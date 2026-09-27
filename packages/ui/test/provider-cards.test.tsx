import { render, screen } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";

import { ProviderCards } from "~/components/lore/ProviderCards";
import type { CostsSnapshot } from "~/contracts";

type Providers = CostsSnapshot["providers"];
type Quotas = CostsSnapshot["quotas"];

const NOW = 1_800_000_000_000;
const money = (usd: number) => `$${usd.toFixed(4)}`;

function providerRow(
  overrides: Partial<Providers[number]> = {},
): Providers[number] {
  return {
    provider: "anthropic",
    auth_kind: "subscription",
    account: "a1b2c3d4e5f6",
    spend: 2.5,
    today_spend: 0.75,
    input_tokens: 12_000,
    output_tokens: 3_000,
    cache_read_tokens: 8_000,
    cache_write_tokens: 400,
    requests: 7,
    last_day: "2026-09-27",
    ...overrides,
  };
}

function quotaRow(overrides: Partial<Quotas[number]> = {}): Quotas[number] {
  return {
    provider: "anthropic",
    auth_kind: "subscription",
    account: "a1b2c3d4e5f6",
    window: "5h",
    label: null,
    window_minutes: 300,
    used_percent: 23,
    remaining: null,
    limit: null,
    resets_at: NOW + 2 * 3600_000 + 14 * 60_000,
    source: "anthropic-unified",
    observed_at: NOW,
    ...overrides,
  };
}

function renderCards(providers: Providers, quotas: Quotas) {
  return render(() => (
    <ProviderCards
      providers={providers}
      quotas={quotas}
      money={money}
      now={() => NOW}
    />
  ));
}

describe("ProviderCards", () => {
  it("renders a card per provider/auth pair with badge and metrics", () => {
    renderCards(
      [
        providerRow(),
        providerRow({
          provider: "openai",
          auth_kind: "api_key",
          account: "f6e5d4c3b2a1",
          spend: 0.5,
        }),
      ],
      [],
    );
    const cards = screen.getAllByTestId("provider-card");
    expect(cards).toHaveLength(2);
    expect(cards[0]?.getAttribute("data-auth-kind")).toBe("subscription");
    expect(cards[0]?.textContent).toContain("Anthropic");
    expect(cards[0]?.textContent).toContain("Subscription");
    expect(cards[0]?.textContent).toContain("$2.5000");
    expect(cards[0]?.textContent).toContain("$0.7500");
    expect(cards[0]?.textContent).toContain("8,000");
    expect(cards[0]?.textContent).toContain("· 400 written");
    expect(cards[0]?.textContent).toContain("2026-09-27");
    expect(cards[1]?.textContent).toContain("API key");
  });

  it("shows progressbars and countdowns for subscription quota windows", () => {
    const { container } = renderCards(
      [providerRow()],
      [
        quotaRow(),
        quotaRow({
          window: "7d",
          window_minutes: 10080,
          used_percent: 41,
          resets_at: NOW + 3 * 24 * 3600_000 + 4 * 3600_000,
        }),
      ],
    );
    const bars = container.querySelectorAll('[role="progressbar"]');
    expect(bars).toHaveLength(2);
    expect(bars[0]?.getAttribute("aria-valuenow")).toBe("23");
    expect(bars[1]?.getAttribute("aria-valuenow")).toBe("41");
    const card = container.querySelector('[data-testid="provider-card"]')!;
    expect(card.textContent).toContain("resets in 2h 14m");
    expect(card.textContent).toContain("resets in 3d 4h");
    expect(card.textContent).toContain("5-hour window");
    expect(card.textContent).toContain("Weekly window");
  });

  it("api-key card without quotas renders no progressbar", () => {
    const { container } = renderCards(
      [providerRow({ auth_kind: "api_key", account: "k" })],
      [],
    );
    expect(container.querySelector('[role="progressbar"]')).toBeNull();
  });

  it("quota-only card shows spend as an em dash", () => {
    renderCards([], [quotaRow()]);
    const card = screen.getByTestId("provider-card");
    expect(card.textContent).toContain("Spend");
    expect(card.textContent).toContain("—");
  });

  it("renders the empty state with no rows", () => {
    renderCards([], []);
    expect(screen.getByText("No provider costs yet")).toBeTruthy();
    expect(screen.queryAllByTestId("provider-card")).toHaveLength(0);
  });

  it("renders hostile provider ids as inert text", () => {
    renderCards([providerRow({ provider: '<img src=x onerror="pwn()">' })], []);
    const card = screen.getByTestId("provider-card");
    expect(card.textContent).toContain('<img src=x onerror="pwn()">');
    expect(card.querySelector("img")).toBeNull();
  });

  it("non-5h/7d windows render only when they carry numbers", () => {
    const { container } = renderCards(
      [],
      [
        quotaRow({
          window: "requests",
          used_percent: null,
          limit: 100,
          remaining: 42,
        }),
        quotaRow({ window: "empty-window", used_percent: null }),
        quotaRow({ window: "credits", used_percent: null, remaining: 10 }),
      ],
    );
    expect(container.textContent).toContain("requests");
    // limit+remaining derive a percent (58) → bar, not free text
    const bars = container.querySelectorAll('[role="progressbar"]');
    expect(
      Number(bars[bars.length - 1]?.getAttribute("aria-valuenow")),
    ).toBeCloseTo(58);
    expect(container.textContent).not.toContain("empty-window");
    // remaining alone (no limit) is not enough for a non-5h/7d window
    expect(container.textContent).not.toContain("credits");
  });
});
