/**
 * `session_meta` — the disposable derived cache behind the sessions-list
 * `title`/`title_source` columns (#1921).
 *
 * One row per `(project_id, session_id)` records the derived title plus the
 * aggregate counts (`message_count`, `distillation_count`) it was computed
 * against. `refreshSessionMeta` recomputes only stale rows:
 *
 *   - a missing row is always recomputed;
 *   - a row whose source is `distillation` or `id` is recomputed when the
 *     session's counts moved (a later distillation or message may give it a
 *     better title);
 *   - `first_message` and `explicit` rows are fresh forever — the first user
 *     message does not change (content edits invalidate eagerly in
 *     `temporal.store()`, explicit titles via `data.setSessionTitle()`).
 *
 * The table is NOT in `SYNCED_TABLES`: it is a cache, rebuildable from
 * `temporal_messages` / `distillations` / `session_state` on any machine.
 */
import { db, withSavepoint } from "./db";
import { sql } from "./sql";
import {
  deriveSessionTitle,
  normalizeTitle,
  type SessionTitleSource,
} from "./session-title";

export type SessionTitleInfo = {
  title: string;
  title_source: SessionTitleSource;
};

/** Aggregate row a caller computed for a session (from the list query). */
export type SessionMetaInput = {
  session_id: string;
  message_count: number;
  distillation_count: number;
};

/** Bound-parameter ceiling (mirrors MAX_TEMPORAL_BIND_PARAMS). */
const META_BIND_CHUNK = 900;

type MetaRow = SessionTitleInfo & {
  session_id: string;
  message_count: number;
  distillation_count: number;
};

/**
 * Ensure every session in `rows` has a fresh `session_meta` row and return
 * `{title, title_source}` for each. Reads are a single chunked `IN` lookup;
 * writes (only for stale rows) run inside one savepoint.
 */
export function refreshSessionMeta(
  pid: string,
  rows: readonly SessionMetaInput[],
  opts?: { force?: boolean },
): Map<string, SessionTitleInfo> {
  const result = new Map<string, SessionTitleInfo>();
  if (rows.length === 0) return result;

  const database = db();
  const existing = new Map<string, MetaRow>();
  for (let i = 0; i < rows.length; i += META_BIND_CHUNK) {
    const chunk = rows.slice(i, i + META_BIND_CHUNK);
    for (const row of sql.all<MetaRow>(
      database,
      sql`SELECT session_id, title, title_source, message_count, distillation_count
          FROM session_meta
          WHERE project_id = ${pid}
            AND session_id ${sql.inList(chunk.map((r) => r.session_id))}`,
    )) {
      existing.set(row.session_id, row);
    }
  }

  const stale: SessionMetaInput[] = [];
  for (const row of rows) {
    const meta = existing.get(row.session_id);
    const isStale =
      opts?.force === true ||
      meta === undefined ||
      ((meta.title_source === "distillation" || meta.title_source === "id") &&
        (meta.message_count !== row.message_count ||
          meta.distillation_count !== row.distillation_count));
    if (isStale) {
      stale.push(row);
    } else {
      result.set(row.session_id, {
        title: meta.title,
        title_source: meta.title_source,
      });
    }
  }
  if (stale.length === 0) return result;

  const explicitStmt = database.query(
    "SELECT title FROM session_state WHERE session_id = ?",
  );
  const userStmt = database.query(
    `SELECT content FROM temporal_messages
     WHERE project_id = ? AND session_id = ? AND role = 'user'
     ORDER BY created_at ASC, id ASC LIMIT 5`,
  );
  const narrativeStmt = database.query(
    `SELECT narrative FROM distillations
     WHERE project_id = ? AND session_id = ?
     ORDER BY created_at DESC LIMIT 1`,
  );
  const upsertStmt = database.query(
    `INSERT INTO session_meta
       (project_id, session_id, title, title_norm, title_source,
        message_count, distillation_count, computed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_id, session_id) DO UPDATE SET
       title = excluded.title,
       title_norm = excluded.title_norm,
       title_source = excluded.title_source,
       message_count = excluded.message_count,
       distillation_count = excluded.distillation_count,
       computed_at = excluded.computed_at`,
  );

  withSavepoint("refresh_session_meta", () => {
    const now = Date.now();
    for (const row of stale) {
      const explicit =
        (explicitStmt.get(row.session_id) as { title: string | null } | null)
          ?.title ?? null;
      const userMessages = (
        userStmt.all(pid, row.session_id) as Array<{ content: string }>
      ).map((r) => r.content);
      const narrative =
        (
          narrativeStmt.get(pid, row.session_id) as {
            narrative: string;
          } | null
        )?.narrative ?? null;
      const derived = deriveSessionTitle({
        sessionId: row.session_id,
        explicitTitle: explicit,
        userMessages,
        latestDistillationNarrative: narrative,
      });
      upsertStmt.run(
        pid,
        row.session_id,
        derived.title,
        normalizeTitle(derived.title),
        derived.title_source,
        row.message_count,
        row.distillation_count,
        now,
      );
      result.set(row.session_id, derived);
    }
  });
  return result;
}

/** Drop the cached row so the next list recomputes it (content edits,
 *  explicit-title changes, session moves/deletes). */
export function invalidateSessionMeta(pid: string, sessionId: string): void {
  db()
    .query("DELETE FROM session_meta WHERE project_id = ? AND session_id = ?")
    .run(pid, sessionId);
}

/** Remove `session_meta` rows whose session no longer exists in the project
 *  (the table is a cache — orphans are dead weight, not data loss). */
export function pruneOrphanSessionMeta(pid: string): void {
  db()
    .query(
      `DELETE FROM session_meta WHERE project_id = ? AND session_id NOT IN
       (SELECT DISTINCT session_id FROM temporal_messages WHERE project_id = ?)`,
    )
    .run(pid, pid);
}

/** Escape LIKE metacharacters so a search string is matched literally. */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}
