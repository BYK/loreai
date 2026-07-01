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
 * breaker signals the whole system is degraded) OR the shared embedding worker
 * is serving a live recall lookup (a single-query embed is in flight). Gating on
 * the *actual shared resource* — not session activity — is what lets the walk
 * make progress on a busy multi-session host: a session being "recently active"
 * says nothing about whether the embed worker has spare capacity *right now*,
 * whereas an empty recall-embed queue does. The walk resumes the instant the
 * worker drains, and because it checkpoints per row, parking for long stretches
 * is free — it just resumes from the last durable cursor.
 *
 * Factored out of the wiring as a pure factory over injected dependencies so it
 * is unit-testable without the pipeline's module state.
 */
export interface TemporalBackfillGateDeps {
  /** Whether background LLM/embed work is currently paused (circuit breaker). */
  isPaused: () => boolean;
  /**
   * Whether the shared embedding worker is currently serving latency-sensitive
   * recall work (≥1 single-query embed in flight). Re-read on every gate call so
   * it reflects the worker's live load, never a stale snapshot.
   */
  isEmbedBusy: () => boolean;
}

/**
 * Build the `shouldPause` predicate handed to `runStartupBackfill`. Returns
 * `true` when the temporal walk should park.
 */
export function makeTemporalBackfillGate(
  deps: TemporalBackfillGateDeps,
): () => boolean {
  return () => deps.isPaused() || deps.isEmbedBusy();
}
