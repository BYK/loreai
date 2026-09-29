import { createHash } from "node:crypto";
import { config } from "./config";
import { db, withSavepoint } from "./db";
import { deleteEmbeddings, readStorageMode } from "./db/vec-store";
import { currentTenantId } from "./tenant";

const TEMPORAL_EMBEDDING_POLICY_VERSION = 2;
// The provider uses at most 256 KiB per drain. Bound repeated authoritative
// source checks on the gateway thread while retaining FTS for larger messages.
export const MAX_TEMPORAL_EMBEDDING_SOURCE_BYTES = 512 * 1024;
let wakeLiveAdmission: ((messageId: string) => void) | null = null;

/** Scheduler-owned wakeup; never part of the durable write's success contract. */
export function setTemporalEmbeddingAdmissionWake(
  wake: ((messageId: string) => void) | null,
): void {
  wakeLiveAdmission = wake;
}

export function temporalContentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function temporalEmbeddingFingerprint(): string {
  const embedding = config().search.embeddings;
  return `${embedding.provider}:${embedding.model}:${embedding.dimensions}:temporal-embedding-policy-v${TEMPORAL_EMBEDDING_POLICY_VERSION}`;
}

/** Constant-time canonical presence probe; never scans vec0 auxiliary columns. */
export function hasTemporalEmbedding(messageId: string): boolean {
  if (readStorageMode(db()) === "vec0") {
    return (
      db()
        .query("SELECT 1 FROM temporal_vec WHERE chunk_id = ?")
        .get(`${messageId}#0`) !== null
    );
  }
  return (
    db()
      .query(
        "SELECT 1 FROM temporal_messages WHERE id = ? AND embedding IS NOT NULL",
      )
      .get(messageId) !== null
  );
}

/** A retained old vector does not make a historical replacement a live job. */
export function hasPendingHistoricalTemporalEmbedding(
  messageId: string,
  projectId: string,
): boolean {
  return (
    db()
      .query(
        `SELECT 1 FROM temporal_messages t JOIN projects p ON p.id = t.project_id
         WHERE t.id = ? AND t.project_id = ? AND p.tenant_id = ?
           AND (EXISTS (
             SELECT 1 FROM temporal_embedding_queue q
             WHERE q.message_id = t.id AND q.project_id = t.project_id AND q.priority = 0
           ) OR EXISTS (
             SELECT 1 FROM temporal_embedding_parked d WHERE d.message_id = t.id
           ))`,
      )
      .get(messageId, projectId, currentTenantId()) !== null
  );
}

/** Retire a source that cannot be verified without unbounded synchronous work. */
export function retireOversizedTemporalEmbedding(
  messageId: string,
  projectId?: string,
): boolean {
  return withSavepoint("retire_oversized_temporal_embedding", () => {
    const source = db()
      .query(
        `SELECT t.project_id, length(CAST(t.content AS BLOB)) AS bytes
         FROM temporal_messages t JOIN projects p ON p.id = t.project_id
         WHERE t.id = ? AND p.tenant_id = ?`,
      )
      .get(messageId, currentTenantId()) as {
      project_id: string;
      bytes: number;
    } | null;
    if (
      !source ||
      (projectId !== undefined && source.project_id !== projectId) ||
      source.bytes <= MAX_TEMPORAL_EMBEDDING_SOURCE_BYTES
    )
      return false;
    db()
      .query(
        "DELETE FROM temporal_embedding_queue WHERE message_id = ? AND project_id = ?",
      )
      .run(messageId, source.project_id);
    db()
      .query("DELETE FROM temporal_embedding_parked WHERE message_id = ?")
      .run(messageId);
    invalidateTemporalEmbedding(messageId);
    return true;
  });
}

/** Persist desired temporal embedding state without copying message content. */
export function enqueueTemporalEmbedding(
  messageId: string,
  content: string,
  source: "live" | "backfill" = "live",
): boolean {
  if (
    Buffer.byteLength(content, "utf8") > MAX_TEMPORAL_EMBEDDING_SOURCE_BYTES
  ) {
    retireOversizedTemporalEmbedding(messageId);
    return false;
  }
  const contentHash = temporalContentHash(content);
  const fingerprint = temporalEmbeddingFingerprint();
  const admit = () =>
    db()
      .query(
        `INSERT INTO temporal_embedding_queue
           (message_id, content_hash, fingerprint, enqueued_at, priority, project_id)
         SELECT ?, ?, ?, ?, ?, t.project_id
           FROM temporal_messages t JOIN projects p ON p.id = t.project_id
          WHERE t.id = ? AND p.tenant_id = ?
        ON CONFLICT(message_id) DO UPDATE SET
          content_hash = excluded.content_hash,
          fingerprint = excluded.fingerprint,
          enqueued_at = CASE
            WHEN temporal_embedding_queue.content_hash != excluded.content_hash
              OR temporal_embedding_queue.fingerprint != excluded.fingerprint
              OR temporal_embedding_queue.project_id != excluded.project_id
              OR temporal_embedding_queue.priority < excluded.priority
            THEN excluded.enqueued_at ELSE temporal_embedding_queue.enqueued_at END,
          retry_at = CASE
            WHEN temporal_embedding_queue.content_hash != excluded.content_hash
              OR temporal_embedding_queue.fingerprint != excluded.fingerprint
              OR temporal_embedding_queue.project_id != excluded.project_id
              OR temporal_embedding_queue.priority < excluded.priority
            THEN 0 ELSE temporal_embedding_queue.retry_at END,
           failures = CASE
            WHEN temporal_embedding_queue.content_hash != excluded.content_hash
              OR temporal_embedding_queue.fingerprint != excluded.fingerprint
              OR temporal_embedding_queue.project_id != excluded.project_id
              OR temporal_embedding_queue.priority < excluded.priority
             THEN 0 ELSE temporal_embedding_queue.failures END,
           fair_ahead = CASE WHEN excluded.priority = 1
             THEN 0 ELSE temporal_embedding_queue.fair_ahead END,
           priority = MAX(temporal_embedding_queue.priority, excluded.priority),
          project_id = excluded.project_id
        WHERE temporal_embedding_queue.content_hash != excluded.content_hash
           OR temporal_embedding_queue.fingerprint != excluded.fingerprint
           OR temporal_embedding_queue.priority < excluded.priority
           OR temporal_embedding_queue.project_id != excluded.project_id`,
      )
      .run(
        messageId,
        contentHash,
        fingerprint,
        Date.now(),
        source === "live" ? 1 : 0,
        messageId,
        currentTenantId(),
      );
  const result = withSavepoint("admit_temporal_embedding", () => {
    const parked = db()
      .query(
        `SELECT d.content_hash, d.fingerprint, d.enqueued_at, d.failures, d.retry_at
         FROM temporal_embedding_parked d
         JOIN temporal_messages t ON t.id = d.message_id
         JOIN projects p ON p.id = t.project_id
         WHERE d.message_id = ? AND p.tenant_id = ?`,
      )
      .get(messageId, currentTenantId()) as {
      content_hash: string;
      fingerprint: string;
      enqueued_at: number;
      failures: number;
      retry_at: number;
    } | null;
    const inserted = admit();
    if (
      parked &&
      source === "backfill" &&
      parked.content_hash === contentHash &&
      parked.fingerprint === fingerprint
    ) {
      // Re-scanning an unchanged source must preserve its prior row-local
      // deadline. A changed generation or live arrival starts fresh instead.
      db()
        .query(
          `UPDATE temporal_embedding_queue SET failures = ?, retry_at = ?, enqueued_at = ?
           WHERE message_id = ? AND content_hash = ? AND fingerprint = ?
             AND priority = 0 AND failures = 0
             AND EXISTS (
               SELECT 1 FROM temporal_messages t JOIN projects p ON p.id = t.project_id
               WHERE t.id = temporal_embedding_queue.message_id
                 AND t.project_id = temporal_embedding_queue.project_id
                 AND p.tenant_id = ?
             )`,
        )
        .run(
          parked.failures,
          parked.retry_at,
          parked.enqueued_at,
          messageId,
          contentHash,
          fingerprint,
          currentTenantId(),
        );
    }
    // The valid queue row owns this source now. Remove stale retry metadata in
    // the same write unit, including after an interrupted prior admission.
    db()
      .query(
        `DELETE FROM temporal_embedding_parked WHERE message_id = ?
         AND EXISTS (
           SELECT 1 FROM temporal_embedding_queue q
           JOIN temporal_messages t ON t.id = q.message_id AND t.project_id = q.project_id
           JOIN projects p ON p.id = t.project_id
           WHERE q.message_id = temporal_embedding_parked.message_id
             AND p.tenant_id = ?
         )`,
      )
      .run(messageId, currentTenantId());
    return inserted;
  });
  if (result.changes > 0 && source === "live") {
    try {
      wakeLiveAdmission?.(messageId);
    } catch {
      // A scheduler wakeup cannot turn a successful temporal write into a failure.
    }
  }
  return result.changes > 0;
}

/** Remove a vector that no longer represents the authoritative base content. */
export function invalidateTemporalEmbedding(messageId: string): void {
  if (readStorageMode(db()) === "vec0") {
    deleteEmbeddings(db(), "temporal", [messageId]);
    return;
  }
  db()
    .query("UPDATE temporal_messages SET embedding = NULL WHERE id = ?")
    .run(messageId);
}
