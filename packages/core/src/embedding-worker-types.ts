/**
 * Shared message types for the embedding worker thread.
 *
 * The embedding worker (`embedding-worker.ts`) runs ONNX inference via
 * `@huggingface/transformers` in a separate `node:worker_threads` Worker
 * so the main thread's event loop stays free during inference. This file
 * defines the message protocol between the main thread (`LocalProvider`
 * in `embedding.ts`) and the worker.
 *
 * Imported by both sides — keep this file free of runtime dependencies.
 */

// ---------------------------------------------------------------------------
// Main thread → Worker
// ---------------------------------------------------------------------------

/** Request an embedding batch. */
export interface EmbedRequest {
  type: "embed";
  /** Monotonic request ID for correlating responses. */
  id: number;
  /** Texts to embed (already prefixed with task instruction by the caller). */
  texts: string[];
  /** "document" for storage, "query" for search. */
  inputType: "document" | "query";
  /** "high" = recall queries (jump the queue), "normal" = backfill. */
  priority: "high" | "normal";
}

/** Ask the worker to exit cleanly. */
export interface ShutdownRequest {
  type: "shutdown";
}

export type WorkerInbound = EmbedRequest | ShutdownRequest;

// ---------------------------------------------------------------------------
// Worker → Main thread
// ---------------------------------------------------------------------------

/** Embedding result — vectors are Float32Array[], sent via structured clone. */
export interface EmbedResult {
  type: "result";
  /** Matches the request ID. */
  id: number;
  /** One Float32Array per input text. Sent via structured clone
   *  (Bun preserves Float32Array identity across threads). */
  vectors: Float32Array[];
}

/** A single embed request failed (ONNX error, etc.). */
export interface EmbedError {
  type: "error";
  /** Matches the request ID. */
  id: number;
  /** Human-readable error message. */
  error: string;
}

/** Model initialization failed inside the worker. All pending and future
 *  requests should be rejected — the worker is unusable. */
export interface InitError {
  type: "init-error";
  /** Human-readable error message. */
  error: string;
}

export type WorkerOutbound = EmbedResult | EmbedError | InitError;

// ---------------------------------------------------------------------------
// Error classification — shared between worker and main thread
// ---------------------------------------------------------------------------
// These functions classify ONNX/WASM error messages. Both the worker
// (embedding-worker.ts) and the main thread (embedding.ts) need the same
// logic. Keep them here to prevent drift — a duplicated regex set caused
// the original 11k-event storm (numeric OOM codes weren't classified as
// fatal on both sides).

/**
 * Detect ONNX runtime out-of-memory errors. The runtime throws opaque
 * numeric error codes (e.g. "287180544") for allocation failures rather
 * than a readable message. We match on large numeric-only strings and
 * known OOM patterns.
 */
export function isOomError(msg: string): boolean {
  // Pure numeric error codes ≥ 6 digits are ORT allocation failures
  if (/^\d{6,}$/.test(msg)) return true;
  // Explicit OOM messages from various ONNX backends
  if (/out.of.memory|alloc.*fail|oom/i.test(msg)) return true;
  return false;
}

/**
 * Detect fatal WASM/ONNX runtime errors that leave the session in an
 * unrecoverable state. These include:
 *   - WASM `abort()` calls ("Aborted(). Build with -sASSERTIONS...")
 *   - WASM RuntimeError ("unreachable", "memory access out of bounds")
 *   - ONNX runtime allocation failures (opaque numeric error codes like
 *     "284792864" ≈ 271 MiB). These represent model-init allocations
 *     that cannot succeed with smaller input — retrying is futile.
 *
 * After detecting a fatal error, the worker should exit so the main
 * thread's `on("exit")` handler marks the provider as broken.
 */
export function isWasmFatalError(msg: string): boolean {
  // Recognize the wrapper prefix the worker adds before process.exit(1).
  // The main thread receives "WASM fatal error (worker exiting): <raw>"
  // and must classify it as fatal to create LocalProviderUnavailableError
  // instead of a plain Error in the on("message") handler.
  if (/WASM fatal error/i.test(msg)) return true;
  // WASM abort() — "Aborted(). Build with -sASSERTIONS for more info."
  if (/\bAborted\b/i.test(msg)) return true;
  // RuntimeError from WASM (e.g. "unreachable", "memory access out of bounds")
  if (/\bRuntimeError\b/.test(msg)) return true;
  // ONNX runtime allocation failures — opaque numeric codes (e.g. "284792864").
  // These are model-init-time OOMs, not input-size-driven, so truncation
  // retries cannot help. Treat as fatal to stop the event storm.
  if (isOomError(msg)) return true;
  // Callable-pattern failure safety net (LOREAI-GATEWAY-10):
  // @huggingface/transformers uses Object.setPrototypeOf to make pipeline
  // instances callable. Under esbuild CJS + Node v24, this can fail
  // silently — the pipeline object is truthy but not a function. The
  // primary fix is the `typeof pipe !== "function"` guard in
  // embedding-worker.ts that throws at construction time, so the worker
  // exits cleanly on first init. This regex is a backstop for any code
  // path where the guard didn't fire — classify the failure as fatal so
  // the main thread marks the provider broken and stops retrying.
  if (/is not a function/.test(msg)) return true;
  return false;
}

/**
 * Detect a corrupt / incomplete model file on disk. The most common cause is a
 * truncated HF Hub download (e.g. a 137MB ONNX model where only 87MB was written
 * before the connection dropped): the file header parses but the protobuf body
 * is incomplete, so ONNX reports "Protobuf parsing failed" / "Load model …
 * failed". Unlike OOM or WASM aborts (environmental, non-recoverable in-process),
 * these are recoverable: deleting the cached file and re-downloading fixes them.
 * The worker uses this to self-heal a bad download instead of bricking embeddings
 * until the next manual intervention.
 *
 * IMPORTANT: this gates a destructive purge + re-download. A false positive on a
 * transient *download* failure (401/403/404/network) would cause a
 * purge→redownload→fail→purge loop that never converges and hammers the Hub. So
 * we explicitly exclude auth/HTTP-status/network errors, and only treat an
 * ONNX-side *parse/deserialize* failure of an already-downloaded file as corrupt
 * (the "load model … failed" branch additionally requires a parse signal).
 */
export function isCorruptModelError(msg: string): boolean {
  // Exclude transient download/auth/network failures — these are NOT on-disk
  // corruption and must not trigger a purge (would loop forever). Covers the
  // real transformers.js download-failure strings ("Unauthorized access to
  // file", "Could not locate file") and common network errors. HTTP status
  // codes are matched only in an explicit status/error context to avoid hitting
  // arbitrary 3-digit numbers in paths/sizes.
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
  // ONNX "load model … failed" only counts as corruption when accompanied by a
  // parse/deserialize signal — a bare "load model failed" can be a download/IO
  // error, which the exclusion above already filters but we keep this tight.
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
 * Resolve the on-disk cache directory for a model, given transformers.js's
 * `env.cacheDir` and the HF model id. transformers.js stores files at
 * `<cacheDir>/<modelId>/<file>` (e.g.
 * `<cacheDir>/nomic-ai/nomic-embed-text-v1.5/onnx/model_quantized.onnx`), so the
 * model's directory is `<cacheDir>/<...modelId segments>`. Pure (no fs access)
 * so it can be unit-tested; the worker passes the result to an `rm(recursive)`.
 *
 * Returns null when inputs are unusable (empty cacheDir/modelId), signalling the
 * caller that there is nothing safe to purge.
 */
export function resolveModelCacheDir(
  cacheDir: string | undefined | null,
  modelId: string,
): string | null {
  if (!cacheDir || !modelId) return null;
  const segments = modelId.split("/").filter((s) => s.length > 0);
  if (segments.length === 0) return null;
  const base = cacheDir.replace(/[/\\]+$/, "");
  return `${base}/${segments.join("/")}`;
}

/**
 * Decide whether a failed pipeline init should trigger the self-heal path
 * (purge cached model + retry download once). Heal only when the model is NOT
 * vendored (npm mode — re-downloadable) AND the error indicates on-disk
 * corruption. Vendored binaries ship a read-only model that must not be deleted.
 * Pure predicate, extracted for testability.
 */
export function shouldHealCorruptModel(
  isVendored: boolean,
  errorMessage: string,
): boolean {
  return !isVendored && isCorruptModelError(errorMessage);
}

// ---------------------------------------------------------------------------
// workerData contract
// ---------------------------------------------------------------------------

/** Passed to the worker via `workerData` at construction time. */
export interface WorkerInitData {
  /** HuggingFace model ID, e.g. "nomic-ai/nomic-embed-text-v1.5". */
  modelId: string;
  /** Target embedding dimensions. For Nomic v1.5 with Matryoshka,
   *  this controls how many leading dims to keep (64–768). */
  dimensions: number;
  /** Vendored model info for binary mode, or null for npm mode.
   *  In binary mode, model files are pre-extracted to a local dir
   *  and we point transformers.js at that path instead of downloading
   *  from HuggingFace Hub. */
  vendorModel: {
    /** Absolute path to the dir containing model files
     *  (config.json, tokenizer.json, onnx/model_quantized.onnx, …). */
    localModelPath: string;
  } | null;
}
