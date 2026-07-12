import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { log } from "@loreai/core";

// Bridge: upstreamFetch now uses undici's own fetch (not globalThis.fetch),
// so tests that mock globalThis.fetch need this shim to intercept calls.
vi.mock("../src/fetch", () => ({
  upstreamFetch: (...args: Parameters<typeof fetch>) =>
    globalThis.fetch(...args),
}));

import {
  fetchModelData,
  ensureModelDataReady,
  isModelDataLoaded,
  getModelEntry,
  getModelEntrySync,
  getWorkerModel,
  resetWorkerModelState,
  clearModelDataCache,
  lookupProviderRoute,
  type ModelsDevEntry,
} from "../src/worker-model";
// Capability consumers — asserted end-to-end against the real merge so the
// multi-provider last-writer-wins collision (fixed here) can't silently
// re-disable the #1109 worker thinking/temperature behavior.
import {
  modelRejectsTemperatureByData,
  workerThinkingOnByDefault,
} from "../src/llm-adapter";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const _MODELS_DEV_API = "https://models.dev/api.json";

/** Build a mock models.dev api.json response with full cost+limit data. */
function buildModelsDevResponse(
  anthropicModels: Record<
    string,
    {
      cost: { input: number; output: number; cache_read: number };
      limit: { context: number; output: number };
    }
  >,
  openaiModels?: Record<
    string,
    {
      cost: { input: number; output: number; cache_read: number };
      limit: { context: number; output: number };
    }
  >,
) {
  const toEntries = (models: typeof anthropicModels) => {
    const entries: Record<string, ModelsDevEntry> = {};
    for (const [id, data] of Object.entries(models)) {
      entries[id] = { id, cost: data.cost, limit: data.limit };
    }
    return entries;
  };
  const resp: Record<string, { models: Record<string, ModelsDevEntry> }> = {
    anthropic: { models: toEntries(anthropicModels) },
  };
  if (openaiModels) {
    resp.openai = { models: toEntries(openaiModels) };
  }
  return resp;
}

/** Default Anthropic models.dev data for tests. */
const DEFAULT_ANTHROPIC_MODELS = {
  "claude-opus-4-6": {
    cost: { input: 5, output: 25, cache_read: 0.5 },
    limit: { context: 1_000_000, output: 128_000 },
  },
  "claude-sonnet-4-20250514": {
    cost: { input: 3, output: 15, cache_read: 0.3 },
    limit: { context: 200_000, output: 64_000 },
  },
  "claude-haiku-4-5": {
    cost: { input: 1, output: 5, cache_read: 0.1 },
    limit: { context: 200_000, output: 64_000 },
  },
};

/** Default OpenAI models.dev data for tests. */
const DEFAULT_OPENAI_MODELS = {
  "gpt-5.4": {
    cost: { input: 2.5, output: 15, cache_read: 0.625 },
    limit: { context: 1_050_000, output: 100_000 },
  },
  "gpt-5.4-mini": {
    cost: { input: 0.75, output: 4.5, cache_read: 0.19 },
    limit: { context: 400_000, output: 100_000 },
  },
};

/** Combined default models for tests. */
const DEFAULT_MODELS = DEFAULT_ANTHROPIC_MODELS;

// ---------------------------------------------------------------------------
// fetchModelData
// ---------------------------------------------------------------------------

describe("fetchModelData", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    clearModelDataCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetWorkerModelState();
  });

  test("fetches and parses model data from models.dev JSON API", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify(buildModelsDevResponse(DEFAULT_MODELS)), {
          status: 200,
        }),
      ),
    ) as unknown as typeof fetch;

    const data = await fetchModelData();

    expect(data.size).toBeGreaterThanOrEqual(3);
    const opus = data.get("claude-opus-4-6");
    if (!opus) throw new Error("expected opus model data");
    expect(opus.cost?.input).toBe(5);
    expect(opus.cost?.output).toBe(25);
    expect(opus.cost?.cache_read).toBe(0.5);
    expect(opus.limit?.context).toBe(1_000_000);
    expect(opus.limit?.output).toBe(128_000);
  });

  test("fetches models from multiple providers", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify(
            buildModelsDevResponse(
              DEFAULT_ANTHROPIC_MODELS,
              DEFAULT_OPENAI_MODELS,
            ),
          ),
          { status: 200 },
        ),
      ),
    ) as unknown as typeof fetch;

    const data = await fetchModelData();

    expect(data.size).toBe(5); // 3 Anthropic + 2 OpenAI
    expect(data.get("claude-opus-4-6")?.cost?.input).toBe(5);
    expect(data.get("gpt-5.4")?.cost?.input).toBe(2.5);
    expect(data.get("gpt-5.4-mini")?.cost?.input).toBe(0.75);
  });

  test("caches results and returns cache on subsequent calls", async () => {
    let callCount = 0;
    globalThis.fetch = vi.fn(() => {
      callCount++;
      return Promise.resolve(
        new Response(JSON.stringify(buildModelsDevResponse(DEFAULT_MODELS)), {
          status: 200,
        }),
      );
    }) as unknown as typeof fetch;

    // Defensive reset: another test file's async cleanup may have populated
    // the cache via our mock between beforeEach and here.
    clearModelDataCache();
    callCount = 0;

    const first = await fetchModelData();
    const countAfterFirst = callCount;
    const second = await fetchModelData();

    // At least one fetch for the first call; cross-test pollution may add more
    // (other test files can call fetch() on our mock during await yields).
    expect(countAfterFirst).toBeGreaterThanOrEqual(1);
    // No re-fetch for the second call — cache hit. Delta is immune to pollution.
    expect(callCount - countAfterFirst).toBe(0);
    expect(first).toBe(second); // Same reference — cached
  });

  test("returns empty map on API error with no cache", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(new Response("Server Error", { status: 500 })),
    ) as unknown as typeof fetch;

    const data = await fetchModelData();
    expect(data.size).toBe(0);
  });

  test("returns stale cache on network error", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.reject(new Error("Network error")),
    ) as unknown as typeof fetch;

    const data = await fetchModelData();
    expect(data.size).toBe(0);
  });

  test("deduplicates concurrent in-flight requests", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify(buildModelsDevResponse(DEFAULT_MODELS)), {
          status: 200,
        }),
      ),
    ) as unknown as typeof fetch;

    // Defensive reset: another test file's async cleanup may have populated
    // the cache via our mock between beforeEach and here.
    clearModelDataCache();

    // All three calls execute synchronously — dedup returns the same promise.
    // Promise identity is the correct assertion: immune to cross-test pollution
    // (callCount can be inflated by other test files calling fetch() on our mock
    // during the await, even with delta-based counting).
    const pa = fetchModelData();
    const pb = fetchModelData();
    const pc = fetchModelData();

    expect(pa).toBe(pb);
    expect(pb).toBe(pc);

    const [a, b, c] = await Promise.all([pa, pb, pc]);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  test("deduplicates concurrent calls even on network error", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.reject(new Error("Network error")),
    ) as unknown as typeof fetch;

    // Defensive reset: another test file's async cleanup may have populated
    // the cache via our mock between beforeEach and here.
    clearModelDataCache();

    // Dedup holds even when fetch rejects (caught internally → empty Map).
    // Promise identity is the correct assertion (see comment in sibling test).
    const pa = fetchModelData();
    const pb = fetchModelData();

    expect(pa).toBe(pb);

    const [a, b] = await Promise.all([pa, pb]);
    expect(a).toBe(b);
    expect(a.size).toBe(0);
  });

  test("handles missing providers gracefully", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ google: { models: {} } }), {
          status: 200,
        }),
      ),
    ) as unknown as typeof fetch;

    const data = await fetchModelData();
    expect(data.size).toBe(0); // Neither anthropic nor openai present
  });

  test("loads available providers even when some are missing", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            openai: {
              models: {
                "gpt-5.4": {
                  id: "gpt-5.4",
                  cost: { input: 2.5, output: 15 },
                  limit: { context: 1_050_000, output: 100_000 },
                },
              },
            },
          }),
          { status: 200 },
        ),
      ),
    ) as unknown as typeof fetch;

    const data = await fetchModelData();
    expect(data.size).toBe(1); // Only OpenAI, no Anthropic
    expect(data.get("gpt-5.4")?.cost?.input).toBe(2.5);
  });
});

// ---------------------------------------------------------------------------
// ensureModelDataReady / isModelDataLoaded (cold-start race)
// ---------------------------------------------------------------------------

describe("ensureModelDataReady", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    clearModelDataCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetWorkerModelState();
  });

  test("loads model data when not yet cached", async () => {
    expect(isModelDataLoaded()).toBe(false);
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify(buildModelsDevResponse(DEFAULT_MODELS)), {
          status: 200,
        }),
      ),
    ) as unknown as typeof fetch;

    await ensureModelDataReady();

    expect(isModelDataLoaded()).toBe(true);
    // Subsequent synchronous lookups now see real data, not fallback.
    expect(getModelEntrySync("claude-opus-4-6").limit?.context).toBe(1_000_000);
  });

  test("returns immediately without fetching when already loaded", async () => {
    const fetchSpy = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify(buildModelsDevResponse(DEFAULT_MODELS)), {
          status: 200,
        }),
      ),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await ensureModelDataReady(); // first load
    const callsAfterLoad = fetchSpy.mock.calls.length;

    await ensureModelDataReady(); // should be a no-op (data already cached)
    expect(fetchSpy.mock.calls.length).toBe(callsAfterLoad);
  });

  test("resolves within the timeout even if the fetch never completes (never hangs)", async () => {
    // Fetch hangs forever — ensureModelDataReady must still resolve via timeout.
    globalThis.fetch = vi.fn(
      () => new Promise(() => {}),
    ) as unknown as typeof fetch;

    const start = Date.now();
    await ensureModelDataReady(50);
    const elapsed = Date.now() - start;

    // Tight bound: must be governed by the 50ms timeout, not some other path.
    expect(elapsed).toBeLessThan(500);
    // Data not loaded (fetch never resolved) — caller falls back gracefully.
    expect(isModelDataLoaded()).toBe(false);
  });

  test("on fetch failure, leaves data unloaded so a later turn can retry (retry-next-request)", async () => {
    // HTTP 500 — fetchModelData must NOT cache an empty map; cachedModelData
    // stays null so isModelDataLoaded() is false and the next attempt retries.
    const failSpy = vi.fn(() =>
      Promise.resolve(new Response("upstream boom", { status: 500 })),
    );
    globalThis.fetch = failSpy as unknown as typeof fetch;

    await ensureModelDataReady(50);
    expect(isModelDataLoaded()).toBe(false);
    expect(failSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  test("recovers on a later attempt after an earlier failure", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(new Response("boom", { status: 500 })),
    ) as unknown as typeof fetch;
    await ensureModelDataReady(50);
    expect(isModelDataLoaded()).toBe(false);

    // Bypass the per-attempt cooldown for this isolated test, then succeed.
    clearModelDataCache();
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify(buildModelsDevResponse(DEFAULT_MODELS)), {
          status: 200,
        }),
      ),
    ) as unknown as typeof fetch;

    await ensureModelDataReady(2_000);
    expect(isModelDataLoaded()).toBe(true);
    expect(getModelEntrySync("claude-opus-4-6").limit?.context).toBe(1_000_000);
  });

  test("does not re-pay the wait every call during a sustained outage (cooldown)", async () => {
    // Fetch hangs forever (outage). The first call pays the timeout; the
    // immediate next call must short-circuit on the cooldown (no new fetch,
    // near-instant) so every turn doesn't block for `timeoutMs`.
    const hangSpy = vi.fn(() => new Promise(() => {}));
    globalThis.fetch = hangSpy as unknown as typeof fetch;

    await ensureModelDataReady(50); // first: pays the wait, kicks off fetch
    const callsAfterFirst = hangSpy.mock.calls.length;

    const start = Date.now();
    await ensureModelDataReady(50); // second: cooldown short-circuit
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(20); // did not wait again
    expect(hangSpy.mock.calls.length).toBe(callsAfterFirst); // no new fetch
    expect(isModelDataLoaded()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// lookupProviderRoute (dynamic models.dev fallback)
// ---------------------------------------------------------------------------

describe("lookupProviderRoute", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    clearModelDataCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetWorkerModelState();
  });

  test("resolves anthropic-protocol provider after cache is populated", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            anthropic: { models: {} },
            "some-new-provider": {
              id: "some-new-provider",
              api: "https://api.newprovider.com/anthropic/v1",
              npm: "@ai-sdk/anthropic",
              models: {},
            },
          }),
          { status: 200 },
        ),
      ),
    ) as unknown as typeof fetch;

    // Populate cache first (lookupProviderRoute is sync, non-blocking).
    await fetchModelData();
    const route = lookupProviderRoute("some-new-provider");
    expect(route).toEqual({
      url: "https://api.newprovider.com/anthropic",
      protocol: "anthropic",
    });
  });

  test("resolves openai-compatible provider after cache is populated", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            anthropic: { models: {} },
            "custom-openai": {
              id: "custom-openai",
              api: "https://api.custom.com/v1",
              npm: "@ai-sdk/openai-compatible",
              models: {},
            },
          }),
          { status: 200 },
        ),
      ),
    ) as unknown as typeof fetch;

    await fetchModelData();
    const route = lookupProviderRoute("custom-openai");
    expect(route).toEqual({
      url: "https://api.custom.com",
      protocol: "openai",
    });
  });

  test("resolves openai-responses provider after cache is populated", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            anthropic: { models: {} },
            "openai-like": {
              id: "openai-like",
              api: "https://api.openailike.com/v1",
              npm: "@ai-sdk/openai",
              models: {},
            },
          }),
          { status: 200 },
        ),
      ),
    ) as unknown as typeof fetch;

    await fetchModelData();
    const route = lookupProviderRoute("openai-like");
    expect(route).toEqual({
      url: "https://api.openailike.com",
      protocol: "openai-responses",
    });
  });

  test("returns null for provider without api field", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            anthropic: {
              id: "anthropic",
              npm: "@ai-sdk/anthropic",
              models: {},
            },
          }),
          { status: 200 },
        ),
      ),
    ) as unknown as typeof fetch;

    await fetchModelData();
    // anthropic in models.dev has no `api` field — SDK handles routing
    expect(lookupProviderRoute("anthropic")).toBeNull();
  });

  test("returns null for unknown provider", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            anthropic: { models: {} },
          }),
          { status: 200 },
        ),
      ),
    ) as unknown as typeof fetch;

    await fetchModelData();
    expect(lookupProviderRoute("nonexistent")).toBeNull();
  });

  test("returns null on cold cache and triggers background fetch", () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            anthropic: { models: {} },
            "delayed-provider": {
              id: "delayed-provider",
              api: "https://api.delayed.com/v1",
              npm: "@ai-sdk/openai-compatible",
              models: {},
            },
          }),
          { status: 200 },
        ),
      ),
    ) as unknown as typeof fetch;

    // Cold cache — returns null immediately, doesn't block.
    const route = lookupProviderRoute("delayed-provider");
    expect(route).toBeNull();
    // Background fetch was triggered.
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// getModelEntry (async)
// ---------------------------------------------------------------------------

describe("getModelEntry", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    clearModelDataCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetWorkerModelState();
  });

  test("returns exact match from models.dev", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify(buildModelsDevResponse(DEFAULT_MODELS)), {
          status: 200,
        }),
      ),
    ) as unknown as typeof fetch;

    const entry = await getModelEntry("claude-opus-4-6");
    expect(entry.cost?.input).toBe(5);
    expect(entry.cost?.output).toBe(25);
    expect(entry.limit?.context).toBe(1_000_000);
  });

  test("returns prefix match for dated model IDs", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify(buildModelsDevResponse(DEFAULT_MODELS)), {
          status: 200,
        }),
      ),
    ) as unknown as typeof fetch;

    const entry = await getModelEntry("claude-haiku-4-5-20251001");
    expect(entry.cost?.input).toBe(1);
    expect(entry.cost?.output).toBe(5);
  });

  test("returns fallback for unknown model", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify(buildModelsDevResponse(DEFAULT_MODELS)), {
          status: 200,
        }),
      ),
    ) as unknown as typeof fetch;

    const entry = await getModelEntry("claude-future-model-2027");
    // Fallback defaults
    expect(entry.cost?.input).toBe(3);
    expect(entry.cost?.output).toBe(15);
    expect(entry.limit?.context).toBe(200_000);
  });
});

// ---------------------------------------------------------------------------
// getModelEntrySync
// ---------------------------------------------------------------------------

describe("getModelEntrySync", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    clearModelDataCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetWorkerModelState();
  });

  test("returns fallback when cache is cold", () => {
    const entry = getModelEntrySync("claude-opus-4-6");
    // Should get fallback pricing for opus-4-6
    expect(entry.cost?.input).toBe(5);
    expect(entry.cost?.output).toBe(25);
    expect(entry.limit?.context).toBe(1_000_000);
  });

  test("offline fallback prices claude-sonnet-5 at its real cost, not the generic default", () => {
    // claude-sonnet-5 is the anthropic worker default + a common session model.
    // Its FALLBACK_PRICING prefix must NOT collide with claude-sonnet-4 and must
    // resolve to the real $2/$10 instead of the generic $3/$15 unknown default.
    const entry = getModelEntrySync("claude-sonnet-5");
    expect(entry.cost?.input).toBe(2);
    expect(entry.cost?.output).toBe(10);
    expect(entry.cost?.cache_read).toBe(0.2);
    expect(entry.cost?.cache_write).toBe(2.5);
    expect(entry.limit?.context).toBe(1_000_000);
    expect(entry.limit?.output).toBe(128_000);
  });

  test("returns cached data after fetchModelData populates cache", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify(buildModelsDevResponse(DEFAULT_MODELS)), {
          status: 200,
        }),
      ),
    ) as unknown as typeof fetch;

    // Warm the cache
    await fetchModelData();

    const entry = getModelEntrySync("claude-haiku-4-5");
    expect(entry.cost?.input).toBe(1);
    expect(entry.cost?.output).toBe(5);
    expect(entry.limit?.output).toBe(64_000);
  });

  test("prefix matches work in sync mode", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify(buildModelsDevResponse(DEFAULT_MODELS)), {
          status: 200,
        }),
      ),
    ) as unknown as typeof fetch;

    await fetchModelData();

    const entry = getModelEntrySync("claude-sonnet-4-20250514-extended");
    expect(entry.cost?.input).toBe(3);
  });

  test("unknown model returns default fallback", () => {
    const entry = getModelEntrySync("totally-unknown-model");
    expect(entry.cost?.input).toBe(3);
    expect(entry.cost?.output).toBe(15);
    expect(entry.limit?.context).toBe(200_000);
    expect(entry.limit?.output).toBe(8_192);
  });
});

// ---------------------------------------------------------------------------
// Canonical-provider capability resolution (multi-provider collision)
// ---------------------------------------------------------------------------

describe("canonical-provider capability resolution", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    clearModelDataCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetWorkerModelState();
    clearModelDataCache();
  });

  const mockResponse = (resp: unknown) => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify(resp), { status: 200 })),
    ) as unknown as typeof fetch;
  };

  // Reproduces the REAL models.dev shape: the vendor (anthropic) defines the
  // bare id FIRST, then aggregators/proxies redefine it later with divergent
  // capability flags. Under naive last-writer-wins the aggregator clobbers the
  // vendor — this fixture makes that failure mode observable.
  const collisionResponse = {
    anthropic: {
      api: "https://api.anthropic.com",
      npm: "@ai-sdk/anthropic",
      models: {
        "claude-sonnet-5": {
          id: "claude-sonnet-5",
          temperature: false,
          reasoning: true,
          reasoning_options: [{ type: "toggle" }, { type: "effort" }],
          cost: { input: 3, output: 15, cache_read: 0.3 },
          limit: { context: 1_000_000, output: 128_000 },
        },
        "claude-opus-4-8": {
          id: "claude-opus-4-8",
          temperature: false,
          reasoning: true,
          reasoning_options: [{ type: "effort" }],
          cost: { input: 5, output: 25, cache_read: 0.5 },
          limit: { context: 1_000_000, output: 128_000 },
        },
      },
    },
    // Iterated AFTER anthropic — would win the keys under last-writer-wins.
    azure: {
      models: {
        // Wrong temperature flag (Anthropic says false).
        "claude-opus-4-8": {
          id: "claude-opus-4-8",
          temperature: true,
          reasoning: true,
          reasoning_options: [{ type: "effort" }],
        },
      },
    },
    "github-copilot": {
      models: {
        // Missing the `toggle` reasoning option (Anthropic has it).
        "claude-sonnet-5": {
          id: "claude-sonnet-5",
          temperature: false,
          reasoning: true,
          reasoning_options: [{ type: "effort" }],
        },
      },
    },
  };

  test("vendor entry wins reasoning_options over a toggle-less aggregator (F1)", async () => {
    mockResponse(collisionResponse);
    await fetchModelData();

    const opts = getModelEntrySync("claude-sonnet-5").reasoning_options;
    expect(opts?.some((o) => o?.type === "toggle")).toBe(true);
    // End-to-end: the #1109 headline behavior must engage with live data.
    expect(workerThinkingOnByDefault({ modelID: "claude-sonnet-5" })).toBe(
      true,
    );
  });

  test("vendor entry wins temperature flag over an aggregator that reports temperature:true (F3)", async () => {
    mockResponse(collisionResponse);
    await fetchModelData();

    expect(getModelEntrySync("claude-opus-4-8").temperature).toBe(false);
    expect(modelRejectsTemperatureByData("claude-opus-4-8")).toBe(true);
    // sonnet-5 is temperature:false at both vendor and aggregator — still true.
    expect(modelRejectsTemperatureByData("claude-sonnet-5")).toBe(true);
  });

  test("re-apply does not disturb models only an aggregator defines", async () => {
    mockResponse({
      ...collisionResponse,
      "some-aggregator": {
        models: {
          "exotic-model-9": {
            id: "exotic-model-9",
            temperature: false,
            cost: { input: 1, output: 2, cache_read: 0.1 },
            limit: { context: 100_000, output: 8_192 },
          },
        },
      },
    });
    await fetchModelData();
    expect(getModelEntrySync("exotic-model-9").temperature).toBe(false);
    expect(getModelEntrySync("exotic-model-9").cost?.input).toBe(1);
  });

  test("forward-prefix resolves a dated id to the LONGEST (most specific) base (F4)", async () => {
    mockResponse({
      anthropic: {
        models: {
          // Ancestor id inserted FIRST — naive first-hit prefix would pick it.
          "claude-opus-4": {
            id: "claude-opus-4",
            temperature: true,
            reasoning_options: [{ type: "effort" }],
          },
          "claude-opus-4-8": {
            id: "claude-opus-4-8",
            temperature: false,
            reasoning_options: [{ type: "effort" }],
          },
        },
      },
    });
    await fetchModelData();

    // Dated variant must resolve to claude-opus-4-8 (temp:false), not the
    // shorter claude-opus-4 ancestor (temp:true) that was inserted first.
    const entry = getModelEntrySync("claude-opus-4-8-20260101");
    expect(entry.temperature).toBe(false);
    expect(modelRejectsTemperatureByData("claude-opus-4-8-20260101")).toBe(
      true,
    );
  });

  test("reverse-prefix resolves a base/family id to the newest member deterministically (F4)", async () => {
    mockResponse({
      anthropic: {
        models: {
          "claude-opus-4-5": {
            id: "claude-opus-4-5",
            temperature: true,
            reasoning_options: [{ type: "effort" }],
          },
          "claude-opus-4-8": {
            id: "claude-opus-4-8",
            temperature: false,
            reasoning_options: [{ type: "effort" }],
          },
        },
      },
    });
    await fetchModelData();

    // "claude-opus-4-" is a prefix of both; newest (4-8) wins by numeric compare.
    expect(getModelEntrySync("claude-opus-4-").id).toBe("claude-opus-4-8");
  });
});

// ---------------------------------------------------------------------------
// getWorkerModel
// ---------------------------------------------------------------------------

describe("getWorkerModel", () => {
  test("returns a model or undefined (depends on lore config)", () => {
    const result = getWorkerModel();
    expect(result === undefined || typeof result === "object").toBe(true);
  });

  test("known provider (anthropic) with expensive model returns cheaper worker default", () => {
    const result = getWorkerModel({
      providerID: "anthropic",
      model: "claude-opus-4-6",
    });
    expect(result).toBeDefined();
    expect(result?.providerID).toBe("anthropic");
    // Should downgrade to sonnet for cost savings
    expect(result?.modelID).toContain("sonnet");
  });

  test("known provider (anthropic) with cheap model echoes session model (no downgrade)", () => {
    const result = getWorkerModel({
      providerID: "anthropic",
      model: "claude-sonnet-4-6",
    });
    expect(result).toBeDefined();
    expect(result?.providerID).toBe("anthropic");
    expect(result?.modelID).toContain("sonnet");
  });

  test("openai-codex with expensive model downgrades to gpt-5.1-codex-mini", () => {
    // gpt-5.5 is expensive ($5/M) → cost-aware default kicks in. Same provider,
    // same /codex/responses endpoint, ~20x cheaper input.
    const result = getWorkerModel({
      providerID: "openai-codex",
      model: "gpt-5.5",
    });
    expect(result).toBeDefined();
    expect(result?.providerID).toBe("openai-codex");
    expect(result?.modelID).toBe("gpt-5.1-codex-mini");
  });

  test("openai-codex with already-cheap model echoes it (no downgrade)", () => {
    const result = getWorkerModel({
      providerID: "openai-codex",
      model: "gpt-5.1-codex-mini",
    });
    expect(result).toBeDefined();
    expect(result?.providerID).toBe("openai-codex");
    expect(result?.modelID).toBe("gpt-5.1-codex-mini");
  });

  test("unknown provider echoes session model — same provider is always safe", () => {
    // MiniMax, xAI, Mistral, NVIDIA, Google — no WORKER_DEFAULTS entry.
    // The session model is echoed because it's on the same provider (same
    // URL, credentials). The pipeline's cross-provider guard handles the
    // race condition if the provider switches mid-flight.
    const result = getWorkerModel({
      providerID: "minimax-coding-plan",
      model: "MiniMax-M3",
    });
    expect(result).toBeDefined();
    expect(result?.providerID).toBe("minimax-coding-plan");
    expect(result?.modelID).toBe("MiniMax-M3");
  });

  test("unknown provider with expensive model echoes session model (or finds cheaper via models.dev)", () => {
    const result = getWorkerModel({
      providerID: "google",
      model: "gemini-3.1-pro",
    });
    expect(result).toBeDefined();
    expect(result?.providerID).toBe("google");
  });

  test("unknown provider with cheap model echoes session model", () => {
    const result = getWorkerModel({
      providerID: "some-unknown-provider",
      model: "cheap-model:free",
    });
    expect(result).toBeDefined();
    expect(result?.providerID).toBe("some-unknown-provider");
    expect(result?.modelID).toBe("cheap-model:free");
  });

  test("unknown provider with no session model returns undefined", () => {
    // No session model to echo — undefined is correct
    const result = getWorkerModel({
      providerID: "xai",
    });
    expect(result).toBeUndefined();
  });

  test("no session provider (and no config model) returns undefined — never fabricates an anthropic worker", () => {
    // Regression: previously effectiveProvider defaulted to "anthropic" when the
    // session provider was absent, fabricating an Anthropic worker for a session
    // whose real provider is non-Anthropic/unknown. That worker then looked up
    // the session's foreign credential under "anthropic" → no-auth (or a doomed
    // cross-provider 401). With no provider evidence, background work must SKIP.
    const result = getWorkerModel({ model: "some-model" });
    expect(result).toBeUndefined();
  });

  test("empty session object returns undefined — no provider to target", () => {
    const result = getWorkerModel({});
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Dynamic cheaper-model discovery (warm models.dev cache)
// ---------------------------------------------------------------------------

describe("dynamic cheaper-model discovery", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    resetWorkerModelState();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetWorkerModelState();
  });

  test("finds cheaper same-provider model from models.dev cache", async () => {
    // Warm the cache with a custom provider that has an expensive + cheap model
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            anthropic: {
              api: "https://api.anthropic.com/v1",
              models: DEFAULT_ANTHROPIC_MODELS,
            },
            "custom-provider": {
              api: "https://api.custom.com/v1",
              models: {
                "expensive-model": {
                  id: "expensive-model",
                  cost: { input: 10, output: 30, cache_read: 1 },
                  limit: { context: 200_000, output: 64_000 },
                },
                "cheap-model": {
                  id: "cheap-model",
                  cost: { input: 0.5, output: 2, cache_read: 0.05 },
                  limit: { context: 200_000, output: 64_000 },
                },
              },
            },
          }),
          { status: 200 },
        ),
      ),
    ) as unknown as typeof fetch;

    // Defensive reset: a background refresh from another test can
    // repopulate the cache between beforeEach and this point.
    resetWorkerModelState();
    await fetchModelData();

    const result = getWorkerModel({
      providerID: "custom-provider",
      model: "expensive-model",
    });

    expect(result).toBeDefined();
    expect(result?.providerID).toBe("custom-provider");
    // Should pick the cheaper model, not echo the expensive session model
    expect(result?.modelID).toBe("cheap-model");
  });

  test("selects zero-cost model as cheapest alternative", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            anthropic: {
              api: "https://api.anthropic.com/v1",
              models: DEFAULT_ANTHROPIC_MODELS,
            },
            "free-provider": {
              api: "https://api.free.com/v1",
              models: {
                "paid-model": {
                  id: "paid-model",
                  cost: { input: 5, output: 15, cache_read: 0.5 },
                  limit: { context: 200_000, output: 64_000 },
                },
                "free-model": {
                  id: "free-model",
                  cost: { input: 0, output: 0, cache_read: 0 },
                  limit: { context: 100_000, output: 32_000 },
                },
              },
            },
          }),
          { status: 200 },
        ),
      ),
    ) as unknown as typeof fetch;

    resetWorkerModelState();
    await fetchModelData();

    const result = getWorkerModel({
      providerID: "free-provider",
      model: "paid-model",
    });

    expect(result).toBeDefined();
    expect(result?.providerID).toBe("free-provider");
    expect(result?.modelID).toBe("free-model");
  });

  test("echoes session model when no cheaper alternative exists", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            anthropic: {
              api: "https://api.anthropic.com/v1",
              models: DEFAULT_ANTHROPIC_MODELS,
            },
            "single-model-provider": {
              api: "https://api.single.com/v1",
              models: {
                "only-model": {
                  id: "only-model",
                  cost: { input: 3, output: 10, cache_read: 0.3 },
                  limit: { context: 200_000, output: 64_000 },
                },
              },
            },
          }),
          { status: 200 },
        ),
      ),
    ) as unknown as typeof fetch;

    resetWorkerModelState();
    await fetchModelData();

    const result = getWorkerModel({
      providerID: "single-model-provider",
      model: "only-model",
    });

    expect(result).toBeDefined();
    expect(result?.providerID).toBe("single-model-provider");
    // No cheaper model → echoes session model
    expect(result?.modelID).toBe("only-model");
  });
});

// ---------------------------------------------------------------------------
// family-based worker resolution (newest cheap-tier member of a family)
// ---------------------------------------------------------------------------

describe("family-based worker resolution", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    resetWorkerModelState();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetWorkerModelState();
  });

  const LIMIT = { context: 200_000, output: 64_000 };

  /** Warm the models.dev cache with a raw response carrying family metadata. */
  async function warmCache(response: unknown): Promise<void> {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify(response), { status: 200 })),
    ) as unknown as typeof fetch;
    resetWorkerModelState();
    await fetchModelData();
  }

  test("anthropic expensive session resolves to the NEWEST sonnet in family (not the stale hardcoded id)", async () => {
    await warmCache({
      anthropic: {
        api: "https://api.anthropic.com/v1",
        models: {
          "claude-opus-4-6": {
            id: "claude-opus-4-6",
            family: "claude-opus",
            release_date: "2026-01-05",
            cost: { input: 5, output: 25, cache_read: 0.5 },
            limit: LIMIT,
          },
          // Hardcoded WORKER_DEFAULTS offline fallback id.
          "claude-sonnet-5": {
            id: "claude-sonnet-5",
            family: "claude-sonnet",
            release_date: "2026-02-17",
            cost: { input: 3, output: 15, cache_read: 0.3 },
            limit: LIMIT,
          },
          // Newer sonnet generation — this is what the worker should track.
          // Deliberately DISTINCT from the hardcoded fallback (claude-sonnet-5)
          // so a disabled/cold resolver (which returns the fallback) fails this
          // assertion instead of coincidentally passing.
          "claude-sonnet-6": {
            id: "claude-sonnet-6",
            family: "claude-sonnet",
            release_date: "2026-06-01",
            cost: { input: 3, output: 15, cache_read: 0.3 },
            limit: LIMIT,
          },
          // Same cheap tier, DIFFERENT family — must be excluded.
          "claude-haiku-4-5": {
            id: "claude-haiku-4-5",
            family: "claude-haiku",
            release_date: "2025-10-15",
            cost: { input: 1, output: 5, cache_read: 0.1 },
            limit: LIMIT,
          },
        },
      },
    });

    const result = getWorkerModel({
      providerID: "anthropic",
      model: "claude-opus-4-6",
    });

    expect(result?.providerID).toBe("anthropic");
    // Newest in the claude-sonnet family (claude-sonnet-6), NOT the hardcoded
    // fallback claude-sonnet-5 — proving the resolver read models.dev.
    expect(result?.modelID).toBe("claude-sonnet-6");
  });

  test("codex: tracks the newest MINI in family, never upgrades to the full codex (codex caveat)", async () => {
    await warmCache({
      anthropic: { api: "https://api.anthropic.com/v1", models: {} },
      "openai-codex": {
        api: "https://api.openai.com/v1",
        models: {
          "gpt-5.5": {
            id: "gpt-5.5",
            family: "gpt",
            release_date: "2026-03-01",
            cost: { input: 5, output: 30, cache_read: 1.25 },
            limit: LIMIT,
          },
          "gpt-5.1-codex": {
            id: "gpt-5.1-codex",
            family: "gpt-codex",
            release_date: "2025-11-13",
            cost: { input: 1.25, output: 10, cache_read: 0.125 },
            limit: LIMIT,
          },
          "gpt-5.1-codex-mini": {
            id: "gpt-5.1-codex-mini",
            family: "gpt-codex",
            release_date: "2025-11-13",
            cost: { input: 0.25, output: 2, cache_read: 0.025 },
            limit: LIMIT,
          },
          // NEWER full codex — cheaper than the session but NOT a mini; the
          // cheap-variant filter must exclude it so we never upgrade tier.
          "gpt-5.3-codex": {
            id: "gpt-5.3-codex",
            family: "gpt-codex",
            release_date: "2026-02-05",
            cost: { input: 1.25, output: 10, cache_read: 0.125 },
            limit: LIMIT,
          },
          // NEWER mini — this is the one the worker should track.
          "gpt-5.4-codex-mini": {
            id: "gpt-5.4-codex-mini",
            family: "gpt-codex",
            release_date: "2026-04-01",
            cost: { input: 0.3, output: 2.5, cache_read: 0.03 },
            limit: LIMIT,
          },
          // NEWEST full codex overall (newer than the newest mini) and still
          // cheaper than the $5 session. Only the cheap-variant filter keeps the
          // worker off this tier — without it, "newest in family" would pick
          // this. Guards SHOULD-FIX #2: makes the codex-caveat test non-vacuous.
          "gpt-5.6-codex": {
            id: "gpt-5.6-codex",
            family: "gpt-codex",
            release_date: "2026-08-01",
            cost: { input: 1.25, output: 10, cache_read: 0.125 },
            limit: LIMIT,
          },
        },
      },
    });

    const result = getWorkerModel({
      providerID: "openai-codex",
      model: "gpt-5.5",
    });

    expect(result?.providerID).toBe("openai-codex");
    // Newest cheap-variant in gpt-codex: NOT the NEWER full gpt-5.6-codex,
    // NOT the older full gpt-5.3-codex, NOT the stale hardcoded gpt-5.1-codex-mini.
    expect(result?.modelID).toBe("gpt-5.4-codex-mini");
  });

  test("cost guard: a newer family member priced at/above the session is rejected for an older cheaper one", async () => {
    await warmCache({
      anthropic: {
        api: "https://api.anthropic.com/v1",
        models: {
          // Session model priced at $2/M (above the $1.50 downgrade threshold).
          "claude-opus-4-6": {
            id: "claude-opus-4-6",
            family: "claude-opus",
            release_date: "2026-01-05",
            cost: { input: 2, output: 10, cache_read: 0.2 },
            limit: LIMIT,
          },
          "claude-sonnet-4-6": {
            id: "claude-sonnet-4-6",
            family: "claude-sonnet",
            release_date: "2026-02-17",
            cost: { input: 1.5, output: 7.5, cache_read: 0.15 },
            limit: LIMIT,
          },
          // Newer sonnet but PRICIER than the session ($2.5 ≥ $2) — the cost
          // guard must skip it, leaving the older, cheaper sonnet-4-6.
          "claude-sonnet-5": {
            id: "claude-sonnet-5",
            family: "claude-sonnet",
            release_date: "2026-06-01",
            cost: { input: 2.5, output: 12, cache_read: 0.25 },
            limit: LIMIT,
          },
        },
      },
    });

    const result = getWorkerModel({
      providerID: "anthropic",
      model: "claude-opus-4-6",
    });

    expect(result?.providerID).toBe("anthropic");
    // sonnet-5 is newer but pricier than the $2 session → rejected by the
    // cost guard; the older but cheaper sonnet-4-6 wins.
    expect(result?.modelID).toBe("claude-sonnet-4-6");
  });

  test("cost guard: a NEWER family member with UNKNOWN pricing is skipped for a known-cheap older one", async () => {
    // A member with no cost.input cannot be proven to clear the price cap, so it
    // must not be selected over a known-cheap sibling (guards NIT #3 — an
    // unknown-price member must never bypass "never pricier than session").
    await warmCache({
      anthropic: {
        api: "https://api.anthropic.com/v1",
        models: {
          "claude-opus-4-6": {
            id: "claude-opus-4-6",
            family: "claude-opus",
            release_date: "2026-01-05",
            cost: { input: 5, output: 25, cache_read: 0.5 },
            limit: LIMIT,
          },
          // Older, but with KNOWN cheap pricing.
          "claude-sonnet-5": {
            id: "claude-sonnet-5",
            family: "claude-sonnet",
            release_date: "2026-02-17",
            cost: { input: 3, output: 15, cache_read: 0.3 },
            limit: LIMIT,
          },
          // NEWER, but pricing is UNKNOWN (no cost field) → must be skipped.
          "claude-sonnet-6": {
            id: "claude-sonnet-6",
            family: "claude-sonnet",
            release_date: "2026-06-01",
            limit: LIMIT,
          },
        },
      },
    });

    const result = getWorkerModel({
      providerID: "anthropic",
      model: "claude-opus-4-6",
    });

    expect(result?.providerID).toBe("anthropic");
    // The unknown-price claude-sonnet-6 is skipped; the known-cheap
    // claude-sonnet-5 wins even though it is older.
    expect(result?.modelID).toBe("claude-sonnet-5");
  });

  test("tie-break: same release_date picks the numerically newer generation (-10 > -9)", async () => {
    // Two same-family members share a release_date; the id tie-break must be
    // numeric-aware so "claude-sonnet-4-10" beats "claude-sonnet-4-9" (plain
    // string compare would wrongly pick -9). Guards NIT #4.
    await warmCache({
      anthropic: {
        api: "https://api.anthropic.com/v1",
        models: {
          "claude-opus-4-6": {
            id: "claude-opus-4-6",
            family: "claude-opus",
            release_date: "2026-01-05",
            cost: { input: 5, output: 25, cache_read: 0.5 },
            limit: LIMIT,
          },
          "claude-sonnet-4-9": {
            id: "claude-sonnet-4-9",
            family: "claude-sonnet",
            release_date: "2026-05-01",
            cost: { input: 3, output: 15, cache_read: 0.3 },
            limit: LIMIT,
          },
          "claude-sonnet-4-10": {
            id: "claude-sonnet-4-10",
            family: "claude-sonnet",
            release_date: "2026-05-01",
            cost: { input: 3, output: 15, cache_read: 0.3 },
            limit: LIMIT,
          },
        },
      },
    });

    const result = getWorkerModel({
      providerID: "anthropic",
      model: "claude-opus-4-6",
    });

    expect(result?.providerID).toBe("anthropic");
    // Numeric-aware tie-break: -10 is newer than -9 despite string ordering.
    expect(result?.modelID).toBe("claude-sonnet-4-10");
  });

  test("offline fallback: with no models.dev data, uses the hardcoded WORKER_DEFAULTS id", async () => {
    // Fetch fails → cachedModelData stays null → family resolution returns
    // undefined → caller falls back to the hardcoded modelID.
    globalThis.fetch = vi.fn(() =>
      Promise.reject(new Error("offline")),
    ) as unknown as typeof fetch;
    resetWorkerModelState();
    await fetchModelData();
    expect(isModelDataLoaded()).toBe(false);

    const result = getWorkerModel({
      providerID: "anthropic",
      model: "claude-opus-4-6",
    });

    expect(result?.providerID).toBe("anthropic");
    // Hardcoded WORKER_DEFAULTS offline fallback (current newest sonnet).
    expect(result?.modelID).toBe("claude-sonnet-5");
  });

  test("unknown provider: family-aware pick favors the NEWEST member of the cheapest family", async () => {
    // google isn't in WORKER_DEFAULTS → findCheaperSameProviderModel path.
    // The absolute-cheapest is an OLD flash-lite; a NEWER flash-lite is still
    // cheaper than the session. Family-aware resolution must pick the newer one.
    await warmCache({
      anthropic: { api: "https://api.anthropic.com/v1", models: {} },
      google: {
        api: "https://generativelanguage.googleapis.com/v1beta",
        models: {
          "gemini-3.1-pro": {
            id: "gemini-3.1-pro",
            family: "gemini-pro",
            release_date: "2026-05-01",
            cost: { input: 4, output: 20 },
            limit: LIMIT,
          },
          // Cheapest model overall, but an OLD generation.
          "gemini-2.5-flash-lite": {
            id: "gemini-2.5-flash-lite",
            family: "gemini-flash-lite",
            release_date: "2025-06-01",
            cost: { input: 0.1, output: 0.4 },
            limit: LIMIT,
          },
          // Same (cheapest) family, NEWER, still far cheaper than the session.
          "gemini-3-flash-lite": {
            id: "gemini-3-flash-lite",
            family: "gemini-flash-lite",
            release_date: "2026-04-01",
            cost: { input: 0.15, output: 0.6 },
            limit: LIMIT,
          },
          // Cheaper than session but a DIFFERENT (pricier) family — must lose
          // to the flash-lite family chosen by lowest cost.
          "gemini-3-flash": {
            id: "gemini-3-flash",
            family: "gemini-flash",
            release_date: "2026-04-15",
            cost: { input: 1, output: 5 },
            limit: LIMIT,
          },
        },
      },
    });

    const result = getWorkerModel({
      providerID: "google",
      model: "gemini-3.1-pro",
    });

    expect(result?.providerID).toBe("google");
    // Newest in the cheapest (flash-lite) family — NOT the older
    // gemini-2.5-flash-lite, NOT the pricier gemini-3-flash family.
    expect(result?.modelID).toBe("gemini-3-flash-lite");
  });

  test("unknown provider: without family metadata, falls back to absolute cheapest", async () => {
    // No family fields → Pass 2 is skipped → original cheapest-by-cost behavior.
    await warmCache({
      anthropic: { api: "https://api.anthropic.com/v1", models: {} },
      google: {
        api: "https://generativelanguage.googleapis.com/v1beta",
        models: {
          "gemini-3.1-pro": {
            id: "gemini-3.1-pro",
            release_date: "2026-05-01",
            cost: { input: 4, output: 20 },
            limit: LIMIT,
          },
          "gemini-3-flash": {
            id: "gemini-3-flash",
            release_date: "2026-04-15",
            cost: { input: 1, output: 5 },
            limit: LIMIT,
          },
          "gemini-3-flash-lite": {
            id: "gemini-3-flash-lite",
            release_date: "2026-04-01",
            cost: { input: 0.15, output: 0.6 },
            limit: LIMIT,
          },
        },
      },
    });

    const result = getWorkerModel({
      providerID: "google",
      model: "gemini-3.1-pro",
    });

    expect(result?.providerID).toBe("google");
    // Absolute cheapest, since there is no family metadata to refine on.
    expect(result?.modelID).toBe("gemini-3-flash-lite");
  });
});

// ---------------------------------------------------------------------------
// resolution memoization (skip rescan + collapse the per-call INFO log)
// ---------------------------------------------------------------------------

describe("worker-model resolution memoization", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    resetWorkerModelState();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetWorkerModelState();
    vi.restoreAllMocks();
  });

  const LIMIT = { context: 200_000, output: 64_000 };

  async function warmCache(response: unknown): Promise<void> {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify(response), { status: 200 })),
    ) as unknown as typeof fetch;
    resetWorkerModelState();
    await fetchModelData();
  }

  /** Anthropic snapshot whose newest cheap-tier sonnet is `newestSonnetId`. */
  function anthropicSnapshot(newestSonnetId: string) {
    return {
      anthropic: {
        api: "https://api.anthropic.com/v1",
        models: {
          "claude-opus-4-6": {
            id: "claude-opus-4-6",
            family: "claude-opus",
            release_date: "2026-01-05",
            cost: { input: 5, output: 25, cache_read: 0.5 },
            limit: LIMIT,
          },
          "claude-sonnet-5": {
            id: "claude-sonnet-5",
            family: "claude-sonnet",
            release_date: "2026-02-17",
            cost: { input: 3, output: 15, cache_read: 0.3 },
            limit: LIMIT,
          },
          [newestSonnetId]: {
            id: newestSonnetId,
            family: "claude-sonnet",
            release_date: "2026-06-01",
            cost: { input: 3, output: 15, cache_read: 0.3 },
            limit: LIMIT,
          },
        },
      },
    };
  }

  const familyLines = (spy: ReturnType<typeof vi.spyOn>): unknown[][] =>
    (spy.mock.calls as unknown[][]).filter(
      (c) =>
        typeof c[0] === "string" &&
        c[0].includes("worker model: newest in family"),
    );

  test("family path: the 'newest in family' line is logged once per snapshot despite repeated getWorkerModel calls", async () => {
    await warmCache(anthropicSnapshot("claude-sonnet-6"));

    // Spy AFTER warming so we only observe resolution logs, not fetch logs.
    const infoSpy = vi.spyOn(log, "info").mockImplementation(() => {});

    for (let i = 0; i < 5; i++) {
      const r = getWorkerModel({
        providerID: "anthropic",
        model: "claude-opus-4-6",
      });
      expect(r?.modelID).toBe("claude-sonnet-6");
    }

    // Without memoization this fires 5×; memoized it collapses to exactly 1.
    expect(familyLines(infoSpy)).toHaveLength(1);
  });

  test("unknown-provider path: the 'dynamic worker model' line is logged once per snapshot despite repeated calls", async () => {
    await warmCache({
      anthropic: { api: "https://api.anthropic.com/v1", models: {} },
      google: {
        api: "https://generativelanguage.googleapis.com/v1beta",
        models: {
          "gemini-3.1-pro": {
            id: "gemini-3.1-pro",
            family: "gemini-pro",
            release_date: "2026-05-01",
            cost: { input: 4, output: 20 },
            limit: LIMIT,
          },
          "gemini-3-flash-lite": {
            id: "gemini-3-flash-lite",
            family: "gemini-flash-lite",
            release_date: "2026-04-01",
            cost: { input: 0.15, output: 0.6 },
            limit: LIMIT,
          },
        },
      },
    });

    const infoSpy = vi.spyOn(log, "info").mockImplementation(() => {});

    for (let i = 0; i < 5; i++) {
      const r = getWorkerModel({
        providerID: "google",
        model: "gemini-3.1-pro",
      });
      expect(r?.modelID).toBe("gemini-3-flash-lite");
    }

    const dynamicLines = infoSpy.mock.calls.filter(
      (c) => typeof c[0] === "string" && c[0].includes("dynamic worker model:"),
    );
    expect(dynamicLines).toHaveLength(1);
  });

  test("distinct query inputs are memoized independently (no cross-key collision)", async () => {
    // One snapshot serving both the family path (anthropic) and the
    // cheaper path (google) — repeated calls to each must each log once,
    // proving the memo key discriminates rather than sharing one slot.
    await warmCache({
      anthropic: anthropicSnapshot("claude-sonnet-6").anthropic,
      google: {
        api: "https://generativelanguage.googleapis.com/v1beta",
        models: {
          "gemini-3.1-pro": {
            id: "gemini-3.1-pro",
            family: "gemini-pro",
            release_date: "2026-05-01",
            cost: { input: 4, output: 20 },
            limit: LIMIT,
          },
          "gemini-3-flash-lite": {
            id: "gemini-3-flash-lite",
            family: "gemini-flash-lite",
            release_date: "2026-04-01",
            cost: { input: 0.15, output: 0.6 },
            limit: LIMIT,
          },
        },
      },
    });

    const infoSpy = vi.spyOn(log, "info").mockImplementation(() => {});

    getWorkerModel({ providerID: "anthropic", model: "claude-opus-4-6" });
    getWorkerModel({ providerID: "anthropic", model: "claude-opus-4-6" });
    getWorkerModel({ providerID: "google", model: "gemini-3.1-pro" });
    getWorkerModel({ providerID: "google", model: "gemini-3.1-pro" });

    expect(familyLines(infoSpy)).toHaveLength(1);
    const dynamicLines = infoSpy.mock.calls.filter(
      (c) => typeof c[0] === "string" && c[0].includes("dynamic worker model:"),
    );
    expect(dynamicLines).toHaveLength(1);
  });

  test("a new models.dev snapshot re-resolves (memo is snapshot-scoped, never permanently stale)", async () => {
    await warmCache(anthropicSnapshot("claude-sonnet-6"));
    expect(
      getWorkerModel({ providerID: "anthropic", model: "claude-opus-4-6" })
        ?.modelID,
    ).toBe("claude-sonnet-6");

    // A later refresh introduces an even newer sonnet. The memo must not pin
    // the stale answer — resolution reflects the new snapshot and re-announces.
    const infoSpy = vi.spyOn(log, "info").mockImplementation(() => {});
    await warmCache(anthropicSnapshot("claude-sonnet-7"));

    expect(
      getWorkerModel({ providerID: "anthropic", model: "claude-opus-4-6" })
        ?.modelID,
    ).toBe("claude-sonnet-7");
    expect(familyLines(infoSpy).length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// resetWorkerModelState
// ---------------------------------------------------------------------------

describe("resetWorkerModelState", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    resetWorkerModelState();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetWorkerModelState();
  });

  test("clears cache so next fetchModelData re-fetches", async () => {
    // Use relative call-count deltas instead of absolute values to avoid
    // flakiness from cross-test pollution: another test file's async
    // resetPipelineState() → resetWorkerModelState() can clear the model
    // cache while our mock is active, causing unexpected re-fetches.
    let callCount = 0;
    globalThis.fetch = vi.fn(() => {
      callCount++;
      return Promise.resolve(
        new Response(JSON.stringify(buildModelsDevResponse(DEFAULT_MODELS)), {
          status: 200,
        }),
      );
    }) as unknown as typeof fetch;

    // Ensure cache is clear so the first fetch is ours
    resetWorkerModelState();
    callCount = 0;

    await fetchModelData();
    const afterFirst = callCount;
    expect(afterFirst).toBeGreaterThanOrEqual(1);

    // Without reset, cached — count should not increase
    await fetchModelData();
    expect(callCount).toBe(afterFirst);

    // After reset, re-fetches — count should increase by at least 1.
    // Use >= instead of === because cross-test resetPipelineState() can
    // clear the cache concurrently, causing an extra fetch on our mock.
    resetWorkerModelState();
    const beforeReset = callCount;
    await fetchModelData();
    expect(callCount).toBeGreaterThanOrEqual(beforeReset + 1);
  });
});
