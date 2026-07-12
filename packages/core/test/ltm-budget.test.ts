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
 *   usable = contextLimit - min(output, 32_000) - 15_000
 */
describe("getLtmBudget context-aware ceiling + sub-agent sizing", () => {
  // Restore a large, generous default so a leaked small limit from one test
  // can't silently change another. Each test still sets its own limits.
  beforeEach(() => {
    setModelLimits({ context: 200_000, output: 32_000 });
  });

  test("large context, main session: historical floor preserved", () => {
    setModelLimits({ context: 200_000, output: 32_000 }); // usable = 153_000
    // raw = 7_650 → quantized 8_000, ceiling 30_600 → 8_000 (unchanged).
    expect(getLtmBudget(0.05)).toBe(8_000);
  });

  test("small context, main session: scaled BELOW the 8K floor", () => {
    setModelLimits({ context: 30_000, output: 4_000 }); // usable = 11_000
    // Historically this forced 8_000 (73% of usable). The ceiling clips it to
    // 20% of usable = 2_200.
    const budget = getLtmBudget(0.05);
    expect(budget).toBe(2_200);
    expect(budget).toBeLessThan(8_000);
  });

  test("sub-agent gets a smaller budget than a main session (large context)", () => {
    setModelLimits({ context: 200_000, output: 32_000 }); // usable = 153_000
    const main = getLtmBudget(0.05);
    const sub = getLtmBudget(0.05, undefined, { isSubagent: true });
    // Sub-agent skips the 8K floor and takes the exact fraction (7_650).
    expect(sub).toBe(7_650);
    expect(sub).toBeLessThan(main);
  });

  test("sub-agent budget is much smaller on a small context", () => {
    setModelLimits({ context: 30_000, output: 4_000 }); // usable = 11_000
    const main = getLtmBudget(0.05); // 2_200
    const sub = getLtmBudget(0.05, undefined, { isSubagent: true }); // 550
    expect(sub).toBe(550);
    expect(sub).toBeLessThan(main);
  });

  test("ceilings bind for an oversized fraction (main 20%, sub-agent 10%)", () => {
    setModelLimits({ context: 200_000, output: 32_000 }); // usable = 153_000
    expect(getLtmBudget(0.5)).toBe(30_600); // 20% of usable
    expect(getLtmBudget(0.5, undefined, { isSubagent: true })).toBe(15_300); // 10%
  });

  test("returns 0 when there is no usable context (both modes)", () => {
    setModelLimits({ context: 15_000, output: 2_000 }); // usable = 0
    expect(getLtmBudget(0.05)).toBe(0);
    expect(getLtmBudget(0.05, undefined, { isSubagent: true })).toBe(0);
  });

  test("preference budget shares the same function and shrinks for sub-agents", () => {
    setModelLimits({ context: 200_000, output: 32_000 }); // usable = 153_000
    expect(getPreferenceLtmBudget).toBe(getLtmBudget);
    const mainPref = getPreferenceLtmBudget(0.02); // floored to 8_000
    const subPref = getPreferenceLtmBudget(0.02, undefined, {
      isSubagent: true,
    }); // exact fraction 3_060
    expect(mainPref).toBe(8_000);
    expect(subPref).toBe(3_060);
    expect(subPref).toBeLessThan(mainPref);
  });
});
