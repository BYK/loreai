import { describe, expect, test } from "vitest";
import {
  SEMANTIC_LINT_REPLAY_FIXTURES,
  renderSemanticLintReplayMarkdown,
  runSemanticLintReplay,
} from "./runner";

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
