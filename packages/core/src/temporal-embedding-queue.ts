import { createHash } from "node:crypto";
import { config } from "./config";
import { db, withSavepoint } from "./db";
import {
  readStorageMode,
  storeEmbedding,
  storeTemporalChunks,
  type VecStorageMode,
} from "./db/vec-store";
import * as embedding from "./embedding";
import {
  buildEmbeddingUnits,
  MAX_TEMPORAL_CHUNKS_PER_MESSAGE,
  TEMPORAL_EMBEDDING_MIN_CONTENT_LENGTH,
} from "./embedding-units";
import * as log from "./log";
import {
  invalidateTemporalEmbedding,
  temporalContentHash,
  temporalEmbeddingFingerprint,
} from "./temporal-embedding-admission";

export {
  enqueueTemporalEmbedding,
  temporalContentHash,
  temporalEmbeddingFingerprint,
} from "./temporal-embedding-admission";

const MAX_MESSAGES_PER_DRAIN = 8;
const MAX_CONTENT_BYTES_PER_DRAIN = 256 * 1024;
const HASH_CHUNK_BYTES = 16 * 1024;
const IDLE_DRAIN_INTERVAL_MS = 250;
const UNAVAILABLE_DRAIN_INTERVAL_MS = 30_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const FAILURE_RETRY_BASE_MS = 1_000;
const FAILURE_RETRY_MAX_MS = 30_000;

interface DrainDiagnostics {
  stage: "read" | "prepare" | "embed" | "validate" | "commit";
  startedAt: number;
  messages: number;
  inputBytes: number;
  units: number;
  providerUnavailable: boolean;
  abortReason?: "deadline" | "shutdown";
}

interface QueueRow {
  message_id: string;
  content_hash: string;
  fingerprint: string;
  content: string;
  content_bytes: number;
}

interface QueueCandidate extends Omit<QueueRow, "content"> {
  content_bytes: number;
}

interface CapturedJob extends QueueRow {
  texts: string[];
  storageMode: VecStorageMode;
}

let schedulerStarted = false;
let schedulerTimer: ReturnType<typeof setTimeout> | undefined;
let activeDrain: Promise<number> | undefined;
let activeDrainAbort: AbortController | undefined;
let activeDiagnostics: DrainDiagnostics | undefined;
let schedulerGeneration = 0;
let consecutiveFailures = 0;
let failureRetryMs = 0;
let requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS;
const drainSettlers = new Set<() => void>();

function embeddingTexts(content: string, mode: VecStorageMode): string[] {
  if (content.length < TEMPORAL_EMBEDDING_MIN_CONTENT_LENGTH) return [];
  let texts = buildEmbeddingUnits(content)
    .map((unit) => unit.text.trim())
    .filter((text) => text.length > 0);
  if (!texts.length) return [];
  if (mode === "blob") return [texts.join("\n")];
  if (texts.length > MAX_TEMPORAL_CHUNKS_PER_MESSAGE) {
    texts = [
      ...texts.slice(0, MAX_TEMPORAL_CHUNKS_PER_MESSAGE - 1),
      texts.slice(MAX_TEMPORAL_CHUNKS_PER_MESSAGE - 1).join("\n"),
    ];
  }
  return texts;
}

function storedContentHash(messageId: string): string | null {
  const row = db()
    .query(
      "SELECT length(CAST(content AS BLOB)) AS n FROM temporal_messages WHERE id = ?",
    )
    .get(messageId) as { n: number } | null;
  if (!row) return null;
  const hash = createHash("sha256");
  for (let offset = 1; offset <= row.n; offset += HASH_CHUNK_BYTES) {
    const chunk = db()
      .query(
        `SELECT substr(CAST(content AS BLOB), ?, ?) AS value
         FROM temporal_messages WHERE id = ?`,
      )
      .get(offset, HASH_CHUNK_BYTES, messageId) as {
      value: Uint8Array;
    } | null;
    if (!chunk) return null;
    hash.update(chunk.value);
  }
  return hash.digest("hex");
}

function decodeContentPrefix(value: Uint8Array, truncated: boolean): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(value, {
    stream: truncated,
  });
}

function refreshStaleQueueRow(
  row: QueueRow,
  currentHash: string,
  currentFingerprint: string,
): void {
  db()
    .query(
      `UPDATE temporal_embedding_queue
       SET content_hash = ?, fingerprint = ?, enqueued_at = ?
       WHERE message_id = ? AND content_hash = ? AND fingerprint = ?`,
    )
    .run(
      currentHash,
      currentFingerprint,
      Date.now(),
      row.message_id,
      row.content_hash,
      row.fingerprint,
    );
}

function clearTemporalEmbedding(messageId: string): void {
  invalidateTemporalEmbedding(messageId);
}

function validateVectors(vectors: Float32Array[]): void {
  const dimensions = config().search.embeddings.dimensions;
  const valid = vectors.every(
    (vector) =>
      vector instanceof Float32Array &&
      vector.length === dimensions &&
      vector.every(Number.isFinite),
  );
  if (!valid) {
    throw new Error("temporal embedding produced an invalid vector");
  }
}

function commitJob(job: CapturedJob, vectors: Float32Array[]): boolean {
  let committed = false;
  withSavepoint("commit_temporal_embedding", () => {
    const current = db()
      .query(
        `SELECT q.content_hash, q.fingerprint
         FROM temporal_embedding_queue q
         JOIN temporal_messages t ON t.id = q.message_id
         WHERE q.message_id = ?`,
      )
      .get(job.message_id) as {
      content_hash: string;
      fingerprint: string;
    } | null;
    if (!current) return;
    if (
      current.content_hash !== job.content_hash ||
      current.fingerprint !== job.fingerprint ||
      storedContentHash(job.message_id) !== job.content_hash ||
      temporalEmbeddingFingerprint() !== job.fingerprint ||
      readStorageMode(db()) !== job.storageMode
    ) {
      return;
    }

    if (!job.texts.length) {
      clearTemporalEmbedding(job.message_id);
    } else if (job.storageMode === "vec0") {
      storeTemporalChunks(db(), job.message_id, vectors);
    } else {
      const vector = vectors[0];
      if (!vector || vectors.length !== 1) {
        throw new Error(
          "temporal embedding produced an invalid blob vector set",
        );
      }
      storeEmbedding(db(), "temporal", job.message_id, vector);
    }

    const deleted = db()
      .query(
        `DELETE FROM temporal_embedding_queue
         WHERE message_id = ? AND content_hash = ? AND fingerprint = ?`,
      )
      .run(job.message_id, job.content_hash, job.fingerprint);
    committed = deleted.changes === 1;
  });
  return committed;
}

async function drainOnce(
  signal: AbortSignal,
  diagnostics: DrainDiagnostics,
): Promise<number> {
  const candidates = db()
    .query(
      `SELECT q.message_id, q.content_hash, q.fingerprint,
              length(CAST(t.content AS BLOB)) AS content_bytes
       FROM temporal_embedding_queue q
       JOIN temporal_messages t ON t.id = q.message_id
       ORDER BY q.enqueued_at ASC, q.message_id ASC
       LIMIT ?`,
    )
    .all(MAX_MESSAGES_PER_DRAIN) as unknown as QueueCandidate[];
  if (!candidates.length) return 0;

  let admittedBytes = 0;
  const admitted = candidates.filter((candidate, index) => {
    if (
      index > 0 &&
      admittedBytes + candidate.content_bytes > MAX_CONTENT_BYTES_PER_DRAIN
    ) {
      return false;
    }
    admittedBytes += candidate.content_bytes;
    return true;
  });
  const placeholders = admitted.map(() => "?").join(",");
  diagnostics.messages = admitted.length;
  const contentById = new Map(
    (
      db()
        .query(
          `SELECT id,
                   CASE
                     WHEN length(CAST(content AS BLOB)) > ?
                       THEN substr(CAST(content AS BLOB), 1, ?)
                     ELSE CAST(content AS BLOB)
                   END AS content_bytes
              FROM temporal_messages WHERE id IN (${placeholders})`,
        )
        .all(
          MAX_CONTENT_BYTES_PER_DRAIN,
          MAX_CONTENT_BYTES_PER_DRAIN,
          ...admitted.map((candidate) => candidate.message_id),
        ) as Array<{
        id: string;
        content_bytes: Uint8Array;
      }>
    ).map((row) => [row.id, row.content_bytes]),
  );
  diagnostics.inputBytes = [...contentById.values()].reduce(
    (sum, bytes) => sum + bytes.byteLength,
    0,
  );
  diagnostics.stage = "prepare";
  const rows = admitted
    .map((candidate): QueueRow | null => {
      const contentBytes = contentById.get(candidate.message_id);
      if (contentBytes === undefined) return null;
      return {
        ...candidate,
        content: decodeContentPrefix(
          contentBytes,
          candidate.content_bytes > contentBytes.byteLength,
        ),
      };
    })
    .filter((row): row is QueueRow => row !== null);

  const fingerprint = temporalEmbeddingFingerprint();
  const mode = readStorageMode(db());
  const jobs = rows
    .filter((row) => {
      const currentHash =
        row.content_bytes <= MAX_CONTENT_BYTES_PER_DRAIN
          ? temporalContentHash(row.content)
          : storedContentHash(row.message_id);
      if (!currentHash) return false;
      if (currentHash === row.content_hash && row.fingerprint === fingerprint) {
        return true;
      }
      refreshStaleQueueRow(row, currentHash, fingerprint);
      return false;
    })
    .map((row) => ({
      ...row,
      storageMode: mode,
      texts: embeddingTexts(row.content, mode),
    }));
  if (!jobs.length) return 0;

  const emptyJobs = jobs.filter((job) => job.texts.length === 0);
  const embeddingJobs = jobs.filter((job) => job.texts.length > 0);
  const texts = embeddingJobs.flatMap((job) => job.texts);
  diagnostics.units = texts.length;
  diagnostics.stage = "embed";
  if (texts.length > 0 && !embedding.isAvailable()) {
    diagnostics.providerUnavailable = true;
    return 0;
  }
  const vectors =
    texts.length > 0
      ? await embedding.embedInTokenBatches(texts, "document", signal)
      : [];
  if (signal.aborted) {
    throw new embedding.EmbeddingRequestAbortedError();
  }
  diagnostics.stage = "validate";
  validateVectors(vectors);

  diagnostics.stage = "commit";
  let committed = emptyJobs.reduce(
    (count, job) => count + (commitJob(job, []) ? 1 : 0),
    0,
  );
  let offset = 0;
  committed += embeddingJobs.reduce((count, job) => {
    const jobVectors = vectors.slice(offset, offset + job.texts.length);
    offset += job.texts.length;
    if (jobVectors.length !== job.texts.length) {
      throw new Error("temporal embedding produced an invalid vector set");
    }
    return count + (commitJob(job, jobVectors) ? 1 : 0);
  }, 0);
  return committed;
}

/** Drain at most eight oldest queued messages. Concurrent calls share one drain. */
export function drainTemporalEmbeddingQueueOnce(): Promise<number> {
  if (activeDrain) return activeDrain;
  const abort = new AbortController();
  activeDrainAbort = abort;
  const diagnostics: DrainDiagnostics = {
    stage: "read",
    startedAt: performance.now(),
    messages: 0,
    inputBytes: 0,
    units: 0,
    providerUnavailable: false,
  };
  activeDiagnostics = diagnostics;
  const timer = setTimeout(() => {
    if (abort.signal.aborted) return;
    diagnostics.abortReason = "deadline";
    abort.abort(new Error("temporal embedding request deadline exceeded"));
  }, requestTimeoutMs);
  timer.unref?.();
  activeDrain = drainOnce(abort.signal, diagnostics).finally(() => {
    clearTimeout(timer);
    if (activeDrainAbort === abort) {
      activeDrainAbort = undefined;
      activeDiagnostics = undefined;
    }
    activeDrain = undefined;
    const settlers = [...drainSettlers];
    drainSettlers.clear();
    settlers.forEach((settle) => settle());
  });
  return activeDrain;
}

/** Never inspect or stringify arbitrary exception properties, including causes. */
function failureReason(error: unknown, diagnostics: DrainDiagnostics): string {
  if (diagnostics.abortReason === "deadline") return "deadline";
  // Even instanceof can throw for an untrusted Proxy rejection value.
  try {
    if (error instanceof embedding.EmbeddingQueueCapacityError) {
      return "queue-capacity";
    }
    if (error instanceof embedding.LocalProviderUnavailableError) {
      return "provider-unavailable";
    }
    if (error instanceof embedding.EmbeddingRequestAbortedError) {
      return "request-aborted";
    }
  } catch {
    // Fall through to an owned, content-free classification.
  }
  return diagnostics.stage === "validate"
    ? "invalid-output"
    : "operation-failed";
}

function schedulerIsCurrent(generation: number): boolean {
  return schedulerStarted && schedulerGeneration === generation;
}

function scheduleDrain(
  delayMs: number,
  generation = schedulerGeneration,
): void {
  if (!schedulerIsCurrent(generation) || schedulerTimer) return;
  schedulerTimer = setTimeout(() => {
    schedulerTimer = undefined;
    if (!schedulerIsCurrent(generation)) return;
    const drain = drainTemporalEmbeddingQueueOnce();
    // Capture this drain's context before its finally releases the shared slot.
    const diagnostics = activeDiagnostics!;
    void drain.then(
      (processed) => {
        if (!schedulerIsCurrent(generation)) return;
        if (processed > 0 && consecutiveFailures > 0) {
          log.info(
            `temporal embedding scheduler recovered: failures=${consecutiveFailures} committed=${processed}`,
          );
          consecutiveFailures = 0;
          failureRetryMs = 0;
        }
        scheduleDrain(
          processed > 0
            ? 0
            : diagnostics.providerUnavailable
              ? UNAVAILABLE_DRAIN_INTERVAL_MS
              : Math.max(IDLE_DRAIN_INTERVAL_MS, failureRetryMs),
          generation,
        );
      },
      (error: unknown) => {
        if (!schedulerIsCurrent(generation)) return;
        if (diagnostics.abortReason === "shutdown") {
          // A restarted scheduler can share the old, cancelled provider call.
          scheduleDrain(0, generation);
          return;
        }
        consecutiveFailures = Math.min(
          consecutiveFailures + 1,
          Number.MAX_SAFE_INTEGER,
        );
        const reason = failureReason(error, diagnostics);
        failureRetryMs = Math.min(
          FAILURE_RETRY_BASE_MS * 2 ** Math.min(consecutiveFailures - 1, 5),
          FAILURE_RETRY_MAX_MS,
        );
        let unavailable = reason === "provider-unavailable";
        try {
          unavailable ||= !embedding.isAvailable();
        } catch {
          // Availability probing must not replace the original failure or stop retries.
        }
        if (unavailable) failureRetryMs = UNAVAILABLE_DRAIN_INTERVAL_MS;
        log.error(
          `temporal embedding scheduler drain failed: reason=${reason} stage=${diagnostics.stage} elapsed_ms=${Math.round(performance.now() - diagnostics.startedAt)} messages=${diagnostics.messages} input_bytes=${diagnostics.inputBytes} units=${diagnostics.units} failures=${consecutiveFailures} retry_ms=${failureRetryMs}`,
        );
        scheduleDrain(failureRetryMs, generation);
      },
    );
  }, delayMs);
  schedulerTimer.unref?.();
}

/** Start the single process-wide durable temporal embedding scheduler. */
export function startTemporalEmbeddingScheduler(): void {
  if (schedulerStarted) return;
  schedulerStarted = true;
  schedulerGeneration++;
  scheduleDrain(0);
}

/** Stop admission of new scheduler drains. Any active provider call keeps its slot. */
export function stopTemporalEmbeddingScheduler(): void {
  schedulerStarted = false;
  schedulerGeneration++;
  if (schedulerTimer) clearTimeout(schedulerTimer);
  schedulerTimer = undefined;
  if (activeDrainAbort && !activeDrainAbort.signal.aborted) {
    if (activeDiagnostics) activeDiagnostics.abortReason = "shutdown";
    activeDrainAbort.abort(new Error("temporal embedding scheduler stopped"));
  }
}

/**
 * Wait for the real active drain to settle. A timeout only stops waiting; it
 * never pretends to cancel provider work or frees the active drain slot.
 */
export function settleTemporalEmbeddingScheduler(
  timeoutMs?: number,
): Promise<boolean> {
  if (!activeDrain) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (): void => {
      if (timer) clearTimeout(timer);
      resolve(true);
    };
    drainSettlers.add(settle);
    if (timeoutMs !== undefined) {
      timer = setTimeout(
        () => {
          drainSettlers.delete(settle);
          resolve(false);
        },
        Math.max(0, timeoutMs),
      );
    }
  });
}

/** Test-only reset. Call only after the active drain has settled. */
export function _resetTemporalEmbeddingSchedulerForTest(): void {
  stopTemporalEmbeddingScheduler();
  drainSettlers.clear();
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS;
  consecutiveFailures = 0;
  failureRetryMs = 0;
}

/** Test-only request deadline override. Null restores the production default. */
export function _setTemporalEmbeddingRequestTimeoutForTest(
  timeoutMs: number | null,
): void {
  requestTimeoutMs = timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
}
