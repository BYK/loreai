/**
 * Speculative cache warming — sends keepalive requests to refresh
 * Anthropic's prompt cache before it expires.
 *
 * Uses survival analysis on inter-turn gaps to predict whether the user
 * will return before the cache TTL expires. If the expected value of
 * warming (P(return) × cache_miss_savings) exceeds the warmup cost
 * (cache_read_cost), sends a max_tokens:0 request that refreshes the
 * cache without generating output.
 *
 * Key design decisions:
 *  - Cache keys are computed from tokenized prompt content (tools →
 *    system → messages), NOT raw JSON bytes. max_tokens, stream, and
 *    temperature are not part of the cache key. Confirmed by Anthropic
 *    pre-warming docs and cache invalidation table.
 *  - The normalized lastRequestBody from cache-analytics is sufficient
 *    for replay — cch/version suffix normalization doesn't affect the
 *    cache key (those are billing verification, not prompt content).
 *  - Global circuit breaker: if 3 warmup requests cause cache writes
 *    instead of reads (meaning the warmup body doesn't match the cached
 *    prefix), ALL warming is disabled for the process lifetime. This
 *    prevents burning money if our assumptions about cache key computation
 *    are wrong.
 */

import {
  log,
  config as loreConfig,
  db,
  databaseInTransaction,
  canonicalProjectId,
  currentTenantId,
  withSavepoint,
  withTenant,
  projectId,
  getKV,
  setKV,
  evaluateCacheStrategy,
  strategyWantsWarming,
  getLastTransformLayer,
  estimateMetaDistillCostPerCall,
  getPrefixChurnRate,
  PREFIX_CHURN_WARM_BLOCK,
  decodeWarmupHistogram,
  emptyWarmupHistogramCounts,
  encodeWarmupHistogram,
  mergeWarmupHistogramCounts,
  normalizeWarmupHistogram,
} from "@loreai/core";
import {
  applyUpstreamExtraHeaders,
  type InterTurnHistogram,
  type GatewayMessage,
  type WarmingSegment,
  type WarmupResult,
  type SessionState,
  type WarmupState,
} from "./translate/types";
import {
  cacheSegmentDigest,
  classifyWarmupProbe,
  decompressBody,
  isWarmupProbeEnabled,
} from "./cache-analytics";
import { resolveAuth, authHeaders, markAuthStale } from "./auth";
import { recordWorkerFailure, recordWorkerSuccess } from "./worker-health";
import { resignBody } from "./cch";
import {
  extraHeadersForUpstream,
  loadConfig,
  resolveUpstreamRoute,
  type GatewayConfig,
} from "./config";
import { isBedrockMantleHost } from "./translate/bedrock";
import {
  isVertexHost,
  toVertexBody,
  toVertexModelId,
  vertexHost,
  vertexRawPredictUrl,
  vertexRegionFromUrl,
} from "./translate/vertex";
import { getVertexAccessToken, resolveVertexProject } from "./vertex-auth";
import {
  getModelEntrySync,
  getModelEntrySyncForProvider,
  getWorkerModel,
} from "./worker-model";
import { recordWarmupCost } from "./cost-tracker";
import { resolveCostAttribution } from "./cost-attribution";
import { upstreamFetch } from "./fetch";
import { emitWarmupCircuitBreakerMetric } from "./sentry";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Log-scale histogram bin edges (ms). High resolution around the 5m and
 * 1h TTL boundaries where the warming decision matters most.
 */
export const HISTOGRAM_BINS: readonly number[] = [
  10_000, // 10s
  20_000, // 20s
  30_000, // 30s
  45_000, // 45s
  60_000, // 1m
  90_000, // 1.5m
  120_000, // 2m
  180_000, // 3m
  240_000, // 4m
  300_000, // 5m   ← 5m TTL boundary
  420_000, // 7m
  600_000, // 10m
  900_000, // 15m
  1_200_000, // 20m
  1_800_000, // 30m
  2_700_000, // 45m
  3_600_000, // 1h   ← 1h TTL boundary
  5_400_000, // 1.5h
  7_200_000, // 2h
  14_400_000, // 4h
] as const;

/** Number of histogram bins (edges + 1 overflow bin). */
const BIN_COUNT = HISTOGRAM_BINS.length + 1;

/** Pseudocount for Bayesian blending of session vs global histograms. */
export const BLEND_PSEUDOCOUNT = 20;

/** Minimum history for the separate tool-wait probing path. */
const MIN_TURNS_FOR_TOOL_WARMING = 5;

/** Maximum duration (ms) to keep warming during a tool call before
 *  falling back to normal survival analysis. 10 min ≈ 2 cycles at 5m TTL. */
export const MAX_TOOL_CALL_WARMING_MS = 10 * 60 * 1000;

/** Maximum warmup cycles during a single tool-call break. Most tool
 *  calls complete in <5 minutes; 2 cycles covers a 10-minute operation
 *  at 5m TTL, sufficient for 95%+ of tool calls. */
export const TOOL_CALL_MAX_CYCLES = 2;

/** Lifetime confirmed warmup hits required before a SECOND (or later) cycle
 *  is funded within a single tool-call break. The first warmup of each break
 *  is always allowed (the irreducible probe that learns whether a slow tool
 *  returns within TTL). Subsequent cycles in the same break are gated on
 *  evidence: if this session has never recorded a hit, keep-warming is
 *  empirically pure waste. Empirically (Jun 2026): 74 zero-hit tool-call
 *  warmups across 24 sessions, all at <=5 lifetime warmups — the existing
 *  MIN_WARMUPS_FOR_ROI_CHECK=5 guard let nearly all of them through. */
export const TOOL_CALL_MIN_HITS_FOR_CONTINUATION = 1;

/** Max uncached warmup responses before a bucket's circuit breaker trips. */
const CIRCUIT_BREAKER_MAX_FAILURES = 3;

/** How long a tripped bucket stays disabled before auto-decaying (ms). A
 *  transient upstream cache-key change recovers on its own within this window;
 *  a genuinely broken bucket wastes at most a few warmups per decay period.
 *  Buckets can also be cleared immediately via resetCircuitBreaker(). */
export const CIRCUIT_BREAKER_DECAY_MS = 6 * 3_600_000; // 6 hours

/** KV key for the runtime cache-warming on/off override (set via UI / slash). */
const WARMING_ENABLED_KV_KEY = "warming_enabled";

/**
 * Whether cache warming is enabled. Resolution priority (highest first):
 *   1. `LORE_WARMING_ENABLED` env var — "0"/"false"/"off"/"no" disable,
 *      anything else enables (override for automation / CI).
 *   2. DB-persisted KV override, set via the dashboard or `/lore:warm:on|off`
 *      ("1" = on, "0" = off). Absent → fall through.
 *   3. `cache.warming.enabled` from `.lore.json` (schema default: true).
 *
 * This makes the file-only config flag runtime-settable without a restart —
 * mirroring the daily-budget toggle. The gate lives in `shouldWarm`, so warming
 * can be turned off globally the moment it stops paying for itself.
 */
export function isWarmingEnabled(): boolean {
  const env = process.env.LORE_WARMING_ENABLED;
  if (env != null && env.trim() !== "") {
    return !/^(0|false|off|no)$/i.test(env.trim());
  }
  try {
    const kv = getKV(WARMING_ENABLED_KV_KEY);
    if (kv === "0") return false;
    if (kv === "1") return true;
  } catch {
    // DB not initialized yet (e.g. early startup) — fall through to config.
  }
  return loreConfig().cache.warming.enabled;
}

/**
 * Read the runtime KV override directly (no env / config fallback). Returns
 * `true`/`false` when an override is set, or `null` when unset (so the UI can
 * show "following config default"). Used only for display.
 */
export function getWarmingEnabledOverride(): boolean | null {
  try {
    const kv = getKV(WARMING_ENABLED_KV_KEY);
    if (kv === "0") return false;
    if (kv === "1") return true;
  } catch {
    // DB not ready — treat as no override.
  }
  return null;
}

/** Persist the runtime warming on/off override (survives restarts). */
export function setWarmingEnabled(enabled: boolean): void {
  setKV(WARMING_ENABLED_KV_KEY, enabled ? "1" : "0");
}

/** Minimum total warmups before session-level hit-rate ROI check kicks in. */
export const MIN_WARMUPS_FOR_ROI_CHECK = 5;

/** Minimum session-level hit rate to continue warming. Below this,
 *  warming is empirically unprofitable and we stop. 25% means at least
 *  1 in 4 warmups must result in a confirmed user return. */
export const MIN_SESSION_HIT_RATE = 0.25;

/**
 * Gradient layer at/above which a session is treated as under *emergency
 * compaction* and warming is hard-blocked. Layer 4 is the emergency tail and
 * Layer 3 the heavy-compression band just below it; in both, the raw window is
 * cut and re-cut every turn so the distilled prefix re-renders, and the stored
 * body a warmup replays no longer matches the cached prefix — warmups land as
 * expensive partial writes ($1-3 on large Opus contexts) that the next real
 * turn immediately discards (observed Jul 2026: session under Layer 4 produced
 * hit=4%/10% warmups at $3+). The prefix-churn EMA is the general signal but
 * lags and dips between rewrites; the layer is a direct read of the session's
 * current compression state. See getLastTransformLayer(). */
export const EMERGENCY_COMPACTION_LAYER = 3;

/**
 * Shadow-mode (PR2a) cap on the `expectedFutureTurns` proxy fed into the shared
 * cache-economics evaluator. Until PR2b derives a principled mean-residual-life
 * estimate, we use "turns seen so far" (a session that has run N turns is, on
 * average, about halfway) capped here so a single very long session doesn't
 * dominate the ongoing-cost term while we are only MEASURING. Behavior-neutral.
 */
export const SHADOW_FUTURE_TURNS_CAP = 50;

/** Minimum total input tokens (input + cache_read + cache_creation) before
 *  warming is eligible. Below this threshold the absolute savings per hit
 *  are too small to justify the risk of wasted warmups. At 50K tokens with
 *  Opus 5m, a hit saves ~$0.29 and a warmup costs ~$0.025. */
export const MIN_INPUT_TOKENS_FOR_WARMING = 50_000;

/** Size-proportional warmup-margin scaling (5m TTL only). The headroom a prefix
 *  needs to clear its largest block's per-block TTL boundary is ABSOLUTE (a
 *  function of prefix size), not a fraction of the TTL — so the 45s base gets a
 *  per-token term. ~0.27ms/token puts a 164K prefix at ~44s of added headroom
 *  (→ ~89s total margin), matching observed warmup round-trip + boundary jitter
 *  for large multi-block prefixes. See computeWarmupMargin. */
export const MARGIN_PER_TOKEN_MS = 0.27;

/** Absolute cap on the size-driven margin term. Bounds the margin with a fixed
 *  tail instead of a fraction of the TTL: a fraction would balloon the 1h margin
 *  to 24min (warm with 36min of life left = thrash), and even on 5m would warm
 *  too early. With this cap the 5m margin tops out at 45s + 90s = 135s (the cap
 *  bites only past ~333K-token prefixes). */
export const MAX_SIZE_MARGIN_MS = 90_000;

// ---------------------------------------------------------------------------
// Per-bucket circuit breaker
// ---------------------------------------------------------------------------
//
// A warmup "failure" is a response with cacheCreation > 0 AND cacheRead === 0
// while the cached prefix should still have been alive (see `cacheLikelyAlive`
// in executeWarmup) — meaning the warmup body did not match the cached prefix.
//
// The breaker is scoped PER BUCKET — keyed by (sessionID, model, upstreamURL) —
// so one pathological session/model/provider can never disable warming for
// healthy sessions. Switching model or provider mid-session lands in a separate
// bucket. A tripped bucket auto-decays after CIRCUIT_BREAKER_DECAY_MS so a
// transient upstream cache-key change recovers on its own; it can also be
// cleared explicitly via resetCircuitBreaker() (/lore:warm:reset, UI button).

type BreakerEntry = {
  /** Consecutive uncached warmups (reset on a confirmed cache read). In-memory only. */
  failures: number;
  /** True once `failures` reached CIRCUIT_BREAKER_MAX_FAILURES. */
  tripped: boolean;
  /** ms timestamp when this bucket tripped (0 when not tripped). Drives auto-decay. */
  trippedAt: number;
};

/** Per-bucket breaker state. Key = warmupBucketKey(state). */
const circuitBreakers = new Map<string, BreakerEntry>();
let circuitBreakersLoaded = false;
let circuitBreakerCleanupPending = false;

const CB_KV_KEY = "warmup_circuit_breaker";

/**
 * Compute the circuit-breaker bucket key for a session: (sessionID, model,
 * upstreamURL). Switching model or upstream mid-session yields a distinct
 * bucket so failures never cross-contaminate.
 */
export function warmupBucketKey(state: SessionState): string {
  const model = state.lastUpstream?.model ?? "unknown";
  const url = state.lastUpstream?.url
    ? warmupUrlForLog(state.lastUpstream.url)
    : "unknown";
  return `${state.sessionID}\x1f${model}\x1f${url}`;
}

/** Strip credential-bearing URL components while retaining endpoint routing. */
function warmupUrlForLog(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "invalid";
    return `${url.origin}${url.pathname}`;
  } catch {
    return "invalid";
  }
}

/** Load tripped buckets from DB on first access (only tripped buckets persist). */
function ensureCircuitBreakersLoaded(persistCleanup = true): void {
  if (!circuitBreakersLoaded) {
    circuitBreakersLoaded = true;
    try {
      const raw = getKV(CB_KV_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as {
          version?: number;
          buckets?: Record<string, { trippedAt?: number }>;
        };
        // Legacy v1 shape ({tripped, failures}) carried no bucket identity.
        // Defer migration if a dashboard read is the first access.
        if (parsed.version !== 2 || !parsed.buckets) {
          circuitBreakerCleanupPending = true;
        } else {
          const now = Date.now();
          for (const [bucket, entry] of Object.entries(parsed.buckets)) {
            const trippedAt = entry.trippedAt ?? 0;
            // Apply decay on load — drop buckets older than the decay window.
            if (trippedAt > 0 && now - trippedAt < CIRCUIT_BREAKER_DECAY_MS) {
              circuitBreakers.set(bucket, {
                failures: 0,
                tripped: true,
                trippedAt,
              });
            } else {
              circuitBreakerCleanupPending = true;
            }
          }
        }
      }
    } catch {
      // Corrupted value — start fresh.
    }
  }
  if (persistCleanup && circuitBreakerCleanupPending) {
    saveCircuitBreakers();
    circuitBreakerCleanupPending = false;
  }
}

/** Persist only tripped buckets to DB in the v2 shape. */
function saveCircuitBreakers(): void {
  const buckets: Record<string, { trippedAt: number }> = {};
  for (const [bucket, entry] of circuitBreakers) {
    if (entry.tripped) buckets[bucket] = { trippedAt: entry.trippedAt };
  }
  setKV(CB_KV_KEY, JSON.stringify({ version: 2, buckets }));
}

/**
 * Check if a bucket's circuit breaker has tripped.
 *
 * Applies auto-decay: a tripped bucket older than CIRCUIT_BREAKER_DECAY_MS is
 * cleared and re-armed, so a transient upstream cache-key change recovers on
 * its own without a restart or manual reset.
 */
export function isCircuitBreakerTripped(
  bucketKey: string,
  now: number = Date.now(),
): boolean {
  ensureCircuitBreakersLoaded();
  const entry = circuitBreakers.get(bucketKey);
  if (!entry?.tripped) return false;
  if (now - entry.trippedAt >= CIRCUIT_BREAKER_DECAY_MS) {
    circuitBreakers.delete(bucketKey);
    saveCircuitBreakers();
    return false;
  }
  return true;
}

/**
 * Snapshot of a bucket's circuit breaker state for dashboard rendering.
 *
 * Pure read — never mutates the map or persists (unlike isCircuitBreakerTripped,
 * which prunes the entry on decay). A tripped bucket past its decay window is
 * reported as fully recovered (tripped:false, failures:0, trippedAt:0); the
 * stale entry is reclaimed by the idle sweep or the next isCircuitBreakerTripped
 * call, not here. Computing decay inline (rather than calling
 * isCircuitBreakerTripped and then re-reading the entry) avoids an
 * order-of-operations hazard where the just-deleted entry would read back as
 * trippedAt:0.
 */
export function getCircuitBreakerStatus(
  bucketKey: string,
  now: number = Date.now(),
): {
  tripped: boolean;
  failures: number;
  maxFailures: number;
  trippedAt: number;
} {
  ensureCircuitBreakersLoaded(false);
  const entry = circuitBreakers.get(bucketKey);
  const decayed =
    !!entry?.tripped && now - entry.trippedAt >= CIRCUIT_BREAKER_DECAY_MS;
  if (!entry || decayed) {
    return {
      tripped: false,
      failures: 0,
      maxFailures: CIRCUIT_BREAKER_MAX_FAILURES,
      trippedAt: 0,
    };
  }
  return {
    tripped: entry.tripped,
    failures: entry.failures,
    maxFailures: CIRCUIT_BREAKER_MAX_FAILURES,
    trippedAt: entry.tripped ? entry.trippedAt : 0,
  };
}

/** Aggregate breaker state across all buckets (for the dashboard global card). */
export function getCircuitBreakerSummary(now: number = Date.now()): {
  trippedCount: number;
  entries: Array<{ bucket: string; trippedAt: number }>;
} {
  ensureCircuitBreakersLoaded(false);
  const entries: Array<{ bucket: string; trippedAt: number }> = [];
  for (const [bucket, entry] of circuitBreakers) {
    if (entry.tripped && now - entry.trippedAt < CIRCUIT_BREAKER_DECAY_MS) {
      entries.push({ bucket, trippedAt: entry.trippedAt });
    }
  }
  return { trippedCount: entries.length, entries };
}

/**
 * Drop tripped buckets that have aged past the decay window. The decay-on-read
 * path in isCircuitBreakerTripped only fires for buckets that are re-queried;
 * a bucket belonging to an evicted/dead session is never re-checked, so without
 * this sweep its (persisted) tripped entry would linger until process restart.
 * Called periodically from the idle loop to keep both the in-memory map and the
 * persisted KV bounded. Returns the number of buckets pruned.
 *
 * Non-tripped failure entries are not persisted and are cleared on the next
 * confirmed read or reset, so they are intentionally left untouched here.
 */
export function pruneExpiredCircuitBreakers(now: number = Date.now()): number {
  ensureCircuitBreakersLoaded();
  let pruned = 0;
  for (const [bucket, entry] of circuitBreakers) {
    if (entry.tripped && now - entry.trippedAt >= CIRCUIT_BREAKER_DECAY_MS) {
      circuitBreakers.delete(bucket);
      pruned++;
    }
  }
  if (pruned > 0) saveCircuitBreakers();
  return pruned;
}

/**
 * Record a warmup result for a bucket and check its circuit breaker.
 *
 * 🔴 All-or-nothing: a warmup replays the stored body during idle (no tail
 * growth), so a healthy warmup is 100% cacheRead / 0 cacheCreation. ANY
 * cacheCreation > 0 while the cached prefix should still have been alive
 * (`cacheLikelyAlive`) is a body-divergence DEFECT — whether a partial
 * (cacheRead > 0 too) or a full miss (cacheRead === 0). Both count as failures;
 * a partial is NOT "fine". Only a CLEAN refresh (cacheRead > 0 AND
 * cacheCreation === 0) clears accumulated failures. When the cache had already
 * expired (`!cacheLikelyAlive`), a write is the warmer legitimately re-priming a
 * cold cache — neutral. Non-2xx responses (`result.ok === false`) are neutral.
 *
 * Returns true if the bucket's breaker is tripped (warming should stop).
 */
export function checkCircuitBreaker(
  result: WarmupResult,
  bucketKey: string,
  cacheLikelyAlive: boolean,
  now: number = Date.now(),
): boolean {
  ensureCircuitBreakersLoaded();
  if (isCircuitBreakerTripped(bucketKey, now)) return true;

  if (result.ok && result.cacheCreationTokens > 0 && cacheLikelyAlive) {
    const entry = circuitBreakers.get(bucketKey) ?? {
      failures: 0,
      tripped: false,
      trippedAt: 0,
    };
    entry.failures++;
    circuitBreakers.set(bucketKey, entry);
    const kind = result.cacheReadTokens > 0 ? "partial" : "uncached";
    log.error(
      `cache-warmer CIRCUIT BREAKER: warmup caused ${kind} write for ` +
        `bucket=${bucketKey.slice(0, 24)} ` +
        `(${entry.failures}/${CIRCUIT_BREAKER_MAX_FAILURES}). ` +
        `cacheCreation=${result.cacheCreationTokens} cacheRead=${result.cacheReadTokens}`,
    );
    if (entry.failures >= CIRCUIT_BREAKER_MAX_FAILURES) {
      entry.tripped = true;
      entry.trippedAt = now;
      saveCircuitBreakers();
      emitWarmupCircuitBreakerMetric();
      log.error(
        `cache-warmer CIRCUIT BREAKER TRIPPED for bucket=${bucketKey.slice(0, 24)}: ` +
          `${CIRCUIT_BREAKER_MAX_FAILURES} divergent (partial/uncached) warmups detected. ` +
          `Warming disabled for this (session, model, upstream) until it decays in ` +
          `${Math.round(CIRCUIT_BREAKER_DECAY_MS / 3_600_000)}h or is reset. This indicates ` +
          `warmup bodies don't match the cached prefix — investigate cache key assumptions.`,
      );
      return true;
    }
  } else if (
    result.ok &&
    result.cacheReadTokens > 0 &&
    result.cacheCreationTokens === 0
  ) {
    // Clean 100% refresh — clear any accumulated (non-tripped) failures. A
    // partial (cacheCreation > 0) does NOT reach here; it is a failure above.
    const entry = circuitBreakers.get(bucketKey);
    if (entry && !entry.tripped) circuitBreakers.delete(bucketKey);
  }

  return false;
}

/**
 * Reset the circuit breaker. Pass a bucket key to clear a single bucket, or
 * omit to clear ALL buckets. The production recovery path — reachable via the
 * /lore:warm:reset slash command.
 */
export function resetCircuitBreaker(bucketKey?: string): void {
  ensureCircuitBreakersLoaded();
  if (bucketKey) {
    circuitBreakers.delete(bucketKey);
  } else {
    circuitBreakers.clear();
  }
  saveCircuitBreakers();
}

// ---------------------------------------------------------------------------
// Auth-disabled sessions (401/403 from upstream)
// ---------------------------------------------------------------------------

/**
 * Sessions whose warmup requests returned 401/403.
 * Cleared when a fresh credential arrives (via clearWarmupAuthDisabled).
 * Not persisted — on restart, sessions re-attempt naturally.
 */
const authDisabledSessions = new Set<string>();
const warmingSessionsInProgress = new Set<string>();

export type WarmingMode = "keep" | "stop" | "auto";

/** Apply the shared operator control used by the API and /lore:warm commands. */
export function applyWarmingMode(state: SessionState, mode: WarmingMode): void {
  state.warmup ??= {
    lastWarmupAt: 0,
    warmupCount: 0,
    totalWarmups: 0,
    warmupHits: 0,
    disabled: false,
  };
  state.warmup.userStopped = mode === "stop";
  state.warmup.disabled = mode === "stop";
  state.warmup.forceKeepWarm = mode === "keep";
  state._dirty = true;
}

/** Check if warmup is auth-disabled for a session. */
export function isWarmupAuthDisabled(sessionID: string): boolean {
  return authDisabledSessions.has(sessionID);
}

/** Mark a session as unavailable for warmups after an upstream auth failure. */
export function disableWarmupForAuth(sessionID: string): void {
  authDisabledSessions.add(sessionID);
}

/** Clear warmup auth-disabled flag for a session (fresh credential arrived). */
export function clearWarmupAuthDisabled(sessionID: string): void {
  authDisabledSessions.delete(sessionID);
}

/** Check whether a keepalive request is currently running for this session. */
export function isWarmupInProgress(sessionID: string): boolean {
  return warmingSessionsInProgress.has(sessionID);
}

/** Claim a session for one keepalive request; false means another loop owns it. */
export function beginWarmup(sessionID: string): boolean {
  if (warmingSessionsInProgress.has(sessionID)) return false;
  warmingSessionsInProgress.add(sessionID);
  return true;
}

/** Release the keepalive claim after the request settles. */
export function endWarmup(sessionID: string): void {
  warmingSessionsInProgress.delete(sessionID);
}

// ---------------------------------------------------------------------------
// Histogram operations
// ---------------------------------------------------------------------------

/** Create an empty histogram with the right number of bins. */
export function createHistogram(): InterTurnHistogram {
  return { counts: Array.from({ length: BIN_COUNT }, () => 0), total: 0 };
}

/**
 * Find the bin index for a gap duration.
 * Returns 0..HISTOGRAM_BINS.length (last index is the overflow bin).
 */
function binIndex(gapMs: number): number {
  for (let i = 0; i < HISTOGRAM_BINS.length; i++) {
    if (gapMs < HISTOGRAM_BINS[i]) return i;
  }
  return HISTOGRAM_BINS.length; // overflow
}

/** Record an inter-turn gap in a histogram. */
export function recordGap(histogram: InterTurnHistogram, gapMs: number): void {
  const idx = binIndex(gapMs);
  histogram.counts[idx]++;
  histogram.total++;
}

// ---------------------------------------------------------------------------
// Survival function
// ---------------------------------------------------------------------------

/**
 * Compute the survival function S(t) = P(gap > t) from a histogram.
 *
 * S(t) = (# observations with gap > t) / total
 *
 * For an empty histogram, returns 1.0 (optimistic — assume user returns).
 */
export function survivalFunction(
  histogram: InterTurnHistogram,
  tMs: number,
): number {
  if (histogram.total === 0) return 1.0;

  const idx = binIndex(tMs);
  // Sum counts in bins > idx (gaps strictly larger than tMs)
  let surviving = 0;
  for (let i = idx + 1; i < BIN_COUNT; i++) {
    surviving += histogram.counts[i];
  }
  // Include a fraction of the current bin proportionally
  // (linear interpolation within the bin)
  const binStart = idx > 0 ? HISTOGRAM_BINS[idx - 1] : 0;
  const binEnd = idx < HISTOGRAM_BINS.length ? HISTOGRAM_BINS[idx] : Infinity;
  const binWidth = binEnd - binStart;
  if (binWidth > 0 && Number.isFinite(binWidth)) {
    const fractionPast = Math.min(1, Math.max(0, (tMs - binStart) / binWidth));
    surviving += histogram.counts[idx] * (1 - fractionPast);
  }

  return surviving / histogram.total;
}

/**
 * Conditional return probability: P(return within [idle, idle+window] | idle for `idleMs`).
 *
 * Uses the survival function:
 *   P = (S(idleMs + alreadyCoveredMs) - S(idleMs + windowMs)) / S(idleMs)
 *
 * Returns 0 when no observed gaps survive to idleMs.
 */
export function conditionalReturnProbability(
  histogram: InterTurnHistogram,
  idleMs: number,
  windowMs: number,
  alreadyCoveredMs = 0,
): number {
  const sNow = survivalFunction(histogram, idleMs);
  if (sNow <= 0) return 0;
  const sFuture = survivalFunction(histogram, idleMs + windowMs);
  const sAtExpiry =
    alreadyCoveredMs > 0
      ? survivalFunction(histogram, idleMs + alreadyCoveredMs)
      : sNow;
  return Math.max(0, (sAtExpiry - sFuture) / sNow);
}

// ---------------------------------------------------------------------------
// Survival model helpers
// ---------------------------------------------------------------------------

function sessionHistogramForWarming(state: SessionState): InterTurnHistogram {
  const segment = state.warmingTurn?.segment;
  return (
    (segment && state.warmingHistograms?.get(segment)) || createHistogram()
  );
}

/**
 * Blend a session histogram with a global histogram using Bayesian weighting.
 *
 * When the session has few observations, lean on the global prior.
 * As the session accumulates data, its own distribution dominates.
 *
 * effective_count[i] = session_weight × session[i] + global_weight × global[i]
 * where session_weight = min(session.total / PSEUDOCOUNT, 1.0)
 */
export function blendHistograms(
  session: InterTurnHistogram,
  global: InterTurnHistogram,
): InterTurnHistogram {
  const sessionWeight = Math.min(session.total / BLEND_PSEUDOCOUNT, 1.0);
  const globalWeight = 1.0 - sessionWeight;

  const blended = createHistogram();
  for (let i = 0; i < BIN_COUNT; i++) {
    blended.counts[i] =
      sessionWeight * session.counts[i] + globalWeight * global.counts[i];
  }
  blended.total = sessionWeight * session.total + globalWeight * global.total;
  return blended;
}

// ---------------------------------------------------------------------------
// Global histograms (per-project, in-memory)
// ---------------------------------------------------------------------------

/** Global histograms keyed by project_id (UUID). */
const globalHistograms = new Map<string, InterTurnHistogram>();

/**
 * Get the global histogram for a project by its ID.
 *
 * Creates an empty histogram if none exists for the given pid.
 */
export function getGlobalHistogram(pid: string): InterTurnHistogram {
  reconcileProjectMerges();
  const canonical = canonicalProjectId(pid, { committed: true });
  if (!canonical) return createHistogram();
  pid = canonical;
  let hist = globalHistograms.get(pid);
  if (!hist) {
    hist = createHistogram();
    globalHistograms.set(pid, hist);
  }
  return hist;
}

export function blendedHistogramForSession(
  state: SessionState,
): InterTurnHistogram {
  const session = sessionHistogramForWarming(state);
  const global = globalHistogramForWarmingSnapshot(state);
  return global.total > 0 ? blendHistograms(session, global) : session;
}

/** The last finite histogram boundary. A non-return goes in the overflow
 * bin so it stays in the risk set for every modeled warming window. */
export const WARMING_OBSERVATION_HORIZON_MS =
  HISTOGRAM_BINS[HISTOGRAM_BINS.length - 1];

type PendingWarmingObservation = {
  session_id: string;
  project_id: string;
  segment: WarmingSegment;
  replied_at: number;
};

function isHumanWarmingText(text: string): boolean {
  // Only skip complete harness annotations at the start of a block. Each
  // search consumes its closing tag, keeping repeated markup linear.
  const tag = /\s*<(system-reminder|task-notification|local-command-[\w-]+)>/iy;
  let offset = 0;
  while (offset < text.length) {
    tag.lastIndex = offset;
    const match = tag.exec(text);
    if (!match) return text.slice(offset).trim().length > 0;
    const closing = "</" + match[1] + ">";
    const end = text.indexOf(closing, tag.lastIndex);
    if (end < 0) return true;
    offset = end + closing.length;
  }
  return false;
}

function warmingMessageOrigin(
  message: GatewayMessage | undefined,
): "human" | "system" | "tool" {
  if (message?.role !== "user") return "system";
  if (
    message.content.some((block) =>
      block.type === "text"
        ? isHumanWarmingText(block.text)
        : block.type === "opaque" && !block.responsesItem,
    )
  )
    return "human";
  return message.content.some((block) => block.type === "tool_result")
    ? "tool"
    : "system";
}

function writeWarmingGap(
  observation: PendingWarmingObservation,
  gapMs: number,
  now: number,
  count = 1,
): void {
  const { project_id: pid, segment } = observation;
  const database = db();
  const stored = database
    .query(
      "SELECT counts, CAST(total AS TEXT) AS total FROM warmup_histograms WHERE project_id = ? AND time_slot = ?",
    )
    .get(pid, segment) as { counts: string; total: string } | null;
  const counts =
    (stored && decodeWarmupHistogram(stored.counts, stored.total)) ??
    emptyWarmupHistogramCounts();
  counts[binIndex(gapMs)] += BigInt(count);
  const encoded = encodeWarmupHistogram(counts);
  database
    .query(`
    INSERT INTO warmup_histograms (project_id, time_slot, counts, total, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (project_id, time_slot) DO UPDATE SET
      counts = excluded.counts, total = excluded.total, updated_at = excluded.updated_at
  `)
    .run(pid, segment, encoded.counts, encoded.total, now);
}

function recordSessionWarmingGap(
  state: SessionState,
  segment: WarmingSegment,
  gapMs: number,
): void {
  state.warmingHistograms ??= new Map();
  const histogram = state.warmingHistograms.get(segment) ?? createHistogram();
  recordGap(histogram, gapMs);
  state.warmingHistograms.set(segment, histogram);
}

export function beginWarmingTurn(
  state: SessionState,
  messages: readonly GatewayMessage[],
  requestOrder: number,
  requestStartedAt: number,
  noStore: boolean,
  sourcePrefixCount = 0,
): void {
  const previousTurn = state.warmingTurn;
  if (previousTurn && previousTurn.order >= requestOrder) return;
  const origin = warmingMessageOrigin(messages.at(-1));
  if (!state.isSubagent) {
    try {
      const hasPending = db()
        .query(
          "SELECT 1 FROM warmup_pending_observations WHERE session_id = ? AND replied_at <= ?",
        )
        .get(state.sessionID, requestStartedAt);
      const settled =
        hasPending &&
        withSavepoint("observe_warming_return", () => {
          // Consume only an idle period which already began when this request
          // arrived. The first write takes SQLite's write lock before reading
          // or updating the histogram, so retries cannot double-count it.
          const pending = db()
            .query(`
          DELETE FROM warmup_pending_observations
          WHERE session_id = ? AND replied_at <= ?
            AND project_id IN (SELECT id FROM projects WHERE tenant_id = ?)
          RETURNING session_id, project_id, segment, replied_at
        `)
            .get(
              state.sessionID,
              requestStartedAt,
              state.storageTenantId ?? "",
            ) as PendingWarmingObservation | null;
          if (
            !pending ||
            noStore ||
            db()
              .query("SELECT amnesia FROM session_state WHERE session_id = ?")
              .get(state.sessionID)?.amnesia === 1
          )
            return;
          const gapMs =
            origin === "human"
              ? requestStartedAt - pending.replied_at
              : Infinity;
          writeWarmingGap(pending, gapMs, requestStartedAt);
          return { segment: pending.segment, gapMs };
        });
      if (settled)
        recordSessionWarmingGap(state, settled.segment, settled.gapMs);
    } catch (error) {
      log.warn("cache-warmer: failed to record reply gap:", error);
    }
  }
  // Tool-result continuations inherit the initiating request's origin/depth.
  if (origin === "tool" && previousTurn) {
    state.warmingTurn = {
      depth: previousTurn.depth,
      segment: previousTurn.segment,
      lastHumanIndex: previousTurn.lastHumanIndex,
      noStore: noStore || previousTurn.noStore,
      order: requestOrder,
    };
    return;
  }

  // Count human prompts, up to the deepest bucket. Calls made by the model
  // can inflate messageCount without moving the human conversation forward.
  let depth =
    previousTurn?.depth === 4 || sourcePrefixCount > 0
      ? (previousTurn?.depth ?? 0)
      : 0;
  const lastCountedIndex =
    sourcePrefixCount > 0 ? (previousTurn?.lastHumanIndex ?? -1) : -1;
  let lastHumanIndex = lastCountedIndex;
  for (let i = messages.length - 1; i >= 0 && depth < 4; i--) {
    const index = sourcePrefixCount + i;
    if (index <= lastCountedIndex) break;
    if (
      (i === messages.length - 1
        ? origin
        : warmingMessageOrigin(messages[i])) === "human"
    ) {
      depth++;
      lastHumanIndex = Math.max(lastHumanIndex, index);
    }
  }
  depth = Math.max(depth, previousTurn?.depth ?? 0);
  const band = depth <= 1 ? "1" : depth <= 3 ? "2-3" : "4+";
  state.warmingTurn = {
    order: requestOrder,
    depth,
    lastHumanIndex,
    noStore,
    segment:
      origin === "human" ? `return:human:${band}` : `return:system:${band}`,
  };
}

export function finishWarmingTurn(
  state: SessionState,
  requestOrder: number,
  requestStartedAt: number,
  repliedAt: number,
  stopReason: string,
  noStore: boolean,
): void {
  const turn = state.warmingTurn;
  if (!turn || turn.order !== requestOrder) return;
  turn.accepted = { requestedAt: requestStartedAt, repliedAt };
  if (
    stopReason === "tool_use" ||
    state.isSubagent ||
    noStore ||
    turn.noStore ||
    state.amnesia
  )
    return;

  try {
    const pid = withTenant(state.storageTenantId ?? "", () =>
      projectId(state.projectPath),
    );
    if (!pid) return;
    db()
      .query(`
      INSERT INTO warmup_pending_observations (session_id, project_id, segment, replied_at)
      SELECT session_state.session_id, projects.id, ?, ?
      FROM projects
      JOIN session_state_owners ON session_state_owners.tenant_id = projects.tenant_id
      JOIN session_state ON session_state.session_id = session_state_owners.session_id
      WHERE projects.id = ? AND projects.tenant_id = ?
        AND session_state.session_id = ? AND session_state.amnesia = 0
      ON CONFLICT (session_id) DO UPDATE SET
        project_id = excluded.project_id, segment = excluded.segment, replied_at = excluded.replied_at
      WHERE excluded.replied_at > warmup_pending_observations.replied_at
        AND warmup_pending_observations.project_id IN (SELECT id FROM projects WHERE tenant_id = ?)
    `)
      .run(
        turn.segment,
        repliedAt,
        pid,
        state.storageTenantId ?? "",
        state.sessionID,
        state.storageTenantId ?? "",
      );
  } catch (error) {
    log.warn("cache-warmer: failed to open reply observation:", error);
  }
}

export function discardPendingWarmingObservation(state: SessionState): void {
  try {
    db()
      .query(`
        DELETE FROM warmup_pending_observations
        WHERE session_id = ?
          AND project_id IN (SELECT id FROM projects WHERE tenant_id = ?)
      `)
      .run(state.sessionID, state.storageTenantId ?? "");
  } catch (error) {
    log.warn("cache-warmer: failed to discard reply observation:", error);
  }
}

const WARMING_EXPIRY_BATCH_SIZE = 128;

export function expireWarmingObservations(
  now: number,
  sessions: ReadonlyMap<string, SessionState>,
  isActive?: (id: string) => boolean,
): void {
  try {
    const cutoff = now - WARMING_OBSERVATION_HORIZON_MS;
    // This maintenance job is deliberately DB-wide. A pending row points to
    // the original project's UUID and can only write that project's segment.
    const due = db()
      .query(
        "SELECT session_id FROM warmup_pending_observations WHERE replied_at <= ? ORDER BY replied_at LIMIT ?",
      )
      .all(cutoff, WARMING_EXPIRY_BATCH_SIZE) as Array<{ session_id: string }>;
    if (!due.length) return;
    const expired = withSavepoint("expire_warming_observations", () => {
      const result: PendingWarmingObservation[] = [];
      const groups = new Map<
        string,
        { observation: PendingWarmingObservation; count: number }
      >();
      const amnesia = db().query(
        "SELECT amnesia FROM session_state WHERE session_id = ?",
      );
      const consume = db().query(`
        DELETE FROM warmup_pending_observations WHERE session_id = ? AND replied_at <= ?
        RETURNING session_id, project_id, segment, replied_at
      `);
      for (const { session_id: id } of due) {
        if (isActive?.(id)) continue;
        const pending = consume.get(
          id,
          cutoff,
        ) as PendingWarmingObservation | null;
        if (!pending) continue;
        if (amnesia.get(id)?.amnesia === 1) continue;
        const key = warmingHistogramKey(pending.project_id, pending.segment);
        const group = groups.get(key);
        if (group) group.count++;
        else groups.set(key, { observation: pending, count: 1 });
        result.push(pending);
      }
      for (const { observation, count } of groups.values()) {
        writeWarmingGap(observation, Infinity, now, count);
      }
      return result;
    });
    for (const { session_id, segment } of expired) {
      const state = sessions.get(session_id);
      if (state) recordSessionWarmingGap(state, segment, Infinity);
    }
  } catch (error) {
    log.warn("cache-warmer: failed to expire reply observations:", error);
  }
}

/**
 * Compute the corrected cost threshold for a warming decision.
 *
 * Accounts for the fact that a successful warmup sequence costs
 * cache_read twice: once for the keepalive and once when the user
 * returns. Break-even: read / (write - read).
 */
export function costThreshold(
  cacheReadCostPerMTok: number,
  cacheMissCostPerMTok: number,
): number {
  const denominator = cacheMissCostPerMTok - cacheReadCostPerMTok;
  if (denominator <= 0) return 1.0; // degenerate — never warm
  return cacheReadCostPerMTok / denominator;
}

/**
 * Maximum profitable warmup cycles before total warming cost exceeds
 * the savings from avoiding a cache write on user return.
 *
 * maxCycles = floor((write - read) / read)
 */
export function maxProfitableCycles(
  cacheReadCostPerMTok: number,
  cacheMissCostPerMTok: number,
): number {
  if (cacheReadCostPerMTok <= 0) return 0;
  return Math.floor(
    (cacheMissCostPerMTok - cacheReadCostPerMTok) / cacheReadCostPerMTok,
  );
}

// ---------------------------------------------------------------------------
// Cache warming profiles
// ---------------------------------------------------------------------------

/** Provider-agnostic cache warming profile. */
export type CacheWarmingProfile = {
  /** Cache TTL in ms for this session's configuration. */
  ttlMs: number;
  /** Per-MTok cost to read from cache ($). */
  cacheReadCostPerMTok: number;
  /** Per-MTok cost on a full miss (write) ($). */
  cacheMissCostPerMTok: number;
  /** How early before TTL expiry to send the warmup (ms). */
  warmupMarginMs: number;
  /** Prepare the stored body for a warmup request. */
  prepareWarmupBody: (storedBody: string) => string;
  /** Upstream URL to send the warmup to. For Vertex (authMode "vertex") this is
   *  the region BASE host (`https://{region}-aiplatform.googleapis.com`);
   *  executeWarmup rebuilds the per-model `:rawPredict` URL from it. */
  upstreamUrl: string;
  /** Auth/transport mode. Default (undefined) = Anthropic: session credential +
   *  cch re-sign. "vertex" = GCP OAuth2 bearer (ADC), no cch, rawPredict URL. */
  authMode?: "vertex";
};

/**
 * Prepare an Anthropic request body for cache warming.
 *
 * Sets max_tokens to 0 (or 1 for thinking-enabled sessions), disables
 * streaming, and strips fields incompatible with max_tokens:0.
 *
 * The cache key is computed from tokenized prompt content (tools → system
 * → messages), NOT raw JSON bytes. max_tokens, stream, and temperature
 * are not part of the cache key, so changing them doesn't affect cache
 * hit/miss. Confirmed by Anthropic's pre-warming docs.
 */
export function prepareAnthropicWarmupBody(storedBody: string): string {
  const body = JSON.parse(storedBody);
  const hasThinking = "thinking" in body;

  // max_tokens: 0 is the ideal warmup (zero output cost), but it's
  // incompatible with extended thinking. Fall back to max_tokens: 1
  // for thinking-enabled sessions (~$0.000015 output cost, negligible).
  body.max_tokens = hasThinking ? 1 : 0;
  body.stream = false;

  // Strip forced tool_choice (incompatible with max_tokens: 0;
  // also avoids generating a tool call on max_tokens: 1)
  if (body.tool_choice?.type === "tool" || body.tool_choice?.type === "any") {
    delete body.tool_choice;
  }

  // Strip structured output format (incompatible with max_tokens: 0)
  delete body.output_config;

  // Ensure a cache breakpoint is present. NOTE: since the #943 raw-body fix,
  // lastRequestBody stores the RAW as-sent body, which already carries the real
  // turn's FULL multi-breakpoint layout (system[1] stableLtm, tools,
  // conversation) — so ensureCacheBreakpoint is a NO-OP here (it returns early
  // when any breakpoint is present). It remains only as a defensive backstop for
  // the degenerate case of a stored body with zero breakpoints (which would
  // otherwise write NOTHING to the cache), re-adding one on the last block of the
  // last message. Replaying the real breakpoints verbatim is what makes a healthy
  // warmup a 100% refresh.
  ensureCacheBreakpoint(body);

  return JSON.stringify(body);
}

/**
 * Re-attach an ephemeral `cache_control` breakpoint to the last content block
 * of the last message if the body has none. Idempotent: a body that already
 * carries any breakpoint is left untouched.
 */
function ensureCacheBreakpoint(body: {
  messages?: Array<{ content?: unknown }>;
}): void {
  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) return;

  // If any block anywhere already has a breakpoint, do nothing.
  const hasBreakpoint = messages.some(
    (m) =>
      Array.isArray(m?.content) &&
      m.content.some(
        (b: unknown) =>
          typeof b === "object" && b !== null && "cache_control" in b,
      ),
  );
  if (hasBreakpoint) return;

  // Find the last message with an array content holding at least one block.
  for (let i = messages.length - 1; i >= 0; i--) {
    const content = messages[i]?.content;
    if (Array.isArray(content) && content.length > 0) {
      const lastBlock = content[content.length - 1];
      if (typeof lastBlock === "object" && lastBlock !== null) {
        (lastBlock as { cache_control?: unknown }).cache_control = {
          type: "ephemeral",
        };
      }
      return;
    }
  }
}

/**
 * How early before TTL expiry to fire the warmup, scaled by prefix size.
 *
 * The 5m base of 45s is too tight for LARGE multi-block prefixes: a big
 * conversation block sitting against the 5-minute wall can cross its per-block
 * TTL boundary inside the headroom window, so the warmup lands as a partial
 * (head block refreshed, large block rewritten). The headroom needed to clear
 * that boundary is ABSOLUTE (a function of prefix size), not a fraction of the
 * TTL, so we add a size-proportional term capped by an absolute tail
 * (MAX_SIZE_MARGIN_MS).
 *
 * The 1h base of 300s already dwarfs the headroom any realistic prefix needs,
 * so 1h stays flat — only the 5m path scales. `prefixTokens` is the session's
 * last input-token count (state.lastInputTokens); 0 (the default for callers
 * without a session, e.g. unit tests) reproduces the original flat base.
 */
export function computeWarmupMargin(ttlMs: number, prefixTokens = 0): number {
  const base = ttlMs === 3_600_000 ? 300_000 : 45_000;
  // 1h base already covers any prefix's boundary headroom — keep it flat.
  if (ttlMs === 3_600_000) return base;
  // Guard non-finite/negative prefixTokens: a NaN would propagate through the
  // arithmetic to a NaN margin, which silently bypasses BOTH the cooldown and
  // window gates (`x < ttlMs - NaN` is false) → warm on every idle tick.
  const safeTokens = Number.isFinite(prefixTokens)
    ? Math.max(0, prefixTokens)
    : 0;
  const sizeTerm = Math.min(
    safeTokens * MARGIN_PER_TOKEN_MS,
    MAX_SIZE_MARGIN_MS,
  );
  return base + sizeTerm;
}

/**
 * Build an Anthropic warming profile for a given model and TTL.
 *
 * `prefixTokens` (the session's last input-token count) scales the 5m warmup
 * margin so large prefixes fire earlier; see computeWarmupMargin. Defaults to 0
 * (flat base) for callers without a live session.
 */
export function buildAnthropicProfile(
  model: string,
  ttl: "5m" | "1h",
  upstreamBase?: string,
  prefixTokens = 0,
  providerID?: string,
): CacheWarmingProfile {
  const route = resolveUpstreamRoute(model);
  // || (not ??): an empty-string upstreamBase (header-less Anthropic sessions)
  // must coalesce to the model route, not produce a base of "".
  const base = upstreamBase || route?.url || "https://api.anthropic.com";

  // Price from the provider the session is routed to when known (aggregators
  // publish the same bare id at different cache prices); falls back to the flat
  // last-write-wins entry when the provider is unknown/undefined.
  const entry = getModelEntrySyncForProvider(providerID, model);
  const cacheReadCost =
    entry.cost?.cache_read ?? (entry.cost?.input ?? 3) * 0.1;
  // Base cache_write is the 5m TTL price. Anthropic charges 2× for 1h TTL writes.
  const baseCacheWrite =
    entry.cost?.cache_write ?? (entry.cost?.input ?? 3) * 1.25;
  const cacheWriteCost = ttl === "1h" ? baseCacheWrite * 2 : baseCacheWrite;

  const ttlMs = ttl === "1h" ? 3_600_000 : 300_000;
  // Size-aware margin: the 5m base (45s) is too tight for large multi-block
  // prefixes, which can cross a per-block TTL boundary inside the headroom
  // window and land the warmup as a partial. 1h stays flat at 300s. See
  // computeWarmupMargin.
  const warmupMarginMs = computeWarmupMargin(ttlMs, prefixTokens);

  return {
    ttlMs,
    cacheReadCostPerMTok: cacheReadCost,
    cacheMissCostPerMTok: cacheWriteCost,
    warmupMarginMs,
    prepareWarmupBody: prepareAnthropicWarmupBody,
    upstreamUrl: `${base.replace(/\/$/, "")}/v1/messages`,
  };
}

/**
 * Build a warming profile for a Google Vertex AI (Claude) session. Vertex
 * supports Anthropic prompt caching, and warming hits the SESSION's own Vertex
 * host with lore's GCP credentials (the same auth real turns use), so it is
 * safe to warm (unlike foreign anthropic-compat hosts). Pricing reuses the
 * Anthropic profile (Vertex Claude pricing tracks the Anthropic API). The
 * stored `upstreamUrl` is the region base — executeWarmup rebuilds the
 * per-model `:rawPredict` URL and attaches the OAuth2 bearer.
 */
export function buildVertexProfile(
  model: string,
  ttl: "5m" | "1h",
  upstreamBase: string,
  prefixTokens = 0,
): CacheWarmingProfile {
  const region = vertexRegionFromUrl(upstreamBase) ?? "global";
  // Vertex Claude uses Anthropic prompt caching, so it is exposed to the same
  // large-prefix TTL-race partial — thread prefixTokens so the 5m margin scales
  // (computeWarmupMargin), matching the first-party/proxied/bedrock paths.
  const base = buildAnthropicProfile(model, ttl, undefined, prefixTokens);
  return {
    ...base,
    upstreamUrl: `https://${vertexHost(region)}`,
    authMode: "vertex",
    // prepareAnthropicWarmupBody re-adds `stream:false` and (for billing
    // sessions) leaves the body shaped for Anthropic. Vertex rejects a body
    // `stream` field (the URL verb selects streaming) and needs `model` absent
    // + `anthropic_version` present — so run the prepared body back through the
    // canonical Vertex transform. The stored body is already the Vertex body,
    // so this only re-strips the `stream` that prepareWarmupBody re-injected.
    prepareWarmupBody: (storedBody: string) =>
      JSON.stringify(
        toVertexBody(
          JSON.parse(base.prepareWarmupBody(storedBody)) as Record<
            string,
            unknown
          >,
        ),
      ),
  };
}

/**
 * True only for Anthropic's first-party API host. Anthropic-compatible
 * providers (MiniMax `api.minimax.io/anthropic`, Fireworks, Kimi, …) report
 * `protocol:"anthropic"` but do NOT support Anthropic prompt-cache warming and
 * reject the session's foreign key if sent to api.anthropic.com. Cache warming
 * is gated to this host (see resolveProfile).
 */
function isAnthropicFirstPartyHost(url: string): boolean {
  try {
    return new URL(url).host === "api.anthropic.com";
  } catch {
    return false;
  }
}

/**
 * Resolve a warming profile for a session.
 *
 * Returns null if warming is not applicable (unknown provider, warming
 * disabled, or a non-Anthropic-first-party host).
 */
export function resolveProfile(
  model: string | undefined,
  protocol:
    | "anthropic"
    | "openai"
    | "openai-responses"
    | "vertex"
    | "gemini"
    | undefined,
  ttl: "5m" | "1h" | undefined,
  upstreamBase?: string,
  providerID?: string,
  prefixTokens = 0,
): CacheWarmingProfile | null {
  if (!model || !protocol) return null;

  // Google Vertex AI (Claude): supports Anthropic prompt caching. The warmup
  // hits the session's own Vertex host with lore's GCP credentials, so it is
  // always safe to warm (no foreign-key-to-anthropic.com hazard). Detected by
  // the explicit vertex provider id OR a vertex aiplatform host.
  if (protocol === "vertex") {
    const vRoute = resolveUpstreamRoute(model);
    const vHost = upstreamBase || vRoute?.url;
    if (!vHost || !isVertexHost(vHost)) return null;
    return buildVertexProfile(model, ttl ?? "5m", vHost, prefixTokens);
  }

  // Only Anthropic protocol for now — OpenAI has automatic prefix caching with
  // no explicit warming API. (Bedrock rides the anthropic protocol via mantle.)
  if (protocol !== "anthropic") return null;

  // 🔴 Gate on Anthropic IDENTITY, not just the wire protocol. Anthropic-compat
  // providers (MiniMax, Fireworks, Kimi) report protocol:"anthropic" but
  // warming them sends the session's foreign api-key to api.anthropic.com (the
  // buildAnthropicProfile fallback) → 401 "invalid x-api-key" loop, and they
  // don't honor cache_control warming anyway. Accept the session as Anthropic
  // when EITHER:
  //   (a) its explicit providerID is "anthropic" — preserves warming for
  //       Anthropic routed through a proxy (LORE_UPSTREAM_ANTHROPIC / LiteLLM /
  //       Cloudflare AI Gateway), where the host is not api.anthropic.com; OR
  //   (b) the host the warmup would hit IS api.anthropic.com — covers the
  //       header-less flagship case (Claude Code CLI/Desktop send no
  //       x-lore-provider / x-lore-upstream-url, so providerID is undefined and
  //       lastUpstream.url is "").
  // Use || (not ??) so an EMPTY-STRING upstreamBase coalesces to the model route
  // (api.anthropic.com) instead of leaving warmupHost = "" → wrongly skipped.
  const route = resolveUpstreamRoute(model);
  const warmupHost = upstreamBase || route?.url;

  // AWS Bedrock via bedrock-mantle: prompt caching IS supported, so warm it.
  // Unlike MiniMax/Fireworks (foreign anthropic-compat hosts we must NOT warm,
  // because that would send the session key to api.anthropic.com), the mantle
  // warmup hits the SESSION's own mantle host with the SESSION's Bedrock API
  // key — the exact credential the real turns use. The warmup BODY already
  // carries the mantle model id (the conversation path remapped it before it
  // was stored as lastRequestBody), so we pass the CLIENT model id here purely
  // for the models.dev cost lookup (the mantle `anthropic.<model>` id would not
  // resolve to a pricing entry).
  const isBedrockMantle =
    providerID === "bedrock" ||
    providerID === "amazon-bedrock" ||
    (!!warmupHost && isBedrockMantleHost(warmupHost));
  if (isBedrockMantle) {
    return buildAnthropicProfile(
      model,
      ttl ?? "5m",
      upstreamBase,
      prefixTokens,
      providerID,
    );
  }

  const isAnthropic =
    providerID === "anthropic" ||
    (!!warmupHost && isAnthropicFirstPartyHost(warmupHost));
  if (!isAnthropic) return null;

  return buildAnthropicProfile(
    model,
    ttl ?? "5m",
    upstreamBase,
    prefixTokens,
    providerID,
  );
}

/**
 * Resolve a warming profile from a live session's state. Single seam shared by
 * the live warming loop (idle.ts) and the dashboard snapshot so the upstream
 * routing AND the size-aware warmup margin (state.lastInputTokens →
 * computeWarmupMargin) can never diverge between "what we report" and "what we
 * actually warm". Keep both call sites routed through here.
 */
export function resolveProfileForSession(
  state: SessionState,
): CacheWarmingProfile | null {
  return resolveProfile(
    state.lastUpstream?.model,
    state.lastUpstream?.protocol,
    state.resolvedConversationTTL,
    // Pass the session's real upstream URL + providerID so the warmer warms
    // only true-Anthropic sessions (first-party host OR providerID "anthropic",
    // incl. proxied Anthropic) and never sends a compat provider's key to
    // api.anthropic.com (MiniMax 401 loop).
    state.lastUpstream?.url,
    state.lastUpstream?.providerID,
    // Size-aware warmup margin: large prefixes fire earlier so a big
    // conversation block doesn't cross its per-block TTL boundary before the
    // warmup lands (computeWarmupMargin).
    state.lastInputTokens ?? 0,
  );
}

// ---------------------------------------------------------------------------
// Decision function
// ---------------------------------------------------------------------------

function toolWarmupHistory(warmup: WarmupState | undefined): {
  total: number;
  hits: number;
  hitRate: number;
} {
  // Preserve existing lifetime counters and exclude new human-wait samples
  // from the evidence required to fund a separate tool-wait probe.
  const total = (warmup?.totalWarmups ?? 0) - (warmup?.automaticWarmups ?? 0);
  const hits = (warmup?.warmupHits ?? 0) - (warmup?.automaticWarmupHits ?? 0);
  return { total, hits, hitRate: total > 0 ? hits / total : 0 };
}

/**
 * Decide whether to refresh the cache for this session now.
 *
 * For user-wait warming, compare the incremental cost of each refresh to
 * the probability that it preserves a hit for the next human request.
 */
export function shouldWarm(
  state: SessionState,
  profile: CacheWarmingProfile,
  blendedHist: InterTurnHistogram,
  now: number = Date.now(),
  // Runtime warming kill-switch. Defaults to a fresh resolve, but per-session
  // loop callers (idle.ts) pass a value hoisted out of the loop so the KV read
  // for this global flag happens once, not once per session (N+1).
  warmingEnabled: boolean = isWarmingEnabled(),
  readOnly = false,
  decisionDetails?: { strategy: string | null; confident: boolean },
): boolean {
  // Per-bucket kill switch — always respected, even with /lore:warm:keep.
  const bucketKey = warmupBucketKey(state);
  const breakerTripped = readOnly
    ? getCircuitBreakerStatus(bucketKey, now).tripped
    : isCircuitBreakerTripped(bucketKey, now);
  if (breakerTripped) return false;

  // Sub-agent sessions are always exempt — they are too short-lived
  // for warming to be profitable, even with /lore:warm:keep force.
  if (state.isSubagent) return false;

  const cfg = loreConfig();
  // Runtime-settable (env / KV override / config default) so warming can be
  // disabled globally without a restart — see isWarmingEnabled().
  if (!warmingEnabled) return false;

  // No stored body to replay — nothing to warm
  if (!state.cacheAnalytics.lastRequestBody) return false;

  // Explicit operator stops survive the response path's reset of the
  // survival-model `disabled` flag when a user returns to the session.
  if (state.warmup?.userStopped) return false;

  // Prefix-churn gate. While meta-distillation is actively rewriting the
  // distilled prefix (messages[0/1]), a warmup is pure waste: it replays the
  // stored body and refreshes a prefix the very next real turn will REPLACE, so
  // it lands as a partial (reads only the stable system+tools prefix, rewrites
  // everything after). The real turns themselves bust at messages[1] every turn
  // in this regime, so no warmup can help. Suppress warming until real turns stop
  // rewriting the prefix (the EMA decays below the threshold) — then warmups land
  // as clean 100% refreshes. Applies to ALL paths, including forced
  // /lore:warm:keep, since warming a churning prefix never pays off. Independent
  // of the circuit breaker (which trips on uncached WRITES, a lagging signal).
  if (getPrefixChurnRate(state.sessionID) >= PREFIX_CHURN_WARM_BLOCK) {
    log.info(
      `cache-warmer: skip warmup for session=${state.sessionID.slice(0, 16)} — ` +
        `distilled prefix churning (churn=${getPrefixChurnRate(state.sessionID).toFixed(2)} >= ` +
        `${PREFIX_CHURN_WARM_BLOCK}); warmups would land as partials`,
    );
    return false;
  }

  // Emergency-compaction gate. A session at gradient Layer >= 3 is aggressively
  // re-rendering its distilled prefix every turn (the raw window is cut and
  // re-cut), so the stored body a warmup replays no longer matches the cached
  // prefix — the warmup lands as an expensive partial write the next real turn
  // discards. This is a DIRECT read of the session's current compression state,
  // complementing the prefix-churn EMA above, which lags and can dip below its
  // threshold between rewrites (how these sessions slip through). getLastTransformLayer
  // reflects the last genuine turn (warmups don't call transform()); null =
  // never transformed in-process → fail open. Blocks ALL paths (incl.
  // /lore:warm:keep) — an emergency-compacted prefix never warms cleanly.
  const lastLayer = getLastTransformLayer(state.sessionID);
  if (lastLayer !== null && lastLayer >= EMERGENCY_COMPACTION_LAYER) {
    log.info(
      `cache-warmer: skip warmup for session=${state.sessionID.slice(0, 16)} — ` +
        `session under emergency compaction (layer=${lastLayer} >= ${EMERGENCY_COMPACTION_LAYER}); ` +
        `warmups would land as partials`,
    );
    return false;
  }

  const elapsed = now - state.lastRequestTime;
  const { ttlMs, warmupMarginMs, cacheReadCostPerMTok, cacheMissCostPerMTok } =
    profile;
  const forced = state.warmup?.forceKeepWarm === true;
  const toolCallActive = state.lastStopReason === "tool_use";

  // Already warmed recently — prevent double-warming.
  // Cooldown = ttlMs - warmupMarginMs so the next warmup fires while the
  // previous cache is still alive. Using the full ttlMs as cooldown causes
  // each continuation warmup to arrive right as the cache expires, turning
  // every warmup into a cold write (~$1.25 for Opus 200K) instead of a
  // cheap refresh (~$0.10). This was the dominant cost driver: 65 warmups
  // at cold-write pricing = ~$65 vs ~$6.50 with correct timing.
  const cooldownMs = Math.max(ttlMs - warmupMarginMs, 0);
  if (
    state.warmup?.lastWarmupAt &&
    now - state.warmup.lastWarmupAt < cooldownMs
  ) {
    return false;
  }

  if (forced) {
    // /lore:warm:keep mode: skip survival/signal analysis but still respect
    // the break-even cap — warming beyond maxCycles is always unprofitable,
    // even when the user explicitly asked for /lore:warm:keep.
    const maxCycles = maxProfitableCycles(
      cacheReadCostPerMTok,
      cacheMissCostPerMTok,
    );
    const cyclesSpent = state.warmup?.warmupCount ?? 0;
    if (cyclesSpent >= maxCycles) return false;

    // Check we're in the warmup margin of *some* TTL window.
    const intoWindow = elapsed % ttlMs;
    if (intoWindow < ttlMs - warmupMarginMs) return false;
    return true;
  }

  // A failed or interrupted request cannot refresh the previous cached body.
  if (state.warmingTurn && !state.warmingTurn.accepted) return false;
  if (state.warmup?.disabled) return false;

  // --- Tool-call fast path ---
  // When lastStopReason is "tool_use", the agent is executing a tool and
  // WILL return with the result. Bypass survival analysis (return probability
  // is ~1.0) but respect break-even cap, session ROI guard, and a maximum
  // duration to handle agent crashes gracefully.
  if (toolCallActive) {
    // Cap: don't warm indefinitely if the agent crashed mid-tool-call
    if (elapsed > MAX_TOOL_CALL_WARMING_MS) return false;

    // Session-level ROI guard applies even during tool calls
    const { total, hits, hitRate } = toolWarmupHistory(state.warmup);
    if (total >= MIN_WARMUPS_FOR_ROI_CHECK && hitRate < MIN_SESSION_HIT_RATE)
      return false;

    const maxCycles = maxProfitableCycles(
      cacheReadCostPerMTok,
      cacheMissCostPerMTok,
    );
    const cyclesSpent = state.warmup?.warmupCount ?? 0;

    // (Write-efficiency averaging guard removed — superseded by the prefix-churn
    // gate at the top of shouldWarm, which predicts partials from the FREE
    // real-turn prefix-rewrite signal instead of paying a partial warmup to
    // learn. Any residual partial-while-alive is now a circuit-breaker DEFECT,
    // not a tolerated cost.)

    // 🔴 Evidence gate (Bug C): ALWAYS fund the first warmup of a break
    // (cyclesSpent === 0 — the probe that learns if this slow tool returns
    // within TTL), but NEVER fund a second-or-later cycle for a session that
    // has produced zero confirmed hits over its lifetime. This is where the
    // observed waste lived: 66 of 74 zero-hit warmups occurred at <=5 lifetime
    // warmups, below MIN_WARMUPS_FOR_ROI_CHECK, so the hit-rate guard above
    // never engaged. warmupHits is lifetime (durable across breaks), so a
    // session that has ever landed a hit keeps full TOOL_CALL_MAX_CYCLES
    // coverage. cyclesSpent (warmupCount) is per-break (reset on return in
    // pipeline.ts), so the first probe of every new break is always funded.
    if (cyclesSpent >= 1 && hits < TOOL_CALL_MIN_HITS_FOR_CONTINUATION) {
      return false;
    }

    // Tool-call-specific cap: most tools complete in <10min (2 cycles at 5m TTL)
    const effectiveMax = Math.min(maxCycles, TOOL_CALL_MAX_CYCLES);
    if (cyclesSpent >= effectiveMax) return false;

    // Still require some history to have a stored body worth warming
    if (state.messageCount < MIN_TURNS_FOR_TOOL_WARMING * 2) return false;

    // Context too small — absolute savings per hit don't justify risk
    if ((state.lastInputTokens ?? 0) < MIN_INPUT_TOKENS_FOR_WARMING)
      return false;

    // Only warm in the margin window of the current TTL cycle
    const intoWindow = elapsed % ttlMs;
    if (intoWindow < ttlMs - warmupMarginMs) return false;

    return true;
  }

  if ((state.lastInputTokens ?? 0) < MIN_INPUT_TOKENS_FOR_WARMING) return false;

  // User-wait warming only refreshes a live cache. If a poll misses the
  // window, the next request would pay write pricing, not read pricing.
  const { cacheAgeMs, pReturn, threshold } = automaticWarmingInputs(
    state,
    profile,
    blendedHist,
    now,
  );
  if (cacheAgeMs >= ttlMs) return false;

  // Price exactly one refresh. Past warmups are sunk and future refreshes
  // will each be evaluated again if the user is still idle.
  const metaThreshold = cfg.distillation.metaThreshold;
  const workerModelID = getWorkerModel(state.lastUpstream)?.modelID;
  const workerModel = workerModelID
    ? getModelEntrySync(workerModelID)
    : undefined;
  const strategy = evaluateCacheStrategy(
    state.sessionID,
    {
      pReturn,
      expectedCycles: 1,
      expectedFutureTurns: Math.min(
        Math.floor(state.messageCount / 2),
        SHADOW_FUTURE_TURNS_CAP,
      ),
      metaThreshold,
      metaDistillCostPerCall: estimateMetaDistillCostPerCall(
        workerModel,
        metaThreshold,
      ),
    },
    {
      readPerToken: cacheReadCostPerMTok / 1_000_000,
      writePerToken: cacheMissCostPerMTok / 1_000_000,
    },
    now,
    { updateState: !readOnly },
  );
  const inWarmupMargin = cacheAgeMs >= ttlMs - warmupMarginMs;
  if (decisionDetails) {
    decisionDetails.strategy = strategy?.strategy ?? null;
    decisionDetails.confident = strategy?.confident === true;
  }
  if (strategy?.confident && inWarmupMargin && !readOnly) {
    log.info(
      `cache-economics: session=${state.sessionID.slice(0, 16)} ` +
        `strategy=${strategy.strategy} pReturn=${pReturn.toFixed(3)} ` +
        `costs[hold=${strategy.holdWarmCost.toFixed(4)} ` +
        `coolBust=${strategy.coolBustCost.toFixed(4)} ` +
        `coolFull=${strategy.coolFullWriteCost.toFixed(4)}]`,
    );
  }

  return (
    inWarmupMargin &&
    pReturn > threshold &&
    (!strategy?.confident || strategyWantsWarming(strategy.strategy))
  );
}

function automaticWarmingInputs(
  state: SessionState,
  profile: CacheWarmingProfile,
  histogram: InterTurnHistogram,
  now: number,
): { cacheAgeMs: number; pReturn: number; threshold: number } {
  const { ttlMs, cacheReadCostPerMTok, cacheMissCostPerMTok } = profile;
  const lastRefresh = Math.max(
    state.warmingTurn?.accepted?.requestedAt ?? state.lastRequestTime,
    state.warmup?.lastWarmupAt ?? 0,
  );
  const cacheAgeMs = now - lastRefresh;
  const idleMs = Math.max(
    0,
    now -
      (state.warmingTurn?.accepted?.repliedAt ??
        state.lastResponseTime ??
        state.lastRequestTime),
  );
  const remainingCacheMs = Math.max(0, ttlMs - cacheAgeMs);
  return {
    cacheAgeMs,
    // A return before the current cache expires would hit without a refresh.
    pReturn: conditionalReturnProbability(
      histogram,
      idleMs,
      ttlMs,
      remainingCacheMs,
    ),
    threshold: Math.max(
      costThreshold(cacheReadCostPerMTok, cacheMissCostPerMTok),
      loreConfig().cache.warming.minReturnProbability ?? 0,
    ),
  };
}

// ---------------------------------------------------------------------------
// Dashboard snapshot
// ---------------------------------------------------------------------------

/** All data the dashboard needs for one session's warming visualization. */
export type WarmingSnapshot = {
  sessionId: string;
  projectPath: string;
  // State
  messageCount: number;
  idleMs: number;
  consecutiveTextOnlyTurns: number;
  ttl: "5m" | "1h" | undefined;
  // Warmup state
  warmupCount: number;
  totalWarmups: number;
  warmupHits: number;
  lastWarmupAt: number;
  disabled: boolean;
  userStopped: boolean;
  forceKeepWarm: boolean;
  // Survival analysis
  sessionHistogram: InterTurnHistogram;
  globalHistogram: InterTurnHistogram;
  blendedHistogram: InterTurnHistogram;
  sessionWeight: number;
  survivalAtIdle: number;
  pReturns: number;
  warmingPhase: "initial" | "continuation" | "none";
  // Tool-call state
  toolCallActive: boolean;
  // Decision
  shouldWarmNow: boolean;
  notWarmingReason: string | null;
  // Circuit breaker for THIS session's (model, upstream) bucket.
  circuitBreaker: {
    tripped: boolean;
    failures: number;
    maxFailures: number;
    trippedAt: number;
  };
};

/**
 * Compute a read-only snapshot of all warming heuristics for a session.
 *
 * Used by the dashboard to render warming state without importing
 * internal functions. All calls are pure or idempotent (read-only).
 */
export function computeWarmingSnapshot(
  state: SessionState,
  now: number = Date.now(),
  // See shouldWarm(): loop callers (the dashboard pages) pass a hoisted value
  // so the global warming-enabled KV read happens once, not once per session.
  warmingEnabled: boolean = isWarmingEnabled(),
  suppliedGlobalHistogram?: InterTurnHistogram,
): WarmingSnapshot {
  const idleMs = now - state.lastRequestTime;
  const sessionHist = sessionHistogramForWarming(state);
  const globalHist =
    suppliedGlobalHistogram ?? globalHistogramForWarmingSnapshot(state);
  const blendedHist =
    globalHist.total > 0
      ? blendHistograms(sessionHist, globalHist)
      : sessionHist;
  const sessionWeight = Math.min(sessionHist.total / BLEND_PSEUDOCOUNT, 1.0);
  const survivalAtIdle = survivalFunction(
    blendedHist,
    Math.max(0, now - (state.lastResponseTime ?? state.lastRequestTime)),
  );

  const profile = resolveProfileForSession(state);
  const ttlMs = profile?.ttlMs ?? 300_000;
  const warmupMarginMs = profile?.warmupMarginMs ?? 45_000;
  const { cacheAgeMs, pReturn, threshold } = profile
    ? automaticWarmingInputs(state, profile, blendedHist, now)
    : { cacheAgeMs: idleMs, pReturn: 0, threshold: 1 };
  const cyclesSpent = state.warmup?.warmupCount ?? 0;

  // Decision + reason
  const bucketKey = warmupBucketKey(state);
  const circuitBreaker = getCircuitBreakerStatus(bucketKey, now);
  const decisionDetails = { strategy: null as string | null, confident: false };
  const idleSkipReason = state.amnesia
    ? "Session amnesia is enabled"
    : isWarmupInProgress(state.sessionID)
      ? "Warmup already in progress"
      : isWarmupAuthDisabled(state.sessionID)
        ? "Warmup skipped because upstream authentication is unavailable"
        : null;
  const tooFewToolTurns =
    !state.warmup?.forceKeepWarm &&
    !state.warmup?.disabled &&
    state.lastStopReason === "tool_use" &&
    state.messageCount < MIN_TURNS_FOR_TOOL_WARMING * 2;
  const contextTooSmall =
    (state.lastInputTokens ?? 0) < MIN_INPUT_TOKENS_FOR_WARMING;
  const warmNow =
    idleSkipReason === null &&
    !contextTooSmall &&
    profile != null &&
    shouldWarm(
      state,
      profile,
      blendedHist,
      now,
      warmingEnabled,
      true,
      decisionDetails,
    );

  let notWarmingReason: string | null = null;
  if (!warmNow) {
    if (idleSkipReason) {
      notWarmingReason = idleSkipReason;
    } else if (circuitBreaker.tripped) {
      notWarmingReason = "Circuit breaker tripped";
    } else if (state.isSubagent) {
      notWarmingReason = "Sub-agent session (ephemeral)";
    } else if (!warmingEnabled) {
      notWarmingReason = "Warming disabled (config/override)";
    } else if (!state.cacheAnalytics.lastRequestBody) {
      notWarmingReason = "No stored request body";
    } else if (state.warmup?.userStopped) {
      notWarmingReason = "Warming stopped by user";
    } else if (getPrefixChurnRate(state.sessionID) >= PREFIX_CHURN_WARM_BLOCK) {
      notWarmingReason = `Distilled prefix churning (churn=${getPrefixChurnRate(state.sessionID).toFixed(2)} >= ${PREFIX_CHURN_WARM_BLOCK}) — warmups would land as partials`;
    } else if (
      (getLastTransformLayer(state.sessionID) ?? 0) >=
      EMERGENCY_COMPACTION_LAYER
    ) {
      notWarmingReason = `Emergency compaction (layer=${getLastTransformLayer(state.sessionID)} >= ${EMERGENCY_COMPACTION_LAYER}) — prefix re-renders every turn, warmups would land as partials`;
    } else if (!profile) {
      notWarmingReason = "No warming profile (non-Anthropic or unknown model)";
    } else if (tooFewToolTurns) {
      notWarmingReason = "Too few messages for tool-wait warming";
    } else if (contextTooSmall) {
      const tokK = Math.floor((state.lastInputTokens ?? 0) / 1000);
      notWarmingReason = `Context too small (${tokK}k < ${MIN_INPUT_TOKENS_FOR_WARMING / 1000}k tokens)`;
    } else if (state.warmup?.forceKeepWarm) {
      const maxCyc = maxProfitableCycles(
        profile.cacheReadCostPerMTok,
        profile.cacheMissCostPerMTok,
      );
      if (cyclesSpent >= maxCyc) {
        notWarmingReason = `Force-keep: break-even exceeded (${cyclesSpent} >= ${maxCyc} cycles)`;
      } else {
        const intoWindow = idleMs % ttlMs;
        if (intoWindow < ttlMs - warmupMarginMs) {
          notWarmingReason = "Force-keep: not in warmup window yet";
        } else {
          notWarmingReason = "Force-keep: cooldown active";
        }
      }
    } else if (state.warmup?.disabled) {
      notWarmingReason = "Session paused by survival analysis";
    } else if (state.warmingTurn && !state.warmingTurn.accepted) {
      notWarmingReason = "Latest request has no completed response";
    } else if (state.lastStopReason === "tool_use") {
      const { total, hits, hitRate } = toolWarmupHistory(state.warmup);
      if (idleMs > MAX_TOOL_CALL_WARMING_MS) {
        notWarmingReason = `Tool call exceeded max duration (${Math.round(idleMs / 60_000)}min > ${Math.round(MAX_TOOL_CALL_WARMING_MS / 60_000)}min)`;
      } else if (
        total >= MIN_WARMUPS_FOR_ROI_CHECK &&
        hitRate < MIN_SESSION_HIT_RATE
      ) {
        notWarmingReason = `Tool call: session hit rate too low (${(hitRate * 100).toFixed(0)}% < ${(MIN_SESSION_HIT_RATE * 100).toFixed(0)}%)`;
      } else if (
        (state.warmup?.warmupCount ?? 0) >= 1 &&
        hits < TOOL_CALL_MIN_HITS_FOR_CONTINUATION
      ) {
        notWarmingReason =
          "Tool call: no confirmed hits yet (continuation gated after first probe)";
      } else {
        const maxCyc = maxProfitableCycles(
          profile.cacheReadCostPerMTok,
          profile.cacheMissCostPerMTok,
        );
        const effectiveMax = Math.min(maxCyc, TOOL_CALL_MAX_CYCLES);
        if ((state.warmup?.warmupCount ?? 0) >= effectiveMax) {
          notWarmingReason = `Tool call: cycle cap reached (${state.warmup?.warmupCount ?? 0} >= ${effectiveMax})`;
        } else {
          const intoWindow = idleMs % ttlMs;
          notWarmingReason =
            intoWindow < ttlMs - warmupMarginMs
              ? "Tool call: not in warmup window yet"
              : "Tool call: cooldown active";
        }
      }
    } else if (
      state.warmup?.lastWarmupAt &&
      now - state.warmup.lastWarmupAt <
        cooldownFor(state, ttlMs, warmupMarginMs)
    ) {
      notWarmingReason = "Already warmed in this TTL window";
    } else if (cacheAgeMs >= ttlMs) {
      notWarmingReason = "Cache already expired";
    } else if (cacheAgeMs < ttlMs - warmupMarginMs) {
      notWarmingReason = "Cache still fresh";
    } else if (pReturn <= threshold) {
      notWarmingReason = `P(returns) ${(pReturn * 100).toFixed(1)}% <= threshold ${(threshold * 100).toFixed(1)}%`;
    } else if (
      decisionDetails.confident &&
      decisionDetails.strategy === "cool-bust"
    ) {
      notWarmingReason =
        "Cache economics favors cooling and compacting on return";
    } else if (
      decisionDetails.confident &&
      decisionDetails.strategy === "cool-full-write"
    ) {
      notWarmingReason = "Cache economics favors a full cache write on return";
    } else {
      notWarmingReason = "Unknown";
    }
  }

  return {
    sessionId: state.sessionID,
    projectPath: state.projectPath,
    messageCount: state.messageCount,
    idleMs,
    consecutiveTextOnlyTurns: state.consecutiveTextOnlyTurns ?? 0,
    ttl: state.resolvedConversationTTL,
    warmupCount: cyclesSpent,
    totalWarmups: state.warmup?.totalWarmups ?? 0,
    warmupHits: state.warmup?.warmupHits ?? 0,
    lastWarmupAt: state.warmup?.lastWarmupAt ?? 0,
    disabled:
      state.warmup?.disabled === true || state.warmup?.userStopped === true,
    userStopped: state.warmup?.userStopped === true,
    forceKeepWarm: state.warmup?.forceKeepWarm ?? false,
    sessionHistogram: sessionHist,
    globalHistogram: globalHist,
    blendedHistogram: blendedHist,
    sessionWeight,
    survivalAtIdle,
    pReturns: pReturn,
    warmingPhase:
      cyclesSpent > 0 ? "continuation" : idleMs < ttlMs ? "initial" : "none",
    // Tool-call state
    toolCallActive:
      state.lastStopReason === "tool_use" &&
      idleMs <= MAX_TOOL_CALL_WARMING_MS &&
      !state.warmup?.disabled &&
      !state.warmup?.userStopped,
    // Decision
    shouldWarmNow: warmNow,
    notWarmingReason,
    circuitBreaker,
  };
}

/** Cooldown between warmups — must match shouldWarm() logic. */
function cooldownFor(
  _state: SessionState,
  ttlMs: number,
  warmupMarginMs: number,
): number {
  return Math.max(ttlMs - warmupMarginMs, 0);
}

// ---------------------------------------------------------------------------
// Warmup execution
// ---------------------------------------------------------------------------

/**
 * Extract the first user message text from a serialized request body.
 * Used for cch re-signing (version suffix depends on first user chars).
 */
function extractFirstUserText(bodyJson: string): string {
  try {
    const body = JSON.parse(bodyJson);
    if (Array.isArray(body.messages)) {
      for (const msg of body.messages) {
        if (msg.role !== "user") continue;
        if (typeof msg.content === "string") return msg.content;
        if (Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (block.type === "text" && typeof block.text === "string") {
              return block.text;
            }
          }
        }
      }
    }
  } catch {
    // Parse failure — return empty
  }
  return "";
}

/** Accept only real token counts from an upstream usage object. */
function responseTokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

/**
 * Execute a cache warmup for a session.
 *
 * Decompresses the stored request body, patches it for warmup
 * (max_tokens:0, stream:false), re-signs the cch billing header,
 * and sends it to the upstream provider.
 *
 * Returns the result for circuit breaker checking and metrics.
 */
export async function executeWarmup(
  state: SessionState,
  profile: CacheWarmingProfile,
  config: GatewayConfig = loadConfig(),
): Promise<WarmupResult> {
  const noResult: WarmupResult = {
    ok: false,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };

  const { lastRequestBody } = state.cacheAnalytics;
  if (!lastRequestBody) return noResult;

  // Circuit-breaker bucket + cache-liveness, captured BEFORE the warmup state
  // mutation below overwrites lastWarmupAt. cacheRead=0 only indicates a
  // body/prefix mismatch when the cached entry should still be alive; if the
  // last cache write (real turn or prior warmup) is older than the breakpoint
  // TTL, the entry expired and a fresh write is the warmer re-priming a cold
  // cache — expected, not a fault. checkCircuitBreaker ignores those.
  const breakerBucket = warmupBucketKey(state);
  const turn = state.warmingTurn;
  const auto =
    !state.warmup?.forceKeepWarm && state.lastStopReason !== "tool_use";
  const lastCacheTouch = Math.max(
    turn?.accepted?.requestedAt ?? state.lastRequestTime,
    state.warmup?.lastWarmupAt ?? 0,
  );

  // Decompress the stored body
  const storedBody = decompressBody(lastRequestBody);

  // Prepare for warmup (max_tokens:0, strip incompatible fields)
  const warmupBody = profile.prepareWarmupBody(storedBody);

  // Build URL + headers + body. Two modes:
  //  - Vertex (authMode "vertex"): GCP OAuth2 bearer (ADC), a per-model
  //    :rawPredict URL rebuilt from the region base, and NO cch re-sign
  //    (Vertex is not a Claude Code billing endpoint). The session credential
  //    is irrelevant — Vertex auth is the GCP token lore mints.
  //  - Anthropic (default): the session credential + cch re-sign to /v1/messages.
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  let requestUrl: string;
  let signedBody: string;

  if (profile.authMode === "vertex") {
    const model = state.lastUpstream?.model;
    if (!model) return noResult;
    const region = vertexRegionFromUrl(profile.upstreamUrl) ?? "global";
    try {
      // Thread the configured project (LORE_VERTEX_PROJECT / GOOGLE_CLOUD_PROJECT)
      // explicitly: after a restart the warmer can fire before any live
      // conversation turn has populated resolveVertexProject's cache, and ADC's
      // getProjectId() does NOT see LORE_VERTEX_PROJECT — so passing "" here
      // would skip warmups ("no GCP project") for LORE_VERTEX_PROJECT-only users.
      const project = await resolveVertexProject(loadConfig().vertexProject);
      if (!project) {
        log.warn(
          `cache-warmer: no GCP project for vertex session=${state.sessionID.slice(0, 16)}, skipping`,
        );
        recordWorkerFailure(state.sessionID, "cache-warmer", "no-auth");
        return noResult;
      }
      const token = await getVertexAccessToken();
      headers.Authorization = `Bearer ${token}`;
      requestUrl = vertexRawPredictUrl(
        region,
        project,
        toVertexModelId(model),
        false,
      );
    } catch {
      // ADC unavailable / token mint failed — skip this tick rather than
      // crashing the warmer loop. Telemetry must never break the idle loop.
      log.warn(
        `cache-warmer: vertex auth failed for session=${state.sessionID.slice(0, 16)}`,
      );
      recordWorkerFailure(state.sessionID, "cache-warmer", "no-auth");
      return noResult;
    }
    // No cch re-sign for Vertex (no billing header) — send the warmup as-is.
    signedBody = warmupBody;
  } else {
    // Resolve auth for this session — use the provider from lastUpstream
    // to avoid cross-contamination when the session uses multiple providers.
    const cred = resolveAuth(state.sessionID, state.lastUpstream?.providerID);
    if (!cred) {
      log.warn(
        `cache-warmer: no auth for session=${state.sessionID.slice(0, 16)}, skipping`,
      );
      recordWorkerFailure(state.sessionID, "cache-warmer", "no-auth");
      return noResult;
    }
    headers["anthropic-version"] = "2023-06-01";
    Object.assign(headers, authHeaders(cred));

    // Forward anthropic-beta from the last real request so beta-gated body
    // fields (e.g. context_management) are accepted by the upstream API.
    const betaHeader = state.lastUpstream?.headers["anthropic-beta"];
    if (betaHeader) {
      headers["anthropic-beta"] = betaHeader;
    }

    // Re-sign the cch billing header. The cch hash covers the entire
    // serialized body, and we changed max_tokens/stream. The cch is
    // billing verification only — NOT part of the cache key.
    const firstUserText = extractFirstUserText(storedBody);
    signedBody = resignBody(warmupBody, firstUserText);
    requestUrl = profile.upstreamUrl;
  }

  // Apply gateway-admin headers only after the final warmup URL is known. This
  // keeps cache warming under the same exact configured-base policy as normal
  // foreground and compact dispatches.
  applyUpstreamExtraHeaders(
    headers,
    extraHeadersForUpstream(config, requestUrl),
  );

  const cacheLikelyAlive =
    lastCacheTouch > 0 && Date.now() - lastCacheTouch < profile.ttlMs;
  if (auto && turn && (!cacheLikelyAlive || state.warmingTurn !== turn))
    return noResult;

  log.info(
    `cache-warmer: sending warmup for session=${state.sessionID.slice(0, 16)} ` +
      `model=${state.lastUpstream?.model} ttl=${profile.ttlMs / 1000}s`,
  );

  try {
    const response = await upstreamFetch(requestUrl, {
      method: "POST",
      headers,
      body: signedBody,
    });

    if (!response.ok) {
      log.error(
        `cache-warmer: upstream error ${response.status} for ` +
          `session=${state.sessionID.slice(0, 16)}`,
      );
      // On auth error, disable future warmups for this session until
      // a fresh credential arrives. Prevents unbounded 401 spam every 30s.
      if (response.status === 401 || response.status === 403) {
        disableWarmupForAuth(state.sessionID);
        markAuthStale(state.sessionID, state.lastUpstream?.providerID);
        recordWorkerFailure(state.sessionID, "cache-warmer", "auth-rejected");
        log.warn(
          `cache-warmer: auth error ${response.status} — disabling warmup for ` +
            `session=${state.sessionID.slice(0, 16)} until fresh credential`,
        );
      }
      return { ok: false, cacheReadTokens: 0, cacheCreationTokens: 0 };
    }

    // Parse the response to extract usage
    let resp: {
      usage?: {
        cache_read_input_tokens?: unknown;
        cache_creation_input_tokens?: unknown;
        input_tokens?: unknown;
      };
      stop_reason?: string;
    };
    try {
      resp = (await response.json()) as typeof resp;
    } catch {
      log.error(
        `cache-warmer: upstream returned malformed JSON with status ${response.status} for ` +
          `session=${state.sessionID.slice(0, 16)}`,
      );
      return noResult;
    }

    const inputTokens = responseTokenCount(resp.usage?.input_tokens);
    const cacheReadTokens = responseTokenCount(
      resp.usage?.cache_read_input_tokens,
    );
    const cacheCreationTokens = responseTokenCount(
      resp.usage?.cache_creation_input_tokens,
    );
    const totalInput = inputTokens + cacheReadTokens + cacheCreationTokens;

    const result: WarmupResult = {
      ok: true,
      cacheReadTokens,
      cacheCreationTokens,
    };

    // Compute cost estimate for this warmup
    const readCost =
      (cacheReadTokens / 1_000_000) * profile.cacheReadCostPerMTok;
    const writeCost =
      (cacheCreationTokens / 1_000_000) * profile.cacheMissCostPerMTok;
    const warmupCost = readCost + writeCost;
    const costStr = `$${warmupCost.toFixed(4)}`;

    // Log the outcome with full cache statistics
    const sid = state.sessionID.slice(0, 16);
    const hitRate =
      totalInput > 0
        ? `${((cacheReadTokens / totalInput) * 100).toFixed(0)}%`
        : "N/A";
    // Diagnostic: number of cache_control breakpoints in the body we actually
    // sent. Real turns place several (system[1], tools, conversation); a warmup
    // that collapsed to a single end-of-body breakpoint is the body-divergence
    // bug. Correlating this with the outcome confirms the breakpoint-preserving
    // fix (raw stored body) is working: UNCACHED with breakpoints=1 was the bug.
    const breakpoints = (signedBody.match(/"cache_control"/g) ?? []).length;

    // --- Warmup cache-divergence probe (env-gated) ---
    // The decisive tiebreaker between EVICTION and body DIVERGENCE. Hash the
    // warmup body's cacheable segments and compare to the last real turn's
    // (stored by analyzeCacheTurn). Combined with the cacheRead outcome, the
    // classifier below distinguishes: HEAD DIVERGENCE (real body bug), plain
    // read>0 (healthy), EVICTION (identical head yet full miss while the cache
    // should have been live), and expected TTL expiry. A matching head with a
    // differing prefix/tail localizes the divergence to the distilled prefix
    // (meta-distillation) or conversation tail.
    //
    // Hash `warmupBody` (PRE-resign), NOT `signedBody`: `resignBody` recomputes
    // the cch/cc_version billing token over the warmup body (which sets
    // stream=false, max_tokens=0), so its cch differs from the real turn's even
    // though Anthropic strips the cch before hashing its cache key. Hashing the
    // post-resign body would therefore report a false HEAD DIVERGENCE for OAuth
    // sessions. `warmupBody` carries the real turn's cch verbatim
    // (prepareWarmupBody never touches system[0]), so it compares symmetrically
    // against the real turn's stored body that analyzeCacheTurn hashed.
    //
    // Wrapped in try/catch: this is a diagnostic and must never break the warmup
    // path (a throw here would run before cost/circuit-breaker accounting below).
    if (isWarmupProbeEnabled()) {
      try {
        const ca = state.cacheAnalytics;
        const dg = cacheSegmentDigest(warmupBody);
        if (dg) {
          const cmp = (name: string, warm: string, real: string | undefined) =>
            `${name}=${warm}${real ? (warm === real ? "==" : `!=${real}`) : "(no-baseline)"}`;
          const verdict = classifyWarmupProbe({
            hasBaseline: ca.probeHeadSha != null,
            headMatch: dg.headSha === ca.probeHeadSha,
            cacheReadTokens,
            cacheLikelyAlive,
          });
          log.info(
            `warmup-probe: WARMUP session=${sid} ` +
              `${cmp("head", dg.headSha, ca.probeHeadSha)} ` +
              `${cmp("tools", dg.toolsSha, ca.probeToolsSha)} ` +
              `${cmp("prefix", dg.prefixSha, ca.probePrefixSha)} ` +
              `bp=${dg.bpCount} sysBlocks=${dg.systemBlocks} bytes=${dg.bytes} ` +
              `cacheRead=${cacheReadTokens} cacheWrite=${cacheCreationTokens} ` +
              `→ ${verdict}`,
          );
        }
      } catch (err) {
        log.warn(`warmup-probe: probe failed (ignored): ${String(err)}`);
      }
    }

    if (cacheReadTokens > 0 && cacheCreationTokens === 0) {
      log.info(
        `cache-warmer: ✓ refresh session=${sid} ` +
          `input=${totalInput} cacheRead=${cacheReadTokens} hit=${hitRate} breakpoints=${breakpoints} cost=${costStr}`,
      );
    } else if (cacheReadTokens > 0 && cacheCreationTokens > 0) {
      // Partial — read the stable prefix but rewrote the rest. On an idle replay
      // of the stored body this should NOT happen: a healthy warmup is 100%
      // read. A partial while the cache should still be alive is a body-divergence
      // DEFECT (here, almost always the distilled prefix churning) — NOT "fine".
      // checkCircuitBreaker (below) treats it as a failure when cacheLikelyAlive.
      const ageSec =
        lastCacheTouch > 0
          ? Math.round((Date.now() - lastCacheTouch) / 1000)
          : -1;
      const logFn = cacheLikelyAlive ? log.warn : log.info;
      logFn(
        `cache-warmer: ~ partial session=${sid} ` +
          `input=${totalInput} cacheRead=${cacheReadTokens} cacheWrite=${cacheCreationTokens} ` +
          `hit=${hitRate} breakpoints=${breakpoints} cost=${costStr} ` +
          `cacheLikelyAlive=${cacheLikelyAlive} ageSinceCacheTouch=${ageSec}s` +
          (cacheLikelyAlive
            ? " — DIVERGENCE: cache should have been live but warmup only partially " +
              "matched (warmup body ≠ cached prefix; usually distilled-prefix churn)"
            : " — partial expired-cache re-prime (some breakpoints aged out)"),
      );
    } else {
      // cacheRead=0: the warmup wrote a fresh cache instead of refreshing an
      // existing one. `cacheLikelyAlive` (captured before the lastWarmupAt
      // mutation above) is the diagnostic discriminator:
      //   - false → the cached prefix had simply expired; this is a benign cold
      //             re-prime (and is excluded from the circuit breaker).
      //   - true  → the cache SHOULD still have been live, so the warmup body
      //             diverged from what the real turn cached. THIS is the genuine
      //             "divergence" signal worth investigating (issue: warmup body
      //             ≠ cached prefix). If this never fires in practice, every
      //             UNCACHED warmup is pure expiry and there is no body bug.
      const ageSec =
        lastCacheTouch > 0
          ? Math.round((Date.now() - lastCacheTouch) / 1000)
          : -1;
      log.warn(
        `cache-warmer: ✗ UNCACHED session=${sid} ` +
          `input=${totalInput} cacheRead=${cacheReadTokens} cacheWrite=${cacheCreationTokens} ` +
          `cost=${costStr} cacheLikelyAlive=${cacheLikelyAlive} ` +
          `ageSinceCacheTouch=${ageSec}s ttl=${Math.round(profile.ttlMs / 1000)}s ` +
          // Buffer.byteLength gives the UTF-8 byte size actually sent over the
          // wire; signedBody.length would count UTF-16 code units and underreport
          // for multi-byte content (prose/code-heavy bodies — exactly the ones
          // this diagnostic targets).
          `bodyBytes=${Buffer.byteLength(signedBody, "utf8")} breakpoints=${breakpoints}` +
          (cacheLikelyAlive
            ? " — DIVERGENCE: cache should have been live but warmup missed " +
              "(warmup body ≠ cached prefix)"
            : " — expired-cache re-prime (expected)"),
      );
    }

    // Accumulate warmup cost for the session
    const ttl: "5m" | "1h" = profile.ttlMs >= 3_600_000 ? "1h" : "5m";
    recordWarmupCost(
      state.sessionID,
      state.lastUpstream?.model ?? "unknown",
      cacheReadTokens,
      cacheCreationTokens,
      ttl,
      resolveCostAttribution({
        sessionID: state.sessionID,
        providerID: state.lastUpstream?.providerID,
        upstreamURL: state.lastUpstream?.url,
        credential: resolveAuth(
          state.sessionID,
          state.lastUpstream?.providerID,
        ),
        requestHeaders: headers,
      }),
    );

    // Update session warmup state
    if (!state.warmup) {
      state.warmup = {
        lastWarmupAt: 0,
        warmupCount: 0,
        totalWarmups: 0,
        warmupHits: 0,
        disabled: false,
      };
    }
    state.warmup.lastWarmupAt = Date.now();
    state.warmup.warmupCount++;
    state.warmup.totalWarmups = (state.warmup.totalWarmups ?? 0) + 1;
    state.warmup.lastWarmupWasAutomatic = auto;
    if (auto)
      state.warmup.automaticWarmups = (state.warmup.automaticWarmups ?? 0) + 1;
    // 🔴 Record the cache prefix this warmup actually refreshed. Savings on
    // the returning turn MUST be credited against THIS count (the tokens the
    // warmup kept alive), NEVER the returning turn's cacheReadInputTokens —
    // tool-use continuations / breakpoint shifts report a far smaller read,
    // undercounting savings ~10×. The read portion is the kept-alive prefix
    // even on a partial warmup (the written portion was a cost, not a save,
    // already booked via recordWarmupCost). A non-zero value also marks THIS
    // session as the warmup's payer (see WarmupState invariant), gating hit
    // attribution to prevent phantom savings.
    state.warmup.lastWarmupRefreshTokens = cacheReadTokens;

    // Check circuit breaker for this (session, model, upstream) bucket. A
    // partial OR uncached write while the cache should have been alive is a
    // divergence DEFECT (all-or-nothing): it trips the breaker after
    // CIRCUIT_BREAKER_MAX_FAILURES, and only a clean 100% refresh clears it.
    checkCircuitBreaker(result, breakerBucket, cacheLikelyAlive);

    // Clear worker-health failure state on successful warmup.
    recordWorkerSuccess(state.sessionID, "cache-warmer");

    return result;
  } catch {
    // Network errors can include credential-bearing request URLs. Keep the
    // session diagnostic, but never the thrown details.
    log.error(
      `cache-warmer: fetch failed for session=${state.sessionID.slice(0, 16)}`,
    );
    return noResult;
  }
}

/** Outcome of attributing a returning turn against a prior warmup. */
export type WarmupHitOutcome = {
  /** True if this turn was credited as a confirmed warmup hit. */
  hit: boolean;
  /** Cache-read tokens credited for the hit's savings (0 when no hit). */
  creditedTokens: number;
};

/**
 * Decide whether a returning turn is a warmup hit and, if so, how many
 * tokens to credit for savings. Pure + side-effect free so the cost-critical
 * accounting can be unit-tested without standing up the full pipeline.
 *
 * 🔴 Phantom-savings guard (Bug A): a hit/savings is ONLY attributed when
 * THIS session actually fired & paid for the warmup. Proof of payment is
 * `lastWarmupRefreshTokens > 0` (set only by this session's executeWarmup)
 * AND `totalWarmups > 0`. `lastWarmupAt` alone is insufficient — it can ride
 * along in a restored/inherited warmupState blob, booking savings against a
 * session whose warmup cost lives elsewhere.
 *
 * 🔴 Savings token source (Bug B — pro-rata): when a hit is credited, the
 * savings equal the tokens the returning turn ACTUALLY read from the warmed
 * prefix, capped at what the warmup refreshed: `min(cacheReadTokens,
 * refreshTokens)`. Unconditionally crediting the full `refreshTokens`
 * overstated savings whenever the returning turn diverged from the warmed
 * prefix and read only part of it (0 < read < refreshTokens) — e.g. a
 * breakpoint shift or tool-use continuation — which inflated warmup ROI and
 * warped the hit-rate gate for future warming. The cap also prevents crediting
 * the warmup for reads it did not cause (read > refreshTokens from normal turn
 * caching). A full-prefix read (read >= refreshTokens) still credits the full
 * refreshTokens, so the common well-behaved case is unchanged.
 *
 * Residual (unavoidable): Anthropic reports only an AGGREGATE
 * `cache_read_input_tokens`, not a per-breakpoint split. If the returning turn
 * reads a small slice of the warmed prefix PLUS a separately-cached block whose
 * combined total is still <= refreshTokens, the whole read is attributed to the
 * warmup even though part of it wasn't the warmed prefix. The cap only rules out
 * over-attribution when the aggregate read EXCEEDS refreshTokens. This is still
 * strictly closer to reality than crediting the full refreshTokens.
 *
 * 🔴 Read-confirmation guard (Bug C): a hit is ONLY attributed when the
 * returning turn ACTUALLY READ the warmed cache (`cacheReadTokens > 0`). The
 * warmup refreshes the prefix, but the returning turn can pivot to a different
 * context, use a different tool chain, or find the cache evicted by a
 * concurrent path — in which case the API reports zero cache read and there
 * are no savings to book. Without this, warmupHits/creditedTokens inflate and
 * warp the ROI analysis that gates future warming.
 *
 * This function MUTATES `warmup`: it consumes the warmup by zeroing
 * `lastWarmupAt` and `lastWarmupRefreshTokens` (a warmup benefits only the
 * first returning turn) and increments `warmupHits` on a confirmed hit. It
 * also scrubs a stale/inherited `lastWarmupAt` that lacks proof of payment.
 *
 * @param cacheReadTokens The returning turn's `cache_read_input_tokens` (Bug C
 *   gate). Pass 0 — never a positive placeholder — when the turn read nothing.
 */
export function creditWarmupHit(
  warmup: WarmupState | undefined,
  sinceWarmupMs: number,
  ttlMs: number,
  cacheReadTokens: number,
): WarmupHitOutcome {
  const noHit: WarmupHitOutcome = { hit: false, creditedTokens: 0 };
  if (!warmup?.lastWarmupAt) return noHit;

  const refreshTokens = warmup.lastWarmupRefreshTokens ?? 0;
  const automatic = warmup.lastWarmupWasAutomatic;
  const paidForWarmup = (warmup.totalWarmups ?? 0) > 0 && refreshTokens > 0;

  // Consume the warmup unconditionally — it can only benefit the FIRST
  // returning turn, so clear the markers regardless of the outcome.
  warmup.lastWarmupAt = 0;
  warmup.lastWarmupRefreshTokens = 0;
  delete warmup.lastWarmupWasAutomatic;

  // Stale/inherited lastWarmupAt without proof of payment: scrubbed above,
  // record NO hit (prevents phantom savings).
  if (!paidForWarmup) return noHit;

  // Returned too late — cache already expired, no benefit.
  if (sinceWarmupMs >= ttlMs) return noHit;

  // Bug C: the returning turn must have actually READ the warmed cache.
  // A warmup refreshes the prefix, but the returning turn might use a
  // completely different context (pivot to different topic, different tool
  // chain, concurrent session evicted the cache). Without this check the
  // savings are phantom: warmupHits and creditedTokens are booked even when
  // the API reported zero cache read for this turn, inflating the hit rate
  // and warping the ROI analysis.
  if (cacheReadTokens <= 0) return noHit;

  // `warmupHits` is a RETURN-FREQUENCY counter (binary +1), NOT a savings
  // figure — it feeds the session ROI gate `warmupHits/totalWarmups >=
  // MIN_SESSION_HIT_RATE`, which asks "did the user come back and read the
  // warmed cache at all." Binary is correct there: a return is a return. Do NOT
  // confuse this with the SAVINGS, which ARE pro-rata below (Bug B). An earlier
  // note claimed a partial read "credits the full refreshTokens" — that was the
  // pre-#1105 behavior and is no longer true: `creditedTokens` is the capped
  // min() and is the only value booked as savings (pipeline recordWarmupHit).
  warmup.warmupHits++;
  if (automatic)
    warmup.automaticWarmupHits = (warmup.automaticWarmupHits ?? 0) + 1;
  // Pro-rata (Bug B): realized savings = what this turn actually read from the
  // warmed prefix, capped at what the warmup refreshed. See the docstring.
  return {
    hit: true,
    creditedTokens: Math.min(cacheReadTokens, refreshTokens),
  };
}

// ---------------------------------------------------------------------------
// Global histogram persistence (SQLite)
// ---------------------------------------------------------------------------

/** Tracks which project IDs have been modified since last flush. */
const dirtyProjects = new Set<string>();
/** Unflushed observations, tracked separately so project merges can rebase them. */
const dirtyHistograms = new Map<string, InterTurnHistogram>();

function loadPersistedHistogramCounts(pid: string): bigint[] {
  let merged = emptyWarmupHistogramCounts();
  const rows = db()
    .query(
      "SELECT counts, CAST(total AS TEXT) AS total FROM warmup_histograms WHERE project_id = ? AND time_slot NOT LIKE 'return:%'",
    )
    .all(pid) as Array<{ counts: string; total: string }>;
  for (const row of rows) {
    const counts = decodeWarmupHistogram(row.counts, row.total);
    if (counts) merged = mergeWarmupHistogramCounts(merged, counts);
  }
  return merged;
}

function loadPersistedHistogram(pid: string): InterTurnHistogram {
  const merged = normalizeWarmupHistogram(loadPersistedHistogramCounts(pid));
  return merged;
}

function addHistogram(
  target: InterTurnHistogram,
  source: InterTurnHistogram,
): void {
  const merged = normalizeWarmupHistogram(
    mergeWarmupHistogramCounts(
      target.counts.map(BigInt),
      source.counts.map(BigInt),
    ),
  );
  target.counts = merged.counts;
  target.total = merged.total;
}

function reconcileProjectMerges(): void {
  const database = db();
  if (databaseInTransaction(database)) return;
  const pendingByTarget = new Map<string, InterTurnHistogram>();
  const affectedTargets = new Set<string>();
  const trackedIds = new Set([
    ...globalHistograms.keys(),
    ...dirtyHistograms.keys(),
  ]);
  for (const id of trackedIds) {
    const targetId = canonicalProjectId(id);
    if (targetId === id) continue;
    if (!targetId) {
      // Hide a deleted project's stale aggregate immediately, but retain its
      // pending delta until flush confirms the deletion under a write lock.
      globalHistograms.delete(id);
      continue;
    }
    affectedTargets.add(targetId);
    const dirty = dirtyHistograms.get(id);
    if (dirty) {
      const pending = pendingByTarget.get(targetId) ?? createHistogram();
      addHistogram(pending, dirty);
      pendingByTarget.set(targetId, pending);
    }
    globalHistograms.delete(id);
    dirtyHistograms.delete(id);
    dirtyProjects.delete(id);
  }

  for (const targetId of affectedTargets) {
    const persisted = loadPersistedHistogram(targetId);
    const pending = pendingByTarget.get(targetId) ?? createHistogram();
    const targetDirty = dirtyHistograms.get(targetId);
    if (targetDirty) addHistogram(pending, targetDirty);
    addHistogram(persisted, pending);
    globalHistograms.set(targetId, persisted);
    if (pending.total > 0) {
      dirtyHistograms.set(targetId, pending);
      dirtyProjects.add(targetId);
    }
  }
}

/**
 * Load persisted global histograms for a project from SQLite.
 *
 * Called once per project on first access. Populates the in-memory
 * globalHistograms map so survival analysis has data immediately after
 * a gateway restart.
 *
 * Returns the resolved project_id (UUID) so callers can reuse it
 * without a redundant `projectId()` query, or `undefined` if the
 * project is not yet in the DB.
 *
 * Backward compatibility: if the DB contains old time-slot-segmented rows
 * (work/evening/night), they are merged by summing bin counts into a single
 * histogram. New data is written under the "all" time_slot key.
 */
export function loadGlobalHistograms(projectPath: string): string | undefined {
  reconcileProjectMerges();
  if (databaseInTransaction(db())) return undefined;
  const resolvedPid = projectId(projectPath);
  if (!resolvedPid) return undefined; // project not yet in DB — nothing to load
  const pid = canonicalProjectId(resolvedPid);
  if (!pid) return undefined;

  if (globalHistograms.has(pid)) return pid; // already loaded

  let merged = createHistogram();
  try {
    merged = loadPersistedHistogram(pid);

    log.info(
      `cache-warmer: loaded global histogram for project=${projectPath.slice(-30)} ` +
        `(${merged.total} observations)`,
    );
  } catch (e) {
    log.warn("cache-warmer: failed to load global histograms:", e);
  }

  globalHistograms.set(pid, merged);
  return pid;
}

/**
 * Flush dirty global histograms to SQLite.
 *
 * Designed to be called periodically (e.g. every 60s from the idle
 * scheduler) rather than on every recordGap call, to avoid write
 * amplification on a hot path.
 *
 * Writes a single row per project under time_slot="all". Old slot-segmented
 * rows (work/evening/night) are deleted on first flush to avoid double-counting
 * on the next load.
 */
export function flushGlobalHistograms(): void {
  reconcileProjectMerges();
  if (dirtyProjects.size === 0) return;

  const d = db();
  const now = Date.now();

  const projectsToFlush = Array.from(dirtyProjects);
  for (const pid of projectsToFlush) {
    const pending = dirtyHistograms.get(pid);
    if (!pending) {
      dirtyHistograms.delete(pid);
      dirtyProjects.delete(pid);
      continue;
    }

    try {
      // Atomic: delete old slot rows + upsert the unified "all" row.
      // Without the transaction, a crash between DELETE and INSERT
      // would lose all histogram data for this project.
      d.exec("BEGIN IMMEDIATE");
      let resolvedPid: string | undefined;
      let hist: InterTurnHistogram | undefined;
      try {
        // Re-read after taking the write lock, then apply only observations
        // buffered by this process. This prevents stale cache state from
        // overwriting a merge or another gateway's committed history.
        resolvedPid = canonicalProjectId(pid);
        if (resolvedPid) {
          const exact = mergeWarmupHistogramCounts(
            loadPersistedHistogramCounts(resolvedPid),
            pending.counts.map(BigInt),
          );
          const encoded = encodeWarmupHistogram(exact);
          hist = normalizeWarmupHistogram(encoded.weights);
          // Delete old slot-segmented rows (backward compat cleanup)
          d.query(
            "DELETE FROM warmup_histograms WHERE project_id = ? AND time_slot != 'all' AND time_slot NOT LIKE 'return:%'",
          ).run(resolvedPid);

          d.query(
            `INSERT INTO warmup_histograms (project_id, time_slot, counts, total, updated_at)
             VALUES (?, 'all', ?, ?, ?)
             ON CONFLICT(project_id, time_slot) DO UPDATE SET
               counts = excluded.counts,
               total = excluded.total,
               updated_at = excluded.updated_at`,
          ).run(resolvedPid, encoded.counts, encoded.total, now);
        }
        d.exec("COMMIT");
        if (resolvedPid && hist) {
          if (resolvedPid !== pid) globalHistograms.delete(pid);
          globalHistograms.set(resolvedPid, hist);
        } else {
          globalHistograms.delete(pid);
        }
        dirtyHistograms.delete(pid);
        dirtyProjects.delete(pid);
      } catch (e) {
        d.exec("ROLLBACK");
        throw e;
      }
    } catch (e) {
      log.warn(`cache-warmer: failed to flush histogram:`, e);
    }
  }
}

/**
 * Record an inter-turn gap in a global histogram, with dirty tracking.
 *
 * Wraps the base `recordGap` to also mark the histogram for periodic
 * SQLite flush.
 */
export function recordGlobalGap(projectPath: string, gapMs: number): void {
  const pid = loadGlobalHistograms(projectPath); // ensure loaded; resolves pid
  if (!pid) return; // project not yet in DB — skip
  const hist = getGlobalHistogram(pid);
  recordGap(hist, gapMs);
  const dirty = dirtyHistograms.get(pid) ?? createHistogram();
  recordGap(dirty, gapMs);
  dirtyHistograms.set(pid, dirty);
  dirtyProjects.add(pid);
}

// ---------------------------------------------------------------------------
// Dashboard helpers
// ---------------------------------------------------------------------------

/**
 * Read-only snapshot of persisted and pending global histograms, keyed by the
 * canonical project_id. This avoids loading or reconciling the process cache
 * and includes history even before an active session touches a project after
 * restart.
 */
export function getGlobalHistogramsSnapshot(): ReadonlyMap<
  string,
  InterTurnHistogram
> {
  const snapshot = new Map<string, InterTurnHistogram>();
  const database = db();
  if (databaseInTransaction(database)) {
    // The DB connection can see writes that an outer transaction may still
    // roll back. Use only the last process snapshot in that case.
    for (const [pid, histogram] of globalHistograms) {
      snapshot.set(pid, {
        counts: [...histogram.counts],
        total: histogram.total,
      });
    }
    return snapshot;
  }

  const exactCountsByProject = new Map<string, bigint[]>();
  const rows = database
    .query(
      "SELECT project_id, counts, CAST(total AS TEXT) AS total FROM warmup_histograms",
    )
    .all() as Array<{ project_id: string; counts: string; total: string }>;
  for (const row of rows) {
    const pid = canonicalProjectId(row.project_id, { committed: true });
    if (!pid) continue;
    const decoded = decodeWarmupHistogram(row.counts, row.total);
    if (!decoded) continue;
    const current =
      exactCountsByProject.get(pid) ?? emptyWarmupHistogramCounts();
    exactCountsByProject.set(pid, mergeWarmupHistogramCounts(current, decoded));
  }

  // Dirty histograms contain observations since the persisted base was
  // loaded. Rebase them onto the canonical ID without changing dirty maps.
  for (const [sourceId, dirty] of dirtyHistograms) {
    const pid = canonicalProjectId(sourceId, { committed: true });
    if (!pid) continue;
    const current =
      exactCountsByProject.get(pid) ?? emptyWarmupHistogramCounts();
    const dirtyCounts = dirty.counts.map(BigInt);
    exactCountsByProject.set(
      pid,
      mergeWarmupHistogramCounts(current, dirtyCounts),
    );
  }

  for (const [pid, counts] of exactCountsByProject) {
    snapshot.set(pid, normalizeWarmupHistogram(counts));
  }
  return snapshot;
}

function warmingHistogramKey(pid: string, segment: string): string {
  return pid + "\x1f" + segment;
}

export function getSegmentedWarmingHistogramsSnapshot(): ReadonlyMap<
  string,
  InterTurnHistogram
> {
  const snapshot = new Map<string, InterTurnHistogram>();
  const rows = db()
    .query(`
    SELECT project_id, time_slot, counts, CAST(total AS TEXT) AS total
    FROM warmup_histograms JOIN projects ON projects.id = project_id
    WHERE tenant_id = ? AND time_slot LIKE 'return:%'
  `)
    .all(currentTenantId()) as Array<{
    project_id: string;
    time_slot: string;
    counts: string;
    total: string;
  }>;
  for (const row of rows) {
    const counts = decodeWarmupHistogram(row.counts, row.total);
    if (counts)
      snapshot.set(
        warmingHistogramKey(row.project_id, row.time_slot),
        normalizeWarmupHistogram(counts),
      );
  }
  return snapshot;
}

export function globalHistogramForWarmingSnapshot(
  state: SessionState,
  snapshot?: ReadonlyMap<string, InterTurnHistogram>,
): InterTurnHistogram {
  const segment = state.warmingTurn?.segment;
  if (!segment) return createHistogram();
  const tenant = state.storageTenantId ?? "";
  const supplied = currentTenantId() === tenant ? snapshot : undefined;
  return withTenant(tenant, () => {
    const pid = projectId(state.projectPath);
    if (!pid) return createHistogram();
    if (supplied)
      return (
        supplied.get(warmingHistogramKey(pid, segment)) ?? createHistogram()
      );
    const row = db()
      .query(
        "SELECT counts, CAST(total AS TEXT) AS total FROM warmup_histograms WHERE project_id = ? AND time_slot = ?",
      )
      .get(pid, segment) as { counts: string; total: string } | null;
    const counts = row && decodeWarmupHistogram(row.counts, row.total);
    return counts ? normalizeWarmupHistogram(counts) : createHistogram();
  });
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * @internal Drop in-memory breaker state and force the next access to re-read
 * from the DB (exercises ensureCircuitBreakersLoaded, incl. legacy migration
 * and on-load decay). Tests seed the KV directly, then call this.
 */
export function _forceReloadForTest(): void {
  circuitBreakers.clear();
  circuitBreakersLoaded = false;
  circuitBreakerCleanupPending = false;
}

/** @internal Reset module state for tests. */
export function _resetForTest(): void {
  circuitBreakers.clear();
  circuitBreakersLoaded = true; // Mark as loaded so it doesn't re-read stale DB state
  circuitBreakerCleanupPending = false;
  try {
    setKV(CB_KV_KEY, JSON.stringify({ version: 2, buckets: {} }));
  } catch {
    /* DB may not be available in all test contexts */
  }
  globalHistograms.clear();
  dirtyProjects.clear();
  dirtyHistograms.clear();
  authDisabledSessions.clear();
  warmingSessionsInProgress.clear();
}
