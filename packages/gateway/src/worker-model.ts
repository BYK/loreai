/**
 * Gateway model pricing and resolution.
 *
 * Fetches per-model pricing from models.dev (open-source model database)
 * for cost estimation in Sentry metrics and gradient cost-aware capping.
 *
 * Worker model resolution delegates to core's simple chain:
 *   explicit config override > session model fallback.
 */

import { workerModel, config as loreConfig, log } from "@loreai/core";
import type { ProviderRoute } from "./config";
import { upstreamFetch } from "./fetch";

// ---------------------------------------------------------------------------
// Cost lookup — models.dev
// ---------------------------------------------------------------------------

/**
 * models.dev JSON API endpoint — returns all providers/models with pricing.
 *
 * Single request replaces N individual TOML fetches. Response shape:
 *   { anthropic: { models: { "claude-sonnet-4-20250514": { cost: { input: 3, output: 15, cache_read: 0.3 }, limit: { context: 200000, output: 64000 } }, ... } } }
 * Cost values are per-million-token USD. Limit values are token counts.
 */
const MODELS_DEV_API = "https://models.dev/api.json";

/** Cached models.dev data: model entries keyed by modelID (all providers). */
let cachedModelData: Map<string, ModelsDevEntry> | null = null;
/** Cached provider → model IDs index for same-provider cheaper-model lookup. */
let cachedProviderModels: Map<string, string[]> | null = null;
/** Cached provider routing data extracted from the models.dev response. */
let cachedProviderRoutes: Map<string, ProviderRoute> | null = null;
let cachedModelDataAt = 0;
let inflightFetch: Promise<Map<string, ModelsDevEntry>> | null = null;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Memoized worker-model resolutions (both `resolveNewestInFamily` and
 * `findCheaperSameProviderModel`).
 *
 * A resolution is a pure function of the models.dev snapshot — versioned by
 * `cachedModelDataAt` — plus its query inputs, so the answer cannot change until
 * the snapshot does. Reusing it skips the (cheap) rescan, but the real win is
 * logging: `getWorkerModel()` runs on ~10 background hot paths (idle loop,
 * cache-warmer, cost-tracker, pipeline), so without memoization each idle cycle
 * re-emits the same INFO line ~4×. Memoizing collapses it to exactly one line
 * per genuinely-new outcome, and correctly re-announces after a models.dev
 * refresh changes the answer (new snapshot version → memo rebuilt).
 *
 * Keyed by a `\x1f`-joined tuple; stores `undefined` for memoized negative
 * results (distinguished from "absent" via `Map.has`). Rebuilt lazily when the
 * snapshot version advances and reset in `clearModelDataCache()`.
 */
let resolutionMemo = new Map<string, string | undefined>();
let resolutionMemoVersion = -1;

/**
 * Return the resolution memo valid for the current models.dev snapshot,
 * rebuilding it when the snapshot version (`cachedModelDataAt`) has advanced.
 */
function currentResolutionMemo(): Map<string, string | undefined> {
  if (resolutionMemoVersion !== cachedModelDataAt) {
    resolutionMemo = new Map();
    resolutionMemoVersion = cachedModelDataAt;
  }
  return resolutionMemo;
}

/** Providers to fetch pricing data for from models.dev. */
const SUPPORTED_PROVIDERS = ["anthropic", "openai"] as const;

/** Shape of a model entry in the models.dev JSON API. */
export type ModelsDevEntry = {
  id: string;
  /**
   * models.dev model family (e.g. "claude-sonnet", "gpt-mini", "gpt-codex").
   * Groups successive generations of the same tier so worker defaults can
   * track the newest member instead of pinning a hardcoded ID that goes stale.
   */
  family?: string;
  /** ISO `YYYY-MM-DD` release date — lexicographically sortable == chronological. */
  release_date?: string;
  cost?: {
    input?: number;
    output?: number;
    cache_read?: number;
    cache_write?: number;
  };
  limit?: { context?: number; output?: number };
  /**
   * Whether the model accepts a non-default sampling `temperature` (and
   * `top_p`/`top_k`). `false` on the deprecated-sampling generation
   * (claude-sonnet-5, claude-opus-4-7/4-8, gpt-5, o3, …), which 400s any
   * request that sets it. Drives the proactive temperature strip on worker
   * requests. Absent for models.dev entries that predate the field.
   */
  temperature?: boolean;
  /** Whether the model has any extended/adaptive reasoning capability. */
  reasoning?: boolean;
  /**
   * The reasoning control shapes the model exposes. The `toggle` type marks a
   * model whose adaptive thinking is ON BY DEFAULT and is turned off with
   * `thinking:{type:"disabled"}` (claude-sonnet-5). `effort`-only
   * (claude-opus-4-8, gpt-5) and `budget_tokens` (claude-sonnet-4-5) models run
   * WITHOUT thinking unless it is explicitly requested, so they need no opt-out.
   */
  reasoning_options?: Array<{ type?: string }>;
};

/** Shape of the models.dev JSON API response (subset we care about). */
type ModelsDevResponse = {
  [provider: string]: {
    id?: string;
    api?: string;
    npm?: string;
    models?: { [modelId: string]: ModelsDevEntry };
  };
};

/**
 * Minimal fallback costs (per-million-token, USD) used when models.dev
 * API is unreachable. Only includes models involved in worker selection
 * decisions — everything else uses the generic unknown-model default.
 *
 * Dynamic pricing from models.dev is the primary source; these are a
 * safety net for offline/unreachable scenarios.
 */
const FALLBACK_PRICING: Array<{
  prefix: string;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  context: number;
  outputLimit: number;
}> = [
  // Session models that trigger cost-aware worker selection (input ≥ $1.50/M)
  {
    prefix: "claude-opus-4",
    input: 5,
    output: 25,
    cache_read: 0.5,
    cache_write: 6.25,
    context: 1_000_000,
    outputLimit: 128_000,
  },
  {
    prefix: "gpt-5.4",
    input: 2.5,
    output: 15,
    cache_read: 0.625,
    cache_write: 3.125,
    context: 1_050_000,
    outputLimit: 100_000,
  },
  {
    prefix: "gpt-5.5",
    input: 5,
    output: 30,
    cache_read: 1.25,
    cache_write: 6.25,
    context: 1_050_000,
    outputLimit: 100_000,
  },
  // Worker model defaults
  {
    prefix: "claude-sonnet-5",
    input: 2,
    output: 10,
    cache_read: 0.2,
    cache_write: 2.5,
    context: 1_000_000,
    outputLimit: 128_000,
  },
  {
    prefix: "claude-sonnet-4",
    input: 3,
    output: 15,
    cache_read: 0.3,
    cache_write: 3.75,
    context: 1_000_000,
    outputLimit: 64_000,
  },
  {
    prefix: "gpt-5.4-mini",
    input: 0.75,
    output: 4.5,
    cache_read: 0.19,
    cache_write: 0.94,
    context: 400_000,
    outputLimit: 100_000,
  },
];

function fallbackEntry(modelID: string): ModelsDevEntry {
  // OpenRouter `:free` suffix models cost nothing — don't inflate budget.
  if (modelID.endsWith(":free")) {
    return {
      id: modelID,
      cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
      limit: { context: 200_000, output: 8_192 },
    };
  }

  for (const fb of FALLBACK_PRICING) {
    if (modelID.startsWith(fb.prefix)) {
      return {
        id: modelID,
        cost: {
          input: fb.input,
          output: fb.output,
          cache_read: fb.cache_read,
          cache_write: fb.cache_write,
        },
        limit: { context: fb.context, output: fb.outputLimit },
      };
    }
  }
  // Unknown model — assume mid-range so metrics are roughly correct
  return {
    id: modelID,
    cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
    limit: { context: 200_000, output: 8_192 },
  };
}

/**
 * Fetch model data from models.dev for supported providers.
 *
 * Single HTTP request, cached for 1 hour. Returns a map of
 * modelID → entry with cost and limit data across all supported providers.
 */
export function fetchModelData(): Promise<Map<string, ModelsDevEntry>> {
  // Return cache if fresh
  if (cachedModelData && Date.now() - cachedModelDataAt < CACHE_TTL_MS) {
    return Promise.resolve(cachedModelData);
  }

  // Deduplicate concurrent calls: return the in-flight promise if one exists
  if (inflightFetch) return inflightFetch;

  inflightFetch = (async () => {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);

      const response = await upstreamFetch(MODELS_DEV_API, {
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!response.ok) {
        log.warn(
          `models.dev API failed: ${response.status} ${response.statusText}`,
        );
        return cachedModelData ?? new Map();
      }

      const data = (await response.json()) as ModelsDevResponse;
      const modelData = new Map<string, ModelsDevEntry>();
      const providerModelsIndex = new Map<string, string[]>();
      const providerRoutes = new Map<string, ProviderRoute>();
      const loadedProviders: string[] = [];

      // Iterate ALL providers in the response — not just a hardcoded
      // subset. This ensures model pricing data is available for any
      // provider the user connects (MiniMax, Google, xAI, etc.), enabling
      // cost-aware worker model selection on unknown providers.
      for (const [providerID, providerData] of Object.entries(data)) {
        if (!providerData || typeof providerData !== "object") continue;

        // Extract model pricing data + build provider→models index
        const providerModels = providerData.models;
        if (providerModels && typeof providerModels === "object") {
          const modelIds: string[] = [];
          for (const [modelId, entry] of Object.entries(providerModels)) {
            const e: ModelsDevEntry = { ...entry, id: modelId };
            // Compute cache_write cost if not provided (typically 1.25× input price)
            if (e.cost && e.cost.cache_write == null && e.cost.input != null) {
              e.cost.cache_write = e.cost.input * 1.25;
            }
            modelData.set(modelId, e);
            modelIds.push(modelId);
          }
          providerModelsIndex.set(providerID, modelIds);
          loadedProviders.push(providerID);
        }

        // Extract provider routing data (base URL + protocol)
        const api = providerData.api;
        const npm = providerData.npm;
        if (api && typeof api === "string") {
          const protocol = npmToProtocol(npm);
          // Strip trailing /v1 — gateway appends /v1/messages or /v1/chat/completions.
          const url = api.replace(/\/v1\/?$/, "");
          providerRoutes.set(providerID, { url, protocol });
        }
      }

      // Warn if core providers are missing (likely API change)
      for (const required of SUPPORTED_PROVIDERS) {
        if (!loadedProviders.includes(required)) {
          log.warn(`models.dev API: no ${required} provider found`);
        }
      }

      cachedProviderRoutes = providerRoutes;
      cachedProviderModels = providerModelsIndex;
      cachedModelData = modelData;
      cachedModelDataAt = Date.now();

      log.info(
        `models.dev: loaded data for ${modelData.size} models across ${loadedProviders.length} providers`,
      );
      return modelData;
    } catch (e) {
      log.warn("models.dev API error:", e);
      return cachedModelData ?? new Map();
    } finally {
      inflightFetch = null;
    }
  })();

  return inflightFetch;
}

/**
 * Derive the wire protocol from the models.dev `npm` package name.
 *
 * - `@ai-sdk/anthropic` → "anthropic"
 * - `@ai-sdk/openai` → "openai-responses"
 * - everything else (including `@ai-sdk/openai-compatible`) → "openai"
 */
function npmToProtocol(
  npm: string | undefined,
): "anthropic" | "openai" | "openai-responses" {
  if (!npm) return "openai";
  if (npm === "@ai-sdk/anthropic") return "anthropic";
  if (npm === "@ai-sdk/openai") return "openai-responses";
  return "openai";
}

/**
 * Dynamically look up a provider route from the models.dev API cache.
 *
 * Called as a fallback when `resolveProviderRoute()` (static table) returns
 * null. Returns cached data immediately when available. On cache miss or
 * stale cache, triggers a background refresh and returns stale data (or
 * null) — never blocks the hot request path on a network call.
 */
export function lookupProviderRoute(providerID: string): ProviderRoute | null {
  // Return from cache (fresh or stale) — never block the request.
  if (cachedProviderRoutes) {
    // If stale, trigger a background refresh (fire-and-forget).
    if (Date.now() - cachedModelDataAt >= CACHE_TTL_MS) {
      fetchModelData().catch(() => {});
    }
    return cachedProviderRoutes.get(providerID) ?? null;
  }
  // No cache at all — trigger a background fetch for next request.
  fetchModelData().catch(() => {});
  return null;
}

/**
 * Look up model data by ID, with prefix matching and fallback.
 *
 * First tries exact match, then prefix match (e.g. "claude-opus-4-6-20260101"
 * matches "claude-opus-4-6"), then falls back to hardcoded defaults.
 */
export async function getModelEntry(modelID: string): Promise<ModelsDevEntry> {
  const data = await fetchModelData();

  // Exact match
  const exact = data.get(modelID);
  if (exact) return exact;

  // Prefix match: find the entry whose ID is a prefix of the requested model
  for (const [id, entry] of data) {
    if (modelID.startsWith(id)) return entry;
  }

  // Reverse prefix: find if the requested model is a prefix of any entry
  for (const [id, entry] of data) {
    if (id.startsWith(modelID)) return entry;
  }

  return fallbackEntry(modelID);
}

/**
 * Synchronous model entry lookup — reads from the in-memory cache only.
 *
 * Use this on the hot request path where async is impractical. Returns
 * fallback defaults if the cache hasn't been populated yet (e.g. before
 * the first `fetchModelData()` call completes). Pre-warm the cache by
 * calling `fetchModelData()` during gateway init.
 */
export function getModelEntrySync(modelID: string): ModelsDevEntry {
  if (!cachedModelData) return fallbackEntry(modelID);

  // Exact match
  const exact = cachedModelData.get(modelID);
  if (exact) return exact;

  // Prefix match
  for (const [id, entry] of cachedModelData) {
    if (modelID.startsWith(id)) return entry;
  }

  // Reverse prefix
  for (const [id, entry] of cachedModelData) {
    if (id.startsWith(modelID)) return entry;
  }

  return fallbackEntry(modelID);
}

/** True when models.dev data has been loaded into the in-memory cache. */
export function isModelDataLoaded(): boolean {
  return cachedModelData !== null;
}

/**
 * After a failed/timed-out readiness wait, don't re-pay the wait again for this
 * long. Without this, a sustained models.dev outage (cachedModelData stays
 * null) would make EVERY conversation turn pay the full `timeoutMs` wait. The
 * background fire-and-forget pre-warm and other call sites keep retrying; this
 * just bounds the per-turn cost to one wait per cooldown.
 */
const READY_RETRY_COOLDOWN_MS = 30_000;
let lastReadyAttemptAt = 0;

/**
 * Best-effort wait for models.dev data to be available before a synchronous
 * getModelSpec/getModelEntrySync lookup. Returns immediately if data is already
 * loaded; otherwise kicks off (or joins) the fetch and waits at most
 * `timeoutMs`, then resolves regardless so the caller never hangs on a slow or
 * unreachable models.dev. This closes the cold-start race where the FIRST
 * request after a restart computes its budget from fallback pricing/limits
 * (e.g. l0cap=80000 instead of the model's real cap) before the fire-and-forget
 * pre-warm resolves. After the first success the 1h cache serves everyone.
 *
 * On a sustained outage `cachedModelData` stays null, so we only pay the wait
 * once per READY_RETRY_COOLDOWN_MS — subsequent turns fall straight through to
 * the synchronous fallback path instead of each blocking for `timeoutMs`.
 */
export async function ensureModelDataReady(timeoutMs = 2_000): Promise<void> {
  if (cachedModelData !== null) return;
  // Recently attempted and still not loaded — don't re-pay the wait every turn.
  if (Date.now() - lastReadyAttemptAt < READY_RETRY_COOLDOWN_MS) return;
  lastReadyAttemptAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      fetchModelData(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
        // Don't let the timeout timer keep the event loop alive.
        timer.unref?.();
      }),
    ]);
  } catch {
    // fetchModelData handles its own errors; never let this block the request.
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Clear cached data (for testing). */
export function clearModelDataCache(): void {
  cachedModelData = null;
  cachedProviderModels = null;
  cachedProviderRoutes = null;
  cachedModelDataAt = 0;
  inflightFetch = null;
  lastReadyAttemptAt = 0;
  resolutionMemo = new Map();
  resolutionMemoVersion = -1;
}

/**
 * Test-only: seed the models.dev cache directly (no network) so
 * `getModelEntrySync` returns known capability entries. Bumps the snapshot
 * version so any resolution memo is invalidated.
 */
export function _setModelDataForTest(
  entries: Record<string, ModelsDevEntry>,
): void {
  cachedModelData = new Map(Object.entries(entries));
  cachedModelDataAt = Date.now();
  resolutionMemo = new Map();
  resolutionMemoVersion = -1;
}

// ---------------------------------------------------------------------------
// Dynamic cheaper-model discovery
// ---------------------------------------------------------------------------

/**
 * Find a cheaper model from the same provider using models.dev pricing data.
 *
 * For providers without hardcoded WORKER_DEFAULTS (Google, MiniMax, xAI, etc.),
 * this is family-aware so a discovered worker tracks new generations the same
 * way the hardcoded WORKER_DEFAULTS do (via `resolveNewestInFamily`):
 *
 *   1. Pass 1 — find the absolute cheapest same-provider model strictly cheaper
 *      than the session (input price). Its family identifies the cheapest TIER.
 *   2. Pass 2 — within that cheapest family, return the NEWEST member that is
 *      still cheaper than the session. This avoids pinning an obsolete model
 *      just because it's a few cents cheaper than its modern sibling (e.g.
 *      gemini-2.5-flash-lite over a newer gemini-3-flash-lite), while staying
 *      in the same cost tier and never exceeding the session price.
 *
 * Falls back to the Pass-1 cheapest when the cheapest model has no family
 * metadata (preserving the original cheapest-by-cost behavior offline).
 * Returns undefined if no cheaper model exists.
 */
function findCheaperSameProviderModel(
  providerID: string,
  sessionModelID: string,
  sessionInputCost: number,
): string | undefined {
  const providerModelIds = cachedProviderModels?.get(providerID);
  if (!providerModelIds || !cachedModelData) return undefined;

  const memo = currentResolutionMemo();
  const memoKey = `cheaper\x1f${providerID}\x1f${sessionModelID}\x1f${sessionInputCost}`;
  if (memo.has(memoKey)) return memo.get(memoKey);

  // Pass 1: cheapest same-provider model cheaper than the session.
  let cheapestId: string | undefined;
  let cheapestCost = sessionInputCost;
  let cheapestFamily: string | undefined;
  for (const modelId of providerModelIds) {
    if (modelId === sessionModelID) continue;
    const entry = cachedModelData.get(modelId);
    if (entry?.cost?.input == null) continue;
    if (entry.cost.input < cheapestCost) {
      cheapestCost = entry.cost.input;
      cheapestId = modelId;
      cheapestFamily = entry.family;
    }
  }
  if (!cheapestId) {
    memo.set(memoKey, undefined);
    return undefined;
  }

  // Pass 2: within the cheapest family, prefer the newest member that is still
  // cheaper than the session (release_date desc, then numeric-aware id desc so
  // "-10" sorts after "-9").
  let resolvedId = cheapestId;
  if (cheapestFamily) {
    let bestDate = cachedModelData.get(cheapestId)?.release_date ?? "";
    for (const modelId of providerModelIds) {
      if (modelId === sessionModelID) continue;
      const entry = cachedModelData.get(modelId);
      if (entry?.family !== cheapestFamily) continue;
      if (entry.cost?.input == null || entry.cost.input >= sessionInputCost) {
        continue;
      }
      const date = entry.release_date ?? "";
      if (
        date > bestDate ||
        (date === bestDate &&
          modelId.localeCompare(resolvedId, "en", { numeric: true }) > 0)
      ) {
        bestDate = date;
        resolvedId = modelId;
      }
    }
  }

  const resolvedCost = cachedModelData.get(resolvedId)?.cost?.input;
  log.info(
    `dynamic worker model: ${providerID}/${resolvedId} ($${resolvedCost}/M` +
      `${cheapestFamily ? `, family ${cheapestFamily}` : ""}) ` +
      `instead of ${sessionModelID} ($${sessionInputCost}/M)`,
  );

  memo.set(memoKey, resolvedId);
  return resolvedId;
}

/**
 * Resolve the NEWEST model in a target family from models.dev data.
 *
 * Replaces a hardcoded worker model ID (e.g. "claude-sonnet-4-6") with the
 * freshest equivalent the provider currently ships (e.g. "claude-sonnet-5"),
 * so worker defaults don't go stale as new model generations land.
 *
 * A candidate qualifies when it:
 *   1. Belongs to `providerID` (per the models.dev provider→models index).
 *   2. Has models.dev `family === family`.
 *   3. Passes `isCheapVariant(id)` — the SAME predicate that decides whether a
 *      session model is "already cheap". Within a family this discriminates the
 *      cheap tier from the full tier. This is the codex caveat: family
 *      "gpt-codex" contains both gpt-5.x-codex AND gpt-5.x-codex-mini; only the
 *      mini is a valid worker, so "newest in family" must never upgrade to the
 *      full codex.
 *   4. Has KNOWN pricing that costs strictly less than `maxInputCost` ($/M) — a
 *      cost-aware guard so a worker is never pricier than the session model.
 *      Members with unknown pricing are skipped: we cannot prove they clear the
 *      cap, so the caller falls back to the known-cheap hardcoded default rather
 *      than guessing.
 *
 * Returns the newest qualifying model ID (release_date desc, then numeric-aware
 * id desc as a deterministic tie-break), or undefined when none qualify / the
 * cache is cold — in which case the caller falls back to the hardcoded
 * `WORKER_DEFAULTS` ID.
 */
function resolveNewestInFamily(
  providerID: string,
  family: string,
  isCheapVariant: (id: string) => boolean,
  maxInputCost: number,
): string | undefined {
  const providerModelIds = cachedProviderModels?.get(providerID);
  if (!providerModelIds || !cachedModelData) return undefined;

  const memo = currentResolutionMemo();
  const memoKey = `family\x1f${providerID}\x1f${family}\x1f${maxInputCost}`;
  if (memo.has(memoKey)) return memo.get(memoKey);

  let bestId: string | undefined;
  let bestDate = "";
  for (const id of providerModelIds) {
    const entry = cachedModelData.get(id);
    if (!entry || entry.family !== family) continue;
    if (!isCheapVariant(id)) continue;
    // Cost guard: skip family members priced at/above the session model, and
    // members with unknown pricing — we cannot prove they clear the cap, so we
    // fall back to the known-cheap hardcoded default instead of guessing.
    const input = entry.cost?.input;
    if (input == null || input >= maxInputCost) continue;

    // release_date is ISO YYYY-MM-DD, so string comparison is chronological.
    // Tie-break on id with numeric awareness so "-10" sorts after "-9".
    const date = entry.release_date ?? "";
    if (
      bestId === undefined ||
      date > bestDate ||
      (date === bestDate &&
        id.localeCompare(bestId, "en", { numeric: true }) > 0)
    ) {
      bestId = id;
      bestDate = date;
    }
  }

  if (bestId) {
    log.info(
      `worker model: newest in family ${providerID}/${family} → ${bestId}`,
    );
  }
  memo.set(memoKey, bestId);
  return bestId;
}

// ---------------------------------------------------------------------------
// Resolution — wrapper around core's resolveWorkerModel
// ---------------------------------------------------------------------------

/**
 * Cost-aware worker model defaults per provider family.
 *
 * When the session model costs ≥ EXPENSIVE_MODEL_THRESHOLD, background workers
 * (distillation, curation, query expansion) use a cheaper model from the same
 * provider family. Each mapping was validated via A/B testing on large
 * conversation segments (22 msgs, complex debugging with corrections).
 *
 * Validated pairs (observation counts on large segment):
 *   Anthropic:  Opus 4.6 (23 obs) → Sonnet 4.6 (25 obs)  — quality parity
 *   OpenAI:     GPT-5.4  (24 obs) → GPT-5.4-mini (24 obs) — exact match
 *
 * Disqualified (>20% observation loss):
 *   Google:     Gemini 3.1 Pro (20 obs) → Gemini 3 Flash (13 obs) — -35% drop
 *
 * Untested (API returned no response via OpenCode SDK):
 *   xAI, Mistral — fall back to session model
 */
const WORKER_DEFAULTS: Record<
  string,
  {
    providerID: string;
    modelID: string;
    /**
     * models.dev family the worker should track. When set, the cost-aware
     * default resolves to the NEWEST cheap-tier member of this family
     * (via `resolveNewestInFamily`), and `modelID` becomes the offline
     * fallback used only when models.dev data is unavailable or yields
     * no qualifying candidate.
     */
    family?: string;
    alreadyCheap: (id: string) => boolean;
  }
> = {
  // Anthropic: sonnet matches opus quality on distillation at lower cost.
  // family "claude-sonnet" tracks the newest sonnet live from models.dev; the
  // modelID is only the OFFLINE fallback, so keep it on the current newest
  // (claude-sonnet-5, $2/$10 — cheaper AND newer than the old sonnet-4-6 pin).
  anthropic: {
    providerID: "anthropic",
    modelID: "claude-sonnet-5",
    family: "claude-sonnet",
    alreadyCheap: (id) => id.includes("sonnet") || id.includes("haiku"),
  },
  // OpenAI: gpt-5.4-mini matched gpt-5.4 exactly (24 obs each) at 70% lower cost.
  // family "gpt-mini" tracks the newest mini (gpt-5.x-mini, gpt-4.1-mini, ...).
  openai: {
    providerID: "openai",
    modelID: "gpt-5.4-mini",
    family: "gpt-mini",
    alreadyCheap: (id) => id.includes("mini") || id.includes("nano"),
  },
  // Codex (ChatGPT): the backend serves cheaper models on the same endpoint.
  // gpt-5.1-codex-mini ($0.25/$2) vs gpt-5.5 ($5/$30) — ~20x cheaper input,
  // same provider, same OAuth credential, same /codex/responses endpoint.
  // CAVEAT: family "gpt-codex" also contains the FULL gpt-5.x-codex models;
  // the `alreadyCheap` (mini/spark) filter inside resolveNewestInFamily keeps
  // us on the mini tier so "newest in family" never upgrades to full codex.
  "openai-codex": {
    providerID: "openai-codex",
    modelID: "gpt-5.1-codex-mini",
    family: "gpt-codex",
    alreadyCheap: (id) => id.includes("mini") || id.includes("spark"),
  },
  // GitHub Copilot proxies multiple providers — match by model ID prefix.
  // No `family`: Copilot's family resolution is handled by
  // resolveGitHubCopilotWorker (model IDs use different formatting, e.g.
  // "claude-sonnet-4.6"), so this entry serves only as a last-resort fallback.
  "github-copilot": {
    providerID: "github-copilot",
    modelID: "gpt-5.4-mini", // default; overridden by resolveGitHubCopilotWorker
    alreadyCheap: (id) =>
      id.includes("mini") ||
      id.includes("nano") ||
      id.includes("flash") ||
      id.includes("haiku"),
  },
};

/** Cost threshold ($/M input) above which we downgrade to a cheaper worker. */
const EXPENSIVE_MODEL_THRESHOLD = 1.5;

/**
 * General-purpose fallback worker for GitHub Copilot sessions where no
 * same-family worker is detected. GPT-5.4-mini matched GPT-5.4 exactly
 * (24 obs each) on distillation quality.
 *
 * Only used for GitHub Copilot (where all models are available at no
 * extra cost). For other providers, we fall back to the session model
 * rather than risk calling a provider that may not be configured.
 */
const _GENERAL_FALLBACK_WORKER = {
  providerID: "github-copilot",
  modelID: "gpt-5.4-mini",
};

/**
 * For GitHub Copilot sessions, pick the worker based on which provider family
 * the session model belongs to (detected via model ID prefix).
 */
function resolveGitHubCopilotWorker(sessionModelID: string): {
  providerID: string;
  modelID: string;
} {
  if (sessionModelID.startsWith("claude-")) {
    return { providerID: "github-copilot", modelID: "claude-sonnet-4.6" };
  }
  // For all other model families (OpenAI, Google, xAI, etc.) use GPT-5.4-mini
  // which is available on Copilot and validated for quality parity
  return { providerID: "github-copilot", modelID: "gpt-5.4-mini" };
}

/**
 * Resolve the effective worker model for background calls.
 *
 * Checks (in order):
 *  1. Explicit config override (`workerModel` in lore config)
 *  2. Provider-aware cost default (validated cheaper model from same family)
 *  3. General fallback (GPT-5.4-mini) for unknown providers
 *  4. Config model fallback (session model)
 */
export function getWorkerModel(session?: {
  providerID?: string;
  /** Session model ID (UpstreamSnapshot uses `model`, callers may use `modelID`). */
  model?: string;
}): { providerID: string; modelID: string } | undefined {
  // Env var override — highest priority. Useful for global worker model
  // configuration without per-project .lore.json (e.g. routing all workers
  // to MiniMax). Format: "providerID/modelID" or just "modelID" (defaults
  // to anthropic provider).
  const envModel = process.env.LORE_WORKER_MODEL;
  if (envModel) {
    const slashIdx = envModel.indexOf("/");
    if (slashIdx > 0) {
      return {
        providerID: envModel.slice(0, slashIdx),
        modelID: envModel.slice(slashIdx + 1),
      };
    }
    // No slash — assume anthropic provider (most common case)
    return { providerID: "anthropic", modelID: envModel };
  }

  const cfg = loreConfig();

  // The session's actual provider and model (from the last API request).
  // Workers MUST use the same provider as the session — cross-provider
  // calls always fail (wrong credentials, wrong API format).
  const sessionProviderID = session?.providerID;
  const sessionModelID = session?.model;

  // Effective provider: explicit config > session. Do NOT silently default to
  // "anthropic": fabricating an Anthropic worker for a session whose provider
  // is non-Anthropic (or unknown) produces a doomed cross-provider call — the
  // session's foreign key looked up under "anthropic" misses (→ no-auth, after
  // #776's fail-closed guard) or, worse, an anthropic worker is built for a
  // MiniMax/OpenRouter session. When neither config nor session names a
  // provider, we have no safe target → skip background work (return undefined).
  const effectiveProvider =
    cfg.model?.providerID ?? sessionProviderID ?? undefined;
  if (!effectiveProvider) return undefined;

  // Effective session model: config > session snapshot > provider default.
  const effectiveModelID = cfg.model?.modelID ?? sessionModelID ?? undefined;

  // Determine if the session model is expensive enough to warrant a cheaper
  // worker from the SAME provider. Never cross-provider.
  let costAwareDefault: { providerID: string; modelID: string } | undefined;
  if (effectiveModelID) {
    const entry = getModelEntrySync(effectiveModelID);
    const inputCost = entry.cost?.input ?? 3;

    if (inputCost >= EXPENSIVE_MODEL_THRESHOLD) {
      if (effectiveProvider === "github-copilot") {
        // GitHub Copilot proxies many providers — detect family from model ID
        costAwareDefault = resolveGitHubCopilotWorker(effectiveModelID);
      } else {
        const mapping = WORKER_DEFAULTS[effectiveProvider];
        if (mapping && !mapping.alreadyCheap(effectiveModelID)) {
          // Prefer the newest cheap-tier member of the target family from
          // models.dev (so the worker tracks new generations automatically);
          // fall back to the hardcoded modelID when data is cold/unavailable.
          const newest = mapping.family
            ? resolveNewestInFamily(
                mapping.providerID,
                mapping.family,
                mapping.alreadyCheap,
                inputCost,
              )
            : undefined;
          costAwareDefault = {
            providerID: mapping.providerID,
            modelID: newest ?? mapping.modelID,
          };
        }
        // Unknown providers: try to find a cheaper model from the same
        // provider using models.dev pricing data. This enables cost-aware
        // worker selection for Google, xAI, MiniMax, etc. without needing
        // hardcoded WORKER_DEFAULTS entries.
        if (!mapping && cachedModelData) {
          const cheaper = findCheaperSameProviderModel(
            effectiveProvider,
            effectiveModelID,
            inputCost,
          );
          if (cheaper) {
            costAwareDefault = {
              providerID: effectiveProvider,
              modelID: cheaper,
            };
          }
        }
      }
    }
  }

  // Build the fallback model (used when no cost-aware default or config
  // override applies). Priority:
  //   1. Config model from .lore.json
  //   2. Session model (same provider, same URL, same credentials — always
  //      safe). For unknown providers this echoes the session model as-is;
  //      for known providers with cheap models it also echoes. The pipeline
  //      wrapper's cross-provider guard (pipeline.ts) handles the race
  //      condition when the session switches providers mid-flight.
  //   3. Provider's default worker model (WORKER_DEFAULTS)
  //   4. undefined → skip background work
  const fallback: { providerID: string; modelID: string } | undefined =
    cfg.model ??
    (sessionModelID
      ? { providerID: effectiveProvider, modelID: sessionModelID }
      : undefined) ??
    WORKER_DEFAULTS[effectiveProvider];

  if (!fallback) return undefined;

  return workerModel.resolveWorkerModel(
    effectiveProvider,
    cfg.workerModel,
    fallback,
    costAwareDefault,
  );
}

/** Reset module state (for testing). */
export function resetWorkerModelState(): void {
  clearModelDataCache();
}
