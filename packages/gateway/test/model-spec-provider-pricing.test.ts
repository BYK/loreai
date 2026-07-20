/**
 * Regression guard for the provider-qualified session-model pricing fix
 * (PR #1407 follow-up).
 *
 * A bare model id published by MULTIPLE providers at DIFFERENT cache prices
 * (e.g. `deepseek/deepseek-v4-flash` on openrouter vs zenmux) was priced
 * last-write-wins by the flat models.dev map, corrupting the session's
 * `cacheReadCost` → `computeLayer0Cap`. `getModelSpec(model, providerID)` now
 * threads the routed provider so pricing comes from the provider the session is
 * ACTUALLY routed to.
 *
 * This drives the REAL `getModelSpec` (exported from pipeline.ts) rather than
 * only the `worker-model` helper in isolation, so dropping the provider arg at
 * the pipeline layer fails here — the helper-only test in worker-model.test.ts
 * would still pass on such a revert.
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { getModelSpec } from "../src/pipeline";
import {
  _setModelDataForTest,
  clearModelDataCache,
  type ModelsDevEntry,
} from "../src/worker-model";

const LIMIT = { context: 200_000, output: 64_000 };

// The same bare id, published by two providers at different cache_read prices.
const OPENROUTER_ENTRY: ModelsDevEntry = {
  id: "deepseek/deepseek-v4-flash",
  cost: { input: 0.098, output: 0.4, cache_read: 0.0196 },
  limit: LIMIT,
};
const ZENMUX_ENTRY: ModelsDevEntry = {
  id: "deepseek/deepseek-v4-flash",
  cost: { input: 0.14, output: 0.6, cache_read: 0.0028 },
  limit: LIMIT,
};

describe("getModelSpec provider-qualified pricing (pipeline call site)", () => {
  beforeEach(() => {
    // Flat map is last-write-wins → zenmux (seeded second) wins the bare id.
    // Provider-qualified map carries the true per-provider prices.
    _setModelDataForTest(
      { "deepseek/deepseek-v4-flash": ZENMUX_ENTRY },
      {
        "openrouter/deepseek/deepseek-v4-flash": OPENROUTER_ENTRY,
        "zenmux/deepseek/deepseek-v4-flash": ZENMUX_ENTRY,
      },
    );
  });
  afterEach(() => {
    clearModelDataCache();
  });

  test("prices from the ROUTED provider, not the last-write-wins flat entry", () => {
    // Mutation: revert the call site to getModelSpec(req.model) (drop the
    // provider arg) → both return zenmux's 0.0028/1e6 → RED.
    const or = getModelSpec("deepseek/deepseek-v4-flash", "openrouter");
    expect(or.cacheReadCost).toBeCloseTo(0.0196 / 1_000_000, 15);

    const zm = getModelSpec("deepseek/deepseek-v4-flash", "zenmux");
    expect(zm.cacheReadCost).toBeCloseTo(0.0028 / 1_000_000, 15);

    // The two routed prices must differ — proves the provider arg is load-bearing.
    expect(or.cacheReadCost).not.toBeCloseTo(zm.cacheReadCost ?? 0, 15);
  });

  test("falls back to the flat last-write-wins entry when provider is undefined (prefix-routed / header-less sessions)", () => {
    // Documents the intended no-op fallback: sessions routed by model-prefix or
    // X-Lore-Upstream-URL carry no X-Lore-Provider header → provider undefined →
    // legacy flat pricing (unchanged behavior).
    const spec = getModelSpec("deepseek/deepseek-v4-flash");
    expect(spec.cacheReadCost).toBeCloseTo(0.0028 / 1_000_000, 15);
  });
});
