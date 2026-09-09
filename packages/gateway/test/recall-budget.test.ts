import { describe, expect, test } from "vitest";
import {
  MAX_RECALL_EXECUTIONS,
  MAX_RECALL_SEARCH_ITEMS,
  RecallChainBudget,
} from "../src/recall-budget";

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

  test("reserves and then records the actual search result count", () => {
    const budget = new RecallChainBudget({ maxItems: 64 });
    expect(budget.admit(MAX_RECALL_SEARCH_ITEMS)).toBeUndefined();
    expect(
      budget.record({ resultBytes: 100, coverage: coverage(1) }),
    ).toBeUndefined();
    expect(budget.snapshot()).toMatchObject({ items: 1, reservedItems: 0 });

    // The second broad search can be admitted only because the first one
    // delivered one source, not its maximum reservation of thirty.
    expect(budget.admit(MAX_RECALL_SEARCH_ITEMS)).toBeUndefined();
    expect(
      budget.record({ resultBytes: 100, coverage: coverage(2) }),
    ).toBeUndefined();
    expect(budget.admit(MAX_RECALL_SEARCH_ITEMS)).toBeUndefined();
    expect(budget.snapshot()).toMatchObject({ items: 2, reservedItems: 30 });
  });

  test("counts a preview and a detail of one revision as one delivered item", () => {
    const budget = new RecallChainBudget();
    const source = {
      identity: "k:logical-source",
      revision: "revision-1",
      offset: 0,
      complete: false,
    };
    expect(budget.admit(1)).toBeUndefined();
    expect(
      budget.record({
        resultBytes: 100,
        coverage: [{ ...source, length: 1, kind: "preview" }],
      }),
    ).toBeUndefined();
    expect(budget.admit(1)).toBeUndefined();
    expect(
      budget.record({
        resultBytes: 100,
        coverage: [{ ...source, length: 100, complete: true, kind: "detail" }],
      }),
    ).toBeUndefined();
    expect(budget.snapshot()).toMatchObject({
      items: 1,
      consecutiveNoProgress: 0,
    });
  });

  test("treats a completed empty detail as delivered coverage", () => {
    const budget = new RecallChainBudget({ maxConsecutiveNoProgress: 0 });
    for (let index = 0; index < 3; index++) {
      expect(budget.admit(1)).toBeUndefined();
      expect(
        budget.record({
          resultBytes: 100,
          coverage: [
            {
              identity: `e:empty-${index}`,
              revision: `revision-${index}`,
              offset: 0,
              length: 0,
              complete: true,
              kind: "detail",
            },
          ],
        }),
      ).toBeUndefined();
    }
    expect(budget.snapshot()).toMatchObject({
      items: 3,
      consecutiveNoProgress: 0,
    });
  });

  test("stops broad searches once their delivered sources exhaust the item budget", () => {
    const budget = new RecallChainBudget({ maxItems: 64 });
    const broadCoverage = (offset: number) =>
      Array.from({ length: MAX_RECALL_SEARCH_ITEMS }, (_, index) => ({
        identity: `t:broad-${offset + index}`,
        revision: `revision-${offset + index}`,
        offset: 0,
        length: 100,
        complete: true,
      }));

    expect(budget.admit(MAX_RECALL_SEARCH_ITEMS)).toBeUndefined();
    expect(
      budget.record({ resultBytes: 100, coverage: broadCoverage(0) }),
    ).toBeUndefined();
    expect(budget.admit(MAX_RECALL_SEARCH_ITEMS)).toBeUndefined();
    expect(
      budget.record({ resultBytes: 100, coverage: broadCoverage(30) }),
    ).toBeUndefined();
    expect(budget.snapshot().items).toBe(60);
    expect(budget.admit(MAX_RECALL_SEARCH_ITEMS)).toBe("items");
  });

  test("marks the final continuation before the token boundary", () => {
    const budget = new RecallChainBudget({ maxTokens: 20 });
    budget.recordUsage({ inputTokens: 10 });
    expect(budget.mustFinalizeNext()).toBe(true);
  });

  test("reserves foreground time for final synthesis before dispatch", () => {
    const budget = new RecallChainBudget({
      deadlineAt: 19_999,
      now: () => 0,
    });
    expect(budget.admit(1)).toBe("time");
  });
});
