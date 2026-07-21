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
  | "worker-incapable"
  // Non-escalating: the selected worker model is rejected by the account's
  // data policy (e.g. an OpenRouter `:free` model returns a 404 "No endpoints
  // available matching your guardrail restrictions and data policy" for an
  // account that has not opted into prompt logging). This is a per-account
  // config/availability fact, NOT an outage — the model is blocklisted and
  // selection re-resolves to a usable same-family sibling on the next pass, so
  // it must not drive the degraded/critical Sentry ladder or the circuit
  // breaker. Recorded (warn) for visibility.
  | "data-policy";

/**
 * Failure reasons that are credential/config conditions rather than upstream
 * outages. On a self-hosted gateway (the common case), these mean the user
 * hasn't provided a usable worker credential — NOT that lore or the upstream is
 * broken — so they are not actionable bugs for the lore team and must never
 * spawn a "Worker health degraded/critical" Sentry issue (LOREAI-GATEWAY-3J).
 *
 * They are NOT fully silenced (unlike `worker-incapable`, which early-returns):
 * the local error log, the time-based degraded/critical STATUS, the user-facing
 * `lore doctor` warning, and the circuit breaker are all preserved so the user
 * still gets an actionable local signal. Only the Sentry escalation is
 * suppressed, and only when EVERY failure in the current window is
 * credential-class — a window mixing in any genuine outage reason still
 * escalates. Both reasons also have dedicated handling elsewhere: `no-auth` is
 * pre-guarded at scheduling (idle.ts / scheduleBackgroundWork) and self-limits
 * once the session credential goes stale; `cross-provider` is soft-paused at
 * the call site via {@link markWorkerPaused}.
 */
const CREDENTIAL_CLASS_REASONS: ReadonlySet<FailureReason> = new Set([
  "no-auth",
  "cross-provider",
]);

/** Snapshot of a session's worker health, suitable for the dashboard. */
export type SessionHealth = {
  sessionID: string;
  firstFailureAt: number;
  lastFailureAt: number;
  failureCount: number; // in current sliding window
  reasons: Set<FailureReason>;
  workerIDs: Set<WorkerID | (string & {})>;
  // True once ANY non-credential-class (genuine outage) reason has been seen
  // during this outage. Unlike `reasons` (reset per sliding window), this
  // latches for the entry's lifetime — so a genuine failure that ages out of
  // the active window can't be silently reclassified as first-run credential
  // noise by getDegradationWarning's suppression gate.
  sawGenuineReason: boolean;
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
 * Sessions that have had at least one SUCCESSFUL worker call, with the
 * timestamp of the most recent success. Used to distinguish a first-run
 * "never authenticated yet" state from a genuine "was working, now broken"
 * degradation.
 *
 * The user-facing degradation banner ({@link getDegradationWarning}) tells the
 * user their memory is being "harmed" — accurate once a working session breaks,
 * but alarming and wrong on a brand-new install where the only failures so far
 * are `no-auth` because no turn has authenticated yet (the normal warm-up
 * window every fresh session passes through). Suppressing the banner for
 * never-succeeded credential-class-only failures avoids scaring new users; the
 * banner still fires the moment a real credential lands and later breaks, or
 * when the failures are a genuine outage rather than a missing credential.
 *
 * Bounded like {@link state}: swept on the same TTL so it can't grow unbounded.
 */
const succeededSessions: Map<string, { lastSuccessAt: number }> = new Map();

/**
 * Provider+model+worker verdicts for models that consistently return no usable
 * worker output even after the reasoning-field fallback. Keyed by
 * `${providerID}/${modelID}/${workerID}`.
 *
 * The worker dimension is load-bearing: capability is worker-kind specific. A
 * cheap model can be perfectly capable of one worker prompt (e.g. distillation,
 * which is free-form prose) yet consistently incapable of another (e.g. the
 * curator, which demands strict structured JSON). Keying the verdict on the
 * model ALONE meant a model that could distill but not curate was never marked
 * incapable — its distillation successes reset the curator empty streak (see
 * {@link consecutiveEmpty}) before it ever reached the threshold, so the broken
 * curator kept getting called and escalated the failure ladder forever with a
 * misleading "auth stale" warning. Scoping by worker fixes that: the curator is
 * disabled for the model while distillation keeps using it.
 *
 * Once a (model, worker) pair is marked incapable, callers skip worker LLM
 * calls for that pair (that worker simply defers; the raw data stays
 * recallable). This is a process-lifetime cache — a verdict is a stable
 * capability fact, not a transient outage, so it is intentionally NOT
 * TTL-evicted. Cleared only on process restart or `_resetForTest`.
 */
const incapableModels: Set<string> = new Set();

/**
 * Providers whose OpenRouter-style `:free` worker models are blocked by the
 * account's data policy. Populated when {@link markFreeModelsDataBlocked} is
 * called after a data-policy 404 (see `isDataPolicyBlocked404` in llm-adapter).
 *
 * User directive: once we observe ONE data-policy 404 on a `:free` model, we
 * assume ALL `:free` models on that provider are data-collection-gated and
 * therefore unusable on this account, so worker-model selection skips the
 * entire `:free` tier for that provider. This is provider-scoped (not global)
 * and only ever LEARNED from an actual 404 — we never statically exclude
 * `:free`, since a different account may have opted in.
 *
 * In-memory only: resets on process restart and is re-learned on the first
 * data-policy 404 after a restart. This self-heals if the account later opts
 * into the provider's data policy (a restart clears the block; the newly-usable
 * `:free` model simply stops 404ing).
 */
const freeModelsDataBlocked: Set<string> = new Set();

/**
 * Monotonic counter bumped whenever the model blocklist changes
 * ({@link markWorkerIncapable} adds a new verdict, or
 * {@link markFreeModelsDataBlocked} adds a new provider). Worker-model
 * selection memoizes resolutions keyed on the models.dev snapshot version; it
 * must ALSO key on this generation so a freshly-blocklisted model is not served
 * from a stale memo entry. Read via {@link blocklistGeneration}.
 */
let blocklistGen = 0;

/**
 * Current blocklist generation. Bumped by {@link markWorkerIncapable} and
 * {@link markFreeModelsDataBlocked}. Consumed by worker-model.ts to invalidate
 * its resolution memo when the set of usable models changes.
 */
export function blocklistGeneration(): number {
  return blocklistGen;
}

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
  succeededSessions.clear();
  incapableModels.clear();
  freeModelsDataBlocked.clear();
  blocklistGen = 0;
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
 * Consecutive complete-but-empty responses a (model, worker) pair must produce
 * before we conclude it is genuinely incapable. A single empty completion is
 * often transient or prompt-specific (a one-off glitch, a refusal), so we
 * require a small run before permanently skipping the pair.
 */
const INCAPABLE_THRESHOLD = 3;

/** Per-(model, worker) count of consecutive complete-but-empty responses. */
const consecutiveEmpty: Map<string, number> = new Map();

/**
 * Sentinel worker used when a caller does not scope by worker kind. Keeps the
 * per-worker key well-formed and lets legacy call sites (and tests) that only
 * care about the model share one bucket.
 */
const ANY_WORKER = "_any";

/** Build the verdict key for a provider+model+worker triple. */
function modelKey(
  providerID: string,
  modelID: string,
  workerID: WorkerID | (string & {}) = ANY_WORKER,
): string {
  return `${providerID}/${modelID}/${workerID}`;
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
 * Record a complete-but-empty worker response for a (model, worker) pair and
 * return true when the pair should now be marked incapable (threshold of
 * consecutive empties reached). Non-capability finish reasons (truncation,
 * content filter, tool calls) reset the streak and never mark.
 *
 * The streak is scoped per worker: a distillation success on the same model
 * must NOT reset a curator's empty streak, otherwise a model that can distill
 * but not curate is never marked incapable (see {@link incapableModels}).
 */
export function recordEmptyWorkerResponse(
  providerID: string,
  modelID: string,
  finishReason: string | undefined,
  workerID: WorkerID | (string & {}) = ANY_WORKER,
): boolean {
  const key = modelKey(providerID, modelID, workerID);
  if (!isCapabilityEmpty(finishReason)) {
    consecutiveEmpty.delete(key); // transient/expected — reset the streak
    return false;
  }
  const n = (consecutiveEmpty.get(key) ?? 0) + 1;
  consecutiveEmpty.set(key, n);
  if (n >= INCAPABLE_THRESHOLD) {
    markWorkerIncapable(providerID, modelID, workerID);
    return true;
  }
  return false;
}

/**
 * Clear the consecutive-empty streak for a (model, worker) pair (on a usable
 * response). Only the streak for THIS worker is cleared — a usable
 * distillation must not wipe the curator's accumulating empties.
 */
export function clearEmptyWorkerStreak(
  providerID: string,
  modelID: string,
  workerID: WorkerID | (string & {}) = ANY_WORKER,
): void {
  consecutiveEmpty.delete(modelKey(providerID, modelID, workerID));
}

/**
 * Mark a provider+model+worker as incapable of producing usable worker output,
 * so future calls to that worker for that model are skipped. Idempotent. Logs
 * once per (model, worker).
 */
export function markWorkerIncapable(
  providerID: string,
  modelID: string,
  workerID: WorkerID | (string & {}) = ANY_WORKER,
): void {
  const key = modelKey(providerID, modelID, workerID);
  if (incapableModels.has(key)) return;
  incapableModels.add(key);
  blocklistGen++;
  log.warn(
    `[worker-health] model ${providerID}/${modelID} marked worker-incapable ` +
      `for worker=${workerID} — it returned no usable text after the ` +
      `reasoning-field fallback for ${INCAPABLE_THRESHOLD} consecutive ` +
      `complete responses; skipping this worker for it (data stays recallable)`,
  );
}

/** True when a provider+model+worker has been marked worker-incapable. */
export function isWorkerIncapable(
  providerID: string,
  modelID: string,
  workerID: WorkerID | (string & {}) = ANY_WORKER,
): boolean {
  return incapableModels.has(modelKey(providerID, modelID, workerID));
}

/**
 * Record that the given provider's `:free` worker models are blocked by the
 * account's data policy (learned from a data-policy 404 — see
 * `isDataPolicyBlocked404`). Idempotent per provider; bumps the blocklist
 * generation on the first observation so memoized resolutions re-resolve.
 *
 * User directive: assume ALL `:free` models on the provider collect data once
 * we see this error, so the whole `:free` tier is skipped for that provider.
 */
export function markFreeModelsDataBlocked(providerID: string): void {
  if (freeModelsDataBlocked.has(providerID)) return;
  freeModelsDataBlocked.add(providerID);
  blocklistGen++;
  log.warn(
    `[worker-health] provider ${providerID} :free worker models blocked by ` +
      `account data policy — skipping the :free tier for this provider and ` +
      `re-resolving to a paid same-family sibling (in-memory; re-learned after ` +
      `restart)`,
  );
}

/**
 * True when the given provider's `:free` worker models have been observed to be
 * data-policy-blocked for this account this process.
 */
export function areFreeModelsDataBlocked(providerID: string): boolean {
  return freeModelsDataBlocked.has(providerID);
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
  workerID: WorkerID | (string & {}),
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

  // data-policy is a per-account availability fact (a :free model gated by the
  // account's data policy), not an outage. Like worker-incapable, it must never
  // drive the degraded/critical Sentry ladder or the circuit breaker: the model
  // is blocklisted (markFreeModelsDataBlocked / markWorkerIncapable at the call
  // site) and selection re-resolves to a usable same-family sibling on the next
  // pass, so a sustained-failure warning would be both alarming and wrong.
  // Recorded (warn) for visibility.
  if (reason === "data-policy") {
    log.warn(
      `[worker-health] ${workerID} skipped (data-policy) for session=${sessionID.slice(0, 16)} — worker model re-resolving`,
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
      sawGenuineReason: false,
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
      sawGenuineReason: false,
    };
    state.set(sessionID, entry);
  } else if (t - entry.lastFailureAt > FAILURE_WINDOW_MS) {
    // New sliding window within the same sustained outage: reset the counter
    // and reason/worker sets, but KEEP firstFailureAt so the 30m/60m
    // sustained thresholds continue to accumulate. `sawGenuineReason` also
    // persists — it latches for the whole outage, not per window.
    entry.failureCount = 0;
    entry.reasons = new Set();
    entry.workerIDs = new Set();
  }

  entry.failureCount++;
  entry.lastFailureAt = t;
  entry.reasons.add(reason);
  entry.workerIDs.add(workerID);
  // Latch once a genuine (non-credential-class) reason is seen. This survives
  // window rotation so getDegradationWarning can't later mistake a real outage
  // for first-run credential noise after the genuine reason ages out.
  if (!CREDENTIAL_CLASS_REASONS.has(reason)) {
    entry.sawGenuineReason = true;
  }

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

  // Suppress the Sentry escalation when EVERY failure in this window is a
  // credential/config condition (see CREDENTIAL_CLASS_REASONS): those are the
  // user's local setup, not a lore bug, and were the source of the
  // LOREAI-GATEWAY-3J "Worker health degraded" noise. The local error log
  // above, the degraded STATUS, and the `lore doctor` warning still fire — only
  // the Sentry issue is withheld. A window with any genuine outage reason
  // (`.reasons` is accumulated across the window) still escalates normally.
  const allCredentialClass = [...entry.reasons].every((r) =>
    CREDENTIAL_CLASS_REASONS.has(r),
  );

  // Debounce: don't re-alert within ALERT_COOLDOWN_MS. Skipping the alert when
  // allCredentialClass ALSO leaves `alertSentAt` unset, so a later genuine
  // outage reason in the same window can still fire the first real alert.
  const shouldAlert =
    !allCredentialClass &&
    (!entry.alertSentAt || t - entry.alertSentAt > ALERT_COOLDOWN_MS);
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
      !allCredentialClass &&
      (!entry.exceptionSentAt || t - entry.exceptionSentAt > 60 * 60 * 1000);
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

  // Mark that this session has authenticated and produced usable worker output
  // at least once. Any later degradation is then a genuine "was working, now
  // broken" event worth warning the user about (see {@link succeededSessions}).
  succeededSessions.set(sessionID, { lastSuccessAt: now() });
  // Arm the TTL sweep here too: this map is populated on the SUCCESS path, but
  // the sweep that bounds it was otherwise only armed by recordWorkerFailure.
  // A process that never records a failure would otherwise grow this map
  // unbounded (one entry per unique session).
  ensureSweepTimer();

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
 * Best-effort human-readable "likely cause" derived from the failure reasons
 * actually recorded for the session. Previously this was hard-coded to "session
 * authentication has gone stale", which sent users chasing an auth problem when
 * the real cause was often a worker model returning empty responses. We now key
 * the guidance off the recorded reasons.
 */
function likelyCauseFor(reasons: Set<FailureReason>): string {
  if (reasons.has("no-auth") || reasons.has("auth-rejected")) {
    return (
      "session authentication has gone stale. Run `lore doctor` or check the " +
      "dashboard for details."
    );
  }
  if (
    reasons.has("no-response") ||
    reasons.has("worker-incapable") ||
    reasons.has("parse-error")
  ) {
    return (
      "the background worker model is returning empty or unusable responses. " +
      "Set an explicit `workerModel` (same provider as the session) in your " +
      "lore config, or run `lore doctor` / check the dashboard for details."
    );
  }
  if (reasons.has("rate-limit")) {
    return (
      "the upstream is rate-limiting background worker calls. Run `lore " +
      "doctor` or check the dashboard for details."
    );
  }
  // Fallback for upstream-error / cross-provider / protocol-mismatch / etc.
  return "the upstream is failing background worker calls. Run `lore doctor` or check the dashboard for details.";
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
  // First-run suppression: if this session has NEVER had a successful worker
  // call and has NEVER seen a genuine (non-credential-class) outage reason for
  // this outage, every failure is credential-class (no-auth / cross-provider) —
  // the normal "not authenticated yet" warm-up state on a fresh install, not a
  // working session that broke. Telling the user their memory is being "harmed"
  // here is alarming and wrong (Kjaer/Erica both hit this). Stay quiet until
  // either a real credential lands (recordWorkerSuccess flips neverSucceeded)
  // or a genuine outage reason is seen (sawGenuineReason latches, surviving
  // window rotation so a real failure that ages out isn't reclassified as
  // first-run noise).
  const neverSucceeded = !succeededSessions.has(sessionID);
  if (neverSucceeded && !entry.sawGenuineReason) return null;
  return (
    `[Lore: Background workers (distillation, curation, cache warming) for this session ` +
    `have been failing for ${formatDuration(sustainedMs)}. This is harmful — your ` +
    `context window is not being compressed and long-term knowledge is not being ` +
    `captured. Likely cause: ${likelyCauseFor(entry.reasons)}]`
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
  workerIDs: Array<WorkerID | (string & {})>;
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
    workerIDs: Array<WorkerID | (string & {})>;
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

export interface WorkerHealthSummary {
  /** True when no session is in sustained (degraded/critical) failure. */
  ok: boolean;
  /** Number of sessions past the degraded threshold. */
  degradedSessions: number;
  detail: string;
}

/**
 * Gateway-wide roll-up of the per-session failure ladder, for health surfaces
 * (`/health`, `lore doctor`). Sustained background-worker failures mean
 * distillation/curation aren't running — context isn't being compressed and
 * knowledge isn't being captured — which is otherwise only visible once a
 * single session crosses the 30-minute response-warning threshold.
 */
export function workerHealthSummary(): WorkerHealthSummary {
  const degraded = getWorkerHealth().filter(
    (h) => h.status === "degraded" || h.status === "critical",
  );
  if (degraded.length === 0) {
    return {
      ok: true,
      degradedSessions: 0,
      detail: "background workers healthy",
    };
  }
  return {
    ok: false,
    degradedSessions: degraded.length,
    detail:
      `${degraded.length} session(s) with sustained background-worker failures — ` +
      "distillation/curation may be stalled (likely stale auth or exhausted credit)",
  };
}

/**
 * Build the adapter that core passes around as `input.workerHealth`.
 * The core's `recordFailure` accepts a free-form string; the gateway's typed
 * `FailureReason` enum drives Sentry tags and metrics. This adapter casts the
 * string to a `FailureReason` for downstream consumers.
 */
export function makeWorkerHealth(
  sessionID: string,
  workerID: WorkerID | (string & {}),
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
  succeededSessions.clear();
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
    // Bound the ever-succeeded map on the same TTL so it can't grow unbounded
    // across a long-lived gateway process. BUT never evict a session that still
    // has an active failure entry: a session that was working and then hits
    // persistent credential-class failures (e.g. auth went stale) keeps failing
    // past 1h, and dropping its "was working" history here would flip
    // neverSucceeded back to true and wrongly suppress its degradation banner
    // (Seer #15390225). Only evict once the failure entry is gone (session
    // recovered or fully aged out).
    for (const [sessionID, s] of succeededSessions) {
      if (t - s.lastSuccessAt > SESSION_TTL_MS && !state.has(sessionID)) {
        succeededSessions.delete(sessionID);
      }
    }
  }, SWEEP_INTERVAL_MS);
  // Allow the process to exit without waiting on this timer.
  if (typeof (sweepTimer as { unref?: () => void }).unref === "function") {
    (sweepTimer as { unref: () => void }).unref();
  }
}
