/**
 * Import history — tracks which external agent sessions have been imported
 * to prevent re-importing unchanged sources.
 */
import { db, ensureProject } from "../db";

export type ImportRecord = {
  id: string;
  project_id: string;
  agent_name: string;
  source_id: string;
  source_hash: string;
  entries_created: number;
  entries_updated: number;
  imported_at: number;
};

/**
 * Check if a specific source has already been imported with the same hash.
 *
 * @returns The existing record if found with the same hash, or null if
 *          the source hasn't been imported or the hash has changed.
 */
export function isImported(
  projectPath: string,
  agentName: string,
  sourceId: string,
  sourceHash: string,
): ImportRecord | null {
  const projectId = ensureProject(projectPath);
  const row = db()
    .query(
      `SELECT * FROM import_history
       WHERE project_id = ? AND agent_name = ? AND source_id = ?`,
    )
    .get(projectId, agentName, sourceId) as ImportRecord | null;

  if (!row) return null;
  // Hash changed — source has new content since last import
  if (row.source_hash !== sourceHash) return null;
  return row;
}

/**
 * Record a successful import of a source.
 * Uses INSERT OR REPLACE to handle re-imports of changed sources.
 */
export function recordImport(
  projectPath: string,
  agentName: string,
  sourceId: string,
  sourceHash: string,
  stats: { created: number; updated: number },
): void {
  const projectId = ensureProject(projectPath);
  db()
    .query(
      `INSERT OR REPLACE INTO import_history
       (id, project_id, agent_name, source_id, source_hash, entries_created, entries_updated, imported_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      crypto.randomUUID(),
      projectId,
      agentName,
      sourceId,
      sourceHash,
      stats.created,
      stats.updated,
      Date.now(),
    );
}

/**
 * Check whether an agent has any import_history row for this project,
 * including the "__declined__" sentinel. Used by auto-import to decide
 * whether an agent is brand-new (never imported AND never declined).
 *
 * Unlike isImported(), this is hash-agnostic and source-agnostic — it
 * answers "have we ever offered/handled this agent here?".
 */
export function hasAgentImportRecord(projectPath: string, agentName: string): boolean {
  const projectId = ensureProject(projectPath);
  return !!db()
    .query(
      `SELECT 1 FROM import_history
       WHERE project_id = ? AND agent_name = ?
       LIMIT 1`,
    )
    .get(projectId, agentName);
}

/**
 * Record that the user declined auto-import for a specific agent in this
 * project. Writes a sentinel row (source_id = "__declined__") so the agent
 * is not re-offered. Excluded from listImports() by the sentinel filter.
 *
 * NOTE: This revives a per-agent variant of the pre-v22 decline sentinel.
 * Do not remove the "__declined__" filter in listImports() — it keeps these
 * sentinels invisible to the dashboard/REST surface.
 */
export function recordDecline(projectPath: string, agentName: string): void {
  const projectId = ensureProject(projectPath);
  db()
    .query(
      `INSERT OR REPLACE INTO import_history
       (id, project_id, agent_name, source_id, source_hash, entries_created, entries_updated, imported_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      crypto.randomUUID(),
      projectId,
      agentName,
      "__declined__",
      "", // source_hash unused for sentinel — never compared
      0,
      0,
      Date.now(),
    );
}

/**
 * Get all import records for a project.
 * Excludes "__declined__" sentinel rows written by {@link recordDecline}
 * (used for auto-import gating, not visible to the user/dashboard).
 */
export function listImports(projectPath: string): ImportRecord[] {
  const projectId = ensureProject(projectPath);
  return db()
    .query(
      `SELECT * FROM import_history
       WHERE project_id = ? AND source_id != '__declined__'
       ORDER BY imported_at DESC`,
    )
    .all(projectId) as ImportRecord[];
}

/**
 * Compute a simple hash string for idempotency checks.
 * Uses a fast non-cryptographic approach: file size + message count + last timestamp.
 */
export function computeHash(parts: {
  size?: number;
  messageCount?: number;
  lastTimestamp?: number;
}): string {
  return `${parts.size ?? 0}:${parts.messageCount ?? 0}:${parts.lastTimestamp ?? 0}`;
}
