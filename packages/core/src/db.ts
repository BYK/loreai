import { Database } from "#db/driver";
import { join, dirname } from "node:path";
import { chmodSync, mkdirSync } from "node:fs";
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
  onProjectMutationCb?.();
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
  -- the mirror is still total. But once the follow-up PR wires update()/remove()
  -- onto appendVersion(), COUNT(knowledge) > COUNT(knowledge_fts), which breaks
  -- three full-mirror assumptions that MUST be fixed in that same PR:
  --   1. validateDatabaseIntegrity() (data.ts) asserts the two counts are equal —
  --      relax to COUNT(knowledge_fts) == COUNT(knowledge WHERE is_current=1 AND
  --      is_deleted=0), else the data CLI aborts on every run.
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
];

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
  database.exec("PRAGMA busy_timeout = 5000");
  // Return freed pages to the OS incrementally on each transaction commit
  // instead of accumulating a free-page list that bloats the file.
  database.exec("PRAGMA auto_vacuum = INCREMENTAL");
  migrate(database);
  installSyncCapture(database);
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
      sql += `
        CREATE TEMP TRIGGER IF NOT EXISTS ${t}_outbox_${suffix}
        AFTER ${evt} ON ${t} WHEN (${gate})
        BEGIN
          INSERT INTO sync_outbox (table_name, row_id, op, changed_at)
          VALUES ('${t}', ${ref}.id, '${op}', ${ts});
        END;`;
    }
  }
  // Join table: composite row_id (knowledge_id || char(31) || entity_id),
  // insert/delete only (no updatable columns).
  sql += `
    CREATE TEMP TRIGGER IF NOT EXISTS knowledge_entity_refs_outbox_ins
    AFTER INSERT ON knowledge_entity_refs WHEN (${gate})
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
  database.exec(sql);
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
      embedding      BLOB
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
      knowledge_id TEXT NOT NULL REFERENCES knowledge(id) ON DELETE CASCADE,
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
      created_at    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tool_calls_project_tool_status
      ON tool_calls (project_id, tool, status);
    CREATE INDEX IF NOT EXISTS idx_tool_calls_project_session
      ON tool_calls (project_id, session_id);
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
      ON sync_outbox (table_name, row_id);
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
    CREATE VIEW IF NOT EXISTS knowledge_current AS
      SELECT k.* FROM knowledge k WHERE k.is_current = 1 AND k.is_deleted = 0;
  `);
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
          AND knowledge_id IN (SELECT id FROM knowledge WHERE project_id = ?)`,
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
    instance.close();
    instance = undefined;
  }
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
  if (!process.env.LORE_DB_PATH && /^\/test\//.test(path)) {
    throw new Error(
      `Refusing to create project with test path "${path}" in the production DB. ` +
        `Set LORE_DB_PATH to a temp path, or run tests via \`bun test\` from the repo root.`,
    );
  }

  // 1. Exact path match (fast path)
  const existing = db()
    .query("SELECT id, git_remote FROM projects WHERE path = ?")
    .get(path) as { id: string; git_remote: string | null } | null;
  if (existing) {
    // Lazy backfill: populate git_remote on pre-v14 rows
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
      }
    }
    return existing.id;
  }

  // 2. Check path aliases (worktree/clone re-visits)
  const alias = db()
    .query("SELECT project_id FROM project_path_aliases WHERE path = ?")
    .get(path) as { project_id: string } | null;
  if (alias) return alias.project_id;

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
  fireProjectMutation();
  return id;
}

export function projectId(path: string): string | undefined {
  const row = db()
    .query("SELECT id FROM projects WHERE path = ?")
    .get(path) as { id: string } | null;
  if (row) return row.id;

  // Check path aliases (worktree/clone paths registered by ensureProject)
  const alias = db()
    .query("SELECT project_id FROM project_path_aliases WHERE path = ?")
    .get(path) as { project_id: string } | null;
  return alias?.project_id;
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
export type SessionCostSnapshot = {
  conversationCost: number;
  workerCost: number;
  conversationTurns: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  warmupSavings: number;
  warmupHits: number;
  ttlSavings: number;
  ttlHits: number;
  batchSavings: number;
  avoidedCompactions: number;
  avoidedCompactionCost: number;
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
         cache_read_tokens, cache_write_tokens,
         warmup_savings, warmup_hits, ttl_savings, ttl_hits, batch_savings,
         avoided_compactions, avoided_compaction_cost)
       VALUES (?, COALESCE((SELECT force_min_layer FROM session_state WHERE session_id = ?), 0), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         conversation_cost = excluded.conversation_cost,
         worker_cost = excluded.worker_cost,
         conversation_turns = excluded.conversation_turns,
         cache_read_tokens = excluded.cache_read_tokens,
         cache_write_tokens = excluded.cache_write_tokens,
         warmup_savings = excluded.warmup_savings,
         warmup_hits = excluded.warmup_hits,
         ttl_savings = excluded.ttl_savings,
         ttl_hits = excluded.ttl_hits,
         batch_savings = excluded.batch_savings,
         avoided_compactions = excluded.avoided_compactions,
         avoided_compaction_cost = excluded.avoided_compaction_cost,
         updated_at = excluded.updated_at`,
    )
    .run(
      sessionID,
      sessionID,
      Date.now(),
      costs.conversationCost,
      costs.workerCost,
      costs.conversationTurns,
      costs.cacheReadTokens,
      costs.cacheWriteTokens,
      costs.warmupSavings,
      costs.warmupHits,
      costs.ttlSavings,
      costs.ttlHits,
      costs.batchSavings,
      costs.avoidedCompactions,
      costs.avoidedCompactionCost,
    );
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
              cache_read_tokens, cache_write_tokens,
              warmup_savings, warmup_hits, ttl_savings, ttl_hits, batch_savings,
              avoided_compactions, avoided_compaction_cost
       FROM session_state WHERE session_id = ?`,
    )
    .get(sessionID) as {
    conversation_cost: number;
    worker_cost: number;
    conversation_turns: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
    warmup_savings: number;
    warmup_hits: number;
    ttl_savings: number;
    ttl_hits: number;
    batch_savings: number;
    avoided_compactions: number;
    avoided_compaction_cost: number;
  } | null;
  if (!row) return null;
  return {
    conversationCost: row.conversation_cost,
    workerCost: row.worker_cost,
    conversationTurns: row.conversation_turns,
    cacheReadTokens: row.cache_read_tokens,
    cacheWriteTokens: row.cache_write_tokens,
    warmupSavings: row.warmup_savings,
    warmupHits: row.warmup_hits,
    ttlSavings: row.ttl_savings,
    ttlHits: row.ttl_hits,
    batchSavings: row.batch_savings,
    avoidedCompactions: row.avoided_compactions,
    avoidedCompactionCost: row.avoided_compaction_cost,
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
              cache_read_tokens, cache_write_tokens,
              warmup_savings, warmup_hits, ttl_savings, ttl_hits, batch_savings,
              avoided_compactions, avoided_compaction_cost
       FROM session_state
       WHERE conversation_turns > 0 OR warmup_savings > 0 OR ttl_savings > 0 OR batch_savings > 0`,
    )
    .all() as Array<{
    session_id: string;
    conversation_cost: number;
    worker_cost: number;
    conversation_turns: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
    warmup_savings: number;
    warmup_hits: number;
    ttl_savings: number;
    ttl_hits: number;
    batch_savings: number;
    avoided_compactions: number;
    avoided_compaction_cost: number;
  }>;
  const result = new Map<string, SessionCostSnapshot>();
  for (const row of rows) {
    result.set(row.session_id, {
      conversationCost: row.conversation_cost,
      workerCost: row.worker_cost,
      conversationTurns: row.conversation_turns,
      cacheReadTokens: row.cache_read_tokens,
      cacheWriteTokens: row.cache_write_tokens,
      warmupSavings: row.warmup_savings,
      warmupHits: row.warmup_hits,
      ttlSavings: row.ttl_savings,
      ttlHits: row.ttl_hits,
      batchSavings: row.batch_savings,
      avoidedCompactions: row.avoided_compactions,
      avoidedCompactionCost: row.avoided_compaction_cost,
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
 * Delete all persisted prompt-delta rows for a session.
 *
 * Used when the gradient compresses (a cache-busting layer change): the
 * durable delta's `insertAt` is a frozen absolute index into the
 * gradient-transformed message array, which is non-stationary — compression
 * reshuffles what sits at each index, so a once-safe index can drift into a
 * tool_use/tool_result pair. Rather than tracking/validating the frozen index,
 * we delete the row on compression so the same turn recomputes the delta
 * (position + content) fresh against the new array. No-op when no rows exist.
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
  /** A CacheBustCause value (gateway-owned string). */
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
