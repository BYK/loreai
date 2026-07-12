/**
 * Read-worker pool.
 *
 * Offloads heavy, staleness-TOLERANT, read-only SQLite work off the main event
 * loop onto a small pool of worker threads, each with its own read-only WAL
 * connection (see db/reader.ts). Two job families share the same workers:
 *   - "search": the synchronous, O(n) cosine-similarity scans behind every
 *     `vectorSearch*` call (recall, the per-turn LTM/delta injection path,
 *     dedup, the background scanners) — see vector-query.ts; and
 *   - "read": generic parameterized read-only SQL jobs (FTS scans, table scans,
 *     hydration) — see read-job.ts.
 * The goal is the same for both: keep the main loop free so one session's heavy
 * recall/LTM work runs in a worker while the main thread serves other streams.
 *
 * Safety model (this is shipped behind a DEFAULT-ON kill switch, not opt-in):
 *   - `search.embeddings.workerOffload` (config, default true) and the
 *     `LORE_DISABLE_VEC_WORKER=1` env var both gate the pool off → callers run
 *     the in-process path (current behavior).
 *   - `tryPoolVectorSearch()` / `tryPoolRead()` NEVER throw. They resolve:
 *       · the result, on success;
 *       · `null` when the pool is disabled/broken/errored → caller runs the
 *         in-process path;
 *       · a TIMED_OUT sentinel when the worker was alive but too slow → caller
 *         returns an EMPTY result WITHOUT re-running the scan on the main thread
 *         (re-running re-blocks the loop — the #1006 stall bug). The wedged
 *         worker is terminated so the pool recovers; a timeout is slowness, not
 *         a structural failure, so it never latches the pool broken.
 *   - In tests the pool is inert unless a worker factory is installed via
 *     `_setTestVectorWorkerFactory` (so unit tests keep pure in-process
 *     behavior and never spawn a real worker).
 */

import { Worker } from "node:worker_threads";
import { config } from "./config";
import { dbPath } from "./db";
import * as log from "./log";
import type { ReadJobSpec } from "./read-job";
import type {
  DistillationVectorHit,
  VectorHit,
  VectorQuerySpec,
} from "./vector-query";
import type {
  VectorWorkerInbound,
  VectorWorkerInitData,
  VectorWorkerOutbound,
} from "./vector-worker-types";

/** Per-request timeout. A hung/slow worker must never hang recall. On timeout
 *  we resolve {@link VECTOR_SEARCH_TIMED_OUT} (NOT reject, NOT in-process
 *  fallback): the worker is alive but slow, so re-running the same O(n) scan on
 *  the main thread would just re-block the event loop — that was the stall bug.
 *  Generous vs. a sub-ms vec scan; override with LORE_VEC_SEARCH_TIMEOUT_MS. */
const DEFAULT_VECTOR_SEARCH_TIMEOUT_MS = 10_000;

/** Resolved (never rejected) by {@link tryPoolVectorSearch} when the pool was
 *  used but the request exceeded {@link vectorSearchTimeoutMs}. Distinct from
 *  `null` — which means the pool was disabled / broken / errored and the caller
 *  SHOULD run the in-process path. On a timeout the caller must instead return
 *  an empty result and leave the main thread free. */
export const VECTOR_SEARCH_TIMED_OUT = Symbol("vector-search-timed-out");

/** The read-job analogue of {@link VECTOR_SEARCH_TIMED_OUT}: resolved (never
 *  rejected) by {@link tryPoolRead} when a worker was used but the read exceeded
 *  the timeout. Distinct from `null` (pool disabled/broken/errored → run the
 *  query in-process). On a timeout the caller must DEGRADE to an empty result —
 *  re-running the same scan in-process would re-block the loop the offload
 *  exists to keep free (#1006). The wedged worker is terminated either way. */
export const READ_JOB_TIMED_OUT = Symbol("read-job-timed-out");

/** Internal marker the per-request timer resolves the dispatch Promise with, so
 *  {@link dispatchToPool} can distinguish a timeout from a worker reply payload
 *  (which is never a symbol). Not exported — callers see the per-family
 *  sentinels above. */
const POOL_REQUEST_TIMED_OUT = Symbol("pool-request-timed-out");

/** Resolve the per-request vector-search timeout. Read per call (not cached)
 *  to match the kill-switch env pattern. */
export function vectorSearchTimeoutMs(): number {
  // LORE_VEC_SEARCH_TIMEOUT_MS overrides the per-request vector-search timeout
  // (a positive integer in milliseconds; invalid or non-positive values are
  // ignored). Defaults to 10000 (10s). On timeout, recall degrades to an empty
  // result instead of re-running the O(n) scan on the main thread.
  const raw = process.env.LORE_VEC_SEARCH_TIMEOUT_MS;
  if (raw !== undefined) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return DEFAULT_VECTOR_SEARCH_TIMEOUT_MS;
}

/** Default worker count when config doesn't specify. Small: the goal is to
 *  unblock the main loop, not to parallelize an infrequent, sub-ms scan. */
const DEFAULT_POOL_SIZE = 2;

/** Consecutive structural failures (worker death / load failure / reader-open
 *  failure) — with no healthy reply in between — that latch the pool broken.
 *  A persistently unresolvable worker (missing bundle, bad DB path) would
 *  otherwise respawn on every call; latching makes it fall back to the
 *  in-process path for the rest of the process. */
const MAX_STRUCTURAL_FAILURES = 6;

type Hits = VectorHit[] | DistillationVectorHit[];

interface Pending {
  /** Resolved with the worker's reply payload: vector hits for a "search"
   *  request, the row array / single row for a "read" request. The per-request
   *  timer resolves the same Promise with {@link POOL_REQUEST_TIMED_OUT}
   *  instead. Callers narrow. */
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PoolWorker {
  worker: Worker;
  inflight: Map<number, Pending>;
  dead: boolean;
}

let workers: PoolWorker[] = [];
let nextRequestId = 0;
/** Latched true after spawning fails — stops per-call retry storms. */
let poolBroken = false;
/** Consecutive structural failures since the last healthy reply. */
let structuralFailures = 0;
/** True while shutting the pool down, so terminate()-induced exits aren't
 *  counted as structural failures. */
let shuttingDown = false;

/** Test seam: when set, the pool builds workers with this factory instead of
 *  spawning a real `node:worker_threads` Worker. Never set in production. */
let testWorkerFactory: ((data: VectorWorkerInitData) => Worker) | null = null;

/** For tests: install (or clear with null) the worker factory seam. */
export function _setTestVectorWorkerFactory(
  factory: ((data: VectorWorkerInitData) => Worker) | null,
): void {
  testWorkerFactory = factory;
}

/** Whether the pool should be used at all. */
function poolEnabled(): boolean {
  if (poolBroken) return false;
  // Kill switch: force the in-process vector-search path, disabling the
  // off-thread read-worker pool. Default-on escape hatch, not opt-in.
  if (process.env.LORE_DISABLE_VEC_WORKER === "1") return false;
  // With a test factory installed the pool is explicitly under test.
  if (testWorkerFactory) return true;
  // Otherwise inert in tests so unit suites keep pure in-process behavior and
  // never attempt a real spawn (which can't resolve the .ts worker in vitest).
  if (process.env.NODE_ENV === "test") return false;
  return config().search.embeddings.workerOffload !== false;
}

function desiredPoolSize(): number {
  const n = config().search.embeddings.workerPoolSize;
  return typeof n === "number" && n >= 1 ? Math.floor(n) : DEFAULT_POOL_SIZE;
}

/**
 * Resolve how to spawn the vector worker, mirroring LocalProvider.ensureWorker
 * in embedding.ts:
 *   - test factory seam (deterministic fake), else
 *   - SEA binary: source string via `globalThis.__LORE_VECTOR_WORKER_SOURCE__`
 *     (set by sea-entry.ts) → `new Worker(src, { eval: true, filename, ... })`,
 *   - npm/dev: sibling `./vector-worker.{ts,cjs,js}` next to this module.
 */
function spawnWorker(initData: VectorWorkerInitData): Worker {
  if (testWorkerFactory) return testWorkerFactory(initData);

  const workerSource = (globalThis as Record<string, unknown>)
    .__LORE_VECTOR_WORKER_SOURCE__ as string | undefined;
  if (workerSource !== undefined) {
    const { join } = require("node:path") as typeof import("node:path");
    const { homedir } = require("node:os") as typeof import("node:os");
    // `filename` (sets the worker's __filename under eval:true) isn't in node's
    // WorkerOptions type but is honored at runtime — same loose-options pattern
    // as LocalProvider.ensureWorker in embedding.ts.
    const opts: Record<string, unknown> = {
      eval: true,
      filename: join(homedir(), ".cache", "lore", "vector-worker.cjs"),
      workerData: initData,
    };
    return new Worker(workerSource, opts);
  }

  // npm bundle / dev: sibling file. CJS uses __filename; ESM uses import.meta.url.
  let workerUrl: string | URL;
  if (typeof __filename === "string") {
    const { pathToFileURL } = require("node:url") as typeof import("node:url");
    const workerExt = __filename.endsWith(".ts")
      ? ".ts"
      : __filename.endsWith(".cjs")
        ? ".cjs"
        : ".js";
    workerUrl = new URL(
      `./vector-worker${workerExt}`,
      pathToFileURL(__filename),
    );
  } else {
    const selfUrl = import.meta.url;
    workerUrl = new URL(
      `./vector-worker${selfUrl.endsWith(".ts") ? ".ts" : ".js"}`,
      selfUrl,
    );
  }
  return new Worker(workerUrl, { workerData: initData });
}

/** Reject and clear every in-flight request on a worker. Used for STRUCTURAL
 *  deaths (crash / `error` / `exit` / init-error / shutdown): the worker is
 *  genuinely gone, so the rejection routes each caller to the in-process
 *  fallback where it still gets a correct result. */
function failAll(pw: PoolWorker, err: Error): void {
  for (const [, p] of pw.inflight) {
    clearTimeout(p.timer);
    p.reject(err);
  }
  pw.inflight.clear();
}

/** Resolve every in-flight request on a worker with the timeout marker (NOT a
 *  rejection) and clear them. Used when a worker is retired for a TIMEOUT: the
 *  requests queued behind the wedged synchronous scan must DEGRADE to an empty
 *  result, exactly like the request that actually blew the timeout. Rejecting
 *  them instead (the old `failAll` behavior) routed each one to the in-process
 *  fallback in `offloadAllOrTimeout` / `tryPoolVectorSearch`, re-blocking the
 *  main thread with the very synchronous scans the offload exists to avoid —
 *  the #1006 stall, amplified once the whole recall FTS fan-out shares the pool
 *  (Seer PR #1005 r3480447643). A timeout is slowness, not breakage, so (like
 *  {@link retireTimedOutWorker}) this never counts a structural failure. */
function timeoutAll(pw: PoolWorker): void {
  for (const [, p] of pw.inflight) {
    clearTimeout(p.timer);
    p.resolve(POOL_REQUEST_TIMED_OUT);
  }
  pw.inflight.clear();
}

/**
 * Cancel a timed-out search by retiring its worker.
 *
 * A worker runs `runVectorQuery` synchronously, so a query that blew the
 * timeout can't be interrupted from JS — terminating the worker is the only way
 * to reclaim the thread it's pinning (V8 tears it down once the in-progress
 * native call returns). The immediate, guaranteed effect is de-routing: marking
 * it `dead` drops it from {@link leastBusy} and {@link ensurePool} right away.
 * Leaving it running while we delete the in-flight entry — the pre-cancellation
 * behavior — made the still-busy worker look idle to {@link leastBusy}, so new
 * searches piled up behind the stuck scan in its message queue.
 * {@link ensurePool} respawns a fresh worker on the next call, restoring
 * capacity.
 *
 * Crucially this is NOT counted as a structural failure: a timeout is slowness,
 * not a broken worker, and latching the pool broken after repeated timeouts
 * would send every caller back to the in-process path — reintroducing the very
 * main-thread stall the timeout exists to prevent. Setting `dead` first makes
 * the terminate()-induced `exit` handler's {@link markDead} a no-op, so the
 * structural-failure latch is never touched. Collateral in-flight requests on
 * the same worker are RESOLVED as timeouts (see {@link timeoutAll}) — never
 * rejected — so their callers degrade to an empty result instead of re-running
 * the scan on the main thread (Seer PR #1005 r3480447643).
 */
function retireTimedOutWorker(pw: PoolWorker): void {
  if (pw.dead) return;
  pw.dead = true;
  timeoutAll(pw);
  try {
    void pw.worker.terminate();
  } catch {
    // best-effort — the exit handler (markDead) is already a no-op via `dead`.
  }
}

/**
 * Count a structural failure (worker death / load failure / reader-open
 * failure). After MAX_STRUCTURAL_FAILURES in a row with no healthy reply, latch
 * the pool broken and terminate any survivors so callers fall back to the
 * in-process path for the rest of the process instead of respawn-storming.
 */
function recordStructuralFailure(): void {
  if (shuttingDown || poolBroken) return;
  structuralFailures++;
  if (structuralFailures < MAX_STRUCTURAL_FAILURES) return;
  poolBroken = true;
  log.info(
    "vector worker pool disabled (repeated worker failures) — using in-process vector search",
  );
  for (const w of workers) {
    try {
      void w.worker.terminate();
    } catch {
      // best-effort
    }
  }
  workers = [];
}

/**
 * Mark a worker dead exactly once: reject its in-flight work and count it
 * toward the structural-failure latch. Idempotent — a worker that posts an
 * init-error and then exits is counted a single time.
 */
function markDead(pw: PoolWorker, err: Error): void {
  if (pw.dead) return;
  pw.dead = true;
  failAll(pw, err);
  recordStructuralFailure();
}

function makeWorker(): PoolWorker | null {
  try {
    const worker = spawnWorker({ dbPath: dbPath() });
    const pw: PoolWorker = { worker, inflight: new Map(), dead: false };
    // Don't keep the process alive for a background read worker.
    worker.unref();

    worker.on("message", (msg: VectorWorkerOutbound) => {
      switch (msg.type) {
        case "result": {
          // A healthy reply clears the structural-failure streak.
          structuralFailures = 0;
          const pending = pw.inflight.get(msg.id);
          if (pending) {
            pw.inflight.delete(msg.id);
            clearTimeout(pending.timer);
            pending.resolve(msg.hits);
          }
          break;
        }
        case "read-result": {
          // A healthy reply clears the structural-failure streak.
          structuralFailures = 0;
          const pending = pw.inflight.get(msg.id);
          if (pending) {
            pw.inflight.delete(msg.id);
            clearTimeout(pending.timer);
            pending.resolve(msg.rows);
          }
          break;
        }
        case "error": {
          // Per-request failure (NOT a worker death) — reject just this
          // request; the worker keeps serving. Caller falls back in-process.
          const pending = pw.inflight.get(msg.id);
          if (pending) {
            pw.inflight.delete(msg.id);
            clearTimeout(pending.timer);
            pending.reject(new Error(msg.error));
          }
          break;
        }
        case "init-error": {
          // Reader connection failed to open — the worker is structurally dead.
          markDead(pw, new Error(`vector worker init failed: ${msg.error}`));
          break;
        }
        // "ready" is informational; nothing to do.
      }
    });

    worker.on("error", (err: Error) => {
      markDead(pw, err instanceof Error ? err : new Error(String(err)));
    });

    worker.on("exit", () => {
      markDead(pw, new Error("vector worker exited"));
    });

    return pw;
  } catch (err) {
    // Synchronous spawn failure (e.g. unresolvable worker URL). Latch broken so
    // we stop trying — callers fall back to in-process for the process lifetime.
    poolBroken = true;
    log.info(
      "vector worker pool disabled (spawn failed):",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

/** Ensure the pool is populated with live workers; replace dead slots. Returns
 *  the live workers (possibly empty if spawning failed). */
function ensurePool(): PoolWorker[] {
  // Terminate and drop dead workers. A worker that hit init-error keeps its
  // message loop alive, so we must terminate it explicitly or it leaks a thread.
  for (const w of workers) {
    if (w.dead) {
      try {
        void w.worker.terminate();
      } catch {
        // best-effort
      }
    }
  }
  workers = workers.filter((w) => !w.dead);
  const target = desiredPoolSize();
  while (workers.length < target) {
    const pw = makeWorker();
    if (!pw) break; // poolBroken latched
    workers.push(pw);
  }
  return workers;
}

/** Pick the live worker with the fewest in-flight requests. */
function leastBusy(live: PoolWorker[]): PoolWorker | null {
  let best: PoolWorker | null = null;
  for (const w of live) {
    if (w.dead) continue;
    if (!best || w.inflight.size < best.inflight.size) best = w;
  }
  return best;
}

/** Discriminated outcome of {@link dispatchToPool}. `ok` carries the worker's
 *  reply payload; `unavailable` means run in-process; `timeout` means degrade to
 *  empty (the worker was wedged and has been retired). */
type DispatchResult =
  | { status: "ok"; value: unknown }
  | { status: "unavailable" }
  | { status: "timeout" };

/**
 * Dispatch one request to the least-busy live worker and await its reply.
 * Shared by {@link tryPoolVectorSearch} and {@link tryPoolRead}; NEVER throws.
 *
 * `makeMessage(id)` builds the typed inbound message. `label` is the human
 * request-family name ("vector worker search" / "read worker job") used in the
 * timeout log so incident triage can grep per-family wording.
 *
 * On timeout the worker is alive but too slow: we resolve `{status:"timeout"}`
 * (NOT reject → NOT in-process fallback, which would re-block the loop — the
 * #1006 stall bug) and terminate the wedged worker via
 * {@link retireTimedOutWorker} so the pool recovers. A timeout is slowness, not
 * a structural failure, so the broken-latch is never touched. Anything else
 * (disabled pool, no worker, per-request error, postMessage throw, unexpected
 * throw) yields `{status:"unavailable"}` and the caller runs in-process.
 */
async function dispatchToPool(
  makeMessage: (id: number) => VectorWorkerInbound,
  label: string,
): Promise<DispatchResult> {
  if (!poolEnabled()) return { status: "unavailable" };
  // Everything below is wrapped so the "never throws" contract holds by
  // construction — any unexpected throw (e.g. from ensurePool) resolves to
  // unavailable and the caller runs the in-process path.
  try {
    const live = ensurePool();
    const pw = leastBusy(live);
    if (!pw) return { status: "unavailable" };

    const id = nextRequestId++;
    const timeoutMs = vectorSearchTimeoutMs();
    const settled = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        pw.inflight.delete(id);
        // Resolve the timeout marker (don't reject → don't fall back
        // in-process): the worker is alive but slow; re-running this scan on the
        // main thread re-blocks the event loop. Then cancel the doomed query by
        // terminating its (uninterruptible, synchronously-scanning) worker so
        // the pool recovers instead of piling new work behind the stuck scan.
        log.info(
          `${label} timed out after ${timeoutMs}ms — terminating the wedged worker, returning empty (not re-running in-process)`,
        );
        resolve(POOL_REQUEST_TIMED_OUT);
        retireTimedOutWorker(pw);
      }, timeoutMs);
      // The worker is already unref'd (makeWorker), so an in-flight request must
      // not be the thing that keeps the event loop alive: unref the timeout too,
      // or a pending request delays process exit by up to the timeout on
      // shutdown. (review #989)
      timer.unref();
      pw.inflight.set(id, { resolve, reject, timer });
      try {
        pw.worker.postMessage(makeMessage(id));
      } catch (err) {
        // The worker died in the window after leastBusy() picked it. Clean up
        // the timer + inflight entry (don't leak them) and fall back.
        clearTimeout(timer);
        pw.inflight.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
    return settled === POOL_REQUEST_TIMED_OUT
      ? { status: "timeout" }
      : { status: "ok", value: settled };
  } catch (err) {
    log.info(
      `${label} failed; using in-process fallback:`,
      err instanceof Error ? err.message : String(err),
    );
    return { status: "unavailable" };
  }
}

/**
 * Run a vector search on the pool. Resolves to:
 *   - the hits, on success;
 *   - `null` when the pool is disabled/unavailable/failed → the caller runs the
 *     in-process path;
 *   - {@link VECTOR_SEARCH_TIMED_OUT} when the request timed out → the caller
 *     returns an empty result WITHOUT re-running the scan on the main thread.
 * Never rejects.
 */
export async function tryPoolVectorSearch(
  spec: VectorQuerySpec,
  embedding: Float32Array,
): Promise<Hits | null | typeof VECTOR_SEARCH_TIMED_OUT> {
  const r = await dispatchToPool(
    (id) => ({ type: "search", id, spec, embedding }),
    "vector worker search",
  );
  if (r.status === "timeout") return VECTOR_SEARCH_TIMED_OUT;
  if (r.status === "unavailable") return null;
  // A successful search always returns an array (never null), so the unwrap to
  // Hits is safe.
  return r.value as Hits;
}

/**
 * Run a generic read-only SQL job on the pool. Resolves to:
 *   - `{ rows }` (row array for `mode:"all"`, single row or null for "get") on
 *     success — the `{ rows }` wrapper disambiguates a `.get()` no-row null from
 *     "pool unavailable";
 *   - `null` when the pool is disabled/unavailable/failed → the caller runs the
 *     same job in-process;
 *   - {@link READ_JOB_TIMED_OUT} when the read timed out → the caller DEGRADES
 *     to an empty result WITHOUT re-running the scan on the main thread.
 * Never rejects.
 */
export async function tryPoolRead(
  spec: ReadJobSpec,
): Promise<{ rows: unknown } | null | typeof READ_JOB_TIMED_OUT> {
  const r = await dispatchToPool(
    (id) => ({ type: "read", id, spec }),
    "read worker job",
  );
  if (r.status === "timeout") return READ_JOB_TIMED_OUT;
  if (r.status === "unavailable") return null;
  return { rows: r.value };
}

/** Outcome of {@link checkVecWorker}: a one-shot probe of the off-thread
 *  read-pool path that production vector search actually runs on. */
export interface VecWorkerCheck {
  /** - `"ready"`       → the worker opened its reader connection; then
   *                      `vecAvailable` reports whether native sqlite-vec
   *                      loaded ON THE WORKER THREAD.
   *  - `"init-error"`  → the worker failed to open its reader connection.
   *  - `"timeout"`     → no `ready`/`init-error` arrived within the deadline.
   *  - `"spawn-error"` → the worker couldn't be spawned, errored, or exited
   *                      before reporting readiness. */
  status: "ready" | "init-error" | "timeout" | "spawn-error";
  /** Native sqlite-vec availability on the worker's own connection. Only
   *  meaningful when `status === "ready"`; `false` for every failure status. */
  vecAvailable: boolean;
  /** Diagnostic detail for the non-`ready` statuses. */
  error?: string;
}

/**
 * One-shot diagnostic: spawn a SINGLE read-pool worker exactly the way
 * production does (via {@link spawnWorker} — same SEA
 * `__LORE_VECTOR_WORKER_SOURCE__` / npm sibling-file resolution), wait for its
 * `ready` (or `init-error`) message, and report whether native sqlite-vec
 * loaded ON THE WORKER THREAD.
 *
 * This is the off-thread analogue of the main-thread `isVecAvailable()` check.
 * `--check-vec` alone only proves the main DB connection's extract+load works;
 * it never spawns the pool, so it can't prove the worker-thread path that recall
 * actually uses. Each worker opens its own reader connection and runs
 * `loadVecForConnection`, which inside the SEA resolves the embedded extension
 * via the worker thread's OWN `__LORE_VEC_EXTENSION_PATH__` handshake (set by
 * native-loader.cjs under the `isMainThread`/exists-skip guard). A `ready` reply
 * with `vecAvailable === true` proves that whole worker-thread chain (#1033).
 *
 * Independent of the live pool: it spawns a throwaway worker and never touches
 * the shared `workers[]`, the `poolBroken` latch, or the structural-failure
 * counter. Honors the test worker-factory seam. Never throws — failures surface
 * as a non-`ready` status. The probe worker is always terminated before
 * resolving.
 */
export async function checkVecWorker(
  timeoutMs = DEFAULT_VECTOR_SEARCH_TIMEOUT_MS,
): Promise<VecWorkerCheck> {
  let worker: Worker;
  try {
    worker = spawnWorker({ dbPath: dbPath() });
  } catch (err) {
    return {
      status: "spawn-error",
      vecAvailable: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  return await new Promise<VecWorkerCheck>((resolve) => {
    let settled = false;
    const finish = (result: VecWorkerCheck): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        // Tear down the throwaway probe worker. The terminate()-induced `exit`
        // re-enters `finish`, but the `settled` guard makes it a no-op.
        void worker.terminate();
      } catch {
        // best-effort
      }
      resolve(result);
    };

    const timer = setTimeout(
      () => finish({ status: "timeout", vecAvailable: false }),
      timeoutMs,
    );

    worker.on("message", (msg: VectorWorkerOutbound) => {
      if (msg.type === "ready") {
        finish({ status: "ready", vecAvailable: msg.vecAvailable });
      } else if (msg.type === "init-error") {
        finish({ status: "init-error", vecAvailable: false, error: msg.error });
      }
      // result/read-result/error can't occur — the probe never posts a request.
    });
    worker.on("error", (err: Error) => {
      finish({
        status: "spawn-error",
        vecAvailable: false,
        error: err instanceof Error ? err.message : String(err),
      });
    });
    worker.on("exit", () => {
      // An exit before `ready`/`init-error` is a structural probe failure. After
      // `finish` the terminate()-induced exit is a no-op (settled guard above).
      finish({
        status: "spawn-error",
        vecAvailable: false,
        error: "worker exited before reporting readiness",
      });
    });
  });
}

/** Outcome of {@link checkReadOffload}: a one-shot round-trip of a generic
 *  read job through the off-thread read-pool worker. */
export interface ReadOffloadCheck {
  /** - `"ok"`          → the worker opened its reader connection, ran the read
   *                      job, and returned the expected row off the main thread.
   *  - `"init-error"`  → the worker failed to open its reader connection.
   *  - `"read-error"`  → the worker received the job but threw running it.
   *  - `"bad-result"`  → the worker replied but with an unexpected row shape.
   *  - `"timeout"`     → no terminal reply arrived within the deadline.
   *  - `"spawn-error"` → the worker couldn't be spawned, errored, or exited
   *                      before replying. */
  status:
    | "ok"
    | "init-error"
    | "read-error"
    | "bad-result"
    | "timeout"
    | "spawn-error";
  /** Diagnostic detail for the non-`ok` statuses. */
  error?: string;
}

/** Correlation id for the single probe read request. */
const READ_OFFLOAD_PROBE_ID = 1;

/**
 * One-shot diagnostic: spawn a SINGLE read-pool worker exactly the way
 * production does (via {@link spawnWorker} — same SEA
 * `__LORE_VECTOR_WORKER_SOURCE__` / npm sibling-file resolution), wait for its
 * `ready`, then dispatch a trivial parameterized `read` job and assert the
 * `read-result` round-trips back off the main thread.
 *
 * This is the read-job analogue of {@link checkVecWorker}. Where `--check-vec`
 * only proves the worker can OPEN its connection (`ready`), this proves the full
 * generic read seam the recall + `forSession` fan-out actually rides on: the
 * embedded `vector-worker.cjs` asset resolves, the worker boots, its transitive
 * `read-job.ts` handler bundled, and a `{ sql, params, mode }` job executes on
 * the worker's own query-only connection and returns a structured-cloned row.
 * That whole chain rode in on the vector-worker asset with ZERO SEA-build
 * changes when the read-pool generalized (#989/#1005/#1012/#1019) — this guards
 * the otherwise-untested seam inside a built binary (#1029).
 *
 * The probe uses a fixed `SELECT 1` job, so it needs no schema and can't be
 * perturbed by data; a `read-error`/`bad-result` therefore means the worker's
 * read path itself is broken, not the query.
 *
 * Config-independent: it spawns the worker DIRECTLY, bypassing `poolEnabled()`
 * (so neither `search.workerOffload` nor `LORE_DISABLE_VEC_WORKER` can mask a
 * broken seam), and like {@link checkVecWorker} it never touches the shared
 * `workers[]`, the `poolBroken` latch, or the structural-failure counter.
 * Honors the test worker-factory seam. Never throws — failures surface as a
 * non-`ok` status. The probe worker is always terminated before resolving.
 */
export async function checkReadOffload(
  timeoutMs = DEFAULT_VECTOR_SEARCH_TIMEOUT_MS,
): Promise<ReadOffloadCheck> {
  let worker: Worker;
  try {
    worker = spawnWorker({ dbPath: dbPath() });
  } catch (err) {
    return {
      status: "spawn-error",
      error: err instanceof Error ? err.message : String(err),
    };
  }

  return await new Promise<ReadOffloadCheck>((resolve) => {
    let settled = false;
    const finish = (result: ReadOffloadCheck): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        // Tear down the throwaway probe worker. The terminate()-induced `exit`
        // re-enters `finish`, but the `settled` guard makes it a no-op.
        void worker.terminate();
      } catch {
        // best-effort
      }
      resolve(result);
    };

    const timer = setTimeout(() => finish({ status: "timeout" }), timeoutMs);

    worker.on("message", (msg: VectorWorkerOutbound) => {
      if (msg.type === "ready") {
        // Reader connection opened — now exercise the read path itself. A fixed
        // `SELECT 1` needs no schema and returns a known row.
        try {
          worker.postMessage({
            type: "read",
            id: READ_OFFLOAD_PROBE_ID,
            spec: { sql: "SELECT 1 AS one", params: [], mode: "get" },
          });
        } catch (err) {
          finish({
            status: "spawn-error",
            error: err instanceof Error ? err.message : String(err),
          });
        }
      } else if (msg.type === "init-error") {
        finish({ status: "init-error", error: msg.error });
      } else if (
        msg.type === "read-result" &&
        msg.id === READ_OFFLOAD_PROBE_ID
      ) {
        const row = msg.rows as { one?: unknown } | null;
        finish(
          row && row.one === 1
            ? { status: "ok" }
            : { status: "bad-result", error: JSON.stringify(msg.rows) },
        );
      } else if (msg.type === "error" && msg.id === READ_OFFLOAD_PROBE_ID) {
        finish({ status: "read-error", error: msg.error });
      }
      // A "result" (vector search) reply can't occur — the probe never posts one.
    });
    worker.on("error", (err: Error) => {
      finish({
        status: "spawn-error",
        error: err instanceof Error ? err.message : String(err),
      });
    });
    worker.on("exit", () => {
      // An exit before a terminal reply is a structural probe failure. After
      // `finish` the terminate()-induced exit is a no-op (settled guard above).
      finish({
        status: "spawn-error",
        error: "worker exited before returning a read result",
      });
    });
  });
}

/** Tear down the pool (test teardown + process reset). Idempotent. The
 *  shuttingDown guard keeps the terminate()-induced worker exits below from
 *  being counted as structural failures. */
export function shutdownVectorPool(): void {
  shuttingDown = true;
  for (const pw of workers) {
    failAll(pw, new Error("vector pool shutting down"));
    try {
      pw.worker.postMessage({ type: "shutdown" });
    } catch {
      // worker may already be gone
    }
    try {
      void pw.worker.terminate();
    } catch {
      // best-effort
    }
  }
  workers = [];
}

/** For tests: reset all pool state (workers, latches, counters, request ids). */
export function _resetVectorPoolForTest(): void {
  shutdownVectorPool();
  poolBroken = false;
  nextRequestId = 0;
  structuralFailures = 0;
  shuttingDown = false;
}
