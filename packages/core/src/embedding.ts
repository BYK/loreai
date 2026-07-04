/**
 * Embedding integration for vector search.
 *
 * Supports multiple embedding providers behind a common interface:
 *   - "local" (default): @huggingface/transformers + nomic-embed-text-v1.5
 *     (768 dims, Matryoshka-capable). Runs ONNX inference in a worker thread.
 *   - "voyage": Voyage AI API (voyage-code-3, 1024 dims)
 *   - "openai": OpenAI API (text-embedding-3-small, 1536 dims)
 *
 * Provides embedding generation, pure-JS cosine similarity, and vector search
 * over the knowledge and distillation tables. All operations are gated behind
 * `search.embeddings.enabled` config + the provider's API key env var — falls
 * back silently to FTS-only when unavailable.
 */

import { freemem } from "node:os";
import { performance } from "node:perf_hooks";
import { db, getKV, setKV } from "./db";
import { isVecAvailable } from "./db/vec";
import {
  clearAllEmbeddings,
  copyBlobsToVec0,
  dropEmbeddingColumn,
  type EmbeddingTable,
  embeddingColumnExists,
  ensureVec0Store,
  gcVec0DanglingRows,
  hasEmbeddingSql,
  missingEmbeddingSql,
  readStorageMode,
  resolveReadMode,
  setStorageMode,
  storeEmbedding,
  storeTemporalChunks,
} from "./db/vec-store";
import { config } from "./config";
import * as log from "./log";
import { recordVecReadLatency } from "./vec-latency";
import { buildEmbeddingText, buildEmbeddingUnits } from "./embedding-units";
import { vendorModelInfo } from "./embedding-vendor";
import { nativeIntraOpThreads } from "./ort-native";
import {
  MIN_EMBED_TOKENS,
  MODEL_MAX_TOKENS,
  PER_WORKER_MEM_BUDGET_BYTES,
  EMBED_POOL_ABS_MAX,
  backoffEmbedCap,
  clampFreeToContainerLimit,
  desiredEmbedPoolSize,
  memoryModelEmbedCap,
  reconcileEmbedCap,
  reprobeEmbedCap,
  shouldReprobeEmbedCap,
  type PersistedEmbedCap,
} from "./embedding-cap";
import {
  EMBED_OOM_EXIT_CODE,
  isMissingLocalStackError,
  isWasmFatalError,
  type EmbedRequest,
  type WorkerInbound,
  type WorkerOutbound,
  type WorkerInitData,
} from "./embedding-worker-types";
import {
  runVectorQuery,
  type DistillationVectorHit,
  type VectorHit,
  type VectorQuerySpec,
} from "./vector-query";
import { tryPoolVectorSearch, VECTOR_SEARCH_TIMED_OUT } from "./vector-pool";

// The cosine/BLOB helpers moved to ./vector-query (a leaf module the read
// worker can import without pulling in the provider chain). Re-exported here so
// existing `embedding.toBlob` / `embedding.cosineSimilarity` / `embedding.fromBlob`
// call sites across the codebase keep working unchanged.
export {
  cosineSimilarity,
  fromBlob,
  toBlob,
  type DistillationVectorHit,
  type VectorHit,
} from "./vector-query";

/** Timeout for embedding API fetch calls (ms). Prevents a hanging API from
 *  blocking the recall tool indefinitely. 10s is generous for typical 100-500ms
 *  embedding calls but bounded enough to avoid minutes-long hangs. */
const EMBED_TIMEOUT_MS = 10_000;

/** Max time to wait for the worker to exit cooperatively on shutdown before
 *  force-terminating it. The worker drops queued work immediately but must
 *  finish any in-flight, uninterruptible single-threaded ONNX inference batch
 *  before it can exit — without this cap that could block process exit. */
const WORKER_SHUTDOWN_TIMEOUT_MS = 1_500;

// ---------------------------------------------------------------------------
// Adaptive local-embedding token cap — persistence
// ---------------------------------------------------------------------------
// Pure cap math (memory model, clamp, backoff, reconcile) lives in
// embedding-cap.ts so it can be unit-tested in isolation. Here we keep only the
// db-backed persistence and the worker-lifecycle glue.

/** kv_meta key for the persisted learned cap + the free memory at learn time. */
const EMBED_CAP_KV_KEY = "lore:embedding_cap";

/** Minimum interval between upward cap re-probe checks. Throttles the freemem
 *  read + comparison so embed() stays cheap; the cap only needs to be right
 *  when work is actively flowing, so checking on embed() is sufficient. */
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

/** Test seam: override `process.constrainedMemory()` for container-aware sizing
 *  tests (null → use the real value). */
let testConstrainedMemoryBytes: number | null = null;
export function _setConstrainedMemoryForTest(bytes: number | null): void {
  testConstrainedMemoryBytes = bytes;
}

/** The process's cgroup memory LIMIT in bytes (not free-within-limit), or `0` if
 *  unconstrained / unknown / unsupported by the runtime. `process.constrainedMemory()`
 *  is libuv-backed (cgroup v1 + v2, no hard-coded paths) and returns `0` when
 *  unconstrained; it is present in both Node (≥18.15) and Bun. Read live: it's
 *  cheap and the consuming paths are cap init/re-probe (infrequent) plus the pool
 *  growth gate (only while all workers are busy and below the ceiling — never in
 *  the single-worker or at-ceiling steady state). */
function constrainedMemoryLimit(): number {
  if (testConstrainedMemoryBytes != null) return testConstrainedMemoryBytes;
  const fn = (process as { constrainedMemory?: () => number })
    .constrainedMemory;
  const v = typeof fn === "function" ? fn() : 0;
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/** Container-aware live free memory: `os.freemem()` clamped to the cgroup memory
 *  limit ({@link clampFreeToContainerLimit}) so no sizing decision trusts
 *  host-level free memory inside a memory-capped container. A no-op (returns
 *  `freemem()` unchanged) when unconstrained or when the container limit exceeds
 *  host-reported free — so behavior on non-containerized / roomy hosts is
 *  identical to the pre-cgroup path. Use this for every memory-SIZING read;
 *  telemetry keeps raw `freemem()` so host vs container stays diagnosable.
 *
 *  Note the clamp uses the cgroup LIMIT, not free-within-limit: `min(hostFree,
 *  limit)` can slightly overestimate available memory in a mid-size container
 *  already using part of its budget, but that's deliberate — it's strictly ≤ the
 *  pre-fix host figure, and the per-worker budget already reserves the transient
 *  attention peak as headroom. Using cgroup free (`availableMemory()`) instead
 *  would break the no-op guarantee on constrained-but-roomy hosts. */
function containerFreeBytes(): number {
  return clampFreeToContainerLimit(freemem(), constrainedMemoryLimit());
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

/**
 * Compute the token cap to (re)start a worker with. Prefers a learned,
 * persisted cap when current free memory is close to what it was learned at —
 * this avoids re-walking the backoff on every process restart (the "recurs on
 * every restart" failure). Otherwise it sizes from the memory model and
 * current free memory; a materially larger free pool lets the cap re-probe
 * upward on restart (in lieu of continuous additive increase). Always clamped.
 */
function computeInitialEmbedCap(
  persisted: PersistedEmbedCap | null = readPersistedEmbedCap(),
): number {
  const free = containerFreeBytes();
  return reconcileEmbedCap(
    free,
    persisted,
    memoryModelEmbedCap(free),
    persisted?.knownBadCap ?? 0,
  );
}

/**
 * For tests: persist a learned embedding cap (kv_meta round-trip).
 *
 * `freeMemBytes` defaults to the live `freemem()`. Tests that need a
 * deterministic start cap pass `0`: `reconcileEmbedCap` treats a non-positive
 * learn-time baseline as ratio = 1, so the persisted cap is always trusted
 * as-is — independent of how much free memory the host happens to have. Without
 * this, a host whose free memory swings >25% between persist and provider
 * construction (e.g. a CI box running the full suite in parallel) reconciles to
 * the freemem-derived model cap instead, making the start cap non-deterministic.
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

/**
 * Coarse per-text character bound applied before a text is cloned across the
 * worker boundary — only a payload-size guard. The real, memory-aware token
 * cap is applied inside the worker (`WorkerInitData.maxTokens`). Sized at the
 * model's max sequence length so it never caps below what a healthy host could
 * embed.
 */
const LOCAL_MAX_CHARS = MODEL_MAX_TOKENS * 4; // ~8192 tokens × ~4 chars/token

/**
 * Truncate a string to LOCAL_MAX_CHARS without splitting a UTF-16 surrogate pair.
 * If the cut falls on a high surrogate (0xD800-0xDBFF), backs up one char.
 */
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

/** Context for an embedding-worker memory failure, surfaced to an optional host
 *  telemetry hook. @loreai/core stays Sentry-free; the gateway wires this up. */
export interface EmbeddingFailureInfo {
  /** "oom-backoff" = recovered by lowering the cap + respawning;
   *  "floor-latch" = hit MIN_EMBED_TOKENS and degraded to FTS-only. */
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

/** Register a host telemetry hook fired on embedding-worker OOM backoff/latch.
 *  Pass null to clear. The hook must not throw; errors are swallowed. */
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

// ---------------------------------------------------------------------------
// Provider interface
// ---------------------------------------------------------------------------

export interface EmbeddingProvider {
  embed(
    texts: string[],
    inputType: "document" | "query",
  ): Promise<Float32Array[]>;
  readonly maxBatchSize: number;
}

// ---------------------------------------------------------------------------
// Voyage AI provider
// ---------------------------------------------------------------------------

const VOYAGE_API_URL = "https://api.voyageai.com/v1/embeddings";

type VoyageResponse = {
  data: Array<{ embedding: number[]; index: number }>;
  model: string;
  usage: { total_tokens: number };
};

class VoyageProvider implements EmbeddingProvider {
  readonly maxBatchSize = 128;
  private apiKey: string;
  private model: string;
  private dimensions: number;

  constructor(apiKey: string, model: string, dimensions: number) {
    this.apiKey = apiKey;
    this.model = model;
    this.dimensions = dimensions;
  }

  async embed(
    texts: string[],
    inputType: "document" | "query",
  ): Promise<Float32Array[]> {
    const res = await fetch(VOYAGE_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        input: texts,
        model: this.model,
        input_type: inputType,
        output_dimension: this.dimensions,
      }),
      signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Voyage API ${res.status}: ${body}`);
    }

    const json = (await res.json()) as VoyageResponse;
    const sorted = [...json.data].sort((a, b) => a.index - b.index);
    return sorted.map((d) => new Float32Array(d.embedding));
  }
}

// ---------------------------------------------------------------------------
// OpenAI provider
// ---------------------------------------------------------------------------

const OPENAI_API_URL = "https://api.openai.com/v1/embeddings";

type OpenAIResponse = {
  data: Array<{ embedding: number[]; index: number }>;
  model: string;
  usage: { prompt_tokens: number; total_tokens: number };
};

class OpenAIProvider implements EmbeddingProvider {
  readonly maxBatchSize = 2048;
  private apiKey: string;
  private model: string;
  private dimensions: number;

  constructor(apiKey: string, model: string, dimensions: number) {
    this.apiKey = apiKey;
    this.model = model;
    this.dimensions = dimensions;
  }

  async embed(
    texts: string[],
    _inputType: "document" | "query",
  ): Promise<Float32Array[]> {
    const body: Record<string, unknown> = {
      input: texts,
      model: this.model,
    };
    // OpenAI supports dimensions parameter for text-embedding-3-* models
    if (this.model.startsWith("text-embedding-3")) {
      body.dimensions = this.dimensions;
    }

    const res = await fetch(OPENAI_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
    });

    if (!res.ok) {
      const responseBody = await res.text().catch(() => "");
      throw new Error(`OpenAI API ${res.status}: ${responseBody}`);
    }

    const json = (await res.json()) as OpenAIResponse;
    const sorted = [...json.data].sort((a, b) => a.index - b.index);
    return sorted.map((d) => new Float32Array(d.embedding));
  }
}

// ---------------------------------------------------------------------------
// Local provider (@huggingface/transformers + nomic-embed-text-v1.5)
// ---------------------------------------------------------------------------

/**
 * Thrown when `LocalProvider` cannot initialize (e.g. ONNX runtime fails
 * to load). Callers in `recall.ts` / `ltm.ts` / `distillation.ts` gate
 * on `isAvailable()`, which flips to `false` after this error fires once.
 */
export class LocalProviderUnavailableError extends Error {
  constructor(cause?: unknown) {
    super(
      "Local embedding provider unavailable: '@huggingface/transformers' failed to initialize. " +
        "Recall will use FTS-only search. To use a remote provider instead, set " +
        "search.embeddings.provider to 'voyage' or 'openai' in .lore.json " +
        "and provide the corresponding API key (VOYAGE_API_KEY / OPENAI_API_KEY).",
    );
    this.name = "LocalProviderUnavailableError";
    if (cause !== undefined)
      (this as Error & { cause?: unknown }).cause = cause;
  }
}

/** PERMANENT break: the local provider is disabled for the rest of the process
 *  lifetime (recall degrades to FTS-only). Set only for a non-self-healing cause
 *  — the optional embedding stack is absent, a WASM-fatal abort, a floor OOM, or
 *  the transient-init-retry budget below being exhausted. */
let localProviderKnownBroken = false;
let localProviderErrorLogged = false;

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
let localInitFailures = 0;
/** Epoch ms; `> 0` means "cooling down after a transient init failure — retry a
 *  fresh worker once `Date.now()` reaches it". Reset to 0 on retry/recovery. */
let localInitRetryAt = 0;
let localInitCooldownMs = 30_000;

/** Test seam: shorten the init-retry cooldown so the retry path is drivable
 *  without real time (`0` → the next availability check retries immediately;
 *  `null` restores the production default). */
export function _setLocalInitCooldownMsForTest(ms: number | null): void {
  localInitCooldownMs = ms ?? 30_000;
}

/** For tests: reset the local provider probe + transient-retry state. */
export function _resetLocalProviderProbe(): void {
  localProviderKnownBroken = false;
  localProviderErrorLogged = false;
  localInitFailures = 0;
  localInitRetryAt = 0;
}

/** For tests: simulate the local provider being unavailable, without
 *  actually spawning a worker. After this call, `isAvailable()` returns
 *  false for the local provider. */
export function _markLocalProviderUnavailable(): void {
  localProviderKnownBroken = true;
  localProviderErrorLogged = true; // suppress the info log in tests
}

/** Test seam: when set, `ensureWorker()` uses this factory instead of spawning
 *  a real `node:worker_threads` Worker, so the OOM-recovery lifecycle (exit-75
 *  backoff → respawn → re-submit, floor latch, synchronous respawn failure) can
 *  be driven deterministically. Never set in production. */
let testWorkerFactory:
  | ((data: WorkerInitData) => import("node:worker_threads").Worker)
  | null = null;

/** For tests: install the worker factory seam above (null clears it). */
export function _setTestWorkerFactory(
  factory:
    | ((data: WorkerInitData) => import("node:worker_threads").Worker)
    | null,
): void {
  testWorkerFactory = factory;
}

/** True iff the local provider has been probed and found broken. */
function localProviderKnownUnavailable(): boolean {
  return localProviderKnownBroken;
}

/**
 * Local embedding provider using @huggingface/transformers with
 * nomic-embed-text-v1.5 by default.
 *
 * No API key required — runs entirely on-device via ONNX Runtime.
 * Model files are downloaded on first use (~137MB for INT8 quantized)
 * and cached locally. Subsequent inits load from cache.
 *
 * ONNX inference runs in a dedicated `node:worker_threads` Worker so the
 * main thread's event loop stays free. This class is a thin RPC client —
 * it posts `{ texts, inputType }` to the worker and awaits a reply.
 * The worker owns the transformers.js pipeline and processes requests
 * sequentially from a priority queue (recall queries jump ahead of
 * backfill batches).
 *
 * Task instruction prefixes are prepended automatically:
 *   - "document" → "search_document: <text>"
 *   - "query"    → "search_query: <text>"
 */
class LocalProvider implements EmbeddingProvider {
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
      /** Original request payload, retained so it can be re-submitted to a
       *  freshly respawned worker after an OOM backoff (fresh WASM heap). */
      payload: EmbedRequest;
    }
  >();
  private nextRequestId = 0;
  private initPromise: Promise<void> | null = null;
  private modelId: string;
  private dimensions: number;
  /** Memory-aware input token cap, owned by the main thread and passed to the
   *  worker via workerData. Lowered ×0.7 per OOM respawn; persisted so restarts
   *  start at the learned value instead of re-walking the backoff. */
  private maxTokens: number;
  /** Free memory (bytes) when `maxTokens` was last (re)learned. The upward
   *  re-probe only fires when current free memory exceeds this by
   *  EMBED_REPROBE_RATIO — i.e. when memory has genuinely recovered, which
   *  distinguishes transient starvation from a real hardware limit. */
  private capFreememAtLearn: number;
  /** Timestamp (ms) of the last upward re-probe check, for throttling. */
  private lastReprobeAt = 0;
  /** Highest cap (tokens) that has OOMed in this process, or 0 if none. The
   *  upward re-probe never climbs to or past it — a rising os.freemem() does not
   *  prove the WASM heap can grow that far. Cleared only by a process restart. */
  private lastOomCap = 0;

  constructor(modelId: string, dimensions: number) {
    this.modelId = modelId;
    this.dimensions = dimensions;
    // Seed lastOomCap from the persisted known-bad cap so an upward re-probe in
    // THIS process still respects a ceiling the WASM heap rejected in a PRIOR
    // one (a rising freemem doesn't prove the fixed heap grew). Read once and
    // reuse for the initial cap to avoid a second kv_meta round-trip.
    const persisted = readPersistedEmbedCap();
    this.lastOomCap = persisted?.knownBadCap ?? 0;
    this.maxTokens = computeInitialEmbedCap(persisted);
    this.capFreememAtLearn = containerFreeBytes();
  }

  /**
   * Ensure the worker thread is running. Worker startup failure is
   * surfaced as `LocalProviderUnavailableError` to mark the provider as
   * broken and degrade to FTS-only search.
   */
  private async ensureWorker(): Promise<void> {
    if (this.workerReady) return;
    if (this.workerInitError)
      throw new LocalProviderUnavailableError(this.workerInitError);
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      // Fast-fail if a previous attempt already marked local broken.
      if (localProviderKnownBroken) throw new LocalProviderUnavailableError();

      const { Worker } = await import("node:worker_threads");

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
      // In CJS bundles (gateway npm package) and dev: use the sibling
      // embedding-worker.{cjs,js,ts} file as the worker entrypoint.
      const workerSource = (globalThis as Record<string, unknown>)
        .__LORE_WORKER_SOURCE__ as string | undefined;
      const vendor = vendorModelInfo();
      const workerInitData: WorkerInitData = {
        modelId: this.modelId,
        dimensions: this.dimensions,
        maxTokens: this.maxTokens,
        // Cgroup-CPU-aware native ORT intra-op cap, computed here on the main
        // thread (the worker can't value-import ort-native). undefined = no-op
        // (unconstrained host); applied on the native path only in the worker.
        intraOpThreads: nativeIntraOpThreads(),
        vendorModel: vendor ? { localModelPath: vendor.localModelPath } : null,
        // Snapshot the host's silence state — the worker's own `globalThis`
        // can't see the main thread's flag (re-read on every OOM respawn).
        stderrSilenced: log.isStderrSilenced(),
      };

      if (testWorkerFactory) {
        // Test seam (never set in production): a deterministic fake worker so
        // the OOM-recovery lifecycle can be exercised without a real runtime.
        this.worker = testWorkerFactory(workerInitData);
      } else if (workerSource !== undefined) {
        const { join } = await import("node:path");
        const { homedir } = await import("node:os");
        const opts: Record<string, unknown> = {
          eval: true,
          filename: join(homedir(), ".cache", "lore", "worker.cjs"),
          workerData: workerInitData,
        };
        this.worker = new Worker(workerSource, opts);
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
          workerUrl = new URL(
            `./embedding-worker${workerExt}`,
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
          workerUrl = new URL(
            `./embedding-worker${selfUrl.endsWith(".ts") ? ".ts" : ".js"}`,
            selfUrl,
          );
        }
        this.worker = new Worker(workerUrl, {
          workerData: workerInitData,
        });
      }

      // Don't let the worker prevent process exit.
      this.worker.unref();

      // Wire up response handler.
      this.worker.on("message", (msg: WorkerOutbound) => {
        switch (msg.type) {
          case "result": {
            const pending = this.pendingRequests.get(msg.id);
            if (pending) {
              this.pendingRequests.delete(msg.id);
              this.updateWorkerRef();
              // A successful embed means init succeeded — clear any transient
              // init-failure debt so a future one-off blip gets the full retry
              // budget again (and re-enables the one-time failure log).
              if (localInitFailures > 0 || localInitRetryAt > 0) {
                log.info(
                  `local embedding provider recovered after ${localInitFailures} failed init attempt(s)`,
                );
                localInitFailures = 0;
                localInitRetryAt = 0;
                localProviderErrorLogged = false;
              }
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
                localProviderKnownBroken = true;
                pending.reject(new LocalProviderUnavailableError(msg.error));
              } else {
                pending.reject(
                  new Error(`Worker embedding failed: ${msg.error}`),
                );
              }
            }
            break;
          }
          case "init-error": {
            // Model init failed inside the worker — surface as
            // LocalProviderUnavailableError on all pending + future requests.
            this.workerInitError = msg.error;
            this.workerReady = false;
            if (isMissingLocalStackError(msg.error)) {
              // Optional local-embedding stack not installed (#1026 — an
              // expected, actionable degraded state that will NOT self-heal on
              // its own). Latch permanently; recall degrades to FTS-only.
              localProviderKnownBroken = true;
              if (!localProviderErrorLogged) {
                localProviderErrorLogged = true;
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
              // concurrent writer during a multi-instance restart, momentary
              // memory pressure). Retry a FRESH worker after a cooldown rather
              // than disabling local embeddings for the whole process lifetime;
              // only give up (latch) once the retry budget is exhausted.
              localInitFailures++;
              if (localInitFailures >= LOCAL_INIT_MAX_ATTEMPTS) {
                localProviderKnownBroken = true;
                localInitRetryAt = 0;
                if (!localProviderErrorLogged) {
                  localProviderErrorLogged = true;
                  log.error(
                    `local embedding provider failed to init after ${localInitFailures} attempts: ${msg.error}. ` +
                      `Set search.embeddings.provider in .lore.json to use a remote provider.`,
                    new Error(`embedding worker init failed: ${msg.error}`),
                  );
                }
              } else {
                localInitRetryAt = Date.now() + localInitCooldownMs;
                log.warn(
                  `local embedding init failed (attempt ${localInitFailures}/${LOCAL_INIT_MAX_ATTEMPTS}): ${msg.error}. ` +
                    `Retrying with a fresh worker after a cooldown; recall is FTS-only until then.`,
                );
              }
            }
            for (const [, p] of this.pendingRequests) {
              p.reject(new LocalProviderUnavailableError(msg.error));
            }
            this.pendingRequests.clear();
            this.updateWorkerRef();
            break;
          }
        }
      });

      // Worker crash / exit — reject all in-flight requests.
      // Null out `this.worker` in both handlers so the `?.` optional chaining
      // in embed() prevents postMessage on a terminated Worker (LOREAI-GATEWAY-1T).
      this.worker.on("error", (err: Error) => {
        this.workerInitError = err.message;
        this.workerReady = false;
        this.worker = null;
        this.initPromise = null;
        log.error("embedding worker crashed:", err);
        for (const [, p] of this.pendingRequests) {
          p.reject(new LocalProviderUnavailableError(err));
        }
        this.pendingRequests.clear();
      });

      this.worker.on("exit", (code) => {
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
        if (code !== 0) {
          if (!this.workerInitError) {
            this.workerInitError = `embedding worker exited with code ${code}`;
            log.error(this.workerInitError, new Error(this.workerInitError));
          }
          localProviderKnownBroken = true;
        }
        for (const [, p] of this.pendingRequests) {
          p.reject(
            new LocalProviderUnavailableError(
              this.workerInitError ?? "embedding worker exited",
            ),
          );
        }
        this.pendingRequests.clear();
      });

      this.workerReady = true;
    })().catch((err) => {
      this.initPromise = null; // allow retry
      throw err;
    });

    return this.initPromise;
  }

  /** Keep the worker ref'd while requests are in flight so the event loop
   *  doesn't exit before responses arrive. When the pending map drains,
   *  unref again so the worker doesn't prevent graceful process exit. */
  private updateWorkerRef(): void {
    if (!this.worker) return;
    if (this.pendingRequests.size > 0) {
      this.worker.ref();
    } else {
      this.worker.unref();
    }
  }

  /** Throttled upward re-probe: when free memory has recovered past
   *  EMBED_REPROBE_RATIO × the level at which the current cap was learned, step
   *  the cap up one notch (bounded by the memory model for the now-larger pool)
   *  and persist. Applied via the per-request cap, so it takes effect on the
   *  next request without respawning the worker. An optimistic step is
   *  corrected by the OOM backoff. */
  private maybeReprobeCap(): void {
    const now = Date.now();
    if (now - this.lastReprobeAt < EMBED_REPROBE_INTERVAL_MS) return;
    this.lastReprobeAt = now;
    const free = containerFreeBytes();
    if (!shouldReprobeEmbedCap(free, this.capFreememAtLearn)) return;
    const next = reprobeEmbedCap(this.maxTokens, free, this.lastOomCap);
    if (next <= this.maxTokens) return;
    const prev = this.maxTokens;
    this.maxTokens = next;
    this.capFreememAtLearn = free;
    persistEmbedCap(next, free, this.lastOomCap);
    log.info(
      `embedding cap re-probed up: ≤${prev} → ≤${next} tokens (free memory recovered)`,
    );
  }

  /** Aggregate OOM context across in-flight requests for telemetry. We don't
   *  know which request OOMed (the worker exits without posting), so report the
   *  worst-case longest text and the in-flight count. */
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

  /**
   * Handle an OOM-signalled worker exit: lower the token cap ×0.7, persist it,
   * and respawn (fresh heap) to re-run the in-flight requests. At the floor we
   * give up and latch FTS-only. The worker is already nulled by the exit
   * handler before this runs.
   */
  private handleOomBackoff(): void {
    const capBefore = this.maxTokens;
    const { batchSize, longestChars } = this.pendingOomContext();

    if (capBefore <= MIN_EMBED_TOKENS) {
      // Already at the floor and still OOMing → the host genuinely can't run
      // local embeddings (system-wide exhaustion, not input size). Latch
      // FTS-only and surface the remote-provider hint.
      localProviderKnownBroken = true;
      if (!localProviderErrorLogged) {
        localProviderErrorLogged = true;
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

  /** Respawn the worker (at the already-lowered cap) and re-post every
   *  in-flight request so the OOM backoff is transparent to callers. */
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
      // Re-submit at the lowered cap so the retry doesn't re-OOM at the old one.
      p.payload.maxTokens = this.maxTokens;
      try {
        worker.postMessage(p.payload satisfies WorkerInbound);
      } catch {
        // Worker died again between ensureWorker() and here — its exit handler
        // drives the next backoff/latch. Leave pending in place.
      }
    }
    this.updateWorkerRef();
  }

  async embed(
    texts: string[],
    inputType: "document" | "query",
  ): Promise<Float32Array[]> {
    await this.ensureWorker();
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
      maxTokens: this.maxTokens,
    };

    return new Promise<Float32Array[]>((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject, payload });
      this.updateWorkerRef();
      try {
        this.worker?.postMessage(payload satisfies WorkerInbound);
      } catch {
        // Worker may have been terminated between ensureWorker() and here
        // (race with process.exit(1) in the worker thread). Clean up and
        // reject with the expected error type so callers degrade gracefully.
        this.pendingRequests.delete(id);
        this.updateWorkerRef();
        reject(
          new LocalProviderUnavailableError(
            "embedding worker terminated before request could be sent",
          ),
        );
      }
    });
  }

  /** Shut down the worker thread. Called by `resetProvider()` on config change.
   *  Sends a shutdown message so the worker drains in-flight work and exits
   *  via a deferred `process.exit(0)` (lets NAPI callbacks unwind safely).
   *
   *  Returns a promise that resolves once the worker has fully exited. Callers
   *  that need a clean teardown (tests, config change) should await the result.
   *  Fire-and-forget callers (process exit) can ignore it. */
  shutdown(): Promise<void> {
    if (!this.worker) return Promise.resolve();

    const worker = this.worker;
    this.worker = null;
    this.workerReady = false;
    this.workerInitError = null;
    this.initPromise = null;
    // Don't let a mid-backfill ref keep the event loop alive while we wait for
    // the worker to exit.
    worker.unref();

    // Reject any in-flight requests with LocalProviderUnavailableError so
    // fire-and-forget callers' catch blocks handle it the same way as other
    // provider failures (graceful degradation, no Sentry noise).
    for (const [, p] of this.pendingRequests) {
      p.reject(new LocalProviderUnavailableError("embedding worker shut down"));
    }
    this.pendingRequests.clear();

    return awaitWorkerShutdown(worker, WORKER_SHUTDOWN_TIMEOUT_MS);
  }
}

// ---------------------------------------------------------------------------
// Local embedding worker pool (#999)
// ---------------------------------------------------------------------------

/** Resolve the configured embedding-pool ceiling: `LORE_EMBED_POOL_SIZE` wins
 *  (the escape hatch — `=1` forces today's single worker), then
 *  `search.embeddings.embedPoolSize`, else `undefined` (memory-gated default).
 *  Read per-construction (not cached) so config reloads / env changes take
 *  effect on the next provider. Invalid values are ignored (fall through). */
function configuredEmbedPoolSize(): number | undefined {
  const raw = process.env.LORE_EMBED_POOL_SIZE;
  if (raw !== undefined) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 1) return Math.floor(n);
    // invalid env → ignore, fall through to config
  }
  const cfg = config().search.embeddings.embedPoolSize;
  if (typeof cfg === "number" && Number.isFinite(cfg) && cfg >= 1) {
    return Math.floor(cfg);
  }
  return undefined;
}

/** Test seam: exposes {@link configuredEmbedPoolSize} so suites can assert the
 *  env/config resolution + invalid-value fall-through (invalid env must resolve
 *  to `undefined`, never `NaN`) without spinning up a pool. */
export function _configuredEmbedPoolSize(): number | undefined {
  return configuredEmbedPoolSize();
}

/** Test-only override of the embedding-pool ceiling (null clears). Sets the
 *  construction-time ceiling directly, bypassing the freemem-based sizing so
 *  suites don't depend on the host's actual RAM. */
let testEmbedPoolSize: number | null = null;
export function _setEmbedPoolSizeForTest(n: number | null): void {
  testEmbedPoolSize = n;
}

/** Test-only override for the pool's LIVE per-spawn memory gate (null → real
 *  `os.freemem()`). Lets suites drive the "grow when memory allows" vs "stay at
 *  one worker when memory is tight" paths deterministically. */
let testPoolFreememBytes: number | null = null;
export function _setPoolFreememForTest(bytes: number | null): void {
  testPoolFreememBytes = bytes;
}

/** One worker slot: a {@link LocalProvider} and the number of embed requests the
 *  pool currently has in flight against it. The pool is the sole caller of each
 *  provider's `embed()`, so it tracks in-flight itself — no LocalProvider surface
 *  change. `inflight` stays accurate across a provider's OOM respawn because the
 *  original `embed()` promise stays pending until the resubmit finally settles. */
interface EmbedSlot {
  provider: LocalProvider;
  inflight: number;
}

/**
 * A pool of {@link LocalProvider} workers so concurrent embeds run in parallel
 * instead of serializing through a single worker (#999). Mirrors
 * `vector-pool.ts`, but over the stateful embedding provider rather than raw
 * workers — each LocalProvider keeps its full, tested per-worker lifecycle (OOM
 * ×0.7 backoff + respawn + resubmit, corrupt-model self-heal, WASM-fatal latch,
 * cap re-probe, bounded shutdown). This class adds ONLY cross-worker dispatch.
 *
 * Dispatch: least-busy live provider. Query jump-ahead is preserved by the
 * existing IN-WORKER priority queue (`embedding-worker.ts`) — a high-priority
 * single-text query floats ahead of any backfill batches queued in whichever
 * worker it lands on. With an idle worker available (the common query-vs-backfill
 * case) a query waits zero; worst case it waits one in-flight batch (token-area
 * ≤ 4096 → sub-second), versus today's unbounded cross-session serialization.
 *
 * Growth is LAZY and MEMORY-GATED: worker 0 spawns on the first embed (today's
 * behavior); a secondary spawns only under genuine concurrent demand, below the
 * ceiling, AND when a full {@link PER_WORKER_MEM_BUDGET_BYTES} is free at spawn
 * time — so a light or constrained host never loads a second ~680 MB model. The
 * module-global `localProviderKnownBroken` latch is shared across all workers, so
 * a deterministic model failure (init-error / WASM-fatal / floor-OOM) on any
 * worker degrades the whole provider to FTS-only, exactly as today.
 */
class EmbeddingPool implements EmbeddingProvider {
  readonly maxBatchSize = 256;

  private readonly modelId: string;
  private readonly dimensions: number;
  /** Memory-gated ceiling, fixed at construction (durable — no mid-session
   *  recompute). Live freemem re-gates each actual spawn on top of this. */
  private readonly ceiling: number;
  private readonly slots: EmbedSlot[] = [];

  constructor(modelId: string, dimensions: number) {
    this.modelId = modelId;
    this.dimensions = dimensions;
    if (testEmbedPoolSize != null) {
      // Deterministic test override — bypass the memory gate entirely.
      this.ceiling = Math.max(
        1,
        Math.min(Math.floor(testEmbedPoolSize), EMBED_POOL_ABS_MAX),
      );
    } else if (process.env.NODE_ENV === "test") {
      // Keep existing single-worker suites deterministic regardless of CI RAM:
      // honor an explicit config/env ceiling (clamped like the prod branch),
      // else default to one worker.
      this.ceiling = Math.max(
        1,
        Math.min(configuredEmbedPoolSize() ?? 1, EMBED_POOL_ABS_MAX),
      );
    } else {
      this.ceiling = desiredEmbedPoolSize(
        this.liveFreemem(),
        configuredEmbedPoolSize(),
      );
    }
  }

  /** Pick the slot to dispatch the next request to, growing the pool lazily
   *  when there's concurrent demand, headroom below the ceiling, and memory. */
  private pickSlot(): EmbedSlot {
    // Primary worker: always present (its own OOM backoff, not pool sizing,
    // protects a constrained host — identical to today's single worker).
    if (this.slots.length === 0) return this.spawnSlot();

    let best = this.slots[0];
    for (const s of this.slots) {
      if (s.inflight < best.inflight) best = s;
    }

    // Every worker is busy: add capacity if we're below the ceiling and a full
    // per-worker memory budget is free right now (re-checked live, so a box that
    // has since gone tight won't load another ~680 MB model).
    if (
      best.inflight > 0 &&
      this.slots.length < this.ceiling &&
      this.liveFreemem() >= PER_WORKER_MEM_BUDGET_BYTES
    ) {
      return this.spawnSlot();
    }
    return best;
  }

  /** Container-aware free memory for the live per-spawn gate: the injected test
   *  value (or live `freemem()`) clamped to the cgroup limit, so a memory-capped
   *  container never spawns a second native-ONNX worker off the host's (much
   *  larger) free figure. Overridable in tests via {@link _setPoolFreememForTest}
   *  (host free) and {@link _setConstrainedMemoryForTest} (the cgroup limit). */
  private liveFreemem(): number {
    const raw = testPoolFreememBytes != null ? testPoolFreememBytes : freemem();
    return clampFreeToContainerLimit(raw, constrainedMemoryLimit());
  }

  private spawnSlot(): EmbedSlot {
    const slot: EmbedSlot = {
      provider: new LocalProvider(this.modelId, this.dimensions),
      inflight: 0,
    };
    this.slots.push(slot);
    return slot;
  }

  async embed(
    texts: string[],
    inputType: "document" | "query",
  ): Promise<Float32Array[]> {
    const slot = this.pickSlot();
    slot.inflight++;
    try {
      return await slot.provider.embed(texts, inputType);
    } finally {
      slot.inflight--;
    }
  }

  /** Shut every worker down and clear the pool. Resolves once all have exited
   *  (or been force-terminated). Idempotent. */
  shutdown(): Promise<void> {
    const providers = this.slots.splice(0).map((s) => s.provider);
    return Promise.all(providers.map((p) => p.shutdown())).then(
      () => undefined,
    );
  }
}

/** Minimal worker surface needed to shut a worker down — lets tests inject a
 *  fake worker without spawning a real thread. */
export interface ShutdownableWorker {
  on(event: "exit", listener: () => void): unknown;
  postMessage(value: WorkerInbound): void;
  terminate(): Promise<number>;
}

/**
 * Ask a worker to exit cooperatively, but never wait longer than `timeoutMs`:
 * on timeout, force-`terminate()` it. Resolves once the worker has exited (or
 * been terminated), or immediately if `postMessage` throws (already gone).
 *
 * Exported (underscore-free name is fine; it's a real helper) so the bounded
 * shutdown can be unit-tested with a fake worker — the real failure mode is a
 * worker stuck in an uninterruptible single-threaded ONNX inference batch that
 * never emits "exit", which would otherwise hang process shutdown.
 */
export function awaitWorkerShutdown(
  worker: ShutdownableWorker,
  timeoutMs: number,
): Promise<void> {
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(killTimer);
      resolve();
    };
    // Hard cap: if the worker is mid-inference (an uninterruptible
    // single-threaded ONNX batch) and never emits "exit", force-terminate it
    // so process shutdown can't hang. Terminating is safe — all SQLite state
    // lives on the main thread; the worker is stateless.
    const killTimer = setTimeout(() => {
      void worker
        .terminate()
        .catch(() => {})
        .finally(finish);
    }, timeoutMs);
    killTimer.unref?.();

    worker.on("exit", finish);
    try {
      worker.postMessage({ type: "shutdown" } satisfies WorkerInbound);
    } catch {
      // Worker already exited (e.g. process.exit(1) from WASM fatal) —
      // resolve immediately since the desired end state is already reached.
      finish();
    }
  });
}

// ---------------------------------------------------------------------------
// Provider resolution
// ---------------------------------------------------------------------------

/** Default models per provider — used when config doesn't override. */
const PROVIDER_DEFAULTS: Record<string, { model: string; dimensions: number }> =
  {
    local: { model: "nomic-ai/nomic-embed-text-v1.5", dimensions: 768 },
    voyage: { model: "voyage-code-3", dimensions: 1024 },
    openai: { model: "text-embedding-3-small", dimensions: 1536 },
  };

/** Env var name for each provider's API key. */
const PROVIDER_ENV_KEYS: Record<string, string> = {
  voyage: "VOYAGE_API_KEY",
  openai: "OPENAI_API_KEY",
};

function getProviderApiKey(provider: string): string | undefined {
  const envKey = PROVIDER_ENV_KEYS[provider];
  return envKey ? process.env[envKey] : undefined;
}

let cachedProvider: EmbeddingProvider | null | undefined;

function getProvider(): EmbeddingProvider | null {
  if (cachedProvider !== undefined) return cachedProvider;

  const cfg = config().search.embeddings;
  if (cfg.enabled === false) {
    cachedProvider = null;
    return null;
  }

  const providerName = cfg.provider;
  const model = cfg.model;

  switch (providerName) {
    case "local": {
      // Construct the provider optimistically — the ONNX model init
      // happens lazily in the worker thread(s) on first `embed()` call.
      // If it fails, `LocalProviderUnavailableError` marks the provider
      // as broken and callers degrade to FTS-only search. The pool wraps
      // one or more LocalProvider workers (memory-gated) so concurrent
      // embeds run in parallel instead of serializing (#999).
      cachedProvider = new EmbeddingPool(model, cfg.dimensions);
      break;
    }
    case "voyage": {
      const apiKey = getProviderApiKey(providerName);
      if (!apiKey) {
        cachedProvider = null;
        return null;
      }
      cachedProvider = new VoyageProvider(apiKey, model, cfg.dimensions);
      break;
    }
    case "openai": {
      const apiKey = getProviderApiKey(providerName);
      if (!apiKey) {
        cachedProvider = null;
        return null;
      }
      cachedProvider = new OpenAIProvider(apiKey, model, cfg.dimensions);
      break;
    }
    default:
      log.info(`unknown embedding provider: ${providerName}`);
      cachedProvider = null;
  }

  return cachedProvider;
}

/** Reset cached provider — called when config changes.
 *  Shuts down the worker thread(s) if the current provider is a local pool.
 *  Returns a promise that resolves once all workers have fully exited.
 *  Callers that need clean teardown (tests) should await the result. */
export function resetProvider(): Promise<void> {
  let shutdownPromise: Promise<void> = Promise.resolve();
  if (cachedProvider instanceof EmbeddingPool) {
    shutdownPromise = cachedProvider.shutdown();
  }
  cachedProvider = undefined;
  return shutdownPromise;
}

/** Shut down the current provider and prevent any new provider from being
 *  created. After this call, `embed()` throws and `isAvailable()` returns
 *  false. Test-only: prevents fire-and-forget embeds (queued by other test
 *  files) from spawning a new worker after cleanup. */
export function _shutdownAndDisable(): Promise<void> {
  let shutdownPromise: Promise<void> = Promise.resolve();
  if (cachedProvider instanceof EmbeddingPool) {
    shutdownPromise = cachedProvider.shutdown();
  }
  cachedProvider = null; // null (not undefined) → getProvider() returns null, won't create new
  return shutdownPromise;
}

/** Save the current cached provider reference (including the live worker)
 *  and clear the cache so the next `getProvider()` call creates a fresh one.
 *  Returns an opaque token that must be passed to `_restoreProvider()` to
 *  put the original provider back — without this, the worker is orphaned and
 *  a second ONNX load in the same Bun process will crash.
 *
 *  Test-only helper: lets suites temporarily swap in a mock/unavailable
 *  provider without killing the real worker. */
export function _saveAndClearProvider(): unknown {
  const saved = { provider: cachedProvider };
  cachedProvider = undefined;
  return saved;
}

/** Restore a provider previously saved by `_saveAndClearProvider()`. Any
 *  provider created between save and restore is discarded (callers must
 *  ensure it's not a LocalProvider with a live worker — those suites only
 *  use `_markLocalProviderUnavailable()` so no worker is spawned). */
export function _restoreProvider(token: unknown): void {
  const saved = token as {
    provider: EmbeddingProvider | null | undefined;
  };
  cachedProvider = saved.provider;
}

/**
 * Quick sanity check that a string looks like a real API key rather than
 * a placeholder. Tools like Codex set `OPENAI_API_KEY=nokey` when routing
 * through a custom base URL — using such a value for real API calls
 * produces 401 errors.
 */
function looksLikeApiKey(key: string): boolean {
  // Real API keys are at least 20 characters, don't contain whitespace,
  // and aren't common placeholders.
  const trimmed = key.trim();
  return trimmed.length >= 20 && !/\s/.test(trimmed);
}

/**
 * Build a remote `EmbeddingProvider` from whichever API key is in env.
 * Returns `null` when neither `VOYAGE_API_KEY` nor `OPENAI_API_KEY` is set,
 * which is the signal for callers to fall through to FTS-only behaviour.
 *
 * Voyage wins ties because it's the higher-quality option for code search;
 * users who want OpenAI specifically can pin `search.embeddings.provider`
 * in `.lore.json` and skip the fallback path entirely.
 */
export function pickRemoteFallback(): {
  name: "voyage" | "openai";
  provider: EmbeddingProvider;
} | null {
  // Validate keys before using them — tools like Codex/OpenCode often set
  // OPENAI_API_KEY to a placeholder (e.g. "nokey") when using a custom
  // OPENAI_BASE_URL. Using such a key for real API calls produces 401 noise.
  const voyageKey = process.env.VOYAGE_API_KEY;
  if (voyageKey && looksLikeApiKey(voyageKey)) {
    const d = PROVIDER_DEFAULTS.voyage;
    return {
      name: "voyage",
      provider: new VoyageProvider(voyageKey, d.model, d.dimensions),
    };
  }
  const openaiKey = process.env.OPENAI_API_KEY;
  if (openaiKey && looksLikeApiKey(openaiKey)) {
    const d = PROVIDER_DEFAULTS.openai;
    return {
      name: "openai",
      provider: new OpenAIProvider(openaiKey, d.model, d.dimensions),
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

/** Returns true if embedding is available.
 *  Active when the configured provider's API key is set, unless explicitly
 *  disabled via `search.embeddings.enabled: false` in .lore.json.
 *
 *  For the `local` provider, also returns false once the worker has reported
 *  an init failure — callers (recall, ltm, distillation) use this gate to
 *  skip embedding work and fall back to FTS-only search. */
export function isAvailable(): boolean {
  const provider = getProvider();
  if (!provider) return false;
  if (provider instanceof EmbeddingPool) {
    if (localProviderKnownUnavailable()) {
      // One-time log so the user knows why vector search is degraded.
      if (!localProviderErrorLogged) {
        localProviderErrorLogged = true;
        log.info(
          "local embedding provider unavailable — recall will use FTS-only search. " +
            "To use a remote provider, set search.embeddings.provider in .lore.json.",
        );
      }
      return false;
    }
    if (localInitRetryAt > 0) {
      // A transient init failure is cooling down before its next retry.
      if (Date.now() < localInitRetryAt) return false; // FTS-only until then
      // Cooldown elapsed → discard the failed pool (fire-and-forget shutdown of
      // its dead worker) so getProvider() spawns a FRESH worker — a new init
      // attempt — on the next embed.
      localInitRetryAt = 0;
      void resetProvider();
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Public embed API
// ---------------------------------------------------------------------------

/**
 * A single-text `query` embed is a recall lookup — the latency-sensitive
 * request path (the recall tool and forSession LTM ranking), as opposed to
 * batch/document writes. This is the single source of truth for that
 * classification: the worker uses it to assign "high" priority (see
 * {@link LocalProvider.embed}) and {@link embed} uses it to track in-flight
 * recall load for the temporal backfill's idle-gate. Both sites call this one
 * predicate so the "mirrors the worker" invariant can never silently drift.
 */
function isRecallEmbed(
  texts: string[],
  inputType: "document" | "query",
): boolean {
  return inputType === "query" && texts.length === 1;
}

/**
 * Number of recall (single query-text) embeds currently in flight through
 * {@link embed}. The temporal re-chunk backfill reads this (via
 * {@link recallEmbedsInFlight}) to yield the shared embedding worker to
 * latency-sensitive recall lookups: it parks a page while a recall embed is
 * outstanding and resumes the instant the worker drains.
 *
 * Only single-text `query` embeds are counted — that is exactly the class the
 * worker itself marks "high priority" (see LocalProvider.embed). Document/batch
 * embeds (write-time message/knowledge/entity embeds AND the backfill's own
 * embeds) are deliberately NOT counted, so the backfill never gates against its
 * own load or against fire-and-forget background writes.
 */
let _recallEmbedsInFlight = 0;

/**
 * Live count of in-flight recall (single query-text) embeds — the temporal
 * re-chunk backfill's idle signal. Read on every gate poll so it reflects the
 * shared worker's current recall load, never a stale snapshot.
 */
export function recallEmbedsInFlight(): number {
  return _recallEmbedsInFlight;
}

/**
 * Test seam: force the in-flight recall-embed counter to a known value so the
 * gateway's idle-gate wiring can be exercised deterministically without driving
 * a real (async, provider-dependent) embed. Test-only.
 */
export function _setRecallEmbedsInFlightForTest(n: number): void {
  _recallEmbedsInFlight = n;
}

/**
 * Generate embeddings for the given texts using the configured provider.
 *
 * Remote providers (voyage, openai) are explicit opt-in via
 * `search.embeddings.provider` in `.lore.json` — there is no automatic
 * fallback from local to remote. When the local provider is unavailable,
 * callers should gate on `isAvailable()` and degrade to FTS-only search.
 *
 * @param texts     Array of texts to embed
 * @param inputType "document" for storage, "query" for search
 * @returns         Float32Array per input text
 * @throws          On API errors or when no provider is available
 */
export async function embed(
  texts: string[],
  inputType: "document" | "query",
): Promise<Float32Array[]> {
  const provider = getProvider();
  if (!provider) throw new Error("No embedding provider available");
  // A single-text query embed is a recall lookup (see isRecallEmbed — the same
  // predicate the worker uses for high priority). Track it in flight so the
  // temporal re-chunk backfill can yield the shared worker while recall is
  // active. The counter is decremented in `finally` so a rejected embed
  // (provider gone, OOM, timeout) can never leak a permanent "busy" that would
  // wedge the backfill forever.
  const isRecall = isRecallEmbed(texts, inputType);
  if (isRecall) _recallEmbedsInFlight++;
  try {
    const vecs = await provider.embed(texts, inputType);
    // Enforce the L2-normalization invariant at the single chokepoint so the JS
    // dot-product path and sqlite-vec's vec_distance_cosine() always agree. See
    // l2Normalize() for the full rationale.
    return vecs.map(l2Normalize);
  } finally {
    if (isRecall) _recallEmbedsInFlight--;
  }
}

// ---------------------------------------------------------------------------
// Cosine similarity (pure JS)
// ---------------------------------------------------------------------------

/**
 * Return an L2-normalized (unit-length) copy of a vector.
 *
 * System-wide invariant: every vector produced by {@link embed} is
 * L2-normalized. Two consumers depend on this and would silently DIVERGE if it
 * were violated:
 *   1. {@link cosineSimilarity} (the JS brute-force path) is a bare dot product
 *      — it only equals cosine similarity for unit vectors.
 *   2. sqlite-vec's `vec_distance_cosine()` (the native fast path) normalizes
 *      internally, so a non-normalized stored vector would score differently on
 *      the two paths (e.g. stored [2,0,0] vs query [1,0,0]: JS dot → 2.0, vec →
 *      1.0), breaking vec/JS parity and producing similarities outside [-1, 1].
 *
 * Providers (local ONNX, Voyage, OpenAI) already return ~unit vectors, so this
 * is idempotent in practice. It is applied unconditionally at the single
 * {@link embed} chokepoint to make the invariant true *by construction* rather
 * than by provider convention — guarding against drift if a provider ever
 * returns non-normalized output.
 *
 * A zero or non-finite vector cannot be normalized and is returned unchanged
 * (matches {@link cosineSimilarity}'s zero-vector handling, which returns 0).
 */
export function l2Normalize(vec: Float32Array): Float32Array {
  let sumSq = 0;
  for (let i = 0; i < vec.length; i++) sumSq += vec[i] * vec[i];
  const norm = Math.sqrt(sumSq);
  if (!(norm > 0) || !Number.isFinite(norm)) return vec;
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / norm;
  return out;
}

// ---------------------------------------------------------------------------
// Vector search — knowledge
// ---------------------------------------------------------------------------

/**
 * Search all knowledge entries with embeddings by cosine similarity.
 * Returns top-k entries sorted by similarity descending.
 *
 * Uses dot-product (vectors are L2-normalized) and bounded top-k insertion
 * to avoid a full O(n log n) sort.
 *
 * @param excludeCategories  Optional category names to exclude from results.
 *   Useful when preferences are injected in a separate system block and
 *   shouldn't compete for vector search slots with context-bound entries.
 */
/**
 * Run `spec` on the read-worker pool when it's enabled and healthy (off the
 * main event loop), otherwise synchronously in-process. The pool call never
 * throws: it returns null when unavailable (disabled/broken/errored) so we
 * transparently fall back in-process, or the VECTOR_SEARCH_TIMED_OUT sentinel
 * when the worker is alive but slow — in which case we return an empty result
 * rather than re-running the scan on the main thread.
 */
async function poolOrInProcess(
  spec: VectorQuerySpec,
  queryEmbedding: Float32Array,
): Promise<VectorHit[] | DistillationVectorHit[]> {
  // #1065: record the wall-clock latency of every vector KNN read (pool
  // round-trip + IPC, or the in-process fallback scan) tagged by the DB's
  // (storage layout × sqlite-vec availability) cohort, so the gateway can prove
  // the vec0 latency win (p50/p95) and spot a silently degraded JS-fallback
  // host. storage_mode is DB-global and vec availability is process-global (the
  // main thread and the workers load the extension together), so this
  // main-thread resolution faithfully labels the worker path too. The lookup is
  // a single indexed kv_meta point read (microseconds). Purely additive: the
  // query path below is unchanged — the fallback re-resolves its own readMode.
  const started = performance.now();
  const cohort = resolveReadMode(readStorageMode(db()), isVecAvailable());
  try {
    const pooled = await tryPoolVectorSearch(spec, queryEmbedding);
    // Timed out: the worker is alive but slow. Return empty — degrading this one
    // recall — rather than re-running the O(n) scan on the main thread, which
    // re-blocks the event loop (the stall bug). The pool cancels the timed-out
    // worker query (terminates + respawns) so it recovers for the next caller.
    if (pooled === VECTOR_SEARCH_TIMED_OUT) return [];
    if (pooled !== null) return pooled;
    const readMode = resolveReadMode(readStorageMode(db()), isVecAvailable());
    try {
      return runVectorQuery(db(), readMode, queryEmbedding, spec);
    } catch (err) {
      // Safety net for the vec0 read path, which (unlike the blob paths) has no
      // in-line JS fallback: a vec0 `MATCH` can throw transiently — e.g. during a
      // dimension change, when the query embedding's width no longer matches the
      // vec0 table — and we must degrade THIS recall to empty (FTS/keyword recall
      // still answers) rather than crash, per the never-crash contract. The pool
      // already logged any worker-path failure; log the in-process one too so a
      // systematic break stays visible.
      log.error("in-process vector search failed; returning empty:", err);
      return [];
    }
  } finally {
    recordVecReadLatency(cohort, performance.now() - started);
  }
}

export async function vectorSearch(
  queryEmbedding: Float32Array,
  limit = 10,
  excludeCategories?: string[],
): Promise<VectorHit[]> {
  return (await poolOrInProcess(
    { kind: "knowledge", limit, excludeCategories },
    queryEmbedding,
  )) as VectorHit[];
}

/**
 * Search all entities with embeddings by cosine similarity.
 * Returns top-k entities sorted by similarity descending.
 */
export async function vectorSearchEntities(
  queryEmbedding: Float32Array,
  limit = 10,
): Promise<VectorHit[]> {
  return (await poolOrInProcess(
    { kind: "entities", limit },
    queryEmbedding,
  )) as VectorHit[];
}

// ---------------------------------------------------------------------------
// Vector search — distillations
// ---------------------------------------------------------------------------

/**
 * Search non-archived distillations with embeddings by cosine similarity.
 * Returns top-k entries sorted by similarity descending.
 */
export async function vectorSearchDistillations(
  queryEmbedding: Float32Array,
  limit = 10,
): Promise<VectorHit[]> {
  return (await poolOrInProcess(
    { kind: "distillations", limit },
    queryEmbedding,
  )) as VectorHit[];
}

// ---------------------------------------------------------------------------
// Vector search — all distillations (including archived)
// ---------------------------------------------------------------------------

/**
 * Search ALL distillations (including archived) with embeddings by cosine
 * similarity, scoped to a single project. Returns session_id alongside
 * similarity for cross-session counting.
 *
 * Unlike vectorSearchDistillations() which filters to non-archived only,
 * this searches the full distillation archive — necessary for detecting
 * repeated instructions across sessions where older distillations have
 * been archived after meta-distillation.
 *
 * Pure brute-force — fine for ~200 entries per project. Safety-capped
 * at 500 rows to prevent excessive CPU on long-running projects.
 */
export async function vectorSearchAllDistillations(
  queryEmbedding: Float32Array,
  projectId: string,
  limit = 20,
): Promise<DistillationVectorHit[]> {
  return (await poolOrInProcess(
    { kind: "allDistillations", projectId, limit },
    queryEmbedding,
  )) as DistillationVectorHit[];
}

// ---------------------------------------------------------------------------
// Fire-and-forget embedding
// ---------------------------------------------------------------------------

/**
 * Embed a knowledge entry and store the result in the DB.
 * Fire-and-forget — errors are logged, never thrown.
 * The entry remains usable via FTS even if embedding fails.
 */
// Fire-and-forget document embeds (knowledge, distillation, entity) must not
// block the write path, so callers don't await them. They are tracked here so
// tests can drain them at the test boundary via settleDocumentEmbeds(): a
// promise that resolves AFTER the harness closes/swaps the DB would otherwise
// write to the wrong DB or log spurious errors (issue #885). No-op in
// production, which never calls the drain.
const _docEmbedsInFlight = new Set<Promise<unknown>>();
function trackDocEmbed(p: Promise<unknown>): void {
  _docEmbedsInFlight.add(p);
  void p.finally(() => _docEmbedsInFlight.delete(p));
}

/**
 * Await all in-flight fire-and-forget document embeds (knowledge / distillation
 * / entity). Test-only drain hook — production never calls it. Loops so embeds
 * spawned while draining (rare) are also awaited.
 */
export async function settleDocumentEmbeds(): Promise<void> {
  while (_docEmbedsInFlight.size > 0) {
    await Promise.allSettled([..._docEmbedsInFlight]);
  }
}

export function embedKnowledgeEntry(
  id: string,
  title: string,
  content: string,
): void {
  if (!isAvailable()) return;
  const text = `${title}\n${content}`;
  trackDocEmbed(
    embed([text], "document")
      .then(([vec]) => {
        storeEmbedding(db(), "knowledge", id, vec);
      })
      .catch((err) => {
        if (err instanceof LocalProviderUnavailableError) return;
        log.error("embedding failed for knowledge entry", id, ":", err);
      }),
  );
}

/**
 * Embed an entity (canonical name + all alias values) and store the result.
 * Fire-and-forget — errors are logged, never thrown. Used by entity auto-dedup
 * (#462) to compute semantic similarity between entities whose names differ but
 * mean the same thing ("GitHub Actions" ↔ "GHA").
 */
export function embedEntity(
  id: string,
  canonicalName: string,
  aliasValues: string[],
): void {
  if (!isAvailable()) return;
  // Composite text: canonical name followed by every alias value. Deduped and
  // joined so the vector captures all surface forms of the entity.
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const v of [canonicalName, ...aliasValues]) {
    const t = v.trim();
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    parts.push(t);
  }
  const text = parts.join(" ");
  if (!text) return;
  trackDocEmbed(
    embed([text], "document")
      .then(([vec]) => {
        storeEmbedding(db(), "entities", id, vec);
      })
      .catch((err) => {
        if (err instanceof LocalProviderUnavailableError) return;
        log.error("embedding failed for entity", id, ":", err);
      }),
  );
}

/**
 * Embed a distillation and store the result in the DB.
 * Fire-and-forget — errors are logged, never thrown.
 * The distillation remains searchable via FTS even if embedding fails.
 */
export function embedDistillation(id: string, observations: string): void {
  if (!isAvailable()) return;
  trackDocEmbed(
    embed([observations], "document")
      .then(([vec]) => {
        storeEmbedding(db(), "distillations", id, vec);
      })
      .catch((err) => {
        if (err instanceof LocalProviderUnavailableError) return;
        log.error("embedding failed for distillation", id, ":", err);
      }),
  );
}

/**
 * Hard cap on how many vec0 chunks a single temporal message may fan out to.
 * A normal turn has a handful of parts; this only bites a pathological message
 * (e.g. hundreds of parallel tool calls). Past the cap the overflow units are
 * folded into ONE final chunk, so the per-message chunk count — which is both
 * `temporal_vec` rows AND the size of the KNN window `runTemporal` must collapse
 * by max-sim (then widen-retry over) — stays bounded, without silently dropping
 * any unit's text from the vector (FTS indexes the full content regardless).
 */
export const MAX_TEMPORAL_CHUNKS_PER_MESSAGE = 64;

/**
 * Embed `texts` in token-area-bounded sub-batches (via {@link nextBatch}) and
 * return the vectors in input order. The multi-vector temporal write hands us
 * one text per part-aware unit; a single `embed()` posts the WHOLE array to the
 * worker as one padded tensor, so a message with many large prose/reasoning
 * units could OOM-thrash the worker (the ×0.7 backoff lowers per-input length,
 * not input count). Sub-batching keeps each worker request's peak tensor within
 * MAX_BATCH_TOKEN_AREA, mirroring the backfill paths. All-or-nothing: a failure
 * in any batch rejects before the caller stores, so a partial chunk set is never
 * written (storeTemporalChunks DELETEs-then-INSERTs the complete set).
 */
async function embedInTokenBatches(
  texts: string[],
  inputType: "document" | "query",
): Promise<Float32Array[]> {
  const items = texts.map((text) => ({ text }));
  const out: Float32Array[] = [];
  for (let i = 0; i < items.length; ) {
    const batch = nextBatch(items, i);
    i += batch.length;
    const vecs = await embed(
      batch.map((b) => b.text),
      inputType,
    );
    out.push(...vecs);
  }
  return out;
}

/**
 * Build the part-aware multi-vector chunk set for one temporal message and
 * write it to `temporal_vec`. Awaitable so the fire-and-forget write path
 * ({@link embedTemporalMessage}) and the resumable re-chunk backfill
 * ({@link backfillTemporalEmbeddings}) share one implementation.
 *
 * vec0 only — the caller guarantees vec0 mode. Splits the stored content back
 * into its units (prose, reasoning, reduced tool envelopes), drops empties,
 * caps the per-message chunk fan-out (#1072), sub-batches the embeds, then
 * stores the COMPLETE set. `storeTemporalChunks` DELETEs-then-INSERTs by
 * `message_id`, so a re-embed replaces the whole set and the chunk count may
 * shrink or grow. Returns the number of chunks written (0 when the message has
 * no embeddable units — in which case nothing is stored OR deleted, so an
 * existing chunk set is never wiped without a replacement).
 */
async function embedAndStoreTemporalChunks(
  id: string,
  content: string,
): Promise<number> {
  let texts = buildEmbeddingUnits(content)
    .map((u) => u.text)
    .filter((t) => t.trim().length > 0);
  if (!texts.length) return 0;
  // Bound the per-message chunk fan-out (#1072): past the cap, fold the
  // overflow tail into the final chunk so the chunk count stays bounded
  // without dropping any unit's text from the vector.
  if (texts.length > MAX_TEMPORAL_CHUNKS_PER_MESSAGE) {
    texts = [
      ...texts.slice(0, MAX_TEMPORAL_CHUNKS_PER_MESSAGE - 1),
      texts.slice(MAX_TEMPORAL_CHUNKS_PER_MESSAGE - 1).join("\n"),
    ];
  }
  // Sub-batch the unit embeds so a many-unit message never posts one oversized
  // tensor to the worker; accumulate all vectors, then store the complete set.
  const vecs = await embedInTokenBatches(texts, "document");
  storeTemporalChunks(db(), id, vecs);
  return vecs.length;
}

/**
 * Embed a temporal message and store the result in the DB.
 * Fire-and-forget — errors are logged, never thrown.
 *
 * Called at message-write time (temporal.store) for the message's current
 * content. Distilled messages KEEP their embeddings — they stay in the vector
 * search path (markDistilled only flips the flag; nothing clears the vector),
 * so this is the only place a message's vector is created at write time. The
 * resumable backfill ({@link backfillTemporalEmbeddings}) re-chunks pre-policy
 * survivors of the whole corpus.
 */
export function embedTemporalMessage(id: string, content: string): void {
  if (!isAvailable()) return;
  // Skip very short messages — they don't carry enough semantic signal
  // to be useful in vector search and would waste embedding capacity.
  if (content.length < 50) return;

  // Part-aware embedding: split the stored content back into its units (prose,
  // reasoning, reduced tool envelopes — see buildEmbeddingUnits). Large
  // `[tool:…]` outputs keep only header + first line so they can no longer evict
  // prose/reasoning from the head or dilute the vector. The full content stays
  // in `content` + FTS for keyword recall regardless.
  //
  // vec0 stores each unit as its OWN chunk in `temporal_vec` (multi-vector): a
  // tool output or a specific reasoning step can then match on its own without
  // diluting prose, and the read collapses chunks back to one hit per message.
  // The blob layout has a single `embedding` column per row, so it falls back to
  // ONE vector over the joined units (the prior single part-selective vector).
  if (readStorageMode(db()) === "vec0") {
    embedAndStoreTemporalChunks(id, content).catch((err) => {
      if (err instanceof LocalProviderUnavailableError) return;
      log.error("embedding failed for temporal message", id, ":", err);
    });
    return;
  }

  const text = buildEmbeddingText(content);
  if (!text) return;
  embed([text], "document")
    .then(([vec]) => {
      storeEmbedding(db(), "temporal", id, vec);
    })
    .catch((err) => {
      if (err instanceof LocalProviderUnavailableError) return;
      log.error("embedding failed for temporal message", id, ":", err);
    });
}

// ---------------------------------------------------------------------------
// Vector search — temporal messages (all, including distilled)
// ---------------------------------------------------------------------------

/**
 * Search temporal messages with embeddings by cosine similarity.
 * Returns top-k entries sorted by similarity descending.
 *
 * Includes distilled messages — their embeddings are preserved by
 * markDistilled() specifically to keep this search path viable.
 * Distilled messages contain specific details (algorithm names, config
 * values, file paths) that the distillation summary may have dropped.
 *
 * Scoped to a single project. Optionally scoped to a single session.
 */
export async function vectorSearchTemporal(
  queryEmbedding: Float32Array,
  projectId: string,
  limit = 10,
  sessionId?: string,
): Promise<VectorHit[]> {
  return (await poolOrInProcess(
    { kind: "temporal", projectId, limit, sessionId },
    queryEmbedding,
  )) as VectorHit[];
}

// ---------------------------------------------------------------------------
// Config change detection
// ---------------------------------------------------------------------------

/**
 * Build a config fingerprint from provider + model + dimensions.
 * Used to detect when the embedding config changes (provider swap, model swap,
 * dimension change) so we can clear stale embeddings and re-embed.
 *
 * 🟡 Scope note for FUTURE chunk/text-policy migrations: this fingerprint keys
 * ONLY on provider/model/dimensions — it deliberately does NOT include the
 * embedding TEXT policy (how a message is split into units / which parts are
 * embedded; see buildEmbeddingUnits). So changing that policy does NOT bump the
 * fingerprint, and the stale-embedding clear + backfill triggered here will NOT
 * fire for a pure policy change. Today the temporal re-chunk backfill re-embeds
 * the whole corpus under a new policy only because it is armed by an explicit KV
 * done-flag (see TEMPORAL_RECHUNK_DONE_KEY / resetTemporalRechunkProgress) that
 * is reset on vec0 cutover — NOT by this fingerprint. If a future migration
 * changes the chunk/text policy again WITHOUT a storage cutover, re-arm the walk
 * deliberately — fold a policy-version token into the done-flag key, or call
 * resetTemporalRechunkProgress() from the migration — because this fingerprint
 * will stay silent.
 */
function configFingerprint(): string {
  const cfg = config().search.embeddings;
  return `${cfg.provider}:${cfg.model}:${cfg.dimensions}`;
}

const EMBEDDING_CONFIG_KEY = "lore:embedding_config";

/**
 * Check if embedding config has changed since the last backfill.
 * If so, clear all existing embeddings (they're incompatible) and
 * update the stored fingerprint.
 *
 * Returns true if embeddings were cleared (full re-embed needed).
 */
export function checkConfigChange(): boolean {
  // Read stored fingerprint from kv_meta
  const stored = db()
    .query("SELECT value FROM kv_meta WHERE key = ?")
    .get(EMBEDDING_CONFIG_KEY) as { value: string } | null;

  const current = configFingerprint();

  if (stored && stored.value === current) return false;

  const mode = readStorageMode(db());

  // A vec0-store DB whose extension didn't load (degraded) cannot manage its
  // embeddings — it can neither count/clear the unreadable vec0 tables nor
  // recreate them. Leave the stored fingerprint UNCHANGED so the change is
  // re-detected and handled the next time the DB opens on a capable runtime.
  if (mode === "vec0" && !isVecAvailable()) return false;

  // Config changed (or first run) — clear all embeddings in all tables
  if (stored) {
    const total =
      mode === "vec0" ? countVec0Embeddings() : countBlobEmbeddings();
    if (total > 0) {
      clearAllEmbeddings(db());
      log.info(
        `embedding config changed (${stored.value} → ${current}), cleared ${total} stale embeddings`,
      );
    }
    // A *dimension* change makes the fixed-width vec0 tables incompatible:
    // recreate them at the new dimension (clearAllEmbeddings emptied the old
    // rows; ensureVec0Store drops + recreates when the stored dim differs, and
    // is a no-op for a same-dimension model/provider swap).
    if (mode === "vec0") {
      ensureVec0Store(db(), config().search.embeddings.dimensions);
    }
    // The clear wiped temporal vectors too, and temporal has no dedicated
    // backfill loop above — re-arm the resumable re-chunk walk so it refills
    // the corpus under the new model/dimension on this same startup.
    resetTemporalRechunkProgress();
  }

  // Store new fingerprint
  db()
    .query(
      "INSERT INTO kv_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?",
    )
    .run(EMBEDDING_CONFIG_KEY, current, current);

  return true;
}

/** Count blob-layout embeddings across all four tables (config-change logging). */
function countBlobEmbeddings(): number {
  const n = (sql: string) => (db().query(sql).get() as { n: number }).n;
  return (
    n(
      "SELECT COUNT(*) as n FROM knowledge_current WHERE embedding IS NOT NULL",
    ) +
    n("SELECT COUNT(*) as n FROM distillations WHERE embedding IS NOT NULL") +
    n(
      "SELECT COUNT(*) as n FROM temporal_messages WHERE embedding IS NOT NULL",
    ) +
    n("SELECT COUNT(*) as n FROM entities WHERE embedding IS NOT NULL")
  );
}

/** Count vec0-layout embeddings across all four `vec0` tables. Only reached on a
 *  capable runtime (degraded short-circuits earlier). */
function countVec0Embeddings(): number {
  const n = (sql: string) => (db().query(sql).get() as { n: number }).n;
  return (
    n("SELECT COUNT(*) as n FROM knowledge_vec") +
    n("SELECT COUNT(*) as n FROM distillation_vec") +
    n("SELECT COUNT(*) as n FROM temporal_vec") +
    n("SELECT COUNT(*) as n FROM entity_vec")
  );
}

/** The four embedding-bearing logical tables, in cutover order. */
const EMBEDDING_TABLES: readonly EmbeddingTable[] = [
  "knowledge",
  "entities",
  "distillations",
  "temporal",
];

/**
 * One-time blob→vec0 cutover. NO-OP unless sqlite-vec is loadable on this
 * runtime AND the DB is still in blob layout (so an already-vec0 DB, or an
 * incapable runtime, skips). Idempotent / resumable: each table's
 * copy-then-drop is gated on the base `embedding` column still existing, so a
 * crash mid-cutover re-runs only the unfinished tables (never reads a dropped
 * column — the v55 boot-loop lesson). The storage mode flips LAST, only once
 * every table's blobs have been relocated and dropped.
 */
export function maybeCutoverToVec0(): void {
  if (!isVecAvailable()) return;

  if (readStorageMode(db()) === "blob") {
    const dim = config().search.embeddings.dimensions;
    ensureVec0Store(db(), dim);
    // Relocate every existing blob into vec0 BEFORE flipping the mode. The copy
    // is idempotent (INSERT OR REPLACE) and does NOT drop anything, so a crash
    // here leaves mode="blob" with the base columns still INTACT — the copy
    // simply re-runs next startup. 🔴 INVARIANT: columns are dropped only AFTER
    // the flip below, so mode==="blob" always implies the embedding columns
    // still exist; no blob-mode query can ever read a half-dropped column (the
    // v55 boot-loop hazard).
    let staleSkipped = 0;
    for (const table of EMBEDDING_TABLES) {
      if (embeddingColumnExists(db(), table))
        staleSkipped += copyBlobsToVec0(db(), table, dim);
    }
    // Flip once vec0 is fully populated and authoritative.
    setStorageMode(db(), "vec0");
    // Arm the temporal re-chunk walk so backfillTemporalEmbeddings definitely
    // runs this startup and re-embeds every row skipped above (plus every legacy
    // single-vector row) at the correct dimension. This is a no-op today — the
    // done flag can only be latched from INSIDE a vec0-mode run of that walk, so
    // a machine transitioning from blob mode never has it set — but calling it at
    // the exact blob->vec0 transition hard-guards that invariant against future
    // refactors and self-documents that the walk is (re)armed here.
    resetTemporalRechunkProgress();
    if (staleSkipped > 0) {
      // Rare corpus corruption (blobs written under a different dimension). The
      // rows were skipped from the copy and will be re-embedded at `dim` by the
      // backfills below; surface it so an operator can see it happened.
      log.notice(
        `vec0 cutover skipped ${staleSkipped} stale-dimension embedding blob(s) (not ${dim}-dim / ${dim * 4} bytes); they will be re-embedded by the startup backfills`,
      );
    }
    log.info(`vec0 storage cutover complete (dim=${dim})`);
  }

  // Reclaim: drop any leftover base embedding columns. Runs STRICTLY in vec0
  // mode (mode never reverts to blob), so no blob-mode reader can observe a
  // half-dropped column. Presence-aware + idempotent → resumable across a crash
  // mid-drop (the next startup finishes the remaining columns).
  if (readStorageMode(db()) === "vec0") {
    let droppedAny = false;
    for (const table of EMBEDDING_TABLES) {
      if (embeddingColumnExists(db(), table)) {
        dropEmbeddingColumn(db(), table);
        droppedAny = true;
      }
    }
    if (droppedAny) {
      try {
        // Best-effort: return the freed pages (notably ~320MB of temporal
        // vectors) to the OS. No-op unless auto_vacuum is on.
        db().query("PRAGMA incremental_vacuum").run();
      } catch {
        // ignore — space is already reclaimed within the DB file by DROP COLUMN.
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Startup backfill — single entry point for all hosts
// ---------------------------------------------------------------------------

/**
 * Delay before the startup backfill begins, so the host's HTTP server has
 * a clear window to answer the first wave of requests (web UI shell load,
 * terminal session-connect handshake) before the embedding worker starts
 * competing for CPU. With inference off the main thread the event loop
 * isn't blocked, but the worker still consumes a CPU core — a short delay
 * avoids contention during the first-connect burst.
 */
const STARTUP_BACKFILL_DELAY_MS = 2_000;

/**
 * Run all embedding backfills and log coverage stats.
 *
 * This is the canonical entry point that every host adapter (OpenCode, Pi,
 * future ACP) should call once during init. It:
 *   1. Waits a short grace period so first-connect HTTP requests can finish
 *   2. Detects config changes (provider swap) and clears stale embeddings
 *   3. Backfills knowledge entries missing embeddings
 *   4. Backfills non-archived distillations missing embeddings
 *   5. Logs a one-line coverage summary to stderr (always visible, not gated)
 *
 * Fire-and-forget: callers should `.catch()` — embedding failures must not
 * block plugin initialization.
 */
/** Outcome of a startup backfill pass, returned for host-side instrumentation
 *  (the gateway wraps the call in a Sentry span). @loreai/core stays Sentry-free. */
export interface BackfillStats {
  pendingKnowledge: number;
  pendingDistillations: number;
  knowledgeEmbedded: number;
  distillationEmbedded: number;
  entityEmbedded: number;
  knowledgeTotal: number;
  knowledgeWithEmbedding: number;
  distillationTotal: number;
  distillationWithEmbedding: number;
  temporalRechunked: number;
}

function emptyBackfillStats(): BackfillStats {
  return {
    pendingKnowledge: 0,
    pendingDistillations: 0,
    knowledgeEmbedded: 0,
    distillationEmbedded: 0,
    entityEmbedded: 0,
    knowledgeTotal: 0,
    knowledgeWithEmbedding: 0,
    distillationTotal: 0,
    distillationWithEmbedding: 0,
    temporalRechunked: 0,
  };
}

/** Host-supplied knobs for {@link runStartupBackfill}. */
export interface BackfillOptions {
  /**
   * Idle-gate for the heavy, resumable temporal re-chunk walk. Consulted before
   * each row; while it returns `true` the walk parks (re-polling) and resumes
   * once it clears. `@loreai/core` has no view of host activity, so the host
   * supplies the policy — the gateway pauses while background work is paused
   * (circuit breaker) or a session was active within the idle window. Progress
   * is durable per-row, so a long park just resumes later from the last
   * checkpoint. Only the temporal walk is gated; the small knowledge/
   * distillation/entity backfills run unthrottled.
   */
  shouldPause?: () => boolean;
}

export async function runStartupBackfill(
  opts: BackfillOptions = {},
): Promise<BackfillStats> {
  if (!isAvailable()) {
    // Make the degraded state visible in the startup path — this early return
    // was previously silent, so a consumer who omitted the optional
    // local-embedding stack (#1026), or is on a remote provider without a key,
    // had no startup signal that backfill (and vector recall) is off. Gate on
    // `enabled` so a deliberate `search.embeddings.enabled: false` stays quiet.
    // `isAvailable()` already emits the local-broken FTS-only line once; this is
    // the startup-scoped, backfill-specific companion.
    if (config().search.embeddings.enabled !== false) {
      log.info(
        "startup embedding backfill skipped — embeddings unavailable " +
          "(recall will use FTS-only search)",
      );
    }
    return emptyBackfillStats();
  }

  // Handle an embedding-config change, then attempt the one-time blob→vec0
  // cutover (both no-ops in the steady state). Order matters: a config change
  // clears stale blobs BEFORE the cutover relocates the survivors, so the vec0
  // tables are never seeded with vectors from a since-changed model/dimension.
  checkConfigChange();
  maybeCutoverToVec0();

  const mode = readStorageMode(db());

  // A vec0-store DB on a runtime that cannot load sqlite-vec: the blob columns
  // are gone and the vec0 tables are unreadable. No backfill is possible — vector
  // recall degrades to empty (FTS still answers) and re-converges when the DB is
  // next opened on a capable runtime.
  if (resolveReadMode(mode, isVecAvailable()) === "degraded") {
    log.warn(
      "vec0 storage but sqlite-vec unavailable — skipping embedding backfill " +
        "(vector recall is FTS-only until reopened on a capable runtime)",
    );
    return emptyBackfillStats();
  }

  // Surface backlog up-front so a slow startup is self-explanatory in logs.
  // Counts use the same mode-aware predicates the backfill loops use, so the
  // two numbers always match what we're about to do. (In vec0 mode the blob
  // column is gone — "pending" means a base row absent from the vec0 index.)
  const pendingKnowledge = (
    db()
      .query(
        `SELECT COUNT(*) as n FROM knowledge_current WHERE ${missingEmbeddingSql("knowledge", mode)} AND confidence > 0.2`,
      )
      .get() as { n: number }
  ).n;
  const pendingDistillations = (
    db()
      .query(
        `SELECT COUNT(*) as n FROM distillations WHERE ${missingEmbeddingSql("distillations", mode)} AND archived = 0 AND observations != ''`,
      )
      .get() as { n: number }
  ).n;

  if (pendingKnowledge + pendingDistillations > 0) {
    log.info(
      `embedding backfill scheduled: ${pendingKnowledge} knowledge + ` +
        `${pendingDistillations} distillations pending — starting in ` +
        `${STARTUP_BACKFILL_DELAY_MS / 1000}s, batches yield between calls ` +
        `(host stays responsive)`,
    );
    await new Promise<void>((r) => setTimeout(r, STARTUP_BACKFILL_DELAY_MS));
  }

  const knowledgeEmbedded = await backfillEmbeddings();
  const distillationEmbedded = await backfillDistillationEmbeddings();
  const entityEmbedded = await backfillEntityEmbeddings();
  // Re-chunk pre-multi-vector temporal survivors into the vec0 layout. Resumable
  // + done-flagged, so this is the heavy walk only on the first vec0 run (and
  // again after a config change); a no-op in blob mode and once converged. Idle-
  // gated (opts.shouldPause) so it yields the shared embed pool to live traffic.
  const temporalRechunked = await backfillTemporalEmbeddings({
    shouldPause: opts.shouldPause,
  });

  // Startup backstop: reclaim vec0 rows orphaned by bulk base-row deletes
  // (project/session/prune) since the last run. Harmless if there are none.
  if (mode === "vec0") gcVec0DanglingRows(db());

  // Coverage stats — always log to stderr so the problem is visible.
  const kTotal = (
    db()
      .query(
        "SELECT COUNT(*) as n FROM knowledge_current WHERE confidence > 0.2",
      )
      .get() as { n: number }
  ).n;
  const kWithEmb = (
    db()
      .query(
        `SELECT COUNT(*) as n FROM knowledge_current WHERE ${hasEmbeddingSql("knowledge", mode)} AND confidence > 0.2`,
      )
      .get() as { n: number }
  ).n;
  const dTotal = (
    db()
      .query(
        "SELECT COUNT(*) as n FROM distillations WHERE archived = 0 AND observations != ''",
      )
      .get() as { n: number }
  ).n;
  const dWithEmb = (
    db()
      .query(
        // Mirror dTotal's predicate (incl. observations != '') so the coverage
        // numerator is always a subset of the denominator (never reads "11/10").
        `SELECT COUNT(*) as n FROM distillations WHERE ${hasEmbeddingSql("distillations", mode)} AND archived = 0 AND observations != ''`,
      )
      .get() as { n: number }
  ).n;

  const parts: string[] = [];
  // Lead with the storage mode + native availability so silent degradation is
  // visible at a glance: `storage_mode=vec0 vec=off` means this DB cut over to
  // vec0-only storage but sqlite-vec did not load here, so vector recall is
  // FTS-only until reopened on a capable runtime.
  parts.push(`storage_mode=${mode} vec=${isVecAvailable() ? "on" : "off"}`);
  if (
    knowledgeEmbedded > 0 ||
    distillationEmbedded > 0 ||
    entityEmbedded > 0 ||
    temporalRechunked > 0
  ) {
    parts.push(
      `backfilled ${knowledgeEmbedded} knowledge + ${distillationEmbedded} distillations + ${entityEmbedded} entities + ${temporalRechunked} temporal re-chunked`,
    );
  }
  parts.push(
    `coverage: knowledge ${kWithEmb}/${kTotal}, distillations ${dWithEmb}/${dTotal}`,
  );
  log.info(`embedding startup: ${parts.join("; ")}`);

  return {
    pendingKnowledge,
    pendingDistillations,
    knowledgeEmbedded,
    distillationEmbedded,
    entityEmbedded,
    knowledgeTotal: kTotal,
    knowledgeWithEmbedding: kWithEmb,
    distillationTotal: dTotal,
    distillationWithEmbedding: dWithEmb,
    temporalRechunked,
  };
}

// ---------------------------------------------------------------------------
// Backfill — knowledge
// ---------------------------------------------------------------------------

/**
 * Maximum chunk size for backfill embed requests. Each chunk becomes a
 * separate message to the embedding worker. Keeping chunks small gives
 * the worker's priority queue natural gaps to interleave high-priority
 * recall queries between backfill batches.
 */
const MAX_BACKFILL_CHUNK = 8;

/**
 * Maximum total "token area" (batch_size × max_sequence_length) per
 * backfill batch. ONNX runtime pads all texts to the longest sequence,
 * so the peak tensor size is proportional to this product. A budget of
 * 4096 tokens allows e.g. 8 × 512-token texts, or 2 × 2048-token texts.
 * Prevents OOM on batches with long distillation observations (~4000+
 * chars) that were blowing up at fixed batch sizes.
 */
const MAX_BATCH_TOKEN_AREA = 4096;

/**
 * Rough chars-per-token ratio for budget estimation. Nomic v1.5 uses a
 * WordPiece tokenizer; English text averages ~4 chars/token.
 */
const CHARS_PER_TOKEN = 4;

/**
 * Partition `rows` into batches that respect both MAX_BACKFILL_CHUNK and
 * MAX_BATCH_TOKEN_AREA. Each batch's estimated token area is
 * `batch.length × max_tokens_in_batch`. We greedily add rows until the
 * next row would push the area over budget.
 */
function nextBatch<T extends { text: string }>(rows: T[], start: number): T[] {
  const batch: T[] = [];
  let maxTokens = 0;

  for (
    let i = start;
    i < rows.length && batch.length < MAX_BACKFILL_CHUNK;
    i++
  ) {
    const estTokens = Math.ceil(rows[i].text.length / CHARS_PER_TOKEN);
    const newMax = Math.max(maxTokens, estTokens);
    const newArea = (batch.length + 1) * newMax;

    if (batch.length > 0 && newArea > MAX_BATCH_TOKEN_AREA) break;

    batch.push(rows[i]);
    maxTokens = newMax;
  }

  return batch;
}

/**
 * Embed all knowledge entries that are missing embeddings.
 * Called by `runStartupBackfill()`.
 * Also handles config changes: if provider/model/dimensions changed, clears
 * stale embeddings first, then re-embeds all entries.
 * Returns the number of entries embedded.
 */
export async function backfillEmbeddings(): Promise<number> {
  // Detect config changes and clear stale embeddings
  checkConfigChange();

  const provider = getProvider();
  if (!provider) return 0;

  const mode = readStorageMode(db());
  const rows = db()
    .query(
      `SELECT id, title, content FROM knowledge_current WHERE ${missingEmbeddingSql("knowledge", mode)} AND confidence > 0.2`,
    )
    .all() as Array<{ id: string; title: string; content: string }>;

  if (!rows.length) return 0;

  // Pre-compute text for token-budget batching
  const items = rows.map((r) => ({ ...r, text: `${r.title}\n${r.content}` }));

  let embedded = 0;
  let i = 0;

  while (i < items.length) {
    const batch = nextBatch(items, i);
    i += batch.length;

    try {
      const vectors = await embed(
        batch.map((b) => b.text),
        "document",
      );

      for (let j = 0; j < batch.length; j++) {
        storeEmbedding(db(), "knowledge", batch[j].id, vectors[j]);
        embedded++;
      }
    } catch (err) {
      // Provider shutdown / unavailability is expected graceful degradation,
      // not a bug — check before log.error so captureException doesn't fire
      // and create Sentry noise (LOREAI-GATEWAY-Q).
      if (err instanceof LocalProviderUnavailableError) {
        log.info("embedding backfill stopped: provider unavailable");
        break;
      }
      log.error(
        `embedding backfill batch failed (${batch.length} items):`,
        err,
      );
    }
    // No yieldToEventLoop() needed — embed() is truly async (worker thread).
  }

  if (embedded > 0) {
    log.info(`embedded ${embedded} knowledge entries`);
  }
  return embedded;
}

// ---------------------------------------------------------------------------
// Backfill — distillations
// ---------------------------------------------------------------------------

/**
 * Embed all non-archived distillations that are missing embeddings.
 * Called on startup alongside knowledge backfill.
 * Returns the number of distillations embedded.
 */
export async function backfillDistillationEmbeddings(): Promise<number> {
  const provider = getProvider();
  if (!provider) return 0;

  const mode = readStorageMode(db());
  const rows = db()
    .query(
      `SELECT id, observations FROM distillations WHERE ${missingEmbeddingSql("distillations", mode)} AND archived = 0 AND observations != ''`,
    )
    .all() as Array<{ id: string; observations: string }>;

  if (!rows.length) return 0;

  let embedded = 0;

  // Progress logging: heartbeat every PROGRESS_INTERVAL embedded so a long
  // backfill (e.g. 1000+ pending after a model change) doesn't look
  // like a silent hang. Without this, only the final tally was logged.
  const PROGRESS_INTERVAL = 256;
  let nextProgressAt = PROGRESS_INTERVAL;

  // Pre-compute text for token-budget batching
  const items = rows.map((r) => ({ ...r, text: r.observations }));
  let i = 0;

  while (i < items.length) {
    const batch = nextBatch(items, i);
    i += batch.length;

    try {
      const vectors = await embed(
        batch.map((b) => b.text),
        "document",
      );

      for (let j = 0; j < batch.length; j++) {
        storeEmbedding(db(), "distillations", batch[j].id, vectors[j]);
        embedded++;
      }
    } catch (err) {
      // Provider shutdown / unavailability is expected graceful degradation,
      // not a bug — check before log.error so captureException doesn't fire
      // and create Sentry noise (LOREAI-GATEWAY-Q).
      if (err instanceof LocalProviderUnavailableError) {
        log.info(
          "distillation embedding backfill stopped: provider unavailable",
        );
        break;
      }
      log.error(
        `distillation embedding backfill batch failed (${batch.length} items):`,
        err,
      );
    }

    if (embedded >= nextProgressAt) {
      log.info(`embedding distillations: ${embedded}/${rows.length}…`);
      nextProgressAt = embedded + PROGRESS_INTERVAL;
    }
    // No yieldToEventLoop() needed — embed() is truly async (worker thread).
  }

  if (embedded > 0) {
    log.info(`embedded ${embedded} distillations`);
  }
  return embedded;
}

// ---------------------------------------------------------------------------
// Backfill — entities
// ---------------------------------------------------------------------------

/**
 * Embed all entities that are missing embeddings. Composite text is the
 * canonical name plus all alias values. Called on startup alongside knowledge
 * and distillation backfill, and as a preflight before entity dedup so
 * similarity comparisons have vectors to work with. Returns the count embedded.
 */
export async function backfillEntityEmbeddings(): Promise<number> {
  const provider = getProvider();
  if (!provider) return 0;

  // Bun's bun:sqlite rejects GROUP_CONCAT(DISTINCT col, separator) with two
  // arguments when DISTINCT is used ("DISTINCT aggregates must have exactly
  // one argument"). Use a subquery to deduplicate aliases instead.
  const mode = readStorageMode(db());
  const rows = db()
    .query(
      `SELECT e.id AS id, e.canonical_name AS canonical_name,
              (SELECT GROUP_CONCAT(da.alias_value, ' ')
               FROM (SELECT DISTINCT alias_value FROM entity_aliases WHERE entity_id = e.id) da
              ) AS aliases
       FROM entities e
       WHERE ${missingEmbeddingSql("entities", mode, "e")}`,
    )
    .all() as Array<{
    id: string;
    canonical_name: string;
    aliases: string | null;
  }>;

  if (!rows.length) return 0;

  // Pre-compute text for token-budget batching. Canonical name is also stored
  // as a "name" alias, so it may already appear in `aliases` — harmless for the
  // embedding (duplicate surface form), and entity names are short.
  const items = rows.map((r) => ({
    ...r,
    text: `${r.canonical_name} ${r.aliases ?? ""}`.trim(),
  }));

  let embedded = 0;
  let i = 0;

  while (i < items.length) {
    const batch = nextBatch(items, i);
    i += batch.length;

    try {
      const vectors = await embed(
        batch.map((b) => b.text),
        "document",
      );

      for (let j = 0; j < batch.length; j++) {
        storeEmbedding(db(), "entities", batch[j].id, vectors[j]);
        embedded++;
      }
    } catch (err) {
      // Provider shutdown / unavailability is expected graceful degradation,
      // not a bug — check before log.error so captureException doesn't fire
      // and create Sentry noise (LOREAI-GATEWAY-Q).
      if (err instanceof LocalProviderUnavailableError) {
        log.info("entity embedding backfill stopped: provider unavailable");
        break;
      }
      log.error(
        `entity embedding backfill batch failed (${batch.length} items):`,
        err,
      );
    }
    // No yieldToEventLoop() needed — embed() is truly async (worker thread).
  }

  if (embedded > 0) {
    log.info(`embedded ${embedded} entities`);
  }
  return embedded;
}

// ---------------------------------------------------------------------------
// Backfill — temporal messages (multi-vector re-chunk)
// ---------------------------------------------------------------------------

/** KV key: id of the last temporal message re-chunked by the backfill walk. */
const TEMPORAL_RECHUNK_CURSOR_KEY = "lore:temporal_rechunk.cursor";
/** KV key: "1" once the walk has reached the end of the corpus. */
const TEMPORAL_RECHUNK_DONE_KEY = "lore:temporal_rechunk.done";
/** KV key: how many passes have ended with a still-unembeddable row. */
const TEMPORAL_RECHUNK_ATTEMPTS_KEY = "lore:temporal_rechunk.attempts";
/**
 * Rows fetched per page of the resumable temporal re-chunk walk. Bounds the
 * working-set memory (the corpus is 100k+ rows with large tool-output content)
 * and the redo cost of a crash mid-page.
 */
const TEMPORAL_RECHUNK_PAGE = 256;
/**
 * Cap on passes that end with a row still failing to embed. A transient remote
 * failure (429/5xx surfaces as a plain Error, not LocalProviderUnavailableError)
 * makes the walk rewind and retry on the next startup rather than latch done
 * over the gap; this bounds that so a genuinely un-embeddable row can't loop
 * forever (it keeps its legacy single vector + FTS, so recall still works).
 */
const MAX_TEMPORAL_RECHUNK_RETRY_PASSES = 3;
/**
 * Poll interval while the temporal walk is parked waiting for the host to go
 * idle. Short enough to resume promptly once traffic stops; a parked walk is
 * otherwise idle (one predicate call + one timer per tick).
 */
const TEMPORAL_RECHUNK_PAUSE_POLL_MS = 250;

/**
 * Park while the host-supplied idle-gate says to defer to live traffic. Returns
 * as soon as the gate clears (or immediately if no gate). A gate that throws is
 * treated as "not paused" — a buggy host predicate must never wedge the walk.
 */
async function awaitBackfillIdle(
  shouldPause: (() => boolean) | undefined,
): Promise<void> {
  if (!shouldPause) return;
  // Edge-triggered logging: because this call blocks until the host is idle,
  // one busy stretch (however many rows it spans) yields exactly one park/resume
  // pair — so a long park is visible in the logs instead of looking like a wedge.
  let parked = false;
  for (;;) {
    let paused = false;
    try {
      paused = shouldPause();
    } catch {
      break; // never let a throwing gate brick the walk
    }
    if (!paused) break;
    if (!parked) {
      parked = true;
      log.info("temporal re-chunk parked — deferring to live traffic");
    }
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, TEMPORAL_RECHUNK_PAUSE_POLL_MS);
      // Don't let a parked walk hold the process open on its own; the host's
      // server keeps it alive, and if it doesn't, resuming next start is fine.
      (t as { unref?: () => void }).unref?.();
    });
  }
  if (parked) log.info("temporal re-chunk resumed");
}

/**
 * Reset the temporal re-chunk progress so the next {@link runStartupBackfill}
 * walks the whole corpus again. Called when an embedding-config change clears
 * all vectors — the temporal corpus has no other repopulation path, so the
 * walk is what refills it under the new model/dimension.
 */
export function resetTemporalRechunkProgress(): void {
  setKV(TEMPORAL_RECHUNK_DONE_KEY, "0");
  setKV(TEMPORAL_RECHUNK_CURSOR_KEY, "");
  setKV(TEMPORAL_RECHUNK_ATTEMPTS_KEY, "0");
}

/**
 * Cumulative-progress line for the temporal re-chunk walk. `done`/`total` count
 * embeddable (>=50 char) messages across ALL runs, so the percentage keeps
 * climbing over restarts — unlike the per-process counters, which reset to zero
 * on every boot. `thisRun` is what the current invocation re-chunked. A zero
 * `total` reads as 100% (nothing to do). The percentage is clamped to 100 and
 * rendered to one decimal. Exported for testing. See {@link
 * backfillTemporalEmbeddings} for how `done = baseDone + scanned` is derived.
 */
export function formatTemporalRechunkProgress(
  done: number,
  total: number,
  thisRun: number,
): string {
  const pct =
    total > 0 ? Math.min(100, Math.round((done / total) * 1000) / 10) : 100;
  return `temporal re-chunk: ${pct}% complete (${done}/${total} messages) · +${thisRun} re-chunked this run`;
}

/**
 * Re-chunk existing temporal messages into the multi-vector vec0 layout.
 *
 * New messages are embedded part-aware at write time, but messages written
 * before the multi-vector policy — and every survivor of the blob→vec0 cutover,
 * which copies a single legacy vector as one `#0` chunk — still carry a single
 * vector. Distilled messages KEEP their embeddings and stay in the vector
 * search path, so the legacy set is the WHOLE corpus, not just the undistilled
 * tail. This walks it and re-embeds each message through the same multi-vector
 * path the write path uses.
 *
 * Properties:
 *  - vec0-only: in blob mode there is one vector per row regardless, so this is
 *    a no-op and does NOT latch the done flag — it runs after a future cutover.
 *  - resumable: a KV cursor advances as the walk progresses; an interrupted run
 *    resumes from the last persisted id. `storeTemporalChunks` replaces the
 *    whole chunk set per message, so re-doing rows is idempotent.
 *  - stable order, not chronological: temporal ids come from the upstream agent
 *    (not lore), so `id` may not be time-ordered. The walk only needs a stable,
 *    unique key — `id TEXT PRIMARY KEY`, `ORDER BY id ASC` (BINARY) — to visit
 *    every pre-existing row exactly once. New rows inserted below the cursor are
 *    already correct from write time, so skipping them is harmless.
 *  - never wedges, never latches over a gap: a row that throws a plain Error
 *    (e.g. a remote 429/5xx — local worker failures surface as
 *    LocalProviderUnavailableError and stop the walk cleanly) is skipped so the
 *    100k+ walk keeps converging, but the pass rewinds the cursor to the first
 *    such row so the next startup retries it instead of latching done over the
 *    gap. Bounded by {@link MAX_TEMPORAL_RECHUNK_RETRY_PASSES} so an
 *    un-embeddable row can't loop forever.
 *  - bounded memory: pages the scan instead of loading the whole corpus.
 *  - converges once: a done flag latches at the end of a clean walk; subsequent
 *    startups skip it. {@link resetTemporalRechunkProgress} re-arms it after a
 *    model/dimension change.
 *
 * Returns the number of messages re-chunked (successfully) in this invocation.
 */
export async function backfillTemporalEmbeddings(
  opts: { shouldPause?: () => boolean } = {},
): Promise<number> {
  const provider = getProvider();
  if (!provider) return 0;

  // Multi-vector chunking only exists in vec0 mode. Skip WITHOUT latching done
  // so a later cutover to vec0 still triggers the walk.
  //
  // 🔴 Ordering invariant: this vec0-mode guard MUST come BEFORE the done-flag
  // check below. Because the flag can therefore only ever be latched from inside
  // a vec0-mode run, a blob-mode run can never set it — which is what guarantees
  // the first walk after a blob->vec0 cutover is always armed and re-embeds the
  // rows that cutover skipped. (maybeCutoverToVec0 also explicitly re-arms the
  // walk on cutover as belt-and-suspenders.) Do not reorder these two lines.
  if (readStorageMode(db()) !== "vec0") return 0;
  if (getKV(TEMPORAL_RECHUNK_DONE_KEY) === "1") return 0;

  let cursor = getKV(TEMPORAL_RECHUNK_CURSOR_KEY) ?? "";
  let processed = 0;
  let scanned = 0;
  // Resume point of the FIRST row that hit a transient error this pass. We keep
  // walking past it (so one hiccup never stalls the whole corpus) but rewind
  // here at the end so the next startup retries it rather than latching done
  // over the gap. Holds the cursor value from BEFORE that row (its predecessor),
  // so `id > retryFrom` re-includes the failed row.
  let retryFrom: string | null = null;

  // Up-front backlog so a long walk is explainable from the logs. The corpus is
  // 100k+ rows and, under embed-pool contention, converges at single-digit
  // rows/min — without this line a multi-hour (or, across restarts, multi-day)
  // walk is completely invisible. Counts rows still to scan from the resume
  // cursor; runs once per process (the walk is one-shot per config).
  const backlog = (
    db()
      .query(
        `SELECT COUNT(*) AS n FROM temporal_messages
         WHERE id > ? AND length(content) >= 50`,
      )
      .get(cursor) as { n: number }
  ).n;
  // Denominator for cumulative progress: ALL embeddable messages, not just the
  // remaining backlog, so the heartbeat shows a percentage that keeps climbing
  // across restarts instead of the per-process tally that resets to zero on every
  // boot. `baseDone` is what prior runs already covered (rows at/below the resume
  // cursor); the walk's SELECT is itself filtered to `length >= 50`, so `scanned`
  // counts embeddable rows and `baseDone + scanned` reaches exactly `total` on a
  // clean pass (→ 100%). Gated on `backlog > 0`: when nothing remains the loop
  // latches done without iterating, so `total`/`baseDone` are never read — no
  // point paying for a second full-table COUNT on that path.
  let total = 0;
  let baseDone = 0;
  if (backlog > 0) {
    total = (
      db()
        .query(
          `SELECT COUNT(*) AS n FROM temporal_messages WHERE length(content) >= 50`,
        )
        .get() as { n: number }
    ).n;
    baseDone = Math.max(0, total - backlog);
    const basePct = total > 0 ? Math.round((baseDone / total) * 1000) / 10 : 0;
    log.info(
      `temporal re-chunk: ${backlog} messages to scan (${baseDone}/${total} already done, ${basePct}%)${cursor ? ", resuming" : ""}`,
    );
  }

  // Wall-clock heartbeat rather than a per-N-rows milestone: at the observed
  // throughput a 1000-row milestone can be hours away, so a time cadence keeps
  // the walk visible regardless of speed.
  const PROGRESS_INTERVAL_MS = 30_000;
  let lastProgressAt = Date.now();

  for (;;) {
    // `length(content) >= 50` mirrors embedTemporalMessage's short-message skip,
    // so the walk never embeds a message the write path would have ignored.
    const rows = db()
      .query(
        `SELECT id, content FROM temporal_messages
         WHERE id > ? AND length(content) >= 50
         ORDER BY id ASC LIMIT ?`,
      )
      .all(cursor, TEMPORAL_RECHUNK_PAGE) as Array<{
      id: string;
      content: string;
    }>;

    if (!rows.length) {
      if (retryFrom === null) {
        // Clean pass reached the end — latch done; subsequent startups skip it.
        setKV(TEMPORAL_RECHUNK_DONE_KEY, "1");
        setKV(TEMPORAL_RECHUNK_ATTEMPTS_KEY, "0");
      } else {
        // Some rows failed this pass. Rewind to the first of them so the next
        // startup retries — up to a bounded number of passes, after which we
        // latch done and leave the stragglers on their legacy single vector.
        const attempts =
          Number(getKV(TEMPORAL_RECHUNK_ATTEMPTS_KEY) ?? "0") + 1;
        if (attempts >= MAX_TEMPORAL_RECHUNK_RETRY_PASSES) {
          log.warn(
            `temporal re-chunk giving up after ${attempts} passes with unembeddable rows`,
          );
          setKV(TEMPORAL_RECHUNK_DONE_KEY, "1");
          setKV(TEMPORAL_RECHUNK_ATTEMPTS_KEY, "0");
        } else {
          setKV(TEMPORAL_RECHUNK_ATTEMPTS_KEY, String(attempts));
          setKV(TEMPORAL_RECHUNK_CURSOR_KEY, retryFrom);
        }
      }
      break;
    }

    let stop = false;
    for (const row of rows) {
      // Idle-gate before starting this row's embed so the walk yields the shared
      // embed pool to live traffic. Parking here is safe: the previous row is
      // already checkpointed, so a park (or a crash while parked) resumes from
      // the last durable cursor.
      await awaitBackfillIdle(opts.shouldPause);
      try {
        // Count only messages that actually got a chunk set written. A row that
        // reduces to zero embeddable units (store() never persists one, but the
        // walk reads rows directly) still advances the cursor below — it just
        // isn't counted so the "re-chunked N" tally stays honest.
        const chunks = await embedAndStoreTemporalChunks(row.id, row.content);
        if (chunks > 0) processed++;
      } catch (err) {
        // Provider went away mid-run — stop WITHOUT advancing past this row or
        // latching done; the next startup resumes from the persisted cursor.
        if (err instanceof LocalProviderUnavailableError) {
          log.info("temporal embedding backfill stopped: provider unavailable");
          stop = true;
          break;
        }
        // A transient/row-specific failure (e.g. a remote 429/5xx). Keep walking
        // so one bad row never stalls the corpus, but remember the earliest
        // failure (its predecessor cursor) so the pass doesn't latch over it.
        log.error("temporal embedding backfill row failed", row.id, ":", err);
        if (retryFrom === null) retryFrom = cursor;
      }
      cursor = row.id;
      scanned++;

      // Checkpoint after EVERY row, not once per page. At the observed
      // throughput a 256-row page can take ~an hour; per-page checkpointing
      // loses the whole page on any restart in that window, so on a machine
      // that restarts more often than a page takes the walk never converges —
      // it re-does the same leading rows forever. Once a row has failed this
      // pass, pin the persisted cursor at the first failure (`retryFrom`) so a
      // later crash still resumes there and retries it; the in-memory `cursor`
      // keeps advancing so the current pass finishes the corpus. Re-doing a row
      // is idempotent (storeTemporalChunks replaces the whole chunk set).
      setKV(TEMPORAL_RECHUNK_CURSOR_KEY, retryFrom ?? cursor);

      if (Date.now() - lastProgressAt >= PROGRESS_INTERVAL_MS) {
        log.info(
          formatTemporalRechunkProgress(baseDone + scanned, total, processed),
        );
        lastProgressAt = Date.now();
      }
    }

    if (stop) break;
  }

  if (processed > 0) {
    log.info(
      formatTemporalRechunkProgress(baseDone + scanned, total, processed),
    );
  }
  return processed;
}
