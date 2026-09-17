import { describe, expect, test } from "vitest";
import {
  DEFAULT_SEMANTIC_LINT_REPLAY_CONFIG,
  SEMANTIC_LINT_REPLAY_FIXTURES,
  confusionMetrics,
  contextFalsePositiveReductionForReplay,
  costFor,
  renderSemanticLintReplayMarkdown,
  runSemanticLintReplay,
  validateTraceAccounting,
} from "./runner";
import type {
  RecordedJudgeTrace,
  ReplayObservation,
  TruthLabel,
} from "./types";

describe("semantic-lint labeled replay evaluation", () => {
  test("locks fixed revisions, labels, and controlled mutants", () => {
    expect(SEMANTIC_LINT_REPLAY_FIXTURES.length).toBeGreaterThanOrEqual(8);
    expect(
      SEMANTIC_LINT_REPLAY_FIXTURES.filter((item) => item.split === "labeled")
        .length,
    ).toBeGreaterThanOrEqual(3);
    expect(
      SEMANTIC_LINT_REPLAY_FIXTURES.filter((item) => item.split === "held-out")
        .length,
    ).toBeGreaterThanOrEqual(2);
    expect(
      SEMANTIC_LINT_REPLAY_FIXTURES.filter((item) => item.mutation).length,
    ).toBeGreaterThanOrEqual(2);

    for (const item of SEMANTIC_LINT_REPLAY_FIXTURES) {
      expect(item.revision.source).not.toHaveLength(0);
      expect(item.revision.base).not.toHaveLength(0);
      expect(item.revision.head).not.toHaveLength(0);
      expect(item.invariant.id).not.toHaveLength(0);
      expect(item.hunks.length).toBeGreaterThan(0);
      expect(item.integrity.inputSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(item.integrity.traceSha256).toMatch(/^[0-9a-f]{64}$/);
    }

    const labeledInvariantIds = new Set(
      SEMANTIC_LINT_REPLAY_FIXTURES.filter(
        (item) => item.split === "labeled",
      ).map((item) => item.invariant.id),
    );
    expect(
      SEMANTIC_LINT_REPLAY_FIXTURES.filter(
        (item) =>
          item.split === "held-out" &&
          labeledInvariantIds.has(item.invariant.id),
      ),
    ).toHaveLength(0);

    const tampered = SEMANTIC_LINT_REPLAY_FIXTURES.map((item, index) =>
      index === 0
        ? {
            ...item,
            hunks: item.hunks.map((hunk, hunkIndex) =>
              hunkIndex === 0
                ? { ...hunk, text: `${hunk.text}\n+tampered` }
                : hunk,
            ),
          }
        : item,
    );
    expect(() => runSemanticLintReplay({ repetitions: 1 }, tampered)).toThrow(
      "integrity mismatch",
    );
  });

  test("compares all three strategies with repeated-run metrics", () => {
    const report = runSemanticLintReplay({ repetitions: 2 });
    expect(report.corpus).toMatchObject({
      repetitions: 2,
      observations: SEMANTIC_LINT_REPLAY_FIXTURES.length * 3 * 2,
    });
    expect(report.metrics).toHaveLength(9);
    expect(report.metrics.filter((item) => item.split === "all")).toHaveLength(
      3,
    );

    for (const metric of report.metrics.filter(
      (item) => item.split === "all",
    )) {
      expect(metric.total).toBe(SEMANTIC_LINT_REPLAY_FIXTURES.length * 2);
      expect(metric.p95).toBeGreaterThanOrEqual(metric.p50);
      expect(metric.totalSemanticCalls).toBeGreaterThanOrEqual(0);
      expect(metric.totalTransportAttempts).toBeGreaterThanOrEqual(
        metric.totalSemanticCalls,
      );
      expect(metric.totalInputTokens).toBeGreaterThanOrEqual(0);
      expect(metric.totalOutputTokens).toBeGreaterThanOrEqual(0);
      expect(metric.totalEstimatedCostUsd).toBeGreaterThanOrEqual(0);
    }
  });

  test("counts abstained true violations in recall, not decided recall", () => {
    const observation = (
      label: TruthLabel,
      outcome: ReplayObservation["outcome"],
    ): ReplayObservation => ({
      caseId: `${label}-${outcome}`,
      name: "metric fixture",
      split: "labeled",
      label,
      repetition: 1,
      strategy: "isolated-baseline",
      outcome,
      reason: "metric fixture",
      status: outcome === "abstained" ? "unresolved" : "resolved",
      contextComplete: false,
      availableHunks: 1,
      includedHunks: 0,
      omittedHunks: 1,
      semanticCalls: 0,
      transportAttempts: 0,
      verifierCalls: 0,
      inputTokens: 0,
      plannedInputTokens: 0,
      inputTokenBudget: 1,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      estimatedCostUsd: 0,
      latencyMs: 0,
    });
    const metrics = confusionMetrics([
      observation("true-violation", "finding"),
      observation("true-violation", "clear"),
      observation("true-violation", "abstained"),
      observation("context-fp", "finding"),
    ]);

    expect(metrics).toMatchObject({
      truePositives: 1,
      falseNegatives: 1,
      abstainedTrueViolations: 1,
      decidedRecall: 0.5,
      recall: 1 / 3,
    });
  });

  test("prices disjoint uncached, cache-read, and cache-write tokens", () => {
    expect(
      costFor(
        {
          inputTokens: 1_000,
          outputTokens: 100,
          cacheReadTokens: 500,
          cacheWriteTokens: 200,
        },
        DEFAULT_SEMANTIC_LINT_REPLAY_CONFIG,
      ),
    ).toBeCloseTo(
      (1_000 * 0.25 + 100 * 1.25 + 500 * 0.025 + 200 * 0.3125) / 1_000_000,
    );
  });

  test("keeps isolated and holistic token budgets independently configurable", () => {
    const report = runSemanticLintReplay({
      repetitions: 1,
      budgets: {
        holisticInputTokenBudget: 1,
        counterevidenceInputTokenBudget: 10_000,
      },
    });
    expect(
      report.observations.find(
        (item) =>
          item.caseId === "labeled-safe-embedding-extraction" &&
          item.strategy === "isolated-baseline",
      )?.inputTokenBudget,
    ).toBe(10_000);
    expect(
      report.observations.find(
        (item) =>
          item.caseId === "labeled-safe-embedding-extraction" &&
          item.strategy === "holistic-fit",
      )?.inputTokenBudget,
    ).toBe(1);
  });

  test("pairs context false-positive reductions by case and repetition", () => {
    const observation = (
      caseId: string,
      strategy: ReplayObservation["strategy"],
      outcome: ReplayObservation["outcome"],
    ): ReplayObservation => ({
      caseId,
      name: "pairing fixture",
      split: "labeled",
      label: "context-fp",
      repetition: 1,
      strategy,
      outcome,
      reason: "pairing fixture",
      status: outcome === "abstained" ? "unresolved" : "resolved",
      contextComplete: false,
      availableHunks: 1,
      includedHunks: 0,
      omittedHunks: 1,
      semanticCalls: 0,
      transportAttempts: 0,
      verifierCalls: 0,
      inputTokens: 0,
      plannedInputTokens: 0,
      inputTokenBudget: 1,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      estimatedCostUsd: 0,
      latencyMs: 0,
    });

    expect(
      contextFalsePositiveReductionForReplay([
        observation("case-a", "isolated-baseline", "finding"),
        observation("case-b", "adaptive-connected", "clear"),
      ]),
    ).toBe(0);
    expect(
      contextFalsePositiveReductionForReplay([
        observation("case-c", "isolated-baseline", "finding"),
        observation("case-c", "adaptive-connected", "clear"),
      ]),
    ).toBe(1);
  });

  test("rejects impossible call and token accounting", () => {
    const trace: RecordedJudgeTrace = {
      response: '{"reason":"ok","verdict":"satisfies"}',
      verdict: "satisfies",
      reason: "ok",
      semanticCalls: 2,
      transportAttempts: 1,
      inputTokens: 1_000,
      outputTokens: 100,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      latencyMs: 10,
    };
    expect(() => validateTraceAccounting(trace, "test")).toThrow(
      "transportAttempts cannot be below semanticCalls",
    );
    expect(() =>
      validateTraceAccounting(
        { ...trace, transportAttempts: 2, inputTokens: 1.5 },
        "test",
      ),
    ).toThrow("inputTokens must be a non-negative integer");
  });

  test("reduces context false positives without hiding guard-removal mutants", () => {
    const report = runSemanticLintReplay({ repetitions: 3 });
    expect(report.guardrails.status).toBe("pass");
    expect(report.guardrails.contextFalsePositiveReduction).toBeGreaterThan(0);
    expect(report.guardrails.controlledMutantRecall).toBe(1);

    const adaptive = report.metrics.find(
      (item) => item.strategy === "adaptive-connected" && item.split === "all",
    );
    expect(adaptive?.controlledMutantTruePositives).toBe(
      adaptive?.controlledMutantSamples,
    );
  });

  test("records holistic budget abstention separately from a false negative", () => {
    const report = runSemanticLintReplay({ repetitions: 1 });
    const large = report.observations.find(
      (item) =>
        item.caseId === "heldout-large-clean-refactor" &&
        item.strategy === "holistic-fit",
    );
    expect(large).toMatchObject({
      outcome: "abstained",
      status: "not-attempted",
      abstentionReason: "holistic-budget-exhausted",
      semanticCalls: 0,
    });
    expect(large?.plannedInputTokens).toBeGreaterThan(
      large?.inputTokenBudget ?? 0,
    );
  });

  test("marks isolated context incomplete when companion hunks are omitted", () => {
    const report = runSemanticLintReplay({ repetitions: 1 });
    const isolated = report.observations.find(
      (item) =>
        item.caseId === "labeled-pr-1766-relocated-temporal-gate" &&
        item.strategy === "isolated-baseline",
    );
    expect(isolated).toMatchObject({
      contextComplete: false,
      includedHunks: 1,
      omittedHunks: 2,
    });
  });

  test("renders an auditable Markdown summary", () => {
    const markdown = renderSemanticLintReplayMarkdown(
      runSemanticLintReplay({ repetitions: 1 }),
    );
    expect(markdown).toContain("Semantic-lint replay evaluation");
    expect(markdown).toContain("isolated-baseline");
    expect(markdown).toContain("Precision");
    expect(markdown).toContain("controlled-mutant recall");
  });
});
