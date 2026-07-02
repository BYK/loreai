/**
 * data.ts — Data listing, inspection, and deletion for Lore.
 *
 * Provides a unified API for both the CLI (`lore data`) and the web UI
 * (`/ui/`) to browse, search, and delete stored data across all tables.
 *
 * Cross-cutting concerns (e.g. `clearProject` touches knowledge, temporal,
 * distillations, and session_state in one transaction) live here instead of
 * being spread across ltm/temporal/distillation modules.
 */

import { statSync, unlinkSync, existsSync, rmSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import {
  db,
  ensureProject,
  projectId,
  projectPath as getProjectPathById,
  close,
  dbPath,
  mergeProjectInternal,
  repoNameFromRemote,
  onProjectMutation,
  loadParentChildMap,
  invalidateParentChildCache,
  rebuildDirtySessionRollups,
} from "./db";
import { getGitRemote } from "./git";
import * as ltm from "./ltm";
import * as agentsFile from "./agents-file";
import { config as loreConfig } from "./config";
import * as log from "./log";
import {
  deleteEmbeddings,
  type EmbeddingTable,
  gcVec0DanglingRows,
  readStorageMode,
  repartitionVec0Project,
} from "./db/vec-store";

/**
 * Reclaim the vec0 index rows orphaned by a bulk base-row delete. In vec0 mode a
 * row's vector lives in a separate virtual table, so `DELETE FROM knowledge |
 * temporal_messages | distillations` leaves it dangling; the once-per-startup
 * sweep would otherwise not reclaim it until the next restart (issue #1132). We
 * anti-join-sweep only the vec tables the caller actually deleted from — one
 * scan each, which beats a per-id delete on the un-indexed `temporal_vec`
 * message_id for large scopes, and correctly follows `knowledge_current`.
 *
 * Best-effort: a no-op in blob mode, and any failure is swallowed (the startup
 * `gcVec0DanglingRows` + recall hydration-drop remain the backstop), so vec
 * bookkeeping can never fail a user's delete.
 */
function reclaimVec0Orphans(tables: readonly EmbeddingTable[]): void {
  try {
    if (readStorageMode(db()) === "vec0") gcVec0DanglingRows(db(), tables);
  } catch (e) {
    log.warn("vec0 orphan reclaim after delete failed (harmless):", e);
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProjectSummary = {
  id: string;
  path: string;
  name: string | null;
  git_remote: string | null;
  created_at: number;
  knowledge_count: number;
  session_count: number;
  message_count: number;
  distillation_count: number;
};

export type SessionSummary = {
  session_id: string;
  message_count: number;
  first_message_at: number;
  last_message_at: number;
  distilled_count: number;
  undistilled_count: number;
  distillation_count: number;
};

export type DistillationSummary = {
  id: string;
  session_id: string;
  generation: number;
  token_count: number;
  r_compression: number | null;
  c_norm: number | null;
  archived: number;
  created_at: number;
  call_type: string | null;
};

export type DistillationDetail = DistillationSummary & {
  project_id: string;
  observations: string;
  source_ids: string;
};

export type ClearResult = {
  knowledge_deleted: number;
  temporal_deleted: number;
  distillations_deleted: number;
  sessions_cleared: number;
};

export type GlobalStats = {
  project_count: number;
  knowledge_count: number;
  session_count: number;
  message_count: number;
  distillation_count: number;
  db_size_bytes: number;
};

// ---------------------------------------------------------------------------
// Listing functions
// ---------------------------------------------------------------------------

// Short-lived caches for expensive listing/stats queries. Invalidated by
// mutation functions and on a 5-second TTL so the dashboard never re-runs
// heavy aggregations within a single page render cycle.
let projectsCache: ProjectSummary[] | null = null;
let projectsCacheAt = 0;
let globalStatsCache: GlobalStats | null = null;
let globalStatsCacheAt = 0;
const LIST_CACHE_TTL_MS = 5_000;

/** Invalidate the projects list cache (call after mutations). */
export function invalidateProjectsCache(): void {
  projectsCache = null;
  projectsCacheAt = 0;
}

/** Invalidate the global stats cache (call after mutations). */
export function invalidateGlobalStatsCache(): void {
  globalStatsCache = null;
  globalStatsCacheAt = 0;
}

// Auto-invalidate caches when db.ts creates/merges projects (avoids circular dep).
onProjectMutation(() => {
  invalidateProjectsCache();
  invalidateGlobalStatsCache();
});

/** List all projects with summary counts. */
export function listProjects(): ProjectSummary[] {
  const now = Date.now();
  if (projectsCache && now - projectsCacheAt < LIST_CACHE_TTL_MS) {
    return projectsCache;
  }
  const result = db()
    .query(
      `SELECT p.id, p.path, p.name, p.git_remote, p.created_at,
        COALESCE(k.cnt, 0) AS knowledge_count,
        COALESCE(t.session_count, 0) AS session_count,
        COALESCE(t.message_count, 0) AS message_count,
        COALESCE(d.cnt, 0) AS distillation_count
       FROM projects p
       LEFT JOIN (
         SELECT project_id, COUNT(*) AS cnt
         FROM knowledge_current WHERE confidence > 0.2
         GROUP BY project_id
       ) k ON k.project_id = p.id
       LEFT JOIN (
         SELECT project_id,
                COUNT(DISTINCT session_id) AS session_count,
                COUNT(*) AS message_count
         FROM temporal_messages
         GROUP BY project_id
       ) t ON t.project_id = p.id
       LEFT JOIN (
         SELECT project_id, COUNT(*) AS cnt
         FROM distillations
         GROUP BY project_id
       ) d ON d.project_id = p.id
       ORDER BY p.created_at DESC`,
    )
    .all() as ProjectSummary[];
  projectsCache = result;
  projectsCacheAt = now;
  return result;
}

/** List distinct sessions for a project, with message/distillation counts. */
export function listSessions(
  projectPath: string,
  limit = 50,
): SessionSummary[] {
  const pid = ensureProject(projectPath);
  return db()
    .query(
      `SELECT
        t.session_id,
        COUNT(*) as message_count,
        MIN(t.created_at) as first_message_at,
        MAX(t.created_at) as last_message_at,
        SUM(CASE WHEN t.distilled = 1 THEN 1 ELSE 0 END) as distilled_count,
        SUM(CASE WHEN t.distilled = 0 THEN 1 ELSE 0 END) as undistilled_count,
        COALESCE(d.cnt, 0) as distillation_count
       FROM temporal_messages t
       LEFT JOIN (
         SELECT session_id, COUNT(*) AS cnt
         FROM distillations
         WHERE project_id = ?
         GROUP BY session_id
       ) d ON d.session_id = t.session_id
       WHERE t.project_id = ?
       GROUP BY t.session_id
       ORDER BY MAX(t.created_at) DESC
       LIMIT ?`,
    )
    .all(pid, pid, limit) as SessionSummary[];
}

/**
 * Return the session's CONFIDENTLY-bound project path, or `null`.
 *
 * Reads `session_state.project_path` only when `project_path_provisional = 0`
 * (i.e. the session was bound from a header or an authoritative system-prompt
 * inference, not a cwd fallback or synthetic bucket). This is the strongest
 * available signal for re-attributing a mis-grouped session — it reflects what
 * the gateway already resolved for that conversation. Returns `null` when the
 * session is unknown, has no bound path, or is only provisionally bound.
 */
export function getSessionConfidentProjectPath(
  sessionId: string,
): string | null {
  const row = db()
    .query(
      "SELECT project_path, project_path_provisional FROM session_state WHERE session_id = ?",
    )
    .get(sessionId) as
    | { project_path: string | null; project_path_provisional: number }
    | undefined;
  if (!row?.project_path || row.project_path_provisional !== 0) {
    return null;
  }
  return row.project_path;
}

/** List distillations for a project (optionally filtered by session). */
export function listDistillations(
  projectPath: string,
  opts?: { sessionId?: string; limit?: number },
): DistillationSummary[] {
  const pid = ensureProject(projectPath);
  const limit = opts?.limit ?? 50;

  if (opts?.sessionId) {
    return db()
      .query(
        `SELECT id, session_id, generation, token_count, r_compression, c_norm, archived, created_at, call_type
         FROM distillations
         WHERE project_id = ? AND session_id = ?
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(pid, opts.sessionId, limit) as DistillationSummary[];
  }

  return db()
    .query(
      `SELECT id, session_id, generation, token_count, r_compression, c_norm, archived, created_at, call_type
       FROM distillations
       WHERE project_id = ?
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(pid, limit) as DistillationSummary[];
}

/** Per-session distillation aggregate (cost estimation inputs). */
export type SessionDistillAggregate = {
  session_id: string;
  total_calls: number;
  batch_calls: number;
  /** Sum of token_count across all distillations for the session. */
  total_tokens: number;
  /** Sum of token_count for batch-type distillations only. */
  batch_tokens: number;
};

/**
 * Aggregate distillation stats per session for a project, in a single grouped
 * query. Replaces the per-session `listDistillations` N+1 in cost estimation.
 *
 * Optionally restricts to sessions whose distillations were created on/after
 * `sinceMs` (scope-limiting for historical cost scans).
 */
export function aggregateDistillationsBySession(
  projectPath: string,
  opts?: { sinceMs?: number },
): Map<string, SessionDistillAggregate> {
  const pid = ensureProject(projectPath);
  const sinceMs = opts?.sinceMs ?? 0;
  const rows = db()
    .query(
      `SELECT
         session_id,
         COUNT(*) as total_calls,
         SUM(CASE WHEN call_type = 'batch' THEN 1 ELSE 0 END) as batch_calls,
         SUM(token_count) as total_tokens,
         SUM(CASE WHEN call_type = 'batch' THEN token_count ELSE 0 END) as batch_tokens
       FROM distillations
       WHERE project_id = ? AND created_at >= ?
       GROUP BY session_id`,
    )
    .all(pid, sinceMs) as Array<{
    session_id: string;
    total_calls: number;
    batch_calls: number;
    total_tokens: number;
    batch_tokens: number;
  }>;
  const result = new Map<string, SessionDistillAggregate>();
  for (const row of rows) {
    result.set(row.session_id, {
      session_id: row.session_id,
      total_calls: row.total_calls,
      batch_calls: row.batch_calls ?? 0,
      total_tokens: row.total_tokens ?? 0,
      batch_tokens: row.batch_tokens ?? 0,
    });
  }
  return result;
}

/** Session summary with project context, used by bulk historical cost estimation. */
export type RecentSessionSummary = {
  project_id: string;
  project_path: string;
  project_name: string | null;
  session_id: string;
  message_count: number;
  first_message_at: number;
  last_message_at: number;
};

/**
 * List sessions across ALL projects with activity since `sinceMs`.
 * Single query — replaces the per-project `listSessions()` loop in cost
 * estimation (3P queries → 1).
 *
 * Groups by (project_id, session_id) since session_id is globally unique
 * but the project context is needed for the caller's per-project lookups.
 */
export function listAllRecentSessions(opts?: {
  sinceMs?: number;
  limit?: number;
}): RecentSessionSummary[] {
  const sinceMs = opts?.sinceMs ?? 0;
  const limit = opts?.limit ?? 50_000;
  return db()
    .query(
      `SELECT
         t.project_id,
         p.path AS project_path,
         p.name AS project_name,
         t.session_id,
         COUNT(*) AS message_count,
         MIN(t.created_at) AS first_message_at,
         MAX(t.created_at) AS last_message_at
       FROM temporal_messages t
       JOIN projects p ON p.id = t.project_id
       WHERE t.created_at >= ?
       GROUP BY t.project_id, t.session_id
       ORDER BY MAX(t.created_at) DESC
       LIMIT ?`,
    )
    .all(sinceMs, limit) as RecentSessionSummary[];
}

/**
 * Aggregate distillation stats per session across ALL projects.
 * Single query — replaces the per-project loop in cost estimation.
 *
 * INVARIANT: session_id is globally unique (generateSessionID uses 8 random
 * bytes + timestamp). If this ever changes, GROUP BY must include project_id.
 */
export function aggregateDistillationsBySessionAll(opts?: {
  sinceMs?: number;
}): Map<string, SessionDistillAggregate> {
  const sinceMs = opts?.sinceMs ?? 0;
  const rows = db()
    .query(
      `SELECT
         session_id,
         COUNT(*) as total_calls,
         SUM(CASE WHEN call_type = 'batch' THEN 1 ELSE 0 END) as batch_calls,
         SUM(token_count) as total_tokens,
         SUM(CASE WHEN call_type = 'batch' THEN token_count ELSE 0 END) as batch_tokens
       FROM distillations
       WHERE created_at >= ?
       GROUP BY session_id`,
    )
    .all(sinceMs) as Array<{
    session_id: string;
    total_calls: number;
    batch_calls: number;
    total_tokens: number;
    batch_tokens: number;
  }>;
  const result = new Map<string, SessionDistillAggregate>();
  for (const row of rows) {
    result.set(row.session_id, {
      session_id: row.session_id,
      total_calls: row.total_calls,
      batch_calls: row.batch_calls ?? 0,
      total_tokens: row.total_tokens ?? 0,
      batch_tokens: row.batch_tokens ?? 0,
    });
  }
  return result;
}

/**
 * One materialized session row from `session_rollup`, joined to its project, with
 * everything the costs page needs in a single read (#981). Replaces the three
 * O(N temporal_messages) bulk aggregates (`listAllRecentSessions`,
 * `aggregateTokensBySessionAll`, `aggregateDistillationsBySessionAll`).
 */
export type SessionRollupSummary = {
  project_id: string;
  project_path: string;
  project_name: string | null;
  session_id: string;
  message_count: number;
  first_message_at: number;
  last_message_at: number;
  /** Whole-session SUM(tokens). */
  total_tokens: number;
  /** Metadata of the earliest assistant message (for model detection), or null. */
  first_assistant_metadata: string | null;
  distill_total_calls: number;
  distill_batch_calls: number;
  distill_total_tokens: number;
  distill_batch_tokens: number;
};

/**
 * List per-session rollup rows (across ALL projects) for the costs page. Reads the
 * materialized `session_rollup` table — O(sessions), independent of the total
 * `temporal_messages` count — instead of scanning every message row.
 *
 * `sinceMs` scopes to sessions last active on/after the cutoff (filters
 * `last_message_at`); unlike the old per-message `created_at >= sinceMs` filter,
 * the token/count totals are whole-session. With the 90-day costs window and
 * short-lived sessions these are equivalent (a session is effectively always
 * entirely inside or outside the window), and the whole-session total no longer
 * splits a boundary-straddling session.
 *
 * Resolves any `dirty` rollup rows from source first (a delete of an extreme row
 * defers the MIN/MAX/earliest-assistant recompute to read time), so the returned
 * values always match a full recompute.
 */
export function listSessionRollups(opts?: {
  sinceMs?: number;
  limit?: number;
}): SessionRollupSummary[] {
  const sinceMs = opts?.sinceMs ?? 0;
  const limit = opts?.limit ?? 50_000;
  rebuildDirtySessionRollups(db());
  return db()
    .query(
      `SELECT
         sr.project_id,
         p.path AS project_path,
         p.name AS project_name,
         sr.session_id,
         sr.message_count,
         sr.first_message_at,
         sr.last_message_at,
         sr.token_sum AS total_tokens,
         sr.first_assistant_metadata,
         sr.distill_calls AS distill_total_calls,
         sr.distill_batch_calls,
         sr.distill_token_sum AS distill_total_tokens,
         sr.distill_batch_token_sum AS distill_batch_tokens
       FROM session_rollup sr
       JOIN projects p ON p.id = sr.project_id
       WHERE sr.message_count > 0 AND sr.last_message_at >= ?
       ORDER BY sr.last_message_at DESC
       LIMIT ?`,
    )
    .all(sinceMs, limit) as SessionRollupSummary[];
}

/** Get a single distillation by ID (or resolved prefix). */
export function getDistillation(id: string): DistillationDetail | null {
  return db()
    .query(
      `SELECT id, project_id, session_id, observations, source_ids, generation,
              token_count, r_compression, c_norm, archived, created_at
       FROM distillations WHERE id = ?`,
    )
    .get(id) as DistillationDetail | null;
}

/**
 * Resolve a partial ID prefix to a full ID for a given table.
 * Returns null if 0 or 2+ matches (ambiguous prefix).
 */
export function resolveId(
  table: "knowledge" | "distillations",
  prefix: string,
): string | null {
  if (table === "knowledge") {
    // A2 (#823): the id a user holds is the entry's stable logical_id; the
    // current version's row id may differ, and the base table holds every
    // (timestamp-prefix-sharing) version. Resolve the prefix against the
    // logical_id of CURRENT entries so it stays unique and points at a live entry.
    const results = db()
      .query(
        "SELECT DISTINCT logical_id AS id FROM knowledge_current WHERE logical_id LIKE ? LIMIT 2",
      )
      .all(`${prefix}%`) as Array<{ id: string }>;
    return results.length === 1 ? results[0].id : null;
  }
  const results = db()
    .query(`SELECT id FROM ${table} WHERE id LIKE ? LIMIT 2`)
    .all(`${prefix}%`) as Array<{ id: string }>;
  return results.length === 1 ? results[0].id : null;
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

/** Global stats for the dashboard. */
export function globalStats(): GlobalStats {
  const now = Date.now();
  if (globalStatsCache && now - globalStatsCacheAt < LIST_CACHE_TTL_MS) {
    return globalStatsCache;
  }

  const row = db()
    .query(
      `SELECT
        (SELECT COUNT(*) FROM projects) as project_count,
        (SELECT COUNT(*) FROM knowledge_current WHERE confidence > 0.2) as knowledge_count,
        (SELECT COUNT(DISTINCT session_id) FROM temporal_messages) as session_count,
        (SELECT COUNT(*) FROM temporal_messages) as message_count,
        (SELECT COUNT(*) FROM distillations) as distillation_count`,
    )
    .get() as Omit<GlobalStats, "db_size_bytes">;

  let db_size_bytes = 0;
  try {
    const p = dbPath();
    db_size_bytes = statSync(p).size;
    // Add WAL file size if present
    const walPath = `${p}-wal`;
    if (existsSync(walPath)) {
      db_size_bytes += statSync(walPath).size;
    }
  } catch {
    // File may not exist yet or stat fails
  }

  const result = { ...row, db_size_bytes };
  globalStatsCache = result;
  globalStatsCacheAt = now;
  return result;
}

// ---------------------------------------------------------------------------
// Deletion functions
// ---------------------------------------------------------------------------

/**
 * Count rows that will be affected, for confirmation prompts.
 */
export function countForProject(projectPath: string): {
  knowledge: number;
  messages: number;
  distillations: number;
  sessions: number;
} {
  const pid = projectId(projectPath);
  if (!pid) return { knowledge: 0, messages: 0, distillations: 0, sessions: 0 };

  const row = db()
    .query(
      `SELECT
        (SELECT COUNT(*) FROM knowledge_current WHERE project_id = ? AND confidence > 0.2) as knowledge,
        (SELECT COUNT(*) FROM temporal_messages WHERE project_id = ?) as messages,
        (SELECT COUNT(*) FROM distillations WHERE project_id = ?) as distillations,
        (SELECT COUNT(DISTINCT session_id) FROM temporal_messages WHERE project_id = ?) as sessions`,
    )
    .get(pid, pid, pid, pid) as {
    knowledge: number;
    messages: number;
    distillations: number;
    sessions: number;
  };

  return row;
}

/**
 * Clear all data for a project.
 * Deletes: knowledge, temporal_messages, distillations, session_state.
 * Does NOT delete the project row itself (preserves path->id mapping).
 * Regenerates `.lore.md` if the project path exists on disk.
 */
export function clearProject(projectPath: string): ClearResult {
  const pid = ensureProject(projectPath);
  const database = db();

  // Count before deleting (result.changes is inflated by FTS triggers)
  const counts = {
    knowledge: (
      database
        .query(
          "SELECT COUNT(*) as c FROM knowledge_current WHERE project_id = ?",
        )
        .get(pid) as { c: number }
    ).c,
    temporal: (
      database
        .query(
          "SELECT COUNT(*) as c FROM temporal_messages WHERE project_id = ?",
        )
        .get(pid) as { c: number }
    ).c,
    distillations: (
      database
        .query("SELECT COUNT(*) as c FROM distillations WHERE project_id = ?")
        .get(pid) as { c: number }
    ).c,
    sessions: (
      database
        .query(
          "SELECT COUNT(DISTINCT session_id) as c FROM temporal_messages WHERE project_id = ?",
        )
        .get(pid) as { c: number }
    ).c,
  };

  // Delete in dependency order
  database.exec("BEGIN IMMEDIATE");
  try {
    database
      .query("DELETE FROM session_prompt_deltas WHERE project_id = ?")
      .run(pid);
    // Delete session_state BEFORE temporal_messages (subquery needs the rows)
    database
      .query(
        `DELETE FROM session_state WHERE session_id IN
         (SELECT DISTINCT session_id FROM temporal_messages WHERE project_id = ?)`,
      )
      .run(pid);
    database.query("DELETE FROM tool_calls WHERE project_id = ?").run(pid);
    // knowledge_transfers has two project columns (origin via knowledge_id, and
    // recalled_in). Delete BEFORE knowledge so the subquery still sees the rows.
    database
      .query(
        "DELETE FROM knowledge_transfers WHERE recalled_in_project_id = ? OR knowledge_id IN (SELECT logical_id FROM knowledge WHERE project_id = ?)",
      )
      .run(pid, pid);
    // Per-entry validation bookkeeping keyed on logical_id (no FK CASCADE) —
    // delete BEFORE knowledge so the subquery still sees the rows (#990).
    for (const table of ltm.LOGICAL_ID_BOOKKEEPING_TABLES) {
      database
        .query(
          `DELETE FROM ${table} WHERE logical_id IN (SELECT logical_id FROM knowledge WHERE project_id = ?)`,
        )
        .run(pid);
    }
    // Outcome-reward injection log (#497) carries a project_id column, so sweep
    // it by project scope directly — this also reclaims any rows already
    // orphaned by a prior delete that predates this fix (#996).
    database
      .query("DELETE FROM knowledge_session_injections WHERE project_id = ?")
      .run(pid);
    // Contradiction pairs (#1123) reference TWO logical_ids, so they can't ride
    // a single-column project sweep — purge any pair touching this project's
    // entries BEFORE the knowledge rows go, while the subquery can still see them.
    database
      .query(
        `DELETE FROM knowledge_contradictions
         WHERE logical_id_a IN (SELECT logical_id FROM knowledge WHERE project_id = ?)
            OR logical_id_b IN (SELECT logical_id FROM knowledge WHERE project_id = ?)`,
      )
      .run(pid, pid);
    database.query("DELETE FROM knowledge WHERE project_id = ?").run(pid);
    database
      .query("DELETE FROM temporal_messages WHERE project_id = ?")
      .run(pid);
    database.query("DELETE FROM distillations WHERE project_id = ?").run(pid);
    database.query("DELETE FROM lat_sections WHERE project_id = ?").run(pid);
    database.exec("COMMIT");
  } catch (e) {
    database.exec("ROLLBACK");
    throw e;
  }

  // Base rows are gone (committed above) — reclaim their now-dangling vec0 chunks.
  reclaimVec0Orphans(["knowledge", "temporal", "distillations"]);

  // Regenerate or delete .lore.md depending on toggle
  if (existsSync(projectPath)) {
    try {
      if (loreConfig().loreFile.enabled) {
        agentsFile.exportLoreFile(projectPath);
      } else {
        agentsFile.deleteLoreFile(projectPath);
      }
    } catch {
      // Non-fatal: project dir may not be writable
    }
  }

  invalidateProjectsCache();
  invalidateGlobalStatsCache();

  return {
    knowledge_deleted: counts.knowledge,
    temporal_deleted: counts.temporal,
    distillations_deleted: counts.distillations,
    sessions_cleared: counts.sessions,
  };
}

/**
 * Fully delete a project: all associated data AND the project row itself.
 * Also removes path aliases pointing to this project.
 *
 * Unlike clearProject(), this does NOT call ensureProject() (avoids
 * re-creating the project) and does NOT regenerate .lore.md.
 *
 * Returns deletion counts, or null if the project ID doesn't exist.
 */
export function deleteProject(projectId: string): ClearResult | null {
  const database = db();

  // Verify the project exists and collect all paths BEFORE deleting.
  // We need these to invalidate the .lore.md file cache (kv_meta) after
  // deletion — otherwise shouldImportLoreFile() sees the stale cache,
  // skips re-import, and the curator overwrites .lore.md with junk.
  const project = database
    .query("SELECT id, path FROM projects WHERE id = ?")
    .get(projectId) as { id: string; path: string } | null;
  if (!project) return null;

  const aliasPaths = database
    .query("SELECT path FROM project_path_aliases WHERE project_id = ?")
    .all(projectId) as { path: string }[];
  const allPaths = [project.path, ...aliasPaths.map((r) => r.path)];

  // Count before deleting
  const counts = {
    knowledge: (
      database
        .query(
          "SELECT COUNT(*) as c FROM knowledge_current WHERE project_id = ?",
        )
        .get(projectId) as { c: number }
    ).c,
    temporal: (
      database
        .query(
          "SELECT COUNT(*) as c FROM temporal_messages WHERE project_id = ?",
        )
        .get(projectId) as { c: number }
    ).c,
    distillations: (
      database
        .query("SELECT COUNT(*) as c FROM distillations WHERE project_id = ?")
        .get(projectId) as { c: number }
    ).c,
    sessions: (
      database
        .query(
          "SELECT COUNT(DISTINCT session_id) as c FROM temporal_messages WHERE project_id = ?",
        )
        .get(projectId) as { c: number }
    ).c,
  };

  database.exec("BEGIN IMMEDIATE");
  try {
    database
      .query("DELETE FROM session_prompt_deltas WHERE project_id = ?")
      .run(projectId);
    // Delete session_state BEFORE temporal_messages (subquery needs the rows)
    database
      .query(
        `DELETE FROM session_state WHERE session_id IN
         (SELECT DISTINCT session_id FROM temporal_messages WHERE project_id = ?)`,
      )
      .run(projectId);
    database
      .query("DELETE FROM tool_calls WHERE project_id = ?")
      .run(projectId);
    // knowledge_transfers has two project columns (origin via knowledge_id, and
    // recalled_in). Delete BEFORE knowledge so the subquery still sees the rows.
    database
      .query(
        "DELETE FROM knowledge_transfers WHERE recalled_in_project_id = ? OR knowledge_id IN (SELECT logical_id FROM knowledge WHERE project_id = ?)",
      )
      .run(projectId, projectId);
    // Per-entry validation bookkeeping keyed on logical_id (no FK CASCADE) —
    // delete BEFORE knowledge so the subquery still sees the rows (#990).
    for (const table of ltm.LOGICAL_ID_BOOKKEEPING_TABLES) {
      database
        .query(
          `DELETE FROM ${table} WHERE logical_id IN (SELECT logical_id FROM knowledge WHERE project_id = ?)`,
        )
        .run(projectId);
    }
    // Outcome-reward injection log (#497) carries a project_id column, so sweep
    // it by project scope directly — this also reclaims any rows already
    // orphaned by a prior delete that predates this fix (#996).
    database
      .query("DELETE FROM knowledge_session_injections WHERE project_id = ?")
      .run(projectId);
    // Contradiction pairs (#1123): purge any pair touching this project's
    // entries before the knowledge rows go (composite key, can't ride the loop).
    database
      .query(
        `DELETE FROM knowledge_contradictions
         WHERE logical_id_a IN (SELECT logical_id FROM knowledge WHERE project_id = ?)
            OR logical_id_b IN (SELECT logical_id FROM knowledge WHERE project_id = ?)`,
      )
      .run(projectId, projectId);
    database.query("DELETE FROM knowledge WHERE project_id = ?").run(projectId);
    database
      .query("DELETE FROM temporal_messages WHERE project_id = ?")
      .run(projectId);
    database
      .query("DELETE FROM distillations WHERE project_id = ?")
      .run(projectId);
    database
      .query("DELETE FROM lat_sections WHERE project_id = ?")
      .run(projectId);
    // Explicit delete for safety (FK CASCADE depends on PRAGMA foreign_keys)
    database
      .query("DELETE FROM project_path_aliases WHERE project_id = ?")
      .run(projectId);
    database
      .query("DELETE FROM warmup_histograms WHERE project_id = ?")
      .run(projectId);
    // Finally, delete the project row itself
    database.query("DELETE FROM projects WHERE id = ?").run(projectId);
    database.exec("COMMIT");
  } catch (e) {
    database.exec("ROLLBACK");
    throw e;
  }

  // Base rows are gone (committed above) — reclaim their now-dangling vec0 chunks.
  reclaimVec0Orphans(["knowledge", "temporal", "distillations"]);

  // Invalidate the .lore.md file cache for all known paths so that
  // shouldImportLoreFile() re-checks the file if this project path
  // is reused. Without this, the stale cache causes the import to be
  // skipped, the curator creates junk entries, and exportLoreFile()
  // overwrites the good .lore.md with garbage.
  for (const p of allPaths) {
    agentsFile.clearLoreFileCache(p);
  }

  invalidateProjectsCache();
  invalidateGlobalStatsCache();

  return {
    knowledge_deleted: counts.knowledge,
    temporal_deleted: counts.temporal,
    distillations_deleted: counts.distillations,
    sessions_cleared: counts.sessions,
  };
}

/** Rename a project. Returns true if the project exists and was renamed. */
export function renameProject(projectId: string, newName: string): boolean {
  const result = db()
    .query("UPDATE projects SET name = ? WHERE id = ?")
    .run(newName.trim(), projectId);
  if (result.changes > 0) invalidateProjectsCache();
  return result.changes > 0;
}

/** Clear only knowledge entries for a project. Regenerates .lore.md. */
export function clearKnowledge(projectPath: string): number {
  const pid = ensureProject(projectPath);
  const count = (
    db()
      .query("SELECT COUNT(*) as c FROM knowledge_current WHERE project_id = ?")
      .get(pid) as { c: number }
  ).c;

  // Clean up transfer metrics before deleting entries (no FK CASCADE).
  db()
    .query(
      "DELETE FROM knowledge_transfers WHERE knowledge_id IN (SELECT logical_id FROM knowledge WHERE project_id = ?)",
    )
    .run(pid);
  // Per-entry validation bookkeeping keyed on logical_id (no FK CASCADE) —
  // delete BEFORE knowledge so the subquery still sees the rows (#990).
  for (const table of ltm.LOGICAL_ID_BOOKKEEPING_TABLES) {
    db()
      .query(
        `DELETE FROM ${table} WHERE logical_id IN (SELECT logical_id FROM knowledge WHERE project_id = ?)`,
      )
      .run(pid);
  }
  // Outcome-reward injection log (#497) carries a project_id column, so sweep
  // it by project scope directly — this also reclaims any rows already orphaned
  // by a prior delete that predates this fix (#996).
  db()
    .query("DELETE FROM knowledge_session_injections WHERE project_id = ?")
    .run(pid);
  // Contradiction pairs (#1123): purge any pair touching this project's entries
  // before the knowledge rows go (composite key, can't ride the loop).
  db()
    .query(
      `DELETE FROM knowledge_contradictions
       WHERE logical_id_a IN (SELECT logical_id FROM knowledge WHERE project_id = ?)
          OR logical_id_b IN (SELECT logical_id FROM knowledge WHERE project_id = ?)`,
    )
    .run(pid, pid);
  db().query("DELETE FROM knowledge WHERE project_id = ?").run(pid);
  reclaimVec0Orphans(["knowledge"]);

  invalidateProjectsCache();
  invalidateGlobalStatsCache();

  // Regenerate or delete .lore.md depending on toggle
  if (existsSync(projectPath)) {
    try {
      if (loreConfig().loreFile.enabled) {
        agentsFile.exportLoreFile(projectPath);
      } else {
        agentsFile.deleteLoreFile(projectPath);
      }
    } catch {
      // Non-fatal
    }
  }

  return count;
}

/** Clear only temporal messages for a project. */
export function clearTemporal(projectPath: string): number {
  const pid = ensureProject(projectPath);
  const count = (
    db()
      .query("SELECT COUNT(*) as c FROM temporal_messages WHERE project_id = ?")
      .get(pid) as { c: number }
  ).c;

  db().query("DELETE FROM temporal_messages WHERE project_id = ?").run(pid);
  reclaimVec0Orphans(["temporal"]);

  invalidateProjectsCache();
  invalidateGlobalStatsCache();

  return count;
}

/** Clear only distillations for a project. */
export function clearDistillations(projectPath: string): number {
  const pid = ensureProject(projectPath);
  const count = (
    db()
      .query("SELECT COUNT(*) as c FROM distillations WHERE project_id = ?")
      .get(pid) as { c: number }
  ).c;

  db().query("DELETE FROM distillations WHERE project_id = ?").run(pid);
  reclaimVec0Orphans(["distillations"]);

  invalidateProjectsCache();
  invalidateGlobalStatsCache();

  return count;
}

/** Delete a single knowledge entry. Returns true if found and deleted. */
export function deleteKnowledge(id: string): boolean {
  // id may be a current OR superseded version id (or the logical_id == v1 id).
  // Resolve to the current entry via the stable logical_id (A2, #823).
  const entry = ltm.get(id) ?? ltm.getByLogical(ltm.logicalIdOf(id));
  if (!entry) return false;
  ltm.remove(entry.logical_id);
  invalidateProjectsCache();
  invalidateGlobalStatsCache();
  return true;
}

/** Delete a single distillation. Returns true if found and deleted. */
export function deleteDistillation(id: string): boolean {
  const existing = getDistillation(id);
  if (!existing) return false;
  db().query("DELETE FROM distillations WHERE id = ?").run(id);
  // Single known id → point-delete its vec0 chunk (indexed by the vec PK); no
  // need for the whole-table anti-join sweep here. Best-effort like
  // reclaimVec0Orphans: no-op in blob mode, and any failure is swallowed (the
  // base row is already gone; the startup sweep + hydration-drop backstop it) so
  // vec bookkeeping can never fail a delete that already succeeded.
  try {
    deleteEmbeddings(db(), "distillations", [id]);
  } catch (e) {
    log.warn(
      "vec0 chunk delete after distillation delete failed (harmless):",
      e,
    );
  }
  invalidateProjectsCache();
  invalidateGlobalStatsCache();
  return true;
}

/**
 * Delete all data for a specific session (messages + distillations + session_state).
 */
export function deleteSession(
  projectPath: string,
  sessionId: string,
): { messages_deleted: number; distillations_deleted: number } {
  const pid = ensureProject(projectPath);
  const database = db();

  const msgCount = (
    database
      .query(
        "SELECT COUNT(*) as c FROM temporal_messages WHERE project_id = ? AND session_id = ?",
      )
      .get(pid, sessionId) as { c: number }
  ).c;

  const distCount = (
    database
      .query(
        "SELECT COUNT(*) as c FROM distillations WHERE project_id = ? AND session_id = ?",
      )
      .get(pid, sessionId) as { c: number }
  ).c;

  // Note: knowledge_transfers has no session_id column (it is a pure per-project
  // tally); per-session dedup is handled in-memory in ltm.ts, so there is
  // nothing session-scoped to delete here.
  database
    .query("DELETE FROM tool_calls WHERE project_id = ? AND session_id = ?")
    .run(pid, sessionId);
  database
    .query("DELETE FROM session_prompt_deltas WHERE session_id = ?")
    .run(sessionId);
  database
    .query(
      "DELETE FROM temporal_messages WHERE project_id = ? AND session_id = ?",
    )
    .run(pid, sessionId);
  database
    .query("DELETE FROM distillations WHERE project_id = ? AND session_id = ?")
    .run(pid, sessionId);
  database
    .query("DELETE FROM session_state WHERE session_id = ?")
    .run(sessionId);
  // Outcome-reward injection log (#497) is keyed on session_id — purge it here
  // or its rows orphan once the session's messages are gone (#996).
  database
    .query("DELETE FROM knowledge_session_injections WHERE session_id = ?")
    .run(sessionId);

  // Reclaim the session's now-dangling temporal/distillation vec0 chunks.
  reclaimVec0Orphans(["temporal", "distillations"]);

  invalidateProjectsCache();
  invalidateGlobalStatsCache();

  return { messages_deleted: msgCount, distillations_deleted: distCount };
}

// ---------------------------------------------------------------------------
// Session move / reassign
// ---------------------------------------------------------------------------

export type MoveSessionsResult = {
  sessions_moved: number;
  messages_moved: number;
  distillations_moved: number;
  tool_calls_moved: number;
  knowledge_moved: number;
  /** Full list of session IDs that were moved (including BFS-expanded children).
   *  Callers use this to rebind in-memory active session states. */
  movedSessionIds: string[];
};

/**
 * Take a CONSISTENT backup of the live database via SQLite `VACUUM INTO`.
 *
 * Unlike `cp`, `VACUUM INTO` reads through the same connection inside a
 * transaction, so it captures a coherent snapshot even while the gateway is
 * writing (WAL pages are merged into the copy). The source DB and its
 * `-wal`/`-shm` files are NEVER touched — this is read-only with respect to
 * live data. Returns the absolute path of the backup file.
 *
 * Use this before any destructive maintenance (e.g. `lore data split --yes`)
 * so a mistake is always recoverable. Callers must NEVER delete the live
 * `-wal`/`-shm` files or `cp` over a live DB — let SQLite manage them.
 */
export function backupDatabase(destPath?: string): string {
  const src = dbPath();
  const dest =
    destPath ??
    `${src}.backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  // Never let the backup target collide with the live DB — the cleanup below
  // would otherwise delete the live file and its WAL/SHM. Guards the exported
  // API against a caller passing the live path.
  if (resolvePath(dest) === resolvePath(src)) {
    throw new Error(
      `backupDatabase: destination must differ from the live DB path (${src})`,
    );
  }
  // VACUUM INTO refuses to overwrite an existing file; clear any stale target
  // (and its sidecar files) first. We only ever remove files WE are creating.
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      rmSync(`${dest}${suffix}`, { force: true });
    } catch {
      // best-effort cleanup of our own target
    }
  }
  db().query("VACUUM INTO ?").run(dest);
  return dest;
}

/** Result of a post-mutation database integrity validation. */
export type IntegrityResult = {
  ok: boolean;
  integrity: string;
  /** knowledge row count vs knowledge_fts row count (must match). */
  knowledgeFtsMatch: boolean;
  messageCount: number;
};

/**
 * Validate database integrity after a maintenance mutation: SQLite
 * `integrity_check`, knowledge/FTS parity, and total message count (the caller
 * compares this against a pre-mutation count to assert nothing was lost).
 */
export function validateDatabaseIntegrity(): IntegrityResult {
  const integrity =
    (
      db().query("PRAGMA integrity_check").get() as
        | { integrity_check: string }
        | undefined
    )?.integrity_check ?? "unknown";
  // NOTE (A2, #823): knowledge_fts is an external-content FTS5 table, so a plain
  // `COUNT(*) FROM knowledge_fts` scans the CONTENT table (knowledge) by rowid —
  // it returns the physical row count, NOT the indexed-posting count. So this
  // parity stays COUNT(knowledge) === COUNT(knowledge_fts) and is unaffected by
  // versioning (both sides count every physical version). It does NOT verify the
  // partial index (current+live only); a real index check would use FTS5
  // 'integrity-check' — deferred.
  const kn = (db()
    .query(
      "SELECT (SELECT COUNT(*) FROM knowledge) AS a, (SELECT COUNT(*) FROM knowledge_fts) AS b",
    )
    .get() as { a: number; b: number } | undefined) ?? { a: 0, b: 0 };
  const messageCount =
    (
      db().query("SELECT COUNT(*) AS c FROM temporal_messages").get() as
        | { c: number }
        | undefined
    )?.c ?? 0;
  return {
    ok: integrity === "ok" && kn.a === kn.b,
    integrity,
    knowledgeFtsMatch: kn.a === kn.b,
    messageCount,
  };
}

/**
 * Move one or more sessions from one project to another.
 *
 * Re-points `temporal_messages`, `distillations`, `tool_calls`, and
 * `session_state` for the given session IDs from `fromProjectId` to the
 * project at `toProjectPath` (created via `ensureProject` if needed).
 *
 * Knowledge entries linked by `source_session` are also moved. Knowledge
 * with `source_session = NULL` is NOT touched — use `reassignKnowledge()`
 * for those.
 *
 * By default, sub-agent child sessions (linked via `parent_session_id`)
 * are expanded and included. Pass `{ includeChildren: false }` to move
 * only the explicitly listed sessions.
 */
export function moveSessions(
  sessionIds: string[],
  fromProjectId: string,
  toProjectPath: string,
  opts?: { includeChildren?: boolean; gitRemote?: string },
): MoveSessionsResult {
  const emptyResult: MoveSessionsResult = {
    sessions_moved: 0,
    messages_moved: 0,
    distillations_moved: 0,
    tool_calls_moved: 0,
    knowledge_moved: 0,
    movedSessionIds: [],
  };

  if (!sessionIds.length) return emptyResult;

  const toId = ensureProject(toProjectPath, undefined, opts?.gitRemote);

  // Same project → idempotent no-op.
  if (fromProjectId === toId) return emptyResult;

  // Expand to include sub-agent children unless explicitly opted out.
  let allIds = [...new Set(sessionIds)];
  if (opts?.includeChildren !== false) {
    const parentChildMap = loadParentChildMap();
    // Build a reverse map: parent → children
    const childrenOf = new Map<string, string[]>();
    for (const [childId, parentId] of parentChildMap) {
      let children = childrenOf.get(parentId);
      if (!children) {
        children = [];
        childrenOf.set(parentId, children);
      }
      children.push(childId);
    }
    // BFS to collect all descendants of the requested sessions.
    const expanded = new Set(allIds);
    const queue = [...allIds];
    while (queue.length > 0) {
      const current = queue.pop();
      if (current === undefined) break;
      const children = childrenOf.get(current);
      if (children) {
        for (const child of children) {
          if (!expanded.has(child)) {
            expanded.add(child);
            queue.push(child);
          }
        }
      }
    }
    allIds = [...expanded];
  }

  const database = db();
  const placeholders = allIds.map(() => "?").join(",");

  // Count rows before the UPDATE (FTS triggers inflate stmt.changes).
  // Also count distinct sessions that actually have data in the source
  // project — the expanded allIds may include sessions that don't exist
  // in this project, and we must not overcount.
  const sessionCount = (
    database
      .query(
        `SELECT COUNT(DISTINCT session_id) as c FROM temporal_messages WHERE project_id = ? AND session_id IN (${placeholders})`,
      )
      .get(fromProjectId, ...allIds) as { c: number }
  ).c;

  const msgCount = (
    database
      .query(
        `SELECT COUNT(*) as c FROM temporal_messages WHERE project_id = ? AND session_id IN (${placeholders})`,
      )
      .get(fromProjectId, ...allIds) as { c: number }
  ).c;

  const distCount = (
    database
      .query(
        `SELECT COUNT(*) as c FROM distillations WHERE project_id = ? AND session_id IN (${placeholders})`,
      )
      .get(fromProjectId, ...allIds) as { c: number }
  ).c;

  const toolCount = (
    database
      .query(
        `SELECT COUNT(*) as c FROM tool_calls WHERE project_id = ? AND session_id IN (${placeholders})`,
      )
      .get(fromProjectId, ...allIds) as { c: number }
  ).c;

  const knowledgeCount = (
    database
      .query(
        `SELECT COUNT(*) as c FROM knowledge_current WHERE project_id = ? AND source_session IN (${placeholders})`,
      )
      .get(fromProjectId, ...allIds) as { c: number }
  ).c;

  // Collect logical_ids of knowledge entries being moved (knowledge_transfers
  // keys on logical_id, A2). DISTINCT because an entry may have multiple versions.
  const movedKnowledgeIds = (
    database
      .query(
        `SELECT DISTINCT logical_id FROM knowledge WHERE project_id = ? AND source_session IN (${placeholders})`,
      )
      .all(fromProjectId, ...allIds) as Array<{ logical_id: string }>
  ).map((r) => r.logical_id);

  // All mutations in a single transaction.
  database.query("BEGIN IMMEDIATE").run();
  try {
    database
      .query(
        `UPDATE temporal_messages SET project_id = ? WHERE project_id = ? AND session_id IN (${placeholders})`,
      )
      .run(toId, fromProjectId, ...allIds);

    database
      .query(
        `UPDATE distillations SET project_id = ? WHERE project_id = ? AND session_id IN (${placeholders})`,
      )
      .run(toId, fromProjectId, ...allIds);

    // vec0: the base project_id UPDATEs above leave temporal_vec/distillation_vec
    // partitioned under the OLD project. vec0 forbids UPDATE of a partition key,
    // so re-point by DELETE+reINSERT — inside this transaction so a failure rolls
    // the whole move back (a stale partition silently breaks scoped recall and
    // has no orphan-sweep backstop). No-op in blob mode.
    repartitionVec0Project(database, fromProjectId, toId, allIds);

    // Re-point the session rollup set-based: the project_id UPDATEs above do NOT
    // fire the rollup triggers (scoped to content/tokens/metadata + insert/delete),
    // so move the rows here. session_id is globally unique ⇒ no PK collision.
    database
      .query(
        `UPDATE session_rollup SET project_id = ? WHERE project_id = ? AND session_id IN (${placeholders})`,
      )
      .run(toId, fromProjectId, ...allIds);

    database
      .query(
        `UPDATE tool_calls SET project_id = ? WHERE project_id = ? AND session_id IN (${placeholders})`,
      )
      .run(toId, fromProjectId, ...allIds);

    database
      .query(
        `UPDATE session_prompt_deltas SET project_id = ? WHERE project_id = ? AND session_id IN (${placeholders})`,
      )
      .run(toId, fromProjectId, ...allIds);

    // Outcome-reward injection log (#497) is keyed on session_id and scoped by
    // project_id; creditSessionOutcome filters on the session's CURRENT project,
    // so the rows must follow the session to the target or its credits are
    // silently dropped (and the rows orphan if the source project is later
    // deleted). Mirror the per-session re-point above. (#996)
    database
      .query(
        `UPDATE knowledge_session_injections SET project_id = ? WHERE project_id = ? AND session_id IN (${placeholders})`,
      )
      .run(toId, fromProjectId, ...allIds);

    // Re-bind session_state to the target project path (confident, not provisional).
    database
      .query(
        `UPDATE session_state SET project_path = ?, project_path_provisional = 0 WHERE session_id IN (${placeholders})`,
      )
      .run(toProjectPath, ...allIds);

    // Move knowledge entries linked by source_session.
    database
      .query(
        `UPDATE knowledge SET project_id = ? WHERE project_id = ? AND source_session IN (${placeholders})`,
      )
      .run(toId, fromProjectId, ...allIds);

    // Clean up knowledge_transfers that became self-referential after the
    // move: an entry whose project_id is now toId, recalled in toId.
    // This mirrors the self-referential cleanup in mergeProjectInternal().
    if (movedKnowledgeIds.length > 0) {
      const kPlaceholders = movedKnowledgeIds.map(() => "?").join(",");
      database
        .query(
          `DELETE FROM knowledge_transfers
           WHERE recalled_in_project_id = ?
             AND knowledge_id IN (${kPlaceholders})`,
        )
        .run(toId, ...movedKnowledgeIds);
    }

    database.query("COMMIT").run();
  } catch (e) {
    database.query("ROLLBACK").run();
    throw e;
  }

  invalidateProjectsCache();
  invalidateGlobalStatsCache();
  invalidateParentChildCache();

  return {
    sessions_moved: sessionCount,
    messages_moved: msgCount,
    distillations_moved: distCount,
    tool_calls_moved: toolCount,
    knowledge_moved: knowledgeCount,
    movedSessionIds: allIds,
  };
}

/**
 * Reassign a single knowledge entry to a different project.
 *
 * Useful for curator/aggregate entries with `source_session = NULL` that
 * were not automatically moved by `moveSessions()`.
 *
 * Returns `true` on success, `false` if the entry does not exist.
 */
export function reassignKnowledge(
  knowledgeId: string,
  toProjectPath: string,
  opts?: { gitRemote?: string },
): boolean {
  // Resolve to the current entry via the stable logical_id (A2, #823).
  const entry =
    ltm.get(knowledgeId) ?? ltm.getByLogical(ltm.logicalIdOf(knowledgeId));
  if (!entry) return false;

  const toId = ensureProject(toProjectPath, undefined, opts?.gitRemote);
  if (entry.project_id === toId) return true; // already there

  const oldProjectId = entry.project_id;
  // Move ALL versions of the logical entry so a multi-version entry isn't split
  // across projects (reviewer NIT).
  db()
    .query("UPDATE knowledge SET project_id = ? WHERE logical_id = ?")
    .run(toId, entry.logical_id);

  invalidateProjectsCache();
  invalidateGlobalStatsCache();

  // Best-effort: re-export .lore.md for both old and new projects.
  // Guard with existsSync for central/remote setups where paths may not
  // exist on the gateway host's filesystem.
  try {
    if (toProjectPath && existsSync(toProjectPath)) {
      agentsFile.exportLoreFile(toProjectPath);
    }
    if (oldProjectId) {
      const oldPath = getProjectPathById(oldProjectId);
      if (oldPath && existsSync(oldPath)) {
        agentsFile.exportLoreFile(oldPath);
      }
    }
  } catch {
    // Best-effort — don't fail the reassignment if .lore.md export fails.
  }

  return true;
}

/**
 * Nuclear option: close the DB, delete the file, re-initialize.
 * Returns the path of the deleted DB file.
 */
export function wipeDatabase(): string {
  const p = dbPath();
  close();

  // Delete DB and associated WAL/SHM files
  for (const suffix of ["", "-wal", "-shm"]) {
    const fp = p + suffix;
    if (existsSync(fp)) {
      try {
        unlinkSync(fp);
      } catch {
        // Best-effort
      }
    }
  }

  // Re-initialize with fresh schema
  db();
  return p;
}

// ---------------------------------------------------------------------------
// Project merging & git remote backfill
// ---------------------------------------------------------------------------

export type MergeResult = {
  knowledge_moved: number;
  messages_moved: number;
  distillations_moved: number;
};

/**
 * Merge a source project into a target project.
 *
 * Moves all data (knowledge, messages, distillations, LAT sections, path
 * aliases) from source to target, then deletes the source project row.
 * The source project's path is registered as an alias of the target.
 *
 * Returns counts of moved rows for reporting.
 */
export function mergeProjects(sourceId: string, targetId: string): MergeResult {
  const database = db();

  // Count before merging (result.changes is inflated by FTS triggers)
  const counts = {
    knowledge: (
      database
        .query(
          "SELECT COUNT(*) as c FROM knowledge_current WHERE project_id = ?",
        )
        .get(sourceId) as { c: number }
    ).c,
    messages: (
      database
        .query(
          "SELECT COUNT(*) as c FROM temporal_messages WHERE project_id = ?",
        )
        .get(sourceId) as { c: number }
    ).c,
    distillations: (
      database
        .query("SELECT COUNT(*) as c FROM distillations WHERE project_id = ?")
        .get(sourceId) as { c: number }
    ).c,
  };

  mergeProjectInternal(sourceId, targetId);

  invalidateProjectsCache();
  invalidateGlobalStatsCache();

  return {
    knowledge_moved: counts.knowledge,
    messages_moved: counts.messages,
    distillations_moved: counts.distillations,
  };
}

/**
 * Backfill git_remote for existing projects, merge duplicates, and
 * update project names from git remote repo names where still using
 * the directory-basename default.
 *
 * Iterates all projects that lack a git_remote value, runs `git remote -v`
 * on their stored path, and:
 *  - If no other project shares that remote: sets git_remote on the row.
 *  - If another project already has that remote: merges this project into
 *    the existing one (consolidating fragmented data).
 *
 * Also backfills project names: if a project's name matches the directory
 * basename (the old default) or is null, and a git remote is available,
 * the name is updated to the repo name from the remote URL.
 *
 * Skips projects whose path no longer exists on disk or is not a git repo.
 *
 * Returns counts for reporting.
 */
export function backfillGitRemotes(): {
  updated: number;
  merged: number;
  namesBackfilled: number;
  mergeDetails: Array<{
    sourcePath: string;
    targetPath: string;
    gitRemote: string;
    result: MergeResult;
  }>;
} {
  const projects = db()
    .query(
      "SELECT id, path, name, git_remote FROM projects ORDER BY created_at ASC",
    )
    .all() as Array<{
    id: string;
    path: string;
    name: string | null;
    git_remote: string | null;
  }>;

  let updated = 0;
  let merged = 0;
  let namesBackfilled = 0;
  const mergeDetails: Array<{
    sourcePath: string;
    targetPath: string;
    gitRemote: string;
    result: MergeResult;
  }> = [];

  for (const project of projects) {
    let gitRemote = project.git_remote;

    if (!gitRemote) {
      // Skip if path doesn't exist
      if (!existsSync(project.path)) continue;

      // Try to get git remote
      gitRemote = getGitRemote(project.path);
      if (!gitRemote) continue;

      // Check if another project already has this git_remote
      const existing = db()
        .query(
          "SELECT id, path FROM projects WHERE git_remote = ? AND id != ? LIMIT 1",
        )
        .get(gitRemote, project.id) as {
        id: string;
        path: string;
      } | null;

      if (existing) {
        // Merge this project into the existing one
        const result = mergeProjects(project.id, existing.id);
        mergeDetails.push({
          sourcePath: project.path,
          targetPath: existing.path,
          gitRemote,
          result,
        });
        merged++;
        continue; // project was merged away, skip name backfill
      }

      // Set the git_remote
      db()
        .query("UPDATE projects SET git_remote = ? WHERE id = ?")
        .run(gitRemote, project.id);
      updated++;
    }

    // Backfill name from git remote if still using directory basename default
    const dirBasename = project.path.split("/").pop();
    if (project.name === dirBasename || !project.name) {
      const repoName = repoNameFromRemote(gitRemote);
      if (repoName && repoName !== project.name) {
        db()
          .query("UPDATE projects SET name = ? WHERE id = ?")
          .run(repoName, project.id);
        namesBackfilled++;
      }
    }
  }

  return { updated, merged, namesBackfilled, mergeDetails };
}
