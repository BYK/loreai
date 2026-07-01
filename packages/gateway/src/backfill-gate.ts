/**
 * Idle-gate for the heavy temporal re-chunk backfill walk.
 *
 * The walk (in `@loreai/core`'s `runStartupBackfill`) shares the embedding
 * worker pool with request-path embeds and vector reads. Left unthrottled, a
 * 100k+ row walk saturates that pool and inflates live recall latency. The core
 * walk is signal-agnostic and simply calls a host-supplied `shouldPause()`
 * before each row; this module supplies that policy.
 *
 * Policy: park the walk while background work is paused (a tripped circuit
 * breaker signals the whole system is degraded) OR any session was active
 * within `windowMs` (a request is likely in-flight or imminent). The walk
 * resumes once the host is quiet. Because the walk checkpoints per row, parking
 * for long stretches is free — it just resumes from the last durable cursor.
 *
 * Factored out of the wiring as a pure factory over injected dependencies so it
 * is unit-testable without the pipeline's module state.
 */
export interface TemporalBackfillGateDeps {
  /** Whether background LLM/embed work is currently paused (circuit breaker). */
  isPaused: () => boolean;
  /** Live view of tracked sessions; re-read on every gate call. */
  activeSessions: () => Iterable<{ lastRequestTime: number }>;
  /** A session touched more recently than this (ms) counts as "active". */
  windowMs: number;
  /** Clock injection point for tests. Defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Build the `shouldPause` predicate handed to `runStartupBackfill`. Returns
 * `true` when the temporal walk should park.
 */
export function makeTemporalBackfillGate(
  deps: TemporalBackfillGateDeps,
): () => boolean {
  const now = deps.now ?? Date.now;
  return () => {
    if (deps.isPaused()) return true;
    const t = now();
    for (const s of deps.activeSessions()) {
      // Strict `<`: activity exactly `windowMs` ago is no longer "active".
      if (t - s.lastRequestTime < deps.windowMs) return true;
    }
    return false;
  };
}
