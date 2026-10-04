import { describe, test, expect, beforeEach } from "vitest";
import {
  parseProviderQuotaHeaders,
  observeProviderQuotaHeaders,
} from "../src/provider-quota-headers";
import { db, close, listProviderQuotas } from "@loreai/core";
import type { CostAttribution } from "../src/cost-attribution";

const NOW = 1_800_000_000_000; // fixed observation instant (ms)

function headers(entries: Record<string, string>): Headers {
  return new Headers(entries);
}

function clearQuotas(): void {
  db().exec("DELETE FROM provider_quotas");
}

beforeEach(clearQuotas);

describe("parseProviderQuotaHeaders", () => {
  test("anthropic unified 5h/7d windows", () => {
    const windows = parseProviderQuotaHeaders(
      headers({
        "anthropic-ratelimit-unified-5h-utilization": "0.23",
        "anthropic-ratelimit-unified-5h-reset": "1999999999",
        "anthropic-ratelimit-unified-7d-utilization": "0.41",
        "anthropic-ratelimit-unified-7d-reset": "2000500000",
        "anthropic-ratelimit-unified-status": "allowed",
      }),
      NOW,
    );
    expect(windows).toHaveLength(2);
    const five = windows.find((w) => w.window === "5h")!;
    const seven = windows.find((w) => w.window === "7d")!;
    expect(five).toMatchObject({
      source: "anthropic-unified",
      label: "allowed",
      windowMinutes: 300,
      usedPercent: 23,
      resetsAt: 1_999_999_999_000,
    });
    expect(seven).toMatchObject({
      windowMinutes: 10080,
      usedPercent: 41,
      resetsAt: 2_000_500_000_000,
    });
  });

  test("unified utilization > 1 is treated as already a percent", () => {
    const windows = parseProviderQuotaHeaders(
      headers({ "anthropic-ratelimit-unified-5h-utilization": "42" }),
      NOW,
    );
    expect(windows[0].usedPercent).toBe(42);
  });

  test("anthropic API-key windows compute used percent from limit/remaining", () => {
    const windows = parseProviderQuotaHeaders(
      headers({
        "anthropic-ratelimit-requests-limit": "1000",
        "anthropic-ratelimit-requests-remaining": "250",
        "anthropic-ratelimit-requests-reset": "2033-01-01T00:00:00Z",
        "anthropic-ratelimit-tokens-limit": "80000",
        "anthropic-ratelimit-tokens-remaining": "80000",
      }),
      NOW,
    );
    const requests = windows.find((w) => w.window === "requests")!;
    expect(requests.source).toBe("anthropic-ratelimit");
    expect(requests.limit).toBe(1000);
    expect(requests.remaining).toBe(250);
    expect(requests.usedPercent).toBeCloseTo(75);
    expect(requests.resetsAt).toBe(Date.parse("2033-01-01T00:00:00Z"));
    const tokens = windows.find((w) => w.window === "tokens")!;
    expect(tokens.usedPercent).toBe(0);
  });

  test("openai x-ratelimit duration resets", () => {
    for (const [duration, expectedMs] of [
      ["1s", 1000],
      ["6m0s", 360_000],
      ["1h2m3.5s", 3_723_500],
      ["250ms", 250],
    ] as const) {
      const windows = parseProviderQuotaHeaders(
        headers({
          "x-ratelimit-limit-requests": "60",
          "x-ratelimit-remaining-requests": "59",
          "x-ratelimit-reset-requests": duration,
        }),
        NOW,
      );
      const w = windows.find((x) => x.window === "requests")!;
      expect(w.resetsAt).toBe(NOW + expectedMs);
      expect(w.source).toBe("openai-ratelimit");
      expect(w.limit).toBe(60);
      expect(w.remaining).toBe(59);
    }
  });

  test("openai x-ratelimit -tokens-minute suffix names the window", () => {
    const windows = parseProviderQuotaHeaders(
      headers({ "x-ratelimit-remaining-tokens-minute": "59990" }),
      NOW,
    );
    expect(windows.some((w) => w.window === "tokens-minute")).toBe(true);
  });

  test("codex primary/secondary map to 5h/7d", () => {
    const windows = parseProviderQuotaHeaders(
      headers({
        "x-codex-primary-used-percent": "12.5",
        "x-codex-primary-window-minutes": "300",
        "x-codex-secondary-reset-at": "2000500000",
      }),
      NOW,
    );
    const five = windows.find((w) => w.window === "5h")!;
    expect(five).toMatchObject({
      source: "codex",
      usedPercent: 12.5,
      windowMinutes: 300,
    });
    const seven = windows.find((w) => w.window === "7d");
    // secondary has reset-at but no window-minutes → slot name
    const secondary = windows.find((w) => w.window === "secondary");
    expect(secondary ?? seven).toBeTruthy();
    if (secondary) expect(secondary.resetsAt).toBe(2_000_500_000_000);
  });

  test("codex named bucket + credits; unlimited credits skipped", () => {
    const windows = parseProviderQuotaHeaders(
      headers({
        "x-codex-bengalfox-primary-used-percent": "80",
        "x-codex-bengalfox-limit-name": "model-specific",
        "x-codex-credits-balance": "10.25",
      }),
      NOW,
    );
    const bucket = windows.find((w) => w.window === "bengalfox:primary")!;
    expect(bucket).toMatchObject({
      source: "codex",
      label: "model-specific",
      usedPercent: 80,
    });
    const credits = windows.find((w) => w.window === "credits")!;
    expect(credits).toMatchObject({ label: "credits", remaining: 10.25 });

    const unlimited = parseProviderQuotaHeaders(
      headers({
        "x-codex-credits-balance": "10.25",
        "x-codex-credits-unlimited": "true",
      }),
      NOW,
    );
    expect(unlimited.find((w) => w.window === "credits")).toBeUndefined();
  });

  test("generic x-rate-limit / ratelimit / ratelimit-policy", () => {
    const windows = parseProviderQuotaHeaders(
      headers({
        "x-rate-limit-limit": "100",
        "x-rate-limit-remaining": "42",
        "x-rate-limit-reset": "30",
      }),
      NOW,
    );
    const requests = windows.find((w) => w.window === "requests")!;
    expect(requests).toMatchObject({
      source: "ratelimit",
      limit: 100,
      remaining: 42,
      resetsAt: NOW + 30_000,
    });

    const ietf = parseProviderQuotaHeaders(
      headers({
        ratelimit: '"default";r=99;t=30',
        "ratelimit-policy": '"default";q=100;w=60',
      }),
      NOW,
    );
    const def = ietf.find((w) => w.window === "default")!;
    expect(def.remaining).toBe(99);
    expect(def.resetsAt).toBe(NOW + 30_000);
    expect(def.limit).toBe(100);
    expect(def.windowMinutes).toBe(1);
  });

  test("malformed values produce null fields or dropped windows", () => {
    const windows = parseProviderQuotaHeaders(
      headers({
        "anthropic-ratelimit-unified-5h-utilization": "banana",
        "anthropic-ratelimit-unified-7d-utilization": "",
        "anthropic-ratelimit-unified-7d-reset": "-5",
        "x-ratelimit-reset-requests": "notaduration",
        "x-ratelimit-limit-requests": "-3",
        "x-codex-primary-used-percent": "NaN",
        "x-codex-credits-balance": "huge-not-a-number",
      }),
      NOW,
    );
    // Nothing usable at all — every window malformed.
    expect(windows).toEqual([]);
  });

  test("unrelated headers never produce windows", () => {
    const windows = parseProviderQuotaHeaders(
      headers({
        "set-cookie": "secret=1",
        authorization: "Bearer tok",
        "x-private-upstream": "private",
      }),
      NOW,
    );
    expect(windows).toEqual([]);
  });
});

describe("observeProviderQuotaHeaders", () => {
  const attribution: CostAttribution = {
    provider: "anthropic",
    authKind: "subscription",
    account: "acct",
  };

  test("persists parsed windows and newer observed_at wins", () => {
    const h = headers({
      "anthropic-ratelimit-unified-5h-utilization": "0.5",
    });
    observeProviderQuotaHeaders(h, attribution, NOW);
    let quotas = listProviderQuotas().filter((q) => q.window === "5h");
    expect(quotas).toHaveLength(1);
    expect(quotas[0]).toMatchObject({
      provider: "anthropic",
      authKind: "subscription",
      usedPercent: 50,
      observedAt: NOW,
    });

    // Older observation loses.
    observeProviderQuotaHeaders(
      headers({ "anthropic-ratelimit-unified-5h-utilization": "0.1" }),
      attribution,
      NOW - 1000,
    );
    quotas = listProviderQuotas().filter((q) => q.window === "5h");
    expect(quotas[0].usedPercent).toBe(50);
  });

  test("no quota headers → no rows", () => {
    observeProviderQuotaHeaders(headers({}), attribution, NOW);
    expect(listProviderQuotas()).toEqual([]);
  });

  test("never throws when the DB is closed", () => {
    close();
    expect(() =>
      observeProviderQuotaHeaders(
        headers({ "anthropic-ratelimit-unified-5h-utilization": "0.5" }),
        attribution,
        NOW,
      ),
    ).not.toThrow();
  });
});
