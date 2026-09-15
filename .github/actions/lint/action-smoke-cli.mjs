import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const reportFlag = args.indexOf("--report-file");
const budgetFlag = args.indexOf("--holistic-input-tokens");
const reportPath = reportFlag >= 0 ? args[reportFlag + 1] : undefined;
const budget = budgetFlag >= 0 ? args[budgetFlag + 1] : undefined;

if (!reportPath)
  throw new Error("action smoke CLI did not receive --report-file");
if (budget !== "16000" || process.env.HOLISTIC_INPUT_TOKENS !== "16000") {
  throw new Error("holistic input budget was not passed through the action");
}
if (process.env.LORE_PR_TITLE !== "semantic lint smoke title") {
  throw new Error("PR title override was not passed through the action");
}
if (process.env.LORE_PR_DESCRIPTION !== "semantic lint smoke description") {
  throw new Error("PR description override was not passed through the action");
}

writeFileSync(
  reportPath,
  JSON.stringify({
    schemaVersion: 3,
    status: "complete",
    model: "test/model",
    effort: "off",
    elapsedMs: 1,
    range: { base: "smoke-base", head: "smoke-head", source: "action-smoke" },
    coverage: {
      strategy: "none",
      contextComplete: false,
      inputTokens: 0,
      inputTokenBudget: 16_000,
      availableHunks: 0,
      includedHunks: 0,
      omittedHunks: 0,
      availableInvariants: 0,
      includedInvariants: 0,
      omittedInvariants: 0,
    },
    health: {
      range: { status: "healthy" },
      diff: { status: "healthy", hunks: 0 },
      invariantSource: { status: "healthy" },
      invariantVectors: {
        status: "healthy",
        expected: 0,
        available: 0,
        missing: 0,
      },
      hunkVectors: {
        status: "healthy",
        expected: 0,
        available: 0,
        missing: 0,
      },
      judge: {
        status: "healthy",
        selected: 0,
        resolved: 0,
        unresolved: 0,
        notAttempted: 0,
      },
    },
    counters: {
      hunks: 0,
      invariants: 0,
      candidates: 0,
      attempted: 0,
      resolved: 0,
      unresolved: 0,
      notAttempted: 0,
      semanticCalls: 0,
      transportAttempts: 0,
    },
    candidates: [],
    findings: [],
    gate: {
      mode: "advisory",
      blockingFindingIds: [],
      overridden: [],
      advisoryFindingIds: [],
      wouldBlockFindingIds: [],
    },
  }),
);
