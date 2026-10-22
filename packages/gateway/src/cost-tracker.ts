/**
 * Per-session cost accumulation and counterfactual savings estimation.
 *
 * Tracks actual spend across conversation turns and worker calls, and
 * estimates what each session *would* have cost without Lore's optimizations
 * (cache warming, 1h TTL, batch API, distillation replacing compaction).
 *
 * All estimates use the synchronous pricing cache from worker-model.ts —
 * no async or extra LLM calls. Costs are accumulated in memory and can be
 * surfaced via the /ui dashboard or emitted as Sentry metrics.
 */

import { getModelEntrySync, getWorkerModel } from "./worker-model";
import {
  AUTOCOMPACT_THRESHOLD,
  MAX_OUTPUT_RESERVE,
  autocompactThresholdForModel,
  clientMeteredContextWindow,
} from "./compaction";
import {
  log,
  data,
  db,
  loadSessionCosts,
  loadAllSessionCosts,
  addDailyCost,
  getDailyCostTotals,
  addProviderCost,
  getProviderCostTotals,
  type ProviderAuthKind,
  type DailyCostBucket,
} from "@loreai/core";
import type { CostAttribution } from "./cost-attribution";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Cost breakdown for a single LLM call. */
export type CallCost = {
  /** Total USD cost of this call. */
  total: number;
  /** Uncached input cost. */
  inputCost: number;
  /** Cache read cost. */
  cacheReadCost: number;
  /** Cache write cost. */
  cacheWriteCost: number;
  /** Output token cost. */
  outputCost: number;
};

/** Accumulated costs for a session. */
export type SessionCosts = {
  // --- Conversation (user-facing turns) ---
  conversation: {
    cost: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    turns: number;
  };

  // --- Worker overhead (Lore background tasks) ---
  workers: {
    distillation: { cost: number; calls: number };
    curation: { cost: number; calls: number };
    compaction: { cost: number; calls: number };
    recall: { cost: number; calls: number };
    warmup: { cost: number; calls: number };
  };

  /** Dollar savings from batch API (50% discount on batched worker calls). */
  batchSavings: number;

  // --- Counterfactual savings estimation ---
  counterfactual: {
    /** Cost of cache writes that warming prevented (user returned within TTL). */
    warmupSavings: number;
    /** Number of confirmed warmup hits. */
    warmupHits: number;
    /** Cost saved by 1h TTL — cache reads that would have been writes at 5m TTL. */
    ttlSavings: number;
    /** Number of turns that benefited from 1h TTL. */
    ttlHits: number;
    /** Number of compactions that *would* have triggered without Lore distillation. */
    avoidedCompactions: number;
    /** Estimated cost of those avoided compactions. */
    avoidedCompactionCost: number;
  };

  // --- Legacy budget-throttle counters; subscription pacing never increments these ---
  throttle: {
    /** Number of requests delayed by a separate throttling mechanism. */
    events: number;
    /** Total delay imposed by a separate throttling mechanism, in milliseconds. */
    totalDelayMs: number;
  };

  /** Shadow context counter — tracks virtual uncompressed context growth for compaction estimation. */
  _shadowContextTokens: number;
  /** Whether shadow context has been initialized for the current process. */
  _shadowContextInitialized: boolean;
  /** Previous turn's actual (compressed) input tokens — for delta estimation. */
  _lastActualInput: number;
  /** Previous turn's output tokens (always uncompressed) — for growth estimation. */
  _lastOutputTokens: number;
};

/** Backdated historical estimates from stored data. */
export type HistoricalEstimates = {
  /** Per-session backdated estimates. */
  sessions: Array<{
    projectPath: string;
    projectName: string | null;
    projectId: string;
    sessionId: string;
    messageCount: number;
    firstMessage: number;
    lastMessage: number;
    /** Estimated distillation overhead from stored records. */
    distillationCost: number;
    distillationCalls: number;
    distillationBatchCalls: number;
    distillationDirectCalls: number;
    /** Estimated avoided compactions from shadow context simulation. */
    avoidedCompactions: number;
    avoidedCompactionCost: number;
    /** Model used (from metadata of first message, or fallback). */
    model: string;
    /** Persisted live-session cost data (null if not available for this session). */
    persisted: {
      conversationCost: number;
      workerCost: number;
      conversationTurns: number;
      warmupSavings: number;
      warmupCost: number;
      warmupHits: number;
      ttlSavings: number;
      ttlHits: number;
      batchSavings: number;
      avoidedCompactions: number;
      avoidedCompactionCost: number;
    } | null;
  }>;
  /** Totals across all sessions. */
  totals: {
    distillationCost: number;
    distillationCalls: number;
    distillationBatchCalls: number;
    distillationDirectCalls: number;
    avoidedCompactions: number;
    avoidedCompactionCost: number;
    warmupSavings: number;
    /** Cache-warmup request cost (read+write) across all sessions. */
    warmupCost: number;
    warmupHits: number;
    ttlSavings: number;
    ttlHits: number;
    batchSavings: number;
    sessionCount: number;
    messageCount: number;
    /**
     * Total worker cost using persisted real API data where available,
     * falling back to heuristic distillation estimates for sessions
     * without a persisted snapshot.
     */
    totalWorkerCost: number;
    /** Persisted conversation cost (from sessions that went idle). */
    persistedConversationCost: number;
    /**
     * Per-bucket worker spend, accumulated from persisted
     * `session_state.worker_breakdown` snapshots. Sessions written before this
     * field existed (pre-migration) contribute to `totalWorkerCost` but not
     * here, so this is a best-effort attribution view of where worker cost went.
     * Warmup is intentionally EXCLUDED here — it is already aggregated in the
     * dedicated `warmupCost` field, and duplicating it would risk a double-count
     * if a caller ever summed both. (The per-session `worker_breakdown` JSON
     * still carries all five buckets as a faithful snapshot.)
     */
    workerBreakdown: {
      distillation: { cost: number; calls: number };
      curation: { cost: number; calls: number };
      compaction: { cost: number; calls: number };
      recall: { cost: number; calls: number };
    };
  };
};

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

/** Per-session cost accumulators. Keyed by internal sessionID. */
const sessions = new Map<string, SessionCosts>();

/** Cached historical estimates (computed once, refreshed on demand). */
let historicalCache: HistoricalEstimates | null = null;
let historicalCacheAt = 0;
const HISTORICAL_CACHE_TTL_MS = 300_000; // 5 minutes — historical data changes slowly

/**
 * Only scan sessions with activity in the last N days for historical cost
 * estimates. Older sessions rarely change; their persisted cost is still
 * reflected in the per-day ledger and budget bar.
 */
const HISTORICAL_SCAN_DAYS = 90;

// ---------------------------------------------------------------------------
// Throttle curve
// ---------------------------------------------------------------------------

/** UTC day (YYYY-MM-DD) that cost is attributed to. */
function utcToday(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Drop the computed daily-costs cache (for testing). */
export function resetDailyCostsCache(): void {
  dailyCostsCache = null;
  dailyCostsCacheAt = 0;
  dailyCostsCacheDays = 0;
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

function emptyCosts(): SessionCosts {
  return {
    conversation: {
      cost: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      turns: 0,
    },
    workers: {
      distillation: { cost: 0, calls: 0 },
      curation: { cost: 0, calls: 0 },
      compaction: { cost: 0, calls: 0 },
      recall: { cost: 0, calls: 0 },
      warmup: { cost: 0, calls: 0 },
    },
    batchSavings: 0,
    counterfactual: {
      warmupSavings: 0,
      warmupHits: 0,
      ttlSavings: 0,
      ttlHits: 0,
      avoidedCompactions: 0,
      avoidedCompactionCost: 0,
    },
    throttle: { events: 0, totalDelayMs: 0 },
    _shadowContextTokens: 0,
    _shadowContextInitialized: false,
    _lastActualInput: 0,
    _lastOutputTokens: 0,
  };
}

function restorePersistedCosts(
  costs: SessionCosts,
  persisted: NonNullable<ReturnType<typeof loadSessionCosts>>,
): void {
  costs.conversation = {
    cost: persisted.conversationCost,
    inputTokens: persisted.inputTokens,
    outputTokens: persisted.outputTokens,
    cacheReadTokens: persisted.cacheReadTokens,
    cacheWriteTokens: persisted.cacheWriteTokens,
    turns: persisted.conversationTurns,
  };

  if (persisted.workerBreakdown) {
    const restored = emptyCosts().workers;
    for (const bucket of [
      "distillation",
      "curation",
      "compaction",
      "recall",
      "warmup",
    ] as const) {
      const saved = persisted.workerBreakdown[bucket];
      if (
        saved &&
        Number.isFinite(saved.cost) &&
        Number.isInteger(saved.calls) &&
        saved.calls >= 0
      ) {
        restored[bucket] = { cost: saved.cost, calls: saved.calls };
      }
    }
    costs.workers = restored;
  } else {
    // Older snapshots have no bucket split. Preserve their aggregate in the
    // best-effort distillation bucket, but retain warmup spend from the
    // separate field present in every snapshot. Clamp both values so a
    // malformed legacy row cannot produce negative bucket costs.
    const aggregateWorkerCost = Number.isFinite(persisted.workerCost)
      ? Math.max(0, persisted.workerCost)
      : 0;
    const knownWarmupCost = Number.isFinite(persisted.warmupCost)
      ? Math.min(aggregateWorkerCost, Math.max(0, persisted.warmupCost))
      : 0;
    costs.workers.warmup.cost = knownWarmupCost;
    costs.workers.distillation.cost = aggregateWorkerCost - knownWarmupCost;
  }

  costs.batchSavings = persisted.batchSavings;
  costs.counterfactual = {
    warmupSavings: persisted.warmupSavings,
    warmupHits: persisted.warmupHits,
    ttlSavings: persisted.ttlSavings,
    ttlHits: persisted.ttlHits,
    avoidedCompactions: persisted.avoidedCompactions,
    avoidedCompactionCost: persisted.avoidedCompactionCost,
  };

  const shadowContext = persisted.shadowContextTokens;
  const lastActualInput = persisted.shadowLastActualInput;
  const lastOutputTokens = persisted.shadowLastOutputTokens;
  if (
    typeof shadowContext === "number" &&
    Number.isSafeInteger(shadowContext) &&
    shadowContext >= 0 &&
    typeof lastActualInput === "number" &&
    Number.isSafeInteger(lastActualInput) &&
    lastActualInput >= 0 &&
    typeof lastOutputTokens === "number" &&
    Number.isSafeInteger(lastOutputTokens) &&
    lastOutputTokens >= 0
  ) {
    costs._shadowContextTokens = shadowContext;
    costs._lastActualInput = lastActualInput;
    costs._lastOutputTokens = lastOutputTokens;
    costs._shadowContextInitialized = true;
  }
}

function getOrCreate(sessionID: string): SessionCosts {
  let costs = sessions.get(sessionID);
  if (!costs) {
    costs = emptyCosts();
    const persisted = loadSessionCosts(sessionID);
    if (persisted) restorePersistedCosts(costs, persisted);
    sessions.set(sessionID, costs);
    // Historical snapshots omit live sessions when computed. Invalidate any
    // earlier snapshot that included this session, after hydrating its saved
    // lifetime costs so the live totals remain continuous across a resume.
    invalidateHistoricalCache();
  }
  return costs;
}

// ---------------------------------------------------------------------------
// Pricing helpers
// ---------------------------------------------------------------------------

type Usage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
};

type Pricing = {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
};

/**
 * Get pricing for a model from the sync cache.
 * Falls back to sensible defaults (same logic as sentry.ts getPricing).
 */
export function getPricingSync(model: string): Pricing {
  // OpenRouter `:free` suffix models cost nothing — don't inflate budget.
  if (model.endsWith(":free")) {
    return { input: 0, output: 0, cache_read: 0, cache_write: 0 };
  }
  const entry = getModelEntrySync(model);
  const input = entry.cost?.input ?? 3;
  return {
    input,
    output: entry.cost?.output ?? 15,
    cache_read: entry.cost?.cache_read ?? input * 0.1,
    cache_write: entry.cost?.cache_write ?? input * 1.25,
  };
}

/**
 * Compute the USD cost breakdown for an LLM call.
 *
 * This is the single source of truth for cost computation — used by both
 * the accumulator (sync, hot path) and Sentry metrics emission.
 *
 * @param ttl - Cache TTL for this call. Anthropic charges 2× cache_write
 *   for 1h TTL; without this parameter the cost uses the base (5m) rate.
 */
export function computeCallCost(
  model: string,
  usage: Usage,
  callType: "conversation" | "direct" | "batch",
  ttl?: "5m" | "1h",
): CallCost {
  const pricing = getPricingSync(model);
  const batchMultiplier = callType === "batch" ? 0.5 : 1.0;
  // Anthropic doubles cache_write pricing for 1h TTL
  const cacheWriteRate =
    ttl === "1h" ? pricing.cache_write * 2 : pricing.cache_write;

  const inputCost =
    ((usage.input_tokens ?? 0) / 1_000_000) * pricing.input * batchMultiplier;
  const cacheReadCost =
    ((usage.cache_read_input_tokens ?? 0) / 1_000_000) *
    pricing.cache_read *
    batchMultiplier;
  const cacheWriteCost =
    ((usage.cache_creation_input_tokens ?? 0) / 1_000_000) *
    cacheWriteRate *
    batchMultiplier;
  const outputCost =
    ((usage.output_tokens ?? 0) / 1_000_000) * pricing.output * batchMultiplier;

  return {
    total: inputCost + cacheReadCost + cacheWriteCost + outputCost,
    inputCost,
    cacheReadCost,
    cacheWriteCost,
    outputCost,
  };
}

// ---------------------------------------------------------------------------
// Accumulation — called from pipeline, LLM adapter, batch queue, warmup
// ---------------------------------------------------------------------------

/**
 * Record a conversation turn's cost (called from postResponse).
 *
 * @param ttl - Cache TTL for this session. Anthropic charges 2× cache_write
 *   for 1h TTL; without this the cost uses the base (5m) rate.
 */
export function recordConversationCost(
  sessionID: string,
  model: string,
  usage: Usage,
  ttl?: "5m" | "1h",
  attribution?: CostAttribution,
): void {
  const costs = getOrCreate(sessionID);
  const call = computeCallCost(model, usage, "conversation", ttl);
  costs.conversation.cost += call.total;
  costs.conversation.inputTokens += usage.input_tokens ?? 0;
  costs.conversation.outputTokens += usage.output_tokens ?? 0;
  costs.conversation.cacheReadTokens += usage.cache_read_input_tokens ?? 0;
  costs.conversation.cacheWriteTokens += usage.cache_creation_input_tokens ?? 0;
  costs.conversation.turns++;

  // Per-day cost ledger (14-day trend; provider budgets read their own ledger).
  addDailyCost(utcToday(), "conversation", call.total);
  recordProviderCost(attribution, "conversation", call.total, usage);
}

/** Worker ID → cost bucket mapping. */
type WorkerBucket = keyof SessionCosts["workers"];

const WORKER_BUCKETS: Record<string, WorkerBucket> = {
  "lore-distill": "distillation",
  "lore-curator": "curation",
  "lore-compact": "compaction",
  "lore-query-expand": "recall",
};

/**
 * Record a worker LLM call's cost (called from LLM adapter / batch queue).
 */
export function recordWorkerCost(
  sessionID: string | undefined,
  model: string,
  usage: Usage,
  callType: "direct" | "batch",
  workerID?: string,
  ttl?: "5m" | "1h",
  attribution?: CostAttribution,
): void {
  if (!sessionID) return;
  const costs = getOrCreate(sessionID);
  const call = computeCallCost(model, usage, callType, ttl);

  const bucket = WORKER_BUCKETS[workerID ?? ""] ?? "distillation";
  costs.workers[bucket].cost += call.total;
  costs.workers[bucket].calls++;

  // Track batch savings: how much more this would have cost at full price
  if (callType === "batch") {
    const fullCost = computeCallCost(model, usage, "direct", ttl);
    costs.batchSavings += fullCost.total - call.total;
  }

  addDailyCost(utcToday(), "worker", call.total);
  recordProviderCost(attribution, "worker", call.total, usage);
}

/**
 * Record a cache warmup cost (called from executeWarmup).
 *
 * @param ttl - Cache TTL for this session. Anthropic charges 2× cache_write
 *   for 1h TTL; without this parameter the cost is undercounted by 50%.
 */
export function recordWarmupCost(
  sessionID: string,
  model: string,
  cacheReadTokens: number,
  cacheCreationTokens: number,
  ttl?: "5m" | "1h",
  attribution?: CostAttribution,
): void {
  const costs = getOrCreate(sessionID);
  const pricing = getPricingSync(model);
  const readCost = (cacheReadTokens / 1_000_000) * pricing.cache_read;
  // Anthropic doubles cache_write pricing for 1h TTL
  const cacheWriteRate =
    ttl === "1h" ? pricing.cache_write * 2 : pricing.cache_write;
  const writeCost = (cacheCreationTokens / 1_000_000) * cacheWriteRate;
  const warmupTotal = readCost + writeCost;
  costs.workers.warmup.cost += warmupTotal;
  costs.workers.warmup.calls++;

  addDailyCost(utcToday(), "warmup", warmupTotal);
  recordProviderCost(attribution, "warmup", warmupTotal, {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: cacheReadTokens,
    cache_creation_input_tokens: cacheCreationTokens,
  });
}

// ---------------------------------------------------------------------------
// Per-provider ledger (provider_costs table, #1926)
// ---------------------------------------------------------------------------

/** Write one provider-attributed cost row alongside the daily ledger write. */
function recordProviderCost(
  attribution: CostAttribution | undefined,
  bucket: DailyCostBucket,
  cost: number,
  usage: Usage,
): void {
  if (!attribution) return;
  try {
    addProviderCost({
      day: utcToday(),
      provider: attribution.provider,
      authKind: attribution.authKind,
      account: attribution.account,
      bucket,
      cost,
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
      cacheReadTokens: usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
      requests: 1,
    });
  } catch (error) {
    log.info("provider cost capture failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** API-shaped per-provider cost totals for GET /api/v1/costs. */
export type ProviderCostSummary = {
  provider: string;
  auth_kind: ProviderAuthKind;
  account: string;
  spend: number;
  today_spend: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  requests: number;
  last_day: string | null;
};

export function getProviderCostSummary(): ProviderCostSummary[] {
  return getProviderCostTotals(utcToday()).map((row) => ({
    provider: row.provider,
    auth_kind: row.authKind,
    account: row.account,
    spend: row.cost,
    today_spend: row.todayCost,
    input_tokens: row.inputTokens,
    output_tokens: row.outputTokens,
    cache_read_tokens: row.cacheReadTokens,
    cache_write_tokens: row.cacheWriteTokens,
    requests: row.requests,
    last_day: row.lastDay,
  }));
}

// ---------------------------------------------------------------------------
// Counterfactual tracking
// ---------------------------------------------------------------------------

/** Estimated post-compaction context size in tokens. */
const POST_COMPACTION_CONTEXT = 30_000;

/**
 * Per-model auto-compact threshold for the counterfactual estimate. Mirrors
 * pipeline.ts `maxReportedUsageForModelID` (same client-metered-window
 * semantics), but returns the UNSCALED auto-compact trigger point (what a host
 * like Claude Code compacts at) rather than the 0.9× client-usage reporting cap.
 * An empty/unknown model falls back to the historical 200K-model value
 * ({@link AUTOCOMPACT_THRESHOLD}).
 *
 * `longContext` MUST reflect whether the session opted into the 1M window via
 * the `context-1m` beta ({@link clientMeteredContextWindow}). This is the same
 * gate the client-usage cap uses (#1214): the counterfactual "would the client
 * have compacted?" question only makes sense against the window the CLIENT
 * actually meters — which is 200K unless the request enables long context, even
 * for a 1M-capable model (e.g. MiniMax-M3 over the Anthropic wire). Defaults to
 * `false` (conservative 200K) so callers without the signal — and the dominant
 * third-party-via-Claude-Code case — stay accurate.
 *
 * #983 correctly made this per-model, but assumed the client always meters
 * against the model's real window. That over-counts nothing for genuine
 * long-context sessions yet UNDER-counts avoided compactions for a 1M model the
 * client meters against 200K (it assumed the host compacts at ~967K when it
 * really compacts at ~167K). Gating on the beta reconciles both.
 */
export function autocompactThresholdForModelID(
  modelID?: string,
  longContext = false,
): number {
  if (!modelID) return AUTOCOMPACT_THRESHOLD;
  const entry = getModelEntrySync(modelID);
  const realContextWindow = entry.limit?.context ?? 200_000;
  const maxOutput = entry.limit?.output ?? MAX_OUTPUT_RESERVE;
  const contextWindow = clientMeteredContextWindow(
    realContextWindow,
    longContext,
  );
  return autocompactThresholdForModel(contextWindow, maxOutput);
}

/**
 * Counterfactual "avoided compactions" for a session that reached
 * `sessionTokens` uncompressed, given the host's per-model auto-compact
 * `threshold` and its post-compaction context size. The host compacts once at
 * `threshold`, then every `(threshold − postCompactionContext)` tokens of
 * growth thereafter.
 *
 * Returns 0 when the model is too small to model meaningfully — i.e.
 * `threshold ≤ postCompactionContext`, where the stride would be non-positive
 * and the estimate would run away (#983). This keeps pathologically small
 * windows conservative (0) rather than emitting an absurd count.
 */
export function estimateAvoidedCompactions(
  sessionTokens: number,
  threshold: number,
  postCompactionContext: number,
): number {
  if (threshold <= postCompactionContext || sessionTokens <= threshold) {
    return 0;
  }
  const stride = threshold - postCompactionContext;
  return 1 + Math.floor((sessionTokens - threshold) / stride);
}

/**
 * Estimate the total cost of a single compaction event.
 *
 * Includes three components:
 * 1. Force-distill pass: ~10K input, ~2K output (at worker model rates)
 * 2. Compaction LLM call: ~20K input, ~5K output (at worker model rates)
 * 3. Cache bust penalty: after compaction, the entire post-compaction context
 *    (~30K tokens) must be re-written to the prompt cache at cache_write rates
 *    on the conversation model. Without compaction, these tokens would have
 *    been served from cache_read.
 */
function estimateCompactionCost(
  workerModel: string,
  conversationModel?: string,
  ttl?: "5m" | "1h",
): number {
  const wPricing = getPricingSync(workerModel);
  // Force-distill: ~10K input, ~2K output
  const distillCost =
    (10_000 / 1_000_000) * wPricing.input +
    (2_000 / 1_000_000) * wPricing.output;
  // Compaction LLM call: ~20K input, ~5K output
  const compactCost =
    (20_000 / 1_000_000) * wPricing.input +
    (5_000 / 1_000_000) * wPricing.output;

  // Cache bust: post-compaction context (~POST_COMPACTION_CONTEXT tokens) must
  // be re-written to cache. The penalty is the difference between cache_write
  // and cache_read pricing on the conversation model.
  // Anthropic charges 2× cache_write for 1h TTL.
  let cacheBustCost = 0;
  if (conversationModel) {
    const cPricing = getPricingSync(conversationModel);
    const cacheWriteRate =
      ttl === "1h" ? cPricing.cache_write * 2 : cPricing.cache_write;
    cacheBustCost =
      (POST_COMPACTION_CONTEXT / 1_000_000) *
      (cacheWriteRate - cPricing.cache_read);
  }

  return distillCost + compactCost + cacheBustCost;
}

/**
 * Update the shadow context counter after a conversation turn.
 *
 * Maintains a virtual "what would context size be without Lore?" counter
 * using additive growth tracking. Instead of snapshotting the compressed
 * API token count (which underestimates because Lore's gradient manager
 * already trimmed the context), we accumulate per-turn growth from
 * uncompressed signals:
 *
 * - Output tokens are always uncompressed (the model's full response).
 * - The previous turn's output becomes part of the next turn's context.
 * - New user input is estimated from the delta in actual input tokens.
 *
 * When the shadow counter crosses the compaction threshold, a
 * counterfactual compaction event is recorded and the counter resets.
 *
 * @param totalInputTokens - Total input tokens for this turn (input + cache_read + cache_write)
 * @param outputTokens - Output tokens for this turn (always uncompressed)
 * @param workerModel - Model ID used for worker calls (for compaction cost estimation)
 */
export function updateShadowContext(
  sessionID: string,
  totalInputTokens: number,
  outputTokens: number,
  workerModel: string,
  conversationModel?: string,
  ttl?: "5m" | "1h",
  /** Whether the request opted into the 1M window via `context-1m` beta. Gates
   *  the per-model auto-compact threshold (#1214), matching the client-usage cap:
   *  a 1M-capable model the client meters against 200K compacts at ~167K, not
   *  ~967K. Defaults to `false` (conservative 200K). */
  longContext = false,
): void {
  const costs = getOrCreate(sessionID);

  // On first turn, initialize shadow context to the actual input size.
  // No compression has happened yet, so the actual count is accurate.
  // NOTE: this check relies on recordConversationCost() having already
  // incremented turns for this turn (called earlier in postResponse).
  if (!costs._shadowContextInitialized) {
    costs._shadowContextTokens = totalInputTokens;
    costs._shadowContextInitialized = true;
    costs._lastActualInput = totalInputTokens;
    costs._lastOutputTokens = outputTokens;
    return;
  }

  // Estimate uncompressed context growth since the last turn.
  // Growth is at least prevOutput (the assistant's response is always
  // added to context, uncompressed) and at most inputDelta (when new
  // user content exceeds the response size). If gradient compression
  // makes the delta negative, we fall back to prevOutput as the floor.
  const inputDelta = totalInputTokens - costs._lastActualInput;
  const prevOutput = costs._lastOutputTokens;
  const growth = Math.max(inputDelta, prevOutput);

  costs._shadowContextTokens += growth;
  costs._lastActualInput = totalInputTokens;
  costs._lastOutputTokens = outputTokens;

  // Per-model auto-compact trigger (#983). The `> POST_COMPACTION_CONTEXT`
  // guard skips pathologically small windows (threshold ≤ post-compaction
  // size), where a shadow compaction would immediately re-trigger every turn —
  // report 0 for those rather than a runaway count (matches the prior 167K
  // constant's effective 0 for tiny models, while fixing large-window overcount).
  const threshold = autocompactThresholdForModelID(
    conversationModel,
    longContext,
  );
  if (
    threshold > POST_COMPACTION_CONTEXT &&
    costs._shadowContextTokens > threshold
  ) {
    costs.counterfactual.avoidedCompactions++;
    costs.counterfactual.avoidedCompactionCost += estimateCompactionCost(
      workerModel,
      conversationModel,
      ttl,
    );
    costs._shadowContextTokens = POST_COMPACTION_CONTEXT;
    log.info(
      `cost-tracker: shadow compaction #${costs.counterfactual.avoidedCompactions} ` +
        `for session=${sessionID.slice(0, 16)} — est. cost=$${costs.counterfactual.avoidedCompactionCost.toFixed(4)}`,
    );
  }
}

/**
 * Record a confirmed warmup hit — user returned after a cache warming ping.
 *
 * The counterfactual: without warming, the cache would have expired and
 * the next request would pay full cache_write cost instead of cache_read.
 *
 * @param cacheReadTokens - Cache read tokens from the turn that confirmed the hit
 * @param ttl - Cache TTL for this session. Anthropic charges 2× cache_write
 *   for 1h TTL; without this parameter savings are undercounted.
 */
export function recordWarmupHit(
  sessionID: string,
  model: string,
  cacheReadTokens: number,
  ttl?: "5m" | "1h",
): void {
  const costs = getOrCreate(sessionID);
  // 🔴 Phantom-savings observability backstop (Bug A): a session should only
  // record warmup savings if it also booked a warmup COST (recordWarmupCost
  // ran for this sid). Savings without a matching cost is the phantom
  // attribution signature. We only WARN (not drop) here because warmup.calls
  // is an in-memory counter that resets on gateway restart — a legitimate
  // hit whose cost was booked in a prior process would false-negative. The
  // authoritative guard is the pipeline caller (creditWarmupHit), which gates
  // on the persisted lastWarmupRefreshTokens proving this session paid.
  if (costs.workers.warmup.calls === 0) {
    log.warn(
      `cost-tracker: warmup-hit for session=${sessionID.slice(0, 16)} ` +
        `with zero in-process warmup cost — verify not phantom (Bug A) ` +
        `or a cross-restart attribution.`,
    );
  }
  const pricing = getPricingSync(model);
  // Anthropic doubles cache_write pricing for 1h TTL
  const cacheWriteRate =
    ttl === "1h" ? pricing.cache_write * 2 : pricing.cache_write;
  // Without warming, these reads would have been writes
  const savings =
    (cacheReadTokens / 1_000_000) * (cacheWriteRate - pricing.cache_read);
  costs.counterfactual.warmupSavings += savings;
  costs.counterfactual.warmupHits++;
}

/**
 * Record a turn where 1h TTL saved a cache write.
 *
 * Called when a turn has cache reads but the gap since the last request
 * exceeds 5 minutes — meaning the 5m TTL would have expired, but the
 * 1h TTL kept the cache alive.
 *
 * The counterfactual is against 5m TTL (base cache_write rate), NOT 1h —
 * the saving comes from having 1h TTL instead of 5m, so the write cost
 * avoided is the 5m rate. The 1h surcharge is the price we paid to get
 * the longer TTL in the first place.
 */
export function recordTTLSavings(
  sessionID: string,
  model: string,
  cacheReadTokens: number,
): void {
  const costs = getOrCreate(sessionID);
  const pricing = getPricingSync(model);
  // Counterfactual: without 1h TTL, the 5m cache would have expired and
  // these reads would have been 5m-rate writes. Use base cache_write.
  const savings =
    (cacheReadTokens / 1_000_000) * (pricing.cache_write - pricing.cache_read);
  costs.counterfactual.ttlSavings += savings;
  costs.counterfactual.ttlHits++;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** Get the cost accumulator for a session (or null if not tracked). */
export function getSessionCosts(sessionID: string): SessionCosts | null {
  return sessions.get(sessionID) ?? null;
}

/** Get all tracked sessions (for UI dashboard). */
export function getAllSessionCosts(): Map<string, SessionCosts> {
  return sessions;
}

/** Total actual spend for a session. */
export function totalActualCost(costs: SessionCosts): number {
  return (
    costs.conversation.cost +
    costs.workers.distillation.cost +
    costs.workers.curation.cost +
    costs.workers.compaction.cost +
    costs.workers.recall.cost +
    costs.workers.warmup.cost
  );
}

/** Total worker overhead cost. */
export function totalWorkerCost(costs: SessionCosts): number {
  return (
    costs.workers.distillation.cost +
    costs.workers.curation.cost +
    costs.workers.compaction.cost +
    costs.workers.recall.cost +
    costs.workers.warmup.cost
  );
}

/** Total counterfactual savings. */
export function totalSavings(costs: SessionCosts): number {
  return (
    costs.counterfactual.warmupSavings +
    costs.counterfactual.ttlSavings +
    costs.batchSavings +
    costs.counterfactual.avoidedCompactionCost -
    totalWorkerCost(costs) // Net: subtract Lore's own overhead
  );
}

/** Estimated cost without Lore. */
export function costWithoutLore(costs: SessionCosts): number {
  return totalActualCost(costs) + totalSavings(costs);
}

/** Delete a session's cost data (cleanup on session expiry). */
export function deleteSessionCosts(sessionID: string): void {
  const existed = sessions.delete(sessionID);
  // The session just moved from "live" to "historical". Invalidate the
  // historical estimate cache so its persisted snapshot is picked up on the
  // next Costs page load instead of waiting out the TTL.
  if (existed) invalidateHistoricalCache();
}

/** Clear all sessions (for testing). */
export function clearAllCosts(): void {
  sessions.clear();
  invalidateHistoricalCache();
  resetDailyCostsCache();
}

// ---------------------------------------------------------------------------
// Historical backdating — estimates from stored DB data
// ---------------------------------------------------------------------------

/**
 * Extract model ID from a temporal message's metadata JSON.
 * Returns null if metadata is missing or unparseable.
 */
function extractModelFromMetadata(
  metadata: string | null | undefined,
): string | null {
  if (!metadata) return null;
  try {
    const parsed = JSON.parse(metadata);
    // Assistant messages: { modelID, providerID, ... }
    if (parsed.modelID && parsed.modelID !== "unknown") return parsed.modelID;
    // User messages: { agent, model: { providerID, modelID } }
    if (parsed.model?.modelID && parsed.model.modelID !== "unknown")
      return parsed.model.modelID;
    return null;
  } catch {
    return null;
  }
}

/** Default model for cost estimation when metadata is unavailable. */
const DEFAULT_ESTIMATION_MODEL = "claude-sonnet-4-20250514";

/**
 * Compute backdated historical estimates from stored DB data.
 *
 * Walks through all projects and sessions in the database to estimate:
 * 1. **Distillation overhead** — each distillation record represents an LLM
 *    call whose input was the source messages and output was the observations.
 * 2. **Avoided compactions** — simulates a shadow context counter by walking
 *    temporal messages chronologically. When the running total crosses the
 *    auto-compact threshold, counts a counterfactual compaction and resets.
 *
 * Cache/TTL/warmup/batch savings are loaded from persisted session cost
 * snapshots (saved on idle) when available.
 *
 * Results are cached for 5 minutes to avoid repeated DB scans.
 */
export function computeHistoricalEstimates(
  projectsList?: data.ProjectSummary[],
): HistoricalEstimates {
  // Return cache if fresh
  if (
    historicalCache &&
    Date.now() - historicalCacheAt < HISTORICAL_CACHE_TTL_MS
  ) {
    return historicalCache;
  }

  const totals: HistoricalEstimates["totals"] = {
    distillationCost: 0,
    distillationCalls: 0,
    distillationBatchCalls: 0,
    distillationDirectCalls: 0,
    avoidedCompactions: 0,
    avoidedCompactionCost: 0,
    warmupSavings: 0,
    warmupCost: 0,
    warmupHits: 0,
    ttlSavings: 0,
    ttlHits: 0,
    batchSavings: 0,
    sessionCount: 0,
    messageCount: 0,
    totalWorkerCost: 0,
    persistedConversationCost: 0,
    workerBreakdown: {
      distillation: { cost: 0, calls: 0 },
      curation: { cost: 0, calls: 0 },
      compaction: { cost: 0, calls: 0 },
      recall: { cost: 0, calls: 0 },
    },
  };

  const sessionEstimates: HistoricalEstimates["sessions"] = [];

  // Resolve the worker model used for distillation calls.
  // Distillations run on the worker model (e.g. claude-sonnet-4-6), not the
  // conversation model (e.g. claude-opus-4-6). Use worker pricing for overhead.
  // No session context available — use default provider for estimation.
  const workerResult = getWorkerModel();
  const workerModelID = workerResult?.modelID ?? DEFAULT_ESTIMATION_MODEL;
  const workerPricing = getPricingSync(workerModelID);

  // Load persisted cost snapshots from DB (saved on idle).
  const persistedCosts = loadAllSessionCosts();

  // Scope-limit the scan to recent sessions. Older sessions rarely change and
  // re-scanning them on every (uncached) load is the dominant cost. Their
  // persisted snapshots are still reflected in the daily ledger / budget, just
  // not in this rolling "intelligence" estimate.
  const scanCutoffMs = Date.now() - HISTORICAL_SCAN_DAYS * 86_400_000;

  try {
    // Build a project lookup map for enriching session rows with project info.
    // Uses the caller-provided list when available to avoid a redundant query.
    const projects = projectsList ?? data.listProjects();
    const projectById = new Map<string, (typeof projects)[number]>();
    for (const p of projects) {
      projectById.set(p.id, p);
    }

    // Single bulk read from the materialized session_rollup table (#981):
    // O(sessions), independent of total temporal_messages count. Replaces the
    // three O(N-messages) bulk aggregates (recent sessions + token sums +
    // distillation counts) with one row-per-session lookup.
    const allSessions = data.listSessionRollups({
      sinceMs: scanCutoffMs,
    });
    const sessionsWithRollups = new Set(
      allSessions.map((session) => session.session_id),
    );
    for (const sess of allSessions) {
      // Skip test sessions (created by the test suite)
      if (sess.project_path.includes("__tmp_agents_file__")) continue;

      // Skip sessions that are currently tracked live
      if (sessions.has(sess.session_id)) continue;

      totals.sessionCount++;
      totals.messageCount += sess.message_count;

      // --- Determine model for this session ---
      // Use the earliest assistant message's metadata (user messages have
      // "unknown"). Falls back to the default estimation model.
      let model = DEFAULT_ESTIMATION_MODEL;
      const m = extractModelFromMetadata(sess.first_assistant_metadata);
      if (m) model = m;

      // --- 1. Estimate distillation overhead ---
      // Use worker model pricing — distillations run on the worker, not
      // conversation model. The rollup gives total token_count split by
      // call_type, so the batch discount (50%) is applied to the actual batch
      // token sum — equivalent to the old per-row loop.
      const totalDistillCalls = sess.distill_total_calls;
      const sessionBatchCalls = sess.distill_batch_calls;
      const sessionDirectCalls = totalDistillCalls - sessionBatchCalls;
      const batchTokens = sess.distill_batch_tokens;
      const directTokens = sess.distill_total_tokens - batchTokens;
      const perTokenCost = (estOut: number, mult: number) =>
        ((estOut * 3) / 1_000_000) * workerPricing.input * mult +
        (estOut / 1_000_000) * workerPricing.output * mult;
      const sessionDistillCost =
        perTokenCost(directTokens, 1.0) + perTokenCost(batchTokens, 0.5);
      totals.distillationCost += sessionDistillCost;
      totals.distillationCalls += totalDistillCalls;
      totals.distillationBatchCalls += sessionBatchCalls;
      totals.distillationDirectCalls += sessionDirectCalls;

      // --- 2. Approximate avoided compactions from total token sum ---
      // The old per-message running-context simulation is too expensive for
      // batched queries. This formula approximates the same count using the
      // session token total. It overestimates slightly when individual messages
      // are large relative to the stride (overshoot tokens beyond the threshold
      // are discarded in the per-message sim but counted by the division).
      // This is only a fallback — sessions with persisted snapshots (the common
      // case) use real data from live tracking.
      const sessionTokens = sess.total_tokens;
      // Per-model auto-compact threshold (#983), client-metered-window aware
      // (#1214). This batched historical path has no per-session `context-1m`
      // signal, so it uses the conservative default (longContext=false → 200K
      // clamp): the client-metered threshold for any model it can't confirm was
      // in long-context mode. This matches the client-usage cap default and the
      // dominant real case (1M-capable third parties metered against 200K via
      // Claude Code). New sessions are tracked live with the real beta signal
      // and prefer the persisted count below, so this coarse fallback only
      // affects legacy sessions with no snapshot. Pass the *extracted* model
      // (`m`, null when the session has no usable metadata) — NOT the
      // pricing-defaulted `model` (which falls back to a 1M-window estimation
      // model purely to price the compaction cost).
      const avoidedCompactions = estimateAvoidedCompactions(
        sessionTokens,
        autocompactThresholdForModelID(m ?? undefined),
        POST_COMPACTION_CONTEXT,
      );

      const sessionCompactionCost =
        avoidedCompactions * estimateCompactionCost(workerModelID, model);

      // --- 3. Look up persisted live-session cost data ---
      // Avoided compaction and worker cost totals are accumulated here
      // (not above) because persisted real data is preferred over simulation.
      const persisted = persistedCosts.get(sess.session_id);
      let sessionPersisted: HistoricalEstimates["sessions"][number]["persisted"] =
        null;
      if (persisted) {
        sessionPersisted = {
          conversationCost: persisted.conversationCost,
          workerCost: persisted.workerCost,
          conversationTurns: persisted.conversationTurns,
          warmupSavings: persisted.warmupSavings,
          warmupCost: persisted.warmupCost,
          warmupHits: persisted.warmupHits,
          ttlSavings: persisted.ttlSavings,
          ttlHits: persisted.ttlHits,
          batchSavings: persisted.batchSavings,
          avoidedCompactions: persisted.avoidedCompactions,
          avoidedCompactionCost: persisted.avoidedCompactionCost,
        };
        totals.warmupSavings += persisted.warmupSavings;
        totals.warmupCost += persisted.warmupCost;
        totals.warmupHits += persisted.warmupHits;
        totals.ttlSavings += persisted.ttlSavings;
        totals.ttlHits += persisted.ttlHits;
        totals.batchSavings += persisted.batchSavings;
        totals.persistedConversationCost += persisted.conversationCost;

        // Prefer persisted real worker cost over heuristic distillation estimate.
        // The persisted workerCost includes all 5 buckets (distillation, curation,
        // compaction, recall, warmup) from exact API-reported usage.
        totals.totalWorkerCost += persisted.workerCost;

        // Attribute the aggregate to buckets when the split was persisted
        // (session_state.worker_breakdown). Older rows lack it and contribute
        // only to totalWorkerCost above. Warmup is deliberately omitted here —
        // it is aggregated separately in totals.warmupCost, so summing it into
        // the breakdown too would double-count.
        const bd = persisted.workerBreakdown;
        if (bd) {
          for (const k of [
            "distillation",
            "curation",
            "compaction",
            "recall",
          ] as const) {
            totals.workerBreakdown[k].cost += bd[k]?.cost ?? 0;
            totals.workerBreakdown[k].calls += bd[k]?.calls ?? 0;
          }
        }

        // Prefer persisted avoided compaction data over re-simulation.
        // Live tracking uses real API-reported total input tokens; the
        // simulation uses chars/3 estimates that miss system prompt and
        // tool definition overhead.
        if (persisted.avoidedCompactions > 0) {
          totals.avoidedCompactions += persisted.avoidedCompactions;
          totals.avoidedCompactionCost += persisted.avoidedCompactionCost;
        } else {
          // No persisted compaction data — use simulation fallback
          totals.avoidedCompactions += avoidedCompactions;
          totals.avoidedCompactionCost += sessionCompactionCost;
        }
      } else {
        // No persisted snapshot — use heuristic distillation estimate as
        // worker cost and simulation for avoided compactions.
        totals.totalWorkerCost += sessionDistillCost;
        totals.avoidedCompactions += avoidedCompactions;
        totals.avoidedCompactionCost += sessionCompactionCost;
      }

      // Look up project info from the pre-built map
      const project = projectById.get(sess.project_id);

      sessionEstimates.push({
        projectPath: sess.project_path,
        projectName: project?.name ?? sess.project_name,
        projectId: sess.project_id,
        sessionId: sess.session_id,
        messageCount: sess.message_count,
        firstMessage: sess.first_message_at,
        lastMessage: sess.last_message_at,
        distillationCost: sessionDistillCost,
        distillationCalls: totalDistillCalls,
        distillationBatchCalls: sessionBatchCalls,
        distillationDirectCalls: sessionDirectCalls,
        avoidedCompactions: persisted?.avoidedCompactions || avoidedCompactions,
        avoidedCompactionCost:
          persisted?.avoidedCompactionCost || sessionCompactionCost,
        model,
        persisted: sessionPersisted,
      });
    }

    // Amnesia and no-store sessions intentionally leave no temporal messages,
    // so they have no session_rollup row. Preserve their recent persisted spend
    // without exposing session-level data or counting live sessions and
    // sessions already represented by a rollup twice.
    const unrolledCostSessions = db()
      .query(
        `SELECT session_id FROM session_state AS s
         WHERE s.updated_at >= ?
           AND instr(COALESCE(s.project_path, ''), '__tmp_agents_file__') = 0
           AND (s.conversation_turns > 0 OR s.warmup_savings > 0 OR
                s.warmup_cost > 0 OR s.ttl_savings > 0 OR s.batch_savings > 0)`,
      )
      .all(scanCutoffMs) as Array<{ session_id: string }>;

    for (const { session_id: sessionID } of unrolledCostSessions) {
      if (sessions.has(sessionID) || sessionsWithRollups.has(sessionID))
        continue;
      const persisted = persistedCosts.get(sessionID);
      if (!persisted) continue;

      totals.sessionCount++;
      totals.persistedConversationCost += persisted.conversationCost;
      totals.totalWorkerCost += persisted.workerCost;
      totals.warmupSavings += persisted.warmupSavings;
      totals.warmupCost += persisted.warmupCost;
      totals.warmupHits += persisted.warmupHits;
      totals.ttlSavings += persisted.ttlSavings;
      totals.ttlHits += persisted.ttlHits;
      totals.batchSavings += persisted.batchSavings;
      totals.avoidedCompactions += persisted.avoidedCompactions;
      totals.avoidedCompactionCost += persisted.avoidedCompactionCost;

      const breakdown = persisted.workerBreakdown;
      if (breakdown) {
        for (const task of [
          "distillation",
          "curation",
          "compaction",
          "recall",
        ] as const) {
          totals.workerBreakdown[task].cost += breakdown[task]?.cost ?? 0;
          totals.workerBreakdown[task].calls += breakdown[task]?.calls ?? 0;
        }
      }
    }
  } catch (e) {
    log.error("cost-tracker: historical estimate computation failed:", e);
  }

  // Sort by most recent first
  sessionEstimates.sort((a, b) => b.lastMessage - a.lastMessage);

  historicalCache = { sessions: sessionEstimates, totals };
  historicalCacheAt = Date.now();

  log.info(
    `cost-tracker: computed historical estimates for ${totals.sessionCount} sessions — ` +
      `worker overhead=$${totals.totalWorkerCost.toFixed(4)} (distillation-only=$${totals.distillationCost.toFixed(4)}), ` +
      `conversation=$${totals.persistedConversationCost.toFixed(4)}, ` +
      `avoided compactions=${totals.avoidedCompactions} ($${totals.avoidedCompactionCost.toFixed(4)}), ` +
      `warmup=net $${(totals.warmupSavings - totals.warmupCost).toFixed(4)} ` +
      `($${totals.warmupSavings.toFixed(4)} savings − $${totals.warmupCost.toFixed(4)} cost, ${totals.warmupHits} hits), ` +
      `ttl=$${totals.ttlSavings.toFixed(4)} (${totals.ttlHits} hits), ` +
      `batch=$${totals.batchSavings.toFixed(4)}`,
  );

  return historicalCache;
}

/** Invalidate the historical estimates cache. */
export function invalidateHistoricalCache(): void {
  historicalCache = null;
  historicalCacheAt = 0;
}

// ---------------------------------------------------------------------------
// Daily cost aggregation (for trend chart)
// ---------------------------------------------------------------------------

export type DailyCostEntry = {
  /** Date string in YYYY-MM-DD format (UTC). */
  date: string;
  /** Total USD cost for the day (conversation + worker + warmup). */
  cost: number;
};

/** Format a Date as a UTC YYYY-MM-DD string. */
function utcDayString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Compute per-day cost totals over the last N days from the per-day ledger.
 *
 * Reads the `daily_costs` table — a single grouped query — so cost is
 * attributed to the actual UTC day it was incurred. This replaces the prior
 * per-session bucketing that dumped whole-session cumulative cost onto a
 * single date and re-attributed all live-session cost to "today" (which
 * inflated recent days). Day boundaries are UTC throughout.
 *
 * Note: the ledger is forward-only. Cost incurred before the v30 migration
 * is not back-filled, so days before the ledger existed read 0.
 */
let dailyCostsCache: DailyCostEntry[] | null = null;
let dailyCostsCacheAt = 0;
let dailyCostsCacheDays = 0;
const DAILY_COSTS_CACHE_TTL_MS = 60_000; // 1 minute

export function computeDailyCosts(days = 14): DailyCostEntry[] {
  const now = Date.now();
  if (
    dailyCostsCache &&
    dailyCostsCacheDays === days &&
    now - dailyCostsCacheAt < DAILY_COSTS_CACHE_TTL_MS
  ) {
    return dailyCostsCache;
  }

  const dayMs = 86_400_000;

  // Build the ordered list of UTC day strings, oldest first.
  const dayKeys: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    dayKeys.push(utcDayString(new Date(now - i * dayMs)));
  }
  const cutoffDay = dayKeys[0];

  // Single grouped query for all days in the window.
  const totals = getDailyCostTotals(cutoffDay);

  const result = dayKeys.map((date) => ({ date, cost: totals.get(date) ?? 0 }));
  dailyCostsCache = result;
  dailyCostsCacheAt = now;
  dailyCostsCacheDays = days;
  return result;
}
