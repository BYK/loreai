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
  providerBudgetPressure,
  ledgerWindowBounds,
  type ProviderBudgetStatus,
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

const HOUR = 3600_000;
const SUB = { provider: "anthropic", auth_kind: "subscription" as const };

function only(
  statuses: ProviderBudgetStatus[],
  filter: Partial<ProviderBudgetStatus>,
): ProviderBudgetStatus {
  const hits = statuses.filter((s) =>
    Object.entries(filter).every(
      ([key, value]) => (s as Record<string, unknown>)[key] === value,
    ),
  );
  expect(hits).toHaveLength(1);
  return hits[0]!;
}

describe("parseProviderBudgets", () => {
  test("accepts pace, off and cap entries; pace headroom defaults to 10", () => {
    const parsed = parseProviderBudgets([
      { ...SUB, mode: "pace", window: "7d" },
      { ...SUB, account: "acct1", mode: "off", window: "5h" },
      { ...SUB, mode: "cap", unit: "percent", window: "7d", amount: 80 },
      {
        provider: "openai",
        auth_kind: "api_key",
        account: null,
        mode: "cap",
        unit: "usd",
        window: "week",
        amount: 25,
      },
      {
        provider: "openai",
        auth_kind: "api_key",
        mode: "cap",
        unit: "tokens",
        window: "day",
        amount: 1e6,
      },
    ]);
    expect(parsed).toEqual([
      { ...SUB, account: null, mode: "pace", window: "7d", headroom: 10 },
      { ...SUB, account: "acct1", mode: "off", window: "5h" },
      {
        ...SUB,
        account: null,
        mode: "cap",
        unit: "percent",
        window: "7d",
        amount: 80,
      },
      {
        provider: "openai",
        auth_kind: "api_key",
        account: null,
        mode: "cap",
        unit: "usd",
        window: "week",
        amount: 25,
      },
      {
        provider: "openai",
        auth_kind: "api_key",
        account: null,
        mode: "cap",
        unit: "tokens",
        window: "day",
        amount: 1e6,
      },
    ]);
  });

  test.each([
    [
      "percent caps need a quota window",
      { ...SUB, mode: "cap", unit: "percent", window: "day", amount: 50 },
      /percent caps require window "5h" or "7d"/,
    ],
    [
      "usd caps need a ledger window",
      { ...SUB, mode: "cap", unit: "usd", window: "5h", amount: 5 },
      /usd caps require window "day" or "week"/,
    ],
    [
      "tokens caps need a ledger window",
      { ...SUB, mode: "cap", unit: "tokens", window: "7d", amount: 5 },
      /tokens caps require window "day" or "week"/,
    ],
    [
      "legacy daily window",
      { ...SUB, mode: "cap", unit: "usd", window: "daily", amount: 5 },
      /usd caps require window/,
    ],
    [
      "pace on an API key",
      { provider: "openai", auth_kind: "api_key", mode: "pace", window: "7d" },
      /auth_kind "subscription"/,
    ],
    [
      "pace on a ledger window",
      { ...SUB, mode: "pace", window: "week" },
      /window "5h" or "7d"/,
    ],
    [
      "headroom above 50",
      { ...SUB, mode: "pace", window: "5h", headroom: 51 },
      /headroom/,
    ],
    [
      "negative headroom",
      { ...SUB, mode: "pace", window: "5h", headroom: -1 },
      /headroom/,
    ],
    [
      "percent above 100",
      { ...SUB, mode: "cap", unit: "percent", window: "5h", amount: 101 },
      /amount/,
    ],
    [
      "zero amount",
      { ...SUB, mode: "cap", unit: "usd", window: "day", amount: 0 },
      /amount/,
    ],
    [
      "missing mode (legacy shape)",
      { ...SUB, unit: "usd", window: "day", amount: 5 },
      /mode/,
    ],
    [
      "field of another mode",
      { ...SUB, mode: "off", window: "5h", headroom: 5 },
      /unknown field "headroom"/,
    ],
    [
      "cap without auth_kind",
      {
        provider: "openai",
        mode: "cap",
        unit: "usd",
        window: "day",
        amount: 5,
      },
      /auth_kind/,
    ],
  ])("rejects %s", (_name, entry, message) => {
    const parsed = parseProviderBudgets([entry]);
    expect(typeof parsed).toBe("string");
    expect(parsed).toMatch(/^provider_budgets\[0\]: /);
    expect(parsed).toMatch(message);
  });

  test("pace and off share a window slot; caps coexist with pace", () => {
    expect(
      parseProviderBudgets([
        { ...SUB, mode: "pace", window: "7d" },
        { ...SUB, mode: "off", window: "7d" },
      ]),
    ).toMatch(/provider_budgets\[1\]: duplicate pace\/off entry/);
    expect(
      parseProviderBudgets([
        { ...SUB, mode: "pace", window: "7d" },
        { ...SUB, mode: "cap", unit: "percent", window: "7d", amount: 90 },
      ]),
    ).toHaveLength(2);
  });

  test("rejects non-arrays and oversized lists", () => {
    expect(parseProviderBudgets({})).toBe("provider_budgets must be an array.");
    expect(
      parseProviderBudgets(
        Array.from({ length: 51 }, (_, i) => ({
          ...SUB,
          account: `a${i}`,
          mode: "pace",
          window: "5h",
        })),
      ),
    ).toMatch(/at most 50/);
  });
});

describe("getProviderBudgets / setProviderBudgets", () => {
  test("round-trips through KV", () => {
    const list = parseProviderBudgets([
      { ...SUB, mode: "pace", window: "5h", headroom: 5 },
    ]);
    if (typeof list === "string") throw new Error(list);
    setProviderBudgets(list);
    expect(getProviderBudgets()).toEqual(list);
  });

  test("re-validates stored entries one by one, dropping invalid and duplicate ones", () => {
    setKV(
      "provider_budgets",
      JSON.stringify([
        // Pre-#1927-revision shape: no mode, "daily" window.
        {
          provider: "anthropic",
          auth_kind: null,
          account: null,
          unit: "usd",
          window: "daily",
          amount: 10,
        },
        { ...SUB, account: null, mode: "pace", window: "7d", headroom: 20 },
        { ...SUB, account: null, mode: "off", window: "7d" },
        "garbage",
        {
          ...SUB,
          account: null,
          mode: "cap",
          unit: "percent",
          window: "5h",
          amount: 90,
        },
      ]),
    );
    expect(getProviderBudgets()).toEqual([
      { ...SUB, account: null, mode: "pace", window: "7d", headroom: 20 },
      {
        ...SUB,
        account: null,
        mode: "cap",
        unit: "percent",
        window: "5h",
        amount: 90,
      },
    ]);
  });

  test("corrupt JSON and non-array values yield []", () => {
    setKV("provider_budgets", "{not json");
    expect(getProviderBudgets()).toEqual([]);
    setKV("provider_budgets", JSON.stringify({ provider: "anthropic" }));
    expect(getProviderBudgets()).toEqual([]);
  });
});

describe("pace evaluation", () => {
  // 5h window: 300 minutes. resetsAt sets how much of it has elapsed.
  function paceAt(elapsedFraction: number, used: number, headroom?: number) {
    upsertProviderQuota(
      quotaRow({
        usedPercent: used,
        // At 100% elapsed the window has not reset yet (1 ms left).
        resetsAt: NOW + Math.max(1, (1 - elapsedFraction) * 5 * HOUR),
        observedAt: NOW - 1000,
      }),
    );
    if (headroom !== undefined) {
      setProviderBudgets([
        { ...SUB, account: "acct1", mode: "pace", window: "5h", headroom },
      ]);
    }
    return only(evaluateProviderBudgets(NOW), { window: "5h" });
  }

  test("target is the even-pace line plus headroom at 0% / 50% / 100% elapsed", () => {
    expect(paceAt(0, 5).target).toBeCloseTo(10);
    clear();
    expect(paceAt(0.5, 5).target).toBeCloseTo(60);
    clear();
    expect(paceAt(1, 5).target).toBe(100);
    clear();
    expect(paceAt(0.5, 5, 0).target).toBeCloseTo(50);
    clear();
    expect(paceAt(0.5, 5, 25).target).toBeCloseTo(75);
  });

  test("on pace means no pressure", () => {
    const status = paceAt(0.5, 60);
    expect(status.ahead).toBeCloseTo(0);
    expect(status.pressure).toBe(0);
    expect(status.status).toBe("ok");
    expect(status.implicit).toBe(true);
  });

  test("ahead of target ramps pressure over PACE_RAMP (10 points)", () => {
    const half = paceAt(0.5, 65);
    expect(half.ahead).toBeCloseTo(5);
    expect(half.pressure).toBeCloseTo(0.5);
    expect(half.status).toBe("throttling");
    clear();
    const full = paceAt(0.5, 75);
    expect(full.pressure).toBe(1);
    expect(full.status).toBe("paused");
  });

  test("used 100% is pressure 1 even at the end of the window", () => {
    const status = paceAt(1, 100);
    expect(status.ahead).toBe(0);
    expect(status.pressure).toBe(1);
  });

  test("a stale window has pressure 0 and status stale", () => {
    upsertProviderQuota(
      quotaRow({
        usedPercent: 99,
        resetsAt: NOW - 1000,
        observedAt: NOW - 3 * HOUR,
      }),
    );
    const status = only(evaluateProviderBudgets(NOW), { window: "5h" });
    expect(status).toMatchObject({
      stale: true,
      status: "stale",
      pressure: 0,
      used: null,
    });
  });

  test("an unknown window length cannot be paced", () => {
    upsertProviderQuota(quotaRow({ windowMinutes: null, usedPercent: 99 }));
    const status = only(evaluateProviderBudgets(NOW), { window: "5h" });
    expect(status).toMatchObject({
      status: "unknown",
      pressure: 0,
      target: null,
      used: 99,
    });
  });
});

describe("implicit pace budgets", () => {
  test("every subscription account with 5h/7d quota rows is paced by default", () => {
    upsertProviderQuota(quotaRow({ window: "5h" }));
    upsertProviderQuota(
      quotaRow({
        window: "7d",
        windowMinutes: 10080,
        resetsAt: NOW + 3 * 24 * HOUR,
      }),
    );
    upsertProviderQuota(
      quotaRow({
        account: "acct2",
        window: "7d",
        windowMinutes: 10080,
        resetsAt: NOW + 24 * HOUR,
      }),
    );
    upsertProviderQuota(
      quotaRow({ authKind: "api_key", account: "key1", window: "requests" }),
    );
    const statuses = evaluateProviderBudgets(NOW);
    expect(
      statuses.map((s) => [
        s.account,
        s.window,
        s.mode,
        s.implicit,
        s.mode === "pace" ? s.headroom : null,
      ]),
    ).toEqual([
      ["acct1", "5h", "pace", true, 10],
      ["acct1", "7d", "pace", true, 10],
      ["acct2", "7d", "pace", true, 10],
    ]);
  });

  test("an explicit pace entry overrides the implicit one for that window", () => {
    upsertProviderQuota(quotaRow({ window: "5h" }));
    upsertProviderQuota(
      quotaRow({
        window: "7d",
        windowMinutes: 10080,
        resetsAt: NOW + 3 * 24 * HOUR,
      }),
    );
    setProviderBudgets([
      { ...SUB, account: "acct1", mode: "pace", window: "7d", headroom: 30 },
    ]);
    const statuses = evaluateProviderBudgets(NOW);
    expect(statuses.map((s) => [s.window, s.implicit])).toEqual([
      ["7d", false],
      ["5h", true],
    ]);
    expect(only(statuses, { window: "7d" })).toMatchObject({ headroom: 30 });
  });

  test("explicit off disables pacing; an account-less entry covers every account", () => {
    upsertProviderQuota(quotaRow({ window: "5h" }));
    upsertProviderQuota(quotaRow({ account: "acct2", window: "5h" }));
    setProviderBudgets([{ ...SUB, account: null, mode: "off", window: "5h" }]);
    const statuses = evaluateProviderBudgets(NOW);
    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toMatchObject({
      mode: "off",
      status: "off",
      pressure: 0,
      implicit: false,
    });
  });

  test("a percent cap does not disable implicit pacing", () => {
    upsertProviderQuota(quotaRow({ window: "5h" }));
    setProviderBudgets([
      {
        ...SUB,
        account: "acct1",
        mode: "cap",
        unit: "percent",
        window: "5h",
        amount: 80,
      },
    ]);
    const statuses = evaluateProviderBudgets(NOW);
    expect(statuses.map((s) => [s.mode, s.implicit])).toEqual([
      ["cap", false],
      ["pace", true],
    ]);
  });
});

describe("cap evaluation", () => {
  test("percent cap: 50%-floor ramp on the quota fraction", () => {
    upsertProviderQuota(quotaRow({ usedPercent: 60 }));
    setProviderBudgets([
      {
        ...SUB,
        account: "acct1",
        mode: "cap",
        unit: "percent",
        window: "5h",
        amount: 80,
      },
      { ...SUB, account: "acct1", mode: "off", window: "5h" },
    ]);
    const cap = only(evaluateProviderBudgets(NOW), { mode: "cap" });
    expect(cap.fraction).toBeCloseTo(0.75);
    expect(cap.pressure).toBeCloseTo(0.5);
    expect(cap.target).toBeNull();
    expect(cap.ahead).toBeNull();
  });

  test("usd day cap: no pressure below half or at a sustainable rate", () => {
    setProviderBudgets([
      {
        provider: "anthropic",
        auth_kind: "subscription",
        account: null,
        mode: "cap",
        unit: "usd",
        window: "day",
        amount: 10,
      },
    ]);
    addProviderCost(costRow({ cost: 4 }));
    let cap = only(evaluateProviderBudgets(NOW), { mode: "cap" });
    expect(cap).toMatchObject({ used: 4, pressure: 0, status: "ok" });
    expect(cap.resets_at).toBe(Date.UTC(2099, 0, 2));
    // 6 USD by 23:00: 0.26 USD/h average vs 4 USD left over the last hour.
    addProviderCost(costRow({ cost: 2, account: "acct2" }));
    cap = only(evaluateProviderBudgets(Date.UTC(2099, 0, 1, 23)), {
      mode: "cap",
    });
    expect(cap.used).toBe(6);
    expect(cap.pressure).toBe(0);
  });

  test("usd day cap: rate overshoot keeps the original ramp² × tanh curve", () => {
    setProviderBudgets([
      {
        provider: "anthropic",
        auth_kind: "subscription",
        account: "acct1",
        mode: "cap",
        unit: "usd",
        window: "day",
        amount: 10,
      },
    ]);
    addProviderCost(costRow({ cost: 6 }));
    const cap = only(evaluateProviderBudgets(NOW), { mode: "cap" });
    // rate 0.5/h vs sustainable 4/12h → overshoot 0.5
    const expected = 0.2 * Math.sqrt(Math.tanh(0.5 / 3));
    expect(cap.pressure).toBeCloseTo(expected);
    expect(cap.pressure ** 2 * 60).toBeCloseTo(60 * 0.04 * Math.tanh(0.5 / 3));
    addProviderCost(costRow({ cost: 4 }));
    expect(only(evaluateProviderBudgets(NOW), { mode: "cap" }).pressure).toBe(
      1,
    );
  });

  test("tokens cap sums all token columns", () => {
    setProviderBudgets([
      {
        provider: "anthropic",
        auth_kind: "subscription",
        account: "acct1",
        mode: "cap",
        unit: "tokens",
        window: "day",
        amount: 1000,
      },
    ]);
    addProviderCost(costRow());
    expect(only(evaluateProviderBudgets(NOW), { mode: "cap" }).used).toBe(165);
  });

  describe("week window", () => {
    // 2026-10-12 is a Monday.
    const WED = Date.UTC(2026, 9, 14, 12);
    const NEXT_MON = Date.UTC(2026, 9, 19, 0, 30);

    test("bounds are the ISO week from Monday 00:00 UTC", () => {
      expect(ledgerWindowBounds("week", WED)).toEqual({
        start: Date.UTC(2026, 9, 12),
        end: Date.UTC(2026, 9, 19),
      });
      expect(ledgerWindowBounds("week", Date.UTC(2026, 9, 18, 23, 59))).toEqual(
        {
          start: Date.UTC(2026, 9, 12),
          end: Date.UTC(2026, 9, 19),
        },
      );
      expect(ledgerWindowBounds("week", NEXT_MON).start).toBe(
        Date.UTC(2026, 9, 19),
      );
    });

    test("sums Monday..today and resets on Monday", () => {
      setProviderBudgets([
        {
          provider: "openai",
          auth_kind: "api_key",
          account: "key1",
          mode: "cap",
          unit: "usd",
          window: "week",
          amount: 100,
        },
      ]);
      const row = (day: string, cost: number) =>
        addProviderCost(
          costRow({
            day,
            cost,
            provider: "openai",
            authKind: "api_key",
            account: "key1",
          }),
        );
      row("2026-10-11", 50); // previous week's Sunday
      row("2026-10-12", 3);
      row("2026-10-14", 4);
      row("2026-10-19", 7); // next week
      let cap = only(evaluateProviderBudgets(WED), { mode: "cap" });
      expect(cap.used).toBe(7);
      expect(cap.resets_at).toBe(Date.UTC(2026, 9, 19));
      cap = only(evaluateProviderBudgets(NEXT_MON), { mode: "cap" });
      expect(cap.used).toBe(7);
      expect(cap.resets_at).toBe(Date.UTC(2026, 9, 26));
      row("2026-10-19", 1);
      expect(
        only(evaluateProviderBudgets(NEXT_MON), { mode: "cap" }).used,
      ).toBe(8);
    });
  });
});

describe("providerBudgetPressure", () => {
  const MATCH = {
    provider: "anthropic",
    auth_kind: "subscription" as const,
    account: "acct1",
  };

  test("is the max over matching budgets and names the one that tripped", () => {
    upsertProviderQuota(
      quotaRow({ usedPercent: 65, resetsAt: NOW + 2.5 * HOUR }),
    );
    setProviderBudgets([
      {
        ...SUB,
        account: "acct1",
        mode: "cap",
        unit: "percent",
        window: "5h",
        amount: 100,
      },
    ]);
    const result = providerBudgetPressure(MATCH, NOW);
    expect(result.pressure).toBeCloseTo(0.5);
    expect(result.budget).toMatchObject({
      mode: "pace",
      implicit: true,
      window: "5h",
    });
  });

  test("other accounts, auth kinds and providers are unaffected", () => {
    upsertProviderQuota(quotaRow({ usedPercent: 100 }));
    expect(providerBudgetPressure(MATCH, NOW).pressure).toBe(1);
    expect(
      providerBudgetPressure({ ...MATCH, account: "acct2" }, NOW).pressure,
    ).toBe(0);
    expect(
      providerBudgetPressure({ ...MATCH, auth_kind: "api_key" }, NOW).pressure,
    ).toBe(0);
    expect(
      providerBudgetPressure({ ...MATCH, provider: "openai" }, NOW).pressure,
    ).toBe(0);
    expect(providerBudgetPressure(null, NOW)).toEqual({
      pressure: 0,
      budget: null,
    });
  });

  test("an account-less pace budget evaluates the attribution's own account", () => {
    upsertProviderQuota(quotaRow({ usedPercent: 100 }));
    upsertProviderQuota(quotaRow({ account: "acct2", usedPercent: 1 }));
    setProviderBudgets([
      { ...SUB, account: null, mode: "pace", window: "5h", headroom: 10 },
    ]);
    expect(providerBudgetPressure(MATCH, NOW).pressure).toBe(1);
    expect(
      providerBudgetPressure({ ...MATCH, account: "acct2" }, NOW).pressure,
    ).toBe(0);
    // The snapshot reports the worst account.
    expect(only(evaluateProviderBudgets(NOW), { mode: "pace" })).toMatchObject({
      account: null,
      pressure: 1,
    });
  });

  test("off silences pacing entirely", () => {
    upsertProviderQuota(quotaRow({ usedPercent: 100 }));
    setProviderBudgets([
      { ...SUB, account: "acct1", mode: "off", window: "5h" },
    ]);
    expect(providerBudgetPressure(MATCH, NOW).pressure).toBe(0);
  });

  test("a leftover global daily_budget KV row has no effect", () => {
    setKV("daily_budget", "0.01");
    addProviderCost(costRow({ cost: 500 }));
    expect(providerBudgetPressure(MATCH, NOW).pressure).toBe(0);
  });
});
