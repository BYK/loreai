/**
 * Integration tests for `executeWarmup` — the producer side of the warmup
 * cost-accounting fix. These cover the parts that the pure `creditWarmupHit`
 * unit tests (in cache-warmer.test.ts) cannot:
 *
 *  - Bug B producer: a successful warmup persists the cache_read tokens it
 *    actually refreshed into `state.warmup.lastWarmupRefreshTokens`, so the
 *    later hit credit uses the full prefix — NOT the returning turn's read.
 *  - Uncached warmup (cacheRead=0): the refresh credit must be 0 so the
 *    phantom guard later denies a bogus hit.
 *  - Partial warmup (read>0, write>0): credit the read portion only.
 *
 * Mirrors quota.test.ts: `upstreamFetch` is bridged to globalThis.fetch so a
 * vi.fn() can intercept the warmup request.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../src/fetch", () => ({
  upstreamFetch: (...args: Parameters<typeof fetch>) =>
    globalThis.fetch(...args),
}));

import {
  executeWarmup,
  buildAnthropicProfile,
  WRITE_EFFICIENCY_WINDOW,
} from "../src/cache-warmer";
import { setSessionAuth, _resetAuthForTest } from "../src/auth";
import { clearAllCosts } from "../src/cost-tracker";
import { compressBody } from "../src/cache-analytics";
import type { SessionState, CacheAnalytics } from "../src/translate/types";

const SESSION_ID = "warmup-exec-session-1";
const MODEL = "claude-sonnet-4-20250514";

function makeCacheAnalytics(): CacheAnalytics {
  const body = JSON.stringify({
    model: MODEL,
    max_tokens: 1024,
    messages: [{ role: "user", content: "hello world" }],
  });
  return {
    lastRequestBody: compressBody(body),
    lastRequestBodyLength: body.length,
    lastCacheRead: 0,
    lastCacheCreation: 0,
  } as CacheAnalytics;
}

function makeState(): SessionState {
  return {
    sessionID: SESSION_ID,
    projectPath: "/tmp/test-project",
    fingerprint: "abc123",
    lastRequestTime: Date.now() - 270_000,
    lastUserTurnTime: Date.now() - 270_000,
    messageCount: 20,
    turnsSinceCuration: 2,
    consecutiveTextOnlyTurns: 0,
    recallStore: new Map(),
    cacheAnalytics: makeCacheAnalytics(),
    lastUpstream: {
      url: "https://api.anthropic.com",
      protocol: "anthropic" as const,
      model: MODEL,
      headers: {},
    },
    upstreamByProvider: new Map(),
    resolvedConversationTTL: "5m",
    lastInputTokens: 100_000,
  } as SessionState;
}

/** Build a fetch mock returning the given usage block as an Anthropic resp. */
function fetchReturningUsage(usage: Record<string, number>) {
  return vi.fn(() =>
    Promise.resolve(
      new Response(JSON.stringify({ usage, stop_reason: "end_turn" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ),
  );
}

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  _resetAuthForTest();
  clearAllCosts();
  setSessionAuth(SESSION_ID, { scheme: "bearer", value: "test-token" });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("executeWarmup → lastWarmupRefreshTokens (Bug B producer)", () => {
  test("a full refresh persists the warmup's cache_read tokens", async () => {
    globalThis.fetch = fetchReturningUsage({
      input_tokens: 5,
      cache_read_input_tokens: 168_000,
      cache_creation_input_tokens: 0,
    }) as unknown as typeof fetch;

    const state = makeState();
    const profile = buildAnthropicProfile(MODEL, "5m");
    const result = await executeWarmup(state, profile);

    expect(result.ok).toBe(true);
    expect(result.cacheReadTokens).toBe(168_000);
    // The credit used later for savings = the prefix THIS warmup refreshed,
    // not the returning turn's (smaller) read.
    expect(state.warmup?.lastWarmupRefreshTokens).toBe(168_000);
    expect(state.warmup?.totalWarmups).toBe(1);
    expect(state.warmup?.lastWarmupAt).toBeGreaterThan(0);
  });

  test("a partial refresh credits the read portion only", async () => {
    globalThis.fetch = fetchReturningUsage({
      input_tokens: 5,
      cache_read_input_tokens: 100_000,
      cache_creation_input_tokens: 20_000,
    }) as unknown as typeof fetch;

    const state = makeState();
    const profile = buildAnthropicProfile(MODEL, "5m");
    await executeWarmup(state, profile);

    // Read portion = kept-alive prefix; the written portion was a cost, not
    // a save (already booked via recordWarmupCost).
    expect(state.warmup?.lastWarmupRefreshTokens).toBe(100_000);
  });

  test("an UNCACHED warmup sets refresh credit to 0 (phantom guard input)", async () => {
    globalThis.fetch = fetchReturningUsage({
      input_tokens: 5,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 168_000,
    }) as unknown as typeof fetch;

    const state = makeState();
    const profile = buildAnthropicProfile(MODEL, "5m");
    await executeWarmup(state, profile);

    // cacheRead=0 → the warmup kept NOTHING alive (paid a full write). The
    // refresh credit must be 0 so creditWarmupHit later denies a bogus hit.
    expect(state.warmup?.lastWarmupRefreshTokens).toBe(0);
    expect(state.warmup?.totalWarmups).toBe(1);
  });
});

describe("executeWarmup → writeEfficiencySamples (efficiency gate producer)", () => {
  test("records read/(read+write) efficiency on a partial warmup", async () => {
    globalThis.fetch = fetchReturningUsage({
      input_tokens: 5,
      cache_read_input_tokens: 30_000,
      cache_creation_input_tokens: 470_000, // 30k/(30k+470k) = 0.06
    }) as unknown as typeof fetch;

    const state = makeState();
    const profile = buildAnthropicProfile(MODEL, "5m");
    await executeWarmup(state, profile);

    const samples = state.warmup?.writeEfficiencySamples ?? [];
    expect(samples).toHaveLength(1);
    expect(samples[0]).toBeCloseTo(0.06, 2);
  });

  test("records 1.0 on a perfect refresh (cacheWrite=0) — keeps the average healthy", async () => {
    globalThis.fetch = fetchReturningUsage({
      input_tokens: 5,
      cache_read_input_tokens: 168_000,
      cache_creation_input_tokens: 0,
    }) as unknown as typeof fetch;

    const state = makeState();
    const profile = buildAnthropicProfile(MODEL, "5m");
    await executeWarmup(state, profile);

    const samples = state.warmup?.writeEfficiencySamples ?? [];
    expect(samples).toHaveLength(1);
    expect(samples[0]).toBe(1);
  });

  test("does NOT record a sample when read+write is 0 (no signal)", async () => {
    globalThis.fetch = fetchReturningUsage({
      input_tokens: 5,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    }) as unknown as typeof fetch;

    const state = makeState();
    const profile = buildAnthropicProfile(MODEL, "5m");
    await executeWarmup(state, profile);

    expect(state.warmup?.writeEfficiencySamples ?? []).toHaveLength(0);
  });

  test("rolling window is capped at WRITE_EFFICIENCY_WINDOW (oldest evicted)", async () => {
    globalThis.fetch = fetchReturningUsage({
      input_tokens: 5,
      cache_read_input_tokens: 30_000,
      cache_creation_input_tokens: 470_000,
    }) as unknown as typeof fetch;

    const profile = buildAnthropicProfile(MODEL, "5m");
    const state = makeState();
    // Fire more warmups than the window size; cooldown is bypassed because
    // executeWarmup itself does not gate on cooldown (shouldWarm does).
    for (let i = 0; i < WRITE_EFFICIENCY_WINDOW + 3; i++) {
      await executeWarmup(state, profile);
    }
    expect(state.warmup?.writeEfficiencySamples ?? []).toHaveLength(
      WRITE_EFFICIENCY_WINDOW,
    );
  });
});
