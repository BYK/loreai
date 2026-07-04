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
  /** Per-request override of the worker's token cap. Lets the main thread
   *  RAISE the cap (after a freemem-gated re-probe) without respawning the
   *  worker. Falls back to the workerData cap when absent. OOM-driven cap
   *  LOWERING still respawns (fresh heap); only upward nudges ride this. */
  maxTokens?: number;
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
// Worker exit codes
// ---------------------------------------------------------------------------

/**
 * Worker process exit code signalling an input-size-driven ONNX OOM that is
 * recoverable by respawning with a lower token cap (fresh WASM heap). The main
 * thread's `on("exit")` handler distinguishes this from a genuine fatal exit
 * (code 1) and drives the halve-and-respawn backoff (see `LocalProvider` in
 * embedding.ts) instead of latching the provider broken. Picked in the
 * application-defined range, clear of Node's own conventions (0, 1, 128+n).
 */
export const EMBED_OOM_EXIT_CODE = 75;

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
 *     "284792864" ≈ 271 MiB).
 *
 * Note on OOM: numeric ORT allocation failures are predominantly
 * *inference-time, input-size-driven* — a long sequence's O(L²) attention
 * tensor blows the WASM heap. They are NOT model-init failures. They look
 * unrecoverable to an *in-process* retry only because WASM linear memory
 * never shrinks: once the first oversized allocation grows the heap, every
 * smaller retry in the same worker also fails. The real recovery is to
 * respawn the worker (fresh heap) at a lower token cap — driven by the
 * `EMBED_OOM_EXIT_CODE` backoff in embedding.ts, not by in-process truncation.
 * `isWasmFatalError` still returns true for OOM as a defensive backstop for
 * any OOM that surfaces as a *posted* error rather than the exit-code path.
 *
 * After detecting a genuinely fatal error, the worker exits so the main
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
  // Defensive backstop only: the primary OOM path exits with
  // EMBED_OOM_EXIT_CODE and is handled by the halve-and-respawn backoff. This
  // classifies any OOM that surfaces as a *posted* error as fatal so a stray
  // OOM message still degrades cleanly instead of re-creating an event storm.
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
 * Detect that the OPTIONAL local-embedding stack is simply not installed, as
 * opposed to installed-but-broken. `@huggingface/transformers` (and its native
 * transitive deps `onnxruntime-node` / `onnxruntime-web` / `sharp`) is an
 * `optionalDependency` of `@loreai/core` (#1026): a consumer on remote
 * embeddings — or the SEA binary, which ships its own runtime — can install
 * with `--omit=optional` and drop ~480 MB of ML runtime. When absent, the
 * worker's `import("@huggingface/transformers")` (or, since transformers is
 * bundled, its transitive `require("onnxruntime-node")`) throws a module-/
 * package-not-found error rather than a runtime crash.
 *
 * We surface THIS as an expected, actionable degraded state (warn → FTS-only),
 * distinct from a genuine init failure (error). Match requires BOTH a
 * module-not-found signal AND a reference to one of the optional packages, so an
 * unrelated resolution error (e.g. a missing model file) is never misclassified.
 */
export function isMissingLocalStackError(msg: string): boolean {
  const moduleNotFound =
    /ERR_MODULE_NOT_FOUND|Cannot find (?:module|package)|Could not locate the bindings file/i.test(
      msg,
    );
  if (!moduleNotFound) return false;
  return /@huggingface\/transformers|onnxruntime|\bsharp\b/i.test(msg);
}

/**
 * The two leading strings transformers.js' `sessionRun()` (models.js) passes to
 * `console.error` when `session.run` throws, before it re-throws: the error
 * message, and a dump of every input tensor's metadata AND `.data`. For our
 * feature-extraction pipeline that data is `input_ids` / `attention_mask` /
 * `token_type_ids` — thousands of token IDs (~21K values at the 8192-token cap).
 *
 * A memory-driven OOM is an EXPECTED, recovered event in this worker (the main
 * thread drives the ×0.7 cap backoff + fresh-heap respawn), so on a cold start
 * this dumps ~60 lines of noise 1–2× before the cap converges. It is emitted by
 * transformers.js — NOT the ORT C++ logger — so `logSeverityLevel` does not gate
 * it; the only lever is filtering these lines. Matching is by leading string so
 * the interpolated error text is irrelevant; if a future transformers release
 * renames them the dump merely reappears (no functional change).
 */
export const TRANSFORMERS_INFERENCE_DUMP_PREFIXES = [
  "An error occurred during model execution:",
  "Inputs given to model:",
] as const;

/**
 * True when `arg` is the first argument of one of transformers.js'
 * inference-error `console.error` dump lines (see
 * {@link TRANSFORMERS_INFERENCE_DUMP_PREFIXES}). Used by the worker to drop that
 * dump for the duration of a single (expected-to-maybe-OOM) inference. Non-string
 * args (e.g. the formatted-inputs object) never match — only the leading string
 * line is tested, and dropping it takes its trailing object with it.
 */
export function isTransformersInferenceDumpLine(arg: unknown): boolean {
  return (
    typeof arg === "string" &&
    TRANSFORMERS_INFERENCE_DUMP_PREFIXES.some((p) => arg.startsWith(p))
  );
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

/** Minimum plausible size for a real ONNX model file. A truncated/aborted
 *  download, an empty file, or an HTML error page saved as the model is far
 *  smaller (the nomic q8 model is ~137 MB). Used to distinguish a genuinely
 *  corrupt/partial file (safe to purge + re-download) from a transient parse
 *  failure of an INTACT file (must NOT be destroyed — a failed re-download,
 *  e.g. offline, would leave us worse off). */
export const MIN_ONNX_FILE_BYTES = 1024 * 1024; // 1 MiB

/**
 * True when an on-disk ONNX file looks structurally intact: plausibly sized AND
 * beginning with the ONNX/protobuf header byte. A serialized ONNX ModelProto
 * starts with field 1 (`ir_version`), whose protobuf wire tag is `0x08`; a
 * truncated head, an empty file, or a non-protobuf payload (HTML error page)
 * fails this. Pure predicate (the worker performs the fs read); extracted for
 * testability. When this is true a parse failure was almost certainly transient,
 * so the corrupt-model self-heal must NOT purge the file.
 */
export function looksLikeIntactOnnxFile(
  sizeBytes: number,
  firstByte: number | undefined,
): boolean {
  return sizeBytes >= MIN_ONNX_FILE_BYTES && firstByte === 0x08;
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
  /** Maximum input sequence length (in tokens) the worker will feed to the
   *  model. Every batch is truncated to this ceiling (real tokenizer) before
   *  the single inference attempt. Owned and adapted by the main thread
   *  (LocalProvider): it starts at a memory-aware estimate and is lowered ×0.7
   *  on each fresh-heap respawn after an OOM. Capping sequence length up-front
   *  bounds the O(L²) attention allocation and keeps a constrained host out of
   *  swap. */
  maxTokens: number;
  /** Intra-op thread count for native ONNX Runtime, or `undefined` to leave
   *  ORT's own (host-core-sized) default in place. Computed on the main thread
   *  via `nativeIntraOpThreads()` (the worker runs as raw .ts and can't
   *  value-import `ort-native` — same constraint as the stderr-silence flag
   *  below): caps intra-op threads to the cgroup CPU quota only when the process
   *  is genuinely CPU-restricted, else `undefined` (a strict no-op). The worker
   *  applies it on the native path only; WASM is already single-threaded. */
  intraOpThreads?: number;
  /** Vendored model info for binary mode, or null for npm mode.
   *  In binary mode, model files are pre-extracted to a local dir
   *  and we point transformers.js at that path instead of downloading
   *  from HuggingFace Hub. */
  vendorModel: {
    /** Absolute path to the dir containing model files
     *  (config.json, tokenizer.json, onnx/model_quantized.onnx, …). */
    localModelPath: string;
  } | null;
  /** Snapshot of the host's stderr-silence state at spawn time. A worker thread
   *  has its OWN `globalThis`, so the main thread's `log.silenceStderr()`
   *  process-global can't reach it — we pass the value explicitly instead. When
   *  true (the plugin/in-process-gateway TUI mode), the worker must not write a
   *  single byte to stderr, which would corrupt the host's full-screen render.
   *  The worker gates its `console.warn` diagnostics on this flag inline (it runs
   *  as raw .ts and can't value-import siblings — see embedding-worker.ts). */
  stderrSilenced?: boolean;
}
