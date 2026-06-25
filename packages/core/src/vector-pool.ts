/**
 * Vector-search read-worker pool.
 *
 * Offloads the synchronous, O(n) cosine-similarity scans behind every
 * `vectorSearch*` call (recall, the per-turn LTM/delta injection path, dedup,
 * and the background scanners) onto a small pool of worker threads, each with
 * its own read-only WAL connection (see db/reader.ts). The goal is to keep the
 * main event loop free: one session's heavy vector work runs in a worker while
 * the main thread keeps serving other sessions' streams.
 *
 * Safety model (this is shipped behind a DEFAULT-ON kill switch, not opt-in):
 *   - `search.embeddings.workerOffload` (config, default true) and the
 *     `LORE_DISABLE_VEC_WORKER=1` env var both gate the pool off → callers run
 *     the in-process path (current behavior).
 *   - `tryPoolVectorSearch()` NEVER throws: any spawn failure, worker death,
 *     timeout, or per-request error resolves to `null`, and the caller falls
 *     back to the in-process `runVectorQuery`. Repeated structural failure
 *     latches the pool broken so we don't retry-storm.
 *   - In tests the pool is inert unless a worker factory is installed via
 *     `_setTestVectorWorkerFactory` (so unit tests keep pure in-process
 *     behavior and never spawn a real worker).
 */

import { Worker } from "node:worker_threads";
import { config } from "./config";
import { dbPath } from "./db";
import * as log from "./log";
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

/** Per-request timeout. A hung worker must never hang recall — on timeout we
 *  reject (→ caller falls back in-process). Generous vs. a sub-ms vec scan. */
const VECTOR_SEARCH_TIMEOUT_MS = 5_000;

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
  resolve: (hits: Hits) => void;
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

/** Reject and clear every in-flight request on a worker (death/timeout). */
function failAll(pw: PoolWorker, err: Error): void {
  for (const [, p] of pw.inflight) {
    clearTimeout(p.timer);
    p.reject(err);
  }
  pw.inflight.clear();
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

/**
 * Run a vector search on the pool. Resolves to the hits, or to `null` when the
 * pool is disabled/unavailable/failed (the caller then runs the in-process
 * path). Never rejects.
 */
export async function tryPoolVectorSearch(
  spec: VectorQuerySpec,
  embedding: Float32Array,
): Promise<Hits | null> {
  if (!poolEnabled()) return null;
  // Everything below is wrapped so the "never throws" contract holds by
  // construction — any unexpected throw (e.g. from ensurePool) resolves to null
  // and the caller runs the in-process path.
  try {
    const live = ensurePool();
    const pw = leastBusy(live);
    if (!pw) return null;

    const id = nextRequestId++;
    return await new Promise<Hits>((resolve, reject) => {
      const timer = setTimeout(() => {
        pw.inflight.delete(id);
        reject(new Error("vector worker search timed out"));
      }, VECTOR_SEARCH_TIMEOUT_MS);
      pw.inflight.set(id, { resolve, reject, timer });
      try {
        const msg: VectorWorkerInbound = {
          type: "search",
          id,
          spec,
          embedding,
        };
        pw.worker.postMessage(msg);
      } catch (err) {
        // The worker died in the window after leastBusy() picked it. Clean up
        // the timer + inflight entry (don't leak them) and fall back.
        clearTimeout(timer);
        pw.inflight.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  } catch (err) {
    log.info(
      "vector worker search failed; using in-process fallback:",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

/** Tear down the pool (test teardown + process reset). Idempotent. The
 *  shuttingDown guard keeps the terminate()-induced worker exits below from
 *  being counted as structural failures. */
export function shutdownVectorPool(): void {
  shuttingDown = true;
  for (const pw of workers) {
    failAll(pw, new Error("vector pool shutting down"));
    try {
      pw.worker.postMessage({ type: "shutdown" } as VectorWorkerInbound);
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
