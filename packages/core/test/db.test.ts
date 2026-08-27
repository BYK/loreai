import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { registerSink, type LogSink } from "../src/log";
import {
  db,
  close,
  ensureProject,
  projectId,
  canonicalProjectId,
  onProjectMutation,
  invalidateProjectIdCache,
  mergeProjectInternal,
  PROJECT_MERGE_TABLES,
  loadForceMinLayer,
  saveForceMinLayer,
  getMeta,
  setMeta,
  getInstanceId,
  saveSessionCosts,
  loadSessionCosts,
  loadAllSessionCosts,
  getLastImportAt,
  setLastImportAt,
  saveSessionTracking,
  loadSessionTracking,
  findSessionStatesByFingerprint,
  countMatchingTemporalIds,
  withSavepoint,
  appendSessionPromptDelta,
  listSessionPromptDeltas,
  loadHeaderSessionIndex,
  getKV,
  setKV,
  getTeamConfig,
  setTeamConfig,
  deleteTeamConfig,
  getAllTeamConfig,
  addDailyCost,
  getDailyCostTotals,
  getDailyCostForDay,
  isUnattributedProjectPath,
  UNATTRIBUTED_PROJECT_PREFIX,
  assertFts5Available,
  MIGRATIONS,
} from "../src/db";
import { enableHostedMode, _resetHostedModeForTest } from "../src/hosted";
import {
  deleteProject,
  invalidateProjectsCache,
  listProjects,
  mergeProjects,
} from "../src/data";
import {
  decodeWarmupHistogram,
  encodeWarmupHistogram,
  emptyWarmupHistogramCounts,
  normalizeWarmupHistogram,
} from "../src/warmup-histogram";

const passthroughLogSink: LogSink = {
  info() {},
  warn() {},
  error() {},
  captureException() {},
};

describe("db", () => {
  test("initializes and creates tables", () => {
    const database = db();
    const tables = database
      .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain("projects");
    expect(names).toContain("temporal_messages");
    expect(names).toContain("distillations");
    expect(names).toContain("knowledge");
    expect(names).toContain("knowledge_meta");
    expect(names).toContain("schema_version");
    expect(names).toContain("session_state");
    expect(names).toContain("metadata");
    expect(names).toContain("import_history");
    expect(names).toContain("tool_calls");
  });

  describe("assertFts5Available", () => {
    test("passes on a runtime whose SQLite has FTS5 and leaves no temp table", () => {
      const database = db();
      expect(() => assertFts5Available(database)).not.toThrow();
      // The probe must clean up after itself — no stray temp table left behind.
      const leftover = database
        .query(
          "SELECT name FROM sqlite_temp_master WHERE type='table' AND name='lore_fulltext_probe'",
        )
        .get() as { name: string } | null;
      expect(leftover).toBeNull();
    });

    test("throws an actionable FTS5 error when the module is missing", () => {
      // Stub a connection whose exec fails exactly as an FTS5-less SQLite does.
      const cause = new Error("no such module: fts5");
      const stub = {
        exec: () => {
          throw cause;
        },
      } as unknown as Parameters<typeof assertFts5Available>[0];

      let thrown: unknown;
      try {
        assertFts5Available(stub);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(Error);
      const msg = (thrown as Error).message;
      expect(msg).toContain("FTS5");
      expect(msg).toContain("no such module: fts5");
      // Actionable guidance + preserved cause for debugging.
      expect(msg).toMatch(/lore` binary|Node\.js\/Bun|sqlite\.org\/fts5/);
      expect((thrown as Error).cause).toBe(cause);
    });

    test("surfaces an unexpected (non-FTS5) probe error unchanged", () => {
      const cause = new Error("disk I/O error");
      const stub = {
        exec: () => {
          throw cause;
        },
      } as unknown as Parameters<typeof assertFts5Available>[0];

      // Must NOT be mislabeled as an FTS5 problem — rethrown as the SAME object
      // (identity, not just message), so no wrapping occurred.
      let thrown: unknown;
      try {
        assertFts5Available(stub);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBe(cause);
    });
  });

  test("schema version is set", () => {
    const row = db().query("SELECT version FROM schema_version").get() as {
      version: number;
    };
    expect(row.version).toBe(MIGRATIONS.length);
  });

  test("v85 creates the local temporal queue without re-arming completed legacy progress", () => {
    const database = db();
    database.exec(`
      DELETE FROM temporal_embedding_queue;
      DROP TABLE temporal_embedding_queue;
      INSERT INTO kv_meta (key, value)
        VALUES ('lore:temporal_rechunk.done', '1')
        ON CONFLICT(key) DO UPDATE SET value = excluded.value;
      INSERT INTO kv_meta (key, value)
        VALUES ('lore:temporal_rechunk.cursor', 'legacy-complete-cursor')
        ON CONFLICT(key) DO UPDATE SET value = excluded.value;
      UPDATE schema_version SET version = 84;
    `);
    close();

    const migrated = db();
    expect(migrated.query("SELECT version FROM schema_version").get()).toEqual({
      version: MIGRATIONS.length,
    });
    expect(
      migrated
        .query(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'temporal_embedding_queue'",
        )
        .get(),
    ).toEqual({ name: "temporal_embedding_queue" });
    expect(
      migrated
        .query("SELECT value FROM kv_meta WHERE key = ?")
        .get("lore:temporal_rechunk.done"),
    ).toEqual({ value: "1" });
    expect(
      migrated
        .query("SELECT value FROM kv_meta WHERE key = ?")
        .get("lore:temporal_rechunk.cursor"),
    ).toEqual({ value: "legacy-complete-cursor" });

    migrated.exec("DROP TABLE temporal_embedding_queue");
    close();
    const recovered = db();
    expect(
      recovered
        .query(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_temporal_embedding_queue_enqueued'",
        )
        .get(),
    ).toEqual({ name: "idx_temporal_embedding_queue_enqueued" });
    expect(
      recovered
        .query("SELECT value FROM kv_meta WHERE key = ?")
        .get("lore:temporal_rechunk.done"),
    ).toEqual({ value: "1" });
    expect(
      recovered
        .query("SELECT value FROM kv_meta WHERE key = ?")
        .get("lore:temporal_rechunk.cursor"),
    ).toEqual({ value: "legacy-complete-cursor" });
  });

  test("v81 quarantines sync bookkeeping that predates tenant provenance", () => {
    const database = db();
    database.exec("DELETE FROM sync_outbox; DELETE FROM sync_state;");
    database
      .query(
        "INSERT INTO sync_outbox (table_name, row_id, op, changed_at) VALUES ('knowledge', 'legacy-outbox', 'delete', 1)",
      )
      .run();
    database
      .query(
        `INSERT INTO sync_state
           (table_name, row_id, content_hash, revision, remote_updated_at)
         VALUES ('knowledge', 'legacy-state', NULL, 0, NULL)`,
      )
      .run();

    // Reproduce an on-disk v80 database: the rows exist, but neither table can
    // attribute them to a storage tenant. Re-open through the real migration.
    database.exec("ALTER TABLE sync_outbox DROP COLUMN tenant_id");
    database.exec("ALTER TABLE sync_state DROP COLUMN tenant_id");
    database.exec("UPDATE schema_version SET version = 80");
    close();

    const migrated = db();
    expect(
      migrated.query("SELECT row_id, tenant_id FROM sync_outbox").all(),
    ).toEqual([{ row_id: "legacy-outbox", tenant_id: null }]);
    expect(
      migrated.query("SELECT row_id, tenant_id FROM sync_state").all(),
    ).toEqual([{ row_id: "legacy-state", tenant_id: null }]);
    expect(migrated.query("SELECT version FROM schema_version").get()).toEqual({
      version: MIGRATIONS.length,
    });
    expect(
      migrated
        .query("SELECT value FROM kv_meta WHERE key = ?")
        .get("sync.tenantIsolationReconcile"),
    ).toEqual({ value: "1" });

    migrated.exec(
      "DELETE FROM sync_outbox; DELETE FROM sync_state; UPDATE kv_meta SET value = '0' WHERE key = 'sync.tenantIsolationReconcile';",
    );
  });

  test("v82 preserves existing temporal/tool data while adding owned identities", () => {
    const database = db();
    const projectID = ensureProject(
      `/tmp/v82-existing-data-${crypto.randomUUID()}`,
    );
    const messageID = `legacy-message-${crypto.randomUUID()}`;
    const callID = `legacy-call-${crypto.randomUUID()}`;
    database
      .query(
        `INSERT INTO temporal_messages
           (id, source_id, project_id, session_id, role, content, tokens,
            distilled, created_at, metadata)
         VALUES (?, ?, ?, 'legacy-session', 'user', 'legacy zircon content',
                 3, 0, 1000, '{}')`,
      )
      .run(messageID, messageID, projectID);
    database.exec("DELETE FROM tool_calls;");
    database
      .query(
        `INSERT INTO tool_calls
           (call_id, message_id, project_id, session_id, tool, status,
            created_at, verifier, input_paths_json)
         VALUES (?, ?, ?, 'legacy-session', 'read', 'completed', 1000, 0,
                 '["legacy.ts"]')`,
      )
      .run(callID, messageID, projectID);

    // Reproduce the v81 layouts exactly: no temporal source_id and a globally
    // primary-keyed tool call. Existing IDs and payloads must survive v82.
    database.exec(`
      DROP INDEX idx_temporal_source_identity;
      ALTER TABLE temporal_messages DROP COLUMN source_id;
      CREATE TABLE tool_calls_v81 (
        call_id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        tool TEXT NOT NULL,
        status TEXT NOT NULL,
        error_type TEXT,
        error_message TEXT,
        duration_ms INTEGER,
        created_at INTEGER NOT NULL,
        verifier INTEGER,
        input_paths_json TEXT
      );
      INSERT INTO tool_calls_v81 SELECT * FROM tool_calls;
      DROP TABLE tool_calls;
      ALTER TABLE tool_calls_v81 RENAME TO tool_calls;
      CREATE INDEX idx_tool_calls_project_tool_status
        ON tool_calls (project_id, tool, status);
      CREATE INDEX idx_tool_calls_project_session
        ON tool_calls (project_id, session_id);
      UPDATE schema_version SET version = 81;
    `);
    close();

    const migrated = db();
    expect(migrated.query("SELECT version FROM schema_version").get()).toEqual({
      version: MIGRATIONS.length,
    });
    expect(
      migrated
        .query(
          "SELECT id, source_id, content FROM temporal_messages WHERE id = ?",
        )
        .get(messageID),
    ).toEqual({
      id: messageID,
      source_id: messageID,
      content: "legacy zircon content",
    });
    expect(
      migrated
        .query(
          `SELECT m.id FROM temporal_fts f
             JOIN temporal_messages m ON m.rowid = f.rowid
            WHERE temporal_fts MATCH 'zircon' AND m.id = ?`,
        )
        .get(messageID),
    ).toEqual({ id: messageID });
    expect(
      migrated
        .query(
          "SELECT call_id, status, input_paths_json FROM tool_calls WHERE call_id = ?",
        )
        .get(callID),
    ).toEqual({
      call_id: callID,
      status: "completed",
      input_paths_json: '["legacy.ts"]',
    });
    const pk = (
      migrated.query("PRAGMA table_info(tool_calls)").all() as Array<{
        name: string;
        pk: number;
      }>
    )
      .filter((column) => column.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((column) => column.name);
    expect(pk).toEqual(["project_id", "session_id", "call_id"]);
  });

  test("v55: confidence/last_reinforced_at moved to knowledge_meta, exposed via view", () => {
    // The columns are GONE from the base knowledge table...
    const kcols = (
      db().query("PRAGMA table_info(knowledge)").all() as Array<{
        name: string;
      }>
    ).map((c) => c.name);
    expect(kcols).not.toContain("confidence");
    expect(kcols).not.toContain("last_reinforced_at");
    // ...live on the register...
    const mcols = (
      db().query("PRAGMA table_info(knowledge_meta)").all() as Array<{
        name: string;
      }>
    ).map((c) => c.name);
    expect(mcols).toEqual(
      expect.arrayContaining([
        "logical_id",
        "confidence",
        "last_reinforced_at",
        "updated_at",
      ]),
    );
    // ...and reappear (same SHAPE) on the read view via the JOIN.
    const vcols = (
      db().query("PRAGMA table_info(knowledge_current)").all() as Array<{
        name: string;
      }>
    ).map((c) => c.name);
    expect(vcols).toContain("confidence");
    expect(vcols).toContain("last_reinforced_at");
  });

  test("v55 is re-run-safe after a partial apply (no 'no such column' boot-loop)", () => {
    // Regression for the partial-v55 boot-loop: migrations are NOT transaction-
    // wrapped, so a crash AFTER `ALTER TABLE knowledge DROP COLUMN confidence` but
    // BEFORE the post-loop version bump leaves confidence gone with schema_version
    // still < 55. The forward loop then re-runs v55; a plain-SQL backfill that
    // SELECTs confidence would throw "no such column: confidence" (not swallowed by
    // the duplicate-column catch) → re-thrown → permanent boot-loop. The column-
    // aware JS step (applyKnowledgeMetaRegister) must make the re-run a clean no-op.
    const d = db(); // already at v55: confidence dropped, register present
    // Simulate the crashed-mid-v55 on-disk state.
    d.exec("UPDATE schema_version SET version = 54");
    d.exec("DROP VIEW IF EXISTS knowledge_current");
    d.exec("DROP TABLE IF EXISTS knowledge_meta");

    // Re-open — migrate() re-runs the v55 step (and any later migrations). Must
    // NOT throw, and the version normalizes to MIGRATIONS.length.
    close();
    const fresh = db();
    const ver = fresh.query("SELECT version FROM schema_version").get() as {
      version: number;
    };
    expect(ver.version).toBe(MIGRATIONS.length);
    // Register + JOIN view were rebuilt and are queryable (confidence exposed).
    expect(
      fresh
        .query(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='knowledge_meta'",
        )
        .get(),
    ).not.toBeNull();
    expect(() =>
      fresh.query("SELECT confidence FROM knowledge_current LIMIT 1").all(),
    ).not.toThrow();
  });

  test("v75/v76: both-columns state (partial v75→v76) converges on re-open", () => {
    // Regression for B1 (adversarial review of #1504): a DB that has BOTH
    // `input_path` AND `input_paths_json` (e.g. a partial v75→v76 mid-apply
    // or a manual sidecar ADD) used to crash the gateway on re-open with
    // `duplicate column name: input_paths_json`. The migration loop must
    // converge the schema to the post-rename state (only `input_paths_json`)
    // and normalize the version to MIGRATIONS.length.
    const d = db();
    // Simulate the partial state: input_path was added by v75, then a
    // manual ADD COLUMN input_paths_json (or a re-apply that half-succeeded).
    d.exec("ALTER TABLE tool_calls ADD COLUMN input_path TEXT;");
    d.exec("UPDATE schema_version SET version = 54");
    close();
    const fresh = db();
    const tcols = fresh.query("PRAGMA table_info(tool_calls)").all() as Array<{
      name: string;
    }>;
    const names = tcols.map((c) => c.name);
    expect(names).toContain("input_paths_json");
    expect(names).not.toContain("input_path");
    const ver = fresh.query("SELECT version FROM schema_version").get() as {
      version: number;
    };
    expect(ver.version).toBe(MIGRATIONS.length);
  });

  test("v56: knowledge_ref_validity table + projects.last_refcheck_at exist after recovery", () => {
    // Simulate the real v56→v57 upgrade path where the column/table are ABSENT
    // (a DB already at v56=costs-index, on which the renumbered refcheck
    // migration's loop body never runs — see db.ts mid-array-insert note). Drop
    // the table AND the column, reopen, confirm recoverMissingObjects restores
    // both idempotently. Dropping the column (not just NULLing it) is what
    // actually exercises the column-presence ALTER branch.
    db().exec("DROP TABLE IF EXISTS knowledge_ref_validity");
    db().exec("ALTER TABLE projects DROP COLUMN last_refcheck_at");
    // Sanity: the column is really gone before recovery runs.
    const before = db().query("PRAGMA table_info(projects)").all() as Array<{
      name: string;
    }>;
    expect(before.some((c) => c.name === "last_refcheck_at")).toBe(false);
    close();
    const fresh = db();
    const rv = fresh
      .query("PRAGMA table_info(knowledge_ref_validity)")
      .all() as Array<{ name: string; notnull: number }>;
    expect(rv.map((c) => c.name)).toEqual(
      expect.arrayContaining(["logical_id", "broken", "total", "checked_at"]),
    );
    const pcols = fresh.query("PRAGMA table_info(projects)").all() as Array<{
      name: string;
    }>;
    expect(pcols.some((c) => c.name === "last_refcheck_at")).toBe(true);
  });

  test("v74: knowledge_ref_anchor table exists / is restored after recovery", () => {
    // Drop the sidecar table, reopen, confirm recoverMissingObjects restores it
    // idempotently (same self-heal contract as knowledge_ref_validity /
    // knowledge_symbol_presence).
    db().exec("DROP TABLE IF EXISTS knowledge_ref_anchor");
    close();
    const fresh = db();
    const cols = fresh
      .query("PRAGMA table_info(knowledge_ref_anchor)")
      .all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toEqual(
      expect.arrayContaining(["logical_id", "kind", "anchor", "updated_at"]),
    );
  });

  test("session_prompt_deltas persist ordered selector/content rows (v42)", () => {
    const projectID = ensureProject("/tmp/lore-prompt-deltas");
    appendSessionPromptDelta({
      sessionID: "delta-session",
      projectID,
      selector: JSON.stringify({ target: "messages", insertAt: 3 }),
      content: JSON.stringify({ role: "user", content: [] }),
    });
    appendSessionPromptDelta({
      sessionID: "delta-session",
      projectID,
      selector: JSON.stringify({ target: "messages", insertAt: 7 }),
      content: JSON.stringify({ role: "user", content: [] }),
    });

    const rows = listSessionPromptDeltas("delta-session");
    expect(rows.map((r) => r.seq)).toEqual([0, 1]);
    expect(rows.map((r) => JSON.parse(r.selector).insertAt)).toEqual([3, 7]);
    expect(rows.every((r) => r.projectID === projectID)).toBe(true);
  });

  test("knowledge_tombstones table exists (migration v40)", () => {
    const names = (
      db().query("PRAGMA table_info(knowledge_tombstones)").all() as Array<{
        name: string;
      }>
    ).map((c) => c.name);
    expect(names).toContain("id");
    expect(names).toContain("project_id");
    expect(names).toContain("deleted_at");
  });

  test("entities table has embedding column (migration v34)", () => {
    const cols = (
      db().query("PRAGMA table_info(entities)").all() as Array<{
        name: string;
      }>
    ).map((c) => c.name);
    expect(cols).toContain("embedding");
  });

  test("dedup_feedback has kind discriminator defaulting to 'knowledge' (v34)", () => {
    const cols = db()
      .query("PRAGMA table_info(dedup_feedback)")
      .all() as Array<{
      name: string;
      dflt_value: string | null;
    }>;
    const kind = cols.find((c) => c.name === "kind");
    expect(kind).toBeDefined();
    // Rows inserted without an explicit kind are treated as knowledge feedback.
    db()
      .query(
        `INSERT INTO dedup_feedback
           (project_id, entry_a_title, entry_b_title, similarity, accepted, source, created_at)
         VALUES (NULL, 'a', 'b', 0.9, 1, 'cli_yes', ?)`,
      )
      .run(Date.now());
    const last = db()
      .query("SELECT kind FROM dedup_feedback ORDER BY id DESC LIMIT 1")
      .get() as { kind: string };
    expect(last.kind).toBe("knowledge");
    db().query("DELETE FROM dedup_feedback").run();
  });

  test("distillation_fts virtual table exists", () => {
    const tables = db()
      .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain("distillation_fts");
  });

  test("distillation_fts triggers exist for sync", () => {
    const triggers = db()
      .query(
        "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'distillation_fts_%' ORDER BY name",
      )
      .all() as Array<{ name: string }>;
    const names = triggers.map((t) => t.name);
    expect(names).toContain("distillation_fts_insert");
    expect(names).toContain("distillation_fts_delete");
    expect(names).toContain("distillation_fts_update");
  });

  test("all FTS5 tables use a language-neutral tokenizer (no English porter stemmer)", () => {
    const ftsTables = [
      "temporal_fts",
      "knowledge_fts",
      "distillation_fts",
      "lat_sections_fts",
      "entities_fts",
      "entity_aliases_fts",
    ];
    for (const name of ftsTables) {
      const row = db()
        .query("SELECT sql FROM sqlite_master WHERE type='table' AND name = ?")
        .get(name) as { sql: string } | undefined;
      expect(row, `${name} should exist`).toBeTruthy();
      // Must NOT use the English-only porter stemmer.
      expect(row?.sql).not.toContain("porter");
      // Must use unicode61 and preserve diacritics (Turkish letters are distinct).
      expect(row?.sql).toContain("unicode61");
      expect(row?.sql).toContain("remove_diacritics 0");
    }
  });

  test("Turkish content is searchable via FTS5 after the tokenizer change", () => {
    const pid = ensureProject("/tmp/lore-test-tr-fts");
    const now = Date.now();
    db()
      .query(
        `INSERT INTO knowledge (id, project_id, category, title, content, created_at, updated_at)
         VALUES (?, ?, 'preference', ?, ?, ?, ?)`,
      )
      .run(
        "tr-fts-1",
        pid,
        "Türkçe tercih",
        "Her zaman değişiklik için PR aç",
        now,
        now,
      );

    // A Turkish keyword with special letters must match (it would have been
    // mangled/split by the old porter+ASCII pipeline at the query layer).
    const hit = db()
      .query(
        `SELECT k.id FROM knowledge_fts f
         JOIN knowledge k ON k.rowid = f.rowid
         WHERE knowledge_fts MATCH ? AND k.project_id = ?`,
      )
      .get("değişiklik*", pid) as { id: string } | undefined;
    expect(hit?.id).toBe("tr-fts-1");
  });

  test("compound indexes exist for common query patterns", () => {
    const indexes = db()
      .query(
        "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%' ORDER BY name",
      )
      .all() as Array<{ name: string }>;
    const names = indexes.map((i) => i.name);
    // Compound indexes added in version 6
    expect(names).toContain("idx_temporal_project_session_distilled");
    expect(names).toContain("idx_temporal_project_distilled_created");
    expect(names).toContain("idx_distillation_project_session");
    expect(names).toContain("idx_distillation_project_session_gen_archived");
    // Redundant single-column indexes should be dropped
    expect(names).not.toContain("idx_temporal_project");
    expect(names).not.toContain("idx_temporal_distilled");
    expect(names).not.toContain("idx_distillation_project");
    // Version 58: covering indexes for the costs-page aggregates replaced the
    // narrow idx_temporal_session / idx_temporal_project_session, which are now
    // exact left-prefixes of the wider covering indexes and must be dropped.
    expect(names).toContain("idx_temporal_session_created_tokens");
    expect(names).toContain("idx_temporal_project_session_created");
    expect(names).not.toContain("idx_temporal_session");
    expect(names).not.toContain("idx_temporal_project_session");
  });

  test("ensureProject creates and returns id", () => {
    const id = ensureProject("/test/project/alpha");
    expect(id).toBeTruthy();
    expect(typeof id).toBe("string");
  });

  test("ensureProject returns same id for same path", () => {
    const id1 = ensureProject("/test/project/alpha");
    const id2 = ensureProject("/test/project/alpha");
    expect(id1).toBe(id2);
  });

  test("ensureProject creates different ids for different paths", () => {
    const id1 = ensureProject("/test/project/alpha");
    const id2 = ensureProject("/test/project/beta");
    expect(id1).not.toBe(id2);
  });

  test("projectId returns id for known path", () => {
    ensureProject("/test/project/gamma");
    const id = projectId("/test/project/gamma");
    expect(id).toBeTruthy();
  });

  test("isUnattributedProjectPath recognizes synthetic buckets", () => {
    expect(
      isUnattributedProjectPath(`${UNATTRIBUTED_PROJECT_PREFIX}/abc123`),
    ).toBe(true);
    expect(isUnattributedProjectPath(UNATTRIBUTED_PROJECT_PREFIX)).toBe(true);
    expect(isUnattributedProjectPath("/home/user/real-project")).toBe(false);
    // Must not match a real path that merely contains the segment elsewhere.
    expect(isUnattributedProjectPath("/home/__lore_unattributed__/x")).toBe(
      false,
    );
  });

  test("ensureProject gives unattributed buckets a provisional name", () => {
    const id = ensureProject(`${UNATTRIBUTED_PROJECT_PREFIX}/sessabcdef123456`);
    const row = db()
      .query("SELECT name FROM projects WHERE id = ?")
      .get(id) as { name: string };
    expect(row.name.startsWith("(unattributed)")).toBe(true);
    // Should not be the bare session ID as if it were a real repo.
    expect(row.name).not.toBe("sessabcdef123456");
  });

  test("projectId returns undefined for unknown path", () => {
    const id = projectId("/nonexistent/path");
    expect(id).toBeUndefined();
  });

  test("saveForceMinLayer persists and loadForceMinLayer retrieves", () => {
    saveForceMinLayer("test-session-persist", 2);
    expect(loadForceMinLayer("test-session-persist")).toBe(2);
  });

  test("saveForceMinLayer(0) deletes the row", () => {
    saveForceMinLayer("test-session-delete", 3);
    expect(loadForceMinLayer("test-session-delete")).toBe(3);
    saveForceMinLayer("test-session-delete", 0);
    expect(loadForceMinLayer("test-session-delete")).toBe(0);
  });

  test("loadForceMinLayer returns 0 for unknown session", () => {
    expect(loadForceMinLayer("nonexistent-session")).toBe(0);
  });

  test("kv_meta table exists (migration v8)", () => {
    const tables = db()
      .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).toContain("kv_meta");
  });

  test("metadata table exists (migration v13)", () => {
    const tables = db()
      .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).toContain("metadata");
  });

  test("getMeta returns null for unknown key", () => {
    expect(getMeta("nonexistent_key")).toBeNull();
  });

  test("setMeta and getMeta round-trip", () => {
    setMeta("test_key", "test_value");
    expect(getMeta("test_key")).toBe("test_value");
  });

  test("setMeta upserts on conflict", () => {
    setMeta("upsert_key", "first");
    expect(getMeta("upsert_key")).toBe("first");
    setMeta("upsert_key", "second");
    expect(getMeta("upsert_key")).toBe("second");
  });

  test("getInstanceId generates and persists UUID", () => {
    const id = getInstanceId();
    expect(id).toBeTruthy();
    expect(typeof id).toBe("string");
    // UUID v4 format
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    // Same value on subsequent calls
    expect(getInstanceId()).toBe(id);
  });

  test("db() re-initializes after close()", () => {
    // Ensure the singleton is populated
    const first = db();
    expect(first).toBeDefined();

    // Close resets the singleton
    close();

    // Next call should re-create and re-migrate — not return a stale handle
    const second = db();
    expect(second).toBeDefined();

    // Verify the new instance is fully migrated (kv_meta exists)
    const row = second
      .query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='kv_meta'",
      )
      .get() as { name: string } | null;
    expect(row).not.toBeNull();
    expect(row?.name).toBe("kv_meta");
  });

  test("recoverMissingObjects creates kv_meta and metadata when version=latest but tables are missing", () => {
    // Simulate the exact scenario: DB at current version but tables missing
    // due to a partial migration (ALTER TABLE duplicate column aborted exec
    // before CREATE TABLE).
    const d = db();

    // Drop both tables to simulate the broken state
    d.exec("DROP TABLE IF EXISTS kv_meta");
    d.exec("DROP TABLE IF EXISTS metadata");
    expect(
      d
        .query(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='kv_meta'",
        )
        .get(),
    ).toBeNull();
    expect(
      d
        .query(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='metadata'",
        )
        .get(),
    ).toBeNull();

    // Close and re-open — migrate() should recover the missing tables
    close();
    const fresh = db();
    const afterKv = fresh
      .query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='kv_meta'",
      )
      .get() as { name: string } | null;
    expect(afterKv).not.toBeNull();
    expect(afterKv?.name).toBe("kv_meta");

    const afterMeta = fresh
      .query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='metadata'",
      )
      .get() as { name: string } | null;
    expect(afterMeta).not.toBeNull();
    expect(afterMeta?.name).toBe("metadata");
  });

  // -------------------------------------------------------------------------
  // Migration v14: git-based project identification
  // -------------------------------------------------------------------------

  test("projects table has git_remote column (migration v14)", () => {
    const cols = db().query("PRAGMA table_info(projects)").all() as Array<{
      name: string;
    }>;
    expect(cols.map((c) => c.name)).toContain("git_remote");
  });

  test("project_path_aliases table exists (migration v14)", () => {
    const tables = db()
      .query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='project_path_aliases'",
      )
      .all() as Array<{ name: string }>;
    expect(tables.length).toBe(1);
  });

  test("idx_projects_git_remote index exists (migration v14)", () => {
    const indexes = db()
      .query(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_projects_git_remote'",
      )
      .all() as Array<{ name: string }>;
    expect(indexes.length).toBe(1);
  });

  test("ensureProject stores git_remote as null for non-git paths", () => {
    const id = ensureProject("/test/non-git/project-v14");
    const row = db()
      .query("SELECT git_remote FROM projects WHERE id = ?")
      .get(id) as { git_remote: string | null };
    expect(row.git_remote).toBeNull();
  });

  test("projectId resolves via project_path_aliases", () => {
    // Manually create a project and alias
    const id = ensureProject("/test/alias/original");
    db()
      .query(
        "INSERT OR IGNORE INTO project_path_aliases (path, project_id) VALUES (?, ?)",
      )
      .run("/test/alias/worktree", id);

    // projectId should resolve the alias
    expect(projectId("/test/alias/worktree")).toBe(id);
  });

  // Regression (LOREAI-GATEWAY-3K): the hot request path resolves the same
  // worktree/alias path many times per turn. ensureProject/projectId memoize
  // path→id per connection; the memo must be honored AND invalidated correctly.
  describe("project id memoization (#3K)", () => {
    test("serves a resolved alias path from the memo until it is invalidated", () => {
      const canonical = "/test/memo/canonical";
      const worktree = "/test/memo/worktree";
      const id = ensureProject(canonical);
      db()
        .query(
          "INSERT OR IGNORE INTO project_path_aliases (path, project_id) VALUES (?, ?)",
        )
        .run(worktree, id);

      // First resolve caches worktree→id via the (stable) alias branch.
      expect(ensureProject(worktree)).toBe(id);

      // Remove the alias row WITHOUT invalidating the memo. If the memo is live,
      // a cache HIT still returns the old id even though the DB no longer has
      // the alias — this is what proves the lookups are actually memoized.
      db()
        .query("DELETE FROM project_path_aliases WHERE path = ?")
        .run(worktree);
      expect(ensureProject(worktree)).toBe(id); // served from memo
      expect(projectId(worktree)).toBe(id); // shared memo

      // After explicit invalidation the stale mapping is gone → the now-orphan
      // worktree path resolves fresh (a brand-new project).
      invalidateProjectIdCache();
      expect(ensureProject(worktree)).not.toBe(id);
    });

    test("deleteProject invalidates the memo so a reused path is never a dangling id", () => {
      const canonical = "/test/memo-del/canonical";
      const worktree = "/test/memo-del/worktree";
      const id1 = ensureProject(canonical);
      db()
        .query(
          "INSERT OR IGNORE INTO project_path_aliases (path, project_id) VALUES (?, ?)",
        )
        .run(worktree, id1);
      db()
        .query(
          "INSERT INTO project_id_aliases (retired_id, project_id) VALUES (?, ?)",
        )
        .run("retired-before-delete", id1);
      expect(ensureProject(worktree)).toBe(id1); // prime the memo

      deleteProject(id1);

      // The memo must have been cleared: the path resolves to a FRESH project,
      // never the deleted id, and the returned id must actually exist (a stale
      // memo would hand back id1 and FK-violate on the next temporal write).
      const id2 = ensureProject(worktree);
      expect(id2).not.toBe(id1);
      expect(
        db().query("SELECT 1 AS n FROM projects WHERE id = ?").get(id2),
      ).toBeTruthy();
      expect(
        db()
          .query(
            "SELECT project_id FROM project_id_aliases WHERE retired_id = ?",
          )
          .get("retired-before-delete"),
      ).toBeNull();
    });

    test("mergeProjectInternal invalidates the memo (source path resolves to the winner, not the deleted source)", () => {
      const loserPath = "/test/memo-merge/loser";
      const winnerPath = "/test/memo-merge/winner";
      const loser = ensureProject(loserPath);
      const winner = ensureProject(winnerPath);
      // Make the loser remote-backed so its settled exact-path row is memoized
      // (a remote-less row is intentionally never cached).
      db()
        .query("UPDATE projects SET git_remote = ? WHERE id = ?")
        .run("github.com/test/memo-merge", loser);
      expect(ensureProject(loserPath)).toBe(loser); // primes the memo

      // Merge deletes the loser row and re-points loserPath as an alias→winner.
      // Without invalidation the memo would keep serving the DELETED loser id —
      // a dangling FK target for the next temporal/knowledge write.
      mergeProjectInternal(loser, winner);

      expect(ensureProject(loserPath)).toBe(winner);
      expect(projectId(loserPath)).toBe(winner);
    });

    test("does not publish an alias to the memo before its transaction commits", () => {
      enableHostedMode();
      try {
        const canonical = `/test/memo-rollback/canonical-${crypto.randomUUID()}`;
        const worktree = `/test/memo-rollback/worktree-${crypto.randomUUID()}`;
        const remote = `github.com/test/memo-rollback-${crypto.randomUUID()}`;
        const id = ensureProject(canonical, undefined, remote);

        withSavepoint("project_alias_publication", () => {
          expect(ensureProject(worktree, undefined, remote)).toBe(id);
          // Delete the still-uncommitted alias directly. If ensureProject had
          // speculatively memoized it, projectId would keep returning `id` even
          // though no SQL row now supports that mapping.
          db()
            .query("DELETE FROM project_path_aliases WHERE path = ?")
            .run(worktree);
          expect(projectId(worktree)).toBeUndefined();
        });
      } finally {
        _resetHostedModeForTest();
      }
    });

    test("does not publish a lookup under a data version committed after its query", () => {
      const path = `/test/query-memo-race-${crypto.randomUUID()}`;
      const movedPath = `${path}-moved`;
      const oldId = crypto.randomUUID();
      db()
        .query(
          "INSERT INTO projects (id, path, name, git_remote, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(
          oldId,
          path,
          "old owner",
          `github.com/test/query-memo-race-${crypto.randomUUID()}`,
          Date.now(),
        );
      invalidateProjectIdCache();

      const freshId = crypto.randomUUID();
      const external = new DatabaseSync(process.env.LORE_DB_PATH as string);
      external.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON");
      let reassigned = false;
      registerSink({
        ...passthroughLogSink,
        withDbSpan<T>(sql: string, fn: () => T): T {
          const result = fn();
          if (
            !reassigned &&
            sql.includes("SELECT id, git_remote FROM projects") &&
            sql.includes("path = ?")
          ) {
            reassigned = true;
            external.exec("BEGIN IMMEDIATE");
            external
              .prepare("UPDATE projects SET path = ? WHERE id = ?")
              .run(movedPath, oldId);
            external
              .prepare(
                "INSERT INTO projects (id, path, name, created_at) VALUES (?, ?, ?, ?)",
              )
              .run(freshId, path, "fresh owner", Date.now());
            external.exec("COMMIT");
          }
          return result;
        },
      });
      try {
        // This query legitimately saw oldId, but the external commit lands
        // after the SQL completes and before memo publication.
        expect(projectId(path)).toBe(oldId);
      } finally {
        registerSink(passthroughLogSink);
        external.close();
      }

      expect(reassigned).toBe(true);
      // The lookup-start data_version must invalidate the stale result here.
      expect(projectId(path)).toBe(freshId);
    });
  });

  test("ensureProject deduplicates via git_remote", () => {
    // Guard: this test inserts a synthetic /test/... project path via raw SQL,
    // which bypasses ensureProject()'s production-DB guard. If LORE_DB_PATH is
    // not set, we'd be writing into the real production DB — fail loudly rather
    // than leaking a /test/... row that later breaks `lore data dedup`.
    if (!process.env.LORE_DB_PATH) {
      throw new Error(
        "test DB not isolated: LORE_DB_PATH must be set (see packages/core/test/setup.ts)",
      );
    }
    // Manually insert a project with a git_remote
    const id1 = crypto.randomUUID();
    db()
      .query(
        "INSERT INTO projects (id, path, name, git_remote, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        id1,
        "/test/git-dedup/original",
        "original",
        "github.com/test/dedup-repo",
        Date.now(),
      );

    // Mock getGitRemote by pre-populating the cache
    // (getGitRemote for /test/git-dedup/worktree would return null since it's
    // not a real path, so we test via direct DB manipulation instead)

    // Simulate: another path has same git_remote. ensureProject should find
    // the existing project when looking up by git_remote.
    // Since we can't easily mock getGitRemote in the same module, we test
    // the alias path: register an alias, then verify it resolves.
    db()
      .query(
        "INSERT OR IGNORE INTO project_path_aliases (path, project_id) VALUES (?, ?)",
      )
      .run("/test/git-dedup/worktree", id1);

    const id2 = ensureProject("/test/git-dedup/worktree");
    expect(id2).toBe(id1);
  });

  // A client-supplied git remote is only trusted in HOSTED mode (the gateway
  // can't read the client's disk). In local mode it is reconciled against the
  // on-disk repo and DROPPED for non-repo paths — see the dedicated
  // "git-remote magnet guard" block below.
  describe("supplied gitRemote (hosted mode)", () => {
    beforeEach(() => {
      enableHostedMode();
    });
    afterEach(() => {
      _resetHostedModeForTest();
    });

    test("groups different paths via supplied remote", () => {
      // Simulates a remote/hosted gateway receiving the X-Lore-Git-Remote
      // header from a client — the path is on the client's disk, not ours.
      const id1 = ensureProject(
        "/test/supplied-remote/path-a",
        undefined,
        "github.com/test/supplied-remote-repo",
      );

      const row = db()
        .query("SELECT git_remote FROM projects WHERE id = ?")
        .get(id1) as { git_remote: string | null };
      expect(row.git_remote).toBe("github.com/test/supplied-remote-repo");

      // A different path with the same supplied git remote resolves to the
      // same project (step 3 git-remote match) and registers an alias.
      const id2 = ensureProject(
        "/test/supplied-remote/path-b",
        undefined,
        "github.com/test/supplied-remote-repo",
      );
      expect(id2).toBe(id1);

      const alias = db()
        .query("SELECT project_id FROM project_path_aliases WHERE path = ?")
        .get("/test/supplied-remote/path-b") as { project_id: string } | null;
      expect(alias).not.toBeNull();
      expect(alias?.project_id).toBe(id1);
    });

    test("backfills existing project", () => {
      const id1 = ensureProject("/test/backfill-remote/original");
      const rowBefore = db()
        .query("SELECT git_remote FROM projects WHERE id = ?")
        .get(id1) as { git_remote: string | null };
      expect(rowBefore.git_remote).toBeNull();

      const id2 = ensureProject(
        "/test/backfill-remote/original",
        undefined,
        "github.com/test/backfill-repo",
      );
      expect(id2).toBe(id1);

      const rowAfter = db()
        .query("SELECT git_remote FROM projects WHERE id = ?")
        .get(id1) as { git_remote: string | null };
      expect(rowAfter.git_remote).toBe("github.com/test/backfill-repo");
    });

    test("memoizes the mapping after a successful git_remote backfill (#3K)", () => {
      const path = "/test/backfill-cache/original";
      const id = ensureProject(path); // remote-less create → left uncached
      // The backfill settles git_remote and, per the #3K memo, caches path→id.
      expect(
        ensureProject(path, undefined, "github.com/test/backfill-cache"),
      ).toBe(id);
      const queries: string[] = [];
      registerSink({
        ...passthroughLogSink,
        withDbSpan<T>(sql: string, fn: () => T): T {
          queries.push(sql);
          return fn();
        },
      });
      try {
        expect(
          ensureProject(path, undefined, "github.com/test/backfill-cache"),
        ).toBe(id);
        expect(queries).toContain("PRAGMA data_version");
        expect(
          queries.some((sql) =>
            sql.includes("SELECT id, git_remote FROM projects WHERE path = ?"),
          ),
        ).toBe(false);
      } finally {
        registerSink(passthroughLogSink);
      }
    });

    test("external path reassignment invalidates a live cached UUID", () => {
      const path = `/test/external-path-owner-${crypto.randomUUID()}`;
      const movedPath = `${path}-moved`;
      const oldId = ensureProject(
        path,
        undefined,
        `github.com/test/external-path-${crypto.randomUUID()}`,
      );
      expect(projectId(path)).toBe(oldId); // prime the remote-backed memo

      const freshId = crypto.randomUUID();
      const external = new DatabaseSync(process.env.LORE_DB_PATH as string);
      try {
        external.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON");
        external.exec("BEGIN IMMEDIATE");
        external
          .prepare("UPDATE projects SET path = ? WHERE id = ?")
          .run(movedPath, oldId);
        external
          .prepare(
            "INSERT INTO projects (id, path, name, created_at) VALUES (?, ?, ?, ?)",
          )
          .run(freshId, path, "fresh external owner", Date.now());
        external.exec("COMMIT");
      } finally {
        external.close();
      }

      expect(projectId(path)).toBe(freshId);
      expect(ensureProject(path)).toBe(freshId);
    });
  });

  test("committed canonical reads stay bound to the live database path", () => {
    const sourceId = ensureProject(
      `/test/committed-reader-source-${crypto.randomUUID()}`,
    );
    const targetId = ensureProject(
      `/test/committed-reader-target-${crypto.randomUUID()}`,
    );
    mergeProjectInternal(sourceId, targetId);

    const originalPath = process.env.LORE_DB_PATH;
    process.env.LORE_DB_PATH = ":memory:";
    try {
      withSavepoint("committed_reader_live_path", () => {
        expect(canonicalProjectId(sourceId, { committed: true })).toBe(
          targetId,
        );
      });
    } finally {
      if (originalPath === undefined) delete process.env.LORE_DB_PATH;
      else process.env.LORE_DB_PATH = originalPath;
    }
  });

  test("committed canonical reads fail closed for private in-memory databases", () => {
    const originalPath = process.env.LORE_DB_PATH;
    close();
    try {
      const memoryPaths = [
        ":memory:",
        `file:lore-committed-${crypto.randomUUID()}?mode=memory&cache=shared`,
      ];
      for (const [index, memoryPath] of memoryPaths.entries()) {
        process.env.LORE_DB_PATH = memoryPath;
        const sourceId = ensureProject(`/test/in-memory-source-${index}`);
        const targetId = ensureProject(`/test/in-memory-target-${index}`);
        withSavepoint("in_memory_committed_reader", () => {
          mergeProjectInternal(sourceId, targetId);
          expect(
            canonicalProjectId(sourceId, { committed: true }),
          ).toBeUndefined();
        });
        close();
      }
    } finally {
      close();
      if (originalPath === undefined) delete process.env.LORE_DB_PATH;
      else process.env.LORE_DB_PATH = originalPath;
    }
  });

  // Regression: the "git-remote magnet" bug. A non-repo path (e.g. a parent
  // dir full of loose scripts) must NEVER acquire a client-supplied remote on
  // a LOCAL gateway, or it becomes a bucket that swallows every project later
  // sending that same remote.
  describe("git-remote magnet guard (local mode)", () => {
    afterEach(() => {
      _resetHostedModeForTest();
    });

    test("does NOT attach a client remote to a non-repo path", () => {
      // Local mode (hosted OFF by default). /test/... is not a git repo, so
      // getGitRemote() returns null → the supplied remote must be dropped.
      const id = ensureProject(
        "/test/magnet/non-repo-a",
        undefined,
        "github.com/BYK/loreai",
      );
      const row = db()
        .query("SELECT git_remote FROM projects WHERE id = ?")
        .get(id) as { git_remote: string | null };
      expect(row.git_remote).toBeNull();
    });

    test("a non-repo path cannot become a magnet for same-remote paths", () => {
      // First non-repo path with a supplied remote (dropped → no remote).
      const idA = ensureProject(
        "/test/magnet/non-repo-b",
        undefined,
        "github.com/BYK/somerepo",
      );
      // A second, unrelated non-repo path sending the SAME remote must get its
      // OWN project — NOT be aliased into the first.
      const idB = ensureProject(
        "/test/magnet/non-repo-c",
        undefined,
        "github.com/BYK/somerepo",
      );
      expect(idB).not.toBe(idA);
      const aliased = db()
        .query("SELECT project_id FROM project_path_aliases WHERE path = ?")
        .get("/test/magnet/non-repo-c") as { project_id: string } | null;
      expect(aliased).toBeNull();
    });

    test("does NOT backfill a client remote onto an existing non-repo row", () => {
      const id = ensureProject("/test/magnet/backfill-non-repo");
      // Re-visit with a supplied remote — local + non-repo → must stay null.
      ensureProject(
        "/test/magnet/backfill-non-repo",
        undefined,
        "github.com/BYK/loreai",
      );
      const row = db()
        .query("SELECT git_remote FROM projects WHERE id = ?")
        .get(id) as { git_remote: string | null };
      expect(row.git_remote).toBeNull();
    });

    test("still trusts the supplied remote in hosted mode (can't read disk)", () => {
      enableHostedMode();
      const id = ensureProject(
        "/test/magnet/hosted-non-repo",
        undefined,
        "github.com/BYK/loreai",
      );
      const row = db()
        .query("SELECT git_remote FROM projects WHERE id = ?")
        .get(id) as { git_remote: string | null };
      expect(row.git_remote).toBe("github.com/BYK/loreai");
    });
  });

  test("ensureProject with supplied gitRemote=null falls through to create", () => {
    // Passing null explicitly should behave like not passing it at all
    // (no git remote, no deduplication by remote).
    const id = ensureProject("/test/null-remote/project", undefined, null);
    const row = db()
      .query("SELECT git_remote FROM projects WHERE id = ?")
      .get(id) as { git_remote: string | null };
    expect(row.git_remote).toBeNull();
  });

  test("mergeProjectInternal moves all data from source to target", () => {
    // Create two projects
    const sourceId = ensureProject("/test/merge/source");
    const targetId = ensureProject("/test/merge/target");

    // Add some data to source
    db()
      .query(
        "INSERT INTO temporal_messages (id, project_id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        crypto.randomUUID(),
        sourceId,
        "session-merge",
        "user",
        "test message",
        Date.now(),
      );

    db()
      .query(
        "INSERT INTO knowledge (id, project_id, category, title, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        crypto.randomUUID(),
        sourceId,
        "pattern",
        "Test",
        "test content",
        Date.now(),
        Date.now(),
      );

    // Outcome-reward injection log row scoped to the source project (#996): it
    // must follow the entries to the target, not orphan when source is deleted.
    db()
      .query(
        "INSERT INTO knowledge_session_injections (session_id, logical_id, project_id, created_at, credited) VALUES (?, ?, ?, ?, 0)",
      )
      .run("session-merge", crypto.randomUUID(), sourceId, Date.now());

    // Verify source has data
    const sourceMsgsBefore = (
      db()
        .query(
          "SELECT COUNT(*) as c FROM temporal_messages WHERE project_id = ?",
        )
        .get(sourceId) as { c: number }
    ).c;
    expect(sourceMsgsBefore).toBe(1);

    const sourceKnowledgeBefore = (
      db()
        .query("SELECT COUNT(*) as c FROM knowledge WHERE project_id = ?")
        .get(sourceId) as { c: number }
    ).c;
    expect(sourceKnowledgeBefore).toBe(1);

    // Merge source into target
    mergeProjectInternal(sourceId, targetId);

    // Source should be deleted
    const sourceRow = db()
      .query("SELECT id FROM projects WHERE id = ?")
      .get(sourceId);
    expect(sourceRow).toBeNull();

    // Target should have the data
    const targetMsgs = (
      db()
        .query(
          "SELECT COUNT(*) as c FROM temporal_messages WHERE project_id = ?",
        )
        .get(targetId) as { c: number }
    ).c;
    expect(targetMsgs).toBe(1);

    const targetKnowledge = (
      db()
        .query("SELECT COUNT(*) as c FROM knowledge WHERE project_id = ?")
        .get(targetId) as { c: number }
    ).c;
    expect(targetKnowledge).toBe(1);

    // Injection log must have moved to target — none left orphaned under source
    // (#996). If unmoved, these rows become permanently unreachable once the
    // source project row is deleted, and outcome-reward crediting breaks.
    const sourceInjections = (
      db()
        .query(
          "SELECT COUNT(*) as c FROM knowledge_session_injections WHERE project_id = ?",
        )
        .get(sourceId) as { c: number }
    ).c;
    expect(sourceInjections).toBe(0);
    const targetInjections = (
      db()
        .query(
          "SELECT COUNT(*) as c FROM knowledge_session_injections WHERE project_id = ?",
        )
        .get(targetId) as { c: number }
    ).c;
    expect(targetInjections).toBe(1);

    // Source path should be registered as alias of target
    const alias = db()
      .query("SELECT project_id FROM project_path_aliases WHERE path = ?")
      .get("/test/merge/source") as { project_id: string } | null;
    expect(alias).not.toBeNull();
    expect(alias?.project_id).toBe(targetId);
    expect(canonicalProjectId(sourceId)).toBe(targetId);
  });

  test("project self-merges preserve the project and all scoped data", () => {
    const project = ensureProject("/test/merge/self");
    db()
      .query(
        "INSERT INTO temporal_messages (id, project_id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        crypto.randomUUID(),
        project,
        "session-self-merge",
        "user",
        "must survive",
        Date.now(),
      );
    const mutations: unknown[] = [];
    const unsubscribe = onProjectMutation((mutation) =>
      mutations.push(mutation),
    );

    try {
      mergeProjectInternal(project, project);
      expect(mergeProjects(project, project)).toEqual({
        knowledge_moved: 0,
        messages_moved: 0,
        distillations_moved: 0,
      });

      expect(
        db().query("SELECT path FROM projects WHERE id = ?").get(project),
      ).toEqual({ path: "/test/merge/self" });
      expect(
        db()
          .query("SELECT content FROM temporal_messages WHERE project_id = ?")
          .all(project),
      ).toEqual([{ content: "must survive" }]);
      expect(mutations).toEqual([]);
    } finally {
      unsubscribe();
    }
  });

  test("project ID redirects flatten transitive merges and ignore stale sources", () => {
    const source = ensureProject("/test/merge-id-alias/source");
    const middle = ensureProject("/test/merge-id-alias/middle");
    const target = ensureProject("/test/merge-id-alias/target");
    const staleTarget = ensureProject("/test/merge-id-alias/stale-target");

    mergeProjectInternal(source, middle);
    mergeProjectInternal(middle, target);
    mergeProjectInternal(source, staleTarget);

    expect(canonicalProjectId(source)).toBe(target);
    expect(canonicalProjectId(middle)).toBe(target);
    expect(canonicalProjectId(target)).toBe(target);
    expect(
      db()
        .query(
          "SELECT retired_id, project_id FROM project_id_aliases WHERE retired_id IN (?, ?) ORDER BY retired_id",
        )
        .all(source, middle),
    ).toEqual(
      [
        { retired_id: source, project_id: target },
        { retired_id: middle, project_id: target },
      ].sort((a, b) => a.retired_id.localeCompare(b.retired_id)),
    );
  });

  test("mergeProjectInternal covers every project-scoped table", () => {
    const d = db();
    expect(Object.isFrozen(PROJECT_MERGE_TABLES)).toBe(true);
    const tables = (
      d
        .query(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
        )
        .all() as Array<{ name: string }>
    )
      .map((row) => row.name)
      .filter(
        (name) =>
          !name.startsWith("temporal_vec_") &&
          !name.startsWith("distillation_vec_"),
      );
    const projectScoped = tables.filter((table) => {
      const quoted = table.replaceAll('"', '""');
      const columns = d.query(`PRAGMA table_info("${quoted}")`).all() as Array<{
        name: string;
      }>;
      return columns.some(
        (column) =>
          column.name === "project_id" ||
          column.name === "recalled_in_project_id",
      );
    });
    const registered = PROJECT_MERGE_TABLES.filter((table) =>
      tables.includes(table),
    );
    expect(projectScoped.sort()).toEqual([...registered].sort());
  });

  test("mergeProjectInternal preserves collision-prone project sidecars", () => {
    const d = db();
    const sourceId = ensureProject("/test/merge-sidecars/source");
    const targetId = ensureProject("/test/merge-sidecars/target");
    const sourceCounts = Array.from({ length: 21 }, () => 1);
    const targetCounts = Array.from({ length: 21 }, () => 2);

    d.query(
      `INSERT INTO session_prompt_deltas
         (session_id, seq, project_id, selector, content)
       VALUES ('source-session', 1, ?, 'after-system', 'source delta')`,
    ).run(sourceId);
    d.query(
      `INSERT INTO import_history
         (id, project_id, agent_name, source_id, source_hash,
          entries_created, entries_updated, imported_at)
       VALUES ('target-import', ?, 'opencode', 'shared', 'old', 1, 2, 100),
              ('source-import', ?, 'opencode', 'shared', 'new', 3, 4, 200),
              ('source-only-import', ?, 'claude', 'unique', 'only', 5, 6, 150)`,
    ).run(targetId, sourceId, sourceId);
    d.query(
      `INSERT INTO warmup_histograms
         (project_id, time_slot, counts, total, updated_at)
       VALUES (?, 'all', ?, 21, 100), (?, 'all', ?, 42, 200)`,
    ).run(
      sourceId,
      JSON.stringify(sourceCounts),
      targetId,
      JSON.stringify(targetCounts),
    );
    d.query(
      `INSERT INTO dedup_feedback
         (project_id, entry_a_title, entry_b_title, similarity, accepted,
          source, created_at, kind)
       VALUES (?, 'source-a', 'source-b', 0.9, 1, 'manual', 100, 'knowledge'),
              (?, 'target-a', 'target-b', 0.8, 0, 'manual', 200, 'knowledge')`,
    ).run(sourceId, targetId);
    d.query(
      `INSERT INTO knowledge_tombstones (id, project_id, deleted_at)
       VALUES ('source-tombstone', ?, 100), ('target-tombstone', ?, 200)`,
    ).run(sourceId, targetId);
    d.query(
      `INSERT INTO cache_bust_stats
         (project_id, cause, relocatable, turns, write_tokens, updated_at)
       VALUES (?, 'system-host-change', 1, 2, 20, 100),
              (?, 'system-host-change', 1, 3, 30, 200)`,
    ).run(sourceId, targetId);
    d.query(
      `INSERT INTO knowledge_contradictions
         (logical_id_a, logical_id_b, project_id, similarity, status,
          detected_at, updated_at)
       VALUES ('source-a', 'source-b', ?, 0.9, 'open', 100, 100),
              ('target-a', 'target-b', ?, 0.8, 'resolved', 200, 200)`,
    ).run(sourceId, targetId);

    mergeProjectInternal(sourceId, targetId);

    for (const table of [
      "session_prompt_deltas",
      "import_history",
      "warmup_histograms",
      "dedup_feedback",
      "knowledge_tombstones",
      "cache_bust_stats",
      "knowledge_contradictions",
    ]) {
      const quoted = table.replaceAll('"', '""');
      const source = d
        .query(`SELECT COUNT(*) AS count FROM "${quoted}" WHERE project_id = ?`)
        .get(sourceId) as { count: number };
      expect(source.count, table).toBe(0);
    }
    expect(
      d
        .query(
          "SELECT project_id FROM session_prompt_deltas WHERE session_id = 'source-session'",
        )
        .get(),
    ).toEqual({ project_id: targetId });
    expect(
      d
        .query(
          `SELECT source_hash, entries_created, entries_updated, imported_at
             FROM import_history
            WHERE project_id = ? AND agent_name = 'opencode' AND source_id = 'shared'`,
        )
        .get(targetId),
    ).toEqual({
      source_hash: "new",
      entries_created: 3,
      entries_updated: 4,
      imported_at: 200,
    });
    expect(
      d
        .query(
          "SELECT COUNT(*) AS count FROM import_history WHERE project_id = ?",
        )
        .get(targetId),
    ).toEqual({ count: 2 });
    const histogram = d
      .query(
        "SELECT counts, total, updated_at FROM warmup_histograms WHERE project_id = ? AND time_slot = 'all'",
      )
      .get(targetId) as { counts: string; total: number; updated_at: number };
    expect(JSON.parse(histogram.counts)).toEqual(
      Array.from({ length: 21 }, () => 3),
    );
    expect(histogram).toMatchObject({ total: 63, updated_at: 200 });
    expect(
      d
        .query(
          "SELECT COUNT(*) AS count FROM dedup_feedback WHERE project_id = ?",
        )
        .get(targetId),
    ).toEqual({ count: 2 });
    expect(
      d
        .query(
          "SELECT COUNT(*) AS count FROM knowledge_tombstones WHERE project_id = ?",
        )
        .get(targetId),
    ).toEqual({ count: 2 });
    expect(
      d
        .query(
          `SELECT turns, write_tokens, updated_at FROM cache_bust_stats
            WHERE project_id = ? AND cause = 'system-host-change' AND relocatable = 1`,
        )
        .get(targetId),
    ).toEqual({ turns: 5, write_tokens: 50, updated_at: 200 });
    expect(
      d
        .query(
          "SELECT COUNT(*) AS count FROM knowledge_contradictions WHERE project_id = ?",
        )
        .get(targetId),
    ).toEqual({ count: 2 });
  });

  test("mergeProjectInternal rebuilds colliding session rollups from source rows", () => {
    const d = db();
    const sourceId = ensureProject("/test/merge-rollup/source");
    const targetId = ensureProject("/test/merge-rollup/target");
    const sessionId = "shared-rollup-session";
    d.query(
      `INSERT INTO temporal_messages
         (id, project_id, session_id, role, content, tokens, created_at)
       VALUES ('source-rollup-message', ?, ?, 'user', 'source', 5, 100),
              ('target-rollup-message', ?, ?, 'assistant', 'target', 7, 200)`,
    ).run(sourceId, sessionId, targetId, sessionId);
    expect(
      d
        .query(
          "SELECT COUNT(*) AS count FROM session_rollup WHERE session_id = ?",
        )
        .get(sessionId),
    ).toEqual({ count: 2 });

    mergeProjectInternal(sourceId, targetId);

    expect(
      d
        .query(
          `SELECT project_id, message_count, token_sum, first_message_at,
                  last_message_at, first_assistant_metadata, dirty
             FROM session_rollup WHERE session_id = ?`,
        )
        .all(sessionId),
    ).toEqual([
      {
        project_id: targetId,
        message_count: 2,
        token_sum: 12,
        first_message_at: 100,
        last_message_at: 200,
        first_assistant_metadata: null,
        dirty: 0,
      },
    ]);
  });

  test("mergeProjectInternal never combines invalid warmup histograms", () => {
    const d = db();
    const sourceId = ensureProject("/test/merge-histogram/source");
    const targetId = ensureProject("/test/merge-histogram/target");
    const valid = JSON.stringify(Array.from({ length: 21 }, () => 2));
    const invalid = new Map<string, string>([
      ["wrong-length", JSON.stringify([1, 1])],
      [
        "non-finite",
        `[${Array.from({ length: 21 }, () => "1")
          .slice(0, 20)
          .join(",")},1e400]`,
      ],
      ["malformed", "{bad"],
      [
        "negative",
        JSON.stringify([-1, ...Array.from({ length: 20 }, () => 1)]),
      ],
      [
        "fractional",
        JSON.stringify([0.5, ...Array.from({ length: 20 }, () => 1)]),
      ],
    ]);
    for (const [slot, counts] of invalid) {
      d.query(
        `INSERT INTO warmup_histograms
           (project_id, time_slot, counts, total, updated_at)
         VALUES (?, ?, ?, 21, 100), (?, ?, ?, 42, 200)`,
      ).run(sourceId, slot, counts, targetId, slot, valid);
    }

    mergeProjectInternal(sourceId, targetId);

    const rows = d
      .query(
        "SELECT time_slot, counts, total, updated_at FROM warmup_histograms WHERE project_id = ? ORDER BY time_slot",
      )
      .all(targetId) as Array<{
      time_slot: string;
      counts: string;
      total: number;
      updated_at: number;
    }>;
    expect(rows).toHaveLength(invalid.size);
    for (const row of rows) {
      expect(row.counts, row.time_slot).toBe(valid);
      expect(row.total, row.time_slot).toBe(42);
      expect(row.updated_at, row.time_slot).toBe(200);
    }
  });

  test("mergeProjectInternal makes the source canonical path target the winner", () => {
    const d = db();
    const sourcePath = "/test/merge-alias-conflict/source";
    const sourceId = ensureProject(sourcePath);
    const targetId = ensureProject("/test/merge-alias-conflict/target");
    const unrelatedId = ensureProject("/test/merge-alias-conflict/unrelated");
    d.query(
      "INSERT INTO project_path_aliases (path, project_id) VALUES (?, ?)",
    ).run(sourcePath, unrelatedId);

    mergeProjectInternal(sourceId, targetId);

    expect(projectId(sourcePath)).toBe(targetId);
    expect(
      d
        .query("SELECT project_id FROM project_path_aliases WHERE path = ?")
        .get(sourcePath),
    ).toEqual({ project_id: targetId });
  });

  test("mergeProjectInternal rejects 64-bit counter overflow atomically", () => {
    const d = db();
    const cacheSource = ensureProject("/test/merge-overflow/cache-source");
    const cacheTarget = ensureProject("/test/merge-overflow/cache-target");
    d.exec(`
      INSERT INTO cache_bust_stats
        (project_id, cause, relocatable, turns, write_tokens, updated_at)
      VALUES ('${cacheSource}', 'overflow', 0, 1, 1, 100),
             ('${cacheTarget}', 'overflow', 0, 9223372036854775807,
              9223372036854775807, 200);
    `);
    expect(() => mergeProjectInternal(cacheSource, cacheTarget)).toThrow(
      /counter overflow/,
    );
    expect(
      d
        .query("SELECT COUNT(*) AS count FROM projects WHERE id IN (?, ?)")
        .get(cacheSource, cacheTarget),
    ).toEqual({ count: 2 });
    expect(
      d
        .query(
          "SELECT COUNT(*) AS count FROM cache_bust_stats WHERE project_id IN (?, ?)",
        )
        .get(cacheSource, cacheTarget),
    ).toEqual({ count: 2 });

    const transferSource = ensureProject(
      "/test/merge-overflow/transfer-source",
    );
    const transferTarget = ensureProject(
      "/test/merge-overflow/transfer-target",
    );
    d.exec(`
      INSERT INTO knowledge_transfers
        (knowledge_id, recalled_in_project_id, hit_count,
         first_recalled_at, last_recalled_at)
      VALUES ('overflow-entry', '${transferSource}', 1, 100, 100),
             ('overflow-entry', '${transferTarget}', 9223372036854775807,
              200, 200);
    `);
    expect(() => mergeProjectInternal(transferSource, transferTarget)).toThrow(
      /counter overflow/,
    );
    expect(
      d
        .query("SELECT COUNT(*) AS count FROM projects WHERE id IN (?, ?)")
        .get(transferSource, transferTarget),
    ).toEqual({ count: 2 });
    expect(
      d
        .query(
          "SELECT COUNT(*) AS count FROM knowledge_transfers WHERE recalled_in_project_id IN (?, ?)",
        )
        .get(transferSource, transferTarget),
    ).toEqual({ count: 2 });
  });

  test.each([
    ["turns", 1.5, 2],
    ["write tokens", 1, 2.5],
  ] as const)(
    "mergeProjectInternal rejects fractional source-only cache %s atomically",
    (_field, turns, writeTokens) => {
      const d = db();
      const cacheSource = ensureProject(
        `/test/merge-invalid/cache-source-${_field}`,
      );
      const cacheTarget = ensureProject(
        `/test/merge-invalid/cache-target-${_field}`,
      );
      d.query(
        `INSERT INTO cache_bust_stats
           (project_id, cause, relocatable, turns, write_tokens, updated_at)
         VALUES (?, ?, 0, ?, ?, 100)`,
      ).run(cacheSource, `invalid-source-${_field}`, turns, writeTokens);

      expect(() => mergeProjectInternal(cacheSource, cacheTarget)).toThrow(
        /counter overflow/,
      );
      expect(
        d
          .query(
            `SELECT project_id, turns, write_tokens
               FROM cache_bust_stats WHERE project_id = ?`,
          )
          .get(cacheSource),
      ).toEqual({
        project_id: cacheSource,
        turns,
        write_tokens: writeTokens,
      });
      expect(
        d
          .query("SELECT COUNT(*) AS count FROM projects WHERE id IN (?, ?)")
          .get(cacheSource, cacheTarget),
      ).toEqual({ count: 2 });
    },
  );

  test("mergeProjectInternal rejects fractional source-only transfer counters atomically", () => {
    const d = db();
    const transferSource = ensureProject("/test/merge-invalid/transfer-source");
    const transferTarget = ensureProject("/test/merge-invalid/transfer-target");
    d.exec(`
      INSERT INTO knowledge_transfers
        (knowledge_id, recalled_in_project_id, hit_count,
         first_recalled_at, last_recalled_at)
      VALUES ('invalid-source-entry', '${transferSource}', 3.5, 100, 100);
    `);
    expect(() => mergeProjectInternal(transferSource, transferTarget)).toThrow(
      /counter overflow/,
    );
    expect(
      d
        .query(
          `SELECT recalled_in_project_id, hit_count
             FROM knowledge_transfers
            WHERE knowledge_id = 'invalid-source-entry'`,
        )
        .get(),
    ).toEqual({ recalled_in_project_id: transferSource, hit_count: 3.5 });
    expect(
      d
        .query("SELECT COUNT(*) AS count FROM projects WHERE id IN (?, ?)")
        .get(transferSource, transferTarget),
    ).toEqual({ count: 2 });
  });

  test("mergeProjectInternal preserves valid histogram distributions across aggregate overflow", () => {
    const d = db();
    const sourceId = ensureProject("/test/merge-overflow-histogram/source");
    const targetId = ensureProject("/test/merge-overflow-histogram/target");
    const laterId = ensureProject("/test/merge-overflow-histogram/later");
    const sourceTotal = Number.MAX_SAFE_INTEGER;
    const emptyCounts = Array.from({ length: 21 }, () => 0);
    const sourceCounts = [...emptyCounts];
    const targetCounts = [...emptyCounts];
    const laterCounts = [...emptyCounts];
    sourceCounts[0] = sourceTotal - 1;
    sourceCounts[1] = 1;
    targetCounts[2] = 1;
    laterCounts[3] = 1;
    d.query(
      `INSERT INTO warmup_histograms
         (project_id, time_slot, counts, total, updated_at)
       VALUES (?, 'all', ?, ?, 100),
              (?, 'all', ?, ?, 100),
              (?, 'all', ?, ?, 100)`,
    ).run(
      sourceId,
      JSON.stringify(sourceCounts),
      sourceTotal,
      targetId,
      JSON.stringify(targetCounts),
      1,
      laterId,
      JSON.stringify(laterCounts),
      1,
    );

    mergeProjectInternal(sourceId, targetId);
    mergeProjectInternal(targetId, laterId);

    const row = d
      .query(
        "SELECT counts, total FROM warmup_histograms WHERE project_id = ? AND time_slot = 'all'",
      )
      .get(laterId) as { counts: string; total: number };
    const exact = decodeWarmupHistogram(row.counts, row.total);
    expect(exact).toBeDefined();
    const counts = normalizeWarmupHistogram(exact ?? []).counts;
    expect(Number.isSafeInteger(row.total)).toBe(true);
    expect(counts.reduce((sum, count) => sum + count, 0)).toBe(row.total);
    expect(counts.slice(0, 4).every((count) => count > 0)).toBe(true);
    expect(
      d
        .query(
          "SELECT COUNT(*) AS count FROM warmup_histograms WHERE project_id IN (?, ?)",
        )
        .get(sourceId, targetId),
    ).toEqual({ count: 0 });
  });

  test("mergeProjectInternal persists a decodable row when exact weights gain a digit", () => {
    const d = db();
    const sourceId = ensureProject("/test/merge-exact-boundary/source");
    const targetId = ensureProject("/test/merge-exact-boundary/target");
    const boundary = 10n ** 1000n - 1n;
    const sourceWeights = emptyWarmupHistogramCounts();
    const targetWeights = emptyWarmupHistogramCounts();
    sourceWeights[0] = boundary;
    sourceWeights[1] = 1n;
    targetWeights[0] = boundary;
    targetWeights[2] = 1n;
    const source = encodeWarmupHistogram(sourceWeights);
    const target = encodeWarmupHistogram(targetWeights);
    d.query(
      `INSERT INTO warmup_histograms
         (project_id, time_slot, counts, total, updated_at)
       VALUES (?, 'all', ?, ?, 100), (?, 'all', ?, ?, 100)`,
    ).run(
      sourceId,
      source.counts,
      source.total,
      targetId,
      target.counts,
      target.total,
    );

    mergeProjectInternal(sourceId, targetId);

    const row = d
      .query(
        "SELECT counts, total FROM warmup_histograms WHERE project_id = ? AND time_slot = 'all'",
      )
      .get(targetId) as { counts: string; total: number };
    const decoded = decodeWarmupHistogram(row.counts, row.total);
    expect(decoded).toBeDefined();
    expect(decoded?.[0].toString()).toHaveLength(1001);
    expect(decoded?.slice(0, 3).every((count) => count > 0n)).toBe(true);
  });

  test.each([
    ["source", 200, 100],
    ["target", 100, 200],
  ] as const)(
    "mergeProjectInternal retains newer %s histogram with unsafe totals",
    (_newer, sourceUpdatedAt, targetUpdatedAt) => {
      const d = db();
      const sourceId = ensureProject(
        `/test/merge-unsafe-histogram/source-${sourceUpdatedAt}`,
      );
      const targetId = ensureProject(
        `/test/merge-unsafe-histogram/target-${targetUpdatedAt}`,
      );
      const sourceCounts = JSON.stringify(Array.from({ length: 21 }, () => 1));
      const targetCounts = JSON.stringify(Array.from({ length: 21 }, () => 2));
      d.exec(`
        INSERT INTO warmup_histograms
          (project_id, time_slot, counts, total, updated_at)
        VALUES ('${sourceId}', 'all', '${sourceCounts}',
                9223372036854775807, ${sourceUpdatedAt}),
               ('${targetId}', 'all', '${targetCounts}',
                9223372036854775806, ${targetUpdatedAt});
      `);

      mergeProjectInternal(sourceId, targetId);

      const row = d
        .query(
          `SELECT counts, CAST(total AS TEXT) AS total, updated_at
             FROM warmup_histograms
            WHERE project_id = ? AND time_slot = 'all'`,
        )
        .get(targetId);
      expect(row).toEqual(
        sourceUpdatedAt > targetUpdatedAt
          ? {
              counts: sourceCounts,
              total: "9223372036854775807",
              updated_at: sourceUpdatedAt,
            }
          : {
              counts: targetCounts,
              total: "9223372036854775806",
              updated_at: targetUpdatedAt,
            },
      );
    },
  );

  test.each([
    ["source", 200, 100],
    ["target", 100, 200],
  ] as const)(
    "mergeProjectInternal retains newer %s histogram when totals disagree with counts",
    (_newer, sourceUpdatedAt, targetUpdatedAt) => {
      const d = db();
      const sourceId = ensureProject(
        `/test/merge-inconsistent-histogram/source-${sourceUpdatedAt}`,
      );
      const targetId = ensureProject(
        `/test/merge-inconsistent-histogram/target-${targetUpdatedAt}`,
      );
      const sourceCounts = JSON.stringify(Array.from({ length: 21 }, () => 1));
      const targetCounts = JSON.stringify(Array.from({ length: 21 }, () => 2));
      d.query(
        `INSERT INTO warmup_histograms
           (project_id, time_slot, counts, total, updated_at)
         VALUES (?, 'all', ?, 22, ?), (?, 'all', ?, 43, ?)`,
      ).run(
        sourceId,
        sourceCounts,
        sourceUpdatedAt,
        targetId,
        targetCounts,
        targetUpdatedAt,
      );

      mergeProjectInternal(sourceId, targetId);

      expect(
        d
          .query(
            `SELECT counts, total, updated_at
               FROM warmup_histograms
              WHERE project_id = ? AND time_slot = 'all'`,
          )
          .get(targetId),
      ).toEqual(
        sourceUpdatedAt > targetUpdatedAt
          ? { counts: sourceCounts, total: 22, updated_at: sourceUpdatedAt }
          : { counts: targetCounts, total: 43, updated_at: targetUpdatedAt },
      );
    },
  );

  test("mergeProjectInternal rejects malformed rollup source counters", () => {
    const d = db();
    const sourceId = ensureProject("/test/merge-invalid-rollup/source");
    const targetId = ensureProject("/test/merge-invalid-rollup/target");
    const sessionId = "invalid-rollup-session";
    d.exec(`
      INSERT INTO temporal_messages
        (id, project_id, session_id, role, content, tokens, created_at)
      VALUES ('invalid-source-rollup', '${sourceId}', '${sessionId}',
              'user', 'source', 1.25, 100),
             ('invalid-target-rollup', '${targetId}', '${sessionId}',
              'assistant', 'target', 2.5, 200);
    `);

    expect(() => mergeProjectInternal(sourceId, targetId)).toThrow(
      /rollup counter invalid/,
    );
    expect(
      d
        .query("SELECT COUNT(*) AS count FROM projects WHERE id IN (?, ?)")
        .get(sourceId, targetId),
    ).toEqual({ count: 2 });
    expect(
      d
        .query(
          "SELECT COUNT(*) AS count FROM session_rollup WHERE session_id = ?",
        )
        .get(sessionId),
    ).toEqual({ count: 2 });
  });

  test("listProjects never caches an uncommitted nested merge", () => {
    const sourcePath = "/test/merge-list-cache/source";
    const targetPath = "/test/merge-list-cache/target";
    const sourceId = ensureProject(sourcePath);
    const targetId = ensureProject(targetPath);
    invalidateProjectsCache();
    expect(listProjects().some((project) => project.id === sourceId)).toBe(
      true,
    );

    expect(() =>
      withSavepoint("outer_merge_rollback", () => {
        mergeProjectInternal(sourceId, targetId);
        expect(listProjects().some((project) => project.id === sourceId)).toBe(
          false,
        );
        throw new Error("force outer rollback");
      }),
    ).toThrow("force outer rollback");

    expect(projectId(sourcePath)).toBe(sourceId);
    expect(canonicalProjectId(sourceId)).toBe(sourceId);
    expect(
      db()
        .query("SELECT project_id FROM project_id_aliases WHERE retired_id = ?")
        .get(sourceId),
    ).toBeNull();
    expect(listProjects().some((project) => project.id === sourceId)).toBe(
      true,
    );
  });

  test("project mutation listeners fan out without replacing data cache invalidation", () => {
    listProjects();
    const mutations: string[] = [];
    const unsubscribe = onProjectMutation((mutation) => {
      mutations.push(mutation.type);
    });
    try {
      const project = ensureProject(
        `/test/listener-fanout-${crypto.randomUUID()}`,
      );
      expect(mutations).toEqual(["create"]);
      expect(listProjects().some(({ id }) => id === project)).toBe(true);
    } finally {
      unsubscribe();
    }
  });

  test("recoverMissingObjects creates project_path_aliases when missing", () => {
    const d = db();

    // Drop the table to simulate the broken state
    d.exec("DROP TABLE IF EXISTS project_path_aliases");
    expect(
      d
        .query(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='project_path_aliases'",
        )
        .get(),
    ).toBeNull();

    // Close and re-open — migrate() should recover
    close();
    const fresh = db();
    const after = fresh
      .query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='project_path_aliases'",
      )
      .get() as { name: string } | null;
    expect(after).not.toBeNull();
    expect(after?.name).toBe("project_path_aliases");
  });

  test("recoverMissingObjects creates project_id_aliases when missing", () => {
    const d = db();
    d.exec("DROP TABLE IF EXISTS project_id_aliases");
    expect(
      d
        .query(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='project_id_aliases'",
        )
        .get(),
    ).toBeNull();

    close();
    const fresh = db();
    expect(
      fresh
        .query(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='project_id_aliases'",
        )
        .get(),
    ).toEqual({ name: "project_id_aliases" });
  });

  test("recoverMissingObjects creates the temporal embedding queue and index when missing", () => {
    const d = db();
    d.exec("DROP TABLE IF EXISTS temporal_embedding_queue");
    expect(
      d
        .query(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='temporal_embedding_queue'",
        )
        .get(),
    ).toBeNull();

    close();
    const fresh = db();
    expect(
      fresh
        .query(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='temporal_embedding_queue'",
        )
        .get(),
    ).toEqual({ name: "temporal_embedding_queue" });
    expect(
      fresh
        .query(
          "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_temporal_embedding_queue_enqueued'",
        )
        .get(),
    ).toEqual({ name: "idx_temporal_embedding_queue_enqueued" });
  });

  test("saveSessionCosts and loadSessionCosts round-trip", () => {
    const sid = `test-costs-${crypto.randomUUID()}`;
    const snapshot = {
      conversationCost: 1.23,
      workerCost: 0.45,
      conversationTurns: 10,
      inputTokens: 120000,
      outputTokens: 8000,
      cacheReadTokens: 50000,
      cacheWriteTokens: 5000,
      warmupSavings: 0.12,
      warmupCost: 0.09,
      warmupHits: 3,
      ttlSavings: 0.34,
      ttlHits: 7,
      batchSavings: 0.56,
      avoidedCompactions: 2,
      avoidedCompactionCost: 0.78,
    };
    saveSessionCosts(sid, snapshot);
    const loaded = loadSessionCosts(sid);
    expect(loaded).toEqual(snapshot);
  });

  test("saveSessionCosts round-trips input/output token buckets", () => {
    const sid = `test-costs-io-${crypto.randomUUID()}`;
    saveSessionCosts(sid, {
      conversationCost: 1.0,
      workerCost: 0,
      conversationTurns: 3,
      inputTokens: 123456,
      outputTokens: 7890,
      cacheReadTokens: 1000,
      cacheWriteTokens: 200,
      warmupSavings: 0,
      warmupCost: 0,
      warmupHits: 0,
      ttlSavings: 0,
      ttlHits: 0,
      batchSavings: 0,
      avoidedCompactions: 0,
      avoidedCompactionCost: 0,
    });
    // Survives both the single-session and bulk load paths.
    expect(loadSessionCosts(sid)?.inputTokens).toBe(123456);
    expect(loadSessionCosts(sid)?.outputTokens).toBe(7890);
    const all = loadAllSessionCosts().get(sid);
    expect(all?.inputTokens).toBe(123456);
    expect(all?.outputTokens).toBe(7890);
  });

  test("input/output tokens default to 0 for rows written without them", () => {
    // Simulate a legacy row: insert directly without the token columns, relying
    // on the NOT NULL DEFAULT 0 from the migration.
    const sid = `test-costs-legacy-io-${crypto.randomUUID()}`;
    db()
      .query(
        `INSERT INTO session_state (session_id, force_min_layer, updated_at, conversation_turns)
         VALUES (?, 0, ?, 1)`,
      )
      .run(sid, Date.now());
    const loaded = loadSessionCosts(sid);
    expect(loaded?.inputTokens).toBe(0);
    expect(loaded?.outputTokens).toBe(0);
  });

  test("saveSessionCosts round-trips the per-bucket worker breakdown", () => {
    const sid = `test-costs-breakdown-${crypto.randomUUID()}`;
    const workerBreakdown = {
      distillation: { cost: 0.5, calls: 4 },
      curation: { cost: 0.2, calls: 2 },
      compaction: { cost: 0.05, calls: 1 },
      recall: { cost: 0.05, calls: 3 },
      warmup: { cost: 0.1, calls: 1 },
    };
    saveSessionCosts(sid, {
      conversationCost: 2.0,
      workerCost: 0.9,
      conversationTurns: 12,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 1000,
      cacheWriteTokens: 100,
      warmupSavings: 0,
      warmupCost: 0.1,
      warmupHits: 0,
      ttlSavings: 0,
      ttlHits: 0,
      batchSavings: 0,
      avoidedCompactions: 0,
      avoidedCompactionCost: 0,
      workerBreakdown,
    });
    // Survives both the single-session and bulk load paths.
    expect(loadSessionCosts(sid)?.workerBreakdown).toEqual(workerBreakdown);
    expect(loadAllSessionCosts().get(sid)?.workerBreakdown).toEqual(
      workerBreakdown,
    );
  });

  test("loadSessionCosts leaves workerBreakdown undefined for legacy rows (none stored)", () => {
    const sid = `test-costs-nobreakdown-${crypto.randomUUID()}`;
    saveSessionCosts(sid, {
      conversationCost: 1.0,
      workerCost: 0.2,
      conversationTurns: 3,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      warmupSavings: 0,
      warmupCost: 0,
      warmupHits: 0,
      ttlSavings: 0,
      ttlHits: 0,
      batchSavings: 0,
      avoidedCompactions: 0,
      avoidedCompactionCost: 0,
      // workerBreakdown intentionally omitted → column stored NULL
    });
    expect(loadSessionCosts(sid)?.workerBreakdown).toBeUndefined();
  });

  test("saveSessionCosts overwrites existing data", () => {
    const sid = `test-costs-overwrite-${crypto.randomUUID()}`;
    saveSessionCosts(sid, {
      conversationCost: 1.0,
      workerCost: 0,
      conversationTurns: 5,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      warmupSavings: 0,
      warmupCost: 0,
      warmupHits: 0,
      ttlSavings: 0,
      ttlHits: 0,
      batchSavings: 0,
      avoidedCompactions: 0,
      avoidedCompactionCost: 0,
    });
    saveSessionCosts(sid, {
      conversationCost: 2.0,
      workerCost: 0.5,
      conversationTurns: 15,
      inputTokens: 987654,
      outputTokens: 54321,
      cacheReadTokens: 100000,
      cacheWriteTokens: 10000,
      warmupSavings: 0.5,
      warmupCost: 0.3,
      warmupHits: 5,
      ttlSavings: 0.8,
      ttlHits: 10,
      batchSavings: 1.2,
      avoidedCompactions: 3,
      avoidedCompactionCost: 1.5,
    });
    const loaded = loadSessionCosts(sid);
    expect(loaded?.conversationCost).toBe(2.0);
    expect(loaded?.conversationTurns).toBe(15);
    expect(loaded?.warmupSavings).toBe(0.5);
    expect(loaded?.avoidedCompactions).toBe(3);
    expect(loaded?.avoidedCompactionCost).toBe(1.5);
    // Exercise the ON CONFLICT DO UPDATE path for the token columns: the
    // second (updating) save must overwrite, not silently drop, these buckets.
    expect(loaded?.inputTokens).toBe(987654);
    expect(loaded?.outputTokens).toBe(54321);
    expect(loaded?.cacheReadTokens).toBe(100000);
    expect(loaded?.cacheWriteTokens).toBe(10000);
  });

  test("saveSessionCosts preserves existing forceMinLayer", () => {
    const sid = `test-costs-layer-${crypto.randomUUID()}`;
    saveForceMinLayer(sid, 2);
    saveSessionCosts(sid, {
      conversationCost: 1.0,
      workerCost: 0,
      conversationTurns: 5,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      warmupSavings: 0,
      warmupCost: 0,
      warmupHits: 0,
      ttlSavings: 0,
      ttlHits: 0,
      batchSavings: 0,
      avoidedCompactions: 0,
      avoidedCompactionCost: 0,
    });
    expect(loadForceMinLayer(sid)).toBe(2);
    expect(loadSessionCosts(sid)?.conversationTurns).toBe(5);
  });

  test("loadSessionCosts returns null for unknown session", () => {
    expect(loadSessionCosts("nonexistent-session")).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Migration v22: last_import_at on projects
  // -------------------------------------------------------------------------

  test("projects table has last_import_at column (migration v22)", () => {
    const cols = db().query("PRAGMA table_info(projects)").all() as Array<{
      name: string;
    }>;
    expect(cols.map((c) => c.name)).toContain("last_import_at");
  });

  test("getLastImportAt returns null for new project", () => {
    const result = getLastImportAt("/test/import-tracking/new");
    expect(result).toBeNull();
  });

  test("setLastImportAt and getLastImportAt round-trip", () => {
    const path = "/test/import-tracking/roundtrip";
    const ts = Date.now();
    setLastImportAt(path, ts);
    expect(getLastImportAt(path)).toBe(ts);
  });

  test("setLastImportAt updates existing value", () => {
    const path = "/test/import-tracking/update";
    setLastImportAt(path, 1000);
    expect(getLastImportAt(path)).toBe(1000);
    setLastImportAt(path, 2000);
    expect(getLastImportAt(path)).toBe(2000);
  });

  test("loadAllSessionCosts returns only sessions with cost data", () => {
    const sid1 = `test-costs-all-1-${crypto.randomUUID()}`;
    const sid2 = `test-costs-all-2-${crypto.randomUUID()}`;
    saveSessionCosts(sid1, {
      conversationCost: 1.0,
      workerCost: 0,
      conversationTurns: 5,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      warmupSavings: 0.1,
      warmupCost: 0.05,
      warmupHits: 1,
      ttlSavings: 0,
      ttlHits: 0,
      batchSavings: 0,
      avoidedCompactions: 1,
      avoidedCompactionCost: 0.3,
    });
    // sid2: all zeros — should not appear (only forceMinLayer row)
    saveForceMinLayer(sid2, 1);

    const all = loadAllSessionCosts();
    expect(all.has(sid1)).toBe(true);
    expect(all.has(sid2)).toBe(false);
    expect(all.get(sid1)?.warmupSavings).toBe(0.1);
  });

  // -------------------------------------------------------------------------
  // Migration v23: Session tracking state persistence
  // -------------------------------------------------------------------------

  test("session_state has v23 tracking columns", () => {
    const cols = db().query("PRAGMA table_info(session_state)").all() as Array<{
      name: string;
    }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain("last_curated_at");
    expect(names).toContain("message_count");
    expect(names).toContain("turns_since_curation");
    expect(names).toContain("ltm_cache_text");
    expect(names).toContain("ltm_cache_tokens");
    expect(names).toContain("ltm_pin_text");
    expect(names).toContain("ltm_pin_tokens");
    expect(names).toContain("consecutive_text_only_turns");
  });

  test("session_state has ltm_pin_keys column (migration v39)", () => {
    const cols = db().query("PRAGMA table_info(session_state)").all() as Array<{
      name: string;
    }>;
    expect(cols.map((c) => c.name)).toContain("ltm_pin_keys");
  });

  test("saveSessionTracking and loadSessionTracking round-trip", () => {
    const sid = `test-tracking-${crypto.randomUUID()}`;
    saveSessionTracking(sid, {
      lastCuratedAt: 1000,
      messageCount: 42,
      turnsSinceCuration: 5,
      ltmCacheText: "cached LTM text",
      ltmCacheTokens: 100,
      ltmPinText: "pinned LTM text",
      ltmPinTokens: 90,
      ltmPinKeys: JSON.stringify(["a:1", "b:2"]),
      stableLtmText: "frozen stable LTM text",
      stableLtmTokens: 77,
      recallStore: JSON.stringify([["all:q", { toolUseId: "t1" }]]),
      amnesia: true,
      dedupDecisions: JSON.stringify([["m1:p1", true]]),
      lastKnownMessageCount: 137,
      lastUpstream: JSON.stringify({ model: "gpt-test" }),
    });
    const loaded = loadSessionTracking(sid);
    expect(loaded).not.toBeNull();
    expect(loaded?.lastCuratedAt).toBe(1000);
    expect(loaded?.messageCount).toBe(42);
    expect(loaded?.turnsSinceCuration).toBe(5);
    expect(loaded?.ltmCacheText).toBe("cached LTM text");
    expect(loaded?.ltmCacheTokens).toBe(100);
    expect(loaded?.ltmPinText).toBe("pinned LTM text");
    expect(loaded?.ltmPinTokens).toBe(90);
    expect(loaded?.ltmPinKeys).toBe(JSON.stringify(["a:1", "b:2"]));
    expect(loaded?.stableLtmText).toBe("frozen stable LTM text");
    expect(loaded?.stableLtmTokens).toBe(77);
    expect(loaded?.recallStore).toBe(
      JSON.stringify([["all:q", { toolUseId: "t1" }]]),
    );
    expect(loaded?.amnesia).toBe(true);
    expect(loaded?.dedupDecisions).toBe(JSON.stringify([["m1:p1", true]]));
    // v43: persisted for accurate calibrated-delta estimation after restart.
    expect(loaded?.lastKnownMessageCount).toBe(137);
    expect(loaded?.lastUpstream).toBe(JSON.stringify({ model: "gpt-test" }));
  });

  test("stable LTM (system[1]) freeze round-trips and survives partial updates (v45)", () => {
    const sid = `test-stable-ltm-${crypto.randomUUID()}`;
    saveSessionTracking(sid, {
      stableLtmText: "## Long-term Knowledge\n\n* pref A\n* pref B",
      stableLtmTokens: 123,
    });
    expect(loadSessionTracking(sid)?.stableLtmText).toBe(
      "## Long-term Knowledge\n\n* pref A\n* pref B",
    );
    expect(loadSessionTracking(sid)?.stableLtmTokens).toBe(123);

    // A later unrelated update must NOT clobber the frozen stable LTM — this is
    // what guarantees the system[1] prefix replays byte-identically.
    saveSessionTracking(sid, { messageCount: 9 });
    const loaded = loadSessionTracking(sid);
    expect(loaded?.messageCount).toBe(9);
    expect(loaded?.stableLtmText).toBe(
      "## Long-term Knowledge\n\n* pref A\n* pref B",
    );
    expect(loaded?.stableLtmTokens).toBe(123);
  });

  test("saveSessionTracking partial update preserves other fields", () => {
    const sid = `test-tracking-partial-${crypto.randomUUID()}`;
    saveSessionTracking(sid, {
      lastCuratedAt: 1000,
      messageCount: 10,
      turnsSinceCuration: 3,
    });
    // Update only messageCount
    saveSessionTracking(sid, { messageCount: 20 });
    const loaded = loadSessionTracking(sid);
    expect(loaded?.lastCuratedAt).toBe(1000);
    expect(loaded?.messageCount).toBe(20);
    expect(loaded?.turnsSinceCuration).toBe(3);
  });

  test("saveSessionTracking preserves existing forceMinLayer", () => {
    const sid = `test-tracking-layer-${crypto.randomUUID()}`;
    saveForceMinLayer(sid, 2);
    saveSessionTracking(sid, { messageCount: 15 });
    expect(loadForceMinLayer(sid)).toBe(2);
    expect(loadSessionTracking(sid)?.messageCount).toBe(15);
  });

  test("loadSessionTracking returns null for unknown session", () => {
    expect(loadSessionTracking("nonexistent-tracking")).toBeNull();
  });

  test("saveSessionTracking can set ltm fields to null", () => {
    const sid = `test-tracking-null-${crypto.randomUUID()}`;
    saveSessionTracking(sid, {
      ltmCacheText: "some text",
      ltmCacheTokens: 50,
    });
    expect(loadSessionTracking(sid)?.ltmCacheText).toBe("some text");
    // Clear the cache
    saveSessionTracking(sid, {
      ltmCacheText: null,
      ltmCacheTokens: null,
    });
    const loaded = loadSessionTracking(sid);
    expect(loaded?.ltmCacheText).toBeNull();
    expect(loaded?.ltmCacheTokens).toBeNull();
  });

  // -------------------------------------------------------------------------
  // v24: session identity, cache warming, gradient state
  // -------------------------------------------------------------------------

  test("saveSessionTracking v24 session identity round-trip", () => {
    const sid = `test-v24-identity-${crypto.randomUUID()}`;
    saveSessionTracking(sid, {
      fingerprint: "abc123hash",
      headerSessionId: "uuid-4567",
      headerName: "x-claude-code-session-id",
      credentialFingerprint: "0123456789abcdef",
    });
    const loaded = loadSessionTracking(sid);
    expect(loaded).not.toBeNull();
    expect(loaded?.fingerprint).toBe("abc123hash");
    expect(loaded?.headerSessionId).toBe("uuid-4567");
    expect(loaded?.headerName).toBe("x-claude-code-session-id");
    expect(loaded?.credentialFingerprint).toBe("0123456789abcdef");
  });

  test("saveSessionTracking v24 cache warming round-trip", () => {
    const sid = `test-v24-warming-${crypto.randomUUID()}`;
    const warmup = {
      lastWarmupAt: 1000,
      warmupCount: 3,
      totalWarmups: 3,
      warmupHits: 1,
      disabled: false,
      forceKeepWarm: true,
    };
    saveSessionTracking(sid, {
      resolvedConversationTTL: "1h",
      warmupState: JSON.stringify(warmup),
    });
    const loaded = loadSessionTracking(sid);
    expect(loaded).not.toBeNull();
    if (!loaded?.warmupState) throw new Error("expected warmupState");
    expect(loaded.resolvedConversationTTL).toBe("1h");
    const parsed = JSON.parse(loaded.warmupState);
    expect(parsed.warmupCount).toBe(3);
    expect(parsed.totalWarmups).toBe(3);
    expect(parsed.forceKeepWarm).toBe(true);
  });

  test("saveSessionTracking v24 gradient state round-trip", () => {
    const sid = `test-v24-gradient-${crypto.randomUUID()}`;
    saveSessionTracking(sid, {
      dynamicContextCap: 150000,
      bustRateEMA: 0.35,
      interBustIntervalEMA: 120000,
      lastLayer: 1,
      lastKnownInput: 80000,
      lastTurnAt: Date.now() - 5000,
      lastBustAt: Date.now() - 60000,
    });
    const loaded = loadSessionTracking(sid);
    expect(loaded).not.toBeNull();
    expect(loaded?.dynamicContextCap).toBe(150000);
    expect(loaded?.bustRateEMA).toBeCloseTo(0.35);
    expect(loaded?.interBustIntervalEMA).toBe(120000);
    expect(loaded?.lastLayer).toBe(1);
    expect(loaded?.lastKnownInput).toBe(80000);
    expect(loaded?.lastTurnAt).toBeGreaterThan(0);
    expect(loaded?.lastBustAt).toBeGreaterThan(0);
  });

  test("saveSessionTracking v24 partial update preserves v23 + v24 fields", () => {
    const sid = `test-v24-partial-${crypto.randomUUID()}`;
    saveSessionTracking(sid, {
      messageCount: 10,
      fingerprint: "hash1",
      dynamicContextCap: 100000,
    });
    // Update only gradient field
    saveSessionTracking(sid, { bustRateEMA: 0.5 });
    const loaded = loadSessionTracking(sid);
    expect(loaded?.messageCount).toBe(10);
    expect(loaded?.fingerprint).toBe("hash1");
    expect(loaded?.dynamicContextCap).toBe(100000);
    expect(loaded?.bustRateEMA).toBeCloseTo(0.5);
  });

  test("saveSessionTracking v24 defaults are correct for new rows", () => {
    const sid = `test-v24-defaults-${crypto.randomUUID()}`;
    saveSessionTracking(sid, { messageCount: 1 });
    const loaded = loadSessionTracking(sid);
    expect(loaded).not.toBeNull();
    // v24 defaults
    expect(loaded?.fingerprint).toBe("");
    expect(loaded?.headerSessionId).toBeNull();
    expect(loaded?.headerName).toBeNull();
    expect(loaded?.credentialFingerprint).toBe("");
    expect(loaded?.resolvedConversationTTL).toBe("5m");
    expect(loaded?.warmupState).toBeNull();
    expect(loaded?.dynamicContextCap).toBe(0);
    expect(loaded?.bustRateEMA).toBe(-1);
    expect(loaded?.interBustIntervalEMA).toBe(-1);
    expect(loaded?.lastLayer).toBe(0);
    expect(loaded?.lastKnownInput).toBe(0);
    expect(loaded?.lastTurnAt).toBe(0);
    expect(loaded?.lastBustAt).toBe(0);
  });

  // -------------------------------------------------------------------------
  // v36: project binding persistence (restart continuity)
  // -------------------------------------------------------------------------

  test("session_state has v36 project binding columns", () => {
    const cols = db().query("PRAGMA table_info(session_state)").all() as Array<{
      name: string;
    }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain("project_path");
    expect(names).toContain("project_path_provisional");
  });

  test("saveSessionTracking v36 project binding round-trip", () => {
    const sid = `test-v36-binding-${crypto.randomUUID()}`;
    saveSessionTracking(sid, {
      projectPath: "/home/me/proj",
      projectPathProvisional: false,
    });
    const loaded = loadSessionTracking(sid);
    expect(loaded?.projectPath).toBe("/home/me/proj");
    expect(loaded?.projectPathProvisional).toBe(false);
  });

  test("saveSessionTracking v36 partial update preserves project binding", () => {
    const sid = `test-v36-partial-${crypto.randomUUID()}`;
    saveSessionTracking(sid, {
      projectPath: "/home/me/proj",
      projectPathProvisional: false,
    });
    // A later save that omits the binding must NOT clobber it.
    saveSessionTracking(sid, { messageCount: 7 });
    const loaded = loadSessionTracking(sid);
    expect(loaded?.messageCount).toBe(7);
    expect(loaded?.projectPath).toBe("/home/me/proj");
    expect(loaded?.projectPathProvisional).toBe(false);
  });

  test("saveSessionTracking v36 defaults: legacy row has no binding", () => {
    const sid = `test-v36-defaults-${crypto.randomUUID()}`;
    // Row created without ever writing the binding (pre-v36 / INSERT OR IGNORE).
    saveSessionTracking(sid, { messageCount: 1 });
    const loaded = loadSessionTracking(sid);
    expect(loaded?.projectPath).toBeNull();
    // Default flag is provisional (1) — never falsely claims confidence.
    expect(loaded?.projectPathProvisional).toBe(true);
  });

  // -------------------------------------------------------------------------
  // loadHeaderSessionIndex
  // -------------------------------------------------------------------------

  test("loadHeaderSessionIndex only returns sessions with non-null headers", () => {
    const sid1 = `test-hsi-1-${crypto.randomUUID()}`;
    const sid2 = `test-hsi-2-${crypto.randomUUID()}`;
    saveSessionTracking(sid1, {
      headerSessionId: "uuid-aaa",
      headerName: "x-claude-code-session-id",
      credentialFingerprint: "credential-a",
    });
    saveSessionTracking(sid2, {
      headerSessionId: "uuid-bbb",
      headerName: "x-session-affinity",
      credentialFingerprint: "credential-b",
    });
    // Session without headers should NOT appear
    const sid3 = `test-hsi-3-${crypto.randomUUID()}`;
    saveSessionTracking(sid3, { messageCount: 5 });

    const entries = loadHeaderSessionIndex();
    const found1 = entries.find((e) => e.sessionId === sid1);
    const found2 = entries.find((e) => e.sessionId === sid2);
    const found3 = entries.find((e) => e.sessionId === sid3);

    expect(found1).toBeDefined();
    expect(found1?.headerSessionId).toBe("uuid-aaa");
    expect(found1?.headerName).toBe("x-claude-code-session-id");
    expect(found1?.credentialFingerprint).toBe("credential-a");
    expect(found2).toBeDefined();
    expect(found2?.headerSessionId).toBe("uuid-bbb");
    expect(found2?.headerName).toBe("x-session-affinity");
    expect(found2?.credentialFingerprint).toBe("credential-b");
    expect(found3).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // KV helpers (kv_meta table)
  // -------------------------------------------------------------------------

  test("getKV returns null for unknown key", () => {
    expect(getKV("nonexistent_kv_key")).toBeNull();
  });

  test("setKV and getKV round-trip", () => {
    setKV("test_kv_key", "test_kv_value");
    expect(getKV("test_kv_key")).toBe("test_kv_value");
  });

  test("setKV upserts on conflict", () => {
    setKV("kv_upsert", "first");
    expect(getKV("kv_upsert")).toBe("first");
    setKV("kv_upsert", "second");
    expect(getKV("kv_upsert")).toBe("second");
  });

  // -------------------------------------------------------------------------
  // team_config helpers (team_config table — sync credentials & state)
  // -------------------------------------------------------------------------

  describe("team_config helpers", () => {
    test("team_config table exists (migration v29)", () => {
      const tables = db()
        .query(
          "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
        )
        .all() as Array<{ name: string }>;
      expect(tables.map((t) => t.name)).toContain("team_config");
    });

    test("getTeamConfig returns null for unknown key", () => {
      expect(getTeamConfig("nonexistent_team_key")).toBeNull();
    });

    test("setTeamConfig and getTeamConfig round-trip", () => {
      setTeamConfig("tc_key", "tc_value");
      expect(getTeamConfig("tc_key")).toBe("tc_value");
    });

    test("setTeamConfig upserts on conflict", () => {
      setTeamConfig("tc_upsert", "first");
      expect(getTeamConfig("tc_upsert")).toBe("first");
      setTeamConfig("tc_upsert", "second");
      expect(getTeamConfig("tc_upsert")).toBe("second");
    });

    test("deleteTeamConfig removes the key", () => {
      setTeamConfig("tc_delete", "gone-soon");
      expect(getTeamConfig("tc_delete")).toBe("gone-soon");
      deleteTeamConfig("tc_delete");
      expect(getTeamConfig("tc_delete")).toBeNull();
    });

    test("deleteTeamConfig is a no-op for unknown key", () => {
      expect(() => deleteTeamConfig("tc_never_existed")).not.toThrow();
    });

    test("getAllTeamConfig returns all entries as an object", () => {
      // Start clean so the assertion is deterministic regardless of test order.
      for (const key of Object.keys(getAllTeamConfig())) deleteTeamConfig(key);
      setTeamConfig("tc_a", "1");
      setTeamConfig("tc_b", "2");
      expect(getAllTeamConfig()).toEqual({ tc_a: "1", tc_b: "2" });
    });

    test("team_config is JSON-session friendly (stores a serialized blob)", () => {
      const session = {
        access_token: "at",
        refresh_token: "rt",
        expires_at: 123,
        user_id: "u1",
      };
      setTeamConfig("supabase.session", JSON.stringify(session));
      expect(JSON.parse(getTeamConfig("supabase.session") ?? "null")).toEqual(
        session,
      );
    });
  });

  test("BUG-001: saveForceMinLayer(sid, 0) preserves other session_state columns", () => {
    const sid = "test-bug-001";
    saveSessionTracking(sid, {
      lastLayer: 1,
      lastKnownInput: 50,
    });

    const trackingBefore = loadSessionTracking(sid);
    expect(trackingBefore).not.toBeNull();

    saveForceMinLayer(sid, 0);

    const trackingAfter = loadSessionTracking(sid);
    expect(trackingAfter).not.toBeNull();
  });

  test("BUG-001b: saveForceMinLayer(sid, N>0) preserves other session_state columns", () => {
    const sid = "test-bug-001b";
    // Populate tracking and cost data first
    saveSessionTracking(sid, {
      lastLayer: 1,
      lastKnownInput: 100,
    });
    saveSessionCosts(sid, {
      conversationCost: 0.05,
      workerCost: 0.01,
      conversationTurns: 5,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 1000,
      cacheWriteTokens: 2000,
      warmupSavings: 0.02,
      warmupCost: 0.015,
      warmupHits: 1,
      ttlSavings: 0.01,
      ttlHits: 2,
      batchSavings: 0.0,
      avoidedCompactions: 0,
      avoidedCompactionCost: 0,
    });

    // Now set forceMinLayer to a non-zero value on the existing row
    saveForceMinLayer(sid, 2);

    // Both tracking and cost data must survive
    const trackingAfter = loadSessionTracking(sid);
    expect(trackingAfter).not.toBeNull();
    expect(trackingAfter?.lastLayer).toBe(1);
    expect(trackingAfter?.lastKnownInput).toBe(100);

    const costsAfter = loadSessionCosts(sid);
    expect(costsAfter).not.toBeNull();
    expect(costsAfter?.conversationCost).toBe(0.05);
    expect(costsAfter?.conversationTurns).toBe(5);

    // And forceMinLayer should be 2
    expect(loadForceMinLayer(sid)).toBe(2);
  });

  describe("ensureProject test-path guard", () => {
    let savedLoreDbPath: string | undefined;

    beforeEach(() => {
      savedLoreDbPath = process.env.LORE_DB_PATH;
    });

    afterEach(() => {
      // Restore — tests run under setup.ts preload so LORE_DB_PATH is set
      if (savedLoreDbPath !== undefined) {
        process.env.LORE_DB_PATH = savedLoreDbPath;
      } else {
        delete process.env.LORE_DB_PATH;
      }
    });

    test("throws for /test/ paths when LORE_DB_PATH is unset", () => {
      delete process.env.LORE_DB_PATH;
      expect(() => ensureProject("/test/ltm/something")).toThrow(
        /Refusing to create project with test path/,
      );
    });

    test("allows /test/ paths when LORE_DB_PATH is set (temp DB)", () => {
      // LORE_DB_PATH is already set by test preload — just verify it works
      expect(() => ensureProject("/test/guard-check")).not.toThrow();
    });

    test("allows non-test paths when LORE_DB_PATH is unset", () => {
      delete process.env.LORE_DB_PATH;
      // The guard only rejects /test/ prefix — real-looking paths pass through.
      // The DB singleton is already initialized (pointing at the temp test DB),
      // so this call writes to the temp DB, not the production one.
      expect(() => ensureProject("/home/user/my-project")).not.toThrow();
    });

    test("does not match similar-but-different path prefixes", () => {
      delete process.env.LORE_DB_PATH;
      // /testing/... and /test (no trailing slash) should NOT be rejected
      expect(() => ensureProject("/testing/something")).not.toThrow();
      expect(() => ensureProject("/test")).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Migration v30: per-day cost ledger (daily_costs)
  // -------------------------------------------------------------------------

  describe("daily_costs ledger (v30)", () => {
    test("daily_costs table exists", () => {
      const tables = db()
        .query(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='daily_costs'",
        )
        .all() as Array<{ name: string }>;
      expect(tables.length).toBe(1);
    });

    test("addDailyCost accumulates per (day, bucket)", () => {
      const day = "2099-01-01";
      addDailyCost(day, "conversation", 1.5);
      addDailyCost(day, "conversation", 0.5);
      addDailyCost(day, "worker", 0.25);
      addDailyCost(day, "warmup", 0.1);
      // Total across all buckets for the day = 1.5 + 0.5 + 0.25 + 0.1
      expect(getDailyCostForDay(day)).toBeCloseTo(2.35, 6);
    });

    test("addDailyCost ignores zero, negative, and non-finite costs", () => {
      const day = "2099-01-02";
      addDailyCost(day, "conversation", 0);
      addDailyCost(day, "conversation", -1.5);
      addDailyCost(day, "conversation", Number.NaN);
      addDailyCost(day, "conversation", Number.POSITIVE_INFINITY);
      expect(getDailyCostForDay(day)).toBe(0);
    });

    test("getDailyCostTotals groups by day for days >= sinceDay", () => {
      addDailyCost("2099-02-01", "conversation", 1.0);
      addDailyCost("2099-02-02", "conversation", 2.0);
      addDailyCost("2099-02-02", "worker", 0.5);
      addDailyCost("2099-02-03", "warmup", 0.25);

      const totals = getDailyCostTotals("2099-02-02");
      // 2099-02-01 is before the cutoff — excluded.
      expect(totals.has("2099-02-01")).toBe(false);
      expect(totals.get("2099-02-02")).toBeCloseTo(2.5, 6);
      expect(totals.get("2099-02-03")).toBeCloseTo(0.25, 6);
    });

    test("cost is attributed to the actual day, not dumped onto one date", () => {
      // Simulate a multi-day session: spend split across two UTC days.
      addDailyCost("2099-03-01", "conversation", 3.0);
      addDailyCost("2099-03-02", "conversation", 1.0);
      const totals = getDailyCostTotals("2099-03-01");
      expect(totals.get("2099-03-01")).toBeCloseTo(3.0, 6);
      expect(totals.get("2099-03-02")).toBeCloseTo(1.0, 6);
    });

    test("recoverMissingObjects recreates daily_costs when missing", () => {
      const d = db();
      d.exec("DROP TABLE IF EXISTS daily_costs");
      expect(
        d
          .query(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='daily_costs'",
          )
          .get(),
      ).toBeNull();

      close();
      const fresh = db();
      const after = fresh
        .query(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='daily_costs'",
        )
        .get() as { name: string } | null;
      expect(after).not.toBeNull();
      expect(after?.name).toBe("daily_costs");
    });
  });

  // -------------------------------------------------------------------------
  // Migration v31: structured tool-call execution trace (tool_calls)
  // -------------------------------------------------------------------------

  describe("tool_calls trace (v31)", () => {
    test("tool_calls table exists", () => {
      const tables = db()
        .query(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='tool_calls'",
        )
        .all() as Array<{ name: string }>;
      expect(tables.length).toBe(1);
    });

    test("tool_calls indexes exist", () => {
      const idx = db()
        .query(
          "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='tool_calls'",
        )
        .all() as Array<{ name: string }>;
      const names = idx.map((i) => i.name);
      expect(names).toContain("idx_tool_calls_project_tool_status");
      expect(names).toContain("idx_tool_calls_project_session");
    });

    test("owned call_id PK upserts in place", () => {
      const pid = ensureProject("/tmp/tool-calls-pk-test");
      const insert = () =>
        db().query(
          `INSERT INTO tool_calls
               (call_id, message_id, project_id, session_id, tool, status, error_type, error_message, duration_ms, created_at)
             VALUES ('c1', 'm1', ?, 's1', 'bash', ?, ?, ?, ?, 1000)
              ON CONFLICT(project_id, session_id, call_id) DO UPDATE SET
               status = excluded.status,
               error_type = excluded.error_type,
               error_message = excluded.error_message,
               duration_ms = excluded.duration_ms`,
        );
      insert().run(pid, "pending", null, null, null);
      insert().run(pid, "error", "timeout", "timed out", 20);

      const rows = db()
        .query(
          "SELECT status, error_type, duration_ms FROM tool_calls WHERE call_id='c1'",
        )
        .all() as Array<{
        status: string;
        error_type: string | null;
        duration_ms: number;
      }>;
      expect(rows.length).toBe(1);
      expect(rows[0].status).toBe("error");
      expect(rows[0].error_type).toBe("timeout");
      expect(rows[0].duration_ms).toBe(20);
    });

    test("recoverMissingObjects recreates tool_calls when missing", () => {
      const d = db();
      d.exec("DROP TABLE IF EXISTS tool_calls");
      expect(
        d
          .query(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='tool_calls'",
          )
          .get(),
      ).toBeNull();

      close();
      const fresh = db();
      const after = fresh
        .query(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='tool_calls'",
        )
        .get() as { name: string } | null;
      expect(after).not.toBeNull();
      expect(after?.name).toBe("tool_calls");
      // Indexes recovered too.
      const idx = fresh
        .query(
          "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='tool_calls'",
        )
        .all() as Array<{ name: string }>;
      const names = idx.map((i) => i.name);
      expect(names).toContain("idx_tool_calls_project_tool_status");
      expect(names).toContain("idx_tool_calls_project_session");
    });
  });

  // -------------------------------------------------------------------------
  // Migration v43: persist lastKnownMessageCount + restart-proof session
  // adoption helpers (issue #796)
  // -------------------------------------------------------------------------

  describe("session adoption helpers (v43)", () => {
    test("session_state has last_known_message_count column", () => {
      const cols = db()
        .query("PRAGMA table_info(session_state)")
        .all() as Array<{ name: string }>;
      expect(cols.map((c) => c.name)).toContain("last_known_message_count");
    });

    test("recoverMissingObjects re-adds last_known_message_count when missing", () => {
      const d = db();
      d.exec("ALTER TABLE session_state DROP COLUMN last_known_message_count");
      expect(
        (
          d.query("PRAGMA table_info(session_state)").all() as Array<{
            name: string;
          }>
        ).some((c) => c.name === "last_known_message_count"),
      ).toBe(false);

      close();
      const fresh = db();
      expect(
        (
          fresh.query("PRAGMA table_info(session_state)").all() as Array<{
            name: string;
          }>
        ).some((c) => c.name === "last_known_message_count"),
      ).toBe(true);
    });

    test("recoverMissingObjects re-adds sync_conflicts.local_content when missing", () => {
      // Regression: the first sync-engine release (#782) shipped sync_conflicts
      // WITHOUT local_content, then the column was added only to the CREATE TABLE
      // IF NOT EXISTS definition (no ALTER). An early sync adopter's table keeps
      // the old 5-column shape forever, so recordConflict()'s INSERT throws
      // "no such column: local_content" on every sync cycle. Reproduce the old
      // shape, reopen, and confirm recoverMissingObjects self-heals the column.
      const d = db();
      d.exec("ALTER TABLE sync_conflicts DROP COLUMN local_content");
      expect(
        (
          d.query("PRAGMA table_info(sync_conflicts)").all() as Array<{
            name: string;
          }>
        ).some((c) => c.name === "local_content"),
      ).toBe(false);

      close();
      const fresh = db();
      expect(
        (
          fresh.query("PRAGMA table_info(sync_conflicts)").all() as Array<{
            name: string;
          }>
        ).some((c) => c.name === "local_content"),
      ).toBe(true);
    });

    test("recoverMissingObjects re-adds knowledge_session_injections.verdict without throwing on the index", () => {
      // Regression: the (logical_id, verdict) index must be created AFTER the
      // verdict column is ensured. Dropping the column (SQLite also drops the
      // dependent index) then reopening must self-heal — not throw
      // `no such column: verdict` while recovering a pre-v54 table.
      const d = db();
      // SQLite refuses to drop a column an index depends on — drop the index
      // first, reproducing a pre-v54 table (no verdict column, no verdict index).
      d.exec("DROP INDEX IF EXISTS idx_ksi_logical_verdict");
      d.exec("ALTER TABLE knowledge_session_injections DROP COLUMN verdict");
      expect(
        (
          d
            .query("PRAGMA table_info(knowledge_session_injections)")
            .all() as Array<{
            name: string;
          }>
        ).some((c) => c.name === "verdict"),
      ).toBe(false);

      close();
      const fresh = db(); // must not throw
      expect(
        (
          fresh
            .query("PRAGMA table_info(knowledge_session_injections)")
            .all() as Array<{ name: string }>
        ).some((c) => c.name === "verdict"),
      ).toBe(true);
      // The verdict-keyed index is restored too.
      expect(
        (
          fresh
            .query("PRAGMA index_list(knowledge_session_injections)")
            .all() as Array<{ name: string }>
        ).some((i) => i.name === "idx_ksi_logical_verdict"),
      ).toBe(true);
    });

    test("findSessionStatesByFingerprint returns only matching non-empty fingerprints", () => {
      const sidA = `adopt-a-${crypto.randomUUID()}`;
      const sidB = `adopt-b-${crypto.randomUUID()}`;
      const sidOther = `adopt-other-${crypto.randomUUID()}`;
      const sidEmpty = `adopt-empty-${crypto.randomUUID()}`;
      const fp = `fp-${crypto.randomUUID().slice(0, 8)}`;
      saveSessionTracking(sidA, {
        fingerprint: fp,
        messageCount: 100,
        projectPath: "/tmp/adopt-provisional",
        projectPathProvisional: true,
      });
      saveSessionTracking(sidB, {
        fingerprint: fp,
        messageCount: 200,
        isSubagent: true,
      });
      saveSessionTracking(sidOther, {
        fingerprint: `other-${crypto.randomUUID().slice(0, 8)}`,
        messageCount: 50,
      });
      // Empty fingerprint must never be returned (default for untracked rows).
      saveSessionTracking(sidEmpty, { fingerprint: "", messageCount: 10 });

      const got = findSessionStatesByFingerprint(fp);
      const bySid = new Map(got.map((r) => [r.session_id, r]));
      expect(bySid.has(sidA)).toBe(true);
      expect(bySid.has(sidB)).toBe(true);
      expect(bySid.has(sidOther)).toBe(false);
      expect(bySid.has(sidEmpty)).toBe(false);
      expect(bySid.get(sidA)?.message_count).toBe(100);
      expect(bySid.get(sidB)?.is_subagent).toBe(1);
      expect(bySid.get(sidA)?.is_subagent).toBe(0);
      expect(bySid.get(sidA)?.project_path).toBe("/tmp/adopt-provisional");
      expect(bySid.get(sidA)?.project_path_provisional).toBe(1);

      // Empty query never matches the empty-fingerprint rows.
      expect(findSessionStatesByFingerprint("")).toEqual([]);
    });

    test("findSessionStatesByFingerprint can restrict candidates by owner", () => {
      const fp = `legacy-fp-${crypto.randomUUID().slice(0, 8)}`;
      const unowned = `legacy-unowned-${crypto.randomUUID()}`;
      const owned = `legacy-owned-${crypto.randomUUID()}`;
      saveSessionTracking(unowned, {
        fingerprint: fp,
        credentialFingerprint: "",
      });
      saveSessionTracking(owned, {
        fingerprint: fp,
        credentialFingerprint: "credential-a",
      });

      expect(
        findSessionStatesByFingerprint(fp, { legacyUnownedOnly: true }).map(
          (row) => row.session_id,
        ),
      ).toEqual([unowned]);
      expect(
        findSessionStatesByFingerprint(fp, {
          credentialFingerprint: "credential-a",
        }).map((row) => row.session_id),
      ).toEqual([owned]);
      expect(
        findSessionStatesByFingerprint(fp, {
          credentialFingerprint: "credential-b",
        }),
      ).toEqual([]);
    });

    test("countMatchingTemporalIds counts only same-project, same-session ids", () => {
      const pidA = ensureProject(`/tmp/adopt-overlap-a-${crypto.randomUUID()}`);
      const pidB = ensureProject(`/tmp/adopt-overlap-b-${crypto.randomUUID()}`);
      const sess = `ov-sess-${crypto.randomUUID()}`;
      const ins = (pid: string, sid: string, id: string) =>
        db()
          .query(
            `INSERT INTO temporal_messages
                (id, source_id, project_id, session_id, role, content, tokens, distilled, created_at)
              VALUES (?, ?, ?, ?, 'user', 'x', 1, 0, 1000)`,
          )
          .run(id, id, pid, sid);
      ins(pidA, sess, "m1");
      ins(pidA, sess, "m2");
      ins(pidA, sess, "m3");
      ins(pidA, "other-sess", "m9"); // same project, different session
      ins(pidB, sess, "mb"); // different project, same session id

      // 2 of the 3 probed ids exist in (pidA, sess); "x" does not.
      expect(countMatchingTemporalIds(pidA, sess, ["m1", "m2", "x"])).toBe(2);
      // Different session → no overlap.
      expect(countMatchingTemporalIds(pidA, "other-sess", ["m1", "m2"])).toBe(
        0,
      );
      // Different project → no overlap.
      expect(countMatchingTemporalIds(pidB, sess, ["m1", "m2", "m3"])).toBe(0);
      // Empty id list → 0, no query error.
      expect(countMatchingTemporalIds(pidA, sess, [])).toBe(0);
    });

    test("countMatchingTemporalIds chunks id lists beyond the SQLite variable limit", () => {
      const pid = ensureProject(`/tmp/adopt-chunk-${crypto.randomUUID()}`);
      const sess = `chunk-sess-${crypto.randomUUID()}`;
      const real: string[] = [];
      for (let i = 0; i < 5; i++) {
        const id = `real-${i}`;
        real.push(id);
        db()
          .query(
            `INSERT INTO temporal_messages
                (id, source_id, project_id, session_id, role, content, tokens, distilled, created_at)
              VALUES (?, ?, ?, ?, 'user', 'x', 1, 0, 1000)`,
          )
          .run(id, id, pid, sess);
      }
      // 1200 ids (>999 SQLite bound-variable limit) — must not throw and must
      // count only the 5 that exist.
      const ids = [
        ...real,
        ...Array.from({ length: 1195 }, (_, i) => `fake-${i}`),
      ];
      expect(countMatchingTemporalIds(pid, sess, ids)).toBe(5);
    });
  });

  // Migration v33: cross-project knowledge transfer metrics (knowledge_transfers)
  describe("knowledge_transfers tally (v33)", () => {
    test("knowledge_transfers table and index exist", () => {
      const tbl = db()
        .query(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='knowledge_transfers'",
        )
        .get();
      expect(tbl).not.toBeNull();
      const idx = db()
        .query(
          "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='knowledge_transfers'",
        )
        .all() as Array<{ name: string }>;
      expect(idx.map((i) => i.name)).toContain(
        "idx_knowledge_transfers_recalled_in",
      );
    });

    test("recoverMissingObjects recreates knowledge_transfers when missing", () => {
      const d = db();
      d.exec("DROP TABLE IF EXISTS knowledge_transfers");
      expect(
        d
          .query(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='knowledge_transfers'",
          )
          .get(),
      ).toBeNull();

      close();
      const fresh = db();
      const after = fresh
        .query(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='knowledge_transfers'",
        )
        .get() as { name: string } | null;
      expect(after).not.toBeNull();
      expect(after?.name).toBe("knowledge_transfers");
      const idx = fresh
        .query(
          "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='knowledge_transfers'",
        )
        .all() as Array<{ name: string }>;
      expect(idx.map((i) => i.name)).toContain(
        "idx_knowledge_transfers_recalled_in",
      );
    });
  });
});
