import { beforeEach, describe, expect, test } from "vitest";
import {
  getLtmBudget,
  getPreferenceLtmBudget,
  setModelLimits,
} from "../src/gradient";

/**
 * getLtmBudget: context-aware ceiling + sub-agent-aware sizing (#1300 context).
 *
 * These tests never call calibrate(), so getOverhead() falls back to the
 * uncalibrated FIRST_TURN_OVERHEAD (15_000). With sessionID omitted, the budget
 * is a pure function of the model limits set here:
 *   usable     = contextLimit - min(output, 32_000) - 15_000
 *   gridUsable = floor(usable / 8_000) * 8_000   (LTM_BUDGET_STEP grid)
 * The budget is derived from gridUsable (not raw usable) so it is stable under
 * per-turn overhead wobble.
 */
describe("getLtmBudget context-aware ceiling + sub-agent sizing", () => {
  // Restore a large, generous default so a leaked small limit from one test
  // can't silently change another. Each test still sets its own limits.
  beforeEach(() => {
    setModelLimits({ context: 200_000, output: 32_000 });
  });

  test("large context, main session: historical value preserved", () => {
    setModelLimits({ context: 200_000, output: 32_000 }); // usable 153_000, grid 152_000
    // raw 7_600 → quantized 8_000; ceiling 30_400 caps only the floor → 8_000.
    expect(getLtmBudget(0.05)).toBe(8_000);
  });

  test("small context, main session: scaled BELOW the 8K floor", () => {
    setModelLimits({ context: 30_000, output: 4_000 }); // usable 11_000, grid 8_000
    // Historically forced 8_000 (73% of usable). The ceiling caps the floor to
    // 20% of gridUsable = 1_600.
    const budget = getLtmBudget(0.05);
    expect(budget).toBe(1_600);
    expect(budget).toBeLessThan(8_000);
  });

  test("small-context main budget is STABLE across usable wobble (no churn)", () => {
    // Regression guard for the ceiling-bound path being unquantized. Three
    // context sizes whose usable (10_000 / 13_000 / 15_000) all floor-bucket to
    // gridUsable 8_000 must yield the SAME budget. Pre-fix (ceiling = raw
    // usable * 0.2) these produced 2_000 / 2_600 / 3_000 — a moving packing
    // boundary that churns the pinned LTM set every turn.
    const budgets = new Set<number>();
    for (const context of [27_000, 30_000, 32_000]) {
      setModelLimits({ context, output: 2_000 });
      budgets.add(getLtmBudget(0.05));
    }
    expect(budgets.size).toBe(1);
    expect([...budgets][0]).toBe(1_600);
  });

  test("sub-one-step window still gets a non-zero (never-disabled) budget", () => {
    setModelLimits({ context: 24_000, output: 2_000 }); // usable 7_000 (< 8K step)
    // Flooring would snap gridUsable to 0 and disable LTM; instead we fall back
    // to real usable so a tiny window keeps LTM. Main = 20% of 7_000 = 1_400;
    // sub-agent takes the exact 5% fraction = 350.
    expect(getLtmBudget(0.05)).toBe(1_400);
    expect(getLtmBudget(0.05, undefined, { isSubagent: true })).toBe(350);
  });

  test("sub-agent gets a smaller budget than a main session (large context)", () => {
    setModelLimits({ context: 200_000, output: 32_000 }); // usable 153_000, grid 152_000
    const main = getLtmBudget(0.05);
    const sub = getLtmBudget(0.05, undefined, { isSubagent: true });
    // Sub-agent skips the 8K floor and takes the exact fraction (7_600).
    expect(sub).toBe(7_600);
    expect(sub).toBeLessThan(main);
  });

  test("sub-agent budget is much smaller on a small context", () => {
    setModelLimits({ context: 30_000, output: 4_000 }); // usable 11_000, grid 8_000
    const main = getLtmBudget(0.05); // 1_600
    const sub = getLtmBudget(0.05, undefined, { isSubagent: true }); // 400
    expect(sub).toBe(400);
    expect(sub).toBeLessThan(main);
  });

  test("main honors a large configured fraction — ceiling caps only the floor", () => {
    setModelLimits({ context: 200_000, output: 32_000 }); // usable 153_000, grid 152_000
    // budget.ltm can be configured up to 0.3. On a large window the fraction is
    // NOT clipped by MAX_LTM_BUDGET_FRACTION (0.2): raw 45_600 → quantized
    // 48_000, and the ceiling only bounds the never-disable floor. (Pre-fix this
    // was wrongly clipped to 30_600.)
    expect(getLtmBudget(0.3)).toBe(48_000);
  });

  test("sub-agent still caps at its tighter ceiling for an oversized fraction", () => {
    setModelLimits({ context: 200_000, output: 32_000 }); // usable 153_000, grid 152_000
    const main = getLtmBudget(0.5); // 80_000 (quantized fraction, uncapped)
    const sub = getLtmBudget(0.5, undefined, { isSubagent: true }); // 15_200 (10% cap)
    expect(main).toBe(80_000);
    expect(sub).toBe(15_200);
    expect(sub).toBeLessThan(main);
  });

  test("returns 0 when there is no usable context (both modes)", () => {
    setModelLimits({ context: 15_000, output: 2_000 }); // usable = 0
    expect(getLtmBudget(0.05)).toBe(0);
    expect(getLtmBudget(0.05, undefined, { isSubagent: true })).toBe(0);
  });

  test("preference budget shares the same function and shrinks for sub-agents", () => {
    setModelLimits({ context: 200_000, output: 32_000 }); // usable 153_000, grid 152_000
    expect(getPreferenceLtmBudget).toBe(getLtmBudget);
    const mainPref = getPreferenceLtmBudget(0.02); // floored to 8_000
    const subPref = getPreferenceLtmBudget(0.02, undefined, {
      isSubagent: true,
    }); // exact fraction 3_040
    expect(mainPref).toBe(8_000);
    expect(subPref).toBe(3_040);
    expect(subPref).toBeLessThan(mainPref);
  });
});
