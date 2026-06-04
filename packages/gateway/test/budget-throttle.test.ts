import { describe, test, expect, beforeEach } from "bun:test";
import {
  computeThrottleDelay,
  getDailyThrottleDelay,
  getDailySpend,
  getCostRate,
  estimateRequestCost,
  resetDailyBudgetState,
  recordConversationCost,
  recordWorkerCost,
  recordWarmupCost,
  computeDailyCosts,
  bootstrapDailySpend,
  clearAllCosts,
  getSessionCosts,
} from "../src/cost-tracker";
import { getDailyCostForDay } from "@loreai/core";

describe("budget-throttle", () => {
  beforeEach(() => {
    clearAllCosts();
  });

  // ---------------------------------------------------------------------------
  // computeThrottleDelay — pure function, no global state dependency
  // ---------------------------------------------------------------------------
  describe("computeThrottleDelay", () => {
    test("returns 0 when budget is 0 (disabled)", () => {
      expect(computeThrottleDelay(5, 0, 10, 12)).toBe(0);
    });

    test("returns 0 when budget is negative (disabled)", () => {
      expect(computeThrottleDelay(5, -1, 10, 12)).toBe(0);
    });

    test("returns 0 when spend is below 50% floor", () => {
      // $4 of $10 = 40% — below THROTTLE_FLOOR (50%)
      expect(computeThrottleDelay(4, 10, 100, 12)).toBe(0);
    });

    test("returns 0 when spend is exactly at 50% floor", () => {
      // $5 of $10 = 50% — exactly at floor
      expect(computeThrottleDelay(5, 10, 100, 12)).toBe(0);
    });

    test("returns 0 when rate is sustainable", () => {
      // $7 of $10 = 70%, remaining = $3 over 12h = $0.25/hr target
      // Current rate = $0.10/hr — sustainable
      expect(computeThrottleDelay(7, 10, 0.1, 12)).toBe(0);
    });

    test("applies small delay at 60% spend with 2x overshoot", () => {
      // $6 of $10 = 60%, remaining = $4 over 12h = $0.33/hr target
      // Current rate = $0.67/hr (~2x overshoot)
      const delay = computeThrottleDelay(6, 10, 0.67, 12);
      expect(delay).toBeGreaterThan(0);
      expect(delay).toBeLessThan(3); // should be well under 3s
    });

    test("applies moderate delay at 80% spend with 2x overshoot", () => {
      // $8 of $10 = 80%, remaining = $2 over 10h = $0.20/hr target
      // Current rate = $0.40/hr (2x overshoot)
      const delay = computeThrottleDelay(8, 10, 0.4, 10);
      expect(delay).toBeGreaterThan(3);
      expect(delay).toBeLessThan(15);
    });

    test("applies large delay at 80% spend with 5x overshoot", () => {
      // $8 of $10 = 80%, remaining = $2 over 10h = $0.20/hr target
      // Current rate = $1.00/hr (5x overshoot)
      const delay = computeThrottleDelay(8, 10, 1.0, 10);
      expect(delay).toBeGreaterThan(10);
      expect(delay).toBeLessThan(30);
    });

    test("approaches max delay at 95% spend with 3x overshoot", () => {
      // $9.50 of $10 = 95%, remaining = $0.50 over 10h = $0.05/hr target
      // Current rate = $0.15/hr (3x overshoot)
      const delay = computeThrottleDelay(9.5, 10, 0.15, 10);
      expect(delay).toBeGreaterThan(20);
      expect(delay).toBeLessThanOrEqual(60);
    });

    test("never exceeds MAX_THROTTLE_DELAY (60s)", () => {
      // Extreme: 100% spend, 10x overshoot
      const delay = computeThrottleDelay(10, 10, 100, 1);
      expect(delay).toBeLessThanOrEqual(60);
    });

    test("is monotonically increasing with spend fraction", () => {
      const rate = 2;
      const hours = 10;
      const budget = 10;
      let prevDelay = 0;
      for (let spend = 5; spend <= 10; spend += 0.5) {
        const delay = computeThrottleDelay(spend, budget, rate, hours);
        expect(delay).toBeGreaterThanOrEqual(prevDelay);
        prevDelay = delay;
      }
    });

    test("is monotonically increasing with cost rate", () => {
      const spend = 7;
      const budget = 10;
      const hours = 10;
      // Target rate = $3 / 10h = $0.30/hr
      let prevDelay = 0;
      for (let rate = 0.3; rate <= 5; rate += 0.5) {
        const delay = computeThrottleDelay(spend, budget, rate, hours);
        expect(delay).toBeGreaterThanOrEqual(prevDelay);
        prevDelay = delay;
      }
    });

    test("floors hoursRemaining at 0.5 to avoid division explosion", () => {
      // Near midnight: only 0.01 hours remaining (36 seconds)
      // Without floor this would make targetRate insanely high
      const delay = computeThrottleDelay(9, 10, 5, 0.01);
      // Should still compute a reasonable delay, not NaN or Infinity
      expect(Number.isFinite(delay)).toBe(true);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(60);
    });

    test("returns max delay when budget is exhausted regardless of rate", () => {
      // Spent more than budget — even if rate is 0 (idle return), max delay applies
      expect(computeThrottleDelay(12, 10, 0, 10)).toBe(60);
      expect(computeThrottleDelay(10, 10, 0, 10)).toBe(60);
    });

    test("smooth curve — no cliff edges between adjacent inputs", () => {
      const budget = 10;
      const rate = 2;
      const hours = 10;
      // Check that adjacent 0.1% spend increments don't produce >5s jumps
      for (let pct = 0.5; pct < 1.0; pct += 0.001) {
        const d1 = computeThrottleDelay(pct * budget, budget, rate, hours);
        const d2 = computeThrottleDelay(
          (pct + 0.001) * budget,
          budget,
          rate,
          hours,
        );
        expect(Math.abs(d2 - d1)).toBeLessThan(5);
      }
    });

    // --- quota pressure (5th param) ---

    test("quotaPressure=0 leaves budget-only behavior unchanged", () => {
      // No budget, no quota → 0
      expect(computeThrottleDelay(5, 0, 10, 12, 0)).toBe(0);
      // Below floor, no quota → 0
      expect(computeThrottleDelay(4, 10, 100, 12, 0)).toBe(0);
      // Same as omitting the 5th param
      expect(computeThrottleDelay(8, 10, 0.4, 10, 0)).toBe(
        computeThrottleDelay(8, 10, 0.4, 10),
      );
    });

    test("quota pressure throttles even with no USD budget", () => {
      // dailyBudget=0 (disabled), high quota pressure → non-zero delay
      const delay = computeThrottleDelay(0, 0, 0, 12, 1);
      expect(delay).toBe(60); // MAX_THROTTLE_DELAY at full pressure
    });

    test("quota delay ramps with pressure (squared)", () => {
      const half = computeThrottleDelay(0, 0, 0, 12, 0.5);
      expect(half).toBeCloseTo(15, 0); // 60 * 0.5^2 = 15
      expect(computeThrottleDelay(0, 0, 0, 12, 0)).toBe(0);
    });

    test("final delay is the max of budget and quota delays", () => {
      // Strong budget delay, weak quota → budget wins
      const budgetStrong = computeThrottleDelay(10, 10, 100, 1, 0.2);
      const budgetOnly = computeThrottleDelay(10, 10, 100, 1, 0);
      expect(budgetStrong).toBe(budgetOnly);

      // Weak budget (below floor), strong quota → quota wins
      const quotaWins = computeThrottleDelay(0, 10, 0, 12, 1);
      expect(quotaWins).toBe(60);
    });
  });

  // ---------------------------------------------------------------------------
  // estimateRequestCost
  // ---------------------------------------------------------------------------
  describe("estimateRequestCost", () => {
    test("returns positive cost for known model", () => {
      const cost = estimateRequestCost("claude-sonnet-4-20250514", 100_000);
      expect(cost).toBeGreaterThan(0);
    });

    test("input tokens contribute to cost", () => {
      const small = estimateRequestCost("claude-sonnet-4-20250514", 10_000);
      const large = estimateRequestCost("claude-sonnet-4-20250514", 100_000);
      expect(large).toBeGreaterThan(small);
    });

    test("output estimate is capped at 16K tokens", () => {
      // With 1M input tokens, 25% would be 250K — should be capped at 16K
      const cost1M = estimateRequestCost("claude-sonnet-4-20250514", 1_000_000);
      const cost500K = estimateRequestCost("claude-sonnet-4-20250514", 500_000);
      // The difference should come only from input cost, not output
      // (both hit the 16K cap)
      const costRatio = cost1M / cost500K;
      // Should be close to 2x (input doubles), not 2x+ (if output also doubled)
      expect(costRatio).toBeGreaterThan(1.5);
      expect(costRatio).toBeLessThan(2.5);
    });
  });

  // ---------------------------------------------------------------------------
  // updateCostRate (tested via recordConversationCost + getCostRate)
  // ---------------------------------------------------------------------------
  describe("cost rate EMA", () => {
    const mockUsage = {
      input_tokens: 50_000,
      output_tokens: 1_000,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    };

    test("seeds on first turn", () => {
      expect(getCostRate()).toBe(0);
      recordConversationCost(
        "session-1",
        "claude-sonnet-4-20250514",
        mockUsage,
      );
      expect(getCostRate()).toBeGreaterThan(0);
    });

    test("EMA is finite after multiple turns", async () => {
      for (let i = 0; i < 5; i++) {
        recordConversationCost(
          "session-1",
          "claude-sonnet-4-20250514",
          mockUsage,
        );
        // Small delay to avoid sub-second collapse
        await new Promise((r) => setTimeout(r, 10));
      }
      const rate = getCostRate();
      expect(Number.isFinite(rate)).toBe(true);
      expect(rate).toBeGreaterThan(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Daily spend accumulator
  // ---------------------------------------------------------------------------
  describe("daily spend accumulator", () => {
    test("starts at zero", () => {
      const { spend } = getDailySpend();
      expect(spend).toBe(0);
    });

    test("accumulates conversation costs", () => {
      recordConversationCost("session-1", "claude-sonnet-4-20250514", {
        input_tokens: 50_000,
        output_tokens: 1_000,
      });
      const { spend } = getDailySpend();
      expect(spend).toBeGreaterThan(0);
    });

    test("returns today's date", () => {
      const { date } = getDailySpend();
      const today = new Date().toISOString().slice(0, 10);
      expect(date).toBe(today);
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
      // Ledger increment should match the in-memory dailySpend delta.
      expect(after - before).toBeCloseTo(getDailySpend().spend, 6);
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

    test("bootstrapDailySpend reads today's spend from the ledger", () => {
      recordConversationCost("ledger-session-3", "claude-sonnet-4-20250514", {
        input_tokens: 40_000,
        output_tokens: 1_000,
      });
      const ledgerToday = getDailyCostForDay(today);
      // Clear in-memory state, then bootstrap — should recover from the ledger.
      resetDailyBudgetState();
      expect(getDailySpend().spend).toBe(0);
      bootstrapDailySpend();
      expect(getDailySpend().spend).toBeCloseTo(ledgerToday, 6);
    });
  });

  // ---------------------------------------------------------------------------
  // getDailyThrottleDelay — integrates accumulator + EMA + computeThrottleDelay
  // ---------------------------------------------------------------------------
  describe("getDailyThrottleDelay", () => {
    test("returns 0 when budget is 0 (disabled)", () => {
      expect(getDailyThrottleDelay(0, 0.01)).toBe(0);
    });

    test("returns 0 when no spend has occurred", () => {
      // Even with a budget, no spend + no EMA = no throttle
      expect(getDailyThrottleDelay(10, 0.01)).toBe(0);
    });

    test("returns 0 for small estimated cost with fresh state", () => {
      expect(getDailyThrottleDelay(10, 0.001)).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // resetDailyBudgetState
  // ---------------------------------------------------------------------------
  describe("resetDailyBudgetState", () => {
    test("clears all budget state", () => {
      recordConversationCost("session-1", "claude-sonnet-4-20250514", {
        input_tokens: 50_000,
        output_tokens: 1_000,
      });
      expect(getDailySpend().spend).toBeGreaterThan(0);
      expect(getCostRate()).toBeGreaterThan(0);

      resetDailyBudgetState();
      expect(getDailySpend().spend).toBe(0);
      expect(getCostRate()).toBe(0);
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
      expect(costs!.throttle.events).toBe(0);
      expect(costs!.throttle.totalDelayMs).toBe(0);
    });
  });
});
