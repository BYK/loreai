import { describe, expect, test } from "vitest";
import { parseAnthropicResponseJSON } from "../src/translate/anthropic";

describe("parseAnthropicResponseJSON usage validation", () => {
  test.each([
    { input_tokens: -1, output_tokens: 1 },
    { input_tokens: 1.5, output_tokens: 1 },
    { input_tokens: Number.MAX_SAFE_INTEGER + 1, output_tokens: 1 },
    {
      input_tokens: Number.MAX_SAFE_INTEGER,
      output_tokens: 1,
    },
  ])("rejects malformed or overflowing usage", (usage) => {
    expect(() => parseAnthropicResponseJSON({ content: [], usage })).toThrow(
      "malformed Anthropic response usage",
    );
  });

  test("accepts validated usage", () => {
    expect(
      parseAnthropicResponseJSON({
        content: [],
        usage: { input_tokens: 2, output_tokens: 3 },
      }).usage,
    ).toMatchObject({ inputTokens: 2, outputTokens: 3 });
  });
});
