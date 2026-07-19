/**
 * Embedding worker thread — runs ONNX inference via @huggingface/transformers
 * off the main thread.
 *
 * This file is the entry point for a `node:worker_threads` Worker spawned by
 * `LocalProvider` in `embedding.ts`. It owns the transformers.js pipeline
 * and processes embed requests sequentially from a priority queue. Moving
 * inference here keeps the main thread's event loop free — HTTP requests,
 * SSE streams, and session APIs are no longer blocked during embedding.
 *
 * Communication uses `parentPort` message passing with structured clone.
 * Float32Array vectors are sent back directly (Bun preserves identity).
 *
 * The worker applies Nomic's recommended post-processing:
 *   1. Mean pooling (via pipeline option)
 *   2. Layer normalization
 *   3. Matryoshka dimension truncation (if dimensions < full 768)
 *   4. L2 normalization
 *
 * @see embedding-worker-types.ts for the message protocol.
 */

import { parentPort, workerData } from "node:worker_threads";
import type {
  WorkerInbound,
  WorkerOutbound,
  WorkerInitData,
  EmbedRequest,
} from "./embedding-worker-types.js";

// ---------------------------------------------------------------------------
// workerData
// ---------------------------------------------------------------------------

// This module is only ever loaded as a worker thread entry point, so
// `parentPort` is always present. Capture it into a non-null local and fail
// fast otherwise.
if (!parentPort) {
  throw new Error("embedding-worker must be run as a worker thread");
}
const port = parentPort;

const init = workerData as WorkerInitData;
const { modelId, dimensions, vendorModel } = init;
// Force the bundled WASM ONNX Runtime, skipping native-addon resolution (see
// WorkerInitData.forceWasm). Set by the main thread only when respawning after a
// native worker posted `init-needs-wasm` (#1379). Default false = prefer native.
const forceWasm = init.forceWasm ?? false;
// Snapshot of the host's stderr-silence state (see WorkerInitData). When true,
// every diagnostic below stays off stderr so it can't corrupt the host's TUI.
const stderrSilenced = init.stderrSilenced ?? false;

/**
 * Main-thread-owned input token cap (see `WorkerInitData.maxTokens`). Every
 * batch is truncated to this ceiling (real tokenizer) before the single
 * inference attempt, bounding the O(L²) attention allocation that drives ONNX
 * OOMs. The main thread lowers it ×0.7 and respawns this worker (fresh heap)
 * on each OOM. Falls back to a conservative default only if an older caller
 * omits it.
 */
const maxTokens = init.maxTokens ?? 2048;

/**
 * Cgroup-CPU-aware intra-op thread count for native ONNX Runtime, or `undefined`
 * to leave ORT's own (host-core-sized) default. Computed on the main thread via
 * `nativeIntraOpThreads()` and passed in — the worker runs as raw .ts and can't
 * value-import `ort-native` (see the classifier note below). Applied on the
 * native path only; WASM is already forced single-thread via env.
 */
const intraOpThreads = init.intraOpThreads;

/**
 * Worker exit code signalling an input-size-driven ONNX OOM that the main
 * thread recovers from by respawning at a lower token cap (fresh WASM heap).
 * Inlined here — kept in sync with embedding-worker-types.ts — because the
 * worker is spawned by Node's native resolver, which can't map "./foo.js" →
 * "./foo.ts" for runtime (value) imports.
 */
const EMBED_OOM_EXIT_CODE = 75;

// ---------------------------------------------------------------------------
// Error classifiers — inlined to keep the worker self-contained.
// ---------------------------------------------------------------------------
// The canonical copy lives in embedding-worker-types.ts and is imported by
// the main thread (embedding.ts). The worker thread is spawned by Node's
// native ESM resolver (not Vite), which cannot map internal "./foo.js"
// imports back to "./foo.ts" source files. Inlining avoids the import
// entirely. Keep in sync with embedding-worker-types.ts.

/** Detect ONNX runtime out-of-memory errors. */
function isOomError(msg: string): boolean {
  if (/^\d{6,}$/.test(msg)) return true;
  if (/out.of.memory|alloc.*fail|oom/i.test(msg)) return true;
  return false;
}

/** Detect fatal WASM/ONNX runtime errors (abort, unreachable, OOM). */
function isWasmFatalError(msg: string): boolean {
  if (/\bAborted\b/i.test(msg)) return true;
  if (/\bRuntimeError\b/.test(msg)) return true;
  if (isOomError(msg)) return true;
  return false;
}

/**
 * Detect a corrupt / incomplete model file on disk (truncated HF download →
 * "Protobuf parsing failed"). Gates a destructive purge + re-download, so it
 * MUST exclude transient download/auth/network failures (else a 401/network
 * error loops purge→redownload→fail forever). Inlined copy of the canonical
 * `isCorruptModelError` in embedding-worker-types.ts — keep in sync.
 */
function isCorruptModelError(msg: string): boolean {
  if (
    /unauthorized|forbidden|access to file|could not (locate|find)|network|fetch failed|econnreset|etimedout|enotfound|en.*not.*found/i.test(
      msg,
    )
  ) {
    return false;
  }
  if (/\b(?:status|error|http)\b[^.]*\b(?:40[1349]|4\d\d|5\d\d)\b/i.test(msg)) {
    return false;
  }
  if (/protobuf parsing failed/i.test(msg)) return true;
  if (/load model .*failed.*(protobuf|pars|deserial|modelproto)/i.test(msg))
    return true;
  if (/failed to load model .*(protobuf|pars|deserial|corrupt)/i.test(msg))
    return true;
  if (/invalid model|corrupt(ed)? model|model .*corrupt/i.test(msg))
    return true;
  // ONNX deserialization errors surface as "ModelProto" / "deserialize" failures.
  if (/modelproto|deserializ/i.test(msg)) return true;
  return false;
}

/**
 * Resolve `<cacheDir>/<...modelId>` — the dir transformers.js caches a model in.
 * Inlined copy of the canonical `resolveModelCacheDir` in
 * embedding-worker-types.ts — keep in sync. Returns null when unusable.
 */
function resolveModelCacheDir(
  cacheDir: string | undefined | null,
  id: string,
): string | null {
  if (!cacheDir || !id) return null;
  const segments = id.split("/").filter((s) => s.length > 0);
  if (segments.length === 0) return null;
  const base = cacheDir.replace(/[/\\]+$/, "");
  return `${base}/${segments.join("/")}`;
}

// ---------------------------------------------------------------------------
// Model lifecycle — lazy init on first embed request
// ---------------------------------------------------------------------------

/** The transformers.js pipeline instance, typed loosely since the exact
 *  return type depends on the pipeline task. */
type FeatureExtractionPipeline = {
  (
    texts: string[],
    options?: Record<string, unknown>,
  ): Promise<{
    dims: number[];
    data: Float32Array;
    tolist(): number[][];
  }>;
  dispose?(): Promise<void>;
};

let pipe: FeatureExtractionPipeline | null = null;
/** True once `loadPipeline` commits the NATIVE ONNX Runtime backend (false only
 *  on the npm-bundle WASM fallback). Read by `ensurePipeline` to decide whether
 *  a model-parse failure warrants an `init-needs-wasm` respawn (#1379). */
let usedNativeBinding = false;
/** Set once this (native) worker has asked the main thread to respawn it forcing
 *  WASM (#1379). Suppresses the "pipe is null" hard error on the awaiting init
 *  caller — the worker is about to be terminated and replaced. */
let wasmRespawnRequested = false;
let tokenizer: {
  encode(text: string, options?: Record<string, unknown>): number[];
  decode(ids: number[] | bigint[], options?: Record<string, unknown>): string;
} | null = null;
let layerNormFn:
  | ((
      input: unknown,
      normalized_shape: number[],
    ) => {
      dims: number[];
      data: Float32Array;
      normalize(
        p: number,
        dim: number,
      ): { tolist(): number[][]; data: Float32Array; dims: number[] };
      slice(...args: unknown[]): {
        normalize(
          p: number,
          dim: number,
        ): { tolist(): number[][]; data: Float32Array; dims: number[] };
      };
    })
  | null = null;
let initPromise: Promise<void> | null = null;
let initFailed = false;
let initError: string | null = null;

/**
 * Ensure the transformers.js pipeline is loaded. Lazy — first call triggers
 * the dynamic import + pipeline creation, subsequent calls return immediately.
 * On failure, marks the worker as permanently broken and posts `init-error`.
 */
async function ensurePipeline(): Promise<void> {
  if (pipe) return;
  if (initFailed)
    throw new Error(initError ?? "pipeline init previously failed");

  if (!initPromise) {
    initPromise = (async () => {
      try {
        await loadPipeline();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Self-heal a corrupt / truncated model download: in npm mode the model
        // is auto-fetched into transformers.js's HF cache, so a dropped download
        // leaves a truncated file that bricks embeddings permanently. Delete the
        // cached model and retry the download ONCE. Skipped for vendored binaries
        // (the model ships in the binary — re-downloading isn't appropriate and
        // the path is read-only).
        if (!vendorModel && isCorruptModelError(msg)) {
          // Integrity-gate the DESTRUCTIVE purge: if the model files are present,
          // correctly sized, and start with a valid ONNX header, the parse
          // failure was almost certainly transient — e.g. the file was read
          // while a concurrent process was still writing it during a
          // multi-instance restart. Deleting a good ~137 MB model then would be
          // strictly worse (a failed re-download, e.g. offline, bricks it). Retry
          // the load once WITHOUT purging; a fresh-worker respawn on the main
          // thread (the init-retry cooldown) is the next line of defense.
          // Gate diagnostics on the host's stderr-silence flag (see
          // WorkerInitData) — a raw byte corrupts a host TUI render. Inlined
          // because the worker runs as raw .ts and can't value-import siblings.
          const intact = await cachedModelLooksIntact();
          if (intact) {
            // Native backend loaded the addon but couldn't parse a
            // structurally-intact model — the signature of a native-runtime
            // incompatibility (Bun ↔ onnxruntime-node, #1379), NOT a corrupt
            // download. An in-process retry can't help: the backend is already
            // committed for this worker's module graph. Ask the main thread to
            // respawn a FRESH worker forcing WASM (a new graph). WASM-path
            // parse-failures of an intact file fall through to the retry below
            // (respawn wouldn't change the already-WASM backend). Do NOT post
            // init-error — that's the main thread's break signal.
            if (usedNativeBinding) {
              if (!stderrSilenced) {
                console.warn(
                  `[embedding-worker] native ONNX could not parse an intact model (${msg}); ` +
                    `requesting WASM respawn`,
                );
              }
              post({ type: "init-needs-wasm", error: msg });
              wasmRespawnRequested = true;
              return;
            }
            if (!stderrSilenced) {
              console.warn(
                `[embedding-worker] model parse failed but on-disk files look intact (${msg}); retrying load without purging`,
              );
            }
            // Retry once. If it still fails, it propagates to the .catch below.
            await loadPipeline();
          } else {
            const healed = await purgeCachedModel();
            if (healed) {
              // Diagnostic only — do NOT post `init-error` here; the main thread
              // treats it as a break. Only the .catch below (a genuine final
              // failure) may post init-error.
              if (!stderrSilenced) {
                console.warn(
                  `[embedding-worker] model corrupt (${msg}); purged cache, retrying download once`,
                );
              }
              await loadPipeline();
            } else {
              throw err;
            }
          }
        } else {
          throw err;
        }
      }
    })().catch((err) => {
      initFailed = true;
      initError = err instanceof Error ? err.message : String(err);
      initPromise = null;
      // Notify main thread — all pending + future requests should fail.
      post({ type: "init-error", error: initError });
      throw err;
    });
  }

  await initPromise;
  if (!pipe) {
    // We asked the main thread to respawn us with WASM (#1379); it will
    // terminate this worker imminently. Reject this init caller with a plain
    // error (NOT init-error, already handled by the message above) so the
    // triggering embed settles instead of hanging on a pipe that will never load.
    if (wasmRespawnRequested)
      throw new Error("embedding worker awaiting WASM respawn");
    throw new Error("pipeline init completed but pipe is null");
  }
}

/**
 * Load (or reload) the transformers.js feature-extraction pipeline into the
 * module-level `pipe`/`tokenizer`/`layerNormFn`. Extracted from `ensurePipeline`
 * so it can be retried after a corrupt-model purge. Throws on any failure.
 */
async function loadPipeline(): Promise<void> {
  // npm gateway bundle path: prefer NATIVE ONNX Runtime, fall back to the
  // bundled WASM. This bundle ships the WASM runtime (ort-wasm-simd-threaded.
  // {mjs,wasm}) next to this worker, so their presence is the "am I the npm
  // bundle?" signal. dev/test (raw .ts, real native onnxruntime-node, no sibling
  // WASM) and the SEA binary (vendorModel mode; native via
  // __LORE_ORT_BINDING_PATH__ set by native-loader.cjs) don't match, so this
  // block stays inert there.
  //
  // Native: if the per-platform `@loreai/onnxruntime-<target>` package is
  // installed (optionalDependencies gated by os/cpu — npm-12-safe, no
  // postinstall download), resolve its addon and set __LORE_ORT_BINDING_PATH__;
  // the graceful-patched onnxruntime-node binding then loads it and
  // transformers.js uses native (2.7–4.1× faster than WASM, #999).
  //
  // Fallback (dist-only / unsupported platform): point transformers' wasmPaths
  // at the shipped WASM files (local, not the jsdelivr CDN). The bundle's
  // onnxruntime-node shim (ort-npm-plugin.ts) sees no __LORE_ORT_BINDING_PATH__
  // and resolves to onnxruntime-web, so transformers' IS_NODE_ENV branch (which
  // registers the "cpu" device) drives WASM — keeping dist-only/AUR installs
  // self-contained (#763).
  const globals = globalThis as Record<string, unknown>;
  if (!vendorModel && typeof __filename === "string") {
    const { dirname, join } = await import("node:path");
    const { pathToFileURL } = await import("node:url");
    const { existsSync } = await import("node:fs");
    const distDir = dirname(__filename);
    const wasmMjs = join(distDir, "ort-wasm-simd-threaded.mjs");
    const wasmBin = join(distDir, "ort-wasm-simd-threaded.wasm");
    const isNpmBundle = existsSync(wasmMjs) && existsSync(wasmBin);
    if (
      isNpmBundle &&
      !globals.__LORE_ORT_BINDING_PATH__ &&
      !globals.__LORE_NPM_WASM_PATHS__
    ) {
      // forceWasm (#1379): a prior native worker loaded the addon but couldn't
      // parse the model (Bun ↔ onnxruntime-node). Skip native outright and use
      // the shipped WASM so the retry actually changes backend — resolving
      // native again would just repeat the failure. `nativePath` is only
      // consulted when not forcing WASM.
      const nativePath = forceWasm
        ? null
        : (await import("./ort-native")).resolveNativeOrtBindingPath(
            __filename,
          );
      if (nativePath) {
        globals.__LORE_ORT_BINDING_PATH__ = nativePath;
      } else {
        globals.__LORE_NPM_WASM_PATHS__ = {
          mjs: pathToFileURL(wasmMjs).href,
          wasm: wasmBin,
        };
      }
    }
  }

  // The ONLY code path that runs on the WASM backend is the npm-bundle fallback
  // that set `__LORE_NPM_WASM_PATHS__` above (dist-only / unsupported platform /
  // forceWasm). Every other path — dev/test (real onnxruntime-node), the SEA
  // vendored binary, and the npm bundle's native branch — runs native. So a
  // model-parse failure is "native couldn't parse it" iff WASM was NOT selected.
  // This drives the init-needs-wasm respawn decision in ensurePipeline (#1379).
  usedNativeBinding = !globals.__LORE_NPM_WASM_PATHS__;

  const transformers = await import("@huggingface/transformers");
  const { pipeline, env, layer_norm } = transformers;

  // Configure transformers.js environment
  env.allowRemoteModels = !vendorModel;
  env.allowLocalModels = true;

  if (vendorModel) {
    // Binary mode: point at pre-extracted model files on disk.
    env.localModelPath = vendorModel.localModelPath;
    env.allowRemoteModels = false;
  }

  // WASM-only tuning: force single-threaded WASM execution to avoid Bun's buggy
  // shared-memory/pthread WASM paths (the npm dist path may run under Bun). The
  // threaded build uses `new WebAssembly.Memory({shared:true})` which triggers
  // open Bun bugs:
  //   - oven-sh/bun#25677: SharedArrayBuffer writes invisible to workers
  //   - oven-sh/bun#31158: SIGPWR storm with native threads + WASM
  //   - oven-sh/bun#18145: $bunfs + WASM Aborted() in --compile binaries
  // Single-thread avoids all three. This touches only `env.backends.onnx.wasm`,
  // which the native onnxruntime-node backend (SEA binary + dev/test) ignores —
  // native uses its own multi-threaded intra-op pool (a key reason the SEA
  // switched to native: it scales with cores, #999). So this is a no-op there.
  const wasmEnv = (env as Record<string, unknown>).backends as
    | { onnx?: { wasm?: { numThreads?: number; proxy?: boolean } } }
    | undefined;
  if (wasmEnv?.onnx?.wasm) {
    wasmEnv.onnx.wasm.numThreads = 1;
    wasmEnv.onnx.wasm.proxy = false;
  }

  // Create feature-extraction pipeline with ONNX quantized model.
  // dtype: 'q8' selects the INT8 quantized ONNX variant (model_quantized.onnx)
  // which is ~137MB for Nomic v1.5 vs ~547MB for the full FP32 model.
  //
  // device: "cpu" — the SEA binary and dev/test use the native onnxruntime-node
  // CPU backend (multi-threaded). The npm dist-only bundle redirects
  // onnxruntime-node → onnxruntime-web, which serves "cpu" via its WASM+SIMD
  // backend (API-compatible).
  // Native ORT sizes its intra-op thread pool to the HOST core count, which is
  // cgroup-CPU-blind — a CPU-quota'd container oversubscribes (one memory arena
  // per thread → RSS inflation). The main thread computed the cgroup-aware cap
  // (nativeIntraOpThreads() → WorkerInitData.intraOpThreads; the worker runs as
  // raw .ts and can't value-import ort-native — see maxTokens above), a strict
  // no-op on unconstrained hosts. Apply it on the native path only — WASM is
  // already forced single-thread via env above; `globals` (captured above) only
  // carries __LORE_NPM_WASM_PATHS__ when the npm bundle fell back to WASM, so
  // every other path (SEA vendorModel, native binding, dev/test) is native.
  const pipelineOptions: Record<string, unknown> = {
    dtype: "q8",
    device: "cpu",
  };
  if (intraOpThreads !== undefined && !globals.__LORE_NPM_WASM_PATHS__) {
    pipelineOptions.session_options = { intraOpNumThreads: intraOpThreads };
  }
  pipe = (await pipeline(
    "feature-extraction",
    modelId,
    pipelineOptions,
  )) as unknown as FeatureExtractionPipeline;

  // Guard against Callable pattern failure: @huggingface/transformers
  // uses Object.setPrototypeOf(closure, new.target.prototype) in the
  // Callable base class to make pipeline instances callable. Under
  // esbuild CJS bundling + Node v24, this pattern can break — the
  // pipeline object is truthy but not a function, causing "pipe is not
  // a function" on every subsequent inference (LOREAI-GATEWAY-10).
  // Detect at construction time and fail fast with a descriptive error.
  if (typeof pipe !== "function") {
    const actualType = typeof pipe;
    pipe = null;
    throw new Error(
      `pipeline() returned a non-callable ${actualType} — ` +
        `Callable pattern broken (Node ${process.versions.node})`,
    );
  }

  // Stash a reference to the pipeline's tokenizer for token-level
  // truncation during OOM retries.
  tokenizer = (pipe as unknown as { tokenizer: typeof tokenizer }).tokenizer;

  layerNormFn = layer_norm as typeof layerNormFn;
}

/**
 * Delete the cached model directory for `modelId` so transformers.js re-downloads
 * it on the next pipeline() call. Used to recover from a corrupt / truncated
 * download. Returns true if a cache directory was found and removed (i.e. a retry
 * is worthwhile), false otherwise (nothing to purge → retrying would be futile).
 *
 * Only safe in npm mode: the HF cache lives under `env.cacheDir` and the model
 * resolves to `<cacheDir>/<modelId>/`. Never called for vendored binaries.
 */
async function purgeCachedModel(): Promise<boolean> {
  try {
    const { env } = await import("@huggingface/transformers");
    const cacheDir = (env as { cacheDir?: string }).cacheDir;
    const modelDir = resolveModelCacheDir(cacheDir, modelId);
    if (!modelDir) return false;
    const { rm, stat } = await import("node:fs/promises");
    try {
      await stat(modelDir);
    } catch {
      return false; // nothing cached to purge
    }
    await rm(modelDir, { recursive: true, force: true });
    return true;
  } catch {
    // If we can't resolve/remove the cache, retrying the download is pointless.
    return false;
  }
}

/** Inlined copy of MIN_ONNX_FILE_BYTES from embedding-worker-types.ts — the
 *  worker runs as raw .ts and can't value-import siblings (see the classifier
 *  note above). Keep in sync with `looksLikeIntactOnnxFile`. */
const MIN_ONNX_FILE_BYTES = 1024 * 1024;

/**
 * Best-effort integrity check of the cached model's ONNX file(s): present,
 * plausibly sized (≥ 1 MiB), and starting with the ONNX/protobuf header byte
 * (field 1 `ir_version`, wire tag 0x08). Returns true only when EVERY `.onnx`
 * file passes — i.e. the on-disk model looks loadable, so a parse failure was
 * likely transient and the corrupt-model self-heal must NOT purge it. Returns
 * false on ANY uncertainty (missing dir / read error), so the caller falls back
 * to the safe purge + re-download path. Never throws. Mirrors the pure
 * `looksLikeIntactOnnxFile` predicate in embedding-worker-types.ts.
 */
async function cachedModelLooksIntact(): Promise<boolean> {
  try {
    const { env } = await import("@huggingface/transformers");
    const cacheDir = (env as { cacheDir?: string }).cacheDir;
    const modelDir = resolveModelCacheDir(cacheDir, modelId);
    if (!modelDir) return false;
    const { readdir, stat, open } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const onnxDir = join(modelDir, "onnx");
    let onnxFiles: string[];
    try {
      onnxFiles = (await readdir(onnxDir)).filter((f) => f.endsWith(".onnx"));
    } catch {
      return false; // no onnx dir → can't verify → allow the purge fallback
    }
    if (onnxFiles.length === 0) return false;
    for (const name of onnxFiles) {
      const file = join(onnxDir, name);
      const { size } = await stat(file);
      if (size < MIN_ONNX_FILE_BYTES) return false; // truncated / empty
      const fh = await open(file, "r");
      try {
        const head = Buffer.alloc(1);
        const { bytesRead } = await fh.read(head, 0, 1, 0);
        if (bytesRead < 1 || head[0] !== 0x08) return false; // not an ONNX proto
      } finally {
        await fh.close();
      }
    }
    return true;
  } catch {
    return false; // uncertain → safe fallback to purge
  }
}

// ---------------------------------------------------------------------------
// Priority queue — high-priority (recall) jumps ahead of normal (backfill)
// ---------------------------------------------------------------------------

const queue: EmbedRequest[] = [];
let processing = false;

/**
 * Enqueue an embed request. High-priority requests are inserted after any
 * existing high-priority items but before all normal-priority items (FIFO
 * within each priority level). Triggers drain if not already running.
 */
function enqueue(msg: EmbedRequest): void {
  if (msg.priority === "high") {
    // Insert after the last "high" item — keeps FIFO within high priority.
    let insertAt = 0;
    while (insertAt < queue.length && queue[insertAt].priority === "high") {
      insertAt++;
    }
    queue.splice(insertAt, 0, msg);
  } else {
    queue.push(msg);
  }
  void drain();
}

/**
 * Process queued requests one at a time. ONNX inference is synchronous
 * inside the NAPI call, so parallelism within the worker buys nothing.
 * The queue gives us a natural point to interleave high-priority requests
 * between normal-priority batches.
 */
async function drain(): Promise<void> {
  if (processing) return;
  processing = true;

  while (queue.length > 0 && !shutdownRequested) {
    const req = queue.shift();
    if (!req) break;
    await processEmbed(req);
  }

  processing = false;
}

// ---------------------------------------------------------------------------
// Embed processing
// ---------------------------------------------------------------------------

/**
 * Truncate texts to a maximum number of tokens using the real tokenizer.
 * Only texts exceeding `maxTokens` chars are checked — at worst-case
 * ~1 char/token, shorter texts can never exceed the limit.
 */
function truncateTexts(texts: string[], maxTokens: number): string[] {
  const tk = tokenizer;
  if (!tk) return texts;
  return texts.map((text) => {
    if (text.length <= maxTokens) return text;
    // Exclude [CLS]/[SEP] special tokens so ids.length reflects pure content
    // token count — otherwise the 2 extra tokens skew the limit check.
    const ids = tk.encode(text, { add_special_tokens: false });
    if (ids.length <= maxTokens) return text;
    return tk.decode(ids.slice(0, maxTokens), {
      skip_special_tokens: true,
    });
  });
}

// isOomError and isWasmFatalError are imported from embedding-worker-types.ts
// (shared with the main thread to prevent classification drift).

// transformers.js' sessionRun() (models.js) wraps `session.run` in a try/catch
// that, on ANY inference error, does two console.error() calls before
// re-throwing: the error message, and a dump of every input tensor INCLUDING
// its `.data` — for us that's `input_ids`/`attention_mask`/`token_type_ids`,
// thousands of token IDs (~21K values at the 8192-token cap). A memory-driven
// OOM is an EXPECTED, recovered event here (the main thread drives the ×0.7 cap
// backoff + fresh-heap respawn), so that dump is pure journal noise, emitted
// 1–2× per cold start. It is NOT gated by ORT's logSeverityLevel (it's
// transformers.js, not the ORT C++ logger — verified: setting logSeverityLevel:4
// leaves the dump unchanged), so the only lever is filtering these two lines.
// Nothing actionable is lost: transformers re-throws the error, and
// processEmbed() below classifies+surfaces it (OOM → respawn+resubmit; otherwise
// → posted error).
//
// Inlined here — kept in sync with the canonical
// `isTransformersInferenceDumpLine` / `TRANSFORMERS_INFERENCE_DUMP_PREFIXES` in
// embedding-worker-types.ts (unit-tested there) — for the same reason as
// isOomError/isWasmFatalError above: the worker is spawned by Node's native
// resolver, which can't map a runtime `.js` import back to this `.ts` source.
const TRANSFORMERS_INFERENCE_DUMP_PREFIXES = [
  "An error occurred during model execution:",
  "Inputs given to model:",
];

// Byte-identical inline copy of the canonical `isTransformersInferenceDumpLine`
// in embedding-worker-types.ts. Both the prefixes array AND this function body
// are drift-guarded by embedding-worker-types.test.ts, so the worker's actual
// filtering logic (not just the data) can't silently diverge from the
// unit-tested canonical.
function isTransformersInferenceDumpLine(arg: unknown): boolean {
  return (
    typeof arg === "string" &&
    TRANSFORMERS_INFERENCE_DUMP_PREFIXES.some((p) => arg.startsWith(p))
  );
}

/** Temporarily drop transformers.js' inference-error tensor dump; returns a
 *  restore fn. Everything else on console.error passes through untouched. Safe
 *  because the worker runs inferences strictly sequentially — there is never a
 *  concurrent runInference to race the console.error swap. */
function suppressTransformersInferenceDump(): () => void {
  const original = console.error;
  console.error = (...args: unknown[]): void => {
    if (isTransformersInferenceDumpLine(args[0])) return;
    original(...args);
  };
  return () => {
    console.error = original;
  };
}

/** Run inference on `texts` and return per-text vectors. */
async function runInference(texts: string[]): Promise<Float32Array[]> {
  // `ensurePipeline()` (awaited by the caller) guarantees both `pipe` and
  // `layerNormFn` are set; capture into locals for narrowing.
  const pipeline = pipe;
  const layerNorm = layerNormFn;
  if (!pipeline || !layerNorm) {
    throw new Error("pipeline not initialized");
  }

  // Run feature extraction with mean pooling.
  // truncation: true caps each text at the model's max length (8192 tokens
  // for Nomic v1.5) as a last-resort safety net. The console.error filter is
  // installed only around this call (see suppressTransformersInferenceDump) to
  // swallow transformers.js' input-tensor dump on the expected OOM path.
  const restoreConsole = suppressTransformersInferenceDump();
  let output: Awaited<ReturnType<typeof pipeline>>;
  try {
    output = await pipeline(texts, { pooling: "mean", truncation: true });
  } finally {
    restoreConsole();
  }

  // Post-process following Nomic's recipe:
  //   1. Layer normalization over the full hidden dimension
  //   2. Matryoshka truncation to target dimensions
  //   3. L2 normalization
  const fullDim = output.dims[output.dims.length - 1]; // 768 for Nomic v1.5
  const truncate = dimensions < fullDim;

  let normalized: { tolist(): number[][]; data: Float32Array; dims: number[] };
  if (truncate) {
    // layer_norm → slice → L2 normalize
    normalized = layerNorm(output, [fullDim])
      .slice(null, [0, dimensions])
      .normalize(2, -1);
  } else {
    // layer_norm → L2 normalize (no truncation)
    normalized = layerNorm(output, [fullDim]).normalize(2, -1);
  }

  // Extract per-text vectors from the batched tensor.
  const numTexts = texts.length;
  const vectors: Float32Array[] = [];
  const dim = truncate ? dimensions : fullDim;

  for (let i = 0; i < numTexts; i++) {
    const start = i * dim;
    const vec = new Float32Array(dim);
    vec.set(normalized.data.subarray(start, start + dim));
    vectors.push(vec);
  }

  return vectors;
}

async function processEmbed(req: EmbedRequest): Promise<void> {
  inflight++;
  try {
    await ensurePipeline();

    // Truncate to the main-thread-owned token cap BEFORE the single inference
    // attempt. The cap is memory-aware and is lowered ×0.7 per fresh-heap
    // respawn (see LocalProvider in embedding.ts). We deliberately do NOT
    // retry in-process on OOM: WASM linear memory never shrinks, so a smaller
    // retry in this same worker allocates against an already-exhausted/
    // fragmented heap and fails too. Instead we exit with EMBED_OOM_EXIT_CODE
    // so the main thread respawns us (fresh heap) at a lower cap and
    // re-submits the request.
    // Per-request cap (an upward re-probe) overrides the workerData default.
    const effectiveMax = req.maxTokens ?? maxTokens;
    const texts = truncateTexts(req.texts, effectiveMax);
    const vectors = await runInference(texts);
    post({ type: "result", id: req.id, vectors });
  } catch (err) {
    // Don't re-post init-error — it was already sent in ensurePipeline().
    // Also stay silent when we've asked the main thread to respawn us forcing
    // WASM (#1379/#1387-B2): ensurePipeline() rejected this request with
    // "awaiting WASM respawn", but posting a per-request `error` here would make
    // the main thread reject+drop the pending BEFORE respawnForWasm() can
    // re-submit it to the fresh WASM worker. The respawn re-submits it instead.
    if (!initFailed && !wasmRespawnRequested) {
      const raw = err instanceof Error ? err.message : String(err);
      const longest = Math.max(...req.texts.map((t) => t.length));
      const effectiveMax = req.maxTokens ?? maxTokens;

      // Input-size-driven OOM → recoverable. Exit with the dedicated code so
      // the main thread drives the halve-and-respawn backoff (fresh heap,
      // lower cap, then re-submit). We do NOT post an error first: that would
      // reject the request before the backoff can re-submit it. The main
      // thread reconstructs OOM context from the pending request for telemetry.
      if (isOomError(raw)) {
        // Silenced in host-TUI mode (see WorkerInitData.stderrSilenced); the
        // main thread reconstructs OOM telemetry, so nothing diagnostic is lost.
        if (!stderrSilenced) {
          console.warn(
            `[lore] ONNX OOM at ≤${effectiveMax} tokens (batch=${req.texts.length}, ` +
              `longest≈${longest} chars) — respawning worker at a lower cap`,
          );
        }
        process.exit(EMBED_OOM_EXIT_CODE);
        return; // unreachable, but makes intent clear
      }

      // Genuine fatal WASM error (Aborted/RuntimeError/non-callable) — not
      // input-size-driven, so respawning won't help. Report this request and
      // exit(1) so the main thread latches the provider broken.
      if (isWasmFatalError(raw)) {
        post({
          type: "error",
          id: req.id,
          error: `WASM fatal error (worker exiting): ${raw}`,
        });
        process.exit(1);
        return; // unreachable, but makes intent clear
      }

      // Non-fatal per-request error — reject just this request, keep serving.
      post({ type: "error", id: req.id, error: raw });
    }
  } finally {
    inflight--;
    maybeExit();
  }
}

// ---------------------------------------------------------------------------
// Shutdown handling
// ---------------------------------------------------------------------------

let inflight = 0;
let shutdownRequested = false;

function maybeExit(): void {
  if (shutdownRequested && inflight === 0) {
    // Deferred process.exit(0) lets any pending setImmediate / microtask
    // callbacks (e.g. onnxruntime-node NAPI result conversion) complete
    // before we tear down the V8 isolate.  A plain port.close() is not
    // sufficient: native NAPI handles can keep the event loop alive
    // indefinitely.
    setTimeout(() => process.exit(0), 0);
  }
}

function post(msg: WorkerOutbound): void {
  port.postMessage(msg);
}

port.on("message", (msg: WorkerInbound) => {
  switch (msg.type) {
    case "embed":
      if (!shutdownRequested) {
        enqueue(msg);
      }
      break;
    case "shutdown":
      shutdownRequested = true;
      queue.length = 0; // Drop queued (not in-flight) requests.
      maybeExit();
      break;
  }
});
