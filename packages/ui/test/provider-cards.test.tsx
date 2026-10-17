import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";

import { ProviderCards } from "~/components/lore/ProviderCards";
import type { CostsSnapshot } from "~/contracts";

type Providers = CostsSnapshot["providers"];
type Quotas = CostsSnapshot["quotas"];
type Budgets = CostsSnapshot["provider_budgets"];

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
    stale: false,
    ...overrides,
  };
}

function budgetRow(overrides: Partial<Budgets[number]> = {}): Budgets[number] {
  return {
    provider: "anthropic",
    auth_kind: "subscription",
    account: "a1b2c3d4e5f6",
    mode: "cap",
    unit: "percent",
    window: "7d",
    amount: 80,
    used: 41,
    target: null,
    ahead: null,
    fraction: 41 / 80,
    pressure: 0,
    resets_at: NOW + 3 * 24 * 3600_000,
    stale: false,
    implicit: false,
    status: "ok",
    ...overrides,
  };
}

function renderCards(
  providers: Providers,
  quotas: Quotas,
  budgets: Budgets = [],
) {
  return render(() => (
    <ProviderCards
      providers={providers}
      quotas={quotas}
      budgets={budgets}
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

  it("stale snapshot (resets_at passed) renders no bar and a stale note", () => {
    const { container } = renderCards(
      [],
      [quotaRow({ resets_at: NOW - 60_000, observed_at: NOW - 120_000 })],
    );
    expect(container.querySelector('[role="progressbar"]')).toBeNull();
    expect(container.textContent).toMatch(/last seen .* ago, may have reset/);
  });

  it("snapshot older than its window degrades to stale", () => {
    const { container } = renderCards(
      [],
      [
        quotaRow({
          window: "5h",
          window_minutes: 300,
          resets_at: null,
          observed_at: NOW - 6 * 3600_000,
        }),
      ],
    );
    expect(container.querySelector('[role="progressbar"]')).toBeNull();
    expect(container.textContent).toMatch(/last seen .* ago, may have reset/);
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

  it("shows matching budgets with used/amount and stale suffix", () => {
    renderCards(
      [providerRow()],
      [],
      [
        budgetRow(),
        budgetRow({
          unit: "usd",
          window: "day",
          amount: 10,
          used: 12.5,
          fraction: 1.25,
          pressure: 1,
        }),
        budgetRow({
          unit: "tokens",
          window: "week",
          amount: 100_000,
          used: null,
          fraction: null,
          stale: true,
          status: "stale",
        }),
        budgetRow({
          mode: "pace",
          unit: undefined,
          amount: undefined,
          headroom: 10,
          window: "5h",
          used: 30,
          target: 52,
          ahead: -22,
          fraction: null,
          implicit: true,
        }),
        budgetRow({
          mode: "off",
          unit: undefined,
          amount: undefined,
          window: "7d",
          used: null,
          fraction: null,
          status: "off",
        }),
        // wrong auth_kind and wrong provider — filtered out
        budgetRow({ auth_kind: "api_key" }),
        budgetRow({ provider: "openai" }),
      ],
    );
    const card = screen.getByTestId("provider-card");
    expect(card.textContent).toContain("Budgets");
    expect(card.textContent).toContain("Quota cap · 7d");
    expect(card.textContent).toContain("41% / 80%");
    expect(card.textContent).toContain("USD cap · day");
    expect(card.textContent).toContain("$12.5000 / $10.0000");
    expect(card.textContent).toContain("Tokens cap · week");
    expect(card.textContent).toContain("Pace · 5h");
    expect(card.textContent).toContain("30% / 52% pace");
    expect(card.textContent).toContain("Pace off · 7d");
    expect(card.textContent).toContain("—");
    expect(card.textContent).toContain("(stale)");
  });

  it("marks over-budget rows with text-danger", () => {
    renderCards(
      [providerRow()],
      [],
      [budgetRow({ used: 90, fraction: 90 / 80, pressure: 1 })],
    );
    const danger = screen
      .getByTestId("provider-card")
      .querySelector(".text-danger");
    expect(danger?.textContent).toContain("90% / 80%");
  });
});

function paceRow(overrides: Partial<Budgets[number]> = {}): Budgets[number] {
  return budgetRow({
    mode: "pace",
    unit: undefined,
    amount: undefined,
    window: "5h",
    headroom: 10,
    used: 23,
    target: 70,
    ahead: -47,
    fraction: null,
    implicit: true,
    ...overrides,
  });
}

describe("ProviderCards pacing", () => {
  it("draws the even-pace tick at target − headroom and says on pace", () => {
    renderCards([providerRow()], [quotaRow()], [paceRow()]);
    const tick = screen.getByTestId("pace-tick");
    expect(tick.style.left).toBe("60%");
    expect(screen.getByTestId("pace-state").textContent).toBe("on pace");
  });

  it("says how far ahead of pace and that Lore is slowing", () => {
    renderCards(
      [providerRow()],
      [quotaRow({ used_percent: 82 })],
      [paceRow({ used: 82, ahead: 12, pressure: 1, status: "paused" })],
    );
    const state = screen.getByTestId("pace-state");
    expect(state.textContent).toBe(
      "ahead of pace by 12 pts — Lore is slowing background work",
    );
    expect(state.className).toContain("text-danger");
  });

  it("marks a stale window and hides the tick", () => {
    renderCards(
      [providerRow()],
      [quotaRow({ stale: true })],
      [paceRow({ stale: true, status: "stale", target: null, ahead: null })],
    );
    expect(screen.queryByTestId("pace-tick")).toBeNull();
    expect(screen.getByTestId("pace-state").textContent).toBe("stale");
  });
});

describe("ProviderCards budget editor", () => {
  it("is absent without a save handler (hosted mode)", () => {
    renderCards([providerRow()], [quotaRow()], [paceRow()]);
    expect(screen.queryByRole("button", { name: "Edit budgets" })).toBeNull();
  });

  it("saves subscription pace/headroom/cap via onSaveBudgets", async () => {
    const onSave = vi.fn(async () => {});
    render(() => (
      <ProviderCards
        providers={[providerRow()]}
        quotas={[quotaRow()]}
        budgets={[paceRow(), paceRow({ window: "7d" })]}
        money={money}
        now={() => NOW}
        onSaveBudgets={onSave}
      />
    ));
    fireEvent.click(screen.getByRole("button", { name: "Edit budgets" }));
    fireEvent.input(
      screen.getByLabelText("Pace headroom for the 5h window (points)"),
      { target: { value: "20" } },
    );
    fireEvent.click(screen.getByLabelText("Pace the 7d window"));
    fireEvent.input(screen.getByLabelText("Quota cap for the 7d window (%)"), {
      target: { value: "90" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save budgets" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const scope = {
      provider: "anthropic",
      auth_kind: "subscription",
      account: "a1b2c3d4e5f6",
    };
    expect(onSave).toHaveBeenCalledWith([
      { ...scope, mode: "pace", window: "5h", headroom: 20 },
      { ...scope, mode: "off", window: "7d" },
      { ...scope, mode: "cap", unit: "percent", window: "7d", amount: 90 },
    ]);
    await waitFor(() =>
      expect(screen.queryByTestId("budget-editor")).toBeNull(),
    );
  });

  it("shows validation and save errors inline without closing", async () => {
    const onSave = vi.fn(async () => {
      throw new Error("boom");
    });
    render(() => (
      <ProviderCards
        providers={[
          providerRow({
            provider: "openai",
            auth_kind: "api_key",
            account: "k1",
          }),
        ]}
        quotas={[]}
        budgets={[]}
        money={money}
        now={() => NOW}
        onSaveBudgets={onSave}
      />
    ));
    fireEvent.click(screen.getByRole("button", { name: "Edit budgets" }));
    fireEvent.input(screen.getByLabelText("USD cap per day"), {
      target: { value: "0" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save budgets" }));
    expect(screen.getByRole("alert").textContent).toMatch(/positive/);
    expect(onSave).not.toHaveBeenCalled();

    fireEvent.input(screen.getByLabelText("USD cap per day"), {
      target: { value: "5" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save budgets" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("boom"),
    );
    expect(onSave).toHaveBeenCalledWith([
      {
        provider: "openai",
        auth_kind: "api_key",
        account: "k1",
        mode: "cap",
        unit: "usd",
        window: "day",
        amount: 5,
      },
    ]);
    expect(screen.getByTestId("budget-editor")).toBeTruthy();
  });
});
