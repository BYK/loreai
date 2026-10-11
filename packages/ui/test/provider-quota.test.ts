import { describe, expect, it } from "vitest";

import {
  displayProvider,
  formatDelay,
  formatRate,
  pacingForCard,
  pacingStateText,
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

describe("pacing helpers", () => {
  const window = {
    window: "5h",
    used: 40,
    resets_at: 0,
    sustainable_rate: 24,
    current_rate: 48,
    rate_source: "observed" as const,
    ratio: 2,
    throttling: true,
    delay_ms: 10_000,
  };

  it("pacingForCard matches subscription cards only", () => {
    const row = {
      provider: "anthropic",
      account: "a1",
      enabled: true,
      throttling: false,
      delay_ms: 0,
      request_gap_ms: null,
      windows: [],
    };
    const card = {
      provider: "anthropic",
      auth_kind: "subscription" as const,
      account: "a1",
    };
    expect(pacingForCard([row], card)).toBe(row);
    expect(pacingForCard([row], { ...card, account: "a2" })).toBeNull();
    expect(pacingForCard([row], { ...card, auth_kind: "api_key" })).toBeNull();
  });

  it("formats rates and delays", () => {
    expect(formatRate(null)).toBe("—");
    expect(formatRate(7.66)).toBe("7.7 pts/h");
    expect(formatRate(38.5)).toBe("39 pts/h");
    expect(formatDelay(0)).toBe("none");
    expect(formatDelay(4_200)).toBe("4.2s");
    expect(formatDelay(60_000)).toBe("60s");
  });

  it("pacingStateText covers off / on pace / throttling / limit", () => {
    expect(pacingStateText(window, false)).toBe("pacing off");
    expect(pacingStateText({ ...window, throttling: false }, true)).toBe(
      "on pace",
    );
    expect(pacingStateText(window, true)).toBe(
      "2.0× the sustainable rate — Lore is slowing requests",
    );
    expect(pacingStateText({ ...window, ratio: 0.95 }, true)).toBe(
      "holding pace — Lore is slowing requests",
    );
    expect(pacingStateText({ ...window, used: 100 }, true)).toBe(
      "limit reached — Lore is slowing requests",
    );
  });
});
