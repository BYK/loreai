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
 *  above ~2048 tokens (a single vector over long text is a diluted mean-pool
 *  centroid regardless of cap; temporal-message embeddings additionally drop
 *  bulky tool-output bodies before embedding via buildEmbeddingUnits, and the
 *  full text stays keyword-searchable in FTS), a low cap costs almost nothing
 *  in quality. A
 *  box that genuinely has headroom recovers via the freemem-gated re-probe; an
 *  optimistic start is corrected by the ×0.7 backoff. */
export const EMBED_MEM_FRACTION = 0.5;

/** Free-memory ratio above `freememAtLearn` that re-arms an upward re-probe.
 *  We only climb when there's evidence more memory is genuinely available —
 *  distinguishing transient starvation (recoverable) from a real hardware
 *  limit (free memory never improves → never re-probe). */
export const EMBED_REPROBE_RATIO = 1.3;

/** Resident baseline (nomic q8 model + ORT/WASM runtime + buffers) subtracted
 *  from free memory before sizing the transient allocation. Measured at ~665 MB
 *  (two runs: 662, 673) on the bundled single-threaded WASM worker
 *  (eval/measure-embed-cap.mjs, #857) — far above the original 400 MB guess —
 *  rounded up for cross-runtime margin. */
export const EMBED_MODEL_BASELINE_BYTES = 680 * 1024 * 1024;

/** Peak attention bytes per token². The dominant inference allocation is the
 *  O(L²) attention tensor, so footprint ≈ baseline + K·L². Measured at ~116
 *  bytes/token² (two runs: 116.8, 115.7) on the bundled WASM worker
 *  (eval/measure-embed-cap.mjs, #857; R²=0.999 across L=256..4096), rounded up
 *  for margin. The backoff corrects any residual. */
export const EMBED_ATTENTION_BYTES_PER_TOKEN_SQ = 120;

/** Free-memory ratio band within which a persisted learned cap is trusted
 *  as-is (i.e. memory is "close enough" to learn-time to skip re-converging). */
export const EMBED_CAP_TRUST_BAND = 0.25;

/** Persisted learned cap + the free memory at learn time (kv_meta JSON). */
export interface PersistedEmbedCap {
  cap: number;
  freeMemBytes: number;
  /** Highest cap (tokens) known to have OOMed, persisted across restarts so a
   *  memory-rich reboot never re-probes back up to a cap the WASM heap has
   *  already rejected. Absent/0 = none learned yet. */
  knownBadCap?: number;
}

/** Reference sequence length used to size the per-worker memory budget for pool
 *  growth. Generous on purpose: a worker's steady-state footprint is the model
 *  baseline plus the O(L²) attention peak, and the pool only adds a worker when a
 *  whole such budget is free — so it errs toward under- rather than over-
 *  provisioning memory. */
export const EMBED_POOL_BUDGET_REF_TOKENS = 2048;

/** Approximate memory one local embedding worker needs: the model/runtime
 *  baseline ({@link EMBED_MODEL_BASELINE_BYTES}) plus the O(L²) attention peak at
 *  {@link EMBED_POOL_BUDGET_REF_TOKENS}. A second (or Nth) worker is only spawned
 *  when this much memory is free, so the pool never multiplies memory pressure on
 *  a constrained host (each worker adds a full ~680 MB baseline that the ×0.7
 *  cap-backoff cannot reclaim — only fewer workers can). */
export const PER_WORKER_MEM_BUDGET_BYTES =
  EMBED_MODEL_BASELINE_BYTES +
  EMBED_ATTENTION_BYTES_PER_TOKEN_SQ *
    EMBED_POOL_BUDGET_REF_TOKENS *
    EMBED_POOL_BUDGET_REF_TOKENS;

/** Default upper bound on local embedding workers when memory allows and no
 *  explicit override is set. Two workers remove the cross-session serialization
 *  for the common query-vs-backfill case; more multiplies model memory for
 *  diminishing return on single-threaded WASM inference. */
export const DEFAULT_MAX_EMBED_POOL = 2;

/** Hard ceiling on the embedding pool regardless of config (matches the config
 *  schema max for `search.embeddings.embedPoolSize`). */
export const EMBED_POOL_ABS_MAX = 8;

/**
 * Memory-gated target size for the local embedding worker pool.
 *
 * `configured` (from `search.embeddings.embedPoolSize` or `LORE_EMBED_POOL_SIZE`)
 * sets the ceiling; when omitted it defaults to {@link DEFAULT_MAX_EMBED_POOL}.
 * The ceiling is then capped by how many {@link PER_WORKER_MEM_BUDGET_BYTES}-sized
 * workers fit in `freeBytes` — but never below 1: the primary worker always runs
 * (its own OOM backoff, not pool-sizing, protects a constrained host, exactly as
 * today's single-worker behavior). Pure so the pool math is unit-testable; the
 * caller passes `os.freemem()`.
 */
export function desiredEmbedPoolSize(
  freeBytes: number,
  configured?: number,
): number {
  const ceiling =
    configured != null && Number.isFinite(configured) && configured >= 1
      ? Math.min(Math.floor(configured), EMBED_POOL_ABS_MAX)
      : DEFAULT_MAX_EMBED_POOL;
  if (ceiling <= 1) return 1;
  const free = Number.isFinite(freeBytes) && freeBytes > 0 ? freeBytes : 0;
  const affordable = Math.max(
    1,
    Math.floor(free / PER_WORKER_MEM_BUDGET_BYTES),
  );
  return Math.min(ceiling, affordable);
}

/**
 * Clamp host-reported free memory to the container's cgroup memory limit.
 *
 * `constrained` is `process.constrainedMemory()` — the cgroup memory limit in
 * bytes, or `0` when the process is unconstrained (bare metal / VM) or the limit
 * is unknown. Inside a memory-capped container `os.freemem()` reports the HOST's
 * free memory (cgroup-blind), which can be many times larger than the container
 * can actually allocate: the pool then spawns unbounded native-ONNX workers and
 * sizes over-large token caps, and the cgroup OOM-killer SIGKILLs the process —
 * uncatchable, so the ×0.7 OOM backoff never fires (the WASM path self-limited
 * against its fixed 4 GiB heap; native has no such wall). Clamping to the limit
 * caps every freemem-derived decision at what the container can actually provide.
 *
 * No-op whenever the process is unconstrained (`constrained <= 0`) or the limit
 * is at least the host free figure (roomy container / bare metal): it returns
 * `hostFree` unchanged, so sizing is byte-identical to the pre-cgroup behavior
 * except on a container whose limit is below host-reported free. Monotonic — it
 * can only lower the figure, never raise it, so it never increases memory use.
 */
export function clampFreeToContainerLimit(
  hostFree: number,
  constrained: number,
): number {
  if (!Number.isFinite(constrained) || constrained <= 0) return hostFree;
  return Math.min(hostFree, constrained);
}

/** Clamp a raw cap estimate into the valid [MIN, MODEL_MAX] range. */
export function clampEmbedCap(n: number): number {
  if (!Number.isFinite(n)) return MIN_EMBED_TOKENS;
  return Math.max(MIN_EMBED_TOKENS, Math.min(MODEL_MAX_TOKENS, Math.round(n)));
}

/** ONNX WASM runtime linear-memory hard cap. The bundled
 *  `ort-wasm-simd-threaded` build declares `Memory({ initial: 256,
 *  maximum: 65536, shared: true })` → 65536 pages × 64 KiB = 4 GiB (measured on
 *  the built worker, #999). Unlike host RAM this is FIXED regardless of how much
 *  free memory the box has — so a cap sized purely from `os.freemem()` can exceed
 *  it on a memory-rich host and OOM the WASM heap. */
export const EMBED_WASM_HEAP_MAX_BYTES = 4 * 1024 * 1024 * 1024;

/** Fraction of the WASM hard cap usable for the transient O(L²) attention
 *  allocation (after the model/runtime baseline) before OOM. Headroom (0.85)
 *  absorbs WASM heap fragmentation and ORT's non-attention intermediates — the
 *  real OOM fires a bit below the theoretical 4 GiB. Combined with the measured
 *  baseline/K this yields ~4950 tokens, matching the observed safe convergence
 *  (≤4962) on a 4 GiB-WASM host (#999). */
export const EMBED_WASM_HEAP_USABLE_FRACTION = 0.85;

/** Hard, host-RAM-independent token ceiling for a single embed:
 *  `sqrt((MAX·fraction − baseline) / K)` ≈ 4962. Every freemem-derived cap is
 *  bounded by this.
 *
 *  Its VALUE is sized to the WASM linear-memory cap because that is the binding
 *  constraint on the **npm/WASM path** (onnxruntime-web): the fixed 4 GiB heap
 *  can't hold more, and since the OOM-backoff only corrects *downward*, an
 *  over-sized start OOMs 1–2× every boot until it re-converges — the exact
 *  failure this prevents.
 *
 *  On the **native path** (the SEA binary — see #1143 — plus dev/test, which use
 *  native onnxruntime-node) there is no WASM heap and no 4 GiB wall, so here this
 *  same bound instead acts as a memory-prudence + quality cap: nomic-embed-v1.5's
 *  effective context plateaus around ~2048 tokens, so capping at ~4962 sacrifices
 *  negligible embedding quality while keeping the transient O(L²) attention
 *  allocation bounded (and long inputs are chunked upstream anyway). Lifting it
 *  for native would let it drift up toward {@link MODEL_MAX_TOKENS} on big-RAM
 *  hosts for no quality gain, so we keep the single shared ceiling. */
export const EMBED_TOKEN_CEILING = clampEmbedCap(
  Math.sqrt(
    (EMBED_WASM_HEAP_MAX_BYTES * EMBED_WASM_HEAP_USABLE_FRACTION -
      EMBED_MODEL_BASELINE_BYTES) /
      EMBED_ATTENTION_BYTES_PER_TOKEN_SQ,
  ),
);

/** Lower the cap one backoff step, never below the floor. */
export function backoffEmbedCap(cap: number): number {
  return Math.max(Math.round(cap * EMBED_BACKOFF_FACTOR), MIN_EMBED_TOKENS);
}

/** Size the token cap from free memory and the O(L²) attention model, bounded by
 *  {@link EMBED_TOKEN_CEILING}. The freemem term guards against host-memory
 *  thrashing (too big for RAM → swap); the ceiling guards the WASM path against
 *  the fixed 4 GiB linear-memory cap (too big for the heap → OOM) that host RAM
 *  says nothing about, and doubles as a memory-prudence/quality cap on native. */
export function memoryModelEmbedCap(freeBytes: number): number {
  const budget = Math.max(
    freeBytes * EMBED_MEM_FRACTION - EMBED_MODEL_BASELINE_BYTES,
    0,
  );
  return Math.min(
    clampEmbedCap(Math.sqrt(budget / EMBED_ATTENTION_BYTES_PER_TOKEN_SQ)),
    EMBED_TOKEN_CEILING,
  );
}

/**
 * Reconcile a freshly computed model cap with any persisted learned cap. When
 * current free memory is close to what it was at learn time, trust the learned
 * cap (avoids re-walking the backoff every restart — the "recurs on every
 * restart" failure). When memory has materially grown, re-probe upward via the
 * model; when it has materially shrunk, take the safer of model vs learned.
 *
 * `knownBadCap` (a cap that has OOMed, persisted across restarts) is a hard
 * ceiling on the result: a rising `os.freemem()` does NOT prove the fixed WASM
 * heap can grow (see {@link reprobeEmbedCap}), so a memory-rich reboot must never
 * re-probe back up to or past a cap the heap already rejected — the exact
 * every-boot-OOM this guards against.
 */
export function reconcileEmbedCap(
  freeBytes: number,
  stored: PersistedEmbedCap | null,
  modelCap: number,
  knownBadCap = 0,
): number {
  const reconciled = ((): number => {
    if (!stored) return modelCap;
    const ratio = stored.freeMemBytes > 0 ? freeBytes / stored.freeMemBytes : 1;
    if (
      ratio >= 1 - EMBED_CAP_TRUST_BAND &&
      ratio <= 1 + EMBED_CAP_TRUST_BAND
    ) {
      return clampEmbedCap(stored.cap);
    }
    return freeBytes > stored.freeMemBytes
      ? modelCap
      : clampEmbedCap(Math.min(modelCap, stored.cap));
  })();
  // Bound EVERY path by EMBED_TOKEN_CEILING — not just the model-derived
  // ones. The trust-band branch returns a persisted `stored.cap` verbatim, so a
  // stale cap learned before this bound existed (e.g. an old 7000 read after an
  // upgrade) would otherwise slip through and OOM once. knownBadCap (a
  // per-host-learned OOM) tightens it further when present.
  const ceiling =
    knownBadCap > 0
      ? Math.min(EMBED_TOKEN_CEILING, knownBadCap - 1)
      : EMBED_TOKEN_CEILING;
  return clampEmbedCap(Math.min(reconciled, ceiling));
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
 * re-probe *up to or past* a cap that already failed.
 *
 * The result is also hard-bounded by {@link EMBED_TOKEN_CEILING} so this
 * path can never yield a cap above it — even if handed an above-ceiling `cap`
 * (the `Math.max(cap, …)` "never step down" clause would otherwise propagate it).
 * This makes the "no cap exceeds EMBED_TOKEN_CEILING" invariant locally enforced
 * here, not merely inherited from a bounded input.
 */
export function reprobeEmbedCap(
  cap: number,
  freeBytes: number,
  knownBadCap = 0,
): number {
  const stepped = Math.round(cap / EMBED_BACKOFF_FACTOR);
  let ceiling = memoryModelEmbedCap(freeBytes);
  if (knownBadCap > 0) ceiling = Math.min(ceiling, knownBadCap - 1);
  return Math.min(
    clampEmbedCap(Math.max(cap, Math.min(stepped, ceiling))),
    EMBED_TOKEN_CEILING,
  );
}
