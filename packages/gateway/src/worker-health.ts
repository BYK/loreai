/**
 * Worker health tracking and graduated escalation.
 *
 * Background workers (distillation, curation, query expansion, cache warming)
 * can fail for various reasons — no auth, protocol mismatch, upstream error.
 * When they fail, the current code path silently returns `null` and the
 * operation is skipped. This is **actively harmful** because:
 *
 *  1. **Distillation skip → context bloat.** Without distillation, the
 *     conversation grows unbounded, eventually overflowing the model's
 *     context window. The user pays more for tokens and gets slower
 *     responses.
 *  2. **Curation skip → no LTM growth.** Without curation, long-term
 *     knowledge never accumulates. The user loses the recall/auto-suggest
 *     benefits of lore.
 *  3. **Cache-warmup skip → cache misses.** The prompt cache goes cold,
 *     every turn re-processes the system prompt, costs balloon.
 *
 * The previous design was silent because single failures are usually transient
 * (OAuth refresh, key rotation) and not worth alarming. But sustained failure
 * is harmful and the user must know.
 *
 * This module implements a graduated escalation ladder:
 *
 *  - 1-2 failures in 5 min: log warn (current behavior preserved for transients)
 *  - 3rd failure in 5 min: log error + Sentry.captureMessage (debounced 15 min)
 *  - Sustained 30+ min: getDegradationWarning() returns non-null for
 *    injection into the next user response
 *  - Sustained 60+ min: Sentry.captureException (full alert, not debounced)
 *  - Any successful worker call: clear state, optionally send Sentry recovery
 *
 * All public functions are safe to call concurrently (single-threaded event
 * loop) and idempotent. State is per-session and TTL-evicted.
 */

import * as Sentry from "@sentry/bun";
import { log } from "@loreai/core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Stable IDs for the worker kinds. Used in metrics tags and Sentry scope. */
export type WorkerID =
  | "lore-distill"
  | "lore-curator"
  | "lore-pattern-echo"
  | "lore-query-expand"
  | "lore-compact"
  | "lore-import"
  | "cache-warmer"
  | "lore-batch";

/** Categorical reason for a failure. Drives metric tags and dashboards. */
export type FailureReason =
  | "no-auth"
  | "auth-rejected"
  | "protocol-mismatch"
  | "cross-provider"
  | "upstream-error"
  | "no-response"
  | "parse-error"
  | "rate-limit"
  | "circuit-breaker"
  // Non-escalating: a specific provider+model consistently returns no usable
  // text even after the reasoning-field fallback (e.g. a free aggregator model
  // that only emits reasoning, or refuses the observer prompt). This is a
  // capability limitation of the model, NOT an outage — it must not drive the
  // degraded/critical Sentry ladder or the circuit breaker. We record it for
  // visibility and cache the verdict so we stop calling that model.
  | "worker-incapable";

/** Snapshot of a session's worker health, suitable for the dashboard. */
export type SessionHealth = {
  sessionID: string;
  firstFailureAt: number;
  lastFailureAt: number;
  failureCount: number; // in current sliding window
  reasons: Set<FailureReason>;
  workerIDs: Set<WorkerID | string>;
  alertSentAt?: number; // last Sentry message timestamp (debounce)
  exceptionSentAt?: number; // last Sentry exception timestamp (per-hour cap)
};

/** State of the worker health for a session. Used in response headers. */
export type WorkerHealthStatus = "healthy" | "degraded" | "critical";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Sliding window for failure counting. */
const FAILURE_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

/** Number of failures in the window that triggers the first alert. */
const DEGRADED_THRESHOLD = 3;

/** Minimum time between Sentry message events for the same session. */
const ALERT_COOLDOWN_MS = 15 * 60 * 1000; // 15 minutes

/** Sustained failure duration that triggers response-message injection. */
const RESPONSE_MESSAGE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

/** Sustained failure duration that triggers Sentry exception (not debounced). */
const CRITICAL_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour

/** Per-session TTL after last failure. State is evicted when this expires. */
const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour

/** How often the TTL sweep runs. */
const SWEEP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Sustained failure duration after which the circuit breaker opens. Once we've
 * been failing this long the upstream is genuinely down (not a transient blip),
 * so callers should stop hammering it every turn and probe only periodically.
 *
 * Independent of (but currently equal to) {@link RESPONSE_MESSAGE_THRESHOLD_MS}:
 * "when to stop hammering the upstream" is a distinct concern from "when to
 * warn the user", so they get their own constants even though both are 30m
 * today — changing one for UX reasons must not silently change the other.
 */
const CIRCUIT_OPEN_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

/**
 * While the circuit is open, allow at most one worker probe per this interval.
 * Because every failed probe refreshes `lastFailureAt`, gating on the age of
 * the last failure throttles attempts to roughly one per interval — turning a
 * runaway (thousands of failures/hour) into a slow heartbeat that still
 * detects recovery.
 */
const CIRCUIT_PROBE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state: Map<string, SessionHealth> = new Map();

/**
 * Sessions soft-paused due to an upstream credit/billing state (HTTP 402,
 * e.g. OpenRouter "requires more credits"). Distinct from the failure-ladder
 * circuit in `state`: this is an *expected* account state, not an outage, so
 * it carries NO Sentry escalation. Cleared on the session's next successful
 * worker call. A single probe is allowed per CIRCUIT_PROBE_INTERVAL_MS so a
 * credit top-up recovers automatically without spamming the upstream.
 */
const creditPaused: Map<string, { lastProbe: number }> = new Map();

/**
 * Provider+model verdicts for models that consistently return no usable worker
 * output even after the reasoning-field fallback. Keyed by `${providerID}/${modelID}`.
 * Once a model is marked incapable, callers skip worker LLM calls for it
 * (distillation/curation simply defer; the raw data stays recallable). This is
 * a process-lifetime cache — a verdict is a stable capability fact, not a
 * transient outage, so it is intentionally NOT TTL-evicted. Cleared only on
 * process restart or `_resetForTest`.
 */
const incapableModels: Set<string> = new Set();

let sweepTimer: ReturnType<typeof setInterval> | null = null;

/** Injectable time source — tests can override. */
let now: () => number = () => Date.now();

/** Internal accessor for tests. */
export function _setNowForTest(fn: () => number): void {
  now = fn;
}

/** Internal accessor for tests. Resets the global state. */
export function _resetForTest(): void {
  state.clear();
  creditPaused.clear();
  incapableModels.clear();
  consecutiveEmpty.clear();
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
  now = () => Date.now();
}

// ---------------------------------------------------------------------------
// Worker-incapable verdicts — non-escalating per-model skip
// ---------------------------------------------------------------------------

/**
 * Consecutive complete-but-empty responses a model must produce before we
 * conclude it is genuinely incapable. A single empty completion is often
 * transient or prompt-specific (a one-off glitch, a refusal), so we require a
 * small run before permanently skipping the model.
 */
const INCAPABLE_THRESHOLD = 3;

/** Per-model count of consecutive complete-but-empty responses. */
const consecutiveEmpty: Map<string, number> = new Map();

/** Build the verdict key for a provider+model pair. */
function modelKey(providerID: string, modelID: string): string {
  return `${providerID}/${modelID}`;
}

/**
 * Decide whether a complete-but-empty worker response indicates a model
 * CAPABILITY problem (vs a transient/recoverable one) based on the upstream
 * finish/stop reason.
 *
 * Excluded (these are NOT capability facts, so they stay retryable no-response):
 *  - undefined          — unknown shape; can't conclude incapacity
 *  - "length"           — OpenAI output-budget truncation
 *  - "max_tokens"       — Anthropic output-budget truncation (same as length)
 *  - "content_filter"   — prompt-specific moderation, not a model trait
 *  - "tool_calls" /
 *    "tool_use"         — the model emitted tool calls, not text (expected)
 *
 * Everything else (e.g. "stop", "end_turn") with empty text after the
 * reasoning-field fallback counts as a complete response that produced nothing
 * usable — a capability signal.
 */
export function isCapabilityEmpty(finishReason: string | undefined): boolean {
  if (finishReason == null) return false;
  return ![
    "length",
    "max_tokens",
    "content_filter",
    "tool_calls",
    "tool_use",
  ].includes(finishReason);
}

/**
 * Record a complete-but-empty worker response for a model and return true when
 * the model should now be marked incapable (threshold of consecutive empties
 * reached). Non-capability finish reasons (truncation, content filter, tool
 * calls) reset the streak and never mark.
 */
export function recordEmptyWorkerResponse(
  providerID: string,
  modelID: string,
  finishReason: string | undefined,
): boolean {
  const key = modelKey(providerID, modelID);
  if (!isCapabilityEmpty(finishReason)) {
    consecutiveEmpty.delete(key); // transient/expected — reset the streak
    return false;
  }
  const n = (consecutiveEmpty.get(key) ?? 0) + 1;
  consecutiveEmpty.set(key, n);
  if (n >= INCAPABLE_THRESHOLD) {
    markWorkerIncapable(providerID, modelID);
    return true;
  }
  return false;
}

/** Clear the consecutive-empty streak for a model (on a usable response). */
export function clearEmptyWorkerStreak(
  providerID: string,
  modelID: string,
): void {
  consecutiveEmpty.delete(modelKey(providerID, modelID));
}

/**
 * Mark a provider+model as incapable of producing usable worker output, so
 * future worker calls for it are skipped. Idempotent. Logs once per model.
 */
export function markWorkerIncapable(providerID: string, modelID: string): void {
  const key = modelKey(providerID, modelID);
  if (incapableModels.has(key)) return;
  incapableModels.add(key);
  log.warn(
    `[worker-health] model ${key} marked worker-incapable — ` +
      `it returned no usable text after the reasoning-field fallback ` +
      `for ${INCAPABLE_THRESHOLD} consecutive complete responses; ` +
      `skipping background worker calls for it (data stays recallable)`,
  );
}

/** True when a provider+model has been marked worker-incapable. */
export function isWorkerIncapable(
  providerID: string,
  modelID: string,
): boolean {
  return incapableModels.has(modelKey(providerID, modelID));
}

// ---------------------------------------------------------------------------
// Credit pause (HTTP 402) — soft, non-escalating worker pause
// ---------------------------------------------------------------------------

/**
 * Soft-pause a session's background workers due to an upstream credit/billing
 * state (HTTP 402). Idempotent — re-marking an already-paused session does not
 * reset its probe cadence. Does NOT feed the failure ladder, so it never
 * escalates to Sentry.
 */
export function markWorkerPaused(sessionID: string): void {
  if (!creditPaused.has(sessionID)) {
    creditPaused.set(sessionID, { lastProbe: now() });
  }
}

/**
 * Whether a session is currently credit-paused. Allows one probe per
 * CIRCUIT_PROBE_INTERVAL_MS (returning `false` for that single call and
 * advancing the probe clock) so a credit top-up recovers automatically.
 */
export function isWorkerCreditPaused(sessionID: string): boolean {
  const entry = creditPaused.get(sessionID);
  if (!entry) return false;
  const t = now();
  if (t - entry.lastProbe >= CIRCUIT_PROBE_INTERVAL_MS) {
    entry.lastProbe = t; // allow one probe through, then resume pausing
    return false;
  }
  return true;
}

/** Clear a session's credit pause (e.g. after a successful worker call). */
export function clearWorkerPaused(sessionID: string): void {
  creditPaused.delete(sessionID);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Record a worker failure. Decides whether to log, escalate to Sentry, or
 * both, based on the graduated escalation ladder.
 *
 * Safe to call from any worker path. Concurrent calls for the same session
 * are serialized by the event loop; no locking needed.
 *
 * @param sessionID  The session the worker is operating on. May be "_unknown"
 *                   for session-less operations (e.g. some warmup paths).
 * @param workerID   Stable worker identifier (for grouping and tags). The
 *                   `WorkerID` type lists the canonical set; callers may pass
 *                   any string for forward-compatibility.
 * @param reason     Categorical reason for the failure.
 */
export function recordWorkerFailure(
  sessionID: string,
  workerID: WorkerID | string,
  reason: FailureReason,
): void {
  const t = now();

  // worker-incapable is a model capability fact, not an outage. Never let it
  // drive the degraded/critical Sentry ladder or the circuit breaker — that
  // would spam alerts for a model that is simply unsuitable for worker calls.
  // It is recorded (warn) for visibility; the verdict cache (markWorkerIncapable)
  // is what actually stops further calls.
  if (reason === "worker-incapable") {
    log.warn(
      `[worker-health] ${workerID} skipped (worker-incapable) for session=${sessionID.slice(0, 16)}`,
    );
    return;
  }

  let entry = state.get(sessionID);

  // Initialize or rotate the sliding window.
  //
  // Two axes to reconcile:
  //  - Sliding window (FAILURE_WINDOW_MS = 5m): the counter that triggers the
  //    first Sentry alert. Reset on entry to the new window.
  //  - Sustained duration (RESPONSE_MESSAGE_THRESHOLD_MS = 30m,
  //    CRITICAL_THRESHOLD_MS = 60m): measured from firstFailureAt. MUST be
  //    preserved across window rotations, otherwise a session that fails every
  //    4 minutes would never accumulate to 30/60 minutes of sustained outage.
  //
  // The full TTL (SESSION_TTL_MS = 1h) is the eviction bound — once the gap
  // since lastFailureAt exceeds it, the session is considered fully recovered
  // and we start fresh (including resetting firstFailureAt).
  if (!entry) {
    entry = {
      sessionID,
      firstFailureAt: t,
      lastFailureAt: t,
      failureCount: 0,
      reasons: new Set(),
      workerIDs: new Set(),
    };
    state.set(sessionID, entry);
  } else if (t - entry.lastFailureAt > SESSION_TTL_MS) {
    // Stale entry past full TTL — fully recovered. Start fresh.
    state.delete(sessionID);
    entry = {
      sessionID,
      firstFailureAt: t,
      lastFailureAt: t,
      failureCount: 0,
      reasons: new Set(),
      workerIDs: new Set(),
    };
    state.set(sessionID, entry);
  } else if (t - entry.lastFailureAt > FAILURE_WINDOW_MS) {
    // New sliding window within the same sustained outage: reset the counter
    // and reason/worker sets, but KEEP firstFailureAt so the 30m/60m
    // sustained thresholds continue to accumulate.
    entry.failureCount = 0;
    entry.reasons = new Set();
    entry.workerIDs = new Set();
  }

  entry.failureCount++;
  entry.lastFailureAt = t;
  entry.reasons.add(reason);
  entry.workerIDs.add(workerID);

  // First 1-2 failures: silent at the warn level. This preserves the
  // existing behavior for transient errors (OAuth refresh, momentary 429).
  if (entry.failureCount < DEGRADED_THRESHOLD) {
    log.warn(
      `[worker-health] ${workerID} failed (${reason}) for session=${sessionID.slice(0, 16)} — ${entry.failureCount} in window`,
    );
    ensureSweepTimer();
    return;
  }

  // Threshold reached: log at error and consider Sentry escalation.
  log.error(
    `[worker-health] ${workerID} degraded: ${entry.failureCount} failures in 5min for session=${sessionID.slice(0, 16)} (reasons: ${[...entry.reasons].join(", ")})`,
  );

  // Debounce: don't re-alert within ALERT_COOLDOWN_MS.
  const shouldAlert =
    !entry.alertSentAt || t - entry.alertSentAt > ALERT_COOLDOWN_MS;
  if (shouldAlert) {
    entry.alertSentAt = t;
    // Stable message + fingerprint so Sentry groups all degradations of a
    // given worker into ONE issue. The session ID / counts vary per event and
    // MUST live in tags+contexts only — embedding them in the message text
    // spawns a new Sentry issue per session (LOREAI-GATEWAY worker-health noise).
    Sentry.captureMessage("Worker health degraded", {
      level: "error",
      fingerprint: ["worker-health-degraded", workerID],
      tags: {
        worker_id: workerID,
        reason,
        session_id: sessionID,
        failure_count: String(entry.failureCount),
      },
      contexts: {
        worker_health: {
          sessionID,
          workerIDs: [...entry.workerIDs],
          reasons: [...entry.reasons],
          failureCount: entry.failureCount,
          firstFailureAt: entry.firstFailureAt,
          lastFailureAt: entry.lastFailureAt,
        },
      },
    });
  }

  // Critical escalation: sustained 1h+ of failure → Sentry exception.
  // Throttled to once per hour per session to avoid alert fatigue.
  const sustainedMs = t - entry.firstFailureAt;
  if (sustainedMs >= CRITICAL_THRESHOLD_MS) {
    const shouldException =
      !entry.exceptionSentAt || t - entry.exceptionSentAt > 60 * 60 * 1000;
    if (shouldException) {
      entry.exceptionSentAt = t;
      // Stable Error message + fingerprint so Sentry groups all critical
      // outages of a given worker into ONE issue. The previous message
      // embedded the failure count, duration, AND session ID, so EVERY event
      // was a unique issue (dozens of one-off LOREAI-GATEWAY issues). The
      // varying detail lives in tags+contexts below.
      const err = new Error("Worker health critical: sustained worker failure");
      Sentry.captureException(err, {
        fingerprint: ["worker-health-critical", workerID],
        tags: {
          worker_id: workerID,
          reason,
          session_id: sessionID,
          failure_count: String(entry.failureCount),
          sustained: formatDuration(sustainedMs),
        },
        contexts: {
          worker_health: {
            sessionID,
            workerIDs: [...entry.workerIDs],
            reasons: [...entry.reasons],
            failureCount: entry.failureCount,
            sustainedMs,
          },
        },
      });
    }
  }

  ensureSweepTimer();
}

/**
 * Record a successful worker call. Clears the failure state for the session
 * and emits a Sentry recovery message if the session was previously in
 * alert state.
 */
export function recordWorkerSuccess(sessionID: string): void {
  // A successful call clears any credit pause (e.g. user topped up). Must run
  // before the early return below: credit-paused sessions have no failure-
  // ladder `state` entry (402 never calls recordWorkerFailure).
  creditPaused.delete(sessionID);

  const entry = state.get(sessionID);
  if (!entry) return;

  const wasInAlertState = entry.alertSentAt !== undefined;
  state.delete(sessionID);

  if (wasInAlertState) {
    log.info(
      `[worker-health] session ${sessionID.slice(0, 16)} recovered (was degraded, now healthy)`,
    );
    // Recovery is a GOOD event — record it as a breadcrumb (forensic context
    // for any later event in this scope) rather than a captured message, which
    // would otherwise spawn its own Sentry issue per session (noise).
    Sentry.addBreadcrumb({
      category: "worker-health",
      level: "info",
      message: "Worker health recovered",
      data: { session_id: sessionID },
    });
  }
}

/**
 * Circuit breaker: decide whether a non-urgent background worker should be
 * allowed to run for this session right now.
 *
 * Returns `true` when the session is healthy, when sustained failure hasn't
 * yet crossed {@link CIRCUIT_OPEN_THRESHOLD_MS} (circuit closed), or when the
 * circuit is open but enough time has elapsed since the last failure to allow
 * a single recovery probe. Returns `false` while the circuit is open and
 * within the probe cooldown.
 *
 * Pure read-only predicate (no side effects): the throttle clock is the
 * existing `lastFailureAt`, which {@link recordWorkerFailure} refreshes on
 * every failure. So a failed probe pushes the next allowed probe out by
 * {@link CIRCUIT_PROBE_INTERVAL_MS}, and a success ({@link recordWorkerSuccess})
 * clears the entry entirely, closing the circuit.
 *
 * Callers MUST only gate *non-urgent* background work with this. Urgent
 * distillation and blocking compaction are intentionally exempt — starving
 * them harms the user more than a futile retry costs.
 *
 * Note: those exempt paths omit the `workerHealth` hook entirely, so they are
 * invisible to the breaker — they neither open/extend it (their failures
 * aren't recorded) nor close it (no `recordWorkerSuccess`). Recovery is
 * therefore detected only by the periodic non-urgent probe this gate lets
 * through, which DOES carry the hook; recovery latency is bounded by
 * {@link CIRCUIT_PROBE_INTERVAL_MS}.
 */
export function allowWorkerProbe(sessionID: string): boolean {
  const entry = state.get(sessionID);
  if (!entry) return true; // healthy — no recorded failures

  const t = now();
  // Circuit closed: failures haven't been sustained long enough to throttle.
  if (t - entry.firstFailureAt < CIRCUIT_OPEN_THRESHOLD_MS) return true;

  // Circuit open: allow a probe only once the last failure is old enough.
  return t - entry.lastFailureAt >= CIRCUIT_PROBE_INTERVAL_MS;
}

/**
 * Returns the user-facing warning message for the next response, or null
 * if the session is healthy.
 *
 * The message is intentionally concise and actionable — the user is being
 * harmed (context bloat, no LTM growth) and needs to know.
 */
export function getDegradationWarning(sessionID: string): string | null {
  const entry = state.get(sessionID);
  if (!entry) return null;
  const sustainedMs = now() - entry.firstFailureAt;
  if (sustainedMs < RESPONSE_MESSAGE_THRESHOLD_MS) return null;
  return (
    `[Lore: Background workers (distillation, curation, cache warming) for this session ` +
    `have been failing for ${formatDuration(sustainedMs)}. This is harmful — your ` +
    `context window is not being compressed and long-term knowledge is not being ` +
    `captured. Likely cause: session authentication has gone stale. Run \`lore status\` ` +
    `or check the dashboard for details.]`
  );
}

/**
 * Returns the health status of a session, for the `X-Lore-Worker-Health`
 * response header.
 */
export function getStatus(sessionID: string): WorkerHealthStatus {
  const entry = state.get(sessionID);
  if (!entry) return "healthy";
  const sustainedMs = now() - entry.firstFailureAt;
  if (sustainedMs >= CRITICAL_THRESHOLD_MS) return "critical";
  if (sustainedMs >= RESPONSE_MESSAGE_THRESHOLD_MS) return "degraded";
  return "healthy";
}

/**
 * Snapshot of all active session health entries, for the dashboard API.
 */
export function getWorkerHealth(): Array<{
  sessionID: string;
  status: WorkerHealthStatus;
  failureCount: number;
  firstFailureAt: number;
  lastFailureAt: number;
  sustainedMs: number;
  reasons: FailureReason[];
  workerIDs: Array<WorkerID | string>;
  warning: string | null;
}> {
  const t = now();
  const result: Array<{
    sessionID: string;
    status: WorkerHealthStatus;
    failureCount: number;
    firstFailureAt: number;
    lastFailureAt: number;
    sustainedMs: number;
    reasons: FailureReason[];
    workerIDs: Array<WorkerID | string>;
    warning: string | null;
  }> = [];
  for (const entry of state.values()) {
    const sustainedMs = t - entry.firstFailureAt;
    result.push({
      sessionID: entry.sessionID,
      status:
        sustainedMs >= CRITICAL_THRESHOLD_MS
          ? "critical"
          : sustainedMs >= RESPONSE_MESSAGE_THRESHOLD_MS
            ? "degraded"
            : "healthy",
      failureCount: entry.failureCount,
      firstFailureAt: entry.firstFailureAt,
      lastFailureAt: entry.lastFailureAt,
      sustainedMs,
      reasons: [...entry.reasons],
      workerIDs: [...entry.workerIDs],
      warning: getDegradationWarning(entry.sessionID),
    });
  }
  return result;
}

/**
 * Build the adapter that core passes around as `input.workerHealth`.
 * The core's `recordFailure` accepts a free-form string; the gateway's typed
 * `FailureReason` enum drives Sentry tags and metrics. This adapter casts the
 * string to a `FailureReason` for downstream consumers.
 */
export function makeWorkerHealth(
  sessionID: string,
  workerID: WorkerID | string,
): {
  recordFailure(reason: string): void;
  recordSuccess(): void;
} {
  return {
    recordFailure(reason: string) {
      recordWorkerFailure(sessionID, workerID, reason as FailureReason);
    },
    recordSuccess() {
      recordWorkerSuccess(sessionID);
    },
  };
}

/**
 * Clear all state. Intended for tests and graceful shutdown.
 */
export function clearAll(): void {
  state.clear();
  creditPaused.clear();
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Format a duration in ms as "Xh Ym" or "Xm Ys". Used in user-facing
 * messages and Sentry tags.
 */
function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/**
 * Ensure the TTL sweep timer is running. Idempotent. The sweep evicts
 * stale entries (no activity for SESSION_TTL_MS) so the state map doesn't
 * grow unbounded across long-lived gateway processes.
 */
function ensureSweepTimer(): void {
  if (sweepTimer) return;
  if (typeof setInterval !== "function") return; // edge case: tests with no timers
  sweepTimer = setInterval(() => {
    const t = now();
    for (const [sessionID, entry] of state) {
      if (t - entry.lastFailureAt > SESSION_TTL_MS) {
        state.delete(sessionID);
      }
    }
  }, SWEEP_INTERVAL_MS);
  // Allow the process to exit without waiting on this timer.
  if (typeof (sweepTimer as { unref?: () => void }).unref === "function") {
    (sweepTimer as { unref: () => void }).unref();
  }
}
