/**
 * Regression tests for worker response parsing of reasoning models.
 *
 * Free/reasoning models commonly served on aggregators (OpenCode Zen, etc.) —
 * DeepSeek, Qwen-thinking, Nemotron, MiniMax — put their answer in a reasoning
 * field and leave the normal `content`/`text` block empty. Before the fix the
 * worker parsers returned `null`, which the adapter classified as an opaque
 * `no-response`, blocking background distillation/curation. These tests lock in
 * the reasoning-field fallback AND assert the normal path is unchanged.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../src/fetch", () => ({ upstreamFetch: vi.fn() }));

import {
  createGatewayLLMClient,
  gatewayResponseToWorkerResult,
  parseOpenAIResponse,
  parseAnthropicResponse,
} from "../src/llm-adapter";
import { upstreamFetch } from "../src/fetch";
import { clearAllCosts } from "../src/cost-tracker";
import { resetBackgroundLimiter } from "../src/background-limiter";

const mockFetch = vi.mocked(upstreamFetch);

describe("parseOpenAIResponse — reasoning-model fallback", () => {
  test("positive: normal content body still parses unchanged", () => {
    const r = parseOpenAIResponse({
      choices: [{ message: { content: "the real answer" } }],
      model: "gpt-x",
    });
    expect(r.text).toBe("the real answer");
    expect(r.model).toBe("gpt-x");
  });

  test("falls back to reasoning_content when content is empty (DeepSeek/Qwen)", () => {
    const r = parseOpenAIResponse({
      choices: [
        {
          message: { content: "", reasoning_content: "answer in reasoning" },
          finish_reason: "stop",
        },
      ],
    });
    expect(r.text).toBe("answer in reasoning");
  });

  test("falls back to reasoning_content when content is missing", () => {
    const r = parseOpenAIResponse({
      choices: [{ message: { reasoning_content: "only reasoning here" } }],
    });
    expect(r.text).toBe("only reasoning here");
  });

  test("falls back to `reasoning` field (OpenRouter shape)", () => {
    const r = parseOpenAIResponse({
      choices: [{ message: { reasoning: "openrouter reasoning text" } }],
    });
    expect(r.text).toBe("openrouter reasoning text");
  });

  test("prefers content over reasoning when both present", () => {
    const r = parseOpenAIResponse({
      choices: [
        {
          message: {
            content: "primary",
            reasoning_content: "secondary",
          },
        },
      ],
    });
    expect(r.text).toBe("primary");
  });

  test("negative: genuinely empty body still returns null (real failure preserved)", () => {
    const r = parseOpenAIResponse({ choices: [{ message: {} }] });
    expect(r.text).toBeNull();
  });

  test("non-string content (null) falls back to reasoning, never returned as text", () => {
    const r = parseOpenAIResponse({
      // content null at runtime (some providers) — must not be returned as text
      choices: [
        {
          message: {
            content: null as unknown as string,
            reasoning_content: "fallback reasoning",
          },
        },
      ],
    });
    expect(r.text).toBe("fallback reasoning");
  });

  test("ignores a non-string reasoning field", () => {
    const r = parseOpenAIResponse({
      choices: [
        {
          message: {
            reasoning_content: 42 as unknown as string,
          },
        },
      ],
    });
    expect(r.text).toBeNull();
  });

  test("negative: no choices returns null", () => {
    const r = parseOpenAIResponse({});
    expect(r.text).toBeNull();
  });
});

describe("parseAnthropicResponse — thinking-block fallback", () => {
  test("positive: normal text block still parses unchanged", () => {
    const r = parseAnthropicResponse({
      content: [{ type: "text", text: "the real answer" }],
      model: "claude-x",
    });
    expect(r.text).toBe("the real answer");
    expect(r.model).toBe("claude-x");
  });

  test("falls back to thinking block when no text block exists", () => {
    const r = parseAnthropicResponse({
      content: [{ type: "thinking", thinking: "answer in thinking" }],
    });
    expect(r.text).toBe("answer in thinking");
  });

  test("prefers text block over thinking block", () => {
    const r = parseAnthropicResponse({
      content: [
        { type: "thinking", thinking: "secondary" },
        { type: "text", text: "primary" },
      ],
    });
    expect(r.text).toBe("primary");
  });

  test("negative: genuinely empty content still returns null", () => {
    const r = parseAnthropicResponse({ content: [] });
    expect(r.text).toBeNull();
  });

  test("negative: missing content returns null", () => {
    const r = parseAnthropicResponse({});
    expect(r.text).toBeNull();
  });
});

describe("gatewayResponseToWorkerResult — streaming thinking-block fallback (#1334)", () => {
  const base = { id: "x", model: "m", stopReason: "end_turn" } as const;

  test("positive: a text block is returned unchanged", () => {
    const r = gatewayResponseToWorkerResult({
      ...base,
      content: [{ type: "text", text: "the real answer" }],
    });
    expect(r.text).toBe("the real answer");
  });

  test("falls back to a thinking block when there is no text (reasoning-only stream)", () => {
    // MiniMax-M3 via OpenRouter streams reasoning deltas and leaves content empty →
    // the accumulator emits only a thinking block. It must still yield usable text.
    const r = gatewayResponseToWorkerResult({
      ...base,
      content: [{ type: "thinking", thinking: "answer in reasoning" }],
    });
    expect(r.text).toBe("answer in reasoning");
  });

  test("prefers text over thinking when both present", () => {
    const r = gatewayResponseToWorkerResult({
      ...base,
      content: [
        { type: "thinking", thinking: "secondary" },
        { type: "text", text: "primary" },
      ],
    });
    expect(r.text).toBe("primary");
  });

  test("joins multiple thinking blocks when no text block exists", () => {
    const r = gatewayResponseToWorkerResult({
      ...base,
      content: [
        { type: "thinking", thinking: "part1 " },
        { type: "thinking", thinking: "part2" },
      ],
    });
    expect(r.text).toBe("part1 part2");
  });

  test("negative: a tool_use-only response is still empty (workers consume text)", () => {
    const r = gatewayResponseToWorkerResult({
      ...base,
      content: [{ type: "tool_use", id: "t1", name: "f", input: {} }],
    });
    expect(r.text).toBeNull();
  });

  test("negative: an empty content array returns null", () => {
    const r = gatewayResponseToWorkerResult({
      ...base,
      content: [],
    });
    expect(r.text).toBeNull();
  });
});

describe("worker end-to-end: reasoning-only SSE body → usable text (#1334 seam)", () => {
  const UPSTREAMS = {
    anthropic: "https://api.anthropic.com",
    openai: "https://api.openai.com",
  };

  beforeEach(() => {
    mockFetch.mockReset();
  });
  afterEach(() => {
    mockFetch.mockReset();
    clearAllCosts();
    resetBackgroundLimiter();
  });

  // The exact wire that regressed in #1334: a worker sends stream:false, but the
  // provider (OpenRouter/MiniMax-M3) returns an SSE body whose deltas carry only
  // `reasoning` (empty `content`). This drives the real seam
  // isSSE → accumulateWorkerSSE(openai) → gatewayResponseToWorkerResult, which the
  // two unit suites above only cover in halves.
  test("a reasoning-only OpenAI SSE worker response yields the reasoning as text", async () => {
    const sseBody = [
      'data: {"id":"c1","model":"minimax/minimax-m3","choices":[{"delta":{"reasoning":"extracted "}}]}',
      'data: {"choices":[{"delta":{"reasoning":"knowledge"}}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2}}',
      "data: [DONE]",
      "",
    ].join("\n\n");
    // Note: content-type is application/json (a mislabeled stream) — the worker
    // sniffs the body for SSE regardless, exercising the looksLikeSSE path too.
    mockFetch.mockResolvedValue(
      new Response(sseBody, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const client = createGatewayLLMClient(
      UPSTREAMS,
      (_sid, providerID) =>
        providerID === "openrouter"
          ? { scheme: "bearer", value: "or_worker" }
          : null,
      { providerID: "openrouter", modelID: "minimax/minimax-m3" },
    );

    const text = await client.prompt("system", "user", {
      sessionID: "sess-m3",
      workerID: "lore-distill",
      model: { providerID: "openrouter", modelID: "minimax/minimax-m3" },
      upstreamUrl: "https://openrouter.ai/api/v1",
      upstreamProviderID: "openrouter",
    });

    // Pre-fix this returned null (reasoning dropped) → distillation parse-error.
    expect(text).toBe("extracted knowledge");
  });
});
