import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { db, addProviderCost, getProviderCostTotals } from "@loreai/core";
import {
  recordConversationCost,
  recordWorkerCost,
  recordWarmupCost,
  deleteSessionCosts,
  getProviderCostSummary,
  resetDailyBudgetState,
} from "../src/cost-tracker";
import type { CostAttribution } from "../src/cost-attribution";

const MODEL = "__test_fake_model__";
const SID = "cost-attribution-test-session";
const ATTR: CostAttribution = {
  provider: "anthropic",
  authKind: "subscription",
  account: "acct123",
};

function clear(): void {
  db().exec("DELETE FROM provider_costs");
  deleteSessionCosts(SID);
}

beforeEach(clear);
afterEach(clear);

const USAGE = {
  input_tokens: 1000,
  output_tokens: 500,
  cache_read_input_tokens: 100,
  cache_creation_input_tokens: 50,
};

describe("provider cost attribution", () => {
  test("recordConversationCost writes provider_costs with conversation bucket", () => {
    recordConversationCost(SID, MODEL, USAGE, "5m", ATTR);
    const rows = getProviderCostTotals("2099-01-01");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      provider: "anthropic",
      authKind: "subscription",
      account: "acct123",
      requests: 1,
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 100,
      cacheWriteTokens: 50,
    });
    expect(rows[0].cost).toBeGreaterThan(0);
  });

  test("recordWorkerCost writes worker bucket", () => {
    recordWorkerCost(SID, MODEL, USAGE, "direct", "lore-distill", "5m", ATTR);
    const rows = getProviderCostTotals("2099-01-01");
    expect(rows[0].cost).toBeGreaterThan(0);
    const raw = db().query("SELECT bucket FROM provider_costs").all() as Array<{
      bucket: string;
    }>;
    expect(raw[0].bucket).toBe("worker");
  });

  test("recordWarmupCost writes warmup bucket with cache tokens", () => {
    recordWarmupCost(SID, MODEL, 200, 300, "5m", ATTR);
    const raw = db()
      .query(
        "SELECT bucket, cache_read_tokens, cache_write_tokens FROM provider_costs",
      )
      .all() as Array<{
      bucket: string;
      cache_read_tokens: number;
      cache_write_tokens: number;
    }>;
    expect(raw[0]).toMatchObject({
      bucket: "warmup",
      cache_read_tokens: 200,
      cache_write_tokens: 300,
    });
  });

  test("without attribution no provider_costs rows are written", () => {
    recordConversationCost(SID, MODEL, USAGE);
    recordWorkerCost(SID, MODEL, USAGE, "direct");
    recordWarmupCost(SID, MODEL, 100, 100);
    expect(getProviderCostTotals("2099-01-01")).toEqual([]);
  });

  test("recordWorkerCost with no sessionID writes nothing", () => {
    recordWorkerCost(undefined, MODEL, USAGE, "direct", "x", "5m", ATTR);
    expect(getProviderCostTotals("2099-01-01")).toEqual([]);
  });

  test("getProviderCostSummary reports today without bootstrapDailySpend", () => {
    const today = new Date().toISOString().slice(0, 10);
    addProviderCost({
      day: today,
      provider: "anthropic",
      authKind: "subscription",
      account: "acct123",
      bucket: "conversation",
      cost: 1.25,
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      requests: 1,
    });
    // Simulate a cold tracker: no bootstrap ran, so the date is unset —
    // the summary must roll the day itself rather than read "" as today.
    resetDailyBudgetState();
    const summary = getProviderCostSummary();
    const row = summary.find(
      (r) => r.provider === "anthropic" && r.account === "acct123",
    );
    expect(row?.today_spend).toBeCloseTo(1.25, 6);
  });
});
