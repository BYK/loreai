import { createHash } from "node:crypto";
import { config } from "./config";
import { db } from "./db";
import { deleteEmbeddings, readStorageMode } from "./db/vec-store";

const TEMPORAL_EMBEDDING_POLICY_VERSION = 2;

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

/** Persist desired temporal embedding state without copying message content. */
export function enqueueTemporalEmbedding(
  messageId: string,
  content: string,
): boolean {
  const result = db()
    .query(
      `INSERT INTO temporal_embedding_queue
         (message_id, content_hash, fingerprint, enqueued_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(message_id) DO UPDATE SET
         content_hash = excluded.content_hash,
         fingerprint = excluded.fingerprint,
         enqueued_at = excluded.enqueued_at
       WHERE temporal_embedding_queue.content_hash != excluded.content_hash
          OR temporal_embedding_queue.fingerprint != excluded.fingerprint`,
    )
    .run(
      messageId,
      temporalContentHash(content),
      temporalEmbeddingFingerprint(),
      Date.now(),
    );
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
