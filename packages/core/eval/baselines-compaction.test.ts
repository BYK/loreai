import { describe, expect, test } from "vitest";
import { compactionBaseline } from "./baselines";
import type { ConversationTurn } from "./types";

/** Mock LLM that returns a tiny summary and records every prompt it saw. */
function mockLlm() {
  const prompts: string[] = [];
  const client = {
    config: {
      backend: "anthropic" as const,
      model: "m",
      judgeModel: "m",
      apiKey: "",
      baseUrl: "",
    },
    async prompt(_system: string, user: string) {
      prompts.push(user);
      return {
        text: `SUMMARY#${prompts.length}`,
        inputTokens: 0,
        outputTokens: 0,
      };
    },
  };
  return { client: client as never, prompts };
}

/** N synthetic turns of `tokensEach` tokens (token field drives the math). */
function synthTurns(n: number, tokensEach: number): ConversationTurn[] {
  return Array.from({ length: n }, (_, i) => ({
    role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
    content: [{ type: "text" as const, text: `turn ${i} fact-${i}` }],
    tokens: tokensEach,
  }));
}

// Signature: compactionBaseline(turns, llm, modelContextWindow?, maxOutputTokens?)
describe("progressive compactionBaseline", () => {
  test("fires multiple times on a large session and compounds the anchor", async () => {
    const { client, prompts } = mockLlm();
    // ~600K tokens (120 × 5K) against a 200K window → many progressive passes.
    const turns = synthTurns(120, 5000);
    const out = await compactionBaseline(turns, client, 200_000);

    // Multiple progressive compactions (not one-shot).
    expect(prompts.length).toBeGreaterThanOrEqual(2);
    // The final context carries the running anchored summary, not raw prefix.
    expect(out).toContain("## Summary of earlier conversation");
    expect(out).toContain(`SUMMARY#${prompts.length}`);

    // Compounding: every pass after the first folds a prefix that still carries
    // the PREVIOUS anchor summary text.
    for (let i = 1; i < prompts.length; i++) {
      expect(prompts[i]).toContain("SUMMARY#");
    }
  });

  test("no compaction when the session fits under the window", async () => {
    const { client, prompts } = mockLlm();
    const turns = synthTurns(10, 5000); // 50K << 200K window
    const out = await compactionBaseline(turns, client, 200_000);
    expect(prompts.length).toBe(0);
    expect(out).not.toContain("## Summary of earlier conversation");
  });

  test("a bigger session compacts more times than a smaller one", async () => {
    const small = mockLlm();
    await compactionBaseline(synthTurns(60, 5000), small.client, 200_000); // 300K
    const big = mockLlm();
    await compactionBaseline(synthTurns(200, 5000), big.client, 200_000); // 1M
    expect(big.prompts.length).toBeGreaterThan(small.prompts.length);
  });
});
