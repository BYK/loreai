/**
 * Regression for an Anthropic turn that emits two recall tool calls.
 *
 * The gateway rejects parallel recall execution. The request-side guard in
 * `anthropic-parallel-tool-use-guard.test.ts` prevents this shape for supported
 * Anthropic-compatible endpoints; this test keeps the failure path explicit if
 * an endpoint strips the guard or a replayed request omits it.
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
  test("two recall tool calls abort the relay without executing recall", async () => {
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

    await expect(downstream.text()).rejects.toThrow("SSE stream read failed");
    expect(failures).toEqual(["parallel_recall"]);
    expect(mockedRecall).not.toHaveBeenCalled();
  });
});
