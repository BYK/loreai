import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";

import { ProviderCards } from "~/components/lore/ProviderCards";
import type { CostsSnapshot } from "~/contracts";

type Providers = CostsSnapshot["providers"];
type Quotas = CostsSnapshot["quotas"];
type Pacing = CostsSnapshot["provider_pacing"];

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

function pacingWindow(
  overrides: Partial<Pacing[number]["windows"][number]> = {},
): Pacing[number]["windows"][number] {
  return {
    window: "5h",
    used: 23,
    resets_at: NOW + 2 * 3600_000 + 14 * 60_000,
    sustainable_rate: 34.6,
    current_rate: 8.1,
    rate_source: "average",
    ratio: 0.23,
    throttling: false,
    recommended_extra_gap_ms: 0,
    ...overrides,
  };
}

function pacingRow(overrides: Partial<Pacing[number]> = {}): Pacing[number] {
  return {
    provider: "anthropic",
    account: "a1b2c3d4e5f6",
    enabled: true,
    throttling: false,
    recommended_extra_gap_ms: 0,
    request_gap_ms: 12_000,
    windows: [pacingWindow()],
    ...overrides,
  };
}

function renderCards(
  providers: Providers,
  quotas: Quotas,
  pacing: Pacing = [],
  onSetPacing?: (setting: {
    provider: string;
    account: string;
    enabled: boolean;
  }) => Promise<void>,
) {
  return render(() => (
    <ProviderCards
      providers={providers}
      quotas={quotas}
      pacing={pacing}
      money={money}
      now={() => NOW}
      onSetPacing={onSetPacing}
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
});

describe("ProviderCards pacing", () => {
  it("shows sustainable rate and curation state without claiming request delays", () => {
    renderCards([providerRow()], [quotaRow()], [pacingRow()]);
    expect(screen.getByTestId("pacing-rates").textContent).toBe(
      "sustainable 35 pts/hcurrent 8.1 pts/h (window avg)",
    );
    expect(screen.getByTestId("pacing-state").textContent).toBe(
      "within sustainable rate",
    );
    expect(screen.getByTestId("pacing-curation-state").textContent).toBe(
      "inactive",
    );
    expect(screen.getByTestId("pacing-control").textContent).toContain(
      "Provider pacing never delays user requests.",
    );
    expect(
      screen.getByRole("switch", { name: "Automatic pacing" }),
    ).toHaveAttribute("aria-checked", "true");
    expect(screen.queryByTestId("budget-editor")).toBeNull();
    expect(screen.queryByText(/Edit budgets/)).toBeNull();
  });

  it("reports the curation pause without claiming to slow user requests", () => {
    renderCards(
      [providerRow()],
      [quotaRow()],
      [
        pacingRow({
          throttling: true,
          recommended_extra_gap_ms: 12_400,
          windows: [
            pacingWindow({
              current_rate: 69.2,
              rate_source: "observed",
              ratio: 2,
              throttling: true,
              recommended_extra_gap_ms: 12_400,
            }),
          ],
        }),
      ],
    );
    const state = screen.getByTestId("pacing-state");
    expect(state.textContent).toBe(
      "2.0× the sustainable rate — background curation paused",
    );
    expect(state.className).toContain("text-danger");
    expect(screen.getByTestId("pacing-rates").textContent).toBe(
      "sustainable 35 pts/hcurrent 69 pts/h",
    );
    expect(screen.getByTestId("pacing-curation-state").textContent).toBe(
      "active",
    );
    expect(screen.getByTestId("pacing-extra-gap").textContent).toBe("12s");
    expect(screen.queryByText("Current delay")).toBeNull();
    expect(
      screen.getByText(/gap estimate is informational only/i),
    ).not.toBeNull();
    expect(
      screen.getByText(/Provider pacing never delays user requests/),
    ).not.toBeNull();
  });

  it("expires the curation pause when its quota window resets", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const result = render(() => (
      <ProviderCards
        providers={[providerRow()]}
        quotas={[quotaRow()]}
        pacing={[
          pacingRow({
            throttling: true,
            recommended_extra_gap_ms: 12_400,
            windows: [
              pacingWindow({
                resets_at: NOW + 30_000,
                throttling: true,
                recommended_extra_gap_ms: 12_400,
              }),
            ],
          }),
        ]}
        money={money}
      />
    ));

    try {
      expect(screen.getByTestId("pacing-curation-state").textContent).toBe(
        "active",
      );
      vi.setSystemTime(NOW + 30_000);
      vi.advanceTimersByTime(30_000);
      expect(screen.getByTestId("pacing-curation-state").textContent).toBe(
        "inactive",
      );
      expect(screen.getByTestId("pacing-extra-gap").textContent).toBe("none");
    } finally {
      result.unmount();
      vi.useRealTimers();
    }
  });

  it("hides pacing for a stale window", () => {
    renderCards(
      [providerRow()],
      [quotaRow({ resets_at: NOW - 1 })],
      [pacingRow()],
    );
    expect(screen.queryByTestId("pacing-rates")).toBeNull();
  });

  it("API-key cards get no pacing switch", () => {
    renderCards(
      [providerRow({ auth_kind: "api_key", account: "k1" })],
      [],
      [pacingRow({ account: "k1" })],
    );
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByTestId("pacing-control")).toBeNull();
  });

  it("the switch is read-only without a handler (hosted mode)", () => {
    renderCards([providerRow()], [quotaRow()], [pacingRow()]);
    expect(screen.getByRole("switch")).toBeDisabled();
  });

  it("toggling sends { provider, account, enabled } and shows errors", async () => {
    const onSet = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("nope"));
    renderCards([providerRow()], [quotaRow()], [pacingRow()], onSet);
    const toggle = screen.getByRole("switch", { name: "Automatic pacing" });
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(onSet).toHaveBeenCalledWith({
        provider: "anthropic",
        account: "a1b2c3d4e5f6",
        enabled: false,
      }),
    );
    await waitFor(() => expect(toggle).not.toBeDisabled());
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe("Error: nope"),
    );
  });

  it("a disabled account says pacing off and has no curation pause", () => {
    renderCards(
      [providerRow()],
      [quotaRow()],
      [
        pacingRow({
          enabled: false,
          windows: [pacingWindow({ throttling: true, ratio: 3 })],
        }),
      ],
    );
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "false");
    expect(screen.getByTestId("pacing-state").textContent).toBe("pacing off");
    expect(screen.getByTestId("pacing-curation-state").textContent).toBe(
      "inactive",
    );
    expect(screen.getByTestId("pacing-extra-gap").textContent).toBe("off");
  });
});
