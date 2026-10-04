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
  MAX_TEMPORAL_EMBEDDING_SOURCE_BYTES,
  retireOversizedTemporalEmbedding,
  setTemporalEmbeddingAdmissionWake,
  temporalContentHash,
  temporalEmbeddingFingerprint,
} from "./temporal-embedding-admission";
import { LOCAL_TENANT_ID, withTenant } from "./tenant";

export {
  enqueueTemporalEmbedding,
  temporalContentHash,
  temporalEmbeddingFingerprint,
} from "./temporal-embedding-admission";

const MAX_MESSAGES_PER_DRAIN = 8;
const MAX_CONTENT_BYTES_PER_DRAIN = 256 * 1024;
const MAX_UNITS_PER_DRAIN = 16;
const HASH_CHUNK_BYTES = 16 * 1024;
const IDLE_DRAIN_INTERVAL_MS = 250;
const UNAVAILABLE_DRAIN_INTERVAL_MS = 30_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const FAILURE_RETRY_BASE_MS = 1_000;
const FAILURE_RETRY_MAX_MS = 30_000;
// A bounded chain can try more than one other owner without hammering a
// provider that is genuinely unavailable to everyone.
const MAX_FAST_CROSS_OWNER_PROBES = 2;

interface DrainDiagnostics {
  stage: "read" | "prepare" | "embed" | "validate" | "commit";
  startedAt: number;
  messages: number;
  inputBytes: number;
  units: number;
  providerUnavailable: boolean;
  providerSucceeded: boolean;
  deferred: boolean;
  abortReason?: "deadline" | "shutdown";
  failedOwnerId?: string;
}

interface QueueRow {
  message_id: string;
  project_id: string;
  tenant_id: string;
  content_hash: string;
  fingerprint: string;
  content: string;
  content_bytes: number;
}

interface QueueCandidate extends Omit<QueueRow, "content" | "content_bytes"> {
  failures: number;
  priority: 0 | 1;
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
let lastFailedOwnerId: string | undefined;
let fastCrossOwnerProbes = 0;
let crossOwnerProbePermitted = false;
let preferredFastMessageId: string | undefined;
let liveDrains = 0;
// Each priority earns its own fresh-work allowance before retrying failures.
// Live traffic must never consume the historical allowance.
const freshDrains: [number, number] = [0, 0];
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

function storedContentHash(
  messageId: string,
  owner: { project_id: string; tenant_id: string },
): string | null {
  const row = db()
    .query(
      `SELECT length(CAST(t.content AS BLOB)) AS n
       FROM temporal_messages t
       JOIN temporal_embedding_queue q ON q.message_id = t.id AND q.project_id = t.project_id
       JOIN projects p ON p.id = t.project_id
       WHERE t.id = ? AND t.project_id = ? AND p.tenant_id = ?`,
    )
    .get(messageId, owner.project_id, owner.tenant_id) as { n: number } | null;
  if (!row) return null;
  if (row.n > MAX_TEMPORAL_EMBEDDING_SOURCE_BYTES) return null;
  const hash = createHash("sha256");
  for (let offset = 1; offset <= row.n; offset += HASH_CHUNK_BYTES) {
    const chunk = db()
      .query(
        `SELECT substr(CAST(t.content AS BLOB), ?, ?) AS value
         FROM temporal_messages t
         JOIN temporal_embedding_queue q ON q.message_id = t.id AND q.project_id = t.project_id
         JOIN projects p ON p.id = t.project_id
         WHERE t.id = ? AND t.project_id = ? AND p.tenant_id = ?`,
      )
      .get(
        offset,
        HASH_CHUNK_BYTES,
        messageId,
        owner.project_id,
        owner.tenant_id,
      ) as {
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
  withTenant(row.tenant_id, () =>
    db()
      .query(
        `UPDATE temporal_embedding_queue AS q
          SET content_hash = ?, fingerprint = ?, enqueued_at = ?,
              retry_at = 0, failures = 0
         WHERE q.message_id = ? AND q.project_id = ?
            AND q.content_hash = ? AND q.fingerprint = ?
            AND EXISTS (
              SELECT 1 FROM temporal_messages t
              JOIN projects p ON p.id = t.project_id
              WHERE t.id = q.message_id AND t.project_id = q.project_id
                AND p.tenant_id = ?
            )`,
      )
      .run(
        currentHash,
        currentFingerprint,
        Date.now(),
        row.message_id,
        row.project_id,
        row.content_hash,
        row.fingerprint,
        row.tenant_id,
      ),
  );
}

function selectCandidates(priority: 0 | 1, now: number): QueueCandidate[] {
  const fresh = (): QueueCandidate[] => {
    const first = db()
      .query(
        `SELECT q.project_id FROM temporal_embedding_queue q
         JOIN temporal_messages t ON t.id = q.message_id AND t.project_id = q.project_id
         JOIN projects p ON p.id = t.project_id
         WHERE q.priority = ? AND q.failures = 0
         ORDER BY q.enqueued_at ASC, q.message_id ASC LIMIT 1`,
      )
      .get(priority) as { project_id: string } | null;
    if (!first) return [];
    // A provider request must belong to one project and one tenant. If it
    // fails, retry debt never spills onto another owner's healthy work.
    return db()
      .query(
        `SELECT q.message_id, q.project_id, p.tenant_id, q.content_hash, q.fingerprint, q.failures, q.priority
         FROM temporal_embedding_queue q
         JOIN temporal_messages t ON t.id = q.message_id AND t.project_id = q.project_id
         JOIN projects p ON p.id = t.project_id
          WHERE q.priority = ? AND q.project_id = ? AND q.failures = 0
         ORDER BY q.enqueued_at ASC, q.message_id ASC LIMIT ?`,
      )
      .all(
        priority,
        first.project_id,
        MAX_MESSAGES_PER_DRAIN,
      ) as unknown as QueueCandidate[];
  };
  const retry = () =>
    db()
      .query(
        `SELECT q.message_id, q.project_id, p.tenant_id, q.content_hash, q.fingerprint, q.failures, q.priority
          FROM temporal_embedding_queue q
          JOIN temporal_messages t ON t.id = q.message_id AND t.project_id = q.project_id
          JOIN projects p ON p.id = t.project_id
         WHERE q.priority = ? AND q.failures > 0 AND q.retry_at <= ?
         ORDER BY q.retry_at ASC, q.enqueued_at ASC, q.message_id ASC LIMIT 1`,
      )
      .all(priority, now) as unknown as QueueCandidate[];
  // Retry one previously failed message at a time. Fresh work is still allowed
  // through, while durable retries receive a fixed share even on a busy host.
  if (freshDrains[priority] >= 3) {
    const pendingRetry = retry();
    if (pendingRetry.length) return pendingRetry;
  }
  const pendingFresh = fresh();
  return pendingFresh.length ? pendingFresh : retry();
}

/** Find one fresh row belonging to a different owner without scanning a failed owner's backlog. */
function freshOtherOwnerMessage(ownerId: string): string | undefined {
  const after = db().query(
    `SELECT message_id FROM temporal_embedding_queue INDEXED BY idx_temporal_embedding_queue_fresh_owner
     WHERE priority = ? AND project_id > ? AND failures = 0
     ORDER BY project_id, enqueued_at, message_id LIMIT 1`,
  );
  const before = db().query(
    `SELECT message_id FROM temporal_embedding_queue INDEXED BY idx_temporal_embedding_queue_fresh_owner
     WHERE priority = ? AND project_id < ? AND failures = 0
     ORDER BY project_id, enqueued_at, message_id LIMIT 1`,
  );
  for (const priority of [1, 0]) {
    const row = (after.get(priority, ownerId) ??
      before.get(priority, ownerId)) as { message_id: string } | null;
    if (row) return row.message_id;
  }
  return undefined;
}

function deferFailedJobs(jobs: CapturedJob[]): boolean {
  let deferred = false;
  withSavepoint("defer_temporal_embeddings", () => {
    const update = db().query(
      `UPDATE temporal_embedding_queue
        SET failures = MIN(failures + 1, 32),
            retry_at = ?,
            fair_ahead = 0
        WHERE message_id = ? AND content_hash = ? AND fingerprint = ?
          AND project_id = ? AND EXISTS (
            SELECT 1 FROM temporal_messages t JOIN projects p ON p.id = t.project_id
            WHERE t.id = temporal_embedding_queue.message_id
              AND t.project_id = temporal_embedding_queue.project_id
              AND p.tenant_id = ?
          )`,
    );
    for (const job of jobs) {
      const row = withTenant(job.tenant_id, () => {
        try {
          assertJobCurrent(job);
        } catch (error) {
          if (error instanceof StaleTemporalEmbeddingJobError) return null;
          throw error;
        }
        return db()
          .query(
            `SELECT q.failures, q.fair_ahead FROM temporal_embedding_queue q
             JOIN temporal_messages t ON t.id = q.message_id AND t.project_id = q.project_id
             JOIN projects p ON p.id = t.project_id
             WHERE q.message_id = ? AND q.content_hash = ? AND q.fingerprint = ?
               AND q.project_id = ? AND p.tenant_id = ?`,
          )
          .get(
            job.message_id,
            job.content_hash,
            job.fingerprint,
            job.project_id,
            job.tenant_id,
          ) as { failures: number; fair_ahead: number } | null;
      });
      if (!row) continue;
      const delay = Math.min(
        FAILURE_RETRY_BASE_MS * 2 ** Math.min(row.failures, 5),
        FAILURE_RETRY_MAX_MS,
      );
      const result = update.run(
        Date.now() + delay,
        job.message_id,
        job.content_hash,
        job.fingerprint,
        job.project_id,
        job.tenant_id,
      );
      if (result.changes === 1 && row.fair_ahead === 1) {
        // A failed fair-ahead claim no longer occupies a runnable slot. Keep
        // its retry deadline and generation in a durable, source-owned park so
        // 16 failed owners cannot turn 16 spare slots into unbounded queue debt.
        const parked = db()
          .query(
            `INSERT INTO temporal_embedding_parked
               (message_id, content_hash, fingerprint, enqueued_at, failures, retry_at)
             SELECT message_id, content_hash, fingerprint, enqueued_at, failures, retry_at
               FROM temporal_embedding_queue
              WHERE message_id = ? AND project_id = ? AND content_hash = ?
                AND fingerprint = ? AND failures > 0
             ON CONFLICT(message_id) DO UPDATE SET
               content_hash = excluded.content_hash,
               fingerprint = excluded.fingerprint,
               enqueued_at = excluded.enqueued_at,
               failures = excluded.failures,
               retry_at = excluded.retry_at`,
          )
          .run(
            job.message_id,
            job.project_id,
            job.content_hash,
            job.fingerprint,
          );
        if (parked.changes !== 1)
          throw new Error("temporal embedding retry park unavailable");
        const removed = db()
          .query(
            `DELETE FROM temporal_embedding_queue
              WHERE message_id = ? AND project_id = ? AND content_hash = ?
                AND fingerprint = ? AND failures > 0`,
          )
          .run(
            job.message_id,
            job.project_id,
            job.content_hash,
            job.fingerprint,
          );
        if (removed.changes !== 1)
          throw new Error("temporal embedding retry park unavailable");
      }
      deferred ||= result.changes === 1;
    }
  });
  return deferred;
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

class StaleTemporalEmbeddingJobError extends Error {}

/** Check source ownership and bytes before every provider sub-batch. */
function assertJobCurrent(job: CapturedJob): void {
  const current = db()
    .query(
      `SELECT q.content_hash, q.fingerprint
       FROM temporal_embedding_queue q
       JOIN temporal_messages t ON t.id = q.message_id AND t.project_id = q.project_id
       JOIN projects p ON p.id = t.project_id
       WHERE q.message_id = ? AND q.project_id = ? AND p.tenant_id = ?`,
    )
    .get(job.message_id, job.project_id, job.tenant_id) as {
    content_hash: string;
    fingerprint: string;
  } | null;
  if (
    !current ||
    current.content_hash !== job.content_hash ||
    current.fingerprint !== job.fingerprint ||
    temporalEmbeddingFingerprint() !== job.fingerprint ||
    readStorageMode(db()) !== job.storageMode ||
    storedContentHash(job.message_id, job) !== job.content_hash
  ) {
    throw new StaleTemporalEmbeddingJobError();
  }
}

function commitJob(job: CapturedJob, vectors: Float32Array[]): boolean {
  let committed = false;
  withSavepoint("commit_temporal_embedding", () => {
    const current = db()
      .query(
        `SELECT q.content_hash, q.fingerprint
          FROM temporal_embedding_queue q
          JOIN temporal_messages t ON t.id = q.message_id AND t.project_id = q.project_id
          JOIN projects p ON p.id = t.project_id
           WHERE q.message_id = ? AND q.project_id = ? AND p.tenant_id = ?`,
      )
      .get(job.message_id, job.project_id, job.tenant_id) as {
      content_hash: string;
      fingerprint: string;
    } | null;
    if (!current) return;
    if (
      current.content_hash !== job.content_hash ||
      current.fingerprint !== job.fingerprint ||
      storedContentHash(job.message_id, job) !== job.content_hash ||
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
  const now = Date.now();
  const preferLive = liveDrains < 3;
  const primary = preferLive ? 1 : 0;
  // A failed owner cannot hide a healthy owner's queued row behind many fresh
  // failures. The one allowed cross-owner probe names its exact durable row.
  const preferred = preferredFastMessageId;
  preferredFastMessageId = undefined;
  const selected = preferred
    ? (db()
        .query(
          `SELECT q.message_id, q.project_id, p.tenant_id, q.content_hash, q.fingerprint,
                     q.failures, q.priority
             FROM temporal_embedding_queue q
             JOIN temporal_messages t ON t.id = q.message_id AND t.project_id = q.project_id
             JOIN projects p ON p.id = t.project_id
            WHERE q.message_id = ? AND q.failures = 0`,
        )
        .get(preferred) as QueueCandidate | null)
    : null;
  const primaryCandidates = selected
    ? [selected]
    : selectCandidates(primary, now);
  const candidates = primaryCandidates.length
    ? primaryCandidates
    : selectCandidates(primary === 1 ? 0 : 1, now);
  if (!candidates.length) return 0;

  diagnostics.stage = "prepare";
  // Selection is metadata-only. Read text inside the authoritative source
  // tenant, with the queue and project still matching the captured owner.
  const admission = { messages: 0, bytes: 0 };
  const rows = candidates.flatMap((candidate) =>
    withTenant(
      candidate.tenant_id,
      (): Array<QueueRow & { retainedBytes: number }> => {
        const length = db()
          .query(
            `SELECT length(CAST(t.content AS BLOB)) AS n
           FROM temporal_messages t
           JOIN temporal_embedding_queue q ON q.message_id = t.id AND q.project_id = t.project_id
           JOIN projects p ON p.id = t.project_id
           WHERE t.id = ? AND t.project_id = ? AND p.tenant_id = ?`,
          )
          .get(
            candidate.message_id,
            candidate.project_id,
            candidate.tenant_id,
          ) as {
          n: number;
        } | null;
        if (length?.n && length.n > MAX_TEMPORAL_EMBEDDING_SOURCE_BYTES) {
          retireOversizedTemporalEmbedding(
            candidate.message_id,
            candidate.project_id,
          );
          return [];
        }
        if (
          !length ||
          (admission.messages > 0 &&
            admission.bytes + length.n > MAX_CONTENT_BYTES_PER_DRAIN)
        )
          return [];
        const content = db()
          .query(
            `SELECT CASE
             WHEN length(CAST(t.content AS BLOB)) > ?
               THEN substr(CAST(t.content AS BLOB), 1, ?)
             ELSE CAST(t.content AS BLOB)
           END AS content_bytes
           FROM temporal_messages t
           JOIN temporal_embedding_queue q ON q.message_id = t.id AND q.project_id = t.project_id
           JOIN projects p ON p.id = t.project_id
           WHERE t.id = ? AND t.project_id = ? AND p.tenant_id = ?`,
          )
          .get(
            MAX_CONTENT_BYTES_PER_DRAIN,
            MAX_CONTENT_BYTES_PER_DRAIN,
            candidate.message_id,
            candidate.project_id,
            candidate.tenant_id,
          ) as { content_bytes: Uint8Array } | null;
        if (!content) return [];
        admission.messages++;
        admission.bytes += length.n;
        return [
          {
            ...candidate,
            content_bytes: length.n,
            content: decodeContentPrefix(
              content.content_bytes,
              length.n > content.content_bytes.byteLength,
            ),
            retainedBytes: content.content_bytes.byteLength,
          },
        ];
      },
    ),
  );
  diagnostics.messages = rows.length;
  diagnostics.inputBytes = rows.reduce(
    (sum, row) => sum + row.retainedBytes,
    0,
  );

  const fingerprint = temporalEmbeddingFingerprint();
  const mode = readStorageMode(db());
  const preparedJobs = rows
    .filter((row) => {
      const currentHash =
        row.content_bytes <= MAX_CONTENT_BYTES_PER_DRAIN
          ? temporalContentHash(row.content)
          : withTenant(row.tenant_id, () =>
              storedContentHash(row.message_id, row),
            );
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
  const jobs: CapturedJob[] = [];
  let admittedUnits = 0;
  for (const job of preparedJobs) {
    // Never split a message's vector set across commits. A large message may
    // own one drain; later messages still advance at the next drain boundary.
    if (
      jobs.length > 0 &&
      admittedUnits + job.texts.length > MAX_UNITS_PER_DRAIN
    )
      break;
    jobs.push(job);
    admittedUnits += job.texts.length;
  }
  if (!jobs.length) return 0;
  liveDrains = candidates[0].priority === 1 ? Math.min(3, liveDrains + 1) : 0;
  freshDrains[candidates[0].priority] =
    candidates[0].failures > 0
      ? 0
      : Math.min(3, freshDrains[candidates[0].priority] + 1);
  diagnostics.messages = jobs.length;

  const emptyJobs = jobs.filter((job) => job.texts.length === 0);
  const embeddingJobs = jobs.filter((job) => job.texts.length > 0);
  if (jobs.every((job) => job.project_id === jobs[0].project_id))
    diagnostics.failedOwnerId = jobs[0].project_id;
  const texts = embeddingJobs.flatMap((job) => job.texts);
  diagnostics.units = texts.length;
  diagnostics.stage = "embed";
  if (embeddingJobs.length > 0) {
    try {
      withTenant(embeddingJobs[0].tenant_id, () =>
        embeddingJobs.forEach(assertJobCurrent),
      );
    } catch (error) {
      if (error instanceof StaleTemporalEmbeddingJobError) return 0;
      throw error;
    }
  }
  if (
    texts.length > 0 &&
    !withTenant(embeddingJobs[0].tenant_id, () => embedding.isAvailable())
  ) {
    diagnostics.providerUnavailable = true;
    return 0;
  }
  let vectors: Float32Array[];
  try {
    vectors =
      texts.length > 0
        ? await withTenant(embeddingJobs[0].tenant_id, () =>
            embedding.embedInTokenBatches(texts, "document", signal, {
              background: true,
              beforeBatch: () => embeddingJobs.forEach(assertJobCurrent),
            }),
          )
        : [];
    if (signal.aborted) {
      throw new embedding.EmbeddingRequestAbortedError();
    }
    diagnostics.stage = "validate";
    validateVectors(vectors);
    diagnostics.providerSucceeded = texts.length > 0;
  } catch (error) {
    // A moved or edited row remains durable for its current owner. It is not
    // an inference failure and must never incur old-owner retry debt.
    if (error instanceof StaleTemporalEmbeddingJobError) return 0;
    const reason = failureReason(error, diagnostics);
    if (
      diagnostics.abortReason !== "shutdown" &&
      reason !== "provider-unavailable" &&
      reason !== "queue-capacity" &&
      reason !== "request-aborted"
    ) {
      try {
        diagnostics.deferred = deferFailedJobs(embeddingJobs);
      } catch {
        // Retain the original failure. The global scheduler backoff still
        // applies if SQLite cannot record row-local retry state.
      }
    }
    throw error;
  }

  diagnostics.stage = "commit";
  const commitCapturedJob = (job: CapturedJob, jobVectors: Float32Array[]) => {
    try {
      return withTenant(job.tenant_id, () => commitJob(job, jobVectors));
    } catch (error) {
      // The vector write and queue removal rolled back together. Defer only
      // this still-current row so a different owner's fresh work can proceed.
      // When SQLite cannot record retry debt, keep the global backoff instead.
      try {
        diagnostics.deferred ||= deferFailedJobs([job]);
      } catch {
        // Preserve the original storage failure.
      }
      throw error;
    }
  };
  let committed = emptyJobs.reduce(
    (count, job) => count + (commitCapturedJob(job, []) ? 1 : 0),
    0,
  );
  let offset = 0;
  committed += embeddingJobs.reduce((count, job) => {
    const jobVectors = vectors.slice(offset, offset + job.texts.length);
    offset += job.texts.length;
    if (jobVectors.length !== job.texts.length) {
      throw new Error("temporal embedding produced an invalid vector set");
    }
    return count + (commitCapturedJob(job, jobVectors) ? 1 : 0);
  }, 0);
  return committed;
}

/** Drain up to eight priority- and retry-eligible messages; concurrent calls share one drain. */
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
    providerSucceeded: false,
    deferred: false,
  };
  activeDiagnostics = diagnostics;
  const timer = setTimeout(() => {
    if (abort.signal.aborted) return;
    diagnostics.abortReason = "deadline";
    abort.abort(new Error("temporal embedding request deadline exceeded"));
  }, requestTimeoutMs);
  timer.unref?.();
  // The shared queue belongs to the server, not whichever request happened to
  // wake it. Provider work and commits re-enter the captured source tenant.
  activeDrain = withTenant(LOCAL_TENANT_ID, () =>
    drainOnce(abort.signal, diagnostics),
  ).finally(() => {
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
    withTenant(LOCAL_TENANT_ID, () => {
      schedulerTimer = undefined;
      if (!schedulerIsCurrent(generation)) return;
      const drain = drainTemporalEmbeddingQueueOnce();
      // Capture this drain's context before its finally releases the shared slot.
      const diagnostics = activeDiagnostics!;
      void drain.then(
        (processed) => {
          if (!schedulerIsCurrent(generation)) return;
          if (
            processed > 0 &&
            consecutiveFailures > 0 &&
            diagnostics.providerSucceeded
          ) {
            try {
              log.info(
                `temporal embedding scheduler recovered: failures=${consecutiveFailures} committed=${processed}`,
              );
            } catch {
              // Logging never decides whether durable work gets its next turn.
            }
            consecutiveFailures = 0;
            failureRetryMs = 0;
            lastFailedOwnerId = undefined;
            fastCrossOwnerProbes = 0;
            crossOwnerProbePermitted = false;
          }
          if (
            processed > 0 &&
            consecutiveFailures > 0 &&
            !diagnostics.providerSucceeded
          ) {
            // An empty/short job did not test the provider. It cannot restore
            // the fast-probe budget during an ongoing failure streak.
            fastCrossOwnerProbes = MAX_FAST_CROSS_OWNER_PROBES;
          }
          scheduleDrain(
            processed > 0 && consecutiveFailures === 0
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
          lastFailedOwnerId = diagnostics.failedOwnerId;
          crossOwnerProbePermitted = diagnostics.deferred && !unavailable;
          let fastProbe = false;
          if (crossOwnerProbePermitted && lastFailedOwnerId) {
            try {
              preferredFastMessageId =
                freshOtherOwnerMessage(lastFailedOwnerId);
              fastProbe =
                preferredFastMessageId !== undefined &&
                fastCrossOwnerProbes < MAX_FAST_CROSS_OWNER_PROBES;
              if (fastProbe) fastCrossOwnerProbes++;
            } catch {
              // A failed owner probe cannot replace the original embed failure.
            }
          }
          const retryMs = fastProbe ? IDLE_DRAIN_INTERVAL_MS : failureRetryMs;
          try {
            log.error(
              `temporal embedding scheduler drain failed: reason=${reason} stage=${diagnostics.stage} elapsed_ms=${Math.round(performance.now() - diagnostics.startedAt)} messages=${diagnostics.messages} input_bytes=${diagnostics.inputBytes} units=${diagnostics.units} failures=${consecutiveFailures} retry_ms=${retryMs}`,
            );
          } catch {
            // A failed diagnostic sink cannot strand the next retry timer.
          }
          scheduleDrain(retryMs, generation);
        },
      );
    });
  }, delayMs);
  schedulerTimer.unref?.();
}

/** Start the single process-wide durable temporal embedding scheduler. */
export function startTemporalEmbeddingScheduler(): void {
  if (schedulerStarted) return;
  schedulerStarted = true;
  schedulerGeneration++;
  const generation = schedulerGeneration;
  setTemporalEmbeddingAdmissionWake((messageId) => {
    if (!schedulerIsCurrent(generation) || activeDrain) return;
    if (consecutiveFailures > 0) {
      if (
        !crossOwnerProbePermitted ||
        fastCrossOwnerProbes >= MAX_FAST_CROSS_OWNER_PROBES ||
        !lastFailedOwnerId
      )
        return;
      const row = db()
        .query(
          "SELECT project_id FROM temporal_embedding_queue WHERE message_id = ? AND failures = 0",
        )
        .get(messageId) as { project_id: string } | null;
      if (!row || row.project_id === lastFailedOwnerId) return;
      fastCrossOwnerProbes++;
      preferredFastMessageId = messageId;
    }
    // A deferred row can own a long retry timer. Fresh live work is eligible
    // now and must not inherit that row's cooldown.
    if (schedulerTimer) clearTimeout(schedulerTimer);
    schedulerTimer = undefined;
    scheduleDrain(0, generation);
  });
  scheduleDrain(0);
}

/** Stop admission of new scheduler drains. Any active provider call keeps its slot. */
export function stopTemporalEmbeddingScheduler(): void {
  schedulerStarted = false;
  schedulerGeneration++;
  setTemporalEmbeddingAdmissionWake(null);
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
  lastFailedOwnerId = undefined;
  fastCrossOwnerProbes = 0;
  crossOwnerProbePermitted = false;
  preferredFastMessageId = undefined;
  liveDrains = 0;
  freshDrains[0] = 0;
  freshDrains[1] = 0;
}

/** Test-only request deadline override. Null restores the production default. */
export function _setTemporalEmbeddingRequestTimeoutForTest(
  timeoutMs: number | null,
): void {
  requestTimeoutMs = timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
}
