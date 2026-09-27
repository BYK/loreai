import { describe, test, expect, beforeEach } from "vitest";
import {
  db,
  addProviderCost,
  getProviderCostTotals,
  isProviderQuotaStale,
  QUOTA_STALE_FALLBACK_MS,
  upsertProviderQuota,
  listProviderQuotas,
  type ProviderCostRow,
  type ProviderQuotaRow,
} from "../src/db";

function clearTables(): void {
  db().exec("DELETE FROM provider_costs");
  db().exec("DELETE FROM provider_quotas");
}

beforeEach(clearTables);

function costRow(overrides: Partial<ProviderCostRow> = {}): ProviderCostRow {
  return {
    day: "2099-01-01",
    provider: "anthropic",
    authKind: "subscription",
    account: "acct1",
    bucket: "conversation",
    cost: 1.0,
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 10,
    cacheWriteTokens: 5,
    requests: 1,
    ...overrides,
  };
}

function quotaRow(overrides: Partial<ProviderQuotaRow> = {}): ProviderQuotaRow {
  return {
    provider: "anthropic",
    authKind: "subscription",
    account: "acct1",
    window: "5h",
    label: "allowed",
    windowMinutes: 300,
    usedPercent: 42,
    remaining: null,
    limit: null,
    resetsAt: 1_800_000_000_000,
    source: "anthropic-unified",
    observedAt: 1000,
    ...overrides,
  };
}

describe("provider_costs ledger", () => {
  test("addProviderCost accumulates numeric columns across calls", () => {
    addProviderCost(costRow());
    addProviderCost(costRow({ cost: 0.5, requests: 2, outputTokens: 10 }));

    const totals = getProviderCostTotals("2099-01-01");
    expect(totals.length).toBe(1);
    expect(totals[0]).toMatchObject({
      provider: "anthropic",
      authKind: "subscription",
      account: "acct1",
      cost: 1.5,
      inputTokens: 200,
      outputTokens: 60,
      cacheReadTokens: 20,
      cacheWriteTokens: 10,
      requests: 3,
      todayCost: 1.5,
      lastDay: "2099-01-01",
    });
  });

  test("all-zero or non-finite input is a no-op", () => {
    addProviderCost(
      costRow({
        cost: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        requests: 0,
      }),
    );
    addProviderCost(
      costRow({
        cost: Number.NaN,
        inputTokens: -5,
        outputTokens: Number.POSITIVE_INFINITY,
        cacheReadTokens: -1,
        cacheWriteTokens: Number.NaN,
        requests: -1,
      }),
    );
    expect(getProviderCostTotals("2099-01-01")).toEqual([]);
  });

  test("negative/non-finite fields clamp to 0 while positive fields count", () => {
    addProviderCost(
      costRow({ cost: -2, inputTokens: Number.NaN, requests: 1 }),
    );
    const totals = getProviderCostTotals("2099-01-01");
    expect(totals[0].cost).toBe(0);
    expect(totals[0].inputTokens).toBe(0);
    expect(totals[0].requests).toBe(1);
  });

  test("getProviderCostTotals groups by provider/authKind/account and orders by cost", () => {
    addProviderCost(costRow({ provider: "openai", cost: 0.1 }));
    addProviderCost(costRow({ provider: "anthropic", cost: 2.0 }));
    addProviderCost(
      costRow({ authKind: "api_key", account: "acct2", cost: 1.0 }),
    );
    addProviderCost(
      costRow({ day: "2099-01-02", cost: 5.0, bucket: "worker" }),
    );

    const totals = getProviderCostTotals("2099-01-01");
    expect(totals.map((t) => t.provider)).toEqual([
      "anthropic",
      "anthropic",
      "openai",
    ]);
    const sub = totals.find((t) => t.authKind === "subscription");
    expect(sub?.cost).toBeCloseTo(7.0, 6);
    expect(sub?.todayCost).toBeCloseTo(2.0, 6);
    expect(sub?.lastDay).toBe("2099-01-02");
  });
});

describe("provider_costs index", () => {
  test("idx_provider_costs_group exists and serves the totals query", () => {
    const index = db()
      .query(
        `SELECT name FROM sqlite_master
         WHERE type = 'index' AND name = 'idx_provider_costs_group'`,
      )
      .get();
    expect(index).toBeTruthy();

    const plan = db()
      .query(
        `EXPLAIN QUERY PLAN
         SELECT provider, auth_kind, account, SUM(cost) AS cost
         FROM provider_costs
         GROUP BY provider, auth_kind, account`,
      )
      .all() as Array<{ detail: string }>;
    expect(
      plan.some((row) => row.detail.includes("idx_provider_costs_group")),
    ).toBe(true);
  });
});

describe("isProviderQuotaStale", () => {
  const now = 1_700_000_000_000;
  test("resets_at in the past → stale", () => {
    expect(
      isProviderQuotaStale(
        { resetsAt: now - 1, observedAt: now - 60_000, windowMinutes: 300 },
        now,
      ),
    ).toBe(true);
  });
  test("age exceeds the window length → stale", () => {
    expect(
      isProviderQuotaStale(
        { resetsAt: null, observedAt: now - 301 * 60_000, windowMinutes: 300 },
        now,
      ),
    ).toBe(true);
  });
  test("null window older than 24h → stale", () => {
    expect(
      isProviderQuotaStale(
        {
          resetsAt: null,
          observedAt: now - QUOTA_STALE_FALLBACK_MS - 1,
          windowMinutes: null,
        },
        now,
      ),
    ).toBe(true);
  });
  test("fresh snapshot → not stale", () => {
    expect(
      isProviderQuotaStale(
        {
          resetsAt: now + 3600_000,
          observedAt: now - 60_000,
          windowMinutes: 300,
        },
        now,
      ),
    ).toBe(false);
    expect(
      isProviderQuotaStale(
        { resetsAt: null, observedAt: now - 60_000, windowMinutes: null },
        now,
      ),
    ).toBe(false);
  });
});

describe("provider_quotas snapshots", () => {
  test("upsert replaces per (provider, authKind, account, window) key", () => {
    upsertProviderQuota(quotaRow({ usedPercent: 40 }));
    upsertProviderQuota(quotaRow({ usedPercent: 55, observedAt: 2000 }));
    const quotas = listProviderQuotas();
    expect(quotas.length).toBe(1);
    expect(quotas[0].usedPercent).toBe(55);
    expect(quotas[0].observedAt).toBe(2000);
  });

  test("older observed_at does not overwrite newer snapshot", () => {
    upsertProviderQuota(quotaRow({ usedPercent: 55, observedAt: 2000 }));
    upsertProviderQuota(quotaRow({ usedPercent: 10, observedAt: 1500 }));
    const quotas = listProviderQuotas();
    expect(quotas[0].usedPercent).toBe(55);
    expect(quotas[0].observedAt).toBe(2000);
  });

  test("equal observed_at replaces (latest write wins for same instant)", () => {
    upsertProviderQuota(quotaRow({ usedPercent: 30, observedAt: 2000 }));
    upsertProviderQuota(quotaRow({ usedPercent: 31, observedAt: 2000 }));
    expect(listProviderQuotas()[0].usedPercent).toBe(31);
  });

  test("different windows coexist; listing is ordered", () => {
    upsertProviderQuota(quotaRow({ window: "7d", windowMinutes: 10080 }));
    upsertProviderQuota(quotaRow({ window: "5h" }));
    upsertProviderQuota(
      quotaRow({ provider: "openai", authKind: "api_key", window: "requests" }),
    );
    const quotas = listProviderQuotas();
    expect(quotas.map((q) => `${q.provider}:${q.window}`)).toEqual([
      "anthropic:5h",
      "anthropic:7d",
      "openai:requests",
    ]);
  });
});
