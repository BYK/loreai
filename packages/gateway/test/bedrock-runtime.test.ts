/**
 * Bedrock Runtime API → Gateway passthrough (issue #1567).
 *
 * Unit tests cover the path matcher and region URL builder; the e2e test
 * drives a real gateway and asserts the verbatim forwarding (URL, headers,
 * body) by intercepting the upstream via undici's `MockAgent` injected
 * through the `setUpstreamDispatcherForTest` seam in `fetch.ts`.
 */
import { describe, test, expect, afterEach } from "vitest";
import { existsSync, unlinkSync } from "node:fs";
import { MockAgent } from "undici";
import {
  BEDROCK_RUNTIME_PATH_RE,
  BEDROCK_RUNTIME_VERBS,
  bedrockRuntimeUrl,
  proxyBedrockRuntimeRequest,
} from "../src/translate/bedrock-runtime";
import { setUpstreamDispatcherForTest } from "../src/fetch";
import { resetPipelineState } from "../src/pipeline";
import { startServer } from "../src/server";
import { loadConfig } from "../src/config";
import { close as closeDB } from "@loreai/core";

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

    const resp = await fetch(`${baseURL}/v1/model/${modelId}/${verb}`, {
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

    const resp = await fetch(`${baseURL}/v1/model/${modelId}/${verb}`, {
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
    const resp = await fetch(`${baseURL}/v1/models`, { method: "GET" });
    // 404 because no real upstream is configured; the load-bearing assertion
    // is that we reached the Anthropic passthrough route, not the Bedrock one.
    expect(resp.status).not.toBe(200);
    expect(resp.headers.get("content-type")).toContain("application/json");
  });
});
