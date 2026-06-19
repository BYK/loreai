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

import { join } from "node:path";
import {
  temporal,
  distillation,
  curator,
  ltm,
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
  evictSession as evictGradientSession,
  distillLimiter,
  curatorLimiter,
} from "@loreai/core";
import type { ChangedEntry, LLMClient } from "@loreai/core";
import {
  makeWorkerHealth,
  allowWorkerProbe,
  isWorkerCreditPaused,
} from "./worker-health";
import type { GatewayConfig } from "./config";
import type { SessionState } from "./translate/types";
import { getWorkerModel, getModelEntrySync } from "./worker-model";
import {
  isCircuitBreakerTripped,
  isWarmupAuthDisabled,
  clearWarmupAuthDisabled,
  resolveProfile,
  blendedHistogramForSession,
  shouldWarm,
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

const POLL_INTERVAL_MS = 30_000;

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

  const timer = setInterval(() => {
    const now = Date.now();
    const timeoutMs = config.idleTimeoutSeconds * 1000;

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

      inProgress.add(sessionID);
      // Scope the circuit-breaker check to the provider this session's worker
      // will call — a 429 from a different provider must not pause this work.
      const idleProviderID = getWorkerModel(state.lastUpstream)?.providerID;
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
    if (isCircuitBreakerTripped()) return;

    for (const [sessionID, state] of sessions) {
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

      const profile = resolveProfile(
        state.lastUpstream?.model,
        state.lastUpstream?.protocol,
        state.resolvedConversationTTL,
        // Pass the session's real upstream URL + providerID so the warmer warms
        // only true-Anthropic sessions (first-party host OR providerID
        // "anthropic", incl. proxied Anthropic) and never sends a compat
        // provider's key to api.anthropic.com (MiniMax 401 loop).
        state.lastUpstream?.url,
        state.lastUpstream?.providerID,
      );
      if (!profile) continue;

      const blendedHist = blendedHistogramForSession(state);
      if (!shouldWarm(state, profile, blendedHist, now)) continue;

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
        const costs = getSessionCosts(sessionID);
        if (costs && costs.conversation.turns > 0) {
          saveSessionCosts(sessionID, {
            conversationCost: costs.conversation.cost,
            workerCost: totalWorkerCost(costs),
            conversationTurns: costs.conversation.turns,
            cacheReadTokens: costs.conversation.cacheReadTokens,
            cacheWriteTokens: costs.conversation.cacheWriteTokens,
            warmupSavings: costs.counterfactual.warmupSavings,
            warmupHits: costs.counterfactual.warmupHits,
            ttlSavings: costs.counterfactual.ttlSavings,
            ttlHits: costs.counterfactual.ttlHits,
            batchSavings: costs.batchSavings,
            avoidedCompactions: costs.counterfactual.avoidedCompactions,
            avoidedCompactionCost: costs.counterfactual.avoidedCompactionCost,
          });
        }
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
      const costs = getSessionCosts(sessionID);
      if (costs && costs.conversation.turns > 0) {
        saveSessionCosts(sessionID, {
          conversationCost: costs.conversation.cost,
          workerCost: totalWorkerCost(costs),
          conversationTurns: costs.conversation.turns,
          cacheReadTokens: costs.conversation.cacheReadTokens,
          cacheWriteTokens: costs.conversation.cacheWriteTokens,
          warmupSavings: costs.counterfactual.warmupSavings,
          warmupHits: costs.counterfactual.warmupHits,
          ttlSavings: costs.counterfactual.ttlSavings,
          ttlHits: costs.counterfactual.ttlHits,
          batchSavings: costs.batchSavings,
          avoidedCompactions: costs.counterfactual.avoidedCompactions,
          avoidedCompactionCost: costs.counterfactual.avoidedCompactionCost,
        });
      }
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

    // 1. Distillation — force-distill ALL pending messages on idle, even
    // below minMessages. The cache is going cold; aggressive distillation
    // now means a smaller context on the next turn via post-idle compact.
    // Skip meta-distillation in the run() call: we run it as a separate
    // step below so gen-0 segments from the force-distill are counted.
    try {
      const callType =
        process.env.LORE_BATCH_DISABLED === "1"
          ? ("direct" as const)
          : ("batch" as const);
      const pending = temporal.undistilledCount(projectPath, sessionID);
      if (allowWorker && pending > 0) {
        await distillation.run({
          llm,
          projectPath,
          sessionID,
          model,
          force: true,
          skipMeta: true,
          callType,
          workerHealth: makeWorkerHealth(sessionID, "lore-distill"),
        });
      }
      // Meta consolidation: safe on idle because cache is already cold.
      // Run as a separate step so gen-0 segments from the force-distill
      // above are counted toward the threshold.
      // Under bust pressure (3+ consecutive busts), lower the threshold
      // to consolidate earlier — shrinks the distilled prefix before the
      // session becomes unsustainable.
      const busts = getConsecutiveBusts(sessionID);
      const metaThreshold = effectiveMetaThreshold(
        busts,
        cfg.distillation.metaThreshold,
      );
      const g0 = distillation.gen0Count(projectPath, sessionID);
      if (allowWorker && g0 >= metaThreshold) {
        await distillation.metaDistill({
          llm,
          projectPath,
          sessionID,
          model,
          callType,
          workerHealth: makeWorkerHealth(sessionID, "lore-distill"),
        });
      }
    } catch (e) {
      log.error("idle distillation error:", e);
    }

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
        const decayed = ltm.decayProject(projectPath);
        if (decayed > 0) {
          log.info(`decayed ${decayed} unreinforced knowledge entries`);
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

    // 4. Consolidation — runs after curation so new entries are counted.
    //    Cooldown: skip if we already attempted consolidation for this project
    //    with the same entry count within the last hour — avoids wasting
    //    Sonnet calls when the LLM correctly concludes all entries are unique.
    if (allowWorker && cfg.knowledge.enabled) {
      try {
        const entries = ltm.forProject(projectPath, false);
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
    if (cfg.knowledge.enabled) {
      try {
        const entries = ltm.forProject(projectPath, false);
        if (entries.length > 0) {
          if (cfg.loreFile.enabled && cfg.agentsFile.enabled) {
            // Default: .lore.md + AGENTS.md pointer
            const filePath = join(projectPath, cfg.agentsFile.path);
            exportToFile({ projectPath, filePath });
          } else if (cfg.loreFile.enabled) {
            // .lore.md only
            exportLoreFile(projectPath);
          } else if (cfg.agentsFile.enabled) {
            // Inline knowledge in AGENTS.md (no .lore.md)
            const filePath = join(projectPath, cfg.agentsFile.path);
            exportInlineToAgentsFile({ projectPath, filePath });
          }
          // else: both disabled — no markdown file
        }
      } catch (e) {
        log.error("idle knowledge export error:", e);
      }
    }

    // 7. Dead reference cleanup
    if (cfg.knowledge.enabled) {
      try {
        const cleaned = ltm.cleanDeadRefs();
        if (cleaned > 0) {
          log.info(`cleaned ${cleaned} dead knowledge cross-references`);
        }
      } catch (e) {
        log.error("idle dead-ref cleanup error:", e);
      }
    }

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
      const costs = getSessionCosts(sessionID);
      if (costs && costs.conversation.turns > 0) {
        saveSessionCosts(sessionID, {
          conversationCost: costs.conversation.cost,
          workerCost: totalWorkerCost(costs),
          conversationTurns: costs.conversation.turns,
          cacheReadTokens: costs.conversation.cacheReadTokens,
          cacheWriteTokens: costs.conversation.cacheWriteTokens,
          warmupSavings: costs.counterfactual.warmupSavings,
          warmupHits: costs.counterfactual.warmupHits,
          ttlSavings: costs.counterfactual.ttlSavings,
          ttlHits: costs.counterfactual.ttlHits,
          batchSavings: costs.batchSavings,
          avoidedCompactions: costs.counterfactual.avoidedCompactions,
          avoidedCompactionCost: costs.counterfactual.avoidedCompactionCost,
        });
      }
    } catch (e) {
      log.error("idle session cost persistence error:", e);
    }
  };
}
