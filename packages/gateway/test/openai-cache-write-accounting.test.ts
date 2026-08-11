/**
 * Tests for OpenRouter/OpenAI-protocol cache-WRITE accounting.
 *
 * Companion to `openai-caching.test.ts` (which emits `cache_control` on the
 * request). Once OpenRouter starts writing to the cache it reports the write in
 * `usage.prompt_tokens_details.cache_write_tokens` (Chat Completions) or
 * `usage.input_tokens_details.cache_write_tokens` (Responses API). These tests
 * pin that every OpenAI-protocol parse path maps that field to
 * `cacheCreationInputTokens` so the cost tracker, cache analytics and warmer
 * economics see real write tokens instead of a hard-coded 0.
 *
 * Regression guard for the second half of the "OpenRouter caching" fix: the
 * request now marks content cacheable (PR #1321); this makes the reported
 * writes actually count.
 */
import { describe, test, expect } from "vitest";
import {
  accumulateOpenAINonStreamJSON,
  accumulateResponsesNonStreamJSON,
} from "../src/pipeline";
import { accumulateOpenAISSEStream } from "../src/stream/openai";
import { accumulateResponsesSSEStream } from "../src/stream/openai-responses";
import {
  normalizeOpenAIUsage,
  disjointOpenAIInputTokens,
  gatewayResponseToWorkerResult,
} from "../src/llm-adapter";

/** One SSE event per entry; blank-line delimited per the spec. */
function sse(lines: string[]): Response {
  return new Response(`${lines.join("\n\n")}\n\n`, {
    headers: { "content-type": "text/event-stream" },
  });
}

function responsesSSE(
  events: Array<{ event: string; data: Record<string, unknown> }>,
): Response {
  const chunks = events.map(
    (e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`,
  );
  return new Response(chunks.join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

// ---------------------------------------------------------------------------
// Non-streaming Chat Completions (accumulateOpenAINonStreamJSON)
// ---------------------------------------------------------------------------

describe("non-stream Chat Completions cache-write accounting", () => {
  test("foreground parser rejects duplicate effective tool identities", () => {
    expect(() =>
      accumulateOpenAINonStreamJSON({
        choices: [
          {
            message: {
              tool_calls: [
                { id: "shared", function: { name: "a", arguments: "{}" } },
                { id: "shared", function: { name: "b", arguments: "{}" } },
              ],
            },
          },
        ],
      }),
    ).toThrow("malformed OpenAI response tool identity");
  });
  test("foreground parser validates tool identities in choice 1", () => {
    expect(() =>
      accumulateOpenAINonStreamJSON({
        choices: [
          { message: { content: "supported" } },
          {
            message: {
              tool_calls: [
                { id: "", function: { name: "bad", arguments: "{}" } },
              ],
            },
          },
        ],
      }),
    ).toThrow("malformed OpenAI response tool identity");
  });
  test("foreground parser validates all choices while projecting choice zero", () => {
    const response = accumulateOpenAINonStreamJSON({
      choices: [
        {
          index: 0,
          message: {
            content: "projected",
            tool_calls: [
              {
                id: "choice-zero",
                function: { name: "zero", arguments: "{}" },
              },
            ],
          },
        },
        {
          index: 1,
          message: {
            content: "ignored",
            tool_calls: [
              { id: "choice-one", function: { name: "one", arguments: "{}" } },
            ],
          },
        },
      ],
    });
    expect(response.content).toEqual([
      { type: "text", text: "projected" },
      { type: "tool_use", id: "choice-zero", name: "zero", input: {} },
    ]);
  });
  test("foreground parser permits the same tool identity in independent choices", () => {
    const response = accumulateOpenAINonStreamJSON({
      choices: [
        {
          index: 0,
          message: {
            tool_calls: [
              { id: "shared", function: { name: "zero", arguments: "{}" } },
            ],
          },
        },
        {
          index: 1,
          message: {
            tool_calls: [
              { id: "shared", function: { name: "one", arguments: "{}" } },
            ],
          },
        },
      ],
    });
    expect(response.content).toEqual([
      { type: "tool_use", id: "shared", name: "zero", input: {} },
    ]);
  });
  test("foreground parser rejects duplicate logical choice indices before tool validation", () => {
    expect(() =>
      accumulateOpenAINonStreamJSON({
        choices: [
          { index: 4, message: { content: "first" } },
          { index: 4, message: { tool_calls: "malformed" } },
        ],
      }),
    ).toThrow("malformed OpenAI response choice");
  });
  test("foreground parser fallback indices cannot collide with explicit indices", () => {
    expect(() =>
      accumulateOpenAINonStreamJSON({
        choices: [
          { index: 1, message: { content: "first" } },
          { message: { content: "second" } },
        ],
      }),
    ).toThrow("malformed OpenAI response choice");
  });
  test.each([
    [{ index: -1, message: { content: "bad" } }],
    [{ finish_reason: 7, message: { content: "bad" } }],
    [{ message: { content: 42 } }],
  ])(
    "foreground parser rejects malformed non-projected choice %#",
    (choice) => {
      expect(() =>
        accumulateOpenAINonStreamJSON({
          choices: [{ message: { content: "projected" } }, choice],
        }),
      ).toThrow("malformed OpenAI response choice");
    },
  );
  test("maps prompt_tokens_details.cache_write_tokens to cacheCreationInputTokens", () => {
    const resp = accumulateOpenAINonStreamJSON({
      id: "c1",
      model: "anthropic/claude-opus-4.8",
      choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 200,
        completion_tokens: 5,
        prompt_tokens_details: { cached_tokens: 50, cache_write_tokens: 100 },
      },
    });
    expect(resp.usage?.cacheReadInputTokens).toBe(50);
    expect(resp.usage?.cacheCreationInputTokens).toBe(100);
    // prompt_tokens (200) is inclusive of cache read (50) + write (100);
    // disjoint input = 200 − 50 − 100 = 50.
    expect(resp.usage?.inputTokens).toBe(50);
  });

  test("leaves cacheCreationInputTokens undefined when the field is absent", () => {
    const resp = accumulateOpenAINonStreamJSON({
      id: "c1",
      model: "gpt-4o",
      choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 2,
        prompt_tokens_details: { cached_tokens: 0 },
      },
    });
    expect(resp.usage?.cacheReadInputTokens).toBe(0);
    // undefined, NOT 0 — a real write of 0 and "no data" must stay distinct.
    expect(resp.usage?.cacheCreationInputTokens).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Non-streaming Responses API (accumulateResponsesNonStreamJSON)
// ---------------------------------------------------------------------------

describe("non-stream Responses API cache-write accounting", () => {
  test("foreground parser rejects missing and duplicate effective tool identities", () => {
    expect(() =>
      accumulateResponsesNonStreamJSON({
        output: [
          {
            type: "function_call",
            call_id: "",
            id: "",
            name: "missing",
            arguments: "{}",
          },
        ],
      }),
    ).toThrow("malformed Responses response item identity");
  });
  test("foreground parser rejects duplicate item IDs with distinct call IDs", () => {
    expect(() =>
      accumulateResponsesNonStreamJSON({
        output: [
          {
            type: "function_call",
            id: "item-shared",
            call_id: "call-a",
            name: "a",
            arguments: "{}",
          },
          {
            type: "function_call",
            id: "item-shared",
            call_id: "call-b",
            name: "b",
            arguments: "{}",
          },
        ],
      }),
    ).toThrow("malformed Responses response item identity");
  });
  test("reads cache_write_tokens from input_tokens_details", () => {
    const resp = accumulateResponsesNonStreamJSON({
      id: "resp_1",
      model: "anthropic/claude-opus-4.8",
      status: "completed",
      output: [
        {
          type: "message",
          id: "msg-cache-write",
          content: [{ type: "output_text", text: "hi" }],
        },
      ],
      usage: {
        input_tokens: 300,
        output_tokens: 8,
        input_tokens_details: { cached_tokens: 20, cache_write_tokens: 250 },
      },
    });
    expect(resp.usage?.cacheReadInputTokens).toBe(20);
    expect(resp.usage?.cacheCreationInputTokens).toBe(250);
    // input_tokens (300) inclusive of read (20) + write (250) → 300−20−250 = 30.
    expect(resp.usage?.inputTokens).toBe(30);
  });

  test("falls back to prompt_tokens_details for OpenAI-compatible providers", () => {
    const resp = accumulateResponsesNonStreamJSON({
      id: "resp_2",
      model: "some/provider",
      status: "completed",
      output: [],
      usage: {
        input_tokens: 100,
        output_tokens: 4,
        prompt_tokens_details: { cached_tokens: 10, cache_write_tokens: 90 },
      },
    });
    expect(resp.usage?.cacheReadInputTokens).toBe(10);
    expect(resp.usage?.cacheCreationInputTokens).toBe(90);
    // input_tokens (100) inclusive of read (10) + write (90) → 100−10−90 = 0.
    expect(resp.usage?.inputTokens).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Streaming Chat Completions (accumulateOpenAISSEStream)
// ---------------------------------------------------------------------------

describe("stream Chat Completions cache-write accounting", () => {
  test("reads cache_write_tokens from the final usage chunk", async () => {
    const resp = await accumulateOpenAISSEStream(
      sse([
        'data: {"id":"c1","model":"anthropic/claude-opus-4.8","choices":[{"delta":{"content":"ok"}}]}',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":200,"completion_tokens":5,"prompt_tokens_details":{"cached_tokens":50,"cache_write_tokens":100}}}',
        "data: [DONE]",
        "",
      ]),
    );
    expect(resp.usage?.cacheReadInputTokens).toBe(50);
    expect(resp.usage?.cacheCreationInputTokens).toBe(100);
    // prompt_tokens (200) inclusive of read (50) + write (100) → 200−50−100 = 50.
    expect(resp.usage?.inputTokens).toBe(50);
  });

  test("leaves cacheCreationInputTokens undefined when absent", async () => {
    const resp = await accumulateOpenAISSEStream(
      sse([
        'data: {"id":"c1","choices":[{"delta":{"content":"ok"}}]}',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":7,"completion_tokens":3}}',
        "data: [DONE]",
        "",
      ]),
    );
    expect(resp.usage?.cacheCreationInputTokens).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Streaming Responses API (accumulateResponsesSSEStream)
// ---------------------------------------------------------------------------

describe("stream Responses API cache-write accounting", () => {
  test("reads cache_write_tokens from input_tokens_details on response.completed", async () => {
    const resp = await accumulateResponsesSSEStream(
      responsesSSE([
        {
          event: "response.completed",
          data: {
            type: "response.completed",
            response: {
              id: "resp_1",
              model: "anthropic/claude-opus-4.8",
              status: "completed",
              output: [],
              usage: {
                input_tokens: 300,
                output_tokens: 8,
                input_tokens_details: {
                  cached_tokens: 20,
                  cache_write_tokens: 250,
                },
              },
            },
          },
        },
      ]),
    );
    expect(resp.usage?.cacheReadInputTokens).toBe(20);
    expect(resp.usage?.cacheCreationInputTokens).toBe(250);
    // input_tokens (300) inclusive of read (20) + write (250) → 300−20−250 = 30.
    expect(resp.usage?.inputTokens).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// Worker cost normalization (normalizeOpenAIUsage)
// ---------------------------------------------------------------------------

describe("normalizeOpenAIUsage cache-write accounting", () => {
  test("maps cache_write_tokens to cache_creation_input_tokens", () => {
    const result = normalizeOpenAIUsage({
      prompt_tokens: 200,
      completion_tokens: 5,
      prompt_tokens_details: { cached_tokens: 50, cache_write_tokens: 100 },
    });
    expect(result.cache_read_input_tokens).toBe(50);
    expect(result.cache_creation_input_tokens).toBe(100);
    // prompt_tokens (200) inclusive of read (50) + write (100) → disjoint 50.
    expect(result.input_tokens).toBe(50);
  });

  test("defaults cache_creation_input_tokens to 0 when absent (OpenAI proper)", () => {
    const result = normalizeOpenAIUsage({
      prompt_tokens: 10,
      completion_tokens: 2,
      prompt_tokens_details: { cached_tokens: 0 },
    });
    expect(result.cache_creation_input_tokens).toBe(0);
    // no cache tokens → input_tokens unchanged.
    expect(result.input_tokens).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// disjointOpenAIInputTokens — the shared inclusive→disjoint converter
// ---------------------------------------------------------------------------

describe("disjointOpenAIInputTokens", () => {
  test("subtracts cache read + write from the raw input", () => {
    expect(disjointOpenAIInputTokens(200, 50, 100)).toBe(50);
  });

  test("treats missing cache fields as zero", () => {
    expect(disjointOpenAIInputTokens(200, undefined, undefined)).toBe(200);
    expect(disjointOpenAIInputTokens(200, 30, undefined)).toBe(170);
  });

  test("clamps at 0 when cache tokens exceed the reported input", () => {
    // Defensive: a provider must never drive input negative.
    expect(disjointOpenAIInputTokens(100, 80, 90)).toBe(0);
  });

  test("treats missing raw input as zero", () => {
    expect(disjointOpenAIInputTokens(undefined, 10, 10)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// gatewayResponseToWorkerResult — SSE worker path must forward cache writes
// ---------------------------------------------------------------------------

describe("gatewayResponseToWorkerResult cache-write forwarding", () => {
  test("maps cacheCreationInputTokens to cache_creation_input_tokens", () => {
    const result = gatewayResponseToWorkerResult({
      id: "w1",
      model: "anthropic/claude-opus-4.8",
      content: [{ type: "text", text: "ok" }],
      stopReason: "end_turn",
      usage: {
        inputTokens: 50,
        outputTokens: 5,
        cacheReadInputTokens: 20,
        cacheCreationInputTokens: 100,
      },
    });
    // The SSE worker path dropped cache_creation_input_tokens, under-reporting
    // worker cache-creation cost. It must be forwarded verbatim.
    expect(result.usage?.cache_creation_input_tokens).toBe(100);
    expect(result.usage?.cache_read_input_tokens).toBe(20);
    expect(result.usage?.input_tokens).toBe(50);
  });
});
