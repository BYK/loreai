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
import {
  distillation,
  getDailyCostForDay,
  ltm,
  loadSessionTracking,
  saveSessionTracking,
  temporal,
} from "@loreai/core";
import * as Sentry from "@sentry/bun";
import type { Harness } from "./helpers/harness";
import { createHarness } from "./helpers/harness";
import type { FixtureEntry } from "../src/recorder";
import type { GatewayRequest } from "../src/translate/types";

vi.mock("@sentry/bun", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sentry/bun")>();
  return {
    ...actual,
    startInactiveSpan: vi.fn(actual.startInactiveSpan),
  };
});

vi.mock("../src/worker-health", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/worker-health")>();
  return {
    ...actual,
    getDegradationWarning: vi.fn(actual.getDegradationWarning),
  };
});

import {
  activePipelineRequestCountForTest,
  buildStreamingResponse,
  abortAwareDelay,
  completeBudgetThrottleDelay,
  createForegroundAbortScope,
  detachedPipelineRequestCountForTest,
  evictLiveSessionForTest,
  getActiveSessions,
  handleCompactEndpoint,
  handleRequest,
  handleResponsesCompactEndpoint,
  isPipelineSessionActiveForTest,
  expireProvisionalHeaderMappingsForTest,
  mergeRecallUsage,
  pendingPipelineSessionClaimCountForTest,
  resetPipelineState,
  scheduleStreamingPostResponseForTest,
  setPipelinePreUpstreamPauseForTest,
  setMaxActivePipelineRequestsForTest,
  setMaxDetachedPipelineRequestsForTest,
  setPipelineResetSettleTimeoutForTest,
  setPipelineResetPauseForTest,
  setBeforeUpstreamCaptureForTest,
  setPostResponseStartObserverForTest,
  setProvisionalFinalizerPauseForTest,
  setStreamingPostResponseLimitsForTest,
  setStreamingPostResponseWaitObserverForTest,
  setUpstreamInterceptor,
  streamingPostResponsePendingForTest,
  validatedMetaStream,
} from "../src/pipeline";
import { loadConfig } from "../src/config";
import { authFingerprint } from "../src/auth";
import { getDegradationWarning } from "../src/worker-health";
import {
  clearAllCosts,
  computeCallCost,
  getCostRate,
  getDailySpend,
  getSessionCosts,
} from "../src/cost-tracker";
import { translateAnthropicStreamToOpenAI } from "../src/stream/openai";
import { translateAnthropicStreamToResponses } from "../src/stream/openai-responses";
import { translateAnthropicStreamToGemini } from "../src/stream/gemini";
import {
  makeConversationFixtures,
  STANDARD_TOOLS,
  DEFAULT_MODEL,
  DEFAULT_SYSTEM,
} from "./helpers/fixtures";

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

function responsesEvent(type: string, data: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

function validResponsesSSE(
  id: string,
  text?: string,
  usage: Record<string, unknown> = {
    input_tokens: 1,
    output_tokens: text ? 1 : 0,
  },
): string {
  const output = text
    ? {
        type: "message",
        id: `msg_${id}`,
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text }],
      }
    : undefined;
  return (
    responsesEvent("response.created", {
      response: { id, model: "gpt-5.6-sol", status: "in_progress" },
    }) +
    (output
      ? responsesEvent("response.output_item.added", {
          output_index: 0,
          item: {
            type: "message",
            id: output.id,
            role: "assistant",
            status: "in_progress",
          },
        }) +
        responsesEvent("response.output_text.delta", {
          output_index: 0,
          item_id: output.id,
          content_index: 0,
          delta: text,
        }) +
        responsesEvent("response.output_text.done", {
          output_index: 0,
          item_id: output.id,
          content_index: 0,
          text,
        }) +
        responsesEvent("response.output_item.done", {
          output_index: 0,
          item: output,
        })
      : "") +
    responsesEvent("response.completed", {
      response: {
        id,
        model: "gpt-5.6-sol",
        status: "completed",
        output: output ? [output] : [],
        usage,
      },
    })
  );
}

function incompleteResponsesSSE(id: string): string {
  return (
    responsesEvent("response.created", {
      response: { id, model: "gpt-5.6-sol", status: "in_progress" },
    }) +
    responsesEvent("response.incomplete", {
      response: {
        id,
        model: "gpt-5.6-sol",
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output: [],
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    })
  );
}

function makeResponsesRequest(input: {
  sessionHeaders: Record<string, string>;
  messages?: GatewayRequest["messages"];
  tools?: GatewayRequest["tools"];
}): GatewayRequest {
  return {
    protocol: "openai-responses",
    model: "gpt-5.6-sol",
    system: "You are a coding agent.",
    messages: input.messages ?? [
      { role: "user", content: [{ type: "text", text: "continue" }] },
    ],
    tools: input.tools ?? [
      { name: "read", description: "Read a file", inputSchema: {} },
    ],
    stream: true,
    maxTokens: 1024,
    metadata: {},
    rawHeaders: {
      authorization: "Bearer test-key",
      "x-lore-agent": "coder",
      "x-lore-project": process.cwd(),
      "x-lore-provider": "openai",
      "x-lore-upstream-url": "https://api.openai.com/v1",
      ...input.sessionHeaders,
    },
  };
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

  it.each(["caller", "upstream"] as const)(
    "does not run marker fallback post-processing after %s follow-up cancellation",
    async (abortSource) => {
      const caller = new AbortController();
      let postResponses = 0;
      let call = 0;
      let followUpStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        followUpStarted = resolve;
      });
      setPostResponseStartObserverForTest(() => postResponses++);
      setUpstreamInterceptor(async () => {
        call++;
        if (call === 1) {
          return new Response(
            JSON.stringify({
              id: "resp_recall_abort",
              object: "response",
              created_at: 0,
              model: "gpt-5.6-sol",
              status: "completed",
              output: [
                {
                  type: "function_call",
                  id: "fc_recall_abort",
                  call_id: "call_recall_abort",
                  name: "recall",
                  arguments: JSON.stringify({
                    query:
                      "one two three four five six seven eight nine technical terms",
                  }),
                  status: "completed",
                },
              ],
              usage: { input_tokens: 1, output_tokens: 1 },
            }),
            { headers: { "content-type": "application/json" } },
          );
        }
        followUpStarted();
        if (abortSource === "upstream") {
          throw new DOMException("upstream cancelled", "AbortError");
        }
        return new Promise<Response>(() => {});
      });

      try {
        const request = makeResponsesRequest({
          sessionHeaders: { "x-lore-session-id": "recall-followup-abort" },
        });
        request.stream = false;
        request.signal = caller.signal;
        const pending = handleRequest(request, loadConfig());
        await started;
        if (abortSource === "caller") {
          caller.abort(new DOMException("client disconnected", "AbortError"));
        }

        const response = await pending;
        expect(response.status).toBe(502);
        expect(postResponses).toBe(0);
      } finally {
        setPostResponseStartObserverForTest(undefined);
        setUpstreamInterceptor(undefined);
        await resetPipelineState();
      }
    },
  );

  it("retains no replay body or recall result for a no-store turn", async () => {
    let call = 0;
    setUpstreamInterceptor(async () => {
      call++;
      if (call === 1) {
        return new Response(
          JSON.stringify({
            id: "resp_no_store_recall",
            object: "response",
            created_at: 0,
            model: "gpt-5.6-sol",
            status: "completed",
            output: [
              {
                type: "function_call",
                id: "fc_no_store_recall",
                call_id: "call_no_store_recall",
                name: "recall",
                arguments: JSON.stringify({
                  query:
                    "one two three four five six seven eight nine private terms",
                }),
                status: "completed",
              },
            ],
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          id: "resp_no_store_final",
          object: "response",
          created_at: 0,
          model: "gpt-5.6-sol",
          status: "completed",
          output: [
            {
              type: "message",
              id: "msg_no_store_final",
              role: "assistant",
              status: "completed",
              content: [
                {
                  type: "output_text",
                  text: "private answer",
                  annotations: [],
                },
              ],
            },
          ],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { headers: { "content-type": "application/json" } },
      );
    });

    try {
      const request = makeResponsesRequest({
        sessionHeaders: { "x-lore-session-id": "no-store-recall-session" },
      });
      request.stream = false;
      request.rawHeaders["x-lore-no-store"] = "true";
      const response = await handleRequest(request, loadConfig());
      expect(response.status).toBe(200);
      await response.text();

      const state = [...getActiveSessions().values()].find(
        (candidate) => candidate.headerSessionId === "no-store-recall-session",
      );
      expect(state).toBeDefined();
      expect(state?.cacheAnalytics.lastRequestBody).toBeNull();
      expect(state?.recallStore.size).toBe(0);
      expect(
        loadSessionTracking(state?.sessionID ?? "")?.recallStore,
      ).toBeNull();
      expect(
        loadSessionTracking(state?.sessionID ?? "")?.fingerprint,
      ).toBeFalsy();
    } finally {
      setUpstreamInterceptor(undefined);
      await resetPipelineState();
    }
  });

  it("accounts typed failed JSON recall follow-up usage in the fallback turn", async () => {
    clearAllCosts();
    let call = 0;
    setUpstreamInterceptor(async () => {
      call++;
      if (call === 1) {
        return new Response(
          JSON.stringify({
            id: "resp_failed_json_recall",
            object: "response",
            created_at: 0,
            model: "gpt-5.6-sol",
            status: "completed",
            output: [
              {
                type: "function_call",
                id: "fc_failed_json_recall",
                call_id: "call_failed_json_recall",
                name: "recall",
                arguments: JSON.stringify({
                  query: "failed json recall usage",
                }),
                status: "completed",
              },
            ],
            usage: { input_tokens: 10, output_tokens: 1 },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          id: "resp_failed_json_recall_followup",
          object: "response",
          created_at: 0,
          model: "gpt-5.6-sol",
          status: "failed",
          output: [],
          usage: { input_tokens: 1_000, output_tokens: 100 },
          error: { type: "server_error", message: "provider failed" },
        }),
        { headers: { "content-type": "application/json" } },
      );
    });

    try {
      const request = makeResponsesRequest({
        sessionHeaders: { "x-lore-session-id": "failed-json-recall-usage" },
      });
      request.stream = false;
      request.rawHeaders["x-lore-no-store"] = "true";
      const response = await handleRequest(request, loadConfig());
      expect(response.status).toBe(200);
      await response.text();
      const state = [...getActiveSessions().values()].find(
        (candidate) => candidate.headerSessionId === "failed-json-recall-usage",
      );
      expect(state).toBeDefined();
      expect(
        getSessionCosts(state?.sessionID ?? "")?.conversation,
      ).toMatchObject({
        inputTokens: 1_010,
        outputTokens: 101,
        turns: 1,
      });
    } finally {
      setUpstreamInterceptor(undefined);
      await resetPipelineState();
      clearAllCosts();
    }
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
  afterEach(() => vi.mocked(getDegradationWarning).mockReset());

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

  it("closes a Responses tool continuation before post-response storage", async () => {
    const order: string[] = [];
    let postResponses = 0;
    let upstreamCalls = 0;
    let upstreamCancellations = 0;
    setPostResponseStartObserverForTest(() =>
      order.push(`post${++postResponses}`),
    );
    const wire = validResponsesSSE("resp_tool_continuation", "continued");
    const makeUpstream = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(wire));
          },
          pull() {
            return new Promise(() => {});
          },
          cancel() {
            upstreamCancellations++;
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    setUpstreamInterceptor(async () => {
      upstreamCalls++;
      if (upstreamCalls === 2) order.push("upstream2");
      return makeUpstream();
    });
    const toolOutput = "tool output line\n".repeat(512);
    const request = (sessionHeaders: Record<string, string>): GatewayRequest =>
      makeResponsesRequest({
        sessionHeaders,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "read the file" }],
          },
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "call_read",
                name: "read",
                input: { filePath: "large.txt" },
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                toolUseId: "call_read",
                content: [{ type: "text", text: toolOutput }],
              },
            ],
          },
        ],
      });

    try {
      const response = await handleRequest(
        request({ "x-session-affinity": "legacy-affinity-session" }),
        loadConfig(),
      );

      const body = await response.text();
      order.push("eof1");
      const secondResponse = await handleRequest(
        request({
          "x-lore-session-id": "stable-lore-session",
          "x-session-affinity": "legacy-affinity-session",
        }),
        loadConfig(),
      );
      expect(order).toEqual(["eof1"]);
      const secondBody = await secondResponse.text();
      order.push("eof2");
      await new Promise((resolve) => setImmediate(resolve));

      setStreamingPostResponseLimitsForTest(64, 0);
      const perSessionSaturated = await handleRequest(
        request({
          "x-lore-session-id": "responses-post-response-per-session",
        }),
        loadConfig(),
      );
      const perSessionSaturatedBody = await perSessionSaturated.text();
      order.push("eof3");
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      setStreamingPostResponseLimitsForTest(0, 2);
      const globallySaturated = await handleRequest(
        request({ "x-lore-session-id": "responses-post-response-global" }),
        loadConfig(),
      );
      const globallySaturatedBody = await globallySaturated.text();
      order.push("eof4");
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      expect(body).toContain("event: response.completed");
      expect(body).not.toContain("event: response.failed");
      expect(secondBody).toContain("event: response.completed");
      expect(secondBody).not.toContain("event: response.failed");
      expect(perSessionSaturatedBody).toContain("event: response.completed");
      expect(perSessionSaturatedBody).not.toContain("event: response.failed");
      expect(globallySaturatedBody).toContain("event: response.completed");
      expect(globallySaturatedBody).not.toContain("event: response.failed");
      expect(order).toEqual([
        "eof1",
        "post1",
        "upstream2",
        "eof2",
        "post2",
        "eof3",
        "post3",
        "eof4",
        "post4",
      ]);
      expect(streamingPostResponsePendingForTest()).toBe(0);
      expect(upstreamCancellations).toBe(4);
    } finally {
      setStreamingPostResponseLimitsForTest();
      setPostResponseStartObserverForTest(undefined);
      setUpstreamInterceptor(undefined);
      await resetPipelineState();
    }
  });

  it("does not start Responses post-processing before the final EOF read", async () => {
    let postResponses = 0;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    setPostResponseStartObserverForTest(() => postResponses++);
    setUpstreamInterceptor(
      async () =>
        new Response(validResponsesSSE("resp_terminal_before_eof"), {
          headers: { "content-type": "text/event-stream" },
        }),
    );

    try {
      const response = await handleRequest(
        makeResponsesRequest({
          sessionHeaders: {
            "x-lore-session-id": "terminal-before-eof-session",
          },
        }),
        loadConfig(),
      );
      reader = response.body?.getReader();
      expect(reader).toBeDefined();
      if (!reader) throw new Error("missing response body");
      const decoder = new TextDecoder();
      let output = "";
      while (!output.includes("event: response.completed")) {
        const chunk = await reader.read();
        expect(chunk.done).toBe(false);
        if (chunk.value) {
          output += decoder.decode(chunk.value, { stream: true });
        }
      }

      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      expect(postResponses).toBe(0);

      for (;;) {
        const finalChunk = await reader.read();
        if (finalChunk.done) break;
      }
      await vi.waitFor(() => expect(postResponses).toBe(1));
    } finally {
      if (reader) await reader.cancel().catch(() => {});
      setPostResponseStartObserverForTest(undefined);
      setUpstreamInterceptor(undefined);
      await resetPipelineState();
    }
  });

  it("defers buffered warning-path storage until the Responses body closes", async () => {
    const order: string[] = [];
    vi.mocked(getDegradationWarning).mockReturnValueOnce("workers degraded");
    setPostResponseStartObserverForTest(() => order.push("post"));
    setUpstreamInterceptor(
      async () =>
        new Response(validResponsesSSE("resp_warning"), {
          headers: { "content-type": "text/event-stream" },
        }),
    );

    try {
      const response = await handleRequest(
        makeResponsesRequest({
          sessionHeaders: { "x-lore-session-id": "warning-path-session" },
        }),
        loadConfig(),
      );
      const body = await response.text();
      order.push("eof");

      expect(body).toContain("workers degraded");
      expect(order).toEqual(["eof"]);
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      expect(order).toEqual(["eof", "post"]);
    } finally {
      setPostResponseStartObserverForTest(undefined);
      setUpstreamInterceptor(undefined);
      await resetPipelineState();
    }
  });

  it("does not finalize a buffered warning-path incomplete Responses turn", async () => {
    const alias = "warning-incomplete-alias";
    const canonical = "warning-incomplete-canonical";
    let upstreamCall = 0;
    setUpstreamInterceptor(async () => {
      upstreamCall++;
      return new Response(
        upstreamCall === 1
          ? validResponsesSSE("resp_warning_incomplete_setup")
          : incompleteResponsesSSE("resp_warning_incomplete"),
        { headers: { "content-type": "text/event-stream" } },
      );
    });
    const store = vi.spyOn(temporal, "store");

    try {
      await (
        await handleRequest(
          makeResponsesRequest({
            sessionHeaders: { "x-session-affinity": alias },
          }),
          loadConfig(),
        )
      ).text();
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      const state = [...getActiveSessions().values()].find(
        (candidate) => candidate.headerSessionId === alias,
      );
      expect(state).toBeDefined();

      vi.mocked(getDegradationWarning).mockReturnValueOnce("workers degraded");
      clearAllCosts();
      store.mockClear();
      const response = await handleRequest(
        makeResponsesRequest({
          sessionHeaders: {
            "x-lore-session-id": canonical,
            "x-session-affinity": alias,
          },
        }),
        loadConfig(),
      );
      const body = await response.text();
      expect(body).toContain("event: response.incomplete");
      expect(body).not.toContain("event: response.completed");
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      expect(store).not.toHaveBeenCalled();
      expect(
        getSessionCosts(state?.sessionID ?? "")?.conversation,
      ).toMatchObject({
        inputTokens: 1,
        outputTokens: 0,
        turns: 1,
      });

      const compact = await handleCompactEndpoint(
        new Request("http://gateway.test/v1/compact", {
          method: "POST",
          headers: {
            authorization: "Bearer test-key",
            "content-type": "application/json",
            "x-lore-session-id": canonical,
          },
          body: JSON.stringify({ project_path: process.cwd() }),
        }),
        loadConfig(),
      );
      expect(compact.status).toBe(404);
      expect(loadSessionTracking(state?.sessionID ?? "")).toMatchObject({
        headerName: "x-session-affinity",
        headerSessionId: alias,
      });
    } finally {
      store.mockRestore();
      setUpstreamInterceptor(undefined);
      await resetPipelineState();
      clearAllCosts();
    }
  });

  it("uses reserved capacity for production finalizers", async () => {
    const end = vi.fn();
    const span = {
      end,
      setAttribute: vi.fn(),
      setAttributes: vi.fn(),
      setStatus: vi.fn(),
      updateName: vi.fn(),
    } as unknown as Sentry.Span;
    vi.mocked(Sentry.startInactiveSpan).mockReturnValueOnce(span);
    let postResponses = 0;
    setPostResponseStartObserverForTest(() => postResponses++);
    setStreamingPostResponseLimitsForTest(0, 2);
    setUpstreamInterceptor(
      async () =>
        new Response(validResponsesSSE("resp_dropped_span"), {
          headers: { "content-type": "text/event-stream" },
        }),
    );

    try {
      const response = await handleRequest(
        makeResponsesRequest({
          sessionHeaders: { "x-lore-session-id": "dropped-span-session" },
        }),
        loadConfig(),
      );
      await response.text();
      await vi.waitFor(() => expect(postResponses).toBe(1));

      expect(end).toHaveBeenCalledOnce();
      expect(streamingPostResponsePendingForTest()).toBe(0);
    } finally {
      setStreamingPostResponseLimitsForTest();
      setPostResponseStartObserverForTest(undefined);
      setUpstreamInterceptor(undefined);
      await resetPipelineState();
    }
  });

  it("enforces and cleans up the real per-session and global queue limits", async () => {
    setUpstreamInterceptor(async () => new Response("{}", { status: 200 }));
    const admissionRequest = makeResponsesRequest({
      sessionHeaders: { "x-lore-session-id": "queue-admission" },
      tools: [],
    });
    admissionRequest.stream = false;
    admissionRequest.rawHeaders["x-lore-agent"] = "title";

    try {
      await (await handleRequest(admissionRequest, loadConfig())).text();
      const perSessionOrder: number[] = [];
      let releasePerSession: (() => void) | undefined;
      const perSessionGate = new Promise<void>((resolve) => {
        releasePerSession = resolve;
      });
      let perSessionDrops = 0;
      scheduleStreamingPostResponseForTest("real-limit-session", async () => {
        await perSessionGate;
        perSessionOrder.push(1);
      });
      scheduleStreamingPostResponseForTest("real-limit-session", async () => {
        await perSessionGate;
        perSessionOrder.push(2);
      });
      scheduleStreamingPostResponseForTest(
        "real-limit-session",
        () => {
          perSessionOrder.push(3);
        },
        () => perSessionDrops++,
      );

      expect(streamingPostResponsePendingForTest()).toBe(2);
      expect(perSessionDrops).toBe(1);
      releasePerSession?.();
      await vi.waitFor(() =>
        expect(streamingPostResponsePendingForTest()).toBe(0),
      );
      expect(perSessionOrder).toEqual([1, 2]);

      let releaseGlobal: (() => void) | undefined;
      const globalGate = new Promise<void>((resolve) => {
        releaseGlobal = resolve;
      });
      let globalDrops = 0;
      for (let index = 0; index < 64; index++) {
        scheduleStreamingPostResponseForTest(
          `real-global-limit-${index}`,
          () => globalGate,
        );
      }
      scheduleStreamingPostResponseForTest(
        "real-global-limit-overflow",
        () => {},
        () => globalDrops++,
      );

      expect(streamingPostResponsePendingForTest()).toBe(64);
      expect(globalDrops).toBe(1);
      releaseGlobal?.();
      await vi.waitFor(() =>
        expect(streamingPostResponsePendingForTest()).toBe(0),
      );

      let releaseResetFinalizer: (() => void) | undefined;
      const resetFinalizerGate = new Promise<void>((resolve) => {
        releaseResetFinalizer = resolve;
      });
      scheduleStreamingPostResponseForTest(
        "real-reset-limit",
        () => resetFinalizerGate,
      );
      const reset = resetPipelineState();
      let resetSettled = false;
      void reset.then(() => {
        resetSettled = true;
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(resetSettled).toBe(false);
      releaseResetFinalizer?.();
      await reset;
      expect(streamingPostResponsePendingForTest()).toBe(0);
    } finally {
      setUpstreamInterceptor(undefined);
      await resetPipelineState();
    }
  });

  it("ends the response span when a stream is cancelled before terminal", async () => {
    const end = vi.fn();
    const setStatus = vi.fn();
    const span = {
      end,
      setAttribute: vi.fn(),
      setAttributes: vi.fn(),
      setStatus,
      updateName: vi.fn(),
    } as unknown as Sentry.Span;
    vi.mocked(Sentry.startInactiveSpan).mockReturnValueOnce(span);
    let upstreamStartedResolve: (() => void) | undefined;
    const upstreamStarted = new Promise<void>((resolve) => {
      upstreamStartedResolve = resolve;
    });
    let upstreamCancellations = 0;
    setUpstreamInterceptor(async () => {
      upstreamStartedResolve?.();
      return new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            upstreamCancellations++;
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    });

    try {
      const response = await handleRequest(
        makeResponsesRequest({
          sessionHeaders: { "x-lore-session-id": "cancelled-span-session" },
        }),
        loadConfig(),
      );
      const reader = response.body?.getReader();
      expect(reader).toBeDefined();
      await reader?.read();
      await upstreamStarted;
      await reader?.cancel("client disconnected");
      await vi.waitFor(() => expect(end).toHaveBeenCalledOnce());

      expect(setStatus).toHaveBeenCalledWith({
        code: 2,
        message: "stream cancelled before terminal response",
      });
      expect(upstreamCancellations).toBe(1);
    } finally {
      setUpstreamInterceptor(undefined);
      await resetPipelineState();
    }
  });

  it("ends an unsuccessful Responses stream span exactly once", async () => {
    const end = vi.fn();
    const span = {
      end,
      setAttribute: vi.fn(),
      setAttributes: vi.fn(),
      setStatus: vi.fn(),
      updateName: vi.fn(),
    } as unknown as Sentry.Span;
    vi.mocked(Sentry.startInactiveSpan).mockReturnValueOnce(span);
    setUpstreamInterceptor(
      async () =>
        new Response(incompleteResponsesSSE("resp_incomplete_span"), {
          headers: { "content-type": "text/event-stream" },
        }),
    );

    try {
      const response = await handleRequest(
        makeResponsesRequest({
          sessionHeaders: { "x-lore-session-id": "incomplete-span-session" },
        }),
        loadConfig(),
      );
      expect(await response.text()).toContain("event: response.incomplete");
      await vi.waitFor(() => expect(end).toHaveBeenCalledOnce());
    } finally {
      setUpstreamInterceptor(undefined);
      await resetPipelineState();
    }
  });

  it.each(["incomplete", "failed"] as const)(
    "accounts validated usage from a %s Responses terminal without storing the turn",
    async (terminal) => {
      clearAllCosts();
      const today = new Date().toISOString().slice(0, 10);
      const ledgerBefore = getDailyCostForDay(today);
      const sessionHeader = `account-${terminal}-response-session`;
      const wire =
        responsesEvent("response.created", {
          response: {
            id: `resp_account_${terminal}`,
            model: "gpt-5.6-sol",
            status: "in_progress",
          },
        }) +
        responsesEvent(`response.${terminal}`, {
          response: {
            id: `resp_account_${terminal}`,
            model: "gpt-5.6-sol",
            status: terminal,
            output: [],
            usage: { input_tokens: 1_000, output_tokens: 100 },
            ...(terminal === "incomplete"
              ? { incomplete_details: { reason: "max_output_tokens" } }
              : {
                  error: { type: "server_error", message: "provider failed" },
                }),
          },
        });
      setUpstreamInterceptor(
        async () =>
          new Response(wire, {
            headers: { "content-type": "text/event-stream" },
          }),
      );
      const store = vi.spyOn(temporal, "store");

      try {
        const response = await handleRequest(
          makeResponsesRequest({
            sessionHeaders: { "x-lore-session-id": sessionHeader },
          }),
          loadConfig(),
        );
        expect(await response.text()).toContain(`event: response.${terminal}`);
        const state = [...getActiveSessions().values()].find(
          (candidate) => candidate.headerSessionId === sessionHeader,
        );
        expect(state).toBeDefined();
        await vi.waitFor(() => {
          expect(getSessionCosts(state?.sessionID ?? "")?.conversation).toEqual(
            expect.objectContaining({
              inputTokens: 1_000,
              outputTokens: 100,
              turns: 1,
            }),
          );
        });
        expect(getDailySpend().spend).toBeGreaterThan(0);
        expect(getCostRate()).toBeGreaterThan(0);
        expect(getDailyCostForDay(today)).toBeGreaterThan(ledgerBefore);
        expect(store).not.toHaveBeenCalled();
      } finally {
        store.mockRestore();
        setUpstreamInterceptor(undefined);
        await resetPipelineState();
        clearAllCosts();
      }
    },
  );

  it("accounts a failed recall-aware continuation without storing the turn", async () => {
    clearAllCosts();
    const sessionHeader = "account-failed-recall-continuation";
    let upstreamCall = 0;
    setUpstreamInterceptor(async () => {
      upstreamCall++;
      if (upstreamCall === 1) {
        const args = JSON.stringify({
          query:
            "one two three four five six seven eight nine architecture terms",
        });
        return new Response(
          responsesEvent("response.created", {
            response: {
              id: "resp_recall_accounting",
              model: "gpt-5.6-sol",
              status: "in_progress",
            },
          }) +
            responsesEvent("response.output_item.added", {
              output_index: 0,
              item: {
                type: "function_call",
                id: "fc_recall_accounting",
                call_id: "call_recall_accounting",
                name: "recall",
              },
            }) +
            responsesEvent("response.function_call_arguments.done", {
              output_index: 0,
              item_id: "fc_recall_accounting",
              arguments: args,
            }) +
            responsesEvent("response.output_item.done", {
              output_index: 0,
              item: {
                type: "function_call",
                id: "fc_recall_accounting",
                call_id: "call_recall_accounting",
                name: "recall",
                arguments: args,
                status: "completed",
              },
            }) +
            responsesEvent("response.completed", {
              response: {
                id: "resp_recall_accounting",
                model: "gpt-5.6-sol",
                status: "completed",
                usage: { input_tokens: 10, output_tokens: 1 },
              },
            }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response(
        responsesEvent("response.created", {
          response: {
            id: "resp_recall_accounting_failed",
            model: "gpt-5.6-sol",
            status: "in_progress",
          },
        }) +
          responsesEvent("response.failed", {
            response: {
              id: "resp_recall_accounting_failed",
              model: "gpt-5.6-sol",
              status: "failed",
              output: [],
              usage: { input_tokens: 1_000, output_tokens: 100 },
              error: { type: "server_error", message: "provider failed" },
            },
          }),
        { headers: { "content-type": "text/event-stream" } },
      );
    });
    const store = vi.spyOn(temporal, "store");

    try {
      const response = await handleRequest(
        makeResponsesRequest({
          sessionHeaders: { "x-lore-session-id": sessionHeader },
        }),
        loadConfig(),
      );
      expect(await response.text()).toContain("event: response.failed");
      const state = [...getActiveSessions().values()].find(
        (candidate) => candidate.headerSessionId === sessionHeader,
      );
      expect(state).toBeDefined();
      await vi.waitFor(() => {
        expect(
          getSessionCosts(state?.sessionID ?? "")?.conversation,
        ).toMatchObject({
          inputTokens: 1_010,
          outputTokens: 101,
          turns: 1,
        });
      });
      expect(store).not.toHaveBeenCalled();
    } finally {
      store.mockRestore();
      setUpstreamInterceptor(undefined);
      await resetPipelineState();
      clearAllCosts();
    }
  });

  it("defers non-stream incomplete accounting and span closure until EOF", async () => {
    clearAllCosts();
    const end = vi.fn();
    const span = {
      end,
      setAttribute: vi.fn(),
      setAttributes: vi.fn(),
      setStatus: vi.fn(),
      updateName: vi.fn(),
    } as unknown as Sentry.Span;
    vi.mocked(Sentry.startInactiveSpan).mockReturnValueOnce(span);
    setUpstreamInterceptor(
      async () =>
        new Response(
          JSON.stringify({
            id: "resp_nonstream_incomplete_accounting",
            object: "response",
            created_at: 0,
            model: "gpt-5.6-sol",
            status: "incomplete",
            output: [],
            usage: { input_tokens: 1_000, output_tokens: 100 },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );

    try {
      const request = makeResponsesRequest({
        sessionHeaders: {
          "x-lore-session-id": "nonstream-incomplete-accounting",
        },
      });
      request.stream = false;
      const response = await handleRequest(request, loadConfig());
      expect(end).not.toHaveBeenCalled();
      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.status).toBe("incomplete");
      expect(body.incomplete_details).toEqual({
        reason: "max_output_tokens",
      });
      await vi.waitFor(() => expect(end).toHaveBeenCalledOnce());
      const state = [...getActiveSessions().values()].find(
        (candidate) =>
          candidate.headerSessionId === "nonstream-incomplete-accounting",
      );
      expect(
        getSessionCosts(state?.sessionID ?? "")?.conversation,
      ).toMatchObject({
        inputTokens: 1_000,
        outputTokens: 100,
        turns: 1,
      });
    } finally {
      setUpstreamInterceptor(undefined);
      await resetPipelineState();
      clearAllCosts();
    }
  });

  it("preserves finalizer order for overlapping requests in one session", async () => {
    const order: string[] = [];
    const sources: Array<
      ReadableStreamDefaultController<Uint8Array> | undefined
    > = [];
    const startedResolvers: Array<(() => void) | undefined> = [];
    const started = [0, 1, 2].map(
      (index) =>
        new Promise<void>((resolve) => {
          startedResolvers[index] = resolve;
        }),
    );
    let upstreamCall = 0;
    let postResponses = 0;
    setPostResponseStartObserverForTest(() =>
      order.push(`post${++postResponses}`),
    );
    setUpstreamInterceptor(async () => {
      const index = upstreamCall++;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            sources[index] = controller;
            if (index === 2) order.push("upstream3");
            startedResolvers[index]?.();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    });
    const request = () =>
      makeResponsesRequest({
        sessionHeaders: { "x-lore-session-id": "overlapping-session" },
      });

    try {
      const first = await handleRequest(request(), loadConfig());
      const firstBody = first.text();
      await started[0];

      const second = await handleRequest(request(), loadConfig());
      const secondBody = second.text();
      await new Promise((resolve) => setImmediate(resolve));
      expect(upstreamCall).toBe(1);

      sources[0]?.enqueue(
        new TextEncoder().encode(validResponsesSSE("resp_overlap_1")),
      );
      sources[0]?.close();
      await firstBody;
      order.push("eof1");
      await started[1];
      expect(order).toEqual(["eof1", "post1"]);

      const third = await handleRequest(request(), loadConfig());
      const thirdBody = third.text();
      await new Promise((resolve) => setImmediate(resolve));
      expect(upstreamCall).toBe(2);

      sources[1]?.enqueue(
        new TextEncoder().encode(validResponsesSSE("resp_overlap_2")),
      );
      sources[1]?.close();
      await secondBody;
      order.push("eof2");
      await started[2];

      expect(order).toEqual(["eof1", "post1", "eof2", "post2", "upstream3"]);

      sources[2]?.enqueue(
        new TextEncoder().encode(validResponsesSSE("resp_overlap_3")),
      );
      sources[2]?.close();
      await thirdBody;
      order.push("eof3");
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      expect(order).toEqual([
        "eof1",
        "post1",
        "eof2",
        "post2",
        "upstream3",
        "eof3",
        "post3",
      ]);
      expect(streamingPostResponsePendingForTest()).toBe(0);
    } finally {
      setStreamingPostResponseWaitObserverForTest(undefined);
      setPostResponseStartObserverForTest(undefined);
      setUpstreamInterceptor(undefined);
      await resetPipelineState();
    }
  });

  it("keeps one same-session waiter off global active capacity", async () => {
    const ownerHeaders = { "x-lore-session-id": "fair-session-owner" };
    let ownerSource: ReadableStreamDefaultController<Uint8Array> | undefined;
    let ownerStartedResolve!: () => void;
    const ownerStarted = new Promise<void>((resolve) => {
      ownerStartedResolve = resolve;
    });
    let upstreamCalls = 0;
    setMaxActivePipelineRequestsForTest(2);
    setUpstreamInterceptor(async () => {
      upstreamCalls++;
      if (upstreamCalls === 1) {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              ownerSource = controller;
              ownerStartedResolve();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response(validResponsesSSE(`resp_fair_${upstreamCalls}`), {
        headers: { "content-type": "text/event-stream" },
      });
    });

    try {
      const owner = await handleRequest(
        makeResponsesRequest({ sessionHeaders: ownerHeaders }),
        loadConfig(),
      );
      const ownerBody = owner.text();
      await ownerStarted;

      const waiting = await handleRequest(
        makeResponsesRequest({ sessionHeaders: ownerHeaders }),
        loadConfig(),
      );
      const waitingBody = waiting.text();
      await new Promise((resolve) => setImmediate(resolve));
      expect(activePipelineRequestCountForTest()).toBe(1);

      const overflow = await handleRequest(
        makeResponsesRequest({ sessionHeaders: ownerHeaders }),
        loadConfig(),
      );
      expect(await overflow.text()).toContain("event: response.failed");

      const unrelated = await handleRequest(
        makeResponsesRequest({
          sessionHeaders: { "x-lore-session-id": "fair-unrelated-session" },
        }),
        loadConfig(),
      );
      expect(await unrelated.text()).toContain("event: response.completed");
      expect(upstreamCalls).toBe(2);

      ownerSource?.enqueue(
        new TextEncoder().encode(validResponsesSSE("resp_fair_owner")),
      );
      ownerSource?.close();
      ownerSource = undefined;
      await ownerBody;
      expect(await waitingBody).toContain("event: response.completed");
      expect(upstreamCalls).toBe(3);
    } finally {
      ownerSource?.close();
      setMaxActivePipelineRequestsForTest();
      setUpstreamInterceptor(undefined);
      await resetPipelineState();
    }
  });

  it("rejects an unread early-flush response after pipeline reset", async () => {
    let postResponses = 0;
    setPostResponseStartObserverForTest(() => postResponses++);
    setUpstreamInterceptor(async () => {
      throw new Error("unread early-flush response must not start");
    });

    try {
      const response = await handleRequest(
        makeResponsesRequest({
          sessionHeaders: {
            "x-lore-session-id": "responses-post-response-reset",
          },
        }),
        loadConfig(),
      );
      await resetPipelineState();
      setPostResponseStartObserverForTest(() => postResponses++);
      setUpstreamInterceptor(async () => new Response("{}", { status: 200 }));
      const reopenedRequest = makeResponsesRequest({
        sessionHeaders: { "x-lore-session-id": "post-reset-request" },
        tools: [],
      });
      reopenedRequest.stream = false;
      reopenedRequest.rawHeaders["x-lore-agent"] = "title";
      await (await handleRequest(reopenedRequest, loadConfig())).text();

      let staleUpstreamCalls = 0;
      setUpstreamInterceptor(async () => {
        staleUpstreamCalls++;
        return new Response(validResponsesSSE("resp_after_reset"), {
          headers: { "content-type": "text/event-stream" },
        });
      });
      const body = await response.text();

      expect(body).toContain("event: response.failed");
      expect(body).toContain("Gateway request failed");
      expect(staleUpstreamCalls).toBe(0);
      expect(postResponses).toBe(0);
      expect(streamingPostResponsePendingForTest()).toBe(0);
    } finally {
      setPostResponseStartObserverForTest(undefined);
      setUpstreamInterceptor(undefined);
      await resetPipelineState();
    }
  });

  it("retains cancelled producers until abort-unaware work settles", async () => {
    let releaseProducer: (() => void) | undefined;
    const producerPause = new Promise<void>((resolve) => {
      releaseProducer = resolve;
    });
    let producerWaitingResolve: (() => void) | undefined;
    const producerWaiting = new Promise<void>((resolve) => {
      producerWaitingResolve = resolve;
    });
    setPipelinePreUpstreamPauseForTest(producerPause, () =>
      producerWaitingResolve?.(),
    );
    const sessionHeaders = {
      "x-lore-session-id": "cancelled-preterminal-session",
    };
    const initialActiveRequests = activePipelineRequestCountForTest();

    try {
      const response = await handleRequest(
        makeResponsesRequest({ sessionHeaders }),
        loadConfig(),
      );
      const reader = response.body?.getReader();
      expect(reader).toBeDefined();
      await reader?.read();
      await producerWaiting;

      const state = [...getActiveSessions().values()].find(
        (candidate) =>
          candidate.headerSessionId === sessionHeaders["x-lore-session-id"],
      );
      expect(state).toBeDefined();
      expect(activePipelineRequestCountForTest()).toBe(
        initialActiveRequests + 1,
      );
      expect(isPipelineSessionActiveForTest(state?.sessionID ?? "")).toBe(true);

      await reader?.cancel("client disconnected");
      expect(activePipelineRequestCountForTest()).toBe(
        initialActiveRequests + 1,
      );
      expect(isPipelineSessionActiveForTest(state?.sessionID ?? "")).toBe(true);
      setMaxActivePipelineRequestsForTest(initialActiveRequests + 1);
      const saturated = await handleRequest(
        makeResponsesRequest({
          sessionHeaders: { "x-lore-session-id": "capacity-rejected-session" },
        }),
        loadConfig(),
      );
      expect(saturated.status).toBe(503);
      expect(await saturated.text()).toContain("Gateway is busy");

      releaseProducer?.();
      await vi.waitFor(() => {
        expect(activePipelineRequestCountForTest()).toBe(initialActiveRequests);
        expect(isPipelineSessionActiveForTest(state?.sessionID ?? "")).toBe(
          false,
        );
      });
    } finally {
      releaseProducer?.();
      setMaxActivePipelineRequestsForTest();
      setPipelinePreUpstreamPauseForTest(undefined);
      await resetPipelineState();
    }
  });

  it("waits for an abort-unaware early-flush producer before reset clears state", async () => {
    let releaseProducer: (() => void) | undefined;
    const producerPause = new Promise<void>((resolve) => {
      releaseProducer = resolve;
    });
    let producerWaitingResolve: (() => void) | undefined;
    const producerWaiting = new Promise<void>((resolve) => {
      producerWaitingResolve = resolve;
    });
    setPipelinePreUpstreamPauseForTest(producerPause, () =>
      producerWaitingResolve?.(),
    );
    let upstreamCalls = 0;
    setUpstreamInterceptor(async () => {
      upstreamCalls++;
      return new Response(validResponsesSSE("resp_stale_producer"), {
        headers: { "content-type": "text/event-stream" },
      });
    });
    let reset: Promise<void> | undefined;

    try {
      const response = await handleRequest(
        makeResponsesRequest({
          sessionHeaders: { "x-lore-session-id": "stale-producer-session" },
        }),
        loadConfig(),
      );
      const body = response.text();
      await producerWaiting;
      reset = resetPipelineState();
      let resetSettled = false;
      void reset.then(() => {
        resetSettled = true;
      });

      await new Promise((resolve) => setImmediate(resolve));
      expect(resetSettled).toBe(false);
      releaseProducer?.();
      await reset;
      expect(resetSettled).toBe(true);
      expect(upstreamCalls).toBe(0);
      expect(await body).toContain("event: response.failed");
    } finally {
      releaseProducer?.();
      await reset;
      setPipelinePreUpstreamPauseForTest(undefined);
      setUpstreamInterceptor(undefined);
      await resetPipelineState();
    }
  });

  it("fences an early-flush producer that resumes after the reset timeout", async () => {
    const sessionHeader = "late-stale-producer-session";
    const staleProjectPath = "/tmp";
    const freshProjectPath = process.cwd();
    const staleUpstream = "https://stale-reset.example";
    const freshUpstream = "https://fresh-reset.example";
    let releaseProducer: (() => void) | undefined;
    const producerPause = new Promise<void>((resolve) => {
      releaseProducer = resolve;
    });
    let producerWaitingResolve: (() => void) | undefined;
    const producerWaiting = new Promise<void>((resolve) => {
      producerWaitingResolve = resolve;
    });
    setPipelinePreUpstreamPauseForTest(producerPause, () =>
      producerWaitingResolve?.(),
    );
    setPipelineResetSettleTimeoutForTest(0);
    let upstreamCalls = 0;
    setUpstreamInterceptor(async () => {
      upstreamCalls++;
      return new Response(validResponsesSSE("resp_late_stale_producer"), {
        headers: { "content-type": "text/event-stream" },
      });
    });

    try {
      const staleRequest = makeResponsesRequest({
        sessionHeaders: {
          "x-lore-session-id": sessionHeader,
        },
      });
      staleRequest.rawHeaders["x-lore-project"] = staleProjectPath;
      staleRequest.rawHeaders["x-lore-upstream-url"] = staleUpstream;
      const response = await handleRequest(staleRequest, loadConfig());
      const body = response.text();
      await producerWaiting;
      await resetPipelineState();

      expect(activePipelineRequestCountForTest()).toBe(0);
      expect(detachedPipelineRequestCountForTest()).toBe(1);
      setMaxDetachedPipelineRequestsForTest(1);
      const quarantineFull = await handleRequest(
        makeResponsesRequest({
          sessionHeaders: {
            "x-lore-session-id": "quarantine-saturation-session",
          },
        }),
        loadConfig(),
      );
      expect(quarantineFull.status).toBe(503);
      expect(await quarantineFull.text()).toContain("Gateway is busy");
      setMaxDetachedPipelineRequestsForTest();
      setPipelinePreUpstreamPauseForTest(undefined);
      setUpstreamInterceptor(async () => {
        upstreamCalls++;
        return new Response(validResponsesSSE("resp_reopened_after_timeout"), {
          headers: { "content-type": "text/event-stream" },
        });
      });
      const freshRequest = makeResponsesRequest({
        sessionHeaders: {
          "x-lore-session-id": sessionHeader,
        },
      });
      freshRequest.rawHeaders["x-lore-project"] = freshProjectPath;
      freshRequest.rawHeaders["x-lore-upstream-url"] = freshUpstream;
      const reopened = await handleRequest(freshRequest, loadConfig());
      expect(await reopened.text()).toContain("event: response.completed");
      expect(upstreamCalls).toBe(1);
      const freshState = [...getActiveSessions().values()].find(
        (candidate) => candidate.headerSessionId === sessionHeader,
      );
      expect(freshState).toBeDefined();
      await vi.waitFor(() => {
        expect(loadSessionTracking(freshState?.sessionID ?? "")).toMatchObject({
          projectPath: freshProjectPath,
          projectPathProvisional: false,
          lastUpstream: expect.stringContaining(freshUpstream),
        });
      });
      const freshTracking = loadSessionTracking(freshState?.sessionID ?? "");

      releaseProducer?.();
      expect(await body).toContain("event: response.failed");
      await vi.waitFor(() =>
        expect(detachedPipelineRequestCountForTest()).toBe(0),
      );
      expect(upstreamCalls).toBe(1);
      expect(freshState).toMatchObject({
        projectPath: freshProjectPath,
        projectPathProvisional: false,
        lastUpstream: expect.objectContaining({ url: freshUpstream }),
      });
      expect(loadSessionTracking(freshState?.sessionID ?? "")).toMatchObject({
        projectPath: freshProjectPath,
        projectPathProvisional: false,
        lastUpstream: freshTracking?.lastUpstream,
      });
    } finally {
      releaseProducer?.();
      setMaxDetachedPipelineRequestsForTest();
      setPipelinePreUpstreamPauseForTest(undefined);
      setPipelineResetSettleTimeoutForTest();
      setUpstreamInterceptor(undefined);
      await resetPipelineState();
    }
  });

  it("aborts a started stream before reset reopens admission", async () => {
    let upstreamStartedResolve: (() => void) | undefined;
    const upstreamStarted = new Promise<void>((resolve) => {
      upstreamStartedResolve = resolve;
    });
    let postResponses = 0;
    let upstreamCancellations = 0;
    setUpstreamInterceptor(async () => {
      upstreamStartedResolve?.();
      return new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            upstreamCancellations++;
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    });

    try {
      const response = await handleRequest(
        makeResponsesRequest({
          sessionHeaders: {
            "x-lore-session-id": "started-response-before-reset",
          },
        }),
        loadConfig(),
      );
      const bodyResult = response.text();
      await upstreamStarted;
      await resetPipelineState();

      setPostResponseStartObserverForTest(() => postResponses++);
      setUpstreamInterceptor(async () => new Response("{}", { status: 200 }));
      const reopenedRequest = makeResponsesRequest({
        sessionHeaders: { "x-lore-session-id": "started-post-reset-request" },
        tools: [],
      });
      reopenedRequest.stream = false;
      reopenedRequest.rawHeaders["x-lore-agent"] = "title";
      await (await handleRequest(reopenedRequest, loadConfig())).text();
      const body = await bodyResult;

      expect(body).toContain("event: response.failed");
      expect(body).toContain("Gateway request failed");
      expect(upstreamCancellations).toBe(1);
      expect(postResponses).toBe(0);
      expect(streamingPostResponsePendingForTest()).toBe(0);
    } finally {
      setPostResponseStartObserverForTest(undefined);
      setUpstreamInterceptor(undefined);
      await resetPipelineState();
    }
  });

  it("does not start an unread structural compaction after reset", async () => {
    let upstreamCalls = 0;
    setUpstreamInterceptor(async () => {
      upstreamCalls++;
      return new Response(validResponsesSSE("resp_before_unread_compact"), {
        headers: { "content-type": "text/event-stream" },
      });
    });
    const sessionHeaders = {
      "x-lore-session-id": "unread-compaction-reset-session",
    };
    let compactionRead: { mockRestore: () => void } | undefined;

    try {
      const established = await handleRequest(
        makeResponsesRequest({
          sessionHeaders,
          messages: Array.from({ length: 12 }, (_, index) => ({
            role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
            content: [{ type: "text" as const, text: `turn ${index}` }],
          })),
        }),
        loadConfig(),
      );
      await established.text();
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      compactionRead = vi.spyOn(temporal, "undistilledCount");
      const compacted = await handleRequest(
        makeResponsesRequest({
          sessionHeaders,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: "Create an anchored summary from the conversation history above.",
                },
              ],
            },
          ],
          tools: [],
        }),
        loadConfig(),
      );
      await resetPipelineState();

      await expect(compacted.text()).rejects.toMatchObject({
        name: "AbortError",
        message: "gateway pipeline reset",
      });
      expect(compactionRead).not.toHaveBeenCalled();
      expect(upstreamCalls).toBe(1);
    } finally {
      compactionRead?.mockRestore();
      setUpstreamInterceptor(undefined);
      await resetPipelineState();
    }
  });

  it("keeps cancelled streaming compaction active until abort-unaware distillation settles", async () => {
    let upstreamCalls = 0;
    setUpstreamInterceptor(async () => {
      upstreamCalls++;
      return new Response(validResponsesSSE("resp_before_cancelled_compact"), {
        headers: { "content-type": "text/event-stream" },
      });
    });
    const sessionHeaders = {
      "x-lore-session-id": "cancelled-compaction-session",
    };
    let distillationStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      distillationStarted = resolve;
    });
    let distillationAborted!: () => void;
    const aborted = new Promise<void>((resolve) => {
      distillationAborted = resolve;
    });
    let releaseDistillation!: () => void;
    const distillationResult = new Promise<{
      rounds: number;
      distilled: number;
    }>((resolve) => {
      releaseDistillation = () => resolve({ rounds: 0, distilled: 0 });
    });
    let distillationSignal: AbortSignal | undefined;
    const undistilledCount = vi
      .spyOn(temporal, "undistilledCount")
      .mockReturnValue(1);
    const runDistillation = vi
      .spyOn(distillation, "run")
      .mockImplementation(async (input) => {
        distillationStarted();
        const signal = input.signal;
        if (!signal) throw new Error("compaction signal missing");
        distillationSignal = signal;
        const onAbort = () => distillationAborted();
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
        // Deliberately ignore cancellation. The request must retain its active
        // session claim until this underlying operation actually settles.
        return distillationResult;
      });

    try {
      const established = await handleRequest(
        makeResponsesRequest({
          sessionHeaders,
          messages: Array.from({ length: 12 }, (_, index) => ({
            role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
            content: [{ type: "text" as const, text: `turn ${index}` }],
          })),
        }),
        loadConfig(),
      );
      await established.text();
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      const sessionState = [...getActiveSessions().values()].find(
        (candidate) =>
          candidate.headerSessionId === sessionHeaders["x-lore-session-id"],
      );
      expect(sessionState).toBeDefined();

      const compactRequest = makeResponsesRequest({
        sessionHeaders,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Create an anchored summary from the conversation history above.",
              },
            ],
          },
        ],
        tools: [],
      });
      compactRequest.protocol = "anthropic";
      compactRequest.model = DEFAULT_MODEL;
      compactRequest.rawHeaders["x-lore-provider"] = "anthropic";
      compactRequest.rawHeaders["x-lore-upstream-url"] =
        "https://api.anthropic.com";
      const compacted = await handleRequest(compactRequest, loadConfig());
      await started;
      expect(distillationSignal).toBeDefined();
      expect(activePipelineRequestCountForTest()).toBe(1);

      await compacted.body?.cancel(
        new DOMException("client disconnected", "AbortError"),
      );
      await aborted;
      await new Promise((resolve) => setImmediate(resolve));

      expect(runDistillation).toHaveBeenCalledOnce();
      expect(distillationSignal?.aborted).toBe(true);
      expect(activePipelineRequestCountForTest()).toBe(1);
      expect(
        isPipelineSessionActiveForTest(sessionState?.sessionID ?? ""),
      ).toBe(true);

      releaseDistillation();
      await distillationResult;
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      expect(activePipelineRequestCountForTest()).toBe(0);
      expect(
        isPipelineSessionActiveForTest(sessionState?.sessionID ?? ""),
      ).toBe(false);
      expect(upstreamCalls).toBe(1);
    } finally {
      releaseDistillation();
      runDistillation.mockRestore();
      undistilledCount.mockRestore();
      setUpstreamInterceptor(undefined);
      await resetPipelineState();
    }
  });

  it("keeps cancelled streaming compaction active until abort-unaware LTM lookup settles", async () => {
    let upstreamCalls = 0;
    setUpstreamInterceptor(async () => {
      upstreamCalls++;
      return new Response(validResponsesSSE("resp_before_cancelled_ltm"), {
        headers: { "content-type": "text/event-stream" },
      });
    });
    const sessionHeaders = {
      "x-lore-session-id": "cancelled-compaction-ltm-session",
    };
    let releaseLookup!: () => void;
    const lookupResult = new Promise<
      Awaited<ReturnType<typeof ltm.forProjectOffloaded>>
    >((resolve) => {
      releaseLookup = () => resolve([]);
    });
    let lookupStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      lookupStarted = resolve;
    });
    let undistilledCount: { mockRestore(): void } | undefined;
    let lookup: { mockRestore(): void } | undefined;

    try {
      const established = await handleRequest(
        makeResponsesRequest({
          sessionHeaders,
          messages: Array.from({ length: 12 }, (_, index) => ({
            role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
            content: [{ type: "text" as const, text: `turn ${index}` }],
          })),
        }),
        loadConfig(),
      );
      await established.text();
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      const sessionState = [...getActiveSessions().values()].find(
        (candidate) =>
          candidate.headerSessionId === sessionHeaders["x-lore-session-id"],
      );
      expect(sessionState).toBeDefined();

      undistilledCount = vi
        .spyOn(temporal, "undistilledCount")
        .mockReturnValue(0);
      lookup = vi.spyOn(ltm, "forProjectOffloaded").mockImplementation(() => {
        lookupStarted();
        return lookupResult;
      });

      const compactRequest = makeResponsesRequest({
        sessionHeaders,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Create an anchored summary from the conversation history above.",
              },
            ],
          },
        ],
        tools: [],
      });
      compactRequest.protocol = "anthropic";
      compactRequest.model = DEFAULT_MODEL;
      compactRequest.rawHeaders["x-lore-provider"] = "anthropic";
      compactRequest.rawHeaders["x-lore-upstream-url"] =
        "https://api.anthropic.com";
      const compacted = await handleRequest(compactRequest, loadConfig());
      await started;

      await compacted.body?.cancel(
        new DOMException("client disconnected", "AbortError"),
      );
      await new Promise((resolve) => setImmediate(resolve));

      expect(lookup).toHaveBeenCalledOnce();
      expect(activePipelineRequestCountForTest()).toBe(1);
      expect(
        isPipelineSessionActiveForTest(sessionState?.sessionID ?? ""),
      ).toBe(true);

      releaseLookup();
      await lookupResult;
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      expect(activePipelineRequestCountForTest()).toBe(0);
      expect(
        isPipelineSessionActiveForTest(sessionState?.sessionID ?? ""),
      ).toBe(false);
      expect(upstreamCalls).toBe(1);
    } finally {
      releaseLookup();
      lookup?.mockRestore();
      undistilledCount?.mockRestore();
      setUpstreamInterceptor(undefined);
      await resetPipelineState();
    }
  });

  it("rejects requests while pipeline reset is in progress", async () => {
    let releaseReset: (() => void) | undefined;
    const resetPause = new Promise<void>((resolve) => {
      releaseReset = resolve;
    });
    let upstreamCalls = 0;
    setPipelineResetPauseForTest(resetPause);
    setUpstreamInterceptor(async () => {
      upstreamCalls++;
      return new Response("{}", { status: 200 });
    });
    const reset = resetPipelineState();

    try {
      const response = await handleRequest(
        makeResponsesRequest({
          sessionHeaders: { "x-lore-session-id": "request-during-reset" },
        }),
        loadConfig(),
      );

      expect(response.status).toBe(503);
      expect(await response.text()).toContain("Gateway pipeline is resetting");
      expect(upstreamCalls).toBe(0);
    } finally {
      releaseReset?.();
      await reset;
      setPipelineResetPauseForTest(undefined);
      setUpstreamInterceptor(undefined);
    }
  });

  it("makes concurrent reset callers await the same teardown", async () => {
    let releaseReset: (() => void) | undefined;
    const resetPause = new Promise<void>((resolve) => {
      releaseReset = resolve;
    });
    setPipelineResetPauseForTest(resetPause);
    const first = resetPipelineState();
    const second = resetPipelineState();
    let secondSettled = false;
    void second.then(() => {
      secondSettled = true;
    });

    try {
      await Promise.resolve();
      expect(secondSettled).toBe(false);
      releaseReset?.();
      await Promise.all([first, second]);
      expect(secondSettled).toBe(true);
    } finally {
      releaseReset?.();
      await first;
      setPipelineResetPauseForTest(undefined);
    }
  });

  it("admits finalizers after a direct compact route initializes post-reset", async () => {
    await resetPipelineState();
    setUpstreamInterceptor(
      async () =>
        new Response(JSON.stringify({ output: [] }), {
          headers: { "content-type": "application/json" },
        }),
    );
    const compact = new Request("http://gateway.test/v1/responses/compact", {
      method: "POST",
      headers: {
        authorization: "Bearer test-key",
        "content-type": "application/json",
        "x-lore-project": process.cwd(),
        "x-lore-provider": "openai",
        "x-lore-upstream-url": "https://api.openai.com/v1",
        "x-lore-session-id": "direct-route-initializer",
      },
      body: JSON.stringify({
        model: "gpt-5.6-sol",
        instructions: "You are a coding agent.",
        input: [
          {
            role: "user",
            content: [{ type: "input_text", text: "compact" }],
          },
        ],
        tools: [],
      }),
    });

    try {
      await (
        await handleResponsesCompactEndpoint(compact, loadConfig())
      ).text();
      let postResponses = 0;
      setPostResponseStartObserverForTest(() => postResponses++);
      setUpstreamInterceptor(
        async () =>
          new Response(validResponsesSSE("resp_after_direct_compact"), {
            headers: { "content-type": "text/event-stream" },
          }),
      );
      const streamed = await handleRequest(
        makeResponsesRequest({
          sessionHeaders: { "x-lore-session-id": "post-direct-route" },
        }),
        loadConfig(),
      );
      await streamed.text();
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      expect(postResponses).toBe(1);
    } finally {
      setPostResponseStartObserverForTest(undefined);
      setUpstreamInterceptor(undefined);
      await resetPipelineState();
    }
  });

  it("allows authenticated sessions to use global warming controls", async () => {
    const sessionHeaders = {
      "x-lore-session-id": "authenticated-warming-admin",
    };
    const { isWarmingEnabled } = await import("../src/cache-warmer");
    setUpstreamInterceptor(
      async () =>
        new Response(validResponsesSSE("resp_warming_admin"), {
          headers: { "content-type": "text/event-stream" },
        }),
    );
    const command = (text: string): GatewayRequest => {
      const request = makeResponsesRequest({
        sessionHeaders,
        messages: [{ role: "user", content: [{ type: "text", text }] }],
      });
      request.stream = false;
      return request;
    };

    try {
      await (
        await handleRequest(
          makeResponsesRequest({ sessionHeaders }),
          loadConfig(),
        )
      ).text();
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      const off = await handleRequest(command("/lore:warm:off"), loadConfig());
      expect(await off.text()).toContain("Cache warming disabled globally");
      expect(isWarmingEnabled()).toBe(false);

      const on = await handleRequest(command("/lore:warm:on"), loadConfig());
      expect(await on.text()).toContain("Cache warming enabled globally");
      expect(isWarmingEnabled()).toBe(true);

      const reset = await handleRequest(
        command("/lore:warm:reset"),
        loadConfig(),
      );
      expect(await reset.text()).toContain(
        "Cache warming circuit breaker reset",
      );
    } finally {
      setUpstreamInterceptor(undefined);
      await resetPipelineState();
    }
  });

  it("persists a project binding made authoritative by curate", async () => {
    const sessionHeaders = {
      "x-lore-session-id": "curate-project-binding-session",
    };
    setUpstreamInterceptor(
      async () =>
        new Response(validResponsesSSE("resp_curate_project_binding"), {
          headers: { "content-type": "text/event-stream" },
        }),
    );

    try {
      const provisional = makeResponsesRequest({ sessionHeaders });
      delete provisional.rawHeaders["x-lore-project"];
      await (await handleRequest(provisional, loadConfig())).text();
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      const curate = makeResponsesRequest({
        sessionHeaders,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "/lore:curate" }],
          },
        ],
      });
      curate.stream = false;
      curate.rawHeaders["x-lore-project"] = "/tmp";
      const response = await handleRequest(curate, loadConfig());
      expect(response.status).toBe(200);
      await response.text();

      const state = [...getActiveSessions().values()].find(
        (candidate) =>
          candidate.headerSessionId === sessionHeaders["x-lore-session-id"],
      );
      expect(state).toBeDefined();
      expect(loadSessionTracking(state?.sessionID ?? "")).toMatchObject({
        projectPath: "/tmp",
        projectPathProvisional: false,
      });
    } finally {
      setUpstreamInterceptor(undefined);
      await resetPipelineState();
    }
  });

  it("rehydrates an evicted Tier-2 session for curate", async () => {
    setUpstreamInterceptor(
      async () =>
        new Response(validResponsesSSE("resp_tier2_curate"), {
          headers: { "content-type": "text/event-stream" },
        }),
    );

    try {
      await (
        await handleRequest(
          makeResponsesRequest({
            sessionHeaders: { "x-lore-session-id": "tier2-seed-session" },
          }),
          loadConfig(),
        )
      ).text();
      await resetPipelineState();
      setUpstreamInterceptor(
        async () =>
          new Response(validResponsesSSE("resp_tier2_curate"), {
            headers: { "content-type": "text/event-stream" },
          }),
      );

      saveSessionTracking("persisted-tier2-session", {
        credentialFingerprint: authFingerprint({
          scheme: "bearer",
          value: "test-key",
        }),
        headerName: "x-custom-session-key",
        headerSessionId: "tier2-custom-value",
        projectPath: process.cwd(),
        projectPathProvisional: false,
      });
      const curate = makeResponsesRequest({
        sessionHeaders: { "x-custom-session-key": "tier2-custom-value" },
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "/lore:curate" }],
          },
        ],
      });
      curate.stream = false;
      const response = await handleRequest(curate, loadConfig());
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("Curation complete");
      expect(getActiveSessions().has("persisted-tier2-session")).toBe(true);
    } finally {
      setUpstreamInterceptor(undefined);
      await resetPipelineState();
    }
  });

  it("fails closed when an unknown canonical slash header conflicts with a known alias", async () => {
    const legacyHeader = { "x-session-affinity": "slash-alias-session" };
    const store = vi.spyOn(temporal, "store");
    setUpstreamInterceptor(
      async () =>
        new Response(validResponsesSSE("resp_slash_alias"), {
          headers: { "content-type": "text/event-stream" },
        }),
    );

    try {
      const established = await handleRequest(
        makeResponsesRequest({ sessionHeaders: legacyHeader }),
        loadConfig(),
      );
      await established.text();
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      const slashRequest = (command: string): GatewayRequest => {
        const request = makeResponsesRequest({
          sessionHeaders: {
            "x-lore-session-id": "new-canonical-alias",
            ...legacyHeader,
          },
          messages: [
            { role: "user", content: [{ type: "text", text: command }] },
          ],
        });
        request.stream = false;
        return request;
      };
      const curate = await handleRequest(
        slashRequest("/lore:curate"),
        loadConfig(),
      );
      expect(await curate.text()).toContain(
        "No active session found for curation",
      );
      await (
        await handleRequest(slashRequest("/lore:amnesia:on"), loadConfig())
      ).text();

      const order: string[] = [];
      setPostResponseStartObserverForTest(() => order.push("post"));
      store.mockClear();
      const sensitive = await handleRequest(
        makeResponsesRequest({
          sessionHeaders: legacyHeader,
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: "sensitive turn" }],
            },
          ],
        }),
        loadConfig(),
      );
      await sensitive.text();
      order.push("eof");

      await (
        await handleRequest(slashRequest("/lore:amnesia:off"), loadConfig())
      ).text();
      order.push("slash");

      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      expect(order).toEqual(["eof", "slash", "post"]);
      expect(store).toHaveBeenCalled();
    } finally {
      store.mockRestore();
      setPostResponseStartObserverForTest(undefined);
      setUpstreamInterceptor(undefined);
      await resetPipelineState();
    }
  });

  it("does not confirm canonical migration from an aborted normal turn", async () => {
    const alias = "aborted-migration-alias";
    const canonical = "aborted-migration-canonical";
    let upstreamCalls = 0;
    setUpstreamInterceptor(async () => {
      upstreamCalls++;
      return new Response(validResponsesSSE("resp_migration_setup"), {
        headers: { "content-type": "text/event-stream" },
      });
    });
    let release!: () => void;
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    let waitingResolve!: () => void;
    const waiting = new Promise<void>((resolve) => {
      waitingResolve = resolve;
    });

    try {
      await (
        await handleRequest(
          makeResponsesRequest({
            sessionHeaders: { "x-session-affinity": alias },
          }),
          loadConfig(),
        )
      ).text();
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      const state = [...getActiveSessions().values()].find(
        (candidate) => candidate.headerSessionId === alias,
      );
      expect(state).toBeDefined();

      setPipelinePreUpstreamPauseForTest(paused, waitingResolve);
      const caller = new AbortController();
      const migration = makeResponsesRequest({
        sessionHeaders: {
          "x-lore-session-id": canonical,
          "x-session-affinity": alias,
        },
      });
      migration.signal = caller.signal;
      const failed = await handleRequest(migration, loadConfig());
      const failedBody = failed.text();
      await waiting;
      caller.abort(new DOMException("caller disconnected", "AbortError"));
      release();
      expect(await failedBody).toContain("event: response.failed");
      setPipelinePreUpstreamPauseForTest(undefined);

      const compact = await handleCompactEndpoint(
        new Request("http://gateway.test/v1/compact", {
          method: "POST",
          headers: {
            authorization: "Bearer test-key",
            "content-type": "application/json",
            "x-lore-session-id": canonical,
          },
          body: JSON.stringify({ project_path: process.cwd() }),
        }),
        loadConfig(),
      );
      expect(compact.status).toBe(404);
      expect(loadSessionTracking(state?.sessionID ?? "")).toMatchObject({
        headerName: "x-session-affinity",
        headerSessionId: alias,
      });
      expect(upstreamCalls).toBe(1);

      await (
        await handleRequest(
          makeResponsesRequest({
            sessionHeaders: { "x-lore-session-id": canonical },
          }),
          loadConfig(),
        )
      ).text();
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      expect(getActiveSessions().size).toBe(1);
      expect(loadSessionTracking(state?.sessionID ?? "")).toMatchObject({
        headerName: "x-lore-session-id",
        headerSessionId: canonical,
      });
      expect(upstreamCalls).toBe(2);
    } finally {
      release();
      setPipelinePreUpstreamPauseForTest(undefined);
      setUpstreamInterceptor(undefined);
      await resetPipelineState();
    }
  });

  it("converges concurrent first turns with the same canonical header", async () => {
    const canonical = "concurrent-first-canonical";
    let upstreamCalls = 0;
    setUpstreamInterceptor(async () => {
      upstreamCalls++;
      return new Response(
        validResponsesSSE(`resp_concurrent_${upstreamCalls}`),
        {
          headers: { "content-type": "text/event-stream" },
        },
      );
    });

    try {
      const first = handleRequest(
        makeResponsesRequest({
          sessionHeaders: { "x-lore-session-id": canonical },
        }),
        loadConfig(),
      );
      const second = handleRequest(
        makeResponsesRequest({
          sessionHeaders: { "x-lore-session-id": canonical },
        }),
        loadConfig(),
      );
      const responses = await Promise.all([first, second]);
      await Promise.all(responses.map((response) => response.text()));
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      const matching = [...getActiveSessions().values()].filter(
        (state) => state.headerSessionId === canonical,
      );
      expect(matching).toHaveLength(1);
      expect(loadSessionTracking(matching[0]?.sessionID ?? "")).toMatchObject({
        headerName: "x-lore-session-id",
        headerSessionId: canonical,
      });
      expect(upstreamCalls).toBe(2);
    } finally {
      setUpstreamInterceptor(undefined);
      await resetPipelineState();
    }
  });

  it("accounts a successful provisional canonical migration exactly once", async () => {
    const alias = "accounted-migration-alias";
    const canonical = "accounted-migration-canonical";
    let upstreamCall = 0;
    setUpstreamInterceptor(async () => {
      upstreamCall++;
      return new Response(
        upstreamCall === 1
          ? validResponsesSSE("resp_accounted_migration_setup")
          : validResponsesSSE(
              "resp_accounted_migration",
              "migration accepted",
              {
                input_tokens: 1_100,
                output_tokens: 100,
                input_tokens_details: { cache_write_tokens: 1_000 },
              },
            ),
        { headers: { "content-type": "text/event-stream" } },
      );
    });
    const store = vi.spyOn(temporal, "store");

    try {
      await (
        await handleRequest(
          makeResponsesRequest({
            sessionHeaders: { "x-session-affinity": alias },
          }),
          loadConfig(),
        )
      ).text();
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      const state = [...getActiveSessions().values()].find(
        (candidate) => candidate.headerSessionId === alias,
      );
      expect(state).toBeDefined();
      clearAllCosts();
      const today = new Date().toISOString().slice(0, 10);
      const ledgerBefore = getDailyCostForDay(today);
      store.mockClear();

      const response = await handleRequest(
        makeResponsesRequest({
          sessionHeaders: {
            "x-lore-session-id": canonical,
            "x-session-affinity": alias,
          },
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "account this provisional migration" },
              ],
            },
          ],
        }),
        loadConfig(),
      );
      expect(response.status).toBe(200);
      await response.text();
      await vi.waitFor(() => {
        expect(
          getSessionCosts(state?.sessionID ?? "")?.conversation,
        ).toMatchObject({
          inputTokens: 100,
          outputTokens: 100,
          cacheWriteTokens: 1_000,
          turns: 1,
        });
      });

      expect(getDailySpend().spend).toBeGreaterThan(0);
      expect(getDailyCostForDay(today)).toBeGreaterThan(ledgerBefore);
      expect(store).toHaveBeenCalledTimes(2);
      expect(loadSessionTracking(state?.sessionID ?? "")).toMatchObject({
        headerName: "x-lore-session-id",
        headerSessionId: canonical,
      });
    } finally {
      store.mockRestore();
      setUpstreamInterceptor(undefined);
      await resetPipelineState();
      clearAllCosts();
    }
  });

  it("does not confirm canonical migration when the completed response is cancelled", async () => {
    const alias = "cancelled-complete-alias";
    const canonical = "cancelled-complete-canonical";
    const store = vi.spyOn(temporal, "store");
    setUpstreamInterceptor(
      async () =>
        new Response(validResponsesSSE("resp_cancelled_complete"), {
          headers: { "content-type": "text/event-stream" },
        }),
    );

    try {
      await (
        await handleRequest(
          makeResponsesRequest({
            sessionHeaders: { "x-session-affinity": alias },
          }),
          loadConfig(),
        )
      ).text();
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      const state = [...getActiveSessions().values()].find(
        (candidate) => candidate.headerSessionId === alias,
      );
      const original = loadSessionTracking(state?.sessionID ?? "");
      clearAllCosts();
      store.mockClear();

      const response = await handleRequest(
        makeResponsesRequest({
          sessionHeaders: {
            "x-lore-session-id": canonical,
            "x-session-affinity": alias,
          },
        }),
        loadConfig(),
      );
      const reader = response.body?.getReader();
      expect(reader).toBeDefined();
      const decoder = new TextDecoder();
      let output = "";
      while (!output.includes("event: response.completed")) {
        const chunk = await reader?.read();
        expect(chunk?.done).toBe(false);
        if (chunk?.value)
          output += decoder.decode(chunk.value, { stream: true });
      }
      await reader?.cancel("client disconnected after terminal event");
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      expect(getSessionCosts(state?.sessionID ?? "")).toBeNull();
      expect(store).not.toHaveBeenCalled();
      expect(loadSessionTracking(state?.sessionID ?? "")).toEqual(original);
      const compact = await handleCompactEndpoint(
        new Request("http://gateway.test/v1/compact", {
          method: "POST",
          headers: {
            authorization: "Bearer test-key",
            "content-type": "application/json",
            "x-lore-session-id": canonical,
          },
          body: JSON.stringify({ project_path: process.cwd() }),
        }),
        loadConfig(),
      );
      expect(compact.status).toBe(404);
    } finally {
      store.mockRestore();
      setUpstreamInterceptor(undefined);
      await resetPipelineState();
      clearAllCosts();
    }
  });

  it.each(["completed", "incomplete"] as const)(
    "drops stale provisional %s accounting after a bounded reset drain",
    async (status) => {
      const alias = `stale-${status}-accounting-alias`;
      const canonical = `stale-${status}-accounting-canonical`;
      let upstreamCall = 0;
      setUpstreamInterceptor(async () => {
        upstreamCall++;
        return new Response(
          upstreamCall === 1 || status === "completed"
            ? validResponsesSSE(`resp_stale_${status}_${upstreamCall}`)
            : incompleteResponsesSSE("resp_stale_incomplete_accounting"),
          { headers: { "content-type": "text/event-stream" } },
        );
      });
      let releaseFinalizer!: () => void;
      const finalizerPause = new Promise<void>((resolve) => {
        releaseFinalizer = resolve;
      });
      let finalizerWaitingResolve!: () => void;
      const finalizerWaiting = new Promise<void>((resolve) => {
        finalizerWaitingResolve = resolve;
      });

      try {
        await (
          await handleRequest(
            makeResponsesRequest({
              sessionHeaders: { "x-session-affinity": alias },
            }),
            loadConfig(),
          )
        ).text();
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));
        const state = [...getActiveSessions().values()].find(
          (candidate) => candidate.headerSessionId === alias,
        );
        expect(state).toBeDefined();
        clearAllCosts();

        setProvisionalFinalizerPauseForTest(
          finalizerPause,
          finalizerWaitingResolve,
        );
        setPipelineResetSettleTimeoutForTest(0);
        const response = await handleRequest(
          makeResponsesRequest({
            sessionHeaders: {
              "x-lore-session-id": canonical,
              "x-session-affinity": alias,
            },
          }),
          loadConfig(),
        );
        expect(response.status).toBe(200);
        const body = await response.text();
        expect(body).toContain(
          status === "completed"
            ? "event: response.completed"
            : "event: response.incomplete",
        );
        await finalizerWaiting;
        await resetPipelineState();

        clearAllCosts();
        const today = new Date().toISOString().slice(0, 10);
        const ledgerBefore = getDailyCostForDay(today);
        releaseFinalizer();
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));

        expect(getSessionCosts(state?.sessionID ?? "")).toBeNull();
        expect(getDailyCostForDay(today)).toBe(ledgerBefore);
      } finally {
        releaseFinalizer();
        setPipelineResetSettleTimeoutForTest();
        setProvisionalFinalizerPauseForTest(undefined);
        setUpstreamInterceptor(undefined);
        await resetPipelineState();
        clearAllCosts();
      }
    },
  );

  it("strips context markers before provisional migration reaches upstream", async () => {
    const alias = "marker-provisional-alias";
    let upstreamCall = 0;
    const forwardedBodies: string[] = [];
    setUpstreamInterceptor(async (body) => {
      upstreamCall++;
      forwardedBodies.push(JSON.stringify(body));
      return new Response(validResponsesSSE(`resp_marker_${upstreamCall}`), {
        headers: { "content-type": "text/event-stream" },
      });
    });

    try {
      await (
        await handleRequest(
          makeResponsesRequest({
            sessionHeaders: { "x-session-affinity": alias },
          }),
          loadConfig(),
        )
      ).text();
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      const response = await handleRequest(
        makeResponsesRequest({
          sessionHeaders: {
            "x-lore-session-id": "marker-provisional-canonical",
            "x-session-affinity": alias,
          },
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: "continue\n[lore:session-id=secret-marker]\n[lore:project=/secret/path]",
                },
              ],
            },
          ],
        }),
        loadConfig(),
      );
      await response.text();
      expect(forwardedBodies.at(-1)).not.toContain("lore:session-id");
      expect(forwardedBodies.at(-1)).not.toContain("lore:project");
    } finally {
      setUpstreamInterceptor(undefined);
      await resetPipelineState();
    }
  });

  it.each(["provider", "malformed", "missing-terminal", "transport"] as const)(
    "does not confirm canonical migration after a %s Responses failure",
    async (failure) => {
      const alias = `failed-${failure}-alias`;
      const canonical = `failed-${failure}-canonical`;
      let upstreamCall = 0;
      setUpstreamInterceptor(async () => {
        upstreamCall++;
        if (upstreamCall === 1) {
          return new Response(validResponsesSSE(`resp_${failure}_setup`), {
            headers: { "content-type": "text/event-stream" },
          });
        }
        if (failure === "provider") {
          return new Response(
            responsesEvent("response.failed", {
              response: {
                id: `resp_${failure}`,
                model: "gpt-5.6-sol",
                status: "failed",
                error: { type: "server_error", message: "provider failed" },
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          );
        }
        if (failure === "malformed") {
          return new Response("event: response.created\ndata: {bad}\n\n", {
            headers: { "content-type": "text/event-stream" },
          });
        }
        if (failure === "missing-terminal") {
          return new Response(
            responsesEvent("response.created", {
              response: { id: `resp_${failure}`, status: "in_progress" },
            }),
            { headers: { "content-type": "text/event-stream" } },
          );
        }
        return new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.error(new Error("transport failed"));
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      });
      const store = vi.spyOn(temporal, "store");

      try {
        await (
          await handleRequest(
            makeResponsesRequest({
              sessionHeaders: { "x-session-affinity": alias },
            }),
            loadConfig(),
          )
        ).text();
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));
        const state = [...getActiveSessions().values()].find(
          (candidate) => candidate.headerSessionId === alias,
        );
        expect(state).toBeDefined();
        const originalTracking = loadSessionTracking(state?.sessionID ?? "");
        store.mockClear();

        const migration = makeResponsesRequest({
          sessionHeaders: {
            "x-lore-session-id": canonical,
            "x-session-affinity": alias,
          },
        });
        migration.rawHeaders["x-lore-project"] =
          "/tmp/untrusted-provisional-project";
        const failed = await handleRequest(migration, loadConfig());
        expect(await failed.text()).toContain("event: response.failed");
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));

        const compact = await handleCompactEndpoint(
          new Request("http://gateway.test/v1/compact", {
            method: "POST",
            headers: {
              authorization: "Bearer test-key",
              "content-type": "application/json",
              "x-lore-session-id": canonical,
            },
            body: JSON.stringify({ project_path: process.cwd() }),
          }),
          loadConfig(),
        );
        expect(compact.status).toBe(404);
        expect(store).not.toHaveBeenCalled();
        expect(loadSessionTracking(state?.sessionID ?? "")).toEqual(
          originalTracking,
        );
      } finally {
        store.mockRestore();
        setUpstreamInterceptor(undefined);
        await resetPipelineState();
      }
    },
  );

  it.each(["failed", "cancelled", "incomplete", "in_progress"] as const)(
    "does not confirm canonical migration after a non-stream %s Responses body",
    async (status) => {
      const alias = `nonstream-${status}-alias`;
      const canonical = `nonstream-${status}-canonical`;
      let upstreamCall = 0;
      setUpstreamInterceptor(async () => {
        upstreamCall++;
        if (upstreamCall === 1) {
          return new Response(validResponsesSSE(`resp_${status}_setup`), {
            headers: { "content-type": "text/event-stream" },
          });
        }
        return new Response(
          JSON.stringify({
            id: `resp_nonstream_${status}`,
            object: "response",
            created_at: 0,
            model: "__test_fake_model__",
            status,
            output: [
              {
                type: "message",
                id: `msg_nonstream_${status}`,
                role: "assistant",
                status,
                content: [
                  {
                    type: "output_text",
                    text: "must not persist",
                    annotations: [],
                  },
                ],
              },
            ],
            usage: {
              input_tokens: 1_100,
              output_tokens: 100,
              input_tokens_details: { cache_write_tokens: 1_000 },
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      });
      const store = vi.spyOn(temporal, "store");

      try {
        await (
          await handleRequest(
            makeResponsesRequest({
              sessionHeaders: { "x-session-affinity": alias },
            }),
            loadConfig(),
          )
        ).text();
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));
        const state = [...getActiveSessions().values()].find(
          (candidate) => candidate.headerSessionId === alias,
        );
        expect(state).toBeDefined();
        saveSessionTracking(state?.sessionID ?? "", {
          resolvedConversationTTL: "1h",
        });
        expect(
          evictLiveSessionForTest(
            makeResponsesRequest({
              sessionHeaders: { "x-session-affinity": alias },
            }),
          ),
        ).toBe(true);
        clearAllCosts();
        store.mockClear();

        const failed = makeResponsesRequest({
          sessionHeaders: {
            "x-lore-session-id": canonical,
            "x-session-affinity": alias,
          },
        });
        failed.stream = false;
        const response = await handleRequest(failed, loadConfig());
        if (status === "incomplete") {
          expect(response.status).toBe(200);
          const body = (await response.json()) as Record<string, unknown>;
          expect(body.status).toBe("incomplete");
          expect(body.incomplete_details).toEqual({
            reason: "max_output_tokens",
          });
        } else {
          expect(response.status).toBe(502);
          expect(await response.text()).toContain("Gateway request failed");
        }
        await vi.waitFor(() => {
          expect(
            getSessionCosts(state?.sessionID ?? "")?.conversation,
          ).toMatchObject({
            inputTokens: 100,
            outputTokens: 100,
            cacheWriteTokens: 1_000,
            turns: 1,
          });
        });
        expect(
          getSessionCosts(state?.sessionID ?? "")?.conversation.cost,
        ).toBeCloseTo(
          computeCallCost(
            "__test_fake_model__",
            {
              input_tokens: 100,
              output_tokens: 100,
              cache_creation_input_tokens: 1_000,
            },
            "conversation",
            "1h",
          ).total,
        );
        expect(store).not.toHaveBeenCalled();

        const compact = await handleCompactEndpoint(
          new Request("http://gateway.test/v1/compact", {
            method: "POST",
            headers: {
              authorization: "Bearer test-key",
              "content-type": "application/json",
              "x-lore-session-id": canonical,
            },
            body: JSON.stringify({ project_path: process.cwd() }),
          }),
          loadConfig(),
        );
        expect(compact.status).toBe(404);
        expect(loadSessionTracking(state?.sessionID ?? "")).toMatchObject({
          headerName: "x-session-affinity",
          headerSessionId: alias,
        });
      } finally {
        store.mockRestore();
        setUpstreamInterceptor(undefined);
        await resetPipelineState();
        clearAllCosts();
      }
    },
  );

  it.each(
    (
      [
        {
          protocol: "anthropic",
          provider: "anthropic",
          upstream: "https://api.anthropic.com",
          malformed: {},
        },
        {
          protocol: "openai",
          provider: "openai",
          upstream: "https://api.openai.com",
          malformed: { choices: [] },
        },
        {
          protocol: "openai-responses",
          provider: "openai",
          upstream: "https://api.openai.com",
          malformed: { status: "completed" },
        },
        {
          protocol: "gemini",
          provider: "google",
          upstream: "https://generativelanguage.googleapis.com",
          malformed: {},
        },
      ] as const
    ).flatMap((entry) => [
      { ...entry, shape: "malformed", body: entry.malformed },
      {
        ...entry,
        shape: "error-envelope",
        body: { error: { type: "server_error", message: "provider failed" } },
      },
    ]),
  )(
    "does not confirm canonical migration after a $protocol 2xx $shape body",
    async ({ protocol, provider, upstream, body }) => {
      const alias = `nonstream-${protocol}-alias`;
      const canonical = `nonstream-${protocol}-canonical`;
      let upstreamCall = 0;
      setUpstreamInterceptor(async () => {
        upstreamCall++;
        if (upstreamCall === 1) {
          return new Response(validResponsesSSE(`resp_${protocol}_setup`), {
            headers: { "content-type": "text/event-stream" },
          });
        }
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      });
      const store = vi.spyOn(temporal, "store");

      try {
        await (
          await handleRequest(
            makeResponsesRequest({
              sessionHeaders: { "x-session-affinity": alias },
            }),
            loadConfig(),
          )
        ).text();
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));
        const state = [...getActiveSessions().values()].find(
          (candidate) => candidate.headerSessionId === alias,
        );
        expect(state).toBeDefined();
        const originalTracking = loadSessionTracking(state?.sessionID ?? "");
        store.mockClear();

        const migration = makeResponsesRequest({
          sessionHeaders: {
            "x-lore-session-id": canonical,
            "x-session-affinity": alias,
          },
        });
        migration.protocol = protocol;
        migration.stream = false;
        migration.rawHeaders["x-lore-provider"] = provider;
        migration.rawHeaders["x-lore-upstream-url"] = upstream;
        const response = await handleRequest(migration, loadConfig());
        expect(response.status).toBe(502);
        expect(await response.text()).toContain("Gateway request failed");
        await new Promise((resolve) => setImmediate(resolve));

        expect(store).not.toHaveBeenCalled();
        expect(loadSessionTracking(state?.sessionID ?? "")).toEqual(
          originalTracking,
        );
        const compact = await handleCompactEndpoint(
          new Request("http://gateway.test/v1/compact", {
            method: "POST",
            headers: {
              authorization: "Bearer test-key",
              "content-type": "application/json",
              "x-lore-session-id": canonical,
            },
            body: JSON.stringify({ project_path: process.cwd() }),
          }),
          loadConfig(),
        );
        expect(compact.status).toBe(404);
      } finally {
        store.mockRestore();
        setUpstreamInterceptor(undefined);
        await resetPipelineState();
      }
    },
  );

  it("does not migrate a confirmed alias across confident projects", async () => {
    const alias = "cross-project-migration-alias";
    const canonical = "cross-project-migration-canonical";
    const projectA = "/tmp/lore-cross-header-project-a";
    const projectB = "/tmp/lore-cross-header-project-b";
    let upstreamCall = 0;
    setUpstreamInterceptor(async () => {
      upstreamCall++;
      return new Response(validResponsesSSE(`resp_cross_${upstreamCall}`), {
        headers: { "content-type": "text/event-stream" },
      });
    });

    try {
      const established = makeResponsesRequest({
        sessionHeaders: { "x-session-affinity": alias },
      });
      established.rawHeaders["x-lore-project"] = projectA;
      await (await handleRequest(established, loadConfig())).text();
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      const original = [...getActiveSessions().values()].find(
        (state) => state.headerSessionId === alias,
      );
      expect(original).toMatchObject({
        projectPath: projectA,
        projectPathProvisional: false,
      });

      const migration = makeResponsesRequest({
        sessionHeaders: {
          "x-lore-session-id": canonical,
          "x-session-affinity": alias,
        },
      });
      migration.rawHeaders["x-lore-project"] = projectB;
      expect(
        await (await handleRequest(migration, loadConfig())).text(),
      ).toContain("event: response.completed");
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      expect(original).toMatchObject({
        headerName: "x-session-affinity",
        headerSessionId: alias,
        projectPath: projectA,
        projectPathProvisional: false,
      });
      const independent = [...getActiveSessions().values()].find(
        (state) => state.headerSessionId === canonical,
      );
      expect(independent).toMatchObject({
        headerName: "x-lore-session-id",
        projectPath: projectB,
        projectPathProvisional: false,
      });
      expect(independent?.sessionID).not.toBe(original?.sessionID);
      expect(upstreamCall).toBe(2);
    } finally {
      setUpstreamInterceptor(undefined);
      await resetPipelineState();
    }
  });

  it("rechecks project binding after a concurrent first turn claims the fallback session", async () => {
    const alias = "concurrent-project-migration-alias";
    const canonical = "concurrent-project-migration-canonical";
    const projectA = "/tmp/lore-concurrent-project-a";
    const projectB = "/tmp/lore-concurrent-project-b";
    let releaseFirst!: () => void;
    const firstPause = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstWaitingResolve!: () => void;
    const firstWaiting = new Promise<void>((resolve) => {
      firstWaitingResolve = resolve;
    });
    let upstreamCalls = 0;
    setUpstreamInterceptor(async () => {
      upstreamCalls++;
      return new Response(
        validResponsesSSE(`resp_project_race_${upstreamCalls}`),
        {
          headers: { "content-type": "text/event-stream" },
        },
      );
    });
    setBeforeUpstreamCaptureForTest(async (request) => {
      if (
        request.rawHeaders["x-session-affinity"] === alias &&
        !request.rawHeaders["x-lore-session-id"]
      ) {
        firstWaitingResolve();
        await firstPause;
      }
    });

    try {
      const first = makeResponsesRequest({
        sessionHeaders: { "x-session-affinity": alias },
      });
      first.rawHeaders["x-lore-project"] = projectA;
      const firstResponse = await handleRequest(first, loadConfig());
      const firstBody = firstResponse.text();
      await firstWaiting;

      const migration = makeResponsesRequest({
        sessionHeaders: {
          "x-lore-session-id": canonical,
          "x-session-affinity": alias,
        },
      });
      migration.rawHeaders["x-lore-project"] = projectB;
      const migrationResponse = await handleRequest(migration, loadConfig());
      const migrationBody = migrationResponse.text();
      await vi.waitFor(() =>
        expect(pendingPipelineSessionClaimCountForTest()).toBe(1),
      );

      releaseFirst();
      expect(await firstBody).toContain("event: response.completed");
      const boundAfterFirst = [...getActiveSessions().values()].find(
        (state) => state.headerSessionId === alias,
      );
      expect(boundAfterFirst).toMatchObject({
        projectPath: projectA,
        projectPathProvisional: false,
      });
      expect(await migrationBody).toContain("event: response.failed");
      expect(upstreamCalls).toBe(1);

      setBeforeUpstreamCaptureForTest(undefined);
      const retry = makeResponsesRequest({
        sessionHeaders: {
          "x-lore-session-id": canonical,
          "x-session-affinity": alias,
        },
      });
      retry.rawHeaders["x-lore-project"] = projectB;
      expect(await (await handleRequest(retry, loadConfig())).text()).toContain(
        "event: response.completed",
      );
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      const original = [...getActiveSessions().values()].find(
        (state) => state.headerSessionId === alias,
      );
      const independent = [...getActiveSessions().values()].find(
        (state) => state.headerSessionId === canonical,
      );
      expect(original).toMatchObject({
        projectPath: projectA,
        projectPathProvisional: false,
      });
      expect(independent).toMatchObject({
        projectPath: projectB,
        projectPathProvisional: false,
      });
      expect(independent?.sessionID).not.toBe(original?.sessionID);
      expect(upstreamCalls).toBe(2);
    } finally {
      releaseFirst();
      setBeforeUpstreamCaptureForTest(undefined);
      setUpstreamInterceptor(undefined);
      await resetPipelineState();
    }
  });

  it("does not migrate a confirmed alias across confidently inferred projects", async () => {
    const alias = "inferred-project-migration-alias";
    const canonical = "inferred-project-migration-canonical";
    const projectA = "/tmp/lore-inferred-migration-a";
    const projectB = "/tmp/lore-inferred-migration-b";
    let upstreamCall = 0;
    setUpstreamInterceptor(async () => {
      upstreamCall++;
      return new Response(validResponsesSSE(`resp_inferred_${upstreamCall}`), {
        headers: { "content-type": "text/event-stream" },
      });
    });

    try {
      const established = makeResponsesRequest({
        sessionHeaders: { "x-session-affinity": alias },
      });
      established.rawHeaders["x-lore-project"] = projectA;
      await (await handleRequest(established, loadConfig())).text();
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      const original = [...getActiveSessions().values()].find(
        (state) => state.headerSessionId === alias,
      );

      const migration = makeResponsesRequest({
        sessionHeaders: {
          "x-lore-session-id": canonical,
          "x-session-affinity": alias,
        },
      });
      delete migration.rawHeaders["x-lore-project"];
      migration.system = `You are a coding agent.\nWorking directory: ${projectB}`;
      await (await handleRequest(migration, loadConfig())).text();
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      expect(original).toMatchObject({
        headerName: "x-session-affinity",
        headerSessionId: alias,
        projectPath: projectA,
      });
      const independent = [...getActiveSessions().values()].find(
        (state) => state.headerSessionId === canonical,
      );
      expect(independent).toMatchObject({
        headerName: "x-lore-session-id",
        projectPath: projectB,
      });
      expect(independent?.sessionID).not.toBe(original?.sessionID);
    } finally {
      setUpstreamInterceptor(undefined);
      await resetPipelineState();
    }
  });

  it.each([false, true])(
    "does not confirm canonical migration after a blocked Gemini response (stream=%s)",
    async (stream) => {
      const alias = `blocked-gemini-${stream}-alias`;
      const canonical = `blocked-gemini-${stream}-canonical`;
      let upstreamCall = 0;
      setUpstreamInterceptor(async () => {
        upstreamCall++;
        if (upstreamCall === 1) {
          return new Response(validResponsesSSE("resp_gemini_block_setup"), {
            headers: { "content-type": "text/event-stream" },
          });
        }
        const blocked = {
          responseId: "gemini-blocked",
          modelVersion: "gemini-test",
          promptFeedback: { blockReason: "SAFETY" },
          usageMetadata: {
            promptTokenCount: 1,
            candidatesTokenCount: 0,
            totalTokenCount: 1,
          },
        };
        return new Response(
          stream
            ? `data: ${JSON.stringify(blocked)}\n\n`
            : JSON.stringify(blocked),
          {
            headers: {
              "content-type": stream ? "text/event-stream" : "application/json",
            },
          },
        );
      });
      const store = vi.spyOn(temporal, "store");

      try {
        await (
          await handleRequest(
            makeResponsesRequest({
              sessionHeaders: { "x-session-affinity": alias },
            }),
            loadConfig(),
          )
        ).text();
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));
        const state = [...getActiveSessions().values()].find(
          (candidate) => candidate.headerSessionId === alias,
        );
        const original = loadSessionTracking(state?.sessionID ?? "");
        store.mockClear();

        const migration = makeResponsesRequest({
          sessionHeaders: {
            "x-lore-session-id": canonical,
            "x-session-affinity": alias,
          },
        });
        migration.protocol = "gemini";
        migration.stream = stream;
        migration.rawHeaders["x-lore-provider"] = "google";
        migration.rawHeaders["x-lore-upstream-url"] =
          "https://generativelanguage.googleapis.com";
        await (await handleRequest(migration, loadConfig())).text();
        await new Promise((resolve) => setImmediate(resolve));

        expect(store).not.toHaveBeenCalled();
        expect(loadSessionTracking(state?.sessionID ?? "")).toEqual(original);
        expect(state).toMatchObject({
          headerName: "x-session-affinity",
          headerSessionId: alias,
        });
      } finally {
        store.mockRestore();
        setUpstreamInterceptor(undefined);
        await resetPipelineState();
      }
    },
  );

  it("rejects a provisional canonical migration that conflicts with a confirmed alias", async () => {
    const aliasA = "provisional-conflict-alias-a";
    const aliasB = "provisional-conflict-alias-b";
    const canonical = "provisional-conflict-canonical";
    const projectA = "/tmp/lore-provisional-conflict-a";
    const projectB = "/tmp/lore-provisional-conflict-b";
    let upstreamCall = 0;
    setUpstreamInterceptor(async () => {
      upstreamCall++;
      return new Response(validResponsesSSE(`resp_conflict_${upstreamCall}`), {
        headers: { "content-type": "text/event-stream" },
      });
    });
    const establish = async (alias: string, project: string): Promise<void> => {
      const request = makeResponsesRequest({
        sessionHeaders: { "x-session-affinity": alias },
      });
      request.rawHeaders["x-lore-project"] = project;
      await (await handleRequest(request, loadConfig())).text();
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
    };
    let release!: () => void;
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    let waitingResolve!: () => void;
    const waiting = new Promise<void>((resolve) => {
      waitingResolve = resolve;
    });

    try {
      await establish(aliasA, projectA);
      await establish(aliasB, projectB);
      const stateA = [...getActiveSessions().values()].find(
        (state) => state.headerSessionId === aliasA,
      );
      const stateB = [...getActiveSessions().values()].find(
        (state) => state.headerSessionId === aliasB,
      );
      expect(stateA?.sessionID).not.toBe(stateB?.sessionID);

      setPipelinePreUpstreamPauseForTest(paused, waitingResolve);
      const first = makeResponsesRequest({
        sessionHeaders: {
          "x-lore-session-id": canonical,
          "x-session-affinity": aliasA,
        },
      });
      first.rawHeaders["x-lore-project"] = projectA;
      const firstResponse = await handleRequest(first, loadConfig());
      const firstBody = firstResponse.text();
      await waiting;
      setPipelinePreUpstreamPauseForTest(undefined);

      const conflicting = makeResponsesRequest({
        sessionHeaders: {
          "x-lore-session-id": canonical,
          "x-session-affinity": aliasB,
        },
      });
      conflicting.rawHeaders["x-lore-project"] = projectB;
      const conflictingResponse = await handleRequest(
        conflicting,
        loadConfig(),
      );
      const conflictingBody = conflictingResponse.text();
      release();

      expect(await firstBody).toContain("event: response.completed");
      expect(await conflictingBody).toContain("event: response.failed");
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      expect(stateA).toMatchObject({
        headerName: "x-lore-session-id",
        headerSessionId: canonical,
        projectPath: projectA,
      });
      expect(stateB).toMatchObject({
        headerName: "x-session-affinity",
        headerSessionId: aliasB,
        projectPath: projectB,
      });
      expect(upstreamCall).toBe(3);
    } finally {
      release();
      setPipelinePreUpstreamPauseForTest(undefined);
      setUpstreamInterceptor(undefined);
      await resetPipelineState();
    }
  });

  it("does not confirm expired provisional ownership after another session claims the canonical header", async () => {
    const aliasA = "expired-owner-alias-a";
    const aliasB = "expired-owner-alias-b";
    const canonical = "expired-owner-canonical";
    const projectA = "/tmp/lore-expired-owner-a";
    const projectB = "/tmp/lore-expired-owner-b";
    let upstreamCall = 0;
    setUpstreamInterceptor(async () => {
      upstreamCall++;
      if (upstreamCall === 3) {
        return new Response(JSON.stringify({ error: "validation failed" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(validResponsesSSE(`resp_expired_${upstreamCall}`), {
        headers: { "content-type": "text/event-stream" },
      });
    });
    const establish = async (alias: string, project: string): Promise<void> => {
      const request = makeResponsesRequest({
        sessionHeaders: { "x-session-affinity": alias },
      });
      request.rawHeaders["x-lore-project"] = project;
      await (await handleRequest(request, loadConfig())).text();
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
    };
    let release!: () => void;
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    let waitingResolve!: () => void;
    const waiting = new Promise<void>((resolve) => {
      waitingResolve = resolve;
    });

    try {
      await establish(aliasA, projectA);
      await establish(aliasB, projectB);
      const stateA = [...getActiveSessions().values()].find(
        (state) => state.headerSessionId === aliasA,
      );
      const stateB = [...getActiveSessions().values()].find(
        (state) => state.headerSessionId === aliasB,
      );
      const request = (alias: string, project: string): GatewayRequest => {
        const result = makeResponsesRequest({
          sessionHeaders: {
            "x-lore-session-id": canonical,
            "x-session-affinity": alias,
          },
        });
        result.rawHeaders["x-lore-project"] = project;
        return result;
      };

      await (
        await handleRequest(request(aliasA, projectA), loadConfig())
      ).text();
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      const costsBeforeExpiredRetry = structuredClone(
        getSessionCosts(stateA?.sessionID ?? "")?.conversation,
      );
      setPipelinePreUpstreamPauseForTest(paused, waitingResolve);
      const retryA = await handleRequest(
        request(aliasA, projectA),
        loadConfig(),
      );
      const retryABody = retryA.text();
      await waiting;
      setPipelinePreUpstreamPauseForTest(undefined);
      expireProvisionalHeaderMappingsForTest();

      await (
        await handleRequest(request(aliasB, projectB), loadConfig())
      ).text();
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      release();
      await retryABody;
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      expect(stateA).toMatchObject({
        headerName: "x-session-affinity",
        headerSessionId: aliasA,
        projectPath: projectA,
      });
      expect(stateB).toMatchObject({
        headerName: "x-lore-session-id",
        headerSessionId: canonical,
        projectPath: projectB,
      });
      expect(
        [...getActiveSessions().values()].filter(
          (state) => state.headerSessionId === canonical,
        ),
      ).toHaveLength(1);
      expect(getSessionCosts(stateA?.sessionID ?? "")?.conversation).toEqual(
        costsBeforeExpiredRetry,
      );
    } finally {
      release();
      setPipelinePreUpstreamPauseForTest(undefined);
      setUpstreamInterceptor(undefined);
      await resetPipelineState();
    }
  });

  it("does not learn Tier-2 header evidence from failed requests", async () => {
    const candidateHeader = "x-candidate-session";
    const globalHeader = "x-global-session";
    const candidateValue = "candidate-session-a";
    const otherCandidateValue = "candidate-session-b";
    const globalValue = "global-session-a";
    const failedGlobalValue = "global-session-b";
    let upstreamCall = 0;
    setUpstreamInterceptor(async () => {
      upstreamCall++;
      if (upstreamCall === 3 || upstreamCall === 4) {
        return new Response(JSON.stringify({ error: "upstream failed" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(validResponsesSSE(`resp_learning_${upstreamCall}`), {
        headers: { "content-type": "text/event-stream" },
      });
    });
    const messages = (seed: string, turn: number): GatewayRequest["messages"] =>
      Array.from({ length: turn * 2 - 1 }, (_, index) => ({
        role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
        content: [
          {
            type: "text" as const,
            text: index === 0 ? seed : `${seed} turn ${index}`,
          },
        ],
      }));
    const turn = async (
      sessionHeaders: Record<string, string>,
      seed: string,
      number: number,
      succeeds: boolean,
    ): Promise<void> => {
      const response = await handleRequest(
        makeResponsesRequest({
          sessionHeaders,
          messages: messages(seed, number),
        }),
        loadConfig(),
      );
      const body = await response.text();
      expect(body).toContain(
        succeeds ? "event: response.completed" : "event: response.failed",
      );
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
    };

    try {
      // Establish legitimate uniqueness only for candidateHeader.
      await turn(
        { [candidateHeader]: otherCandidateValue },
        "other successful session",
        1,
        true,
      );
      await turn(
        {
          [candidateHeader]: candidateValue,
          [globalHeader]: globalValue,
        },
        "primary session",
        1,
        true,
      );
      const primary = [...getActiveSessions().values()].find(
        (state) =>
          state.candidateHeaders?.get(globalHeader)?.value === globalValue,
      );
      expect(primary?.candidateHeaders?.get(candidateHeader)?.seenCount).toBe(
        1,
      );
      expect(primary?.candidateHeaders?.get(globalHeader)?.seenCount).toBe(1);

      // A failed new session must not add global uniqueness.
      await turn(
        { [globalHeader]: failedGlobalValue },
        "failed distinct session",
        1,
        false,
      );
      expect(
        [...getActiveSessions().values()].some(
          (state) =>
            state.candidateHeaders?.get(globalHeader)?.value ===
            failedGlobalValue,
        ),
      ).toBe(false);

      // A failed matched turn must not advance the primary candidates.
      await turn(
        {
          [candidateHeader]: candidateValue,
          [globalHeader]: globalValue,
        },
        "primary session",
        2,
        false,
      );
      expect(primary?.candidateHeaders?.get(candidateHeader)?.seenCount).toBe(
        1,
      );
      expect(primary?.candidateHeaders?.get(globalHeader)?.seenCount).toBe(1);

      // The retry is only the second successful observation. If the failed
      // matched turn counted, candidateHeader would promote here.
      await turn(
        {
          [candidateHeader]: candidateValue,
          [globalHeader]: globalValue,
        },
        "primary session",
        2,
        true,
      );
      expect(primary?.headerSessionId).toBeUndefined();
      expect(primary?.candidateHeaders?.get(candidateHeader)?.seenCount).toBe(
        2,
      );
      expect(primary?.candidateHeaders?.get(globalHeader)?.seenCount).toBe(2);

      // The third successful globalHeader observation remains non-unique. If
      // the failed new session counted globally, it would promote here.
      await turn({ [globalHeader]: globalValue }, "primary session", 3, true);
      expect(primary?.headerSessionId).toBeUndefined();
      expect(primary?.candidateHeaders?.get(globalHeader)?.seenCount).toBe(3);
    } finally {
      setUpstreamInterceptor(undefined);
      await resetPipelineState();
    }
  });

  it("keeps failed Tier-2 promotion retries provisional until success", async () => {
    const headerName = "x-retry-session";
    const targetValue = "retry-session-target";
    const distinctValue = "retry-session-other";
    let upstreamCall = 0;
    setUpstreamInterceptor(async () => {
      upstreamCall++;
      if (upstreamCall === 4 || upstreamCall === 5) {
        return new Response(JSON.stringify({ error: "upstream failed" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(validResponsesSSE(`resp_retry_${upstreamCall}`), {
        headers: { "content-type": "text/event-stream" },
      });
    });
    const messages = (seed: string, turn: number): GatewayRequest["messages"] =>
      Array.from({ length: turn * 2 - 1 }, (_, index) => ({
        role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
        content: [
          {
            type: "text" as const,
            text: index === 0 ? seed : `${seed} turn ${index}`,
          },
        ],
      }));
    const turn = async (
      headerValue: string,
      seed: string,
      number: number,
      succeeds: boolean,
    ): Promise<void> => {
      const response = await handleRequest(
        makeResponsesRequest({
          sessionHeaders: { [headerName]: headerValue },
          messages: messages(seed, number),
        }),
        loadConfig(),
      );
      const body = await response.text();
      expect(body).toContain(
        succeeds ? "event: response.completed" : "event: response.failed",
      );
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
    };
    const store = vi.spyOn(temporal, "store");

    try {
      await turn(distinctValue, "other session", 1, true);
      await turn(targetValue, "target session", 1, true);
      await turn(targetValue, "target session", 2, true);
      const target = [...getActiveSessions().values()].find(
        (state) =>
          state.candidateHeaders?.get(headerName)?.value === targetValue,
      );
      expect(target).toBeDefined();
      expect(target?.messageCount).toBe(3);
      expect(target?.candidateHeaders?.get(headerName)?.seenCount).toBe(2);
      store.mockClear();

      // The third observation promotes only provisionally, and provider failure
      // must leave all session-owned state unchanged.
      await turn(targetValue, "target session", 3, false);
      expect(target?.messageCount).toBe(3);
      expect(target?.candidateHeaders?.get(headerName)?.seenCount).toBe(2);
      expect(target?.headerName).toBeUndefined();
      expect(target?.headerSessionId).toBeUndefined();
      expect(store).not.toHaveBeenCalled();

      // A retry resolved from the provisional index must remain on the same
      // validation-only path rather than entering the full pipeline early.
      await turn(targetValue, "target session", 3, false);
      expect(target?.messageCount).toBe(3);
      expect(target?.candidateHeaders?.get(headerName)?.seenCount).toBe(2);
      expect(target?.headerName).toBeUndefined();
      expect(target?.headerSessionId).toBeUndefined();
      expect(store).not.toHaveBeenCalled();

      const slash = makeResponsesRequest({
        sessionHeaders: { [headerName]: targetValue },
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "/lore:amnesia:on" }],
          },
        ],
      });
      const slashResponse = await handleRequest(slash, loadConfig());
      expect(await slashResponse.text()).toContain(
        "Amnesia mode was not changed",
      );
      expect(target?.amnesia).toBe(false);

      // Even a validated upstream completion does not publish until the client
      // consumes EOF and the post-response finalizer commits the turn.
      const validation = await handleRequest(
        makeResponsesRequest({
          sessionHeaders: { [headerName]: targetValue },
          messages: messages("target session", 3),
        }),
        loadConfig(),
      );
      expect(target?.headerSessionId).toBeUndefined();
      expect(await validation.text()).toContain("event: response.completed");
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      expect(target?.headerName).toBe(headerName);
      expect(target?.headerSessionId).toBe(targetValue);
      expect(target?.messageCount).toBe(5);

      await turn(targetValue, "target session", 4, true);
      expect(target?.messageCount).toBe(7);
      expect(upstreamCall).toBe(7);
    } finally {
      store.mockRestore();
      setUpstreamInterceptor(undefined);
      await resetPipelineState();
    }
  });

  it("rejects slash commands with ambiguous promoted Tier-2 headers", async () => {
    let upstreamCall = 0;
    setUpstreamInterceptor(async () => {
      upstreamCall++;
      return new Response(validResponsesSSE(`resp_tier2_${upstreamCall}`), {
        headers: { "content-type": "text/event-stream" },
      });
    });
    const messages = (seed: string, turn: number): GatewayRequest["messages"] =>
      Array.from({ length: turn * 2 - 1 }, (_, index) => ({
        role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
        content: [
          {
            type: "text" as const,
            text: index === 0 ? seed : `${seed} turn ${index}`,
          },
        ],
      }));
    const turn = async (
      headerName: string,
      headerValue: string,
      seed: string,
      number: number,
    ): Promise<void> => {
      await (
        await handleRequest(
          makeResponsesRequest({
            sessionHeaders: { [headerName]: headerValue },
            messages: messages(seed, number),
          }),
          loadConfig(),
        )
      ).text();
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
    };

    try {
      await turn("x-alpha-session", "alpha-session-value", "alpha seed", 1);
      await turn("x-alpha-session", "alpha-other-value", "alpha other", 1);
      await turn("x-alpha-session", "alpha-session-value", "alpha seed", 2);
      await turn("x-alpha-session", "alpha-session-value", "alpha seed", 3);

      await turn("x-beta-session", "beta-session-value", "beta seed", 1);
      await turn("x-beta-session", "beta-other-value", "beta other", 1);
      await turn("x-beta-session", "beta-session-value", "beta seed", 2);
      await turn("x-beta-session", "beta-session-value", "beta seed", 3);

      const alpha = [...getActiveSessions().values()].find(
        (state) =>
          state.headerName === "x-alpha-session" &&
          state.headerSessionId === "alpha-session-value",
      );
      const beta = [...getActiveSessions().values()].find(
        (state) =>
          state.headerName === "x-beta-session" &&
          state.headerSessionId === "beta-session-value",
      );
      expect(alpha).toBeDefined();
      expect(beta).toBeDefined();
      expect(alpha?.sessionID).not.toBe(beta?.sessionID);

      const ambiguous = makeResponsesRequest({
        sessionHeaders: {
          "x-alpha-session": "alpha-session-value",
          "x-beta-session": "beta-session-value",
        },
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "/lore:amnesia:on" }],
          },
        ],
      });
      ambiguous.stream = false;
      const response = await handleRequest(ambiguous, loadConfig());
      expect(await response.text()).toContain("Amnesia mode was not changed");
      expect(alpha?.amnesia).toBe(false);
      expect(beta?.amnesia).toBe(false);
      expect(upstreamCall).toBe(8);

      const normalAmbiguous = makeResponsesRequest({
        sessionHeaders: {
          "x-alpha-session": "alpha-session-value",
          "x-beta-session": "beta-session-value",
        },
        messages: messages("alpha seed", 4),
      });
      const normal = await handleRequest(normalAmbiguous, loadConfig());
      expect(await normal.text()).toContain("event: response.failed");
      expect(upstreamCall).toBe(8);
      expect(alpha?.messageCount).toBe(messages("alpha seed", 3).length);
      expect(beta?.messageCount).toBe(messages("beta seed", 3).length);
    } finally {
      setUpstreamInterceptor(undefined);
      await resetPipelineState();
    }
  });

  it("rejects unbound structural compaction before reading project memory", async () => {
    const victimAlias = "structural-compaction-victim-alias";
    let upstreamCalls = 0;
    setUpstreamInterceptor(async () => {
      upstreamCalls++;
      return new Response(validResponsesSSE("resp_structural_victim"), {
        headers: { "content-type": "text/event-stream" },
      });
    });
    const undistilled = vi.spyOn(temporal, "undistilled");

    try {
      await (
        await handleRequest(
          makeResponsesRequest({
            sessionHeaders: { "x-session-affinity": victimAlias },
          }),
          loadConfig(),
        )
      ).text();
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      const provisional = makeResponsesRequest({
        sessionHeaders: {
          "x-lore-session-id": "provisional-structural-session",
        },
      });
      delete provisional.rawHeaders["x-lore-project"];
      await (await handleRequest(provisional, loadConfig())).text();
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      undistilled.mockClear();

      const attack = async (
        sessionHeaders: Record<string, string>,
        credential: string | null,
        projectPath = process.cwd(),
      ): Promise<Response> => {
        const request = makeResponsesRequest({
          sessionHeaders,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: "Create an anchored summary from the conversation history above.",
                },
              ],
            },
          ],
          tools: [],
        });
        request.stream = false;
        request.rawHeaders["x-lore-project"] = projectPath;
        if (credential) request.rawHeaders.authorization = credential;
        else delete request.rawHeaders.authorization;
        return handleRequest(request, loadConfig());
      };

      const fresh = await attack(
        { "x-lore-session-id": "new-structural-attacker" },
        "Bearer test-key",
      );
      expect(fresh.status).toBe(404);
      expect(await fresh.text()).not.toContain("structural victim");

      const conflictingAlias = await attack(
        {
          "x-lore-session-id": "unknown-structural-canonical",
          "x-session-affinity": victimAlias,
        },
        "Bearer test-key",
      );
      expect(conflictingAlias.status).toBe(404);
      expect(await conflictingAlias.text()).not.toContain("structural victim");

      const missingCredential = await attack(
        { "x-session-affinity": victimAlias },
        null,
      );
      expect(missingCredential.status).toBe(401);

      const wrongCredential = await attack(
        { "x-session-affinity": victimAlias },
        "Bearer wrong-tenant-key",
      );
      expect(wrongCredential.status).toBe(404);

      const provisionalRebind = await attack(
        { "x-lore-session-id": "provisional-structural-session" },
        "Bearer test-key",
        "/tmp",
      );
      expect(provisionalRebind.status).toBe(403);

      expect(undistilled).not.toHaveBeenCalled();
      expect(upstreamCalls).toBe(2);
    } finally {
      undistilled.mockRestore();
      setUpstreamInterceptor(undefined);
      await resetPipelineState();
    }
  });

  it("does not fall through an indexed canonical session to a conflicting alias", async () => {
    let upstreamCalls = 0;
    setUpstreamInterceptor(async () => {
      upstreamCalls++;
      return new Response(
        validResponsesSSE(`resp_alias_conflict_${upstreamCalls}`),
        {
          headers: { "content-type": "text/event-stream" },
        },
      );
    });
    const canonicalHeaders = {
      "x-lore-session-id": "authoritative-canonical-session",
    };
    const fallbackHeaders = {
      "x-session-affinity": "conflicting-fallback-session",
    };
    const canonicalRequest = makeResponsesRequest({
      sessionHeaders: canonicalHeaders,
    });
    const store = vi.spyOn(temporal, "store");

    try {
      await (await handleRequest(canonicalRequest, loadConfig())).text();
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      await (
        await handleRequest(
          makeResponsesRequest({ sessionHeaders: fallbackHeaders }),
          loadConfig(),
        )
      ).text();
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      expect(evictLiveSessionForTest(canonicalRequest)).toBe(true);

      const slash = makeResponsesRequest({
        sessionHeaders: { ...canonicalHeaders, ...fallbackHeaders },
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "/lore:amnesia:on" }],
          },
        ],
      });
      slash.stream = false;
      await (await handleRequest(slash, loadConfig())).text();

      store.mockClear();
      await (
        await handleRequest(
          makeResponsesRequest({
            sessionHeaders: canonicalHeaders,
            messages: [
              {
                role: "user",
                content: [{ type: "text", text: "canonical sensitive turn" }],
              },
            ],
          }),
          loadConfig(),
        )
      ).text();
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      expect(store).not.toHaveBeenCalled();

      store.mockClear();
      await (
        await handleRequest(
          makeResponsesRequest({ sessionHeaders: fallbackHeaders }),
          loadConfig(),
        )
      ).text();
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      expect(store).toHaveBeenCalled();
    } finally {
      store.mockRestore();
      setUpstreamInterceptor(undefined);
      await resetPipelineState();
    }
  });

  it("cancels a request waiting behind an unrelated downstream finalizer", async () => {
    const sessionHeaders = {
      "x-lore-session-id": "cancel-finalizer-wait-session",
    };
    setUpstreamInterceptor(
      async () =>
        new Response(validResponsesSSE("resp_waiter_setup"), {
          headers: { "content-type": "text/event-stream" },
        }),
    );
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let finalizerStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      finalizerStarted = resolve;
    });
    let pending: Promise<Response> | undefined;

    try {
      await (
        await handleRequest(
          makeResponsesRequest({ sessionHeaders }),
          loadConfig(),
        )
      ).text();
      await new Promise((resolve) => setImmediate(resolve));
      const state = [...getActiveSessions().values()].find(
        (candidate) =>
          candidate.headerSessionId === sessionHeaders["x-lore-session-id"],
      );
      expect(state).toBeDefined();
      scheduleStreamingPostResponseForTest(state?.sessionID ?? "", async () => {
        finalizerStarted();
        await blocked;
      });
      await started;

      const caller = new AbortController();
      const slash = makeResponsesRequest({
        sessionHeaders,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "/lore:amnesia:on" }],
          },
        ],
      });
      slash.stream = false;
      slash.signal = caller.signal;
      pending = handleRequest(slash, loadConfig());
      caller.abort(new DOMException("caller disconnected", "AbortError"));

      const outcome = await Promise.race([
        pending.then((response) => response.status),
        new Promise<"pending">((resolve) =>
          setImmediate(() => resolve("pending")),
        ),
      ]);
      expect(outcome).toBe(502);
    } finally {
      release();
      await pending;
      setUpstreamInterceptor(undefined);
      await resetPipelineState();
    }
  });

  it.each(["curate", "compact", "responses-compact"] as const)(
    "holds %s behind preterminal session work",
    async (endpoint) => {
      const sessionHeaders = {
        "x-lore-session-id": `preterminal-${endpoint}-session`,
      };
      setUpstreamInterceptor(
        async () =>
          new Response(validResponsesSSE(`resp_${endpoint}_setup`), {
            headers: { "content-type": "text/event-stream" },
          }),
      );
      let release!: () => void;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      let finalizerStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        finalizerStarted = resolve;
      });
      let pending: Promise<Response> | undefined;

      try {
        await (
          await handleRequest(
            makeResponsesRequest({ sessionHeaders }),
            loadConfig(),
          )
        ).text();
        await new Promise((resolve) => setImmediate(resolve));
        const state = [...getActiveSessions().values()].find(
          (candidate) =>
            candidate.headerSessionId === sessionHeaders["x-lore-session-id"],
        );
        expect(state).toBeDefined();
        scheduleStreamingPostResponseForTest(
          state?.sessionID ?? "",
          async () => {
            finalizerStarted();
            await blocked;
          },
        );
        await started;

        const headers = {
          authorization: "Bearer test-key",
          "content-type": "application/json",
          "x-lore-project": process.cwd(),
          "x-lore-provider": "openai",
          "x-lore-upstream-url": "https://api.openai.com/v1",
          ...sessionHeaders,
        };
        if (endpoint === "curate") {
          const curate = makeResponsesRequest({
            sessionHeaders,
            messages: [
              {
                role: "user",
                content: [{ type: "text", text: "/lore:curate" }],
              },
            ],
          });
          curate.stream = false;
          pending = handleRequest(curate, loadConfig());
        } else {
          pending =
            endpoint === "compact"
              ? handleCompactEndpoint(
                  new Request("http://gateway.test/v1/compact", {
                    method: "POST",
                    headers,
                    body: JSON.stringify({
                      project_path: process.cwd(),
                      tokens_before: 1,
                    }),
                  }),
                  loadConfig(),
                )
              : handleResponsesCompactEndpoint(
                  new Request("http://gateway.test/v1/responses/compact", {
                    method: "POST",
                    headers,
                    body: JSON.stringify({
                      model: "gpt-5.6-sol",
                      instructions: "You are a coding agent.",
                      input: [
                        {
                          role: "user",
                          content: [{ type: "input_text", text: "compact" }],
                        },
                      ],
                      tools: [],
                    }),
                  }),
                  loadConfig(),
                );
        }

        const outcome = await Promise.race([
          pending.then(() => "settled" as const),
          new Promise<"pending">((resolve) =>
            setImmediate(() => resolve("pending")),
          ),
        ]);
        expect(outcome).toBe("pending");
        expect(isPipelineSessionActiveForTest(state?.sessionID ?? "")).toBe(
          true,
        );

        release();
        const response = await pending;
        expect(response.status).toBe(200);
        await response.text();
        await vi.waitFor(() =>
          expect(isPipelineSessionActiveForTest(state?.sessionID ?? "")).toBe(
            false,
          ),
        );
      } finally {
        release();
        if (pending) {
          const response = await pending;
          if (!response.bodyUsed) await response.text();
        }
        setUpstreamInterceptor(undefined);
        await resetPipelineState();
      }
    },
  );

  it.each(["structural", "compact", "responses-compact"] as const)(
    "rechecks %s project authorization after a queued session claim",
    async (endpoint) => {
      const sessionHeaders = {
        "x-lore-session-id": `queued-project-${endpoint}-session`,
      };
      const projectA = `/tmp/lore-queued-${endpoint}-a`;
      const projectB = `/tmp/lore-queued-${endpoint}-b`;
      let upstreamCalls = 0;
      setUpstreamInterceptor(async () => {
        upstreamCalls++;
        return new Response(validResponsesSSE(`resp_queued_${endpoint}`), {
          headers: { "content-type": "text/event-stream" },
        });
      });
      let releaseRebind!: () => void;
      const rebindPause = new Promise<void>((resolve) => {
        releaseRebind = resolve;
      });
      let rebindWaitingResolve!: () => void;
      const rebindWaiting = new Promise<void>((resolve) => {
        rebindWaitingResolve = resolve;
      });
      const undistilled = vi.spyOn(temporal, "undistilled");

      try {
        const setup = makeResponsesRequest({ sessionHeaders });
        setup.rawHeaders["x-lore-project"] = projectA;
        await (await handleRequest(setup, loadConfig())).text();
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));
        undistilled.mockClear();

        setPipelinePreUpstreamPauseForTest(rebindPause, rebindWaitingResolve);
        const rebind = makeResponsesRequest({ sessionHeaders });
        rebind.rawHeaders["x-lore-project"] = projectB;
        const rebindResponse = await handleRequest(rebind, loadConfig());
        const rebindBody = rebindResponse.text();
        await rebindWaiting;
        setPipelinePreUpstreamPauseForTest(undefined);

        const headers = {
          authorization: "Bearer test-key",
          "content-type": "application/json",
          "x-lore-project": projectA,
          "x-lore-provider": "openai",
          "x-lore-upstream-url": "https://api.openai.com/v1",
          ...sessionHeaders,
        };
        let pending: Promise<Response>;
        if (endpoint === "structural") {
          const structural = makeResponsesRequest({
            sessionHeaders,
            messages: [
              {
                role: "user",
                content: [
                  {
                    type: "text",
                    text: "Create an anchored summary from the conversation history above.",
                  },
                ],
              },
            ],
            tools: [],
          });
          structural.stream = false;
          structural.rawHeaders["x-lore-project"] = projectA;
          pending = handleRequest(structural, loadConfig());
        } else if (endpoint === "compact") {
          pending = handleCompactEndpoint(
            new Request("http://gateway.test/v1/compact", {
              method: "POST",
              headers,
              body: JSON.stringify({ project_path: projectA }),
            }),
            loadConfig(),
          );
        } else {
          pending = handleResponsesCompactEndpoint(
            new Request("http://gateway.test/v1/responses/compact", {
              method: "POST",
              headers,
              body: JSON.stringify({
                model: "gpt-5.6-sol",
                instructions: "You are a coding agent.",
                input: [
                  {
                    role: "user",
                    content: [{ type: "input_text", text: "compact" }],
                  },
                ],
                tools: [],
              }),
            }),
            loadConfig(),
          );
        }
        await vi.waitFor(() =>
          expect(pendingPipelineSessionClaimCountForTest()).toBe(1),
        );

        releaseRebind();
        expect(await rebindBody).toContain("event: response.completed");
        const response = await pending;
        expect(response.status).toBe(403);
        expect(await response.text()).toMatch(/project[_ ]path/i);
        expect(undistilled).not.toHaveBeenCalled();
        expect(upstreamCalls).toBe(2);
        const state = [...getActiveSessions().values()].find(
          (candidate) =>
            candidate.headerSessionId === sessionHeaders["x-lore-session-id"],
        );
        expect(state).toMatchObject({
          projectPath: projectB,
          projectPathProvisional: false,
        });
      } finally {
        releaseRebind();
        undistilled.mockRestore();
        setPipelinePreUpstreamPauseForTest(undefined);
        setUpstreamInterceptor(undefined);
        await resetPipelineState();
      }
    },
  );

  it.each([
    "regular",
    "structural",
    "compact",
    "responses-compact",
    "slash",
  ] as const)(
    "rejects a queued %s request after affinity rotation revokes its identity",
    async (route) => {
      const oldAffinity = `queued-revoked-${route}-old`;
      const newAffinity = `queued-revoked-${route}-new`;
      const history: GatewayRequest["messages"] = Array.from(
        { length: 12 },
        (_, index) => ({
          role:
            index === 0 || index === 10
              ? ("user" as const)
              : ("assistant" as const),
          content: [
            {
              type: "text" as const,
              text: `${route} rotation history ${index}`,
            },
          ],
        }),
      );
      let upstreamCalls = 0;
      setUpstreamInterceptor(async () => {
        upstreamCalls++;
        return new Response(
          validResponsesSSE(`resp_queued_revoked_${upstreamCalls}`),
          { headers: { "content-type": "text/event-stream" } },
        );
      });
      let releaseRotation!: () => void;
      const rotationPause = new Promise<void>((resolve) => {
        releaseRotation = resolve;
      });
      let rotationWaitingResolve!: () => void;
      const rotationWaiting = new Promise<void>((resolve) => {
        rotationWaitingResolve = resolve;
      });
      let queued: Promise<Response> | undefined;
      let rotationBody: Promise<string> | undefined;
      const summaryRead = vi.spyOn(distillation, "loadForSession");

      try {
        const seed = makeResponsesRequest({
          sessionHeaders: { "x-session-affinity": oldAffinity },
          messages: [history[0]],
        });
        await (await handleRequest(seed, loadConfig())).text();
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));

        const setup = makeResponsesRequest({
          sessionHeaders: { "x-session-affinity": oldAffinity },
          messages: history,
        });
        await (await handleRequest(setup, loadConfig())).text();
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));

        setPipelinePreUpstreamPauseForTest(
          rotationPause,
          rotationWaitingResolve,
        );
        const rotation = makeResponsesRequest({
          sessionHeaders: { "x-session-affinity": newAffinity },
          messages: [
            ...history,
            {
              role: "user",
              content: [{ type: "text", text: "continue after restart" }],
            },
          ],
        });
        const rotationResponse = await handleRequest(rotation, loadConfig());
        rotationBody = rotationResponse.text();
        await rotationWaiting;
        const oldState = [...getActiveSessions().values()].find(
          (state) => state.headerSessionId === oldAffinity,
        );
        expect(oldState).toBeDefined();
        expect(isPipelineSessionActiveForTest(oldState?.sessionID ?? "")).toBe(
          true,
        );

        const headers = {
          authorization: "Bearer test-key",
          "content-type": "application/json",
          "x-lore-project": process.cwd(),
          "x-lore-provider": "openai",
          "x-lore-upstream-url": "https://api.openai.com/v1",
          "x-session-affinity": oldAffinity,
        };
        if (route === "regular") {
          const request = makeResponsesRequest({
            sessionHeaders: { "x-session-affinity": oldAffinity },
          });
          request.stream = false;
          queued = handleRequest(request, loadConfig());
        } else if (route === "structural") {
          const request = makeResponsesRequest({
            sessionHeaders: { "x-session-affinity": oldAffinity },
            messages: [
              {
                role: "user",
                content: [
                  {
                    type: "text",
                    text: "Create an anchored summary from the conversation history above.",
                  },
                ],
              },
            ],
            tools: [],
          });
          request.stream = false;
          queued = handleRequest(request, loadConfig());
        } else if (route === "slash") {
          const request = makeResponsesRequest({
            sessionHeaders: { "x-session-affinity": oldAffinity },
            messages: [
              {
                role: "user",
                content: [{ type: "text", text: "/lore:amnesia:on" }],
              },
            ],
          });
          request.stream = false;
          queued = handleRequest(request, loadConfig());
        } else if (route === "compact") {
          queued = handleCompactEndpoint(
            new Request("http://gateway.test/v1/compact", {
              method: "POST",
              headers,
              body: JSON.stringify({ project_path: process.cwd() }),
            }),
            loadConfig(),
          );
        } else {
          queued = handleResponsesCompactEndpoint(
            new Request("http://gateway.test/v1/responses/compact", {
              method: "POST",
              headers,
              body: JSON.stringify({
                model: "gpt-5.6-sol",
                instructions: "You are a coding agent.",
                input: [
                  {
                    role: "user",
                    content: [{ type: "input_text", text: "compact" }],
                  },
                ],
                tools: [],
              }),
            }),
            loadConfig(),
          );
        }
        await vi.waitFor(() =>
          expect(pendingPipelineSessionClaimCountForTest()).toBe(1),
        );
        summaryRead.mockClear();

        releaseRotation();
        expect(await rotationBody).toContain("event: response.completed");
        const response = await queued;
        expect(response.status).toBe(route === "slash" ? 200 : 404);
        expect(await response.text()).toMatch(/authenticated.*session/i);
        expect(upstreamCalls).toBe(3);
        expect(summaryRead).not.toHaveBeenCalled();
      } finally {
        releaseRotation();
        if (rotationBody) await rotationBody.catch(() => "");
        if (queued) {
          const response = await queued.catch(() => undefined);
          if (response && !response.bodyUsed) await response.text();
        }
        summaryRead.mockRestore();
        setPipelinePreUpstreamPauseForTest(undefined);
        setUpstreamInterceptor(undefined);
        await resetPipelineState();
      }
    },
  );

  it("drops a captured post-response finalizer after session eviction", async () => {
    const sessionHeaders = {
      "x-lore-session-id": "evicted-finalizer-session",
    };
    const request = makeResponsesRequest({
      sessionHeaders,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "must not store after eviction" }],
        },
      ],
    });
    const store = vi.spyOn(temporal, "store");
    let postResponses = 0;
    setPostResponseStartObserverForTest(() => postResponses++);
    setUpstreamInterceptor(
      async () =>
        new Response(validResponsesSSE("resp_evicted_finalizer"), {
          headers: { "content-type": "text/event-stream" },
        }),
    );

    try {
      const response = await handleRequest(request, loadConfig());
      const reader = response.body?.getReader();
      expect(reader).toBeDefined();
      const decoder = new TextDecoder();
      let output = "";
      while (!output.includes("event: response.completed")) {
        const chunk = await reader?.read();
        expect(chunk?.done).toBe(false);
        if (chunk?.value)
          output += decoder.decode(chunk.value, { stream: true });
      }
      expect(streamingPostResponsePendingForTest()).toBe(1);
      expect(evictLiveSessionForTest(request)).toBe(true);

      for (;;) {
        const chunk = await reader?.read();
        if (!chunk || chunk.done) break;
      }
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      expect(postResponses).toBe(0);
      expect(store).not.toHaveBeenCalled();
      expect(streamingPostResponsePendingForTest()).toBe(0);
    } finally {
      store.mockRestore();
      setPostResponseStartObserverForTest(undefined);
      setUpstreamInterceptor(undefined);
      await resetPipelineState();
    }
  });

  it("keeps a preterminal turn private when amnesia is disabled concurrently", async () => {
    const legacyHeader = { "x-session-affinity": "amnesia-snapshot-session" };
    let upstreamCalls = 0;
    let sensitiveSource:
      | ReadableStreamDefaultController<Uint8Array>
      | undefined;
    let sensitiveStartedResolve: (() => void) | undefined;
    const sensitiveStarted = new Promise<void>((resolve) => {
      sensitiveStartedResolve = resolve;
    });
    setUpstreamInterceptor(async () => {
      upstreamCalls++;
      if (upstreamCalls === 1) {
        return new Response(validResponsesSSE("resp_amnesia_setup"), {
          headers: { "content-type": "text/event-stream" },
        });
      }
      sensitiveStartedResolve?.();
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            sensitiveSource = controller;
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    });
    const slashRequest = (command: string): GatewayRequest => {
      const request = makeResponsesRequest({
        sessionHeaders: legacyHeader,
        messages: [
          { role: "user", content: [{ type: "text", text: command }] },
        ],
      });
      request.stream = false;
      return request;
    };
    const store = vi.spyOn(temporal, "store");

    try {
      const established = await handleRequest(
        makeResponsesRequest({ sessionHeaders: legacyHeader }),
        loadConfig(),
      );
      await established.text();
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      await (
        await handleRequest(slashRequest("/lore:amnesia:on"), loadConfig())
      ).text();
      store.mockClear();

      const order: string[] = [];
      setPostResponseStartObserverForTest(() => order.push("post"));
      const sensitive = await handleRequest(
        makeResponsesRequest({
          sessionHeaders: legacyHeader,
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: "preterminal secret" }],
            },
          ],
        }),
        loadConfig(),
      );
      const sensitiveBody = sensitive.text();
      await sensitiveStarted;

      const disableAmnesia = handleRequest(
        slashRequest("/lore:amnesia:off"),
        loadConfig(),
      );
      const beforeTerminal = await Promise.race([
        disableAmnesia.then(() => "settled" as const),
        new Promise<"pending">((resolve) =>
          setImmediate(() => resolve("pending")),
        ),
      ]);
      expect(beforeTerminal).toBe("pending");

      sensitiveSource?.enqueue(
        new TextEncoder().encode(validResponsesSSE("resp_amnesia_secret")),
      );
      sensitiveSource?.close();
      await sensitiveBody;
      order.push("eof");
      await (await disableAmnesia).text();
      order.push("slash");

      expect(order).toEqual(["eof", "post", "slash"]);
      expect(store).not.toHaveBeenCalled();
    } finally {
      store.mockRestore();
      setPostResponseStartObserverForTest(undefined);
      setUpstreamInterceptor(undefined);
      await resetPipelineState();
    }
  });

  it("waits for a canonical finalizer before compaction reads temporal state", async () => {
    const order: string[] = [];
    let upstreamCalls = 0;
    const originalStore = temporal.store.bind(temporal);
    const store = vi.spyOn(temporal, "store").mockImplementation((input) => {
      const result = originalStore(input);
      if (!order.includes("stored")) order.push("stored");
      return result;
    });
    const undistilledCount = vi
      .spyOn(temporal, "undistilledCount")
      .mockImplementation(() => {
        if (!order.includes("compaction-read")) order.push("compaction-read");
        return 0;
      });
    const wire = validResponsesSSE("resp_before_compaction");
    setUpstreamInterceptor(async () => {
      upstreamCalls++;
      return new Response(wire, {
        headers: { "content-type": "text/event-stream" },
      });
    });
    try {
      const first = await handleRequest(
        makeResponsesRequest({
          sessionHeaders: {
            "x-lore-session-id": "compaction-stable-session",
          },
          messages: Array.from({ length: 12 }, (_, index) => ({
            role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
            content: [
              { type: "text" as const, text: `remember this turn ${index}` },
            ],
          })),
        }),
        loadConfig(),
      );
      await first.text();

      const compacted = await handleRequest(
        makeResponsesRequest({
          sessionHeaders: {
            "x-lore-session-id": "compaction-stable-session",
          },
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: "Summarize this conversation." }],
            },
          ],
          tools: [],
        }),
        loadConfig(),
      );
      expect(order).not.toContain("stored");
      const compactedBody = await compacted.text();

      expect(compactedBody).toContain("remember this turn");
      expect(order.indexOf("stored")).toBeLessThan(
        order.indexOf("compaction-read"),
      );
      expect(upstreamCalls).toBe(1);
    } finally {
      store.mockRestore();
      undistilledCount.mockRestore();
      setUpstreamInterceptor(undefined);
      await resetPipelineState();
    }
  });

  it.each(["compact", "responses-compact"] as const)(
    "waits for deferred storage in the explicit %s endpoint",
    async (endpoint) => {
      const order: string[] = [];
      let upstreamCalls = 0;
      setPostResponseStartObserverForTest(() => order.push("post"));
      setUpstreamInterceptor(async () => {
        upstreamCalls++;
        if (upstreamCalls === 1) {
          return new Response(validResponsesSSE("resp_explicit_compact"), {
            headers: { "content-type": "text/event-stream" },
          });
        }
        return new Response(JSON.stringify({ output: [] }), {
          headers: { "content-type": "application/json" },
        });
      });
      const sessionID = `explicit-${endpoint}-session`;

      try {
        const streamed = await handleRequest(
          makeResponsesRequest({
            sessionHeaders: { "x-lore-session-id": sessionID },
          }),
          loadConfig(),
        );
        await streamed.text();
        order.push("eof");

        const headers = {
          authorization: "Bearer test-key",
          "content-type": "application/json",
          "x-lore-project": process.cwd(),
          "x-lore-provider": "openai",
          "x-lore-upstream-url": "https://api.openai.com/v1",
          "x-lore-session-id": sessionID,
        };
        const response =
          endpoint === "compact"
            ? await handleCompactEndpoint(
                new Request("http://gateway.test/v1/compact", {
                  method: "POST",
                  headers,
                  body: JSON.stringify({
                    project_path: process.cwd(),
                    tokens_before: 1,
                  }),
                }),
                loadConfig(),
              )
            : await handleResponsesCompactEndpoint(
                new Request("http://gateway.test/v1/responses/compact", {
                  method: "POST",
                  headers,
                  body: JSON.stringify({
                    model: "gpt-5.6-sol",
                    instructions: "You are a coding agent.",
                    input: [
                      {
                        role: "user",
                        content: [{ type: "input_text", text: "continue" }],
                      },
                    ],
                    tools: [],
                  }),
                }),
                loadConfig(),
              );
        await response.text();
        order.push("endpoint");

        expect(order.slice(0, 3)).toEqual(["eof", "post", "endpoint"]);
      } finally {
        setPostResponseStartObserverForTest(undefined);
        setUpstreamInterceptor(undefined);
        await resetPipelineState();
      }
    },
  );

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
        loadConfig(),
      );
      await Promise.resolve();
      controller.abort(new DOMException("client disconnected", "AbortError"));
      const response = await pending;
      expect(response.status).toBe(502);
      await expect(response.text()).resolves.toContain(
        "Gateway request failed",
      );
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
        loadConfig(),
      );
      await vi.advanceTimersByTimeAsync(300_000);
      const response = await pending;
      expect(response.status).toBe(502);
      await expect(response.text()).resolves.toContain(
        "Gateway request failed",
      );
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
                authorization: "Bearer test-key",
                "x-lore-agent": "title",
                "x-lore-provider": provider,
                "x-lore-upstream-url": upstream,
              },
              signal: caller.signal,
            },
            loadConfig(),
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
              authorization: "Bearer test-key",
              "x-lore-agent": "title",
              "x-lore-provider": provider,
              "x-lore-upstream-url": upstream,
            },
          },
          loadConfig(),
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
      const response = await harness.request(testCase.path, {
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

  it.each([true, false])(
    "preserves a valid incomplete Responses terminal for cross-protocol meta stream=%s",
    async (stream) => {
      setUpstreamInterceptor(async () =>
        stream
          ? new Response(incompleteResponsesSSE("resp_meta_incomplete"), {
              headers: { "content-type": "text/event-stream" },
            })
          : new Response(
              JSON.stringify({
                id: "resp_meta_incomplete",
                model: "gpt-5.6-sol",
                status: "incomplete",
                output: [],
                usage: { input_tokens: 10, output_tokens: 2 },
              }),
              { headers: { "content-type": "application/json" } },
            ),
      );

      try {
        const response = await handleRequest(
          {
            protocol: "anthropic",
            model: "gpt-5.6-sol",
            system: "title this",
            messages: [
              { role: "user", content: [{ type: "text", text: "title" }] },
            ],
            tools: [],
            stream,
            maxTokens: 32,
            metadata: {},
            rawHeaders: {
              authorization: "Bearer test-key",
              "x-lore-agent": "title",
              "x-lore-provider": "openai",
            },
          },
          loadConfig(),
        );
        expect(response.status).toBe(200);
        const body = await response.text();
        expect(body).toContain('"stop_reason":"max_tokens"');
        expect(body).not.toContain("Gateway request failed");
      } finally {
        setUpstreamInterceptor(undefined);
      }
    },
  );

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
          loadConfig(),
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
          loadConfig(),
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
      const response = await harness.request(path, {
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
