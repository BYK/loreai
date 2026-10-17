import { describe, test, expect, beforeEach } from "vitest";
import {
  throttleDelayForPressure,
  recordConversationCost,
  recordWorkerCost,
  recordWarmupCost,
  computeDailyCosts,
  clearAllCosts,
  getSessionCosts,
} from "../src/cost-tracker";
import { getDailyCostForDay } from "@loreai/core";

describe("budget-throttle", () => {
  beforeEach(() => {
    clearAllCosts();
  });

  // ---------------------------------------------------------------------------
  // throttleDelayForPressure — provider-budget pressure → delay curve
  // ---------------------------------------------------------------------------
  describe("throttleDelayForPressure", () => {
    test("no pressure means no delay", () => {
      expect(throttleDelayForPressure(0)).toBe(0);
      expect(throttleDelayForPressure(-1)).toBe(0);
      expect(throttleDelayForPressure(Number.NaN)).toBe(0);
    });

    test("ramps with the square of pressure up to 60s", () => {
      expect(throttleDelayForPressure(0.5)).toBe(15);
      expect(throttleDelayForPressure(0.1)).toBe(0.6);
      expect(throttleDelayForPressure(1)).toBe(60);
    });

    test("clamps pressure above 1", () => {
      expect(throttleDelayForPressure(5)).toBe(60);
    });

    test("is monotonically increasing", () => {
      let prev = 0;
      for (let p = 0; p <= 1; p += 0.05) {
        const delay = throttleDelayForPressure(p);
        expect(delay).toBeGreaterThanOrEqual(prev);
        prev = delay;
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Per-day cost ledger (daily_costs) — fed by the three record* functions
  // ---------------------------------------------------------------------------
  describe("daily cost ledger", () => {
    const today = new Date().toISOString().slice(0, 10);

    test("recordConversationCost writes to the ledger for today", () => {
      const before = getDailyCostForDay(today);
      recordConversationCost("ledger-session", "claude-sonnet-4-20250514", {
        input_tokens: 50_000,
        output_tokens: 1_000,
      });
      const after = getDailyCostForDay(today);
      expect(after).toBeGreaterThan(before);
    });

    test("worker and warmup costs accumulate into the same day", () => {
      const before = getDailyCostForDay(today);
      recordWorkerCost(
        "ledger-session",
        "claude-sonnet-4-20250514",
        {
          input_tokens: 10_000,
          output_tokens: 500,
        },
        "direct",
        "lore-distill",
      );
      recordWarmupCost(
        "ledger-session",
        "claude-sonnet-4-20250514",
        20_000,
        2_000,
      );
      const after = getDailyCostForDay(today);
      expect(after).toBeGreaterThan(before);
    });

    test("computeDailyCosts reflects ledger totals on today's bucket", () => {
      recordConversationCost("ledger-session-2", "claude-sonnet-4-20250514", {
        input_tokens: 80_000,
        output_tokens: 2_000,
      });
      const daily = computeDailyCosts(14);
      expect(daily.length).toBe(14);
      // Last bucket is today (UTC), and its cost matches the ledger.
      const todayBucket = daily[daily.length - 1];
      expect(todayBucket.date).toBe(today);
      expect(todayBucket.cost).toBeCloseTo(getDailyCostForDay(today), 6);
    });
  });

  // ---------------------------------------------------------------------------
  // SessionCosts.throttle field
  // ---------------------------------------------------------------------------
  describe("SessionCosts throttle field", () => {
    test("initialized to zero in new sessions", () => {
      recordConversationCost("new-session", "claude-sonnet-4-20250514", {
        input_tokens: 100,
        output_tokens: 100,
      });
      const costs = getSessionCosts("new-session");
      expect(costs).not.toBeNull();
      expect(costs?.throttle.events).toBe(0);
      expect(costs?.throttle.totalDelayMs).toBe(0);
    });
  });
});
