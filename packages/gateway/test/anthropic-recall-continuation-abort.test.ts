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
import type { GatewayRequest, SessionState } from "../src/translate/types";

const mockedRecall = vi.mocked(executeRecall);

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
  test.each(["caller", "deadline"] as const)(
    "%s abort settles a hostile nonterminal follow-up",
    async (mode) => {
      if (mode === "deadline") vi.useFakeTimers();
      mockedRecall.mockResolvedValue({
        result: "recall results",
        input: { query: "architecture" },
      });
      const continuation = hostileContinuation(mode === "deadline");
      setUpstreamInterceptor(async () => continuation.response);
      const caller = new AbortController();
      const req = request(caller.signal);
      const state = sessionState();
      const downstream = buildStreamingResponse(
        recallOnlyResponse(),
        () => {},
        {
          clientMessages: req.messages,
          modifiedReq: req,
          config: loadConfig(),
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
        await vi.advanceTimersByTimeAsync(300_000);
        await expect(outcome).resolves.toMatchObject({ name: "TimeoutError" });
      }
      expect(continuation.cancelled()).toBe(true);
      expect(continuation.response.body?.locked).toBe(false);
    },
  );
});
