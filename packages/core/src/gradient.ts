import type { LorePart, LoreMessageWithParts } from "./types";
import { isTextPart, isReasoningPart, isToolPart } from "./types";
import {
  db,
  ensureProject,
  loadForceMinLayer,
  saveForceMinLayer,
  saveSessionTracking,
  loadSessionTracking,
} from "./db";
import {
  type CacheEconomicsResult,
  decideCacheStrategy,
} from "./cache-economics";
import { config } from "./config";
import { formatDistillations } from "./prompt";
import { normalize } from "./markdown";
import * as log from "./log";

type MessageWithParts = LoreMessageWithParts;

// Token estimate: ~3 chars per token. Validated against real API data across
// 200+ turn-pairs: chars/3 gives ~1.68x ratio (actual/estimate), best among
// heuristics tested. The gap is overhead (system prompt, tool definitions,
// conversation structure) which calibratedOverhead captures via EMA.
function estimate(text: string): number {
  return Math.ceil(text.length / 3);
}

function estimateParts(parts: LorePart[]): number {
  let total = 0;
  for (const part of parts) {
    if (isTextPart(part)) total += estimate(part.text);
    else if (isReasoningPart(part) && part.text) total += estimate(part.text);
    else if (isToolPart(part) && part.state.status === "completed")
      total += estimate(part.state.output) + estimate(part.tool) + 50;
    else if (isToolPart(part) && part.state.status === "error")
      total += estimate(part.state.error) + estimate(part.tool) + 50;
    else total += 20; // metadata overhead for other part types
  }
  return total;
}

function estimateMessage(msg: MessageWithParts): number {
  return estimateParts(msg.parts) + 20; // role/metadata overhead
}

// Cached model context limit — set by system transform hook, used by message transform
let contextLimit = 200_000; // sensible default
let outputReserved = 32_000;

// ---------------------------------------------------------------------------
// Tier-based context management
//
// Three quality tiers based on empirical model effectiveness:
//   Tier 1: 0 – 200K tokens (best quality, preferred operating range)
//   Tier 2: 200K – 500K tokens (acceptable quality)
//   Tier 3: 500K – model context limit (degraded, compress when economical)
//
// At each tier boundary, a per-turn economic comparison decides whether to
// compress (bust the cache) or continue growing:
//   bustCost    = compressedSize × cacheWriteCostPerToken
//   continueCost = currentSize   × cacheReadCostPerToken
// If bustCost ≥ threshold × continueCost, don't compress — reads are cheap.
//
// Rolling bust detection: once SUSTAINED_BUST_THRESHOLD consecutive turns bust
// the cache, stop trying to compress — something structural is causing busts,
// and compression just adds cost on top.
// ---------------------------------------------------------------------------

/** Tier boundary tokens. Configurable for testing. */
const TIER_BOUNDARIES = [200_000, 500_000] as const;

/** Cache pricing per token (USD). Set by host adapter via setCachePricing(). */
let cacheWriteCostPerToken = 0;
let cacheReadCostPerToken = 0;

/**
 * Set cache pricing for the current model. Called by the host adapter after
 * looking up model cost data. Required for tier-based bust-vs-continue
 * decisions. When not set (both 0), tier decisions fall back to conservative
 * defaults: do NOT compress (preserve the cache).
 */
export function setCachePricing(writeCost: number, readCost: number) {
  cacheWriteCostPerToken = Math.max(0, writeCost);
  cacheReadCostPerToken = Math.max(0, readCost);
}

/** Returns current pricing (for tests). */
export function getCachePricing(): { write: number; read: number } {
  return { write: cacheWriteCostPerToken, read: cacheReadCostPerToken };
}

// Cost-aware layer-0 token cap. When > 0, the layer-0 passthrough gate uses
// min(maxInput, maxLayer0Tokens) instead of maxInput alone. Derived from the
// model's cache-read cost: cap = targetCostPerTurn / costPerToken. This prevents
// expensive models from sending huge contexts at layer 0, where cache-read costs
// compound linearly across turns. Set to 0 to disable (use full context).
let maxLayer0Tokens = 0;

const MIN_LAYER0_FLOOR = 40_000;

/** Quantization step for the LTM token budget (getLtmBudget). The budget is
 *  derived from `usable`, which wobbles every turn via the per-turn overhead
 *  EMA; snapping it to this step keeps the budget — and therefore the
 *  ltm.forSession() greedy entry-packing boundary — stable across normal
 *  wobble, so the selected entry set (and thus the pinned system[2] block) only
 *  changes when knowledge genuinely changes. Without this, the lowest-ranked
 *  pinned entry drops/re-enters as the budget drifts, churning the set and
 *  appending a durable prompt-delta into the cached prefix every turn (a cache
 *  bust). Sized to absorb typical per-turn overhead drift on high-context
 *  models. */
const LTM_BUDGET_STEP = 8_000;

/** Consecutive zero-cache-write turns before treating the session as free-write. */
const NO_CACHE_WRITE_THRESHOLD = 3;

/** Layer-0 ceiling fraction for free-write sessions.
 *  65% of maxInput ≈ 109k for 200k context → ~59k headroom for tool-heavy turns. */
const FREE_WRITE_LAYER0_FRACTION = 0.65;

/**
 * On uncalibrated turns, multiply the chars/3 estimate to approximate the real
 * token count. chars/3 undercounts by ~1.68x on real data, but the overhead EMA
 * captures most of the gap; 1.5 provides a safe margin. Module-scoped so the
 * layer-0 sizing helper (and isLargeColdStart) share one definition with the
 * transform path.
 */
export const UNCALIBRATED_SAFETY = 1.5;

/**
 * True when the session's upstream has reported zero cache_creation_input_tokens
 * for at least {@link NO_CACHE_WRITE_THRESHOLD} consecutive turns.  Covers both
 * free-write-cache providers (e.g. MiniMax passive caching) and non-caching
 * providers.  Self-correcting: any turn with non-zero cache writes resets
 * the counter.
 *
 * Note: a fully cache-warmed Anthropic session could theoretically trigger this
 * if the prompt stays byte-identical for 3+ turns, but that's rare in practice
 * (LTM injection and new messages almost always cause cache writes).
 *
 * Uses Map.get() to avoid creating phantom SessionState entries — same pattern
 * as {@link getConsecutiveBusts}.
 */
export function isFreeWriteSession(sessionID: string): boolean {
  return (
    (sessionStates.get(sessionID)?.zeroCacheWriteTurns ?? 0) >=
    NO_CACHE_WRITE_THRESHOLD
  );
}

/** Consecutive-bust count at/above which a session is in a "sustained-bust
 *  regime": the prompt cache is being rewritten nearly every turn, so the
 *  "continue" path is paying cache *write* cost — not the cheap read cost the
 *  tier gate normally assumes.
 *
 *  Kept low (2): at large context windows a single full cache bust rewrites
 *  hundreds of thousands of tokens at ~12.5× the read price, so even two
 *  consecutive full busts is already too expensive to keep paying. A low
 *  threshold makes shouldCompress() reprice "continue" at the write rate
 *  sooner (compressing earlier instead of letting the context grow). */
const SUSTAINED_BUST_THRESHOLD = 2;

/** Number of a newly-tracked session's first in-process transforms during which
 *  bust spirals are treated as expected cold-start rewrites, not alerts (#797).
 *
 *  When Lore first tracks a large conversation in-process the opening turns
 *  inherently rewrite the body — turn-1 cold write, turn-2 LTM injection,
 *  turn-3 layer 0→1 transition — and each counts as a consecutive cache bust.
 *  The first cold-start episode within this window emits a low-severity Sentry
 *  breadcrumb (informational); past the window, sustained busts fire a
 *  high-severity Sentry alert (one per spiral episode, debounced, cleared on
 *  recovery). The economic `consecutiveBusts` counter (which drives
 *  compression) is left untouched. Kept at 3 to span the documented
 *  cold-start sequence. Like `consecutiveBusts`, the per-session
 *  `transformCount` that drives this is NOT restored from the DB — a resumed/
 *  restarted session re-enters the grace, which is harmless (it is already
 *  calibrated and does not cold-start bust). */
export const COLD_START_GRACE_TURNS = 3;

/** Categorical cause of a cache bust. Defined in core (rather than gateway) so
 *  `recordCacheUsage` can discriminate non-user-driven busts (e.g. meta-
 *  distillation prefix rewrites) from genuine user-context growth without
 *  creating a circular gateway→core import. Gateway's own categorization
 *  (`categorizeBust` in `cache-analytics.ts`) assigns one of these values and
 *  threads it into `recordCacheUsage`. */
export type CacheBustCause =
  | "first-turn" // session's first request (unavoidable)
  | "system-host-change" // divergence in system[0]: agent-owned host prompt
  | "system-ltm-change" // divergence in system[1]/[2]: lore's own LTM blocks
  | "tools-change" // tool definitions changed
  | "prefix-rewrite" // distilled prefix content changed (meta-distillation)
  | "window-shift" // raw window eviction changed message positions
  | "idle-resume" // first turn after idle detection (cold cache)
  | "incremental" // normal append (cache hit, write only new tail)
  | "unknown"; // unclassified

/**
 * Decide whether compression is economical at a tier boundary.
 *
 * The core comparison is bustCost (write the compressed context once) vs
 * continueCost (keep sending the full context each turn). Normally "continue"
 * is a cheap cache *read*, so growing the context is fine. But when the session
 * is in a sustained-bust regime (`consecutiveBusts >= SUSTAINED_BUST_THRESHOLD`),
 * the full context is being *written* every turn anyway — so "continue" costs
 * write, not read. In that regime we price continueCost at the write rate,
 * which makes compression economical precisely when it's needed (growth-driven
 * busts), instead of refusing to compress and letting the context grow
 * unbounded.
 *
 * @param currentTokens    - expected input tokens if we stay at the current layer
 * @param compressedTokens - expected tokens after compression
 * @param consecutiveBusts - how many turns in a row we've busted the cache
 * @param opts.threshold   - bust cost must be < threshold × continue cost (default 0.85)
 * @param opts.freeWrite   - when true, compression is free (no cache write cost)
 * @returns true if compression is worth it
 */
export function shouldCompress(
  currentTokens: number,
  compressedTokens: number,
  consecutiveBusts: number,
  opts?: { threshold?: number; freeWrite?: boolean },
): boolean {
  const { threshold = 0.85, freeWrite = false } = opts ?? {};

  // Free-write cache (or no cache): compression never incurs a write cost.
  // Always compress at tier boundaries — there's no economic downside — EXCEPT
  // after a sustained run of busts, where repeated free compression that keeps
  // overflowing is just churn (compress→overflow loop). This guard applies to
  // free-write sessions only; paid-cache sessions are handled by the
  // write-cost repricing below (Fix C).
  if (freeWrite) {
    return consecutiveBusts < SUSTAINED_BUST_THRESHOLD;
  }

  // If no pricing data, fall back to conservative: do NOT compress.
  // Compression busts the cache, which is expensive. Without pricing data
  // we can't prove it's worthwhile, so err on the side of keeping the cache.
  if (cacheWriteCostPerToken <= 0 || cacheReadCostPerToken <= 0) return false;

  const sustainedBust = consecutiveBusts >= SUSTAINED_BUST_THRESHOLD;

  const bustCost = compressedTokens * cacheWriteCostPerToken;
  // In a sustained-bust regime the "continue" path is paying cache *write*
  // cost on the whole context every turn, not the cheap read cost. Price it
  // accordingly so the gate reflects reality. Otherwise use the read rate.
  const continuePerToken = sustainedBust
    ? cacheWriteCostPerToken
    : cacheReadCostPerToken;
  const continueCost = currentTokens * continuePerToken;

  // Compress only if the bust cost is meaningfully less than continuing.
  // Note: we deliberately do NOT short-circuit to "never compress" on a high
  // bust count anymore. Structural system[2] busts (the historical cause of
  // runaway bust counts) are eliminated by the reorder-tolerant LTM pin, so a
  // sustained bust now indicates raw-window growth — exactly the case where
  // compressing (writing once) is cheaper than continuing to rewrite the whole
  // grown context every turn.
  return bustCost < threshold * continueCost;
}

/**
 * Determine which tier the given token count falls into.
 * Returns 0, 1, or 2 corresponding to the tier index.
 */
export function getTier(tokens: number): number {
  if (tokens <= TIER_BOUNDARIES[0]) return 0;
  if (tokens <= TIER_BOUNDARIES[1]) return 1;
  return 2;
}

/**
 * Record cache usage from an API response. Tracks consecutive busts for
 * the rolling bust detection used by shouldCompress().
 *
 * A "bust" is when cache_write > 50% of total input tokens.
 *
 * @param cacheWrite  - cache_creation_input_tokens from the API response
 * @param cacheRead   - cache_read_input_tokens from the API response
 * @param inputTokens - input_tokens from the API response (uncached portion only —
 *                      Anthropic's input_tokens excludes both cache reads and writes)
 * @param sessionID   - session that produced this response
 * @param isIdleResume  - true when the upstream turn is the first one after an
 *                        idle gap past the cache TTL; re-warms are expected
 *                        cold-cache writes, not sustained growth
 * @param bustCause     - categorical cause of the bust (when the gateway has
 *                        computed it). `prefix-rewrite` busts are exempted from
 *                        the counter because they are self-inflicted by Lore's
 *                        own meta-distillation — they don't reflect user-context
 *                        growth. `undefined` falls through to the legacy
 *                        counter behavior (treat as a user-driven bust).
 */
export function recordCacheUsage(
  cacheWrite: number,
  cacheRead: number,
  inputTokens: number,
  sessionID?: string,
  isIdleResume = false,
  bustCause?: CacheBustCause,
): void {
  if (!sessionID) return;
  const state = getSessionState(sessionID);

  // Total = cacheWrite + cacheRead + uncached input. Anthropic's input_tokens
  // field is only the uncached portion, NOT the total — using it alone as the
  // denominator makes every cached turn look like a bust (e.g. 1000/3 >> 0.5).
  const total = cacheWrite + cacheRead + inputTokens;
  if (total > 0) {
    const bustRatio = cacheWrite / total;
    const prev = state.consecutiveBusts;
    if (bustRatio > 0.5) {
      // Two classes of bust are NOT counted toward consecutiveBusts:
      //
      // (a) Idle-resume re-warms: expected cold-cache writes when the user
      //     pauses longer than the conversation cache TTL. Counting these
      //     produced false bust-spiral alerts on bursty sessions whose
      //     turns are spaced beyond the TTL — every threshold-crossing bust
      //     in the ses_14b9bf3d… incident followed an 11m–2h idle gap past
      //     the 5m TTL. HOLD the counter on an idle resume: neither advance
      //     toward the threshold nor erase a genuine prior run (a real
      //     warm-window bust that preceded the idle is still real). A
      //     genuine cache HIT (ratio <= 0.5) below still resets, even on an
      //     idle resume.
      //
      // (b) Lore-internal prefix rewrites (`prefix-rewrite`): meta-
      //     distillation consolidates gen-0 segments and rewrites the
      //     synthetic distilled prefix (messages[0/1]) on the next turn.
      //     That's a real prompt-cache bust, but the cause is Lore's own
      //     distillation pipeline — it does NOT reflect user-context growth.
      //     Counting it produced the false bust-spiral alert on opencode
      //     session ses_10f932a26ffeFBKO9ZsjycCCna (Lore session
      //     0XrHNdlsWwgVkX4MH, 2026-06-22): context was bounded at ~130K
      //     tokens (well under the 200K layer-0 cap), but meta-distillation
      //     firing under bust pressure rewrote the prefix every few turns,
      //     accumulating 2-3 consecutive busts and triggering the alert.
      //     Adding the bust-cause discriminator (this parameter) lets the
      //     counter recognize these self-inflicted busts the same way it
      //     recognizes idle-resume ones.
      const isNonUserBust = isIdleResume || bustCause === "prefix-rewrite";
      if (!isNonUserBust) state.consecutiveBusts++;
    } else {
      state.consecutiveBusts = 0;
    }
    if (state.consecutiveBusts !== prev) {
      log.info(
        `bust-tracker: session=${sessionID.slice(0, 16)} ratio=${bustRatio.toFixed(3)}` +
          ` (write=${cacheWrite} read=${cacheRead} uncached=${inputTokens})` +
          ` busts=${prev}→${state.consecutiveBusts}` +
          (bustCause ? ` cause=${bustCause}` : ""),
      );
    } else if (isIdleResume && bustRatio > 0.5) {
      log.info(
        `bust-tracker: session=${sessionID.slice(0, 16)} idle-resume re-warm` +
          ` ratio=${bustRatio.toFixed(3)} (write=${cacheWrite} read=${cacheRead}` +
          ` uncached=${inputTokens}) — not counted (busts held at ${state.consecutiveBusts})`,
      );
    } else if (bustCause === "prefix-rewrite" && bustRatio > 0.5) {
      log.info(
        `bust-tracker: session=${sessionID.slice(0, 16)} prefix-rewrite (meta-distill)` +
          ` ratio=${bustRatio.toFixed(3)} (write=${cacheWrite} read=${cacheRead}` +
          ` uncached=${inputTokens}) — not counted (busts held at ${state.consecutiveBusts})`,
      );
    }

    // Free-write detection: track consecutive turns with zero cache writes.
    // Covers providers with free passive caching (e.g. MiniMax) and
    // non-caching providers. Both produce the same observable signal.
    if (cacheWrite === 0) {
      state.zeroCacheWriteTurns++;
      // Crossing the threshold: reset bust counter — prior busts were
      // computed under false pricing assumptions (inflated write cost).
      if (state.zeroCacheWriteTurns === NO_CACHE_WRITE_THRESHOLD) {
        state.consecutiveBusts = 0;
        log.info(
          `free-write-detect: session=${sessionID.slice(0, 16)} ` +
            `${NO_CACHE_WRITE_THRESHOLD} consecutive turns with zero cache writes — ` +
            `treating compression as free`,
        );
      }
    } else {
      state.zeroCacheWriteTurns = 0;
    }
  }
}

// Conservative overhead reserve for first-turn (before calibration):
// accounts for provider system prompt + AGENTS.md + tool definitions + env info
const FIRST_TURN_OVERHEAD = 15_000;

// Calibrated overhead: actual tokens used minus our message estimate.
// Null = not yet calibrated (first turn). Updated after every assistant response.
// Shared across all sessions — this is model-level overhead (system prompt,
// tool definitions, provider headers) that doesn't vary per session.
let calibratedOverhead: number | null = null;

// ---------------------------------------------------------------------------
// Per-session state
//
// All calibration, layer-tracking, and window-ID state is scoped per session
// using an in-memory Map. This prevents worker sessions (lore-distill,
// lore-curator) from corrupting the main session's sticky-layer guard and
// delta-estimation state when their transform() calls return layer 0.
//
// forceMinLayer is the one field that MUST survive process restarts: when the
// API returns "prompt is too long", the error handler sets forceMinLayer=2.
// If OpenCode restarts before the next turn, the escalation is lost and the
// overflow repeats. forceMinLayer is persisted to SQLite (session_state table)
// and loaded on first access. All other state rebuilds from the first API
// response via UNCALIBRATED_SAFETY.
// ---------------------------------------------------------------------------

type DistillationSnapshot = {
  /** Cached distillation rows from the most recent DB read */
  rows: Distillation[];
  /** ID of the last user message when this snapshot was taken */
  lastUserMsgId: string | null;
};

type SessionState = {
  /** Exact input token count from the last successful API response */
  lastKnownInput: number;
  /** LTM tokens that were in-flight when lastKnownInput was recorded */
  lastKnownLtm: number;
  /** Total messages sent to the model in the last turn (compressed count on layers 1-4) */
  lastKnownMessageCount: number;
  /** Number of messages in the most recent transform() output */
  lastTransformedCount: number;
  /** Layer used by the most recent transform() call — sticky-layer guard */
  lastLayer: SafetyLayer;
  /** Message IDs in the most recent transform() output — ID-based delta estimation */
  lastWindowMessageIDs: Set<string>;
  /** One-shot force escalation: skip layers below this on the next transform() */
  forceMinLayer: SafetyLayer;
  /** Token estimate from the most recent transform() output (compressed window) */
  lastTransformEstimate: number;
  /** LTM tokens injected for this session's current turn (per-session isolation) */
  ltmTokens: number;
  /** Distilled prefix cache (Approach C) */
  prefixCache: PrefixCache | null;
  /** Raw window pin cache (Approach B) */
  rawWindowCache: RawWindowCache | null;
  /**
   * Wall-clock timestamp (epoch ms) of the most recent transform() call for this
   * session. Used by onIdleResume() to detect cold-cache resumption — when the
   * gap between turns exceeds Anthropic's prompt cache eviction window (5 min
   * default / 1 hour extended), the byte-identity caching subsystems
   * (prefixCache, rawWindowCache) are providing no value because the cache is
   * already cold. Refreshing them on resume lets us produce a better-fitting
   * window without paying a cache cost we'd otherwise be trying to preserve.
   * 0 = never set (first turn).
   */
  lastTurnAt: number;
  /**
   * Set true by onIdleResume() when an idle-resume reset just fired; consumed
   * (and cleared) by the LTM degraded-recovery branch in the OpenCode hook to
   * skip the conversation-vs-LTM token comparison. After idle eviction the
   * cache-bust cost is effectively zero, so we should always recover LTM on
   * the post-idle turn regardless of conversation size.
   */
  cameOutOfIdle: boolean;
  /**
   * Set true by onIdleResume() alongside cameOutOfIdle; consumed (and cleared)
   * by transformInner() to activate the post-idle compact layer. When true AND
   * distillations exist, transform skips layer 0 (full-raw passthrough) and
   * uses a tighter raw budget for layer 1. Rationale: on a cold cache the
   * entire context is a cache WRITE — a smaller total means lower write cost,
   * and aggressive idle distillation already captured the older history.
   */
  postIdleCompact: boolean;
  /** Consecutive turns at layer >= 2. When >= 3, log a compaction hint. */
  consecutiveHighLayer: number;
  /** Consecutive turns where the cache was busted (>50% writes).
   *  Used for rolling bust detection: once consecutiveBusts reaches
   *  SUSTAINED_BUST_THRESHOLD, stop trying to compress and warn that the
   *  conversation is unsustainable. */
  consecutiveBusts: number;
  /** Consecutive turns where the upstream reported zero cache_creation_input_tokens.
   *  After >= NO_CACHE_WRITE_THRESHOLD turns, the session is treated as "free-write" —
   *  compression never busts an expensive cache, so shouldCompress() always says yes.
   *  Covers both free-write-cache providers (MiniMax) and non-caching providers.
   *  Not persisted to DB — rebuilds from live API responses (same rationale as
   *  consecutiveBusts: stale values from a prior process would be incorrect). */
  zeroCacheWriteTurns: number;
  /** Number of transform() calls observed for this session in the current
   *  process. Starts at 0 for a freshly-tracked session and is NOT restored
   *  from the DB (same rationale as consecutiveBusts). Drives the cold-start
   *  grace window that gates bust-spiral alerting for the first
   *  COLD_START_GRACE_TURNS turns (#797). */
  transformCount: number;
  /** True once we've fired the high-severity Sentry alert for this session's
   *  current bust-spiral episode. Cleared when consecutiveBusts drops to 0
   *  (i.e. the episode ended) so a future spiral can alert again. NOT
   *  persisted to DB (same rationale as consecutiveBusts). */
  bustSpiralAlerted: boolean;
  /** True once we've emitted the cold-start info-breadcrumb for this session's
   *  first in-grace spiral. Cold-start is bounded by the grace window so this
   *  is never cleared within a process run. NOT persisted to DB. */
  bustSpiralColdStartLogged: boolean;

  /**
   * Distillation row snapshot — cached to avoid hitting the DB on every
   * transform() call. Refreshed only at turn boundaries (when a new user
   * message appears) or on first call / idle resume. During autonomous
   * tool-call chains this stays frozen, keeping the distilled prefix
   * byte-identical across consecutive API calls and preserving the prompt
   * cache.
   *
   * Cost context: each prefix refresh costs context_size × cache_write_price
   * (~$1.88 per bust at 500K Sonnet). New distillations have near-zero
   * marginal value mid-chain since the model already has raw messages.
   */
  distillationSnapshot: DistillationSnapshot | null;
  /**
   * Cross-turn dedup decisions, keyed by "<messageID>:<partID>" → wasCollapsed.
   * Keeps deduplicateToolOutputs() stable as the conversation grows: a tool
   * output already sent (full or collapsed) keeps that form so the prompt cache
   * isn't busted by a newly-appended later duplicate flipping an early message.
   */
  dedupDecisions: Map<string, boolean>;

  // --- Shared cache-economics inputs/result (see cache-economics.ts) ---
  // The single-entry-point design (evaluateCacheStrategy) reads every input for
  // the warm-vs-compact decision from this one place and stores the one result
  // here, so the cache warmer and the gradient bust calculator branch off an
  // identical decision and cannot diverge.
  /** Full-body token size from the most recent transform() (gradient's own estimate). */
  cacheSizeFull: number;
  /** Compacted-body token target from the most recent transform(); === cacheSizeFull when no compaction is available. */
  cacheSizeCompressed: number;
  /** Non-message floor (system/tools overhead + LTM) of the most recent
   *  transform(), in the SAME estimate basis as the message body (un-inflated).
   *  Compaction never removes this; it is added back to the compressed body so
   *  cacheSizeCompressed lands on the same scale as cacheSizeFull (issue #886). */
  cacheNonBodyTokens: number;
  /** Multiplier that maps the gradient's un-inflated (chars/3) body estimate onto
   *  cacheSizeFull's scale: 1 when calibrated, UNCALIBRATED_SAFETY when not — the
   *  same factor layer0Bounds applies to cacheSizeFull. (issue #886) */
  cacheBodySafety: number;
  /** The single stored strategy decision + when it was computed (null until first evaluated). */
  cacheStrategy: { result: CacheEconomicsResult; decidedAt: number } | null;
};

function makeSessionState(): SessionState {
  return {
    lastKnownInput: 0,
    lastKnownLtm: 0,
    lastKnownMessageCount: 0,
    lastTransformedCount: 0,
    lastLayer: 0,
    lastWindowMessageIDs: new Set(),
    forceMinLayer: 0,
    lastTransformEstimate: 0,
    ltmTokens: 0,
    prefixCache: null,
    rawWindowCache: null,
    lastTurnAt: 0,
    cameOutOfIdle: false,
    postIdleCompact: false,
    consecutiveHighLayer: 0,
    consecutiveBusts: 0,
    zeroCacheWriteTurns: 0,
    transformCount: 0,
    bustSpiralAlerted: false,
    bustSpiralColdStartLogged: false,

    distillationSnapshot: null,
    dedupDecisions: new Map(),
    cacheSizeFull: 0,
    cacheSizeCompressed: 0,
    cacheNonBodyTokens: 0,
    cacheBodySafety: 1,
    cacheStrategy: null,
  };
}

const sessionStates = new Map<string, SessionState>();

function getSessionState(sessionID: string): SessionState {
  let state = sessionStates.get(sessionID);
  if (!state) {
    state = makeSessionState();
    // Restore persisted forceMinLayer from DB — survives process restarts.
    // Critical for "prompt too long" recovery: the error handler sets
    // forceMinLayer=2, but if OpenCode restarts before the next turn,
    // the in-memory escalation would be lost without this.
    state.forceMinLayer = loadForceMinLayer(sessionID) as SafetyLayer;

    // Restore gradient calibration state from DB (v24) — avoids uncalibrated
    // first turns after restart. Without this, lastTurnAt=0 prevents
    // onIdleResume() from detecting idle gaps.
    //
    // Atomic restore: lastTurnAt > 0 is the proxy for "gradient state was
    // ever flushed to DB". Restore all fields together or none — avoids
    // per-field sentinel fragility where a valid value (e.g. lastLayer=0)
    // could be mistaken for "never persisted".
    const persisted = loadSessionTracking(sessionID);
    if (persisted && persisted.lastTurnAt > 0) {
      state.lastLayer = persisted.lastLayer as SafetyLayer;
      state.lastKnownInput = persisted.lastKnownInput;
      // v43: restore the last-sent message count so the calibrated-delta
      // estimate identifies only genuinely-new messages on the resume turn
      // (without it, the whole conversation looks new → over-escalation). (#796)
      state.lastKnownMessageCount = persisted.lastKnownMessageCount;
      state.lastTurnAt = persisted.lastTurnAt;
      // Don't restore consecutiveBusts from DB — it's a short-term rolling
      // signal that must rebuild from live API responses in the current process.
      // Stale values from a previous process (different cache state after restart)
      // would cause false bust-spiral alerts. The dynamicContextCap column is
      // still written for diagnostics but not consumed on restore.
    }

    sessionStates.set(sessionID, state);
  }
  return state;
}

/**
 * Detect cold-cache resumption and refresh byte-identity caches.
 *
 * Anthropic's prompt cache evicts entries after ~5 minutes (default tier) /
 * ~1 hour (extended tier). When a session resumes after the eviction window,
 * the cache is provably cold — every prefix we've been carefully keeping
 * byte-stable (`prefixCache`, `rawWindowCache`, plus the host's per-session
 * LTM cache) provides no benefit on this turn. Worse, the LTM block was
 * scored against the conversation context as it was on the previous turn,
 * which may have drifted significantly in N hours.
 *
 * On resume after `thresholdMs`:
 *   - reset the distilled prefix cache (next turn re-renders from scratch)
 *   - reset the raw window pin cache (next turn picks a fresh cutoff)
 *   - set `cameOutOfIdle` so the OpenCode host can also clear `ltmSessionCache`
 *     and bypass the conversation-vs-LTM cost comparison in the LTM
 *     degraded-recovery branch
 *
 * Importantly, this does NOT touch:
 *   - reasoning blocks (Anthropic's April 23 postmortem identifies dropping
 *     reasoning blocks as the root cause of forgetfulness/repetition; Lore
 *     preserves reasoning by policy across all gradient layers)
 *   - the gradient layer (cold cache doesn't change token budgets;
 *     calibration's actualInput = input + cache.read + cache.write already
 *     accounts for cache misses correctly)
 *   - calibration state (`lastKnownInput`, overhead EMA, message-ID set) —
 *     the next API response will refresh these via the normal calibrate() path
 *
 * Set `thresholdMs <= 0` to disable. Returns true if a reset fired so the
 * caller can log/observe.
 *
 * @param skipCompact  When true, perform all idle-resume housekeeping
 *   (clear caches, set cameOutOfIdle) but do NOT set postIdleCompact.
 *   Used when the caller knows the upstream prompt cache is still warm
 *   (e.g. cache warmer recently refreshed it) — compacting would produce
 *   a different prompt body that doesn't match the warmed prefix, causing
 *   a cache bust and wasting the warming cost.
 */
export function onIdleResume(
  sessionID: string,
  thresholdMs: number,
  now: number = Date.now(),
  skipCompact: boolean = false,
): { triggered: false } | { triggered: true; idleMs: number } {
  if (thresholdMs <= 0) return { triggered: false };
  const state = getSessionState(sessionID);
  if (state.lastTurnAt === 0) return { triggered: false }; // first turn — nothing to refresh
  const idleMs = now - state.lastTurnAt;
  if (idleMs < thresholdMs) return { triggered: false };
  state.prefixCache = null;
  state.rawWindowCache = null;
  state.distillationSnapshot = null;
  // Cache is cold after idle eviction — a fresh window will be rebuilt, so the
  // stable-dedup memo can reset too (its purpose is warm-cache stability).
  state.dedupDecisions.clear();
  state.cameOutOfIdle = true;
  state.postIdleCompact = !skipCompact;
  return { triggered: true, idleMs };
}

/**
 * Return the wall-clock timestamp (epoch ms) of the most recent transform()
 * call for this session. Returns 0 if the session has never been transformed.
 * Used by callers (e.g. meta-distillation gating) to check whether the
 * upstream prompt cache is likely still warm.
 */
export function getLastTurnAt(sessionID: string): number {
  return sessionStates.get(sessionID)?.lastTurnAt ?? 0;
}

/**
 * Read-and-clear the cameOutOfIdle flag. The OpenCode host's LTM degraded-
 * recovery branch consumes this to decide whether to bypass the
 * conversation-vs-LTM token comparison on a post-idle turn.
 */
export function consumeCameOutOfIdle(sessionID: string): boolean {
  const state = sessionStates.get(sessionID);
  if (!state?.cameOutOfIdle) return false;
  state.cameOutOfIdle = false;
  return true;
}

// ---------------------------------------------------------------------------
// Shared cache-economics: single entry point
// ---------------------------------------------------------------------------

/** Survival inputs supplied by the cache warmer for the shared strategy decision. */
export interface CacheSurvivalInputs {
  /** Probability the session returns within the warming horizon (0..1). */
  pReturn: number;
  /** Expected warmup cycles before the session resolves. */
  expectedCycles: number;
  /** Expected turns the resumed session runs (the "ongoing cost" horizon). */
  expectedFutureTurns: number;
  /**
   * #947 — meta-distillation threshold (gen-0 segments per meta cycle). Passed
   * through to `decideCacheStrategy` to compute the meta-aware adjustment to
   * `coolBustCost`. Default 0 (or undefined) → no adjustment, byte-identical
   * to the pre-#947 behavior. Use `cfg.distillation.metaThreshold`.
   */
  metaThreshold?: number;
  /**
   * #947 — per-call cost of meta-distillation ($/call, same currency unit as
   * `readPerToken`/`writePerToken`). Pre-computed at the call site from
   * worker model rates × estimated input/output token counts. Default 0 (or
   * undefined) → only the cache-read-miss term in the meta-bust cost applies
   * (the LLM term is suppressed).
   */
  metaDistillCostPerCall?: number;
}

/**
 * Compute the cache-economics compressed size on the SAME scale as cacheSizeFull
 * (issue #886). cacheSizeFull is INPUT-scale: it includes the non-message floor
 * (system/tools overhead + LTM) and is ×UNCALIBRATED_SAFETY-inflated on
 * uncalibrated turns. A compacted prompt still carries that whole floor — only
 * the message body shrinks — so the compressed cache size is:
 *
 *   (nonBodyFloor + rebuiltWindowBody) × bodySafety   (clamped to full)
 *
 * where `rebuiltWindowBody` (result.totalTokens) and `nonBodyFloor` are the
 * gradient's un-inflated estimates and `bodySafety` is the same factor applied to
 * full. Layer 0 = no compaction → full.
 *
 * EXACT for UNCALIBRATED turns: cacheSizeFull there is `(msgBody+overhead+ltm)·s`
 * built from the SAME `overhead+ltm` expression, so the floor cancels and the
 * delta is exactly `(msgBody−rebuiltBody)·s` (the removed message tokens).
 * APPROXIMATE for CALIBRATED turns: cacheSizeFull is the API-measured
 * `lastKnownInput`, whose embedded floor is the real tokenizer count, while this
 * floor is the gradient's `overhead+ltm` estimate (and `overhead` is an EMA that
 * already absorbs LTM + the chars/3 body undercount — the same entanglement as
 * `usable`). The mismatch errs toward a LARGER compressed (under-reports savings;
 * the clamp to `full` keeps it safe). Fully reconciling the calibrated basis is
 * the remaining PR2b normalization work; harmless while the evaluator is
 * shadow-only.
 */
export function computeCompressedCacheSize(
  layer: number,
  rebuiltWindowTokens: number,
  nonBodyTokens: number,
  bodySafety: number,
  fullTokens: number,
): number {
  if (layer < 1) return fullTokens;
  const compressed = Math.round(
    (Math.max(0, nonBodyTokens) + Math.max(0, rebuiltWindowTokens)) *
      Math.max(1, bodySafety),
  );
  return Math.max(0, Math.min(compressed, fullTokens));
}

/**
 * Record the gradient's own size estimate for a session's current body.
 *
 * This is the WRITER side and intentionally CREATES the session state (via
 * getSessionState) — in production the writer is transform() (which writes the
 * fields directly) and this exported helper is used by tests. The READ
 * accessors (getCacheStrategy / getCacheSizeSnapshot) and the warmer-facing
 * evaluateCacheStrategy use the non-creating `sessionStates.get` so a background
 * warmer can never materialize a phantom session. Do NOT call this from the
 * warmer for that reason. `compressed === full` means "no compaction available"
 * (collapses cool-bust into cool-full-write downstream).
 */
export function setCacheSizeSnapshot(
  sessionID: string,
  fullBodyTokens: number,
  compressedTokens: number,
): void {
  const state = getSessionState(sessionID);
  state.cacheSizeFull = Math.max(0, fullBodyTokens);
  state.cacheSizeCompressed = Math.max(
    0,
    Math.min(compressedTokens, fullBodyTokens),
  );
}

/**
 * THE single entry point for the warm-vs-compact decision. Reads every input
 * from one place — the gradient's size snapshot (set by transform), the cache
 * pricing (module state), and the survival inputs passed in by the warmer — runs
 * the pure decideCacheStrategy ONCE, stores the single result on the session
 * state, and returns it. Both the cache warmer and the gradient bust calculator
 * branch off this stored result (via getCacheStrategy) so they cannot disagree.
 *
 * Returns null when there is no size snapshot yet (the session has not been
 * transformed) so callers keep their legacy behaviour.
 */
export function evaluateCacheStrategy(
  sessionID: string,
  survival: CacheSurvivalInputs,
  // Per-token pricing. Callers SHOULD pass the session's own model pricing — the
  // module-global getCachePricing() reflects the LAST transform's model, which
  // can belong to a different session/model when a background warmer evaluates.
  pricing?: { readPerToken: number; writePerToken: number },
  now: number = Date.now(),
): CacheEconomicsResult | null {
  const state = sessionStates.get(sessionID);
  if (!state || state.cacheSizeFull <= 0) return null;
  // Only fall back to the module-global pricing when no override is supplied
  // (the override is the common path — callers SHOULD pass their own pricing).
  const result = decideCacheStrategy({
    fullBodyTokens: state.cacheSizeFull,
    compressedTokens: state.cacheSizeCompressed,
    readPerToken: pricing?.readPerToken ?? getCachePricing().read,
    writePerToken: pricing?.writePerToken ?? getCachePricing().write,
    pReturn: survival.pReturn,
    expectedCycles: survival.expectedCycles,
    expectedFutureTurns: survival.expectedFutureTurns,
    metaThreshold: survival.metaThreshold,
    metaDistillCostPerCall: survival.metaDistillCostPerCall,
  });
  state.cacheStrategy = { result, decidedAt: now };
  return result;
}

/** Read the single stored strategy decision for a session (null if never evaluated). */
export function getCacheStrategy(
  sessionID: string,
): { result: CacheEconomicsResult; decidedAt: number } | null {
  return sessionStates.get(sessionID)?.cacheStrategy ?? null;
}

/**
 * Read the gradient's last full/compressed size estimate for a session (null if
 * never transformed). Exposed so the warmer can log the shared sizes and
 * cross-check the gradient estimate against the real API token count.
 */
export function getCacheSizeSnapshot(
  sessionID: string,
): { full: number; compressed: number } | null {
  const state = sessionStates.get(sessionID);
  if (!state || state.cacheSizeFull <= 0) return null;
  return { full: state.cacheSizeFull, compressed: state.cacheSizeCompressed };
}

// LTM tokens injected via system transform hook this turn.
// Per-session when a sessionID is provided (preferred), with a module-level
// fallback for callers that don't have a session ID.
let ltmTokensFallback = 0;

/**
 * Snapshot of all model-derived budget inputs for a single transform.
 *
 * These values were previously only mutable module globals set per-request by
 * the host. Because the host does async work (ltm.forSession awaits) BETWEEN
 * setting them and calling transform(), a concurrently-running request for a
 * DIFFERENT model could clobber the globals on the single-threaded event loop,
 * so the transform read the wrong model's caps/pricing (the cross-model
 * contamination seen as l0cap flipping 200000 ↔ 3571428 and layer thrash).
 *
 * Passing a ModelBudget to transform() makes the per-request values atomic:
 * transform() applies them synchronously right before the (fully synchronous)
 * transformInner, so no other request can interleave between apply and use.
 * The setters remain for tests and legacy callers.
 */
export type ModelBudget = {
  contextLimit: number;
  outputReserved: number;
  maxLayer0Tokens: number;
  cacheWriteCostPerToken: number;
  cacheReadCostPerToken: number;
};

/**
 * Atomically apply a per-request model budget to the module globals. Called at
 * the very top of transform() (synchronous path) so the values cannot be
 * clobbered by a concurrent request before the transform reads them.
 */
function applyModelBudget(budget: ModelBudget): void {
  setModelLimits({
    context: budget.contextLimit,
    output: budget.outputReserved,
  });
  setMaxLayer0Tokens(budget.maxLayer0Tokens);
  setCachePricing(budget.cacheWriteCostPerToken, budget.cacheReadCostPerToken);
}

export function setModelLimits(limits: { context: number; output: number }) {
  contextLimit = limits.context || 200_000;
  // NOTE: this cap of 32K matches what @ai-sdk/anthropic sends as max_tokens for
  // claude-opus-4-6 (the SDK doesn't recognise the -6 variant and falls back to
  // the generic claude-opus-4- pattern with maxOutputTokens=32K).  If the SDK is
  // updated to send the model's actual limit (128K for opus-4-6), this cap will
  // become wrong — the effective max input would drop from 168K to 72K but our
  // budget would still assume 168K.  At that point, remove the cap.
  outputReserved = Math.min(limits.output || 32_000, 32_000);
}

/**
 * Set the cost-aware layer-0 token cap. When the cap > 0, the layer-0
 * passthrough gate uses `min(maxInput, cap)` instead of `maxInput` alone.
 *
 * Call from the host adapter after computing the cap from model pricing:
 * `cap = max(targetCostPerTurn / model.cost.cache.read, MIN_LAYER0_FLOOR)`
 */
export function setMaxLayer0Tokens(tokens: number) {
  maxLayer0Tokens = Math.max(0, Math.floor(tokens));
}

/** Compute the layer-0 token cap from a per-turn cost target and cache-read price. */
export function computeLayer0Cap(
  targetCostPerTurn: number,
  cacheReadCostPerToken: number,
): number {
  if (targetCostPerTurn <= 0 || cacheReadCostPerToken <= 0) return 0;
  const rawCap = Math.floor(targetCostPerTurn / cacheReadCostPerToken);
  return Math.max(rawCap, MIN_LAYER0_FLOOR);
}

/** Called by the system transform hook after formatting LTM knowledge.
 *  When sessionID is provided, stores on per-session state to prevent
 *  cross-session budget contamination. Falls back to module-level global
 *  for callers without a session ID. */
export function setLtmTokens(tokens: number, sessionID?: string) {
  if (sessionID) {
    getSessionState(sessionID).ltmTokens = tokens;
  }
  ltmTokensFallback = tokens;
}

/** Returns the LTM token count for the given session, falling back to
 *  the module-level global when no session ID is provided. */
export function getLtmTokens(sessionID?: string): number {
  if (sessionID) {
    const state = sessionStates.get(sessionID);
    if (state) return state.ltmTokens;
  }
  return ltmTokensFallback;
}

/**
 * Returns the token budget available for LTM system-prompt injection.
 * This is the usable context (after output + overhead) multiplied by
 * the configured ltm budget fraction. Call this from the system transform
 * hook to cap how many tokens formatKnowledge may use.
 */
export function getLtmBudget(ltmFraction: number): number {
  const overhead = calibratedOverhead ?? FIRST_TURN_OVERHEAD;
  const usable = Math.max(0, contextLimit - outputReserved - overhead);
  // Quantize to a coarse step so per-turn `usable` wobble (overhead EMA drift)
  // does not move the ltm.forSession() packing boundary and churn the pinned
  // LTM set every turn. See LTM_BUDGET_STEP.
  //
  // Round to the NEAREST step (not floor) so the budget never collapses to 0
  // when the raw budget is below one step (small-context models): a raw budget
  // under half a step rounds up to one full step rather than to zero, and the
  // common large-context case (raw >> step) is unaffected. This keeps the
  // budget stable across wobble while never disabling LTM.
  const raw = Math.floor(usable * ltmFraction);
  if (raw <= 0) return 0;
  const quantized = Math.round(raw / LTM_BUDGET_STEP) * LTM_BUDGET_STEP;
  return Math.max(LTM_BUDGET_STEP, quantized);
}

/** Returns the token budget for stable LTM (preferences). Independent of context-bound LTM budget. */
export const getPreferenceLtmBudget = getLtmBudget;

// Called after each assistant message completes with real token usage data.
// actualInput    = tokens.input + tokens.cache.read + tokens.cache.write
// sessionID      = session that produced this response (for exact-tracking validity)
// messageCount   = number of messages that were sent (for delta estimation)
//
// Overhead calibration uses lastTransformEstimate (the token estimate from the
// compressed window that was actually sent to the model) instead of re-estimating
// all session messages. On compressed sessions, all-message estimate >> actualInput,
// which clamped overhead to 0 and broke budget calculations.
export function calibrate(
  actualInput: number,
  sessionID?: string,
  messageCount?: number,
) {
  // Use the transform's own estimate for the compressed window it produced.
  // This is the correct baseline: it estimates the same messages the model saw.
  const messageEstimate = sessionID
    ? getSessionState(sessionID).lastTransformEstimate
    : 0;

  // Update global overhead calibration (shared across sessions — model-level).
  // Skip when actualInput > 0 but no transform estimate exists yet (no baseline
  // to compare against). Allow when both are 0 (test setup to zero overhead) or
  // when we have a real transform estimate.
  if (messageEstimate > 0 || actualInput === 0) {
    const overhead = Math.max(0, actualInput - messageEstimate);
    calibratedOverhead =
      calibratedOverhead === null
        ? overhead
        : Math.round(calibratedOverhead * 0.7 + overhead * 0.3);
  }

  // Store per-session exact counts for the proactive layer 0 decision.
  if (sessionID !== undefined) {
    const state = getSessionState(sessionID);
    state.lastKnownInput = actualInput;
    state.lastKnownLtm = state.ltmTokens;
    if (messageCount !== undefined) state.lastKnownMessageCount = messageCount;
  }
}

export function getOverhead(): number {
  return calibratedOverhead ?? FIRST_TURN_OVERHEAD;
}

/**
 * Returns the number of messages in the most recent transform() output for
 * the given session. Used by calibrate() to track the compressed window size.
 */
export function getLastTransformedCount(sessionID: string): number {
  return sessionStates.get(sessionID)?.lastTransformedCount ?? 0;
}

/** Returns the token estimate from the most recent transform() output. */
export function getLastTransformEstimate(sessionID: string): number {
  return sessionStates.get(sessionID)?.lastTransformEstimate ?? 0;
}

/** Returns the layer used by the most recent transform() call. For testing. */
export function getLastLayer(sessionID?: string): SafetyLayer {
  if (sessionID) return sessionStates.get(sessionID)?.lastLayer ?? 0;
  // Fallback for tests: return from the first (and usually only) session state
  const first = sessionStates.values().next().value;
  return first?.lastLayer ?? 0;
}

/**
 * Decide whether the "prefix-present floor" applies — i.e. whether the next
 * transform must pin to at least Layer 1 (keeping the distilled prefix present
 * at messages[0]/[1]) because the session has already compressed.
 *
 * Returns true when the session has compressed before (`lastLayer >= 1`) AND
 * this turn is NOT a genuine compaction. A genuine compaction is detected when
 * the last-known window size is known (> 0) and the incoming conversation has
 * shrunk below it — that is the one case where dropping back to Layer 0 is
 * correct (the host shrank the conversation, so the prefix is no longer needed).
 *
 * Notes:
 *  - Covers `lastLayer === 4` (the strong sticky guard's `<= 3` excludes it).
 *  - When `lastKnownMessageCount === 0` (fresh process, not yet set), this never
 *    treats the turn as a compaction — it relies on the DB-restored `lastLayer`
 *    to hold the floor until the live count is established.
 *  - Pure function of its inputs — unit-testable without driving a full transform.
 */
export function prefixPresentFloorApplies(
  lastLayer: number,
  messagesLength: number,
  lastKnownMessageCount: number,
): boolean {
  const hasCompressed = lastLayer >= 1;
  const genuineCompaction =
    lastKnownMessageCount > 0 && messagesLength < lastKnownMessageCount;
  return hasCompressed && !genuineCompaction;
}

/**
 * Force the next transform() call for this session to use at least the given layer.
 * Called when the API returns "prompt is too long" so the next attempt
 * trims the context enough to fit within the model's context window.
 */
export function setForceMinLayer(layer: SafetyLayer, sessionID?: string) {
  if (sessionID) {
    getSessionState(sessionID).forceMinLayer = layer;
    saveForceMinLayer(sessionID, layer);
  } else {
    // Fallback for tests / callers without session ID: set on all active sessions
    for (const [sid, state] of sessionStates.entries()) {
      state.forceMinLayer = layer;
      saveForceMinLayer(sid, layer);
    }
  }
}

/**
 * Evict a single session's in-memory state. Called when a session has been
 * idle long enough that keeping its caches resident is wasteful. All
 * important state (gradient calibration, force-min-layer) is already
 * persisted to SQLite and will be reloaded if the session resumes.
 *
 * Does NOT reset global calibration — only frees session-specific caches
 * (prefix cache, raw window cache, distillation snapshot, etc.).
 */
export function evictSession(sessionID: string): void {
  sessionStates.delete(sessionID);
}

// For testing only — reset all calibration and force-escalation state
export function resetCalibration(sessionID?: string) {
  calibratedOverhead = null;
  cacheWriteCostPerToken = 0;
  cacheReadCostPerToken = 0;
  urgentDistillationEnabled = true;
  urgentDistillationMap.clear();
  if (sessionID) {
    saveForceMinLayer(sessionID, 0); // clear persisted state
    sessionStates.delete(sessionID);
  } else {
    for (const sid of sessionStates.keys()) {
      saveForceMinLayer(sid, 0);
    }
    sessionStates.clear();
  }
}

/**
 * For testing only — observe session-state cache fields without exposing the
 * full type. Returns null when the session has no state. The boolean fields
 * answer "does this cache hold something right now?" — sufficient for asserting
 * that onIdleResume() reset them.
 */
export function inspectSessionState(sessionID: string): {
  hasPrefixCache: boolean;
  hasRawWindowCache: boolean;
  cameOutOfIdle: boolean;
  postIdleCompact: boolean;
  lastTurnAt: number;
  distillationSnapshot: DistillationSnapshot | null;
  consecutiveBusts: number;
  zeroCacheWriteTurns: number;
  lastKnownMessageCount: number;
  transformCount: number;
  bustSpiralAlerted: boolean;
  bustSpiralColdStartLogged: boolean;
} | null {
  const state = sessionStates.get(sessionID);
  if (!state) return null;
  return {
    hasPrefixCache: state.prefixCache !== null,
    hasRawWindowCache: state.rawWindowCache !== null,
    cameOutOfIdle: state.cameOutOfIdle,
    postIdleCompact: state.postIdleCompact,
    lastTurnAt: state.lastTurnAt,
    distillationSnapshot: state.distillationSnapshot,
    consecutiveBusts: state.consecutiveBusts,
    zeroCacheWriteTurns: state.zeroCacheWriteTurns,
    lastKnownMessageCount: state.lastKnownMessageCount,
    transformCount: state.transformCount,
    bustSpiralAlerted: state.bustSpiralAlerted,
    bustSpiralColdStartLogged: state.bustSpiralColdStartLogged,
  };
}

/**
 * Return the consecutive-bust counter for a session (read-only).
 * Returns 0 if the session has no in-memory state — callers treat this
 * as "no bust pressure" which is the safe default.
 *
 * Uses Map.get() instead of getSessionState() to avoid creating phantom
 * SessionState entries with zeroed calibration fields, which would cause
 * the next transform() call to treat the session as uncalibrated.
 */
export function getConsecutiveBusts(sessionID: string): number {
  return sessionStates.get(sessionID)?.consecutiveBusts ?? 0;
}

// ---------------------------------------------------------------------------
// Bust-spiral alerting (#797)
//
// When a session goes through a sustained sequence of cache busts (the
// "bust spiral"), it's almost always a real caching bug we want to
// investigate — prefix drift, prompt-delta position drift after
// post-idle recompression, LTM pin mismatch, etc. We surface this via
// a host-registered hook (gateway → Sentry) rather than the user-facing
// warning we used to inject, because:
//   - The user has no actionable response.
//   - Two structurally different bugs (drift vs. genuine unbounded growth)
//     surfaced the same way to the user; Sentry's structured context lets
//     us distinguish them in aggregate.
//   - The cold-start opening (turn-1 cold write, turn-2 LTM injection,
//     turn-3 layer transition) is EXPECTED per #796/#804 and would be noise
//     if alerted on. The grace window above distinguishes the two cases.
//
// The hook is optional; core has no Sentry dependency. The gateway wires it
// once at startup (`setupBustSpiralCapture`).
// ---------------------------------------------------------------------------

/** Diagnostic snapshot passed to {@link BustSpiralHook} callbacks. */
export interface BustSpiralInfo {
  sessionID: string;
  /** Current consecutive-bust count at the time of detection. */
  consecutiveBusts: number;
  /** Transform count at the time of detection (cold-start gate signal). */
  transformCount: number;
  /** Current gradient layer (0 = raw passthrough, 4 = emergency). */
  layer: number;
  /** Optional upstream cache telemetry, when available. */
  cacheWriteTokens?: number;
  cacheReadTokens?: number;
}

/** Optional hook the gateway registers to surface bust-spiral events.
 *  All methods are optional; core calls only what the host provides. */
export interface BustSpiralHook {
  /** Within cold-start grace, busts first cross SUSTAINED_BUST_THRESHOLD.
   *  Fires once per cold-start episode (debounced via SessionState). */
  onColdStart?(info: BustSpiralInfo): void;
  /** Past cold-start grace, busts at SUSTAINED_BUST_THRESHOLD+. Fires once
   *  per spiral episode; cleared when consecutiveBusts drops to 0. */
  onSpiral?(info: BustSpiralInfo): void;
  /** Spiral ended (consecutiveBusts dropped to 0 after a spiral). Optional
   *  recovery signal — gateway typically emits an info-level breadcrumb. */
  onRecovered?(info: BustSpiralInfo): void;
}

let bustSpiralHook: BustSpiralHook | null = null;

/** Register (or clear, with `null`) the bust-spiral hook. The gateway calls
 *  this once at startup. Pass `null` to clear (used by tests). */
export function setBustSpiralHook(h: BustSpiralHook | null): void {
  bustSpiralHook = h;
}

/** Build a {@link BustSpiralInfo} snapshot from current SessionState. */
function bustSpiralInfo(
  sid: string,
  state: SessionState,
  layer: number,
): BustSpiralInfo {
  return {
    sessionID: sid,
    consecutiveBusts: state.consecutiveBusts,
    transformCount: state.transformCount,
    layer,
  };
}

/** Run the bust-spiral detection logic for a session. Called from
 *  transform() after the inner transform updates SessionState.
 *
 *  Fires:
 *  - `onColdStart` (once per cold-start episode) when in grace AND busts ≥
 *    SUSTAINED_BUST_THRESHOLD AND not already logged this episode.
 *  - `onSpiral` (once per past-grace episode) when past grace AND busts ≥
 *    SUSTAINED_BUST_THRESHOLD AND not already alerted this episode.
 *  - `onRecovered` when an alerted episode ends (busts dropped to 0).
 *
 *  Pure no-op when `sid` is undefined (callers without session context are not
 *  interesting for spiral alerts). */
function maybeDetectBustSpiral(
  sid: string | undefined,
  state: SessionState,
  layer: number,
  totalTokens: number,
): void {
  if (!sid) return;
  const busts = state.consecutiveBusts;
  const inGrace = state.transformCount <= COLD_START_GRACE_TURNS;

  // The cap-fit passthrough (layer 0, tier 0) returns a session that fits
  // the layer-0 cap with headroom — its busts come from structural causes
  // (e.g. a prompt-delta position drift after post-idle recompression), not
  // genuine context growth. Skip the alert for sub-cap sessions even past
  // the cold-start grace window. Mirrors the original cap-fit hardcode
  // `unsustainable: false` from #797's earlier design.
  const isCapFit = layer === 0 && getTier(totalTokens) === 0;

  if (busts >= SUSTAINED_BUST_THRESHOLD) {
    if (inGrace && !state.bustSpiralColdStartLogged) {
      state.bustSpiralColdStartLogged = true;
      // Cold-start breadcrumb fires even for cap-fit sub-cap sessions —
      // useful telemetry for the cold-start phase regardless of cap-fit.
      bustSpiralHook?.onColdStart?.(bustSpiralInfo(sid, state, layer));
    } else if (!inGrace && !state.bustSpiralAlerted && !isCapFit) {
      state.bustSpiralAlerted = true;
      bustSpiralHook?.onSpiral?.(bustSpiralInfo(sid, state, layer));
    }
    return;
  }

  // Recovery — an alerted episode ended. Clear the debounce flag so a future
  // spiral alerts again. Also clear the cold-start flag so the next cold-start
  // episode (in a new process run) can log a fresh breadcrumb.
  if (busts === 0) {
    const hadAlert = state.bustSpiralAlerted;
    state.bustSpiralAlerted = false;
    state.bustSpiralColdStartLogged = false;
    if (hadAlert) {
      bustSpiralHook?.onRecovered?.(bustSpiralInfo(sid, state, layer));
    }
  }
}

/** Bust-pressure threshold for meta-distillation: consecutive busts ≥ this
 *  value trigger earlier consolidation of gen-0 segments. */
export const BUST_PRESSURE_THRESHOLD = 3;

/** Minimum gap between the session's last turn and "now" for the bust-pressure
 *  meta-threshold override (and the symmetric cool-bust mid-flight defer
 *  gate in the gateway idle handler) to apply. Below this, the session is too
 *  fresh — the user is likely to come back to a still-warming cache, and
 *  forcing meta would rewrite the prefix right before the next user turn,
 *  busting the cache they just paid to re-warm. Matches the default Anthropic
 *  prompt cache TTL (5 min) — anything tighter would race the warmer. */
export const DEEP_IDLE_MS = 5 * 60 * 1000;

/** Floor for the bust-pressure meta-threshold override. Even with busts
 *  ≥ BUST_PRESSURE_THRESHOLD, the lowered threshold is clamped to this value
 *  — meta-distillation is a heavy rewrite (archives gen-0, creates gen-1,
 *  busts the prompt cache on the next turn), so the override only fires
 *  when there's enough accumulated churn to justify it. With the default
 *  metaThreshold=20 and the 1/4 rule, the lowered value would be 5 — too
 *  eager given that meta itself causes prefix-rewrite busts. */
const BUST_PRESSURE_META_FLOOR = 10;

/**
 * Compute the effective meta-distillation threshold under bust pressure.
 *
 * Two conditions gate the override:
 *
 * (1) **Bust pressure** — `busts >= BUST_PRESSURE_THRESHOLD` (3 consecutive
 *     busts). The session is churning, so earlier consolidation can help.
 *
 * (2) **Deep-idle signal** — the session's last turn was at least
 *     `DEEP_IDLE_MS` (5 min) ago. Without this, a churning session that
 *     briefly goes idle (e.g. 90s gap) would fire meta right before the
 *     user comes back, busting the cache they just paid to re-warm. The
 *     ses_10f932a26ffe… (lore 0XrHNdlsWwgVkX4MH) incident: bust pressure
 *     crossed the threshold at 20:04, the session idled 36 min (well past
 *     5 min), and meta fired during that idle. Good. But the OLD logic
 *     (floor=3) would have fired meta at 20:04 even with a 1-min gap —
 *     which would have busted the cache on the turn the user was about to
 *     send. The 5-min gate is the "we expect the user to be away" check.
 *
 * When the override DOES fire, the threshold is `floor(configThreshold / 4)`
 * clamped to `BUST_PRESSURE_META_FLOOR` (10). The floor prevents the
 * override from collapsing the meta cadence to "every 5 gen-0 segments" —
 * which is too eager given that meta itself causes prefix-rewrite busts
 * (those are now exempt from consecutiveBusts, but they still incur a
 * real cache write cost).
 *
 * @param busts           - current consecutive-bust count for the session
 * @param configThreshold - configured metaThreshold (e.g. `cfg.distillation.metaThreshold`)
 * @param lastTurnAtMs    - wall-clock ms of the session's last turn
 *                          (use 0 for "never"; treated as deep-idle)
 * @param nowMs           - current wall-clock ms; injectable for deterministic
 *                          tests. Defaults to `Date.now()`. Production callers
 *                          never pass it.
 * @returns the effective meta-threshold for the idle handler
 */
export function effectiveMetaThreshold(
  busts: number,
  configThreshold: number,
  lastTurnAtMs = 0,
  nowMs: number = Date.now(),
): number {
  if (busts < BUST_PRESSURE_THRESHOLD) return configThreshold;
  // 0 = never set (first turn). Treat as deep-idle so the very first bust
  // pressure event isn't blocked by a missing timestamp.
  const gapMs = lastTurnAtMs === 0 ? Infinity : nowMs - lastTurnAtMs;
  if (gapMs < DEEP_IDLE_MS) return configThreshold;
  return Math.max(BUST_PRESSURE_META_FLOOR, Math.floor(configThreshold / 4));
}

/**
 * For testing only — set the session's lastTurnAt field. Used to simulate
 * idle gaps without sleeping. Creates the session state if not present so
 * tests don't need to seed it via a transform() call.
 */
export function setLastTurnAtForTest(sessionID: string, ms: number): void {
  getSessionState(sessionID).lastTurnAt = ms;
}

/**
 * For testing only — set the session's consecutiveBusts count. Used to drive
 * bust-pressure code paths (e.g. the idle handler's deferred-prefix-work
 * override) without replaying real cache-bust turns. Creates the session state
 * if not present.
 */
export function setConsecutiveBustsForTest(
  sessionID: string,
  busts: number,
): void {
  getSessionState(sessionID).consecutiveBusts = busts;
}

/**
 * Test-only: set the per-session transform counter that drives the cold-start
 * grace window (#797). Set it above COLD_START_GRACE_TURNS to simulate a
 * session that has moved past cold-start stabilization, or below it to simulate
 * a freshly-tracked session still within the grace window.
 */
export function setTransformCountForTest(
  sessionID: string,
  count: number,
): void {
  getSessionState(sessionID).transformCount = count;
}

/**
 * Persist gradient calibration state to the session_state table.
 *
 * Designed to be called periodically (e.g. every 30s from the idle scheduler
 * tick) rather than on every mutation, to avoid write amplification on the
 * hot path. Max data loss on crash is one tick interval (~30s).
 */
export function saveGradientState(sessionID: string): void {
  const state = sessionStates.get(sessionID);
  if (!state) return;

  saveSessionTracking(sessionID, {
    lastLayer: state.lastLayer,
    lastKnownInput: state.lastKnownInput,
    lastKnownMessageCount: state.lastKnownMessageCount,
    lastTurnAt: state.lastTurnAt,
    // Repurpose the dead dynamicContextCap column (v24, always 0 now)
    // to persist consecutiveBusts — avoids a new DB migration.
    dynamicContextCap: state.consecutiveBusts,
  });
}

type Distillation = {
  id: string;
  observations: string;
  generation: number;
  token_count: number;
  created_at: number;
  session_id: string;
  r_compression: number | null;
  c_norm: number | null;
  source_ids: string[];
};

// Load non-archived distillations for the in-context prefix.
// Archived gen-0 entries (preserved after meta-distillation) are excluded here
// but remain searchable via the recall tool's searchDistillations().
function loadDistillations(
  projectPath: string,
  sessionID?: string,
): Distillation[] {
  const pid = ensureProject(projectPath);
  // id tie-break — never let same-ms rows reorder and bust the cache.
  // created_at is Date.now() (ms precision); two rows written in the same
  // millisecond would otherwise have an undefined relative order across
  // queries, flipping the distilledPrefixCached validity anchor and forcing
  // an unnecessary full prefix re-render. Distillation ids are random
  // (crypto.randomUUID, v4), so (created_at, id) is NOT chronological for
  // same-ms rows — but it IS a stable, deterministic total order, which is
  // exactly what cache stability requires.
  const query = sessionID
    ? "SELECT id, observations, generation, token_count, created_at, session_id, r_compression, c_norm, source_ids FROM distillations WHERE project_id = ? AND session_id = ? AND archived = 0 ORDER BY created_at ASC, id ASC"
    : "SELECT id, observations, generation, token_count, created_at, session_id, r_compression, c_norm, source_ids FROM distillations WHERE project_id = ? AND archived = 0 ORDER BY created_at ASC, id ASC";
  const params = sessionID ? [pid, sessionID] : [pid];
  const rows = db()
    .query(query)
    .all(...params) as Array<
    Omit<Distillation, "source_ids"> & { source_ids: string }
  >;
  return rows.map((r) => ({
    ...r,
    source_ids: r.source_ids ? JSON.parse(r.source_ids) : [],
  }));
}

// Cached distillation loader — avoids hitting the DB on every transform() call.
// Refreshed only at turn boundaries (when a new user message appears), on first
// call (null snapshot), or after idle resume (snapshot cleared by onIdleResume).
// During autonomous tool-call chains (consecutive assistant→tool→assistant with
// the same last user message), returns the cached rows so the distilled prefix
// stays byte-identical and preserves the Anthropic prompt cache.
function loadDistillationsCached(
  projectPath: string,
  sessionID: string,
  messages: MessageWithParts[],
  sessState: SessionState,
): Distillation[] {
  // Find the last user message ID in the input
  let lastUserMsgId: string | null = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].info.role === "user") {
      lastUserMsgId = messages[i].info.id;
      break;
    }
  }

  const snapshot = sessState.distillationSnapshot;

  // Cache hit: same user message = still in the same tool-call chain
  if (snapshot && snapshot.lastUserMsgId === lastUserMsgId) {
    return snapshot.rows;
  }

  // Cache miss: new user message (turn boundary), first call, or post-idle
  const rows = loadDistillations(projectPath, sessionID);
  sessState.distillationSnapshot = { rows, lastUserMsgId };

  log.info(
    `distillation refresh: ${rows.length} rows` +
      ` (user msg ${lastUserMsgId?.substring(0, 16) ?? "none"})`,
  );

  return rows;
}

// Strip all <system-reminder>...</system-reminder> blocks from message text.
// For the user-message wrapper pattern, extracts the actual user text.
// For all other reminders (build-switch, plan reminders, etc.), drops them entirely.
// These tags are added by OpenCode in-memory or persisted as synthetic parts —
// leaving them in the raw window causes the model to echo the format.
function stripSystemReminders(text: string): string {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>\n?/g, (match) => {
      const inner = match.match(
        /The user sent the following message:\n([\s\S]*?)\n\nPlease address/,
      );
      return inner ? `${inner[1].trim()}\n` : "";
    })
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function cleanParts(parts: LorePart[]): LorePart[] {
  const cleaned = parts.map((part) => {
    if (!isTextPart(part)) return part;
    const text = stripSystemReminders(part.text);
    if (text === part.text) return part;
    return { ...part, text } as LorePart;
  });
  // Filter out text parts that became empty after stripping
  const filtered = cleaned.filter(
    (part) => !isTextPart(part) || part.text.trim().length > 0,
  );
  // If all parts were stripped (e.g. a user message that was purely build-switch synthetic
  // content), keep a minimal placeholder so the message survives toModelMessages.
  // Without this, the message gets dropped and the conversation ends with an assistant message,
  // causing Anthropic's "does not support assistant message prefill" error.
  if (filtered.length === 0 && parts.length > 0) {
    const first = parts[0];
    if (isTextPart(first)) {
      return [{ ...first, text: "..." } as LorePart];
    }
  }
  return filtered.length > 0 ? filtered : parts;
}

// Upper bound on how much of the output the path-extraction regex scans.
// Two mitigations for catastrophic backtracking in `PATH_RE`:
//   1. Skip entirely if the input contains no '/' (a path requires at least
//      one separator, so without one the regex has no possible match yet
//      still backtracks O(n²) on long runs of [\w.-]).
//   2. Cap the scanned slice at this limit so even crafted inputs with a
//      '/' somewhere don't stall the worker. The annotation only needs a
//      few representative paths — sampling the first 64KB is plenty.
const ANNOTATION_PATH_SCAN_LIMIT = 64 * 1024;
const PATH_RE = /(?:[\w.-]+\/)+[\w.-]+\.\w{1,5}/g;

// Build a metadata annotation for a stripped tool output, preserving key signals
// about what was lost without requiring an LLM call. Inspired by the per-token
// scalar bias β from "Fast KV Compaction via Attention Matching" (Zweiger et al.,
// 2025) — when tokens are removed, preserving metadata about the removed content
// helps the model compensate for information loss and decide whether to recall.
// Reference: https://arxiv.org/abs/2602.16284
export function toolStripAnnotation(toolName: string, output: string): string {
  const lines = output.split("\n").length;

  // Detect key signals via lightweight heuristics — no LLM call
  const hasError =
    /\b(?:error|fail(?:ed|ure)?|exception|panic|traceback)\b/i.test(output);

  // Path extraction: skip entirely if no '/' is present (cheap O(n) check
  // via indexOf) to avoid PATH_RE's O(n²) backtracking on long runs of
  // [\w.-] without a separator. Otherwise sample the first N KB.
  let uniquePaths: string[] = [];
  if (output.indexOf("/") !== -1) {
    const pathScan =
      output.length > ANNOTATION_PATH_SCAN_LIMIT
        ? output.slice(0, ANNOTATION_PATH_SCAN_LIMIT)
        : output;
    const paths = pathScan.match(PATH_RE);
    if (paths) uniquePaths = [...new Set(paths)].slice(0, 5);
  }

  let annotation = `[output omitted — ${toolName}: ${lines} lines`;
  if (hasError) annotation += ", contained errors";
  if (uniquePaths.length > 0)
    annotation += `, paths: ${uniquePaths.join(", ")}`;
  annotation += " — use recall for details]";
  return annotation;
}

// ---------------------------------------------------------------------------
// Content-aware deduplication
// ---------------------------------------------------------------------------
// Inspired by Dirac's ContextManager file-read deduplication: detects when the
// same content appears multiple times in the conversation (e.g., the same file
// read multiple times, or the same command output repeated) and replaces earlier
// occurrences with compact annotations. This reduces token pressure before layer
// selection, potentially keeping sessions at lower (less lossy) gradient layers.

// Minimum output size (chars) to consider for dedup — annotations for smaller
// outputs would cost more tokens than the original content.
const DEDUP_MIN_CHARS = 600;

/** Fast FNV-1a hash for content comparison. */
function simpleHash(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash;
}

/** Parsed read-tool input: file path plus optional line range. */
type ReadRange = {
  path: string;
  /** 1-based start line. undefined = from beginning. */
  offset: number | undefined;
  /** Number of lines to read. undefined = to end. */
  limit: number | undefined;
};

/** Extract file path from a tool's input JSON.
 *  Handles common formats: {"path": "/foo.ts"}, {"filePath": "/foo.ts"},
 *  and plain text fallback. */
function _extractFilePath(input: string): string | undefined {
  try {
    const parsed = JSON.parse(input);
    return parsed.path || parsed.filePath || parsed.file;
  } catch {
    // Plain text — try to extract a path-like string
    const match = input.match(/(?:[\w.-]+\/)+[\w.-]+\.\w{1,5}/);
    return match?.[0];
  }
}

/** Extract file path + line range from a read tool's input. */
function extractReadRange(input: string): ReadRange | undefined {
  try {
    const parsed = JSON.parse(input);
    const path = parsed.path || parsed.filePath || parsed.file;
    if (!path) return undefined;
    const offset =
      typeof parsed.offset === "number" ? parsed.offset : undefined;
    const limit = typeof parsed.limit === "number" ? parsed.limit : undefined;
    return { path, offset, limit };
  } catch {
    const match = input.match(/(?:[\w.-]+\/)+[\w.-]+\.\w{1,5}/);
    if (!match) return undefined;
    return { path: match[0], offset: undefined, limit: undefined };
  }
}

/**
 * Does `later` cover the line range of `earlier`?
 *
 * Coverage rules:
 * - Full-file read (no offset/limit) covers everything for the same path.
 * - A ranged read covers another ranged read when its [offset, offset+limit)
 *   interval is a superset of (or equal to) the other's interval.
 * - A ranged read does NOT cover a full-file read.
 */
export function laterReadCovers(later: ReadRange, earlier: ReadRange): boolean {
  if (later.path !== earlier.path) return false;

  // Full-file read covers everything for the same path.
  if (later.offset === undefined && later.limit === undefined) return true;

  // Later is a ranged read but earlier is full-file — can't cover.
  if (earlier.offset === undefined && earlier.limit === undefined) return false;

  // Both have ranges. Compute intervals.
  const laterStart = later.offset ?? 1;
  const earlierStart = earlier.offset ?? 1;

  // An open-ended later read (no limit) covers if its start <= earlier start.
  if (later.limit === undefined) return laterStart <= earlierStart;

  // Earlier is open-ended but later isn't — later can't cover infinite range.
  if (earlier.limit === undefined) return false;

  // Both bounded: [start, start+limit) superset check.
  const laterEnd = laterStart + later.limit;
  const earlierEnd = earlierStart + earlier.limit;
  return laterStart <= earlierStart && laterEnd >= earlierEnd;
}

/** Format a range label for dedup annotations. */
function rangeLabel(range: ReadRange): string {
  if (range.offset !== undefined && range.limit !== undefined) {
    return ` lines ${range.offset}-${range.offset + range.limit - 1}`;
  }
  if (range.offset !== undefined) {
    return ` from line ${range.offset}`;
  }
  return "";
}

/** Annotation for deduplicated tool output — follows the toolStripAnnotation() pattern. */
function dedupAnnotation(
  toolName: string,
  filePath?: string,
  range?: ReadRange,
): string {
  if (filePath) {
    const rl = range ? rangeLabel(range) : "";
    return `[earlier read of ${filePath}${rl} — see latest read below for current content]`;
  }
  return `[duplicate output — same content as later ${toolName} in this session — use recall for details]`;
}

/**
 * Replace duplicate tool outputs with compact back-references, keeping only
 * the latest occurrence of each unique output. Reduces context token usage
 * without information loss — the model sees the most recent content intact.
 *
 * Deduplicates by:
 * 1. Exact content hash: identical tool outputs (same file read twice, same command output)
 * 2. Range-aware file reads: read_file/read outputs for the same path where a later
 *    read covers the same or wider line range (full-file covers everything; a ranged
 *    read only covers another ranged read when its interval is a superset).
 *
 * The current turn (from currentTurnIdx onward) is never touched — the model
 * needs full context for its active work. Tool parts are never removed entirely;
 * only state.output is replaced with a compact annotation.
 *
 * Returns the original array reference (not a copy) when no duplicates exist.
 */
export function deduplicateToolOutputs(
  messages: MessageWithParts[],
  currentTurnIdx: number,
  /**
   * Optional per-session memo of prior collapse decisions, keyed by
   * `"<messageID>:<partID>"` → wasCollapsed. Makes dedup STABLE across turns:
   * once a tool output has been sent (full or collapsed) it keeps that form, so
   * a newly-appended later duplicate can't retroactively flip an already-cached
   * earlier message and bust the prompt cache. Caller persists this map across
   * transform() calls (per session). When omitted, dedup is stateless (legacy
   * behavior — still correct, just not cross-turn-stable).
   */
  stableDecisions?: Map<string, boolean>,
): MessageWithParts[] {
  // Track latest occurrence: contentKey → latest message index
  const contentLatest = new Map<string, number>();

  // Track all read ranges per file path, ordered by message index (ascending).
  // Each entry records the range and the message index so the second pass can
  // check whether any later read covers the current read's range.
  const fileReads = new Map<
    string,
    Array<{ range: ReadRange; msgIdx: number }>
  >();

  // First pass: scan all messages (including current turn) to build tracking maps.
  for (let i = 0; i < messages.length; i++) {
    for (const part of messages[i].parts) {
      if (!isToolPart(part) || part.state.status !== "completed") continue;
      const output = part.state.output;
      if (!output || output.length < DEDUP_MIN_CHARS) continue;

      const key = `${part.tool}:${simpleHash(output)}`;
      contentLatest.set(key, i);

      // For read-type tools, record the full range info
      if (part.tool === "read_file" || part.tool === "read") {
        const inputStr =
          typeof part.state.input === "string"
            ? part.state.input
            : JSON.stringify(part.state.input);
        const range = extractReadRange(inputStr);
        if (range) {
          let entries = fileReads.get(range.path);
          if (!entries) {
            entries = [];
            fileReads.set(range.path, entries);
          }
          entries.push({ range, msgIdx: i });
        }
      }
    }
  }

  // Second pass: replace earlier occurrences (but never touch the current turn)
  let changed = false;
  const result = messages.map((msg, msgIdx) => {
    if (msgIdx >= currentTurnIdx) return msg; // sacred boundary

    let partsChanged = false;
    const parts = msg.parts.map((part) => {
      if (!isToolPart(part) || part.state.status !== "completed") return part;
      const output = part.state.output;
      if (!output || output.length < DEDUP_MIN_CHARS) return part;

      // Check exact-match dedup: is this the latest occurrence of this content?
      const contentKey = `${part.tool}:${simpleHash(output)}`;
      const isLatestContent = contentLatest.get(contentKey) === msgIdx;

      // Check range-aware file dedup for read tools: does any later read
      // of the same file cover this read's range?
      let readRange: ReadRange | undefined;
      let coveredByLater = false;
      if (part.tool === "read_file" || part.tool === "read") {
        const inputStr =
          typeof part.state.input === "string"
            ? part.state.input
            : JSON.stringify(part.state.input);
        readRange = extractReadRange(inputStr);
        if (readRange) {
          const entries = fileReads.get(readRange.path);
          if (entries) {
            // Check if any entry with a higher message index covers this range
            for (const entry of entries) {
              if (
                entry.msgIdx > msgIdx &&
                laterReadCovers(entry.range, readRange)
              ) {
                coveredByLater = true;
                break;
              }
            }
          }
        }
      }

      // Cross-turn stability: if we already decided this exact tool part's
      // fate on a prior turn, honor it verbatim. A part sent full stays full;
      // a part collapsed stays collapsed. This prevents a newly-appended later
      // duplicate from retroactively collapsing an already-cached earlier
      // message (which would change its bytes and bust the prompt cache).
      const decisionKey = stableDecisions
        ? `${msg.info.id}:${part.id}`
        : undefined;
      const priorCollapsed = decisionKey
        ? stableDecisions?.get(decisionKey)
        : undefined;

      // Fresh decision: keep if this is both the latest content AND not covered
      // by a later read. A prior decision (when present) overrides this.
      const freshKeep = isLatestContent && !coveredByLater;
      const collapse = priorCollapsed ?? !freshKeep;

      if (decisionKey && priorCollapsed === undefined) {
        // Record the first-seen decision so it sticks on later turns.
        stableDecisions?.set(decisionKey, collapse);
      }

      if (!collapse) return part;

      // This is a duplicate — replace with compact annotation.
      // Drop structured `blocks` — the content is being compressed away.
      partsChanged = true;
      return {
        ...part,
        state: {
          ...part.state,
          output: dedupAnnotation(part.tool, readRange?.path, readRange),
          blocks: undefined,
        },
      } as LorePart;
    });

    if (!partsChanged) return msg;
    changed = true;
    return { ...msg, parts };
  });

  return changed ? result : messages;
}

// Ensure every tool part in the window has a terminal state (completed or error).
// Pending/running tool parts produce tool_use blocks at the API level but have no
// output to generate a matching tool_result — causing Anthropic to reject the request
// with "tool_use ids were found without tool_result blocks immediately after".
// This happens when a session errors mid-tool-execution (e.g. context overflow) and
// the tool part remains in pending/running state on the next transform.
// Converting to error state generates both tool_use + tool_result(is_error=true).
function sanitizeToolParts(messages: MessageWithParts[]): MessageWithParts[] {
  let changed = false;
  const result = messages.map((msg) => {
    if (msg.info.role !== "assistant") return msg;

    let partsChanged = false;
    const parts = msg.parts.map((part) => {
      if (!isToolPart(part)) return part;
      const { status } = part.state;
      if (status === "completed" || status === "error") return part;

      // pending or running → convert to error so SDK emits tool_result
      // Use a deterministic timestamp (0) instead of Date.now() so that
      // repeated transform() calls on the same stale pending part produce
      // identical bytes.  OpenCode's prompt-loop cache fix (e148f00aa)
      // preserves old pending parts across iterations; Date.now() here
      // would re-stamp them each call → different bytes → cache bust.
      partsChanged = true;
      const existingStart = "time" in part.state ? part.state.time.start : 0;
      return {
        ...part,
        state: {
          status: "error" as const,
          input: part.state.input,
          error: "[tool execution interrupted — session recovered]",
          metadata: "metadata" in part.state ? part.state.metadata : undefined,
          time: {
            start: existingStart,
            end: existingStart,
          },
        },
      } as LorePart;
    });

    if (!partsChanged) return msg;
    changed = true;
    return { ...msg, parts };
  });

  return changed ? result : messages;
}

function stripToolOutputs(parts: LorePart[]): LorePart[] {
  return parts.map((part) => {
    if (!isToolPart(part)) return part;
    if (part.state.status === "completed") {
      // Drop structured `blocks` — content is being compressed to annotation.
      return {
        ...part,
        state: {
          ...part.state,
          output: toolStripAnnotation(part.tool, part.state.output),
          blocks: undefined,
        },
      } as LorePart;
    }
    // Error outputs (e.g. large stack traces) must also be stripped under
    // aggressive (Layer 2) compression — otherwise failure-heavy turns evade
    // the strip entirely and can overflow the context.
    if (part.state.status === "error") {
      return {
        ...part,
        state: {
          ...part.state,
          error: toolStripAnnotation(part.tool, part.state.error),
          blocks: undefined,
        },
      } as LorePart;
    }
    return part;
  });
}

function _stripToTextOnly(parts: LorePart[]): LorePart[] {
  const stripped = parts
    .filter(isTextPart)
    .map((p) => ({
      ...p,
      text: normalize(stripSystemReminders(p.text)),
    }))
    .filter((p) => p.text.trim().length > 0) as LorePart[];
  // Guard against empty result — keep a placeholder so the message survives
  // toModelMessages and the conversation doesn't end with an assistant message.
  if (stripped.length === 0 && parts.length > 0) {
    const first = parts.find(isTextPart);
    if (first) return [{ ...first, text: "..." } as LorePart];
  }
  return stripped;
}

// Build synthetic user/assistant message pair wrapping formatted distillation text.
// Shared by the cached and non-cached prefix paths.
function buildPrefixMessages(formatted: string): MessageWithParts[] {
  return [
    {
      info: {
        id: "lore-distilled-user",
        sessionID: "",
        role: "user" as const,
        time: { created: 0 },
        agent: "",
        model: { providerID: "", modelID: "" },
      },
      parts: [
        {
          id: "lore-distilled-user-part",
          sessionID: "",
          messageID: "lore-distilled-user",
          type: "text" as const,
          text: "[Memory context follows — do not reference this format in your responses]",
          time: { start: 0, end: 0 },
        },
      ],
    },
    {
      info: {
        id: "lore-distilled-assistant",
        sessionID: "",
        role: "assistant" as const,
        time: { created: 0 },
        parentID: "lore-distilled-user",
        modelID: "",
        providerID: "",
        mode: "memory",
        path: { cwd: "", root: "" },
        cost: 0,
        tokens: {
          input: 0,
          output: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
      },
      parts: [
        {
          id: "lore-distilled-assistant-part",
          sessionID: "",
          messageID: "lore-distilled-assistant",
          type: "text" as const,
          text: formatted,
          time: { start: 0, end: 0 },
        },
      ],
    },
  ];
}

// --- Importance-aware distillation selection ---
//
// When a compression stage limits distillation count (distLimit < Infinity),
// selects the most valuable distillations rather than blindly taking the last N.
// Scoring: 70% recency (position in chronological order) + 30% content signal.
// Results are re-sorted chronologically after selection so the prefix cache
// (Approach C) remains byte-stable when the same distillations are selected.
//
// Content signals (lightweight keyword detection, no LLM call):
//   - Decisions: "decision"/"decided"/"chose" → +0.3
//   - Gotchas/bugs: "gotcha"/"bug"/"fix"/"error" → +0.2
//   - Architecture: "architecture"/"pattern" → +0.1
//   - Meta-distilled (gen >= 1): +0.2 (consolidation = higher value density)

const DECISION_RE = /\b(?:decision|decided|chose|chosen|agreed)\b/i;
const GOTCHA_RE =
  /\b(?:gotcha|(?:critical|known|subtle)\s+bug|broken|crash(?:ed|es)?|regression)\b/i;
const ARCH_RE =
  /\b(?:architecture|design.(?:decision|pattern)|system.design)\b/i;

function importanceBonus(d: Distillation): number {
  let bonus = 0;
  if (DECISION_RE.test(d.observations)) bonus += 0.3;
  if (GOTCHA_RE.test(d.observations)) bonus += 0.2;
  if (ARCH_RE.test(d.observations)) bonus += 0.1;
  if (d.generation >= 1) bonus += 0.2;
  return Math.min(bonus, 1.0);
}

export function selectDistillations(
  all: Distillation[],
  limit: number,
): Distillation[] {
  if (all.length <= limit) return all;

  // Always include meta distillations (gen >= 1) — they contain the
  // consolidated session history and must not be evicted by recency-weighted
  // gen-0 segments. Without this guarantee, layer 3 (distLimit=5) would drop
  // the meta in favor of 5 recent gen-0 segments, losing older context. #417.
  const meta = all.filter((d) => d.generation >= 1);
  const gen0 = all.filter((d) => d.generation === 0);
  const remainingSlots = limit - meta.length;

  // If meta entries alone fill or exceed the limit, keep them all by score.
  if (remainingSlots <= 0) {
    const maxIdx = meta.length - 1;
    const scored = meta.map((d, i) => ({
      d,
      score: (maxIdx > 0 ? i / maxIdx : 1) * 0.7 + importanceBonus(d) * 0.3,
    }));
    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => s.d)
      .sort((a, b) => a.created_at - b.created_at);
  }

  // Fill remaining slots from gen-0 by recency + importance scoring.
  const maxIdx = gen0.length - 1;
  const scored = gen0.map((d, i) => ({
    d,
    score: (maxIdx > 0 ? i / maxIdx : 1) * 0.7 + importanceBonus(d) * 0.3,
  }));
  const topGen0 = scored
    .sort((a, b) => b.score - a.score)
    .slice(0, remainingSlots)
    .map((s) => s.d);

  // Merge and re-sort chronologically (cache-safe).
  return [...meta, ...topGen0].sort((a, b) => a.created_at - b.created_at);
}

// Build a synthetic message pair containing the distilled history.
// Non-cached path — used by layers 2+ which already cause full cache invalidation.
function distilledPrefix(distillations: Distillation[]): MessageWithParts[] {
  if (!distillations.length) return [];
  const formatted = formatDistillations(distillations);
  if (!formatted) return [];
  return buildPrefixMessages(formatted);
}

// --- Approach C: Append-only distillation prefix cache ---
//
// Caches the rendered prefix text per session. When new distillations arrive,
// only renders the new rows and appends them to the cached text. This keeps
// the prefix byte-identical between distillation runs, preserving the prompt
// cache. Only meta-distillation (which rewrites gen-0 rows into gen-1) causes
// a full re-render — and that happens roughly every 80-100 turns.

type PrefixCache = {
  /** The session this cache belongs to */
  sessionID: string;
  /** ID of the last distillation row included in the cached text */
  lastDistillationID: string;
  /** Number of rows that produced the cached text */
  rowCount: number;
  /** The rendered text (used to build delta appends) */
  cachedText: string;
  /** Ready-to-use message pair */
  prefixMessages: MessageWithParts[];
  /** Token estimate of prefixMessages */
  prefixTokens: number;
};

/**
 * Return the distilled prefix messages, reusing cached content when possible.
 * Uses per-session state from sessState.prefixCache (no module-level cache).
 *
 * Cache hit  — no new rows: returns the exact same prefixMessages object
 *              (byte-identical content, prompt cache preserved).
 * Warm hit   — returns the cached prefix as-is even when new gen-0 rows were
 *              appended in the DB. Re-rendering/appending those rows would
 *              mutate messages[1].content near the front of the prompt and
 *              bust the warm Anthropic prompt cache.
 * Full reset — first call, idle resume (onIdleResume clears prefixCache), or
 *              rows were rewritten by cold-boundary meta-distillation:
 *              renders everything from scratch and folds in accumulated rows.
 */
function distilledPrefixCached(
  distillations: Distillation[],
  sessionID: string,
  sessState: SessionState,
): { messages: MessageWithParts[]; tokens: number } {
  if (!distillations.length) {
    // Freeze the *absence* of a prefix too. If the first gen-0 distillation
    // arrives while the conversation cache is warm, injecting synthetic
    // messages[0/1] would be just as cache-busting as appending to an existing
    // prefix. onIdleResume clears this empty pin so a cold turn can render it.
    sessState.prefixCache = {
      sessionID,
      lastDistillationID: "",
      rowCount: 0,
      cachedText: "",
      prefixMessages: [],
      prefixTokens: 0,
    };
    return { messages: [], tokens: 0 };
  }

  const lastRow = distillations[distillations.length - 1];
  const prefixCache = sessState.prefixCache;

  // Cache is valid when: same session, row count only grew (no rewrites),
  // and the last previously-cached row still exists at the same position.
  const cacheValid =
    prefixCache !== null &&
    prefixCache.sessionID === sessionID &&
    prefixCache.rowCount <= distillations.length &&
    (prefixCache.rowCount === 0 ||
      distillations[prefixCache.rowCount - 1]?.id ===
        prefixCache.lastDistillationID);

  if (cacheValid) {
    // Warm-session freeze: keep messages[0/1] byte-identical. New gen-0
    // distillations accumulate in the DB but are not rendered into the prefix
    // until a cold boundary clears prefixCache (idle resume / test reset). This
    // trades slight memory staleness for prompt-cache stability; recall can
    // still retrieve the newly-distilled rows if needed.
    return {
      messages: prefixCache.prefixMessages,
      tokens: prefixCache.prefixTokens,
    };
  }

  // Full re-render: first call or meta-distillation rewrote rows
  const fullText = formatDistillations(distillations);
  if (!fullText) {
    sessState.prefixCache = null;
    return { messages: [], tokens: 0 };
  }

  const messages = buildPrefixMessages(fullText);
  const tokens = messages.reduce((sum, m) => sum + estimateMessage(m), 0);
  sessState.prefixCache = {
    sessionID,
    lastDistillationID: lastRow.id,
    rowCount: distillations.length,
    cachedText: fullText,
    prefixMessages: messages,
    prefixTokens: tokens,
  };
  return { messages, tokens };
}

/**
 * Serialize the cross-turn dedup decision memo for a session to a JSON string,
 * so the host can persist it (survives gateway restarts). Returns null when the
 * session has no recorded decisions.
 */
export function exportDedupDecisions(sessionID: string): string | null {
  const state = sessionStates.get(sessionID);
  if (!state || state.dedupDecisions.size === 0) return null;
  return JSON.stringify(Array.from(state.dedupDecisions.entries()));
}

/**
 * Restore a previously-persisted dedup decision memo into a session's state.
 * Ignores malformed input (the memo is an optimization — a bad blob just means
 * the first post-restart turn re-derives decisions). Does not overwrite an
 * already-populated in-memory memo.
 */
export function importDedupDecisions(sessionID: string, json: string): void {
  const state = getSessionState(sessionID);
  if (state.dedupDecisions.size > 0) return;
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return;
    for (const entry of parsed) {
      if (
        Array.isArray(entry) &&
        typeof entry[0] === "string" &&
        typeof entry[1] === "boolean"
      ) {
        state.dedupDecisions.set(entry[0], entry[1]);
      }
    }
  } catch {
    // Corrupt blob — start fresh.
  }
}

// For testing only — reset prefix cache state for a specific session (or all)
export function resetPrefixCache(sessionID?: string) {
  if (sessionID) {
    const state = sessionStates.get(sessionID);
    if (state) state.prefixCache = null;
  } else {
    for (const state of sessionStates.values()) state.prefixCache = null;
  }
}

// For testing only — reset distillation snapshot for a specific session (or all)
export function resetDistillationSnapshot(sessionID?: string) {
  if (sessionID) {
    const state = sessionStates.get(sessionID);
    if (state) state.distillationSnapshot = null;
  } else {
    for (const state of sessionStates.values())
      state.distillationSnapshot = null;
  }
}

// --- Approach B: Lazy raw window eviction ---
//
// Tracks the ID of the first (oldest) message in the previous raw window.
// On the next turn, if the window starting at that message still fits within
// the raw budget, the cutoff is pinned — no messages are evicted and the raw
// window stays byte-identical for caching purposes. Only when the pinned
// window no longer fits (e.g. a large tool response pushed us over) is the
// cutoff allowed to advance forward by one message at a time.
//
// This eliminates the "window sliding on every turn" problem that was the
// dominant source of cache misses in gradient mode: each new turn appends a
// message to the conversation, but the start of the raw window only moves
// when it must.
//
// Reset conditions: session changes, or layer escalates to 2+ (the pinned
// window was too large even with stripping — something genuinely changed).
//
// When the pinned window overflows and we must rescan, we evict down to
// RAW_WINDOW_EVICT_TARGET of rawBudget rather than re-pinning right at the
// ceiling. A window re-pinned exactly at the budget ceiling overflows again
// after the next ~2 messages, degrading the pin into a per-turn sliding window
// that busts the prompt cache on every turn (the boundary marches forward ~2
// messages/turn). Evicting a chunk leaves headroom so the boundary stays stable
// for many turns between evictions, trading a little retained history for a
// large reduction in cache-write cost.
const RAW_WINDOW_EVICT_TARGET = 0.75;

type RawWindowCache = {
  sessionID: string;
  /** Number of raw messages (excluding prefix) in the pinned window at creation. */
  pinnedRawCount: number;
  /** Total number of messages in the input array when the pin was created.
   *  Used to compute how many new messages were appended since. */
  pinnedTotalCount: number;
  /** rawBudget that was in effect when the pin was created — used for the
   *  pin-validity check so that global budget fluctuations don't evict the pin. */
  pinnedBudget: number;
};

// For testing only — reset raw window cache state for a specific session (or all)
export function resetRawWindowCache(sessionID?: string) {
  if (sessionID) {
    const state = sessionStates.get(sessionID);
    if (state) state.rawWindowCache = null;
  } else {
    for (const state of sessionStates.values()) state.rawWindowCache = null;
  }
}

/**
 * Layer-1 tryFit with lazy eviction.
 * Uses per-session rawWindowCache from sessState (no module-level cache).
 *
 * Attempts to reuse the previous raw window cutoff before falling back to a
 * full backward scan. If the pinned window fits, returns it unchanged (same
 * message objects, byte-identical for prompt caching). If it doesn't fit,
 * delegates to the normal tryFit which finds the new minimal cutoff and
 * updates the cache.
 */
function tryFitStable(input: {
  messages: MessageWithParts[];
  prefix: MessageWithParts[];
  prefixTokens: number;
  distilledBudget: number;
  rawBudget: number;
  sessionID: string;
  sessState: SessionState;
}): Omit<
  TransformResult,
  "layer" | "usable" | "distilledBudget" | "rawBudget" | "refreshLtm"
> | null {
  // If the prefix already overflows its budget there's no point trying.
  if (input.prefixTokens > input.distilledBudget && input.prefix.length > 0)
    return null;

  const rawWindowCache = input.sessState.rawWindowCache;
  const cacheValid =
    rawWindowCache !== null && rawWindowCache.sessionID === input.sessionID;

  if (cacheValid && rawWindowCache) {
    // Compute the pinned index from the stored raw count + new message growth.
    // newMessages = messages appended since pin creation (typically 2 per turn).
    // The pinned window grows to include them: pinnedRawCount + newMessages.
    // This is resilient to front-trimming by the host (e.g. OpenCode evicting
    // old messages) because the offset is relative to the tail.
    const newMessages = Math.max(
      0,
      input.messages.length - rawWindowCache.pinnedTotalCount,
    );
    const windowSize = rawWindowCache.pinnedRawCount + newMessages;
    const pinnedIdx = Math.max(0, input.messages.length - windowSize);

    // Ensure the pinned window starts with a user message when a prefix is
    // present — the prefix ends with assistant so a leading assistant in the
    // raw window would create back-to-back assistants (#424).
    let adjustedPinnedIdx = pinnedIdx;
    if (input.prefix.length > 0) {
      while (
        adjustedPinnedIdx < input.messages.length &&
        input.messages[adjustedPinnedIdx].info.role === "assistant"
      ) {
        adjustedPinnedIdx++;
      }
    }

    // Measure the token cost of the pinned window.
    const pinnedWindow = input.messages.slice(adjustedPinnedIdx);
    const pinnedTokens = pinnedWindow.reduce(
      (sum, m) => sum + estimateMessage(m),
      0,
    );

    // Use the budget that was in effect when the pin was created with a 15%
    // hysteresis margin so that small budget fluctuations from overhead drift
    // and deduplicateToolOutputs() token-estimate changes don't evict the pin.
    // The high-water mark (max of pinned and current budgets) prevents overhead
    // EMA drift from shrinking the effective budget below what was valid when
    // the pin was created — the budget shrank due to overhead drift, not because
    // the context limit changed.
    const highWaterBudget = Math.max(
      rawWindowCache.pinnedBudget,
      input.rawBudget,
    );
    const effectiveBudget = highWaterBudget * 1.15;
    if (pinnedTokens <= effectiveBudget) {
      // Pinned window still fits within the hysteresis margin of the high-water
      // budget. Re-pin at the current budget when the old hysteresis is exceeded
      // so that next turn's check uses a fresh baseline.
      if (pinnedTokens > rawWindowCache.pinnedBudget * 1.15) {
        input.sessState.rawWindowCache = {
          ...rawWindowCache,
          pinnedRawCount: pinnedWindow.length,
          pinnedTotalCount: input.messages.length,
          pinnedBudget: input.rawBudget,
        };
      }
      // Apply system-reminder cleanup only (strip:"none" is the layer-1 mode),
      // returning the same message object references wherever nothing changed.
      const processed = pinnedWindow.map((msg) => {
        const parts = cleanParts(msg.parts);
        return parts !== msg.parts ? { info: msg.info, parts } : msg;
      });
      const total = input.prefixTokens + pinnedTokens;
      return {
        messages: [...input.prefix, ...processed],
        distilledTokens: input.prefixTokens,
        rawTokens: pinnedTokens,
        totalTokens: total,
      };
    }
    // Pinned window is too large for both budgets — fall through to rescan.
    log.info(
      `pin-overflow: session=${input.sessionID} pinnedTokens=${pinnedTokens} ` +
        `pinnedBudget=${rawWindowCache?.pinnedBudget} effectiveBudget=${Math.round(effectiveBudget)} ` +
        `currentRawBudget=${input.rawBudget} windowSize=${pinnedWindow.length}`,
    );
  }

  // Normal backward scan to find the tightest fitting cutoff. Evict down to a
  // chunk below the ceiling (rawFillBudget) so the re-pinned boundary has
  // headroom and won't overflow again on the next turn — preventing the
  // per-turn boundary march that busts the cache. The current-turn escalation
  // guard inside tryFit still uses the full rawBudget.
  //
  // Edge case: when the current turn alone is larger than rawFillBudget
  // (i.e. > 75% of rawBudget), the older-message fill collapses to ~0 and the
  // window keeps only the current turn — so a session whose every turn is that
  // large can still march. That's an extreme regime (the old full-budget rescan
  // also degraded, just at the 100% boundary); higher layers (tool stripping)
  // take over when even the current turn doesn't fit the full rawBudget.
  const result = tryFit({
    messages: input.messages,
    prefix: input.prefix,
    prefixTokens: input.prefixTokens,
    distilledBudget: input.distilledBudget,
    rawBudget: input.rawBudget,
    rawFillBudget: Math.floor(input.rawBudget * RAW_WINDOW_EVICT_TARGET),
    strip: "none",
  });

  if (result) {
    // Update the raw window cache: store the raw message count and total message
    // count so we can reconstruct the window position on the next turn even after
    // front-trimming by the host (e.g. OpenCode evicting old messages).
    // Snapshot the current rawBudget so future pin checks use the budget that
    // was in effect when this window was chosen (Option 1: snapshot isolation).
    const rawMessageCount = result.messages.length - input.prefix.length;
    if (rawMessageCount > 0) {
      input.sessState.rawWindowCache = {
        sessionID: input.sessionID,
        pinnedRawCount: rawMessageCount,
        pinnedTotalCount: input.messages.length,
        pinnedBudget: input.rawBudget,
      };
    }
  }

  return result;
}

export type SafetyLayer = 0 | 1 | 2 | 3 | 4;

// --- Compression stage table ---
// Defines the escalation path for layers 1-3. Each stage tries increasingly
// aggressive compression: tool stripping, tighter budgets, distillation trimming.
// Adding a new intermediate stage = one table entry.
type CompressionStage = {
  strip: "none" | "old-tools" | "all-tools";
  rawFrac: number | null; // fraction of usable; null = use default rawBudget
  distFrac: number | null; // fraction of usable; null = use default distilledBudget
  distLimit: number; // Infinity = all, 5 = last 5, etc.
  protectedTurns: number; // turns exempt from tool stripping
  useStableWindow: boolean; // use tryFitStable (Approach B pin cache)
};

const COMPRESSION_STAGES: CompressionStage[] = [
  {
    strip: "none",
    rawFrac: null,
    distFrac: null,
    distLimit: Infinity,
    protectedTurns: 0,
    useStableWindow: true,
  },
  {
    strip: "old-tools",
    rawFrac: 0.5,
    distFrac: null,
    distLimit: Infinity,
    protectedTurns: 2,
    useStableWindow: false,
  },
  {
    strip: "all-tools",
    rawFrac: 0.55,
    distFrac: 0.15,
    distLimit: 5,
    protectedTurns: 0,
    useStableWindow: false,
  },
];

export type TransformResult = {
  messages: MessageWithParts[];
  layer: SafetyLayer;
  distilledTokens: number;
  rawTokens: number;
  totalTokens: number;
  // Budget context (for display in context inspector)
  usable: number;
  distilledBudget: number;
  rawBudget: number;
  // Signals that the pipeline should re-run forSession() to refresh LTM
  // relevance scoring. Set on Layer 4 (emergency) where the context is
  // fully reset and mid-session knowledge may have changed relevance.
  refreshLtm: boolean;
  /** Number of consecutive cache busts detected for this session at the time
   *  of this transform. Surfaced so callers (and the bust-spiral detection in
   *  transform()) can observe the current bust pressure. */
  consecutiveBusts?: number;
};

// Per-session urgent distillation tracking.
// Keyed by sessionID. Set by layer returns in transformInner(),
// consumed (read + delete) by needsUrgentDistillation(sessionID).
const urgentDistillationMap = new Map<string, boolean>();
let urgentDistillationEnabled = true;

export function setUrgentDistillationEnabledForTest(enabled: boolean): void {
  urgentDistillationEnabled = enabled;
  if (!enabled) urgentDistillationMap.clear();
}

export function needsUrgentDistillation(sessionID: string): boolean {
  const v = urgentDistillationMap.get(sessionID) ?? false;
  urgentDistillationMap.delete(sessionID);
  return v;
}

/**
 * Layer-0 sizing for a given expected input. Single source of truth shared by
 * transformInner() (the layer decision) and isLargeColdStart() (the pipeline's
 * turn-1 LTM-injection decision) so the two never diverge. Reads the
 * module-global model limits set per-request by the host before transform().
 * (issue #796)
 */
function layer0Bounds(
  expectedInput: number,
  calibrated: boolean,
  sid: string | undefined,
): { layer0Input: number; layer0Ceiling: number } {
  const maxInput = contextLimit - outputReserved;
  // chars/3 undercounts by ~1.63x on real sessions — without this an
  // uncalibrated session estimated at 146K passes Layer 0 but actually costs
  // 214K → overflow.
  const layer0Input = calibrated
    ? expectedInput
    : expectedInput * UNCALIBRATED_SAFETY;
  // Cost-aware cap: smaller of the API limit and the cost-derived cap
  // (0 = disabled → pure maxInput).
  let layer0Ceiling =
    maxLayer0Tokens > 0 ? Math.min(maxInput, maxLayer0Tokens) : maxInput;
  // Cold-cache awareness: the entire context is a cache WRITE on an
  // uncalibrated turn — tighten the cap to 70% to reduce cold-write cost.
  if (!calibrated && layer0Ceiling < maxInput) {
    layer0Ceiling = Math.floor(layer0Ceiling * 0.7);
  }
  // Free-write / non-caching: no expensive write to avoid → compress earlier.
  if (sid && isFreeWriteSession(sid)) {
    layer0Ceiling = Math.min(
      layer0Ceiling,
      Math.floor(maxInput * FREE_WRITE_LAYER0_FRACTION),
    );
  }
  return { layer0Input, layer0Ceiling };
}

/**
 * Will an uncalibrated (first-sight) session of this size be forced to skip
 * Layer-0 passthrough and compress on its cold turn? Pure, read-only.
 *
 * Used by the gateway pipeline to decide whether to inject context-bound LTM
 * (system[2]) on turn 1 for an already-large resumed session instead of
 * deferring to turn 2. Returns false once the session is calibrated
 * (lastKnownInput > 0) — by then the normal per-turn logic applies.
 *
 * Shares layer0Bounds() with transformInner, so the caller can make the two
 * agree EXACTLY: pass `ltmTokens` = the LTM tokens that will be set for this
 * turn when system[2] is NOT injected (i.e. the stable/preference block only).
 * Then on a "not large" result the pipeline skips system[2] and calls
 * setLtmTokens(stableOnly), so transformInner's expectedInput equals the value
 * tested here — no decision-vs-compression drift band. (#796)
 */
export function isLargeColdStart(input: {
  messages: MessageWithParts[];
  sessionID?: string;
  /** Override the session's in-flight LTM token count (see docstring). */
  ltmTokens?: number;
}): boolean {
  const sid = input.sessionID ?? input.messages[0]?.info.sessionID;
  const sessState = sid ? getSessionState(sid) : makeSessionState();
  if (sessState.lastKnownInput > 0) return false;
  const overhead = getOverhead();
  const sessLtmTokens =
    input.ltmTokens ?? (sid ? sessState.ltmTokens : ltmTokensFallback);
  const expectedInput =
    estimateMessages(input.messages) + overhead + sessLtmTokens;
  const { layer0Input, layer0Ceiling } = layer0Bounds(
    expectedInput,
    false,
    sid,
  );
  return layer0Input > layer0Ceiling;
}

function transformInner(input: {
  messages: MessageWithParts[];
  projectPath: string;
  sessionID?: string;
}): TransformResult {
  const cfg = config();
  const overhead = getOverhead();

  // --- Session state (must precede budget computation) ---
  const sid = input.sessionID ?? input.messages[0]?.info.sessionID;
  const sessState = sid ? getSessionState(sid) : makeSessionState();

  // Usable = full context minus output reservation minus fixed overhead (system + tools)
  // minus LTM tokens already injected into the system prompt this turn.
  // Read LTM tokens from per-session state to avoid cross-session contamination.
  //
  // NOTE: `usable` is sensitive to BOTH `contextLimit` (set per-turn from the
  // model spec, which can climb as models.dev data warms from a cold fallback)
  // and `overhead` (a shared EMA from calibrate()). Anything derived as a
  // fraction of `usable` — e.g. distilled/raw budgets — therefore scales with a
  // large context window. Downstream economic decisions must not treat such a
  // budget as the real compressed size (see the tier gate's compressedEstimate
  // clamp below).
  const sessLtmTokens = sid ? sessState.ltmTokens : ltmTokensFallback;
  const usableRaw = Math.max(
    0,
    contextLimit - outputReserved - overhead - sessLtmTokens,
  );

  // No EMA-driven adaptive cap — use the full available context budget.
  // The layer-0 cap (maxLayer0Tokens) still applies for per-turn read cost,
  // and tier-based bust-vs-continue decisions control whether to compress
  // at quality boundaries.
  const usable = usableRaw;

  const distilledBudget = Math.floor(usable * cfg.budget.distilled);
  // Base raw budget. May be overridden below for post-idle compact mode.
  let rawBudget = Math.floor(usable * cfg.budget.raw);

  // --- Escalated-stage budget ceiling (layers 2-3 only) ---
  // The ESCALATED compression stages (layer 2: rawFrac 0.5; layer 3: rawFrac
  // 0.55) size their raw/distilled windows as a fraction of `usable`. On a
  // high-context model (e.g. a 1M-token opus → usable ~800K) `usable * 0.5` ≈
  // 400K — far LARGER than the ~200K cost cap (maxLayer0Tokens) whose breach
  // triggered compression, AND larger than the layer-1 window itself. So
  // escalating to a "more aggressive" layer paradoxically GREW the context,
  // unbounded, until the model's real limit overflowed. (This wedged session
  // 0AVWKugtmhBKqLOX9 at layer 2: layer-1 200K → layer-2 356K → 461K, then
  // "prompt is too long".) Clamp the ESCALATED-stage budgets to the layer-0
  // cost ceiling so each higher layer actually shrinks the window toward the
  // cap. NOTE: the layer-1 stable window (stage 0, rawFrac=null) deliberately
  // keeps the full `usable * raw` budget — the cost cap governs WHEN to
  // compress, not the layer-1 window size, and shrinking it would defeat the
  // cache-stable raw-window pin (its chunked eviction needs headroom).
  //   - maxLayer0Tokens === 0 (cost cap disabled): stageBudgetUsable === usable,
  //     a no-op preserving the explicit "use the model's full context" opt-out.
  //   - small-context models: usable < ceiling, so this is also a no-op.
  const stageBudgetCeiling =
    maxLayer0Tokens > 0
      ? Math.min(contextLimit - outputReserved, maxLayer0Tokens)
      : contextLimit - outputReserved;
  const stageBudgetUsable = Math.min(usable, stageBudgetCeiling);

  // --- Force escalation (reactive error recovery) ---
  // When the API previously rejected with "prompt is too long", skip layers
  // below the forced minimum to ensure enough trimming on the next attempt.
  // One-shot: consumed here and reset to 0 (both in-memory and on disk).
  let effectiveMinLayer = sessState.forceMinLayer;
  sessState.forceMinLayer = 0;
  if (sid && effectiveMinLayer > 0) saveForceMinLayer(sid, 0);

  // --- Approach A: Cache-preserving passthrough ---
  // Use exact token count from the previous API response when available.
  // Only the delta (messages added since last call) uses chars/3 estimation,
  // making the layer-0 decision highly accurate from the API's own tokenizer.
  // maxInput = absolute ceiling the API enforces: input_tokens + max_tokens <= context
  const maxInput = contextLimit - outputReserved;

  // True when we have real API token data from a previous turn in this session.
  // When false (first turn / session change), chars/3 estimates may still diverge
  // from the real tokenizer — so tryFit output must be validated with a safety
  // multiplier before being used.
  const calibrated = sessState.lastKnownInput > 0;

  // Hard ceiling: never allow layer-0 passthrough within 5% of maxInput,
  // regardless of calibration accuracy or economic analysis.  The estimation
  // error on calibrated deltas can be 5-10K tokens, and maxInput is a hard
  // API limit — exceeding it causes an unrecoverable 400.
  const HARD_CEILING_MARGIN = 0.95;

  // Returns true if a rebuilt compression-stage window is safe to ship.
  //
  // A rebuilt window's `totalTokens` is a FRESH chars/3 estimate of the WHOLE
  // window — it is NOT anchored to the API's last real count the way the
  // layer-0 delta path (expectedInput = lastKnownInput + delta) is. So being
  // "calibrated" does NOT make a rebuilt window exact: chars/3 undercounts the
  // real tokenizer ~1.5-3x. Previously this returned `true` unconditionally for
  // calibrated sessions, so a stage whose real size exceeded the model's
  // context window was shipped anyway → unrecoverable "prompt is too long"
  // (this, with the unclamped budgets, wedged session 0AVWKugtmhBKqLOX9).
  //
  // Validate every rebuilt window — calibrated or not — against the hard API
  // ceiling with the same undercount safety multiplier. Rejecting an
  // over-ceiling stage makes the loop escalate to a tighter layer (ultimately
  // the always-returns emergency tail) instead of overflowing the model. This
  // is only the stage-loop acceptance gate (the layer-0 / tier-gate paths use
  // their own `maxInput * HARD_CEILING_MARGIN` checks against expectedInput).
  //
  // The layer-1 stable window is effectively bounded to ~0.65*usable (prefix
  // 0.25 + raw 0.4), so `total * 1.5 = 0.975*usable <= maxInput` and layer 1
  // is never falsely rejected in the normal regime. The stable-window
  // hysteresis (up to 1.15x raw) can push the worst case to ~0.71*usable, which
  // exceeds maxInput only when overhead+LTM is a tiny (<~6%) slice of the
  // window — and in that regime the real (1.5x) size genuinely approaches the
  // ceiling, so escalating one layer is the correct, safe response, not a
  // spurious reject.
  function fitsWithSafetyMargin(
    result: { totalTokens: number } | null,
  ): boolean {
    if (!result) return false;
    return result.totalTokens * UNCALIBRATED_SAFETY <= maxInput;
  }

  // --- Sticky layer guard (Option C) ---
  // After a compressed turn (layer >= N), don't allow re-entry below N until
  // the session genuinely shrinks (e.g. after compaction deletes messages).
  // Prevents calibration oscillation AND layer-transition cache busts:
  //   - 0→1→0: compressed turn stores lastKnownInput=100K for a 50-message
  //     window, next turn's 300 raw messages produce an undercounted
  //     expectedInput that "fits" in layer 0 but actually overflows.
  //   - 1→2→1: layer 2 strips tool outputs (different bytes), bouncing back
  //     to layer 1 restores them (different bytes again) → two busts.
  // Pinning to the *actual* last layer prevents all downward oscillation.
  // Only applied when calibrated (same session, per-session state) to avoid
  // affecting other sessions including worker sessions.
  // Layer 4 (emergency) already blows the cache — stickiness there just traps
  // the session at emergency permanently. Only apply stickiness for layers 1-3
  // where dropping back would bust a warm cache.
  if (
    calibrated &&
    sessState.lastLayer >= 1 &&
    sessState.lastLayer <= 3 &&
    input.messages.length >= sessState.lastKnownMessageCount
  ) {
    effectiveMinLayer = Math.max(
      effectiveMinLayer,
      sessState.lastLayer,
    ) as SafetyLayer;
  }

  // --- Prefix-present floor (no Layer-0 re-entry once compressed) ---
  // Once a session has compressed (reached Layer >= 1), the distilled prefix is
  // injected at messages[0]/[1]. Dropping back to Layer 0 omits the prefix —
  // messages[0] changes → full prompt-cache front-bust; the reverse re-injects
  // it → bust again (0<->N thrash). The strong sticky guard above pins to the
  // FULL lastLayer, but only for lastLayer 1-3 AND only while `calibrated`.
  //
  // For a CALIBRATED 1-3 session this floor's condition equals the sticky
  // guard's (both gate on `messages.length >= lastKnownMessageCount`), so here
  // it is pure defense-in-depth. Its GENUINELY NEW coverage is the two gaps the
  // sticky guard leaves open — exactly where the production front-busts occur:
  //   (1) lastLayer === 4 (genuine emergency overflow) — excluded by `<= 3`.
  //   (2) a compressed-but-UNCALIBRATED session (lastKnownInput == 0, so
  //       `calibrated` is false): the API call hasn't established a token count
  //       yet (first compressed turn whose call failed before calibrate, or a
  //       resume/restart before the first calibrate of this process). The sticky
  //       guard is skipped entirely; without this floor the layer-0 fit and the
  //       tier-based bust-vs-continue gate (both gated on effectiveMinLayer===0)
  //       pass the session through at Layer 0 and vanish the prefix.
  // The floor pins to >= Layer 1 ONLY (prefix PRESENT) — NEVER higher, so it
  // never traps the session at an emergency layer. It is released only on a
  // GENUINE compaction: the host shrank the conversation below the last-known
  // window (and that window is known, i.e. > 0 — so a fresh process with
  // lastKnownMessageCount=0 does not spuriously release; it relies on the
  // DB-restored lastLayer to hold the floor until the live count is set).
  if (
    prefixPresentFloorApplies(
      sessState.lastLayer,
      input.messages.length,
      sessState.lastKnownMessageCount,
    )
  ) {
    effectiveMinLayer = Math.max(effectiveMinLayer, 1) as SafetyLayer;
  }

  // --- Post-idle compact layer ---
  // When the cache just went cold (onIdleResume fired), skip layer 0 full-raw
  // passthrough and use a tighter raw budget. Rationale: the entire context is
  // a cache WRITE regardless — a smaller total costs less to write, and
  // aggressive idle distillation already captured older history in the prefix.
  // The flag is one-shot: consumed here and reset so subsequent turns use
  // normal budgets once the cache is warm.
  const postIdleCompact = sessState.postIdleCompact;
  if (postIdleCompact) {
    sessState.postIdleCompact = false;
    // Skip layer 0 — don't pass through all raw messages on a cold cache.
    effectiveMinLayer = Math.max(effectiveMinLayer, 1) as SafetyLayer;
    // Use a tighter raw budget on cold cache to limit write cost.
    rawBudget = Math.floor(usable * 0.2);
    log.info(
      `post-idle compact: session=${sid} rawBudget=${rawBudget}` +
        ` (${Math.floor(usable * cfg.budget.raw)}→${rawBudget})`,
    );
  }

  let expectedInput: number;
  if (calibrated) {
    // Exact approach: prior API count + estimate of only genuinely new messages.
    // Use message ID tracking (Option B) to identify new messages accurately.
    // After compression, the "last window" is a subset of the full message array —
    // counting by index would treat evicted messages as new (off-by-250 error).
    // Safety multiplier for the delta portion of the calibrated estimate.
    // The base (lastKnownInput) is exact from the API, but new messages use
    // chars/3 which undercounts by ~1.68x.  Calibrated overhead captures most
    // of the structural gap, but the per-message content gap remains ~20-30%.
    // 1.3 covers this without triggering unnecessary compression.
    const CALIBRATED_DELTA_SAFETY = 1.3;

    const newMessages =
      sessState.lastWindowMessageIDs.size > 0
        ? input.messages.filter(
            (m) => !sessState.lastWindowMessageIDs.has(m.info.id),
          )
        : input.messages.slice(
            -Math.max(
              0,
              input.messages.length - sessState.lastKnownMessageCount,
            ),
          );
    const rawNewMsgTokens = newMessages.reduce(
      (s, m) => s + estimateMessage(m),
      0,
    );
    const newMsgTokens = Math.ceil(rawNewMsgTokens * CALIBRATED_DELTA_SAFETY);
    const ltmDelta = sessLtmTokens - sessState.lastKnownLtm;
    expectedInput = sessState.lastKnownInput + newMsgTokens + ltmDelta;
  } else {
    // First turn or session change: fall back to chars/3 estimate + overhead.
    const messageTokens = input.messages.reduce(
      (s, m) => s + estimateMessage(m),
      0,
    );
    expectedInput = messageTokens + overhead + sessLtmTokens;
  }

  // Layer-0 sizing (input estimate + ceiling). Extracted to layer0Bounds() so
  // the pipeline's turn-1 LTM decision (isLargeColdStart) shares ONE definition
  // with the layer choice here — a disagreement would re-introduce a bust. (#796)
  const { layer0Input, layer0Ceiling } = layer0Bounds(
    expectedInput,
    calibrated,
    sid,
  );

  // Record the gradient's own full-body size estimate so the shared cache-
  // economics evaluator (and therefore the warmer) read identical sizes from one
  // place. `cacheSizeCompressed` is set AUTHORITATIVELY from the actual rebuilt
  // window at the single transform() exit (issue #881) — see transform() — so it
  // is correct on EVERY layer path (including layer >= 1 sessions held by the
  // sticky/prefix-floor/post-idle/first-sight-large guards, which bypass the tier
  // gate below). Seed it to full here as the no-compaction default; the exit
  // overwrites it with the real compressed size whenever result.layer >= 1.
  if (sid) {
    sessState.cacheSizeFull = Math.max(0, Math.round(layer0Input));
    sessState.cacheSizeCompressed = sessState.cacheSizeFull;
    // Capture the inputs transform() needs to lift the compressed size onto the
    // same INPUT scale as cacheSizeFull (issue #886): the non-message floor
    // (overhead + LTM, which compaction never removes) and the safety factor
    // layer0Bounds applied to cacheSizeFull (1 when calibrated, else
    // UNCALIBRATED_SAFETY). Stored un-inflated; transform() inflates both the
    // floor and the rebuilt-window body together via computeCompressedCacheSize.
    sessState.cacheNonBodyTokens = Math.max(0, overhead + sessLtmTokens);
    sessState.cacheBodySafety = calibrated ? 1 : UNCALIBRATED_SAFETY;
  }

  // First-sight large session → skip the Layer-0 cold full-write. An
  // uncalibrated session already over the Layer-0 ceiling is a resumed
  // conversation Lore hasn't tracked in-process. Passing it through at Layer 0
  // writes the entire raw body on a cold cache; the next (calibrated) turn then
  // re-windows to Layer 1 (a second full write), and LTM injection adds a third
  // (system[2]) bust. Compressing now collapses all of that into the single
  // unavoidable cold write. Mirrors postIdleCompact's "cache write regardless"
  // rationale: the tier gate's continue-at-Layer-0 economics assume a WARM
  // cache, which does not exist on a cold turn. (issue #796)
  if (!calibrated && layer0Input > layer0Ceiling) {
    effectiveMinLayer = Math.max(effectiveMinLayer, 1) as SafetyLayer;
  }

  if (
    effectiveMinLayer === 0 &&
    layer0Input <= layer0Ceiling &&
    layer0Input <= maxInput * HARD_CEILING_MARGIN
  ) {
    // All messages fit — return unmodified to preserve append-only prompt-cache pattern.
    // Raw messages are strictly better context than lossy distilled summaries.
    const messageTokens = calibrated
      ? expectedInput - (sessLtmTokens - sessState.lastKnownLtm) // approximate raw portion
      : expectedInput - overhead - sessLtmTokens;
    return {
      messages: input.messages,
      layer: 0,
      distilledTokens: 0,
      rawTokens: Math.max(0, messageTokens),
      totalTokens: Math.max(0, messageTokens),
      usable,
      distilledBudget,
      rawBudget,
      refreshLtm: false,
    };
  }

  // --- Tier-based bust-vs-continue gate ---
  // When expectedInput exceeds the layer-0 cap but still fits in the model's
  // context window, check whether compression is economically justified.
  // If not (bust cost ≥ 85% of continue cost), skip compression and pass
  // through at layer 0 — the cache reads are cheap enough to justify the
  // larger context, and raw messages are better quality than distilled.
  if (
    effectiveMinLayer === 0 &&
    layer0Input > layer0Ceiling &&
    layer0Input <= maxInput * HARD_CEILING_MARGIN &&
    sid
  ) {
    const busts = getSessionState(sid).consecutiveBusts;
    const freeWrite = isFreeWriteSession(sid);
    // For compression, estimate the compressed size as the layer-1 budget
    // (distilled + raw fractions). This is a rough upper bound — actual
    // compressed output may be smaller.
    //
    // Clamp to layer0Ceiling (the cost-aware layer-0 cap, ~l0cap): the raw
    // distilled+raw budget is scaled off `usable`, which for high-context
    // models (e.g. a 1M-token opus → usable ~957K) inflates the estimate to
    // ~0.65*usable (~620K) — far larger than what compression actually yields
    // (it targets layer0Ceiling, ~200K). Feeding the inflated figure to
    // shouldCompress() makes bustCost dwarf continueCost, so the gate refuses
    // to compress every turn — even under sustained-bust write-rate repricing —
    // and the raw context grows unbounded until the hard ceiling. Clamping to
    // the real compression target makes the economics reflect reality.
    const compressedEstimate = Math.min(
      distilledBudget + rawBudget,
      layer0Ceiling,
    );
    // NOTE: `cacheSizeCompressed` is NOT set here. It used to be refined to
    // `compressedEstimate` at this point, but (a) when shouldCompress() below
    // returns false the session stays at layer 0 with NO compaction, so leaving
    // compressed < full wrongly implied savings, and (b) it covered only this
    // layer-0 gate. transform() now sets it authoritatively from the actual
    // rebuilt window on every layer path (issue #881). `compressedEstimate` is
    // still the input to shouldCompress() (the bust-vs-continue decision).
    if (
      !shouldCompress(Math.round(layer0Input), compressedEstimate, busts, {
        freeWrite,
      })
    ) {
      const messageTokens = calibrated
        ? expectedInput - (sessLtmTokens - sessState.lastKnownLtm)
        : expectedInput - overhead - sessLtmTokens;
      log.info(
        `tier gate: session=${sid} skipping compression — bustCost not justified` +
          ` (input=${Math.round(layer0Input)} compressed=${compressedEstimate} busts=${busts})`,
      );
      return {
        messages: input.messages,
        layer: 0,
        distilledTokens: 0,
        rawTokens: Math.max(0, messageTokens),
        totalTokens: Math.max(0, messageTokens),
        usable,
        distilledBudget,
        rawBudget,
        refreshLtm: false,
        consecutiveBusts: busts,
      };
    }
  }

  // --- Gradient mode: context exhausted (or force-escalated), compress older messages ---

  // Pre-pass: deduplicate repeated tool outputs before layer selection.
  // Keeps only the latest occurrence of each unique output, replacing earlier
  // ones with compact annotations. This can save thousands of tokens for sessions
  // with repeated file reads, potentially avoiding escalation to higher layers.
  const turnStart = currentTurnStart(input.messages);
  // Pass the per-session decision memo so dedup stays byte-stable across turns
  // (an already-sent output keeps its full/collapsed form). Only when we have a
  // session to scope the memo to.
  const dedupMessages = deduplicateToolOutputs(
    input.messages,
    turnStart,
    sid ? sessState.dedupDecisions : undefined,
  );

  const distillations = sid
    ? loadDistillationsCached(input.projectPath, sid, input.messages, sessState)
    : [];

  // Layer 1 uses the append-only cached prefix (Approach C) to keep the
  // distilled content byte-identical between distillation runs, preserving
  // the prompt cache. Layers 2+ already cause full cache invalidation via
  // tool stripping / message restructuring, so they use the non-cached path.
  const cached = sid
    ? distilledPrefixCached(distillations, sid, sessState)
    : (() => {
        const msgs = distilledPrefix(distillations);
        return {
          messages: msgs,
          tokens: msgs.reduce((sum, m) => sum + estimateMessage(m), 0),
        };
      })();

  // --- Compression stages (layers 1-3) ---
  // Data-driven table replaces three hardcoded layer blocks. Each stage
  // escalates tool stripping and/or tightens distillation budgets.
  // Stage 0 (layer 1): stable window (Approach B), no stripping
  // Stage 1 (layer 2): strip old tool outputs, protect last 2 turns
  // Stage 2 (layer 3): strip ALL tool outputs, keep only 5 distillations
  for (let s = 0; s < COMPRESSION_STAGES.length; s++) {
    const stageLayer = (s + 1) as SafetyLayer;
    if (effectiveMinLayer > stageLayer) continue;

    const stage = COMPRESSION_STAGES[s];
    // Budget scaling by layer:
    //   - Layer 1 (stage 0): keep the FULL unclamped base budgets (usable*raw,
    //     usable*distilled). The cost cap governs WHEN to compress, not the
    //     layer-1 window size; clamping it would starve the cache-stable
    //     raw-window pin (its chunked eviction needs headroom).
    //   - Escalated layers (2-3): clamp BOTH raw AND distilled to the layer-0
    //     cost ceiling (`stageBudgetUsable`). On a 1M-token model `usable*0.5`
    //     ≈ 400K — far LARGER than the ~200K cap that triggered compression AND
    //     larger than the layer-1 window — so escalating GREW the context until
    //     the model overflowed (wedged session 0AVWKugtmhBKqLOX9). Both
    //     dimensions must be clamped: clamping only raw still lets the distilled
    //     prefix balloon to usable*0.25 (~242K on 1M), so the total would not
    //     actually shrink toward the cap. A null fraction on an escalated stage
    //     (e.g. layer 2's distFrac) falls back to the configured base fraction,
    //     still clamped to the ceiling.
    const isEscalated = stageLayer > 1;
    const stageRawBudget = isEscalated
      ? Math.floor(stageBudgetUsable * (stage.rawFrac ?? cfg.budget.raw))
      : rawBudget;
    const stageDistBudget = isEscalated
      ? Math.floor(stageBudgetUsable * (stage.distFrac ?? cfg.budget.distilled))
      : distilledBudget;

    // Determine prefix: if distLimit is finite, re-render with trimmed distillations.
    // Otherwise use the cached prefix (Approach C, byte-identical for cache).
    let stagePrefix = cached.messages;
    let stagePrefixTokens = cached.tokens;
    let stageDistillations = distillations;
    if (
      stage.distLimit !== Infinity &&
      distillations.length > stage.distLimit
    ) {
      stageDistillations = selectDistillations(distillations, stage.distLimit);
      stagePrefix = distilledPrefix(stageDistillations);
      stagePrefixTokens = stagePrefix.reduce(
        (sum, m) => sum + estimateMessage(m),
        0,
      );
    }

    // Budget-aware prefix trim: if the rendered prefix still exceeds this
    // stage's distilled budget, drop gen-0 distillations (selectDistillations
    // always preserves meta/gen>=1) until it fits — instead of handing tryFit
    // an over-budget prefix, which returns null and escalates the layer. A
    // meta-distillation rewrite forces a full re-render (cacheValid=false) whose
    // size can blow past every stage's budget, falling through to emergency
    // Layer 4 even when the session has ample headroom (the distilled-prefix
    // front-bust). Trimming keeps the session at a compressed layer (1-3) with
    // the prefix PRESENT, so messages[0] stays byte-stable across turns.
    // NOTE: on a STEADY warm turn (unchanged budget) the cached prefix already
    // fits, so this block does not fire and messages[0/1] stay byte-identical.
    // It CAN fire on the warm path when stageDistBudget contracts below the
    // frozen prefix (usable / LTM / overhead-EMA drift) — re-rendering a smaller
    // prefix and busting the front once. That is still strictly better than the
    // pre-fix behavior in that case, which fell through to emergency Layer 4 and
    // then thrashed 0<->4 (a front-bust every other turn); here we re-stabilize
    // at a compressed layer immediately. Edge case: if even meta (gen>=1) entries
    // alone exceed the budget, the search converges to an empty prefix (dropping
    // meta) rather than escalating — preferable to a Layer-4 fallthrough.
    if (stagePrefixTokens > stageDistBudget && stageDistillations.length > 0) {
      let lo = 0;
      let hi = stageDistillations.length;
      // Largest count whose rendered prefix fits stageDistBudget (binary search).
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        const candidate = selectDistillations(stageDistillations, mid);
        const tokens = distilledPrefix(candidate).reduce(
          (sum, m) => sum + estimateMessage(m),
          0,
        );
        if (tokens <= stageDistBudget) lo = mid;
        else hi = mid - 1;
      }
      const fitted = selectDistillations(stageDistillations, lo);
      stagePrefix = distilledPrefix(fitted);
      stagePrefixTokens = stagePrefix.reduce(
        (sum, m) => sum + estimateMessage(m),
        0,
      );
    }

    // Stage 0 (layer 1) uses tryFitStable for Approach B pin cache.
    // Higher stages reset the raw window cache and use plain tryFit.
    let result: Omit<
      TransformResult,
      "layer" | "usable" | "distilledBudget" | "rawBudget" | "refreshLtm"
    > | null;
    if (stage.useStableWindow && sid) {
      result = tryFitStable({
        messages: dedupMessages,
        prefix: stagePrefix,
        prefixTokens: stagePrefixTokens,
        distilledBudget: stageDistBudget,
        rawBudget: stageRawBudget,
        sessionID: sid,
        sessState,
      });
    } else {
      // Reset raw window cache when leaving stage 0 — higher stages use full
      // scans and already break the prompt cache. Must fire even when stage 1
      // is skipped via effectiveMinLayer (e.g. forceMinLayer = 3).
      sessState.rawWindowCache = null;
      result = tryFit({
        messages: dedupMessages,
        prefix: stagePrefix,
        prefixTokens: stagePrefixTokens,
        distilledBudget: stageDistBudget,
        rawBudget: stageRawBudget,
        strip: stage.strip,
        protectedTurns: stage.protectedTurns,
      });
    }

    if (result && fitsWithSafetyMargin(result)) {
      // Trigger urgent distillation when: (a) higher stages always need it, or
      // (b) stage 0 with no distillations = first time in gradient mode.
      if (urgentDistillationEnabled && sid && (s > 0 || cached.tokens === 0)) {
        urgentDistillationMap.set(sid, true);
      }
      return {
        ...result,
        layer: stageLayer,
        usable,
        distilledBudget,
        rawBudget,
        refreshLtm: false,
        consecutiveBusts: sid ? getSessionState(sid).consecutiveBusts : 0,
      };
    }
  }

  // All compression stages exhausted — reset raw window cache before emergency.
  sessState.rawWindowCache = null;

  // Layer 4: Emergency — last 2 distillations + token-budget raw tail.
  // We do NOT strip tool parts here: doing so would cause an infinite tool-call loop because
  // the model would lose sight of its own in-progress tool calls and re-invoke them endlessly.
  // Instead, we aggressively drop old messages and rely on the `recall` tool (which the model
  // is always instructed to use) to retrieve any older details it needs.
  //
  // Token-budget tail (F7): instead of a fixed `slice(-3)`, size the raw
  // tail using `clamp(usable * 0.25, 2_000, 8_000)` tokens — matching
  // upstream OpenCode's tail-budget formula for compaction. The current
  // agentic turn (from `currentTurnStart()`) is ALWAYS fully included even
  // if it alone exceeds the tail budget — layer 4 is the terminal layer
  // and must always return. Remaining budget is filled backward with older
  // messages.
  if (urgentDistillationEnabled && sid) urgentDistillationMap.set(sid, true);
  const nuclearDistillations = selectDistillations(distillations, 2);
  const nuclearPrefix = distilledPrefix(nuclearDistillations);
  const nuclearPrefixTokens = nuclearPrefix.reduce(
    (sum, m) => sum + estimateMessage(m),
    0,
  );

  // Token budget for the raw tail. clamp(usable * 0.25, 2K, 8K).
  const tailBudget = Math.max(
    2_000,
    Math.min(8_000, Math.floor(usable * 0.25)),
  );

  // Current turn is always included (non-negotiable — dropping it causes
  // the infinite tool-call loop). Clean parts but never strip tool outputs.
  const nuclearTurnStart = currentTurnStart(input.messages);
  const currentTurn = input.messages.slice(nuclearTurnStart).map((m) => ({
    info: m.info,
    parts: cleanParts(m.parts),
  }));
  const currentTurnTokens = currentTurn.reduce(
    (sum, m) => sum + estimateMessage(m),
    0,
  );

  // Fill remaining budget walking backward from the turn boundary.
  const olderMessages: MessageWithParts[] = [];
  let olderTokens = 0;
  const remaining = Math.max(0, tailBudget - currentTurnTokens);
  for (let i = nuclearTurnStart - 1; i >= 0 && olderTokens < remaining; i--) {
    const msg = input.messages[i];
    const est = estimateMessage(msg);
    if (olderTokens + est > remaining) break;
    olderMessages.unshift({
      info: msg.info,
      parts: cleanParts(msg.parts),
    });
    olderTokens += est;
  }

  // Ensure role alternation at the prefix/raw boundary: drop leading assistant
  // messages from the older tail so the raw window starts with user (#424).
  while (
    olderMessages.length > 0 &&
    nuclearPrefix.length > 0 &&
    olderMessages[0].info.role === "assistant"
  ) {
    olderTokens -= estimateMessage(olderMessages[0]);
    olderMessages.shift();
  }

  const nuclearRaw = [...olderMessages, ...currentTurn];
  const nuclearRawTokens = olderTokens + currentTurnTokens;

  const busts = sid ? getSessionState(sid).consecutiveBusts : 0;

  return {
    messages: [...nuclearPrefix, ...nuclearRaw],
    layer: 4,
    distilledTokens: nuclearPrefixTokens,
    rawTokens: nuclearRawTokens,
    totalTokens: nuclearPrefixTokens + nuclearRawTokens,
    usable,
    distilledBudget,
    rawBudget,
    refreshLtm: true,
    consecutiveBusts: busts,
  };
}

// Public wrapper: records the compressed message count for calibration.
// Calibration needs to know how many messages were SENT to the model (the
// compressed window), not the total DB count. On layer 0 these are equal;
// on layers 1-4 the compressed window is smaller, and the delta on the next
// turn must be computed relative to the compressed count — otherwise the
// expected input on the next turn is anchored to the compressed input token
// count but the "new messages" delta is computed against the full DB count,
// making newMsgCount ≈ 0 and causing layer 0 passthrough on an overflowing session.
export function transform(input: {
  messages: MessageWithParts[];
  projectPath: string;
  sessionID?: string;
  /**
   * Per-request model budget. When provided, applied atomically here so the
   * transform reads THIS request's model caps/pricing — never a concurrently
   * running request's. Omit to use whatever the module globals currently hold
   * (legacy/test path).
   */
  budget?: ModelBudget;
}): TransformResult {
  // Apply the per-request budget synchronously before transformInner so no
  // other request can clobber the globals between here and the transform.
  if (input.budget) applyModelBudget(input.budget);

  // #797: count this transform for the cold-start grace window. Incremented
  // BEFORE transformInner so the very first turn observes transformCount === 1,
  // making the grace cover exactly the first COLD_START_GRACE_TURNS turns of a
  // newly-tracked session. NOT restored from the DB (see makeSessionState /
  // getSessionState), so a resumed/restarted session re-enters the grace —
  // harmless, since it is already calibrated and will not cold-start bust.
  const coldStartSid = input.sessionID ?? input.messages[0]?.info.sessionID;
  if (coldStartSid) getSessionState(coldStartSid).transformCount++;

  const result = transformInner(input);

  // Sanitize non-terminal tool parts before the window reaches the SDK.
  // Must run after transformInner (covers all layers 0-4) and before the
  // trailing-drop loop in index.ts sees the messages.
  result.messages = sanitizeToolParts(result.messages);

  const sid = input.sessionID ?? input.messages[0]?.info.sessionID;
  if (sid) {
    const state = getSessionState(sid);
    state.lastTransformedCount = result.messages.length;
    state.lastTransformEstimate = result.totalTokens;
    state.lastLayer = result.layer;
    state.lastWindowMessageIDs = new Set(result.messages.map((m) => m.info.id));

    // Source the shared cache-economics compressed size from the ACTUAL rebuilt
    // window (issue #881), lifted onto the same INPUT scale as cacheSizeFull
    // (issue #886). transformInner seeds cacheSizeCompressed = cacheSizeFull (the
    // no-compaction default) and refined it only inside the layer-0 tier gate;
    // sessions HELD at layer >= 1 by the sticky / prefix-floor / post-idle /
    // first-sight-large guards bypass that gate. We set it authoritatively here
    // from result.layer so EVERY path is correct, and via computeCompressedCacheSize
    // so the compressed size keeps the non-message floor (overhead + LTM, which
    // compaction does NOT remove) and the same UNCALIBRATED_SAFETY factor as full.
    // The full-vs-compressed delta is then the message tokens compaction removed,
    // on the input scale the warmer cross-checks against apiActual — EXACT for
    // uncalibrated turns, APPROXIMATE (conservative, clamp-guarded) for calibrated
    // turns where full is API-measured (see computeCompressedCacheSize). Layer 0 =
    // no compaction (compressed == full).
    state.cacheSizeCompressed = computeCompressedCacheSize(
      result.layer,
      result.totalTokens,
      state.cacheNonBodyTokens,
      state.cacheBodySafety,
      state.cacheSizeFull,
    );
    // Mark wall-clock for onIdleResume() — must record on every transform()
    // so the next-turn idle check has an accurate baseline. Done after the
    // result fields above so a thrown transformInner doesn't update it.
    state.lastTurnAt = Date.now();

    // --- Compaction hint ---
    if (result.layer >= 2) {
      state.consecutiveHighLayer++;
      if (state.consecutiveHighLayer === 3) {
        log.info(
          `session ${sid} has been at gradient layer ${result.layer}+ for 3 consecutive turns.` +
            ` Consider running /compact to reset the context window.`,
        );
      }
    } else {
      state.consecutiveHighLayer = 0;
    }

    // --- Bust-spiral detection (#797) ---
    // Gated by the cold-start grace window (transformCount): in-grace spirals
    // emit an info-level breadcrumb; past-grace spirals fire a high-severity
    // Sentry alert (debounced per episode, cleared on recovery). No-op when no
    // hook is registered (CLI/tests).
    maybeDetectBustSpiral(sid, state, result.layer, result.totalTokens);

    log.info(
      `gradient: session=${sid} layer=${result.layer} tokens=${result.totalTokens}` +
        ` (distilled=${result.distilledTokens} raw=${result.rawTokens})` +
        ` usable=${result.usable} tier=${getTier(result.totalTokens)} l0cap=${maxLayer0Tokens || "off"}`,
    );
  }
  return result;
}

// Compute our message-only estimate for a set of messages (for calibration use)
export function estimateMessages(messages: MessageWithParts[]): number {
  return messages.reduce((sum, m) => sum + estimateMessage(m), 0);
}

// Identify the current agentic turn: walk backwards from the end to find the
// boundary where it's safe to strip tool outputs. The "current turn" includes:
// 1. All messages from the last user message onwards (the explicit turn boundary)
// 2. All messages that are part of an unfinished tool-call chain BEFORE that user
//    message — because subagent/child user messages can appear mid-chain, and the
//    parent's tool-call chain must be kept intact or the model re-issues tool calls.
//
// The heuristic: walk backwards from the last user message, and if we see assistant
// messages with tool parts (tool-call chains), keep extending the boundary back.
// Stop when we hit a user message that's followed by a non-tool assistant (a clean
// conversational boundary, not a mid-chain subagent injection).
function currentTurnStart(messages: MessageWithParts[]): number {
  if (messages.length === 0) return 0;

  // Start from the last user message
  let boundary = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].info.role === "user") {
      boundary = i;
      break;
    }
  }
  if (boundary === messages.length) return 0; // no user message — protect all

  // Now walk backwards past any tool-call chains that precede this user message.
  // A tool-call chain looks like: ...assistant(tool-calls) → user(subagent) → ...
  // We keep extending boundary back while we see tool-bearing assistant messages.
  for (let i = boundary - 1; i >= 0; i--) {
    const msg = messages[i];
    const hasToolParts = msg.parts.some(isToolPart);
    if (hasToolParts) {
      // This assistant message has tools — it's part of an active chain.
      // Extend the boundary to include it.
      boundary = i;
      continue;
    }
    if (msg.info.role === "user") {
      // A user message with no tool-bearing assistant before it — this might be
      // another subagent injection. Keep walking back.
      boundary = i;
      continue;
    }
    // Non-tool assistant message (pure text response) — this is a clean boundary.
    // The chain above this point is a completed conversation turn.
    break;
  }

  return boundary;
}

function tryFit(input: {
  messages: MessageWithParts[];
  prefix: MessageWithParts[];
  prefixTokens: number;
  distilledBudget: number;
  rawBudget: number;
  strip: "none" | "old-tools" | "all-tools";
  protectedTurns?: number;
  /**
   * Optional target budget for the backward fill of OLDER messages. Defaults to
   * `rawBudget`. The current-turn escalation guard always uses the full
   * `rawBudget` (a turn that doesn't fit must still escalate), but the older-
   * message fill can target a smaller budget so the chosen window leaves
   * headroom below the ceiling. Used by tryFitStable's rescan path to evict in
   * a chunk (so the re-pinned boundary doesn't sit right at the ceiling and
   * overflow again next turn).
   */
  rawFillBudget?: number;
}): Omit<
  TransformResult,
  "layer" | "usable" | "distilledBudget" | "rawBudget" | "refreshLtm"
> | null {
  // If distilled prefix exceeds its budget, fail this layer
  if (input.prefixTokens > input.distilledBudget && input.prefix.length > 0)
    return null;

  // Identify the current turn (last user message + all following assistant messages).
  // These are always included — they must never be evicted. If they alone exceed the
  // raw budget, escalate to the next layer (which strips tool outputs to reduce size).
  const turnStart = currentTurnStart(input.messages);
  const currentTurn = input.messages.slice(turnStart);
  const currentTurnTokens = currentTurn.reduce(
    (s, m) => s + estimateMessage(m),
    0,
  );

  if (currentTurnTokens > input.rawBudget) {
    // Current turn alone exceeds budget — can't fit even with everything else dropped.
    // Signal failure so the caller escalates to the next layer (tool-output stripping).
    return null;
  }

  // Walk backwards through older messages (before the current turn),
  // filling the remaining budget after reserving space for the current turn.
  // The fill targets `rawFillBudget` (defaults to rawBudget); callers can pass a
  // smaller value to evict in a chunk and leave headroom below the ceiling. The
  // current turn is always reserved against the full rawBudget (already checked
  // above), so clamp so the older-fill target can't go negative.
  const olderMessages = input.messages.slice(0, turnStart);
  const fillBudget = input.rawFillBudget ?? input.rawBudget;
  const remainingBudget = Math.max(0, fillBudget - currentTurnTokens);
  let olderTokens = 0;
  let cutoff = olderMessages.length; // default: include none of the older messages
  const protectedTurns = input.protectedTurns ?? 0;

  for (let i = olderMessages.length - 1; i >= 0; i--) {
    const msg = olderMessages[i];
    const tokens = estimateMessage(msg);
    if (olderTokens + tokens > remainingBudget) {
      cutoff = i + 1;
      break;
    }
    olderTokens += tokens;
    if (i === 0) cutoff = 0;
  }

  // Ensure role alternation at the prefix/raw boundary: the distilled prefix
  // ends with an assistant message, so the raw window must start with a user.
  // The backward budget scan is purely token-based and can land on any role.
  // If the cutoff produces a raw window starting with assistant(s), advance it
  // past them — otherwise loreMessagesToGateway produces back-to-back assistants
  // and the API rejects with "tool_use ids found without tool_result" (#424).
  if (input.prefix.length > 0) {
    while (
      cutoff < olderMessages.length &&
      olderMessages[cutoff].info.role === "assistant"
    ) {
      olderTokens -= estimateMessage(olderMessages[cutoff]);
      cutoff++;
    }
  }

  // Symmetric guard: a tool_use/tool_result pair is atomic at the gradient
  // boundary. The role-alternation guard above only handles the case where
  // the first kept message is an assistant. The other case — first kept is a
  // user with a tool_result whose issuing assistant was just evicted — is
  // equally broken: it produces an orphan tool_result that the wire format
  // rejects ("tool_use ids were found without tool_result blocks immediately
  // after"). Move cutoff backward to keep the issuing assistant.
  //
  // Note: this may re-include an assistant that the role-alternation guard
  // just skipped, producing back-to-back assistants with the prefix. This
  // is intentional — loreMessagesToGateway coalesces adjacent same-role
  // messages, and if the re-included assistant causes a budget overrun the
  // caller (`tryFitStage` / `transformInner`) re-checks via
  // `fitsWithSafetyMargin()` and escalates to the next layer (which strips
  // tool outputs to make room). The alternative — orphan tool_result — is a
  // hard upstream 400.
  if (
    cutoff > 0 &&
    cutoff < olderMessages.length &&
    olderMessages[cutoff].info.role === "user" &&
    olderMessages[cutoff].parts.some(
      (p) => isToolPart(p) && p.tool === "result",
    ) &&
    olderMessages[cutoff - 1].info.role === "assistant"
  ) {
    olderTokens += estimateMessage(olderMessages[cutoff - 1]);
    cutoff--;
  }

  const rawMessages = [...olderMessages.slice(cutoff), ...currentTurn];
  const rawTokens = olderTokens + currentTurnTokens;

  // Apply system-reminder stripping + optional tool output stripping.
  // The current turn (end of rawMessages) is always "protected" — never stripped.
  const currentTurnSet = new Set(currentTurn.map((m) => m.info.id));
  const processed = rawMessages.map((msg, idx) => {
    const fromEnd = rawMessages.length - idx;
    const isCurrentTurn = currentTurnSet.has(msg.info.id);
    const isProtected =
      isCurrentTurn ||
      input.strip === "none" ||
      (input.strip === "old-tools" && fromEnd <= protectedTurns * 2);
    const parts = isProtected
      ? cleanParts(msg.parts)
      : cleanParts(
          input.strip === "all-tools"
            ? stripToolOutputs(msg.parts)
            : stripToolOutputs(msg.parts),
        );
    const changed = parts !== msg.parts;
    return changed ? { info: msg.info, parts } : msg;
  });

  const total = input.prefixTokens + rawTokens;
  return {
    messages: [...input.prefix, ...processed],
    distilledTokens: input.prefixTokens,
    rawTokens,
    totalTokens: total,
  };
}
