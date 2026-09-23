/**
 * Coverage for the env-configurable SSE inactivity deadlines.
 *
 * Regression guard for the defect where a hardcoded 120s upstream-side
 * deadline aborted foreground relays during long legitimate upstream silence
 * (extended thinking), surfacing to the client as a mid-stream transport loss
 * with zero content.
 */
import { afterEach, describe, it, expect, vi } from "vitest";
import {
  parseSseInactivityMs,
  DEFAULT_FOREGROUND_SSE_INACTIVITY_MS,
  DEFAULT_FOREGROUND_REQUEST_TIMEOUT_MS,
  FOREGROUND_SSE_INACTIVITY_MS,
  FOREGROUND_REQUEST_TIMEOUT_MS,
  WORKER_RESPONSE_INACTIVITY_MS,
  WORKER_REQUEST_TIMEOUT_MS,
} from "../src/sse-inactivity";

const DEADLINE_ENV_KEYS = [
  "LORE_FOREGROUND_SSE_INACTIVITY_MS",
  "LORE_FOREGROUND_REQUEST_TIMEOUT_MS",
  "LORE_WORKER_RESPONSE_INACTIVITY_MS",
  "LORE_WORKER_REQUEST_TIMEOUT_MS",
] as const;

type DeadlineEnvKey = (typeof DEADLINE_ENV_KEYS)[number];

async function loadWithDeadlineEnv(
  overrides: Partial<Record<DeadlineEnvKey, string>>,
) {
  for (const key of DEADLINE_ENV_KEYS) {
    vi.stubEnv(key, overrides[key] ?? "");
  }
  vi.resetModules();
  return import("../src/sse-inactivity");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("parseSseInactivityMs", () => {
  it("returns the fallback when unset or empty", () => {
    expect(parseSseInactivityMs(undefined, 600_000)).toBe(600_000);
    expect(parseSseInactivityMs("", 600_000)).toBe(600_000);
  });

  it("parses a positive integer", () => {
    expect(parseSseInactivityMs("900000", 600_000)).toBe(900_000);
  });

  it("rejects invalid values by falling back to the default", () => {
    for (const raw of ["abc", "0", "-1", "1.5", "NaN", "Infinity"]) {
      expect(parseSseInactivityMs(raw, 600_000)).toBe(600_000);
    }
  });

  it("rejects values beyond the 32-bit timer ceiling", () => {
    expect(parseSseInactivityMs("99999999999", 600_000)).toBe(600_000);
  });

  it("floors an over-aggressive override so the deadline stays meaningful", () => {
    // `=1` must not turn the deadline into an immediate abort.
    expect(parseSseInactivityMs("1", 600_000)).toBe(1_000);
  });
});

describe("inactivity deadline defaults", () => {
  it("defaults the foreground deadline above every client watchdog", () => {
    // Claude Code's own watchdogs fire at 180s/300s; the gateway must not
    // preempt them, or the client reports a transport loss instead of a stall.
    expect(DEFAULT_FOREGROUND_SSE_INACTIVITY_MS).toBeGreaterThanOrEqual(
      600_000,
    );
  });

  it("resolves the live constants from the defaults when no env override is set", () => {
    if (process.env.LORE_FOREGROUND_SSE_INACTIVITY_MS === undefined) {
      expect(FOREGROUND_SSE_INACTIVITY_MS).toBe(
        DEFAULT_FOREGROUND_SSE_INACTIVITY_MS,
      );
    }
    if (process.env.LORE_WORKER_RESPONSE_INACTIVITY_MS === undefined) {
      expect(WORKER_RESPONSE_INACTIVITY_MS).toBe(
        DEFAULT_FOREGROUND_SSE_INACTIVITY_MS,
      );
    }
    if (process.env.LORE_FOREGROUND_REQUEST_TIMEOUT_MS === undefined) {
      expect(FOREGROUND_REQUEST_TIMEOUT_MS).toBe(
        DEFAULT_FOREGROUND_REQUEST_TIMEOUT_MS,
      );
    }
  });

  it("keeps the request ceiling above the inactivity deadline", () => {
    // Regression: a request ceiling below the inactivity deadline makes the
    // inactivity deadline unreachable, so raising it appears to do nothing.
    expect(FOREGROUND_REQUEST_TIMEOUT_MS).toBeGreaterThan(
      FOREGROUND_SSE_INACTIVITY_MS,
    );
    expect(DEFAULT_FOREGROUND_REQUEST_TIMEOUT_MS).toBeGreaterThan(
      DEFAULT_FOREGROUND_SSE_INACTIVITY_MS,
    );
    expect(WORKER_REQUEST_TIMEOUT_MS).toBeGreaterThan(
      WORKER_RESPONSE_INACTIVITY_MS,
    );
  });
});

describe("deadline environment overrides", () => {
  it("reads all four environment variables independently", async () => {
    const deadlines = await loadWithDeadlineEnv({
      LORE_FOREGROUND_SSE_INACTIVITY_MS: "450000",
      LORE_FOREGROUND_REQUEST_TIMEOUT_MS: "800000",
      LORE_WORKER_RESPONSE_INACTIVITY_MS: "350000",
      LORE_WORKER_REQUEST_TIMEOUT_MS: "700000",
    });

    expect(deadlines.FOREGROUND_SSE_INACTIVITY_MS).toBe(450_000);
    expect(deadlines.FOREGROUND_REQUEST_TIMEOUT_MS).toBe(800_000);
    expect(deadlines.WORKER_RESPONSE_INACTIVITY_MS).toBe(350_000);
    expect(deadlines.WORKER_REQUEST_TIMEOUT_MS).toBe(700_000);
  });

  it("raises a request timeout configured below inactivity plus headroom", async () => {
    const deadlines = await loadWithDeadlineEnv({
      LORE_FOREGROUND_SSE_INACTIVITY_MS: "700000",
      LORE_FOREGROUND_REQUEST_TIMEOUT_MS: "500000",
      LORE_WORKER_RESPONSE_INACTIVITY_MS: "800000",
      LORE_WORKER_REQUEST_TIMEOUT_MS: "500000",
    });

    expect(deadlines.FOREGROUND_REQUEST_TIMEOUT_MS).toBe(760_000);
    expect(deadlines.WORKER_REQUEST_TIMEOUT_MS).toBe(860_000);
  });

  it("reserves timer headroom at the maximum accepted inactivity override", async () => {
    const maxNodeDelay = 2_147_483_647;
    const headroom = 60_000;
    const deadlines = await loadWithDeadlineEnv({
      LORE_FOREGROUND_SSE_INACTIVITY_MS: String(maxNodeDelay),
      LORE_FOREGROUND_REQUEST_TIMEOUT_MS: String(maxNodeDelay),
      LORE_WORKER_RESPONSE_INACTIVITY_MS: String(maxNodeDelay),
      LORE_WORKER_REQUEST_TIMEOUT_MS: String(maxNodeDelay),
    });

    expect(deadlines.FOREGROUND_SSE_INACTIVITY_MS).toBe(
      maxNodeDelay - headroom,
    );
    expect(deadlines.WORKER_RESPONSE_INACTIVITY_MS).toBe(
      maxNodeDelay - headroom,
    );
    expect(deadlines.FOREGROUND_REQUEST_TIMEOUT_MS).toBe(maxNodeDelay);
    expect(deadlines.WORKER_REQUEST_TIMEOUT_MS).toBe(maxNodeDelay);
  });
});
