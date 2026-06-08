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

/** Providers to fetch pricing data for from models.dev. */
const SUPPORTED_PROVIDERS = ["anthropic", "openai"] as const;

/** Shape of a model entry in the models.dev JSON API. */
export type ModelsDevEntry = {
  id: string;
  cost?: {
    input?: number;
    output?: number;
    cache_read?: number;
    cache_write?: number;
  };
  limit?: { context?: number; output?: number };
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

/** Clear cached data (for testing). */
export function clearModelDataCache(): void {
  cachedModelData = null;
  cachedProviderModels = null;
  cachedProviderRoutes = null;
  cachedModelDataAt = 0;
  inflightFetch = null;
}

// ---------------------------------------------------------------------------
// Dynamic cheaper-model discovery
// ---------------------------------------------------------------------------

/**
 * Find a cheaper model from the same provider using models.dev pricing data.
 *
 * For providers without hardcoded WORKER_DEFAULTS (Google, MiniMax, xAI, etc.),
 * this searches the cached models.dev data for a model that:
 *   1. Belongs to the same provider
 *   2. Costs less than the session model (input price)
 *   3. Has the lowest input cost among candidates (cheapest available)
 *   4. Is not the session model itself
 *
 * Returns the model ID of the cheapest alternative, or undefined if none found.
 */
function findCheaperSameProviderModel(
  providerID: string,
  sessionModelID: string,
  sessionInputCost: number,
): string | undefined {
  const providerModelIds = cachedProviderModels?.get(providerID);
  if (!providerModelIds || !cachedModelData) return undefined;

  let cheapestId: string | undefined;
  let cheapestCost = sessionInputCost;

  for (const modelId of providerModelIds) {
    if (modelId === sessionModelID) continue;
    const entry = cachedModelData.get(modelId);
    if (!entry?.cost?.input) continue;
    // Must be cheaper than the session model AND cheaper than any
    // candidate we've found so far
    if (entry.cost.input < cheapestCost) {
      cheapestCost = entry.cost.input;
      cheapestId = modelId;
    }
  }

  if (cheapestId) {
    log.info(
      `dynamic worker model: ${providerID}/${cheapestId} ($${cheapestCost}/M) ` +
        `instead of ${sessionModelID} ($${sessionInputCost}/M)`,
    );
  }

  return cheapestId;
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
  { providerID: string; modelID: string; alreadyCheap: (id: string) => boolean }
> = {
  // Anthropic: sonnet-4-6 matches opus quality on distillation at 40% lower cost
  anthropic: {
    providerID: "anthropic",
    modelID: "claude-sonnet-4-6",
    alreadyCheap: (id) => id.includes("sonnet") || id.includes("haiku"),
  },
  // OpenAI: gpt-5.4-mini matched gpt-5.4 exactly (24 obs each) at 70% lower cost
  openai: {
    providerID: "openai",
    modelID: "gpt-5.4-mini",
    alreadyCheap: (id) => id.includes("mini") || id.includes("nano"),
  },
  // GitHub Copilot proxies multiple providers — match by model ID prefix
  "github-copilot": {
    providerID: "github-copilot",
    modelID: "gpt-5.4-mini", // default; overridden by _resolveGitHubCopilotWorker
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

  // Effective provider: explicit config > session > anthropic default.
  const effectiveProvider =
    cfg.model?.providerID ?? sessionProviderID ?? "anthropic";

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
          costAwareDefault = {
            providerID: mapping.providerID,
            modelID: mapping.modelID,
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
