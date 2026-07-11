/**
 * CM-1 Context Retention eval — vitest-evals.
 *
 * Tests recall of early, mid, and late session details at 400K tokens.
 * Replays the CM-1 scenario through the Lore gateway, then asks questions.
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
import { inflateScenario } from "./inflate";

// Load scenario
const mod = await import("./scenarios/context-management");
const baseScenario = mod.scenarios.find((s) => s.id === "cm-1-early-detail");
if (!baseScenario) throw new Error("cm-1-early-detail scenario not found");

const scenario = inflateScenario(baseScenario, 400_000, 42);

// Judge harness — uses Anthropic for LLM-as-judge
const judgeHarness = createJudgeHarness({
  run: async (input) => {
    const { resolveBackend, createEvalLLMClient } =
      await import("./llm-backend");
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
// Setup: replay + warmup
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await replayAndWarmup(scenario, "claude-sonnet-4-6");
}, 1_800_000); // 30 min timeout for replay

afterAll(async () => {
  await teardownGateway();
});

// ---------------------------------------------------------------------------
// Tests: one per question
// ---------------------------------------------------------------------------

describeEval(
  "CM-1 Context Retention (400K, Lore)",
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
