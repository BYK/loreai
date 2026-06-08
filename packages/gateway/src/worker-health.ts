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
  | "circuit-breaker";

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

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state: Map<string, SessionHealth> = new Map();

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
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
  now = () => Date.now();
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
    Sentry.captureMessage(
      `Worker health degraded for session ${sessionID.slice(0, 16)}`,
      {
        level: "error",
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
      },
    );
  }

  // Critical escalation: sustained 1h+ of failure → Sentry exception.
  // Throttled to once per hour per session to avoid alert fatigue.
  const sustainedMs = t - entry.firstFailureAt;
  if (sustainedMs >= CRITICAL_THRESHOLD_MS) {
    const shouldException =
      !entry.exceptionSentAt || t - entry.exceptionSentAt > 60 * 60 * 1000;
    if (shouldException) {
      entry.exceptionSentAt = t;
      const err = new Error(
        `Worker health critical: ${entry.failureCount} failures sustained for ${formatDuration(sustainedMs)} on session ${sessionID}`,
      );
      Sentry.captureException(err, {
        tags: {
          worker_id: workerID,
          reason,
          session_id: sessionID,
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
  const entry = state.get(sessionID);
  if (!entry) return;

  const wasInAlertState = entry.alertSentAt !== undefined;
  state.delete(sessionID);

  if (wasInAlertState) {
    log.info(
      `[worker-health] session ${sessionID.slice(0, 16)} recovered (was degraded, now healthy)`,
    );
    Sentry.captureMessage(
      `Worker health recovered for session ${sessionID.slice(0, 16)}`,
      {
        level: "info",
        tags: { session_id: sessionID },
      },
    );
  }
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
