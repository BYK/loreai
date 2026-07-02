/**
 * Idle detection and background work scheduling for the Lore gateway.
 *
 * Since the gateway doesn't have host lifecycle hooks (like OpenCode's
 * `session.idle` event), it uses a timer-based approach to detect when
 * sessions go idle and trigger background work (distillation, curation,
 * pruning, AGENTS.md export, etc.).
 *
 * Also runs speculative cache warming checks on every 30s tick — separate
 * from idle work (which triggers after idleTimeoutSeconds). Warming needs
 * to fire ~45s before cache TTL expiry, not after the idle timeout.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  temporal,
  distillation,
  contradiction,
  curator,
  ltm,
  DirectFsResolver,
  ensureProject,
  latReader,
  log,
  config as loreConfig,
  exportToFile,
  exportLoreFile,
  exportInlineToAgentsFile,
  saveSessionCosts,
  saveSessionTracking,
  saveGradientState,
  getConsecutiveBusts,
  effectiveMetaThreshold,
  BUST_PRESSURE_THRESHOLD,
  DEEP_IDLE_MS,
  getLastTurnAt,
  getCacheStrategy,
  strategyWantsWarming,
  getLastLayer,
  evictSession as evictGradientSession,
  distillLimiter,
  curatorLimiter,
  formatVecReadLatencyHeartbeat,
  vecReadLatencyTotalSamples,
} from "@loreai/core";
import type { CacheStrategy, ChangedEntry, LLMClient } from "@loreai/core";
import {
  makeWorkerHealth,
  allowWorkerProbe,
  isWorkerCreditPaused,
} from "./worker-health";
import type { GatewayConfig } from "./config";
import type { SessionState } from "./translate/types";
import { getWorkerModel, getModelEntrySync } from "./worker-model";
import { buildSessionMetadata } from "./session-metadata";
import {
  isCircuitBreakerTripped,
  pruneExpiredCircuitBreakers,
  warmupBucketKey,
  isWarmupAuthDisabled,
  clearWarmupAuthDisabled,
  resolveProfileForSession,
  blendedHistogramForSession,
  shouldWarm,
  isWarmingEnabled,
  executeWarmup,
  loadGlobalHistograms,
  flushGlobalHistograms,
  MIN_TURNS_FOR_WARMING,
  MIN_INPUT_TOKENS_FOR_WARMING,
} from "./cache-warmer";
import * as Sentry from "@sentry/bun";
import {
  runBackground,
  scaleBackgroundConcurrency,
  shouldShedLowPriority,
} from "./background-limiter";
import {
  isAuthStale,
  resolveAuth,
  deleteSessionAuth,
  clearAuthStale,
  authFingerprint,
} from "./auth";
import {
  emitWarmupMetric,
  emitSessionCostMetrics,
  emitCurationMetrics,
  startResourceMonitor,
  emitResourceGauge,
} from "./sentry";
import {
  getSessionCosts,
  totalWorkerCost,
  deleteSessionCosts,
} from "./cost-tracker";
import { deleteBillingPrefix } from "./cch";
import {
  maybeFetchQuota,
  isQuotaPaused,
  deleteQuotaForFingerprint,
} from "./quota";

// Re-export DEEP_IDLE_MS so test fixtures can compute "recent vs deep-idle"
// boundaries against the same constant the helper uses (the test imports
// from `../src/idle` rather than @loreai/core to keep the boundary
// observable from the helper's own import surface).
export { DEEP_IDLE_MS };

const POLL_INTERVAL_MS = 30_000;

function persistSessionCosts(sessionID: string): void {
  const costs = getSessionCosts(sessionID);
  if (costs && costs.conversation.turns > 0) {
    saveSessionCosts(sessionID, {
      conversationCost: costs.conversation.cost,
      workerCost: totalWorkerCost(costs),
      conversationTurns: costs.conversation.turns,
      cacheReadTokens: costs.conversation.cacheReadTokens,
      cacheWriteTokens: costs.conversation.cacheWriteTokens,
      warmupSavings: costs.counterfactual.warmupSavings,
      warmupCost: costs.workers.warmup.cost,
      warmupHits: costs.counterfactual.warmupHits,
      ttlSavings: costs.counterfactual.ttlSavings,
      ttlHits: costs.counterfactual.ttlHits,
      batchSavings: costs.batchSavings,
      avoidedCompactions: costs.counterfactual.avoidedCompactions,
      avoidedCompactionCost: costs.counterfactual.avoidedCompactionCost,
    });
  }
}

/**
 * How often the scheduler runs the GLOBAL dead-knowledge sweep
 * (`pruneDeadEntriesAllProjects`). The per-session idle pass only prunes the
 * active session's project, so dead entries in projects nobody is currently
 * working in would linger. This backstop reaps them across all projects on a
 * slow cadence (the work is a single local query that returns nothing most
 * ticks). In-memory gate; the first tick after startup runs it once.
 */
export const GLOBAL_DEAD_SWEEP_INTERVAL_MS = 60 * 60 * 1000; // 1h

/**
 * Max entries the global sweep reaps per tick — bounds the synchronous delete
 * loop so a pathological mass-decay backlog can't stall the proxy event loop.
 * When a tick fills this batch, the gate is reset so the remainder drains on the
 * next tick (every ~30s) instead of waiting the full interval.
 */
const GLOBAL_DEAD_SWEEP_BATCH = 1000;

/**
 * Cooldown tracking for knowledge consolidation.
 *
 * When consolidation runs but fails to reduce entries below maxEntries
 * (e.g. all entries are genuinely unique), we record the attempt so the
 * idle scheduler doesn't retry every 30s — which wastes Sonnet calls.
 *
 * Keyed by resolved PROJECT ID (not the raw session/worktree path): N worktrees
 * of one repo resolve to a single canonical project via ensureProject(), and
 * ltm.forProject() operates on that shared knowledge set. Keying by raw path
 * gave each worktree its own cooldown bucket guarding the same entries, so
 * consolidation ran N× redundantly (bug: the consolidation retry storm).
 */
const consolidationCooldown = new Map<
  string,
  { attemptedAt: number; entryCount: number; topCategoryCount: number }
>();

/**
 * Projects with an in-flight consolidation LLM call (keyed by resolved project
 * ID). The cooldown is checked before the `await` and set after it returns, so
 * without this guard concurrent idle sessions for the same project all pass the
 * gate before any sets the cooldown → thundering herd. Set before the await,
 * cleared in a `finally`.
 */
const consolidationInProgress = new Set<string>();

/** 1 hour cooldown before retrying consolidation with the same entry count. */
export const CONSOLIDATION_COOLDOWN_MS = 60 * 60 * 1000;

/**
 * Entry-count growth (since the last no-op consolidation) required to re-attempt
 * early, before the cooldown window elapses. A no-op consolidation means the LLM
 * found nothing to merge; only genuinely NEW entries create fresh merge
 * candidates. A decrease (eviction/delete) or trivial churn does not — so the
 * cooldown stays sticky against the count oscillation seen at a saturated cap.
 */
export const CONSOLIDATION_REATTEMPT_GROWTH = 3;

/**
 * Pure decision: is consolidation still on cooldown for this project?
 *
 * Returns true (skip) when a prior no-op attempt is still within the cooldown
 * window AND the knowledge set has not materially grown since. Returns false
 * (allow) when there is no prior attempt, the window has elapsed, or new merge
 * candidates have appeared (global count grew past the reattempt threshold, or
 * the top category grew).
 */
export function consolidationCooldownActive(
  cooldown:
    | { attemptedAt: number; entryCount: number; topCategoryCount: number }
    | undefined,
  now: number,
  entryCount: number,
  topCategoryCount: number,
): boolean {
  if (!cooldown) return false;
  if (now - cooldown.attemptedAt >= CONSOLIDATION_COOLDOWN_MS) return false;
  // Re-attempt early only when knowledge GREW (new merge candidates). A
  // decrease yields no new opportunity, so the prior verdict still stands.
  if (entryCount > cooldown.entryCount + CONSOLIDATION_REATTEMPT_GROWTH)
    return false;
  if (topCategoryCount > cooldown.topCategoryCount) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Contradiction detection throttle (#1123)
// ---------------------------------------------------------------------------

/**
 * Last time a contradiction-detection pass STARTED for a project (resolved
 * project ID). Armed unconditionally the moment a pass begins so a
 * "nothing found" outcome still throttles the next attempt — otherwise the full
 * embed + judge scan would rerun every idle tick (the pattern-echo throttle
 * gotcha). Keyed by canonical project ID like the consolidation cooldown so N
 * worktrees of one repo share a single bucket.
 */
const contradictionCooldown = new Map<string, number>();

/**
 * Projects with an in-flight contradiction pass — thundering-herd guard across
 * concurrent idle sessions for the same project (set before the await, cleared
 * in a finally), mirroring consolidationInProgress.
 */
const contradictionInProgress = new Set<string>();

/** Minimum interval between contradiction-detection passes per project. */
export const CONTRADICTION_COOLDOWN_MS = 60 * 60 * 1000; // 1h

/** Pure decision: is contradiction detection still on cooldown for this project? */
export function contradictionCooldownActive(
  lastAttemptAt: number | undefined,
  now: number,
): boolean {
  if (lastAttemptAt === undefined) return false;
  return now - lastAttemptAt < CONTRADICTION_COOLDOWN_MS;
}

/**
 * Per-category consolidation trigger, proportional to the global cap so it
 * scales with `maxEntries` instead of being a magic constant. The global
 * trigger structurally misses single-category bloat: a category (notably
 * `preference`, which the curator re-mints and re-phrases each session) can
 * swell while the total stays under maxEntries, so consolidation never fires and
 * the near-duplicates inject into the always-pinned system[1] block. Preserves
 * the historical 12/40 = 0.3 ratio (→ 60 at the default maxEntries of 200).
 */
export function perCategoryThreshold(maxEntries: number): number {
  return Math.ceil(maxEntries * 0.3);
}

/**
 * After an idle tick that may have rewritten the distilled prefix (messages[1])
 * via force-distillation / meta-consolidation, drop the cache warmer's stored
 * body when it is now stale, and report whether it did.
 *
 * Stale ⇔ ALL hold:
 *  - `prefixMutated`: idle distillation actually rewrote the distilled prefix;
 *  - `layer >= 1`: the session is COMPRESSED, so its body actually carries the
 *    distilled prefix. Layer-0 (full-passthrough) bodies have no distilled
 *    prefix, so distillation doesn't change them — leave their warming untouched;
 *  - there is a stored body to invalidate.
 */
export function invalidateWarmupBodyAfterIdleDistill(
  state: SessionState,
  prefixMutated: boolean,
  layer: number,
): boolean {
  const stale =
    prefixMutated && layer >= 1 && state.cacheAnalytics.lastRequestBody != null;
  if (stale) state.cacheAnalytics.lastRequestBody = null;
  return stale;
}

/**
 * D6′ deferred prefix work (PR2b follow-on): should the idle handler DEFER its
 * prefix-rewriting steps (force-distillation, meta-consolidation) to avoid
 * busting a cache the warmer is deliberately keeping warm?
 *
 * Defer ⇔ the unified cache-economics strategy confidently wants to keep this
 * session warm (`hold-warm`) AND the session is NOT under bust pressure. A
 * cool-bust / cool-full-write / non-confident session is busting (or letting go
 * of) its prefix anyway, so flushing now is free. Bust pressure overrides
 * hold-warm: a churning session is busting cache regardless of intent, so the
 * deferred work is free at that point too.
 *
 * This only biases the SCHEDULE — it never starves distillation/LTM. The
 * existing urgency thresholds still fire: distillation falls back to the
 * `minMessages` gate (a ≥minMessages backlog distills even while held warm), and
 * meta-consolidation keeps its `gen0 >= metaThreshold` gate.
 */
export function shouldHoldPrefixWarm(
  econ: { result: { strategy: CacheStrategy; confident: boolean } } | null,
  bustPressure: boolean,
): boolean {
  if (bustPressure) return false;
  return (
    econ?.result.confident === true &&
    strategyWantsWarming(econ.result.strategy)
  );
}

/**
 * #946 symmetric inverse override: should the idle handler DEFER its
 * prefix-rewriting steps for a cool-bust / cool-full-write session that is
 * still mid-flight (the user's last turn was recent enough that the prompt
 * cache is still warm)?
 *
 * Defer ⇔ ALL hold:
 *  1. The session is NOT under bust pressure — a churning session is busting
 *     cache regardless of intent, so flushing is free.
 *  2. The strategy is confidently `cool-bust` or `cool-full-write` (the
 *     inverse of `shouldHoldPrefixWarm` — do not double-defer hold-warm,
 *     which `shouldHoldPrefixWarm` already owns).
 *  3. `lastTurnAtMs === 0` (no recorded turns — no cache to protect) OR
 *     `nowMs - lastTurnAtMs < DEEP_IDLE_MS` (the user was active within the
 *     default Anthropic prompt-cache TTL, so the cache is still warm from
 *     their last turn).
 *
 * Reuses `DEEP_IDLE_MS` from `@loreai/core` — the same constant that gates
 * `effectiveMetaThreshold`'s bust-pressure override. The 5 min default matches
 * Anthropic's prompt cache TTL so the gate aligns with the cache's natural
 * liveness window.
 *
 * Like `shouldHoldPrefixWarm`, this only biases the SCHEDULE — it never
 * starves distillation/LTM in a single deferral. The existing urgency
 * thresholds still fire when a deferral is in effect: distillation's
 * `minMessages` gate runs even with `force=false`, meta's
 * `gen0 >= metaThreshold` gate runs once the cache goes cold, and the
 * bust-pressure lowered threshold is unaffected (its `lastTurnAt=0` path is
 * orthogonal to this helper's `lastTurnAt=0` path).
 *
 * ⚠ Bursty-user caveat: a user who makes turns every 60–90s (so
 * `lastTurnAt` is always within `DEEP_IDLE_MS`) will keep the cache warm
 * continuously. Meta-consolidation is then deferred on every idle tick until
 * the user goes truly idle (>5 min). This is the same bursty-user tradeoff
 * `shouldHoldPrefixWarm` already makes — a churn-heavy session would have
 * the same meta-deferral pattern there. The fix targets the high-frequency
 * bust pattern (session 0AVWKugtmhBKqLOX: 8 bust turns / 16 observed) where
 * the per-tick cost dominates; lower-frequency sessions trade a one-tick
 * deferral for the next user turn's intact prompt cache.
 */
export function shouldDeferPrefixRewriteOnCoolBust(
  econ: { result: { strategy: CacheStrategy; confident: boolean } } | null,
  bustPressure: boolean,
  lastTurnAtMs: number,
  nowMs: number,
): boolean {
  if (bustPressure) return false;
  if (!econ?.result.confident) return false;
  // The inverse of shouldHoldPrefixWarm: defer only when the strategy is NOT
  // hold-warm. A hold-warm session is governed by shouldHoldPrefixWarm.
  if (strategyWantsWarming(econ.result.strategy)) return false;
  // lastTurnAtMs === 0 is a sentinel for "never had a turn" — treat as
  // "user is away, no cache to protect, flushing is free" (mirrors the
  // effectiveMetaThreshold convention at gradient.ts:1177).
  if (lastTurnAtMs === 0) return false;
  return nowMs - lastTurnAtMs < DEEP_IDLE_MS;
}

/**
 * Sub-agent sessions are ephemeral (1-3 turns) — evict them faster than
 * regular sessions to free memory sooner.
 */
const SUBAGENT_EVICTION_MS = 5 * 60 * 1000; // 5 minutes

// ---------------------------------------------------------------------------
// startIdleScheduler
// ---------------------------------------------------------------------------

/**
 * Start a periodic timer that checks each active session for idle timeout.
 *
 * Every 30 seconds, walks the sessions map and fires `doIdleWork` for any
 * session whose `lastRequestTime` is older than `config.idleTimeoutSeconds`.
 * Tracks in-progress sessions to avoid double-triggering.
 *
 * @returns A cleanup function that clears the interval timer.
 */
export function startIdleScheduler(
  config: GatewayConfig,
  sessions: Map<string, SessionState>,
  doIdleWork: (sessionID: string, state: SessionState) => Promise<void>,
  /** Optional callback to clean up pipeline-level satellite Maps when a session is evicted. */
  onEvict?: (sessionID: string) => void,
): () => void {
  const inProgress = new Set<string>();
  const warmupInProgress = new Set<string>();
  // In-memory gate for the global dead-knowledge sweep. Starts at 0 so the first
  // tick after startup runs it once (catches entries that decayed while the
  // gateway was down), then at most once per GLOBAL_DEAD_SWEEP_INTERVAL_MS.
  let lastGlobalDeadSweepAt = 0;
  // Cumulative vector-read count at the last heartbeat log (#1065). The
  // heartbeat only logs when new reads happened since the last tick, so idle
  // periods stay quiet instead of repeating a stale p50/p95 line every tick.
  let lastVecLatencyLogged = 0;

  // Begin sampling event-loop delay for the periodic resource gauge below.
  startResourceMonitor();

  const timer = setInterval(() => {
    const now = Date.now();
    const timeoutMs = config.idleTimeoutSeconds * 1000;

    // Periodic process-resource + event-loop-lag gauge (~30s). Cheap, gated on
    // Sentry being initialized, and never throws.
    emitResourceGauge();

    // Vector KNN read-latency heartbeat (#1065): log the rolling p50/p95 per
    // (storage × vec) cohort so a healthy vec0 host (sub-second) is visibly
    // separable from a degraded JS-fallback host (multi-second) in per-install
    // logs — the local counterpart to the Sentry distribution. Gated on new
    // reads since the last tick so idle periods stay quiet. Never throws out.
    try {
      const totalReads = vecReadLatencyTotalSamples();
      if (totalReads > lastVecLatencyLogged) {
        lastVecLatencyLogged = totalReads;
        const summary = formatVecReadLatencyHeartbeat();
        if (summary) log.info(`vec read latency (rolling): ${summary}`);
      }
    } catch {
      // Telemetry must never break the idle loop.
    }

    // Scale background concurrency to the live session count before scheduling
    // this tick's work. The idle scheduler owns the sessions Map, so doing it
    // here keeps background-limiter free of session-state imports.
    scaleBackgroundConcurrency(sessions.size);

    // Global dead-knowledge sweep — interval-gated backstop for entries in
    // projects with no active session (the per-session pass only prunes the
    // active project). Knowledge-gated; cheap local query; never throws out.
    if (
      loreConfig().knowledge.enabled &&
      now - lastGlobalDeadSweepAt >= GLOBAL_DEAD_SWEEP_INTERVAL_MS
    ) {
      // Arm the gate BEFORE the work so a throw can't cause a per-tick retry
      // storm (matches the consolidation cooldown pattern).
      lastGlobalDeadSweepAt = now;
      try {
        const pruned = ltm.pruneDeadEntriesAllProjects(GLOBAL_DEAD_SWEEP_BATCH);
        if (pruned.length > 0) {
          log.info(
            `global sweep: pruned ${pruned.length} dead knowledge entries across all projects`,
          );
        }
        // Filled the batch → more dead rows likely remain; drain on the next
        // tick instead of waiting the full interval (re-open the gate).
        if (pruned.length >= GLOBAL_DEAD_SWEEP_BATCH) lastGlobalDeadSweepAt = 0;
      } catch (e) {
        log.error("global dead-entry sweep error:", e);
      }
    }

    // Global dead-reference cleanup — once per tick, not per session.
    // cleanDeadRefs scans ALL knowledge_refs globally, so running it for
    // every idle session was redundant work.
    if (loreConfig().knowledge.enabled) {
      try {
        const cleaned = ltm.cleanDeadRefs();
        if (cleaned > 0) {
          log.info(`cleaned ${cleaned} dead knowledge cross-references`);
        }
      } catch (e) {
        log.error("dead-ref cleanup error:", e);
      }
    }

    // --- Idle work (distillation, curation, etc.) ---
    for (const [sessionID, state] of sessions) {
      if (inProgress.has(sessionID)) continue;
      if (now - state.lastRequestTime < timeoutMs) continue;

      // Skip idle work when the agent is executing a tool — the session
      // is still active, not genuinely idle. Distillation/curation should
      // wait for the actual idle period after the tool-use turn completes.
      if (state.lastStopReason === "tool_use") continue;

      // Skip sessions with stale auth credentials — background LLM calls
      // (distillation, curation) would just 401, flooding Sentry with
      // events every 30s. Auth refreshes when the next client request
      // arrives via setSessionAuth(), which clears the stale flag.
      if (isAuthStale(sessionID) && !resolveAuth(sessionID)) continue;

      // Skip sessions soft-paused due to an upstream credit/billing state
      // (HTTP 402). Expected account state, not an outage — retrying every
      // 30s just wastes calls. A probe is allowed once per circuit interval
      // (see isWorkerCreditPaused) so a credit top-up recovers automatically.
      if (isWorkerCreditPaused(sessionID)) continue;

      // Skip background work for OAuth accounts near quota exhaustion — preserve
      // remaining entitlement for user-facing conversation turns.
      if (isQuotaPaused(resolveAuth(sessionID))) continue;

      // Coalesce with any distillation/curation already in-flight OR queued for
      // this session. The per-session p-limit(1) pools (distillLimiter/
      // curatorLimiter) are the durable dedup signal — they persist across
      // ticks, unlike the local inProgress Set which clears the instant
      // runBackground returns (even on an immediate queue-full skip). Without
      // this, every idle session re-floods the global FIFO every 30s, crowding
      // out one-shot incremental-distill/curation work.
      if (
        distillLimiter.isBusy(sessionID) ||
        curatorLimiter.isBusy(sessionID)
      ) {
        continue;
      }

      // Idle work is regenerated every 30s — under queue pressure, shed it so
      // FIFO slots stay reserved for one-shot hot-path work (pipeline.ts).
      // Dropping idle work is safe.
      if (shouldShedLowPriority()) continue;

      // Provider-aware auth guard (mirror of scheduleBackgroundWork): skip when
      // the worker model's provider has no usable credential for this session.
      // A no-auth worker call just degrades worker-health every idle tick;
      // resolveAuth/getSessionAuth warns once on the mismatch, then stays quiet.
      // Resumes once a turn uses a credentialed provider. #894
      const idleWorkerModel = getWorkerModel(state.lastUpstream);
      // Exempt the dedicated-worker-key setup (LORE_WORKER_API_KEY): the worker
      // uses its own credential and bypasses resolveAuth, so a session-auth miss
      // must NOT disable background work there.
      if (
        !config.workerApiKey &&
        idleWorkerModel &&
        !resolveAuth(sessionID, idleWorkerModel.providerID)
      ) {
        continue;
      }

      inProgress.add(sessionID);
      // Scope the circuit-breaker check to the provider this session's worker
      // will call — a 429 from a different provider must not pause this work.
      // (idleWorkerModel may be undefined — getWorkerModel returns undefined
      // when no provider can be resolved; the guard above only skips when it IS
      // defined but unauthed, so preserve the undefined-safe access here.)
      const idleProviderID = idleWorkerModel?.providerID;
      runBackground(
        () => doIdleWork(sessionID, state),
        `idle session=${sessionID.slice(0, 16)}`,
        idleProviderID,
      )
        .catch((e) =>
          log.error(`idle work failed for session ${sessionID}:`, e),
        )
        .finally(() => inProgress.delete(sessionID));
    }

    // --- Anthropic OAuth quota refresh ---
    // Separate pass (not gated by idle timeout) so quota refreshes even on
    // active sessions. maybeFetchQuota gates internally to Anthropic-OAuth
    // sessions, applies a 5-min per-account cooldown, and deduplicates
    // concurrent requests for the same OAuth account.
    for (const [sessionID] of sessions) {
      if (isAuthStale(sessionID)) continue;
      const cred = resolveAuth(sessionID);
      if (!cred) continue;
      maybeFetchQuota(sessionID, cred);
    }

    evictIdleSessions(
      config,
      sessions,
      inProgress,
      warmupInProgress,
      now,
      onEvict,
    );

    // --- Cache warming (separate from idle work — fires before TTL expiry) ---
    // NOTE: the circuit breaker is per-bucket (session, model, upstream), not
    // global, so it's checked inside the loop below — a tripped bucket must
    // never short-circuit warming for every other (healthy) session.
    // Sweep decayed tripped buckets first so state stays bounded even for
    // buckets whose session was evicted (never re-queried on the read path).
    pruneExpiredCircuitBreakers(now);

    // Global kill-switch, hoisted out of the per-session loop so a disabled
    // deployment doesn't do a getKV per session per tick for a global flag.
    // shouldWarm() still re-checks isWarmingEnabled() on the per-request path.
    const warmingGloballyEnabled = isWarmingEnabled();

    for (const [sessionID, state] of sessions) {
      if (!warmingGloballyEnabled) break;
      if (warmupInProgress.has(sessionID)) continue;

      // Skip sessions with stale auth credentials — warmup would just 401
      if (isWarmupAuthDisabled(sessionID)) continue;

      // Skip sub-agent sessions — ephemeral, warming is wasted work
      if (state.isSubagent) continue;

      // Skip sessions with too few turns — insufficient data for survival
      // model and not worth the warmup cost ($0.30 per wasted warmup at
      // 200K Opus tokens). Checked here to avoid expensive profile/histogram
      // work before shouldWarm() rejects them anyway.
      if (state.messageCount < MIN_TURNS_FOR_WARMING * 2) continue;

      // Skip sessions with small context — absolute savings per hit
      // don't justify the risk of wasted warmups.
      if ((state.lastInputTokens ?? 0) < MIN_INPUT_TOKENS_FOR_WARMING) continue;

      // Ensure global histograms are loaded from SQLite for this project
      loadGlobalHistograms(state.projectPath);

      // Shared seam with the dashboard snapshot (computeWarmingSnapshot) so the
      // upstream routing + size-aware warmup margin never diverge. See
      // resolveProfileForSession.
      const profile = resolveProfileForSession(state);
      if (!profile) continue;

      // Skip only this session's tripped (model, upstream) bucket — other
      // sessions/models keep warming. Auto-decays after CIRCUIT_BREAKER_DECAY_MS.
      if (isCircuitBreakerTripped(warmupBucketKey(state), now)) continue;

      const blendedHist = blendedHistogramForSession(state);
      if (!shouldWarm(state, profile, blendedHist, now, warmingGloballyEnabled))
        continue;

      warmupInProgress.add(sessionID);
      executeWarmup(state, profile, config.upstreamExtraHeaders)
        .then((result) => {
          // executeWarmup mutates state.warmup (lastWarmupAt, totalWarmups,
          // lastWarmupRefreshTokens). The periodic flush below skips
          // non-dirty sessions, so without this the warmup counters/refresh
          // tokens would be lost on eviction/restart. Mark dirty on a real
          // ping so the next tick persists them.
          if (result.ok) state._dirty = true;
          emitWarmupMetric(state, result);
        })
        .catch((e) =>
          log.error(
            `cache-warmer: warmup failed session=${sessionID.slice(0, 16)}:`,
            e,
          ),
        )
        .finally(() => warmupInProgress.delete(sessionID));
    }

    // Flush dirty global histograms to SQLite (debounced — runs at most
    // once per 30s poll tick, not on every recordGap call).
    try {
      flushGlobalHistograms();
    } catch (e) {
      log.warn("cache-warmer: histogram flush error:", e);
    }

    // --- Periodic state persistence (30s tick) ---
    // Flush gradient calibration + cache warming + cost state for dirty sessions.
    // Max data loss on crash is one tick interval (~30s) — acceptable tradeoff
    // vs per-mutation writes on the hot path.
    for (const [sessionID, state] of sessions) {
      if (!state._dirty) continue;
      try {
        saveGradientState(sessionID);
        // Persist cache warming state (resolvedConversationTTL + warmup blob)
        // in a single DB write alongside gradient state.
        saveSessionTracking(sessionID, {
          resolvedConversationTTL: state.resolvedConversationTTL ?? "5m",
          warmupState: state.warmup ? JSON.stringify(state.warmup) : null,
        });
        // Persist cost snapshot
        persistSessionCosts(sessionID);
        state._dirty = false;
      } catch (e) {
        log.error(
          `periodic state flush error for session ${sessionID.slice(0, 16)}:`,
          e,
        );
      }
    }
  }, POLL_INTERVAL_MS);

  return () => clearInterval(timer);
}

// ---------------------------------------------------------------------------
// evictIdleSessions — extracted for testability
// ---------------------------------------------------------------------------

/**
 * Evict sessions that have been idle beyond the configured eviction timeout.
 *
 * All important state is persisted to SQLite before eviction; only in-memory
 * caches are freed (gradient state, prefix cache, recall store, LTM caches,
 * cost tracking, auth credentials). If a session resumes, getOrCreateSession()
 * in pipeline.ts reloads persisted state from DB.
 *
 * Extracted from the scheduler interval so it can be tested directly without
 * waiting for a 30s timer tick.
 *
 * @returns Number of sessions evicted.
 */
export function evictIdleSessions(
  config: GatewayConfig,
  sessions: Map<string, SessionState>,
  inProgress: ReadonlySet<string>,
  warmupInProgress: ReadonlySet<string>,
  now: number,
  onEvict?: (sessionID: string) => void,
): number {
  const evictionTimeoutMs = config.sessionEvictionTimeoutSeconds * 1000;
  let evicted = 0;

  for (const [sessionID, state] of sessions) {
    if (evictionTimeoutMs <= 0) break; // eviction disabled
    if (inProgress.has(sessionID)) continue; // don't evict during active idle work
    if (warmupInProgress.has(sessionID)) continue;
    // Sub-agent sessions are ephemeral — evict faster
    const timeout = state.isSubagent
      ? Math.min(evictionTimeoutMs, SUBAGENT_EVICTION_MS)
      : evictionTimeoutMs;
    if (now - state.lastRequestTime < timeout) continue;
    // Don't evict sessions still executing tools — they're active
    if (state.lastStopReason === "tool_use") continue;

    log.info(
      `evicting idle session ${sessionID.slice(0, 16)}` +
        `${state.isSubagent ? " (subagent)" : ""}` +
        ` (idle ${Math.round((now - state.lastRequestTime) / 60_000)}m)`,
    );

    // Persist final cost snapshot before eviction
    try {
      persistSessionCosts(sessionID);
    } catch (e) {
      log.warn(
        `session eviction: cost persistence failed for ${sessionID.slice(0, 16)}:`,
        e,
      );
    }

    // Persist gradient state before eviction
    try {
      saveGradientState(sessionID);
    } catch (e) {
      log.warn(
        `session eviction: gradient persistence failed for ${sessionID.slice(0, 16)}:`,
        e,
      );
    }

    // Persist cache-warming state (resolvedConversationTTL + warmup blob)
    // before eviction. The periodic flush also writes this, but eviction can
    // fire between a warmup's .then() (which sets lastWarmupRefreshTokens +
    // totalWarmups) and the next 30s tick — without this, an evicted session
    // loses its warmup refresh credit and the resume path would deny a
    // legitimate hit (phantom-guard false negative).
    try {
      saveSessionTracking(sessionID, {
        resolvedConversationTTL: state.resolvedConversationTTL ?? "5m",
        warmupState: state.warmup ? JSON.stringify(state.warmup) : null,
      });
    } catch (e) {
      log.warn(
        `session eviction: warmup-state persistence failed for ${sessionID.slice(0, 16)}:`,
        e,
      );
    }

    // Capture the OAuth account fingerprint BEFORE deleting the session's
    // auth, so we can GC the shared (per-account) quota cache afterwards.
    const evictedCred = resolveAuth(sessionID);
    const evictedFingerprint = evictedCred
      ? authFingerprint(evictedCred)
      : null;

    // Clean up all per-session in-memory state across modules
    evictGradientSession(sessionID);
    curator.resetCurationTracker(sessionID);
    deleteSessionCosts(sessionID);
    deleteSessionAuth(sessionID);
    clearAuthStale(sessionID);
    deleteBillingPrefix(sessionID);
    clearWarmupAuthDisabled(sessionID);
    distillLimiter.evict(sessionID);
    curatorLimiter.evict(sessionID);

    // Clean up pipeline-level satellite Maps via callback
    onEvict?.(sessionID);

    // Remove from the main sessions map last
    sessions.delete(sessionID);

    // Clean up project-scoped consolidation state when no remaining session
    // resolves to the same canonical project (worktrees share one project ID).
    const evictedProjectId = ensureProject(state.projectPath);
    let projectStillActive = false;
    for (const [, s] of sessions) {
      if (ensureProject(s.projectPath) === evictedProjectId) {
        projectStillActive = true;
        break;
      }
    }
    if (!projectStillActive) {
      consolidationCooldown.delete(evictedProjectId);
      consolidationInProgress.delete(evictedProjectId);
      contradictionCooldown.delete(evictedProjectId);
      contradictionInProgress.delete(evictedProjectId);
    }

    // GC the shared quota cache only when no remaining session uses this
    // OAuth account (the cache is keyed by account fingerprint, not session).
    if (evictedFingerprint) {
      let fingerprintStillActive = false;
      for (const [otherID] of sessions) {
        const otherCred = resolveAuth(otherID);
        if (otherCred && authFingerprint(otherCred) === evictedFingerprint) {
          fingerprintStillActive = true;
          break;
        }
      }
      if (!fingerprintStillActive) {
        deleteQuotaForFingerprint(evictedFingerprint);
      }
    }

    evicted++;
  }

  return evicted;
}

// ---------------------------------------------------------------------------
// touchSession
// ---------------------------------------------------------------------------

/**
 * Update a session's `lastRequestTime` to now. Called on every request.
 */
export function touchSession(
  sessions: Map<string, SessionState>,
  sessionID: string,
): void {
  const state = sessions.get(sessionID);
  if (state) {
    state.lastRequestTime = Date.now();
  }
}

// ---------------------------------------------------------------------------
// buildIdleWorkHandler
// ---------------------------------------------------------------------------

/**
 * Build the idle work handler that runs the same background tasks as
 * OpenCode/Pi adapters on session idle:
 *
 *  1. Distillation (if enough undistilled messages)
 *  2. Curation (if enough turns since last curation)
 *  3. Consolidation (if entries exceed max)
 *  4. Temporal pruning
 *  5. AGENTS.md export
 *  6. Dead reference cleanup
 *  7. lat.md refresh
 *
 * Each step is independently try/catch'd — one failure won't block the rest.
 *
 * @param llm - LLM client for worker calls (distillation, curation)
 */
export function buildIdleWorkHandler(
  llm: LLMClient,
  onKnowledgeChanged?: (
    sessionID: string,
    result: { changedEntries?: ChangedEntry[] },
  ) => void,
): (sessionID: string, state: SessionState) => Promise<void> {
  return async (sessionID: string, state: SessionState) => {
    const projectPath = state.projectPath;
    // Resolve the raw worktree/session path to the canonical project ID so the
    // consolidation cooldown / in-flight guard collapse across worktrees of the
    // same repo (they share one knowledge set via ltm.forProject()).
    const projectId = ensureProject(projectPath);
    const cfg = loreConfig();
    const model = getWorkerModel(state.lastUpstream);

    // Worker circuit breaker: when this session's background workers have been
    // failing for a sustained period, skip the LLM-calling steps (distillation,
    // curation, consolidation) and allow only a periodic probe — prevents the
    // idle scheduler from re-driving a dead upstream every tick. Local steps
    // (pruning, export, lat refresh, cost metrics) are unaffected.
    const allowWorker = allowWorkerProbe(sessionID);

    // Bust pressure: the session has bust the cache on enough consecutive turns
    // that it's churning regardless of intent — flushing deferred prefix work is
    // free. Use the same BUST_PRESSURE_THRESHOLD that effectiveMetaThreshold uses
    // to lower the meta bar (single source of truth; deriving it from the lowered
    // threshold value degenerates to "never" at metaThreshold == 3).
    const busts = getConsecutiveBusts(sessionID);
    const metaThreshold = effectiveMetaThreshold(
      busts,
      cfg.distillation.metaThreshold,
      getLastTurnAt(sessionID),
    );
    const bustPressure = busts >= BUST_PRESSURE_THRESHOLD;

    // D6′ deferred prefix work (PR2b follow-on): the idle force-distill below was
    // written assuming "idle ⇒ cache going cold." That is no longer true — when
    // the unified cache-economics strategy is `hold-warm`, the warmer is (or will
    // be) paying to keep this session's prompt prefix alive. Force-distilling /
    // meta-consolidating then rewrites the very prefix we're paying to keep warm
    // (busting the cache and forcing the warmer to re-WRITE instead of re-READ).
    // So on hold-warm we DEFER the prefix-rewriting steps; cool-bust /
    // cool-full-write / non-confident sessions still flush aggressively (the
    // prefix is busting anyway — flushing is free). See shouldHoldPrefixWarm.
    //
    // #946 symmetric inverse: the D6′ deferral is one-directional — it only
    // defers hold-warm. But a cool-bust / cool-full-write session that is
    // still MID-FLIGHT (the user's last turn was within DEEP_IDLE_MS) has a
    // still-warm prompt cache; flushing the rewrite here busts that warm
    // cache for no benefit, forcing the next user turn to pay a full cache
    // write. Mirror the deferral: if the session is mid-flight, low bust
    // pressure, and not hold-warm, defer the rewrite too. The two helpers
    // are OR'd together so a session that's both hold-warm AND mid-flight
    // defers for either reason, but a cool-bust session defers only for
    // mid-flight, and a hold-warm session defers only for hold-warm. See
    // shouldDeferPrefixRewriteOnCoolBust.
    const holdingWarm = shouldHoldPrefixWarm(
      getCacheStrategy(sessionID),
      bustPressure,
    );
    const deferCoolBust = shouldDeferPrefixRewriteOnCoolBust(
      getCacheStrategy(sessionID),
      bustPressure,
      getLastTurnAt(sessionID),
      Date.now(),
    );
    const deferPrefixRewrites = holdingWarm || deferCoolBust;

    // 1. Distillation. When NOT holding the cache warm, force-distill ALL pending
    // messages even below minMessages — the cache is going cold, so aggressive
    // distillation now means a smaller context on the next turn via post-idle
    // compact. When holding warm, defer: pass force=false so distillation runs
    // only once enough has piled up (the existing minMessages gate is the natural
    // urgency override — a ≥minMessages backlog warrants the rewrite regardless).
    // Skip meta-distillation in the run() call: we run it as a separate
    // step below so gen-0 segments from the force-distill are counted.
    // Tracks whether this tick's distillation rewrote the in-context distilled
    // prefix (messages[1]). Used below to invalidate a now-stale warmup body.
    let idlePrefixMutated = false;
    try {
      const callType =
        process.env.LORE_BATCH_DISABLED === "1"
          ? ("direct" as const)
          : ("batch" as const);
      const pending = temporal.undistilledCount(projectPath, sessionID);
      if (allowWorker && pending > 0) {
        const result = await distillation.run({
          llm,
          projectPath,
          sessionID,
          model,
          force: !deferPrefixRewrites,
          skipMeta: true,
          callType,
          workerHealth: makeWorkerHealth(sessionID, "lore-distill"),
          // #627 Phase 1: stamp the session's gitHead on every distilled row.
          metadata: buildSessionMetadata(state.gitHead),
        });
        // Only a run that actually created gen-0 segments rewrites the in-context
        // prefix. `distilled` counts messages folded into a NEW gen-0 segment
        // (distillation.ts:954); it stays 0 for tiny-segment absorption, worker
        // failures, parse errors, and expansion-guard discards — which mark
        // messages distilled WITHOUT creating gen-0, leaving the prefix (and the
        // warmup body) unchanged. Gating on it avoids nulling a still-valid body.
        if (result.distilled > 0) idlePrefixMutated = true;
      }
      // Meta consolidation — also a prefix rewrite (archives gen-0, adds gen-1+),
      // so it's deferred under the same hold-warm bias (and the #946 cool-bust
      // mid-flight bias). Run as a separate step so gen-0 segments from the
      // force-distill above are counted toward the threshold. Under bust pressure
      // the threshold is already lowered AND deferPrefixRewrites is false, so a
      // churning session consolidates earlier.
      const g0 = distillation.gen0Count(projectPath, sessionID);
      if (allowWorker && g0 >= metaThreshold && !deferPrefixRewrites) {
        const meta = await distillation.metaDistill({
          llm,
          projectPath,
          sessionID,
          model,
          callType,
          // #627 Phase 1: stamp the session's gitHead on meta-distilled rows.
          metadata: buildSessionMetadata(state.gitHead),
          workerHealth: makeWorkerHealth(sessionID, "lore-distill"),
        });
        // meta consolidation archives gen-0 and adds gen-1+ — rewrites the prefix.
        if (meta) idlePrefixMutated = true;
      }
    } catch (e) {
      log.error("idle distillation error:", e);
    }

    // Lore's OWN idle-time prefix mutation. When force-distillation / meta-
    // consolidation rewrites the distilled prefix (messages[1]) of a COMPRESSED
    // session, the body the next real turn sends diverges from the last turn's —
    // and the idle force-distill above is explicitly preparing a smaller
    // post-idle-compact body. So the cache warmer's stored body is now stale:
    // replaying it would just refresh a prefix the next turn busts anyway (the
    // large-session cacheRead=0 waste). Drop it — same rationale as the /compact
    // and model-switch invalidations in pipeline.ts.
    invalidateWarmupBodyAfterIdleDistill(
      state,
      idlePrefixMutated,
      getLastLayer(sessionID),
    );

    // 2. Curation — cost-aware frequency: on expensive worker models, curate
    //    less often (same multiplier as the inline path in pipeline.ts).
    if (allowWorker && cfg.knowledge.enabled && cfg.curator.onIdle) {
      try {
        const workerModelID = model?.modelID ?? "unknown";
        const modelInputCost =
          getModelEntrySync(workerModelID).cost?.input ?? 3;
        const curationMultiplier =
          modelInputCost >= 5 ? 3 : modelInputCost >= 1 ? 2 : 1;
        const effectiveAfterTurns = cfg.curator.afterTurns * curationMultiplier;
        if (state.turnsSinceCuration >= effectiveAfterTurns) {
          const result = await Sentry.startSpan(
            {
              name: "lore.curator",
              op: "lore.curation",
              attributes: { trigger: "idle" },
            },
            () =>
              curator.run({
                llm,
                projectPath,
                sessionID,
                model,
                workerHealth: makeWorkerHealth(sessionID, "lore-curator"),
                // #627 Phase 1: stamp the session's gitHead on curator entries.
                metadata: buildSessionMetadata(state.gitHead),
              }),
          );
          state.turnsSinceCuration = 0;
          saveSessionTracking(sessionID, { turnsSinceCuration: 0 });
          if (result.created > 0 || result.updated > 0 || result.deleted > 0) {
            log.info(
              `idle curation: ${result.created} created, ${result.updated} updated, ${result.deleted} deleted`,
            );
            emitCurationMetrics({ ...result, trigger: "idle" });
            onKnowledgeChanged?.(sessionID, result);
            // NOTE: intentionally do NOT clear the consolidation cooldown here.
            // At a saturated cap, curation churns entries every sweep; clearing
            // on any change defeated the cooldown entirely. consolidationCooldown-
            // Active() instead re-attempts only when the set materially GROWS.
          }
        }
      } catch (e) {
        log.error("idle curation error:", e);
      }
    }

    // 3. Knowledge confidence lifecycle (local DB-only, runs regardless of
    //    allowWorker). Decay first — lower confidence for entries unreinforced
    //    past the grace window (interval-gated to once/24h per project) — then
    //    prune anything that has reached the relevance floor. Keeps the row
    //    count and the curator's existing-entries context lean.
    if (cfg.knowledge.enabled) {
      try {
        // Credit injected entries by this session's verifier outcome (#497)
        // BEFORE decay/prune, so a penalty that reaches the relevance floor is
        // reaped in the same pass. Once-per-session (idempotent).
        if (cfg.knowledge.outcomeReward) {
          const credit = ltm.creditSessionOutcome(sessionID, projectPath);
          if (credit.credited > 0) {
            log.info(
              `outcome (${credit.verdict}): adjusted ${credit.credited} injected knowledge entries`,
            );
          }
        }
        const decayed = ltm.decayProject(projectPath);
        if (decayed > 0) {
          log.info(`decayed ${decayed} unreinforced knowledge entries`);
        }
        // Reference-validity (#627 Phase 0): local Direct-FS mode only — runs
        // when the gateway can stat the repo (native plugin / `lore run`/`start`
        // co-located). Remote-mode projects (root not statable here) are checked
        // by the synthetic client probe on the request path instead. Runs BEFORE
        // prune so an entry pushed to the floor is reaped in the same pass.
        if (cfg.knowledge.referenceValidation && existsSync(projectPath)) {
          try {
            const res = await ltm.validateProjectReferences(
              projectPath,
              new DirectFsResolver(projectPath),
            );
            if (res.penalized > 0) {
              log.info(
                `reference drift: penalized ${res.penalized}/${res.checked} entries with unresolved references`,
              );
            }
          } catch (e) {
            log.warn("idle reference-validation error (non-fatal):", e);
          }
        }
        const pruned = ltm.pruneDeadEntries(projectPath);
        if (pruned.length > 0) {
          log.info(
            `pruned ${pruned.length} dead knowledge entries (<= relevance floor)`,
          );
        }
      } catch (e) {
        log.error("idle knowledge-lifecycle error:", e);
      }
    }

    // Load project entries once for steps 4 (consolidation) and 6 (export).
    // Re-queried only if consolidation actually runs and mutates entries.
    let entries = cfg.knowledge.enabled
      ? ltm.forProject(projectPath, false)
      : [];

    // 4. Consolidation — runs after curation so new entries are counted.
    //    Cooldown: skip if we already attempted consolidation for this project
    //    with the same entry count within the last hour — avoids wasting
    //    Sonnet calls when the LLM correctly concludes all entries are unique.
    if (allowWorker && cfg.knowledge.enabled) {
      try {
        // Per-category bloat check counts PROJECT-SCOPED entries only — matching
        // what category-focused consolidation will actually merge (it excludes
        // cross-project entries to avoid one project deleting a globally-shared
        // preference). Global-preference duplicates are prevented at create time
        // by dedupePreferenceCreates instead.
        const catCounts = new Map<string, number>();
        for (const e of entries) {
          catCounts.set(e.category, (catCounts.get(e.category) ?? 0) + 1);
        }
        let topCategory = "";
        let topCategoryCount = 0;
        for (const [cat, n] of catCounts) {
          if (n > topCategoryCount) {
            topCategoryCount = n;
            topCategory = cat;
          }
        }
        const categoryThreshold = perCategoryThreshold(cfg.curator.maxEntries);
        const globalOver = entries.length > cfg.curator.maxEntries;
        const categoryOver = topCategoryCount > categoryThreshold;
        if (globalOver || categoryOver) {
          const cooldown = consolidationCooldown.get(projectId);
          const now = Date.now();
          // Skip when (a) a no-op attempt is still sticky (see helper), or
          // (b) another idle session for this project already has a
          // consolidation in flight — the cooldown is set only AFTER the await,
          // so without this guard concurrent sessions all pass the gate.
          if (
            consolidationCooldownActive(
              cooldown,
              now,
              entries.length,
              topCategoryCount,
            ) ||
            consolidationInProgress.has(projectId)
          ) {
            // Skip — avoid the consolidation retry storm.
          } else {
            log.info(
              globalOver
                ? `entry count ${entries.length} exceeds maxEntries ${cfg.curator.maxEntries} — running consolidation`
                : `category "${topCategory}" count ${topCategoryCount} exceeds per-category threshold ${categoryThreshold} — running consolidation`,
            );
            const beforeCount = entries.length;
            consolidationInProgress.add(projectId);
            try {
              const result = await Sentry.startSpan(
                {
                  name: "lore.consolidation",
                  op: "lore.curation",
                  attributes: { trigger: "consolidation" },
                },
                () =>
                  curator.consolidate({
                    llm,
                    projectPath,
                    sessionID,
                    model,
                    // Category-focused mode when only the per-category threshold
                    // is exceeded (global count still under maxEntries) — merges
                    // the bloated category's near-duplicates directly.
                    ...(!globalOver && categoryOver
                      ? { focusCategory: topCategory }
                      : {}),
                    workerHealth: makeWorkerHealth(sessionID, "lore-curator"),
                  }),
              );
              if (result.updated > 0 || result.deleted > 0) {
                log.info(
                  `consolidation: ${result.updated} updated, ${result.deleted} deleted`,
                );
                emitCurationMetrics({
                  created: 0,
                  ...result,
                  trigger: "consolidation",
                });
                // Consolidation mutated entries — refresh for step 6 (export).
                entries = ltm.forProject(projectPath, false);
                // Consolidation made progress — clear cooldown so it can retry
                consolidationCooldown.delete(projectId);
              } else {
                // Consolidation produced no changes — enter cooldown to prevent
                // retry storm (the LLM thinks all entries are unique).
                consolidationCooldown.set(projectId, {
                  attemptedAt: Date.now(),
                  entryCount: beforeCount,
                  topCategoryCount,
                });
                log.info(
                  `consolidation produced no changes — cooldown active for 1h ` +
                    `(${beforeCount} entries in ${projectPath})`,
                );
              }
            } finally {
              consolidationInProgress.delete(projectId);
            }
          }
        }
      } catch (e) {
        log.error("idle consolidation error:", e);
      }
    }

    // 4.5 Contradiction detection (#1123). Idle-time, LLM-gated: find genuinely
    // OPPOSING knowledge pairs and record them for the user to resolve on the
    // dashboard / CLI. Never merges or deletes — the affirmative of the
    // consolidation "opposing rules are never duplicates" invariant. Runs AFTER
    // consolidation so it judges the post-merge entry set (paraphrase duplicates
    // already collapsed), and is throttled / in-flight-guarded like it.
    if (allowWorker && cfg.knowledge.enabled && model) {
      try {
        const now = Date.now();
        if (
          contradictionCooldownActive(
            contradictionCooldown.get(projectId),
            now,
          ) ||
          contradictionInProgress.has(projectId)
        ) {
          // Throttled or a pass is already in flight for this project — skip.
        } else {
          // Arm the cooldown UNCONDITIONALLY before the work: a "nothing found"
          // pass must still throttle the next attempt (pattern-echo gotcha).
          contradictionCooldown.set(projectId, now);
          contradictionInProgress.add(projectId);
          try {
            const res = await contradiction.detectContradictions({
              projectPath,
              sessionID,
              llm,
              model,
            });
            if (res.found > 0) {
              log.info(
                `contradiction detection: ${res.found} new contradiction(s) surfaced ` +
                  `(${res.judged} judged) in ${projectPath}`,
              );
            }
          } finally {
            contradictionInProgress.delete(projectId);
          }
        }
      } catch (e) {
        log.error("idle contradiction detection error:", e);
      }
    }

    // 5. Temporal pruning
    try {
      const { ttlDeleted, capDeleted } = temporal.prune({
        projectPath,
        retentionDays: cfg.pruning.retention,
        maxStorageMB: cfg.pruning.maxStorage,
      });
      if (ttlDeleted > 0 || capDeleted > 0) {
        log.info(
          `pruned temporal messages: ${ttlDeleted} by TTL, ${capDeleted} by size cap`,
        );
      }
    } catch (e) {
      log.error("idle pruning error:", e);
    }

    // 6. Knowledge export (.lore.md + optional agents file)
    //    Reuses `entries` from step 4 (re-queried only if consolidation mutated).
    if (cfg.knowledge.enabled) {
      try {
        if (entries.length > 0) {
          if (cfg.loreFile.enabled && cfg.agentsFile.enabled) {
            // Default: .lore.md + AGENTS.md pointer
            const filePath = join(projectPath, cfg.agentsFile.path);
            exportToFile({ projectPath, filePath, entries });
          } else if (cfg.loreFile.enabled) {
            // .lore.md only
            exportLoreFile(projectPath, entries);
          } else if (cfg.agentsFile.enabled) {
            // Inline knowledge in AGENTS.md (no .lore.md)
            const filePath = join(projectPath, cfg.agentsFile.path);
            exportInlineToAgentsFile({ projectPath, filePath, entries });
          }
          // else: both disabled — no markdown file
        }
      } catch (e) {
        log.error("idle knowledge export error:", e);
      }
    }

    // 7. Dead reference cleanup — moved to the scheduler level (once per tick,
    //    not per session) since cleanDeadRefs is a global operation.

    // 8. lat.md refresh
    try {
      latReader.refresh(projectPath);
    } catch (e) {
      log.error("idle lat-reader refresh error:", e);
    }

    // 9. Emit session cost/savings metrics to Sentry
    emitSessionCostMetrics(sessionID);

    // 10. Persist live session cost snapshot to DB so historical estimates
    //    include all worker costs, avoided compactions, cache warming,
    //    1h TTL, and batch API savings after restart.
    try {
      persistSessionCosts(sessionID);
    } catch (e) {
      log.error("idle session cost persistence error:", e);
    }
  };
}
