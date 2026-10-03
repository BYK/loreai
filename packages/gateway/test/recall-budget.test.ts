import { describe, expect, test } from "vitest";
import {
  MAX_RECALL_ADDITIONAL_TOKENS,
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

  test("bounds additional calls by the real principal size and reserves a full final turn", () => {
    const budget = new RecallChainBudget({ modelContextTokens: 1_000_000 });
    expect(
      budget.recordPrincipalUsage(
        {
          inputTokens: 40_000,
          cacheReadInputTokens: 200_000,
          outputTokens: 100,
        },
        { expectedModel: "large", actualModel: "large" },
        true,
      ),
    ).toBeUndefined();
    expect(budget.maxTokens).toBe(960_400);
    expect(budget.snapshot().inputTokens).toBe(0);
    expect(budget.admit(1)).toBeUndefined();
    budget.record({ resultBytes: 10, coverage: coverage(1) });
    expect(budget.mustFinalizeNext()).toBe(false);

    budget.recordUsage({
      inputTokens: 40_000,
      cacheReadInputTokens: 200_000,
      outputTokens: 100,
    });
    expect(budget.mustFinalizeNext()).toBe(false);
    expect(budget.admit(1)).toBeUndefined();
    budget.record({ resultBytes: 10, coverage: coverage(2) });
    budget.recordUsage({
      inputTokens: 40_000,
      cacheReadInputTokens: 200_000,
      outputTokens: 100,
    });
    expect(budget.mustFinalizeNext()).toBe(true);
    budget.recordUsage({
      inputTokens: 40_000,
      cacheReadInputTokens: 200_000,
      outputTokens: 100,
    });
    expect(budget.admit(1)).toBe("tokens");
  });

  test("caps long-context spending and rejects principal usage beyond the model", () => {
    const budget = new RecallChainBudget({ modelContextTokens: 1_000_000 });
    expect(
      budget.recordPrincipalUsage(
        {
          inputTokens: 999_000,
          outputTokens: 1_000,
        },
        { expectedModel: "large", actualModel: "large" },
        true,
      ),
    ).toBeUndefined();
    expect(budget.maxTokens).toBe(MAX_RECALL_ADDITIONAL_TOKENS);
    expect(budget.admit(1)).toBeUndefined();

    const impossible = new RecallChainBudget({ modelContextTokens: 200_000 });
    expect(
      impossible.recordPrincipalUsage(
        { inputTokens: 200_001 },
        { expectedModel: "medium", actualModel: "medium" },
        true,
      ),
    ).toBe("tokens");
    expect(impossible.admit(1)).toBe("tokens");
  });

  test("allows a final call at the expanded ceiling but rejects any excess", () => {
    const budget = new RecallChainBudget({ modelContextTokens: 1_000_000 });
    expect(
      budget.recordPrincipalUsage(
        { inputTokens: 240_000, outputTokens: 0 },
        { expectedModel: "large", actualModel: "large" },
        true,
      ),
    ).toBeUndefined();
    expect(budget.maxTokens).toBe(960_000);
    expect(
      budget.recordContinuationUsage(
        { inputTokens: 960_000, outputTokens: 0 },
        "large",
        true,
      ),
    ).toBe("tokens");
    expect(budget.exceedsTokenCeiling()).toBe(false);
    expect(budget.canRecover()).toBe(true);
    budget.recordContinuationUsage(
      { inputTokens: 1, outputTokens: 0 },
      "large",
      true,
    );
    expect(budget.exceedsTokenCeiling()).toBe(true);
    expect(budget.canRecover()).toBe(false);
  });

  test("never recovers with an unmetered or switched expanded continuation", () => {
    for (const [model, completeUsage] of [
      ["large", false],
      ["small", true],
    ] as const) {
      const budget = new RecallChainBudget({ modelContextTokens: 1_000_000 });
      budget.recordPrincipalUsage(
        { inputTokens: 240_000, outputTokens: 1 },
        { expectedModel: "large", actualModel: "large" },
        true,
      );
      expect(
        budget.recordContinuationUsage(
          { inputTokens: 10, outputTokens: 1 },
          model,
          completeUsage,
        ),
      ).toBe("tokens");
      expect(budget.exceedsTokenCeiling()).toBe(false);
      expect(budget.canRecover()).toBe(false);
    }
  });

  test("rejects a metered continuation larger than the verified route's context", () => {
    const budget = new RecallChainBudget({ modelContextTokens: 272_000 });
    expect(
      budget.recordPrincipalUsage(
        { inputTokens: 240_000, outputTokens: 10 },
        { expectedModel: "gpt-6-sol", actualModel: "gpt-6-sol" },
        true,
      ),
    ).toBeUndefined();
    expect(budget.maxTokens).toBe(960_040);
    expect(
      budget.recordContinuationUsage(
        { inputTokens: 300_000, outputTokens: 10 },
        "gpt-6-sol",
        true,
      ),
    ).toBe("tokens");
    expect(budget.exceedsTokenCeiling()).toBe(false);
    expect(budget.canRecover()).toBe(false);
    expect(budget.snapshot().inputTokens).toBe(300_000);
  });

  test("never expands for an unverified answering model", () => {
    const mismatch = new RecallChainBudget({ modelContextTokens: 1_000_000 });
    expect(
      mismatch.recordPrincipalUsage(
        { inputTokens: 240_000 },
        { expectedModel: "large", actualModel: "small" },
        true,
      ),
    ).toBe("tokens");
    expect(mismatch.admit(1)).toBe("tokens");

    const unverified = new RecallChainBudget({ modelContextTokens: 1_000_000 });
    expect(
      unverified.recordPrincipalUsage(
        { inputTokens: 100_000 },
        { actualModel: "large" },
        true,
      ),
    ).toBeUndefined();
    expect(unverified.maxTokens).toBe(128_000);
  });

  test("charges a smaller mismatched principal against the conservative budget", () => {
    const budget = new RecallChainBudget({ modelContextTokens: 1_000_000 });
    expect(
      budget.recordPrincipalUsage(
        { inputTokens: 120_000 },
        { expectedModel: "large", actualModel: "small" },
        true,
      ),
    ).toBeUndefined();
    expect(budget.admit(1)).toBeUndefined();
    budget.record({ resultBytes: 1, coverage: coverage(1) });
    budget.recordUsage({ inputTokens: 10_000 });
    expect(budget.admit(1)).toBe("tokens");
  });

  test("does not admit another recall after an expanded continuation omits usage", () => {
    const budget = new RecallChainBudget({ modelContextTokens: 1_000_000 });
    expect(
      budget.recordPrincipalUsage(
        { inputTokens: 240_000 },
        { expectedModel: "large", actualModel: "large" },
        true,
      ),
    ).toBeUndefined();
    expect(budget.admit(1)).toBeUndefined();
    budget.record({ resultBytes: 1, coverage: coverage(1) });
    expect(budget.recordUsage(undefined)).toBe("tokens");
    expect(budget.admit(1)).toBe("tokens");
  });

  test("does not expand a verified model's budget from incomplete principal usage", () => {
    const budget = new RecallChainBudget({ modelContextTokens: 1_000_000 });
    expect(
      budget.recordPrincipalUsage(
        { inputTokens: 240_000 },
        { expectedModel: "large", actualModel: "large" },
        false,
      ),
    ).toBe("tokens");
    expect(budget.maxTokens).toBe(128_000);
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
