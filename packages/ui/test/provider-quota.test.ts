import { describe, expect, it } from "vitest";

import {
  applyBudgetEditor,
  budgetEditorState,
  budgetsForCard,
  evenPacePercent,
  explicitBudgets,
  paceFor,
  paceStateText,
  type BudgetRow,
  displayProvider,
  formatResetCountdown,
  groupProviderCards,
  quotaPercent,
  type ProviderRow,
  type QuotaRow,
} from "~/lib/provider-quota";

describe("displayProvider", () => {
  it.each([
    ["anthropic", "Anthropic"],
    ["openai", "OpenAI"],
    ["gemini", "Gemini"],
    ["vertex", "Vertex AI"],
    ["openrouter", "OpenRouter"],
    ["github-copilot", "GitHub Copilot"],
    ["bedrock", "Amazon Bedrock"],
    ["opencode", "OpenCode Zen"],
    ["opencode-go", "OpenCode Go"],
    ["google", "Gemini"],
    ["unknown", "Unknown provider"],
    ["minimax", "minimax"],
    ["<img>", "<img>"],
  ])("%s → %s", (id, expected) => {
    expect(displayProvider(id)).toBe(expected);
  });
});

function quota(overrides: Partial<QuotaRow> = {}): QuotaRow {
  return {
    provider: "anthropic",
    auth_kind: "subscription",
    account: "a1",
    window: "5h",
    label: null,
    window_minutes: 300,
    used_percent: null,
    remaining: null,
    limit: null,
    resets_at: null,
    source: "test",
    observed_at: 0,
    stale: false,
    ...overrides,
  };
}

function provider(overrides: Partial<ProviderRow> = {}): ProviderRow {
  return {
    provider: "anthropic",
    auth_kind: "subscription",
    account: "a1",
    spend: 1,
    today_spend: 1,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    requests: 1,
    last_day: "2026-09-27",
    ...overrides,
  };
}

describe("quotaPercent", () => {
  it("prefers used_percent", () => {
    expect(quotaPercent(quota({ used_percent: 42 }))).toBe(42);
    expect(
      quotaPercent(quota({ used_percent: 42, limit: 100, remaining: 90 })),
    ).toBe(42);
  });

  it("derives from limit/remaining", () => {
    expect(quotaPercent(quota({ limit: 200, remaining: 50 }))).toBe(75);
    expect(quotaPercent(quota({ limit: 100, remaining: 0 }))).toBe(100);
  });

  it("is null without usable numbers", () => {
    expect(quotaPercent(quota())).toBeNull();
    expect(quotaPercent(quota({ limit: 0, remaining: 0 }))).toBeNull();
    expect(quotaPercent(quota({ limit: 100 }))).toBeNull();
  });
});

describe("formatResetCountdown", () => {
  const now = 1_000_000;
  it("formats seconds, minutes, hours+minutes, days+hours", () => {
    expect(formatResetCountdown(now + 45_000, now)).toBe("resets in 45s");
    expect(formatResetCountdown(now + 5 * 60_000, now)).toBe("resets in 5m");
    expect(formatResetCountdown(now + (2 * 60 + 14) * 60_000, now)).toBe(
      "resets in 2h 14m",
    );
    expect(formatResetCountdown(now + (3 * 24 + 4) * 3600_000, now)).toBe(
      "resets in 3d 4h",
    );
    expect(formatResetCountdown(now + 3600_000, now)).toBe("resets in 1h");
  });

  it("handles past and null", () => {
    expect(formatResetCountdown(now - 1, now)).toBe("reset passed");
    expect(formatResetCountdown(now, now)).toBe("reset passed");
    expect(formatResetCountdown(null, now)).toBe("");
  });
});

describe("groupProviderCards", () => {
  it("merges cost and quota rows by (provider, auth_kind, account)", () => {
    const cards = groupProviderCards(
      [provider()],
      [quota({ window: "7d" }), quota({ window: "5h" })],
    );
    expect(cards).toHaveLength(1);
    expect(cards[0]?.costs?.spend).toBe(1);
    expect(cards[0]?.quotas.map((q) => q.window)).toEqual(["5h", "7d"]);
  });

  it("creates quota-only cards after cost cards", () => {
    const cards = groupProviderCards(
      [provider({ provider: "openai", auth_kind: "api_key", account: "o" })],
      [quota({ provider: "gemini", auth_kind: "api_key", account: "g" })],
    );
    expect(cards).toHaveLength(2);
    expect(cards[0]?.provider).toBe("openai");
    expect(cards[1]?.provider).toBe("gemini");
    expect(cards[1]?.costs).toBeNull();
  });

  it("keeps api_key and subscription cards for the same provider separate", () => {
    const cards = groupProviderCards(
      [
        provider({ auth_kind: "api_key", account: "k" }),
        provider({ auth_kind: "subscription", account: "s" }),
      ],
      [],
    );
    expect(cards.map((c) => c.auth_kind)).toEqual(["api_key", "subscription"]);
  });

  it("orders 5h, 7d first then other windows", () => {
    const cards = groupProviderCards(
      [],
      [
        quota({ window: "requests" }),
        quota({ window: "7d" }),
        quota({ window: "credits" }),
        quota({ window: "5h" }),
      ],
    );
    expect(cards[0]?.quotas.map((q) => q.window)).toEqual([
      "5h",
      "7d",
      "requests",
      "credits",
    ]);
  });
});

describe("budgetsForCard", () => {
  const card = {
    provider: "anthropic",
    auth_kind: "subscription" as const,
    account: "a1",
  };
  const budget = (
    o: Partial<Parameters<typeof budgetsForCard>[0][number]> = {},
  ) => ({
    provider: "anthropic",
    auth_kind: "subscription" as const,
    account: null,
    mode: "cap" as const,
    unit: "usd" as const,
    window: "day" as const,
    amount: 10,
    used: null,
    target: null,
    ahead: null,
    fraction: null,
    pressure: 0,
    resets_at: null,
    stale: false,
    implicit: false,
    status: "ok" as const,
    ...o,
  });

  it("matches the account wildcard and exact tuples, filters the rest", () => {
    const budgets = [
      budget(),
      budget({ account: "a1" }),
      budget({ auth_kind: "api_key" }),
      budget({ account: "other" }),
      budget({ provider: "openai" }),
    ];
    expect(budgetsForCard(budgets, card)).toHaveLength(2);
  });
});

describe("provider budget pacing + editor", () => {
  const card = {
    provider: "anthropic",
    auth_kind: "subscription" as const,
    account: "a1",
  };
  const status = (o: Partial<BudgetRow> = {}): BudgetRow => ({
    provider: "anthropic",
    auth_kind: "subscription",
    account: "a1",
    mode: "pace",
    window: "7d",
    headroom: 10,
    used: 41,
    target: 67,
    ahead: -26,
    fraction: null,
    pressure: 0,
    resets_at: 1,
    stale: false,
    implicit: true,
    status: "ok",
    ...o,
  });

  it("paceStateText covers on pace / ahead / stale / off / unknown", () => {
    expect(paceStateText(status(), false)).toBe("on pace");
    expect(
      paceStateText(
        status({ used: 80, ahead: 13.4, pressure: 1, status: "paused" }),
        false,
      ),
    ).toBe("ahead of pace by 13 pts — Lore is slowing background work");
    // Ahead by less than the ramp still slows; never rounds down to 0 pts.
    expect(paceStateText(status({ ahead: 0.3, pressure: 0.03 }), false)).toBe(
      "ahead of pace by 1 pts — Lore is slowing background work",
    );
    expect(paceStateText(status({ status: "stale", stale: true }), false)).toBe(
      "stale",
    );
    expect(paceStateText(status(), true)).toBe("stale");
    expect(
      paceStateText(status({ mode: "off", headroom: undefined }), false),
    ).toBe("pacing off");
    expect(
      paceStateText(
        status({ status: "unknown", target: null, ahead: null }),
        false,
      ),
    ).toBeNull();
    expect(paceStateText(null, false)).toBeNull();
  });

  it("evenPacePercent is target minus headroom, clamped", () => {
    expect(evenPacePercent(status())).toBe(57);
    expect(evenPacePercent(status({ target: 100, headroom: 10 }))).toBe(90);
    expect(evenPacePercent(status({ target: 5, headroom: 10 }))).toBe(0);
    expect(evenPacePercent(status({ target: null }))).toBeNull();
    expect(evenPacePercent(status({ mode: "off" }))).toBeNull();
  });

  it("paceFor prefers the card's own account over an account-less entry", () => {
    const wildcard = status({ account: null, mode: "off", implicit: false });
    const own = status({ headroom: 20, implicit: false });
    expect(paceFor([wildcard, own], card, "7d")).toBe(own);
    expect(paceFor([wildcard], card, "7d")).toBe(wildcard);
    expect(paceFor([own], card, "5h")).toBeNull();
  });

  it("explicitBudgets drops implicit rows and status fields", () => {
    expect(
      explicitBudgets([
        status(),
        status({ window: "5h", headroom: 25, implicit: false }),
        status({ mode: "off", window: "7d", implicit: false }),
        status({ mode: "cap", unit: "percent", amount: 80, implicit: false }),
      ]),
    ).toEqual([
      {
        provider: "anthropic",
        auth_kind: "subscription",
        account: "a1",
        mode: "pace",
        window: "5h",
        headroom: 25,
      },
      {
        provider: "anthropic",
        auth_kind: "subscription",
        account: "a1",
        mode: "off",
        window: "7d",
      },
      {
        provider: "anthropic",
        auth_kind: "subscription",
        account: "a1",
        mode: "cap",
        unit: "percent",
        window: "7d",
        amount: 80,
      },
    ]);
  });

  it("budgetEditorState reflects effective pace, headroom and caps", () => {
    const state = budgetEditorState(
      [
        status({ window: "5h", headroom: 25, implicit: false }),
        status({ mode: "off", window: "7d", implicit: false }),
        status({
          mode: "cap",
          unit: "percent",
          window: "7d",
          amount: 80,
          implicit: false,
        }),
      ],
      card,
    );
    expect(state).toEqual({
      kind: "subscription",
      windows: {
        "5h": { pace: true, headroom: "25", cap: "" },
        "7d": { pace: false, headroom: "10", cap: "80" },
      },
    });
    // No stored entries: the implicit default (pace on, 10 pts).
    expect(budgetEditorState([], card)).toEqual({
      kind: "subscription",
      windows: {
        "5h": { pace: true, headroom: "10", cap: "" },
        "7d": { pace: true, headroom: "10", cap: "" },
      },
    });
  });

  it("applyBudgetEditor replaces only this account's entries", () => {
    const other = status({
      account: "zz",
      window: "5h",
      headroom: 30,
      implicit: false,
    });
    const wildcardCap = status({
      account: null,
      mode: "cap",
      unit: "percent",
      amount: 90,
      implicit: false,
    });
    const own = status({ window: "5h", headroom: 25, implicit: false });
    const next = applyBudgetEditor([other, wildcardCap, own], card, {
      kind: "subscription",
      windows: {
        "5h": { pace: true, headroom: "10", cap: "" },
        "7d": { pace: false, headroom: "10", cap: "75" },
      },
    });
    expect(next).toEqual([
      {
        provider: "anthropic",
        auth_kind: "subscription",
        account: "zz",
        mode: "pace",
        window: "5h",
        headroom: 30,
      },
      {
        provider: "anthropic",
        auth_kind: "subscription",
        account: null,
        mode: "cap",
        unit: "percent",
        window: "7d",
        amount: 90,
      },
      // 5h back at the default headroom → left to the implicit budget.
      {
        provider: "anthropic",
        auth_kind: "subscription",
        account: "a1",
        mode: "off",
        window: "7d",
      },
      {
        provider: "anthropic",
        auth_kind: "subscription",
        account: "a1",
        mode: "cap",
        unit: "percent",
        window: "7d",
        amount: 75,
      },
    ]);
  });

  it("applyBudgetEditor stores default-headroom pace when an account-less off would win", () => {
    const wildcardOff = status({ account: null, mode: "off", implicit: false });
    const next = applyBudgetEditor([wildcardOff], card, {
      kind: "subscription",
      windows: {
        "5h": { pace: true, headroom: "10", cap: "" },
        "7d": { pace: true, headroom: "10", cap: "" },
      },
    });
    expect(next).toEqual([
      {
        provider: "anthropic",
        auth_kind: "subscription",
        account: null,
        mode: "off",
        window: "7d",
      },
      {
        provider: "anthropic",
        auth_kind: "subscription",
        account: "a1",
        mode: "pace",
        window: "7d",
        headroom: 10,
      },
    ]);
  });

  it("applyBudgetEditor writes API-key USD/token caps per day/week", () => {
    const keyCard = {
      provider: "openai",
      auth_kind: "api_key" as const,
      account: "k1",
    };
    expect(
      applyBudgetEditor([], keyCard, {
        kind: "api_key",
        caps: {
          usd_day: "5",
          usd_week: "",
          tokens_day: "",
          tokens_week: "2000000",
        },
      }),
    ).toEqual([
      {
        provider: "openai",
        auth_kind: "api_key",
        account: "k1",
        mode: "cap",
        unit: "usd",
        window: "day",
        amount: 5,
      },
      {
        provider: "openai",
        auth_kind: "api_key",
        account: "k1",
        mode: "cap",
        unit: "tokens",
        window: "week",
        amount: 2_000_000,
      },
    ]);
    expect(
      budgetEditorState(
        [
          status({
            provider: "openai",
            auth_kind: "api_key",
            account: "k1",
            mode: "cap",
            unit: "usd",
            window: "week",
            amount: 20,
            implicit: false,
          }),
        ],
        keyCard,
      ),
    ).toEqual({
      kind: "api_key",
      caps: { usd_day: "", usd_week: "20", tokens_day: "", tokens_week: "" },
    });
  });

  it("applyBudgetEditor rejects out-of-range input", () => {
    const sub = (
      w5: Partial<{ pace: boolean; headroom: string; cap: string }>,
    ) => ({
      kind: "subscription" as const,
      windows: {
        "5h": { pace: true, headroom: "10", cap: "", ...w5 },
        "7d": { pace: true, headroom: "10", cap: "" },
      },
    });
    expect(applyBudgetEditor([], card, sub({ headroom: "51" }))).toMatch(
      /0 and 50/,
    );
    expect(applyBudgetEditor([], card, sub({ headroom: "" }))).toMatch(
      /0 and 50/,
    );
    expect(applyBudgetEditor([], card, sub({ cap: "150" }))).toMatch(
      /0 and 100/,
    );
    expect(applyBudgetEditor([], card, sub({ cap: "abc" }))).toMatch(
      /0 and 100/,
    );
    // Disabled pacing ignores a junk headroom field.
    expect(
      applyBudgetEditor([], card, sub({ pace: false, headroom: "" })),
    ).toEqual([
      {
        provider: "anthropic",
        auth_kind: "subscription",
        account: "a1",
        mode: "off",
        window: "5h",
      },
    ]);
    expect(
      applyBudgetEditor(
        [],
        { ...card, auth_kind: "api_key" },
        {
          kind: "api_key",
          caps: {
            usd_day: "-1",
            usd_week: "",
            tokens_day: "",
            tokens_week: "",
          },
        },
      ),
    ).toMatch(/positive/);
  });
});
