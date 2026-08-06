// Codex-worker Responses-path cache accounting.
//
// `parseResponsesWorkerResponse` parses the OpenAI Responses body returned to a
// worker call (openai-codex background work). Before this fix it read only
// input_tokens/output_tokens verbatim — it ignored cache reads/writes entirely
// and passed the inclusive `input_tokens` straight through, so worker cache
// cost was under-reported and (once cache tokens are present) input was double-
// counted. This suite locks in: cache read + write mapping, and the disjoint
// input conversion (matching the streaming/non-streaming accumulators).

import { describe, test, expect } from "vitest";
import { parseResponsesWorkerResponse } from "../src/llm-adapter";

describe("parseResponsesWorkerResponse cache accounting", () => {
  test("maps cache read + write from input_tokens_details and disjoins input", () => {
    const { usage } = parseResponsesWorkerResponse({
      output_text: "ok",
      model: "anthropic/claude-opus-4.8",
      usage: {
        input_tokens: 300,
        output_tokens: 8,
        input_tokens_details: { cached_tokens: 20, cache_write_tokens: 250 },
      },
    });
    expect(usage?.cache_read_input_tokens).toBe(20);
    expect(usage?.cache_creation_input_tokens).toBe(250);
    // input_tokens (300) inclusive of read (20) + write (250) → 300−20−250 = 30.
    expect(usage?.input_tokens).toBe(30);
  });

  test("falls back to prompt_tokens_details for OpenAI-compatible providers", () => {
    const { usage } = parseResponsesWorkerResponse({
      output_text: "ok",
      usage: {
        input_tokens: 100,
        output_tokens: 4,
        prompt_tokens_details: { cached_tokens: 10, cache_write_tokens: 90 },
      },
    });
    expect(usage?.cache_read_input_tokens).toBe(10);
    expect(usage?.cache_creation_input_tokens).toBe(90);
    // 100 − 10 − 90 = 0.
    expect(usage?.input_tokens).toBe(0);
  });

  test("defaults cache buckets to 0 and leaves input unchanged when absent", () => {
    const { usage } = parseResponsesWorkerResponse({
      output_text: "ok",
      usage: { input_tokens: 42, output_tokens: 3 },
    });
    expect(usage?.cache_read_input_tokens).toBe(0);
    expect(usage?.cache_creation_input_tokens).toBe(0);
    expect(usage?.input_tokens).toBe(42);
  });

  test("returns null usage when the response omits usage", () => {
    const { usage } = parseResponsesWorkerResponse({ output_text: "ok" });
    expect(usage).toBeNull();
  });

  test("falls back to output[].content[].text when output_text aggregate is null", () => {
    // GitHub Copilot's /responses endpoint echoes back `output_text: null` in
    // its convenience aggregate and instead nests the text under
    // `output[].content[].text` (verified by live probe against
    // api.githubcopilot.com/responses on gpt-5.6-luna). The parser MUST
    // fall back to the item walk — otherwise every Copilot /responses worker
    // call would return text=null and fail the parseInvariantVerdict step.
    //
    // The function's parameter type declares `output_text?: string`, but
    // Copilot returns null in practice; the parser's `typeof === "string"`
    // guard at `parseResponsesWorkerResponse:1447` already handles null
    // correctly. The cast here pins the production behavior without forcing
    // a (potentially-confusing) widening of the public parameter type.
    const { text } = parseResponsesWorkerResponse({
      output_text: null as unknown as string,
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: "fallback via item walk" }],
        },
      ],
    });
    expect(text).toBe("fallback via item walk");
  });
});
