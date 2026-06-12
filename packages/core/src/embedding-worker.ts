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

const { modelId, dimensions, vendorModel } = workerData as WorkerInitData;

/**
 * Token ceiling used when retrying after an ONNX OOM. We don't pre-truncate
 * every request — most texts are fine at their natural length. Instead, on
 * OOM we retry with progressively halved token limits starting from this
 * value. The pipeline's built-in `truncation: true` caps at model_max_length
 * (8192 for Nomic v1.5), which is too high for ONNX to allocate safely.
 */
const OOM_RETRY_START_TOKENS = 4096;

/** Maximum number of OOM retry attempts (including the initial full-length
 *  try). On OOM the token limit halves each retry: full → 4096 → 2048 → 1024.
 *  Three truncated retries covers extreme cases. */
const OOM_MAX_RETRIES = 3;

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
          const healed = await purgeCachedModel();
          if (healed) {
            // Diagnostic only — do NOT post `init-error` here. The main thread
            // treats `init-error` as a permanent break (sets
            // localProviderKnownBroken=true), which would brick the provider
            // even though we're about to retry successfully. Only the .catch
            // below (a genuine final failure) may post init-error.
            console.warn(
              `[embedding-worker] model corrupt (${msg}); purged cache, retrying download once`,
            );
            // Retry once. If this throws, it propagates to the .catch below and
            // marks the worker permanently failed.
            await loadPipeline();
          } else {
            throw err;
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
  if (!pipe) throw new Error("pipeline init completed but pipe is null");
}

/**
 * Load (or reload) the transformers.js feature-extraction pipeline into the
 * module-level `pipe`/`tokenizer`/`layerNormFn`. Extracted from `ensurePipeline`
 * so it can be retried after a corrupt-model purge. Throws on any failure.
 */
async function loadPipeline(): Promise<void> {
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

  // Force single-threaded WASM execution to avoid Bun's buggy
  // shared-memory/pthread WASM paths. The threaded build uses
  // `new WebAssembly.Memory({shared:true})` which triggers open Bun bugs:
  //   - oven-sh/bun#25677: SharedArrayBuffer writes invisible to workers
  //   - oven-sh/bun#31158: SIGPWR storm with native threads + WASM
  //   - oven-sh/bun#18145: $bunfs + WASM Aborted() in --compile binaries
  // Single-thread avoids all three. The ~2× batch speed advantage of
  // threading is batch-only (single-text is identical) and lore's workload
  // is incremental single-text embeds, so no practical throughput loss.
  //
  // Access the ONNX WASM config via the env object exposed by transformers.js.
  // `env.backends.onnx.wasm` is the ORT WebAssemblyFlags interface.
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
  // device: "cpu" — in npm mode, transformers.js uses onnxruntime-node
  // (native CPU). In the compiled binary, onnxruntime-node is redirected
  // to onnxruntime-web by the build plugin, which handles "cpu" via its
  // WASM+SIMD backend (API-compatible, ~2x faster on batch workloads).
  pipe = (await pipeline("feature-extraction", modelId, {
    dtype: "q8",
    device: "cpu",
  })) as unknown as FeatureExtractionPipeline;

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
  drain();
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
  // for Nomic v1.5) as a last-resort safety net.
  const output = await pipeline(texts, { pooling: "mean", truncation: true });

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

    // Try inference at full length first. On ONNX OOM, retry with
    // progressively halved token limits using the real tokenizer.
    // This preserves maximum semantic content for normal texts while
    // handling dense-token content (code, CJK, base64) adaptively.
    //
    // attempt 0 = original texts (no truncation)
    // attempt 1 = truncated to 4096 tokens
    // attempt 2 = truncated to 2048 tokens
    // attempt 3 = truncated to 1024 tokens
    let texts = req.texts;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= OOM_MAX_RETRIES; attempt++) {
      try {
        const vectors = await runInference(texts);
        post({ type: "result", id: req.id, vectors });
        return;
      } catch (err) {
        const raw = err instanceof Error ? err.message : String(err);
        if (!isOomError(raw) || !tokenizer) throw err;
        lastError = err instanceof Error ? err : new Error(raw);

        // If all texts are already shorter than the smallest retry ceiling
        // (1024 tokens ≈ chars at worst-case 1:1 ratio), truncation cannot
        // help — the OOM is a model-init/runtime allocation failure, not
        // input-size-driven. Throw immediately to reach the fatal exit path.
        const smallestRetryLimit =
          OOM_RETRY_START_TOKENS >> (OOM_MAX_RETRIES - 1); // 1024
        const longestText = Math.max(...req.texts.map((t) => t.length));
        if (longestText <= smallestRetryLimit) {
          throw lastError;
        }

        // OOM — truncate texts and retry with fewer tokens.
        // attempt 0 failed at full length → retry at 4096 tokens
        // attempt 1 failed at 4096       → retry at 2048 tokens
        // attempt 2 failed at 2048       → retry at 1024 tokens
        // attempt 3 failed at 1024       → loop exits, throw below
        if (attempt < OOM_MAX_RETRIES) {
          const maxTokens = OOM_RETRY_START_TOKENS >> attempt; // 4096, 2048, 1024
          texts = truncateTexts(req.texts, maxTokens);
          console.warn(
            `[lore] ONNX OOM on attempt ${attempt + 1}, retrying with ≤${maxTokens} tokens ` +
              `(batch=${req.texts.length}, longest≈${Math.max(...req.texts.map((t) => t.length))} chars)`,
          );
        }
      }
    }

    // All retries exhausted — report the last error.
    throw lastError ?? new Error("ONNX OOM retries exhausted");
  } catch (err) {
    // Don't re-post init-error — it was already sent in ensurePipeline().
    if (!initFailed) {
      const raw = err instanceof Error ? err.message : String(err);

      // Fatal WASM errors (e.g. "Aborted()") leave the ONNX runtime in an
      // unrecoverable state — every subsequent request would also fail,
      // generating unbounded Sentry events. Report the error for this
      // request and exit the worker so the main thread marks the provider
      // as broken and stops sending work.
      if (isWasmFatalError(raw)) {
        post({
          type: "error",
          id: req.id,
          error: `WASM fatal error (worker exiting): ${raw}`,
        });
        process.exit(1);
        return; // unreachable, but makes intent clear
      }

      const msg = isOomError(raw)
        ? `ONNX runtime out of memory after ${OOM_MAX_RETRIES} retries ` +
          `(batch=${req.texts.length}, ` +
          `longest≈${Math.max(...req.texts.map((t) => t.length))} chars). ` +
          `Raw: ${raw}`
        : raw;
      post({ type: "error", id: req.id, error: msg });
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
