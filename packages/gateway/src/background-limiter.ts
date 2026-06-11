/**
 * Global concurrency limiter for background LLM work.
 *
 * Wraps fire-and-forget background LLM calls (idle distillation,
 * curation, pipeline-triggered incremental distillation) through a
 * single p-limit instance whose concurrency is dynamically scaled by
 * the active-session count (see `scaleBackgroundConcurrency`). Starts
 * at MIN_BACKGROUND_CONCURRENCY=2 and scales up to
 * MAX_BACKGROUND_CONCURRENCY=12 (or the env override).
 *
 * Note: auto-import extraction (`import-auto.ts`) is NOT wrapped here —
 * it creates its own LLM client and runs sequentially per-process.
 * The circuit breaker still provides protection for import because
 * `tripCircuitBreaker` is called from `llm-adapter.ts` on any 429
 * (urgent included — an urgent call keeps retrying but still pauses
 * other background work to the same provider), and import uses the
 * same adapter.
 *
 * Also provides a per-provider circuit breaker that trips on upstream
 * 429 responses, pausing background work to the offending provider for
 * the Retry-After period. Work routed to other providers keeps draining.
 * This prevents cascading retries from consuming the rate limit budget
 * that conversation turns need, without the blast-radius of a global
 * pause.
 */

import pLimit from "p-limit";
import { log } from "@loreai/core";

/**
 * Background concurrency is scaled dynamically by active-session count
 * (see `scaleBackgroundConcurrency`). These bound that scaling.
 *
 * The limiter starts at MIN and scales up on demand so a freshly-started
 * gateway with one session doesn't reserve idle capacity. The circuit
 * breaker remains the rate-limit governor — scaling only changes the drain
 * rate between trips.
 */
const MIN_BACKGROUND_CONCURRENCY = 2;
const MAX_BACKGROUND_CONCURRENCY = 12;

/**
 * Background LLM ops allowed per active session (rounded up). Not every
 * session has pending background work simultaneously, so a fractional
 * factor keeps the cap proportional without over-provisioning. Tunable.
 */
const CONCURRENCY_PER_SESSION = 0.5;

/**
 * Resolve the upper bound for background concurrency. `LORE_BACKGROUND_CONCURRENCY`
 * is a hard ceiling override (escape hatch for large multi-tenant hosts);
 * otherwise the built-in MAX applies. Clamped to a sane [1, 32].
 */
function resolveMaxConcurrency(): number {
  const env = process.env.LORE_BACKGROUND_CONCURRENCY;
  if (env) {
    const n = Number.parseInt(env, 10);
    if (Number.isFinite(n) && n >= 1) return Math.min(n, 32);
  }
  return MAX_BACKGROUND_CONCURRENCY;
}

/**
 * Maximum pending tasks in the queue. Beyond this, new submissions are
 * rejected immediately. Prevents unbounded queue growth when many sessions
 * schedule background work simultaneously — tasks will be re-generated
 * on the next idle tick.
 */
const MAX_PENDING_QUEUE = 50;

/**
 * Fraction of MAX_PENDING_QUEUE above which disposable (regenerable) work —
 * i.e. idle work, which is re-derived every idle tick — should self-shed
 * rather than occupy a slot. Reserves the upper half of the queue for
 * one-shot hot-path work (incremental-distill, curation) scheduled from
 * `pipeline.ts`, which submits unconditionally.
 */
const LOW_PRIORITY_SHED_THRESHOLD = 0.5;

const limiter = pLimit(MIN_BACKGROUND_CONCURRENCY);

// ---------------------------------------------------------------------------
// Circuit breaker (per-provider)
// ---------------------------------------------------------------------------

/**
 * The circuit breaker is keyed by upstream provider, NOT global. A 429 from
 * one provider (e.g. OpenRouter) must only pause background work that targets
 * THAT provider — work routed to a healthy provider (e.g. Anthropic) keeps
 * draining. A global breaker would let one rate-limited provider freeze every
 * session's background work regardless of where it's routed.
 *
 * Callers that lack provider context (e.g. the test-only `_tripRaw`, or a
 * session whose worker model can't be resolved) fall back to GLOBAL_KEY, which
 * behaves like the old single global breaker — paused work under GLOBAL_KEY
 * pauses everything. This keeps the conservative behavior for the unknown case.
 */
const GLOBAL_KEY = "_global";

interface BreakerState {
  /** Timestamp (ms) when this provider's breaker expires. 0 = not tripped. */
  openUntil: number;
  /** Consecutive trips without a full recovery in between. */
  consecutiveTrips: number;
}

/** Per-provider breaker state. Absent key = never tripped. */
const breakers = new Map<string, BreakerState>();

/**
 * Escalating backoff schedule (seconds) for consecutive circuit breaker trips.
 * Prevents the trip→60s→retry→trip cycle that hammers rate-limited APIs.
 * Exported for testing.
 */
export const BACKOFF_SCHEDULE = [60, 120, 240, 480, 600] as const;

function breakerKey(providerID?: string): string {
  return providerID && providerID.length > 0 ? providerID : GLOBAL_KEY;
}

/**
 * Whether a specific provider's breaker is currently open. A tripped GLOBAL_KEY
 * breaker pauses every provider (conservative fallback for unknown-provider
 * trips); otherwise only the named provider is paused.
 */
function isProviderPaused(key: string): boolean {
  const entry = breakers.get(key);
  if (!entry || entry.openUntil === 0) return false;
  if (Date.now() >= entry.openUntil) {
    // Expired naturally — full recovery, reset escalation for this provider
    breakers.delete(key);
    return false;
  }
  return true;
}

/**
 * Check if background work for `providerID` should be paused. Returns true when
 * either that provider's own breaker OR the global-fallback breaker is open.
 *
 * @param providerID Upstream provider the pending work will call. Omit when
 *                   unknown — only the global-fallback breaker is consulted.
 */
export function isBackgroundPaused(providerID?: string): boolean {
  // The global-fallback breaker pauses everything; a per-provider breaker
  // pauses only that provider.
  if (isProviderPaused(GLOBAL_KEY)) return true;
  const key = breakerKey(providerID);
  if (key === GLOBAL_KEY) return false; // already checked above
  return isProviderPaused(key);
}

/**
 * Trip the circuit breaker for a specific provider. Called when an LLM worker
 * call to that provider receives a 429 (urgent calls included — they keep
 * retrying themselves but still pause other background work to that provider).
 * Pauses with escalating backoff, scoped to the provider.
 *
 * When `retryAfterSeconds` is provided (from Retry-After header), the pause
 * duration is the greater of the server-guided value and the escalation
 * schedule — server guidance is respected but escalation still applies.
 *
 * @param retryAfterSeconds Server-guided pause duration, if available.
 * @param providerID        Provider that returned 429. Omit (→ GLOBAL_KEY) only
 *                          when the provider is genuinely unknown — that pauses
 *                          ALL background work (conservative fallback).
 */
export function tripCircuitBreaker(
  retryAfterSeconds?: number,
  providerID?: string,
): void {
  const key = breakerKey(providerID);
  const entry = breakers.get(key) ?? { openUntil: 0, consecutiveTrips: 0 };

  const scheduled =
    BACKOFF_SCHEDULE[
      Math.min(entry.consecutiveTrips, BACKOFF_SCHEDULE.length - 1)
    ];
  const duration =
    retryAfterSeconds && retryAfterSeconds > 0
      ? Math.max(retryAfterSeconds, scheduled)
      : scheduled;
  entry.consecutiveTrips++;

  const until = Date.now() + duration * 1000;
  // Only extend, never shorten an active pause
  if (until > entry.openUntil) {
    entry.openUntil = until;
    log.warn(
      `background circuit breaker tripped for ${key} (trip #${entry.consecutiveTrips}): ` +
        `pausing background work to ${key} for ${duration}s ` +
        `[active=${limiter.activeCount} pending=${limiter.pendingCount}]`,
    );
  }
  breakers.set(key, entry);
}

/**
 * Get remaining pause time in seconds for a provider (for diagnostics/logging).
 * Returns the max remaining across the provider's own breaker and the global
 * fallback. Returns 0 if not paused.
 */
export function remainingPauseSeconds(providerID?: string): number {
  const now = Date.now();
  let until = 0;
  const globalEntry = breakers.get(GLOBAL_KEY);
  if (globalEntry && globalEntry.openUntil > now) until = globalEntry.openUntil;
  const key = breakerKey(providerID);
  if (key !== GLOBAL_KEY) {
    const entry = breakers.get(key);
    if (entry && entry.openUntil > until) until = entry.openUntil;
  }
  return until > now ? Math.ceil((until - now) / 1000) : 0;
}

/**
 * Consecutive trips for a provider (for diagnostics/testing). Defaults to the
 * global-fallback breaker when no provider is given.
 */
export function getConsecutiveTrips(providerID?: string): number {
  return breakers.get(breakerKey(providerID))?.consecutiveTrips ?? 0;
}

// ---------------------------------------------------------------------------
// Limiter
// ---------------------------------------------------------------------------

/**
 * Run a background task through the global concurrency limiter.
 *
 * If the circuit breaker is tripped, the task is skipped (returns undefined).
 * Otherwise, the task is queued behind the p-limit(2) gate.
 *
 * The circuit breaker is checked both at submission time (fast rejection)
 * and again when the task reaches the front of the queue (in case the
 * breaker tripped while the task was waiting).
 *
 * @param fn Async function to execute
 * @param label Human-readable label for logging (e.g., "idle session=abc")
 * @param providerID Upstream provider this work will call. The circuit-breaker
 *                   check is scoped to this provider, so a 429 from a different
 *                   provider does not pause this work. Omit when unknown (only
 *                   the global-fallback breaker is consulted).
 * @returns The function's return value, or undefined if skipped
 */
export async function runBackground<T>(
  fn: () => Promise<T>,
  label?: string,
  providerID?: string,
): Promise<T | undefined> {
  if (isBackgroundPaused(providerID)) {
    if (label) {
      log.info(
        `background work skipped (circuit breaker, ${remainingPauseSeconds(providerID)}s remaining): ${label}`,
      );
    }
    return undefined;
  }
  // Reject when queue is full to prevent unbounded growth — tasks will be
  // re-generated on the next idle tick.
  if (limiter.pendingCount >= MAX_PENDING_QUEUE) {
    if (label) {
      log.info(
        `background work skipped (queue full, ${limiter.pendingCount} pending): ${label}`,
      );
    }
    return undefined;
  }
  return limiter(async () => {
    // Re-check after waiting in the queue — the breaker may have tripped
    // while this task was pending behind other in-flight work.
    if (isBackgroundPaused(providerID)) {
      if (label) {
        log.info(
          `background work skipped at execution (circuit breaker, ${remainingPauseSeconds(providerID)}s remaining): ${label}`,
        );
      }
      return undefined as T | undefined;
    }
    return fn();
  });
}

/**
 * Scale background concurrency to the current active-session count.
 *
 *   concurrency = clamp(ceil(activeSessions * CONCURRENCY_PER_SESSION),
 *                       MIN_BACKGROUND_CONCURRENCY, resolveMaxConcurrency())
 *
 * Called from the idle scheduler tick (which owns the sessions Map) so the
 * limiter never imports session state — no layering violation. p-limit's
 * `concurrency` setter resumes queued tasks immediately when raised, and
 * naturally drains down to the lower cap when sessions go away.
 */
export function scaleBackgroundConcurrency(activeSessions: number): void {
  const want = Math.ceil(Math.max(0, activeSessions) * CONCURRENCY_PER_SESSION);
  const next = Math.min(
    Math.max(want, MIN_BACKGROUND_CONCURRENCY),
    resolveMaxConcurrency(),
  );
  if (limiter.concurrency !== next) {
    limiter.concurrency = next;
    log.info(
      `background concurrency scaled to ${next} (active sessions=${activeSessions})`,
    );
  }
}

/**
 * True when the queue is congested enough that disposable (regenerable) work
 * should skip submission. Disposable work (idle distillation/curation) is
 * re-derived on the next idle tick, so dropping it under pressure is safe and
 * keeps the upper half of the queue free for one-shot hot-path work.
 */
export function shouldShedLowPriority(): boolean {
  return (
    limiter.pendingCount >= MAX_PENDING_QUEUE * LOW_PRIORITY_SHED_THRESHOLD
  );
}

/**
 * Current limiter stats (for diagnostics).
 */
export function backgroundLimiterStats(): {
  activeCount: number;
  pendingCount: number;
  paused: boolean;
  pauseRemainingSeconds: number;
} {
  return {
    activeCount: limiter.activeCount,
    pendingCount: limiter.pendingCount,
    paused: isBackgroundPaused(),
    pauseRemainingSeconds: remainingPauseSeconds(),
  };
}

/**
 * Reset all state (for tests).
 *
 * Note: `clearQueue()` only removes pending (queued) tasks — in-flight
 * tasks (up to the current concurrency cap) will continue to completion. Pending tasks resolve
 * as `undefined`, consistent with the circuit breaker skip behavior.
 */
export function resetBackgroundLimiter(): void {
  limiter.clearQueue();
  limiter.concurrency = MIN_BACKGROUND_CONCURRENCY;
  breakers.clear();
}

/**
 * Set the limiter concurrency directly, bypassing session-count scaling.
 * For tests only — production code should use `scaleBackgroundConcurrency()`.
 */
export function _setConcurrencyForTest(concurrency: number): void {
  limiter.concurrency = concurrency;
}

/**
 * Trip the circuit breaker with an exact duration, bypassing the
 * escalation schedule. For tests only — production code should use
 * `tripCircuitBreaker()`.
 *
 * Unlike `tripCircuitBreaker`, this unconditionally sets the deadline
 * (can shorten an active pause) — useful for overriding to short
 * durations in tests. Defaults to the global-fallback breaker (pauses all
 * providers); pass `providerID` to scope it.
 */
export function _tripRaw(durationSeconds: number, providerID?: string): void {
  const key = breakerKey(providerID);
  const entry = breakers.get(key) ?? { openUntil: 0, consecutiveTrips: 0 };
  entry.openUntil = Date.now() + durationSeconds * 1000;
  breakers.set(key, entry);
}
