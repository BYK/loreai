import { describe, expect, it } from "vitest";

import {
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
