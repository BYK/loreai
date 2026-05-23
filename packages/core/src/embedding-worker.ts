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
} from "./embedding-worker-types";

// ---------------------------------------------------------------------------
// workerData
// ---------------------------------------------------------------------------

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
// Model lifecycle — lazy init on first embed request
// ---------------------------------------------------------------------------

/** The transformers.js pipeline instance, typed loosely since the exact
 *  return type depends on the pipeline task. */
type FeatureExtractionPipeline = {
  (texts: string[], options?: Record<string, unknown>): Promise<{
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
let layerNormFn: ((input: unknown, normalized_shape: number[]) => {
  dims: number[];
  data: Float32Array;
  normalize(p: number, dim: number): { tolist(): number[][]; data: Float32Array; dims: number[] };
  slice(...args: unknown[]): { normalize(p: number, dim: number): { tolist(): number[][]; data: Float32Array; dims: number[] } };
}) | null = null;
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
  if (initFailed) throw new Error(initError ?? "pipeline init previously failed");

  if (!initPromise) {
    initPromise = (async () => {
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

      // Stash a reference to the pipeline's tokenizer for token-level
      // truncation during OOM retries.
      tokenizer = (pipe as unknown as { tokenizer: typeof tokenizer }).tokenizer;

      layerNormFn = layer_norm as typeof layerNormFn;
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

  while (queue.length > 0) {
    const req = queue.shift()!;
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
  if (!tokenizer) return texts;
  return texts.map((text) => {
    if (text.length <= maxTokens) return text;
    // Exclude [CLS]/[SEP] special tokens so ids.length reflects pure content
    // token count — otherwise the 2 extra tokens skew the limit check.
    const ids = tokenizer!.encode(text, { add_special_tokens: false });
    if (ids.length <= maxTokens) return text;
    return tokenizer!.decode(ids.slice(0, maxTokens), {
      skip_special_tokens: true,
    });
  });
}

/**
 * Detect ONNX runtime out-of-memory errors. The runtime throws opaque
 * numeric error codes (e.g. "287180544") for allocation failures rather
 * than a readable message. We match on large numeric-only strings and
 * known OOM patterns.
 */
function isOomError(msg: string): boolean {
  // Pure numeric error codes ≥ 6 digits are ORT allocation failures
  if (/^\d{6,}$/.test(msg)) return true;
  // Explicit OOM messages from various ONNX backends
  if (/out.of.memory|alloc.*fail|oom/i.test(msg)) return true;
  return false;
}

/**
 * Detect fatal WASM runtime errors that leave the ONNX session in an
 * unrecoverable state. Unlike OOM (which can be retried with smaller
 * input), these indicate the WASM module has called `abort()` — all
 * subsequent inference calls will also fail.
 *
 * After detecting a fatal error, the worker should exit so the main
 * thread's `on("exit")` handler marks the provider as broken.
 */
function isWasmFatalError(msg: string): boolean {
  // WASM abort() — "Aborted(). Build with -sASSERTIONS for more info."
  if (/\bAborted\b/i.test(msg)) return true;
  // RuntimeError from WASM (e.g. "unreachable", "memory access out of bounds")
  if (/\bRuntimeError\b/.test(msg)) return true;
  return false;
}

/** Run inference on `texts` and return per-text vectors. */
async function runInference(texts: string[]): Promise<Float32Array[]> {
  // Run feature extraction with mean pooling.
  // truncation: true caps each text at the model's max length (8192 tokens
  // for Nomic v1.5) as a last-resort safety net.
  const output = await pipe!(texts, { pooling: "mean", truncation: true });

  // Post-process following Nomic's recipe:
  //   1. Layer normalization over the full hidden dimension
  //   2. Matryoshka truncation to target dimensions
  //   3. L2 normalization
  const fullDim = output.dims[output.dims.length - 1]; // 768 for Nomic v1.5
  const truncate = dimensions < fullDim;

  let normalized: { tolist(): number[][]; data: Float32Array; dims: number[] };
  if (truncate) {
    // layer_norm → slice → L2 normalize
    normalized = layerNormFn!(output, [fullDim])
      .slice(null, [0, dimensions])
      .normalize(2, -1);
  } else {
    // layer_norm → L2 normalize (no truncation)
    normalized = layerNormFn!(output, [fullDim])
      .normalize(2, -1);
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
        post({ type: "error", id: req.id, error: `WASM fatal error (worker exiting): ${raw}` });
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
  }
}

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------

function post(msg: WorkerOutbound): void {
  parentPort!.postMessage(msg);
}

parentPort!.on("message", (msg: WorkerInbound) => {
  switch (msg.type) {
    case "embed":
      enqueue(msg);
      break;
    case "shutdown":
      process.exit(0);
      break;
  }
});
