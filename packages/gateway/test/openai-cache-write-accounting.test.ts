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
import { normalizeOpenAIUsage } from "../src/llm-adapter";

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
  test("reads cache_write_tokens from input_tokens_details", () => {
    const resp = accumulateResponsesNonStreamJSON({
      id: "resp_1",
      model: "anthropic/claude-opus-4.8",
      status: "completed",
      output: [
        {
          type: "message",
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
  });

  test("defaults cache_creation_input_tokens to 0 when absent (OpenAI proper)", () => {
    const result = normalizeOpenAIUsage({
      prompt_tokens: 10,
      completion_tokens: 2,
      prompt_tokens_details: { cached_tokens: 0 },
    });
    expect(result.cache_creation_input_tokens).toBe(0);
  });
});
