import { describe, test, expect, beforeEach, afterEach } from "vitest";
import {
  db,
  setKV,
  addProviderCost,
  upsertProviderQuota,
  type ProviderQuotaRow,
} from "@loreai/core";
import {
  getProviderBudgets,
  setProviderBudgets,
  parseProviderBudgets,
  evaluateProviderBudgets,
  computeProviderBudgetPressure,
  type ProviderBudget,
} from "../src/provider-budgets";

const NOW = Date.UTC(2099, 0, 1, 12, 0, 0); // fixed noon UTC
const DAY = "2099-01-01";

function clear(): void {
  db().exec("DELETE FROM provider_costs");
  db().exec("DELETE FROM provider_quotas");
  db().query("DELETE FROM kv_meta WHERE key = ?").run("provider_budgets");
}

beforeEach(clear);
afterEach(clear);

function budget(overrides: Partial<ProviderBudget> = {}): ProviderBudget {
  return {
    provider: "anthropic",
    auth_kind: null,
    account: null,
    unit: "usd",
    window: "daily",
    amount: 10,
    ...overrides,
  };
}

function costRow(
  overrides: Partial<Parameters<typeof addProviderCost>[0]> = {},
) {
  return {
    day: DAY,
    provider: "anthropic",
    authKind: "subscription" as const,
    account: "acct1",
    bucket: "conversation" as const,
    cost: 1,
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
    label: null,
    windowMinutes: 300,
    usedPercent: 40,
    remaining: null,
    limit: null,
    resetsAt: NOW + 2 * 3600_000,
    source: "anthropic-unified",
    observedAt: NOW - 60_000,
    ...overrides,
  };
}

describe("parseProviderBudgets", () => {
  test("accepts a valid list and normalizes nulls", () => {
    const parsed = parseProviderBudgets([
      {
        provider: "anthropic",
        auth_kind: "subscription",
        account: "abc123",
        unit: "percent",
        window: "5h",
        amount: 80,
      },
      { provider: "openai", unit: "usd", window: "daily", amount: 5 },
    ]);
    expect(parsed).toEqual([
      {
        provider: "anthropic",
        auth_kind: "subscription",
        account: "abc123",
        unit: "percent",
        window: "5h",
        amount: 80,
      },
      {
        provider: "openai",
        auth_kind: null,
        account: null,
        unit: "usd",
        window: "daily",
        amount: 5,
      },
    ]);
  });

  test.each([
    "not-an-array",
    [
      {
        provider: "anthropic",
        unit: "usd",
        window: "daily",
        amount: 1,
        extra: 1,
      },
    ],
    [{ provider: "ANTHROPIC", unit: "usd", window: "daily", amount: 1 }],
    [{ provider: "anthropic", unit: "widgets", window: "daily", amount: 1 }],
    [{ provider: "anthropic", unit: "usd", window: "5h", amount: 1 }],
    [{ provider: "anthropic", unit: "percent", window: "daily", amount: 101 }],
    [{ provider: "anthropic", unit: "usd", window: "daily", amount: 0 }],
    [{ provider: "anthropic", unit: "usd", window: "daily", amount: NaN }],
    [{ provider: "anthropic", unit: "usd", window: "daily", amount: 2e9 }],
    [
      {
        provider: "anthropic",
        unit: "usd",
        window: "daily",
        amount: 1,
        auth_kind: "oauth",
      },
    ],
    [
      { provider: "anthropic", unit: "usd", window: "daily", amount: 1 },
      { provider: "anthropic", unit: "usd", window: "daily", amount: 2 },
    ],
    Array.from({ length: 51 }, () => ({
      provider: "anthropic",
      unit: "usd",
      window: "daily",
      amount: 1,
    })),
  ])("rejects invalid input %#", (input) => {
    expect(typeof parseProviderBudgets(input)).toBe("string");
  });

  test("daily + percent is rejected with a specific message", () => {
    expect(
      parseProviderBudgets([
        { provider: "anthropic", unit: "percent", window: "daily", amount: 50 },
      ]),
    ).toBe(
      'percent budgets apply to quota windows (5h/7d); daily budgets must be "usd" or "tokens".',
    );
  });

  test("different auth kinds on the same tuple are not duplicates", () => {
    const parsed = parseProviderBudgets([
      {
        provider: "anthropic",
        auth_kind: "api_key",
        unit: "usd",
        window: "daily",
        amount: 1,
      },
      {
        provider: "anthropic",
        auth_kind: "subscription",
        unit: "usd",
        window: "daily",
        amount: 1,
      },
    ]);
    expect(parsed).toHaveLength(2);
  });
});

describe("getProviderBudgets / setProviderBudgets", () => {
  test("round-trips through KV", () => {
    const list = [budget(), budget({ unit: "tokens", amount: 5000 })];
    setProviderBudgets(list);
    expect(getProviderBudgets()).toEqual(list);
  });

  test("corrupted JSON or invalid entries fall back to []", () => {
    setKV("provider_budgets", "{not json");
    expect(getProviderBudgets()).toEqual([]);
    setKV("provider_budgets", '[{"provider":"BAD","unit":"x"}]');
    expect(getProviderBudgets()).toEqual([]);
  });
});

describe("evaluateProviderBudgets", () => {
  test("daily usd sums today's rows; auth_kind null aggregates all kinds", () => {
    addProviderCost(costRow({ cost: 4 }));
    addProviderCost(costRow({ authKind: "api_key", cost: 4 }));
    setProviderBudgets([
      budget({ amount: 10 }),
      budget({ auth_kind: "subscription", amount: 10 }),
    ]);
    const statuses = evaluateProviderBudgets(NOW);
    expect(statuses[0]).toMatchObject({ used: 8, fraction: 0.8, stale: false });
    expect(statuses[1]).toMatchObject({ used: 4, fraction: 0.4, stale: false });
    expect(statuses[0]?.resets_at).toBe(Date.UTC(2099, 0, 2));
  });

  test("daily tokens sums all token columns; account filters", () => {
    addProviderCost(costRow());
    addProviderCost(costRow({ account: "acct2" }));
    setProviderBudgets([
      budget({ unit: "tokens", account: "acct1", amount: 330 }),
    ]);
    const statuses = evaluateProviderBudgets(NOW);
    expect(statuses[0]?.used).toBe(165);
    expect(statuses[0]?.fraction).toBeCloseTo(0.5);
  });

  test("percent window uses the latest quota snapshot", () => {
    upsertProviderQuota(quotaRow({ window: "5h", usedPercent: 40 }));
    upsertProviderQuota(
      quotaRow({ window: "5h", usedPercent: 60, observedAt: NOW - 30_000 }),
    );
    setProviderBudgets([budget({ unit: "percent", window: "5h", amount: 80 })]);
    const status = evaluateProviderBudgets(NOW)[0];
    expect(status).toMatchObject({
      used: 60,
      resets_at: NOW + 2 * 3600_000,
      stale: false,
    });
    expect(status?.fraction).toBeCloseTo(0.75);
  });

  test("rolled-over window reports used 0, stale, keeps observed resets_at", () => {
    upsertProviderQuota(
      quotaRow({ usedPercent: 90, resetsAt: NOW - 3600_000 }),
    );
    setProviderBudgets([budget({ unit: "percent", window: "5h", amount: 80 })]);
    expect(evaluateProviderBudgets(NOW)[0]).toMatchObject({
      used: 0,
      fraction: 0,
      resets_at: NOW - 3600_000,
      stale: true,
    });
  });

  test("snapshot older than its window reports unknown, not the stale value", () => {
    upsertProviderQuota(
      quotaRow({
        usedPercent: 90,
        resetsAt: null,
        observedAt: NOW - 6 * 3600_000,
      }),
    );
    setProviderBudgets([budget({ unit: "percent", window: "5h", amount: 80 })]);
    expect(evaluateProviderBudgets(NOW)[0]).toMatchObject({
      used: null,
      fraction: null,
      resets_at: null,
      stale: true,
    });
  });

  test("missing snapshot yields null used/fraction and stale", () => {
    setProviderBudgets([budget({ unit: "percent", window: "7d", amount: 80 })]);
    expect(evaluateProviderBudgets(NOW)[0]).toMatchObject({
      used: null,
      fraction: null,
      resets_at: null,
      stale: true,
    });
  });

  test("percent derives from limit/remaining when used_percent is null", () => {
    upsertProviderQuota(
      quotaRow({ usedPercent: null, limit: 100, remaining: 25 }),
    );
    setProviderBudgets([
      budget({ unit: "percent", window: "5h", amount: 100 }),
    ]);
    const status = evaluateProviderBudgets(NOW)[0];
    expect(status?.used).toBe(75);
    expect(status?.fraction).toBeCloseTo(0.75);
  });

  test("daily percent entries in KV are dropped before evaluation", () => {
    setKV(
      "provider_budgets",
      JSON.stringify([
        {
          provider: "anthropic",
          auth_kind: null,
          account: null,
          unit: "percent",
          window: "daily",
          amount: 50,
        },
      ]),
    );
    // First line of defense: the loader re-validates and drops the entry.
    expect(getProviderBudgets()).toEqual([]);
    expect(evaluateProviderBudgets(NOW)).toEqual([]);
  });

  test("quota rows for other auth kinds/accounts do not match", () => {
    upsertProviderQuota(quotaRow({ account: "other", usedPercent: 90 }));
    setProviderBudgets([
      budget({ unit: "percent", window: "5h", account: "acct1", amount: 80 }),
    ]);
    expect(evaluateProviderBudgets(NOW)[0]?.stale).toBe(true);
  });
});

describe("computeProviderBudgetPressure", () => {
  const match = {
    provider: "anthropic",
    auth_kind: "subscription",
    account: "acct1",
  };

  function status(fraction: number | null, overrides = {}) {
    return {
      ...budget({ auth_kind: "subscription", account: "acct1" }),
      used: 0,
      fraction,
      resets_at: null,
      stale: false,
      ...overrides,
    };
  }

  test("ramps from 0 at 50% to 1 at 100%", () => {
    const statuses = (f: number) => [status(f)];
    expect(computeProviderBudgetPressure(statuses(0.4), match)).toBe(0);
    expect(computeProviderBudgetPressure(statuses(0.75), match)).toBeCloseTo(
      0.5,
    );
    expect(computeProviderBudgetPressure(statuses(1.2), match)).toBe(1);
  });

  test("non-matching provider/auth/account contribute nothing", () => {
    expect(
      computeProviderBudgetPressure(
        [status(0.9, { provider: "openai" })],
        match,
      ),
    ).toBe(0);
    expect(
      computeProviderBudgetPressure(
        [status(0.9, { auth_kind: "api_key" })],
        match,
      ),
    ).toBe(0);
    expect(
      computeProviderBudgetPressure([status(0.9, { account: "other" })], match),
    ).toBe(0);
  });

  test("wildcard budgets match; max across mixed units wins", () => {
    const statuses = [
      status(0.9, { unit: "percent", window: "5h" }),
      status(0.6, { unit: "tokens" }),
      status(1.05, { auth_kind: null, account: null }),
    ];
    expect(computeProviderBudgetPressure(statuses, match)).toBe(1);
    // and without the saturated budget, the 90% one wins
    expect(
      computeProviderBudgetPressure(statuses.slice(0, 2), match),
    ).toBeCloseTo(0.8);
  });

  test("null fractions are ignored; null match is 0", () => {
    expect(computeProviderBudgetPressure([status(null)], match)).toBe(0);
    expect(computeProviderBudgetPressure([status(0.9)], null)).toBe(0);
  });
});
