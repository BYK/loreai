import fc from "fast-check";
import { describe, expect, test } from "vitest";
import {
  MAX_RETAINED_RECALL_COVERAGE,
  MAX_RETAINED_RECALL_COVERAGE_KEY_CHARS,
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
  test("never limits a productive chain by execution count or result size", () => {
    const budget = new RecallChainBudget({
      deadlineAt: 1_000_000,
      now: () => 0,
    });
    for (let index = 0; index < 1_000; index++) {
      expect(budget.admit()).toBeUndefined();
      expect(budget.record(coverage(index))).toBeUndefined();
    }
    expect(budget.snapshot()).toEqual({ consecutiveNoProgress: 0 });
  });

  test("allows a small duplicate allowance, then stops a stalled chain", () => {
    const budget = new RecallChainBudget({
      deadlineAt: 1_000_000,
      maxConsecutiveNoProgress: 2,
      now: () => 0,
    });
    expect(budget.record(coverage(1))).toBeUndefined();
    expect(budget.record(coverage(1))).toBeUndefined();
    expect(budget.record(coverage(1))).toBeUndefined();
    expect(budget.record(coverage(1))).toBe("stalled");
    expect(budget.admit()).toBe("stalled");
  });

  test("treats distinct ranges and revisions as new progress", () => {
    const budget = new RecallChainBudget({
      deadlineAt: 1_000_000,
      maxConsecutiveNoProgress: 0,
      now: () => 0,
    });
    const source = {
      identity: "k:logical-source",
      revision: "revision-1",
      offset: 0,
      length: 10,
      complete: false,
    };
    expect(
      budget.record([{ ...source, kind: "preview" as const }]),
    ).toBeUndefined();
    expect(
      budget.record([{ ...source, offset: 10, kind: "detail" as const }]),
    ).toBeUndefined();
    expect(
      budget.record([
        { ...source, revision: "revision-2", kind: "detail" as const },
      ]),
    ).toBeUndefined();
  });

  test("treats a completed empty detail as progress", () => {
    const budget = new RecallChainBudget({
      deadlineAt: 1_000_000,
      maxConsecutiveNoProgress: 0,
      now: () => 0,
    });
    expect(
      budget.record([
        {
          identity: "e:empty",
          revision: "revision-1",
          offset: 0,
          length: 0,
          complete: true,
          kind: "detail",
        },
      ]),
    ).toBeUndefined();
    expect(budget.snapshot()).toEqual({ consecutiveNoProgress: 0 });
  });

  test("unknown coverage never guesses that legacy recall stalled", () => {
    const budget = new RecallChainBudget({
      deadlineAt: 1_000_000,
      maxConsecutiveNoProgress: 0,
      now: () => 0,
    });
    for (let index = 0; index < 100; index++) {
      expect(budget.record()).toBeUndefined();
    }
  });

  test("bounds retained coverage without treating evicted keys as stalled", () => {
    const budget = new RecallChainBudget({
      deadlineAt: 1_000_000,
      maxConsecutiveNoProgress: 0,
      now: () => 0,
    });
    for (let index = 0; index <= MAX_RETAINED_RECALL_COVERAGE; index++) {
      expect(budget.record(coverage(index))).toBeUndefined();
    }
    expect(budget.record(coverage(0))).toBeUndefined();
    expect(budget.record(coverage(0))).toBe("stalled");
  });

  test("treats oversized coverage keys as unknown progress", () => {
    const budget = new RecallChainBudget({
      deadlineAt: 1_000_000,
      maxConsecutiveNoProgress: 0,
      now: () => 0,
    });
    const oversized = [
      {
        ...coverage(0)[0],
        identity: "x".repeat(MAX_RETAINED_RECALL_COVERAGE_KEY_CHARS + 1),
      },
    ];
    expect(budget.record(oversized)).toBeUndefined();
    expect(budget.record(oversized)).toBeUndefined();
  });

  test("reserves foreground time for final synthesis", () => {
    let now = 0;
    const budget = new RecallChainBudget({
      deadlineAt: 20_001,
      now: () => now,
    });
    expect(budget.admit()).toBeUndefined();
    now = 1;
    expect(budget.admit()).toBe("time");
    expect(budget.mustFinalizeNext()).toBe(true);
  });

  test("productive chains remain admitted for arbitrary positive coverage", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.tuple(fc.string({ minLength: 1 }), fc.nat()), {
          minLength: 1,
          maxLength: 200,
          selector: ([identity, offset]) => `${identity}:${offset}`,
        }),
        (items) => {
          const budget = new RecallChainBudget({
            deadlineAt: 1_000_000,
            maxConsecutiveNoProgress: 0,
            now: () => 0,
          });
          for (const [identity, offset] of items) {
            expect(budget.admit()).toBeUndefined();
            expect(
              budget.record([
                {
                  identity,
                  revision: "revision",
                  offset,
                  length: 1,
                  complete: false,
                },
              ]),
            ).toBeUndefined();
          }
        },
      ),
    );
  });
});
