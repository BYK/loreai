import { Database } from "#db/driver";
import { isVecAvailable, loadVecExtension, resetVecState } from "./db/vec";
import {
  ensureVec0Store,
  readStorageMode,
  readVecDimension,
  repartitionVec0Project,
} from "./db/vec-store";
import { join, dirname } from "node:path";
import { chmodSync, mkdirSync, statSync } from "node:fs";
import { getGitRemote } from "./git";
import { isHostedMode } from "./hosted";
import { dataDir } from "./data-dir";
import { tracedDatabase } from "./db/traced";

/**
 * Callback fired when project rows are created or mutated (merge, rename, etc.).
 * Used by data.ts to invalidate its listing caches without a circular import.
 */
let onProjectMutationCb: (() => void) | null = null;

/** Register a callback for project mutations. Only one callback is supported. */
export function onProjectMutation(cb: () => void): void {
  onProjectMutationCb = cb;
}

/** Fire the project mutation callback (if registered). */
function fireProjectMutation(): void {
  // Project creation and merge (mergeProjectInternal) both route through here,
  // and a merge re-points a path to a different project id. Drop the memo so a
  // stale path→id can never survive a mutation.
  invalidateProjectIdCache();
  onProjectMutationCb?.();
}

/**
 * #1246 (P2): fired when a project's git_remote flips NULL→set (ensureProject lazy
 * backfill). Content created while the project was remote-less was NOT captured (the
 * P2 git_remote gate), so it must be re-enqueued now that the project can correlate —
 * otherwise it would silently stop being backed up until the next `lore sync enable`.
 * The sync layer registers a handler (avoids a db.ts↔sync-data.ts circular import).
 */
let onProjectRemoteBackfilledCb: ((projectId: string) => void) | null = null;

/** Register a handler for git_remote NULL→set backfill. Only one is supported. */
export function onProjectRemoteBackfilled(
  cb: ((projectId: string) => void) | null,
): void {
  onProjectRemoteBackfilledCb = cb;
}

/**
 * Signal that a project's git_remote just flipped NULL→set. Exported so the
 * `lore data`-triggered {@link backfillGitRemotes} path (data.ts) can fire the
 * same reseed side-effect as {@link ensureProject}'s inline lazy backfill —
 * both must notify the sync layer so content gated out while the project was
 * remote-less gets re-enqueued (#1246). Safe to call when sync is disabled (the
 * registered handler no-ops).
 */
export function fireProjectRemoteBackfilled(projectId: string): void {
  // git_remote just flipped NULL→set (possibly via a merge inside the backfill),
  // so the project's identity may have changed — drop the memo to be safe.
  invalidateProjectIdCache();
  onProjectRemoteBackfilledCb?.(projectId);
}

/**
 * Per-connection memo of resolved project IDs keyed by the input `path`.
 *
 * The hot request path resolves the SAME session path many times per turn:
 * `storeTurnTemporal` warms `ensureProject` once, then temporal.store /
 * recordToolCalls each call `ensureProject`/`projectId` again (pipeline.ts,
 * #1084 explicitly expects these to be "cheap cache hits"), and worktree/alias
 * paths cost TWO lookups each (a `projects.path` miss + a `project_path_aliases`
 * hit) — the sequential per-request DB churn Sentry flagged as a blocking
 * operation (LOREAI-GATEWAY-3K).
 *
 * A path→id mapping is stable: it only changes when a project is created (new
 * path, never rewrites an existing entry), merged, git_remote-backfilled, or
 * deleted. The first three all fire {@link fireProjectMutation} /
 * {@link fireProjectRemoteBackfilled}; deletion invalidates via
 * {@link invalidateProjectIdCache} (called by data.ts `deleteProject`). Keyed by
 * the live `db()` instance (WeakMap) so a test harness swapping the DB — or
 * close() — starts from a fresh cache automatically, mirroring the column-list
 * memo. Only STABLE resolutions are cached; the NULL-git_remote "existing"
 * branch is intentionally left uncached so lazy backfill keeps retrying.
 */
const projectIdByPathCache = new WeakMap<Database, Map<string, string>>();

function projectIdCacheFor(conn: Database): Map<string, string> {
  let m = projectIdByPathCache.get(conn);
  if (!m) {
    m = new Map();
    projectIdByPathCache.set(conn, m);
  }
  return m;
}

/**
 * Drop the memoized path→id map for the current connection. Called on every
 * project mutation (create/merge/backfill via the fire-hooks) and by data.ts
 * after a project is deleted, so a stale mapping can never be served.
 */
export function invalidateProjectIdCache(): void {
  // Read `instance` directly (not db()) so invalidation never forces a DB open.
  if (!instance) return;
  projectIdByPathCache.get(instance)?.clear();
}

/**
 * Extract the repository name from a normalized git remote URL.
 *
 * Examples:
 *   "github.com/BYK/LoreAI" → "LoreAI"
 *   "github.com/org/repo"    → "repo"
 *   "github.com"             → null (no path components)
 *   null                     → null
 */
export function repoNameFromRemote(remote: string | null): string | null {
  if (!remote) return null;
  const lastSlash = remote.lastIndexOf("/");
  if (lastSlash < 0) return null;
  const name = remote.slice(lastSlash + 1);
  return name.length > 0 ? name : null;
}

const MIGRATIONS: string[] = [
  `
  -- Version 1: Initial schema

  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,
    name TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS temporal_messages (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    tokens INTEGER DEFAULT 0,
    distilled INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL,
    metadata TEXT
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS temporal_fts USING fts5(
    content,
    content=temporal_messages,
    content_rowid=rowid,
    tokenize='unicode61 remove_diacritics 0'
  );

  -- Triggers to keep FTS in sync
  CREATE TRIGGER IF NOT EXISTS temporal_fts_insert AFTER INSERT ON temporal_messages BEGIN
    INSERT INTO temporal_fts(rowid, content) VALUES (new.rowid, new.content);
  END;

  CREATE TRIGGER IF NOT EXISTS temporal_fts_delete AFTER DELETE ON temporal_messages BEGIN
    INSERT INTO temporal_fts(temporal_fts, rowid, content) VALUES('delete', old.rowid, old.content);
  END;

  CREATE TRIGGER IF NOT EXISTS temporal_fts_update AFTER UPDATE ON temporal_messages BEGIN
    INSERT INTO temporal_fts(temporal_fts, rowid, content) VALUES('delete', old.rowid, old.content);
    INSERT INTO temporal_fts(rowid, content) VALUES (new.rowid, new.content);
  END;

  CREATE INDEX IF NOT EXISTS idx_temporal_session ON temporal_messages(session_id);
  CREATE INDEX IF NOT EXISTS idx_temporal_project ON temporal_messages(project_id);
  CREATE INDEX IF NOT EXISTS idx_temporal_distilled ON temporal_messages(distilled);
  CREATE INDEX IF NOT EXISTS idx_temporal_created ON temporal_messages(created_at);

  CREATE TABLE IF NOT EXISTS distillations (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    session_id TEXT NOT NULL,
    narrative TEXT NOT NULL,
    facts TEXT NOT NULL,
    source_ids TEXT NOT NULL,
    generation INTEGER DEFAULT 0,
    token_count INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_distillation_session ON distillations(session_id);
  CREATE INDEX IF NOT EXISTS idx_distillation_project ON distillations(project_id);
  CREATE INDEX IF NOT EXISTS idx_distillation_generation ON distillations(generation);
  CREATE INDEX IF NOT EXISTS idx_distillation_created ON distillations(created_at);

  CREATE TABLE IF NOT EXISTS knowledge (
    id TEXT PRIMARY KEY,
    project_id TEXT,
    category TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    source_session TEXT,
    cross_project INTEGER DEFAULT 0,
    confidence REAL DEFAULT 1.0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    metadata TEXT
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
    title,
    content,
    category,
    content=knowledge,
    content_rowid=rowid,
    tokenize='unicode61 remove_diacritics 0'
  );

  CREATE TRIGGER IF NOT EXISTS knowledge_fts_insert AFTER INSERT ON knowledge BEGIN
    INSERT INTO knowledge_fts(rowid, title, content, category)
    VALUES (new.rowid, new.title, new.content, new.category);
  END;

  CREATE TRIGGER IF NOT EXISTS knowledge_fts_delete AFTER DELETE ON knowledge BEGIN
    INSERT INTO knowledge_fts(knowledge_fts, rowid, title, content, category)
    VALUES('delete', old.rowid, old.title, old.content, old.category);
  END;

  CREATE TRIGGER IF NOT EXISTS knowledge_fts_update AFTER UPDATE ON knowledge BEGIN
    INSERT INTO knowledge_fts(knowledge_fts, rowid, title, content, category)
    VALUES('delete', old.rowid, old.title, old.content, old.category);
    INSERT INTO knowledge_fts(rowid, title, content, category)
    VALUES (new.rowid, new.title, new.content, new.category);
  END;

  CREATE INDEX IF NOT EXISTS idx_knowledge_project ON knowledge(project_id);
  CREATE INDEX IF NOT EXISTS idx_knowledge_category ON knowledge(category);
  CREATE INDEX IF NOT EXISTS idx_knowledge_cross ON knowledge(cross_project);

  CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER NOT NULL
  );

  INSERT INTO schema_version (version) VALUES (1);
  `,
  `
  -- Version 2: Replace narrative+facts with observations text
  ALTER TABLE distillations ADD COLUMN observations TEXT NOT NULL DEFAULT '';
  `,
  `
  -- Version 3: One-time vacuum to reclaim accumulated free pages, and enable
  -- incremental auto-vacuum so future deletes return pages to the OS.
  -- VACUUM must run outside a transaction and cannot be in a multi-statement
  -- exec, so it is handled specially in the migrate() function.
  `,
  `
  -- Version 4: Persistent session state for error recovery.
  -- Stores forceMinLayer so it survives OpenCode restarts. Without this,
  -- a "prompt too long" error recovery (escalate to layer 2) is lost if
  -- the process restarts before the next turn.
  CREATE TABLE IF NOT EXISTS session_state (
    session_id TEXT PRIMARY KEY,
    force_min_layer INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  );
  `,
  `
  -- Version 5: Multi-resolution composable distillations.
  -- Instead of deleting gen-0 distillations during meta-distillation,
  -- mark them as archived. Archived entries are excluded from the in-context
  -- prefix but remain searchable via the recall tool, providing a detailed
  -- "zoom-in" layer beneath the compressed gen-1 summary.
  -- Inspired by Cartridges (Eyuboglu et al., 2025) composability: independently
  -- compressed representations can be concatenated and queried without retraining.
  -- Reference: https://arxiv.org/abs/2501.17390
  ALTER TABLE distillations ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
  CREATE INDEX IF NOT EXISTS idx_distillation_archived ON distillations(archived);
  `,
  `
  -- Version 6: Compound indexes for common multi-column query patterns.
  -- Almost every query filters on (project_id, session_id) but only single-column
  -- indexes existed, forcing SQLite to pick one and scan for the rest.

  -- temporal_messages: covers bySession, search-LIKE fallback, count, undistilledCount
  CREATE INDEX IF NOT EXISTS idx_temporal_project_session ON temporal_messages(project_id, session_id);
  -- temporal_messages: covers undistilled() and undistilledCount() with distilled filter
  CREATE INDEX IF NOT EXISTS idx_temporal_project_session_distilled ON temporal_messages(project_id, session_id, distilled);
  -- temporal_messages: covers pruning TTL pass and size-cap pass (distilled=1 ordered by created_at)
  CREATE INDEX IF NOT EXISTS idx_temporal_project_distilled_created ON temporal_messages(project_id, distilled, created_at);

  -- distillations: covers loadForSession, latestObservations, searchDistillations, resetOrphans
  CREATE INDEX IF NOT EXISTS idx_distillation_project_session ON distillations(project_id, session_id);
  -- distillations: covers gen0Count, loadGen0, gradient prefix loading (archived filter)
  CREATE INDEX IF NOT EXISTS idx_distillation_project_session_gen_archived ON distillations(project_id, session_id, generation, archived);

  -- Drop redundant single-column indexes that are now left-prefixes of compound indexes.
  -- idx_temporal_project is a prefix of idx_temporal_project_session.
  -- idx_distillation_project is a prefix of idx_distillation_project_session.
  -- idx_temporal_distilled is a prefix of no compound index but is low-selectivity (0/1)
  -- and all queries that use it also filter on project_id — covered by the new compounds.
  DROP INDEX IF EXISTS idx_temporal_project;
  DROP INDEX IF EXISTS idx_temporal_distilled;
  DROP INDEX IF EXISTS idx_distillation_project;
  `,
  `
  -- Version 7: FTS5 for distillations — enables ranked search instead of LIKE.
  CREATE VIRTUAL TABLE IF NOT EXISTS distillation_fts USING fts5(
    observations,
    content=distillations,
    content_rowid=rowid,
    tokenize='unicode61 remove_diacritics 0'
  );

  -- Backfill existing data (skip empty observations from schema v1→v2 migration)
  INSERT INTO distillation_fts(rowid, observations)
  SELECT rowid, observations FROM distillations WHERE observations != '';

  -- Sync triggers
  CREATE TRIGGER IF NOT EXISTS distillation_fts_insert AFTER INSERT ON distillations BEGIN
    INSERT INTO distillation_fts(rowid, observations) VALUES (new.rowid, new.observations);
  END;

  CREATE TRIGGER IF NOT EXISTS distillation_fts_delete AFTER DELETE ON distillations BEGIN
    INSERT INTO distillation_fts(distillation_fts, rowid, observations)
    VALUES('delete', old.rowid, old.observations);
  END;

  CREATE TRIGGER IF NOT EXISTS distillation_fts_update AFTER UPDATE ON distillations BEGIN
    INSERT INTO distillation_fts(distillation_fts, rowid, observations)
    VALUES('delete', old.rowid, old.observations);
    INSERT INTO distillation_fts(rowid, observations) VALUES (new.rowid, new.observations);
  END;
  `,
  `
  -- Version 8: Embedding BLOB column for vector search (Voyage AI).
  -- No backfill — entries get embedded lazily on next create/update
  -- or via explicit backfill when embeddings are first enabled.
  ALTER TABLE knowledge ADD COLUMN embedding BLOB;

  -- Key-value metadata table for plugin state (e.g. embedding config fingerprint).
  CREATE TABLE IF NOT EXISTS kv_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  `
  -- Version 9: Embedding BLOB column for distillation vector search.
  -- Same pattern as knowledge embeddings (version 8). Enables semantic
  -- search over distilled session summaries via cosine similarity.
  -- No backfill — entries get embedded lazily on next distillation
  -- or via explicit backfill when embeddings are first enabled.
  ALTER TABLE distillations ADD COLUMN embedding BLOB;
  `,
  `
  -- Version 10: lat.md section cache + knowledge cross-references.

  -- lat.md section cache for recall integration.
  -- Parsed from lat.md/ directory markdown files, FTS5-indexed for search.
  CREATE TABLE IF NOT EXISTS lat_sections (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    file TEXT NOT NULL,
    heading TEXT NOT NULL,
    depth INTEGER NOT NULL,
    content TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    first_paragraph TEXT,
    updated_at INTEGER NOT NULL
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS lat_sections_fts USING fts5(
    heading,
    content,
    content=lat_sections,
    content_rowid=rowid,
    tokenize='unicode61 remove_diacritics 0'
  );

  CREATE TRIGGER IF NOT EXISTS lat_fts_insert AFTER INSERT ON lat_sections BEGIN
    INSERT INTO lat_sections_fts(rowid, heading, content)
    VALUES (new.rowid, new.heading, new.content);
  END;

  CREATE TRIGGER IF NOT EXISTS lat_fts_delete AFTER DELETE ON lat_sections BEGIN
    INSERT INTO lat_sections_fts(lat_sections_fts, rowid, heading, content)
    VALUES('delete', old.rowid, old.heading, old.content);
  END;

  CREATE TRIGGER IF NOT EXISTS lat_fts_update AFTER UPDATE ON lat_sections BEGIN
    INSERT INTO lat_sections_fts(lat_sections_fts, rowid, heading, content)
    VALUES('delete', old.rowid, old.heading, old.content);
    INSERT INTO lat_sections_fts(rowid, heading, content)
    VALUES (new.rowid, new.heading, new.content);
  END;

  CREATE INDEX IF NOT EXISTS idx_lat_sections_project ON lat_sections(project_id);
  CREATE INDEX IF NOT EXISTS idx_lat_sections_file ON lat_sections(project_id, file);

  -- Knowledge cross-references via [[entry-id]] wiki links.
  -- ON DELETE CASCADE: when either entry is deleted, the ref row is auto-removed.
  CREATE TABLE IF NOT EXISTS knowledge_refs (
    from_id TEXT NOT NULL REFERENCES knowledge(id) ON DELETE CASCADE,
    to_id TEXT NOT NULL REFERENCES knowledge(id) ON DELETE CASCADE,
    PRIMARY KEY (from_id, to_id)
  );
  `,
  `
  -- Version 11: F3b -- unambiguous chunk terminator in temporal_messages.content.
  --
  -- Pre-F3b, partsToText joined chunks with a newline. Tool-output payloads
  -- can contain newlines too, so the boundary between a tool envelope and a
  -- following plain-text or [reasoning] chunk was structurally ambiguous.
  -- This caused two known limitations in the F3 distill-input truncator:
  -- trailing text could be swallowed into a tool payload, and embedded
  -- literal envelope strings inside a payload (e.g. when reading AGENTS.md)
  -- could fabricate fake boundaries.
  --
  -- F3b switches the chunk separator to newline plus ASCII Unit Separator
  -- (char 31). The Unit Separator is non-word so FTS5's unicode61 tokenizer
  -- ignores it (zero BM25 impact). New rows are written via the post-F3b
  -- partsToText. Existing rows are rewritten in place by the UPDATE below,
  -- which uses pure SQL replace() to inject the Unit Separator after every
  -- legacy chunk-prefix sequence -- the same boundary patterns the legacy
  -- F3 reader was already trying to recover.
  --
  -- Trade-off (acceptable): any embedded legacy chunk-prefix sequence
  -- inside a tool payload becomes a structural boundary post-migration.
  -- This matches what the legacy F3 reader did at read-time anyway, baked
  -- into the row permanently. The migration runs once per machine.
  --
  -- Idempotent: a row that already contains the Unit Separator before a
  -- chunk prefix no longer matches the search literal (the separator
  -- interposes), so re-running the UPDATE is a no-op for migrated rows.
  -- (Important: migrate() in db.ts runs each migration via database.exec()
  -- with no explicit BEGIN/COMMIT around the whole loop. SQLite makes this
  -- single UPDATE statement atomic per-statement, so partial progress on
  -- crash is safe to retry thanks to the idempotency above.)
  --
  -- char(10) = newline, char(31) = Unit Separator. SQLite has no native
  -- regex, but two nested replace() calls on the literal prefixes are
  -- sufficient because both legacy chunk prefixes match at line-start.
  --
  -- Each row UPDATE fires the temporal_fts_update trigger once; because
  -- the Unit Separator is a non-word character, the re-indexed content
  -- tokenizes identically -- net no-op for FTS scoring.
  UPDATE temporal_messages
  SET content = replace(
    replace(
      content,
      char(10) || '[tool:',
      char(10) || char(31) || '[tool:'
    ),
    char(10) || '[reasoning] ',
    char(10) || char(31) || '[reasoning] '
  )
  WHERE content LIKE '%' || char(10) || '[tool:%'
     OR content LIKE '%' || char(10) || '[reasoning] %';
  `,
  `
  -- Version 12: Context health diagnostic columns on distillations.
  --
  -- r_compression: k/√N where k = distilled token count, N = source token
  -- count. Values < 1.0 signal likely lossy compression. NULL for rows
  -- created before this migration or for meta-distillations (gen > 0)
  -- where the metric is not computed.
  --
  -- c_norm: normalized variance of relative-existence weights over source
  -- message timestamps. Range [0, 1]; 0 = uniform distribution, 1 = attention
  -- dominated by distant past. NULL for pre-migration rows or meta-distillations.
  --
  -- Both columns are nullable REALs — cheap to add, no backfill needed.
  ALTER TABLE distillations ADD COLUMN r_compression REAL;
  ALTER TABLE distillations ADD COLUMN c_norm REAL;
  `,
  `
  -- Version 13: Installation metadata table for telemetry and diagnostics.
  --
  -- Separate from kv_meta (plugin state) — this holds installation-scoped
  -- values: instance_id, release_channel, etc. Has updated_at for tracking
  -- when values last changed.
  CREATE TABLE IF NOT EXISTS metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  `,
  `
  -- Version 14: Git-based project identification.
  --
  -- Projects can now be identified by their git remote URL in addition to
  -- filesystem path. This enables worktree, clone, and fork awareness:
  -- the same repository accessed from different paths shares one project.
  --
  -- git_remote: Normalized canonical remote URL (e.g. "github.com/user/repo").
  -- NULL for non-git directories or repos with no remotes.
  --
  -- project_path_aliases: Maps additional filesystem paths to existing
  -- projects. When ensureProject() finds a match by git_remote, the
  -- alternate path is registered here for O(1) subsequent lookups.
  ALTER TABLE projects ADD COLUMN git_remote TEXT;
  CREATE INDEX IF NOT EXISTS idx_projects_git_remote ON projects(git_remote);

  CREATE TABLE IF NOT EXISTS project_path_aliases (
    path TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE
  );
  `,

  `
  -- Version 15: Cache warming survival histograms.
  --
  -- Persists global (per-project, per-time-slot) inter-turn gap histograms
  -- across gateway restarts. These histograms feed the survival analysis
  -- model that decides whether to send speculative cache-warming pings.
  -- Without persistence, the model has no data until enough turns rebuild
  -- the histogram from scratch (cold start problem).
  --
  -- counts: JSON array of bin counts (21 elements: 20 bins + 1 overflow).
  -- total: Sum of counts (denormalized for fast reads).
  CREATE TABLE IF NOT EXISTS warmup_histograms (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    time_slot TEXT NOT NULL,
    counts TEXT NOT NULL DEFAULT '[]',
    total INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (project_id, time_slot)
  );
  `,
  `
  -- Version 16: Embedding BLOB column for temporal message vector search.
  -- Same pattern as knowledge (v8) and distillation (v9) embeddings.
  -- Only undistilled messages are embedded; the column is NULLed when
  -- a message is marked as distilled (its semantic content is captured
  -- by the distillation embedding at that point).
  -- No backfill — new messages get embedded lazily at write time.
  ALTER TABLE temporal_messages ADD COLUMN embedding BLOB;
  `,
  `
  -- Version 17: Track whether distillation used batch API pricing.
  -- NULL for pre-migration rows (treated as 'direct' for conservative estimates).
  -- 'batch' = 50% discount on input+output, 'direct' = full price.
  ALTER TABLE distillations ADD COLUMN call_type TEXT;
  `,
  `
  -- Version 18: Persist live session cost data so historical estimates
  -- include cache warming, 1h TTL savings, and batch API savings — metrics
  -- that were previously lost on gateway restart.
  -- All cost columns are in USD. Token columns are raw counts.
  ALTER TABLE session_state ADD COLUMN conversation_cost REAL NOT NULL DEFAULT 0;
  ALTER TABLE session_state ADD COLUMN worker_cost REAL NOT NULL DEFAULT 0;
  ALTER TABLE session_state ADD COLUMN conversation_turns INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE session_state ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE session_state ADD COLUMN cache_write_tokens INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE session_state ADD COLUMN warmup_savings REAL NOT NULL DEFAULT 0;
  ALTER TABLE session_state ADD COLUMN warmup_hits INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE session_state ADD COLUMN ttl_savings REAL NOT NULL DEFAULT 0;
  ALTER TABLE session_state ADD COLUMN ttl_hits INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE session_state ADD COLUMN batch_savings REAL NOT NULL DEFAULT 0;
  `,
  `
  -- Version 19: Import history for conversation import idempotency.
  -- Tracks which external agent sessions have been imported to prevent
  -- re-importing unchanged sources and to record user-declined imports.
  CREATE TABLE IF NOT EXISTS import_history (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    agent_name TEXT NOT NULL,
    source_id TEXT NOT NULL,
    source_hash TEXT NOT NULL,
    entries_created INTEGER NOT NULL DEFAULT 0,
    entries_updated INTEGER NOT NULL DEFAULT 0,
    imported_at INTEGER NOT NULL,
    UNIQUE(project_id, agent_name, source_id)
  );
  CREATE INDEX IF NOT EXISTS idx_import_history_project ON import_history(project_id);
  `,
  `
  -- Version 20: Purge worker boilerplate from temporal messages.
  -- Legacy gateway/plugin worker calls (distillation observer, curator,
  -- consolidation, reflector, eval) stored their full system prompts
  -- (containing entire conversation transcripts, up to 1.6MB each) as
  -- temporal messages. These pollute FTS search results by matching
  -- virtually any domain keyword. Safe to delete: their actual output
  -- (distillations, knowledge entries) is stored in dedicated tables.
  DELETE FROM temporal_messages WHERE content LIKE '%You are a memory observer.%'
    OR content LIKE '%You are a long-term memory curator.%'
    OR content LIKE '%You are a long-term memory curator performing a consolidation pass.%'
    OR content LIKE '%You are a memory reflector.%'
    OR content LIKE '%You are evaluating distillation quality.%';
  `,
  `
  -- Version 21: Persist avoided compaction data from live sessions.
  -- Historical estimates previously re-simulated avoided compactions from
  -- temporal message token estimates (chars/3), missing system prompt and
  -- tool definition overhead. Persisting the live session's real shadow
  -- context tracking (from actual API-reported total input tokens) gives
  -- accurate post-restart historical estimates.
  ALTER TABLE session_state ADD COLUMN avoided_compactions INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE session_state ADD COLUMN avoided_compaction_cost REAL NOT NULL DEFAULT 0;
  `,
  `
  -- Version 22: Track when conversation import was last offered/run.
  -- NULL means import has never been offered for this project.
  -- Used by auto-import to avoid re-prompting, and by explicit
  -- \`lore import\` for incremental imports (only newer conversations).
  ALTER TABLE projects ADD COLUMN last_import_at INTEGER;

  -- Backfill: migrate legacy __declined__ sentinel rows so existing
  -- users who previously declined are not re-prompted after upgrading.
  UPDATE projects SET last_import_at = (
    SELECT ih.imported_at FROM import_history ih
    WHERE ih.project_id = projects.id
      AND ih.source_id = '__declined__'
    LIMIT 1
  )
  WHERE EXISTS (
    SELECT 1 FROM import_history ih
    WHERE ih.project_id = projects.id
      AND ih.source_id = '__declined__'
  );
  `,
  `
  -- Version 23: Persist volatile session tracking state across restarts.
  -- Previously these were in-memory only, causing duplicate processing,
  -- false compaction detection, and expensive prompt cache busts on restart.
  ALTER TABLE session_state ADD COLUMN last_curated_at INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE session_state ADD COLUMN message_count INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE session_state ADD COLUMN turns_since_curation INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE session_state ADD COLUMN ltm_cache_text TEXT;
  ALTER TABLE session_state ADD COLUMN ltm_cache_tokens INTEGER;
  ALTER TABLE session_state ADD COLUMN ltm_pin_text TEXT;
  ALTER TABLE session_state ADD COLUMN ltm_pin_tokens INTEGER;
  ALTER TABLE session_state ADD COLUMN consecutive_text_only_turns INTEGER NOT NULL DEFAULT 0;
  `,
  `
  -- Version 24: Persist remaining volatile session state across restarts.
  -- Session identity (Tier 1/2/3 session correlation)
  ALTER TABLE session_state ADD COLUMN fingerprint TEXT NOT NULL DEFAULT '';
  ALTER TABLE session_state ADD COLUMN header_session_id TEXT;
  ALTER TABLE session_state ADD COLUMN header_name TEXT;
  -- Cache warming state
  ALTER TABLE session_state ADD COLUMN resolved_conversation_ttl TEXT NOT NULL DEFAULT '5m';
  ALTER TABLE session_state ADD COLUMN warmup_state TEXT;
  -- Gradient calibration state (survives restarts to avoid uncalibrated busts)
  ALTER TABLE session_state ADD COLUMN dynamic_context_cap REAL NOT NULL DEFAULT 0;
  ALTER TABLE session_state ADD COLUMN bust_rate_ema REAL NOT NULL DEFAULT -1;
  ALTER TABLE session_state ADD COLUMN inter_bust_interval_ema REAL NOT NULL DEFAULT -1;
  ALTER TABLE session_state ADD COLUMN last_layer INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE session_state ADD COLUMN last_known_input INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE session_state ADD COLUMN last_turn_at INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE session_state ADD COLUMN last_bust_at INTEGER NOT NULL DEFAULT 0;
  `,
  `
  -- Version 25: Adaptive dedup threshold — store accept/reject feedback
  -- on embedding-based duplicate pairs for per-project threshold calibration.
  -- Titles stored instead of FK IDs because entries are deleted during dedup;
  -- the similarity float is the actual calibration input.
  CREATE TABLE IF NOT EXISTS dedup_feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT,
    entry_a_title TEXT NOT NULL,
    entry_b_title TEXT NOT NULL,
    similarity REAL NOT NULL,
    accepted INTEGER NOT NULL,
    source TEXT NOT NULL DEFAULT 'manual',
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_dedup_feedback_project
    ON dedup_feedback(project_id);
  `,
  `
  -- Version 26: Persist sub-agent parent–child session relationships.
  -- parent_session_id: Lore internal session ID of the parent session
  -- (resolved from the x-parent-session-id header at detection time).
  -- NULL for root (non-sub-agent) sessions.
  -- is_subagent: boolean flag (1 = sub-agent) so the flag survives
  -- gateway restarts without requiring the header again.
  ALTER TABLE session_state ADD COLUMN parent_session_id TEXT;
  ALTER TABLE session_state ADD COLUMN is_subagent INTEGER NOT NULL DEFAULT 0;
  CREATE INDEX IF NOT EXISTS idx_session_state_parent ON session_state(parent_session_id);
  `,
  `
  -- Version 27: Entity Registry — recurring people, services, repos, tools, and
  -- companies that users reference across sessions with inconsistent names.
  -- Enables grounding pass (pronoun/nickname → canonical name) and alias-expanded recall.

  CREATE TABLE IF NOT EXISTS entities (
    id             TEXT PRIMARY KEY,
    project_id     TEXT,
    entity_type    TEXT NOT NULL,
    canonical_name TEXT NOT NULL,
    metadata       TEXT,
    cross_project  INTEGER DEFAULT 0,
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_entities_project ON entities(project_id);
  CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(entity_type);

  -- FTS5 for fast canonical name lookup
  CREATE VIRTUAL TABLE IF NOT EXISTS entities_fts USING fts5(
    canonical_name,
    content=entities,
    content_rowid=rowid,
    tokenize='unicode61 remove_diacritics 0'
  );
  CREATE TRIGGER IF NOT EXISTS entities_fts_insert AFTER INSERT ON entities BEGIN
    INSERT INTO entities_fts(rowid, canonical_name)
    VALUES (new.rowid, new.canonical_name);
  END;
  CREATE TRIGGER IF NOT EXISTS entities_fts_delete AFTER DELETE ON entities BEGIN
    INSERT INTO entities_fts(entities_fts, rowid, canonical_name)
    VALUES('delete', old.rowid, old.canonical_name);
  END;
  CREATE TRIGGER IF NOT EXISTS entities_fts_update AFTER UPDATE ON entities BEGIN
    INSERT INTO entities_fts(entities_fts, rowid, canonical_name)
    VALUES('delete', old.rowid, old.canonical_name);
    INSERT INTO entities_fts(rowid, canonical_name)
    VALUES (new.rowid, new.canonical_name);
  END;

  CREATE TABLE IF NOT EXISTS entity_aliases (
    id          TEXT PRIMARY KEY,
    entity_id   TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    alias_type  TEXT NOT NULL,
    alias_value TEXT NOT NULL,
    source      TEXT,
    created_at  INTEGER NOT NULL,
    UNIQUE(alias_type, alias_value)
  );
  CREATE INDEX IF NOT EXISTS idx_entity_aliases_value ON entity_aliases(alias_value COLLATE NOCASE);
  CREATE INDEX IF NOT EXISTS idx_entity_aliases_entity ON entity_aliases(entity_id);

  -- FTS5 for alias value search (handles partial/prefix matching)
  CREATE VIRTUAL TABLE IF NOT EXISTS entity_aliases_fts USING fts5(
    alias_value,
    content=entity_aliases,
    content_rowid=rowid,
    tokenize='unicode61 remove_diacritics 0'
  );
  CREATE TRIGGER IF NOT EXISTS entity_aliases_fts_insert AFTER INSERT ON entity_aliases BEGIN
    INSERT INTO entity_aliases_fts(rowid, alias_value)
    VALUES (new.rowid, new.alias_value);
  END;
  CREATE TRIGGER IF NOT EXISTS entity_aliases_fts_delete AFTER DELETE ON entity_aliases BEGIN
    INSERT INTO entity_aliases_fts(entity_aliases_fts, rowid, alias_value)
    VALUES('delete', old.rowid, old.alias_value);
  END;
  CREATE TRIGGER IF NOT EXISTS entity_aliases_fts_update AFTER UPDATE ON entity_aliases BEGIN
    INSERT INTO entity_aliases_fts(entity_aliases_fts, rowid, alias_value)
    VALUES('delete', old.rowid, old.alias_value);
    INSERT INTO entity_aliases_fts(rowid, alias_value)
    VALUES (new.rowid, new.alias_value);
  END;

  -- Link knowledge entries to entities they reference
  CREATE TABLE IF NOT EXISTS knowledge_entity_refs (
    knowledge_id TEXT NOT NULL REFERENCES knowledge(id) ON DELETE CASCADE,
    entity_id    TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    PRIMARY KEY (knowledge_id, entity_id)
  );
  CREATE INDEX IF NOT EXISTS idx_knowledge_entity_refs_entity ON knowledge_entity_refs(entity_id);
  `,
  `
  -- Version 28: Entity relationships.

  CREATE TABLE IF NOT EXISTS entity_relations (
    id          TEXT PRIMARY KEY,
    entity_a    TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    entity_b    TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    relation    TEXT NOT NULL,
    metadata    TEXT,
    source      TEXT,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    UNIQUE(entity_a, entity_b, relation)
  );

  CREATE INDEX IF NOT EXISTS idx_entity_relations_a ON entity_relations(entity_a);
  CREATE INDEX IF NOT EXISTS idx_entity_relations_b ON entity_relations(entity_b);
  `,
  `
  -- Version 29: Multi-user attribution, promotion workflow, and team sync scaffolding.
  -- All columns nullable/defaulted for backward compat with local-only users.
  -- Security note: these columns are sync metadata and product UX hints,
  -- NOT access control. Isolation is enforced at the DB level (database-per-user/team).

  -- User attribution
  ALTER TABLE knowledge ADD COLUMN created_by TEXT;
  ALTER TABLE knowledge ADD COLUMN updated_by TEXT;

  -- Sensitivity classification (product hint — guides auto-promotion decisions)
  ALTER TABLE knowledge ADD COLUMN sensitivity TEXT NOT NULL DEFAULT 'normal';

  -- Promotion workflow (used in personal DB to track personal -> team flow)
  ALTER TABLE knowledge ADD COLUMN promotion_status TEXT;
  ALTER TABLE knowledge ADD COLUMN promoted_at INTEGER;

  -- Approval workflow (used in team DB for admin approval)
  ALTER TABLE knowledge ADD COLUMN approval_status TEXT NOT NULL DEFAULT 'auto';
  ALTER TABLE knowledge ADD COLUMN approved_by TEXT;
  ALTER TABLE knowledge ADD COLUMN approved_at INTEGER;

  -- Origin tracking (used in team DB to trace back to source user)
  ALTER TABLE knowledge ADD COLUMN source_user_id TEXT;
  ALTER TABLE knowledge ADD COLUMN source_entry_id TEXT;

  -- Access tracking
  ALTER TABLE knowledge ADD COLUMN last_accessed_at INTEGER;

  -- Team knowledge cache (local read-only copy of approved team entries)
  CREATE TABLE IF NOT EXISTS team_knowledge (
    id TEXT PRIMARY KEY,
    category TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    created_by TEXT,
    confidence REAL DEFAULT 1.0,
    sensitivity TEXT NOT NULL DEFAULT 'normal',
    source_user_id TEXT,
    synced_at INTEGER NOT NULL,
    metadata TEXT
  );

  -- Team configuration (credentials, sync state)
  CREATE TABLE IF NOT EXISTS team_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,

  `
  -- Version 30: Per-day cost ledger for accurate daily spend attribution.
  -- Each cost-recording call appends to the (day, bucket) row, so cost is
  -- attributed to the actual UTC day it was incurred — avoiding the prior
  -- bar-chart inflation where whole-session cumulative cost was dumped onto a
  -- single day. Day is a UTC 'YYYY-MM-DD' string; bucket is one of
  -- 'conversation' | 'worker' | 'warmup'.
  CREATE TABLE IF NOT EXISTS daily_costs (
    day        TEXT NOT NULL,
    bucket     TEXT NOT NULL,
    cost       REAL NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (day, bucket)
  );
  `,
  `
  -- Version 31: Structured tool-call execution trace for richer pattern
  -- extraction (issue #496). Each tool invocation is recorded with its name,
  -- success/failure status, a bucketed error type, the raw error message, and
  -- wall-clock duration. Feeds the curator context, the distillation observer
  -- pinned block, auto-gotcha creation, and recall.
  --
  -- A tool call spans two messages in the Anthropic protocol: the assistant
  -- tool_use (carries the tool name) and the following user message
  -- tool_result (carries the outcome). Both phases UPSERT on the globally
  -- unique call_id PK: the tool_use seeds name + 'pending'; the tool_result
  -- updates status/error/duration. This also makes re-stores idempotent.
  CREATE TABLE IF NOT EXISTS tool_calls (
    call_id       TEXT PRIMARY KEY,
    message_id    TEXT NOT NULL,
    project_id    TEXT NOT NULL,
    session_id    TEXT NOT NULL,
    tool          TEXT NOT NULL,
    status        TEXT NOT NULL,        -- 'pending' | 'completed' | 'error'
    error_type    TEXT,                 -- bucketed classifier output, NULL unless error
    error_message TEXT,                 -- raw error string (truncated), NULL unless error
    duration_ms   INTEGER,              -- end-start, NULL if unavailable
    created_at    INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_tool_calls_project_tool_status
    ON tool_calls (project_id, tool, status);
  CREATE INDEX IF NOT EXISTS idx_tool_calls_project_session
    ON tool_calls (project_id, session_id);
  `,

  `
  -- Version 32: Rebuild all FTS5 tables with a language-neutral tokenizer.
  --
  -- The original 'porter unicode61' tokenizer applies the Porter stemmer, which
  -- is English-only and counterproductive for other languages. This migration
  -- switches every FTS table to bare 'unicode61 remove_diacritics 0'.
  --
  -- remove_diacritics 0 is REQUIRED: Turkish ç/ğ/ı/ö/ş/ü (and similar letters in
  -- other languages) are DISTINCT letters, not accented variants. Folding them
  -- (remove_diacritics 1/2) would corrupt meaning and collapse distinct words.
  --
  -- Each FTS table is external-content (content=<source>), so the FTS5 'rebuild'
  -- command repopulates the index directly from the source table — no manual
  -- column SELECT needed. Sync triggers are dropped and recreated verbatim.

  -- temporal_fts (source: temporal_messages, col: content)
  DROP TRIGGER IF EXISTS temporal_fts_insert;
  DROP TRIGGER IF EXISTS temporal_fts_delete;
  DROP TRIGGER IF EXISTS temporal_fts_update;
  DROP TABLE IF EXISTS temporal_fts;
  CREATE VIRTUAL TABLE temporal_fts USING fts5(
    content,
    content=temporal_messages,
    content_rowid=rowid,
    tokenize='unicode61 remove_diacritics 0'
  );
  INSERT INTO temporal_fts(temporal_fts) VALUES('rebuild');
  CREATE TRIGGER temporal_fts_insert AFTER INSERT ON temporal_messages BEGIN
    INSERT INTO temporal_fts(rowid, content) VALUES (new.rowid, new.content);
  END;
  CREATE TRIGGER temporal_fts_delete AFTER DELETE ON temporal_messages BEGIN
    INSERT INTO temporal_fts(temporal_fts, rowid, content) VALUES('delete', old.rowid, old.content);
  END;
  CREATE TRIGGER temporal_fts_update AFTER UPDATE ON temporal_messages BEGIN
    INSERT INTO temporal_fts(temporal_fts, rowid, content) VALUES('delete', old.rowid, old.content);
    INSERT INTO temporal_fts(rowid, content) VALUES (new.rowid, new.content);
  END;

  -- knowledge_fts (source: knowledge, cols: title, content, category)
  DROP TRIGGER IF EXISTS knowledge_fts_insert;
  DROP TRIGGER IF EXISTS knowledge_fts_delete;
  DROP TRIGGER IF EXISTS knowledge_fts_update;
  DROP TABLE IF EXISTS knowledge_fts;
  CREATE VIRTUAL TABLE knowledge_fts USING fts5(
    title,
    content,
    category,
    content=knowledge,
    content_rowid=rowid,
    tokenize='unicode61 remove_diacritics 0'
  );
  INSERT INTO knowledge_fts(knowledge_fts) VALUES('rebuild');
  CREATE TRIGGER knowledge_fts_insert AFTER INSERT ON knowledge BEGIN
    INSERT INTO knowledge_fts(rowid, title, content, category)
    VALUES (new.rowid, new.title, new.content, new.category);
  END;
  CREATE TRIGGER knowledge_fts_delete AFTER DELETE ON knowledge BEGIN
    INSERT INTO knowledge_fts(knowledge_fts, rowid, title, content, category)
    VALUES('delete', old.rowid, old.title, old.content, old.category);
  END;
  CREATE TRIGGER knowledge_fts_update AFTER UPDATE ON knowledge BEGIN
    INSERT INTO knowledge_fts(knowledge_fts, rowid, title, content, category)
    VALUES('delete', old.rowid, old.title, old.content, old.category);
    INSERT INTO knowledge_fts(rowid, title, content, category)
    VALUES (new.rowid, new.title, new.content, new.category);
  END;

  -- distillation_fts (source: distillations, col: observations)
  DROP TRIGGER IF EXISTS distillation_fts_insert;
  DROP TRIGGER IF EXISTS distillation_fts_delete;
  DROP TRIGGER IF EXISTS distillation_fts_update;
  DROP TABLE IF EXISTS distillation_fts;
  CREATE VIRTUAL TABLE distillation_fts USING fts5(
    observations,
    content=distillations,
    content_rowid=rowid,
    tokenize='unicode61 remove_diacritics 0'
  );
  INSERT INTO distillation_fts(distillation_fts) VALUES('rebuild');
  CREATE TRIGGER distillation_fts_insert AFTER INSERT ON distillations BEGIN
    INSERT INTO distillation_fts(rowid, observations) VALUES (new.rowid, new.observations);
  END;
  CREATE TRIGGER distillation_fts_delete AFTER DELETE ON distillations BEGIN
    INSERT INTO distillation_fts(distillation_fts, rowid, observations)
    VALUES('delete', old.rowid, old.observations);
  END;
  CREATE TRIGGER distillation_fts_update AFTER UPDATE ON distillations BEGIN
    INSERT INTO distillation_fts(distillation_fts, rowid, observations)
    VALUES('delete', old.rowid, old.observations);
    INSERT INTO distillation_fts(rowid, observations) VALUES (new.rowid, new.observations);
  END;

  -- lat_sections_fts (source: lat_sections, cols: heading, content)
  DROP TRIGGER IF EXISTS lat_fts_insert;
  DROP TRIGGER IF EXISTS lat_fts_delete;
  DROP TRIGGER IF EXISTS lat_fts_update;
  DROP TABLE IF EXISTS lat_sections_fts;
  CREATE VIRTUAL TABLE lat_sections_fts USING fts5(
    heading,
    content,
    content=lat_sections,
    content_rowid=rowid,
    tokenize='unicode61 remove_diacritics 0'
  );
  INSERT INTO lat_sections_fts(lat_sections_fts) VALUES('rebuild');
  CREATE TRIGGER lat_fts_insert AFTER INSERT ON lat_sections BEGIN
    INSERT INTO lat_sections_fts(rowid, heading, content)
    VALUES (new.rowid, new.heading, new.content);
  END;
  CREATE TRIGGER lat_fts_delete AFTER DELETE ON lat_sections BEGIN
    INSERT INTO lat_sections_fts(lat_sections_fts, rowid, heading, content)
    VALUES('delete', old.rowid, old.heading, old.content);
  END;
  CREATE TRIGGER lat_fts_update AFTER UPDATE ON lat_sections BEGIN
    INSERT INTO lat_sections_fts(lat_sections_fts, rowid, heading, content)
    VALUES('delete', old.rowid, old.heading, old.content);
    INSERT INTO lat_sections_fts(rowid, heading, content)
    VALUES (new.rowid, new.heading, new.content);
  END;

  -- entities_fts (source: entities, col: canonical_name)
  DROP TRIGGER IF EXISTS entities_fts_insert;
  DROP TRIGGER IF EXISTS entities_fts_delete;
  DROP TRIGGER IF EXISTS entities_fts_update;
  DROP TABLE IF EXISTS entities_fts;
  CREATE VIRTUAL TABLE entities_fts USING fts5(
    canonical_name,
    content=entities,
    content_rowid=rowid,
    tokenize='unicode61 remove_diacritics 0'
  );
  INSERT INTO entities_fts(entities_fts) VALUES('rebuild');
  CREATE TRIGGER entities_fts_insert AFTER INSERT ON entities BEGIN
    INSERT INTO entities_fts(rowid, canonical_name)
    VALUES (new.rowid, new.canonical_name);
  END;
  CREATE TRIGGER entities_fts_delete AFTER DELETE ON entities BEGIN
    INSERT INTO entities_fts(entities_fts, rowid, canonical_name)
    VALUES('delete', old.rowid, old.canonical_name);
  END;
  CREATE TRIGGER entities_fts_update AFTER UPDATE ON entities BEGIN
    INSERT INTO entities_fts(entities_fts, rowid, canonical_name)
    VALUES('delete', old.rowid, old.canonical_name);
    INSERT INTO entities_fts(rowid, canonical_name)
    VALUES (new.rowid, new.canonical_name);
  END;

  -- entity_aliases_fts (source: entity_aliases, col: alias_value)
  DROP TRIGGER IF EXISTS entity_aliases_fts_insert;
  DROP TRIGGER IF EXISTS entity_aliases_fts_delete;
  DROP TRIGGER IF EXISTS entity_aliases_fts_update;
  DROP TABLE IF EXISTS entity_aliases_fts;
  CREATE VIRTUAL TABLE entity_aliases_fts USING fts5(
    alias_value,
    content=entity_aliases,
    content_rowid=rowid,
    tokenize='unicode61 remove_diacritics 0'
  );
  INSERT INTO entity_aliases_fts(entity_aliases_fts) VALUES('rebuild');
  CREATE TRIGGER entity_aliases_fts_insert AFTER INSERT ON entity_aliases BEGIN
    INSERT INTO entity_aliases_fts(rowid, alias_value)
    VALUES (new.rowid, new.alias_value);
  END;
  CREATE TRIGGER entity_aliases_fts_delete AFTER DELETE ON entity_aliases BEGIN
    INSERT INTO entity_aliases_fts(entity_aliases_fts, rowid, alias_value)
    VALUES('delete', old.rowid, old.alias_value);
  END;
  CREATE TRIGGER entity_aliases_fts_update AFTER UPDATE ON entity_aliases BEGIN
    INSERT INTO entity_aliases_fts(entity_aliases_fts, rowid, alias_value)
    VALUES('delete', old.rowid, old.alias_value);
    INSERT INTO entity_aliases_fts(rowid, alias_value)
    VALUES (new.rowid, new.alias_value);
  END;
  `,

  `
  -- Version 33: Cross-project knowledge transfer metrics (issue #506).
  -- One row per (knowledge entry, foreign project) pair — a bounded tally,
  -- NOT an event log. hit_count accumulates via UPSERT; last_recalled_at is
  -- overwritten while first_recalled_at is set once. Tracks how often a
  -- cross-project / other-project entry is recalled or surfaced in a project
  -- that is NOT its origin, so we can measure whether promotions are useful.
  --
  -- Global entries (project_id IS NULL) have no origin and are never recorded;
  -- self-project recalls are filtered out by callers. No FTS, no triggers, no
  -- FK CASCADE (consistent with tool_calls / daily_costs) — explicit cleanup
  -- lives in data.ts and mergeProjectInternal().
  CREATE TABLE IF NOT EXISTS knowledge_transfers (
    knowledge_id           TEXT NOT NULL,
    recalled_in_project_id TEXT NOT NULL,
    hit_count              INTEGER NOT NULL DEFAULT 0,
    first_recalled_at      INTEGER NOT NULL,
    last_recalled_at       INTEGER NOT NULL,
    PRIMARY KEY (knowledge_id, recalled_in_project_id)
  );
  CREATE INDEX IF NOT EXISTS idx_knowledge_transfers_recalled_in
    ON knowledge_transfers (recalled_in_project_id);
  `,
  `
  -- Version 34: Entity auto-dedup (#462). Embedding-based alias clustering.
  -- Add a vector column to entities (same Float32Array-as-BLOB pattern as
  -- knowledge.embedding) and a 'kind' discriminator on dedup_feedback so the
  -- adaptive threshold calibration table can hold both knowledge and entity
  -- feedback rows. Existing rows default to 'knowledge' to keep the knowledge
  -- dedup code paths unchanged.
  ALTER TABLE entities ADD COLUMN embedding BLOB;
  ALTER TABLE dedup_feedback ADD COLUMN kind TEXT NOT NULL DEFAULT 'knowledge';
  `,
  `
  -- Version 35: Worker source attribution. Records which model produced
  -- each distillation row and each knowledge entry so audits, cost
  -- attribution, and cross-provider analytics are possible without joining
  -- through temporal_messages. Nullable for backward compatibility — pre-v35
  -- rows stay NULL. The dedicated columns (not the existing knowledge.metadata
  -- JSON blob) are used because dedicated columns are indexable and trivially
  -- queryable; the metadata blob stays available for other per-entry data.
  ALTER TABLE distillations ADD COLUMN worker_provider_id TEXT;
  ALTER TABLE distillations ADD COLUMN worker_model_id TEXT;
  ALTER TABLE knowledge ADD COLUMN worker_provider_id TEXT;
  ALTER TABLE knowledge ADD COLUMN worker_model_id TEXT;
  CREATE INDEX IF NOT EXISTS idx_distillation_worker
    ON distillations(worker_provider_id, worker_model_id);
  CREATE INDEX IF NOT EXISTS idx_knowledge_worker
    ON knowledge(worker_provider_id, worker_model_id);
  `,
  `
  -- Version 36: Persist the session's resolved project binding so a gateway
  -- restart does not re-resolve (and potentially split) the project_id.
  -- Without this, a previously-confident session whose first post-restart turn
  -- lacks X-Lore-Project (and an inferable prompt) re-binds provisionally to
  -- cwd / an unattributed bucket, and its new temporal rows + distillations land
  -- under a different project_id than the pre-restart half until a later
  -- confident turn self-heals.
  -- project_path: the project path the session is bound to. NULL for pre-v36
  -- rows and sessions that never got a binding.
  -- project_path_provisional: 1 = provisional (cwd fallback / unattributed
  -- bucket), 0 = confident (header/inferred). Persisting BOTH lets restart
  -- distinguish a confident binding (must not be downgraded by a path-less turn)
  -- from a provisional one (may still be overwritten/self-healed). The
  -- NOT NULL DEFAULT 1 is the safe default: never falsely claims confidence for
  -- legacy / INSERT-OR-IGNORE rows.
  ALTER TABLE session_state ADD COLUMN project_path TEXT;
  ALTER TABLE session_state ADD COLUMN project_path_provisional INTEGER NOT NULL DEFAULT 1;
  `,
  `ALTER TABLE session_state ADD COLUMN compaction_anomaly_pending INTEGER NOT NULL DEFAULT 0;`,
  `
  -- Version 38: Repair over-eager cross-project marking.
  -- The curator historically defaulted crossProject to TRUE, so project-specific
  -- engineering knowledge (architecture, paths, gotchas, directives) was stored
  -- with cross_project = 1 and leaked into every other project's injected
  -- context. Demote those rows back to project scope.
  -- Conservatively preserve genuinely-global knowledge:
  --   * project_id IS NULL  → user-level / scope:"global" entries (kept cross).
  --   * promotion_status = 'promoted' → auto-promoted across >=3 projects, i.e.
  --     it earned cross-project status (kept cross).
  -- Only curator-default-marked, project-owned rows (promotion_status IS NULL)
  -- are demoted.
  UPDATE knowledge
     SET cross_project = 0,
         updated_at = (CAST(strftime('%s','now') AS INTEGER) * 1000)
   WHERE cross_project = 1
     AND project_id IS NOT NULL
     AND promotion_status IS NULL;
  `,
  `
  -- Version 39: Reorder-tolerant LTM diff-pin.
  -- Stores the identity of the entry SET (and per-entry content hash) that the
  -- pinned system[2] text was rendered from. The pin is reused verbatim when the
  -- selected entry-ID set is identical (any order) and no entry's content
  -- changed, eliminating cache busts from pure re-ranking. NULL for pre-v39 rows
  -- (treated as "unknown set" → the first post-upgrade turn re-pins once).
  ALTER TABLE session_state ADD COLUMN ltm_pin_keys TEXT;
  `,
  `
  -- Version 40: Knowledge tombstones.
  -- Records UUIDs of knowledge entries that were intentionally deleted (by the
  -- curator's consolidation, or manual deletion). Without this, a stale
  -- .lore.md that still lists a deleted entry would resurrect it via the
  -- import "unknown UUID -> create" path, and the next consolidation would
  -- delete it again — a thrash loop that invalidates the LTM cache and busts
  -- the prompt cache every cycle. importLoreFile() consults this table and
  -- refuses to re-create a tombstoned UUID.
  CREATE TABLE IF NOT EXISTS knowledge_tombstones (
    id         TEXT PRIMARY KEY,
    project_id TEXT,
    deleted_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_knowledge_tombstones_project
    ON knowledge_tombstones (project_id);
  `,
  `
  -- Version 41: Cross-turn dedup decisions.
  -- JSON map of "<messageID>:<partID>" -> wasCollapsed, recording whether each
  -- tool output was sent full or collapsed. Persisted so the decision survives
  -- a gateway restart: without it, the first post-restart turn re-derives dedup
  -- from scratch and may flip an already-cached message (full <-> collapsed),
  -- busting the prompt cache once. NULL for pre-v41 rows / sessions.
  ALTER TABLE session_state ADD COLUMN dedup_decisions TEXT;
  `,
  `
  -- Version 42: Durable prompt deltas.
  -- Prompt deltas are exact upstream-request insertions that must survive
  -- process restarts and replay byte-identically at the same selector. They are
  -- ordered per session by seq; rows are append-only until an intentional cache
  -- reset/delete. The selector/content payloads are JSON owned by the gateway.
  CREATE TABLE IF NOT EXISTS session_prompt_deltas (
    session_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    project_id TEXT NOT NULL,
    selector TEXT NOT NULL,
    content TEXT NOT NULL,
    PRIMARY KEY (session_id, seq)
  );
  CREATE INDEX IF NOT EXISTS idx_session_prompt_deltas_project
    ON session_prompt_deltas (project_id);
  `,
  `
  -- Version 43: Logical-sync change tracking (Basic tier — knowledge + entity graph).
  --
  -- The outbox is a monotonic append-only queue of local row changes to push to
  -- the remote. The CAPTURE TRIGGERS are NOT defined here — they are created as
  -- per-connection TEMP triggers in installSyncCapture() (db()). This is
  -- deliberate: apply-suppression must be CONNECTION-scoped (the gateway and a
  -- 'lore' CLI share one DB file; a shared persisted "applying" flag would let
  -- one process suppress the other's legitimate captures -> silent data loss).
  -- A main-schema trigger cannot reference a TEMP table, so temp triggers (which
  -- can) gate on a connection-local temp table instead. content_hash / revision
  -- are computed in JS by the sync engine (SQLite has no hash function) and
  -- tracked per-row in sync_state. row_id for the composite-key join table
  -- knowledge_entity_refs is knowledge_id || char(31) || entity_id.

  CREATE TABLE IF NOT EXISTS sync_outbox (
    seq        INTEGER PRIMARY KEY AUTOINCREMENT,
    table_name TEXT NOT NULL,
    row_id     TEXT NOT NULL,
    op         TEXT NOT NULL,        -- 'upsert' | 'delete'
    changed_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sync_outbox_table_row
    ON sync_outbox (table_name, row_id);
  CREATE INDEX IF NOT EXISTS idx_sync_outbox_table_seq
    ON sync_outbox (table_name, seq);

  CREATE TABLE IF NOT EXISTS sync_state (
    table_name        TEXT NOT NULL,
    row_id            TEXT NOT NULL,
    content_hash      TEXT,          -- hash of the row's semantic content at last sync
    revision          INTEGER NOT NULL DEFAULT 0,
    remote_updated_at TEXT,          -- remote server timestamp last applied (per-row pull cursor)
    PRIMARY KEY (table_name, row_id)
  );

  CREATE TABLE IF NOT EXISTS sync_conflicts (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    table_name    TEXT NOT NULL,
    row_id        TEXT NOT NULL,
    detected_at   INTEGER NOT NULL,
    resolution    TEXT,
    local_content TEXT   -- JSON of the discarded local row (recoverable after LWW)
  );
  `,
  `
  -- Version 44: persist lastKnownMessageCount for restart-proof calibration.
  -- The gradient's calibrated-delta estimate needs the message count that was
  -- sent last turn (to identify only genuinely-new messages). last_known_input
  -- and last_layer already persist; without the count, an adopted/resumed
  -- session after a restart is "calibrated" but treats the whole conversation
  -- as new, over-estimating expectedInput and over-escalating the layer for one
  -- turn. Persisting it makes the resume turn accurate. (issue #796)
  ALTER TABLE session_state ADD COLUMN last_known_message_count INTEGER NOT NULL DEFAULT 0;
  `,
  `
  -- Version 45: Durably pin the stable LTM block (system[1]: preferences +
  -- entities) per session. Previously system[1] lived only in an in-memory
  -- cache (stableLtmCache) and was recomputed from the live knowledge table on
  -- idle-resume >=1h, session eviction, or process restart. A curator/
  -- consolidation delete or update mid-session then silently changed the
  -- "stable" prefix, busting the whole prompt cache (ses_14b9bf3d… incident).
  -- Persisting the frozen text lets system[1] be replayed byte-identically for
  -- the session's life — only a brand-new session computes it fresh.
  ALTER TABLE session_state ADD COLUMN stable_ltm_text TEXT;
  ALTER TABLE session_state ADD COLUMN stable_ltm_tokens INTEGER;
  `,
  `
  -- Version 46: Persist the per-session recall store across restarts. The recall
  -- "Marker and Expand" strategy keeps executed recall results in an in-memory
  -- Map (sessionState.recallStore) keyed by query/scope; on each turn the marker
  -- text in history is expanded back into the original tool_use + tool_result
  -- pair. The Map was in-memory only, so a gateway restart lost it: historical
  -- recall markers could no longer be expanded and leaked upstream as raw marker
  -- TEXT — rewriting that (deep) assistant message tool_use→text and busting the
  -- prompt cache mid-history (ses_14b9bf3d… incident, messages[549]). Persisting
  -- the store as JSON lets expansion stay byte-stable across restarts.
  ALTER TABLE session_state ADD COLUMN recall_store TEXT;
  `,
  `
  -- Version 47: Cache-bust measurement counters (issue #791 measure-first gate).
  -- Durable per-(project, cause, relocatable) tallies so the question "is
  -- system[0] dynamic content a MATERIAL cache-bust cause?" can be answered from
  -- real data. The in-memory CacheAnalytics state (turnCount/bustCount) resets on
  -- every gateway restart, so aggregating the rare-vs-material decision requires
  -- a persisted counter. This is PASSIVE telemetry only — it never influences the
  -- bytes sent upstream. relocatable is 0/1 (only meaningful when cause is
  -- 'system-host-change'); write_tokens sums cache_creation tokens so the cost
  -- magnitude (not just the count) of each cause is visible.
  CREATE TABLE IF NOT EXISTS cache_bust_stats (
    project_id   TEXT NOT NULL,
    cause        TEXT NOT NULL,
    relocatable  INTEGER NOT NULL,
    turns        INTEGER NOT NULL DEFAULT 0,
    write_tokens INTEGER NOT NULL DEFAULT 0,
    updated_at   INTEGER NOT NULL,
    PRIMARY KEY (project_id, cause, relocatable)
  );
  `,
  `
  -- Version 48: Knowledge confidence lifecycle (reinforcement clock + decay).
  -- last_reinforced_at records when an entry's relevance was last CONFIRMED —
  -- injected into a prompt, recalled, or re-confirmed by the curator. The idle
  -- decay pass lowers confidence for entries unreinforced past a grace window,
  -- so unused knowledge ages out below the relevance floor (and is then pruned)
  -- while genuinely useful (regularly-injected) knowledge never decays. Backfill
  -- existing rows to updated_at so they start with a sane "last seen" time.
  --
  -- projects.last_decay_at gates the decay pass to once per interval, making the
  -- per-pass decrement rate-stable regardless of how often the idle scheduler
  -- fires (a per-tick decrement would depend on session activity).
  ALTER TABLE knowledge ADD COLUMN last_reinforced_at INTEGER;
  UPDATE knowledge SET last_reinforced_at = updated_at WHERE last_reinforced_at IS NULL;
  ALTER TABLE projects ADD COLUMN last_decay_at INTEGER;
  `,
  `
  -- Version 49: local mirror of the remote 'profiles' row (pull-only sync).
  -- The remote profiles table (supabase/migrations/0001 + tier from 0003) is
  -- server-authoritative account data the client may only READ — billing flips
  -- 'tier' (free→pro) via service_role; the client never writes it. This single-
  -- row mirror is populated by the sync PULL path (pull-only: no outbox capture
  -- trigger, never pushed) so the gateway can resolve the user's plan tier
  -- locally (currentTier()) without a round-trip. timestamps are epoch ms (the
  -- pull path converts the remote timestamptz to ms, same as every synced table).
  CREATE TABLE IF NOT EXISTS profiles (
    id           TEXT PRIMARY KEY,
    tier         TEXT NOT NULL DEFAULT 'free',
    github_login TEXT,
    display_name TEXT,
    email        TEXT,
    created_at   INTEGER,
    updated_at   INTEGER
  );
  `,
  `
  -- Version 50: append-only versioned knowledge — scaffolding (A2, #823).
  --
  -- Splits knowledge's single identity into a stable 'logical_id' (the entry)
  -- and an immutable 'version' (a snapshot). An "update" becomes an append of a
  -- new version (same logical_id); a "delete" becomes an immutable is_deleted=1
  -- version (a death certificate). 'is_current' marks the latest version per
  -- logical_id. This migration ONLY adds the scaffolding and is BEHAVIOR-NEUTRAL:
  -- every existing row becomes its own logical_id, version 1, current, not-deleted,
  -- so 'knowledge_current' is identical to the live set today. The ltm.ts/curator
  -- rewrite to actually append versions (and the confidence register) lands in a
  -- follow-up PR. confidence/last_reinforced_at intentionally remain on 'knowledge'
  -- here (untouched) so no read/write path changes in this PR.
  ALTER TABLE knowledge ADD COLUMN logical_id TEXT;
  ALTER TABLE knowledge ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE knowledge ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE knowledge ADD COLUMN is_current INTEGER NOT NULL DEFAULT 1;
  UPDATE knowledge SET logical_id = id WHERE logical_id IS NULL;

  CREATE INDEX IF NOT EXISTS idx_knowledge_logical ON knowledge(logical_id, version);
  CREATE INDEX IF NOT EXISTS idx_knowledge_current ON knowledge(is_current);

  -- The "current" projection: latest non-deleted version per logical_id. All
  -- non-FTS reads switch to this in the follow-up PR; today it equals the live set.
  DROP VIEW IF EXISTS knowledge_current;
  CREATE VIEW knowledge_current AS
    SELECT k.* FROM knowledge k WHERE k.is_current = 1 AND k.is_deleted = 0;

  -- FTS becomes current-aware: index ONLY the current, non-deleted version so a
  -- search never returns a superseded or deleted version. Replaces the plain
  -- mirror triggers (base schema / v32). On supersession the old version's FTS
  -- row is dropped; a deleted (is_deleted=1) version is never indexed.
  --
  -- 🔴 PARTIAL-MIRROR CONTRACT: from here on knowledge_fts is a PARTIAL mirror of
  -- knowledge (only current+live rows), NOT a full mirror. Harmless in THIS PR —
  -- appendVersion() has no production caller, so every row is v1/current/live and
  -- the mirror is still total. Once the follow-up PR wires update()/remove() onto
  -- appendVersion(), the index holds only current+live rows. Two assumptions need
  -- fixing (done in sub-PR 2b-2a):
  --   1. [RESOLVED — was a FALSE ALARM] validateDatabaseIntegrity() (data.ts) does
  --      NOT break: knowledge_fts is external-content, so COUNT(*) FROM knowledge_fts
  --      scans the CONTENT table (= COUNT(knowledge)), not the index — the parity
  --      stays equal under versioning. Left unchanged; a real partial-index check
  --      would use FTS5 'integrity-check'.
  --   2. rebuildFts("knowledge_fts") (sync-data.ts, run after every knowledge sync
  --      pull) uses FTS5 'rebuild', which ignores these triggers and re-indexes
  --      ALL versions — resurfacing superseded/deleted rows in search. Make the
  --      knowledge_fts rebuild current-aware (delete-all + insert only current+live).
  --   3. The remote knowledge mirror / applyRemoteUpsert sets no logical_id (the
  --      remote has none until the sync sub-PR's migration) — backfill logical_id
  --      on apply so pulled rows aren't NULL once logical_id-keyed reads land.
  DROP TRIGGER IF EXISTS knowledge_fts_insert;
  DROP TRIGGER IF EXISTS knowledge_fts_delete;
  DROP TRIGGER IF EXISTS knowledge_fts_update;
  CREATE TRIGGER knowledge_fts_insert AFTER INSERT ON knowledge
  WHEN new.is_current = 1 AND new.is_deleted = 0 BEGIN
    INSERT INTO knowledge_fts(rowid, title, content, category)
    VALUES (new.rowid, new.title, new.content, new.category);
  END;
  CREATE TRIGGER knowledge_fts_delete AFTER DELETE ON knowledge
  WHEN old.is_current = 1 AND old.is_deleted = 0 BEGIN
    INSERT INTO knowledge_fts(knowledge_fts, rowid, title, content, category)
    VALUES('delete', old.rowid, old.title, old.content, old.category);
  END;
  CREATE TRIGGER knowledge_fts_update AFTER UPDATE ON knowledge BEGIN
    INSERT INTO knowledge_fts(knowledge_fts, rowid, title, content, category)
    SELECT 'delete', old.rowid, old.title, old.content, old.category
     WHERE old.is_current = 1 AND old.is_deleted = 0;
    INSERT INTO knowledge_fts(rowid, title, content, category)
    SELECT new.rowid, new.title, new.content, new.category
     WHERE new.is_current = 1 AND new.is_deleted = 0;
  END;
  `,
  `
  -- Version 51: append-only invariants + query-plan index (A2 sub-PR 2b-2a, #823).
  --
  -- idx_knowledge_one_current enforces AT MOST ONE current version per logical_id
  -- at the schema level — the core append-only invariant appendVersion() upholds
  -- (it demotes the old current row before inserting the new one). Satisfiable on
  -- existing data: every row is is_current=1 with a unique logical_id (== id).
  --
  -- idx_knowledge_project_current restores the project-scoped query plan once reads
  -- route through knowledge_current: without it a no-stats DB picks the
  -- non-selective idx_knowledge_current(is_current) over idx_knowledge_project
  -- (2a review query-plan nit).
  --
  -- Defensive dedup FIRST: if a pre-v51 DB somehow has >1 current version for a
  -- logical_id (only producible by a crash in an older non-atomic appendVersion —
  -- which never had a production caller), demote all but the highest version so the
  -- UNIQUE index below cannot fail and boot-loop the migration. Pure insurance.
  UPDATE knowledge SET is_current = 0
   WHERE is_current = 1 AND EXISTS (
     SELECT 1 FROM knowledge k2
      WHERE k2.logical_id = knowledge.logical_id AND k2.is_current = 1
        AND (k2.version > knowledge.version
             OR (k2.version = knowledge.version AND k2.rowid > knowledge.rowid))
   );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_one_current
    ON knowledge(logical_id) WHERE is_current = 1;
  CREATE INDEX IF NOT EXISTS idx_knowledge_project_current
    ON knowledge(project_id) WHERE is_current = 1 AND is_deleted = 0;
  `,
  `
  -- Version 52: widen the sync_outbox per-row lookup index to include seq, so
  -- seedOutbox's "latest pending op for this row" probe (ORDER BY seq DESC LIMIT 1)
  -- is a pure index seek instead of a sort within the (table_name,row_id) group.
  -- Same name as before (a superset prefix), so the by-name IF NOT EXISTS ensures
  -- elsewhere see it as present and never revert it.
  DROP INDEX IF EXISTS idx_sync_outbox_table_row;
  CREATE INDEX IF NOT EXISTS idx_sync_outbox_table_row
    ON sync_outbox (table_name, row_id, seq);
  `,

  `
  -- Version 53: outcome-reward loop (#497). Two additions:
  --  (a) tool_calls.verifier — 1 when the tool call was a test/build/typecheck/
  --      lint runner, so a session's verifier outcome can be derived precisely
  --      (a failing 'pnpm test' vs an incidental 'grep' miss). NULL = unknown.
  --  (b) knowledge_session_injections — which knowledge entries were injected
  --      into a session, keyed by logical_id (A2 stable identity, survives
  --      version edits). The idle pass credits each entry's confidence by the
  --      session's verifier verdict; 'credited' makes that idempotent (at most
  --      once per session per entry). Project-scoped only — cross_project
  --      entries are never recorded (the loop must never auto-demote shared
  --      knowledge).
  ALTER TABLE tool_calls ADD COLUMN verifier INTEGER;
  CREATE TABLE IF NOT EXISTS knowledge_session_injections (
    session_id  TEXT NOT NULL,
    logical_id  TEXT NOT NULL,
    project_id  TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    credited    INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (session_id, logical_id)
  );
  CREATE INDEX IF NOT EXISTS idx_ksi_session_uncredited
    ON knowledge_session_injections (session_id, credited);
  `,

  `
  -- Version 54: record the session's verifier verdict on each injection at
  -- credit time (#497 follow-up). Enables per-entry "knowledge impact" stats
  -- (how many passing vs failing sessions an entry co-occurred with) surfaced in
  -- 'lore data show'. NULL until the injection is credited (or the session had
  -- no verifier signal).
  ALTER TABLE knowledge_session_injections ADD COLUMN verdict TEXT;
  CREATE INDEX IF NOT EXISTS idx_ksi_logical_verdict
    ON knowledge_session_injections (logical_id, verdict);
  `,

  `
  -- Version 55: extract the mutable metric register into knowledge_meta (A2
  -- sub-PR 3b, #823). confidence + last_reinforced_at are MUTABLE per-entry values
  -- that were living on the IMMUTABLE append-only knowledge version rows (every
  -- decay/reinforce/credit flipped the current version's content hash, re-pushing
  -- the ENTIRE content row to ship a 0.05 delta; appendVersion had to copy them
  -- forward). They move to a register keyed by the STABLE logical_id, JOINed back
  -- into knowledge_current so the read surface is unchanged. BEHAVIOR-NEUTRAL.
  --
  -- This migration is DESTRUCTIVE (DROP COLUMN) and the backfill reads the about-
  -- to-be-dropped column, so it is NOT idempotent as plain SQL: a partial apply
  -- (crash after DROP COLUMN, before the post-loop version bump) would re-run this
  -- and fail "no such column: confidence", boot-looping. It is therefore run as a
  -- column-presence-aware JS step (applyKnowledgeMetaRegister), special-cased in
  -- migrate() by KNOWLEDGE_META_MIGRATION_INDEX — the same pattern VACUUM uses.
  -- This string is intentionally a no-op marker so MIGRATIONS.length still counts.
  `,
  `

  -- Version 56: reference-validity validator (#627 Phase 0). Two additions:
  --  (a) projects.last_refcheck_at — rate-gates the per-project reference-resolution
  --      pass to once per interval (mirrors last_decay_at), so the per-pass penalty is
  --      rate-stable regardless of idle-tick frequency.
  --  (b) knowledge_ref_validity — the last observed resolve counts per logical entry
  --      (broken/total/checked_at), surfaced in 'lore data show'/'lore doctor'. Keyed
  --      by the stable logical_id (matches knowledge_session_injections / knowledge_meta),
  --      so it survives version edits between checks.
  ALTER TABLE projects ADD COLUMN last_refcheck_at INTEGER;
  CREATE TABLE IF NOT EXISTS knowledge_ref_validity (
    logical_id TEXT PRIMARY KEY,
    broken     INTEGER NOT NULL DEFAULT 0,
    total      INTEGER NOT NULL DEFAULT 0,
    checked_at INTEGER NOT NULL DEFAULT 0
  );
  `,

  `
  -- Version 57: index the /ui/costs "first assistant message per session" scan.
  --
  -- The costs page runs three cross-project bulk aggregates (#561):
  -- listAllRecentSessions, aggregateTokensBySessionAll and
  -- aggregateDistillationsBySessionAll. The expensive one is the metadata lookup
  -- inside aggregateTokensBySessionAll: a subquery that filters role='assistant'
  -- AND created_at>=? and groups by session_id to find each session's earliest
  -- assistant message. With only single-column indexes, SQLite full-SCANs
  -- idx_temporal_session for that subquery (~360ms at ~200K messages).
  --
  --   idx_temporal_role_session_created on temporal_messages(role, session_id, created_at)
  --   turns it into a covering equality seek on role='assistant' that streams the
  --   GROUP BY in (session_id, created_at) order — measured ~8x faster (~360ms -> ~42ms).
  --
  -- Deliberately NOT added: a (created_at, session_id) index for the token-sum,
  -- distillation and recent-session aggregates. EXPLAIN QUERY PLAN was measured at
  -- both low and high created_at selectivity (young DB vs years of history) and the
  -- planner always prefers the session-ordered idx_temporal_session /
  -- idx_distillation_session scan there: session ordering lets it stream the
  -- GROUP BY without a temp b-tree, and the token-sum / distillation projections
  -- (SUM(tokens), call_type, token_count) aren't covered anyway. A (created_at,
  -- session_id) index would be pure write amplification on the two hottest tables
  -- with no read benefit, so it is intentionally omitted. (See cost-bulk-queries.test.ts.)
  CREATE INDEX IF NOT EXISTS idx_temporal_role_session_created
    ON temporal_messages (role, session_id, created_at);
  `,

  `
  -- Version 58: COVER the remaining /ui/costs aggregates so they run index-only.
  --
  -- v57 (above) indexed the role='assistant' metadata subquery. The other two hot
  -- aggregates still streamed their GROUP BY off a session-ordered index but did a
  -- heap lookup for every scanned row to read the aggregated/projected column:
  --   • aggregateTokensBySessionAll token-sum — SUM(tokens) ... WHERE created_at>=?
  --     GROUP BY session_id — grouped off idx_temporal_session(session_id) but read
  --     the tokens column from the table for each of ~200K rows.
  --   • listAllRecentSessions — COUNT(*) / MIN(created_at) / MAX(created_at)
  --     GROUP BY (project_id, session_id) — grouped off idx_temporal_project_session
  --     but read created_at from the table per row.
  --
  -- Widening those two indexes to COVER the columns each query touches turns both
  -- into index-only scans (no per-row heap reads). EXPLAIN flips from
  -- "SCAN ... USING INDEX" to "... USING COVERING INDEX"; measured ~2-3.5x faster
  -- on the token-sum query at ~200K messages, and the win grows as the table
  -- outgrows the page cache. This deliberately supersedes the "token-sum
  -- projection isn't covered anyway" note in v57 for the token-sum step.
  --
  -- The wider indexes have the dropped narrow indexes as exact left-prefixes, so
  -- the narrow ones are now redundant and dropped (same prefix-cleanup pattern as
  -- version 6 above). idx_temporal_project_session was additionally already a
  -- left-prefix of idx_temporal_project_session_distilled. Net index count on
  -- temporal_messages is unchanged: two narrow indexes become two covering ones.
  -- All former session-scoped lookups (WHERE session_id=? [ORDER BY created_at],
  -- WHERE session_id=? AND distilled=0) remain index-backed via the new indexes.
  -- (See cost-bulk-queries.test.ts for the plan/correctness pins and mutation.)
  CREATE INDEX IF NOT EXISTS idx_temporal_session_created_tokens
    ON temporal_messages (session_id, created_at, tokens);
  CREATE INDEX IF NOT EXISTS idx_temporal_project_session_created
    ON temporal_messages (project_id, session_id, created_at);
  DROP INDEX IF EXISTS idx_temporal_session;
  DROP INDEX IF EXISTS idx_temporal_project_session;
  `,

  `
  -- Version 59: knowledge_symbol_presence — per-entry record that a cited code
  -- symbol was once confirmed present in the repo (#911). The symbol
  -- reference-validity check only DECAYS confidence when a symbol that was
  -- previously present goes absent (genuine rename/removal drift). An
  -- external/historical/rejected-alternative mention that was never present here
  -- never gets a row, so it can never be penalized — this is what keeps symbol
  -- validation on the safe side of the "cannot verify ≠ broken" invariant.
  -- Keyed by the stable logical_id (matches knowledge_ref_validity /
  -- knowledge_session_injections / knowledge_meta) so it survives version edits.
  CREATE TABLE IF NOT EXISTS knowledge_symbol_presence (
    logical_id      TEXT NOT NULL,
    symbol          TEXT NOT NULL,
    last_present_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (logical_id, symbol)
  );
  `,

  `
  -- Version 60: materialized per-session rollup for the /ui/costs page (#981).
  --
  -- v57/v58 made the three costs-page bulk aggregates index-only, but they are
  -- still O(N temporal_messages) scans that re-degrade as the table outgrows the
  -- page cache. This migration introduces session_rollup — one row per
  -- (project_id, session_id) holding the costs-page inputs (token_sum,
  -- message_count, first/last_message_at, earliest-assistant metadata, and the
  -- distillation call_type counts/tokens). It is maintained incrementally by
  -- triggers on temporal_messages and distillations, so the costs page reads
  -- ~hundreds of session rows instead of scanning ~200K message rows
  -- (O(sessions) not O(messages)).
  --
  -- The table, its indexes, the maintenance triggers AND the one-time backfill
  -- from existing rows are all performed by a JS step (applySessionRollup),
  -- special-cased in migrate() by SESSION_ROLLUP_MIGRATION_INDEX. Doing it in JS
  -- lets the SAME idempotent routine run from recoverMissingObjects (self-heal a
  -- dropped/empty rollup) and reuse the canonical rebuild query in tests/recovery.
  -- This string is intentionally a no-op marker so MIGRATIONS.length still counts.
  `,
  `
  -- Version 61: persist the per-session cache-warmup COST bucket separately.
  -- session_state already stores warmup_savings / warmup_hits, but the warmup
  -- request cost was only rolled into the aggregate worker_cost — so the cost
  -- dashboard/log could show warmup savings without the paired cost, making a
  -- net-negative warmer look profitable. This column lets cost-tracker surface
  -- warmupNet = warmup_savings - warmup_cost.
  ALTER TABLE session_state ADD COLUMN warmup_cost REAL NOT NULL DEFAULT 0;
  `,

  `
  -- Version 62: knowledge_contradictions — idle-detected pairs of knowledge
  -- entries that genuinely OPPOSE each other (the affirmative of the
  -- consolidation "opposing rules are NEVER duplicates — never merge them"
  -- invariant, prompt.ts). Detection ONLY: we surface the pair for the user to
  -- resolve on the dashboard / CLI, never auto-merge or auto-delete (#1123).
  -- Keyed by the two stable logical_ids in canonical (a <= b) order so a pair
  -- is stored exactly once regardless of detection order. A sidecar table like
  -- knowledge_meta / knowledge_symbol_presence — it never touches the frozen
  -- append-only knowledge table.
  CREATE TABLE IF NOT EXISTS knowledge_contradictions (
    logical_id_a TEXT NOT NULL,
    logical_id_b TEXT NOT NULL,
    project_id   TEXT,
    similarity   REAL NOT NULL DEFAULT 0,
    rationale    TEXT,
    status       TEXT NOT NULL DEFAULT 'open',
    detected_at  INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    PRIMARY KEY (logical_id_a, logical_id_b)
  );
  CREATE INDEX IF NOT EXISTS idx_knowledge_contradictions_status
    ON knowledge_contradictions (status);
  `,

  `
  -- Version 63: make knowledge_meta.confidence a CONVERGENT register (A2 sub-PR
  -- 3b-2, #823). confidence becomes a materialized cache derived from a PN-counter
  -- CRDT: per-replica grow-only positive/negative delta accumulators, summed onto
  -- an immutable per-entry base. This lets two devices' independent reinforce/decay
  -- both survive a merge (max per replica counter) instead of last-writer-wins
  -- clobbering the whole value. base_confidence is the create-time value the deltas
  -- accumulate relative to (backfilled from the current confidence).
  ALTER TABLE knowledge_meta ADD COLUMN base_confidence REAL NOT NULL DEFAULT 1.0;
  UPDATE knowledge_meta SET base_confidence = confidence;
  -- Grow-only counters keyed by (logical_id, replica_id). value(entry) =
  -- clamp(base_confidence + SUM(pos) - SUM(neg), 0, 1), clamped at materialize time.
  -- Merge across devices is per-key max(pos)/max(neg) — a join-semilattice, so it is
  -- commutative/associative/idempotent and a stale lower counter never lowers value.
  CREATE TABLE IF NOT EXISTS knowledge_meta_crdt (
    logical_id  TEXT NOT NULL,
    replica_id  TEXT NOT NULL,
    pos         REAL NOT NULL DEFAULT 0,
    neg         REAL NOT NULL DEFAULT 0,
    updated_at  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (logical_id, replica_id)
  );
  `,

  `
  -- Version 64: client-side encryption key store (C-2, epic #821 "C" / #825).
  -- v1 personal model: ONE per-USER account identity keypair (X25519). Its secret
  -- lives here in the LOCAL db in the clear — the local db is already the plaintext
  -- store (conversations, knowledge) protected by the 0600 file mode; encryption
  -- protects only what is pushed to the REMOTE. The account key is recovered on other
  -- devices via passphrase escrow (below) — a per-device keypair is a client-only /
  -- pairing concern deferred to C-5. account_identity is LOCAL-ONLY, never synced.
  CREATE TABLE IF NOT EXISTS account_identity (
    id          INTEGER PRIMARY KEY CHECK (id = 1),
    public_key  BLOB NOT NULL,
    secret_key  BLOB NOT NULL,
    created_at  INTEGER NOT NULL
  );

  -- Escrow: the account secret key wrapped by an Argon2id(passphrase)-derived KEK, so
  -- any device with the passphrase recovers it. An optional recovery-code wrapping is
  -- a second, independent unlock path. The kdf_* params + salt are stored so the KEK
  -- is reproducible. This row is SYNCED to the server in C-3 (it is ciphertext + KDF
  -- params only — the server never sees the passphrase or the plaintext secret).
  -- The recovery wrapping carries its OWN kdf params (recovery_kdf_*), independent of
  -- the passphrase's — otherwise a passphrase change under different params would
  -- silently invalidate a preserved recovery code (it is derived under its own salt +
  -- params). recovery_* columns are all NULL until a recovery code is configured.
  CREATE TABLE IF NOT EXISTS account_escrow (
    id               INTEGER PRIMARY KEY CHECK (id = 1),
    wrapped_secret   BLOB NOT NULL,
    kdf_salt         BLOB NOT NULL,
    kdf_t            INTEGER NOT NULL,
    kdf_m            INTEGER NOT NULL,
    kdf_p            INTEGER NOT NULL,
    recovery_wrapped BLOB,
    recovery_salt    BLOB,
    recovery_kdf_t   INTEGER,
    recovery_kdf_m   INTEGER,
    recovery_kdf_p   INTEGER,
    key_epoch        INTEGER NOT NULL DEFAULT 0,
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL DEFAULT 0
  );

  -- Per-scope data-encryption key (DEK), wrapped (HPKE) to a member's account public
  -- key. v1 personal: one row per scope, member_user_id = scope_id = the user. Teams
  -- (E) add one row per member. wrapped_dek is ciphertext → SYNCED in C-3; the DEK
  -- plaintext is never persisted (unwrapped on demand, cached in memory).
  CREATE TABLE IF NOT EXISTS scope_keys (
    scope_id        TEXT NOT NULL,
    member_user_id  TEXT NOT NULL,
    wrapped_dek     BLOB NOT NULL,
    key_epoch       INTEGER NOT NULL DEFAULT 0,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (scope_id, member_user_id)
  );
  `,
  // v65 (#1191b PR2b): entities.sync_rank — a synced, self-contained ref-count so the
  // server can value-rank entities for eviction. A new entity starts low-value and its
  // knowledge_entity_refs aren't synced yet, so the server can't value the INCOMING row
  // via a JOIN — the column carries the true ref-count on the entity row itself.
  // Maintained in app code at every knowledge_entity_refs mutation (recursive_triggers is
  // OFF, so a trigger here would NOT fire the entities sync-capture/FTS triggers). The
  // backfill re-runs harmlessly on recovery (stripAppliedAlters drops the duplicate ALTER).
  `
  ALTER TABLE entities ADD COLUMN sync_rank INTEGER NOT NULL DEFAULT 0;
  UPDATE entities SET sync_rank = (
    SELECT COUNT(*) FROM knowledge_entity_refs WHERE entity_id = entities.id
  );
  `,
  // Version 66 (#909): drop the ref→knowledge(id) ON DELETE CASCADE FKs so version
  // compaction can prune the v1 anchor (id == logical_id) without cascade-deleting a
  // still-live entry's wiki-refs + entity-links. Refs are resolved by logical_id
  // everywhere (the current version always carries it), so the id-FK guards nothing;
  // ref integrity is app-managed (ltm.remove + the project-delete paths delete refs
  // explicitly, cleanDeadRefs GCs orphans), aligning local with the remote (which never
  // had these FKs). knowledge_entity_refs KEEPS entity_id→entities CASCADE (entities
  // aren't version-compacted).
  //
  // The recreate (CREATE _new / copy / DROP / RENAME) is NOT atomic under plain exec(),
  // so a crash mid-migration would leave a half-state that boot-loops on retry. It is
  // performed by a JS SAVEPOINT step (applyRefFkDrop), special-cased in migrate() by
  // REF_FK_DROP_MIGRATION_INDEX so the whole recreate is all-or-nothing. This string is
  // a no-op marker so MIGRATIONS.length still counts.
  `
  -- Version 66 (#909): see applyRefFkDrop — no-op SQL marker.
  `,
  // Version 67 (#826/D): temporal_messages.restored_at — a LOCAL-ONLY residency clock.
  // A pulled/restored message keeps its ORIGIN created_at (for ordering + recall) but is
  // stamped restored_at=now on apply (applyRemoteTemporal); the TTL/size prune keys off
  // COALESCE(restored_at, created_at) so a restored message gets a full LOCAL retention
  // window instead of being evicted on the very next idle tick despite its old origin
  // created_at (B3). NULL for native rows (created_at governs). NEVER synced (not in
  // temporal_messages' syncColumns). Re-runs harmlessly on recovery (stripAppliedAlters
  // drops the duplicate ALTER).
  `
  ALTER TABLE temporal_messages ADD COLUMN restored_at INTEGER;
  `,
  // Version 68 (#961 follow-up): session_state.worker_breakdown — a LOCAL-ONLY JSON
  // snapshot of per-bucket worker spend, shaped
  // {distillation,curation,compaction,recall,warmup: {cost,calls}}. Until now only the
  // AGGREGATE worker_cost was persisted, so once a session ended the split across
  // background tasks was lost — you couldn't tell whether distillation, curation, or
  // recall drove the worker overhead. This column captures the breakdown for cost
  // observability (UI + `lore eval`). NULL for pre-migration / never-costed rows (readers
  // fall back to the aggregate worker_cost). NEVER synced (not in session_state's sync
  // surface — it's derived local telemetry). Re-runs harmlessly on recovery
  // (stripAppliedAlters drops the duplicate ALTER).
  `
  ALTER TABLE session_state ADD COLUMN worker_breakdown TEXT;
  `,
  // Version 69 (#827 E-4c-3a): scope_keys PK gains key_epoch → (scope_id, member_user_id,
  // key_epoch), so a member retains ONE wrapped DEK PER epoch (key rotation writes a new-epoch
  // row; old epochs stay readable). SQLite can't ALTER a PK, so the table is RECREATED by a JS
  // SAVEPOINT step (applyScopeKeyEpochPk), special-cased in migrate() by
  // SCOPE_KEY_EPOCH_MIGRATION_INDEX so the recreate is all-or-nothing. This string is a no-op
  // marker so MIGRATIONS.length still counts.
  `
   -- Version 69 (#827): see applyScopeKeyEpochPk — no-op SQL marker.
   `,
  // Version 70 (#827 E-5): local pull-only mirror of the org/scope registry so the client can
  // discover which orgs/team scopes it belongs to (and co-members' roles) — the foundation for
  // unwrapping a team DEK and pulling+decrypting shared content. Populated ONLY by the sync pull
  // (pull-only SYNCED_TABLES entries); never written locally. Columns mirror supabase 0023 + the
  // 0033 updated_at (INTEGER epoch-ms locally, per the profiles-mirror convention).
  `
   CREATE TABLE IF NOT EXISTS orgs (
     id            TEXT PRIMARY KEY,
     kind          TEXT NOT NULL DEFAULT 'team',
     owner_user_id TEXT,
     tier          TEXT NOT NULL DEFAULT 'free',
     name          TEXT,
     created_at    INTEGER,
     updated_at    INTEGER
   );
   CREATE TABLE IF NOT EXISTS org_members (
     org_id     TEXT NOT NULL,
     user_id    TEXT NOT NULL,
     role       TEXT NOT NULL DEFAULT 'member',
     created_at INTEGER,
     updated_at INTEGER,
     PRIMARY KEY (org_id, user_id)
   );
   CREATE TABLE IF NOT EXISTS scopes (
     id         TEXT PRIMARY KEY,
     org_id     TEXT,
     kind       TEXT NOT NULL,
     name       TEXT,
     created_at INTEGER,
     updated_at INTEGER
   );
   CREATE TABLE IF NOT EXISTS scope_members (
     scope_id   TEXT NOT NULL,
     user_id    TEXT NOT NULL,
     role       TEXT NOT NULL DEFAULT 'editor',
     created_at INTEGER,
     updated_at INTEGER,
     PRIMARY KEY (scope_id, user_id)
   );
    CREATE INDEX IF NOT EXISTS idx_scope_members_user ON scope_members(user_id);
    CREATE INDEX IF NOT EXISTS idx_org_members_user ON org_members(user_id);
    `,
  // Version 71 (#827 E-5-F3): scope selection & team-promotion policy plumbing (producer side).
  // `projects.scope_id` = the team scope a project is ASSOCIATED with (promotion TARGET; NULL =
  // personal). `projects.promotion_policy` = per-project override of the auto/manual promotion
  // policy (NULL = inherit the team default). `scopes.promotion_policy` = the team-level default,
  // pulled from remote (0034). All behavior-preserving until F3-3 wires push scope resolution.
  `
   ALTER TABLE projects ADD COLUMN scope_id TEXT;
   ALTER TABLE projects ADD COLUMN promotion_policy TEXT;
   ALTER TABLE scopes ADD COLUMN promotion_policy TEXT;
   `,
  // Version 72 (#827 E-5-F3-3): sync_state.scope_id = the scope a row was last PUSHED under
  // (NULL = personal). Lets the push detect a scope change (e.g. knowledge approved into a team)
  // that does NOT change content_hash, and MIGRATE the row (delete old scope → push new scope).
  `
   ALTER TABLE sync_state ADD COLUMN scope_id TEXT;
   `,
  // Version 73: session_state.input_tokens / output_tokens — cumulative raw
  // conversation token buckets. Previously only cache_read_tokens/cache_write_tokens
  // were persisted; input/output were accumulated in memory but dropped on flush.
  // Persisting them makes cost re-derivation possible after a future accounting
  // bug (e.g. the OpenAI/OpenRouter inclusive→disjoint fix in #1322): given
  // stored input + cache buckets, a corrected cost can be recomputed offline.
  // LOCAL-ONLY telemetry — session_state is not synced.
  `
   ALTER TABLE session_state ADD COLUMN input_tokens INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE session_state ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0;
   `,

  `
  -- Version 74: knowledge_ref_anchor — the currently-RESOLVABLE code anchors
  -- (file:line / symbol) cited by a knowledge entry, so recall can point the
  -- agent straight at the code instead of making it grep (#627 follow-on;
  -- Modem "how coding agents read your code"). The reference-validity pass
  -- (validateProjectReferences) already resolves every cited ref to ok/missing/
  -- unknown; this table PERSISTS the resolved-ok file/symbol anchors (previously
  -- discarded — only broken/total counts survived in knowledge_ref_validity).
  -- Rewritten in full for an entry on each check pass, so a removed/renamed ref
  -- naturally drops out (never a stale jump target). Commands are NOT anchors
  -- (not a code location). Keyed by the stable logical_id (matches
  -- knowledge_ref_validity / knowledge_symbol_presence / knowledge_meta) so it
  -- survives version edits between checks. A sidecar table — never touches the
  -- frozen append-only knowledge table.
  CREATE TABLE IF NOT EXISTS knowledge_ref_anchor (
    logical_id TEXT NOT NULL,
    kind       TEXT NOT NULL,
    anchor     TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (logical_id, kind, anchor)
  );
  `,

  `
  -- Version 75: tool_calls.input_path — the source-file path a file-operation
  -- tool acted on (Read/Edit/Write/etc.), extracted from the tool_use input at
  -- record time (#627 Step 1; Modem "how coding agents read your code"). This is
  -- session→file PROVENANCE: which files a session actually touched, distinct
  -- from the file:line anchors a knowledge entry's PROSE cites (knowledge_ref_
  -- anchor, v74). NULL for non-file tools (bash, grep, task, …) and when no path
  -- is recoverable from the input. Foundation for associating knowledge entries
  -- with the files that produced them (D2c).
  ALTER TABLE tool_calls ADD COLUMN input_path TEXT;
  `,
];

// Index of the migration whose work is performed by a column-presence-aware JS
// step instead of plain SQL, because it is destructive (DROP COLUMN) and its
// backfill reads the dropped column — re-running the raw SQL after a partial
// apply would throw "no such column" and boot-loop (mirrors VACUUM's special
// casing). The MIGRATIONS entry at this index is a no-op documentation marker.
const KNOWLEDGE_META_MIGRATION_INDEX = 54; // 0-based index of version-55

// Index of the migration whose work (create session_rollup + triggers + backfill)
// is performed by a JS step instead of plain SQL, so the same idempotent routine
// can run from recoverMissingObjects and reuse the canonical rebuild query. The
// MIGRATIONS entry at this index is a no-op documentation marker.
const SESSION_ROLLUP_MIGRATION_INDEX = 59; // 0-based index of version-60

// Index of the migration whose ref-table recreate (drop the knowledge(id) FKs) is
// performed atomically by a JS SAVEPOINT step (applyRefFkDrop) instead of plain SQL,
// so a crash mid-recreate rolls back cleanly and the retry starts from the original
// tables (plain exec() of CREATE/DROP/RENAME is NOT atomic). The MIGRATIONS entry at
// this index is a no-op documentation marker.
const REF_FK_DROP_MIGRATION_INDEX = 65; // 0-based index of version-66

// Index of the scope_keys PK-widening migration (adds key_epoch to the PK). SQLite cannot
// ALTER a primary key, so it recreates the table; done as a JS SAVEPOINT step so a crash
// mid-recreate rolls back instead of boot-looping. Idempotent (skips if key_epoch already
// in the PK). The MIGRATIONS entry at this index is a no-op documentation marker.
const SCOPE_KEY_EPOCH_MIGRATION_INDEX = 68; // 0-based index of version-69

/**
 * Idempotent, column-presence-aware application of the v55 knowledge_meta register
 * extraction (A2 sub-PR 3b, #823). Safe to run any number of times and in any
 * partial-apply state:
 *  - creates knowledge_meta if absent;
 *  - if `confidence` still exists on knowledge (pre/mid-drop): backfills the
 *    register from the current versions' real values, then drops both columns;
 *  - if already dropped (re-run after a partial apply): backfills any missing
 *    register rows at the default 1.0 (the live values are gone);
 *  - (re)builds knowledge_current to LEFT JOIN the register.
 * Called from BOTH the forward migration loop and recoverMissingObjects, so a
 * crash between the DROP COLUMN and the version bump can never boot-loop.
 */
function applyKnowledgeMetaRegister(database: Database): void {
  // updated_at is the register's own clock (future pull cursor / merge tiebreak),
  // bumped by metric CHANGES (reinforce/decay/credit/curator set) but NOT by
  // markInjected (a relevance touch) — so an injection stays sync-silent.
  database.exec(`CREATE TABLE IF NOT EXISTS knowledge_meta (
    logical_id         TEXT PRIMARY KEY,
    confidence         REAL NOT NULL DEFAULT 1.0,
    last_reinforced_at INTEGER,
    updated_at         INTEGER NOT NULL DEFAULT 0
  );`);
  const hasConfidence = (
    database.query("PRAGMA table_info(knowledge)").all() as Array<{
      name: string;
    }>
  ).some((c) => c.name === "confidence");
  // The view references confidence via k.* — drop it before touching the columns.
  database.exec("DROP VIEW IF EXISTS knowledge_current;");
  if (hasConfidence) {
    // Backfill one register row per logical entry from its CURRENT version's
    // values (idx_knowledge_one_current guarantees one is_current=1 row each).
    database.exec(
      `INSERT OR IGNORE INTO knowledge_meta (logical_id, confidence, last_reinforced_at, updated_at)
         SELECT logical_id, confidence, last_reinforced_at, updated_at
           FROM knowledge WHERE is_current = 1;`,
    );
    try {
      database.exec("ALTER TABLE knowledge DROP COLUMN confidence;");
    } catch {
      // already dropped by a prior partial run
    }
    try {
      database.exec("ALTER TABLE knowledge DROP COLUMN last_reinforced_at;");
    } catch {
      // already dropped by a prior partial run
    }
  } else {
    // Columns already gone (re-run): the live values are unrecoverable, so any
    // entry missing a register row degrades to the default 1.0 (matches the view).
    database.exec(
      `INSERT OR IGNORE INTO knowledge_meta (logical_id, confidence, updated_at)
         SELECT logical_id, 1.0, updated_at FROM knowledge WHERE is_current = 1;`,
    );
  }
  // LEFT JOIN + COALESCE default (not INNER): a current entry must NEVER vanish
  // from reads just because its register row is missing — it degrades to
  // confidence 1.0 (the old column default). last_reinforced_at stays NULL when
  // absent (decay's COALESCE(last_reinforced_at, updated_at) falls back to the
  // content clock).
  database.exec(`CREATE VIEW knowledge_current AS
    SELECT k.*, COALESCE(m.confidence, 1.0) AS confidence, m.last_reinforced_at
      FROM knowledge k
      LEFT JOIN knowledge_meta m ON m.logical_id = k.logical_id
     WHERE k.is_current = 1 AND k.is_deleted = 0;`);
}

// ---------------------------------------------------------------------------
// session_rollup — materialized per-session aggregates for /ui/costs (v60, #981)
// ---------------------------------------------------------------------------

/**
 * Schema + maintenance triggers for `session_rollup`, all `IF NOT EXISTS` so it
 * can run from the v60 migration AND self-heal from `recoverMissingObjects`.
 *
 * One row per `(project_id, session_id)` holds exactly the costs-page inputs:
 *   - temporal_messages: message_count, token_sum, first/last_message_at, and the
 *     earliest-assistant row (identity + created_at + metadata, for model detection);
 *   - distillations: call/token counts split by call_type.
 *
 * Maintenance invariants (see #981 plan):
 *   - token_sum / message_count / distill_* are EXACT O(1) deltas on every write.
 *   - The only values that cannot be maintained by a pure delta are the MIN/MAX
 *     (first/last_message_at) and the earliest-assistant row when the extreme row
 *     is DELETED. Those mark `dirty=1`; the read path / rebuild recomputes the
 *     session lazily — so even bulk prune/clear stays O(1) per source row.
 *   - The UPDATE trigger is scoped `AFTER UPDATE OF content, tokens, metadata`,
 *     which fires ONLY for `temporal.store()`'s re-store. project_id/session_id/
 *     created_at/role are immutable on that path; the project_id moves done by
 *     mergeProjectInternal / moveSessions intentionally do NOT fire it and instead
 *     re-point the rollup rows set-based.
 *   - distillations.call_type / token_count are immutable after insert, so there
 *     is no distillation UPDATE trigger (archived/embedding changes don't count).
 *   - Earliest-assistant tie-break is (created_at ASC, rowid ASC) everywhere
 *     (insert trigger, recompute, full rebuild) so incremental == recompute.
 */
const SESSION_ROLLUP_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS session_rollup (
    project_id               TEXT NOT NULL REFERENCES projects(id),
    session_id               TEXT NOT NULL,
    message_count            INTEGER NOT NULL DEFAULT 0,
    token_sum                INTEGER NOT NULL DEFAULT 0,
    first_message_at         INTEGER,
    last_message_at          INTEGER,
    first_assistant_rowid    INTEGER,
    first_assistant_at       INTEGER,
    first_assistant_metadata TEXT,
    distill_calls            INTEGER NOT NULL DEFAULT 0,
    distill_batch_calls      INTEGER NOT NULL DEFAULT 0,
    distill_token_sum        INTEGER NOT NULL DEFAULT 0,
    distill_batch_token_sum  INTEGER NOT NULL DEFAULT 0,
    dirty                    INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (project_id, session_id)
  );
  CREATE INDEX IF NOT EXISTS idx_session_rollup_last  ON session_rollup(last_message_at);
  CREATE INDEX IF NOT EXISTS idx_session_rollup_dirty ON session_rollup(dirty) WHERE dirty = 1;

  -- temporal_messages INSERT: extend the running aggregates; adopt the new row as
  -- earliest-assistant when it is an assistant strictly earlier than the current
  -- one (tie-break: smaller rowid). All RHS expressions in the DO UPDATE see the
  -- pre-update row values (SQLite UPSERT semantics), so the three first_assistant_*
  -- assignments share one consistent comparison.
  CREATE TRIGGER IF NOT EXISTS temporal_rollup_insert
  AFTER INSERT ON temporal_messages
  BEGIN
    INSERT INTO session_rollup (
      project_id, session_id, message_count, token_sum,
      first_message_at, last_message_at,
      first_assistant_rowid, first_assistant_at, first_assistant_metadata, dirty
    ) VALUES (
      NEW.project_id, NEW.session_id, 1, COALESCE(NEW.tokens, 0),
      NEW.created_at, NEW.created_at,
      CASE WHEN NEW.role = 'assistant' THEN NEW.rowid END,
      CASE WHEN NEW.role = 'assistant' THEN NEW.created_at END,
      CASE WHEN NEW.role = 'assistant' THEN NEW.metadata END,
      0
    )
    ON CONFLICT(project_id, session_id) DO UPDATE SET
      message_count = message_count + 1,
      token_sum = token_sum + COALESCE(NEW.tokens, 0),
      -- COALESCE first: the row may have been seeded by a distillation insert
      -- (message-less), leaving first/last_message_at NULL; scalar MIN/MAX would
      -- otherwise propagate that NULL forever once a distill-only row exists.
      first_message_at = MIN(COALESCE(first_message_at, NEW.created_at), NEW.created_at),
      last_message_at = MAX(COALESCE(last_message_at, NEW.created_at), NEW.created_at),
      first_assistant_rowid = CASE
        WHEN NEW.role = 'assistant' AND (
          first_assistant_at IS NULL OR NEW.created_at < first_assistant_at
          OR (NEW.created_at = first_assistant_at AND NEW.rowid < first_assistant_rowid)
        ) THEN NEW.rowid ELSE first_assistant_rowid END,
      first_assistant_at = CASE
        WHEN NEW.role = 'assistant' AND (
          first_assistant_at IS NULL OR NEW.created_at < first_assistant_at
          OR (NEW.created_at = first_assistant_at AND NEW.rowid < first_assistant_rowid)
        ) THEN NEW.created_at ELSE first_assistant_at END,
      first_assistant_metadata = CASE
        WHEN NEW.role = 'assistant' AND (
          first_assistant_at IS NULL OR NEW.created_at < first_assistant_at
          OR (NEW.created_at = first_assistant_at AND NEW.rowid < first_assistant_rowid)
        ) THEN NEW.metadata ELSE first_assistant_metadata END;
  END;

  -- temporal_messages re-store (only content/tokens/metadata change): apply the
  -- token delta and refresh the earliest-assistant metadata iff THIS row is it.
  CREATE TRIGGER IF NOT EXISTS temporal_rollup_update
  AFTER UPDATE OF content, tokens, metadata ON temporal_messages
  BEGIN
    UPDATE session_rollup SET
      token_sum = token_sum - COALESCE(OLD.tokens, 0) + COALESCE(NEW.tokens, 0),
      first_assistant_metadata = CASE
        WHEN NEW.rowid = first_assistant_rowid THEN NEW.metadata
        ELSE first_assistant_metadata END
    WHERE project_id = NEW.project_id AND session_id = NEW.session_id;
  END;

  -- temporal_messages DELETE: exact count/token deltas; mark dirty when an extreme
  -- (first/last message or the earliest-assistant row) is removed so the session is
  -- recomputed lazily. Drop the rollup row once the session has no rows at all.
  CREATE TRIGGER IF NOT EXISTS temporal_rollup_delete
  AFTER DELETE ON temporal_messages
  BEGIN
    UPDATE session_rollup SET
      message_count = message_count - 1,
      token_sum = token_sum - COALESCE(OLD.tokens, 0),
      dirty = CASE
        WHEN OLD.rowid = first_assistant_rowid
          OR OLD.created_at = first_message_at
          OR OLD.created_at = last_message_at
        THEN 1 ELSE dirty END
    WHERE project_id = OLD.project_id AND session_id = OLD.session_id;
    DELETE FROM session_rollup
    WHERE project_id = OLD.project_id AND session_id = OLD.session_id
      AND message_count <= 0 AND distill_calls <= 0;
  END;

  -- distillations INSERT/DELETE: pure SUM/COUNT deltas (no extremes → never dirty).
  CREATE TRIGGER IF NOT EXISTS distillation_rollup_insert
  AFTER INSERT ON distillations
  BEGIN
    INSERT INTO session_rollup (
      project_id, session_id,
      distill_calls, distill_batch_calls, distill_token_sum, distill_batch_token_sum
    ) VALUES (
      NEW.project_id, NEW.session_id, 1,
      CASE WHEN NEW.call_type = 'batch' THEN 1 ELSE 0 END,
      COALESCE(NEW.token_count, 0),
      CASE WHEN NEW.call_type = 'batch' THEN COALESCE(NEW.token_count, 0) ELSE 0 END
    )
    ON CONFLICT(project_id, session_id) DO UPDATE SET
      distill_calls = distill_calls + 1,
      distill_batch_calls = distill_batch_calls
        + CASE WHEN NEW.call_type = 'batch' THEN 1 ELSE 0 END,
      distill_token_sum = distill_token_sum + COALESCE(NEW.token_count, 0),
      distill_batch_token_sum = distill_batch_token_sum
        + CASE WHEN NEW.call_type = 'batch' THEN COALESCE(NEW.token_count, 0) ELSE 0 END;
  END;

  CREATE TRIGGER IF NOT EXISTS distillation_rollup_delete
  AFTER DELETE ON distillations
  BEGIN
    UPDATE session_rollup SET
      distill_calls = distill_calls - 1,
      distill_batch_calls = distill_batch_calls
        - CASE WHEN OLD.call_type = 'batch' THEN 1 ELSE 0 END,
      distill_token_sum = distill_token_sum - COALESCE(OLD.token_count, 0),
      distill_batch_token_sum = distill_batch_token_sum
        - CASE WHEN OLD.call_type = 'batch' THEN COALESCE(OLD.token_count, 0) ELSE 0 END
    WHERE project_id = OLD.project_id AND session_id = OLD.session_id;
    DELETE FROM session_rollup
    WHERE project_id = OLD.project_id AND session_id = OLD.session_id
      AND message_count <= 0 AND distill_calls <= 0;
  END;
`;

/** Create the session_rollup table + maintenance triggers if missing (idempotent). */
export function ensureSessionRollup(database: Database): void {
  database.exec(SESSION_ROLLUP_SCHEMA_SQL);
}

/**
 * Recompute one session's rollup row from the source tables and clear its dirty
 * flag. Bounded by the session's own row count (uses the session-scoped indexes).
 * If the session has neither messages nor distillations, the row is removed.
 */
function recomputeSessionRollupRow(
  database: Database,
  projectId: string,
  sessionId: string,
): void {
  const t = database
    .query(
      `SELECT COUNT(*) AS c, COALESCE(SUM(tokens), 0) AS toks,
              MIN(created_at) AS first_at, MAX(created_at) AS last_at
         FROM temporal_messages WHERE project_id = ? AND session_id = ?`,
    )
    .get(projectId, sessionId) as {
    c: number;
    toks: number;
    first_at: number | null;
    last_at: number | null;
  };
  const fa = database
    .query(
      `SELECT rowid AS rid, created_at, metadata
         FROM temporal_messages
        WHERE project_id = ? AND session_id = ? AND role = 'assistant'
        ORDER BY created_at ASC, rowid ASC LIMIT 1`,
    )
    .get(projectId, sessionId) as {
    rid: number;
    created_at: number;
    metadata: string | null;
  } | null;
  const d = database
    .query(
      `SELECT COUNT(*) AS calls,
              COALESCE(SUM(CASE WHEN call_type = 'batch' THEN 1 ELSE 0 END), 0) AS batch_calls,
              COALESCE(SUM(token_count), 0) AS toks,
              COALESCE(SUM(CASE WHEN call_type = 'batch' THEN token_count ELSE 0 END), 0) AS batch_toks
         FROM distillations WHERE project_id = ? AND session_id = ?`,
    )
    .get(projectId, sessionId) as {
    calls: number;
    batch_calls: number;
    toks: number;
    batch_toks: number;
  };

  if (t.c === 0 && d.calls === 0) {
    database
      .query(
        "DELETE FROM session_rollup WHERE project_id = ? AND session_id = ?",
      )
      .run(projectId, sessionId);
    return;
  }
  database
    .query(
      `INSERT INTO session_rollup (
         project_id, session_id, message_count, token_sum,
         first_message_at, last_message_at,
         first_assistant_rowid, first_assistant_at, first_assistant_metadata,
         distill_calls, distill_batch_calls, distill_token_sum, distill_batch_token_sum, dirty
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
       ON CONFLICT(project_id, session_id) DO UPDATE SET
         message_count = excluded.message_count,
         token_sum = excluded.token_sum,
         first_message_at = excluded.first_message_at,
         last_message_at = excluded.last_message_at,
         first_assistant_rowid = excluded.first_assistant_rowid,
         first_assistant_at = excluded.first_assistant_at,
         first_assistant_metadata = excluded.first_assistant_metadata,
         distill_calls = excluded.distill_calls,
         distill_batch_calls = excluded.distill_batch_calls,
         distill_token_sum = excluded.distill_token_sum,
         distill_batch_token_sum = excluded.distill_batch_token_sum,
         dirty = 0`,
    )
    .run(
      projectId,
      sessionId,
      t.c,
      t.toks,
      t.first_at,
      t.last_at,
      fa?.rid ?? null,
      fa?.created_at ?? null,
      fa?.metadata ?? null,
      d.calls,
      d.batch_calls,
      d.toks,
      d.batch_toks,
    );
}

/** Recompute every session_rollup row currently flagged dirty. */
export function rebuildDirtySessionRollups(database: Database = db()): void {
  const dirty = database
    .query("SELECT project_id, session_id FROM session_rollup WHERE dirty = 1")
    .all() as Array<{ project_id: string; session_id: string }>;
  // Fast path: nothing dirty. This is the common case on the /ui/costs read
  // path, so don't open a transaction when there's no work.
  if (dirty.length === 0) return;
  // A bulk prune/clear can flag many sessions dirty at once; recomputing each in
  // its own auto-commit on this read path is N fsyncs of write-amplification
  // (cf. the ~23x seedOutbox slowdown). Batch the whole rebuild into ONE unit.
  // A SAVEPOINT (not BEGIN) makes this safe whether called at top level (the
  // /ui/costs read path) OR nested inside an existing transaction.
  database.exec("SAVEPOINT rebuild_dirty_rollups");
  try {
    for (const r of dirty)
      recomputeSessionRollupRow(database, r.project_id, r.session_id);
    database.exec("RELEASE rebuild_dirty_rollups");
  } catch (e) {
    database.exec("ROLLBACK TO rebuild_dirty_rollups");
    database.exec("RELEASE rebuild_dirty_rollups");
    throw e;
  }
}

/**
 * Reconstruct the entire session_rollup table from the source tables. Used by the
 * v60 backfill and by recovery. Idempotent (truncate + repopulate). Three grouped
 * passes that benefit from the v57/v58 covering indexes (#981).
 */
export function rebuildAllSessionRollups(database: Database = db()): void {
  // Atomic truncate+repopulate: a crash between the DELETE and the final INSERT
  // would otherwise leave the table empty/partial. A SAVEPOINT (not BEGIN) keeps
  // this safe whether called at top level (migration runs in autocommit) OR
  // nested inside an existing transaction.
  database.exec("SAVEPOINT rebuild_all_rollups");
  try {
    database.exec("DELETE FROM session_rollup");
    // Pass 1: per-session message_count / token_sum / first/last_message_at.
    database.exec(`
      INSERT INTO session_rollup (
        project_id, session_id, message_count, token_sum, first_message_at, last_message_at
      )
      SELECT project_id, session_id, COUNT(*), COALESCE(SUM(tokens), 0),
             MIN(created_at), MAX(created_at)
        FROM temporal_messages
       GROUP BY project_id, session_id;
    `);
    // Pass 2: earliest assistant row per session (tie-break created_at ASC, rowid ASC).
    // Every session with an assistant message already has a row from pass 1, so the
    // ON CONFLICT branch always applies.
    database.exec(`
      INSERT INTO session_rollup (
        project_id, session_id, first_assistant_rowid, first_assistant_at, first_assistant_metadata
      )
      SELECT project_id, session_id, rid, created_at, metadata FROM (
        SELECT project_id, session_id, rowid AS rid, created_at, metadata,
               ROW_NUMBER() OVER (
                 PARTITION BY project_id, session_id ORDER BY created_at ASC, rowid ASC
               ) AS rn
          FROM temporal_messages WHERE role = 'assistant'
      ) WHERE rn = 1
      ON CONFLICT(project_id, session_id) DO UPDATE SET
        first_assistant_rowid = excluded.first_assistant_rowid,
        first_assistant_at = excluded.first_assistant_at,
        first_assistant_metadata = excluded.first_assistant_metadata;
    `);
    // Pass 3: distillation counts/tokens per session (may create distill-only rows).
    database.exec(`
      INSERT INTO session_rollup (
        project_id, session_id, distill_calls, distill_batch_calls,
        distill_token_sum, distill_batch_token_sum
      )
      SELECT project_id, session_id, COUNT(*),
             COALESCE(SUM(CASE WHEN call_type = 'batch' THEN 1 ELSE 0 END), 0),
             COALESCE(SUM(token_count), 0),
             COALESCE(SUM(CASE WHEN call_type = 'batch' THEN token_count ELSE 0 END), 0)
        FROM distillations
       GROUP BY project_id, session_id
      ON CONFLICT(project_id, session_id) DO UPDATE SET
        distill_calls = excluded.distill_calls,
        distill_batch_calls = excluded.distill_batch_calls,
        distill_token_sum = excluded.distill_token_sum,
        distill_batch_token_sum = excluded.distill_batch_token_sum;
    `);
    database.exec("RELEASE rebuild_all_rollups");
  } catch (e) {
    database.exec("ROLLBACK TO rebuild_all_rollups");
    database.exec("RELEASE rebuild_all_rollups");
    throw e;
  }
}

/** v60 migration step: create the rollup objects then backfill from source. */
function applySessionRollup(database: Database): void {
  ensureSessionRollup(database);
  rebuildAllSessionRollups(database);
}

/**
 * Resolved path of the SQLite database file. Reads
 * `LORE_DB_PATH` first; falls back to `${dataDir}/lore.db`
 * (typically `~/.local/share/lore/lore.db`).
 *
 * The test preload (`packages/core/test/setup.ts`) sets
 * `LORE_DB_PATH` to a temp directory so tests never touch the
 * production DB. Setting it to a non-existent path will create
 * the file on first use. The gateway itself does not set this —
 * it expects a stable location for the DB so the SQLite WAL
 * and FTS5 indices persist across restarts. Env: `LORE_DB_PATH`.
 */
export function dbPath(): string {
  const envPath = process.env.LORE_DB_PATH;
  if (envPath) return envPath;
  return join(dataDir(), "lore.db");
}

let instance: Database | undefined;

export function db(): Database {
  if (instance) return instance;
  const envPath = process.env.LORE_DB_PATH;
  let path: string;
  if (envPath) {
    mkdirSync(dirname(envPath), { recursive: true });
    path = envPath;
  } else {
    // Guard: refuse to open the production DB during test runs.
    // The test preload (setup.ts) sets LORE_DB_PATH to a temp directory.
    // If we reach here with NODE_ENV=test, the preload didn't fire
    // (e.g. bun test invoked from outside the repo). Throw instead of
    // silently writing test fixtures into the user's live database.
    if (process.env.NODE_ENV === "test") {
      throw new Error(
        "LORE_DB_PATH is not set but NODE_ENV=test. " +
          "Run tests via `bun test` from the repo root, or set " +
          "LORE_DB_PATH to a temp path to avoid polluting the production DB.",
      );
    }
    const dir = dataDir();
    mkdirSync(dir, { recursive: true });
    // Owner-only data dir: the DB (and its -wal/-shm sidecars, which hold
    // recent un-checkpointed writes incl. the auth session) live here and
    // contain bearer credentials. Tightening the dir to 0700 closes the
    // practical window even before the per-file chmod below.
    try {
      chmodSync(dir, 0o700);
    } catch {
      // non-POSIX filesystem / platform
    }
    path = join(dir, "lore.db");
  }
  // Both `bun:sqlite` and `node:sqlite` create the file by default if it doesn't
  // exist, so no special option is needed. (bun:sqlite's `{ create: true }`
  // exists only to opt INTO creation when you want readonly=false — which is
  // already the default for our case.)
  //
  // IMPORTANT: Do NOT assign to `instance` until migrate() succeeds. If
  // migrate() throws (SQLITE_BUSY, partial prior run, disk error), the
  // module-level singleton must remain undefined so the next db() call
  // retries initialization instead of returning an un-migrated handle.
  const database = new Database(path);
  // The DB stores bearer credentials (the Supabase auth session / refresh
  // token in team_config) — make it owner-only so another local user/process
  // can't read it. Best-effort: chmod is a no-op / may throw on Windows & some
  // FUSE mounts, which is fine (those don't honor POSIX modes anyway).
  try {
    chmodSync(path, 0o600);
  } catch {
    // ignore — non-POSIX filesystem / platform
  }
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA foreign_keys = ON");
  // Retry for up to 5s when another connection holds the write lock (e.g.
  // backgroundDistill's BEGIN IMMEDIATE overlapping with a recall query).
  // Default is 0ms which throws SQLITE_BUSY immediately.
  database.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  // Return freed pages to the OS incrementally on each transaction commit
  // instead of accumulating a free-page list that bloats the file.
  database.exec("PRAGMA auto_vacuum = INCREMENTAL");
  // Bound the on-disk WAL (#1221). SQLite's default PASSIVE auto-checkpoint is
  // starved by the persistent reader-pool connections (each recall query holds a
  // WAL read-mark), so the WAL can grow unbounded (a 5.4 GB -wal was observed).
  // journal_size_limit truncates the WAL back to this cap after any checkpoint
  // that resets it — the backstop for the active TRUNCATE checkpoint the idle
  // scheduler runs via checkpointWal(). Default is -1 (never truncate).
  database.exec(`PRAGMA journal_size_limit = ${WAL_JOURNAL_SIZE_LIMIT_BYTES}`);
  // Preflight: Lore's schema is built on FTS5 virtual tables. If this runtime's
  // SQLite lacks the FTS5 module, fail fast with an actionable message instead
  // of a cryptic mid-migration `no such module: fts5` crash-loop (#3M).
  assertFts5Available(database);
  migrate(database);
  installSyncCapture(database);
  // Load the sqlite-vec native extension (if available) on the RAW connection,
  // before the tracing Proxy wrap. Never throws — when unavailable, vector
  // search falls back to the pure-JS brute-force path (see db/vec.ts).
  loadVecExtension(database);
  // For an already-vec0 DB on a capable runtime, ensure the vec0 tables exist
  // BEFORE any read can reach them — the blob→vec0 cutover only runs later, in
  // runStartupBackfill. Recovery uses the persisted dimension (set at cutover);
  // a fresh DB stays blob until that cutover, and an incapable runtime (vec
  // unavailable → reads degrade to []) skips this. vec0 tables are local,
  // non-synced derived data, so creating them after installSyncCapture is safe.
  if (isVecAvailable() && readStorageMode(database) === "vec0") {
    const dim = readVecDimension(database);
    if (dim !== null) ensureVec0Store(database, dim);
  }
  // Wrap the connection in the query-tracing Proxy AFTER migrate() and sync
  // change-capture are installed on the RAW connection, so (a) migration and
  // TEMP-trigger setup queries are never traced / re-entrant, and (b) the
  // singleton is only assigned a fully-migrated handle (see invariant above).
  // The Proxy is transparent when no tracer is registered (see db/traced.ts).

  // LORE_NO_DB_TRACING=1 returns the raw connection instead of the query-tracing Proxy (disables automatic per-query DB spans).
  const dbTracingDisabled = process.env.LORE_NO_DB_TRACING === "1";
  instance = dbTracingDisabled ? database : tracedDatabase(database);
  return instance;
}

// ---------------------------------------------------------------------------
// Per-connection sync change-capture (logical-sync engine, v43)
// ---------------------------------------------------------------------------

/**
 * Install this connection's sync change-capture: a connection-local TEMP table
 * `_sync_applying` plus TEMP triggers that enqueue (table, row_id, op) into
 * `sync_outbox` on every INSERT/UPDATE/DELETE of a synced table.
 *
 * Why per-connection TEMP (not persistent triggers + a shared flag): the
 * gateway and a `lore` CLI invocation share one DB file. Apply-suppression must
 * be CONNECTION-scoped — a shared persisted "applying" flag would let one
 * process suppress the other process's legitimate captures, silently losing
 * changes from the push queue. A main-schema trigger cannot reference a TEMP
 * table; a TEMP trigger can. Capture is gated by the shared user setting
 * `team_config 'sync.enabled'='1'` AND an empty `_sync_applying` (this
 * connection is not mid-apply). Row count in `_sync_applying` is a re-entrant
 * depth counter (see `withSyncApplying`).
 *
 * Idempotent (`IF NOT EXISTS`); runs on every `db()` init so it survives a
 * dropped trigger (unlike `recoverMissingObjects`, which only restores tables).
 */
function installSyncCapture(database: Database) {
  database.exec(
    "CREATE TEMP TABLE IF NOT EXISTS _sync_applying (marker INTEGER)",
  );
  const gate =
    "(SELECT value FROM team_config WHERE key='sync.enabled')='1' " +
    "AND NOT EXISTS (SELECT 1 FROM temp._sync_applying)";
  const ts = "CAST(strftime('%s','now') AS INTEGER)*1000";
  // P2 (#1246) content git_remote gates. A row syncs only if it is REMOTE-BACKED or
  // GLOBAL — a remote-less project's random id can't correlate cross-device, so its
  // private data must not upload. `directGate(c)` for a table WITH project_id/cross_project
  // (knowledge, entities): cross_project=1 (promoted/global) OR NULL project_id OR the
  // project has a git_remote. `knowledgeParentGate`/`entityParentGate` gate a CHILD (no
  // project_id of its own) on whether its parent knowledge/entity is itself syncable.
  const directGate = (c: string) =>
    `(${c}.cross_project = 1 OR ${c}.project_id IS NULL OR ` +
    `EXISTS (SELECT 1 FROM projects p WHERE p.id = ${c}.project_id AND p.git_remote IS NOT NULL))`;
  const knowledgeParentGate = (idExpr: string) =>
    `EXISTS (SELECT 1 FROM knowledge k WHERE COALESCE(k.logical_id, k.id) = ${idExpr} AND ${directGate("k")})`;
  const entityParentGate = (idExpr: string) =>
    `EXISTS (SELECT 1 FROM entities e WHERE e.id = ${idExpr} AND ${directGate("e")})`;
  // P2c (#1246): the Pro tables (distillations, temporal via the fanout) are ALWAYS
  // project-scoped (project_id NOT NULL, no cross_project) — so they sync only when their
  // project is remote-backed. No global/cross exemption applies.
  const projectRemoteGate = (idExpr: string) =>
    `EXISTS (SELECT 1 FROM projects p WHERE p.id = ${idExpr} AND p.git_remote IS NOT NULL)`;
  const ops = [
    ["INSERT", "ins", "new", "upsert"],
    ["UPDATE", "upd", "new", "upsert"],
    ["DELETE", "del", "old", "delete"],
  ] as const;
  let sql = "";
  for (const t of [
    "knowledge",
    "entities",
    "entity_aliases",
    "entity_relations",
  ]) {
    for (const [evt, suffix, ref, op] of ops) {
      // Direct-project_id tables (P2a): gate every op on the row's own project.
      // Child tables (P2b): gate INSERT/UPDATE on the PARENT entity's syncability; a
      // DELETE stays UNGATED — a delete of a never-synced child pushes as a harmless
      // idempotent no-op, and gating it would depend on the parent still existing, but
      // the parent (entity) is cascade-deleted FIRST (ON DELETE CASCADE), so an EXISTS
      // check would spuriously drop a legitimate delete of a previously-synced child.
      let contentGate = "";
      if (t === "knowledge" || t === "entities")
        contentGate = ` AND ${directGate(ref)}`;
      else if (op !== "delete")
        contentGate =
          t === "entity_aliases"
            ? ` AND ${entityParentGate(`${ref}.entity_id`)}`
            : ` AND ${entityParentGate(`${ref}.entity_a`)} AND ${entityParentGate(`${ref}.entity_b`)}`;
      // Knowledge is remote-keyed by logical_id (A2, #823), so capture the
      // logical_id for ALL ops (not the per-version row id). This makes the outbox
      // uniformly logical_id-keyed: the push plan + pending checks read the row_id
      // directly with no join back to a physical version row — so they survive
      // compaction that prunes the v1 anchor (#909). DELETE must capture it anyway
      // (the row is gone afterward); INSERT/UPDATE capture it for uniformity.
      const rowExpr =
        t === "knowledge"
          ? `COALESCE(${ref}.logical_id, ${ref}.id)`
          : `${ref}.id`;
      sql += `
        CREATE TEMP TRIGGER IF NOT EXISTS ${t}_outbox_${suffix}
        AFTER ${evt} ON ${t} WHEN (${gate}${contentGate})
        BEGIN
          INSERT INTO sync_outbox (table_name, row_id, op, changed_at)
          VALUES ('${t}', ${rowExpr}, '${op}', ${ts});
        END;`;
    }
  }
  // Join table: composite row_id (knowledge_id || char(31) || entity_id), insert/delete
  // only (no updatable columns). P2b: gate INSERT on BOTH parents (the ref links a
  // knowledge to an entity — both must be syncable); DELETE stays ungated (no-op if never
  // synced; the parents may be gone by delete time).
  sql += `
    CREATE TEMP TRIGGER IF NOT EXISTS knowledge_entity_refs_outbox_ins
    AFTER INSERT ON knowledge_entity_refs
    WHEN (${gate} AND ${knowledgeParentGate("new.knowledge_id")} AND ${entityParentGate("new.entity_id")})
    BEGIN
      INSERT INTO sync_outbox (table_name, row_id, op, changed_at)
      VALUES ('knowledge_entity_refs', new.knowledge_id || char(31) || new.entity_id, 'upsert', ${ts});
    END;
    CREATE TEMP TRIGGER IF NOT EXISTS knowledge_entity_refs_outbox_del
    AFTER DELETE ON knowledge_entity_refs WHEN (${gate})
    BEGIN
      INSERT INTO sync_outbox (table_name, row_id, op, changed_at)
      VALUES ('knowledge_entity_refs', old.knowledge_id || char(31) || old.entity_id, 'delete', ${ts});
    END;`;
  // A2 sub-PR 3b-2: knowledge_meta base register, keyed by logical_id. Only the
  // IMMUTABLE base_confidence syncs, so the UPDATE trigger fires ONLY when it
  // actually changes — the frequent per-op confidence re-materialization (which
  // only writes the local-derived confidence/updated_at) must NOT churn the outbox.
  // No DELETE (a register row outlives the knowledge entry's death-cert).
  // P2b (#1246): gate on the parent knowledge's syncability.
  sql += `
    CREATE TEMP TRIGGER IF NOT EXISTS knowledge_meta_outbox_ins
    AFTER INSERT ON knowledge_meta WHEN (${gate} AND ${knowledgeParentGate("new.logical_id")})
    BEGIN
      INSERT INTO sync_outbox (table_name, row_id, op, changed_at)
      VALUES ('knowledge_meta', new.logical_id, 'upsert', ${ts});
    END;
    CREATE TEMP TRIGGER IF NOT EXISTS knowledge_meta_outbox_upd
    AFTER UPDATE ON knowledge_meta
    WHEN ((${gate}) AND new.base_confidence IS NOT old.base_confidence AND ${knowledgeParentGate("new.logical_id")})
    BEGIN
      INSERT INTO sync_outbox (table_name, row_id, op, changed_at)
      VALUES ('knowledge_meta', new.logical_id, 'upsert', ${ts});
    END;`;
  // A2 sub-PR 3b-2: knowledge_meta_crdt grow-only counters, composite key
  // (logical_id || US || replica_id). Single-owner per (logical_id, replica_id):
  // local applyConfidenceDelta only ever writes THIS device's replica row, and
  // pulled peer rows arrive under apply-suppression — so the outbox only carries
  // this device's counters. INSERT + UPDATE (pos/neg grow); no DELETE.
  // P2b (#1246): gate on the parent knowledge's syncability.
  sql += `
    CREATE TEMP TRIGGER IF NOT EXISTS knowledge_meta_crdt_outbox_ins
    AFTER INSERT ON knowledge_meta_crdt WHEN (${gate} AND ${knowledgeParentGate("new.logical_id")})
    BEGIN
      INSERT INTO sync_outbox (table_name, row_id, op, changed_at)
      VALUES ('knowledge_meta_crdt', new.logical_id || char(31) || new.replica_id, 'upsert', ${ts});
    END;
    CREATE TEMP TRIGGER IF NOT EXISTS knowledge_meta_crdt_outbox_upd
    AFTER UPDATE ON knowledge_meta_crdt
    WHEN (${gate} AND (new.pos > old.pos OR new.neg > old.neg) AND ${knowledgeParentGate("new.logical_id")})
    BEGIN
      INSERT INTO sync_outbox (table_name, row_id, op, changed_at)
      VALUES ('knowledge_meta_crdt', new.logical_id || char(31) || new.replica_id, 'upsert', ${ts});
    END;`;
  // C-3 (#825): encryption key store. account_escrow is single-row (keyed by id=1);
  // scope_keys is keyed by (member_user_id, key_epoch) — one wrap per member PER epoch since
  // rotation (E-4c-3), so the outbox row_id is composite (member_user_id ⟳ char(31) ⟳ key_epoch),
  // matching idColumns. INSERT + UPDATE (set/rotate the wrapping); no DELETE (v1).
  sql += `
    CREATE TEMP TRIGGER IF NOT EXISTS account_escrow_outbox_ins
    AFTER INSERT ON account_escrow WHEN (${gate})
    BEGIN
      INSERT INTO sync_outbox (table_name, row_id, op, changed_at)
      VALUES ('account_escrow', new.id, 'upsert', ${ts});
    END;
    CREATE TEMP TRIGGER IF NOT EXISTS account_escrow_outbox_upd
    AFTER UPDATE ON account_escrow WHEN (${gate})
    BEGIN
      INSERT INTO sync_outbox (table_name, row_id, op, changed_at)
      VALUES ('account_escrow', new.id, 'upsert', ${ts});
    END;
    CREATE TEMP TRIGGER IF NOT EXISTS scope_keys_outbox_ins
    AFTER INSERT ON scope_keys WHEN (${gate})
    BEGIN
      INSERT INTO sync_outbox (table_name, row_id, op, changed_at)
      VALUES ('scope_keys', new.member_user_id || char(31) || new.key_epoch, 'upsert', ${ts});
    END;
    CREATE TEMP TRIGGER IF NOT EXISTS scope_keys_outbox_upd
    AFTER UPDATE ON scope_keys WHEN (${gate})
    BEGIN
      INSERT INTO sync_outbox (table_name, row_id, op, changed_at)
      VALUES ('scope_keys', new.member_user_id || char(31) || new.key_epoch, 'upsert', ${ts});
    END;`;
  // #1246: projects identity mapping (id→git_remote). Gated on git_remote IS NOT NULL —
  // only remote-backed projects sync (a remote-less project's random id can't correlate
  // cross-device; its content would FK-poison on a peer). The UPDATE trigger fires the
  // git_remote backfill (null→remote) into the outbox. NO DELETE trigger AND projects is
  // deleteInvisible (reconcile skips its delete-tombstone pass), so a local deletion — a
  // convergence merge loser OR a genuine project delete — is fully DELETE-INVISIBLE and
  // never tombstones the shared remote mapping (a merge loser's content is
  // re-keyed to the winner, not deleted; a genuine delete must not nuke another device's
  // still-active project). Bounded by quota, not deletes. path is DEVICE-LOCAL, not synced.
  sql += `
    CREATE TEMP TRIGGER IF NOT EXISTS projects_outbox_ins
    AFTER INSERT ON projects WHEN (${gate} AND new.git_remote IS NOT NULL)
    BEGIN
      INSERT INTO sync_outbox (table_name, row_id, op, changed_at)
      VALUES ('projects', new.id, 'upsert', ${ts});
    END;
    CREATE TEMP TRIGGER IF NOT EXISTS projects_outbox_upd
    AFTER UPDATE ON projects WHEN (${gate} AND new.git_remote IS NOT NULL)
    BEGIN
      INSERT INTO sync_outbox (table_name, row_id, op, changed_at)
      VALUES ('projects', new.id, 'upsert', ${ts});
    END;`;
  // D (#826): Pro-tier distillation-fanout capture. Installed ONLY when the plan
  // tier (from the pulled profiles mirror) is pro/max — a free user creating
  // distillations must not accrue un-pushable pro outbox entries that no push cursor
  // ever drains. On a tier flip the gateway calls reinstallSyncCapture() to add/drop
  // these (TEMP + IF NOT EXISTS is idempotent; the else-branch DROP removes them on
  // downgrade).
  const tierRow = database
    .query("SELECT tier FROM profiles LIMIT 1")
    .all()[0] as { tier?: string } | undefined;
  const isProTier = tierRow?.tier === "pro" || tierRow?.tier === "max";
  if (isProTier) {
    // On INSERT: enqueue the distillation AND fan out one temporal_messages outbox
    // row per referenced source id (json_each over source_ids). This REFERENCED
    // SUBSET is the ONLY temporal that ever syncs — temporal_messages has NO capture
    // trigger of its own (captureStrategy "none"), so an undistilled message is never
    // enqueued. On UPDATE (the archived flip): re-enqueue the distillation only (its
    // source set is immutable; a no-op non-archived UPDATE such as embedding backfill
    // is deduped away by the push-side content_hash check). No DELETE: the local prune
    // is sync-invisible (temporal.prune runs under capture-suppression + clears
    // sync_state), so a pruned local row must NOT tombstone the remote backup.
    // P2c (#1246): gate on the distillation's project git_remote — gating the INSERT
    // trigger's WHEN gates BOTH the distillation row AND the temporal fanout in one shot,
    // so a remote-less project's compressed memory + its referenced messages never upload.
    // Belt-and-suspenders (#826): the fanout ALSO re-checks each fanned-out temporal's OWN
    // project git_remote. Normally redundant (a distillation's source_ids reference
    // messages in the same session⇒same project as the distillation), but should that
    // invariant ever break, a cross-project source id pointing at a remote-less project's
    // message would otherwise upload it and FK-poison a peer (temporal FKs projects).
    sql += `
      CREATE TEMP TRIGGER IF NOT EXISTS distillations_outbox_ins
      AFTER INSERT ON distillations WHEN (${gate} AND ${projectRemoteGate("new.project_id")})
      BEGIN
        INSERT INTO sync_outbox (table_name, row_id, op, changed_at)
        VALUES ('distillations', new.id, 'upsert', ${ts});
        INSERT INTO sync_outbox (table_name, row_id, op, changed_at)
        SELECT 'temporal_messages', value, 'upsert', ${ts} FROM json_each(new.source_ids)
         WHERE EXISTS (SELECT 1 FROM temporal_messages t
                        WHERE t.id = value AND ${projectRemoteGate("t.project_id")});
      END;
      CREATE TEMP TRIGGER IF NOT EXISTS distillations_outbox_upd
      AFTER UPDATE ON distillations WHEN (${gate} AND ${projectRemoteGate("new.project_id")})
      BEGIN
        INSERT INTO sync_outbox (table_name, row_id, op, changed_at)
        VALUES ('distillations', new.id, 'upsert', ${ts});
      END;`;
  } else {
    sql += `
      DROP TRIGGER IF EXISTS distillations_outbox_ins;
      DROP TRIGGER IF EXISTS distillations_outbox_upd;`;
  }
  database.exec(sql);
}

/**
 * Re-run change-capture install on the current connection to reconcile the Pro
 * distillation-fanout trigger set to the current plan tier (installSyncCapture reads
 * it from the profiles mirror). Called after a profile pull may have flipped the
 * tier: TEMP + IF NOT EXISTS makes the re-run idempotent, and the non-pro branch
 * DROPs the Pro triggers on a downgrade.
 */
export function reinstallSyncCapture(database: Database = db()): void {
  installSyncCapture(database);
}

/**
 * Run `fn` with THIS connection's sync change-capture suppressed, so applying
 * pulled remote rows is not re-enqueued for push (push<->pull echo guard).
 * Re-entrant: the suppression is a depth counter (row count in the per-connection
 * `_sync_applying` temp table), so nested calls don't prematurely re-enable
 * capture, and a failing `fn` still decrements exactly one level.
 */
export function withSyncApplying<T>(fn: () => T): T {
  db().exec("INSERT INTO temp._sync_applying (marker) VALUES (1)");
  try {
    return fn();
  } finally {
    db().exec(
      "DELETE FROM temp._sync_applying WHERE rowid = (SELECT MAX(rowid) FROM temp._sync_applying)",
    );
  }
}

// Index of the migration that performs a one-time VACUUM.
// VACUUM cannot run inside a transaction, so migrate() handles it specially.
const VACUUM_MIGRATION_INDEX = 2; // 0-based index of version-3 migration

/**
 * v66 (#909): recreate knowledge_entity_refs + knowledge_refs WITHOUT their
 * `knowledge(id) ON DELETE CASCADE` FKs, so version compaction can prune the v1 anchor
 * without cascade-deleting a live entry's refs. Wrapped in a SAVEPOINT so the whole
 * CREATE _new / copy / DROP / RENAME is atomic: a crash mid-recreate rolls back and the
 * retry starts from the original tables (plain `exec()` of these statements is NOT
 * atomic, and a lingering `_new` table would boot-loop the retry — see #909 review).
 * Idempotent: re-running on already-migrated (FK-less) tables reproduces the same shape.
 * knowledge_entity_refs KEEPS its entity_id→entities CASCADE; the copy filters orphan
 * entity refs so the retained FK cannot fail the INSERT under `foreign_keys=ON`.
 */
function applyRefFkDrop(database: Database) {
  database.exec("SAVEPOINT ref_fk_drop");
  try {
    database.exec(`
      DROP TABLE IF EXISTS knowledge_entity_refs_new;
      CREATE TABLE knowledge_entity_refs_new (
        knowledge_id TEXT NOT NULL,
        entity_id    TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
        PRIMARY KEY (knowledge_id, entity_id)
      );
      INSERT INTO knowledge_entity_refs_new (knowledge_id, entity_id)
        SELECT knowledge_id, entity_id FROM knowledge_entity_refs
         WHERE entity_id IN (SELECT id FROM entities);
      DROP TABLE knowledge_entity_refs;
      ALTER TABLE knowledge_entity_refs_new RENAME TO knowledge_entity_refs;
      CREATE INDEX IF NOT EXISTS idx_knowledge_entity_refs_entity
        ON knowledge_entity_refs(entity_id);

      DROP TABLE IF EXISTS knowledge_refs_new;
      CREATE TABLE knowledge_refs_new (
        from_id TEXT NOT NULL,
        to_id   TEXT NOT NULL,
        PRIMARY KEY (from_id, to_id)
      );
      INSERT INTO knowledge_refs_new (from_id, to_id)
        SELECT from_id, to_id FROM knowledge_refs;
      DROP TABLE knowledge_refs;
      ALTER TABLE knowledge_refs_new RENAME TO knowledge_refs;
    `);
    database.exec("RELEASE ref_fk_drop");
  } catch (e) {
    database.exec("ROLLBACK TO ref_fk_drop");
    database.exec("RELEASE ref_fk_drop");
    throw e;
  }
}

// v69 (#827 E-4c-3a): widen the scope_keys PK to include key_epoch so a member retains one
// wrapped DEK per epoch (rotation writes a new-epoch row). SQLite can't ALTER a PK → recreate.
// Idempotent: skips if key_epoch is already part of the PK (a re-run after recovery).
function applyScopeKeyEpochPk(database: Database) {
  const cols = database.query("PRAGMA table_info('scope_keys')").all() as {
    name: string;
    pk: number;
  }[];
  if (cols.some((c) => c.name === "key_epoch" && c.pk > 0)) return; // already widened
  database.exec("SAVEPOINT scope_key_epoch_pk");
  try {
    database.exec(`
      DROP TABLE IF EXISTS scope_keys_new;
      CREATE TABLE scope_keys_new (
        scope_id        TEXT NOT NULL,
        member_user_id  TEXT NOT NULL,
        wrapped_dek     BLOB NOT NULL,
        key_epoch       INTEGER NOT NULL DEFAULT 0,
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (scope_id, member_user_id, key_epoch)
      );
      INSERT INTO scope_keys_new (scope_id, member_user_id, wrapped_dek, key_epoch, created_at, updated_at)
        SELECT scope_id, member_user_id, wrapped_dek, key_epoch, created_at, updated_at FROM scope_keys;
      DROP TABLE scope_keys;
      ALTER TABLE scope_keys_new RENAME TO scope_keys;
    `);
    database.exec("RELEASE scope_key_epoch_pk");
  } catch (e) {
    database.exec("ROLLBACK TO scope_key_epoch_pk");
    database.exec("RELEASE scope_key_epoch_pk");
    throw e;
  }
}

/**
 * Preflight check: verify the runtime's SQLite has the FTS5 full-text search
 * extension compiled in.
 *
 * Every memory feature (temporal / knowledge / entity / distillation search)
 * is built on FTS5 virtual tables, so a SQLite without it cannot function —
 * this is a hard requirement, not a degradable one. Some system SQLite builds
 * (notably on Windows) omit FTS5; without this probe the absence surfaced only
 * mid-migration as a cryptic `no such module: fts5` that crash-looped on every
 * request (Sentry LOREAI-GATEWAY-3M). Probing up front lets us fail with a
 * clear, actionable message.
 *
 * The probe creates and drops a connection-scoped TEMP virtual table so it
 * never touches the persistent schema. Only the absence of the module makes
 * `CREATE VIRTUAL TABLE ... USING fts5` fail; any other (e.g. disk/IO) error is
 * unexpected and is surfaced unchanged rather than mislabeled as "FTS5 missing".
 */
export function assertFts5Available(database: Database): void {
  try {
    // Table name deliberately omits the literal "fts5" so the classifier below
    // can only match the module name in a real error, never our own probe SQL.
    database.exec(
      "CREATE VIRTUAL TABLE IF NOT EXISTS temp.lore_fulltext_probe USING fts5(x)",
    );
    database.exec("DROP TABLE IF EXISTS temp.lore_fulltext_probe");
  } catch (e: unknown) {
    const detail = e instanceof Error ? e.message : String(e);
    if (!/fts5|no such module/i.test(detail)) throw e;
    throw new Error(
      `Lore requires SQLite with the FTS5 full-text search extension, but this runtime's SQLite was built without it (${detail}). ` +
        "FTS5 powers Lore's memory search and cannot be disabled. Use the standalone `lore` binary, or a Node.js/Bun build whose bundled SQLite includes FTS5. " +
        "See https://www.sqlite.org/fts5.html",
      { cause: e },
    );
  }
}

function migrate(database: Database) {
  const row = database
    .query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'",
    )
    .get() as { name: string } | null;
  const current = row
    ? ((
        database.query("SELECT version FROM schema_version").get() as {
          version: number;
        }
      )?.version ?? 0)
    : 0;
  if (current >= MIGRATIONS.length) {
    // Schema is at the expected version but a prior partial run may have left
    // holes (e.g. ALTER TABLE succeeded but CREATE TABLE in the same migration
    // string was skipped). Run idempotent recovery for known fragile objects.
    recoverMissingObjects(database);
    return;
  }
  for (let i = current; i < MIGRATIONS.length; i++) {
    if (i === VACUUM_MIGRATION_INDEX) {
      // VACUUM cannot run inside a transaction. Run it directly.
      // auto_vacuum mode must be set *before* VACUUM — SQLite bakes it into
      // the file header during the rebuild. After this, every subsequent
      // startup's "PRAGMA auto_vacuum = INCREMENTAL" is a no-op (already set).
      database.exec("PRAGMA auto_vacuum = INCREMENTAL");
      database.exec("VACUUM");
    } else if (i === KNOWLEDGE_META_MIGRATION_INDEX) {
      // Destructive (DROP COLUMN) + non-idempotent-as-SQL: run the column-aware
      // JS step so a partial apply can't boot-loop on re-run (see the fn doc).
      applyKnowledgeMetaRegister(database);
    } else if (i === SESSION_ROLLUP_MIGRATION_INDEX) {
      // Create session_rollup + maintenance triggers, then backfill from source.
      // Done in JS so the same idempotent routine self-heals from recovery (#981).
      applySessionRollup(database);
    } else if (i === REF_FK_DROP_MIGRATION_INDEX) {
      // Recreate the ref tables without their knowledge(id) FKs, atomically (SAVEPOINT)
      // so a crash mid-recreate rolls back instead of boot-looping the retry (#909).
      applyRefFkDrop(database);
    } else if (i === SCOPE_KEY_EPOCH_MIGRATION_INDEX) {
      // Recreate scope_keys with key_epoch in the PK, atomically (SAVEPOINT), idempotent
      // (skips if already migrated) so a partial apply can't boot-loop (#827 E-4c-3a).
      applyScopeKeyEpochPk(database);
    } else {
      try {
        database.exec(MIGRATIONS[i]);
      } catch (e: unknown) {
        // Multi-statement migrations can partially fail when an early
        // statement (e.g. ALTER TABLE ADD COLUMN) hits a duplicate-column
        // error from a prior partial run. Swallow duplicate-column errors
        // so the rest of the migration loop and the version bump proceed.
        // Any genuinely new error is re-thrown.
        if (e instanceof Error && /duplicate column name/i.test(e.message)) {
          // The ALTER TABLE already applied — run remaining statements in
          // this migration by stripping the offending ALTER and re-exec'ing.
          // (Important: migrate() in db.ts runs each migration via database.exec()
          // which stops at the first error in a multi-statement string.)
          const stripped = stripAppliedAlters(MIGRATIONS[i], database);
          if (stripped.trim()) database.exec(stripped);
        } else {
          throw e;
        }
      }
    }
  }
  // Update version to latest. Migration 0 inserts version=1 via its own INSERT,
  // but subsequent migrations don't update it, so always normalize to MIGRATIONS.length.
  database.exec(`UPDATE schema_version SET version = ${MIGRATIONS.length}`);

  // Also run recovery for existing DBs that are already at the latest version
  // but have holes from past partial runs.
  recoverMissingObjects(database);
}

/**
 * Strip ALTER TABLE ADD COLUMN statements for columns that already exist.
 * Returns the migration string with those statements removed.
 */
function stripAppliedAlters(migration: string, database: Database): string {
  return migration.replace(
    /ALTER\s+TABLE\s+(\w+)\s+ADD\s+COLUMN\s+(\w+)\b[^;]*;/gi,
    (match, table, column) => {
      const cols = database
        .query(`PRAGMA table_info(${table})`)
        .all() as Array<{ name: string }>;
      if (cols.some((c) => c.name === column)) return ""; // already exists
      return match; // keep — this ALTER hasn't been applied
    },
  );
}

/**
 * Idempotent recovery for objects that may be missing due to multi-statement
 * migration partial failures (e.g. ALTER TABLE throws duplicate-column,
 * aborting the exec before a subsequent CREATE TABLE in the same string).
 */
function recoverMissingObjects(database: Database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS kv_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS project_path_aliases (
      path TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS entities (
      id             TEXT PRIMARY KEY,
      project_id     TEXT,
      entity_type    TEXT NOT NULL,
      canonical_name TEXT NOT NULL,
      metadata       TEXT,
      cross_project  INTEGER DEFAULT 0,
      created_at     INTEGER NOT NULL,
      updated_at     INTEGER NOT NULL,
      embedding      BLOB,
      sync_rank      INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS entity_aliases (
      id          TEXT PRIMARY KEY,
      entity_id   TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      alias_type  TEXT NOT NULL,
      alias_value TEXT NOT NULL,
      source      TEXT,
      created_at  INTEGER NOT NULL,
      UNIQUE(alias_type, alias_value)
    );
    CREATE TABLE IF NOT EXISTS knowledge_entity_refs (
      -- knowledge_id has NO FK (v66, #909): compaction may prune the anchor version the
      -- logical_id points at; ref integrity is app-managed. entity_id keeps its CASCADE.
      knowledge_id TEXT NOT NULL,
      entity_id    TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      PRIMARY KEY (knowledge_id, entity_id)
    );
    CREATE TABLE IF NOT EXISTS entity_relations (
      id          TEXT PRIMARY KEY,
      entity_a    TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      entity_b    TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      relation    TEXT NOT NULL,
      metadata    TEXT,
      source      TEXT,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL,
      UNIQUE(entity_a, entity_b, relation)
    );
    CREATE TABLE IF NOT EXISTS team_knowledge (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      created_by TEXT,
      confidence REAL DEFAULT 1.0,
      sensitivity TEXT NOT NULL DEFAULT 'normal',
      source_user_id TEXT,
      synced_at INTEGER NOT NULL,
      metadata TEXT
    );
    CREATE TABLE IF NOT EXISTS team_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS daily_costs (
      day        TEXT NOT NULL,
      bucket     TEXT NOT NULL,
      cost       REAL NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (day, bucket)
    );
    CREATE TABLE IF NOT EXISTS tool_calls (
      call_id       TEXT PRIMARY KEY,
      message_id    TEXT NOT NULL,
      project_id    TEXT NOT NULL,
      session_id    TEXT NOT NULL,
      tool          TEXT NOT NULL,
      status        TEXT NOT NULL,
      error_type    TEXT,
      error_message TEXT,
      duration_ms   INTEGER,
      created_at    INTEGER NOT NULL,
      verifier      INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_tool_calls_project_tool_status
      ON tool_calls (project_id, tool, status);
    CREATE INDEX IF NOT EXISTS idx_tool_calls_project_session
      ON tool_calls (project_id, session_id);
    CREATE TABLE IF NOT EXISTS knowledge_session_injections (
      session_id  TEXT NOT NULL,
      logical_id  TEXT NOT NULL,
      project_id  TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      credited    INTEGER NOT NULL DEFAULT 0,
      verdict     TEXT,
      PRIMARY KEY (session_id, logical_id)
    );
    CREATE INDEX IF NOT EXISTS idx_ksi_session_uncredited
      ON knowledge_session_injections (session_id, credited);
    CREATE TABLE IF NOT EXISTS knowledge_ref_validity (
      logical_id TEXT PRIMARY KEY,
      broken     INTEGER NOT NULL DEFAULT 0,
      total      INTEGER NOT NULL DEFAULT 0,
      checked_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS knowledge_symbol_presence (
      logical_id      TEXT NOT NULL,
      symbol          TEXT NOT NULL,
      last_present_at INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (logical_id, symbol)
    );
    CREATE TABLE IF NOT EXISTS knowledge_ref_anchor (
      logical_id TEXT NOT NULL,
      kind       TEXT NOT NULL,
      anchor     TEXT NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (logical_id, kind, anchor)
    );
    CREATE TABLE IF NOT EXISTS knowledge_contradictions (
      logical_id_a TEXT NOT NULL,
      logical_id_b TEXT NOT NULL,
      project_id   TEXT,
      similarity   REAL NOT NULL DEFAULT 0,
      rationale    TEXT,
      status       TEXT NOT NULL DEFAULT 'open',
      detected_at  INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL,
      PRIMARY KEY (logical_id_a, logical_id_b)
    );
    CREATE INDEX IF NOT EXISTS idx_knowledge_contradictions_status
      ON knowledge_contradictions (status);
    CREATE TABLE IF NOT EXISTS knowledge_transfers (
      knowledge_id           TEXT NOT NULL,
      recalled_in_project_id TEXT NOT NULL,
      hit_count              INTEGER NOT NULL DEFAULT 0,
      first_recalled_at      INTEGER NOT NULL,
      last_recalled_at       INTEGER NOT NULL,
      PRIMARY KEY (knowledge_id, recalled_in_project_id)
    );
    CREATE INDEX IF NOT EXISTS idx_knowledge_transfers_recalled_in
      ON knowledge_transfers (recalled_in_project_id);
    CREATE TABLE IF NOT EXISTS knowledge_tombstones (
      id         TEXT PRIMARY KEY,
      project_id TEXT,
      deleted_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_knowledge_tombstones_project
      ON knowledge_tombstones (project_id);
    -- Sync change-tracking (v43). NOTE: the per-table outbox TRIGGERS are NOT
    -- recreated here (same limitation as the FTS triggers) — only the tables.
    -- A missing trigger means changes aren't captured until the next full
    -- reconcile, which the sync engine performs on enable.
    CREATE TABLE IF NOT EXISTS sync_outbox (
      seq        INTEGER PRIMARY KEY AUTOINCREMENT,
      table_name TEXT NOT NULL,
      row_id     TEXT NOT NULL,
      op         TEXT NOT NULL,
      changed_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sync_outbox_table_row
      ON sync_outbox (table_name, row_id, seq);
    CREATE INDEX IF NOT EXISTS idx_sync_outbox_table_seq
      ON sync_outbox (table_name, seq);
    CREATE TABLE IF NOT EXISTS sync_state (
      table_name        TEXT NOT NULL,
      row_id            TEXT NOT NULL,
      content_hash      TEXT,
      revision          INTEGER NOT NULL DEFAULT 0,
      remote_updated_at TEXT,
      PRIMARY KEY (table_name, row_id)
    );
    CREATE TABLE IF NOT EXISTS sync_conflicts (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      table_name    TEXT NOT NULL,
      row_id        TEXT NOT NULL,
      detected_at   INTEGER NOT NULL,
      resolution    TEXT,
      local_content TEXT
    );
  `);

  // Recover missing columns from partial migration runs.
  // Version 17 added call_type to distillations but the ALTER could have been
  // skipped if the version was bumped without the column being created.
  const cols = database
    .query("PRAGMA table_info(distillations)")
    .all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "call_type")) {
    database.exec("ALTER TABLE distillations ADD COLUMN call_type TEXT;");
  }
  // sync_conflicts.local_content was added to the CREATE TABLE definition AFTER
  // the first sync-engine release (#782) shipped the table without it. Because
  // both the migration and the CREATE above use IF NOT EXISTS, an early sync
  // adopter's table keeps the old 5-column shape forever — and recordConflict()'s
  // INSERT ... local_content then throws "no such column" on EVERY sync cycle,
  // escaping to the scheduler catch-all. There was no ALTER to add it, so recover
  // it here (same self-heal pattern as call_type above).
  const scCols = database
    .query("PRAGMA table_info(sync_conflicts)")
    .all() as Array<{ name: string }>;
  if (!scCols.some((c) => c.name === "local_content")) {
    database.exec("ALTER TABLE sync_conflicts ADD COLUMN local_content TEXT;");
  }
  // Version 35: worker source attribution. The first ALTER may have applied
  // while a sibling ALTER in the same migration was skipped; recover each
  // column independently. Also recover the composite indexes which are
  // unreachable after a partial ALTER failure (database.exec stops at the
  // first error in a multi-statement string, skipping subsequent CREATEs).
  for (const table of ["distillations", "knowledge"] as const) {
    const tcols = database.query(`PRAGMA table_info(${table})`).all() as Array<{
      name: string;
    }>;
    for (const col of ["worker_provider_id", "worker_model_id"]) {
      if (!tcols.some((c) => c.name === col)) {
        database.exec(`ALTER TABLE ${table} ADD COLUMN ${col} TEXT;`);
      }
    }
  }
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_distillation_worker
      ON distillations(worker_provider_id, worker_model_id);
    CREATE INDEX IF NOT EXISTS idx_knowledge_worker
      ON knowledge(worker_provider_id, worker_model_id);
  `);
  // Version 50: append-only knowledge scaffolding. Recover the version columns
  // independently (a partial multi-ALTER may apply only some), backfill
  // logical_id, then the indexes + the current-projection view (which depends on
  // those columns). FTS triggers follow the same "not recovered here" rule as the
  // other FTS triggers (restored by the v32/v50 migration or next full run).
  {
    const kcols = database
      .query("PRAGMA table_info(knowledge)")
      .all() as Array<{ name: string }>;
    const addCol = (col: string, ddl: string) => {
      if (!kcols.some((c) => c.name === col)) {
        database.exec(`ALTER TABLE knowledge ADD COLUMN ${ddl};`);
      }
    };
    addCol("logical_id", "logical_id TEXT");
    addCol("version", "version INTEGER NOT NULL DEFAULT 1");
    addCol("is_deleted", "is_deleted INTEGER NOT NULL DEFAULT 0");
    addCol("is_current", "is_current INTEGER NOT NULL DEFAULT 1");
    database.exec(
      "UPDATE knowledge SET logical_id = id WHERE logical_id IS NULL;",
    );
  }
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_knowledge_logical ON knowledge(logical_id, version);
    CREATE INDEX IF NOT EXISTS idx_knowledge_current ON knowledge(is_current);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_one_current
      ON knowledge(logical_id) WHERE is_current = 1;
    CREATE INDEX IF NOT EXISTS idx_knowledge_project_current
      ON knowledge(project_id) WHERE is_current = 1 AND is_deleted = 0;
  `);
  // Version 55: knowledge_meta metric register + JOIN view (A2 sub-PR 3b). Shares
  // the SAME column-presence-aware, idempotent routine the forward migration uses,
  // so a fully-migrated DB self-heals a missing register/view and a partial apply
  // is finished here too.
  applyKnowledgeMetaRegister(database);
  // Version 56: costs-page metadata-scan index. Self-heal a fully-migrated DB
  // that spontaneously lost it (re-creation is a no-op when present). Missing it
  // is latency-only, but recovering it keeps parity with the sibling index blocks.
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_temporal_role_session_created
      ON temporal_messages(role, session_id, created_at);
  `);
  // Version 58: covering indexes for the costs-page token-sum and recent-session
  // aggregates. Self-heal a fully-migrated DB that lost one (re-creation is a
  // no-op when present). The redundant narrow predecessors are intentionally NOT
  // recreated here — leaving them absent matches the migrated end-state.
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_temporal_session_created_tokens
      ON temporal_messages(session_id, created_at, tokens);
    CREATE INDEX IF NOT EXISTS idx_temporal_project_session_created
      ON temporal_messages(project_id, session_id, created_at);
  `);
  // Version 60: session_rollup table + maintenance triggers. Recreate them if a
  // fully-migrated DB lost them (no-op when present). If the table came back empty
  // while the source still has rows, the backfill was lost too — rebuild it once.
  // (A genuinely empty DB skips the rebuild: no source rows ⇒ nothing to do.)
  ensureSessionRollup(database);
  {
    const hasRollup = database
      .query("SELECT 1 FROM session_rollup LIMIT 1")
      .get() as unknown;
    if (!hasRollup) {
      const hasMessages = database
        .query("SELECT 1 FROM temporal_messages LIMIT 1")
        .get() as unknown;
      const hasDistill = database
        .query("SELECT 1 FROM distillations LIMIT 1")
        .get() as unknown;
      if (hasMessages || hasDistill) rebuildAllSessionRollups(database);
    }
  }
  // Version 63: knowledge_meta CRDT register (A2 sub-PR 3b-2). Recover the
  // base_confidence column (backfilled from the materialized confidence) and the
  // grow-only counter table independently of the forward migration.
  {
    const mcols = database
      .query("PRAGMA table_info(knowledge_meta)")
      .all() as Array<{ name: string }>;
    if (!mcols.some((c) => c.name === "base_confidence")) {
      database.exec(
        "ALTER TABLE knowledge_meta ADD COLUMN base_confidence REAL NOT NULL DEFAULT 1.0;",
      );
      database.exec("UPDATE knowledge_meta SET base_confidence = confidence;");
    }
    database.exec(`CREATE TABLE IF NOT EXISTS knowledge_meta_crdt (
      logical_id  TEXT NOT NULL,
      replica_id  TEXT NOT NULL,
      pos         REAL NOT NULL DEFAULT 0,
      neg         REAL NOT NULL DEFAULT 0,
      updated_at  INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (logical_id, replica_id)
    );`);
  }

  // Version 64: encryption key store (C-2, #825). All three tables are plain
  // CREATE IF NOT EXISTS, so recovery is a straight re-create of any that a partial
  // apply left missing.
  database.exec(`CREATE TABLE IF NOT EXISTS account_identity (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    public_key BLOB NOT NULL, secret_key BLOB NOT NULL, created_at INTEGER NOT NULL
  );`);
  database.exec(`CREATE TABLE IF NOT EXISTS account_escrow (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    wrapped_secret BLOB NOT NULL, kdf_salt BLOB NOT NULL,
    kdf_t INTEGER NOT NULL, kdf_m INTEGER NOT NULL, kdf_p INTEGER NOT NULL,
    recovery_wrapped BLOB, recovery_salt BLOB,
    recovery_kdf_t INTEGER, recovery_kdf_m INTEGER, recovery_kdf_p INTEGER,
    key_epoch INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL DEFAULT 0
  );`);
  database.exec(`CREATE TABLE IF NOT EXISTS scope_keys (
    scope_id TEXT NOT NULL, member_user_id TEXT NOT NULL,
    wrapped_dek BLOB NOT NULL, key_epoch INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (scope_id, member_user_id, key_epoch)
  );`);
  // Version 70 (#827 E-5): org/scope registry pull-only mirrors.
  database.exec(`CREATE TABLE IF NOT EXISTS orgs (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'team', owner_user_id TEXT,
    tier TEXT NOT NULL DEFAULT 'free', name TEXT, created_at INTEGER, updated_at INTEGER
  );`);
  database.exec(`CREATE TABLE IF NOT EXISTS org_members (
    org_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member',
    created_at INTEGER, updated_at INTEGER, PRIMARY KEY (org_id, user_id)
  );`);
  database.exec(`CREATE TABLE IF NOT EXISTS scopes (
    id TEXT PRIMARY KEY, org_id TEXT, kind TEXT NOT NULL, name TEXT,
    created_at INTEGER, updated_at INTEGER
  );`);
  database.exec(`CREATE TABLE IF NOT EXISTS scope_members (
    scope_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'editor',
    created_at INTEGER, updated_at INTEGER, PRIMARY KEY (scope_id, user_id)
  );`);
  database.exec(
    "CREATE INDEX IF NOT EXISTS idx_scope_members_user ON scope_members(user_id);",
  );
  database.exec(
    "CREATE INDEX IF NOT EXISTS idx_org_members_user ON org_members(user_id);",
  );

  // Version 36: session project binding. Recover each column independently in
  // case a partial ALTER (e.g. the first succeeded, the second was skipped on a
  // prior failure) left the table missing a column.
  {
    const scols = database
      .query("PRAGMA table_info(session_state)")
      .all() as Array<{ name: string }>;
    if (!scols.some((c) => c.name === "project_path")) {
      database.exec("ALTER TABLE session_state ADD COLUMN project_path TEXT;");
    }
    if (!scols.some((c) => c.name === "project_path_provisional")) {
      database.exec(
        "ALTER TABLE session_state ADD COLUMN project_path_provisional INTEGER NOT NULL DEFAULT 1;",
      );
    }
    // Version 39: reorder-tolerant LTM diff-pin entry-set keys.
    if (!scols.some((c) => c.name === "ltm_pin_keys")) {
      database.exec("ALTER TABLE session_state ADD COLUMN ltm_pin_keys TEXT;");
    }
    // Version 41: cross-turn dedup decisions.
    if (!scols.some((c) => c.name === "dedup_decisions")) {
      database.exec(
        "ALTER TABLE session_state ADD COLUMN dedup_decisions TEXT;",
      );
    }
    // Version 44: persisted last-known message count for restart-proof calibration.
    if (!scols.some((c) => c.name === "last_known_message_count")) {
      database.exec(
        "ALTER TABLE session_state ADD COLUMN last_known_message_count INTEGER NOT NULL DEFAULT 0;",
      );
    }
  }
  // Version 53: tool_calls.verifier (outcome-reward, #497). Recover the column
  // independently — the CREATE TABLE IF NOT EXISTS above is a no-op on an
  // existing tool_calls table and cannot add a missing column to it.
  {
    const tcols = database
      .query("PRAGMA table_info(tool_calls)")
      .all() as Array<{ name: string }>;
    if (!tcols.some((c) => c.name === "verifier")) {
      database.exec("ALTER TABLE tool_calls ADD COLUMN verifier INTEGER;");
    }
    // Version 75: tool_calls.input_path (file provenance, #627 Step 1 / D2c).
    // Same recovery rationale as verifier — CREATE TABLE IF NOT EXISTS cannot
    // add a missing column to a pre-existing table.
    if (!tcols.some((c) => c.name === "input_path")) {
      database.exec("ALTER TABLE tool_calls ADD COLUMN input_path TEXT;");
    }
  }
  // Version 54: knowledge_session_injections.verdict (outcome impact, #497).
  // The verdict-keyed index MUST be created here, AFTER the column is ensured —
  // never in the big exec above, which runs before this ALTER and would throw
  // `no such column: verdict` while recovering a pre-v54 (verdict-less) table.
  {
    const icols = database
      .query("PRAGMA table_info(knowledge_session_injections)")
      .all() as Array<{ name: string }>;
    if (icols.length) {
      if (!icols.some((c) => c.name === "verdict")) {
        database.exec(
          "ALTER TABLE knowledge_session_injections ADD COLUMN verdict TEXT;",
        );
      }
      database.exec(
        "CREATE INDEX IF NOT EXISTS idx_ksi_logical_verdict ON knowledge_session_injections (logical_id, verdict);",
      );
    }
  }
  // Version 56: projects.last_refcheck_at (reference-validity rate gate, #627).
  {
    const pcols = database.query("PRAGMA table_info(projects)").all() as Array<{
      name: string;
    }>;
    if (pcols.length && !pcols.some((c) => c.name === "last_refcheck_at")) {
      database.exec(
        "ALTER TABLE projects ADD COLUMN last_refcheck_at INTEGER;",
      );
    }
    // Version 71: scope selection & team-promotion policy (E-5-F3, #827).
    if (pcols.length && !pcols.some((c) => c.name === "scope_id")) {
      database.exec("ALTER TABLE projects ADD COLUMN scope_id TEXT;");
    }
    if (pcols.length && !pcols.some((c) => c.name === "promotion_policy")) {
      database.exec("ALTER TABLE projects ADD COLUMN promotion_policy TEXT;");
    }
  }
  {
    const scols = database.query("PRAGMA table_info(scopes)").all() as Array<{
      name: string;
    }>;
    if (scols.length && !scols.some((c) => c.name === "promotion_policy")) {
      database.exec("ALTER TABLE scopes ADD COLUMN promotion_policy TEXT;");
    }
  }
  {
    // Version 72: sync_state.scope_id (E-5-F3-3, #827).
    const sscols = database
      .query("PRAGMA table_info(sync_state)")
      .all() as Array<{ name: string }>;
    if (sscols.length && !sscols.some((c) => c.name === "scope_id")) {
      database.exec("ALTER TABLE sync_state ADD COLUMN scope_id TEXT;");
    }
  }
}

/**
 * Merge all data from `sourceId` project into `targetId` project.
 *
 * Moves knowledge, temporal messages, distillations, LAT sections, and
 * path aliases from source to target. Registers the source project's path
 * as an alias of the target. Deletes the source project row.
 *
 * Used internally during lazy git-remote backfill when two path-only
 * projects are discovered to share the same git remote.
 */
/**
 * Deterministically converge projects that share a git_remote (#1246). Two devices can
 * independently mint a random project_id for the same repo; after they sync each other's
 * projects mapping, both hold >1 local project for that remote. Merge all into the
 * lexicographically-smallest id — a winner both devices agree on, so there is NO re-key
 * ping-pong (a non-deterministic "local wins" would make the two devices merge in
 * opposite directions forever). mergeProjectInternal re-keys the content + re-enqueues it
 * under the winner. MUST run AFTER a pull (post-content, so the re-key finds the applied
 * rows) and OUTSIDE any transaction (mergeProjectInternal opens its own BEGIN IMMEDIATE).
 */
export function convergeProjectsByRemote(): void {
  const dupes = db()
    .query(
      "SELECT git_remote FROM projects WHERE git_remote IS NOT NULL GROUP BY git_remote HAVING COUNT(*) > 1",
    )
    .all() as { git_remote: string }[];
  for (const { git_remote } of dupes) {
    const ids = (
      db()
        .query("SELECT id FROM projects WHERE git_remote = ? ORDER BY id")
        .all(git_remote) as { id: string }[]
    ).map((r) => r.id);
    const winner = ids[0]; // lexicographically smallest — identical on every device
    for (const loser of ids.slice(1)) mergeProjectInternal(loser, winner);
  }
}

export function mergeProjectInternal(sourceId: string, targetId: string): void {
  const d = db();
  d.exec("BEGIN IMMEDIATE");
  try {
    d.query("UPDATE knowledge SET project_id = ? WHERE project_id = ?").run(
      targetId,
      sourceId,
    );
    d.query(
      "UPDATE temporal_messages SET project_id = ? WHERE project_id = ?",
    ).run(targetId, sourceId);
    d.query("UPDATE distillations SET project_id = ? WHERE project_id = ?").run(
      targetId,
      sourceId,
    );
    // vec0: re-point temporal_vec/distillation_vec off the source partition (vec0
    // forbids UPDATE of a partition key, so DELETE+reINSERT). Whole-project merge
    // ⇒ no session filter. Inside the transaction so a failure rolls the merge
    // back; no-op in blob mode. (knowledge_vec/entity_vec have no partition key.)
    repartitionVec0Project(d, sourceId, targetId);
    // Re-point the session rollup set-based: the temporal/distillation project_id
    // UPDATEs above do NOT fire the rollup triggers (scoped to content/tokens/
    // metadata + insert/delete), so move the rows here. session_id is globally
    // unique ⇒ no (target, session_id) PK collision.
    d.query(
      "UPDATE session_rollup SET project_id = ? WHERE project_id = ?",
    ).run(targetId, sourceId);
    d.query("UPDATE lat_sections SET project_id = ? WHERE project_id = ?").run(
      targetId,
      sourceId,
    );
    d.query("UPDATE entities SET project_id = ? WHERE project_id = ?").run(
      targetId,
      sourceId,
    );
    d.query("UPDATE tool_calls SET project_id = ? WHERE project_id = ?").run(
      targetId,
      sourceId,
    );
    // Outcome-reward injection log (#497): carries a project_id that must follow
    // the entries to the target, or its rows orphan once the source project row
    // is deleted below AND crediting breaks (creditSessionOutcome queries by the
    // session's current project). A plain UPDATE is safe — the PK is
    // (session_id, logical_id), so re-pointing project_id can't conflict. (#996)
    d.query(
      "UPDATE knowledge_session_injections SET project_id = ? WHERE project_id = ?",
    ).run(targetId, sourceId);
    // knowledge_transfers: re-point the "recalled in" foreign project. A plain
    // UPDATE would violate the composite PK when a (knowledge_id, targetId) row
    // already exists, so merge the counts via UPSERT then delete the leftover
    // source rows. The knowledge_id side needs no update — entries keep their
    // UUID when their origin project merges.
    d.query(
      `INSERT INTO knowledge_transfers
         (knowledge_id, recalled_in_project_id, hit_count, first_recalled_at, last_recalled_at)
       SELECT knowledge_id, ?, hit_count, first_recalled_at, last_recalled_at
         FROM knowledge_transfers WHERE recalled_in_project_id = ?
       ON CONFLICT(knowledge_id, recalled_in_project_id) DO UPDATE SET
         hit_count = hit_count + excluded.hit_count,
         first_recalled_at = MIN(first_recalled_at, excluded.first_recalled_at),
         last_recalled_at = MAX(last_recalled_at, excluded.last_recalled_at)`,
    ).run(targetId, sourceId);
    d.query(
      "DELETE FROM knowledge_transfers WHERE recalled_in_project_id = ?",
    ).run(sourceId);
    // Drop rows that became self-referential (origin == recalled-in) after the
    // merge: an entry whose origin was the source project, recalled in target.
    d.query(
      `DELETE FROM knowledge_transfers
        WHERE recalled_in_project_id = ?
          AND knowledge_id IN (SELECT logical_id FROM knowledge WHERE project_id = ?)`,
    ).run(targetId, targetId);
    // entity_relations references entities by FK — no project_id column to update.
    // Relations move implicitly when their parent entities move.
    d.query(
      "UPDATE OR IGNORE project_path_aliases SET project_id = ? WHERE project_id = ?",
    ).run(targetId, sourceId);
    // Register source's path as alias of target
    const sourceRow = d
      .query("SELECT path FROM projects WHERE id = ?")
      .get(sourceId) as { path: string } | null;
    if (sourceRow) {
      d.query(
        "INSERT OR IGNORE INTO project_path_aliases (path, project_id) VALUES (?, ?)",
      ).run(sourceRow.path, targetId);
    }
    d.query("DELETE FROM projects WHERE id = ?").run(sourceId);
    d.exec("COMMIT");
    fireProjectMutation();
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  }
}

export function close() {
  if (instance) {
    // Reclaim the WAL on a graceful shutdown so the next open doesn't inherit a
    // huge WAL to recover/checkpoint (#1221). Best-effort — we're closing anyway.
    // busy_timeout=0 first so a reader mid-query can't make this busy-wait (~5s)
    // and hang close(); an un-truncated WAL is simply recovered on next open.
    try {
      instance.exec("PRAGMA busy_timeout = 0");
      instance.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      // ignore — a busy checkpoint or driver quirk must not block close()
    }
    instance.close();
    instance = undefined;
  }
  // The sqlite-vec extension is loaded per-connection; reset loader state so a
  // subsequent db() on a fresh connection re-attempts the load. This also clears
  // the sticky vec0 storage-mode latch (a fresh connection may point at a
  // different DB file whose layout must be re-evaluated from scratch).
  resetVecState();
}

/** Write-lock retry window for the writer connection (SQLITE_BUSY handling). */
const BUSY_TIMEOUT_MS = 5000;

/** Cap the on-disk WAL is truncated back to after a resetting checkpoint (#1221). */
const WAL_JOURNAL_SIZE_LIMIT_BYTES = 64 * 1024 * 1024; // 64 MiB

/** Bytes of the `-wal` sidecar (0 if absent / :memory:). Cheap stat for #1221 telemetry. */
export function walSizeBytes(): number {
  try {
    return statSync(`${dbPath()}-wal`).size;
  } catch {
    return 0;
  }
}

/**
 * Reclaim the WAL with a TRUNCATE checkpoint on the writer connection (#1221).
 * SQLite's PASSIVE auto-checkpoint is starved by the persistent reader-pool
 * connections — each recall query holds a WAL read-mark, so the checkpoint can
 * never obtain the "no reader below the mark" instant needed to reset the log and
 * the WAL grows unbounded. TRUNCATE resets AND shrinks the file to zero when run
 * in a quiet window (no reader pinning an older snapshot); when a reader is
 * mid-query it checkpoints what it can and returns `busy` (a harmless no-op we
 * retry on the next idle tick). It never blocks indefinitely.
 */
export function checkpointWal(): { busy: boolean; reclaimedBytes: number } {
  // NOTE: for TRUNCATE mode the `log`/`checkpointed` result columns report the
  // POST-truncation state (0/0) even on success — they can't tell you how much was
  // reclaimed. Only `busy` is reliable there. So we measure the actual reclaim by
  // the -wal file-size delta instead.
  const conn = db();
  const before = walSizeBytes();
  // Drop the write-lock retry to 0 around the checkpoint: this runs synchronously on
  // the gateway event loop, and a TRUNCATE blocked by a reader's read-mark would
  // otherwise busy-wait the whole BUSY_TIMEOUT_MS (~5s stall) — precisely under the
  // sustained-reader load that starves the WAL and makes this fire. With timeout 0 it
  // returns `busy` in ~1ms when it can't reset, and still fully truncates in a quiet
  // window. Restore the retry window afterward.
  conn.exec("PRAGMA busy_timeout = 0");
  let row: { busy: number } | undefined;
  try {
    row = conn.query("PRAGMA wal_checkpoint(TRUNCATE)").get() as
      | { busy: number }
      | undefined;
  } finally {
    conn.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  }
  const after = walSizeBytes();
  return {
    busy: (row?.busy ?? 0) === 1,
    reclaimedBytes: Math.max(0, before - after),
  };
}

/** Bytes of the main DB file (0 if absent / :memory:). */
export function dbFileSizeBytes(): number {
  try {
    return statSync(dbPath()).size;
  } catch {
    return 0;
  }
}

/** Reclaimable free space right now: `freelist_count × page_size`. */
export function freelistBytes(): number {
  const fc = db().query("PRAGMA freelist_count").get() as
    | { freelist_count: number }
    | undefined;
  const ps = db().query("PRAGMA page_size").get() as
    | { page_size: number }
    | undefined;
  return (fc?.freelist_count ?? 0) * (ps?.page_size ?? 0);
}

/**
 * Full VACUUM: rewrites the whole DB, reclaiming ALL free pages AND applying the
 * current `auto_vacuum` mode — so a legacy DB created with `auto_vacuum=NONE`
 * (freed pages never returned to the OS → #1221 main-file bloat) is converted to
 * INCREMENTAL, after which the idle incremental-vacuum can keep it bounded. Heavy:
 * takes an exclusive lock and needs ~2× the DB size in transient disk. Returns the
 * file size before/after. Followed by a resetting WAL checkpoint so the VACUUM's
 * churn doesn't linger in the -wal.
 */
export function vacuum(opts?: { noWait?: boolean }): {
  beforeBytes: number;
  afterBytes: number;
} {
  const conn = db();
  const beforeBytes = dbFileSizeBytes();
  // The mode-converting VACUUM needs a near-exclusive moment; a reader pinning a WAL
  // snapshot would otherwise make it busy-wait the whole BUSY_TIMEOUT_MS (~5s stall).
  // `noWait` (used by the idle auto-reclaim, which runs on the event loop) drops the
  // retry to 0 so it fails fast instead of stalling — the caller retries later. The
  // explicit `lore data vacuum` command omits it so it waits for the lock as expected.
  // Register the desired auto_vacuum mode so the following VACUUM bakes it into the
  // header: this converts a legacy auto_vacuum=NONE DB to INCREMENTAL (the whole point
  // for #1221). Explicit here — not relying on the open-time pragma — so the idle
  // small-DB convert reliably flips the mode and never re-VACUUMs on the next tick.
  // Mirrors the migrate() conversion path. No-op when already INCREMENTAL.
  conn.exec("PRAGMA auto_vacuum = INCREMENTAL");
  if (opts?.noWait) conn.exec("PRAGMA busy_timeout = 0");
  try {
    conn.exec("VACUUM");
  } finally {
    if (opts?.noWait) conn.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  }
  checkpointWal();
  return { beforeBytes, afterBytes: dbFileSizeBytes() };
}

/** `PRAGMA auto_vacuum` mode: 0=NONE, 1=FULL, 2=INCREMENTAL. */
export function autoVacuumMode(): number {
  const r = db().query("PRAGMA auto_vacuum").get() as
    | { auto_vacuum: number }
    | undefined;
  return r?.auto_vacuum ?? 0;
}

/**
 * Reclaim up to `pages` freelist pages via `PRAGMA incremental_vacuum` — the cheap,
 * ongoing counterpart to a full VACUUM (only works when auto_vacuum=INCREMENTAL).
 * Runs on the writer connection; like checkpointWal it drops busy_timeout to 0 so a
 * concurrent write can't make it stall the caller (returns having done what it could).
 * The truncation lands in the WAL — the next checkpoint flushes it to the main file.
 * Reclaim is measured by the freelist delta (the file only physically shrinks after
 * that checkpoint). Returns bytes removed from the freelist.
 */
export function incrementalVacuum(pages: number): { reclaimedBytes: number } {
  const conn = db();
  const before = freelistBytes();
  conn.exec("PRAGMA busy_timeout = 0");
  try {
    conn.exec(`PRAGMA incremental_vacuum(${pages})`);
  } finally {
    conn.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  }
  return { reclaimedBytes: Math.max(0, before - freelistBytes()) };
}

// ---------------------------------------------------------------------------
// Centralized query helpers
//
// Small, runtime-agnostic helpers that remove duplicated inline SQL. They use
// the local `db()` accessor (no handle passing — matches lore convention) and
// therefore live here, in the DB module, rather than a separate file (a
// separate file would create a `db.ts ↔ helpers` import cycle since the KV
// setters below call `runUpsert`).
// ---------------------------------------------------------------------------

/**
 * Build and run an `INSERT ... ON CONFLICT(...) DO UPDATE` upsert from a plain
 * row object. Centralizes the hand-written upsert SQL duplicated across the KV
 * stores and other call sites.
 *
 * @param table - Target table name (must be a trusted constant — interpolated).
 * @param row - Column→value map to insert. Keys are interpolated as column
 *   names, so they must be trusted constants, never user input.
 * @param conflictColumns - Columns forming the conflict target (PK/unique).
 * @param opts.excludeFromUpdate - Columns to set only on INSERT and leave
 *   untouched on UPDATE (e.g. `created_at`).
 *
 * When every column is part of the conflict target there is nothing to update,
 * so the statement degrades to `ON CONFLICT(...) DO NOTHING` (idempotent).
 */
export function runUpsert(
  table: string,
  row: Record<string, unknown>,
  conflictColumns: string[],
  opts: { excludeFromUpdate?: string[] } = {},
): void {
  const columns = Object.keys(row);
  if (columns.length === 0) {
    throw new Error(`runUpsert: no columns provided for table "${table}"`);
  }
  const values = columns.map((c) => row[c]);
  const placeholders = columns.map(() => "?").join(", ");

  const conflict = new Set(conflictColumns);
  const exclude = new Set(opts.excludeFromUpdate ?? []);
  const updatable = columns.filter((c) => !conflict.has(c) && !exclude.has(c));

  const conflictClause = conflictColumns.join(", ");
  const action =
    updatable.length === 0
      ? "DO NOTHING"
      : `DO UPDATE SET ${updatable.map((c) => `${c} = excluded.${c}`).join(", ")}`;

  const sql = `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders}) ON CONFLICT(${conflictClause}) ${action}`;
  db()
    .query(sql)
    .run(...values);
}

/**
 * Run `fn` inside a `BEGIN IMMEDIATE` transaction, committing on success and
 * rolling back (then re-throwing) on error. Returns the callback's value.
 *
 * Uses manual `exec()` rather than the driver's `.transaction()` because
 * `bun:sqlite` and `node:sqlite` expose incompatible transaction APIs (see the
 * note in distillation.ts). `BEGIN IMMEDIATE` acquires the write lock up front
 * to avoid lock-upgrade deadlocks under concurrent access.
 */
export function withTransaction<T>(fn: () => T): T {
  const d = db();
  d.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    d.exec("COMMIT");
    return result;
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  }
}

/**
 * Run `fn` inside a named SAVEPOINT, releasing it on success and (on error)
 * rolling back to then releasing it before re-throwing. Returns the callback's
 * value.
 *
 * Unlike {@link withTransaction} (`BEGIN IMMEDIATE`, which throws if a
 * transaction is already open), a SAVEPOINT is safe whether called at top level
 * OR nested inside an existing transaction — SQLite permits nested savepoints
 * but not nested `BEGIN`s. At top level the first SAVEPOINT implicitly opens a
 * transaction, so this is also atomic when called standalone. Use this for a
 * write unit that may, now or in a future refactor, run inside an outer
 * transaction (see `rebuildDirtySessionRollups`/`rebuildAllSessionRollups`).
 *
 * `name` must be a bare SQL identifier (it is interpolated into the statement,
 * never a bind parameter); a non-identifier is rejected to prevent injection.
 */
export function withSavepoint<T>(name: string, fn: () => T): T {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(
      `withSavepoint: invalid savepoint name ${JSON.stringify(name)}`,
    );
  }
  const d = db();
  d.exec(`SAVEPOINT ${name}`);
  try {
    const result = fn();
    d.exec(`RELEASE ${name}`);
    return result;
  } catch (e) {
    d.exec(`ROLLBACK TO ${name}`);
    d.exec(`RELEASE ${name}`);
    throw e;
  }
}

// Project management

/**
 * Path prefix for synthetic "unattributed" project buckets. Created when a
 * remote/central gateway can't determine a confident project path for a
 * request (no `X-Lore-Project` header, no inferable path in the system
 * prompt). Each such session gets its own bucket
 * (`/__lore_unattributed__/<sessionID>`) so unrelated sessions are never
 * merged onto the gateway's own cwd. Buckets self-heal (when a confident path
 * later arrives) or can be consolidated. Defined here (in core) so both the
 * gateway and DB-layer naming agree on the canonical prefix.
 */
export const UNATTRIBUTED_PROJECT_PREFIX = "/__lore_unattributed__";

/** True when a project path is a synthetic unattributed bucket. */
export function isUnattributedProjectPath(path: string): boolean {
  return (
    path === UNATTRIBUTED_PROJECT_PREFIX ||
    path.startsWith(`${UNATTRIBUTED_PROJECT_PREFIX}/`)
  );
}

/**
 * Reconcile a client-supplied git remote against on-disk truth.
 *
 * The `x-lore-git-remote` header is only trustworthy when it AGREES with what
 * the path actually is on disk. The "git-remote magnet" bug arose because a
 * non-repo parent directory (e.g. `/home/byk/Code`, where a user keeps loose
 * scripts) accepted a remote leaked from a sibling worktree's stale plugin
 * global — becoming a bucket that swallowed every project later sending that
 * same remote (via the alias/merge paths below).
 *
 * Rules:
 *  - disk has a remote               → ALWAYS use disk's remote (a client
 *                                       header can never override on-disk truth)
 *  - disk has NO remote, LOCAL mode  → DROP the client remote (the path is not
 *                                       a git repo; attaching a remote to it is
 *                                       what creates the magnet)
 *  - disk has NO remote, HOSTED mode → trust the client remote (the gateway
 *                                       cannot read the client's disk, so the
 *                                       header is the only signal — unchanged
 *                                       legacy behavior)
 *
 * `getGitRemote()` is per-path cached and already returns null in hosted mode,
 * so this adds at most one cached subprocess call.
 */
function resolveTrustedRemote(
  path: string,
  supplied?: string | null,
): string | null {
  const disk = getGitRemote(path); // null in hosted mode OR when not a repo
  if (disk) return disk;
  if (isHostedMode()) return supplied ?? null;
  return null;
}

/**
 * Look up or create a project by filesystem path, with git-remote awareness.
 *
 * Resolution order:
 *  1. Exact path match in `projects` table (fast path, O(1) index scan)
 *  2. Path alias match in `project_path_aliases` (worktree/clone re-visits)
 *  3. Git remote match — runs `git remote -v` (once per unique path, cached),
 *     finds an existing project with the same normalized remote URL
 *  4. Create a new project row
 *
 * When a git-remote match is found (step 3), the new path is registered as
 * an alias so subsequent calls skip the subprocess. If the matched project's
 * git_remote was not yet populated (pre-v14 rows), it is backfilled lazily.
 *
 * A client-supplied git remote (`suppliedGitRemote`, from the
 * `x-lore-git-remote` header) is reconciled against on-disk truth by
 * `resolveTrustedRemote()` — it is never attached to a path that is not a git
 * repository on a local gateway (prevents the "git-remote magnet" bug).
 */
export function ensureProject(
  path: string,
  name?: string,
  suppliedGitRemote?: string | null,
): string {
  // Guard: reject synthetic test paths when targeting the production DB.
  // Test paths like "/test/ltm/project" are absolute paths that don't exist
  // on any real filesystem — they're only valid in test suites running against
  // a temp DB (LORE_DB_PATH set by test preload). If we see such a path
  // without LORE_DB_PATH being set, a test is likely hitting the production DB.
  // Note: LORE_DB_PATH unset is used as a proxy for "production DB". This
  // wouldn't catch the unlikely case of someone explicitly setting LORE_DB_PATH
  // to the default production path, but that's not a realistic scenario.
  if (!process.env.LORE_DB_PATH && path.startsWith("/test/")) {
    throw new Error(
      `Refusing to create project with test path "${path}" in the production DB. ` +
        `Set LORE_DB_PATH to a temp path, or run tests via \`bun test\` from the repo root.`,
    );
  }

  // 0. Memoized fast path — the same session path is resolved many times per
  // request (see projectIdByPathCache docs / LOREAI-GATEWAY-3K).
  const cache = projectIdCacheFor(db());
  const cached = cache.get(path);
  if (cached !== undefined) return cached;

  // 1. Exact path match (fast path)
  const existing = db()
    .query("SELECT id, git_remote FROM projects WHERE path = ?")
    .get(path) as { id: string; git_remote: string | null } | null;
  if (existing) {
    // Lazy backfill: populate git_remote on pre-v14 rows. NOTE: this branch is
    // intentionally left UNCACHED — git_remote is still NULL, so backfill must
    // keep retrying on subsequent calls until it settles (at which point the
    // `existing.git_remote` branch below caches the stable mapping).
    if (!existing.git_remote) {
      const resolvedRemote = resolveTrustedRemote(path, suppliedGitRemote);
      if (resolvedRemote) {
        // Check for conflict: another project already has this git_remote.
        // If so, merge the conflicting project into this one (one-time).
        const conflict = db()
          .query(
            "SELECT id FROM projects WHERE git_remote = ? AND id != ? LIMIT 1",
          )
          .get(resolvedRemote, existing.id) as { id: string } | null;
        if (conflict) {
          mergeProjectInternal(conflict.id, existing.id);
        }
        db()
          .query("UPDATE projects SET git_remote = ? WHERE id = ?")
          .run(resolvedRemote, existing.id);
        // #1246 (P2): the project just became remote-backed — re-seed the content that
        // was gated out while it was remote-less (else it never gets backed up).
        fireProjectRemoteBackfilled(existing.id);
        // git_remote is now settled and existing.id survived any conflict merge
        // above (it is the merge TARGET) — memoize so the next call for this
        // path skips the exact-path lookup. fireProjectRemoteBackfilled cleared
        // the map, so this set must come AFTER it.
        cache.set(path, existing.id);
        return existing.id;
      }
      // Still remote-less (no remote resolved) — leave uncached so a later call
      // with an on-disk/supplied remote can still lazily backfill.
      return existing.id;
    }
    // Settled remote-backed row — stable mapping, safe to memoize.
    cache.set(path, existing.id);
    return existing.id;
  }

  // 2. Check path aliases (worktree/clone re-visits) — the hot 3K path.
  const alias = db()
    .query("SELECT project_id FROM project_path_aliases WHERE path = ?")
    .get(path) as { project_id: string } | null;
  if (alias) {
    cache.set(path, alias.project_id);
    return alias.project_id;
  }

  // 3. Git remote identification
  const gitRemote = resolveTrustedRemote(path, suppliedGitRemote);
  if (gitRemote) {
    const byRemote = db()
      .query("SELECT id FROM projects WHERE git_remote = ? LIMIT 1")
      .get(gitRemote) as { id: string } | null;
    if (byRemote) {
      // Register this path as an alias for O(1) future lookups
      db()
        .query(
          "INSERT OR IGNORE INTO project_path_aliases (path, project_id) VALUES (?, ?)",
        )
        .run(path, byRemote.id);
      cache.set(path, byRemote.id);
      return byRemote.id;
    }
  }

  // 4. Create new project
  const id = crypto.randomUUID();
  // Synthetic unattributed buckets get a clearly-marked provisional name so the
  // dashboard never shows a bare session ID as if it were a real repo.
  const derivedName = isUnattributedProjectPath(path)
    ? `(unattributed) ${(path.split("/").pop() ?? "").slice(0, 12)}`
    : (name ??
      repoNameFromRemote(gitRemote) ??
      path.split("/").pop() ??
      "unknown");
  db()
    .query(
      "INSERT INTO projects (id, path, name, git_remote, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(id, path, derivedName, gitRemote, Date.now());
  // fireProjectMutation() clears the memo (same map ref); populate AFTER it so
  // the just-created mapping survives. Only memoize when the new project is
  // already settled (has a remote): a remote-less project can still be
  // git_remote-backfilled by a later ensureProject(path, suppliedGitRemote)
  // call, so leave it uncached (mirrors the NULL-git_remote existing branch).
  fireProjectMutation();
  if (gitRemote) cache.set(path, id);
  return id;
}

export function projectId(path: string): string | undefined {
  // Shares ensureProject's per-connection memo (LOREAI-GATEWAY-3K).
  const cache = projectIdCacheFor(db());
  const cached = cache.get(path);
  if (cached !== undefined) return cached;

  const row = db()
    .query("SELECT id, git_remote FROM projects WHERE path = ?")
    .get(path) as { id: string; git_remote: string | null } | null;
  if (row) {
    // Mirror ensureProject: only memoize a settled (remote-backed) exact-path
    // row so a NULL-git_remote project still gets its lazy backfill retried
    // there. An unsettled row is returned but left uncached.
    if (row.git_remote) cache.set(path, row.id);
    return row.id;
  }

  // Check path aliases (worktree/clone paths registered by ensureProject). An
  // alias only exists for an already-resolved project — safe to memoize.
  const alias = db()
    .query("SELECT project_id FROM project_path_aliases WHERE path = ?")
    .get(path) as { project_id: string } | null;
  if (alias) {
    cache.set(path, alias.project_id);
    return alias.project_id;
  }
  return undefined;
}

/**
 * Look up a project by git_remote (preferred) or path. Returns the project ID
 * or null if not found. Unlike `ensureProject()`, this is read-only — it never
 * creates a project or registers path aliases.
 */
export function resolveProjectByRemoteOrPath(
  gitRemote?: string,
  path?: string,
): string | null {
  if (gitRemote) {
    const row = db()
      .query("SELECT id FROM projects WHERE git_remote = ? LIMIT 1")
      .get(gitRemote) as { id: string } | null;
    if (row) return row.id;
  }
  if (path) {
    return projectId(path) ?? null;
  }
  return null;
}

/**
 * List every filesystem path lore knows for the project that `path` belongs to.
 *
 * Read-only (never creates a project or registers aliases). Resolves the project
 * by git remote (preferred) then by exact path / alias, then returns the
 * canonical `projects.path` plus all `project_path_aliases` rows for that
 * project. Returns `[]` when the project isn't known yet (e.g. first-ever
 * import), which callers treat as "no extra paths".
 *
 * This is the DB half of import's worktree-aware detection: agent history is
 * keyed by the directory the agent ran in, so a repo's history is spread across
 * its main checkout and every worktree/clone path. Runtime resolution already
 * collapses those to one project (see `ensureProject`); this exposes the reverse
 * mapping (project → all its known paths) so import can search all of them.
 */
export function projectKnownPaths(path: string): string[] {
  let projId: string | null = null;
  try {
    const remote = getGitRemote(path); // null in hosted mode OR when not a repo
    projId = resolveProjectByRemoteOrPath(remote ?? undefined, path);
  } catch {
    return [];
  }
  if (!projId) return [];

  const paths: string[] = [];
  try {
    const row = db()
      .query("SELECT path FROM projects WHERE id = ?")
      .get(projId) as { path: string } | null;
    if (row?.path) paths.push(row.path);

    const aliasRows = db()
      .query("SELECT path FROM project_path_aliases WHERE project_id = ?")
      .all(projId) as { path: string }[];
    for (const r of aliasRows) if (r.path) paths.push(r.path);
  } catch {
    return [];
  }
  return paths;
}

/**
 * Look up the path for a project by its internal ID.
 * Used by the REST API to resolve project UUID → path for core functions
 * that require a path argument.
 */
export function projectPath(id: string): string | null {
  const row = db().query("SELECT path FROM projects WHERE id = ?").get(id) as {
    path: string;
  } | null;
  return row?.path ?? null;
}

/** Look up a project's normalized git remote by its internal ID, or null. */
export function projectGitRemote(id: string): string | null {
  const row = db()
    .query("SELECT git_remote FROM projects WHERE id = ?")
    .get(id) as { git_remote: string | null } | null;
  return row?.git_remote ?? null;
}

// ---------------------------------------------------------------------------
// E-5-F3 (#827): scope selection & team-promotion policy (producer side)
// ---------------------------------------------------------------------------

/**
 * The team scope a project is bound to (the promotion TARGET), or null (personal). Binding is
 * intent only — content is not team-scoped until it is promoted+approved (F3-2/F3-3).
 */
export function projectScope(id: string): string | null {
  const row = db()
    .query("SELECT scope_id FROM projects WHERE id = ?")
    .get(id) as { scope_id: string | null } | null;
  return row?.scope_id ?? null;
}

/** Bind (scopeId) or unbind (null) a project to a team scope. */
export function setProjectScope(id: string, scopeId: string | null): void {
  db().query("UPDATE projects SET scope_id = ? WHERE id = ?").run(scopeId, id);
}

/**
 * Set (or clear, with null) a project-level override of the team-promotion policy. Null ⇒ inherit
 * the bound team scope's default (see effectivePromotionPolicy).
 */
export function setProjectPromotionPolicy(
  id: string,
  policy: "manual" | "auto" | null,
): void {
  db()
    .query("UPDATE projects SET promotion_policy = ? WHERE id = ?")
    .run(policy, id);
}

/**
 * Effective team-promotion policy for a project: the project override if set, else the bound team
 * scope's default (from the pulled scopes mirror), else 'manual' — never auto-promote to a team
 * without review unless explicitly opted in.
 */
export function effectivePromotionPolicy(id: string): "manual" | "auto" {
  const p = db()
    .query("SELECT scope_id, promotion_policy FROM projects WHERE id = ?")
    .get(id) as {
    scope_id: string | null;
    promotion_policy: string | null;
  } | null;
  if (p?.promotion_policy === "auto" || p?.promotion_policy === "manual") {
    return p.promotion_policy;
  }
  if (p?.scope_id) {
    const s = db()
      .query("SELECT promotion_policy FROM scopes WHERE id = ?")
      .get(p.scope_id) as { promotion_policy: string | null } | null;
    if (s?.promotion_policy === "auto") return "auto";
  }
  return "manual";
}

/**
 * Resolve a `lore team link` target — an exact scope id or a case-insensitive team name — from the
 * LOCAL registry mirror (F1), requiring `userId` to be a WRITE member (admin|editor). Returns the
 * scope `{id, name}` or null (not found locally / not a writable member). Offline-friendly: reads
 * only the pulled mirror, so `lore sync now` must have populated it.
 */
export function resolveWritableScope(
  ref: string,
  userId: string,
): { id: string; name: string | null } | null {
  const byId = db()
    .query("SELECT id, name FROM scopes WHERE id = ?")
    .get(ref) as { id: string; name: string | null } | null;
  const scope =
    byId ??
    (db()
      .query(
        // ORDER BY id so a case-insensitive name shared by two teams resolves deterministically
        // (rather than by arbitrary row order); the exact-id form is the unambiguous escape hatch.
        "SELECT id, name FROM scopes WHERE kind = 'team' AND LOWER(name) = LOWER(?) ORDER BY id LIMIT 1",
      )
      .get(ref) as { id: string; name: string | null } | null);
  if (!scope) return null;
  const m = db()
    .query("SELECT role FROM scope_members WHERE scope_id = ? AND user_id = ?")
    .get(scope.id, userId) as { role: string } | null;
  if (!m || (m.role !== "admin" && m.role !== "editor")) return null;
  return scope;
}

/**
 * The caller's role in a scope from the local registry mirror, or null if they are not a member.
 * A read-only convenience over the mirror — the authoritative role check is always server-side (RLS
 * / RPC). Used e.g. to pre-check "only admins may invite" client-side before firing per-member RPCs.
 */
export function scopeMemberRole(
  scopeId: string,
  userId: string,
): string | null {
  const m = db()
    .query("SELECT role FROM scope_members WHERE scope_id = ? AND user_id = ?")
    .get(scopeId, userId) as { role: string } | null;
  return m?.role ?? null;
}

/** Look up a project's display name by its internal ID. */
export function projectName(id: string): string | null {
  const row = db().query("SELECT name FROM projects WHERE id = ?").get(id) as {
    name: string;
  } | null;
  return row?.name ?? null;
}

/**
 * Returns true if Lore has never been used before (no projects in the DB).
 * Must be called before ensureProject() to get an accurate result.
 */
export function isFirstRun(): boolean {
  const row = db().query("SELECT COUNT(*) as count FROM projects").get() as {
    count: number;
  };
  return row.count === 0;
}

// ---------------------------------------------------------------------------
// Conversation import tracking
// ---------------------------------------------------------------------------

/**
 * Get the timestamp of the last conversation import offer/run for a project.
 * Returns null if import has never been offered for this project.
 */
export function getLastImportAt(projectPath: string): number | null {
  const id = ensureProject(projectPath);
  const row = db()
    .query("SELECT last_import_at FROM projects WHERE id = ?")
    .get(id) as { last_import_at: number | null } | null;
  return row?.last_import_at ?? null;
}

/**
 * Record that conversation import was offered/run for a project.
 * Supplementary timestamp — auto-import now gates on per-agent import_history
 * rows (via hasAgentImportRecord), not this field. Still written by explicit
 * `lore import` for bookkeeping.
 */
export function setLastImportAt(projectPath: string, timestamp: number): void {
  const id = ensureProject(projectPath);
  db()
    .query("UPDATE projects SET last_import_at = ? WHERE id = ?")
    .run(timestamp, id);
}

// ---------------------------------------------------------------------------
// Persistent session state (error recovery)
// ---------------------------------------------------------------------------

/**
 * Load persisted forceMinLayer for a session. Returns 0 if none stored.
 */
export function loadForceMinLayer(sessionID: string): number {
  const row = db()
    .query("SELECT force_min_layer FROM session_state WHERE session_id = ?")
    .get(sessionID) as { force_min_layer: number } | null;
  return row?.force_min_layer ?? 0;
}

/**
 * Persist forceMinLayer for a session. Resets to 0 when consumed.
 * Uses INSERT OR IGNORE + UPDATE to preserve sibling columns
 * (cost, gradient, tracking) that other writers depend on.
 */
export function saveForceMinLayer(sessionID: string, layer: number): void {
  const now = Date.now();
  // Ensure row exists (no-op if it already does)
  db()
    .query(
      "INSERT OR IGNORE INTO session_state (session_id, force_min_layer, updated_at) VALUES (?, 0, ?)",
    )
    .run(sessionID, now);
  // Update only the force_min_layer column, preserving all others
  db()
    .query(
      "UPDATE session_state SET force_min_layer = ?, updated_at = ? WHERE session_id = ?",
    )
    .run(layer, now, sessionID);
}

/** Persisted cost snapshot for a session. */
/**
 * Per-bucket worker (background-task) spend. Mirrors the in-memory
 * `SessionCosts["workers"]` shape in the gateway cost-tracker. Persisted as JSON
 * in `session_state.worker_breakdown` so the split survives the session and can
 * be inspected for cost observability. `cost` is USD; `calls` is the LLM call count.
 */
export type WorkerCostBreakdown = {
  distillation: { cost: number; calls: number };
  curation: { cost: number; calls: number };
  compaction: { cost: number; calls: number };
  recall: { cost: number; calls: number };
  warmup: { cost: number; calls: number };
};

export type SessionCostSnapshot = {
  conversationCost: number;
  workerCost: number;
  conversationTurns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  warmupSavings: number;
  /** Cache-warmup request cost (read+write), so warmupNet = savings − cost. */
  warmupCost: number;
  warmupHits: number;
  ttlSavings: number;
  ttlHits: number;
  batchSavings: number;
  avoidedCompactions: number;
  avoidedCompactionCost: number;
  /**
   * Per-bucket worker spend split. Absent (undefined) when unavailable
   * (pre-migration rows, or sessions written before this field existed) —
   * readers fall back to the aggregate `workerCost`.
   */
  workerBreakdown?: WorkerCostBreakdown;
};

/**
 * Persist a session's cost snapshot. Uses INSERT OR REPLACE so it works
 * whether or not a row already exists (forceMinLayer may have created one).
 */
export function saveSessionCosts(
  sessionID: string,
  costs: SessionCostSnapshot,
): void {
  db()
    .query(
      `INSERT INTO session_state (session_id, force_min_layer, updated_at,
         conversation_cost, worker_cost, conversation_turns,
         input_tokens, output_tokens,
         cache_read_tokens, cache_write_tokens,
         warmup_savings, warmup_cost, warmup_hits, ttl_savings, ttl_hits, batch_savings,
         avoided_compactions, avoided_compaction_cost, worker_breakdown)
       VALUES (?, COALESCE((SELECT force_min_layer FROM session_state WHERE session_id = ?), 0), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         conversation_cost = excluded.conversation_cost,
         worker_cost = excluded.worker_cost,
         conversation_turns = excluded.conversation_turns,
         input_tokens = excluded.input_tokens,
         output_tokens = excluded.output_tokens,
         cache_read_tokens = excluded.cache_read_tokens,
         cache_write_tokens = excluded.cache_write_tokens,
         warmup_savings = excluded.warmup_savings,
         warmup_cost = excluded.warmup_cost,
         warmup_hits = excluded.warmup_hits,
         ttl_savings = excluded.ttl_savings,
         ttl_hits = excluded.ttl_hits,
         batch_savings = excluded.batch_savings,
         avoided_compactions = excluded.avoided_compactions,
         avoided_compaction_cost = excluded.avoided_compaction_cost,
         worker_breakdown = excluded.worker_breakdown,
         updated_at = excluded.updated_at`,
    )
    .run(
      sessionID,
      sessionID,
      Date.now(),
      costs.conversationCost,
      costs.workerCost,
      costs.conversationTurns,
      costs.inputTokens,
      costs.outputTokens,
      costs.cacheReadTokens,
      costs.cacheWriteTokens,
      costs.warmupSavings,
      costs.warmupCost,
      costs.warmupHits,
      costs.ttlSavings,
      costs.ttlHits,
      costs.batchSavings,
      costs.avoidedCompactions,
      costs.avoidedCompactionCost,
      costs.workerBreakdown ? JSON.stringify(costs.workerBreakdown) : null,
    );
}

/**
 * Parse a `worker_breakdown` JSON column value into a WorkerCostBreakdown.
 * Returns null for missing/blank/invalid JSON so a corrupt or pre-migration
 * value never throws on the read path — callers fall back to the aggregate.
 */
function parseWorkerBreakdown(raw: unknown): WorkerCostBreakdown | undefined {
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return undefined;
    return parsed as WorkerCostBreakdown;
  } catch {
    return undefined;
  }
}

/**
 * Load persisted cost snapshot for a session. Returns null if not stored
 * or if all cost columns are zero (pre-migration row from forceMinLayer only).
 */
export function loadSessionCosts(
  sessionID: string,
): SessionCostSnapshot | null {
  const row = db()
    .query(
      `SELECT conversation_cost, worker_cost, conversation_turns,
              input_tokens, output_tokens,
              cache_read_tokens, cache_write_tokens,
              warmup_savings, warmup_cost, warmup_hits, ttl_savings, ttl_hits, batch_savings,
              avoided_compactions, avoided_compaction_cost, worker_breakdown
       FROM session_state WHERE session_id = ?`,
    )
    .get(sessionID) as {
    conversation_cost: number;
    worker_cost: number;
    conversation_turns: number;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
    warmup_savings: number;
    warmup_cost: number;
    warmup_hits: number;
    ttl_savings: number;
    ttl_hits: number;
    batch_savings: number;
    avoided_compactions: number;
    avoided_compaction_cost: number;
    worker_breakdown: string | null;
  } | null;
  if (!row) return null;
  return {
    conversationCost: row.conversation_cost,
    workerCost: row.worker_cost,
    conversationTurns: row.conversation_turns,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheWriteTokens: row.cache_write_tokens,
    warmupSavings: row.warmup_savings,
    warmupCost: row.warmup_cost,
    warmupHits: row.warmup_hits,
    ttlSavings: row.ttl_savings,
    ttlHits: row.ttl_hits,
    batchSavings: row.batch_savings,
    avoidedCompactions: row.avoided_compactions,
    avoidedCompactionCost: row.avoided_compaction_cost,
    workerBreakdown: parseWorkerBreakdown(row.worker_breakdown),
  };
}

/**
 * Load cost snapshots for all sessions that have non-zero cost data.
 * Returns a map of sessionID → SessionCostSnapshot.
 */
export function loadAllSessionCosts(): Map<string, SessionCostSnapshot> {
  const rows = db()
    .query(
      `SELECT session_id, conversation_cost, worker_cost, conversation_turns,
              input_tokens, output_tokens,
              cache_read_tokens, cache_write_tokens,
              warmup_savings, warmup_cost, warmup_hits, ttl_savings, ttl_hits, batch_savings,
              avoided_compactions, avoided_compaction_cost, worker_breakdown
       FROM session_state
       WHERE conversation_turns > 0 OR warmup_savings > 0 OR warmup_cost > 0 OR ttl_savings > 0 OR batch_savings > 0`,
    )
    .all() as Array<{
    session_id: string;
    conversation_cost: number;
    worker_cost: number;
    conversation_turns: number;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
    warmup_savings: number;
    warmup_cost: number;
    warmup_hits: number;
    ttl_savings: number;
    ttl_hits: number;
    batch_savings: number;
    avoided_compactions: number;
    avoided_compaction_cost: number;
    worker_breakdown: string | null;
  }>;
  const result = new Map<string, SessionCostSnapshot>();
  for (const row of rows) {
    result.set(row.session_id, {
      conversationCost: row.conversation_cost,
      workerCost: row.worker_cost,
      conversationTurns: row.conversation_turns,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      cacheReadTokens: row.cache_read_tokens,
      cacheWriteTokens: row.cache_write_tokens,
      warmupSavings: row.warmup_savings,
      warmupCost: row.warmup_cost,
      warmupHits: row.warmup_hits,
      ttlSavings: row.ttl_savings,
      ttlHits: row.ttl_hits,
      batchSavings: row.batch_savings,
      avoidedCompactions: row.avoided_compactions,
      avoidedCompactionCost: row.avoided_compaction_cost,
      workerBreakdown: parseWorkerBreakdown(row.worker_breakdown),
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Per-day cost ledger (daily_costs table, v30)
// ---------------------------------------------------------------------------

/** Cost bucket for the per-day ledger. */
export type DailyCostBucket = "conversation" | "worker" | "warmup";

/**
 * Append `cost` to the (day, bucket) ledger row, creating it if absent.
 *
 * `day` is a UTC date string (YYYY-MM-DD). Costs accumulate on the actual
 * day they were incurred, so multi-day or long-lived sessions attribute
 * spend to the correct day instead of dumping cumulative totals onto one date.
 */
export function addDailyCost(
  day: string,
  bucket: DailyCostBucket,
  cost: number,
): void {
  if (!Number.isFinite(cost) || cost <= 0) return;
  db()
    .query(
      `INSERT INTO daily_costs (day, bucket, cost, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(day, bucket) DO UPDATE SET
         cost = cost + excluded.cost,
         updated_at = excluded.updated_at`,
    )
    .run(day, bucket, cost, Date.now());
}

/**
 * Sum daily-cost totals (across all buckets) per day for days >= `sinceDay`.
 * Returns a Map of UTC date string → total USD. Single grouped query.
 */
export function getDailyCostTotals(sinceDay: string): Map<string, number> {
  const rows = db()
    .query(
      `SELECT day, SUM(cost) AS total
       FROM daily_costs
       WHERE day >= ?
       GROUP BY day`,
    )
    .all(sinceDay) as Array<{ day: string; total: number }>;
  const result = new Map<string, number>();
  for (const row of rows) {
    result.set(row.day, row.total);
  }
  return result;
}

/** Total USD cost recorded for a single UTC day (across all buckets). */
export function getDailyCostForDay(day: string): number {
  const row = db()
    .query(
      "SELECT COALESCE(SUM(cost), 0) AS total FROM daily_costs WHERE day = ?",
    )
    .get(day) as { total: number } | null;
  return row?.total ?? 0;
}

// ---------------------------------------------------------------------------
// Session tracking state (session_state table, v23 columns)
// ---------------------------------------------------------------------------

/** Fields that can be persisted for session tracking state. */
export type SessionTrackingState = {
  lastCuratedAt?: number;
  messageCount?: number;
  turnsSinceCuration?: number;
  consecutiveTextOnlyTurns?: number;
  ltmCacheText?: string | null;
  ltmCacheTokens?: number | null;
  ltmPinText?: string | null;
  ltmPinTokens?: number | null;
  /** JSON array of sorted "id:hash(title+content)" keys for the pinned entry set (v39). */
  ltmPinKeys?: string | null;
  /** Frozen stable LTM block (system[1]: preferences + entities), pinned for the
   *  session's life so curator/consolidation changes never bust the prefix (v45). */
  stableLtmText?: string | null;
  stableLtmTokens?: number | null;
  /** JSON-serialized recall store (marker→result map) so recall markers expand
   *  byte-identically across process restarts (v46). */
  recallStore?: string | null;
  /** JSON map of "<messageID>:<partID>" -> wasCollapsed for stable dedup (v41). */
  dedupDecisions?: string | null;
  // v24: session identity
  fingerprint?: string;
  headerSessionId?: string | null;
  headerName?: string | null;
  // v24: cache warming
  resolvedConversationTTL?: string;
  warmupState?: string | null; // JSON blob
  // v24: gradient calibration
  dynamicContextCap?: number;
  bustRateEMA?: number;
  interBustIntervalEMA?: number;
  lastLayer?: number;
  lastKnownInput?: number;
  /** v43: messages sent last turn — for restart-proof calibrated-delta estimation. */
  lastKnownMessageCount?: number;
  lastTurnAt?: number;
  lastBustAt?: number;
  // v26: sub-agent parent–child relationships
  parentSessionId?: string | null;
  isSubagent?: boolean;
  // v36: project binding (survives restart so the project_id never splits)
  projectPath?: string | null;
  projectPathProvisional?: boolean;
  // v37: compaction anomaly pending flag
  compactionAnomalyPending?: boolean;
};

/**
 * Persist session tracking state. Ensures the row exists, then updates
 * only the fields that are explicitly provided (not undefined).
 */
export function saveSessionTracking(
  sessionID: string,
  state: SessionTrackingState,
): void {
  const now = Date.now();

  // Ensure row exists (no-op if it already does)
  db()
    .query(
      "INSERT OR IGNORE INTO session_state (session_id, force_min_layer, updated_at) VALUES (?, 0, ?)",
    )
    .run(sessionID, now);

  // Build SET clauses for only the provided fields
  const sets: string[] = ["updated_at = ?"];
  const vals: (string | number | null)[] = [now];

  if (state.lastCuratedAt !== undefined) {
    sets.push("last_curated_at = ?");
    vals.push(state.lastCuratedAt);
  }
  if (state.messageCount !== undefined) {
    sets.push("message_count = ?");
    vals.push(state.messageCount);
  }
  if (state.turnsSinceCuration !== undefined) {
    sets.push("turns_since_curation = ?");
    vals.push(state.turnsSinceCuration);
  }
  if (state.consecutiveTextOnlyTurns !== undefined) {
    sets.push("consecutive_text_only_turns = ?");
    vals.push(state.consecutiveTextOnlyTurns);
  }
  if (state.ltmCacheText !== undefined) {
    sets.push("ltm_cache_text = ?");
    vals.push(state.ltmCacheText);
  }
  if (state.ltmCacheTokens !== undefined) {
    sets.push("ltm_cache_tokens = ?");
    vals.push(state.ltmCacheTokens);
  }
  if (state.ltmPinText !== undefined) {
    sets.push("ltm_pin_text = ?");
    vals.push(state.ltmPinText);
  }
  if (state.ltmPinTokens !== undefined) {
    sets.push("ltm_pin_tokens = ?");
    vals.push(state.ltmPinTokens);
  }
  if (state.ltmPinKeys !== undefined) {
    sets.push("ltm_pin_keys = ?");
    vals.push(state.ltmPinKeys);
  }
  if (state.stableLtmText !== undefined) {
    sets.push("stable_ltm_text = ?");
    vals.push(state.stableLtmText);
  }
  if (state.stableLtmTokens !== undefined) {
    sets.push("stable_ltm_tokens = ?");
    vals.push(state.stableLtmTokens);
  }
  if (state.recallStore !== undefined) {
    sets.push("recall_store = ?");
    vals.push(state.recallStore);
  }
  if (state.dedupDecisions !== undefined) {
    sets.push("dedup_decisions = ?");
    vals.push(state.dedupDecisions);
  }
  // v24: session identity
  if (state.fingerprint !== undefined) {
    sets.push("fingerprint = ?");
    vals.push(state.fingerprint);
  }
  if (state.headerSessionId !== undefined) {
    sets.push("header_session_id = ?");
    vals.push(state.headerSessionId);
  }
  if (state.headerName !== undefined) {
    sets.push("header_name = ?");
    vals.push(state.headerName);
  }
  // v24: cache warming
  if (state.resolvedConversationTTL !== undefined) {
    sets.push("resolved_conversation_ttl = ?");
    vals.push(state.resolvedConversationTTL);
  }
  if (state.warmupState !== undefined) {
    sets.push("warmup_state = ?");
    vals.push(state.warmupState);
  }
  // v24: gradient calibration
  if (state.dynamicContextCap !== undefined) {
    sets.push("dynamic_context_cap = ?");
    vals.push(state.dynamicContextCap);
  }
  if (state.bustRateEMA !== undefined) {
    sets.push("bust_rate_ema = ?");
    vals.push(state.bustRateEMA);
  }
  if (state.interBustIntervalEMA !== undefined) {
    sets.push("inter_bust_interval_ema = ?");
    vals.push(state.interBustIntervalEMA);
  }
  if (state.lastLayer !== undefined) {
    sets.push("last_layer = ?");
    vals.push(state.lastLayer);
  }
  if (state.lastKnownInput !== undefined) {
    sets.push("last_known_input = ?");
    vals.push(state.lastKnownInput);
  }
  if (state.lastKnownMessageCount !== undefined) {
    sets.push("last_known_message_count = ?");
    vals.push(state.lastKnownMessageCount);
  }
  if (state.lastTurnAt !== undefined) {
    sets.push("last_turn_at = ?");
    vals.push(state.lastTurnAt);
  }
  if (state.lastBustAt !== undefined) {
    sets.push("last_bust_at = ?");
    vals.push(state.lastBustAt);
  }
  // v26: sub-agent parent–child relationships
  if (state.parentSessionId !== undefined) {
    sets.push("parent_session_id = ?");
    vals.push(state.parentSessionId);
  }
  if (state.isSubagent !== undefined) {
    sets.push("is_subagent = ?");
    vals.push(state.isSubagent ? 1 : 0);
  }
  // v36: project binding
  if (state.projectPath !== undefined) {
    sets.push("project_path = ?");
    vals.push(state.projectPath);
  }
  if (state.projectPathProvisional !== undefined) {
    sets.push("project_path_provisional = ?");
    vals.push(state.projectPathProvisional ? 1 : 0);
  }
  // v37: compaction anomaly pending flag (persisted across restarts)
  if (state.compactionAnomalyPending !== undefined) {
    sets.push("compaction_anomaly_pending = ?");
    vals.push(state.compactionAnomalyPending ? 1 : 0);
  }
  // Update only the specified columns
  db()
    .query(`UPDATE session_state SET ${sets.join(", ")} WHERE session_id = ?`)
    .run(...vals, sessionID);
}

/** Loaded session tracking state. */
export type LoadedSessionTracking = {
  lastCuratedAt: number;
  messageCount: number;
  turnsSinceCuration: number;
  consecutiveTextOnlyTurns: number;
  ltmCacheText: string | null;
  ltmCacheTokens: number | null;
  ltmPinText: string | null;
  ltmPinTokens: number | null;
  // v39: reorder-tolerant pin entry-set keys (JSON)
  ltmPinKeys: string | null;
  // v45: frozen stable LTM block (system[1])
  stableLtmText: string | null;
  stableLtmTokens: number | null;
  // v46: persisted recall store (marker→result map, JSON)
  recallStore: string | null;
  dedupDecisions: string | null;
  // v24: session identity
  fingerprint: string;
  headerSessionId: string | null;
  headerName: string | null;
  // v24: cache warming
  resolvedConversationTTL: string;
  warmupState: string | null;
  // v24: gradient calibration
  dynamicContextCap: number;
  bustRateEMA: number;
  interBustIntervalEMA: number;
  lastLayer: number;
  lastKnownInput: number;
  /** v43: messages sent last turn (0 for pre-v43 / never-calibrated rows). */
  lastKnownMessageCount: number;
  lastTurnAt: number;
  lastBustAt: number;
  // v26: sub-agent parent–child relationships
  parentSessionId: string | null;
  isSubagent: boolean;
  // v36: project binding
  projectPath: string | null;
  projectPathProvisional: boolean;
  // v37: compaction anomaly pending flag
  compactionAnomalyPending: boolean;
};

export type SessionPromptDelta = {
  sessionID: string;
  seq: number;
  projectID: string;
  selector: string;
  content: string;
};

/**
 * Append a durable prompt delta for a session. The next seq is allocated inside
 * the INSERT statement so ordering is deterministic without a separate ID.
 */
export function appendSessionPromptDelta(input: {
  sessionID: string;
  projectID: string;
  selector: string;
  content: string;
}): void {
  db()
    .query(
      `INSERT INTO session_prompt_deltas (session_id, seq, project_id, selector, content)
       SELECT ?, COALESCE(MAX(seq), -1) + 1, ?, ?, ?
         FROM session_prompt_deltas
        WHERE session_id = ?`,
    )
    .run(
      input.sessionID,
      input.projectID,
      input.selector,
      input.content,
      input.sessionID,
    );
}

/**
 * Upsert a SINGLE coalesced prompt delta for a session, pinned to sentinel
 * `seq = 0`, replacing any prior value in place.
 *
 * Unlike `appendSessionPromptDelta` (which appends a new row at MAX(seq)+1 each
 * call), this keeps exactly one durable-delta row per session. The knowledge
 * delta describes the CURRENT selected-vs-pinned state, so it must REPLACE the
 * previous delta, not accumulate alongside it. Accumulating rows (each at a
 * different insertAt as the conversation grew) inserts a new synthetic message
 * into the cached prefix every time the knowledge set changes, shifting all
 * later messages and busting the prompt cache. Coalescing into one row at a
 * frozen insertAt keeps the message prefix byte-stable until the delta's
 * CONTENT genuinely changes (one bust per real change, not a growing cascade).
 */
export function upsertSessionPromptDelta(input: {
  sessionID: string;
  projectID: string;
  selector: string;
  content: string;
}): void {
  db()
    .query(
      `INSERT INTO session_prompt_deltas (session_id, seq, project_id, selector, content)
       VALUES (?, 0, ?, ?, ?)
       ON CONFLICT(session_id, seq) DO UPDATE SET
         project_id = excluded.project_id,
         selector   = excluded.selector,
         content    = excluded.content`,
    )
    .run(input.sessionID, input.projectID, input.selector, input.content);
}

/**
 * Rewrite the persisted `selector` JSON for a single delta block, identified by
 * (sessionID, seq). Content is left untouched — only the placement metadata
 * moves. Used by the steady-layer-1 drift fix (Bug 2): when safeDeltaInsertIndex
 * nudges a once-safe insertAt because the compressed array below it slid,
 * persist the new safe index so subsequent replays use it verbatim and the
 * delta block stays at a byte-identical position across turns. No-op if no
 * matching row exists.
 */
export function updateSessionPromptDeltaSelector(
  sessionID: string,
  seq: number,
  selector: string,
): void {
  db()
    .query(
      `UPDATE session_prompt_deltas
          SET selector = ?
        WHERE session_id = ? AND seq = ?`,
    )
    .run(selector, sessionID, seq);
}

/**
 * Delete all persisted prompt-delta rows for a session. No-op when no rows
 * exist.
 *
 * NOTE: this is no longer the compression-reset action. A compressing turn now
 * RE-ANCHORS the blocks — preserving their content and `mut` surfaced-set
 * history — via the gateway's `reanchorExistingDelta`, rather than deleting
 * them. (Deleting on every compression wiped that history and forced a full
 * pin→DB re-derive each turn, a growing cache-bust wall.) This primitive is
 * still used (a) internally by that re-anchor as its delete-then-re-append
 * step, and (b) by the bounded `MAX_DELTA_BLOCKS` coalesce that intentionally
 * collapses accumulated blocks back into one cumulative block.
 */
export function deleteSessionPromptDelta(sessionID: string): void {
  db()
    .query("DELETE FROM session_prompt_deltas WHERE session_id = ?")
    .run(sessionID);
}

export function listSessionPromptDeltas(
  sessionID: string,
): SessionPromptDelta[] {
  const rows = db()
    .query(
      `SELECT session_id, seq, project_id, selector, content
         FROM session_prompt_deltas
        WHERE session_id = ?
        ORDER BY seq`,
    )
    .all(sessionID) as Array<{
    session_id: string;
    seq: number;
    project_id: string;
    selector: string;
    content: string;
  }>;

  return rows.map((row) => ({
    sessionID: row.session_id,
    seq: row.seq,
    projectID: row.project_id,
    selector: row.selector,
    content: row.content,
  }));
}

// ---------------------------------------------------------------------------
// Cache-bust measurement counters (issue #791 — measure-first gate)
// ---------------------------------------------------------------------------

/** A durable per-(project, cause, relocatable) cache-bust tally. */
export type CacheBustStat = {
  projectID: string;
  /** A CacheBustCause value (defined in gradient.ts, core-owned). */
  cause: string;
  /** Whether the (system[0]) divergence looked relocatable. */
  relocatable: boolean;
  /** Number of observed turns for this key. */
  turns: number;
  /** Summed cache_creation (write) tokens for this key. */
  writeTokens: number;
  /** Last update time (epoch ms). */
  updatedAt: number;
};

/**
 * Record a single per-turn cache-bust observation, accumulating into the
 * durable counter for (project, cause, relocatable). Increments `turns` by 1
 * and adds `writeTokens` to the running total. Passive telemetry only — never
 * affects the upstream request.
 */
export function recordCacheBustObservation(input: {
  projectID: string;
  cause: string;
  relocatable: boolean;
  writeTokens: number;
}): void {
  db()
    .query(
      `INSERT INTO cache_bust_stats
         (project_id, cause, relocatable, turns, write_tokens, updated_at)
       VALUES (?, ?, ?, 1, ?, ?)
       ON CONFLICT(project_id, cause, relocatable) DO UPDATE SET
         turns        = turns + 1,
         write_tokens = write_tokens + excluded.write_tokens,
         updated_at   = excluded.updated_at`,
    )
    .run(
      input.projectID,
      input.cause,
      input.relocatable ? 1 : 0,
      Math.max(0, Math.trunc(input.writeTokens)),
      Date.now(),
    );
}

/**
 * Read cache-bust counters, optionally scoped to one project. Ordered by
 * `turns` descending (most-frequent cause first).
 */
export function getCacheBustStats(projectID?: string): CacheBustStat[] {
  const rows = (
    projectID
      ? db()
          .query(
            `SELECT project_id, cause, relocatable, turns, write_tokens, updated_at
               FROM cache_bust_stats
              WHERE project_id = ?
              ORDER BY turns DESC`,
          )
          .all(projectID)
      : db()
          .query(
            `SELECT project_id, cause, relocatable, turns, write_tokens, updated_at
               FROM cache_bust_stats
              ORDER BY turns DESC`,
          )
          .all()
  ) as Array<{
    project_id: string;
    cause: string;
    relocatable: number;
    turns: number;
    write_tokens: number;
    updated_at: number;
  }>;

  return rows.map((row) => ({
    projectID: row.project_id,
    cause: row.cause,
    relocatable: row.relocatable === 1,
    turns: row.turns,
    writeTokens: row.write_tokens,
    updatedAt: row.updated_at,
  }));
}

/** Aggregated view of cache-bust counters for the issue #791 gate readout. */
export type CacheBustSummary = {
  /** All observed turns (every cause, including non-busts). */
  totalTurns: number;
  /** Turns that were genuine cache busts (excludes incremental / first-turn). */
  bustTurns: number;
  /** Summed write tokens across bust turns. */
  bustTokens: number;
  /** Bust turns whose divergence was in system[0] (host prompt). */
  hostTurns: number;
  /** Summed write tokens across system[0] host busts. */
  hostTokens: number;
  /** System[0] host busts whose changed span looked relocatable. */
  relocatableTurns: number;
  /** Summed write tokens across relocatable system[0] busts. */
  relocatableTokens: number;
};

/** Causes that are NOT genuine cache busts (excluded from the bust denominator). */
const NON_BUST_CAUSES = new Set(["incremental", "first-turn"]);

/**
 * Reduce raw per-(cause, relocatable) counters into the gate summary. Pure —
 * no I/O — so the headline arithmetic that drives the build-vs-close decision
 * is unit-testable independent of the DB and CLI.
 */
export function summarizeCacheBustStats(
  stats: CacheBustStat[],
): CacheBustSummary {
  const out: CacheBustSummary = {
    totalTurns: 0,
    bustTurns: 0,
    bustTokens: 0,
    hostTurns: 0,
    hostTokens: 0,
    relocatableTurns: 0,
    relocatableTokens: 0,
  };
  for (const s of stats) {
    out.totalTurns += s.turns;
    if (!NON_BUST_CAUSES.has(s.cause)) {
      out.bustTurns += s.turns;
      out.bustTokens += s.writeTokens;
    }
    if (s.cause === "system-host-change") {
      out.hostTurns += s.turns;
      out.hostTokens += s.writeTokens;
      if (s.relocatable) {
        out.relocatableTurns += s.turns;
        out.relocatableTokens += s.writeTokens;
      }
    }
  }
  return out;
}

/**
 * Load persisted session tracking state. Returns null if no row exists.
 */
export function loadSessionTracking(
  sessionID: string,
): LoadedSessionTracking | null {
  const row = db()
    .query(
      `SELECT last_curated_at, message_count, turns_since_curation,
              consecutive_text_only_turns,
              ltm_cache_text, ltm_cache_tokens, ltm_pin_text, ltm_pin_tokens,
              ltm_pin_keys, stable_ltm_text, stable_ltm_tokens, recall_store,
              dedup_decisions,
              fingerprint, header_session_id, header_name,
              resolved_conversation_ttl, warmup_state,
              dynamic_context_cap, bust_rate_ema, inter_bust_interval_ema,
              last_layer, last_known_input, last_known_message_count,
              last_turn_at, last_bust_at,
              parent_session_id, is_subagent,
              project_path, project_path_provisional,
              compaction_anomaly_pending
       FROM session_state WHERE session_id = ?`,
    )
    .get(sessionID) as {
    last_curated_at: number;
    message_count: number;
    turns_since_curation: number;
    consecutive_text_only_turns: number;
    ltm_cache_text: string | null;
    ltm_cache_tokens: number | null;
    ltm_pin_text: string | null;
    ltm_pin_tokens: number | null;
    ltm_pin_keys: string | null;
    stable_ltm_text: string | null;
    stable_ltm_tokens: number | null;
    recall_store: string | null;
    dedup_decisions: string | null;
    fingerprint: string;
    header_session_id: string | null;
    header_name: string | null;
    resolved_conversation_ttl: string;
    warmup_state: string | null;
    dynamic_context_cap: number;
    bust_rate_ema: number;
    inter_bust_interval_ema: number;
    last_layer: number;
    last_known_input: number;
    last_known_message_count: number;
    last_turn_at: number;
    last_bust_at: number;
    parent_session_id: string | null;
    is_subagent: number;
    project_path: string | null;
    project_path_provisional: number;
    compaction_anomaly_pending: number;
  } | null;
  if (!row) return null;
  return {
    lastCuratedAt: row.last_curated_at,
    messageCount: row.message_count,
    turnsSinceCuration: row.turns_since_curation,
    consecutiveTextOnlyTurns: row.consecutive_text_only_turns,
    ltmCacheText: row.ltm_cache_text,
    ltmCacheTokens: row.ltm_cache_tokens,
    ltmPinText: row.ltm_pin_text,
    ltmPinTokens: row.ltm_pin_tokens,
    ltmPinKeys: row.ltm_pin_keys,
    stableLtmText: row.stable_ltm_text,
    stableLtmTokens: row.stable_ltm_tokens,
    recallStore: row.recall_store,
    dedupDecisions: row.dedup_decisions,
    fingerprint: row.fingerprint,
    headerSessionId: row.header_session_id,
    headerName: row.header_name,
    resolvedConversationTTL: row.resolved_conversation_ttl,
    warmupState: row.warmup_state,
    dynamicContextCap: row.dynamic_context_cap,
    bustRateEMA: row.bust_rate_ema,
    interBustIntervalEMA: row.inter_bust_interval_ema,
    lastLayer: row.last_layer,
    lastKnownInput: row.last_known_input,
    lastKnownMessageCount: row.last_known_message_count,
    lastTurnAt: row.last_turn_at,
    lastBustAt: row.last_bust_at,
    parentSessionId: row.parent_session_id,
    isSubagent: row.is_subagent === 1,
    projectPath: row.project_path,
    projectPathProvisional: row.project_path_provisional === 1,
    compactionAnomalyPending: row.compaction_anomaly_pending === 1,
  };
}

/**
 * Find persisted sessions whose stored fingerprint matches `fingerprint`.
 *
 * Restart-proof session adoption (issue #796): after a process restart the
 * in-memory session index is empty, so the Tier-3 fingerprint scan (which only
 * iterates memory) can never rematch a resumed conversation. This DB-backed
 * lookup recovers candidate sessions by their persisted fingerprint. The empty
 * fingerprint ('' — the default for untracked rows) never matches, so
 * uninitialized rows are excluded.
 */
export function findSessionStatesByFingerprint(
  fingerprint: string,
): Array<{ session_id: string; message_count: number; is_subagent: number }> {
  if (!fingerprint) return [];
  return db()
    .query(
      `SELECT session_id, message_count, is_subagent
         FROM session_state
        WHERE fingerprint = ? AND fingerprint != ''`,
    )
    .all(fingerprint) as Array<{
    session_id: string;
    message_count: number;
    is_subagent: number;
  }>;
}

/**
 * Count how many of `ids` exist as temporal messages in (projectId, sessionId).
 *
 * Confirms a fingerprint-matched adoption candidate by content overlap: temporal
 * message IDs are deterministic content hashes, so a genuinely-resumed
 * conversation reproduces the same IDs for its (index-stable) leading messages.
 * The project_id predicate also enforces same-project — a cross-project
 * fingerprint twin yields zero overlap. `ids` is chunked to stay under SQLite's
 * bound-variable limit. (issue #796)
 */
export function countMatchingTemporalIds(
  projectId: string,
  sessionId: string,
  ids: string[],
): number {
  if (ids.length === 0) return 0;
  // < SQLite's 999 bound-variable ceiling, leaving headroom for the 2 fixed params.
  const CHUNK = 800;
  let total = 0;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => "?").join(",");
    const row = db()
      .query(
        `SELECT COUNT(*) AS n FROM temporal_messages
          WHERE project_id = ? AND session_id = ? AND id IN (${placeholders})`,
      )
      .get(projectId, sessionId, ...chunk) as { n: number };
    total += row.n;
  }
  return total;
}

/**
 * Load all persisted header → session ID mappings from the session_state table.
 *
 * Used on gateway startup (in initIfNeeded) to pre-populate the in-memory
 * headerSessionIndex so Tier 1 session identification works immediately
 * after a process restart — without this, the first post-restart request
 * with a known session header would generate a new session ID and orphan
 * the old session's persisted state.
 */
export function loadHeaderSessionIndex(): Array<{
  sessionId: string;
  headerSessionId: string;
  headerName: string;
}> {
  const rows = db()
    .query(
      `SELECT session_id, header_session_id, header_name
        FROM session_state
        WHERE header_session_id IS NOT NULL AND header_name IS NOT NULL
        ORDER BY updated_at ASC`,
    )
    .all() as Array<{
    session_id: string;
    header_session_id: string;
    header_name: string;
  }>;
  return rows.map((row) => ({
    sessionId: row.session_id,
    headerSessionId: row.header_session_id,
    headerName: row.header_name,
  }));
}

/**
 * Load parent→child session mappings from the DB.
 * Returns a map: childSessionId → parentSessionId (Lore internal IDs).
 * Used by the dashboard to build session trees.
 */
let parentChildCache: Map<string, string> | null = null;
let parentChildCacheAt = 0;
const PARENT_CHILD_CACHE_TTL_MS = 30_000; // 30 seconds

export function loadParentChildMap(): Map<string, string> {
  const now = Date.now();
  if (
    parentChildCache &&
    now - parentChildCacheAt < PARENT_CHILD_CACHE_TTL_MS
  ) {
    return parentChildCache;
  }
  const rows = db()
    .query(
      `SELECT session_id, parent_session_id
       FROM session_state
       WHERE parent_session_id IS NOT NULL`,
    )
    .all() as Array<{ session_id: string; parent_session_id: string }>;
  const map = new Map<string, string>();
  for (const row of rows) {
    map.set(row.session_id, row.parent_session_id);
  }
  parentChildCache = map;
  parentChildCacheAt = now;
  return map;
}

/** Invalidate the parent-child map cache (for testing / after session mutations). */
export function invalidateParentChildCache(): void {
  parentChildCache = null;
  parentChildCacheAt = 0;
}

// ---------------------------------------------------------------------------
// Key-value store (kv_meta table)
// ---------------------------------------------------------------------------

/** Get a kv_meta value by key. Returns null if not found. */
export function getKV(key: string): string | null {
  const row = db()
    .query("SELECT value FROM kv_meta WHERE key = ?")
    .get(key) as { value: string } | null;
  return row?.value ?? null;
}

/** Set a kv_meta value (upsert). */
export function setKV(key: string, value: string): void {
  runUpsert("kv_meta", { key, value }, ["key"]);
}

// ---------------------------------------------------------------------------
// Team / sync config store (team_config table)
//
// A generic key/value store reserved for team-sync credentials and sync state
// (e.g. the persisted Supabase auth session, sync watermarks). Created by
// migration v29. Distinct from kv_meta (plugin state) and metadata
// (installation-scoped values) so sync data can be cleared independently on
// logout without touching unrelated state.
// ---------------------------------------------------------------------------

/** Get a team_config value by key. Returns null if not found. */
export function getTeamConfig(key: string): string | null {
  const row = db()
    .query("SELECT value FROM team_config WHERE key = ?")
    .get(key) as { value: string } | null;
  return row?.value ?? null;
}

/** Set a team_config value (upsert). */
export function setTeamConfig(key: string, value: string): void {
  runUpsert("team_config", { key, value }, ["key"]);
}

/** Delete a team_config value. No-op if the key does not exist. */
export function deleteTeamConfig(key: string): void {
  db().query("DELETE FROM team_config WHERE key = ?").run(key);
}

/** Return all team_config entries as a plain object. */
export function getAllTeamConfig(): Record<string, string> {
  const rows = db().query("SELECT key, value FROM team_config").all() as Array<{
    key: string;
    value: string;
  }>;
  const out: Record<string, string> = {};
  for (const row of rows) out[row.key] = row.value;
  return out;
}

// ---------------------------------------------------------------------------
// Installation metadata (metadata table)
// ---------------------------------------------------------------------------

/** Get a metadata value by key. Returns null if not found. */
export function getMeta(key: string): string | null {
  const row = db()
    .query("SELECT value FROM metadata WHERE key = ?")
    .get(key) as { value: string } | null;
  return row?.value ?? null;
}

/** Set a metadata value (upsert). */
export function setMeta(key: string, value: string): void {
  runUpsert("metadata", { key, value, updated_at: Date.now() }, ["key"]);
}

/**
 * Get or create the installation instance ID.
 *
 * Generated once (UUID v4) on first call, then persisted in the metadata
 * table across process restarts and upgrades.
 */
export function getInstanceId(): string {
  const existing = getMeta("instance_id");
  if (existing) return existing;
  const id = crypto.randomUUID();
  setMeta("instance_id", id);
  return id;
}
