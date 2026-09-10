import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("../src/recall", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/recall")>();
  return { ...actual, executeRecall: vi.fn() };
});

import { loadConfig } from "../src/config";
import {
  buildStreamingResponse,
  setUpstreamInterceptor,
} from "../src/pipeline";
import { executeRecall } from "../src/recall";
import { FOREGROUND_REQUEST_TIMEOUT_MS } from "../src/sse-inactivity";
import type { GatewayRequest, SessionState } from "../src/translate/types";

const mockedRecall = vi.mocked(executeRecall);

function loadLocalConfig() {
  const config = loadConfig();
  config.remoteGateway = false;
  config.hostedMode = false;
  return config;
}

function event(type: string, data: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

function recallOnlyResponse(): Response {
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
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    }) +
      event("content_block_start", {
        index: 0,
        content_block: {
          type: "tool_use",
          id: "tool_recall",
          name: "recall",
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
    tools: [{ name: "recall", description: "recall", inputSchema: {} }],
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
  setUpstreamInterceptor(undefined);
  mockedRecall.mockReset();
});

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
      mockedRecall.mockResolvedValue({
        result: "recall results",
        input: { query: "architecture" },
      });
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
    },
  );
});

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
      mockedRecall.mockResolvedValue({
        result: "recall results",
        input: { query: "architecture" },
      });
      const finalText =
        mode === "empty" ? "" : "Finished using available results.";
      const completed = vi.fn();
      const failed = vi.fn();
      let calls = 0;
      const req = request();
      req.tools.push({ name: "Read", description: "Read", inputSchema: {} });
      req.metadata.tool_choice = { type: "tool", name: "recall" };
      setUpstreamInterceptor(async (upstream) => {
        calls++;
        if (calls < 10) return recallOnlyResponse();
        const body = upstream as Record<string, unknown>;
        expect(body.tools).toEqual([
          expect.objectContaining({ name: "recall" }),
          expect.objectContaining({ name: "Read" }),
        ]);
        expect(body.tool_choice).toEqual({ type: "tool", name: "recall" });
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
          usage: { inputTokens: 13, outputTokens: 12 },
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
          clientSpeaksAnthropic ? 20 : 0,
        );
        expect(received.match(/^event: message_stop$/gm) ?? []).toHaveLength(
          clientSpeaksAnthropic ? 20 : 0,
        );
        expect(completed).not.toHaveBeenCalled();
        expect(failed).toHaveBeenCalledTimes(1);
        const tokens = mode === "recall" ? 11 : 10;
        expect(failed.mock.calls[0][0].usage).toMatchObject({
          inputTokens: mode !== "recall" && mode !== "http-error" ? 13 : tokens,
          outputTokens:
            mode !== "recall" && mode !== "http-error" ? 12 : tokens,
        });
      }
      expect(calls).toBe(10);
      expect(mockedRecall).toHaveBeenCalledTimes(10);
    });
  },
);
