import { createHash } from "node:crypto";
import { deflateSync, inflateSync } from "node:zlib";
import { db, databaseInTransaction, isCurrentDatabase, projectId } from "./db";
import { currentTenantId } from "./tenant";

export const SOURCE_WINDOW_MAX_BYTES = 16_000_000;
export const SOURCE_WINDOW_MAX_SESSIONS = 32;
// A session may use the canonical path or a tenant-scoped worktree alias.
// Apply this inside both SQL statements so a concurrent rebind cannot race a
// separate ownership precheck. Unbound sessions are bound by the pipeline later.
const SESSION_PROJECT_MATCH = `(s.project_path IS NULL OR s.project_path = ''
  OR s.project_path = ? OR s.project_path = p.path
  OR EXISTS (SELECT 1 FROM project_path_aliases a
    WHERE a.project_id = p.id AND a.tenant_id = p.tenant_id AND a.path = s.project_path))`;
const digest = (value: Uint8Array) =>
  createHash("sha256").update(value).digest("hex");

/**
 * A lease on one accepted-request checkpoint, not an observation watermark.
 * The source count never claims that historical messages were distilled/stored.
 * claim/publish run inside the caller's temporal savepoint: failures roll back
 * both response storage and frontier advancement. A stale request cannot
 * resurrect a deleted owner or replace a newer request's checkpoint.
 */
export class SourceWindowStore {
  private readonly tenant = currentTenantId();
  private connection?: ReturnType<typeof db>;
  private pid?: string;
  private generation?: string;
  private revision?: number;
  private payload?: Uint8Array;
  private checksum?: string;
  private claimed = false;

  private readonly scope: {
    projectPath: string;
    sessionID: string;
    noStore: boolean;
  };
  constructor(scope: {
    projectPath: string;
    sessionID: string;
    noStore: boolean;
  }) {
    // Do not retain extra properties (notably a caller's full request transcript).
    this.scope = {
      projectPath: scope.projectPath,
      sessionID: scope.sessionID,
      noStore: scope.noStore,
    };
    if (scope.noStore) return;
    try {
      const connection = (this.connection = db());
      const pid = (this.pid = projectId(scope.projectPath));
      if (!pid) return;
      const read = () =>
        connection
          .query(`SELECT w.generation, w.revision, w.payload, w.checksum FROM source_windows w
        JOIN projects p ON p.id = w.project_id
        JOIN session_state s ON s.session_id = w.session_id
        WHERE w.project_id = ? AND w.session_id = ? AND p.tenant_id = ? AND s.amnesia = 0
          AND ${SESSION_PROJECT_MATCH} AND (w.payload IS NULL OR length(w.payload) <= 4000000)`)
          .get(pid, scope.sessionID, this.tenant, scope.projectPath) as {
          generation: string;
          revision: number;
          payload: Uint8Array | null;
          checksum: string | null;
        } | null;
      let row = read();
      if (!row) {
        // The common hit is read-only. Cache creation must never wait on a
        // background writer and stall the foreground event loop.
        const { timeout } = connection.query("PRAGMA busy_timeout").get() as {
          timeout: number;
        };
        connection.exec("PRAGMA busy_timeout = 0");
        try {
          const inserted = connection
            .query(`INSERT OR IGNORE INTO source_windows(project_id, session_id, updated_at)
            SELECT p.id, s.session_id, ? FROM projects p, session_state s
            WHERE p.id = ? AND p.tenant_id = ? AND s.session_id = ? AND s.amnesia = 0
              AND ${SESSION_PROJECT_MATCH}`)
            .run(
              Date.now(),
              pid,
              this.tenant,
              scope.sessionID,
              scope.projectPath,
            );
          if (inserted.changes)
            connection
              .query(`DELETE FROM source_windows WHERE rowid IN
            (SELECT rowid FROM source_windows ORDER BY updated_at DESC, rowid DESC LIMIT -1 OFFSET ?)`)
              .run(SOURCE_WINDOW_MAX_SESSIONS);
          row = read();
        } finally {
          connection.exec(`PRAGMA busy_timeout = ${timeout}`);
        }
      }
      if (!row) return;
      this.generation = row.generation;
      this.revision = row.revision;
      this.payload = row.payload ?? undefined;
      this.checksum = row.checksum ?? undefined;
    } catch {
      this.connection = undefined;
    }
  }

  load(): unknown {
    if (!this.payload || !this.checksum) return;
    try {
      if (digest(this.payload) !== this.checksum) return;
      return JSON.parse(
        inflateSync(this.payload, {
          maxOutputLength: SOURCE_WINDOW_MAX_BYTES,
        }).toString("utf8"),
      );
    } catch {
      return;
    }
  }

  /** Acquire the writer lock before checking the lease, inside the response savepoint. */
  claim(): boolean {
    this.claimed = false;
    if (
      !this.connection ||
      !this.generation ||
      this.revision === undefined ||
      !isCurrentDatabase(this.connection) ||
      currentTenantId() !== this.tenant ||
      !databaseInTransaction(this.connection)
    )
      return false;
    try {
      return (this.claimed =
        this.connection
          .query(`UPDATE source_windows SET revision = revision
        WHERE project_id = ? AND session_id = ? AND generation = ? AND revision = ?`)
          .run(this.pid!, this.scope.sessionID, this.generation, this.revision)
          .changes === 1);
    } catch {
      return false;
    }
  }

  /** Caller must have claimed this lease before its own temporal writes. */
  publish(value: unknown): boolean {
    if (
      !this.claimed ||
      !this.connection ||
      !this.generation ||
      !isCurrentDatabase(this.connection) ||
      currentTenantId() !== this.tenant ||
      !databaseInTransaction(this.connection)
    )
      return false;
    this.claimed = false;
    try {
      const json = JSON.stringify(value);
      if (Buffer.byteLength(json) > SOURCE_WINDOW_MAX_BYTES) return false;
      const payload = deflateSync(json, { level: 1 });
      if (payload.length > 4_000_000) return false;
      const result = this.connection
        .query(`UPDATE source_windows SET payload = ?, checksum = ?,
          revision = revision + 1, updated_at = ?
        WHERE project_id = ? AND session_id = ? AND generation = ?`)
        .run(
          payload,
          digest(payload),
          Date.now(),
          this.pid!,
          this.scope.sessionID,
          this.generation,
        );
      if (!result.changes) return false;
      this.connection
        .query(`DELETE FROM source_windows WHERE rowid IN
        (SELECT rowid FROM source_windows ORDER BY updated_at DESC, rowid DESC LIMIT -1 OFFSET ?)`)
        .run(SOURCE_WINDOW_MAX_SESSIONS);
      return true;
    } catch {
      return false;
    }
  }
}
