import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  analyzeRotAB,
  DEFAULT_DEGRADED_COMPOSITE_MAX,
  formatReport,
  loadResults,
  resultsToSteps,
} from "./rot-ab";
import type { BaselineMode, EvalResult } from "./types";

function result(
  mode: BaselineMode,
  cumulativeTokens: number | undefined,
  compositeScore: number,
  scenario = "cm-x",
): EvalResult {
  return {
    timestamp: "2026-01-01T00:00:00Z",
    dimension: "context",
    scenario,
    questionId: `${mode}-${cumulativeTokens}`,
    mode,
    question: "q",
    referenceAnswer: "a",
    hypothesis: "h",
    scores: {},
    compositeScore,
    judgeReasoning: "",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalCost: 0 },
    metadata: cumulativeTokens === undefined ? {} : { cumulativeTokens },
  };
}

/** 30 points 2000..60000 tokens; `degradeDeep` degrades every point ≥40000. */
function arm(mode: BaselineMode, degradeDeep: boolean): EvalResult[] {
  const rows: EvalResult[] = [];
  for (let i = 0; i < 30; i++) {
    const tokens = 2000 + i * 2000;
    const composite = degradeDeep && tokens >= 40000 ? 1 : 5;
    rows.push(result(mode, tokens, composite));
  }
  return rows;
}

describe("resultsToSteps", () => {
  test("maps cumulative tokens and thresholds the composite", () => {
    const steps = resultsToSteps(
      [
        result("lore", 1000, 5),
        result("lore", 2000, 2), // below default 3.0 → degraded
      ],
      DEFAULT_DEGRADED_COMPOSITE_MAX,
    );
    expect(steps).toHaveLength(2);
    expect(steps[0].promptTokens).toBe(1000);
    expect(steps[0].degraded).toBe(false);
    expect(steps[1].degraded).toBe(true);
  });

  test("skips rows without a usable cumulative-token position", () => {
    const steps = resultsToSteps(
      [result("lore", undefined, 1), result("lore", 5000, 1)],
      DEFAULT_DEGRADED_COMPOSITE_MAX,
    );
    expect(steps).toHaveLength(1);
    expect(steps[0].promptTokens).toBe(5000);
  });
});

describe("analyzeRotAB", () => {
  test("contrasts Lore against a degrading baseline on the token axis", () => {
    const reports = analyzeRotAB([
      ...arm("lore", false), // stays clean deep in context
      ...arm("tail-window", true), // degrades deep in context
    ]);
    expect(reports).toHaveLength(1);
    const rep = reports[0];
    expect(rep.axis).toBe("tokens");
    // Deep zone was populated despite topping out at 60K (adaptive terciles).
    expect(rep.deepMin).toBeLessThanOrEqual(60000);

    const lore = rep.arms.find((a) => a.mode === "lore");
    const tail = rep.arms.find((a) => a.mode === "tail-window");
    expect(lore?.curve.deepRate).toBe(0);
    expect(tail?.curve.deepRate).toBe(1);

    expect(rep.contrasts).toHaveLength(1);
    expect(rep.contrasts[0].arm).toBe("tail-window");
    // 0% vs 100% deep, non-overlapping Wilson intervals → significant.
    expect(rep.contrasts[0].loreDeepAdvantageSignificant).toBe(true);
  });

  test("no significant advantage when both arms degrade the same", () => {
    const reports = analyzeRotAB([
      ...arm("lore", true),
      ...arm("tail-window", true),
    ]);
    expect(reports).toHaveLength(1);
    expect(reports[0].contrasts[0].loreDeepAdvantageSignificant).toBe(false);
  });

  test("omits scenarios lacking a Lore arm or any comparator", () => {
    // Only a comparator, no lore arm.
    expect(analyzeRotAB(arm("tail-window", true))).toHaveLength(0);
    // Only lore, no comparator.
    expect(analyzeRotAB(arm("lore", false))).toHaveLength(0);
    // lore-only variants don't count as comparators.
    expect(
      analyzeRotAB([...arm("lore", false), ...arm("lore-memory-only", true)]),
    ).toHaveLength(0);
  });

  test("flags unbalanced arms as diagnostic-only", () => {
    // 30 lore vs 30 tail-window → balanced.
    const balanced = analyzeRotAB([
      ...arm("lore", false),
      ...arm("tail-window", true),
    ]);
    expect(balanced[0].armsBalanced).toBe(true);

    // Halve the comparator arm → imbalance ratio 15/30 = 0.5 < 0.8.
    const loreRows = arm("lore", false);
    const tailRows = arm("tail-window", true).slice(0, 15);
    const unbalanced = analyzeRotAB([...loreRows, ...tailRows]);
    expect(unbalanced[0].armsBalanced).toBe(false);
    expect(formatReport(unbalanced)).toContain("unbalanced arms");
  });

  test("balance ignores non-contrasted Lore variants", () => {
    // lore (30) and tail-window (30) are matched; a small lore-memory-only (15)
    // is shown but not contrasted, so it must not flip the balance verdict.
    const reports = analyzeRotAB([
      ...arm("lore", false),
      ...arm("lore-memory-only", true).slice(0, 15),
      ...arm("tail-window", true),
    ]);
    expect(reports).toHaveLength(1);
    expect(reports[0].contrasts.map((c) => c.arm)).toEqual(["tail-window"]);
    expect(reports[0].armsBalanced).toBe(true);
  });

  test("respects a custom degraded threshold", () => {
    const rows = [
      ...arm("lore", false).map((r) => ({ ...r, compositeScore: 3.5 })),
      ...arm("tail-window", false).map((r) => ({ ...r, compositeScore: 3.5 })),
    ];
    // Threshold 4.0 makes every 3.5 answer degraded in both arms.
    const reports = analyzeRotAB(rows, { degradedThreshold: 4.0 });
    expect(reports[0].arms.every((a) => a.curve.overallRate === 1)).toBe(true);
  });
});

describe("loadResults", () => {
  test("reads jsonl and skips malformed lines", () => {
    const dir = mkdtempSync(join(tmpdir(), "rotab-"));
    try {
      writeFileSync(
        join(dir, "a.jsonl"),
        `${JSON.stringify(result("lore", 1000, 5))}\nnot json\n${JSON.stringify(result("tail-window", 2000, 1))}\n`,
      );
      writeFileSync(join(dir, "ignore.txt"), "nope");
      const rows = loadResults(dir);
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.mode)).toEqual(["lore", "tail-window"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("formatReport", () => {
  test("renders a message when there is nothing to compare", () => {
    expect(formatReport([])).toContain("No paired scenarios");
  });

  test("renders arms and the contrast verdict", () => {
    const reports = analyzeRotAB([
      ...arm("lore", false),
      ...arm("tail-window", true),
    ]);
    const text = formatReport(reports);
    expect(text).toContain("cm-x");
    expect(text).toContain("lore");
    expect(text).toContain("tail-window");
    expect(text).toContain("Lore significantly flatter");
  });
});
