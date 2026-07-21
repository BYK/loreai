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
import {
  isWorkerIncapable,
  areFreeModelsDataBlocked,
  blocklistGeneration,
} from "./worker-health";

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
/**
 * Cached models.dev data keyed by `${providerID}/${modelID}` so a bare id that
 * many providers publish at DIFFERENT prices (e.g. `deepseek/deepseek-v4-flash`
 * on openrouter vs zenmux vs alibaba-cn, each with a different `cache_read`) can
 * be priced from the provider the session is actually routed to. The flat
 * {@link cachedModelData} map is last-write-wins across providers, so a session
 * on openrouter would otherwise be priced with whichever provider appeared last
 * in the JSON — corrupting `cacheReadCostPerToken` → `computeLayer0Cap`.
 */
let cachedModelDataByProvider: Map<string, ModelsDevEntry> | null = null;
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
let resolutionMemoBlocklistGen = -1;

/**
 * Return the resolution memo valid for the current models.dev snapshot,
 * rebuilding it when the snapshot version (`cachedModelDataAt`) OR the
 * worker-health blocklist generation has advanced.
 *
 * The blocklist generation is load-bearing: a resolution is a pure function of
 * the models.dev snapshot AND the set of usable (non-blocklisted) models. When
 * a model is marked worker-incapable or a provider's `:free` tier is
 * data-policy-blocked, the correct answer changes even though the snapshot did
 * not — so the memo must be invalidated or a just-blocklisted model would keep
 * being served from a stale entry, defeating auto-recovery.
 */
function currentResolutionMemo(): Map<string, string | undefined> {
  const gen = blocklistGeneration();
  if (
    resolutionMemoVersion !== cachedModelDataAt ||
    resolutionMemoBlocklistGen !== gen
  ) {
    resolutionMemo = new Map();
    resolutionMemoVersion = cachedModelDataAt;
    resolutionMemoBlocklistGen = gen;
  }
  return resolutionMemo;
}

/** Providers to fetch pricing data for from models.dev. */
const SUPPORTED_PROVIDERS = ["anthropic", "openai"] as const;

/**
 * First-party model vendors whose models.dev entry is AUTHORITATIVE for a given
 * bare model id.
 *
 * models.dev lists the same bare id (e.g. `claude-sonnet-5`, `gpt-5`) under many
 * providers — the vendor plus aggregators/proxies (github-copilot, azure,
 * opencode, llmgateway, …) — and their capability flags frequently disagree
 * with the vendor's own. Because the flat model map is keyed by BARE id with
 * last-writer-wins, an aggregator iterated after the vendor silently clobbers
 * the vendor's correct data (real cases: github-copilot lists `claude-sonnet-5`
 * with NO `toggle` reasoning option, so adaptive-thinking-on detection breaks;
 * azure lists `claude-opus-4-8` as `temperature:true`, so proactive
 * temperature-strip breaks). We re-apply these vendors LAST so their canonical
 * entry wins regardless of provider ordering in the JSON. Later entries win, so
 * order least→most authoritative.
 */
const CANONICAL_MODEL_PROVIDERS = ["openai", "anthropic"] as const;

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
 * Normalize a raw models.dev model entry: stamp the id and derive `cache_write`
 * cost when the source omits it (typically 1.25× input price). Returns a fresh
 * object with a fresh `cost` so the source JSON is never mutated.
 */
function normalizeModelEntry(
  modelId: string,
  entry: ModelsDevEntry,
): ModelsDevEntry {
  const e: ModelsDevEntry = { ...entry, id: modelId };
  if (e.cost && e.cost.cache_write == null && e.cost.input != null) {
    e.cost = { ...e.cost, cache_write: e.cost.input * 1.25 };
  }
  return e;
}

/**
 * Among map ids satisfying `pred`, pick the LONGEST (most specific); break
 * length ties with a numeric-aware compare so the newest generation wins
 * (`claude-opus-4-8` over `claude-opus-4-5`). This makes prefix resolution
 * deterministic instead of returning the first hit in insertion order.
 */
function longestMatchingEntry(
  map: Map<string, ModelsDevEntry>,
  pred: (id: string) => boolean,
): ModelsDevEntry | null {
  let bestId: string | null = null;
  let best: ModelsDevEntry | null = null;
  for (const [id, entry] of map) {
    if (!pred(id)) continue;
    if (
      bestId === null ||
      id.length > bestId.length ||
      (id.length === bestId.length &&
        id.localeCompare(bestId, "en", { numeric: true }) > 0)
    ) {
      bestId = id;
      best = entry;
    }
  }
  return best;
}

/**
 * Resolve a model id against the models.dev map: exact match, then the longest
 * entry id that is a prefix of the requested id (dated/variant ids →
 * most-specific base), then the longest entry id that the requested id is a
 * prefix of (base/family id → most-specific known member). Deterministic
 * regardless of provider/JSON ordering. Returns null when nothing matches.
 */
function matchModelEntry(
  map: Map<string, ModelsDevEntry>,
  modelID: string,
): ModelsDevEntry | null {
  const exact = map.get(modelID);
  if (exact) return exact;
  return (
    longestMatchingEntry(map, (id) => modelID.startsWith(id)) ??
    longestMatchingEntry(map, (id) => id.startsWith(modelID))
  );
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
      const modelDataByProvider = new Map<string, ModelsDevEntry>();
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
            const normalized = normalizeModelEntry(modelId, entry);
            modelData.set(modelId, normalized);
            // Provider-qualified entry: never last-write-wins across providers,
            // so a session's cost is read from the provider it is routed to.
            modelDataByProvider.set(`${providerID}/${modelId}`, normalized);
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

      // Second pass: re-apply first-party vendors so their canonical capability
      // data (temperature, reasoning_options) wins over any aggregator/proxy
      // that defined the same bare model id earlier in the JSON. See
      // CANONICAL_MODEL_PROVIDERS. `.set()` on an existing key updates the value
      // in place without changing insertion order, so prefix/index ordering is
      // preserved — only the (previously order-dependent) capability flags are
      // corrected.
      for (const providerID of CANONICAL_MODEL_PROVIDERS) {
        const providerModels = data[providerID]?.models;
        if (!providerModels || typeof providerModels !== "object") continue;
        for (const [modelId, entry] of Object.entries(providerModels)) {
          const normalized = normalizeModelEntry(modelId, entry);
          modelData.set(modelId, normalized);
          modelDataByProvider.set(`${providerID}/${modelId}`, normalized);
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
      cachedModelDataByProvider = modelDataByProvider;
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
  return matchModelEntry(data, modelID) ?? fallbackEntry(modelID);
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
  return matchModelEntry(cachedModelData, modelID) ?? fallbackEntry(modelID);
}

/**
 * Provider-aware synchronous model entry lookup. Prefers the provider-qualified
 * entry (`${providerID}/${modelID}`) so a bare id published by multiple
 * providers at different prices is read from the provider the session is
 * actually routed to — NOT the last-write-wins flat entry. Falls back to the
 * bare {@link getModelEntrySync} lookup when the provider is unknown/undefined
 * or has no matching entry, so it is fully backward-compatible.
 *
 * Only an EXACT `${providerID}/${modelID}` hit uses the qualified map; prefix/
 * family matching stays on the flat map (the qualified map is a pure pricing
 * override for exactly-known routes, never a new matcher).
 */
export function getModelEntrySyncForProvider(
  providerID: string | undefined,
  modelID: string,
): ModelsDevEntry {
  if (providerID && cachedModelDataByProvider) {
    const qualified = cachedModelDataByProvider.get(`${providerID}/${modelID}`);
    if (qualified) return qualified;
  }
  return getModelEntrySync(modelID);
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
  cachedModelDataByProvider = null;
  cachedProviderModels = null;
  cachedProviderRoutes = null;
  cachedModelDataAt = 0;
  inflightFetch = null;
  lastReadyAttemptAt = 0;
  resolutionMemo = new Map();
  resolutionMemoVersion = -1;
  resolutionMemoBlocklistGen = -1;
}

/**
 * Test-only: seed the models.dev cache directly (no network) so
 * `getModelEntrySync` returns known capability entries. Bumps the snapshot
 * version so any resolution memo is invalidated.
 *
 * `byProvider` optionally seeds the provider-qualified map (keys are
 * `${providerID}/${modelID}`) consumed by {@link getModelEntrySyncForProvider}.
 */
export function _setModelDataForTest(
  entries: Record<string, ModelsDevEntry>,
  byProvider?: Record<string, ModelsDevEntry>,
): void {
  cachedModelData = new Map(Object.entries(entries));
  cachedModelDataByProvider = byProvider
    ? new Map(Object.entries(byProvider))
    : null;
  cachedModelDataAt = Date.now();
  resolutionMemo = new Map();
  resolutionMemoVersion = -1;
  resolutionMemoBlocklistGen = -1;
}

// ---------------------------------------------------------------------------
// Dynamic cheaper-model discovery
// ---------------------------------------------------------------------------

/**
 * The vendor "namespace" of a model id — the segment before the first `/`.
 *
 * Aggregators like OpenRouter namespace every model by vendor
 * (`anthropic/claude-opus-4.8`, `cohere/north-mini-code:free`). Direct
 * providers use bare ids (`claude-opus-4.8`) → empty namespace. Used to keep
 * worker selection inside the session model's OWN vendor on an aggregator, so
 * an Opus session never resolves a Cohere worker.
 */
function modelNamespace(modelID: string): string {
  const slash = modelID.indexOf("/");
  return slash > 0 ? modelID.slice(0, slash) : "";
}

/**
 * The "lineage key" of a models.dev family — the family string up to its first
 * `-`. Groups sibling tiers of one vendor lineage:
 *   claude-opus / claude-sonnet / claude-haiku → "claude"
 *   gpt-mini / gpt-codex / gpt-nano            → "gpt"
 *   gemini-2.5-pro / gemini-3-flash            → "gemini"
 * Derived purely from models.dev data — no hardcoded vendor names.
 */
function lineageKey(family: string): string {
  const dash = family.indexOf("-");
  return dash > 0 ? family.slice(0, dash) : family;
}

/**
 * True when the session's upstream URL points at ChatGPT's backend
 * (`chatgpt.com`, path `/backend-api`). That endpoint authenticates via a
 * ChatGPT OAuth JWT and serves ONLY the session's own model — any sibling model
 * (e.g. a cheaper `gpt-5.4-mini` picked by family selection) 404s. A worker for
 * such a session MUST reuse the session's exact model.
 *
 * This is the only robust discriminator: a ChatGPT-backend session reports the
 * same `providerID` ("openai") and `protocol` ("openai-responses") as a real
 * `api.openai.com` API-key session (config.ts PROVIDER_ROUTES) — only the host
 * differs.
 */
function isChatGPTBackend(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.hostname === "chatgpt.com" || u.pathname.includes("/backend-api");
  } catch {
    // Scheme-less or malformed URL — fall back to a substring check.
    return url.includes("chatgpt.com") || url.includes("/backend-api");
  }
}

/**
 * True when a candidate worker model id is currently usable for selection:
 * not marked worker-incapable, and — when the provider's `:free` tier is
 * data-policy-blocked — not a `:free` model. Both signals come from
 * worker-health and only ever tighten AFTER an observed failure, so this never
 * statically excludes `:free` (a different account may have opted in).
 */
function isSelectableWorkerModel(providerID: string, modelID: string): boolean {
  if (isWorkerIncapable(providerID, modelID)) return false;
  if (modelID.endsWith(":free") && areFreeModelsDataBlocked(providerID)) {
    return false;
  }
  return true;
}

/**
 * Find a cheaper same-provider worker model, staying inside the session model's
 * OWN vendor lineage and choosing the "closest cheaper tier".
 *
 * This matters for aggregators (OpenRouter, etc.) whose provider index mixes
 * many vendors: the old "globally cheapest model in the provider" rule crossed
 * lineages, picking e.g. a `$0` `cohere/...:free` model for an
 * `anthropic/claude-opus-4.8` session. That free model is then data-policy
 * blocked on accounts that haven't opted into prompt logging.
 *
 * Algorithm (all data-driven, no hardcoded vendor names):
 *   1. Resolve the session model's own models.dev entry → its `family` and id
 *      `namespace`. Derive the vendor `lineageKey` (family up to first `-`).
 *   2. Candidate set = same-provider, SELECTABLE (see
 *      {@link isSelectableWorkerModel}) models that match the session's
 *      namespace (when namespaced) AND whose family shares the lineage key AND
 *      that are strictly cheaper than the session.
 *   3. Group candidates by family; judge each family's tier by its NEWEST
 *      member's input cost. Pick the family with the MAXIMUM tier cost still
 *      `< sessionInputCost` — the "closest cheaper tier" (opus → sonnet, not
 *      haiku). Ties broken toward the family whose newest member is newest.
 *   4. Within that family return the newest member still cheaper than the
 *      session (release_date desc, then numeric-aware id desc).
 *
 * Falls back to the legacy global-cheapest-in-provider behavior when the
 * session model has no family/namespace metadata OR the lineage candidate set
 * is empty, so unknown/edge providers are never regressed. Returns undefined
 * when no cheaper selectable model exists.
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

  const sessionEntry = matchModelEntry(cachedModelData, sessionModelID);
  const sessionNamespace = modelNamespace(sessionModelID);
  const sessionLineage = sessionEntry?.family
    ? lineageKey(sessionEntry.family)
    : undefined;

  // ----- Lineage-aware path: same vendor, closest cheaper tier. -----
  if (sessionLineage) {
    // Group cheaper same-lineage selectable candidates by family, tracking each
    // family's newest member (by date, then numeric-aware id) and that member's
    // cost as the family's tier cost.
    type Fam = { newestId: string; newestDate: string; tierCost: number };
    const families = new Map<string, Fam>();
    for (const modelId of providerModelIds) {
      if (modelId === sessionModelID) continue;
      if (sessionNamespace && modelNamespace(modelId) !== sessionNamespace) {
        continue;
      }
      const entry = cachedModelData.get(modelId);
      if (!entry?.family || lineageKey(entry.family) !== sessionLineage) {
        continue;
      }
      const cost = entry.cost?.input;
      if (cost == null || cost >= sessionInputCost) continue;
      if (!isSelectableWorkerModel(providerID, modelId)) continue;

      const date = entry.release_date ?? "";
      const fam = families.get(entry.family);
      if (
        !fam ||
        date > fam.newestDate ||
        (date === fam.newestDate &&
          modelId.localeCompare(fam.newestId, "en", { numeric: true }) > 0)
      ) {
        families.set(entry.family, {
          newestId: modelId,
          newestDate: date,
          tierCost: cost,
        });
      }
    }

    if (families.size > 0) {
      // Closest cheaper tier: the family whose newest member is the most
      // expensive while still cheaper than the session. Tie-break toward the
      // newer family tier so a fresh generation wins a cost tie.
      let best: (Fam & { family: string }) | undefined;
      for (const [family, fam] of families) {
        if (
          !best ||
          fam.tierCost > best.tierCost ||
          (fam.tierCost === best.tierCost &&
            (fam.newestDate > best.newestDate ||
              (fam.newestDate === best.newestDate &&
                fam.newestId.localeCompare(best.newestId, "en", {
                  numeric: true,
                }) > 0)))
        ) {
          best = { ...fam, family };
        }
      }
      // families.size > 0 guarantees `best` is assigned; the guard also
      // narrows the type without a non-null assertion.
      if (best) {
        const resolvedId = best.newestId;
        log.info(
          `dynamic worker model: ${providerID}/${resolvedId} ($${best.tierCost}/M, ` +
            `lineage ${sessionLineage}, family ${best.family}, closest cheaper tier) ` +
            `instead of ${sessionModelID} ($${sessionInputCost}/M)`,
        );
        memo.set(memoKey, resolvedId);
        return resolvedId;
      }
    }
    // The session model HAS a known vendor lineage but no usable cheaper
    // same-vendor sibling exists (all siblings blocklisted, or the lineage has
    // no cheaper tier). Do NOT fall through to the cross-vendor legacy path — a
    // worker must stay inside the session model's own vendor. Return undefined
    // so the caller falls back to the session model itself (safe, just pricier)
    // rather than silently routing to an unrelated vendor's model.
    memo.set(memoKey, undefined);
    return undefined;
  }

  // ----- Legacy fallback path: global cheapest selectable in the provider. ---
  // Reached ONLY when the session model has no family/lineage metadata (unknown
  // or edge providers). Preserves the original cheapest-by-cost behavior.

  // Pass 1: cheapest same-provider selectable model cheaper than the session.
  let cheapestId: string | undefined;
  let cheapestCost = sessionInputCost;
  let cheapestFamily: string | undefined;
  for (const modelId of providerModelIds) {
    if (modelId === sessionModelID) continue;
    const entry = cachedModelData.get(modelId);
    if (entry?.cost?.input == null) continue;
    if (entry.cost.input >= cheapestCost) continue;
    if (!isSelectableWorkerModel(providerID, modelId)) continue;
    cheapestCost = entry.cost.input;
    cheapestId = modelId;
    cheapestFamily = entry.family;
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
      if (!isSelectableWorkerModel(providerID, modelId)) continue;
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
    // Skip models blocklisted this process (worker-incapable, or a
    // data-policy-blocked :free tier) so a bad model isn't re-picked and
    // selection advances to the next candidate on re-resolution.
    if (!isSelectableWorkerModel(providerID, id)) continue;
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
  // OpenAI (real api.openai.com API-key sessions): prefer gpt-5.6-luna as the
  // worker. Luna ($1/M in) is ~5x cheaper than the premium sol tier ($5/M) yet
  // materially higher quality than the mini tier ($0.75/M) — the right
  // cost/quality point for distillation & curation. family "gpt-luna" tracks
  // the newest luna generation from models.dev; the modelID is the OFFLINE
  // fallback. NOTE: this path is reached ONLY for real api.openai.com sessions;
  // ChatGPT-backend (chatgpt.com) sessions short-circuit earlier in
  // getWorkerModel and reuse the session's own model (that endpoint serves ONLY
  // the session's exact model — any sibling 404s).
  openai: {
    providerID: "openai",
    modelID: "gpt-5.6-luna",
    family: "gpt-luna",
    alreadyCheap: (id) =>
      id.includes("luna") || id.includes("mini") || id.includes("nano"),
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
  // NOTE: `google` is intentionally NOT listed here. A gemini session's worker
  // PROTOCOL is resolved to "gemini" from the session snapshot
  // (resolveWorkerProtocol), and its MODEL is resolved cost-aware by the generic
  // findCheaperSameProviderModel path (which auto-picks the cheapest gemini
  // family from models.dev — better than a hardcoded family pin). Adding a
  // WORKER_DEFAULTS.google entry would override that with a fixed family and is
  // unnecessary for correctness.
  //
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
  /**
   * Resolved upstream base URL for the session (from `UpstreamSnapshot.url`).
   * Used to detect ChatGPT-backend sessions, whose endpoint serves only the
   * session's own model. Callers pass the full `UpstreamSnapshot`, so this is
   * populated automatically; the no-arg / no-url case falls back to the normal
   * provider-family selection.
   */
  url?: string;
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

  // ChatGPT-backend short-circuit (correctness, not cost). A session routed to
  // chatgpt.com/backend-api authenticates via a ChatGPT OAuth JWT and its
  // endpoint serves ONLY the session's own LIVE model. Selecting a cheaper
  // sibling (family/cost-aware selection below) would send e.g. gpt-5.4-mini to
  // chatgpt.com → 404, poisoning background work. The worker MUST reuse the
  // session's exact live model.
  //
  //  - Reuses the LIVE session provider+model (sessionProviderID/sessionModelID),
  //    NOT effectiveProvider/effectiveModelID: a `.lore.json` cfg.model override
  //    naming a DIFFERENT model would also 404 against this single-model endpoint,
  //    so the config override cannot apply here. cfg.workerModel is overridden
  //    for the same reason; LORE_WORKER_MODEL (handled above) stays the escape
  //    hatch.
  //  - Requires a known live session model to reuse (none → fall through; the
  //    normal fallback picks the safest available target).
  //  - Exempts sessionProviderID "openai-codex": that path legitimately
  //    downgrades to gpt-5.1-codex-mini on the SAME chatgpt.com endpoint (the
  //    ChatGPT backend does serve codex-mini for codex sessions), validated
  //    separately. Keying on sessionProviderID (not effectiveProvider) prevents
  //    a cfg.model.providerID="openai" override from masking a real codex session.
  if (
    isChatGPTBackend(session?.url) &&
    sessionProviderID !== "openai-codex" &&
    sessionProviderID &&
    sessionModelID
  ) {
    return { providerID: sessionProviderID, modelID: sessionModelID };
  }

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
