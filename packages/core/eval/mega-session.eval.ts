/**
 * Mega-session eval — vitest-evals.
 *
 * Tests recall of details across a real 2.3M-token, 5-day coding session.
 * No inflation needed — the session is already at mega-scale.
 */
import { beforeAll, afterAll } from "vitest";
import {
  describeEval,
  FactualityJudge,
  createJudgeHarness,
} from "vitest-evals";
import {
  loreEvalHarness,
  replayAndWarmup,
  teardownGateway,
} from "./lore-harness";

// Load scenario
const mod = await import("./scenarios/mega-session");
const scenario = mod.default;

// Judge harness
const judgeHarness = createJudgeHarness({
  run: async (input) => {
    const { resolveBackend, createEvalLLMClient } = await import(
      "./llm-backend"
    );
    const llm = createEvalLLMClient(resolveBackend());
    const result = await llm.prompt(
      input.system ??
        "You are an expert judge evaluating the accuracy of answers about past coding sessions.",
      input.prompt,
      { maxTokens: 1024, temperature: 0 },
    );
    return { output: result.text };
  },
});

const factuality = FactualityJudge({ judgeHarness });

// ---------------------------------------------------------------------------
// Setup: replay 2.3M token session + warmup
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await replayAndWarmup(scenario, "claude-sonnet-4-6");
}, 3_600_000); // 60 min timeout for 2.3M replay

afterAll(async () => {
  await teardownGateway();
});

// ---------------------------------------------------------------------------
// Tests: 20 questions across easy/medium/hard
// ---------------------------------------------------------------------------

describeEval(
  "Mega CLI Refactor (2.3M tokens, Lore)",
  {
    harness: loreEvalHarness,
    judges: [factuality],
    judgeThreshold: 0.6,
  },
  (it) => {
    for (const q of scenario.questions) {
      it(q.id, async ({ run }) => {
        await run(q.question, {
          metadata: {
            expected: q.referenceAnswer,
            difficulty: q.metadata.difficulty,
          },
        });
      });
    }
  },
);
