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
 *     `LORE_DISABLE_VEC_WORKER=1` env var gate the pool off. Heavy production
 *     reads then degrade or fail preparation, rather than scanning synchronously.
 *   - `tryPoolVectorSearch()` / `tryPoolRead()` NEVER throw. They resolve:
 *       · the result, on success;
 *       · `null` when the pool is disabled/broken/errored → caller applies its
 *         failure policy (unit-test fallback or production degrade/fail);
 *       · TIMED_OUT on deadline/abort/shutdown or PRESSURED on full admission.
 *         Optional work degrades; required preparation fails retryably. Neither
 *         runs a scan on the main thread. A wedged running worker is retired.
 *   - In tests the pool is inert unless a worker factory is installed via
 *     `_setTestVectorWorkerFactory` (so unit tests keep pure in-process
 *     behavior and never spawn a real worker).
 */

import { Worker } from "node:worker_threads";
import { performance } from "node:perf_hooks";
import { config } from "./config";
import { dbPath, dbReadGeneration } from "./db";
import * as log from "./log";
import { OwnedRetirements } from "./owned-retirements";
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
 *  used but the request exceeded {@link vectorSearchTimeoutMs}, or when pool
 *  shutdown has begun. Distinct from
 *  `null` — which means the pool was disabled / broken / errored and the caller
 *  applies its failure policy. Required reads fail preparation; optional reads
 *  return an empty result without a main-thread scan. */
export const VECTOR_SEARCH_TIMED_OUT = Symbol("vector-search-timed-out");

/** The read-job analogue of {@link VECTOR_SEARCH_TIMED_OUT}: resolved (never
 *  rejected) by {@link tryPoolRead} when a worker was used but the read exceeded
 *  the timeout, or when pool shutdown has begun. Distinct from `null` (pool
 *  disabled/broken/errored → caller applies its failure policy). On timeout
 *  optional reads degrade and required reads fail preparation. A queued
 *  deadline drops only that job; a wedged running worker is retired. */
export const READ_JOB_TIMED_OUT = Symbol("read-job-timed-out");
/** Queue admission rejected a read without posting it to a worker. */
export const READ_JOB_PRESSURED = Symbol("read-job-pressured");
/** Queue admission rejected a search without posting it to a worker. */
export const VECTOR_SEARCH_PRESSURED = Symbol("vector-search-pressured");

/** Internal marker the per-request timer resolves the dispatch Promise with, so
 *  {@link dispatchToPool} can distinguish a timeout from a worker reply payload
 *  (which is never a symbol). Not exported — callers see the per-family
 *  sentinels above. */
const POOL_REQUEST_TIMED_OUT = Symbol("pool-request-timed-out");
const POOL_REQUEST_UNAVAILABLE = Symbol("pool-request-unavailable");

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

/** Host-side waiting room. In-flight jobs are separately capped at one per
 * worker; no worker receives a second message while it is running SQL. */
export const MAX_PENDING_READ_JOBS = 128;
export const MAX_PENDING_READ_BYTES = 8 * 1024 * 1024;
const MAX_BACKGROUND_PENDING_JOBS = 32;
const MAX_BACKGROUND_PENDING_BYTES = 2 * 1024 * 1024;
const FOREGROUND_WEIGHT = 4;

export type ReadPoolPriority = "foreground" | "background";
export interface ReadPoolRequestOptions {
  priority?: ReadPoolPriority;
  /** Abort a queued request before dispatch. Running SQL keeps its worker slot
   * until it finishes or its deadline retires the worker. */
  signal?: AbortSignal;
}

export interface ReadPoolStats {
  pendingCount: number;
  pendingBytes: number;
  runningCount: number;
  retiringCount: number;
  oldestPendingMs: number;
}

export interface ReadPoolTelemetry extends ReadPoolStats {
  family: "read" | "search";
  priority: ReadPoolPriority;
  outcome:
    | "admitted"
    | "pressure"
    | "started"
    | "ok"
    | "error"
    | "timeout"
    | "cancelled"
    | "unavailable";
  queueMs?: number;
  serviceMs?: number;
}

let readPoolTelemetryHook: ((sample: ReadPoolTelemetry) => void) | null = null;
export function setReadPoolTelemetryHook(
  hook: ((sample: ReadPoolTelemetry) => void) | null,
): void {
  readPoolTelemetryHook = hook;
}

/** Consecutive structural failures (worker death / load failure / reader-open
 *  failure) — with no healthy reply in between — that latch the pool broken.
 *  A persistently unresolvable worker (missing bundle, bad DB path) would
 *  otherwise respawn on every call; latching prevents repeated expensive
 *  attempts for the rest of the process. */
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
  id: number;
  message: VectorWorkerInbound;
  priority: ReadPoolPriority;
  bytes: number;
  enqueuedAt: number;
  startedAt?: number;
  owner?: PoolWorker;
  state: "queued" | "running" | "settled";
  signal?: AbortSignal;
  onAbort?: () => void;
  callerSettled: boolean;
}

interface PoolWorker {
  worker: Worker;
  inflight: Map<number, Pending>;
  dead: boolean;
}

let workers: PoolWorker[] = [];
let foregroundQueue: Pending[] = [];
let backgroundQueue: Pending[] = [];
let pendingBytes = 0;
let backgroundBytes = 0;
let consecutiveForeground = 0;
let pumping = false;
/** A retiring native worker still consumes a physical slot until termination
 * is confirmed. Never create fictitious capacity on a caller timeout. */
let retiringVectorWorkers = new Set<ShutdownableVectorWorker>();
let nextRequestId = 0;
/** Latched true after spawning fails — stops per-call retry storms. */
let poolBroken = false;
/** Consecutive structural failures since the last healthy reply. */
let structuralFailures = 0;
let activeDbReadGeneration: number | null = null;
/** True while shutting the pool down, so terminate()-induced exits aren't
 *  counted as structural failures. */
let shuttingDown = false;
/** Shared confirmation for the one process-generation pool teardown. */
let vectorPoolShutdownPromise: Promise<void> | null = null;
/** Runtime-retired generations remain owned until their exits are confirmed. */
let retiredVectorWorkers = new OwnedRetirements<ShutdownableVectorWorker>();

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
  // LORE_DISABLE_VEC_WORKER=1 disables the off-thread read-worker pool.
  // Required foreground memory reads then return retryable 503; optional
  // reads degrade. This never enables an unbounded synchronous scan.
  if (process.env.LORE_DISABLE_VEC_WORKER === "1") return false;
  // With a test factory installed the pool is explicitly under test.
  if (testWorkerFactory) return true;
  // Otherwise inert in tests so unit suites keep pure in-process behavior and
  // never attempt a real spawn (which can't resolve the .ts worker in vitest).
  if (process.env.NODE_ENV === "test") return false;
  return config().search.embeddings.workerOffload !== false;
}

/** Unit tests without a worker factory intentionally exercise the legacy
 * in-process query path. Production never treats worker failure or a disabled
 * worker as permission to execute an unbounded scan on the gateway thread. */
export function inProcessReadFallbackForTest(): boolean {
  return (
    process.env.NODE_ENV === "test" &&
    !testWorkerFactory &&
    process.env.LORE_DISABLE_VEC_WORKER !== "1"
  );
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

export function readPoolStats(): ReadPoolStats {
  const pending = [...foregroundQueue, ...backgroundQueue];
  return {
    pendingCount: pending.length,
    pendingBytes,
    runningCount: workers.reduce((n, w) => n + w.inflight.size, 0),
    retiringCount: retiringVectorWorkers.size,
    oldestPendingMs: pending.length
      ? Math.max(
          0,
          performance.now() - Math.min(...pending.map((p) => p.enqueuedAt)),
        )
      : 0,
  };
}

function emitPoolTelemetry(
  p: Pending,
  outcome: ReadPoolTelemetry["outcome"],
): void {
  if (!readPoolTelemetryHook) return;
  try {
    readPoolTelemetryHook({
      ...readPoolStats(),
      family: p.message.type === "search" ? "search" : "read",
      priority: p.priority,
      outcome,
      queueMs:
        p.startedAt === undefined ? undefined : p.startedAt - p.enqueuedAt,
      serviceMs:
        p.startedAt === undefined ? undefined : performance.now() - p.startedAt,
    });
  } catch {
    // Telemetry cannot interrupt admission or worker lifecycle.
  }
}

/** Charge the actual structured-clone payload retained by the host queue.
 * String lengths use UTF-8 bytes; binary payloads use their byte length. */
function messageBytes(message: VectorWorkerInbound): number {
  if (message.type === "shutdown") return 0;
  if (message.type === "search") {
    if (!(message.embedding instanceof Float32Array))
      throw new TypeError("invalid vector embedding");
    return (
      128 +
      message.embedding.byteLength +
      Buffer.byteLength(JSON.stringify(snapshotVectorSpec(message.spec)))
    );
  }
  if (
    typeof message.spec.sql !== "string" ||
    !Array.isArray(message.spec.params) ||
    (message.spec.mode !== "all" && message.spec.mode !== "get")
  )
    throw new TypeError("invalid read job");
  return (
    128 +
    Buffer.byteLength(message.spec.sql) +
    message.spec.params.reduce<number>((total, param) => {
      if (!validReadParam(param)) throw new TypeError("invalid read parameter");
      return (
        total +
        32 +
        (param instanceof Uint8Array
          ? param.byteLength
          : Buffer.byteLength(String(param)))
      );
    }, 0)
  );
}

function validReadParam(param: unknown): boolean {
  return (
    param === null ||
    param instanceof Uint8Array ||
    ["string", "number", "bigint", "boolean"].includes(typeof param)
  );
}

/** Copy only protocol fields. Extra runtime properties (including binary
 * buffers invisible to JSON size accounting) must never enter the queue. */
function snapshotVectorSpec(spec: VectorQuerySpec): VectorQuerySpec {
  if (typeof spec.limit !== "number")
    throw new TypeError("invalid vector limit");
  switch (spec.kind) {
    case "knowledge": {
      if (spec.tenantId !== undefined && typeof spec.tenantId !== "string")
        throw new TypeError("invalid tenant id");
      if (
        spec.excludeCategories !== undefined &&
        (!Array.isArray(spec.excludeCategories) ||
          !spec.excludeCategories.every(
            (category) => typeof category === "string",
          ))
      )
        throw new TypeError("invalid vector categories");
      return {
        kind: "knowledge",
        limit: spec.limit,
        tenantId: spec.tenantId,
        excludeCategories: spec.excludeCategories?.slice(),
      };
    }
    case "entities":
    case "distillations":
      if (spec.tenantId !== undefined && typeof spec.tenantId !== "string")
        throw new TypeError("invalid tenant id");
      return { kind: spec.kind, limit: spec.limit, tenantId: spec.tenantId };
    case "allDistillations":
      if (typeof spec.projectId !== "string")
        throw new TypeError("invalid project id");
      return {
        kind: "allDistillations",
        limit: spec.limit,
        projectId: spec.projectId,
      };
    case "temporal":
      if (
        typeof spec.projectId !== "string" ||
        (spec.sessionId !== undefined && typeof spec.sessionId !== "string")
      )
        throw new TypeError("invalid temporal scope");
      return {
        kind: "temporal",
        limit: spec.limit,
        projectId: spec.projectId,
        sessionId: spec.sessionId,
      };
  }
  throw new TypeError("invalid vector kind");
}

/** Capture the request at admission. Queued callers may mutate their input
 * before dispatch; in particular, a tiny typed-array view must not retain (or
 * cause structuredClone to copy) a huge backing buffer in the waiting room. */
function snapshotMessage(message: VectorWorkerInbound): VectorWorkerInbound {
  if (message.type === "search")
    return {
      ...message,
      spec: snapshotVectorSpec(message.spec),
      embedding: new Float32Array(message.embedding),
    };
  if (message.type === "read")
    return {
      ...message,
      spec: {
        sql: message.spec.sql,
        mode: message.spec.mode,
        params: message.spec.params.map((param) =>
          param instanceof Uint8Array ? new Uint8Array(param) : param,
        ),
      },
    };
  return message;
}

function removeQueued(p: Pending): void {
  const queue = p.priority === "foreground" ? foregroundQueue : backgroundQueue;
  const index = queue.indexOf(p);
  if (index < 0) return;
  queue.splice(index, 1);
  pendingBytes -= p.bytes;
  if (p.priority === "background") backgroundBytes -= p.bytes;
}

function resolveCaller(p: Pending, value: unknown): void {
  if (p.callerSettled) return;
  p.callerSettled = true;
  p.resolve(value);
}

/** Remove ownership before settling; late worker replies cannot complete a
 * request twice or release a slot that a different job now occupies. */
function finishPending(
  p: Pending,
  outcome: ReadPoolTelemetry["outcome"],
  value: unknown,
  error?: Error,
): void {
  if (p.state === "settled") return;
  if (p.state === "queued") removeQueued(p);
  else p.owner?.inflight.delete(p.id);
  p.state = "settled";
  clearTimeout(p.timer);
  if (p.signal && p.onAbort) p.signal.removeEventListener("abort", p.onAbort);
  // A running abort already reported its terminal outcome to the caller and
  // telemetry, but still owns this worker until its reply (or retirement).
  if (p.callerSettled) return;
  emitPoolTelemetry(p, outcome);
  p.callerSettled = true;
  if (error) p.reject(error);
  else p.resolve(value);
}

function drainQueued(
  value: unknown,
  outcome: ReadPoolTelemetry["outcome"],
): void {
  for (const p of [...foregroundQueue, ...backgroundQueue]) {
    finishPending(p, outcome, value);
  }
  consecutiveForeground = 0;
}

function takeNext(): Pending | undefined {
  if (!backgroundQueue.length) consecutiveForeground = 0;
  const pickBackground =
    backgroundQueue.length > 0 &&
    (foregroundQueue.length === 0 ||
      consecutiveForeground >= FOREGROUND_WEIGHT);
  const queue = pickBackground ? backgroundQueue : foregroundQueue;
  const p = queue[0];
  if (!p) return undefined;
  removeQueued(p);
  consecutiveForeground = pickBackground ? 0 : consecutiveForeground + 1;
  return p;
}

/** Only idle workers receive messages. A synchronous fake worker may reply
 * inside postMessage, so a bounded loop drains newly freed slots without
 * recursively dispatching into the same worker. */
function pumpQueue(): void {
  if (poolBroken) {
    drainQueued(POOL_REQUEST_UNAVAILABLE, "unavailable");
    return;
  }
  if (pumping || shuttingDown) return;
  pumping = true;
  try {
    refreshPoolDatabaseGeneration();
    const live = ensurePool();
    if (poolBroken) {
      drainQueued(POOL_REQUEST_UNAVAILABLE, "unavailable");
      return;
    }
    let assigned = true;
    while (assigned && (foregroundQueue.length || backgroundQueue.length)) {
      assigned = false;
      for (const pw of live) {
        if (pw.dead || pw.inflight.size) continue;
        const p = takeNext();
        if (!p) break;
        assigned = true;
        p.state = "running";
        p.owner = pw;
        p.startedAt = performance.now();
        pw.inflight.set(p.id, p);
        emitPoolTelemetry(p, "started");
        try {
          pw.worker.postMessage(p.message);
        } catch (error) {
          markDead(
            pw,
            error instanceof Error ? error : new Error(String(error)),
          );
          terminateRetiredVectorWorker(pw.worker);
        }
      }
    }
  } catch (error) {
    drainQueued(POOL_REQUEST_UNAVAILABLE, "unavailable");
    log.info(
      "read worker queue dispatch failed:",
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    pumping = false;
  }
}

/** Reject and clear every in-flight request on a worker. Used for STRUCTURAL
 *  deaths (crash / `error` / `exit` / init-error / shutdown): the worker is
 *  genuinely gone, so each caller applies its unavailable policy. */
function failAll(pw: PoolWorker, err: Error): void {
  for (const p of pw.inflight.values())
    finishPending(p, "unavailable", null, err);
}

/** Resolve the one running request on a timed-out worker without triggering a
 * main-thread scan. Queued requests retain independent deadlines on the host. */
function timeoutAll(pw: PoolWorker): void {
  for (const p of pw.inflight.values())
    finishPending(p, "timeout", POOL_REQUEST_TIMED_OUT);
}

function trackVectorWorkerShutdown(
  worker: ShutdownableVectorWorker,
  shutdown: () => Promise<void>,
): void {
  // Capture the generation registry so the test-only reset can replace the
  // module-level owner without a late completion mutating the next test.
  const generation = retiredVectorWorkers;
  void generation.retireOnce(worker, shutdown);
}

function terminateRetiredVectorWorker(worker: ShutdownableVectorWorker): void {
  const retiring = retiringVectorWorkers;
  if (retiring.has(worker)) return;
  retiring.add(worker);
  trackVectorWorkerShutdown(worker, async () => {
    await worker.terminate();
    retiring.delete(worker);
    // The native thread has exited: its physical slot can now be reused.
    if (retiring === retiringVectorWorkers) pumpQueue();
  });
}

async function settleRetiredVectorWorkers(deadlineMs: number): Promise<void> {
  await retiredVectorWorkers.settle({
    timeoutMs: deadlineMs,
    timeoutMessage:
      "retired vector worker did not settle before shutdown deadline",
    failureMessage: "vector worker termination was not confirmed",
  });
}

/**
 * Cancel a timed-out search by retiring its worker.
 *
 * A worker runs `runVectorQuery` synchronously, so a query that blew the
 * timeout can't be interrupted from JS — terminating the worker is the only way
 * to reclaim the thread it's pinning (V8 tears it down once the in-progress
 * native call returns). The immediate, guaranteed effect is de-routing: marking
 * it `dead` prevents further dispatch to it. The host queue holds subsequent
 * work until termination is confirmed and a physical slot is available.
 *
 * Crucially this is NOT counted as a structural failure: a timeout is slowness,
 * not a broken worker, and latching the pool broken after repeated timeouts
 * would leave every foreground heavy read unavailable. Setting `dead` first makes
 * the terminate()-induced `exit` handler's {@link markDead} a no-op, so the
 * structural-failure latch is never touched. Only one job is posted per worker.
 */
function retireTimedOutWorker(pw: PoolWorker): void {
  if (pw.dead) return;
  pw.dead = true;
  timeoutAll(pw);
  terminateRetiredVectorWorker(pw.worker);
  pumpQueue();
}

/**
 * Count a structural failure (worker death / load failure / reader-open
 * failure). After MAX_STRUCTURAL_FAILURES in a row with no healthy reply, latch
 * the pool broken and terminate any survivors instead of respawn-storming.
 */
function recordStructuralFailure(): void {
  if (shuttingDown || poolBroken) return;
  structuralFailures++;
  if (structuralFailures < MAX_STRUCTURAL_FAILURES) return;
  poolBroken = true;
  drainQueued(POOL_REQUEST_UNAVAILABLE, "unavailable");
  log.info(
    "vector worker pool disabled (repeated worker failures) — heavy reads degraded",
  );
  for (const w of workers) {
    if (!w.dead) {
      w.dead = true;
      failAll(w, new Error("vector worker pool disabled"));
    }
    terminateRetiredVectorWorker(w.worker);
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
  if (foregroundQueue.length || backgroundQueue.length) pumpQueue();
}

function makeWorker(): PoolWorker | null {
  let spawned: Worker | undefined;
  try {
    const worker = spawnWorker({ dbPath: dbPath() });
    spawned = worker;
    const pw: PoolWorker = { worker, inflight: new Map(), dead: false };
    // Don't keep the process alive for a background read worker.
    worker.unref();

    worker.on("message", (msg: VectorWorkerOutbound) => {
      // A retired reader can report a late success after its database was
      // replaced. It must neither serve a stale result nor clear the current
      // generation's structural-failure streak.
      if (pw.dead) return;
      switch (msg.type) {
        case "result": {
          // A healthy reply clears the structural-failure streak.
          structuralFailures = 0;
          const pending = pw.inflight.get(msg.id);
          if (pending) {
            finishPending(pending, "ok", msg.hits);
            pumpQueue();
          }
          break;
        }
        case "read-result": {
          // A healthy reply clears the structural-failure streak.
          structuralFailures = 0;
          const pending = pw.inflight.get(msg.id);
          if (pending) {
            finishPending(pending, "ok", msg.rows);
            pumpQueue();
          }
          break;
        }
        case "error": {
          // Per-request failure (NOT a worker death) — reject just this
          // request; the worker keeps serving. Caller applies its failure policy.
          const pending = pw.inflight.get(msg.id);
          if (pending) {
            finishPending(pending, "error", null, new Error(msg.error));
            pumpQueue();
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
    // we stop trying — heavy reads follow their failure policy until restart.
    poolBroken = true;
    drainQueued(POOL_REQUEST_UNAVAILABLE, "unavailable");
    for (const pw of workers) {
      pw.dead = true;
      failAll(pw, new Error("read worker pool spawn failed"));
      terminateRetiredVectorWorker(pw.worker);
    }
    if (spawned) terminateRetiredVectorWorker(spawned);
    workers = [];
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
  // Process shutdown permanently closes admission for this pool generation.
  // This guard is intentionally duplicated in dispatchToPool: ensurePool is
  // the only function that can spawn, so a later refactor cannot accidentally
  // repopulate workers after shutdownVectorPoolAsync snapshots ownership.
  if (shuttingDown) return [];
  // Terminate and drop dead workers. A worker that hit init-error keeps its
  // message loop alive, so we must terminate it explicitly or it leaks a thread.
  for (const w of workers) {
    if (w.dead) {
      terminateRetiredVectorWorker(w.worker);
    }
  }
  workers = workers.filter((w) => !w.dead);
  const target = desiredPoolSize();
  while (workers.length + retiringVectorWorkers.size < target) {
    const pw = makeWorker();
    if (!pw) break; // poolBroken latched
    workers.push(pw);
  }
  return workers;
}

/** A reopened writer may point to a new database (or a replacement at the
 * same path). Retire all readers from the prior writer generation before
 * dispatching another query; reset a broken latch so the new DB can recover. */
function refreshPoolDatabaseGeneration(): void {
  const generation = dbReadGeneration();
  if (activeDbReadGeneration === generation) return;
  if (activeDbReadGeneration !== null) {
    drainQueued(POOL_REQUEST_UNAVAILABLE, "unavailable");
    for (const pw of workers) {
      pw.dead = true;
      failAll(pw, new Error("read worker database replaced"));
      terminateRetiredVectorWorker(pw.worker);
    }
    workers = [];
    poolBroken = false;
    structuralFailures = 0;
  }
  activeDbReadGeneration = generation;
}

/** `ok` carries a reply; `pressure` is bounded admission refusal. Timeouts
 * and shutdown never authorize a synchronous fallback. */
type DispatchResult =
  | { status: "ok"; value: unknown }
  | { status: "unavailable" }
  | { status: "timeout" }
  | { status: "pressure" }
  | { status: "shutting-down" };

/**
 * Admit one request into the bounded host queue and await its worker reply.
 * Shared by {@link tryPoolVectorSearch} and {@link tryPoolRead}; NEVER throws.
 *
 * `makeMessage(id)` builds the typed inbound message. `label` is the human
 * request-family name ("vector worker search" / "read worker job") used in the
 * timeout log so incident triage can grep per-family wording.
 *
 * A queued timeout drops only that job; a running timeout retires its worker.
 * Both resolve `{status:"timeout"}` without a synchronous fallback. Anything else
 * (disabled pool, no worker, per-request error, postMessage throw, unexpected
 * throw) yields `{status:"unavailable"}` and the caller applies its failure policy.
 */
async function dispatchToPool(
  makeMessage: (id: number) => VectorWorkerInbound,
  label: string,
  options: ReadPoolRequestOptions = {},
): Promise<DispatchResult> {
  // Once shutdown owns the worker set, neither spawn a replacement nor route
  // this DB-capable operation to the synchronous main-thread fallback.
  if (shuttingDown) return { status: "shutting-down" };
  refreshPoolDatabaseGeneration();
  const readGeneration = dbReadGeneration();
  if (!poolEnabled()) return { status: "unavailable" };
  // Everything below is wrapped so the "never throws" contract holds by
  // construction — any unexpected throw (e.g. from ensurePool) resolves to
  // unavailable and the caller applies its failure policy.
  try {
    const live = ensurePool();
    if (poolBroken || (!live.length && !retiringVectorWorkers.size))
      return { status: "unavailable" };

    if (options.signal?.aborted) return { status: "timeout" };

    const id = nextRequestId++;
    const timeoutMs = vectorSearchTimeoutMs();
    const original = makeMessage(id);
    const estimatedBytes = messageBytes(original);
    // Runtime validation matters for JS callers: arbitrary strings must not
    // bypass accounting or become unbounded telemetry attributes.
    const priority: ReadPoolPriority =
      options.priority === "background" ? "background" : "foreground";
    const pendingCount = foregroundQueue.length + backgroundQueue.length;
    const pressure =
      estimatedBytes > MAX_PENDING_READ_BYTES ||
      pendingCount >= MAX_PENDING_READ_JOBS ||
      pendingBytes + estimatedBytes > MAX_PENDING_READ_BYTES ||
      (priority === "background" &&
        (backgroundQueue.length >= MAX_BACKGROUND_PENDING_JOBS ||
          backgroundBytes + estimatedBytes > MAX_BACKGROUND_PENDING_BYTES));
    if (pressure) {
      emitPoolTelemetry(
        {
          message: original,
          priority,
          enqueuedAt: performance.now(),
          startedAt: undefined,
        } as Pending,
        "pressure",
      );
      return { status: "pressure" };
    }

    const message = snapshotMessage(original);
    const bytes = messageBytes(message);
    // Defensive against getters/mutation during cloning; the queue accounts
    // for the retained snapshot, never for a caller-owned mutable view.
    if (
      bytes > MAX_PENDING_READ_BYTES ||
      pendingBytes + bytes > MAX_PENDING_READ_BYTES ||
      (priority === "background" &&
        backgroundBytes + bytes > MAX_BACKGROUND_PENDING_BYTES)
    )
      return { status: "pressure" };

    const settled = await new Promise<unknown>((resolve, reject) => {
      const p: Pending = {
        id,
        message,
        priority,
        bytes,
        enqueuedAt: performance.now(),
        state: "queued",
        resolve,
        reject,
        timer: undefined as unknown as ReturnType<typeof setTimeout>,
        signal: options.signal,
        callerSettled: false,
      };
      const timer = setTimeout(() => {
        if (p.state === "queued") {
          finishPending(p, "timeout", POOL_REQUEST_TIMED_OUT);
        } else if (p.state === "running" && p.owner) {
          log.info(
            `${label} timed out after ${timeoutMs}ms — terminating the wedged worker without re-running in-process`,
          );
          retireTimedOutWorker(p.owner);
        }
      }, timeoutMs);
      // The worker is already unref'd (makeWorker), so an in-flight request must
      // not be the thing that keeps the event loop alive: unref the timeout too,
      // or a pending request delays process exit by up to the timeout on
      // shutdown. (review #989)
      timer.unref?.();
      p.timer = timer;
      p.onAbort = () => {
        if (p.state === "queued")
          finishPending(p, "cancelled", POOL_REQUEST_TIMED_OUT);
        else if (p.state === "running" && !p.callerSettled) {
          // Do not free the native worker: it still runs this SQL. Its deadline
          // remains armed and retires it if the job does not finish.
          resolveCaller(p, POOL_REQUEST_TIMED_OUT);
          emitPoolTelemetry(p, "cancelled");
        }
      };
      foregroundQueueOrBackground(p).push(p);
      pendingBytes += bytes;
      if (priority === "background") backgroundBytes += bytes;
      if (options.signal) {
        options.signal.addEventListener("abort", p.onAbort, { once: true });
        if (options.signal.aborted) p.onAbort();
      }
      if (p.state === "queued") {
        emitPoolTelemetry(p, "admitted");
        pumpQueue();
      }
    });
    // A writer close/reopen can happen while this job runs, even before the
    // next dispatch notices the new generation. Never return stale rows from
    // the old reader as a successful snapshot for the new database.
    if (dbReadGeneration() !== readGeneration) return { status: "unavailable" };
    if (settled === POOL_REQUEST_TIMED_OUT) return { status: "timeout" };
    if (settled === POOL_REQUEST_UNAVAILABLE) return { status: "unavailable" };
    return { status: "ok", value: settled };
  } catch (err) {
    // shutdownVectorPoolAsync rejects in-flight work via failAll(). Treat that
    // transition as closed admission, not as a reason to run the same SQLite
    // operation in-process while the writer is being closed.
    if (shuttingDown) return { status: "shutting-down" };
    log.info(
      `${label} failed; degrading off-thread read:`,
      err instanceof Error ? err.message : String(err),
    );
    return { status: "unavailable" };
  }
}

function foregroundQueueOrBackground(p: Pending): Pending[] {
  return p.priority === "foreground" ? foregroundQueue : backgroundQueue;
}

/**
 * Run a vector search on the pool. Resolves to:
 *   - the hits, on success;
 *   - `null` when the pool is disabled/unavailable/failed → the caller applies
 *     its failure policy;
 *   - {@link VECTOR_SEARCH_TIMED_OUT} when the request timed out → the caller
 *     returns an empty result WITHOUT re-running the scan on the main thread.
 * Never rejects.
 */
export async function tryPoolVectorSearch(
  spec: VectorQuerySpec,
  embedding: Float32Array,
  options?: ReadPoolRequestOptions,
): Promise<
  Hits | null | typeof VECTOR_SEARCH_TIMED_OUT | typeof VECTOR_SEARCH_PRESSURED
> {
  const r = await dispatchToPool(
    (id) => ({ type: "search", id, spec, embedding }),
    "vector worker search",
    options,
  );
  if (r.status === "timeout" || r.status === "shutting-down") {
    return VECTOR_SEARCH_TIMED_OUT;
  }
  if (r.status === "unavailable") return null;
  if (r.status === "pressure") return VECTOR_SEARCH_PRESSURED;
  // A successful search always returns an array (never null), so the unwrap to
  // Hits is safe.
  return r.value as Hits;
}

/**
 * Run a generic read-only SQL job on the pool. Resolves to:
 *   - `{ rows }` (row array for `mode:"all"`, single row or null for "get") on
 *     success — the `{ rows }` wrapper disambiguates a `.get()` no-row null from
 *     "pool unavailable";
 *   - `null` when the pool is disabled/unavailable/failed → the caller applies
 *     its failure policy;
 *   - {@link READ_JOB_TIMED_OUT} when the read timed out → the caller DEGRADES
 *     to an empty result WITHOUT re-running the scan on the main thread.
 * Never rejects.
 */
export async function tryPoolRead(
  spec: ReadJobSpec,
  options?: ReadPoolRequestOptions,
): Promise<
  | { rows: unknown }
  | null
  | typeof READ_JOB_TIMED_OUT
  | typeof READ_JOB_PRESSURED
> {
  const r = await dispatchToPool(
    (id) => ({ type: "read", id, spec }),
    "read worker job",
    options,
  );
  if (r.status === "timeout" || r.status === "shutting-down") {
    return READ_JOB_TIMED_OUT;
  }
  if (r.status === "unavailable") return null;
  if (r.status === "pressure") return READ_JOB_PRESSURED;
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
 *  being counted as structural failures.
 *
 *  This is the SYNCHRONOUS variant: it posts `shutdown` and immediately calls
 *  `terminate()` without waiting for the cooperative handler in
 *  `vector-worker.ts` to flush its reader `close()` + `process.exit(0)`. That
 *  is fine for test teardown (the next test opens a fresh pool) but WRONG for
 *  graceful gateway shutdown: the readers each hold a WAL read-mark, and the
 *  writer's TRUNCATE checkpoint (#1221) cannot reset the WAL while any reader
 *  is alive — so leaving the readers up while we try to close the writer
 *  leaves a stranded `-wal` that must be recovered on next boot (#1599).
 *  Use {@link shutdownVectorPoolAsync} on the graceful path. */
export function shutdownVectorPool(): void {
  shuttingDown = true;
  drainQueued(POOL_REQUEST_TIMED_OUT, "timeout");
  for (const pw of workers) {
    failAll(pw, new Error("vector pool shutting down"));
    try {
      pw.worker.postMessage({ type: "shutdown" });
    } catch {
      // worker may already be gone
    }
    try {
      void pw.worker.terminate().catch(() => {});
    } catch {
      // best-effort
    }
  }
  workers = [];
}

/** Default budget for {@link shutdownVectorPoolAsync} — the wait is bounded so
 *  a stuck worker can never hang process shutdown. Tuned to fit comfortably
 *  under the gateway's 4000ms SHUTDOWN_DEADLINE_MS after the embedding drain
 *  (≈60%) and writer close (best-effort, ≈50ms with busy_timeout=0). */
export const DEFAULT_VECTOR_POOL_SHUTDOWN_DEADLINE_MS = 1500;

/** Cooperative "exit" listener signature — the only `Worker` event
 *  {@link shutdownVectorPoolAsync} cares about. Matches the real
 *  `node:worker_threads` Worker `exit` event and lets tests inject a fake. */
type ExitListener = (code: number) => void;

/** Minimal worker surface needed by {@link shutdownVectorPoolAsync}. The real
 *  `node:worker_threads` Worker has more; tests inject a fake. */
interface ShutdownableVectorWorker {
  /** Real Worker#on("exit", listener); the real Worker also fires "error" but
   *  that's handled inside the pool's normal exit handler, not here. */
  on(event: "exit", listener: ExitListener): unknown;
  /** Posts the cooperative shutdown message. May throw if the worker is gone. */
  postMessage(value: VectorWorkerInbound): void;
  /** Force-kills the worker thread. Resolves only once the worker exits. */
  terminate(): Promise<number>;
}

/**
 * Tear down every worker in the pool and wait for each to exit, bounded by
 * `deadlineMs`. Each worker:
 *
 *   1. Has its in-flight requests rejected with "vector pool shutting down"
 *      (dispatch converts that shutdown rejection to the no-fallback sentinel,
 *      so no synchronous SQLite work can race writer close);
 *   2. Receives a cooperative `shutdown` message so `vector-worker.ts` can
 *      run its `reader.db.close()` flush + `process.exit(0)`;
 *   3. If the deadline fires before the worker emits `exit`, is force-
 *      `terminate()`d so its reader cannot outlive the budget.
 *
 * Rejects when a worker's exit cannot be confirmed, allowing the process
 * boundary to choose a forced exit without closing SQLite underneath a live
 * reader. Idempotent: concurrent/repeated calls share one result. Designed for
 * graceful gateway shutdown (#1599): the
 * writer's TRUNCATE checkpoint requires no reader WAL read-marks, so the
 * readers MUST be gone before the writer `close()`s — otherwise the WAL is
 * stranded and the next boot pays the WAL-recovery tax.
 */
export function shutdownVectorPoolAsync(
  deadlineMs: number = DEFAULT_VECTOR_POOL_SHUTDOWN_DEADLINE_MS,
): Promise<void> {
  if (vectorPoolShutdownPromise) return vectorPoolShutdownPromise;
  shuttingDown = true;
  drainQueued(POOL_REQUEST_TIMED_OUT, "timeout");
  // Snapshot the current worker list, then drop our reference so a stray
  // postMessage from a dead worker can't see the pool as "still alive".
  const live = workers;
  workers = [];
  // Reject in-flight requests FIRST so callers stop awaiting results — that
  // also lets the cooperative `shutdown` message reach the worker ahead of any
  // inflight reply the worker is preparing to post.
  for (const pw of live) {
    failAll(pw, new Error("vector pool shutting down"));
    trackVectorWorkerShutdown(pw.worker, () =>
      waitForOneWorkerExit(pw.worker, deadlineMs),
    );
  }

  // Includes workers removed during timeout recovery or structural failure,
  // not just the current array snapshot. Their SQLite readers must also be
  // gone before gateway shutdown may close the writer connection.
  vectorPoolShutdownPromise = settleRetiredVectorWorkers(deadlineMs);
  return vectorPoolShutdownPromise;
}

/** Cooperative shutdown for one worker: post `shutdown`, wait for its `exit`
 *  event up to `deadlineMs`, then force-terminate. Rejects when termination
 *  cannot be confirmed. Exported only for tests. */
export function awaitVectorWorkerShutdown(
  worker: ShutdownableVectorWorker,
  deadlineMs: number,
): Promise<void> {
  return waitForOneWorkerExit(worker, deadlineMs);
}

function waitForOneWorkerExit(
  worker: ShutdownableVectorWorker,
  deadlineMs: number,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let done = false;
    let forceStarted = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(killTimer);
      resolve();
    };
    const forceTerminate = (): void => {
      if (done || forceStarted) return;
      forceStarted = true;
      void worker.terminate().then(finish, (cause: unknown) => {
        if (done) return;
        done = true;
        clearTimeout(killTimer);
        reject(
          new Error("vector worker termination was not confirmed", { cause }),
        );
      });
    };
    // Hard cap: a worker whose reader open is wedged or whose `shutdown`
    // handler never flushes would otherwise hang the gateway's bounded
    // shutdown. Terminate is safe — the reader's SQLite state lives on a
    // per-thread connection; the main thread's WAL just has to recover any
    // uncheckpointed read on next open, which SQLite handles natively.
    const killTimer = setTimeout(forceTerminate, Math.max(0, deadlineMs));
    // Don't keep the event loop alive for this timer — `runShutdownWithDeadline`
    // already has its own hard cap at SHUTDOWN_DEADLINE_MS, and the worker is
    // unref'd so its termination already won't block exit. See review #989.
    killTimer.unref?.();

    worker.on("exit", finish);
    try {
      worker.postMessage({ type: "shutdown" });
    } catch {
      // Posting can fail during a termination race. Node's termination promise
      // is the authoritative confirmation that the reader thread is gone.
      forceTerminate();
    }
  });
}

/** For tests: reset all pool state (workers, latches, counters, request ids). */
export function _resetVectorPoolForTest(): void {
  shutdownVectorPool();
  vectorPoolShutdownPromise = null;
  retiredVectorWorkers = new OwnedRetirements<ShutdownableVectorWorker>();
  retiringVectorWorkers = new Set<ShutdownableVectorWorker>();
  foregroundQueue = [];
  backgroundQueue = [];
  pendingBytes = 0;
  backgroundBytes = 0;
  consecutiveForeground = 0;
  pumping = false;
  readPoolTelemetryHook = null;
  poolBroken = false;
  nextRequestId = 0;
  structuralFailures = 0;
  activeDbReadGeneration = null;
  shuttingDown = false;
}
