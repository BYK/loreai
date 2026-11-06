import { describe, expect, it } from "vitest";
import {
  OpenAIUsageValidationError,
  validateOpenAIUsage,
} from "../src/usage-validation";

describe("OpenAI usage rejection diagnostics", () => {
  it.each([
    [[], "usage", "invalid-container"],
    [{ prompt_tokens: "PRIVATE_COUNT" }, "prompt_tokens", "invalid-count"],
    [{ completion_tokens: -1 }, "completion_tokens", "invalid-count"],
    [{ total_tokens: 1.5 }, "total_tokens", "invalid-count"],
    [
      { prompt_tokens: 2, total_tokens: 2 },
      "total_tokens",
      "missing-components",
    ],
    [
      { prompt_tokens: Number.MAX_SAFE_INTEGER, completion_tokens: 1 },
      "total_tokens",
      "sum-overflow",
    ],
    [
      { prompt_tokens_details: [] },
      "prompt_tokens_details",
      "invalid-container",
    ],
    [
      { prompt_tokens_details: { cached_tokens: "PRIVATE_CACHE" } },
      "prompt_tokens_details.cached_tokens",
      "invalid-count",
    ],
    [
      { completion_tokens_details: { reasoning_tokens: "PRIVATE_REASONING" } },
      "completion_tokens_details.reasoning_tokens",
      "invalid-count",
    ],
    [
      { prompt_tokens: 1, prompt_tokens_details: { cached_tokens: 2 } },
      "prompt_tokens_details",
      "invalid-subset",
    ],
    [
      { completion_tokens_details: { reasoning_tokens: 1 } },
      "completion_tokens_details",
      "invalid-subset",
    ],
    [
      {
        prompt_tokens_details: {
          cached_tokens: Number.MAX_SAFE_INTEGER,
          cache_write_tokens: 1,
        },
      },
      "prompt_tokens_details",
      "sum-overflow",
    ],
  ])("rejects with fixed field and category: %j", (usage, field, category) => {
    let caught: unknown;
    try {
      validateOpenAIUsage(usage, "fixed failure");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(OpenAIUsageValidationError);
    expect(caught).toMatchObject({ message: "fixed failure", field, category });
    expect(JSON.stringify(caught)).not.toContain("PRIVATE_");
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
