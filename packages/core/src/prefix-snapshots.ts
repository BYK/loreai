/**
 * Prefix snapshots (#1809). Each session keeps a FIFO of as-sent request
 * bodies, pushed at prefix-rewrite boundaries: the last body sent before a
 * request whose prefix diverged from it (a gradient layer change,
 * distilled-prefix re-anchoring, a dedup flip). A thread anchored before the
 * rewrite can still inherit that body's exact, still-cached prefix. Entries
 * expire with the session's conversation TTL and are pruned on push and on
 * read. Bodies are stored as given (zstd-compressed by the gateway).
 */
import { db, withTransaction } from "./db";

/** Retained snapshots per session; the oldest are dropped first. */
export const PREFIX_SNAPSHOT_LIMIT = 8;

export interface PrefixSnapshot {
  sessionID: string;
  seq: number;
  projectID: string;
  /** Upstream model id the body was sent with. */
  model: string;
  /** Credential fingerprint of the upstream account. */
  account: string;
  /** Wire protocol of the body (`anthropic`, `openai`, …). */
  wire: string;
  /** zstd-compressed as-sent body. */
  body: Uint8Array;
  /** Uncompressed length in bytes. */
  bodyBytes: number;
  /** When the body was last sent upstream. */
  sentAt: number;
  /** When its prompt-cache entry lapses (`sentAt` + conversation TTL). */
  expiresAt: number;
}

export type PrefixSnapshotInput = Omit<PrefixSnapshot, "seq">;

interface SnapshotRow {
  session_id: string;
  seq: number;
  project_id: string;
  model: string;
  account: string;
  wire: string;
  body: Uint8Array;
  body_bytes: number;
  sent_at: number;
  expires_at: number;
}

export function pushPrefixSnapshot(
  input: PrefixSnapshotInput,
  now = Date.now(),
): void {
  withTransaction(() => {
    prune(input.sessionID, now);
    if (input.expiresAt <= now) return;
    db()
      .query(
        `INSERT INTO session_prefix_snapshots (session_id, seq, project_id,
           model, account, wire, body, body_bytes, sent_at, expires_at)
         SELECT ?, COALESCE(MAX(seq), -1) + 1, ?, ?, ?, ?, ?, ?, ?, ?
           FROM session_prefix_snapshots
          WHERE session_id = ?`,
      )
      .run(
        input.sessionID,
        input.projectID,
        input.model,
        input.account,
        input.wire,
        input.body,
        input.bodyBytes,
        input.sentAt,
        input.expiresAt,
        input.sessionID,
      );
    db()
      .query(
        `DELETE FROM session_prefix_snapshots
          WHERE session_id = ? AND seq NOT IN (
            SELECT seq FROM session_prefix_snapshots
             WHERE session_id = ? ORDER BY seq DESC LIMIT ?)`,
      )
      .run(input.sessionID, input.sessionID, PREFIX_SNAPSHOT_LIMIT);
  });
}

/** Unexpired snapshots of a session, newest first. */
export function listPrefixSnapshots(
  sessionID: string,
  now = Date.now(),
): PrefixSnapshot[] {
  return withTransaction(() => {
    prune(sessionID, now);
    const rows = db()
      .query(
        `SELECT session_id, seq, project_id, model, account, wire, body,
                body_bytes, sent_at, expires_at
           FROM session_prefix_snapshots
          WHERE session_id = ?
          ORDER BY seq DESC`,
      )
      .all(sessionID) as unknown as SnapshotRow[];
    return rows.map((row) => ({
      sessionID: row.session_id,
      seq: row.seq,
      projectID: row.project_id,
      model: row.model,
      account: row.account,
      wire: row.wire,
      body: new Uint8Array(row.body),
      bodyBytes: row.body_bytes,
      sentAt: row.sent_at,
      expiresAt: row.expires_at,
    }));
  });
}

function prune(sessionID: string, now: number): void {
  db()
    .query(
      "DELETE FROM session_prefix_snapshots WHERE session_id = ? AND expires_at <= ?",
    )
    .run(sessionID, now);
}
