/** Local ONNX embedding worker lifecycle. */

import { freemem } from "node:os";
import { db } from "../db";
import * as log from "../log";
import { vendorModelInfo } from "../embedding-vendor";
import { nativeIntraOpThreads } from "../ort-native";
import {
  MIN_EMBED_TOKENS,
  MODEL_MAX_TOKENS,
  backoffEmbedCap,
  clampFreeToContainerLimit,
  memoryModelEmbedCap,
  reconcileEmbedCap,
  reprobeEmbedCap,
  shouldReprobeEmbedCap,
  type PersistedEmbedCap,
} from "../embedding-cap";
import {
  EMBED_OOM_EXIT_CODE,
  isMissingLocalStackError,
  isWasmFatalError,
  type EmbedRequest,
  type WorkerInbound,
  type WorkerOutbound,
  type WorkerInitData,
} from "../embedding-worker-types";
import { OwnedRetirements } from "../owned-retirements";
import {
  EmbeddingProviderError,
  EmbeddingRequestAbortedError,
  type EmbeddingProvider,
  LocalProviderUnavailableError,
  type ShutdownableWorker,
  WORKER_SHUTDOWN_TIMEOUT_MS,
  awaitWorkerShutdown,
  isRecallEmbed,
} from "./contract";

const EMBED_CAP_KV_KEY = "lore:embedding_cap";

const EMBED_REPROBE_INTERVAL_MS = 5 * 60_000;

function readPersistedEmbedCap(): PersistedEmbedCap | null {
  try {
    const row = db()
      .query("SELECT value FROM kv_meta WHERE key = ?")
      .get(EMBED_CAP_KV_KEY) as { value: string } | null;
    if (!row) return null;
    const parsed = JSON.parse(row.value) as Partial<PersistedEmbedCap>;
    if (
      typeof parsed.cap !== "number" ||
      typeof parsed.freeMemBytes !== "number"
    ) {
      return null;
    }
    return {
      cap: parsed.cap,
      freeMemBytes: parsed.freeMemBytes,
      ...(typeof parsed.knownBadCap === "number" && parsed.knownBadCap > 0
        ? { knownBadCap: parsed.knownBadCap }
        : {}),
    };
  } catch {
    return null;
  }
}

let testConstrainedMemoryBytes: number | null = null;
export function _setConstrainedMemoryForTest(bytes: number | null): void {
  testConstrainedMemoryBytes = bytes;
}

let testHostFreememBytes: number | null = null;
export function _setContainerFreeForTest(bytes: number | null): void {
  testHostFreememBytes = bytes;
}

/**
 * The process's cgroup memory LIMIT in bytes (not free-within-limit), or `0` if unconstrained / unknown
 * / unsupported by the runtime. `process.constrainedMemory()` is libuv-backed (cgroup v1 + v2, no
 * hard-coded paths) and returns `0` when unconstrained; it is present in both Node (≥18.15) and Bun.
 */
export function constrainedMemoryLimit(): number {
  if (testConstrainedMemoryBytes != null) return testConstrainedMemoryBytes;
  const fn = (process as { constrainedMemory?: () => number })
    .constrainedMemory;
  const v = typeof fn === "function" ? fn() : 0;
  return Number.isFinite(v) && v > 0 ? v : 0;
}

function containerFreeBytes(): number {
  const raw = testHostFreememBytes != null ? testHostFreememBytes : freemem();
  return clampFreeToContainerLimit(raw, constrainedMemoryLimit());
}

function persistEmbedCap(
  cap: number,
  freeMemBytes: number = containerFreeBytes(),
  knownBadCap = 0,
): void {
  try {
    const value = JSON.stringify({
      cap,
      freeMemBytes,
      ...(knownBadCap > 0 ? { knownBadCap } : {}),
    } satisfies PersistedEmbedCap);
    db()
      .query(
        "INSERT INTO kv_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?",
      )
      .run(EMBED_CAP_KV_KEY, value, value);
  } catch {
    // Best-effort: a failure just means we re-derive the cap next start.
  }
}

function computeInitialEmbedCap(
  persisted: PersistedEmbedCap | null = readPersistedEmbedCap(),
  memDivisor = 1,
): number {
  const free = containerFreeBytes() / Math.max(1, memDivisor);
  return reconcileEmbedCap(
    free,
    persisted,
    memoryModelEmbedCap(free),
    persisted?.knownBadCap ?? 0,
  );
}

/**
 * For tests: persist a learned embedding cap (kv_meta round-trip). `freeMemBytes` defaults to the live
 * `freemem()`.
 */
export function _persistEmbedCap(
  cap: number,
  freeMemBytes?: number,
  knownBadCap?: number,
): void {
  persistEmbedCap(cap, freeMemBytes, knownBadCap);
}

/** For tests: read the persisted embedding cap (or null when absent/corrupt). */
export function _readPersistedEmbedCap(): PersistedEmbedCap | null {
  return readPersistedEmbedCap();
}

const LOCAL_MAX_CHARS = MODEL_MAX_TOKENS * 4; // ~8192 tokens × ~4 chars/token

function safeLocalTruncate(text: string): string {
  if (text.length <= LOCAL_MAX_CHARS) return text;
  let end = LOCAL_MAX_CHARS;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end--; // don't split surrogate pair
  return text.slice(0, end);
}

// ---------------------------------------------------------------------------
// Embedding failure telemetry hook (wired by the gateway to Sentry)
// ---------------------------------------------------------------------------

/** Context for an embedding-worker memory failure, surfaced to an optional host telemetry hook. */
export interface EmbeddingFailureInfo {
  kind: "oom-backoff" | "floor-latch";
  capBefore: number;
  capAfter: number;
  /** Number of in-flight requests at the time of the OOM. */
  batchSize: number;
  /** Longest input text (chars) among in-flight requests. */
  longestChars: number;
  freeMemBytes: number;
  rssBytes: number;
}

let embeddingFailureHook: ((info: EmbeddingFailureInfo) => void) | null = null;

/** Register a host telemetry hook fired on embedding-worker OOM backoff/latch. */
export function setEmbeddingFailureHook(
  fn: ((info: EmbeddingFailureInfo) => void) | null,
): void {
  embeddingFailureHook = fn;
}

function fireEmbeddingFailure(
  info: Omit<EmbeddingFailureInfo, "freeMemBytes" | "rssBytes">,
): void {
  const hook = embeddingFailureHook;
  if (!hook) return;
  try {
    hook({
      ...info,
      freeMemBytes: freemem(),
      rssBytes: process.memoryUsage().rss,
    });
  } catch {
    // Telemetry must never break the embedding path.
  }
}
export type LocalProviderFailureCause = "terminal" | "transient-init-exhausted";
/** A terminal cause must dominate concurrent transient failures. */
export const localEmbeddingState: {
  failureCause: LocalProviderFailureCause | null;
  errorLogged: boolean;
  initFailures: number;
  initFailureGeneration: number;
  initRetryAt: number;
} = {
  failureCause: null,
  errorLogged: false,
  initFailures: 0,
  initFailureGeneration: 0,
  initRetryAt: 0,
};
let localStackMissing = false;
/** Epoch ms of the last self-heal re-probe; `0` = never (primed on first tick). */
let lastSelfHealAt = 0;
/** How long to wait between self-heal re-probes of a latched local provider. */
const SELF_HEAL_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h

// --- Transient init-failure retry (self-heal a one-off worker init failure) ---
// A single model-init failure used to latch the provider FTS-only for the whole
// process lifetime. But a transient failure — e.g. the ONNX model file read
// while a concurrent process was still writing it during a multi-instance
// restart, or momentary memory pressure — should self-heal: reject the in-flight
// requests, wait a cooldown, then respawn a FRESH worker (a new init attempt) on
// the next embed. Only latch permanently after LOCAL_INIT_MAX_ATTEMPTS
// consecutive failures, or immediately for a cause that will never self-heal
// (the optional stack being absent).
const LOCAL_INIT_MAX_ATTEMPTS = 3;
// Ceiling for the init-retry cooldown; the first retries are much faster (see
// computeInitRetryDelayMs). Also the test seam: 0 → retry immediately.
let localInitCooldownMs = 30_000;

function latchLocalProvider(cause: LocalProviderFailureCause): void {
  if (cause === "terminal" || localEmbeddingState.failureCause === null) {
    localEmbeddingState.failureCause = cause;
  }
}

export function clearLocalProviderLatch(): void {
  localEmbeddingState.failureCause = null;
}

const INIT_RETRY_BASE_MS = 2_000;
const INIT_RETRY_BACKOFF_FACTOR = 4;

/** Cooldown before the Nth fresh-worker init-retry: `base * factor^(N-1)`, clamped to `ceilingMs`. */
export function computeInitRetryDelayMs(
  failures: number,
  ceilingMs: number,
): number {
  const n = Math.max(1, failures);
  const backoff = INIT_RETRY_BASE_MS * INIT_RETRY_BACKOFF_FACTOR ** (n - 1);
  return Math.min(ceilingMs, backoff);
}

/**
 * Test seam: shorten the init-retry cooldown ceiling so the retry path is drivable without real time
 * (`0` → the next availability check retries immediately; `null` restores the production default).
 */
export function _setLocalInitCooldownMsForTest(ms: number | null): void {
  localInitCooldownMs = ms ?? 30_000;
}

/** For tests: observe the pending init-retry deadline (epoch ms; 0 = none). */
export function _getLocalInitRetryAtForTest(): number {
  return localEmbeddingState.initRetryAt;
}

/**
 * For tests: arm/clear the init-retry deadline (epoch ms; 0 = none) so the transient "retrying" health
 * state is drivable without a fake worker.
 */
export function _setLocalInitRetryAtForTest(at: number): void {
  localEmbeddingState.initRetryAt = at;
}

/** For tests: reset the local provider probe + transient-retry state. */
export function _resetLocalProviderProbe(): void {
  clearLocalProviderLatch();
  localEmbeddingState.errorLogged = false;
  localStackMissing = false;
  localEmbeddingState.initFailures = 0;
  localEmbeddingState.initFailureGeneration = 0;
  localEmbeddingState.initRetryAt = 0;
  lastSelfHealAt = 0;
}

/** For tests: simulate the local provider being unavailable, without actually spawning a worker. */
export function _markLocalProviderUnavailable(stackMissing = false): void {
  latchLocalProvider("terminal");
  localStackMissing = stackMissing;
  localEmbeddingState.errorLogged = true; // suppress the info log in tests
}

/**
 * Self-heal a permanently-latched LOCAL embedding provider: on a slow cadence, clear the latch so the
 * next embed spawns a fresh worker and re-attempts init.
 */
export function prepareLocalProviderSelfHeal(nowMs = Date.now()): boolean {
  if (localEmbeddingState.failureCause === null || localStackMissing)
    return false;
  if (lastSelfHealAt === 0) {
    // Prime: wait a full interval before the first re-probe.
    lastSelfHealAt = nowMs;
    return false;
  }
  if (nowMs - lastSelfHealAt < SELF_HEAL_INTERVAL_MS) return false;
  lastSelfHealAt = nowMs;
  // Clear the latch + transient counters so getProvider() rebuilds a fresh pool
  // and the next embed re-inits. If it fails again it simply re-latches — cheap
  // at this cadence.
  clearLocalProviderLatch();
  localEmbeddingState.errorLogged = false;
  localEmbeddingState.initFailures = 0;
  localEmbeddingState.initFailureGeneration = 0;
  localEmbeddingState.initRetryAt = 0;
  log.info(
    "self-heal: re-probing a previously-latched local embedding provider " +
      "(a fresh worker retries init on the next embed; re-latches if it fails again)",
  );
  return true;
}

type EmbeddingWorkerSpawnOptions =
  import("node:worker_threads").WorkerOptions & {
    /** Virtual filename used by the SEA eval worker's CJS require shim. */
    filename?: string;
  };

let testWorkerFactory:
  | ((
      data: WorkerInitData,
      entrypoint: string | URL,
      options: EmbeddingWorkerSpawnOptions,
    ) => import("node:worker_threads").Worker)
  | null = null;

/** For tests: install the worker factory seam above (null clears it). */
export function _setTestWorkerFactory(
  factory:
    | ((
        data: WorkerInitData,
        entrypoint: string | URL,
        options: EmbeddingWorkerSpawnOptions,
      ) => import("node:worker_threads").Worker)
    | null,
): void {
  testWorkerFactory = factory;
}

const WORKER_DIAGNOSTIC_MAX_CHARS = 2_000;
const WORKER_DIAGNOSTIC_WINDOW_MS = 60_000;
const WORKER_DIAGNOSTIC_LINES_PER_WINDOW = 20;

function drainEmbeddingWorkerStream(
  stream: import("node:stream").Readable | null | undefined,
  source: "stdout" | "stderr",
): void {
  if (!stream) return; // Test doubles created before the owned-stdio contract.

  let buffered = "";
  let emitted = 0;
  let suppressed = 0;
  let windowStartedAt = Date.now();
  let finalized = false;

  const logDiagnostic = (message: string): void => {
    try {
      log.info(message);
    } catch {
      // A host logger/sink must never interrupt stream consumption and let the
      // worker block on a full pipe. Structured worker messages still carry all
      // actionable failures to the normal parent handlers.
    }
  };

  const route = (rawLine: string): void => {
    let line = "";
    const end = rawLine.endsWith("\r") ? rawLine.length - 1 : rawLine.length;
    for (let i = 0; i < end && line.length < WORKER_DIAGNOSTIC_MAX_CHARS; i++) {
      const code = rawLine.charCodeAt(i);
      if (
        code <= 0x08 ||
        code === 0x0b ||
        code === 0x0c ||
        (code >= 0x0e && code <= 0x1f) ||
        code === 0x7f
      ) {
        continue;
      }
      line += rawLine[i];
    }
    if (!line) return;

    const now = Date.now();
    if (now - windowStartedAt >= WORKER_DIAGNOSTIC_WINDOW_MS) {
      if (suppressed > 0) {
        logDiagnostic(
          `embedding worker ${source}: suppressed ${suppressed} noisy diagnostic line(s)`,
        );
      }
      windowStartedAt = now;
      emitted = 0;
      suppressed = 0;
    }

    if (emitted < WORKER_DIAGNOSTIC_LINES_PER_WINDOW) {
      emitted++;
      logDiagnostic(`embedding worker ${source}: ${line}`);
    } else {
      suppressed++;
    }
  };

  const consume = (chunk: string): void => {
    buffered += chunk;
    for (;;) {
      const newline = buffered.indexOf("\n");
      if (newline >= 0) {
        route(buffered.slice(0, newline));
        buffered = buffered.slice(newline + 1);
        continue;
      }
      if (buffered.length > WORKER_DIAGNOSTIC_MAX_CHARS) {
        route(`${buffered.slice(0, WORKER_DIAGNOSTIC_MAX_CHARS)}…`);
        buffered = buffered.slice(WORKER_DIAGNOSTIC_MAX_CHARS);
        continue;
      }
      break;
    }
  };

  const finalize = (): void => {
    if (finalized) return;
    finalized = true;
    if (buffered) route(buffered);
    buffered = "";
    if (suppressed > 0) {
      logDiagnostic(
        `embedding worker ${source}: suppressed ${suppressed} noisy diagnostic line(s)`,
      );
    }
  };

  stream.setEncoding("utf8");
  stream.on("data", consume);
  stream.on("end", finalize);
  stream.on("close", finalize);
  stream.on("error", (error) => {
    route(`diagnostic stream error: ${error.message}`);
    finalize();
  });
  stream.resume();
}

function drainEmbeddingWorkerOutput(
  worker: import("node:worker_threads").Worker,
): void {
  drainEmbeddingWorkerStream(worker.stdout, "stdout");
  drainEmbeddingWorkerStream(worker.stderr, "stderr");
}

/** True iff the local provider has been probed and found broken. */
export function localProviderKnownUnavailable(): boolean {
  return localEmbeddingState.failureCause !== null;
}

/** Local embedding provider using @huggingface/transformers with nomic-embed-text-v1.5 by default. */
export class LocalProvider implements EmbeddingProvider {
  // With inference off the main thread, large batches no longer block
  // the event loop. 256 maximises throughput per round-trip to the
  // worker. Backfill callers use token-budget-based batching (see
  // nextBatch) to give the worker's priority queue breathing room
  // for recall queries and prevent OOM on long texts.
  readonly maxBatchSize = 256;

  private worker: import("node:worker_threads").Worker | null = null;
  private workerReady = false;
  private workerInitError: string | null = null;
  private pendingRequests = new Map<
    number,
    {
      resolve: (vectors: Float32Array[]) => void;
      reject: (error: Error) => void;
      payload: EmbedRequest;
      onExecutionStart?: () => void;
    }
  >();
  private nextRequestId = 0;
  private initPromise: Promise<void> | null = null;
  private closing = false;
  private shutdownPromise: Promise<void> | null = null;
  /** Superseded workers remain owned until terminate() confirms their exit. */
  private readonly retiredWorkers = new OwnedRetirements<ShutdownableWorker>();
  private modelId: string;
  private dimensions: number;
  private maxTokens: number;
  private capFreememAtLearn: number;
  /** Timestamp (ms) of the last upward re-probe check, for throttling. */
  private lastReprobeAt = 0;
  private lastOomCap = 0;
  private readonly memDivisor: number;
  private forceWasm = false;
  private wasmFallbackTried = false;
  private readonly onUnavailable?: () => void;

  constructor(
    modelId: string,
    dimensions: number,
    memDivisor = 1,
    onUnavailable?: () => void,
  ) {
    this.modelId = modelId;
    this.dimensions = dimensions;
    this.memDivisor = Math.max(1, memDivisor);
    this.onUnavailable = onUnavailable;
    // Seed lastOomCap from the persisted known-bad cap so an upward re-probe in
    // THIS process still respects a ceiling the WASM heap rejected in a PRIOR
    // one (a rising freemem doesn't prove the fixed heap grew). Read once and
    // reuse for the initial cap to avoid a second kv_meta round-trip.
    const persisted = readPersistedEmbedCap();
    this.lastOomCap = persisted?.knownBadCap ?? 0;
    this.maxTokens = computeInitialEmbedCap(persisted, this.memDivisor);
    this.capFreememAtLearn = containerFreeBytes();
  }

  private effectiveMaxTokens(): number {
    const liveCap = memoryModelEmbedCap(containerFreeBytes() / this.memDivisor);
    return Math.min(this.maxTokens, liveCap);
  }

  private async ensureWorker(): Promise<void> {
    if (this.closing)
      throw new LocalProviderUnavailableError("embedding worker is closing");
    if (this.workerReady) return;
    if (this.workerInitError)
      throw new LocalProviderUnavailableError(this.workerInitError);
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      // Fast-fail if a previous attempt already marked local broken.
      if (localEmbeddingState.failureCause !== null) {
        throw new LocalProviderUnavailableError();
      }

      const { Worker } = await import("node:worker_threads");
      if (this.closing) {
        throw new LocalProviderUnavailableError("embedding worker is closing");
      }

      // Resolve how to spawn the worker.
      //
      // In fossilize SEA binary mode: the binary's sea-entry.ts reads
      // the worker source from the SEA asset and exposes it via
      // `globalThis.__LORE_WORKER_SOURCE__`. We pass it to
      // `new Worker(code, { eval: true, filename, workerData })`.
      // The `filename` option sets `__filename` inside the worker to
      // an absolute path, so the post-processing patch that replaces
      // `createRequire(shim.url)` with
      // `createRequire(pathToFileURL(__filename).href)` resolves
      // correctly. No file is written to disk — the filename is
      // purely virtual.
      //
      // In CJS bundles (gateway npm package) and dev: use the emitted sibling
      // worker or the source tree's parent-level TypeScript worker.
      const workerSource = (globalThis as Record<string, unknown>)
        .__LORE_WORKER_SOURCE__ as string | undefined;
      const vendor = vendorModelInfo();
      const workerInitData: WorkerInitData = {
        modelId: this.modelId,
        dimensions: this.dimensions,
        // Only a fallback for a request that omits maxTokens (every embed()
        // carries one) — but size it to current free memory too, so even that
        // fallback path can't drive a native over-allocation.
        maxTokens: this.effectiveMaxTokens(),
        // Cgroup-CPU-aware native ORT intra-op cap, computed here on the main
        // thread (the worker can't value-import ort-native). undefined = no-op
        // (unconstrained host); applied on the native path only in the worker.
        intraOpThreads: nativeIntraOpThreads(),
        vendorModel: vendor ? { localModelPath: vendor.localModelPath } : null,
        // Snapshot the host's silence state — the worker's own `globalThis`
        // can't see the main thread's flag (re-read on every OOM respawn).
        stderrSilenced: log.isStderrSilenced(),
        // Force WASM once a native worker proved it couldn't parse the model
        // (#1379). Sticky across respawns so we don't bounce back to native.
        forceWasm: this.forceWasm,
      };

      let workerEntrypoint: string | URL;
      let workerOptions: EmbeddingWorkerSpawnOptions;
      if (workerSource !== undefined) {
        const path = await import("node:path");
        const os = await import("node:os");
        workerEntrypoint = workerSource;
        workerOptions = {
          eval: true,
          filename: path.join(os.homedir(), ".cache", "lore", "worker.cjs"),
          workerData: workerInitData,
          // Own both streams. Without these flags Node inherits parent stdio,
          // so worker console output bypasses parent-only JSON/report capture.
          stdout: true,
          stderr: true,
        };
      } else {
        // npm bundle / dev path: point at a sibling worker file.
        // CJS uses __filename (always defined); ESM uses import.meta.url.
        let workerUrl: string | URL;
        if (typeof __filename === "string") {
          const { pathToFileURL } = await import("node:url");
          // Match the sibling worker file extension to the current bundle:
          //   .ts  → dev (vitest/tsx)
          //   .cjs → gateway CJS npm bundle
          //   .js  → core ESM npm bundle (fallback)
          const workerExt = __filename.endsWith(".ts")
            ? ".ts"
            : __filename.endsWith(".cjs")
              ? ".cjs"
              : ".js";
          const workerPrefix = workerExt === ".ts" ? "../" : "./";
          workerUrl = new URL(
            `${workerPrefix}embedding-worker${workerExt}`,
            pathToFileURL(__filename),
          );
        } else {
          // ESM (Bun, tsx): resolve worker relative to this module's URL.
          // In CJS bundles the gateway build script (script/bundle.ts)
          // rewrites `import.meta.url` to an injected `import_meta_url`
          // shim — see packages/gateway/script/import-meta-url.js. This
          // branch is unreachable in CJS at runtime since __filename is
          // always defined there, but the shim keeps the source natural
          // and silences esbuild's `empty-import-meta` static warning.
          const selfUrl = import.meta.url;
          const workerPrefix = selfUrl.endsWith(".ts") ? "../" : "./";
          workerUrl = new URL(
            `${workerPrefix}embedding-worker${selfUrl.endsWith(".ts") ? ".ts" : ".js"}`,
            selfUrl,
          );
        }
        workerEntrypoint = workerUrl;
        workerOptions = {
          workerData: workerInitData,
          stdout: true,
          stderr: true,
        };
      }

      if (testWorkerFactory) {
        // Test seam (never set in production): deterministic fake workers can
        // inspect the exact options used by both file-backed and SEA branches.
        this.worker = testWorkerFactory(
          workerInitData,
          workerEntrypoint,
          workerOptions,
        );
      } else {
        this.worker = new Worker(workerEntrypoint, workerOptions);
      }

      // Attach flowing readers before any request is posted. The streams remain
      // owned and drained for the worker's whole lifetime, including init/OOM
      // diagnostics emitted before the first response or during shutdown.
      drainEmbeddingWorkerOutput(this.worker);

      // Don't let the worker prevent process exit.
      this.worker.unref();

      // Capture the worker THIS init spawned. Every event handler below is bound
      // to `spawned` and early-returns if `this.worker !== spawned` — a stale
      // worker's late events (e.g. the `exit(1)` that `terminate()` emits during
      // a WASM fallback respawn, #1379/#1387-B1) must never clobber the fresh
      // worker's state, reject its resubmitted requests, or latch the provider.
      const spawned = this.worker;

      // Wire up response handler.
      this.worker.on("message", (msg: WorkerOutbound) => {
        if (this.worker !== spawned) return; // superseded worker — ignore
        switch (msg.type) {
          case "started": {
            this.pendingRequests.get(msg.id)?.onExecutionStart?.();
            break;
          }
          case "result": {
            const pending = this.pendingRequests.get(msg.id);
            if (pending) {
              this.pendingRequests.delete(msg.id);
              this.updateWorkerRef();
              pending.resolve(msg.vectors);
            }
            break;
          }
          case "error": {
            const pending = this.pendingRequests.get(msg.id);
            if (pending) {
              this.pendingRequests.delete(msg.id);
              this.updateWorkerRef();
              // If the worker reports a WASM-fatal or OOM error, reject with
              // LocalProviderUnavailableError so callers (embed() → isAvailable)
              // treat the local provider as broken and degrade to FTS-only.
              // A generic Error would bypass that path, causing silent data loss.
              // Uses the same isWasmFatalError() from embedding-worker-types.ts
              // that the worker uses — single source of truth for classification.
              if (isWasmFatalError(msg.error)) {
                latchLocalProvider("terminal");
                pending.reject(new LocalProviderUnavailableError(msg.error));
              } else {
                pending.reject(new EmbeddingProviderError());
              }
            }
            break;
          }
          case "init-needs-wasm": {
            // The native ONNX backend loaded but couldn't parse an intact model
            // (#1379 — Bun ↔ onnxruntime-node). Respawn a FRESH worker forcing
            // WASM; the backend is committed per module-graph, so only a new
            // worker can switch. One-shot: if WASM ALSO reports this (shouldn't
            // happen — it means genuine corruption on both backends), fall
            // through to the init-error path so we don't loop respawns.
            if (!this.wasmFallbackTried) {
              this.wasmFallbackTried = true;
              this.forceWasm = true;
              this.workerReady = false;
              // Clear any transient init debt so the deliberate respawn isn't
              // fast-failed, mirroring the OOM backoff path.
              this.workerInitError = null;
              log.info(
                "native ONNX runtime could not load the embedding model " +
                  `(${msg.error}); retrying with the bundled WASM runtime`,
              );
              void this.respawnForWasm();
              break;
            }
            // Already tried WASM and it also failed — treat as a real init
            // failure (genuine corruption on both backends, or a non-Bun cause).
            this.handleInitError(msg.error);
            break;
          }
          case "init-error": {
            this.handleInitError(msg.error);
            break;
          }
        }
      });

      // Worker crash / exit — reject all in-flight requests. Keep an errored
      // worker owned until exit/shutdown so retirement can drain it completely.
      let workerErrorHandled = false;
      this.worker.prependOnceListener("error", () => {
        workerErrorHandled = true;
      });
      this.worker.on("error", (err: Error) => {
        if (this.worker !== spawned) return; // superseded worker — ignore
        if (this.closing) return;
        this.workerReady = false;
        this.initPromise = null;
        log.error("embedding worker crashed:", err);
        // Worker errors can be transient (runtime/model startup pressure), so
        // give them the same bounded cooldown/retry treatment as init-error.
        // Keep the worker handle until exit/shutdown so pool retirement can
        // drain it. The exit handler recognizes this already-classified error.
        this.handleInitError(err.message);
      });

      this.worker.on("exit", (code) => {
        if (this.worker !== spawned) return; // superseded worker — ignore
        this.workerReady = false;
        this.worker = null;
        this.initPromise = null;

        // Input-size-driven OOM: recover by respawning at a lower token cap on
        // a fresh WASM heap (an in-process retry can't — WASM memory never
        // shrinks), then re-submit the in-flight requests. Bounded: the cap
        // backs off ×0.7 down to MIN_EMBED_TOKENS, at which point we latch
        // FTS-only — so this can never loop unbounded (no event storm).
        if (code === EMBED_OOM_EXIT_CODE) {
          this.handleOomBackoff();
          return;
        }

        // Any other non-zero exit is a genuine fatal crash — latch the
        // provider broken so future ensureWorker() calls fast-fail instead of
        // respawning a worker that will just crash again (event-storm guard).
        if (code !== 0 && !workerErrorHandled && !this.closing) {
          if (!this.workerInitError) {
            this.workerInitError = `embedding worker exited with code ${code}`;
            log.error(this.workerInitError, new Error(this.workerInitError));
          }
          latchLocalProvider("terminal");
        }
        for (const [, p] of this.pendingRequests) {
          p.reject(
            new LocalProviderUnavailableError(
              this.workerInitError ?? "embedding worker exited",
            ),
          );
        }
        this.pendingRequests.clear();
        if (!this.closing) this.onUnavailable?.();
      });

      this.workerReady = true;
    })().catch((err) => {
      this.initPromise = null; // allow retry
      if (err instanceof LocalProviderUnavailableError) throw err;
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.handleInitError(errorMsg);
      throw new LocalProviderUnavailableError(errorMsg);
    });

    return this.initPromise;
  }

  private updateWorkerRef(): void {
    if (!this.worker) return;
    if (this.pendingRequests.size > 0) {
      this.worker.ref();
    } else {
      this.worker.unref();
    }
  }

  private maybeReprobeCap(): void {
    const now = Date.now();
    if (now - this.lastReprobeAt < EMBED_REPROBE_INTERVAL_MS) return;
    this.lastReprobeAt = now;
    const free = containerFreeBytes();
    if (!shouldReprobeEmbedCap(free, this.capFreememAtLearn)) return;
    // The re-probe ceiling is the memory model over this worker's pool SHARE of
    // free memory, so climbing back up never lets N workers sum past the host's
    // RAM. The ratio check above stays on undivided free (it only compares
    // now-vs-learn, both undivided).
    const next = reprobeEmbedCap(
      this.maxTokens,
      free / this.memDivisor,
      this.lastOomCap,
    );
    if (next <= this.maxTokens) return;
    const prev = this.maxTokens;
    this.maxTokens = next;
    this.capFreememAtLearn = free;
    persistEmbedCap(next, free, this.lastOomCap);
    log.info(
      `embedding cap re-probed up: ≤${prev} → ≤${next} tokens (free memory recovered)`,
    );
  }

  private pendingOomContext(): { batchSize: number; longestChars: number } {
    let batchSize = 0;
    let longestChars = 0;
    for (const [, p] of this.pendingRequests) {
      batchSize++;
      for (const t of p.payload.texts) {
        if (t.length > longestChars) longestChars = t.length;
      }
    }
    return { batchSize, longestChars };
  }

  private handleOomBackoff(): void {
    const capBefore = this.maxTokens;
    const { batchSize, longestChars } = this.pendingOomContext();

    if (capBefore <= MIN_EMBED_TOKENS) {
      // Already at the floor and still OOMing → the host genuinely can't run
      // local embeddings (system-wide exhaustion, not input size). Latch
      // FTS-only and surface the remote-provider hint.
      latchLocalProvider("terminal");
      if (!localEmbeddingState.errorLogged) {
        localEmbeddingState.errorLogged = true;
        log.error(
          `local embedding provider out of memory even at the ${MIN_EMBED_TOKENS}-token floor — ` +
            `degrading to FTS-only search. Set search.embeddings.provider to 'voyage' or 'openai' ` +
            `in .lore.json (with VOYAGE_API_KEY / OPENAI_API_KEY) for a remote provider.`,
          new Error("embedding OOM at floor"),
        );
      }
      fireEmbeddingFailure({
        kind: "floor-latch",
        capBefore,
        capAfter: capBefore,
        batchSize,
        longestChars,
      });
      for (const [, p] of this.pendingRequests) {
        p.reject(
          new LocalProviderUnavailableError(
            "embedding worker out of memory at the token floor",
          ),
        );
      }
      this.pendingRequests.clear();
      return;
    }

    const free = containerFreeBytes();
    const capAfter = backoffEmbedCap(capBefore);
    this.maxTokens = capAfter;
    // Remember the cap that just OOMed so the upward re-probe never climbs back
    // to or past it within this process (a rising freemem doesn't prove the
    // heap can grow that far).
    this.lastOomCap = Math.max(this.lastOomCap, capBefore);
    // Anchor the re-probe baseline at OOM-time free memory: only climb back up
    // once memory has genuinely recovered (≥ EMBED_REPROBE_RATIO × this).
    this.capFreememAtLearn = free;
    // Persist the known-bad cap alongside the backed-off cap so the NEXT process
    // start won't re-probe up to it even if the box reboots with more free RAM.
    persistEmbedCap(capAfter, free, this.lastOomCap);
    log.info(
      `embedding worker OOM at ≤${capBefore} tokens — backing off to ≤${capAfter} ` +
        `and respawning on a fresh heap (${batchSize} in-flight, longest≈${longestChars} chars)`,
    );
    fireEmbeddingFailure({
      kind: "oom-backoff",
      capBefore,
      capAfter,
      batchSize,
      longestChars,
    });

    // Clear any stale worker error so the deliberate respawn isn't fast-failed
    // by ensureWorker() (mirrors shutdown()). The OOM exit is recoverable — a
    // prior `error`/`init-error` could otherwise leave workerInitError set and
    // block recovery.
    this.workerInitError = null;

    // Respawn and re-submit. Fire-and-forget: ensureWorker()'s own handlers
    // reject pending if the respawn itself fails.
    void this.resubmitPending();
  }

  private async resubmitPending(): Promise<void> {
    if (this.pendingRequests.size === 0) return;
    try {
      await this.ensureWorker();
    } catch {
      // A *synchronous* respawn failure (e.g. `new Worker(...)` throws) rejects
      // initPromise before any worker event handler is attached, so nothing
      // else will ever settle these requests. Reject them here to avoid a hung
      // caller — the local embed path has no timeout. (Asynchronous spawn
      // failures are already settled by the worker error/exit/init-error
      // handlers, which clear the map, so this loop is then a no-op.)
      for (const [, p] of this.pendingRequests) {
        p.reject(
          new LocalProviderUnavailableError(
            "embedding worker respawn failed after OOM backoff",
          ),
        );
      }
      this.pendingRequests.clear();
      return;
    }
    const worker = this.worker;
    if (!worker) return; // raced with another exit — that handler owns pending
    for (const [, p] of this.pendingRequests) {
      // Re-submit at the lowered cap so the retry doesn't re-OOM at the old one,
      // further clamped to live free memory for this worker's pool share.
      p.payload.maxTokens = this.effectiveMaxTokens();
      try {
        worker.postMessage(p.payload satisfies WorkerInbound);
      } catch (error) {
        const errorMsg =
          error instanceof Error
            ? error.message
            : "embedding worker died during OOM resubmit";
        this.handleInitError(errorMsg);
        return;
      }
    }
    this.updateWorkerRef();
  }

  private handleInitError(errorMsg: string): void {
    this.workerInitError = errorMsg;
    this.workerReady = false;
    if (isMissingLocalStackError(errorMsg)) {
      // Optional local-embedding stack not installed (#1026 — an expected,
      // actionable degraded state that will NOT self-heal on its own). Latch
      // permanently; recall degrades to FTS-only. Flag it so the self-heal
      // re-probe skips it (a reinstall, not a retry, is what recovers this).
      latchLocalProvider("terminal");
      localStackMissing = true;
      if (!localEmbeddingState.errorLogged) {
        localEmbeddingState.errorLogged = true;
        log.warn(
          "local embedding dependencies not installed " +
            "(optional '@huggingface/transformers' / 'onnxruntime-node' absent) — " +
            "recall will use FTS-only search. Reinstall without --omit=optional to " +
            "enable local embeddings, or set search.embeddings.provider in .lore.json " +
            "to a remote provider (voyage/openai) with the matching API key.",
        );
      }
    } else {
      // A potentially transient failure (e.g. a model read that raced a
      // concurrent writer during a multi-instance restart, momentary memory
      // pressure). Retry a FRESH worker after a cooldown rather than disabling
      // local embeddings for the whole process lifetime; only give up (latch)
      // once the retry budget is exhausted.
      localEmbeddingState.initFailures++;
      localEmbeddingState.initFailureGeneration++;
      if (localEmbeddingState.initFailures >= LOCAL_INIT_MAX_ATTEMPTS) {
        latchLocalProvider("transient-init-exhausted");
        localEmbeddingState.initRetryAt = 0;
        if (!localEmbeddingState.errorLogged) {
          localEmbeddingState.errorLogged = true;
          log.error(
            `local embedding provider failed to init after ${localEmbeddingState.initFailures} attempts: ${errorMsg}. ` +
              `Set search.embeddings.provider in .lore.json to use a remote provider.`,
            new Error(`embedding worker init failed: ${errorMsg}`),
          );
        }
      } else {
        const retryDelayMs = computeInitRetryDelayMs(
          localEmbeddingState.initFailures,
          localInitCooldownMs,
        );
        localEmbeddingState.initRetryAt = Date.now() + retryDelayMs;
        log.warn(
          `local embedding init failed (attempt ${localEmbeddingState.initFailures}/${LOCAL_INIT_MAX_ATTEMPTS}): ${errorMsg}. ` +
            `Retrying with a fresh worker in ~${Math.round(retryDelayMs / 1000)}s; recall is FTS-only until then.`,
        );
      }
    }
    for (const [, p] of this.pendingRequests) {
      p.reject(new LocalProviderUnavailableError(errorMsg));
    }
    this.pendingRequests.clear();
    this.updateWorkerRef();
    this.onUnavailable?.();
  }

  private async respawnForWasm(): Promise<void> {
    const dead = this.worker;
    this.worker = null;
    this.initPromise = null;
    // Belt-and-suspenders: ensureWorker() early-returns when `workerReady` is
    // true, so it MUST be false here or the WASM worker would never spawn and
    // pending requests would be lost. The `init-needs-wasm` caller already
    // clears it, but re-clear locally so this invariant holds for any caller and
    // survives refactors (defense against the workerReady race Seer flagged).
    this.workerReady = false;
    if (dead) {
      // The fresh worker is independent, so fallback need not wait for a slow
      // native teardown. Keep owning the old generation, though: final process
      // shutdown must join it and must fail closed if Node cannot confirm exit.
      // NOTE: terminate() DOES emit an async `exit(1)` on the dead worker. That
      // event is harmless here only because each handler is bound to its own
      // `spawned` worker and early-returns when `this.worker` has moved on (see
      // ensureWorker) — otherwise the stale exit would latch the provider broken
      // and clobber the fresh WASM worker (#1387-B1).
      this.trackRetiredWorkerTermination(dead);
    }
    try {
      await this.ensureWorker();
    } catch {
      // Synchronous respawn failure — nothing else will settle these requests
      // (the local embed path has no timeout). Reject them here.
      for (const [, p] of this.pendingRequests) {
        p.reject(
          new LocalProviderUnavailableError(
            "embedding worker respawn failed after WASM fallback",
          ),
        );
      }
      this.pendingRequests.clear();
      return;
    }
    // Re-read through a cast: TS still has `this.worker` narrowed to null from
    // the `this.worker = null` above (it can't see that ensureWorker() reassigns
    // it across the await), so a direct read would be typed `never`.
    const worker = this.worker as import("node:worker_threads").Worker | null;
    if (worker == null) return; // raced with an exit — that handler owns pending
    for (const [, p] of this.pendingRequests) {
      p.payload.maxTokens = this.effectiveMaxTokens();
      try {
        worker.postMessage(p.payload satisfies WorkerInbound);
      } catch (error) {
        const errorMsg =
          error instanceof Error
            ? error.message
            : "embedding worker died during WASM resubmit";
        this.handleInitError(errorMsg);
        return;
      }
    }
    this.updateWorkerRef();
  }

  private trackRetiredWorkerTermination(worker: ShutdownableWorker): void {
    void this.retiredWorkers.retireOnce(worker, async () => {
      await worker.terminate();
    });
  }

  private async settleRetiredWorkers(timeoutMs: number): Promise<void> {
    await this.retiredWorkers.settle({
      timeoutMs,
      timeoutMessage:
        "retired embedding worker did not settle before shutdown deadline",
      failureMessage: "embedding worker termination was not confirmed",
    });
  }

  async embed(
    texts: string[],
    inputType: "document" | "query",
    signal?: AbortSignal,
    onExecutionStart?: () => void,
  ): Promise<Float32Array[]> {
    if (signal?.aborted) throw new EmbeddingRequestAbortedError();
    await this.ensureWorker();
    const worker = this.worker;
    if (this.closing || !worker) {
      throw new LocalProviderUnavailableError(
        "embedding worker closed during initialization",
      );
    }
    // Opportunistically raise the cap if free memory has recovered (cheap,
    // throttled). Takes effect via the per-request cap below — no respawn.
    this.maybeReprobeCap();

    // Pre-truncate texts that exceed the safe ONNX inference limit.
    // This prevents OOM on single inputs near the model's 8192-token max.
    const truncated = texts.map(safeLocalTruncate);

    // Prepend Nomic task instruction prefix.
    const prefix =
      inputType === "document" ? "search_document: " : "search_query: ";
    const prefixed = truncated.map((t) => prefix + t);

    const id = this.nextRequestId++;
    // Recall queries (single query-type texts) get high priority so they
    // jump ahead of any queued backfill batches in the worker.
    const priority = isRecallEmbed(texts, inputType) ? "high" : "normal";

    const payload: EmbedRequest = {
      type: "embed",
      id,
      texts: prefixed,
      inputType,
      priority,
      // Clamp to what CURRENT free memory allows for this worker's pool share,
      // not just the construction-time learned cap — free memory drops as
      // sibling workers and live sessions allocate, and a native over-allocation
      // is an uncatchable SIGKILL rather than a recoverable in-worker OOM.
      maxTokens: this.effectiveMaxTokens(),
    };

    return new Promise<Float32Array[]>((resolve, reject) => {
      let settled = false;
      const cleanup = (): void => {
        if (signal) signal.removeEventListener("abort", onAbort);
      };
      const resolveRequest = (vectors: Float32Array[]): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(vectors);
      };
      const rejectRequest = (error: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const onAbort = (): void => {
        if (!this.pendingRequests.delete(id)) return;
        this.updateWorkerRef();
        rejectRequest(new EmbeddingRequestAbortedError());
      };
      this.pendingRequests.set(id, {
        resolve: resolveRequest,
        reject: rejectRequest,
        payload,
        onExecutionStart,
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      this.updateWorkerRef();
      try {
        worker.postMessage(payload satisfies WorkerInbound);
      } catch {
        // Worker may have been terminated between ensureWorker() and here
        // (race with process.exit(1) in the worker thread). Clean up and
        // reject with the expected error type so callers degrade gracefully.
        this.handleInitError(
          "embedding worker terminated before request could be sent",
        );
      }
    });
  }

  shutdown(timeoutMs = WORKER_SHUTDOWN_TIMEOUT_MS): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.closing = true;
    this.workerReady = false;
    this.workerInitError = null;

    // Reject any in-flight requests with LocalProviderUnavailableError so
    // fire-and-forget callers' catch blocks handle it the same way as other
    // provider failures (graceful degradation, no Sentry noise).
    for (const [, p] of this.pendingRequests) {
      p.reject(new LocalProviderUnavailableError("embedding worker shut down"));
    }
    this.pendingRequests.clear();

    const init = this.initPromise;
    this.shutdownPromise = (async () => {
      await init?.catch(() => {});
      const worker = this.worker;
      this.worker = null;
      this.initPromise = null;
      const outcomes = await Promise.allSettled([
        (async () => {
          if (!worker) return;
          // Don't let a mid-backfill ref keep the event loop alive while we wait
          // for the worker to exit.
          worker.unref();
          await awaitWorkerShutdown(worker, timeoutMs);
        })(),
        this.settleRetiredWorkers(timeoutMs),
      ]);
      const failures = outcomes.flatMap((outcome) =>
        outcome.status === "rejected" ? [outcome.reason] : [],
      );
      if (failures.length > 0) {
        if (failures.length === 1) throw failures[0];
        throw new AggregateError(
          failures,
          "embedding worker termination was not confirmed",
        );
      }
    })();
    return this.shutdownPromise;
  }
}
