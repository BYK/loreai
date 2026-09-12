/** Shared embedding contracts and cancellation helpers. */

import type { WorkerInbound } from "../embedding-worker-types";

export const WORKER_SHUTDOWN_TIMEOUT_MS = 1_500;

/**
 * Cooperative cancellation controls for bounded embedding phases. `deadlineMs` is a duration from
 * invocation, matching the existing shutdown deadline convention in this module.
 */
export interface EmbeddingOperationOptions {
  signal?: AbortSignal;
  deadlineMs?: number;
}

/** Stable phase names for orchestration callers (notably semantic lint). */
export type EmbeddingAbortPhase =
  | "provider-readiness"
  | "settle-document-embeds"
  | "knowledge-backfill";

export type EmbeddingAbortCode = "aborted" | "deadline-exceeded";

/** Typed cooperative-stop signal for embedding work. */
export class EmbeddingAbortError extends Error {
  readonly code: EmbeddingAbortCode;
  readonly phase: EmbeddingAbortPhase;

  constructor(
    phase: EmbeddingAbortPhase,
    code: EmbeddingAbortCode,
    cause?: unknown,
  ) {
    super(
      code === "deadline-exceeded"
        ? `Embedding phase '${phase}' exceeded its deadline`
        : `Embedding phase '${phase}' was aborted`,
    );
    this.name = "EmbeddingAbortError";
    this.code = code;
    this.phase = phase;
    if (cause !== undefined)
      (this as Error & { cause?: unknown }).cause = cause;
  }
}

export interface EmbeddingAbortGuard {
  phase: EmbeddingAbortPhase;
  signal?: AbortSignal;
  deadlineAt?: number;
}

function abortCodeForReason(reason: unknown): EmbeddingAbortCode {
  if (reason instanceof EmbeddingAbortError) return reason.code;
  if (
    typeof reason === "object" &&
    reason !== null &&
    "name" in reason &&
    reason.name === "TimeoutError"
  ) {
    return "deadline-exceeded";
  }
  return "aborted";
}

export function createEmbeddingAbortGuard(
  phase: EmbeddingAbortPhase,
  options: EmbeddingOperationOptions,
): EmbeddingAbortGuard {
  const deadlineMs = options.deadlineMs;
  if (
    deadlineMs !== undefined &&
    (!Number.isFinite(deadlineMs) || deadlineMs < 0)
  ) {
    throw new RangeError(
      "embedding deadlineMs must be a finite non-negative number",
    );
  }
  return {
    phase,
    signal: options.signal,
    deadlineAt: deadlineMs === undefined ? undefined : Date.now() + deadlineMs,
  };
}

function currentEmbeddingAbort(
  guard: EmbeddingAbortGuard,
): EmbeddingAbortError | null {
  if (guard.signal?.aborted) {
    return new EmbeddingAbortError(
      guard.phase,
      abortCodeForReason(guard.signal.reason),
      guard.signal.reason,
    );
  }
  if (guard.deadlineAt !== undefined && Date.now() >= guard.deadlineAt) {
    return new EmbeddingAbortError(guard.phase, "deadline-exceeded");
  }
  return null;
}

export function throwIfEmbeddingAborted(guard: EmbeddingAbortGuard): void {
  const error = currentEmbeddingAbort(guard);
  if (error) throw error;
}

/** Race already-scheduled work against the caller's cancellation boundary. */
export async function awaitEmbeddingOperation<T>(
  work: Promise<T>,
  guard: EmbeddingAbortGuard,
): Promise<T> {
  const alreadyAborted = currentEmbeddingAbort(guard);
  if (alreadyAborted) {
    // The caller created `work` immediately before this check. Observe any later
    // rejection even though orchestration is stopping, avoiding an unhandled
    // worker/API rejection after the lint deadline has already been reported.
    void work.catch(() => {});
    throw alreadyAborted;
  }
  if (!guard.signal && guard.deadlineAt === undefined) return await work;

  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    if (guard.signal) {
      onAbort = () => {
        reject(
          new EmbeddingAbortError(
            guard.phase,
            abortCodeForReason(guard.signal?.reason),
            guard.signal?.reason,
          ),
        );
      };
      guard.signal.addEventListener("abort", onAbort, { once: true });
    }
    if (guard.deadlineAt !== undefined) {
      timer = setTimeout(
        () => {
          reject(new EmbeddingAbortError(guard.phase, "deadline-exceeded"));
        },
        Math.max(0, guard.deadlineAt - Date.now()),
      );
    }
  });

  try {
    return await Promise.race([work, aborted]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort && guard.signal) {
      guard.signal.removeEventListener("abort", onAbort);
    }
  }
}

export interface EmbeddingProvider {
  embed(
    texts: string[],
    inputType: "document" | "query",
    signal?: AbortSignal,
  ): Promise<Float32Array[]>;
  readonly maxBatchSize: number;
}

/** Cause-free privacy boundary for provider-controlled failures. */
export class EmbeddingProviderError extends Error {
  declare readonly status?: number;

  constructor(message = "Embedding provider failed", status?: number) {
    super(message);
    Object.defineProperty(this, "name", {
      configurable: true,
      value: "EmbeddingProviderError",
    });
    if (status !== undefined) {
      Object.defineProperty(this, "status", {
        configurable: true,
        value: status,
      });
    }
  }
}

export class LocalProviderUnavailableError extends Error {
  constructor(cause?: unknown) {
    super(
      "Local embedding provider unavailable: '@huggingface/transformers' failed to initialize. " +
        "Recall will use FTS-only search. To use a remote provider instead, set " +
        "search.embeddings.provider to 'voyage' or 'openai' in .lore.json " +
        "and provide the corresponding API key (VOYAGE_API_KEY / OPENAI_API_KEY).",
    );
    this.name = "LocalProviderUnavailableError";
    if (cause instanceof EmbeddingWorkerWatchdogError) {
      Object.defineProperty(this, "cause", {
        configurable: true,
        value: new EmbeddingWorkerWatchdogError(cause.stage),
      });
    }
  }
}

/** A caller stopped waiting for an embedding request. */
export class EmbeddingRequestAbortedError extends Error {
  constructor() {
    super("Embedding request aborted");
    this.name = "EmbeddingRequestAbortedError";
  }
}

/** The host-owned local queue hit its bounded count or byte budget. */
export class EmbeddingQueueCapacityError extends Error {
  constructor() {
    super("Embedding queue capacity exceeded");
    this.name = "EmbeddingQueueCapacityError";
  }
}

/** The worker exceeded its own initialization or execution lifetime. */
export class EmbeddingWorkerWatchdogError extends Error {
  readonly stage: "init" | "execution";

  constructor(stage: "init" | "execution") {
    super(`Embedding worker ${stage} watchdog expired`);
    this.name = "EmbeddingWorkerWatchdogError";
    this.stage = stage;
  }
}

export interface ShutdownableWorker {
  on(event: "exit", listener: () => void): unknown;
  postMessage(value: WorkerInbound): void;
  terminate(): Promise<number>;
}

/**
 * Ask a worker to exit cooperatively, but never wait longer than `timeoutMs`: on timeout,
 * force-`terminate()` it.
 */
export function awaitWorkerShutdown(
  worker: ShutdownableWorker,
  timeoutMs: number,
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
          new Error("embedding worker termination was not confirmed", {
            cause,
          }),
        );
      });
    };
    // Hard cap: if the worker is mid-inference (an uninterruptible
    // single-threaded ONNX batch) and never emits "exit", force-terminate it
    // so process shutdown can't hang. Terminating is safe — all SQLite state
    // lives on the main thread; the worker is stateless.
    const killTimer = setTimeout(forceTerminate, Math.max(0, timeoutMs));
    killTimer.unref?.();

    worker.on("exit", finish);
    try {
      worker.postMessage({ type: "shutdown" } satisfies WorkerInbound);
    } catch {
      // Posting can also fail during a termination race. Ask Node to terminate
      // and use that promise as the authoritative exit confirmation.
      forceTerminate();
    }
  });
}

export function isRecallEmbed(
  texts: string[],
  inputType: "document" | "query",
): boolean {
  return inputType === "query" && texts.length === 1;
}

export function l2Normalize(vec: Float32Array): Float32Array {
  let sumSq = 0;
  for (let i = 0; i < vec.length; i++) sumSq += vec[i] * vec[i];
  const norm = Math.sqrt(sumSq);
  if (!(norm > 0) || !Number.isFinite(norm)) return vec;
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / norm;
  return out;
}
