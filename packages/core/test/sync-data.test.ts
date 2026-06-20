import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  db,
  ensureProject,
  getKV,
  setKV,
  setTeamConfig,
  deleteTeamConfig,
} from "../src/db";
import {
  applyRemoteDelete,
  applyRemoteUpsert,
  assertSyncInvariants,
  classifyRemoteRow,
  clearProfileMirror,
  clearSyncState,
  contentHash,
  currentTier,
  disableSync,
  enableSync,
  getRowById,
  getSyncState,
  hasPendingChange,
  isSyncEnabled,
  maxOutboxSeq,
  pickSyncColumns,
  readOutbox,
  rebuildFts,
  reconcile,
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

function insertEntity(id: string): string {
  const pid = ensureProject("/tmp/lore-sync-data");
  db()
    .query(
      `INSERT INTO entities (id, project_id, entity_type, canonical_name, created_at, updated_at)
       VALUES (?, ?, 'person', 'E', ?, ?)`,
    )
    .run(id, pid, now(), now());
  return id;
}

// A knowledge_entity_refs row (composite PK) with its FK parents present.
function insertJoinRow(knowledgeId: string, entityId: string): void {
  insertKnowledge(knowledgeId, "T", "C");
  insertEntity(entityId);
  db()
    .query(
      `INSERT INTO knowledge_entity_refs (knowledge_id, entity_id) VALUES (?, ?)`,
    )
    .run(knowledgeId, entityId);
}

beforeEach(() => {
  // Disable capture FIRST so the table cleanup below doesn't itself enqueue
  // delete entries via the (working) outbox triggers, then clear state.
  deleteTeamConfig("sync.enabled");
  db().exec("DELETE FROM temp._sync_applying"); // reset suppression depth
  db().exec("DELETE FROM knowledge_entity_refs");
  db().exec("DELETE FROM knowledge");
  db().exec("DELETE FROM entities");
  db().exec("DELETE FROM profiles");
  db().exec("DELETE FROM sync_outbox");
  db().exec("DELETE FROM sync_state");
  db().exec("DELETE FROM sync_conflicts");
});

// Every test in this file leaves a state that must satisfy the sync invariants
// (no pull-only outbox entry, profiles mirror <= 1 row, no unregistered tables).
// Running the check in afterEach turns each test into a continuous regression
// guard for the #828 bug classes (issue #834).
afterEach(() => assertSyncInvariants());

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
      // Pull-only tables (e.g. profiles) are intentionally NOT captured — they
      // are server-authoritative and must never be pushed.
      expect(triggers.some((n) => n.startsWith(`${t.table}_outbox_`))).toBe(
        !t.pullOnly,
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

describe("profiles pull-only mirror", () => {
  function insertProfile(id: string, tier: string): void {
    db()
      .query(
        `INSERT INTO profiles (id, tier, created_at, updated_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(id, tier, now(), now());
  }

  test("is registered as a pull-only, unversioned synced table", () => {
    const p = SYNCED_TABLES.basic.find((m) => m.table === "profiles");
    expect(p).toBeDefined();
    expect(p?.pullOnly).toBe(true);
    expect(p?.versioned).toBe(false);
    expect(p?.idColumns).toEqual(["id"]);
    expect(p?.syncColumns).toContain("tier");
  });

  test("local writes are NEVER captured to the outbox (no push), even when sync is enabled", () => {
    enableSync();
    insertProfile("u1", "pro");
    db().query("UPDATE profiles SET tier = 'free' WHERE id = 'u1'").run();
    // No capture trigger exists for profiles → nothing to ever push.
    expect(outboxFor("profiles")).toHaveLength(0);
  });

  test("currentTier reads the mirror, defaulting to 'free' when empty", () => {
    expect(currentTier()).toBe("free"); // no row pulled yet
    insertProfile("u1", "pro");
    expect(currentTier()).toBe("pro");
  });

  test("a pulled remote profiles row upserts into the local mirror", () => {
    applyRemoteUpsert("profiles", {
      id: "u1",
      tier: "pro",
      github_login: "octocat",
      display_name: "Octo Cat",
      email: "octo@cat.dev",
      created_at: now(),
      updated_at: now(),
    });
    expect(currentTier()).toBe("pro");
    const row = getRowById("profiles", "u1") as Record<string, unknown>;
    expect(row.github_login).toBe("octocat");
  });

  test("seedOutbox/reconcile NEVER enqueue a pull-only table with a local row (prune-floor wedge guard)", () => {
    // The mirror already holds a row (e.g. pulled in a prior session) BEFORE
    // sync is (re-)enabled — the disable→enable path the capture-trigger
    // exclusion does NOT cover. Enqueuing it would create an entry pushOnce
    // skips forever, pinning the prune floor at 0 for ALL tables.
    insertProfile("u1", "pro");
    seedOutbox();
    expect(outboxFor("profiles")).toHaveLength(0);
    enableSync(); // reconcile path (seed + delete-tombstone reconciliation)
    expect(outboxFor("profiles")).toHaveLength(0);
  });

  test("clearProfileMirror drops the row, its sync_state, and resets the pull cursor", () => {
    insertProfile("u1", "pro");
    setSyncState("profiles", "u1", {
      content_hash: null,
      revision: 0,
      remote_updated_at: "x",
    });
    setKV("sync.pull.profiles", "999|u1");
    expect(currentTier()).toBe("pro");

    clearProfileMirror();

    expect(currentTier()).toBe("free");
    expect(getRowById("profiles", "u1")).toBeNull();
    expect(getSyncState("profiles", "u1")).toBeNull();
    expect(getKV("sync.pull.profiles")).toBe("0|");
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

describe("assertSyncInvariants", () => {
  test("passes on a clean state", () => {
    expect(() => assertSyncInvariants()).not.toThrow();
  });

  test("throws when a pull-only table has a sync_outbox entry (prune-floor wedge)", () => {
    db()
      .query(
        "INSERT INTO sync_outbox (table_name, row_id, op, changed_at) VALUES ('profiles', 'u1', 'upsert', ?)",
      )
      .run(now());
    expect(() => assertSyncInvariants()).toThrow(/pull-only table "profiles"/);
    db().exec("DELETE FROM sync_outbox"); // restore clean state for afterEach
  });

  test("throws when the profiles mirror holds more than one row", () => {
    for (const id of ["a", "b"]) {
      db()
        .query(
          "INSERT INTO profiles (id, tier, created_at, updated_at) VALUES (?, 'pro', ?, ?)",
        )
        .run(id, now(), now());
    }
    expect(() => assertSyncInvariants()).toThrow(
      /profiles mirror holds 2 rows/,
    );
    db().exec("DELETE FROM profiles"); // restore clean state for afterEach
  });

  test("throws when sync_state references an unregistered table", () => {
    db()
      .query(
        "INSERT INTO sync_state (table_name, row_id, content_hash, revision, remote_updated_at) VALUES ('bogus_table', 'x', NULL, 0, NULL)",
      )
      .run();
    expect(() => assertSyncInvariants()).toThrow(
      /unregistered table "bogus_table"/,
    );
    db().exec("DELETE FROM sync_state"); // restore clean state for afterEach
  });
});

// Tests closing GENUINE coverage gaps surfaced by the Stryker mutation baseline
// (#832/#840). Each was hand-verified to kill its mutant (apply the exact
// replacement from the report, confirm the test fails). Equivalent mutants (e.g.
// :378 pruneOutbox, :326 getRowById payload filter, :310 column sort) are
// intentionally NOT chased — no behavioral test can distinguish them.
describe("mutation gap coverage (#832)", () => {
  test("classifyRemoteRow: a null remote hash never skips on an absent local row", () => {
    // Kills `remoteHash !== null -> true`: that mutant reduces the guard to
    // `localHash === remoteHash`, where null === null would wrongly return "skip".
    expect(classifyRemoteRow("knowledge", "ghost", null)).toBe("apply");
  });

  test("contentHash: null and undefined columns hash to the same sentinel", () => {
    // Kills the serializeValue null/undefined coalesce (`||`->`&&` or guard
    // removal): both must map to the "\x00" sentinel, so the rows hash equal.
    const a = { id: "x", title: null };
    const b = { id: "x", title: undefined };
    expect(contentHash("knowledge", a)).toBe(contentHash("knowledge", b));
  });

  test("contentHash is truncated to 16 hex chars", () => {
    // Kills removal of `.slice(0, 16)` (would leave the full 64-char digest).
    insertKnowledge("k1", "T", "C");
    const row = getRowById("knowledge", "k1") as Record<string, unknown>;
    expect(contentHash("knowledge", row)).toHaveLength(16);
  });

  test("an unregistered table is rejected", () => {
    // Kills removal of the `if (!m) throw` guard in meta().
    expect(() => rowIdOf("bogus_table", { id: "x" })).toThrow(
      /not a synced table/,
    );
  });

  test("pickSyncColumns omits columns absent from the row", () => {
    // Kills `if (c in row)` -> always-copy (which adds `content: undefined`).
    const picked = pickSyncColumns("knowledge", { id: "k", title: "T" });
    expect(picked).toHaveProperty("id");
    expect(picked).not.toHaveProperty("content");
  });

  test("hasPendingChange reflects outbox presence (both directions)", () => {
    // Kills the empty-body and `!= null` -> `== null` mutants.
    insertKnowledge("k1", "T", "C");
    seedOutbox();
    expect(hasPendingChange("knowledge", "k1", 0)).toBe(true);
    expect(hasPendingChange("knowledge", "absent", 0)).toBe(false);
  });

  test("seedOutbox builds a composite row_id for the join table", () => {
    // Kills `idColumns.length === 1` -> true (which would emit only knowledge_id).
    insertJoinRow("k1", "e1");
    seedOutbox();
    const entries = outboxFor("knowledge_entity_refs");
    expect(entries).toHaveLength(1);
    expect(entries[0].row_id).toBe("k1\x1fe1");
  });

  test("reconcile does not tombstone the pull-only profiles table", () => {
    // A profiles sync_state row with no live row would be delete-tombstoned for a
    // normal table; the `if (m.pullOnly) continue` guard must skip it.
    setSyncState("profiles", "u1", {
      content_hash: "h",
      revision: 1,
      remote_updated_at: "t0",
    });
    reconcile();
    expect(outboxFor("profiles")).toHaveLength(0);
  });

  test("clearSyncState removes the sync_state row", () => {
    // Kills the empty-body mutant.
    setSyncState("knowledge", "k1", {
      content_hash: "h",
      revision: 1,
      remote_updated_at: "t0",
    });
    expect(getSyncState("knowledge", "k1")).not.toBeNull();
    clearSyncState("knowledge", "k1");
    expect(getSyncState("knowledge", "k1")).toBeNull();
  });

  test("applyRemoteUpsert on the all-PK join table uses DO NOTHING", () => {
    // The join table has only PK columns -> nonPk is empty -> onConflict must be
    // "DO NOTHING". Kills `nonPk.length > 0` -> always-true, which emits an
    // invalid `DO UPDATE SET ` (empty) and throws.
    insertKnowledge("k1", "T", "C");
    insertEntity("e1");
    expect(() =>
      applyRemoteUpsert("knowledge_entity_refs", {
        knowledge_id: "k1",
        entity_id: "e1",
      }),
    ).not.toThrow();
  });

  test("isSyncEnabled is false until enabled", () => {
    // Kills the `=== "1"` -> always-true mutant.
    expect(isSyncEnabled()).toBe(false);
    enableSync();
    expect(isSyncEnabled()).toBe(true);
  });
});
