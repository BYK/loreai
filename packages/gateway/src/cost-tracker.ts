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
import { AUTOCOMPACT_THRESHOLD } from "./compaction";
import { log, data, temporal, loadAllSessionCosts, db, getKV, setKV } from "@loreai/core";

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

  // --- Budget throttle diagnostics ---
  throttle: {
    /** Number of requests that were throttled (delayed). */
    events: number;
    /** Total delay imposed in milliseconds. */
    totalDelayMs: number;
  };

  /** Shadow context counter — tracks virtual uncompressed context growth for compaction estimation. */
  _shadowContextTokens: number;
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
const HISTORICAL_CACHE_TTL_MS = 60_000; // 1 minute

// ---------------------------------------------------------------------------
// Daily budget throttle state
// ---------------------------------------------------------------------------

/** Cumulative USD spend for the current UTC day (conversation + worker + warmup). */
let dailySpend = 0;

/** UTC date string (YYYY-MM-DD) for which `dailySpend` is valid. */
let dailySpendDate = "";

/** EMA of cost-per-hour (USD/hr) — tracks spending velocity across all sessions. */
let costRateEMA = 0;

/** Timestamp (ms) of the last conversation turn that updated the EMA. */
let costRateLastUpdate = 0;

/** Whether the cost-rate EMA has been seeded (first turn sets it directly). */
let costRateSeeded = false;

/**
 * Base alpha for cost-rate EMA. Slower than the output-token EMA (0.3)
 * for spike resistance — one expensive turn only moves the EMA ~15%.
 */
const COST_RATE_ALPHA = 0.15;

/** Maximum throttle delay in seconds. */
const MAX_THROTTLE_DELAY = 60;

/**
 * Budget fraction below which no throttling occurs, regardless of rate.
 * At 50% spend, no friction is applied even if the rate is high.
 */
const THROTTLE_FLOOR = 0.50;

/**
 * Reset the daily spend counter if the UTC day has changed.
 * Called before every cost increment — a single string comparison.
 */
function maybeResetDay(): void {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== dailySpendDate) {
    dailySpend = 0;
    dailySpendDate = today;
  }
}

/**
 * Update the cost-rate EMA after a conversation turn.
 *
 * Computes instantaneous rate as (turnCost / hoursSinceLastTurn),
 * then blends into the EMA with time-gap-adjusted alpha.
 * Worker costs are excluded — we only track the user-facing request velocity.
 */
function updateCostRate(turnCost: number): void {
  const now = Date.now();

  if (!costRateSeeded) {
    // First turn: seed with a conservative estimate.
    // Assume 1 turn per 2 minutes = 30 turns/hr as baseline cadence.
    costRateEMA = turnCost * 30;
    costRateLastUpdate = now;
    costRateSeeded = true;
    return;
  }

  const elapsedHours = (now - costRateLastUpdate) / 3_600_000;
  costRateLastUpdate = now;

  if (elapsedHours < 0.0001) {
    // Sub-second since last update (tool-use auto-continuation).
    // Don't spike the rate — treat as part of the same logical turn.
    return;
  }

  // Instantaneous rate: cost of this turn / time since last turn
  const instantRate = turnCost / elapsedHours;

  // Time-gap adjusted alpha: after long gaps, the EMA should decay toward
  // the (low) instantaneous rate faster. After a 1-hour gap where no money
  // was spent, the old EMA is stale.
  // Reference interval = 1/30 hr ≈ 2 min (typical turn cadence).
  const referenceHours = 1 / 30;
  const effectiveAlpha = 1 - Math.pow(1 - COST_RATE_ALPHA, elapsedHours / referenceHours);

  costRateEMA = costRateEMA * (1 - effectiveAlpha) + instantRate * effectiveAlpha;
}

/**
 * Bootstrap the daily spend counter from persisted DB data on startup.
 *
 * Queries `session_state` for today's persisted costs (sessions that went
 * idle and were flushed to DB). Also sums any live in-memory sessions.
 * Call once during gateway startup.
 */
export function bootstrapDailySpend(): void {
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  dailySpendDate = todayStr;

  // Midnight UTC today as epoch ms
  const midnightMs = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());

  // Sum persisted session costs updated today.
  // Note: conversation_cost and worker_cost are cumulative session totals,
  // so multi-day sessions may overestimate today's spend. In practice most
  // sessions don't span midnight boundaries (they idle out).
  try {
    const row = db()
      .query(
        `SELECT COALESCE(SUM(conversation_cost + worker_cost), 0) as total
         FROM session_state
         WHERE updated_at >= ?`,
      )
      .get(midnightMs) as { total: number } | null;
    dailySpend = row?.total ?? 0;
  } catch (err) {
    log.error("budget-throttle: failed to bootstrap daily spend from DB", err);
    dailySpend = 0;
  }

  if (dailySpend > 0) {
    log.info(`budget-throttle: bootstrapped daily spend=$${dailySpend.toFixed(4)} for ${todayStr}`);
  }
}

/**
 * Estimate the USD cost of a request before sending it upstream.
 *
 * Input cost is exact (token count known from gradient transform).
 * Output cost uses a conservative heuristic: 25% of input tokens, capped
 * at 16K tokens. Actual median is 1-4% — the estimate deliberately
 * overestimates to avoid budget overshoot.
 */
export function estimateRequestCost(model: string, inputTokens: number): number {
  const pricing = getPricingSync(model);
  const inputCost = (inputTokens / 1_000_000) * pricing.input;
  // Conservative output estimate — 25% of input, capped at 16K tokens
  const estOutputTokens = Math.min(inputTokens * 0.25, 16_384);
  const outputCost = (estOutputTokens / 1_000_000) * pricing.output;
  return inputCost + outputCost;
}

/**
 * Compute the throttle delay for a request given current budget state.
 *
 * Two factors multiplied together:
 * 1. Budget pressure: (spendFraction - THROTTLE_FLOOR)² — gentle ramp
 * 2. Rate overshoot: tanh((currentRate / targetRate - 1) / 3) — smooth S-curve
 *
 * Returns 0 when:
 * - No budget configured (dailyBudget ≤ 0)
 * - Spend below THROTTLE_FLOOR (50%)
 * - Current rate is sustainable (projected spend ≤ budget)
 *
 * @returns Delay in seconds (0 = no throttle, max MAX_THROTTLE_DELAY)
 */
export function computeThrottleDelay(
  dailySpendUSD: number,
  dailyBudget: number,
  costRatePerHour: number,
  hoursRemaining: number,
): number {
  if (dailyBudget <= 0) return 0;

  const spendFraction = dailySpendUSD / dailyBudget;
  if (spendFraction < THROTTLE_FLOOR) return 0;

  // Budget fully exhausted — apply max delay regardless of rate.
  // Without this, a user who exhausts their budget then goes idle (EMA → 0)
  // would get zero delay on return because 0 <= targetRate(0).
  if (spendFraction >= 1.0) return MAX_THROTTLE_DELAY;

  // Target rate = remaining budget / remaining hours.
  // Floor hoursRemaining at 0.5 to avoid division explosion near midnight.
  const remainingBudget = Math.max(0, dailyBudget - dailySpendUSD);
  const safeHours = Math.max(hoursRemaining, 0.5);
  const targetRate = remainingBudget / safeHours;

  // If current rate is sustainable, no throttle
  if (costRatePerHour <= targetRate) return 0;

  // Overshoot ratio: how much faster than sustainable (clamped to [0, 10])
  const overshoot = Math.min((costRatePerHour / targetRate) - 1, 10);

  // Budget pressure: maps [THROTTLE_FLOOR, 1.0] → [0, 1], squared for gentle ramp
  const pressure = (spendFraction - THROTTLE_FLOOR) / (1 - THROTTLE_FLOOR);

  // delay = MAX_THROTTLE_DELAY × pressure² × tanh(overshoot / 3)
  // tanh provides smooth S-curve: overshoot=1 → 0.32, 3 → 0.76, 10 → ~1.0
  const delay = MAX_THROTTLE_DELAY * pressure * pressure * Math.tanh(overshoot / 3);

  return Math.min(Math.round(delay * 10) / 10, MAX_THROTTLE_DELAY);
}

/**
 * Get the throttle delay for the next request, factoring in current daily
 * spend, cost-rate EMA, and time remaining in the UTC day.
 *
 * @param dailyBudget - Configured daily budget in USD (0 = disabled)
 * @param estimatedCost - Estimated cost of the upcoming request
 * @returns Delay in seconds (0 = no throttle)
 */
export function getDailyThrottleDelay(dailyBudget: number, estimatedCost: number): number {
  if (dailyBudget <= 0) return 0;

  maybeResetDay();
  const projectedSpend = dailySpend + estimatedCost;

  // Hours remaining in the UTC day
  const now = new Date();
  const endOfDay = new Date(now);
  endOfDay.setUTCHours(24, 0, 0, 0);
  const hoursRemaining = (endOfDay.getTime() - now.getTime()) / 3_600_000;

  return computeThrottleDelay(projectedSpend, dailyBudget, costRateEMA, hoursRemaining);
}

/** Get current daily spend and date (for UI / diagnostics). */
export function getDailySpend(): { date: string; spend: number } {
  maybeResetDay();
  return { date: dailySpendDate, spend: dailySpend };
}

/** Get current cost-rate EMA in USD/hr (for UI / diagnostics). */
export function getCostRate(): number {
  return costRateEMA;
}

/** KV key for the persisted daily budget value. */
const DAILY_BUDGET_KV_KEY = "daily_budget";

/**
 * Get the effective daily budget in USD.
 *
 * Resolution priority:
 * 1. `LORE_DAILY_BUDGET` env var (override for automation / CI)
 * 2. DB-persisted value from `kv_meta` (set via UI)
 * 3. 0 (disabled)
 */
export function getDailyBudget(): number {
  const envVal = process.env.LORE_DAILY_BUDGET;
  if (envVal) {
    const parsed = parseFloat(envVal);
    if (parsed > 0) return parsed;
  }
  try {
    const dbVal = getKV(DAILY_BUDGET_KV_KEY);
    if (dbVal) {
      const parsed = parseFloat(dbVal);
      if (parsed > 0) return parsed;
    }
  } catch {
    // DB not initialized yet (e.g., early startup) — fall through
  }
  return 0;
}

/**
 * Set the daily budget in the DB (persisted across restarts).
 * Pass 0 to disable.
 */
export function setDailyBudget(budgetUSD: number): void {
  if (!Number.isFinite(budgetUSD) || budgetUSD < 0) budgetUSD = 0;
  setKV(DAILY_BUDGET_KV_KEY, String(budgetUSD));
}

/** Reset daily budget throttle state (for testing). */
export function resetDailyBudgetState(): void {
  dailySpend = 0;
  dailySpendDate = "";
  costRateEMA = 0;
  costRateLastUpdate = 0;
  costRateSeeded = false;
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
    _lastActualInput: 0,
    _lastOutputTokens: 0,
  };
}

function getOrCreate(sessionID: string): SessionCosts {
  let costs = sessions.get(sessionID);
  if (!costs) {
    costs = emptyCosts();
    sessions.set(sessionID, costs);
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
  const cacheWriteRate = ttl === "1h" ? pricing.cache_write * 2 : pricing.cache_write;

  const inputCost =
    ((usage.input_tokens ?? 0) / 1_000_000) * pricing.input * batchMultiplier;
  const cacheReadCost =
    ((usage.cache_read_input_tokens ?? 0) / 1_000_000) * pricing.cache_read;
  const cacheWriteCost =
    ((usage.cache_creation_input_tokens ?? 0) / 1_000_000) * cacheWriteRate;
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
): void {
  const costs = getOrCreate(sessionID);
  const call = computeCallCost(model, usage, "conversation", ttl);
  costs.conversation.cost += call.total;
  costs.conversation.inputTokens += usage.input_tokens ?? 0;
  costs.conversation.outputTokens += usage.output_tokens ?? 0;
  costs.conversation.cacheReadTokens += usage.cache_read_input_tokens ?? 0;
  costs.conversation.cacheWriteTokens += usage.cache_creation_input_tokens ?? 0;
  costs.conversation.turns++;

  // Daily budget throttle: accumulate spend and update velocity EMA
  maybeResetDay();
  dailySpend += call.total;
  updateCostRate(call.total);
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
): void {
  if (!sessionID) return;
  const costs = getOrCreate(sessionID);
  const call = computeCallCost(model, usage, callType);

  const bucket = WORKER_BUCKETS[workerID ?? ""] ?? "distillation";
  costs.workers[bucket].cost += call.total;
  costs.workers[bucket].calls++;

  // Track batch savings: how much more this would have cost at full price
  if (callType === "batch") {
    const fullCost = computeCallCost(model, usage, "direct");
    costs.batchSavings += fullCost.total - call.total;
  }

  // Daily budget throttle: accumulate worker spend (no EMA update — workers excluded from velocity)
  maybeResetDay();
  dailySpend += call.total;
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
): void {
  const costs = getOrCreate(sessionID);
  const pricing = getPricingSync(model);
  const readCost = (cacheReadTokens / 1_000_000) * pricing.cache_read;
  // Anthropic doubles cache_write pricing for 1h TTL
  const cacheWriteRate = ttl === "1h" ? pricing.cache_write * 2 : pricing.cache_write;
  const writeCost = (cacheCreationTokens / 1_000_000) * cacheWriteRate;
  const warmupTotal = readCost + writeCost;
  costs.workers.warmup.cost += warmupTotal;
  costs.workers.warmup.calls++;

  // Daily budget throttle: accumulate warmup spend (no EMA update)
  maybeResetDay();
  dailySpend += warmupTotal;
}

// ---------------------------------------------------------------------------
// Counterfactual tracking
// ---------------------------------------------------------------------------

/** Estimated post-compaction context size in tokens. */
const POST_COMPACTION_CONTEXT = 30_000;

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
    (10_000 / 1_000_000) * wPricing.input + (2_000 / 1_000_000) * wPricing.output;
  // Compaction LLM call: ~20K input, ~5K output
  const compactCost =
    (20_000 / 1_000_000) * wPricing.input + (5_000 / 1_000_000) * wPricing.output;

  // Cache bust: post-compaction context (~POST_COMPACTION_CONTEXT tokens) must
  // be re-written to cache. The penalty is the difference between cache_write
  // and cache_read pricing on the conversation model.
  // Anthropic charges 2× cache_write for 1h TTL.
  let cacheBustCost = 0;
  if (conversationModel) {
    const cPricing = getPricingSync(conversationModel);
    const cacheWriteRate = ttl === "1h" ? cPricing.cache_write * 2 : cPricing.cache_write;
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
): void {
  const costs = getOrCreate(sessionID);

  // On first turn, initialize shadow context to the actual input size.
  // No compression has happened yet, so the actual count is accurate.
  // NOTE: this check relies on recordConversationCost() having already
  // incremented turns for this turn (called earlier in postResponse).
  if (costs.conversation.turns <= 1) {
    costs._shadowContextTokens = totalInputTokens;
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

  if (costs._shadowContextTokens > AUTOCOMPACT_THRESHOLD) {
    costs.counterfactual.avoidedCompactions++;
    costs.counterfactual.avoidedCompactionCost +=
      estimateCompactionCost(workerModel, conversationModel, ttl);
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
  const pricing = getPricingSync(model);
  // Anthropic doubles cache_write pricing for 1h TTL
  const cacheWriteRate = ttl === "1h" ? pricing.cache_write * 2 : pricing.cache_write;
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
  sessions.delete(sessionID);
}

/** Clear all sessions (for testing). */
export function clearAllCosts(): void {
  sessions.clear();
  resetDailyBudgetState();
}

// ---------------------------------------------------------------------------
// Historical backdating — estimates from stored DB data
// ---------------------------------------------------------------------------

/**
 * Extract model ID from a temporal message's metadata JSON.
 * Returns null if metadata is missing or unparseable.
 */
function extractModelFromMetadata(metadata: string | null | undefined): string | null {
  if (!metadata) return null;
  try {
    const parsed = JSON.parse(metadata);
    // Assistant messages: { modelID, providerID, ... }
    if (parsed.modelID && parsed.modelID !== "unknown") return parsed.modelID;
    // User messages: { agent, model: { providerID, modelID } }
    if (parsed.model?.modelID && parsed.model.modelID !== "unknown") return parsed.model.modelID;
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
 * Results are cached for 1 minute to avoid repeated DB scans.
 */
export function computeHistoricalEstimates(): HistoricalEstimates {
  // Return cache if fresh
  if (historicalCache && Date.now() - historicalCacheAt < HISTORICAL_CACHE_TTL_MS) {
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
    warmupHits: 0,
    ttlSavings: 0,
    ttlHits: 0,
    batchSavings: 0,
    sessionCount: 0,
    messageCount: 0,
    totalWorkerCost: 0,
    persistedConversationCost: 0,
  };

  const sessionEstimates: HistoricalEstimates["sessions"] = [];

  // Resolve the worker model used for distillation calls.
  // Distillations run on the worker model (e.g. claude-sonnet-4-6), not the
  // conversation model (e.g. claude-opus-4-6). Use worker pricing for overhead.
  const workerResult = getWorkerModel();
  const workerModelID = workerResult?.modelID ?? DEFAULT_ESTIMATION_MODEL;
  const workerPricing = getPricingSync(workerModelID);

  // Load persisted cost snapshots from DB (saved on idle).
  const persistedCosts = loadAllSessionCosts();

  try {
    const projects = data.listProjects();

    for (const project of projects) {
      // Skip test sessions (created by the test suite)
      if (project.path.includes("__tmp_agents_file__")) continue;

      const projectSessions = data.listSessions(project.path, 500);

      for (const sess of projectSessions) {
        // Skip sessions that are currently tracked live
        if (sessions.has(sess.session_id)) continue;

        totals.sessionCount++;
        totals.messageCount += sess.message_count;

        // --- Determine model for this session ---
        // Look at assistant messages' metadata for model info (user messages have "unknown")
        const messages = temporal.bySession(project.path, sess.session_id);
        let model = DEFAULT_ESTIMATION_MODEL;
        for (const msg of messages) {
          const m = extractModelFromMetadata(msg.metadata);
          if (m) {
            model = m;
            break;
          }
        }

        // --- 1. Estimate distillation overhead ---
        // Use worker model pricing — distillations run on the worker, not conversation model
        const distillations = data.listDistillations(project.path, {
          sessionId: sess.session_id,
          limit: 500,
        });
        let sessionDistillCost = 0;
        for (const d of distillations) {
          // Estimate: input tokens = source message tokens (typically 2-5x output)
          // We use 3x the output token count as a rough input estimate
          const estInputTokens = d.token_count * 3;
          const estOutputTokens = d.token_count;
          // Use recorded call_type for accurate pricing. Batch API gets 50%
          // discount. Pre-migration rows (NULL call_type) default to 'direct'
          // for conservative estimates.
          const batchMultiplier = d.call_type === "batch" ? 0.5 : 1.0;
          const callCost =
            ((estInputTokens / 1_000_000) * workerPricing.input +
            (estOutputTokens / 1_000_000) * workerPricing.output) * batchMultiplier;
          sessionDistillCost += callCost;
        }
        const sessionBatchCalls = distillations.filter((d) => d.call_type === "batch").length;
        const sessionDirectCalls = distillations.length - sessionBatchCalls;
        totals.distillationCost += sessionDistillCost;
        totals.distillationCalls += distillations.length;
        totals.distillationBatchCalls += sessionBatchCalls;
        totals.distillationDirectCalls += sessionDirectCalls;

        // --- 2. Simulate shadow context for avoided compactions ---
        let shadowContext = 0;
        let avoidedCompactions = 0;

        for (const msg of messages) {
          // Each message adds its tokens to the running context
          shadowContext += msg.tokens;

          if (shadowContext > AUTOCOMPACT_THRESHOLD) {
            avoidedCompactions++;
            shadowContext = POST_COMPACTION_CONTEXT;
          }
        }

        const sessionCompactionCost = avoidedCompactions * estimateCompactionCost(workerModelID, model);

        // --- 3. Look up persisted live-session cost data ---
        // Avoided compaction and worker cost totals are accumulated here
        // (not above) because persisted real data is preferred over simulation.
        const persisted = persistedCosts.get(sess.session_id);
        let sessionPersisted: HistoricalEstimates["sessions"][number]["persisted"] = null;
        if (persisted) {
          sessionPersisted = {
            conversationCost: persisted.conversationCost,
            workerCost: persisted.workerCost,
            conversationTurns: persisted.conversationTurns,
            warmupSavings: persisted.warmupSavings,
            warmupHits: persisted.warmupHits,
            ttlSavings: persisted.ttlSavings,
            ttlHits: persisted.ttlHits,
            batchSavings: persisted.batchSavings,
            avoidedCompactions: persisted.avoidedCompactions,
            avoidedCompactionCost: persisted.avoidedCompactionCost,
          };
          totals.warmupSavings += persisted.warmupSavings;
          totals.warmupHits += persisted.warmupHits;
          totals.ttlSavings += persisted.ttlSavings;
          totals.ttlHits += persisted.ttlHits;
          totals.batchSavings += persisted.batchSavings;
          totals.persistedConversationCost += persisted.conversationCost;

          // Prefer persisted real worker cost over heuristic distillation estimate.
          // The persisted workerCost includes all 5 buckets (distillation, curation,
          // compaction, recall, warmup) from exact API-reported usage.
          totals.totalWorkerCost += persisted.workerCost;

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

        sessionEstimates.push({
          projectPath: project.path,
          projectName: project.name,
          projectId: project.id,
          sessionId: sess.session_id,
          messageCount: sess.message_count,
          firstMessage: sess.first_message_at,
          lastMessage: sess.last_message_at,
          distillationCost: sessionDistillCost,
          distillationCalls: distillations.length,
          distillationBatchCalls: sessionBatchCalls,
          distillationDirectCalls: sessionDirectCalls,
          avoidedCompactions: persisted?.avoidedCompactions || avoidedCompactions,
          avoidedCompactionCost: persisted?.avoidedCompactionCost || sessionCompactionCost,
          model,
          persisted: sessionPersisted,
        });
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
      `warmup=$${totals.warmupSavings.toFixed(4)} (${totals.warmupHits} hits), ` +
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
  /** Date string in YYYY-MM-DD format. */
  date: string;
  /** Total USD cost for the day (conversation + worker). */
  cost: number;
  /** Number of sessions active on this day. */
  sessions: number;
};

/**
 * Compute per-day cost totals over the last N days.
 *
 * Uses historical estimates (persisted snapshots) bucketed by lastMessage date,
 * plus live session costs bucketed to today. Pass a pre-fetched `preloaded`
 * to avoid redundant DB scans when the caller already has the data.
 */
export function computeDailyCosts(days = 14, preloaded?: HistoricalEstimates): DailyCostEntry[] {
  const today = new Date();
  const cutoff = new Date(today);
  cutoff.setDate(cutoff.getDate() - days + 1);
  cutoff.setHours(0, 0, 0, 0);
  const cutoffMs = cutoff.getTime();

  // Initialize date buckets
  const buckets = new Map<string, { cost: number; sessions: number }>();
  for (let i = 0; i < days; i++) {
    const d = new Date(cutoff);
    d.setDate(d.getDate() + i);
    buckets.set(d.toISOString().slice(0, 10), { cost: 0, sessions: 0 });
  }

  // Historical sessions (excludes currently-live sessions)
  const hist = preloaded ?? computeHistoricalEstimates();
  for (const s of hist.sessions) {
    if (s.lastMessage < cutoffMs) continue;
    const dateKey = new Date(s.lastMessage).toISOString().slice(0, 10);
    const bucket = buckets.get(dateKey);
    if (!bucket) continue;
    const sessionCost = s.persisted
      ? s.persisted.conversationCost + s.persisted.workerCost
      : s.distillationCost;
    bucket.cost += sessionCost;
    bucket.sessions += 1;
  }

  // Live sessions — bucket by today's date. Historical estimates skip live
  // sessions (to avoid double-counting), so we must add them here. We bucket
  // to today since these sessions are actively accumulating cost right now.
  const todayKey = today.toISOString().slice(0, 10);
  const todayBucket = buckets.get(todayKey);
  if (todayBucket) {
    for (const [, c] of sessions) {
      const cost = totalActualCost(c);
      if (cost > 0) {
        todayBucket.cost += cost;
        todayBucket.sessions += 1;
      }
    }
  }

  // Convert to sorted array
  return [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, v]) => ({ date, cost: v.cost, sessions: v.sessions }));
}
