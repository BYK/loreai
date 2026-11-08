import { afterEach, describe, expect, test, vi } from "vitest";
import { log } from "@loreai/core";

vi.mock("../src/recall", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/recall")>();
  return { ...actual, executeRecall: vi.fn() };
});

import { loadConfig } from "../src/config";
import {
  buildStreamingResponse,
  setRecallPersistenceCommitObserverForTest,
  setUpstreamInterceptor,
} from "../src/pipeline";
import {
  executeRecall,
  MAX_RECALL_DEPTH,
  RECALL_TOOL_NAME,
} from "../src/recall";
import { FOREGROUND_REQUEST_TIMEOUT_MS } from "../src/sse-inactivity";
import {
  buildSSETextResponse,
  SSEStreamTransportError,
} from "../src/stream/anthropic";
import {
  RecallContinuationFailure,
  setRecallContinuationFailureHook,
  type RecallContinuationFailureCategory,
} from "../src/recall-continuation-failure";
import type { GatewayRequest, SessionState } from "../src/translate/types";

const mockedRecall = vi.mocked(executeRecall);

/** Model a distinct, productive result for every requested recall. */
function installProductiveRecallMock(): void {
  let calls = 0;
  mockedRecall.mockImplementation(async () => {
    calls++;
    return {
      result: "recall results",
      input: { query: "architecture" },
      valid: true,
      coverage: [
        {
          identity: `t:source-${calls}`,
          revision: `revision-${calls}`,
          offset: 0,
          length: 1,
          complete: true,
          kind: "detail" as const,
        },
      ],
    };
  });
}

function loadLocalConfig() {
  const config = loadConfig();
  config.remoteGateway = false;
  config.hostedMode = false;
  return config;
}

function event(type: string, data: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

function recallOnlyResponse(inputTokens = 1): Response {
  return new Response(
    event("message_start", {
      message: {
        id: "msg_recall",
        type: "message",
        role: "assistant",
        model: "claude-test",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: inputTokens, output_tokens: 0 },
      },
    }) +
      event("content_block_start", {
        index: 0,
        content_block: {
          type: "tool_use",
          id: "tool_recall",
          name: RECALL_TOOL_NAME,
          input: {},
        },
      }) +
      event("content_block_delta", {
        index: 0,
        delta: {
          type: "input_json_delta",
          partial_json: '{"query":"architecture"}',
        },
      }) +
      event("content_block_stop", { index: 0 }) +
      event("message_delta", {
        delta: { stop_reason: "tool_use", stop_sequence: null },
        usage: { output_tokens: 1 },
      }) +
      event("message_stop", {}),
    { headers: { "content-type": "text/event-stream" } },
  );
}

function request(signal?: AbortSignal): GatewayRequest {
  return {
    protocol: "anthropic",
    model: "claude-test",
    system: "test",
    messages: [{ role: "user", content: [{ type: "text", text: "question" }] }],
    tools: [{ name: RECALL_TOOL_NAME, description: "recall", inputSchema: {} }],
    stream: true,
    maxTokens: 32,
    metadata: {},
    rawHeaders: {
      "x-api-key": "test-key",
      "x-lore-provider": "anthropic",
      "x-lore-upstream-url": "https://api.anthropic.com",
    },
    signal,
  };
}

function sessionState(): SessionState {
  return {
    sessionID: `recall-abort-${crypto.randomUUID()}`,
    projectPath: "/tmp/recall-abort",
    fingerprint: "fingerprint",
    lastRequestTime: Date.now(),
    lastUserTurnTime: Date.now(),
    messageCount: 1,
    turnsSinceCuration: 0,
    consecutiveTextOnlyTurns: 0,
    upstreamByProvider: new Map(),
    recallStore: new Map(),
    cacheAnalytics: {
      lastRequestBody: null,
      turns: [],
    },
  } as unknown as SessionState;
}

function hostileContinuation(keepAlive = false): {
  response: Response;
  readStarted: Promise<void>;
  cancelled: () => boolean;
} {
  const readStarted = Promise.withResolvers<void>();
  let cancelled = false;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            event("message_start", {
              message: {
                id: "msg_continuation",
                type: "message",
                role: "assistant",
                model: "claude-test",
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 1, output_tokens: 0 },
              },
            }),
          ),
        );
      },
      pull(controller) {
        readStarted.resolve();
        if (keepAlive) {
          return new Promise<void>((resolve) => {
            setTimeout(() => {
              try {
                controller.enqueue(new TextEncoder().encode(event("ping", {})));
              } catch {
                // The foreground deadline may close the stream first.
              }
              resolve();
            }, 60_000);
          });
        }
        return new Promise(() => {});
      },
      cancel() {
        cancelled = true;
        return new Promise<void>(() => {});
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
  return {
    response,
    readStarted: readStarted.promise,
    cancelled: () => cancelled,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  setRecallPersistenceCommitObserverForTest(undefined);
  setRecallContinuationFailureHook(undefined);
  setUpstreamInterceptor(undefined);
  mockedRecall.mockReset();
});

/** Consume the real response, bounding a regression that strands its reader. */
async function expectFailedDelivery(
  response: Response,
  fault: unknown,
): Promise<void> {
  const reader = response.body!.getReader();
  const outcome = (async () => {
    try {
      while (!(await reader.read()).done) {
        // Consume bytes already delivered before the completion callback fails.
      }
      return undefined;
    } catch (error) {
      return error;
    }
  })();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    expect(
      await Promise.race([
        outcome,
        new Promise((resolve) => {
          timeout = setTimeout(
            () => resolve("delivery remained pending"),
            1_000,
          );
        }),
      ]),
    ).toBe(fault);
  } finally {
    if (timeout) clearTimeout(timeout);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

describe.each(["kind", "category"] as const)(
  "untrusted diagnostic field %s",
  (field) => {
    test.each([
      "private string",
      "throwing getter",
      "bigint",
      "cycle",
      "toJSON",
    ] as const)(
      "%s cannot leak data or strand a failed response",
      async (mode) => {
        const sink = vi.spyOn(log, "error").mockImplementation(() => {});
        const secret = "PRIVATE_CALLBACK_DIAGNOSTIC";
        const fault =
          field === "kind"
            ? new SSEStreamTransportError("read", "original callback failure")
            : new RecallContinuationFailure("unexpected");
        const cyclic: { self?: unknown } = {};
        cyclic.self = cyclic;
        const toJSON = vi.fn(() => secret);
        Object.defineProperty(
          fault,
          field,
          mode === "throwing getter"
            ? {
                get() {
                  throw new Error(secret);
                },
              }
            : {
                value:
                  mode === "bigint"
                    ? 1n
                    : mode === "cycle"
                      ? cyclic
                      : mode === "toJSON"
                        ? { toJSON }
                        : secret,
              },
        );

        const response = buildStreamingResponse(
          new Response(
            buildSSETextResponse("normal", "claude-test", "answer", {
              inputTokens: 1,
              outputTokens: 1,
            }),
          ),
          () => {
            throw fault;
          },
        );
        await expectFailedDelivery(response, fault);
        const diagnostic = sink.mock.calls
          .map(([message]) => String(message))
          .join("\n");
        expect(diagnostic).toContain('"phase":"completion"');
        expect(diagnostic).toContain('"category":"unexpected"');
        expect(diagnostic).not.toContain('"transportKind"');
        expect(diagnostic).not.toContain(secret);
        expect(toJSON).not.toHaveBeenCalled();
      },
    );
  },
);

test("diagnostic formatting failures cannot prevent response settlement", async () => {
  const sink = vi.spyOn(log, "error").mockImplementation(() => {});
  const stringify = JSON.stringify;
  vi.spyOn(JSON, "stringify").mockImplementation((value, ...args) => {
    if (
      value &&
      typeof value === "object" &&
      "phase" in value &&
      value.phase === "completion"
    ) {
      throw new Error("PRIVATE_FORMATTING_FAILURE");
    }
    return stringify(value, ...args);
  });
  const fault = new Error("original callback failure");
  const response = buildStreamingResponse(
    new Response(
      buildSSETextResponse("normal", "claude-test", "answer", {
        inputTokens: 1,
        outputTokens: 1,
      }),
    ),
    () => {
      throw fault;
    },
  );
  await expectFailedDelivery(response, fault);
  expect(
    sink.mock.calls.map(([message]) => String(message)).join("\n"),
  ).not.toContain("PRIVATE_FORMATTING_FAILURE");
});

test("unrelated callback exceptions do not inspect category metadata", async () => {
  vi.spyOn(log, "error").mockImplementation(() => {});
  const fault = new Error("original callback failure");
  const category = vi.fn(() => {
    throw new Error("PRIVATE_CATEGORY_METADATA");
  });
  Object.defineProperty(fault, "category", { get: category });
  const response = buildStreamingResponse(
    new Response(
      buildSSETextResponse("normal", "claude-test", "answer", {
        inputTokens: 1,
        outputTokens: 1,
      }),
    ),
    () => {
      throw fault;
    },
  );
  await expectFailedDelivery(response, fault);
  expect(category).not.toHaveBeenCalled();
});

test.each([
  "overloaded_error",
  "rate_limit_error",
  "api_error",
  "PRIVATE_FUTURE_ERROR_TYPE",
])(
  "a valid upstream failure %s is distinct from malformed protocol",
  async (type) => {
    installProductiveRecallMock();
    const sink = vi.spyOn(log, "error").mockImplementation(() => {});
    const failures: RecallContinuationFailureCategory[] = [];
    setRecallContinuationFailureHook((category) => failures.push(category));
    const committed = vi.fn();
    const completed = vi.fn();
    const failed = vi.fn();
    setRecallPersistenceCommitObserverForTest(committed);
    setUpstreamInterceptor(
      async () =>
        new Response(
          event("error", {
            error: { type, message: "PRIVATE_PROVIDER_FAILURE" },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    const req = request();
    const state = sessionState();
    const downstream = buildStreamingResponse(recallOnlyResponse(), completed, {
      clientMessages: req.messages,
      modifiedReq: req,
      config: loadLocalConfig(),
      sessionState: state,
      cacheOptions: { cacheConversation: false },
      clientSpeaksAnthropic: true,
      onFailure: failed,
    });

    await expect(downstream.text()).rejects.toThrow("SSE stream read failed");
    expect(failures).toEqual(["follow_up_failed"]);
    const diagnostic = sink.mock.calls
      .map(([message]) => String(message))
      .join("\n");
    expect(diagnostic).toContain('"phase":"follow_up_stream"');
    expect(diagnostic).toContain('"category":"follow_up_failed"');
    expect(diagnostic).not.toContain(type);
    expect(diagnostic).not.toContain("PRIVATE_PROVIDER_FAILURE");
    expect(completed).not.toHaveBeenCalled();
    expect(failed).toHaveBeenCalledTimes(1);
    expect(committed).not.toHaveBeenCalled();
    expect(state.recallStore.size).toBe(0);
  },
);

test("a completed proxy continuation reports its budget rejection instead of a generic stream error", async () => {
  installProductiveRecallMock();
  const diagnostics = vi.spyOn(log, "error").mockImplementation(() => {});
  const progress = vi.spyOn(log, "info").mockImplementation(() => {});
  const failures: RecallContinuationFailureCategory[] = [];
  setRecallContinuationFailureHook((category) => failures.push(category));
  const completed = vi.fn();
  const failed = vi.fn();
  const committed = vi.fn();
  setRecallPersistenceCommitObserverForTest(committed);
  setUpstreamInterceptor(async () => recallOnlyResponse(70_000));
  const req = request();
  const state = sessionState();
  const downstream = buildStreamingResponse(
    recallOnlyResponse(70_000),
    completed,
    {
      clientMessages: req.messages,
      modifiedReq: req,
      config: loadLocalConfig(),
      sessionState: state,
      cacheOptions: { cacheConversation: false },
      clientSpeaksAnthropic: true,
      // Custom upstream destinations cannot borrow a canonical model's limits.
      modelContextTokens: 128_000,
      allowExpandedContext: false,
      expectedPrincipalModel: req.model,
      onFailure: failed,
    },
  );

  await expect(downstream.text()).rejects.toThrow("SSE stream read failed");
  expect(progress.mock.calls.map(([message]) => message).join("\n")).toContain(
    "recall follow-up stream complete (depth=1)",
  );
  expect(diagnostics).toHaveBeenCalledWith(
    expect.stringContaining(
      'streaming pipeline error {"phase":"follow_up_validation","category":"follow_up_budget_exceeded"',
    ),
  );
  const diagnostic = diagnostics.mock.calls
    .map(([message]) => String(message))
    .join("\n");
  expect(diagnostic).toContain('"budgetTokens":128000');
  expect(diagnostic).toContain('"spentTokens":140002');
  expect(diagnostic).toContain('"budgetStop":"tokens"');
  expect(failures).toEqual(["follow_up_budget_exceeded"]);
  expect(completed).not.toHaveBeenCalled();
  expect(failed).toHaveBeenCalledTimes(1);
  expect(failed.mock.calls[0][0].usage).toMatchObject({
    inputTokens: 140_000,
    outputTokens: 2,
  });
  expect(committed).not.toHaveBeenCalled();
  expect(state.recallStore.size).toBe(0);
});

test.each([false, true])(
  "follow-up transport diagnostics retain only allowlisted cause codes (noStore=%s)",
  async (noStore) => {
    installProductiveRecallMock();
    const diagnostics = vi.spyOn(log, "error").mockImplementation(() => {});
    const failures: RecallContinuationFailureCategory[] = [];
    setRecallContinuationFailureHook((category) => failures.push(category));
    const secret = "PRIVATE_PROVIDER_BODY";
    setUpstreamInterceptor(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(
                new TypeError(secret, {
                  cause: Object.assign(new Error(secret), {
                    code: "UND_ERR_SOCKET",
                    syscall: secret,
                    cause: Object.assign(new Error(secret), { code: secret }),
                  }),
                }),
              );
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    const req = request();
    const state = sessionState();
    const completed = vi.fn();
    const downstream = buildStreamingResponse(recallOnlyResponse(), completed, {
      clientMessages: req.messages,
      modifiedReq: req,
      config: loadLocalConfig(),
      sessionState: state,
      cacheOptions: { cacheConversation: false },
      clientSpeaksAnthropic: true,
      noStore,
    });

    await expect(downstream.text()).rejects.toThrow("SSE stream read failed");
    const diagnostic = diagnostics.mock.calls
      .map(([message]) => String(message))
      .join("\n");
    expect(diagnostic).toContain('"phase":"follow_up_stream"');
    expect(diagnostic).toContain('"category":"follow_up_transport"');
    expect(diagnostic).toContain('"transportKind":"read"');
    expect(diagnostic).toContain('"causeCodes":["UND_ERR_SOCKET"]');
    expect(diagnostic).not.toContain(secret);
    expect(diagnostic.includes('"budgetTokens"')).toBe(!noStore);
    expect(failures).toEqual(["follow_up_transport"]);
    expect(completed).not.toHaveBeenCalled();
    expect(state.recallStore.size).toBe(0);
  },
);

test.each([
  ["usage", "follow_up_stream", "follow_up_protocol"],
  ["protocol", "follow_up_stream", "follow_up_protocol"],
  ["completion", "completion", "unexpected"],
] as const)(
  "distinguishes a %s failure from a broken upstream connection",
  async (mode, phase, category) => {
    installProductiveRecallMock();
    const diagnostics = vi.spyOn(log, "error").mockImplementation(() => {});
    const progress = vi.spyOn(log, "info").mockImplementation(() => {});
    const failures: RecallContinuationFailureCategory[] = [];
    setRecallContinuationFailureHook((failure) => failures.push(failure));
    const secret = "PRIVATE_CONTINUATION_TEXT";
    setUpstreamInterceptor(async () => {
      let body = buildSSETextResponse("continuation", "claude-test", secret, {
        inputTokens: 1,
        outputTokens: 1,
      });
      if (mode === "usage") {
        // A malformed usage count must be classified as a protocol failure.
        body = body.replaceAll('"output_tokens":1', '"output_tokens":null');
      } else if (mode === "protocol") {
        body = event("unexpected", { detail: secret });
      }
      return new Response(body, {
        headers: { "content-type": "text/event-stream" },
      });
    });
    const req = request();
    const completed = vi.fn(() => {
      if (mode === "completion") throw new Error(secret);
    });
    const state = sessionState();
    const downstream = buildStreamingResponse(
      recallOnlyResponse(70_000),
      completed,
      {
        clientMessages: req.messages,
        modifiedReq: req,
        config: loadLocalConfig(),
        sessionState: state,
        cacheOptions: { cacheConversation: false },
        clientSpeaksAnthropic: true,
        noStore: mode !== "completion",
        modelContextTokens: 200_000,
        allowExpandedContext: true,
        expectedPrincipalModel: req.model,
      },
    );

    await expect(downstream.text()).rejects.toThrow("SSE stream read failed");
    const diagnostic = diagnostics.mock.calls
      .map(([message]) => String(message))
      .join("\n");
    expect(diagnostic).toContain(`"phase":"${phase}"`);
    expect(diagnostic).toContain(`"category":"${category}"`);
    expect(diagnostic).not.toContain('"transportKind"');
    expect(diagnostic).not.toContain(secret);
    expect(failures).toEqual([category]);
    expect(completed).toHaveBeenCalledTimes(mode === "completion" ? 1 : 0);
    expect(state.recallStore.size).toBe(0);
    if (mode === "completion") {
      const messages = progress.mock.calls
        .map(([message]) => String(message))
        .join("\n");
      expect(messages).toContain('recall-chain {"outcome":"failed"');
      expect(messages).not.toContain('recall-chain {"outcome":"completed"');
    }
  },
);

describe("Anthropic recall continuation abort", () => {
  test.each([
    ["caller", 1],
    ["deadline", 1],
    ["caller", 10],
    ["deadline", 10],
  ] as const)(
    "%s abort settles a hostile nonterminal follow-up at round %i",
    async (mode, round) => {
      if (mode === "deadline") vi.useFakeTimers();
      installProductiveRecallMock();
      const failures: RecallContinuationFailureCategory[] = [];
      setRecallContinuationFailureHook((category) => failures.push(category));
      const continuation = hostileContinuation(mode === "deadline");
      let follows = 0;
      setUpstreamInterceptor(async () =>
        ++follows < round ? recallOnlyResponse() : continuation.response,
      );
      const caller = new AbortController();
      const req = request(caller.signal);
      const state = sessionState();
      const downstream = buildStreamingResponse(
        recallOnlyResponse(),
        () => {},
        {
          clientMessages: req.messages,
          modifiedReq: req,
          config: loadLocalConfig(),
          sessionState: state,
          cacheOptions: { cacheConversation: false },
          clientSpeaksAnthropic: true,
        },
        undefined,
        state.sessionID,
        undefined,
        caller.signal,
      );
      const pending = downstream.text();
      await continuation.readStarted;
      if (mode === "caller") {
        caller.abort(new DOMException("caller aborted", "AbortError"));
        await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      } else {
        const outcome = pending.then(
          () => null,
          (error: unknown) => error,
        );
        await vi.advanceTimersByTimeAsync(FOREGROUND_REQUEST_TIMEOUT_MS);
        await expect(outcome).resolves.toMatchObject({ name: "TimeoutError" });
      }
      expect(follows).toBe(round);
      expect(continuation.cancelled()).toBe(true);
      expect(continuation.response.body?.locked).toBe(false);
      expect(failures).toEqual([]);
    },
  );
});

test("an expanded Anthropic recall never forwards a switched model's text", async () => {
  installProductiveRecallMock();
  const untrusted = "untrusted continuation text";
  const completed = vi.fn();
  const failed = vi.fn();
  const calls = { count: 0 };
  setUpstreamInterceptor(async () => {
    calls.count++;
    return new Response(
      event("message_start", {
        message: {
          id: "msg_wrong_model",
          type: "message",
          role: "assistant",
          model: "claude-small",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 240_000, output_tokens: 0 },
        },
      }) +
        event("content_block_start", {
          index: 0,
          content_block: { type: "text", text: "" },
        }) +
        event("content_block_delta", {
          index: 0,
          delta: { type: "text_delta", text: untrusted },
        }) +
        event("content_block_stop", { index: 0 }) +
        event("message_delta", {
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 1 },
        }) +
        event("message_stop", {}),
      { headers: { "content-type": "text/event-stream" } },
    );
  });
  const req = request();
  const state = sessionState();
  const downstream = buildStreamingResponse(
    recallOnlyResponse(240_000),
    completed,
    {
      clientMessages: req.messages,
      modifiedReq: req,
      config: loadLocalConfig(),
      sessionState: state,
      cacheOptions: { cacheConversation: false },
      clientSpeaksAnthropic: true,
      noStore: true,
      onFailure: failed,
      modelContextTokens: 1_000_000,
      allowExpandedContext: true,
      expectedPrincipalModel: "claude-test",
    },
  );
  const reader = downstream.body!.getReader();
  const received: string[] = [];
  await expect(async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received.push(new TextDecoder().decode(value));
    }
  }).rejects.toThrow();
  expect(received.join("")).not.toContain(untrusted);
  expect(completed).not.toHaveBeenCalled();
  expect(failed).toHaveBeenCalledTimes(1);
  expect(calls.count).toBe(1);
});

test.each(["fetch", "http"] as const)(
  "an expanded Anthropic recall fails closed when its unmetered follow-up has a %s failure",
  async (mode) => {
    installProductiveRecallMock();
    const completed = vi.fn();
    const failed = vi.fn();
    const committed = vi.fn();
    const calls = { count: 0 };
    setRecallPersistenceCommitObserverForTest(committed);
    setUpstreamInterceptor(async () => {
      calls.count++;
      if (mode === "fetch") throw new Error("upstream unavailable");
      return new Response("unavailable", { status: 503 });
    });
    const req = request();
    const state = sessionState();
    const downstream = buildStreamingResponse(
      recallOnlyResponse(240_000),
      completed,
      {
        clientMessages: req.messages,
        modifiedReq: req,
        config: loadLocalConfig(),
        sessionState: state,
        cacheOptions: { cacheConversation: false },
        clientSpeaksAnthropic: true,
        onFailure: failed,
        modelContextTokens: 1_000_000,
        allowExpandedContext: true,
        expectedPrincipalModel: "claude-test",
      },
    );
    const reader = downstream.body!.getReader();
    const received: string[] = [];
    await expect(async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received.push(new TextDecoder().decode(value));
      }
    }).rejects.toThrow();
    // The marker envelope was already sent before the follow-up failed; a
    // failed turn must never produce a third, successful answer envelope.
    expect(received.join("").match(/^event: message_start$/gm)).toHaveLength(2);
    expect(calls.count).toBe(1);
    expect(completed).not.toHaveBeenCalled();
    expect(failed).toHaveBeenCalledTimes(1);
    expect(failed.mock.calls[0]?.[0]?.usage).toMatchObject({
      inputTokens: 240_000,
      outputTokens: 1,
    });
    expect(committed).not.toHaveBeenCalled();
    expect(state.recallStore.size).toBe(0);
  },
);

test.each([
  { inputTokens: 900_000, accepted: true },
  { inputTokens: 970_000, accepted: false },
])(
  "an expanded Anthropic recall enforces its final answer ceiling at $inputTokens tokens",
  async ({ inputTokens, accepted }) => {
    installProductiveRecallMock();
    const answer = "metered continuation text";
    const completed = vi.fn();
    const failed = vi.fn();
    setUpstreamInterceptor(
      async () =>
        new Response(
          event("message_start", {
            message: {
              id: "msg_metered_continuation",
              type: "message",
              role: "assistant",
              model: "claude-test",
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: inputTokens, output_tokens: 0 },
            },
          }) +
            event("content_block_start", {
              index: 0,
              content_block: { type: "text", text: "" },
            }) +
            event("content_block_delta", {
              index: 0,
              delta: { type: "text_delta", text: answer },
            }) +
            event("content_block_stop", { index: 0 }) +
            event("message_delta", {
              delta: { stop_reason: "end_turn", stop_sequence: null },
              usage: { output_tokens: 1 },
            }) +
            event("message_stop", {}),
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    const req = request();
    const state = sessionState();
    const downstream = buildStreamingResponse(
      recallOnlyResponse(240_000),
      completed,
      {
        clientMessages: req.messages,
        modifiedReq: req,
        config: loadLocalConfig(),
        sessionState: state,
        cacheOptions: { cacheConversation: false },
        clientSpeaksAnthropic: true,
        noStore: true,
        onFailure: failed,
        modelContextTokens: 1_000_000,
        allowExpandedContext: true,
        expectedPrincipalModel: "claude-test",
      },
    );
    const reader = downstream.body!.getReader();
    const received: string[] = [];
    const read = async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received.push(new TextDecoder().decode(value));
      }
    };
    if (accepted) {
      await read();
      expect(received.join("")).toContain(answer);
      expect(completed).toHaveBeenCalledTimes(1);
      expect(failed).not.toHaveBeenCalled();
    } else {
      await expect(read()).rejects.toThrow();
      expect(received.join("")).not.toContain(answer);
      expect(completed).not.toHaveBeenCalled();
      expect(failed).toHaveBeenCalledTimes(1);
    }
  },
);

describe.each([true, false])(
  "Anthropic recall exhaustion recovery (native=%s)",
  (clientSpeaksAnthropic) => {
    test.each([
      "answer",
      "recall",
      "http-error",
      "empty",
      "incomplete",
      "pause_turn",
      "model_context_window_exceeded",
    ] as const)("last continuation: %s", async (mode) => {
      installProductiveRecallMock();
      const finalText =
        mode === "empty" ? "" : "Finished using available results.";
      const completed = vi.fn();
      const failed = vi.fn();
      let calls = 0;
      const req = request();
      req.tools.push({ name: "Read", description: "Read", inputSchema: {} });
      req.metadata.tool_choice = { type: "tool", name: RECALL_TOOL_NAME };
      setUpstreamInterceptor(async (upstream) => {
        calls++;
        if (calls < MAX_RECALL_DEPTH) return recallOnlyResponse();
        const body = upstream as Record<string, unknown>;
        expect(body.tools).toEqual([
          expect.objectContaining({ name: RECALL_TOOL_NAME }),
          expect.objectContaining({ name: "Read" }),
        ]);
        expect(body.tool_choice).toEqual({
          type: "tool",
          name: RECALL_TOOL_NAME,
        });
        expect(JSON.stringify(body.messages)).toContain(
          "The recall budget for this turn has been used",
        );
        if (mode === "http-error")
          return new Response("unavailable", { status: 503 });
        if (mode === "recall") return recallOnlyResponse();
        return new Response(
          event("message_start", {
            message: {
              id: "msg_final",
              type: "message",
              role: "assistant",
              model: "claude-test",
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 3, output_tokens: 0 },
            },
          }) +
            event("content_block_start", {
              index: 0,
              content_block: { type: "text", text: "" },
            }) +
            event("content_block_delta", {
              index: 0,
              delta: { type: "text_delta", text: finalText },
            }) +
            event("content_block_stop", { index: 0 }) +
            event("message_delta", {
              delta: {
                stop_reason:
                  mode === "incomplete"
                    ? "max_tokens"
                    : mode === "pause_turn" ||
                        mode === "model_context_window_exceeded"
                      ? mode
                      : "end_turn",
                stop_sequence: null,
              },
              usage: { output_tokens: 2 },
            }) +
            event("message_stop", {}),
          { headers: { "content-type": "text/event-stream" } },
        );
      });
      const state = sessionState();
      const downstream = buildStreamingResponse(
        recallOnlyResponse(),
        completed,
        {
          clientMessages: req.messages,
          modifiedReq: req,
          config: loadLocalConfig(),
          sessionState: state,
          cacheOptions: { cacheConversation: false },
          clientSpeaksAnthropic,
          noStore: true,
          onFailure: failed,
        },
      );
      if (mode === "answer") {
        expect(await downstream.text()).toContain(finalText);
        expect(completed).toHaveBeenCalledTimes(1);
        expect(completed.mock.calls[0][0]).toMatchObject({
          content: [{ type: "text", text: finalText }],
          usage: {
            inputTokens: MAX_RECALL_DEPTH + 3,
            outputTokens: MAX_RECALL_DEPTH + 2,
          },
        });
      } else {
        const reader = downstream.body!.getReader();
        let received = "";
        let failure: unknown;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            received += new TextDecoder().decode(value);
          }
        } catch (error) {
          failure = error;
        }
        expect(failure).toBeInstanceOf(Error);
        // Read wire events incrementally: response.text() discards earlier bytes
        // on error and can hide a success terminal already delivered to a client.
        expect(received).not.toContain('"stop_reason":"max_tokens"');
        expect(received.match(/^event: message_delta$/gm) ?? []).toHaveLength(
          clientSpeaksAnthropic ? MAX_RECALL_DEPTH * 2 : 0,
        );
        expect(received.match(/^event: message_stop$/gm) ?? []).toHaveLength(
          clientSpeaksAnthropic ? MAX_RECALL_DEPTH * 2 : 0,
        );
        expect(completed).not.toHaveBeenCalled();
        expect(failed).toHaveBeenCalledTimes(1);
        const tokens =
          mode === "recall" ? MAX_RECALL_DEPTH + 1 : MAX_RECALL_DEPTH;
        expect(failed.mock.calls[0][0].usage).toMatchObject({
          inputTokens:
            mode !== "recall" && mode !== "http-error"
              ? MAX_RECALL_DEPTH + 3
              : tokens,
          outputTokens:
            mode !== "recall" && mode !== "http-error"
              ? MAX_RECALL_DEPTH + 2
              : tokens,
        });
      }
      expect(calls).toBe(MAX_RECALL_DEPTH);
      expect(mockedRecall).toHaveBeenCalledTimes(MAX_RECALL_DEPTH);
    });
  },
);
