import { describe, test, expect, beforeEach } from "vitest";
import { db, ensureProject, setTeamConfig, deleteTeamConfig } from "../src/db";
import {
  applyRemoteDelete,
  applyRemoteUpsert,
  classifyRemoteRow,
  contentHash,
  disableSync,
  enableSync,
  getRowById,
  getSyncState,
  isSyncEnabled,
  maxOutboxSeq,
  readOutbox,
  rebuildFts,
  rowIdOf,
  seedOutbox,
  setSyncState,
  SYNCED_TABLES,
  withApplying,
} from "../src/sync-data";

const now = () => Date.now();

function insertKnowledge(id: string, title: string, content: string): string {
  const pid = ensureProject("/tmp/lore-sync-data");
  db()
    .query(
      `INSERT INTO knowledge (id, project_id, category, title, content, created_at, updated_at)
       VALUES (?, ?, 'pattern', ?, ?, ?, ?)`,
    )
    .run(id, pid, title, content, now(), now());
  return id;
}

function outboxFor(table: string) {
  return readOutbox(0).filter((e) => e.table_name === table);
}

beforeEach(() => {
  // Disable capture FIRST so the table cleanup below doesn't itself enqueue
  // delete entries via the (working) outbox triggers, then clear state.
  deleteTeamConfig("sync.enabled");
  db().exec("DELETE FROM temp._sync_applying"); // reset suppression depth
  db().exec("DELETE FROM knowledge");
  db().exec("DELETE FROM sync_outbox");
  db().exec("DELETE FROM sync_state");
  db().exec("DELETE FROM sync_conflicts");
});

describe("v43 schema", () => {
  test("sync tables exist", () => {
    const names = (
      db()
        .query(
          "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'sync_%'",
        )
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(names).toContain("sync_outbox");
    expect(names).toContain("sync_state");
    expect(names).toContain("sync_conflicts");
  });

  test("outbox capture is installed as per-connection TEMP triggers", () => {
    // Connection-scoped (temp) so a CLI process can't suppress the gateway's
    // captures — they live in sqlite_temp_master, not the persistent schema.
    const persistent = (
      db()
        .query(
          "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE '%_outbox_%'",
        )
        .all() as Array<{ name: string }>
    ).length;
    expect(persistent).toBe(0); // must NOT be persistent main-schema triggers

    const triggers = (
      db()
        .query(
          "SELECT name FROM sqlite_temp_master WHERE type='trigger' AND name LIKE '%_outbox_%'",
        )
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    for (const t of SYNCED_TABLES.basic) {
      expect(triggers.some((n) => n.startsWith(`${t.table}_outbox_`))).toBe(
        true,
      );
    }
  });
});

describe("outbox capture", () => {
  test("does NOT capture when sync is disabled", () => {
    insertKnowledge("k1", "T", "C");
    expect(outboxFor("knowledge")).toHaveLength(0);
  });

  test("captures insert/update/delete when sync is enabled", () => {
    setTeamConfig("sync.enabled", "1");
    insertKnowledge("k1", "T", "C");
    db().query("UPDATE knowledge SET content = ? WHERE id = ?").run("C2", "k1");
    db().query("DELETE FROM knowledge WHERE id = ?").run("k1");

    const ops = outboxFor("knowledge").map((e) => e.op);
    expect(ops).toEqual(["upsert", "upsert", "delete"]);
    expect(outboxFor("knowledge").every((e) => e.row_id === "k1")).toBe(true);
  });

  test("apply-suppression prevents re-capture of pulled rows", () => {
    setTeamConfig("sync.enabled", "1");
    withApplying(() => insertKnowledge("k1", "T", "C"));
    expect(outboxFor("knowledge")).toHaveLength(0);
  });

  test("composite row_id for the join table uses the unit separator", () => {
    setTeamConfig("sync.enabled", "1");
    const pid = ensureProject("/tmp/lore-sync-refs");
    db()
      .query(
        `INSERT INTO entities (id, project_id, entity_type, canonical_name, created_at, updated_at)
         VALUES ('e1', ?, 'tool', 'X', ?, ?)`,
      )
      .run(pid, now(), now());
    insertKnowledge("k1", "T", "C");
    db()
      .query(
        "INSERT INTO knowledge_entity_refs (knowledge_id, entity_id) VALUES ('k1','e1')",
      )
      .run();
    const refs = outboxFor("knowledge_entity_refs");
    expect(refs).toHaveLength(1);
    expect(refs[0].row_id).toBe("k1\x1fe1");
  });
});

describe("seedOutbox", () => {
  test("enqueues all existing rows as upserts", () => {
    insertKnowledge("k1", "A", "1"); // inserted while disabled → not captured
    insertKnowledge("k2", "B", "2");
    expect(outboxFor("knowledge")).toHaveLength(0);
    seedOutbox();
    const ids = outboxFor("knowledge")
      .map((e) => e.row_id)
      .sort();
    expect(ids).toEqual(["k1", "k2"]);
    expect(outboxFor("knowledge").every((e) => e.op === "upsert")).toBe(true);
  });
});

describe("enableSync", () => {
  test("sets the flag and seeds once (idempotent)", () => {
    insertKnowledge("k1", "A", "1");
    enableSync();
    expect(isSyncEnabled()).toBe(true);
    expect(outboxFor("knowledge")).toHaveLength(1);
    // Second enable must not double-seed.
    enableSync();
    expect(outboxFor("knowledge")).toHaveLength(1);
  });
});

describe("contentHash", () => {
  test("stable across reads, ignores updated_at", () => {
    insertKnowledge("k1", "T", "C");
    const a = getRowById("knowledge", "k1") as Record<string, unknown>;
    const h1 = contentHash("knowledge", a);
    db()
      .query("UPDATE knowledge SET updated_at = ? WHERE id='k1'")
      .run(now() + 999);
    const b = getRowById("knowledge", "k1") as Record<string, unknown>;
    expect(contentHash("knowledge", b)).toBe(h1); // updated_at not hashed
  });

  test("changes when semantic content changes", () => {
    insertKnowledge("k1", "T", "C");
    const h1 = contentHash(
      "knowledge",
      getRowById("knowledge", "k1") as Record<string, unknown>,
    );
    db().query("UPDATE knowledge SET content='DIFFERENT' WHERE id='k1'").run();
    const h2 = contentHash(
      "knowledge",
      getRowById("knowledge", "k1") as Record<string, unknown>,
    );
    expect(h2).not.toBe(h1);
  });

  test("changes when confidence changes (decay must propagate to sync)", () => {
    // decayProject lowers confidence without bumping updated_at; the content
    // hash must still change so the row is pushed to other clients.
    insertKnowledge("k1", "T", "C");
    const h1 = contentHash(
      "knowledge",
      getRowById("knowledge", "k1") as Record<string, unknown>,
    );
    db().query("UPDATE knowledge SET confidence = 0.5 WHERE id='k1'").run();
    const h2 = contentHash(
      "knowledge",
      getRowById("knowledge", "k1") as Record<string, unknown>,
    );
    expect(h2).not.toBe(h1);
  });

  test("stable when only last_reinforced_at changes (injection must not churn sync)", () => {
    // markInjected fires every turn on the hot path; it must not alter the hash
    // or every injected entry would be re-pushed each turn.
    insertKnowledge("k1", "T", "C");
    const h1 = contentHash(
      "knowledge",
      getRowById("knowledge", "k1") as Record<string, unknown>,
    );
    db()
      .query("UPDATE knowledge SET last_reinforced_at = ? WHERE id='k1'")
      .run(now() + 12345);
    const h2 = contentHash(
      "knowledge",
      getRowById("knowledge", "k1") as Record<string, unknown>,
    );
    expect(h2).toBe(h1);
  });
});

describe("applyRemoteUpsert / applyRemoteDelete", () => {
  test("upsert writes the row without enqueuing the outbox", () => {
    setTeamConfig("sync.enabled", "1");
    const pid = ensureProject("/tmp/lore-sync-apply");
    applyRemoteUpsert("knowledge", {
      id: "kr",
      project_id: pid,
      category: "pattern",
      title: "Remote",
      content: "from server",
      created_at: now(),
      updated_at: now(),
    });
    expect(getRowById("knowledge", "kr")?.title).toBe("Remote");
    expect(outboxFor("knowledge")).toHaveLength(0); // suppressed
    rebuildFts("knowledge_fts"); // must not throw
  });

  test("delete removes the row without enqueuing the outbox", () => {
    setTeamConfig("sync.enabled", "1");
    withApplying(() => insertKnowledge("kd", "T", "C"));
    applyRemoteDelete("knowledge", "kd");
    expect(getRowById("knowledge", "kd")).toBeNull();
    expect(outboxFor("knowledge")).toHaveLength(0);
  });
});

describe("classifyRemoteRow", () => {
  test("skip when remote content equals local", () => {
    insertKnowledge("k1", "T", "C");
    const localHash = contentHash(
      "knowledge",
      getRowById("knowledge", "k1") as Record<string, unknown>,
    );
    expect(classifyRemoteRow("knowledge", "k1", localHash)).toBe("skip");
  });

  test("apply when local is unchanged since last sync (fast-forward)", () => {
    insertKnowledge("k1", "T", "C");
    const localHash = contentHash(
      "knowledge",
      getRowById("knowledge", "k1") as Record<string, unknown>,
    );
    // Record that the current local content is what we last synced.
    setSyncState("knowledge", "k1", {
      content_hash: localHash,
      revision: 1,
      remote_updated_at: "t0",
    });
    // Remote now has different content → fast-forward (no local divergence).
    expect(classifyRemoteRow("knowledge", "k1", "deadbeefdeadbeef")).toBe(
      "apply",
    );
  });

  test("apply when there is no local row", () => {
    expect(classifyRemoteRow("knowledge", "ghost", "deadbeefdeadbeef")).toBe(
      "apply",
    );
  });

  test("conflict when both local and remote diverged since last sync", () => {
    insertKnowledge("k1", "T", "C");
    // We last synced an OLDER content (different hash than current local).
    setSyncState("knowledge", "k1", {
      content_hash: "oldsyncedhashxx",
      revision: 1,
      remote_updated_at: "t0",
    });
    // Local content differs from last-synced AND remote differs too → conflict.
    expect(classifyRemoteRow("knowledge", "k1", "remotehashxxxxxx")).toBe(
      "conflict",
    );
  });
});

describe("getSyncState / maxOutboxSeq", () => {
  test("sync_state round-trips", () => {
    setSyncState("knowledge", "k1", {
      content_hash: "abc",
      revision: 3,
      remote_updated_at: "2026-01-01T00:00:00Z",
    });
    expect(getSyncState("knowledge", "k1")).toEqual({
      content_hash: "abc",
      revision: 3,
      remote_updated_at: "2026-01-01T00:00:00Z",
    });
  });

  test("maxOutboxSeq tracks the high-watermark", () => {
    expect(maxOutboxSeq()).toBe(0);
    setTeamConfig("sync.enabled", "1");
    insertKnowledge("k1", "T", "C");
    insertKnowledge("k2", "T", "C");
    expect(maxOutboxSeq()).toBe(readOutbox(0).at(-1)?.seq);
  });

  test("rowIdOf builds composite ids", () => {
    expect(rowIdOf("knowledge", { id: "x" })).toBe("x");
    expect(
      rowIdOf("knowledge_entity_refs", { knowledge_id: "k", entity_id: "e" }),
    ).toBe("k\x1fe");
  });
});

// ---------------------------------------------------------------------------
// Regressions for the adversarial review findings
// ---------------------------------------------------------------------------

describe("withApplying re-entrancy (BLOCKER fix)", () => {
  test("nested apply does not re-enable capture in the outer scope", () => {
    setTeamConfig("sync.enabled", "1");
    withApplying(() => {
      withApplying(() => insertKnowledge("inner", "T", "C"));
      // After the INNER block exits, capture must still be suppressed because
      // the OUTER block is applying — a unconditional clear would re-enable it.
      insertKnowledge("outer", "T", "C");
    });
    expect(outboxFor("knowledge")).toHaveLength(0);
  });

  test("depth counter restores capture only after the outermost exit", () => {
    setTeamConfig("sync.enabled", "1");
    withApplying(() => withApplying(() => {}));
    // Both levels exited → capture active again.
    insertKnowledge("after", "T", "C");
    expect(outboxFor("knowledge").map((e) => e.row_id)).toEqual(["after"]);
  });
});

describe("reconcile / re-enable (data-loss fix)", () => {
  test("captures edits AND deletes made while sync was disabled", () => {
    // Initial sync of two rows.
    enableSync();
    insertKnowledge("keep", "T", "C");
    insertKnowledge("gone", "T", "C");
    // Pretend we pushed them: record sync_state + drain the outbox.
    for (const id of ["keep", "gone"]) {
      setSyncState("knowledge", id, {
        content_hash: contentHash(
          "knowledge",
          getRowById("knowledge", id) as Record<string, unknown>,
        ),
        revision: 1,
        remote_updated_at: "t0",
      });
    }
    db().exec("DELETE FROM sync_outbox");

    // Disable, then mutate while OFF (triggers don't fire).
    disableSync();
    db().query("UPDATE knowledge SET content='EDITED' WHERE id='keep'").run();
    db().query("DELETE FROM knowledge WHERE id='gone'").run();
    expect(outboxFor("knowledge")).toHaveLength(0);

    // Re-enable → reconcile must re-enqueue the edit (upsert) and the delete.
    enableSync();
    const ops = Object.fromEntries(
      outboxFor("knowledge").map((e) => [e.row_id, e.op]),
    );
    expect(ops.keep).toBe("upsert");
    expect(ops.gone).toBe("delete");
  });

  test("seedOutbox is idempotent (no duplicate pending upserts)", () => {
    insertKnowledge("k1", "T", "C");
    seedOutbox();
    seedOutbox();
    expect(outboxFor("knowledge")).toHaveLength(1);
  });
});

describe("applyRemoteUpsert keeps rowid stable (FTS-safe)", () => {
  test("repeated upserts update in place — rowid unchanged, FTS consistent", () => {
    const pid = ensureProject("/tmp/lore-sync-fts");
    const row = (content: string) => ({
      id: "kf",
      project_id: pid,
      category: "pattern",
      title: "T",
      content,
      created_at: now(),
      updated_at: now(),
    });
    applyRemoteUpsert("knowledge", row("first"));
    const rowid1 = (
      db().query("SELECT rowid AS r FROM knowledge WHERE id='kf'").get() as {
        r: number;
      }
    ).r;
    applyRemoteUpsert("knowledge", row("second"));
    const rowid2 = (
      db().query("SELECT rowid AS r FROM knowledge WHERE id='kf'").get() as {
        r: number;
      }
    ).r;
    expect(rowid2).toBe(rowid1); // ON CONFLICT DO UPDATE, not delete+insert

    // FTS finds the NEW content and not the stale one (no orphan postings).
    rebuildFts("knowledge_fts");
    const hitNew = db()
      .query(
        "SELECT k.id FROM knowledge_fts f JOIN knowledge k ON k.rowid=f.rowid WHERE knowledge_fts MATCH 'second'",
      )
      .get() as { id: string } | undefined;
    expect(hitNew?.id).toBe("kf");
  });
});

describe("classifyRemoteRow pendingLocalChange (resurrection fix)", () => {
  test("an unpushed local change is never fast-forwarded over", () => {
    // No local row, no sync_state → would otherwise be "apply"; the engine
    // signals a pending local delete, so it must be a conflict instead.
    expect(
      classifyRemoteRow("knowledge", "deleted", "remotehashxxxxxx", {
        pendingLocalChange: true,
      }),
    ).toBe("conflict");
  });
});
