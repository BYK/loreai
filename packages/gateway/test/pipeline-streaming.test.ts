/**
 * Pipeline streaming-response coverage (Anthropic conversation turns).
 *
 * The harness's replay interceptor now emits Anthropic SSE for streaming
 * requests (see test/helpers/replay.ts), so a `stream: true` turn exercises
 * the streaming path end-to-end: buildStreamingResponse parses the upstream
 * SSE, forwards it to the client, and accumulates in parallel for
 * postResponse storage.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import type { Harness } from "./helpers/harness";
import { createHarness } from "./helpers/harness";
import type { FixtureEntry } from "../src/recorder";
import {
  buildStreamingResponse,
  abortAwareDelay,
  completeBudgetThrottleDelay,
  createForegroundAbortScope,
  handleRequest,
  mergeRecallUsage,
  setUpstreamInterceptor,
  validatedMetaStream,
} from "../src/pipeline";
import { loadConfig } from "../src/config";
import { translateAnthropicStreamToOpenAI } from "../src/stream/openai";
import { translateAnthropicStreamToResponses } from "../src/stream/openai-responses";
import { translateAnthropicStreamToGemini } from "../src/stream/gemini";
import {
  makeConversationFixtures,
  STANDARD_TOOLS,
  DEFAULT_MODEL,
  DEFAULT_SYSTEM,
} from "./helpers/fixtures";

function loadLocalConfig() {
  const config = loadConfig();
  config.remoteGateway = false;
  config.hostedMode = false;
  return config;
}

function makeStreamBody(userMessage: string): Record<string, unknown> {
  return {
    model: DEFAULT_MODEL,
    max_tokens: 1024,
    stream: true,
    system: DEFAULT_SYSTEM,
    messages: [{ role: "user", content: userMessage }],
    tools: STANDARD_TOOLS,
  };
}

function makeMetaStreamBody(userMessage: string): Record<string, unknown> {
  return {
    model: DEFAULT_MODEL,
    max_tokens: 32,
    stream: true,
    messages: [{ role: "user", content: userMessage }],
  };
}

function validAnthropicSSE(text = "meta ok"): Response {
  const event = (type: string, data: Record<string, unknown>) =>
    `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  return new Response(
    event("message_start", {
      message: {
        id: "msg_meta",
        type: "message",
        role: "assistant",
        model: DEFAULT_MODEL,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    }) +
      event("content_block_start", {
        index: 0,
        content_block: { type: "text", text: "" },
      }) +
      event("content_block_delta", {
        index: 0,
        delta: { type: "text_delta", text },
      }) +
      event("content_block_stop", { index: 0 }) +
      event("message_delta", {
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 1 },
      }) +
      event("message_stop", {}),
    { headers: { "content-type": "text/event-stream" } },
  );
}

describe("non-stream recall usage aggregation", () => {
  it("rejects per-field and cross-component safe-integer overflow", () => {
    expect(() =>
      mergeRecallUsage(
        { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 0 },
        { inputTokens: 1, outputTokens: 0 },
      ),
    ).toThrow("recall usage token overflow");
    expect(() =>
      mergeRecallUsage(
        { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 0 },
        { inputTokens: 0, outputTokens: 1 },
      ),
    ).toThrow("recall usage token overflow");
  });
});

describe("budget throttle cancellation", () => {
  afterEach(() => vi.useRealTimers());

  it("caller abort clears a long delay and removes its listener", async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const remove = vi.spyOn(caller.signal, "removeEventListener");
    let recorded = 0;
    const pending = completeBudgetThrottleDelay(
      600_000,
      caller.signal,
      () => recorded++,
    );
    expect(vi.getTimerCount()).toBe(1);
    caller.abort(new DOMException("client disconnected", "AbortError"));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(recorded).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("the foreground deadline includes throttle delay and prevents later work", async () => {
    vi.useFakeTimers();
    const foreground = createForegroundAbortScope();
    let recorded = 0;
    let upstreamStarted = false;
    const pending = (async () => {
      await completeBudgetThrottleDelay(
        600_000,
        foreground.signal,
        () => recorded++,
      );
      upstreamStarted = true;
    })();
    const rejected = expect(pending).rejects.toMatchObject({
      name: "TimeoutError",
    });
    await vi.advanceTimersByTimeAsync(300_000);
    await rejected;
    expect(recorded).toBe(0);
    expect(upstreamStarted).toBe(false);
    foreground.dispose();
  });

  it("records throttle completion before allowing upstream work", async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    const pending = (async () => {
      await completeBudgetThrottleDelay(5_000, undefined, () =>
        order.push("record"),
      );
      order.push("upstream");
    })();
    expect(order).toEqual([]);
    await vi.advanceTimersByTimeAsync(5_000);
    await pending;
    expect(order).toEqual(["record", "upstream"]);
  });

  it("zero delay does not leave timers or listeners", async () => {
    vi.useFakeTimers();
    const signal = new AbortController().signal;
    await abortAwareDelay(0, signal);
    expect(vi.getTimerCount()).toBe(0);
  });
});

const STALLED_META_CASES = [
  {
    protocol: "anthropic",
    model: DEFAULT_MODEL,
    provider: "anthropic",
    upstream: "https://api.anthropic.com",
    wire: 'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_stalled","type":"message","role":"assistant","model":"test","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
  },
  {
    protocol: "openai",
    model: "gpt-test",
    provider: "groq",
    upstream: "https://api.groq.com/openai/v1",
    wire: 'data: {"id":"chatcmpl_stalled","model":"gpt-test","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n',
  },
  {
    protocol: "openai-responses",
    model: "gpt-test",
    provider: "openai",
    upstream: "https://api.openai.com",
    wire: 'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_stalled","model":"gpt-test","status":"in_progress"}}\n\n',
  },
  {
    protocol: "gemini",
    model: "gemini-test",
    provider: "google",
    upstream: "https://generativelanguage.googleapis.com",
    wire: 'data: {"responseId":"gemini-stalled","modelVersion":"gemini-test","candidates":[{"index":0,"content":{"role":"model","parts":[{"text":"partial"}]}}]}\n\n',
  },
] as const;

function stalledMetaUpstream(wire: string): {
  response: Response;
  cancelled: () => boolean;
} {
  let cancelled = false;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(wire));
      },
      pull() {
        return new Promise(() => {});
      },
      cancel() {
        cancelled = true;
        return new Promise<void>(() => {});
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
  return { response, cancelled: () => cancelled };
}

async function readSSE(resp: Response): Promise<string> {
  return resp.text();
}

describe("Pipeline — streaming responses", () => {
  let harness: Harness;

  afterEach(() => harness?.teardown());

  it("does not deadlock when an OpenAI translator drops Anthropic lifecycle frames", async () => {
    const anthropic = buildStreamingResponse(
      validAnthropicSSE("translated"),
      () => {},
    );
    const translated = translateAnthropicStreamToOpenAI(anthropic);
    await new Promise((resolve) => setImmediate(resolve));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const body = await Promise.race([
        translated.text(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("translated stream deadlocked")),
            1_000,
          );
        }),
      ]);
      expect(body).toContain("translated");
      expect(body.match(/data: \[DONE\]/g)).toHaveLength(1);
      expect(body.match(/"finish_reason":"stop"/g)).toHaveLength(1);
    } finally {
      if (timer) clearTimeout(timer);
    }
  });

  it.each([
    ["OpenAI", translateAnthropicStreamToOpenAI],
    ["Responses", translateAnthropicStreamToResponses],
    ["Gemini", translateAnthropicStreamToGemini],
  ] as const)(
    "aborts Anthropic->%s translation before downstream demand",
    async (_name, translate) => {
      const firstEvent = (
        await validAnthropicSSE("never reached").text()
      ).split(/(?=event: )/)[0];
      let cancelled = 0;
      const upstream = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(firstEvent));
          },
          pull() {
            return new Promise(() => {});
          },
          cancel() {
            cancelled++;
            return new Promise<void>(() => {});
          },
        }),
      );
      const abort = new AbortController();
      const downstream = translate(upstream, {
        strict: true,
        signal: abort.signal,
      });
      await new Promise((resolve) => setImmediate(resolve));
      abort.abort(new DOMException("caller aborted", "AbortError"));

      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await expect(
          Promise.race([
            downstream.text(),
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(
                () => reject(new Error("translator abort deadlocked")),
                1_000,
              );
            }),
          ]),
        ).rejects.toMatchObject({ name: "AbortError" });
      } finally {
        if (timer) clearTimeout(timer);
      }
      expect(cancelled).toBe(1);
      expect(upstream.body?.locked).toBe(false);
    },
  );

  it("aborts the Anthropic conversation streamer before downstream demand", async () => {
    const firstEvent = (await validAnthropicSSE("never reached").text()).split(
      /(?=event: )/,
    )[0];
    let cancelled = false;
    const upstream = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(firstEvent));
        },
        pull() {
          return new Promise(() => {});
        },
        cancel() {
          cancelled = true;
          return new Promise<void>(() => {});
        },
      }),
    );
    const abort = new AbortController();
    const downstream = buildStreamingResponse(
      upstream,
      () => {},
      undefined,
      undefined,
      undefined,
      undefined,
      abort.signal,
    );
    await new Promise((resolve) => setImmediate(resolve));
    abort.abort(new DOMException("caller aborted", "AbortError"));
    await expect(downstream.text()).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(cancelled).toBe(true);
    expect(upstream.body?.locked).toBe(false);
  });

  it("wakes Anthropic conversation demand when its inactivity deadline fires", async () => {
    vi.useFakeTimers();
    const firstEvent = (await validAnthropicSSE("never reached").text()).split(
      /(?=event: )/,
    )[0];
    let cancelled = false;
    const upstream = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(firstEvent));
        },
        pull() {
          return new Promise(() => {});
        },
        cancel() {
          cancelled = true;
          return new Promise<void>(() => {});
        },
      }),
    );
    try {
      const downstream = buildStreamingResponse(upstream, () => {});
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(120_000);
      await expect(downstream.text()).rejects.toThrow(
        "SSE stream inactivity deadline exceeded",
      );
      expect(cancelled).toBe(true);
      expect(upstream.body?.locked).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drains pre-buffered build and meta streams after delayed first reads", async () => {
    const builtUpstream = validAnthropicSSE("built delayed");
    const metaUpstream = validAnthropicSSE("meta delayed");
    const built = buildStreamingResponse(builtUpstream, () => {});
    const meta = validatedMetaStream(metaUpstream, "anthropic", false);
    await new Promise((resolve) => setImmediate(resolve));
    await expect(built.text()).resolves.toContain("built delayed");
    await expect(meta.text()).resolves.toContain("meta delayed");
    expect(builtUpstream.body?.locked).toBe(false);
    expect(metaUpstream.body?.locked).toBe(false);
  });

  it("closes Anthropic build/meta streams at message_stop with an open tail", async () => {
    const wire = await validAnthropicSSE("terminal").text();
    const makeOpenTail = () => {
      let cancelled = 0;
      const response = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(wire));
          },
          pull() {
            return new Promise(() => {});
          },
          cancel() {
            cancelled++;
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
      return { response, cancelled: () => cancelled };
    };
    const builtUpstream = makeOpenTail();
    let completed = 0;
    const built = buildStreamingResponse(builtUpstream.response, () => {
      completed++;
    });
    const metaUpstream = makeOpenTail();
    const meta = validatedMetaStream(metaUpstream.response, "anthropic", false);

    await expect(built.text()).resolves.toContain("event: message_stop");
    await expect(meta.text()).resolves.toContain("event: message_stop");
    expect(completed).toBe(1);
    expect(builtUpstream.cancelled()).toBe(1);
    expect(metaUpstream.cancelled()).toBe(1);
    expect(builtUpstream.response.body?.locked).toBe(false);
    expect(metaUpstream.response.body?.locked).toBe(false);
  });

  it("pauses a filled build queue and resumes it when reads begin", async () => {
    let pulls = 0;
    const body = await validAnthropicSSE("resume").text();
    const chunks = body
      .split(/(?=event: )/)
      .filter(Boolean)
      .map((chunk) => new TextEncoder().encode(chunk));
    let index = 0;
    const upstream = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls++;
          if (index < chunks.length) controller.enqueue(chunks[index++]);
          else controller.close();
        },
      }),
    );
    const downstream = buildStreamingResponse(upstream, () => {});
    await new Promise((resolve) => setImmediate(resolve));
    const pullsBeforeRead = pulls;
    expect(pullsBeforeRead).toBeLessThan(chunks.length + 1);
    const text = await downstream.text();
    expect(text).toContain("resume");
    expect(pulls).toBeGreaterThan(pullsBeforeRead);
  });

  it("distinguishes external meta abort from silent downstream cancellation", async () => {
    let cancelledBeforeAcquire = false;
    const beforeAcquire = validatedMetaStream(
      new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            cancelledBeforeAcquire = true;
          },
        }),
      ),
      "anthropic",
      false,
    );
    await beforeAcquire.body?.cancel();
    expect(cancelledBeforeAcquire).toBe(true);

    let externallyCancelled = false;
    const abort = new AbortController();
    abort.abort(new DOMException("deadline", "TimeoutError"));
    const removeAbortListener = vi.spyOn(abort.signal, "removeEventListener");
    const externallyAborted = validatedMetaStream(
      new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            externallyCancelled = true;
          },
        }),
      ),
      "anthropic",
      false,
      abort.signal,
    );
    await expect(externallyAborted.text()).rejects.toMatchObject({
      name: "TimeoutError",
    });
    expect(externallyCancelled).toBe(true);
    expect(removeAbortListener).toHaveBeenCalledWith(
      "abort",
      expect.any(Function),
    );
  });

  it("meta downstream cancel does not await a hostile upstream cancel", async () => {
    let sourceCancelled = false;
    const upstream = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              'event: message_start\ndata: {"type":"message_start","message":{"id":"hostile","type":"message","role":"assistant","model":"test","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
            ),
          );
        },
        pull() {
          return new Promise(() => {});
        },
        cancel() {
          sourceCancelled = true;
          return new Promise<void>(() => {});
        },
      }),
    );
    const downstreamBody = validatedMetaStream(
      upstream,
      "anthropic",
      false,
    ).body;
    if (!downstreamBody) throw new Error("test stream has no body");
    const reader = downstreamBody.getReader();
    await reader.read();
    const outcome = await Promise.race([
      reader.cancel().then(() => "cancelled"),
      new Promise<string>((resolve) => setImmediate(() => resolve("hung"))),
    ]);
    expect(outcome).toBe("cancelled");
    expect(sourceCancelled).toBe(true);
    expect(upstream.body?.locked).toBe(false);
  });

  it("external meta abort wakes a filled demand waiter", async () => {
    let sourceCancelled = false;
    const full = await validAnthropicSSE("waiting").text();
    const upstream = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(full));
        },
        pull() {
          return new Promise(() => {});
        },
        cancel() {
          sourceCancelled = true;
        },
      }),
    );
    const abort = new AbortController();
    const downstream = validatedMetaStream(
      upstream,
      "anthropic",
      false,
      abort.signal,
    );
    await new Promise((resolve) => setImmediate(resolve));
    abort.abort(new DOMException("deadline", "TimeoutError"));
    await expect(downstream.text()).rejects.toMatchObject({
      name: "TimeoutError",
    });
    expect(sourceCancelled).toBe(true);
  });

  it("foreground meta settles when its injected upstream ignores abort", async () => {
    const controller = new AbortController();
    setUpstreamInterceptor(async () => new Promise(() => {}));
    try {
      const pending = handleRequest(
        {
          protocol: "anthropic",
          model: DEFAULT_MODEL,
          system: "title this",
          messages: [
            { role: "user", content: [{ type: "text", text: "title" }] },
          ],
          tools: [],
          stream: true,
          maxTokens: 32,
          metadata: {},
          rawHeaders: { "x-lore-agent": "title" },
          signal: controller.signal,
        },
        loadLocalConfig(),
      );
      await Promise.resolve();
      controller.abort(new DOMException("client disconnected", "AbortError"));
      const response = await pending;
      expect(response.status).toBe(502);
      await expect(response.text()).resolves.toContain("client disconnected");
    } finally {
      setUpstreamInterceptor(undefined);
    }
  });

  it("foreground deadline settles when its injected upstream never resolves", async () => {
    vi.useFakeTimers();
    setUpstreamInterceptor(async () => new Promise(() => {}));
    try {
      const pending = handleRequest(
        {
          protocol: "anthropic",
          model: DEFAULT_MODEL,
          system: "title this",
          messages: [
            { role: "user", content: [{ type: "text", text: "title" }] },
          ],
          tools: [],
          stream: true,
          maxTokens: 32,
          metadata: {},
          rawHeaders: { "x-lore-agent": "title" },
        },
        loadLocalConfig(),
      );
      await vi.advanceTimersByTimeAsync(300_000);
      const response = await pending;
      expect(response.status).toBe(502);
      await expect(response.text()).resolves.toContain("timed out");
    } finally {
      setUpstreamInterceptor(undefined);
      vi.useRealTimers();
    }
  });

  it.each(STALLED_META_CASES)(
    "caller abort settles a stalled $protocol meta body",
    async ({ protocol, model, provider, upstream, wire }) => {
      const source = stalledMetaUpstream(wire);
      const caller = new AbortController();
      setUpstreamInterceptor(async () => source.response);
      try {
        let responseTimer: ReturnType<typeof setTimeout> | undefined;
        const downstream = await Promise.race([
          handleRequest(
            {
              protocol,
              model,
              system: "title this",
              messages: [
                { role: "user", content: [{ type: "text", text: "title" }] },
              ],
              tools: [],
              stream: true,
              maxTokens: 32,
              metadata: {},
              rawHeaders: {
                "x-api-key": "test-key",
                "x-lore-agent": "title",
                "x-lore-provider": provider,
                "x-lore-upstream-url": upstream,
              },
              signal: caller.signal,
            },
            loadLocalConfig(),
          ),
          new Promise<never>((_resolve, reject) => {
            responseTimer = setTimeout(
              () => reject(new Error("meta response was not returned")),
              1_000,
            );
          }),
        ]).finally(() => {
          if (responseTimer) clearTimeout(responseTimer);
        });
        await new Promise((resolve) => setImmediate(resolve));
        caller.abort(new DOMException("caller aborted", "AbortError"));
        await new Promise((resolve) => setImmediate(resolve));
        expect(source.cancelled()).toBe(true);
        expect(source.response.body?.locked).toBe(false);
        await expect(
          Promise.race([
            downstream.text(),
            new Promise<never>((_resolve, reject) => {
              responseTimer = setTimeout(
                () => reject(new Error("meta body abort deadlocked")),
                1_000,
              );
            }),
          ]).finally(() => {
            if (responseTimer) clearTimeout(responseTimer);
          }),
        ).rejects.toMatchObject({ name: "AbortError" });
      } finally {
        setUpstreamInterceptor(undefined);
      }
    },
  );

  it.each(STALLED_META_CASES)(
    "foreground deadline settles a stalled $protocol meta body",
    async ({ protocol, model, provider, upstream, wire }) => {
      vi.useFakeTimers();
      const source = stalledMetaUpstream(wire);
      setUpstreamInterceptor(async () => source.response);
      try {
        const downstream = await handleRequest(
          {
            protocol,
            model,
            system: "title this",
            messages: [
              { role: "user", content: [{ type: "text", text: "title" }] },
            ],
            tools: [],
            stream: true,
            maxTokens: 32,
            metadata: {},
            rawHeaders: {
              "x-api-key": "test-key",
              "x-lore-agent": "title",
              "x-lore-provider": provider,
              "x-lore-upstream-url": upstream,
            },
          },
          loadLocalConfig(),
        );
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(300_000);
        await expect(downstream.text()).rejects.toMatchObject({
          name: "TimeoutError",
        });
        expect(source.cancelled()).toBe(true);
        expect(source.response.body?.locked).toBe(false);
      } finally {
        setUpstreamInterceptor(undefined);
        vi.useRealTimers();
      }
    },
  );

  it("preserves non-OK meta responses for every client protocol", async () => {
    harness = await createHarness({ fixtures: [] });
    const cases = [
      {
        path: "/v1/messages",
        status: 429,
        body: {
          model: DEFAULT_MODEL,
          max_tokens: 32,
          stream: true,
          messages: [{ role: "user", content: "title" }],
        },
      },
      {
        path: "/v1/chat/completions",
        status: 401,
        body: {
          model: "gpt-test",
          max_tokens: 32,
          stream: true,
          messages: [{ role: "user", content: "title" }],
        },
      },
      {
        path: "/v1/responses",
        status: 400,
        body: {
          model: "gpt-test",
          max_output_tokens: 32,
          stream: true,
          input: "title",
        },
      },
      {
        path: "/v1beta/models/gemini-test:streamGenerateContent",
        status: 429,
        body: {
          contents: [{ role: "user", parts: [{ text: "title" }] }],
          generationConfig: { maxOutputTokens: 32 },
        },
      },
    ];
    let nextStatus = 500;
    setUpstreamInterceptor(
      async () =>
        new Response(JSON.stringify({ error: { message: "provider error" } }), {
          status: nextStatus,
          headers: {
            "content-type": "application/json",
            "retry-after": "17",
            "set-cookie": "upstream-secret=must-not-leak",
            "x-ratelimit-reset-requests": "23ms",
          },
        }),
    );

    for (const testCase of cases) {
      nextStatus = testCase.status;
      const response = await fetch(`${harness.baseURL}${testCase.path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer test-key",
          "x-lore-agent": "title",
        },
        body: JSON.stringify(testCase.body),
      });
      expect(response.status).toBe(testCase.status);
      expect(response.headers.get("retry-after")).toBe("17");
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(response.headers.get("x-ratelimit-reset-requests")).toBe("23ms");
      expect(await response.json()).toEqual({
        error: { message: "provider error" },
      });
    }
  });

  it.each(["openai-responses", "gemini"] as const)(
    "strictly translates an open-tail Anthropic meta stream to %s",
    async (protocol) => {
      const wire = await validAnthropicSSE("cross protocol").text();
      const chunks = wire
        .split(/(?=event: )/)
        .filter(Boolean)
        .map((chunk) => new TextEncoder().encode(chunk));
      let nextChunk = 0;
      let pulls = 0;
      let cancelled = 0;
      const upstream = new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            pulls++;
            if (nextChunk < chunks.length) {
              controller.enqueue(chunks[nextChunk++]);
              return;
            }
            return new Promise(() => {});
          },
          cancel() {
            cancelled++;
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
      setUpstreamInterceptor(async () => upstream);
      try {
        const response = await handleRequest(
          {
            protocol,
            model: DEFAULT_MODEL,
            system: "title this",
            messages: [
              { role: "user", content: [{ type: "text", text: "title" }] },
            ],
            tools: [],
            stream: true,
            maxTokens: 32,
            metadata: {},
            rawHeaders: {
              "x-api-key": "test-key",
              "x-lore-agent": "title",
              "x-lore-provider": "anthropic",
              "x-lore-upstream-url": "https://api.anthropic.com",
            },
          },
          loadLocalConfig(),
        );
        await new Promise((resolve) => setImmediate(resolve));
        expect(pulls).toBeLessThan(chunks.length);
        let timer: ReturnType<typeof setTimeout> | undefined;
        const output = await Promise.race([
          response.text(),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new Error("translation deadlocked")),
              1_000,
            );
          }),
        ]).finally(() => {
          if (timer) clearTimeout(timer);
        });
        expect(output).toContain("cross protocol");
        if (protocol === "openai-responses") {
          expect(output.match(/event: response\.completed/g)).toHaveLength(1);
          expect(output).not.toContain("event: response.failed");
        } else {
          expect(output.match(/^data: /gm)).toHaveLength(1);
          expect(output.match(/"finishReason":"STOP"/g)).toHaveLength(1);
        }
        expect(cancelled).toBe(1);
        expect(upstream.body?.locked).toBe(false);
      } finally {
        setUpstreamInterceptor(undefined);
      }
    },
  );

  it.each(["openai-responses", "gemini"] as const)(
    "rejects malformed Anthropic meta sources before translating to %s",
    async (protocol) => {
      const cases: Array<{ name: string; bytes: Uint8Array }> = [
        {
          name: "lifecycle",
          bytes: new TextEncoder().encode(
            'event: message_stop\ndata: {"type":"message_stop"}\n\n',
          ),
        },
        { name: "utf8", bytes: new Uint8Array([0xff]) },
        {
          name: "oversize",
          bytes: new TextEncoder().encode(
            `event: ping\ndata: ${"x".repeat(4 * 1024 * 1024)}\n\n`,
          ),
        },
      ];
      for (const malformed of cases) {
        let cancelled = false;
        const upstream = new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(malformed.bytes);
            },
            pull() {
              return new Promise(() => {});
            },
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
        setUpstreamInterceptor(async () => upstream);
        const response = await handleRequest(
          {
            protocol,
            model: DEFAULT_MODEL,
            system: "title this",
            messages: [
              { role: "user", content: [{ type: "text", text: "title" }] },
            ],
            tools: [],
            stream: true,
            maxTokens: 32,
            metadata: {},
            rawHeaders: {
              "x-api-key": "test-key",
              "x-lore-agent": "title",
              "x-lore-provider": "anthropic",
              "x-lore-upstream-url": "https://api.anthropic.com",
            },
          },
          loadLocalConfig(),
        );
        await expect(
          response.text(),
          `${protocol} ${malformed.name}`,
        ).rejects.toThrow();
        expect(cancelled, `${protocol} ${malformed.name}`).toBe(true);
        expect(upstream.body?.locked).toBe(false);
      }
      setUpstreamInterceptor(undefined);
    },
  );

  it("streams an Anthropic SSE response containing the assistant text", async () => {
    harness = await createHarness({
      fixtures: makeConversationFixtures([
        { userMessage: "Stream please", assistantText: "Streamed answer." },
      ]),
    });

    const resp = await harness.chat(makeStreamBody("Stream please"));
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toContain("text/event-stream");

    const sse = await readSSE(resp);
    expect(sse).toContain("event: message_start");
    expect(sse).toContain("event: content_block_delta");
    expect(sse).toContain("Streamed answer.");
    expect(sse).toContain("event: message_stop");
  });

  it("persists the streamed turn to temporal storage", async () => {
    harness = await createHarness({
      fixtures: makeConversationFixtures([
        { userMessage: "Persist this stream", assistantText: "Done." },
      ]),
    });

    const resp = await harness.chat(makeStreamBody("Persist this stream"));
    expect(resp.status).toBe(200);
    // Drain the stream so postResponse runs.
    await readSSE(resp);
    await new Promise((r) => setTimeout(r, 200));

    const rows = harness.queryDB<{ n: number }>(
      "SELECT COUNT(*) as n FROM temporal_messages WHERE role='assistant'",
    );
    expect(rows[0].n).toBeGreaterThanOrEqual(1);
  });

  it("streams a tool_use response (text + tool_use blocks)", async () => {
    const toolFixture: FixtureEntry = {
      seq: 0,
      ts: Date.now(),
      request: {},
      response: {
        id: "msg_tool",
        type: "message",
        role: "assistant",
        model: DEFAULT_MODEL,
        content: [
          { type: "text", text: "Running it now." },
          {
            type: "tool_use",
            id: "toolu_1",
            name: "bash",
            input: { command: "ls -la" },
          },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 10, output_tokens: 8 },
      },
      wasStreaming: false,
      model: DEFAULT_MODEL,
    };

    harness = await createHarness({ fixtures: [toolFixture] });

    const resp = await harness.chat(makeStreamBody("List files"));
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toContain("text/event-stream");

    const sse = await readSSE(resp);
    expect(sse).toContain("Running it now.");
    expect(sse).toContain('"type":"tool_use"');
    expect(sse).toContain('"name":"bash"');
    expect(sse).toContain("ls -la");
    expect(sse).toContain("event: message_stop");
  });

  it.each([
    [
      "malformed lifecycle",
      new Response(
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"bad"}}\n\n',
      ),
    ],
    [
      "malformed UTF-8",
      new Response(
        new Uint8Array([
          0x65, 0x76, 0x65, 0x6e, 0x74, 0x3a, 0x20, 0x70, 0x69, 0x6e, 0x67,
          0x0a, 0x64, 0x61, 0x74, 0x61, 0x3a, 0x20, 0xff, 0x0a, 0x0a,
        ]),
      ),
    ],
  ])(
    "rejects %s through the native foreground stream",
    async (_case, upstream) => {
      harness = await createHarness({
        fixtures: makeConversationFixtures([
          { userMessage: "invalid stream", assistantText: "unused" },
        ]),
      });
      setUpstreamInterceptor(async () => upstream);
      const body = await harness.chat(makeStreamBody("invalid stream")).then(
        (response) => response.text().catch(() => ""),
        () => "",
      );
      expect(body).not.toContain('"text":"bad"');
    },
  );

  it("bounds comment-only native foreground streams", async () => {
    harness = await createHarness({
      fixtures: makeConversationFixtures([
        { userMessage: "oversized stream", assistantText: "unused" },
      ]),
    });
    const chunk = new TextEncoder().encode(`: ${"x".repeat(64 * 1024)}\n\n`);
    setUpstreamInterceptor(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              for (let index = 0; index < 65; index++) {
                controller.enqueue(chunk);
              }
              controller.close();
            },
          }),
        ),
    );
    const body = await harness.chat(makeStreamBody("oversized stream")).then(
      (response) => response.text().catch(() => ""),
      () => "",
    );
    expect(body).not.toContain("x".repeat(64 * 1024));

    const dataChunk = new TextEncoder().encode("x".repeat(64 * 1024));
    setUpstreamInterceptor(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode("event: ping\ndata: "),
              );
              for (let index = 0; index < 65; index++) {
                controller.enqueue(dataChunk);
              }
              controller.close();
            },
          }),
        ),
    );
    const dataBody = await harness
      .chat(makeStreamBody("oversized data stream"))
      .then(
        (response) => response.text().catch(() => ""),
        () => "",
      );
    expect(dataBody).not.toContain("x".repeat(64 * 1024));
  });

  it("validates and forwards a same-wire Anthropic meta stream", async () => {
    harness = await createHarness({
      fixtures: makeConversationFixtures([
        { userMessage: "meta valid", assistantText: "unused" },
      ]),
    });
    setUpstreamInterceptor(async () => validAnthropicSSE());
    const response = await harness.chat(makeMetaStreamBody("meta valid"));
    const body = await response.text();
    expect(body).toContain("meta ok");
    expect(body).toContain("event: message_stop");
  });

  it.each([
    {
      name: "OpenAI Chat",
      path: "/v1/chat/completions",
      request: {
        model: "gpt-4o",
        stream: true,
        messages: [{ role: "user", content: "meta" }],
      },
      upstream:
        'data: {"choices":[{"index":0,"delta":{"content":"openai meta"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      expected: "openai meta",
    },
    {
      name: "Responses public",
      path: "/v1/responses",
      request: { model: "gpt-4o", stream: true, input: "meta" },
      upstream:
        'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n',
      expected: "response.completed",
    },
    {
      name: "Gemini",
      path: "/v1beta/models/gemini-test:streamGenerateContent?alt=sse",
      request: { contents: [{ role: "user", parts: [{ text: "meta" }] }] },
      upstream:
        'data: {"candidates":[{"content":{"parts":[{"text":"gemini meta"}]},"finishReason":"STOP"}]}\n\n',
      expected: "gemini meta",
    },
  ])(
    "validates a same-wire $name meta stream",
    async ({ path, request, upstream, expected }) => {
      harness = await createHarness({
        fixtures: makeConversationFixtures([
          { userMessage: "meta protocols", assistantText: "unused" },
        ]),
      });
      setUpstreamInterceptor(
        async () =>
          new Response(upstream, {
            headers: { "content-type": "text/event-stream" },
          }),
      );
      const response = await fetch(`${harness.baseURL}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer test",
        },
        body: JSON.stringify(request),
      });
      expect(await response.text()).toContain(expected);
    },
  );

  it("rejects malformed and oversized same-wire meta streams", async () => {
    harness = await createHarness({
      fixtures: makeConversationFixtures([
        { userMessage: "meta invalid", assistantText: "unused" },
      ]),
    });
    setUpstreamInterceptor(
      async () =>
        new Response('event: message_stop\ndata: {"type":"message_stop"}\n\n'),
    );
    const malformedBody = await harness
      .chat(makeMetaStreamBody("meta invalid"))
      .then(
        (response) => response.text().catch(() => ""),
        () => "",
      );
    expect(malformedBody).not.toContain("message_stop");

    const comment = new TextEncoder().encode(`: ${"x".repeat(64 * 1024)}\n\n`);
    setUpstreamInterceptor(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              for (let index = 0; index < 65; index++) {
                controller.enqueue(comment);
              }
              controller.close();
            },
          }),
        ),
    );
    const oversizedBody = await harness
      .chat(makeMetaStreamBody("meta invalid again"))
      .then(
        (response) => response.text().catch(() => ""),
        () => "",
      );
    expect(oversizedBody).not.toContain("x".repeat(64 * 1024));
  });

  it("cancels a stalled same-wire meta upstream when the client aborts", async () => {
    let cancelled = false;
    const opening = validAnthropicSSE("partial");
    const openingText = await opening.text();
    const messageStart = openingText.slice(
      0,
      openingText.indexOf("event: content_block_start"),
    );
    const upstream = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(messageStart));
        },
        pull() {
          return new Promise(() => {});
        },
        cancel() {
          cancelled = true;
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
    const response = validatedMetaStream(upstream, "anthropic", false);
    const reader = response.body?.getReader();
    await reader?.read();
    await reader?.cancel();
    for (let attempt = 0; attempt < 10 && !cancelled; attempt++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(cancelled).toBe(true);
  });

  it("applies downstream backpressure and cancellation on the native path", async () => {
    let pulls = 0;
    let cancelled = false;
    const encoder = new TextEncoder();
    let openingSent = false;
    const upstream = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls++;
          if (!openingSent) {
            openingSent = true;
            controller.enqueue(
              encoder.encode(
                `event: message_start\ndata: ${JSON.stringify({
                  type: "message_start",
                  message: {
                    id: "msg_slow",
                    type: "message",
                    role: "assistant",
                    model: DEFAULT_MODEL,
                    content: [],
                    stop_reason: null,
                    stop_sequence: null,
                    usage: { input_tokens: 1, output_tokens: 0 },
                  },
                })}\n\n`,
              ),
            );
            return;
          }
          controller.enqueue(
            encoder.encode('event: ping\ndata: {"type":"ping"}\n\n'),
          );
        },
        cancel() {
          cancelled = true;
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
    const response = buildStreamingResponse(upstream, () => {});
    await new Promise((resolve) => setImmediate(resolve));
    expect(pulls).toBeLessThan(100);
    await response.body?.cancel();
    for (let attempt = 0; attempt < 10 && !cancelled; attempt++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(cancelled).toBe(true);
  });
});
