/**
 * Adaptive token-cap math for local ONNX embedding inference.
 *
 * Local inference OOMs on long inputs: the O(L²) attention tensor for a long
 * sequence blows the WASM heap, and because WASM linear memory never shrinks,
 * an in-process retry cannot recover. We instead cap the input sequence length
 * up-front and adapt that cap to the host — start from a memory-aware estimate,
 * and on each OOM lower the cap ×0.7 and respawn the worker on a fresh heap.
 *
 * This module holds the pure, dependency-free math so it can be unit-tested in
 * isolation. The stateful pieces (persistence, worker lifecycle, telemetry)
 * live in embedding.ts.
 */

/** Floor token cap. Below this, an OOM means system-wide memory exhaustion (a
 *  256-token attention tensor is only ~3 MB), not input size — so the caller
 *  stops backing off and latches FTS-only. */
export const MIN_EMBED_TOKENS = 256;

/** Nomic v1.5 max sequence length. The adaptive cap never exceeds this. */
export const MODEL_MAX_TOKENS = 8192;

/** Multiplicative backoff applied to the token cap on each OOM respawn. 0.7 on
 *  tokens ≈ ×0.49 on the O(L²) attention memory per step — gentle enough to
 *  converge near the true sustainable cap without overshooting downward. */
export const EMBED_BACKOFF_FACTOR = 0.7;

/** Fraction of free memory the worker's total footprint (model + peak
 *  attention) may use when sizing the initial cap. Deliberately conservative:
 *  on a constrained host a higher value risks tipping into swap (the exact
 *  event-loop stall we're avoiding), and because embedding quality plateaus
 *  above ~2048 tokens (single-vector embeddings of long text are diluted, and
 *  recall chunks long content), a low cap costs almost nothing in quality. A
 *  box that genuinely has headroom recovers via the freemem-gated re-probe; an
 *  optimistic start is corrected by the ×0.7 backoff. */
export const EMBED_MEM_FRACTION = 0.5;

/** Free-memory ratio above `freememAtLearn` that re-arms an upward re-probe.
 *  We only climb when there's evidence more memory is genuinely available —
 *  distinguishing transient starvation (recoverable) from a real hardware
 *  limit (free memory never improves → never re-probe). */
export const EMBED_REPROBE_RATIO = 1.3;

/** Approximate resident baseline (model weights + ORT runtime) subtracted from
 *  free memory before sizing the transient allocation. ~400 MB. */
export const EMBED_MODEL_BASELINE_BYTES = 400 * 1024 * 1024;

/** Peak attention bytes per token²: n_heads (12) × 4 bytes/float × ~4 buffer
 *  overhead ≈ 192. The dominant inference allocation is the O(L²) attention
 *  tensor, so peakBytes ≈ K · L². Physical constants with a conservative
 *  overhead factor; the backoff corrects any residual estimation error. */
export const EMBED_ATTENTION_BYTES_PER_TOKEN_SQ = 192;

/** Free-memory ratio band within which a persisted learned cap is trusted
 *  as-is (i.e. memory is "close enough" to learn-time to skip re-converging). */
export const EMBED_CAP_TRUST_BAND = 0.25;

/** Persisted learned cap + the free memory at learn time (kv_meta JSON). */
export interface PersistedEmbedCap {
  cap: number;
  freeMemBytes: number;
}

/** Clamp a raw cap estimate into the valid [MIN, MODEL_MAX] range. */
export function clampEmbedCap(n: number): number {
  if (!Number.isFinite(n)) return MIN_EMBED_TOKENS;
  return Math.max(MIN_EMBED_TOKENS, Math.min(MODEL_MAX_TOKENS, Math.round(n)));
}

/** Lower the cap one backoff step, never below the floor. */
export function backoffEmbedCap(cap: number): number {
  return Math.max(Math.round(cap * EMBED_BACKOFF_FACTOR), MIN_EMBED_TOKENS);
}

/** Size the token cap from free memory and the O(L²) attention model. */
export function memoryModelEmbedCap(freeBytes: number): number {
  const budget = Math.max(
    freeBytes * EMBED_MEM_FRACTION - EMBED_MODEL_BASELINE_BYTES,
    0,
  );
  return clampEmbedCap(Math.sqrt(budget / EMBED_ATTENTION_BYTES_PER_TOKEN_SQ));
}

/**
 * Reconcile a freshly computed model cap with any persisted learned cap. When
 * current free memory is close to what it was at learn time, trust the learned
 * cap (avoids re-walking the backoff every restart — the "recurs on every
 * restart" failure). When memory has materially grown, re-probe upward via the
 * model; when it has materially shrunk, take the safer of model vs learned.
 */
export function reconcileEmbedCap(
  freeBytes: number,
  stored: PersistedEmbedCap | null,
  modelCap: number,
): number {
  if (!stored) return modelCap;
  const ratio = stored.freeMemBytes > 0 ? freeBytes / stored.freeMemBytes : 1;
  if (ratio >= 1 - EMBED_CAP_TRUST_BAND && ratio <= 1 + EMBED_CAP_TRUST_BAND) {
    return clampEmbedCap(stored.cap);
  }
  return freeBytes > stored.freeMemBytes
    ? modelCap
    : clampEmbedCap(Math.min(modelCap, stored.cap));
}

/**
 * Whether free memory has recovered enough since the cap was learned to justify
 * an upward re-probe. Guards against a non-positive learn-time baseline. This is
 * the gate that prevents a cap learned during a transient RAM-starved moment
 * from staying low forever within a long-running process.
 */
export function shouldReprobeEmbedCap(
  freeBytes: number,
  freememAtLearn: number,
): boolean {
  return (
    freememAtLearn > 0 && freeBytes >= freememAtLearn * EMBED_REPROBE_RATIO
  );
}

/**
 * Compute the next cap for an upward re-probe: one gentle step up (the inverse
 * of the ×0.7 backoff ≈ ×1.43), bounded by what the memory model says the now-
 * larger free pool supports. Never steps *down* — if the ceiling is below the
 * current cap, the cap is left unchanged. A too-optimistic step is corrected by
 * the OOM backoff.
 *
 * `knownBadCap` (the highest cap that has OOMed in this process, 0 = none) is a
 * hard ceiling: a rising `os.freemem()` does not guarantee the WASM heap can
 * actually grow that far (fragmentation, racing allocations), so we never
 * re-probe *up to or past* a cap that already failed. A process restart
 * re-evaluates from scratch and can exceed it if memory genuinely grew.
 */
export function reprobeEmbedCap(
  cap: number,
  freeBytes: number,
  knownBadCap = 0,
): number {
  const stepped = Math.round(cap / EMBED_BACKOFF_FACTOR);
  let ceiling = memoryModelEmbedCap(freeBytes);
  if (knownBadCap > 0) ceiling = Math.min(ceiling, knownBadCap - 1);
  return clampEmbedCap(Math.max(cap, Math.min(stepped, ceiling)));
}
