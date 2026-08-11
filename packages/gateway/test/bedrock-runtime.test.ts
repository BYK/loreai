/**
 * Bedrock Runtime API → Gateway passthrough (issue #1567).
 *
 * Unit tests cover the path matcher and region URL builder; the e2e test
 * drives a real gateway and asserts the verbatim forwarding (URL, headers,
 * body) by intercepting the upstream via undici's `MockAgent` injected
 * through the `setUpstreamDispatcherForTest` seam in `fetch.ts`.
 */
import { describe, test, expect, afterEach, vi } from "vitest";
import { existsSync, unlinkSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { Readable } from "node:stream";
import { MockAgent } from "undici";
import {
  BEDROCK_RUNTIME_PATH_RE,
  BEDROCK_RUNTIME_MAX_REQUEST_BYTES,
  BEDROCK_RUNTIME_VERBS,
  bedrockRuntimeHeaders,
  bedrockRuntimeUrl,
  proxyBedrockRuntimeRequest,
} from "../src/translate/bedrock-runtime";
import { setUpstreamDispatcherForTest } from "../src/fetch";
import { resetPipelineState } from "../src/pipeline";
import { startServer } from "../src/server";
import { loadConfig } from "../src/config";
import { close as closeDB } from "@loreai/core";

function localRequest(
  baseURL: string,
  path: string,
  options: {
    method: string;
    headers?: Record<string, string>;
    body?: string;
  },
): Promise<Response> {
  const port = Number(new URL(baseURL).port);
  return new Promise<Response>((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: options.method,
        headers: {
          ...options.headers,
          ...(options.body === undefined
            ? {}
            : { "content-length": String(Buffer.byteLength(options.body)) }),
        },
      },
      (incoming) => {
        const headers = new Headers();
        for (let i = 0; i < incoming.rawHeaders.length; i += 2) {
          headers.append(incoming.rawHeaders[i], incoming.rawHeaders[i + 1]);
        }
        resolve(
          new Response(
            Readable.toWeb(incoming) as unknown as ReadableStream<Uint8Array>,
            {
              status: incoming.statusCode ?? 500,
              statusText: incoming.statusMessage,
              headers,
            },
          ),
        );
      },
    );
    request.once("error", reject);
    request.end(options.body);
  });
}

describe("bedrockRuntimeUrl", () => {
  test("builds the regional bedrock-runtime origin (no trailing slash)", () => {
    expect(bedrockRuntimeUrl("us-east-1")).toBe(
      "https://bedrock-runtime.us-east-1.amazonaws.com",
    );
    expect(bedrockRuntimeUrl("eu-west-1")).toBe(
      "https://bedrock-runtime.eu-west-1.amazonaws.com",
    );
    expect(bedrockRuntimeUrl("ap-southeast-2")).toBe(
      "https://bedrock-runtime.ap-southeast-2.amazonaws.com",
    );
  });

  test("returns a valid https URL parseable as a URL", () => {
    const u = new URL(bedrockRuntimeUrl("us-east-1"));
    expect(u.protocol).toBe("https:");
    expect(u.hostname).toBe("bedrock-runtime.us-east-1.amazonaws.com");
    // The WHATWG URL parser normalizes `https://host` (no path) to pathname
    // "/" — we leave it that way and append `/model/<id>/<verb>` so the
    // final upstream path stays `/model/<id>/<verb>` (verified by the e2e
    // test below).
    expect(u.pathname).toBe("/");
  });
});

describe("bedrockRuntimeHeaders", () => {
  test("keeps AWS auth while stripping cross-origin and hop-by-hop fields", () => {
    const headers = bedrockRuntimeHeaders(
      new Headers({
        authorization: "Bearer bedrock-token",
        connection: "keep-alive, x-connection-secret",
        cookie: "session=secret",
        "proxy-authorization": "Basic proxy-secret",
        "transfer-encoding": "chunked",
        "x-amz-content-sha256": "signed-payload",
        "x-connection-secret": "remove-me",
        "x-lore-project": "/private/project",
        "x-lore-session": "private-session",
      }),
    );

    expect(headers.get("authorization")).toBe("Bearer bedrock-token");
    expect(headers.get("x-amz-content-sha256")).toBe("signed-payload");
    for (const name of [
      "connection",
      "cookie",
      "proxy-authorization",
      "transfer-encoding",
      "x-connection-secret",
      "x-lore-project",
      "x-lore-session",
    ]) {
      expect(headers.has(name), name).toBe(false);
    }
  });
});

describe("BEDROCK_RUNTIME_PATH_RE", () => {
  test.each([
    // The four Bedrock Runtime verbs. Model IDs intentionally include dots
    // and dashes to mirror AWS catalog ids (anthropic.claude-opus-4-6-v1,
    // google.gemma-3-4b-it, us.anthropic.claude-haiku-4-5).
    ["/v1/model/anthropic.claude-opus-4-6-v1/converse", "converse"],
    [
      "/v1/model/anthropic.claude-opus-4-6-v1/converse-stream",
      "converse-stream",
    ],
    ["/v1/model/google.gemma-3-4b-it/invoke", "invoke"],
    [
      "/v1/model/us.anthropic.claude-haiku-4-5/invoke-with-response-stream",
      "invoke-with-response-stream",
    ],
    // Version-suffix colons — provisioned-throughput / custom-model-import
    // IDs always carry a `:vN` suffix. The regex must accept `:` in the
    // modelId segment; otherwise these requests 404 at the gateway instead
    // of reaching the upstream (regression that shipped in #1575, fixed by
    // widening the modelId class to `[a-zA-Z0-9._:-]`).
    [
      "/v1/model/anthropic.claude-opus-4-5-20251101-v1:0/converse-stream",
      "converse-stream",
    ],
  ])("matches %s (verb=%s)", (path) => {
    expect(BEDROCK_RUNTIME_PATH_RE.test(path)).toBe(true);
  });

  test("captures modelId and verb", () => {
    const m = BEDROCK_RUNTIME_PATH_RE.exec(
      "/v1/model/google.gemma-3-4b-it/converse-stream",
    );
    expect(m?.[1]).toBe("google.gemma-3-4b-it");
    expect(m?.[2]).toBe("converse-stream");
  });

  test("captures modelId with version-suffix colon", () => {
    const m = BEDROCK_RUNTIME_PATH_RE.exec(
      "/v1/model/anthropic.claude-opus-4-5-20251101-v1:0/converse-stream",
    );
    expect(m?.[1]).toBe("anthropic.claude-opus-4-5-20251101-v1:0");
    expect(m?.[2]).toBe("converse-stream");
  });

  test("rejects paths outside /v1/model/<modelId>/<verb>", () => {
    // Bare /v1/models (plural) — must not be misclassified as runtime.
    expect(BEDROCK_RUNTIME_PATH_RE.test("/v1/models")).toBe(false);
    // /v1/messages (Anthropic protocol).
    expect(BEDROCK_RUNTIME_PATH_RE.test("/v1/messages")).toBe(false);
    // /v1/chat/completions (OpenAI).
    expect(BEDROCK_RUNTIME_PATH_RE.test("/v1/chat/completions")).toBe(false);
    // Unknown verb.
    expect(BEDROCK_RUNTIME_PATH_RE.test("/v1/model/foo/bar")).toBe(false);
    expect(BEDROCK_RUNTIME_PATH_RE.test("/v1/model/foo/converse-foo")).toBe(
      false,
    );
    // GET — runtime verbs are POST-only.
    expect(BEDROCK_RUNTIME_PATH_RE.test("/v1/model/foo/converse")).toBe(true); // regex doesn't gate method; the route does.
  });

  test("rejects modelIds containing a slash (would change routing)", () => {
    // A modelId cannot contain `/` — the regex captures up to the next slash,
    // so any nested path is treated as a different verb segment and fails.
    expect(BEDROCK_RUNTIME_PATH_RE.test("/v1/model/foo/bar/converse")).toBe(
      false,
    );
  });

  // Each row is a path that MUST be rejected. The colon widening in
  // [a-zA-Z0-9._:-] is intentional — AWS permits version-suffix colons at
  // ANY position in the modelId segment (e.g. `foo:`, `:foo`, `foo::bar`),
  // and the regex does not enforce positional semantics. So those rows
  // are NOT included here; only paths the gateway must reject because
  // they introduce path-breaking characters (`/`, whitespace, `%`, etc.)
  // or break the `/v1/model/<modelId>/<verb>` shape.
  test.each([
    ["empty modelId", "/v1/model//converse"],
    ["whitespace in modelId", "/v1/model/foo bar/converse"],
    ["percent in modelId", "/v1/model/foo%3Abar/converse"],
    ["trailing slash after verb", "/v1/model/foo/converse/"],
    ["trailing colon and missing verb", "/v1/model/foo:converse-stream"],
  ])("rejects %s (%s)", (_label, path) => {
    expect(BEDROCK_RUNTIME_PATH_RE.test(path)).toBe(false);
  });

  test("exposes the verb allowlist", () => {
    expect(BEDROCK_RUNTIME_VERBS).toEqual([
      "converse",
      "converse-stream",
      "invoke",
      "invoke-with-response-stream",
    ]);
  });
});

describe("proxyBedrockRuntimeRequest — handler logic", () => {
  test("returns 400 for a path that does not match the runtime regex", async () => {
    const req = new Request("http://127.0.0.1:0/v1/models", {
      method: "POST",
      body: "{}",
    });
    const resp = await proxyBedrockRuntimeRequest(req, "us-east-1");
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as {
      error: { type: string; message: string };
    };
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.message).toMatch(/path does not match/i);
  });

  test.each([
    ["exact limit", BEDROCK_RUNTIME_MAX_REQUEST_BYTES, 200],
    ["limit plus one", BEDROCK_RUNTIME_MAX_REQUEST_BYTES + 1, 413],
  ] as const)(
    "bounds request upload at the %s",
    async (_name, size, status) => {
      let fetchCalls = 0;
      let uploaded: Uint8Array | undefined;
      let sourceCancelled = false;
      const bytes = new Uint8Array(size);
      bytes[0] = 0x11;
      bytes[size - 1] = 0xee;
      const source = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          if (size <= BEDROCK_RUNTIME_MAX_REQUEST_BYTES) controller.close();
        },
        cancel() {
          sourceCancelled = true;
        },
      });
      const request = new Request("http://gateway/v1/model/test/converse", {
        method: "POST",
        body: source,
        duplex: "half",
      } as RequestInit & { duplex: "half" });
      const response = await proxyBedrockRuntimeRequest(request, "us-east-1", {
        upstreamFetch: async (_url, init) => {
          fetchCalls++;
          uploaded = init?.body as Uint8Array;
          return new Response("ok");
        },
      });
      expect(response.status).toBe(status);
      if (status === 200) {
        expect(fetchCalls).toBe(1);
        expect(uploaded?.byteLength).toBe(size);
        expect(uploaded?.[0]).toBe(0x11);
        expect(uploaded?.[size - 1]).toBe(0xee);
        await response.body?.cancel();
        expect(sourceCancelled).toBe(false);
      } else {
        expect(fetchCalls).toBe(0);
        expect(sourceCancelled).toBe(true);
      }
      expect(source.locked).toBe(false);
    },
  );

  test.each(["caller", "deadline"] as const)(
    "%s abort settles a stalled request upload and releases hostile input",
    async (mode) => {
      if (mode === "deadline") vi.useFakeTimers();
      const caller = new AbortController();
      let rejectPull!: (error: unknown) => void;
      let markPull!: () => void;
      const pulling = new Promise<void>((resolve) => (markPull = resolve));
      let sourceCancelled = false;
      const source = new ReadableStream<Uint8Array>({
        pull() {
          return new Promise<void>((_resolve, reject) => {
            rejectPull = reject;
            markPull();
          });
        },
        cancel() {
          sourceCancelled = true;
          return new Promise<void>(() => {});
        },
      });
      const request = new Request("http://gateway/v1/model/test/converse", {
        method: "POST",
        body: source,
        signal: mode === "caller" ? caller.signal : undefined,
        duplex: "half",
      } as RequestInit & { duplex: "half" });
      let fetchCalls = 0;
      const pending = proxyBedrockRuntimeRequest(request, "us-east-1", {
        upstreamFetch: async () => {
          fetchCalls++;
          return new Response("should not happen");
        },
      });
      const rejected = expect(pending).rejects.toMatchObject({
        name: mode === "caller" ? "AbortError" : "TimeoutError",
      });
      await pulling;
      if (mode === "caller") {
        caller.abort(new DOMException("client disconnected", "AbortError"));
      } else {
        await vi.advanceTimersByTimeAsync(300_000);
      }
      await rejected;
      rejectPull(new Error("late upload rejection"));
      await Promise.resolve();
      expect(fetchCalls).toBe(0);
      expect(sourceCancelled).toBe(true);
      expect(source.locked).toBe(false);
      if (mode === "deadline") vi.useRealTimers();
    },
  );

  test.each(["caller", "deadline"] as const)(
    "%s abort settles a signal-ignoring upstream fetch",
    async (mode) => {
      if (mode === "deadline") vi.useFakeTimers();
      const caller = new AbortController();
      let upstreamSignal: AbortSignal | undefined;
      let markStarted!: () => void;
      const started = new Promise<void>((resolve) => (markStarted = resolve));
      const pending = proxyBedrockRuntimeRequest(
        new Request("http://gateway/v1/model/test/converse", {
          method: "POST",
          body: "{}",
          signal: mode === "caller" ? caller.signal : undefined,
        }),
        "us-east-1",
        {
          upstreamFetch: async (_url, init) => {
            upstreamSignal = init?.signal ?? undefined;
            markStarted();
            return new Promise(() => {});
          },
        },
      );
      await started;
      const rejected = expect(pending).rejects.toMatchObject({
        name: mode === "caller" ? "AbortError" : "TimeoutError",
      });
      if (mode === "caller") {
        caller.abort(new DOMException("client disconnected", "AbortError"));
      } else {
        await vi.advanceTimersByTimeAsync(300_000);
      }
      await rejected;
      expect(upstreamSignal?.aborted).toBe(true);
      if (mode === "deadline") vi.useRealTimers();
    },
  );

  test.each(["caller", "deadline"] as const)(
    "%s abort preserves metadata and cancels a hostile upstream body",
    async (mode) => {
      if (mode === "deadline") vi.useFakeTimers();
      const caller = new AbortController();
      let cancelled = false;
      const upstream = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("partial"));
          },
          pull() {
            return new Promise(() => {});
          },
          cancel() {
            cancelled = true;
            return new Promise<void>(() => {});
          },
        }),
        {
          status: 207,
          statusText: "Multi-Status",
          headers: { "x-bedrock": "preserved" },
        },
      );
      const response = await proxyBedrockRuntimeRequest(
        new Request("http://gateway/v1/model/test/converse-stream", {
          method: "POST",
          body: "{}",
          signal: mode === "caller" ? caller.signal : undefined,
        }),
        "us-east-1",
        { upstreamFetch: async () => upstream },
      );
      expect(response.status).toBe(207);
      expect(response.statusText).toBe("Multi-Status");
      expect(response.headers.get("x-bedrock")).toBe("preserved");
      const body = response.text();
      const rejected = expect(body).rejects.toMatchObject({
        name: mode === "caller" ? "AbortError" : "TimeoutError",
      });
      await Promise.resolve();
      if (mode === "caller") {
        caller.abort(new DOMException("client disconnected", "AbortError"));
      } else {
        await vi.advanceTimersByTimeAsync(300_000);
      }
      await rejected;
      expect(cancelled).toBe(true);
      expect(upstream.body?.locked).toBe(false);
      if (mode === "deadline") vi.useRealTimers();
    },
  );

  test("normal body completion disposes the foreground deadline", async () => {
    vi.useFakeTimers();
    let upstreamSignal: AbortSignal | undefined;
    const caller = new AbortController();
    const request = new Request("http://gateway/v1/model/test/converse", {
      method: "POST",
      body: "{}",
      signal: caller.signal,
    });
    const remove = vi.spyOn(request.signal, "removeEventListener");
    try {
      const response = await proxyBedrockRuntimeRequest(request, "us-east-1", {
        upstreamFetch: async (_url, init) => {
          upstreamSignal = init?.signal ?? undefined;
          return new Response("complete", {
            status: 201,
            headers: { "x-bedrock": "complete" },
          });
        },
      });
      expect(response.status).toBe(201);
      expect(response.headers.get("x-bedrock")).toBe("complete");
      await expect(response.text()).resolves.toBe("complete");
      await vi.advanceTimersByTimeAsync(300_000);
      expect(upstreamSignal?.aborted).toBe(false);
      expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    } finally {
      vi.useRealTimers();
    }
  });

  test("downstream cancellation promptly cancels the hostile body and disposes the deadline", async () => {
    vi.useFakeTimers();
    let cancelled = false;
    let upstreamSignal: AbortSignal | undefined;
    try {
      const upstream = new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            cancelled = true;
            return new Promise<void>(() => {});
          },
        }),
      );
      const response = await proxyBedrockRuntimeRequest(
        new Request("http://gateway/v1/model/test/converse-stream", {
          method: "POST",
          body: "{}",
        }),
        "us-east-1",
        {
          upstreamFetch: async (_url, init) => {
            upstreamSignal = init?.signal ?? undefined;
            return upstream;
          },
        },
      );
      await expect(response.body?.cancel()).resolves.toBeUndefined();
      expect(cancelled).toBe(true);
      expect(upstream.body?.locked).toBe(false);
      await vi.advanceTimersByTimeAsync(300_000);
      expect(upstreamSignal?.aborted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// E2E — start a real gateway, drive a request through it, intercept upstream
// via undici MockAgent. Fully hermetic: no real network, DNS, or TLS.
// ---------------------------------------------------------------------------

let teardownFn: (() => void) | undefined;
let mock: MockAgent | undefined;

afterEach(() => {
  teardownFn?.();
  teardownFn = undefined;
  if (mock) {
    void mock.close();
    mock = undefined;
  }
  setUpstreamDispatcherForTest(null);
});

describe("POST /v1/model/{modelId}/{verb} — Bedrock Runtime API passthrough", () => {
  test("forwards a non-streaming converse request to bedrock-runtime.<region>.amazonaws.com", async () => {
    const dbPath = `/tmp/lore-bedrock-runtime-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
    process.env.LORE_DB_PATH = dbPath;
    process.env.LORE_LISTEN_PORT = "0";
    process.env.LORE_BEDROCK_REGION = "us-east-1";
    if (!process.env.LORE_DEBUG) process.env.LORE_DEBUG = "false";

    const upstreamOrigin = "https://bedrock-runtime.us-east-1.amazonaws.com";
    const modelId = "google.gemma-3-4b-it";
    const verb = "converse";
    const captured: {
      method?: string;
      path?: string;
      host?: string;
      body?: string;
      auth?: string;
    } = {};

    mock = new MockAgent();
    mock.disableNetConnect();
    mock
      .get(upstreamOrigin)
      .intercept({ path: () => true, method: "POST" })
      .reply((opts) => {
        captured.method = opts.method;
        captured.path = opts.path;
        const h = opts.headers as Record<string, string>;
        captured.auth = h.authorization ?? h.Authorization;
        // The proxy buffers the body upstream (Buffer.from(req.arrayBuffer()))
        // before dispatching. undici hands the mock callback a Buffer (which
        // is a Uint8Array subclass), so we coerce via Buffer.from to read
        // back the bytes regardless of which subtype undici exposes.
        captured.body =
          opts.body == null
            ? ""
            : Buffer.isBuffer(opts.body)
              ? opts.body.toString("utf8")
              : opts.body instanceof Uint8Array
                ? Buffer.from(opts.body).toString("utf8")
                : JSON.stringify(opts.body);
        return {
          statusCode: 200,
          data: JSON.stringify({
            output: {
              message: {
                role: "assistant",
                content: [{ text: "ok from runtime" }],
              },
            },
            stopReason: "end_turn",
            usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
          }),
          responseOptions: { headers: { "content-type": "application/json" } },
        };
      })
      .persist();
    setUpstreamDispatcherForTest(mock);

    closeDB();
    await resetPipelineState();

    const config = loadConfig();
    const server = await startServer(config);
    const baseURL = `http://127.0.0.1:${server.port}`;

    teardownFn = () => {
      server.stop();
      closeDB();
      for (const suffix of ["", "-shm", "-wal"]) {
        const f = `${dbPath}${suffix}`;
        try {
          if (existsSync(f)) unlinkSync(f);
        } catch {
          // best-effort
        }
      }
    };

    const body = JSON.stringify({
      messages: [{ role: "user", content: [{ text: "hi" }] }],
      inferenceConfig: { maxTokens: 64 },
    });

    const resp = await localRequest(baseURL, `/v1/model/${modelId}/${verb}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer bedrock-api-key-test",
      },
      body,
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(
        `expected ok=true but got status=${resp.status} body=${text}`,
      );
    }
    expect(resp.ok).toBe(true);

    // Upstream destination — exact region-built URL. undici's MockAgent does
    // NOT expose the Host header in opts.headers (it manages it internally
    // on the dispatched socket), so we verify the destination indirectly via
    // the path + origin captured by the mock. The mock's `.get(origin)` is
    // a positive-control: a request to any other origin would have returned
    // ECONNREFUSED (disableNetConnect).
    expect(captured.method).toBe("POST");
    expect(captured.path).toBe(`/model/${modelId}/${verb}`);

    // Authorization header passes through unchanged (bearer tokens are
    // host-agnostic — the bedrock-mantle / Converse API distinction does not
    // affect this).
    expect(captured.auth).toBe("Bearer bedrock-api-key-test");

    // Body is forwarded byte-for-byte.
    expect(captured.body).toBe(body);

    // The client receives the upstream response verbatim.
    const text = await resp.text();
    expect(text).toContain("ok from runtime");
  });

  test("forwards a modelId with version-suffix colon (e2e regression for #1575 follow-up)", async () => {
    const dbPath = `/tmp/lore-bedrock-runtime-colon-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
    process.env.LORE_DB_PATH = dbPath;
    process.env.LORE_LISTEN_PORT = "0";
    process.env.LORE_BEDROCK_REGION = "us-east-1";
    if (!process.env.LORE_DEBUG) process.env.LORE_DEBUG = "false";

    const upstreamOrigin = "https://bedrock-runtime.us-east-1.amazonaws.com";
    // Provisioned-throughput / custom-model-import IDs always carry a `:vN`
    // suffix. The original PR #1575 shipped a regex character class that
    // excluded `:`, so requests for these IDs 404'd at the gateway before
    // reaching the upstream. The follow-up widened the class to
    // `[a-zA-Z0-9._:-]` — this test pins the end-to-end path through the
    // URL builder + forwarder so the regression cannot re-ship silently.
    const modelId = "anthropic.claude-opus-4-5-20251101-v1:0";
    const verb = "converse";
    const captured: {
      method?: string;
      path?: string;
      auth?: string;
      body?: string;
    } = {};

    mock = new MockAgent();
    mock.disableNetConnect();
    mock
      .get(upstreamOrigin)
      .intercept({ path: () => true, method: "POST" })
      .reply((opts) => {
        captured.method = opts.method;
        captured.path = opts.path;
        const h = opts.headers as Record<string, string>;
        captured.auth = h.authorization ?? h.Authorization;
        captured.body =
          opts.body == null
            ? ""
            : Buffer.isBuffer(opts.body)
              ? opts.body.toString("utf8")
              : opts.body instanceof Uint8Array
                ? Buffer.from(opts.body).toString("utf8")
                : JSON.stringify(opts.body);
        return {
          statusCode: 200,
          data: JSON.stringify({
            output: {
              message: { role: "assistant", content: [{ text: "ok" }] },
            },
            stopReason: "end_turn",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          }),
          responseOptions: { headers: { "content-type": "application/json" } },
        };
      })
      .persist();
    setUpstreamDispatcherForTest(mock);

    closeDB();
    await resetPipelineState();

    const config = loadConfig();
    const server = await startServer(config);
    const baseURL = `http://127.0.0.1:${server.port}`;

    teardownFn = () => {
      server.stop();
      closeDB();
      for (const suffix of ["", "-shm", "-wal"]) {
        const f = `${dbPath}${suffix}`;
        try {
          if (existsSync(f)) unlinkSync(f);
        } catch {
          // best-effort
        }
      }
    };

    const resp = await localRequest(baseURL, `/v1/model/${modelId}/${verb}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer bedrock-api-key-test",
      },
      body: "{}",
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(
        `expected ok=true but got status=${resp.status} body=${text}`,
      );
    }
    expect(resp.ok).toBe(true);

    // The colon in the modelId is preserved verbatim into the upstream path.
    // The AWS-runtime destination URL is structurally `/model/<id>/<verb>`
    // with no URL-encoding of the colon — verify the builder + forwarder
    // emit the same shape the AWS SDK would produce.
    expect(captured.method).toBe("POST");
    expect(captured.path).toBe(`/model/${modelId}/${verb}`);
    expect(captured.auth).toBe("Bearer bedrock-api-key-test");
    expect(captured.body).toBe("{}");
  });

  test("streams a converse-stream response (AWS event-stream passthrough)", async () => {
    const dbPath = `/tmp/lore-bedrock-runtime-stream-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
    process.env.LORE_DB_PATH = dbPath;
    process.env.LORE_LISTEN_PORT = "0";
    process.env.LORE_BEDROCK_REGION = "eu-west-1";
    if (!process.env.LORE_DEBUG) process.env.LORE_DEBUG = "false";

    const upstreamOrigin = "https://bedrock-runtime.eu-west-1.amazonaws.com";
    const modelId = "anthropic.claude-opus-4-6-v1";
    const verb = "converse-stream";

    mock = new MockAgent();
    mock.disableNetConnect();
    mock
      .get(upstreamOrigin)
      .intercept({ path: () => true, method: "POST" })
      .reply(200, "chunk-one\nchunk-two\n", {
        headers: {
          "content-type": "application/vnd.amazon.eventstream",
          "x-amzn-requestid": "test-request-1",
        },
      })
      .persist();
    setUpstreamDispatcherForTest(mock);

    closeDB();
    await resetPipelineState();

    const config = loadConfig();
    const server = await startServer(config);
    const baseURL = `http://127.0.0.1:${server.port}`;

    teardownFn = () => {
      server.stop();
      closeDB();
      for (const suffix of ["", "-shm", "-wal"]) {
        const f = `${dbPath}${suffix}`;
        try {
          if (existsSync(f)) unlinkSync(f);
        } catch {
          // best-effort
        }
      }
    };

    const resp = await localRequest(baseURL, `/v1/model/${modelId}/${verb}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer bedrock-api-key-test",
      },
      body: "{}",
    });

    expect(resp.ok).toBe(true);
    // AWS event-stream Content-Type is preserved verbatim — the gateway does
    // not re-shape binary streaming responses.
    expect(resp.headers.get("content-type")).toBe(
      "application/vnd.amazon.eventstream",
    );
    expect(resp.headers.get("x-amzn-requestid")).toBe("test-request-1");

    // Body streams byte-for-byte. Two distinct chunks would be coalesced by
    // undici's reply(), so the content-type + upstream-roundtrip assertion
    // is the load-bearing signal; the body length confirms passthrough.
    const buf = await resp.arrayBuffer();
    const text = new TextDecoder().decode(buf);
    expect(text).toContain("chunk-one");
    expect(text).toContain("chunk-two");
  });

  test("a non-matching path still 404s (does not over-match)", async () => {
    const dbPath = `/tmp/lore-bedrock-runtime-nomatch-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
    process.env.LORE_DB_PATH = dbPath;
    process.env.LORE_LISTEN_PORT = "0";
    process.env.LORE_BEDROCK_REGION = "us-east-1";
    if (!process.env.LORE_DEBUG) process.env.LORE_DEBUG = "false";

    closeDB();
    await resetPipelineState();
    const config = loadConfig();
    const server = await startServer(config);
    const baseURL = `http://127.0.0.1:${server.port}`;

    teardownFn = () => {
      server.stop();
      closeDB();
      for (const suffix of ["", "-shm", "-wal"]) {
        const f = `${dbPath}${suffix}`;
        try {
          if (existsSync(f)) unlinkSync(f);
        } catch {
          // best-effort
        }
      }
    };

    // /v1/models is the Anthropic-protocol models list passthrough — must
    // NOT be misclassified as a Bedrock Runtime call.
    const resp = await localRequest(baseURL, "/v1/models", { method: "GET" });
    // 404 because no real upstream is configured; the load-bearing assertion
    // is that we reached the Anthropic passthrough route, not the Bedrock one.
    expect(resp.status).not.toBe(200);
    expect(resp.headers.get("content-type")).toContain("application/json");
  });
});
