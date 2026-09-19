/**
 * Reproduction: a Claude turn that emits TWO `recall` tool_use blocks aborts
 * the whole relay.
 *
 * pipeline.ts's recall loop throws RecallContinuationFailure("parallel_recall")
 * as soon as it sees more than one recall tool_use in a turn. Unlike the
 * Responses path (which fails in-band with a `response.failed` event), the
 * Anthropic path lets that error escape to the top-level catch, which calls
 * controller.error() on the client stream.
 *
 * The client therefore sees a 200 SSE response that terminates mid-turn with
 * zero text/tool content and no terminal event — which Claude Code renders as
 * "Connection lost before a response was produced".
 *
 * NOTE: the gateway now prevents the model from producing this shape at all by
 * sending `tool_choice.disable_parallel_tool_use` on Anthropic requests that
 * carry a recall tool (see anthropic-parallel-tool-use-guard.test.ts). This
 * test pins the residual behaviour, so the hard abort stays a deliberate choice
 * if the guard is bypassed (for example, an endpoint strips the field or a replayed
 * body omits it), the turn is still lost. Lifting that requires the follow-up — executing every recall call
 * instead of rejecting the turn.
 */
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
import {
  setRecallContinuationFailureHook,
  type RecallContinuationFailureCategory,
} from "../src/recall-continuation-failure";
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

/** An assistant turn that calls `recall` twice in parallel, then stops. */
function parallelRecallResponse(): Response {
  const body =
    event("message_start", {
      message: {
        id: "msg_parallel",
        type: "message",
        role: "assistant",
        model: "claude-opus-5",
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
        id: "tool_recall_a",
        name: "recall",
        input: {},
      },
    }) +
    event("content_block_delta", {
      index: 0,
      delta: { type: "input_json_delta", partial_json: '{"query":"alpha"}' },
    }) +
    event("content_block_stop", { index: 0 }) +
    event("content_block_start", {
      index: 1,
      content_block: {
        type: "tool_use",
        id: "tool_recall_b",
        name: "recall",
        input: {},
      },
    }) +
    event("content_block_delta", {
      index: 1,
      delta: { type: "input_json_delta", partial_json: '{"query":"beta"}' },
    }) +
    event("content_block_stop", { index: 1 }) +
    event("message_delta", {
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { output_tokens: 1 },
    }) +
    event("message_stop", {});
  return new Response(body, {
    headers: { "content-type": "text/event-stream" },
  });
}

function request(): GatewayRequest {
  return {
    protocol: "anthropic",
    model: "claude-opus-5",
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
  };
}

function sessionState(): SessionState {
  return {
    sessionID: `parallel-recall-${crypto.randomUUID()}`,
    projectPath: "/tmp/parallel-recall",
    fingerprint: "fingerprint",
    lastRequestTime: Date.now(),
    lastUserTurnTime: Date.now(),
    messageCount: 1,
    turnsSinceCuration: 0,
    consecutiveTextOnlyTurns: 0,
    upstreamByProvider: new Map(),
    recallStore: new Map(),
    cacheAnalytics: { lastRequestBody: null, turns: [] },
  } as unknown as SessionState;
}

afterEach(() => {
  vi.useRealTimers();
  setUpstreamInterceptor(undefined);
  setRecallContinuationFailureHook(undefined);
  mockedRecall.mockReset();
});

describe("Anthropic parallel recall", () => {
  test("two recall tool_use blocks abort the relay with no content delivered", async () => {
    const failures: RecallContinuationFailureCategory[] = [];
    setRecallContinuationFailureHook((category) => failures.push(category));

    const req = request();
    const downstream = buildStreamingResponse(
      parallelRecallResponse(),
      () => {},
      {
        clientMessages: req.messages,
        modifiedReq: req,
        config: loadLocalConfig(),
        sessionState: sessionState(),
        cacheOptions: { cacheConversation: false },
        clientSpeaksAnthropic: true,
      },
    );

    // The relay dies rather than degrading: this is the defect. The client sees
    // a truncated stream, which Claude Code renders as a connection loss.
    await expect(downstream.text()).rejects.toThrow("SSE stream read failed");
    // The root cause is the parallel-recall guard, not a transport fault.
    expect(failures).toEqual(["parallel_recall"]);
    // Recall is never even executed — the turn is discarded before that.
    expect(mockedRecall).not.toHaveBeenCalled();
  });
});
