import { afterEach, describe, expect, test } from "vitest";
import {
  evaluateCacheStrategy,
  evictSession,
  getCacheSizeSnapshot,
  getCacheStrategy,
  setCacheSizeSnapshot,
  setCachePricing,
} from "../src/gradient";

// Per-token pricing with a 12x miss premium (read=1e-6, write=12e-6).
const PRICING = { readPerToken: 1e-6, writePerToken: 12e-6 };

let counter = 0;
function freshSession(): string {
  return `econ-test-${Date.now()}-${counter++}`;
}

describe("cache-strategy evaluator (single entry point)", () => {
  const created: string[] = [];
  function sid(): string {
    const id = freshSession();
    created.push(id);
    return id;
  }
  afterEach(() => {
    for (const id of created.splice(0)) evictSession(id);
  });

  test("evaluate returns null when the session has no size snapshot", () => {
    expect(
      evaluateCacheStrategy(sid(), {
        pReturn: 0.9,
        expectedCycles: 1,
        expectedFutureTurns: 5,
      }),
    ).toBeNull();
  });

  test("snapshot → evaluate → getCacheStrategy round-trips the same result", () => {
    const id = sid();
    setCacheSizeSnapshot(id, 580_000, 190_000);
    const result = evaluateCacheStrategy(
      id,
      { pReturn: 0.8, expectedCycles: 3, expectedFutureTurns: 20 },
      PRICING,
    );
    expect(result).not.toBeNull();
    // Large body, many future turns, cheap compaction → cool-bust.
    expect(result?.strategy).toBe("cool-bust");
    expect(result?.confident).toBe(true);
    // The stored decision is exactly the one returned (single source of truth).
    const stored = getCacheStrategy(id);
    expect(stored?.result).toEqual(result);
    expect(stored?.decidedAt).toBeGreaterThan(0);
  });

  test("a small, likely-return session evaluates to hold-warm", () => {
    const id = sid();
    setCacheSizeSnapshot(id, 10_000, 10_000); // no compaction available
    const result = evaluateCacheStrategy(
      id,
      { pReturn: 0.95, expectedCycles: 1, expectedFutureTurns: 4 },
      PRICING,
    );
    expect(result?.strategy).toBe("hold-warm");
  });

  test("getCacheSizeSnapshot reflects the snapshot and clamps compressed ≤ full", () => {
    const id = sid();
    setCacheSizeSnapshot(id, 100_000, 250_000); // compressed > full
    expect(getCacheSizeSnapshot(id)).toEqual({
      full: 100_000,
      compressed: 100_000,
    });
  });

  test("getCacheSizeSnapshot is null before any snapshot", () => {
    expect(getCacheSizeSnapshot(sid())).toBeNull();
  });

  test("explicit pricing override is used instead of the module global", () => {
    const id = sid();
    setCacheSizeSnapshot(id, 50_000, 50_000);
    // Set a degenerate global pricing (read>=write) that, if used, would make
    // warming never pay off; the override must take precedence.
    setCachePricing(0, 0);
    const result = evaluateCacheStrategy(
      id,
      { pReturn: 0.95, expectedCycles: 1, expectedFutureTurns: 3 },
      PRICING,
    );
    expect(result?.confident).toBe(true);
    expect(result?.strategy).toBe("hold-warm");
  });

  test("without override, missing global pricing yields low confidence", () => {
    const id = sid();
    setCacheSizeSnapshot(id, 50_000, 50_000);
    setCachePricing(0, 0); // global pricing unavailable
    const result = evaluateCacheStrategy(id, {
      pReturn: 0.9,
      expectedCycles: 1,
      expectedFutureTurns: 3,
    });
    expect(result?.confident).toBe(false);
  });
});
