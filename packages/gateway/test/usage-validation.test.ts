import { describe, expect, it } from "vitest";
import {
  validateGeminiUsageMetadata,
  validateOpenAIUsage,
  validateResponsesUsage,
} from "../src/usage-validation";

describe("usage validation", () => {
  it.each([
    [[]],
    [{ prompt_tokens: "PRIVATE_COUNT" }],
    [{ completion_tokens: -1 }],
    [{ total_tokens: 1.5 }],
    [{ prompt_tokens: 2, total_tokens: 2 }],
    [{ prompt_tokens: Number.MAX_SAFE_INTEGER, completion_tokens: 1 }],
    [{ prompt_tokens_details: [] }],
    [{ prompt_tokens_details: { cached_tokens: "PRIVATE_CACHE" } }],
    [{ completion_tokens_details: { reasoning_tokens: "PRIVATE_REASONING" } }],
    [{ prompt_tokens: 1, prompt_tokens_details: { cached_tokens: 2 } }],
    [{ completion_tokens_details: { reasoning_tokens: 1 } }],
    [
      {
        prompt_tokens_details: {
          cached_tokens: Number.MAX_SAFE_INTEGER,
          cache_write_tokens: 1,
        },
      },
    ],
  ])("rejects malformed OpenAI usage: %j", (usage) => {
    expect(() => validateOpenAIUsage(usage, "fixed failure")).toThrow(
      "fixed failure",
    );
  });

  it.each([4, 5, 6, 7])(
    "accepts total_tokens regardless of equality with prompt + completion (%d)",
    (total) => {
      const usage = {
        prompt_tokens: 2,
        completion_tokens: 3,
        total_tokens: total,
        prompt_tokens_details: { cached_tokens: 1 },
        completion_tokens_details: { reasoning_tokens: 1 },
      };
      expect(validateOpenAIUsage(usage, "fixed failure")).toBe(usage);
    },
  );

  it.each([4, 5, 6, 7])(
    "accepts Responses total_tokens regardless of equality with input + output (%d)",
    (total) => {
      const usage = {
        input_tokens: 2,
        output_tokens: 3,
        total_tokens: total,
        input_tokens_details: { cached_tokens: 1 },
        output_tokens_details: { reasoning_tokens: 1 },
      };
      expect(validateResponsesUsage(usage, "fixed failure")).toBe(usage);
    },
  );

  it.each([12, 14, 15])(
    "accepts Gemini totalTokenCount regardless of equality with components (%d)",
    (total) => {
      const usage = {
        promptTokenCount: 2,
        candidatesTokenCount: 3,
        thoughtsTokenCount: 4,
        toolUsePromptTokenCount: 5,
        cachedContentTokenCount: 1,
        totalTokenCount: total,
      };
      expect(validateGeminiUsageMetadata(usage, "fixed failure")).toBe(usage);
    },
  );

  it("preserves accepted values, including optional and nullable details", () => {
    for (const usage of [
      undefined,
      null,
      {},
      { prompt_tokens: 2 },
      {
        prompt_tokens: 2,
        completion_tokens: 3,
        total_tokens: 5,
        prompt_tokens_details: null,
        completion_tokens_details: { reasoning_tokens: 1 },
      },
    ]) {
      expect(validateOpenAIUsage(usage, "fixed failure")).toBe(
        usage ?? undefined,
      );
    }
  });
});
