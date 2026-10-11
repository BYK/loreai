import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { db, upsertProviderQuota, type ProviderQuotaRow } from "@loreai/core";
import {
  MAX_PACING_DELAY_MS,
  _resetPacingTrackerForTest,
  computePacingDelayMs,
  evaluatePacingWindow,
  evaluateProviderPacing,
  integrateHeldDelayMs,
  getPacingSettings,
  isCurationPacingPaused,
  isPacingEnabled,
  pacingDelayMs,
  parsePacingSetting,
  recordForegroundRequest,
  recordQuotaObservation,
  setPacingEnabled,
  type BudgetMatch,
  type PacingWindowInput,
} from "../src/provider-budgets";
import { observeProviderQuotaHeaders } from "../src/provider-quota-headers";

const NOW = Date.UTC(2099, 0, 1, 12, 0, 0);
const HOUR = 3_600_000;
const FIVE_H = 5 * HOUR;
const MATCH: BudgetMatch = {
  provider: "anthropic",
  auth_kind: "subscription",
  account: "acct1",
};

function clear(): void {
  db().exec("DELETE FROM provider_quotas");
  db().query("DELETE FROM kv_meta WHERE key = ?").run("provider_pacing");
  _resetPacingTrackerForTest();
}

beforeEach(clear);
afterEach(clear);

function quotaRow(overrides: Partial<ProviderQuotaRow> = {}): ProviderQuotaRow {
  return {
    provider: "anthropic",
    authKind: "subscription",
    account: "acct1",
    window: "5h",
    label: null,
    windowMinutes: 300,
    usedPercent: 60,
    remaining: null,
    limit: null,
    resetsAt: NOW + 2.5 * HOUR,
    source: "anthropic-unified",
    observedAt: NOW - 60_000,
    ...overrides,
  };
}

/** Window with `u` used, `T` ms to reset and observed rate `ρ · s`. */
function windowAt(
  used: number,
  T: number,
  rho: number | null,
  window = "5h",
  windowMs = FIVE_H,
  heldDelayMs = 0,
): PacingWindowInput {
  const s = (100 - used) / T;
  return {
    window,
    used,
    resetsAt: NOW + T,
    windowMs,
    observedRate: rho === null ? null : rho * s,
    heldDelayMs,
  };
}

/** Two foreground requests `gap` ms apart, the last one at NOW. */
function gapOf(gap: number): void {
  recordForegroundRequest(MATCH, NOW - gap);
  recordForegroundRequest(MATCH, NOW);
}

describe("pacing delay formula", () => {
  // Average-rate fallback (< 2 samples): u = 60 after 2.5h of 5h → r = 24 %/h,
  // s = 16 %/h, ρ = 1.5. u = 40 after 2.5h → r = 16, s = 24, ρ < 1.
  test("r ≤ s → no delay", () => {
    expect(
      computePacingDelayMs([windowAt(40, 2.5 * HOUR, null)], 10_000, NOW),
    ).toBe(0);
    expect(integrateHeldDelayMs(0, 10_000, 1)).toBe(0);
    expect(integrateHeldDelayMs(0, 10_000, 0.5)).toBe(0);
  });

  test("ρ = 2 with g = 10 s → 10 s", () => {
    expect(integrateHeldDelayMs(0, 10_000, 2)).toBe(10_000);
    // The held delay is what an observed-rate window applies.
    expect(
      computePacingDelayMs(
        [windowAt(50, 2 * HOUR, 2, "5h", FIVE_H, 10_000)],
        10_000,
        NOW,
      ),
    ).toBe(10_000);
  });

  test("delay is capped at 60 s", () => {
    expect(integrateHeldDelayMs(0, 10_000, 10)).toBe(MAX_PACING_DELAY_MS);
    expect(integrateHeldDelayMs(55_000, 10_000, 2)).toBe(MAX_PACING_DELAY_MS);
    // Stateless fallback: u = 95 after 4h of 5h → r = 23.75, s = 5 %/h,
    // ρ = 4.75; g = 20 s → 75 s, capped.
    expect(computePacingDelayMs([windowAt(95, HOUR, null)], 20_000, NOW)).toBe(
      MAX_PACING_DELAY_MS,
    );
    expect(MAX_PACING_DELAY_MS).toBe(60_000);
  });

  test("u ≥ 100 → maximum delay, even without a gap estimate", () => {
    expect(computePacingDelayMs([windowAt(100, HOUR, null)], null, NOW)).toBe(
      MAX_PACING_DELAY_MS,
    );
    expect(
      computePacingDelayMs(
        [windowAt(100, HOUR, 0.5, "5h", FIVE_H, 0)],
        null,
        NOW,
      ),
    ).toBe(MAX_PACING_DELAY_MS);
  });

  test("fewer than 2 samples falls back to r = u / (L - T) and the stateless g · (ρ − 1)", () => {
    const status = evaluatePacingWindow(
      windowAt(60, 2.5 * HOUR, null),
      10_000,
      NOW,
    );
    expect(status?.rate_source).toBe("average");
    expect(status?.current_rate).toBeCloseTo(24, 9);
    expect(status?.sustainable_rate).toBeCloseTo(16, 9);
    expect(status?.ratio).toBeCloseTo(1.5, 9);
    expect(status?.delay_ms).toBeCloseTo(5_000, 6);
  });

  test("an observed-rate window applies its held delay, whatever ρ is now", () => {
    const below = evaluatePacingWindow(
      windowAt(50, 2 * HOUR, 0.9, "5h", FIVE_H, 7_000),
      10_000,
      NOW,
    );
    expect(below).toMatchObject({ throttling: false, delay_ms: 7_000 });
  });

  test("the larger of the two windows wins", () => {
    const fiveHour = windowAt(50, 2 * HOUR, 2, "5h", FIVE_H, 10_000);
    const sevenDay = windowAt(
      50,
      3 * 24 * HOUR,
      3,
      "7d",
      7 * 24 * HOUR,
      20_000,
    );
    expect(computePacingDelayMs([fiveHour], 10_000, NOW)).toBe(10_000);
    expect(computePacingDelayMs([fiveHour, sevenDay], 10_000, NOW)).toBe(
      20_000,
    );
    expect(computePacingDelayMs([sevenDay, fiveHour], 10_000, NOW)).toBe(
      20_000,
    );
  });

  test("no foreground gap yet → no delay below the limit", () => {
    expect(
      computePacingDelayMs([windowAt(60, 2.5 * HOUR, null)], null, NOW),
    ).toBe(0);
    expect(integrateHeldDelayMs(4_000, null, 3)).toBe(4_000);
  });

  test("a window that already reset is ignored", () => {
    expect(computePacingDelayMs([windowAt(100, 0, null)], 10_000, NOW)).toBe(0);
  });
});

describe("pacingDelayMs (quota rows + tracker)", () => {
  test("uses the window-average fallback and the request-gap EWMA", () => {
    upsertProviderQuota(quotaRow());
    gapOf(10_000);
    expect(pacingDelayMs(MATCH, NOW)).toBeCloseTo(5_000, 6);
  });

  test("disabled → 0, and curation is not paused", () => {
    upsertProviderQuota(quotaRow({ usedPercent: 100 }));
    gapOf(10_000);
    expect(pacingDelayMs(MATCH, NOW)).toBe(MAX_PACING_DELAY_MS);
    expect(isCurationPacingPaused(MATCH, NOW)).toBe(true);

    setPacingEnabled({
      provider: "anthropic",
      account: "acct1",
      enabled: false,
    });
    expect(isPacingEnabled("anthropic", "acct1")).toBe(false);
    expect(pacingDelayMs(MATCH, NOW)).toBe(0);
    expect(isCurationPacingPaused(MATCH, NOW)).toBe(false);
    expect(evaluateProviderPacing(NOW)).toEqual([
      expect.objectContaining({
        enabled: false,
        delay_ms: 0,
        throttling: false,
      }),
    ]);

    setPacingEnabled({
      provider: "anthropic",
      account: "acct1",
      enabled: true,
    });
    expect(getPacingSettings()).toEqual([]);
    expect(pacingDelayMs(MATCH, NOW)).toBe(MAX_PACING_DELAY_MS);
  });

  test("API-key accounts are never paced", () => {
    upsertProviderQuota(quotaRow({ authKind: "api_key", usedPercent: 100 }));
    const apiKey: BudgetMatch = { ...MATCH, auth_kind: "api_key" };
    gapOf(10_000);
    expect(pacingDelayMs(apiKey, NOW)).toBe(0);
    expect(isCurationPacingPaused(apiKey, NOW)).toBe(false);
    expect(evaluateProviderPacing(NOW)).toEqual([]);
  });

  test("stale rows do not pace", () => {
    upsertProviderQuota(
      quotaRow({ usedPercent: 100, observedAt: NOW - 6 * HOUR }),
    );
    gapOf(10_000);
    expect(pacingDelayMs(MATCH, NOW)).toBe(0);
  });

  test("curation pauses only while throttling (ρ > 1)", () => {
    // u = 40 after 2.5h → r = 16 %/h; s = 60 / 2.5h = 24 %/h → ρ < 1.
    upsertProviderQuota(quotaRow({ usedPercent: 40 }));
    expect(isCurationPacingPaused(MATCH, NOW)).toBe(false);
    upsertProviderQuota(quotaRow({ usedPercent: 60 }));
    expect(isCurationPacingPaused(MATCH, NOW)).toBe(true);
  });
});

describe("rate tracker", () => {
  const resetsAt = NOW + 2.5 * HOUR;
  const at = (offsetMs: number, usedPercent: number, reset = resetsAt) =>
    quotaRow({ usedPercent, resetsAt: reset, observedAt: NOW + offsetMs });
  const windowStatus = () => evaluateProviderPacing(NOW).at(0)?.windows.at(0);

  function observe(row: ProviderQuotaRow): void {
    upsertProviderQuota(row);
    recordQuotaObservation(row);
  }

  test("two samples ≥ 60 s apart give the observed Δu/Δt rate", () => {
    observe(at(-10 * 60_000, 50));
    observe(at(-5 * 60_000, 51)); // 1 point / 5 min = 12 %/h
    expect(windowStatus()).toMatchObject({ rate_source: "observed" });
    expect(windowStatus()?.current_rate).toBeCloseTo(12, 9);
  });

  test("samples closer than 60 s are ignored", () => {
    observe(at(-10 * 60_000, 50));
    observe(at(-10 * 60_000 + 30_000, 52));
    expect(windowStatus()).toMatchObject({ rate_source: "average" });
  });

  test("successive samples are smoothed by the EWMA", () => {
    observe(at(-15 * 60_000, 50));
    observe(at(-10 * 60_000, 51)); // 12 %/h
    observe(at(-5 * 60_000, 53)); // 24 %/h → 0.3·24 + 0.7·12 = 15.6
    expect(windowStatus()?.current_rate).toBeCloseTo(15.6, 9);
  });

  test("the EWMA resets when resetsAt changes", () => {
    observe(at(-10 * 60_000, 50));
    observe(at(-5 * 60_000, 51));
    expect(windowStatus()).toMatchObject({ rate_source: "observed" });
    observe(at(-60_000, 51, resetsAt + 60_000));
    expect(windowStatus()).toMatchObject({ rate_source: "average" });
  });

  test("the EWMA resets when usage drops", () => {
    observe(at(-10 * 60_000, 50));
    observe(at(-5 * 60_000, 51));
    observe(at(-60_000, 10));
    expect(windowStatus()).toMatchObject({ rate_source: "average", used: 10 });
  });

  test("quota-header writes feed the tracker", () => {
    const attribution = {
      provider: "anthropic",
      authKind: "subscription" as const,
      account: "acct1",
    };
    const reset = Math.floor((NOW + 2.5 * HOUR) / 1000);
    const headers = (utilization: string) =>
      new Headers({
        "anthropic-ratelimit-unified-5h-utilization": utilization,
        "anthropic-ratelimit-unified-5h-reset": String(reset),
        "anthropic-ratelimit-unified-status": "allowed",
      });
    observeProviderQuotaHeaders(
      headers("0.50"),
      attribution,
      NOW - 10 * 60_000,
    );
    observeProviderQuotaHeaders(headers("0.51"), attribution, NOW - 5 * 60_000);
    expect(windowStatus()).toMatchObject({ rate_source: "observed" });
    expect(windowStatus()?.current_rate).toBeCloseTo(12, 6);
  });

  test("the foreground gap is an EWMA of request gaps", () => {
    recordForegroundRequest(MATCH, NOW - 30_000);
    recordForegroundRequest(MATCH, NOW - 20_000); // 10 s
    recordForegroundRequest(MATCH, NOW); // 20 s → 0.3·20 + 0.7·10 = 13 s
    upsertProviderQuota(quotaRow());
    expect(evaluateProviderPacing(NOW)[0]?.request_gap_ms).toBeCloseTo(
      13_000,
      6,
    );
  });
});

describe("integral controller (held d_w)", () => {
  const T0 = 6 * 24 * HOUR;
  const resetsAt = NOW + T0;
  const row = (usedPercent: number, observedAt: number, reset = resetsAt) =>
    quotaRow({
      window: "7d",
      windowMinutes: 7 * 24 * 60,
      usedPercent,
      resetsAt: reset,
      observedAt,
    });
  function observe(r: ProviderQuotaRow): void {
    upsertProviderQuota(r);
    recordQuotaObservation(r);
  }
  const status = (now: number) => evaluateProviderPacing(now).at(0);

  /**
   * Closed loop: each request consumes `q` (the sustainable rate s times
   * c = 20 s), the natural gap is g0 = 5 s, and requests arrive g0 + delay
   * apart. One quota observation per simulated minute.
   */
  function simulate(
    controller: (now: number) => number,
    minutes: number,
  ): { ratio: number; delay: number; gap: number } {
    const c = 20_000;
    const g0 = 5_000;
    let used = 10;
    const q = ((100 - used) / T0) * c;
    let t = NOW;
    let nextRequest = NOW;
    let delay = 0;
    observe(row(used, t));
    for (let minute = 0; minute < minutes; minute++) {
      const end = t + 60_000;
      while (nextRequest < end) {
        recordForegroundRequest(MATCH, nextRequest);
        used += q;
        delay = controller(nextRequest);
        nextRequest += g0 + delay;
      }
      t = end;
      observe(row(used, t));
    }
    const s = status(t);
    return {
      ratio: s?.windows[0]?.ratio ?? Number.NaN,
      delay,
      gap: s?.request_gap_ms ?? Number.NaN,
    };
  }

  test("closed loop settles at r = s with delay ≈ c − g0", () => {
    const result = simulate((now) => pacingDelayMs(MATCH, now), 30);
    expect(Math.abs(result.ratio - 1)).toBeLessThan(0.1);
    expect(Math.abs(result.delay - 15_000)).toBeLessThan(1_500);
  });

  test("the stateless g · (ρ − 1) would settle only halfway", () => {
    const result = simulate((now) => {
      const s = status(now);
      const ratio = s?.windows[0]?.ratio ?? 0;
      const gap = s?.request_gap_ms ?? null;
      return gap === null || ratio <= 1
        ? 0
        : Math.min(MAX_PACING_DELAY_MS, gap * (ratio - 1));
    }, 30);
    // Total gap ≈ (g0 + c) / 2 = 12.5 s instead of c = 20 s → ρ ≈ 1.6.
    expect(Math.abs(result.gap - 12_500)).toBeLessThan(1_250);
    expect(result.ratio).toBeGreaterThan(1.4);
  });

  test("d_w only moves on accepted rate samples, not per request", () => {
    gapOf(10_000);
    observe(row(10, NOW - 10 * 60_000));
    observe(row(12, NOW - 5 * 60_000));
    const held = pacingDelayMs(MATCH, NOW);
    expect(held).toBeGreaterThan(0);
    for (let i = 1; i <= 20; i++) {
      recordForegroundRequest(MATCH, NOW + i * 1_000);
      expect(pacingDelayMs(MATCH, NOW + i * 1_000)).toBe(held);
    }
    // A sample under 60 s after the last one is not accepted either.
    observe(row(13, NOW - 5 * 60_000 + 30_000));
    expect(pacingDelayMs(MATCH, NOW + 21_000)).toBe(held);
  });

  test("d_w decays toward 0 while ρ < 1", () => {
    gapOf(10_000);
    const start = NOW - 25 * 60_000;
    observe(row(10, NOW - 30 * 60_000));
    observe(row(14, start));
    const peak = pacingDelayMs(MATCH, start);
    expect(peak).toBeGreaterThan(0);
    let previous = peak;
    for (let k = 1; k <= 40; k++) {
      const at = start + k * 60_000;
      observe(row(14, at)); // no further usage → r decays, ρ falls below 1
      const held = pacingDelayMs(MATCH, at);
      expect(held).toBeLessThanOrEqual(previous);
      previous = held;
    }
    expect(previous).toBe(0);
  });

  test("d_w resets to 0 on a new resetsAt", () => {
    gapOf(10_000);
    observe(row(10, NOW - 10 * 60_000));
    observe(row(14, NOW - 5 * 60_000));
    expect(pacingDelayMs(MATCH, NOW)).toBeGreaterThan(0);
    // New 7d window, 1h in, 0.1% used: the fallback rate is under s.
    const next = NOW + 7 * 24 * HOUR - HOUR;
    observe(row(0.1, NOW - 60_000, next));
    expect(status(NOW)?.windows[0]).toMatchObject({
      rate_source: "average",
      delay_ms: 0,
    });
    // The first observed sample integrates from 0, not from the old d_w.
    observe(row(0.1, NOW, next));
    expect(status(NOW)?.windows[0]).toMatchObject({ rate_source: "observed" });
    expect(pacingDelayMs(MATCH, NOW)).toBe(0);
  });

  test("u ≥ 100 holds the maximum", () => {
    gapOf(10_000);
    observe(row(99, NOW - 10 * 60_000));
    observe(row(100, NOW - 5 * 60_000));
    expect(pacingDelayMs(MATCH, NOW)).toBe(MAX_PACING_DELAY_MS);
  });
});

describe("pacing settings", () => {
  test("parsePacingSetting validates the toggle body", () => {
    expect(
      parsePacingSetting({
        provider: "anthropic",
        account: "a",
        enabled: false,
      }),
    ).toEqual({ provider: "anthropic", account: "a", enabled: false });
    for (const bad of [
      null,
      [],
      { provider: "anthropic", account: "a" },
      { provider: "anthropic", account: "a", enabled: 1 },
      { provider: "", account: "a", enabled: true },
      { provider: "anthropic", account: "a b", enabled: true },
      { provider: "anthropic", account: "a", enabled: true, window: "7d" },
    ]) {
      expect(typeof parsePacingSetting(bad), JSON.stringify(bad)).toBe(
        "string",
      );
    }
  });

  test("invalid and duplicate stored entries are dropped; missing means enabled", () => {
    db()
      .query("INSERT OR REPLACE INTO kv_meta (key, value) VALUES (?, ?)")
      .run(
        "provider_pacing",
        JSON.stringify([
          { provider: "anthropic", account: "a", enabled: false },
          { provider: "anthropic", account: "a", enabled: true },
          { provider: "anthropic", mode: "off" },
        ]),
      );
    expect(getPacingSettings()).toEqual([
      { provider: "anthropic", account: "a", enabled: false },
    ]);
    expect(isPacingEnabled("anthropic", "a")).toBe(false);
    expect(isPacingEnabled("anthropic", "b")).toBe(true);
  });
});
