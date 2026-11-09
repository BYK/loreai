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
import { log } from "@loreai/core";

vi.mock("../src/fetch", () => ({
  upstreamFetch: (...args: Parameters<typeof fetch>) =>
    globalThis.fetch(...args),
}));

import {
  executeWarmup,
  beginWarmingTurn,
  finishWarmingTurn,
  isWarmupAuthDisabled,
  clearWarmupAuthDisabled,
  buildAnthropicProfile,
  resolveProfileForSession,
  isCircuitBreakerTripped,
  warmupBucketKey,
  resetCircuitBreaker,
} from "../src/cache-warmer";
import { setSessionAuth, _resetAuthForTest } from "../src/auth";
import { clearAllCosts, getSessionCosts } from "../src/cost-tracker";
import { compressBody } from "../src/cache-analytics";
import {
  OPENAI_CACHE_TTL_MS,
  OPENAI_RESPONSES_URL,
  openAIWarmupScope,
  prepareOpenAIWarmupReplay,
} from "../src/openai-cache-warming";
import { _setModelDataForTest, clearModelDataCache } from "../src/worker-model";
import { loadConfig } from "../src/config";
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
  };
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
  clearWarmupAuthDisabled(SESSION_ID);
  clearAllCosts();
  setSessionAuth(SESSION_ID, { scheme: "bearer", value: "test-token" });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("executeWarmup → lastWarmupRefreshTokens (Bug B producer)", () => {
  test.each([200, 401])(
    "a late warmup (%s) cannot modify the next turn or its credential",
    async (status) => {
      const state = makeState();
      const original = state.lastRequestTime;
      beginWarmingTurn(state, [], 1, original, false);
      finishWarmingTurn(state, 1, original, original + 1, "end_turn", false);
      let complete: (response: Response) => void = () => {};
      const fetchMock = vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            complete = resolve;
          }),
      );
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      const warmup = executeWarmup(state, buildAnthropicProfile(MODEL, "5m"));
      expect(fetchMock).toHaveBeenCalledOnce();

      const current = Date.now();
      beginWarmingTurn(state, [], 2, current, false);
      state.lastRequestTime = current;
      finishWarmingTurn(state, 2, current, current + 1, "end_turn", false);
      setSessionAuth(SESSION_ID, { scheme: "bearer", value: "fresh-token" });

      complete(
        new Response(
          JSON.stringify({ usage: { cache_read_input_tokens: 100_000 } }),
          { status },
        ),
      );
      await warmup;
      expect(state.warmup).toBeUndefined();
      expect(isWarmupAuthDisabled(SESSION_ID)).toBe(false);
    },
  );

  test("manual thinking is skipped before dispatch", async () => {
    const fetchMock = fetchReturningUsage({ cache_read_input_tokens: 100_000 });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const state = makeState();
    state.cacheAnalytics.lastRequestBody = compressBody(
      JSON.stringify({
        thinking: { type: "enabled", budget_tokens: 10_000 },
        messages: [{ role: "user", content: "hello" }],
      }),
    );
    expect(
      (await executeWarmup(state, buildAnthropicProfile(MODEL, "5m"))).ok,
    ).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("an under-sized read stops warming the current reply", async () => {
    const fetchMock = fetchReturningUsage({ cache_read_input_tokens: 2_000 });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const state = makeState();
    const requestedAt = state.lastRequestTime;
    beginWarmingTurn(state, [], 1, requestedAt, false);
    finishWarmingTurn(
      state,
      1,
      requestedAt,
      requestedAt + 1,
      "end_turn",
      false,
    );

    await executeWarmup(state, buildAnthropicProfile(MODEL, "5m"));
    expect(state.warmingTurn?.warmupMissed).toBe(true);
    await executeWarmup(state, buildAnthropicProfile(MODEL, "5m"));
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  test("a slow successful warmup measures expiry from dispatch", async () => {
    const state = makeState();
    state.resolvedConversationTTL = "1h";
    const sentAt = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(sentAt);
    globalThis.fetch = vi.fn(async () => {
      clock.mockReturnValue(sentAt + 60_000);
      return Response.json({ usage: { cache_read_input_tokens: 100_000 } });
    }) as unknown as typeof fetch;
    await executeWarmup(state, buildAnthropicProfile(MODEL, "5m"));
    expect(state.warmup?.lastWarmupAt).toBe(sentAt);
    expect(state.warmup?.lastWarmupTTL).toBe("5m");
  });

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

  test("a rejected warmup logs status but never response text or statusText", async () => {
    const bodyMarker = "PRIVATE_WARMUP_RESPONSE_BODY_MARKER";
    const reasonMarker = "PRIVATE_WARMUP_REASON_MARKER";
    const messages: string[] = [];
    vi.spyOn(log, "error").mockImplementation((...args) => {
      messages.push(args.join(" "));
    });
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(
        new Response(bodyMarker, { status: 422, statusText: reasonMarker }),
      ),
    ) as unknown as typeof fetch;

    const result = await executeWarmup(
      makeState(),
      buildAnthropicProfile(MODEL, "5m"),
    );

    expect(result.ok).toBe(false);
    const output = messages.join("\n");
    expect(output).toContain("422");
    expect(output).not.toContain(bodyMarker);
    expect(output).not.toContain(reasonMarker);
  });

  test("malformed warmup JSON never reaches diagnostics", async () => {
    const bodyMarker = "PRIVATE_WARMUP_MALFORMED_PREFIX";
    const messages: string[] = [];
    vi.spyOn(log, "error").mockImplementation((...args) => {
      messages.push(args.join(" "));
    });
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(new Response(`${bodyMarker} not-json`, { status: 200 })),
    ) as unknown as typeof fetch;

    const result = await executeWarmup(
      makeState(),
      buildAnthropicProfile(MODEL, "5m"),
    );

    expect(result.ok).toBe(false);
    expect(messages.join("\n")).not.toContain(bodyMarker);
  });

  test("body-controlled usage fields never reach warmup logs", async () => {
    const bodyMarker = "PRIVATE_WARMUP_USAGE_FIELD_MARKER";
    const messages: string[] = [];
    vi.spyOn(log, "info").mockImplementation((...args) => {
      messages.push(args.join(" "));
    });
    vi.spyOn(log, "warn").mockImplementation((...args) => {
      messages.push(args.join(" "));
    });
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            usage: {
              input_tokens: bodyMarker,
              cache_read_input_tokens: bodyMarker,
              cache_creation_input_tokens: bodyMarker,
            },
          }),
          { status: 200 },
        ),
      ),
    ) as unknown as typeof fetch;

    const result = await executeWarmup(
      makeState(),
      buildAnthropicProfile(MODEL, "5m"),
    );

    expect(result).toEqual({
      ok: true,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
    expect(messages.join("\n")).not.toContain(bodyMarker);
  });

  test("thrown warmup errors do not log URL secrets", async () => {
    const userinfoMarker = "PRIVATE_WARMUP_THROWN_USERINFO";
    const queryMarker = "PRIVATE_WARMUP_THROWN_QUERY";
    const fragmentMarker = "PRIVATE_WARMUP_THROWN_FRAGMENT";
    const messages: string[] = [];
    vi.spyOn(log, "error").mockImplementation((...args) => {
      messages.push(args.join(" "));
    });
    globalThis.fetch = vi.fn(() =>
      Promise.reject(
        new Error(
          `fetch https://user:${userinfoMarker}@example.com/warm?token=${queryMarker}#${fragmentMarker} failed`,
        ),
      ),
    ) as unknown as typeof fetch;

    const result = await executeWarmup(
      makeState(),
      buildAnthropicProfile(MODEL, "5m"),
    );

    expect(result.ok).toBe(false);
    const output = messages.join("\n");
    expect(output).not.toContain(userinfoMarker);
    expect(output).not.toContain(queryMarker);
    expect(output).not.toContain(fragmentMarker);
  });

  test("does not attach admin extras to an untrusted warmup URL", async () => {
    let capturedHeaders: Record<string, string> = {};
    globalThis.fetch = vi.fn((_input, init) => {
      capturedHeaders = init?.headers as Record<string, string>;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            usage: {
              input_tokens: 5,
              cache_read_input_tokens: 168_000,
              cache_creation_input_tokens: 0,
            },
            stop_reason: "end_turn",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    }) as unknown as typeof fetch;
    const config = loadConfig();
    config.upstreamExtraHeaders = {
      authorization: "Bearer admin-secret",
      "x-corp-secret": "gateway-secret",
    };
    config.upstreamExtraHeaderBases = ["https://api.anthropic.com"];
    const state = makeState();
    const lastUpstream = state.lastUpstream;
    if (!lastUpstream) throw new Error("expected warmup upstream snapshot");
    state.lastUpstream = {
      ...lastUpstream,
      url: "https://attacker.example",
    };

    const result = await executeWarmup(
      state,
      buildAnthropicProfile(MODEL, "5m", "https://attacker.example"),
      config,
    );

    expect(result.ok).toBe(true);
    expect(capturedHeaders.Authorization ?? capturedHeaders.authorization).toBe(
      "Bearer test-token",
    );
    expect(capturedHeaders["x-corp-secret"]).toBeUndefined();
  });

  test("applies admin extras to a configured trusted warmup URL", async () => {
    let capturedHeaders: Record<string, string> = {};
    globalThis.fetch = vi.fn((_input, init) => {
      capturedHeaders = init?.headers as Record<string, string>;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            usage: {
              input_tokens: 5,
              cache_read_input_tokens: 168_000,
              cache_creation_input_tokens: 0,
            },
            stop_reason: "end_turn",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    }) as unknown as typeof fetch;
    const config = loadConfig();
    config.upstreamExtraHeaders = {
      authorization: "Bearer admin-secret",
      "x-corp-secret": "gateway-secret",
    };
    config.upstreamExtraHeaderBases = ["https://api.anthropic.com"];

    const result = await executeWarmup(
      makeState(),
      buildAnthropicProfile(MODEL, "5m"),
      config,
    );

    expect(result.ok).toBe(true);
    expect(capturedHeaders.Authorization).toBeUndefined();
    expect(capturedHeaders.authorization).toBe("Bearer admin-secret");
    expect(capturedHeaders["x-corp-secret"]).toBe("gateway-secret");
  });
});

describe("executeWarmup → all-or-nothing circuit breaker (partial-while-alive is a DEFECT)", () => {
  beforeEach(() => resetCircuitBreaker());

  const partialUsage = {
    input_tokens: 5,
    cache_read_input_tokens: 30_000,
    cache_creation_input_tokens: 470_000, // partial: read>0 AND write>0
  };
  const refreshUsage = {
    input_tokens: 5,
    cache_read_input_tokens: 168_000,
    cache_creation_input_tokens: 0, // clean 100% refresh
  };

  test("3 partial-while-alive warmups trip the breaker (a partial is NOT 'fine')", async () => {
    const state = makeState(); // lastRequestTime 4.5min ago → cacheLikelyAlive
    const profile = buildAnthropicProfile(MODEL, "5m");
    const bucket = warmupBucketKey(state);

    globalThis.fetch = fetchReturningUsage(
      partialUsage,
    ) as unknown as typeof fetch;
    await executeWarmup(state, profile);
    await executeWarmup(state, profile);
    expect(isCircuitBreakerTripped(bucket)).toBe(false); // 2 failures
    await executeWarmup(state, profile);
    expect(isCircuitBreakerTripped(bucket)).toBe(true); // 3rd → tripped
  });

  test("a clean 100% refresh clears accumulated partial failures", async () => {
    const state = makeState();
    const profile = buildAnthropicProfile(MODEL, "5m");
    const bucket = warmupBucketKey(state);

    globalThis.fetch = fetchReturningUsage(
      partialUsage,
    ) as unknown as typeof fetch;
    await executeWarmup(state, profile); // failure 1
    await executeWarmup(state, profile); // failure 2

    globalThis.fetch = fetchReturningUsage(
      refreshUsage,
    ) as unknown as typeof fetch;
    await executeWarmup(state, profile); // clean refresh → clears

    globalThis.fetch = fetchReturningUsage(
      partialUsage,
    ) as unknown as typeof fetch;
    await executeWarmup(state, profile);
    await executeWarmup(state, profile);
    // Only 2 failures since the clear → not tripped.
    expect(isCircuitBreakerTripped(bucket)).toBe(false);
  });
});

describe("OpenAI native prewarm", () => {
  afterEach(() => clearModelDataCache());

  function openAIState() {
    const state = makeState();
    const model = "gpt-6.1-sol";
    const entry = { id: model, cost: { input: 2, output: 10 } };
    _setModelDataForTest({ [model]: entry }, { [`openai/${model}`]: entry });
    const requestedAt = Date.now() - OPENAI_CACHE_TTL_MS + 45_000;
    state.lastRequestTime = requestedAt;
    state.lastUpstream = {
      url: "https://api.openai.com/v1",
      protocol: "openai-responses",
      providerID: "openai",
      model,
      headers: {},
    };
    state.cacheAnalytics.lastRequestBody = null;
    setSessionAuth(
      SESSION_ID,
      { scheme: "bearer", value: "test-token" },
      "openai",
    );
    const route = openAIWarmupScope(
      { authorization: "Bearer test-token", "openai-project": "proj_example" },
      model,
      "prefix-key",
    );
    if (!route) throw new Error("missing scope");
    beginWarmingTurn(state, [], 1, requestedAt, false);
    state._upstreamRequestOrder = 1;
    finishWarmingTurn(state, 1, requestedAt, requestedAt + 1, "stop", false);
    state.warmingTurn!.openAIReplay = prepareOpenAIWarmupReplay(
      JSON.stringify({
        model,
        store: false,
        stream: true,
        max_output_tokens: 500,
        input: [{ role: "user", content: "hello" }],
        prompt_cache_key: "prefix-key",
      }),
      route,
      { inputTokens: 100, outputTokens: 1, cacheReadInputTokens: 60_000 },
      50_000,
    );
    const profile = resolveProfileForSession(state);
    if (!profile) throw new Error("missing OpenAI profile");
    return { state, profile };
  }

  test.each([
    { read: 60_000, write: 0, output: 0, verified: true },
    { read: 30_000, write: 30_000, output: 0, verified: false },
    { read: 60_000, write: 0, output: 1, verified: false },
    { read: 55_000, write: 0, output: 0, verified: false },
  ])(
    "meters prewarm usage and credits only a verified refresh ($read/$write/$output)",
    async ({ read, write, output, verified }) => {
      const { state, profile } = openAIState();
      const fetchMock = vi.fn(
        async (_url: RequestInfo | URL, _init?: RequestInit) =>
          Response.json({
            status: "completed",
            output: [],
            usage: {
              input_tokens: read + write + 100,
              output_tokens: output,
              input_tokens_details: {
                cached_tokens: read,
                cache_write_tokens: write,
              },
            },
          }),
      );
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      await executeWarmup(state, profile);
      expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
        OPENAI_RESPONSES_URL,
        expect.objectContaining({
          redirect: "error",
          headers: expect.objectContaining({
            Authorization: "Bearer test-token",
            "openai-project": "proj_example",
          }),
        }),
      );
      const serialized = fetchMock.mock.calls[0]?.[1]?.body;
      if (typeof serialized !== "string")
        throw new Error("missing prewarm JSON");
      const body = JSON.parse(serialized);
      expect(body).toMatchObject({
        stream: false,
        store: false,
        prompt_cache_key: "prefix-key",
        prompt_cache_options: { prewarm: true },
      });
      expect(body).not.toHaveProperty("max_output_tokens");
      expect(state.warmup?.lastWarmupTTL).toBe(verified ? "30m" : undefined);
      expect(state.warmingTurn?.warmupMissed).toBe(verified ? undefined : true);
      expect(getSessionCosts(SESSION_ID)?.workers.warmup.cost).toBeCloseTo(
        (read * 0.1 + write * 2.5 + 100 * 2 + output * 10) / 1_000_000,
        9,
      );
    },
  );

  test("rejects a replay after the session credential changes", async () => {
    const { state, profile } = openAIState();
    setSessionAuth(
      SESSION_ID,
      { scheme: "bearer", value: "rotated-token" },
      "openai",
    );
    const fetchMock = vi.fn<typeof fetch>();
    globalThis.fetch = fetchMock;
    expect((await executeWarmup(state, profile)).ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
