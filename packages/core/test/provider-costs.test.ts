import { describe, test, expect, beforeEach } from "vitest";
import {
  db,
  addProviderCost,
  getProviderCostTotals,
  isProviderQuotaStale,
  QUOTA_STALE_FALLBACK_MS,
  MAX_PROVIDER_QUOTA_ROWS,
  getProviderDayUsage,
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

describe("getProviderDayUsage", () => {
  test("sums cost, tokens and requests for one provider day", () => {
    addProviderCost(costRow({ cost: 1, outputTokens: 50 }));
    addProviderCost(costRow({ cost: 0.5, requests: 2, cacheReadTokens: 90 }));
    addProviderCost(costRow({ day: "2099-01-02", cost: 9 }));
    const usage = getProviderDayUsage(
      "2099-01-01",
      "anthropic",
      "subscription",
      "acct1",
    );
    expect(usage).toEqual({ cost: 1.5, tokens: 410, requests: 3 });
  });

  test("null auth kind/account matches everything, set values filter", () => {
    addProviderCost(costRow({ cost: 1 }));
    addProviderCost(
      costRow({ authKind: "api_key", account: "acct2", cost: 2 }),
    );
    expect(
      getProviderDayUsage("2099-01-01", "anthropic", null, null).cost,
    ).toBe(3);
    expect(
      getProviderDayUsage("2099-01-01", "anthropic", "subscription", null).cost,
    ).toBe(1);
    expect(
      getProviderDayUsage("2099-01-01", "anthropic", null, "acct2").cost,
    ).toBe(2);
  });

  test("no rows returns zeros", () => {
    expect(getProviderDayUsage("2099-01-01", "gemini", null, null)).toEqual({
      cost: 0,
      tokens: 0,
      requests: 0,
    });
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
    expect(
      upsertProviderQuota(quotaRow({ usedPercent: 55, observedAt: 2000 })),
    ).toBe(true);
    expect(
      upsertProviderQuota(quotaRow({ usedPercent: 10, observedAt: 1500 })),
    ).toBe(false);
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

  test("arbitrary window names cannot grow one account's snapshot set without bound", () => {
    const now = Date.now();
    for (let index = 0; index < 65; index++) {
      upsertProviderQuota(
        quotaRow({
          window: `provider-window-${index}`,
          observedAt: now + index,
        }),
      );
    }

    expect(listProviderQuotas()).toHaveLength(64);
    expect(
      upsertProviderQuota(
        quotaRow({ window: "provider-window-0", observedAt: now + 100 }),
      ),
    ).toBe(true);
    expect(listProviderQuotas()).toHaveLength(64);
  });

  test("aggregate quota storage cap preserves established identities", () => {
    const now = Date.now();
    const established = quotaRow({
      account: "established-account",
      window: "5h",
      observedAt: now,
    });
    expect(upsertProviderQuota(established)).toBe(true);
    for (let index = 0; index < MAX_PROVIDER_QUOTA_ROWS - 1; index++) {
      upsertProviderQuota(
        quotaRow({
          account: index === 0 ? "expired-account" : `account-${index}`,
          window: "5h",
          observedAt: index === 0 ? now - 2 * QUOTA_STALE_FALLBACK_MS : now,
          windowMinutes: index === 0 ? 1 : 300,
          resetsAt: index === 0 ? now - 1 : now + 5 * 60_000,
        }),
      );
    }

    const refreshed = quotaRow({
      account: "established-account",
      window: "5h",
      observedAt: now + 1000,
    });
    expect(upsertProviderQuota(refreshed)).toBe(true);
    expect(
      upsertProviderQuota(
        quotaRow({
          account: "overflow-account",
          window: "5h",
          observedAt: now + 2000,
        }),
      ),
    ).toBe(true);

    const quotas = listProviderQuotas();
    expect(quotas).toHaveLength(MAX_PROVIDER_QUOTA_ROWS);
    expect(
      quotas.find((row) => row.account === "established-account")?.observedAt,
    ).toBe(now + 1000);
    expect(quotas.some((row) => row.account === "expired-account")).toBe(false);
    expect(quotas.some((row) => row.account === "overflow-account")).toBe(true);
  });
});
