import { describe, expect, test } from "vitest";
import { MAX_RECALL_EXECUTIONS, RecallChainBudget } from "../src/recall-budget";

const coverage = (index: number) => [
  {
    identity: `t:source-${index}`,
    revision: `revision-${index}`,
    offset: 0,
    length: 100,
    complete: true,
  },
];

describe("RecallChainBudget", () => {
  test("admits a productive twelve-step chain before its emergency ceiling", () => {
    const budget = new RecallChainBudget();
    for (let index = 0; index < 12; index++) {
      expect(budget.admit(1)).toBeUndefined();
      expect(
        budget.record({ resultBytes: 100, coverage: coverage(index) }),
      ).toBeUndefined();
    }
    expect(MAX_RECALL_EXECUTIONS).toBeGreaterThanOrEqual(12);
    expect(budget.snapshot().executions).toBe(12);
  });

  test("allows a small duplicate allowance, then stops a stalled chain", () => {
    const budget = new RecallChainBudget({ maxConsecutiveNoProgress: 2 });
    expect(budget.admit(1)).toBeUndefined();
    expect(
      budget.record({ resultBytes: 10, coverage: coverage(1) }),
    ).toBeUndefined();

    for (let index = 0; index < 2; index++) {
      expect(budget.admit(1)).toBeUndefined();
      expect(
        budget.record({ resultBytes: 10 + index, coverage: coverage(1) }),
      ).toBeUndefined();
    }
    expect(budget.admit(1)).toBeUndefined();
    expect(budget.record({ resultBytes: 10, coverage: coverage(1) })).toBe(
      "stalled",
    );
    expect(budget.admit(1)).toBe("stalled");
  });

  test("does not let new sources replenish a hard token budget", () => {
    const budget = new RecallChainBudget({ maxTokens: 20 });
    budget.recordUsage({ inputTokens: 15, outputTokens: 6 });
    expect(budget.admit(1)).toBe("tokens");
  });

  test("enforces item admission and rendered-byte limits", () => {
    const itemBudget = new RecallChainBudget({ maxItems: 2 });
    expect(itemBudget.admit(3)).toBe("items");

    const byteBudget = new RecallChainBudget({ maxResultBytes: 5 });
    expect(byteBudget.admit(2)).toBeUndefined();
    expect(byteBudget.record({ resultBytes: 6, coverage: coverage(1) })).toBe(
      "result_bytes",
    );
    expect(byteBudget.admit(1)).toBe("result_bytes");
  });

  test("reserves foreground time for final synthesis before dispatch", () => {
    const budget = new RecallChainBudget({
      deadlineAt: 19_999,
      now: () => 0,
    });
    expect(budget.admit(1)).toBe("time");
  });
});
