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
  applyRemoteKnowledge,
  applyRemoteKnowledgeDelete,
  applyRemoteMeta,
  applyRemoteMetaCrdt,
  applyRemoteUpsert,
  assertSyncInvariants,
  classifyRemoteRow,
  clearProfileMirror,
  clearSyncState,
  contentHash,
  currentKnowledgeRow,
  currentTier,
  disableSync,
  enableSync,
  getRowById,
  getSyncState,
  hasPendingChange,
  hasPendingKnowledgeChange,
  isSyncEnabled,
  knowledgePushPlan,
  maxOutboxSeq,
  pickSyncColumns,
  readOutbox,
  rebuildFts,
  reconcile,
  rowIdOf,
  seedOutbox,
  setSyncState,
  SYNCED_TABLES,
  syncedColumns,
  syncedTables,
  syncedTablesFor,
  currentSyncTier,
  metaFor,
  withApplying,
} from "../src/sync-data";
import * as ltm from "../src/ltm";

const now = () => Date.now();

describe("applyRemoteKnowledge — append-only pull apply (A2, #823)", () => {
  const PROJ = "/tmp/lore-apply-knowledge";
  const remoteRow = (
    id: string,
    content: string,
    extra: Record<string, unknown> = {},
  ) => ({
    id,
    project_id: ensureProject(PROJ),
    category: "decision",
    title: "AK",
    content,
    created_at: now(),
    updated_at: now(),
    ...extra,
  });
  const versions = (lid: string) =>
    db()
      .query(
        "SELECT id, version, is_current, is_deleted, content FROM knowledge WHERE COALESCE(logical_id, id) = ? ORDER BY version",
      )
      .all(lid) as Array<{
      id: string;
      version: number;
      is_current: number;
      is_deleted: number;
      content: string;
    }>;
  const curContent = (lid: string) =>
    (
      db()
        .query(
          "SELECT content FROM knowledge_current WHERE COALESCE(logical_id, id) = ?",
        )
        .get(lid) as { content: string } | undefined
    )?.content;

  test("new entry → v1 with id = logical_id", () => {
    applyRemoteKnowledge(remoteRow("n1", "hello"));
    const v = versions("n1");
    expect(v).toHaveLength(1);
    expect(v[0].id).toBe("n1");
    expect(v[0].version).toBe(1);
    expect(v[0].is_current).toBe(1);
    expect(curContent("n1")).toBe("hello");
  });

  test("content change → appends a new current version; prior preserved + demoted", () => {
    applyRemoteKnowledge(remoteRow("c1", "v1"));
    applyRemoteKnowledge(remoteRow("c1", "v2"));
    const v = versions("c1");
    expect(v).toHaveLength(2);
    expect(v[0].content).toBe("v1");
    expect(v[0].is_current).toBe(0); // prior demoted, immutably preserved
    expect(v[1].content).toBe("v2");
    expect(v[1].is_current).toBe(1);
    expect(v[1].id).not.toBe("c1"); // new version row gets a fresh id
    expect(curContent("c1")).toBe("v2");
  });

  test("identical content → no new version (idempotent re-pull / echo)", () => {
    applyRemoteKnowledge(remoteRow("i1", "same"));
    applyRemoteKnowledge(remoteRow("i1", "same"));
    expect(versions("i1")).toHaveLength(1);
  });

  test("metadata-only change (same content) converges in place, no new version", () => {
    // confidence moved to the knowledge_meta register (A2 3b) and is no longer a
    // knowledge sync field, so use another synced metadata column (sensitivity) to
    // exercise the in-place convergence path.
    applyRemoteKnowledge(remoteRow("m1", "body", { sensitivity: "normal" }));
    applyRemoteKnowledge(remoteRow("m1", "body", { sensitivity: "sensitive" }));
    expect(versions("m1")).toHaveLength(1);
    expect(
      (
        db()
          .query(
            "SELECT sensitivity FROM knowledge_current WHERE COALESCE(logical_id, id) = ?",
          )
          .get("m1") as { sensitivity: string }
      ).sensitivity,
    ).toBe("sensitive");
  });

  test("delete → death-cert (no live current); re-delete is a no-op", () => {
    applyRemoteKnowledge(remoteRow("d1", "body"));
    applyRemoteKnowledgeDelete("d1");
    expect(curContent("d1")).toBeUndefined();
    const v = versions("d1");
    expect(v).toHaveLength(2);
    expect(v[1].is_deleted).toBe(1);
    applyRemoteKnowledgeDelete("d1"); // idempotent
    expect(versions("d1")).toHaveLength(2);
  });

  test("revive: a remote upsert after a delete appends a new live current", () => {
    applyRemoteKnowledge(remoteRow("r1", "body"));
    applyRemoteKnowledgeDelete("r1");
    expect(curContent("r1")).toBeUndefined();
    applyRemoteKnowledge(remoteRow("r1", "revived"));
    expect(curContent("r1")).toBe("revived");
    expect(versions("r1")).toHaveLength(3); // v1 live, v2 death-cert, v3 revived
  });

  test("round-trip: A's multi-version entry coalesces to ONE version on peer B", () => {
    // Device A: create + update → two local versions, current content "final".
    const id = ltm.create({
      projectPath: PROJ,
      scope: "project",
      category: "decision",
      title: "RT",
      content: "first",
    });
    ltm.update(id, { content: "final" });
    expect(versions(id)).toHaveLength(2); // A has v1 + v2

    // Push coalesces both versions to ONE remote row keyed by logical_id.
    const plan = knowledgePushPlan(id);
    expect(plan.op).toBe("upsert");
    if (plan.op !== "upsert") return;
    expect(plan.row.id).toBe(id);
    expect(plan.row.content).toBe("final");

    // Device B (simulated as a peer with none of A's local version history).
    db()
      .query("DELETE FROM knowledge WHERE COALESCE(logical_id, id) = ?")
      .run(id);
    applyRemoteKnowledge(plan.row);
    const vB = versions(id);
    expect(vB).toHaveLength(1); // ONE coalesced version, not A's two
    expect(vB[0].id).toBe(id); // v1 keyed by the shared logical_id
    expect(curContent(id)).toBe("final");

    // Re-pulling the same row (echo) is idempotent.
    applyRemoteKnowledge(plan.row);
    expect(versions(id)).toHaveLength(1);
  });
});

describe("knowledgePushPlan — append-only remote mapping keyed by logical_id (A2)", () => {
  test("live current → upsert by logical_id (current content); no live current → delete", () => {
    // The knowledge outbox is logical_id-keyed for every op (#909), so the plan's
    // input IS the logical_id (= id for v1). No version ids ever reach it.
    const id = ltm.create({
      projectPath: "/tmp/lore-sync-kpp",
      scope: "project",
      category: "decision",
      title: "KPP",
      content: "secret v1",
    });
    let p = knowledgePushPlan(id);
    expect(p.op).toBe("upsert");
    if (p.op === "upsert") {
      expect(p.logicalId).toBe(id);
      expect(p.row.id).toBe(id); // keyed on the stable logical_id
      expect(p.row.content).toBe("secret v1");
    }

    ltm.appendVersion(id, { content: "redacted v2" });
    // Same logical_id → the plan now carries the CURRENT content; the old secret
    // is never pushed as a live row.
    p = knowledgePushPlan(id);
    expect(p.op).toBe("upsert");
    if (p.op === "upsert") {
      expect(p.logicalId).toBe(id);
      expect(p.row.id).toBe(id);
      expect(p.row.content).toBe("redacted v2");
    }

    ltm.remove(id); // death-cert → no live current
    expect(knowledgePushPlan(id).op).toBe("delete");
    // An unknown logical_id has no live current → a (harmless, idempotent) delete.
    expect(knowledgePushPlan("00000000-0000-0000-0000-000000000000").op).toBe(
      "delete",
    );
  });

  test("capture triggers key the knowledge outbox by logical_id for every op (#909)", () => {
    setTeamConfig("sync.enabled", "1");
    db().exec("DELETE FROM sync_outbox");
    const id = ltm.create({
      projectPath: "/tmp/lore-kpp-triggers",
      scope: "project",
      category: "decision",
      title: "TRIG",
      content: "v1",
    });
    ltm.appendVersion(id, { content: "v2" }); // demote (UPDATE) + insert (INSERT)
    ltm.remove(id); // demote + death-cert insert (+ the remove's internal ops)
    const rowIds = (
      db()
        .query(
          "SELECT DISTINCT row_id FROM sync_outbox WHERE table_name = 'knowledge'",
        )
        .all() as { row_id: string }[]
    ).map((r) => r.row_id);
    expect(rowIds).toEqual([id]); // every knowledge op coalesced to the logical_id
  });

  test("seedOutbox skips an already-synced versioned (v2) entry — no re-enqueue bloat (#823)", () => {
    setTeamConfig("sync.enabled", "1");
    const id = ltm.create({
      projectPath: "/tmp/lore-seed-bloat",
      scope: "project",
      category: "decision",
      title: "SB",
      content: "v1",
    });
    ltm.appendVersion(id, { content: "v2" }); // versioned: current id ≠ logical_id
    // Mark synced exactly as push would: sync_state keyed by logical_id, hashing the
    // current row re-keyed id=logical_id.
    const row = currentKnowledgeRow(id) as Record<string, unknown>;
    setSyncState("knowledge", id, {
      content_hash: contentHash("knowledge", row),
      revision: 1,
      remote_updated_at: null,
    });
    db().exec("DELETE FROM sync_outbox"); // clear capture from create/append
    setKV("sync.push.knowledge", "0");
    seedOutbox("basic");
    const n = (
      db()
        .query(
          "SELECT COUNT(*) AS n FROM sync_outbox WHERE table_name = 'knowledge'",
        )
        .get() as { n: number }
    ).n;
    expect(n).toBe(0); // already synced (by logical_id) → not re-enqueued
  });

  test("seedOutbox enqueues knowledge by value (confidence, then recency) so the best entries win the cap", () => {
    setTeamConfig("sync.enabled", "1");
    const mk = (title: string) =>
      ltm.create({
        projectPath: "/tmp/lore-seed-rank",
        scope: "project",
        category: "decision",
        title,
        content: "c",
      });
    const low = mk("low");
    const mid = mk("mid");
    const high = mk("high");
    // Distinct confidence, deliberately created in NON-value order above so a stable
    // sort by anything other than value would not reproduce [high, mid, low].
    const setConf = (lid: string, c: number) =>
      db()
        .query("UPDATE knowledge_meta SET confidence = ? WHERE logical_id = ?")
        .run(c, lid);
    setConf(high, 0.9);
    setConf(mid, 0.5);
    setConf(low, 0.1);
    db().exec("DELETE FROM sync_outbox"); // clear the create captures
    setKV("sync.push.knowledge", "0");
    seedOutbox("basic");
    const order = outboxFor("knowledge").map((e) => e.row_id);
    expect(order).toEqual([high, mid, low]); // highest confidence first
  });

  test("seedOutbox breaks confidence ties by recency (most recently reinforced first)", () => {
    setTeamConfig("sync.enabled", "1");
    const mk = (title: string) =>
      ltm.create({
        projectPath: "/tmp/lore-seed-tie",
        scope: "project",
        category: "decision",
        title,
        content: "c",
      });
    const older = mk("older");
    const newer = mk("newer");
    const setMeta = (lid: string, reinforcedAt: number) =>
      db()
        .query(
          "UPDATE knowledge_meta SET confidence = 0.5, last_reinforced_at = ? WHERE logical_id = ?",
        )
        .run(reinforcedAt, lid);
    setMeta(older, 1000);
    setMeta(newer, 2000); // equal confidence, newer reinforcement
    db().exec("DELETE FROM sync_outbox");
    setKV("sync.push.knowledge", "0");
    seedOutbox("basic");
    const order = outboxFor("knowledge").map((e) => e.row_id);
    expect(order).toEqual([newer, older]); // tie broken by recency
  });

  test("seedOutbox seeds entities by reference count first (most-used), then recency", () => {
    setTeamConfig("sync.enabled", "1");
    const pid = ensureProject("/tmp/lore-entity-rank");
    const mkEntity = (id: string, updatedAt: number) =>
      db()
        .query(
          "INSERT INTO entities (id, project_id, entity_type, canonical_name, created_at, updated_at) VALUES (?, ?, 'tool', ?, ?, ?)",
        )
        .run(id, pid, id, updatedAt, updatedAt);
    // Insert in the REVERSE of the expected value order, and make recency the reverse
    // of reference count too — so neither storage order NOR a recency-only sort could
    // reproduce [eA, eB, eC]; only ref-count ranking does.
    mkEntity("eC", 300); // newest, unreferenced (0)
    mkEntity("eB", 200); // 1 ref
    mkEntity("eA", 100); // oldest, most referenced (2)
    insertKnowledge("k1", "T", "C");
    insertKnowledge("k2", "T", "C");
    const mkRef = (kid: string, eid: string) =>
      db()
        .query(
          "INSERT INTO knowledge_entity_refs (knowledge_id, entity_id) VALUES (?, ?)",
        )
        .run(kid, eid);
    mkRef("k1", "eA");
    mkRef("k2", "eA");
    mkRef("k1", "eB");
    db().exec("DELETE FROM sync_outbox"); // clear the insert captures
    setKV("sync.push.entities", "0");
    seedOutbox("basic");
    expect(outboxFor("entities").map((e) => e.row_id)).toEqual([
      "eA",
      "eB",
      "eC",
    ]);
  });

  test("seedOutbox seeds entity_relations + entity_aliases by recency (newest first)", () => {
    setTeamConfig("sync.enabled", "1");
    const pid = ensureProject("/tmp/lore-entity-rank2");
    for (const id of ["e1", "e2"])
      db()
        .query(
          "INSERT INTO entities (id, project_id, entity_type, canonical_name, created_at, updated_at) VALUES (?, ?, 'tool', ?, 1, 1)",
        )
        .run(id, pid, id);
    const mkRel = (id: string, updatedAt: number) =>
      db()
        .query(
          "INSERT INTO entity_relations (id, entity_a, entity_b, relation, created_at, updated_at) VALUES (?, 'e1', 'e2', ?, ?, ?)",
        )
        .run(id, id, updatedAt, updatedAt);
    mkRel("rOld", 100);
    mkRel("rNew", 200);
    const mkAlias = (id: string, createdAt: number) =>
      db()
        .query(
          "INSERT INTO entity_aliases (id, entity_id, alias_type, alias_value, created_at) VALUES (?, 'e1', 'name', ?, ?)",
        )
        .run(id, id, createdAt);
    mkAlias("aOld", 100);
    mkAlias("aNew", 200);
    db().exec("DELETE FROM sync_outbox");
    setKV("sync.push.entity_relations", "0");
    setKV("sync.push.entity_aliases", "0");
    seedOutbox("basic");
    expect(outboxFor("entity_relations").map((e) => e.row_id)).toEqual([
      "rNew",
      "rOld",
    ]);
    expect(outboxFor("entity_aliases").map((e) => e.row_id)).toEqual([
      "aNew",
      "aOld",
    ]);
  });

  test("seedOutbox seeds knowledge_meta in the same value order as knowledge (confidence, recency)", () => {
    setTeamConfig("sync.enabled", "1");
    const mk = (title: string) =>
      ltm.create({
        projectPath: "/tmp/lore-meta-seed",
        scope: "project",
        category: "decision",
        title,
        content: "c",
      });
    // Created low→mid→high, so storage/insertion order is the REVERSE of the expected
    // confidence order — an unordered seed could not reproduce [high, mid, low].
    const low = mk("low");
    const mid = mk("mid");
    const high = mk("high");
    const setConf = (lid: string, c: number) =>
      db()
        .query("UPDATE knowledge_meta SET confidence = ? WHERE logical_id = ?")
        .run(c, lid);
    setConf(high, 0.9);
    setConf(mid, 0.5);
    setConf(low, 0.1);
    db().exec("DELETE FROM sync_outbox"); // clear the create captures
    setKV("sync.push.knowledge_meta", "0");
    seedOutbox("basic");
    expect(outboxFor("knowledge_meta").map((e) => e.row_id)).toEqual([
      high,
      mid,
      low,
    ]);
  });

  test("seedOutbox does NOT seed knowledge_meta for a DELETED entry (live-only JOIN)", () => {
    setTeamConfig("sync.enabled", "1");
    const mk = (title: string) =>
      ltm.create({
        projectPath: "/tmp/lore-meta-live",
        scope: "project",
        category: "decision",
        title,
        content: "c",
      });
    const live = mk("live");
    const dead = mk("dead");
    ltm.remove(dead); // append death-cert; remove() keeps the meta register row
    // Precondition: the dead entry's meta row STILL exists — so its absence from the
    // seed below is the live-only JOIN, not a purged row (guards a future remove() change).
    expect(
      db().query("SELECT 1 FROM knowledge_meta WHERE logical_id = ?").get(dead),
    ).toBeTruthy();
    db().exec("DELETE FROM sync_outbox");
    setKV("sync.push.knowledge_meta", "0");
    seedOutbox("basic");
    const ids = outboxFor("knowledge_meta").map((e) => e.row_id);
    expect(ids).toContain(live);
    expect(ids).not.toContain(dead); // its lingering meta must not be seeded/synced
  });
});

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
  db().exec("DELETE FROM entity_aliases");
  db().exec("DELETE FROM entity_relations");
  db().exec("DELETE FROM knowledge");
  db().exec("DELETE FROM knowledge_meta");
  db().exec("DELETE FROM knowledge_meta_crdt");
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

  test("confidence is NO LONGER a knowledge sync column (moved to knowledge_meta, A2 3b)", () => {
    // confidence + last_reinforced_at were relocated to the knowledge_meta register
    // (sub-PR 3b). They must not appear in knowledge's synced columns — confidence
    // syncs via its own convergent table in 3b-2; the knowledge content row no
    // longer churns when only a metric changes.
    const cols = syncedColumns("knowledge");
    expect(cols).not.toContain("confidence");
    expect(cols).not.toContain("last_reinforced_at");
    // A confidence change (via the register) therefore does NOT alter the knowledge
    // content hash — the content row is not re-pushed for a metric nudge.
    insertKnowledge("k1", "T", "C");
    const h1 = contentHash(
      "knowledge",
      getRowById("knowledge", "k1") as Record<string, unknown>,
    );
    db()
      .query(
        "INSERT OR REPLACE INTO knowledge_meta (logical_id, confidence, updated_at) VALUES ('k1', 0.5, ?)",
      )
      .run(now());
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

  test("applyRemoteKnowledge inserts a pulled entry as v1 with logical_id = id, scoped per row", () => {
    // A pulled knowledge row is keyed by logical_id (= id); a brand-new entry
    // lands as v1 with logical_id = id, isolated per row.
    setTeamConfig("sync.enabled", "1");
    const pid = ensureProject("/tmp/lore-sync-backfill");
    const base = { project_id: pid, category: "pattern", content: "c" };
    applyRemoteKnowledge({
      id: "kA",
      title: "A",
      created_at: now(),
      updated_at: now(),
      ...base,
    });
    applyRemoteKnowledge({
      id: "kB",
      title: "B",
      created_at: now(),
      updated_at: now(),
      ...base,
    });
    // logical_id is not a synced column, so read it directly.
    const logicalOf = (id: string) =>
      (
        db().query("SELECT logical_id FROM knowledge WHERE id = ?").get(id) as {
          logical_id: string;
        }
      ).logical_id;
    expect(logicalOf("kA")).toBe("kA"); // backfilled to its OWN id
    expect(logicalOf("kB")).toBe("kB");
    expect(logicalOf("kA")).not.toBe(logicalOf("kB")); // no cross-row contamination
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

  test("hasPendingKnowledgeChange survives compaction of ALL version rows (#909 anchor-free contract)", () => {
    setTeamConfig("sync.enabled", "1");
    const id = ltm.create({
      projectPath: "/tmp/lore-anchor-free",
      scope: "project",
      category: "decision",
      title: "AF",
      content: "v1",
    });
    // A pending (unpushed) edit captured in the outbox, keyed by logical_id (#909).
    db().exec("DELETE FROM sync_outbox");
    db()
      .query(
        "INSERT INTO sync_outbox (table_name, row_id, op, changed_at) VALUES ('knowledge', ?, 'upsert', ?)",
      )
      .run(id, Date.now());
    // Future compaction physically removes EVERY version row — including the v1
    // anchor (id == logical_id). Under apply-suppression so the DELETE triggers add
    // no outbox entries of their own.
    withApplying(() =>
      db()
        .query("DELETE FROM knowledge WHERE COALESCE(logical_id, id) = ?")
        .run(id),
    );
    expect(
      (
        db()
          .query(
            "SELECT COUNT(*) AS n FROM knowledge WHERE COALESCE(logical_id, id) = ?",
          )
          .get(id) as { n: number }
      ).n,
    ).toBe(0);
    // STILL detected — the outbox row_id IS the logical_id, with no dependency on a
    // surviving version row to JOIN through (the old JOIN form returned false here).
    expect(hasPendingKnowledgeChange(id, 0)).toBe(true);
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

describe("applyRemoteMeta / applyRemoteMetaCrdt — convergent confidence (A2 3b-2b)", () => {
  const PROJ = "/tmp/lore-meta-sync";
  const mk = (confidence: number): string =>
    ltm.create({
      projectPath: PROJ,
      scope: "project",
      category: "decision",
      title: `T-${Math.random()}`,
      content: "body",
      confidence,
    });
  const conf = (logicalId: string): number =>
    (
      db()
        .query("SELECT confidence FROM knowledge_meta WHERE logical_id = ?")
        .get(logicalId) as { confidence: number }
    ).confidence;
  const base = (logicalId: string): number =>
    (
      db()
        .query(
          "SELECT base_confidence FROM knowledge_meta WHERE logical_id = ?",
        )
        .get(logicalId) as { base_confidence: number }
    ).base_confidence;
  const crdtCount = (logicalId: string, replicaId: string): number =>
    (
      db()
        .query(
          "SELECT COUNT(*) n FROM knowledge_meta_crdt WHERE logical_id = ? AND replica_id = ?",
        )
        .get(logicalId, replicaId) as { n: number }
    ).n;

  beforeEach(() => {
    const pid = ensureProject(PROJ);
    db().query("DELETE FROM knowledge WHERE project_id = ?").run(pid);
    db().query("DELETE FROM knowledge_meta").run();
    db().query("DELETE FROM knowledge_meta_crdt").run();
  });

  test("applyRemoteMeta upserts the immutable base and re-materializes confidence", () => {
    const id = mk(1.0); // local base 1.0
    applyRemoteMeta({ logical_id: id, base_confidence: 0.7, updated_at: 1 });
    expect(base(id)).toBeCloseTo(0.7, 6);
    expect(conf(id)).toBeCloseTo(0.7, 6); // clamp(0.7 + 0 − 0)
  });

  test("applyRemoteMeta does NOT overwrite the local materialized confidence/decay clock", () => {
    const id = mk(0.5);
    ltm.reinforce(id, 0.1); // local counter pos=0.1 → conf 0.6
    // A re-pulled base (same value) must not clobber the locally-accumulated value.
    applyRemoteMeta({ logical_id: id, base_confidence: 0.5, updated_at: 2 });
    expect(conf(id)).toBeCloseTo(0.6, 6); // base 0.5 + local 0.1, NOT reset to base
  });

  test("applyRemoteMetaCrdt max-merges a peer counter and converges (A reinforce + B decay)", () => {
    const id = mk(0.5); // base 0.5
    ltm.reinforce(id, 0.1); // local replica pos=0.1 → 0.6
    applyRemoteMetaCrdt({ logical_id: id, replica_id: "B", pos: 0, neg: 0.2 });
    // clamp(0.5 + 0.1(local) − 0.2(B)) = 0.4 — both devices' deltas survive.
    expect(conf(id)).toBeCloseTo(0.4, 6);
  });

  test("stale lower counter never lowers the value (per-key MAX)", () => {
    const id = mk(0.5);
    applyRemoteMetaCrdt({ logical_id: id, replica_id: "B", pos: 0.3, neg: 0 });
    expect(conf(id)).toBeCloseTo(0.8, 6);
    // A stale re-delivery of B with a LOWER pos must be absorbed by MAX → no change.
    applyRemoteMetaCrdt({ logical_id: id, replica_id: "B", pos: 0.1, neg: 0 });
    expect(conf(id)).toBeCloseTo(0.8, 6);
  });

  test("re-pulling the same counter is idempotent (one row, value unchanged)", () => {
    const id = mk(0.5);
    applyRemoteMetaCrdt({ logical_id: id, replica_id: "B", pos: 0.2, neg: 0 });
    applyRemoteMetaCrdt({ logical_id: id, replica_id: "B", pos: 0.2, neg: 0 });
    expect(conf(id)).toBeCloseTo(0.7, 6);
    expect(crdtCount(id, "B")).toBe(1);
  });

  test("three replicas' independent deltas all sum into the converged value", () => {
    const id = mk(0.5);
    ltm.reinforce(id, 0.1); // local
    applyRemoteMetaCrdt({ logical_id: id, replica_id: "B", pos: 0.2, neg: 0 });
    applyRemoteMetaCrdt({ logical_id: id, replica_id: "C", pos: 0, neg: 0.05 });
    // clamp(0.5 + 0.1 + 0.2 − 0.05) = clamp(0.75) = 0.75
    expect(conf(id)).toBeCloseTo(0.75, 6);
  });

  test("a pull-minted register's placeholder base is NEVER pushed on (re-)enable — no peer-base clobber", () => {
    setTeamConfig("sync.enabled", "1");
    const pid = ensureProject(PROJ);
    // Pull a brand-new entry authored on ANOTHER device: only the knowledge content
    // lands here; knowledge_meta syncs on its own (laggable) cursor — so this mints a
    // PLACEHOLDER register row at the default base 1.0 (the real base is unknown yet).
    applyRemoteKnowledge({
      id: "kpeer",
      title: "peer entry",
      content: "peer body",
      category: "decision",
      project_id: pid,
      created_at: 1,
      updated_at: 1,
    });
    expect(base("kpeer")).toBeCloseTo(1.0, 6); // fabricated placeholder

    // A later disable→enable re-seeds the outbox from all existing rows.
    seedOutbox("basic");
    // The placeholder must NOT be enqueued: pushing the fabricated 1.0 would overwrite
    // the author's REAL base on the (scope_id, logical_id)-keyed remote and permanently
    // clobber it for every replica (base is immutable → no one re-corrects it). The
    // mint records sync_state so seedOutbox sees it as already-in-sync.
    const pushed = readOutbox(0).filter(
      (e) => e.table_name === "knowledge_meta" && e.row_id === "kpeer",
    );
    expect(pushed).toHaveLength(0);
  });

  test("a pull-minted register seeds last_reinforced_at to NOW (not NULL) — no premature decay", () => {
    const pid = ensureProject(PROJ);
    const before = Date.now();
    // Pull an entry authored long ago on another device (old content clock).
    applyRemoteKnowledge({
      id: "kold",
      title: "old peer entry",
      content: "old body",
      category: "decision",
      project_id: pid,
      created_at: 1,
      updated_at: 1, // author's ancient content clock
    });
    // The minted register's decay clock must be a local first-appearance touch, NOT
    // NULL: decayProject grace-checks COALESCE(last_reinforced_at, k.updated_at), and
    // NULL would fall back to updated_at=1 (1970) → instantly decay-eligible → a local
    // decay that (now being a CRDT counter) would sync back and spuriously lower the
    // entry for every replica.
    const lra = (
      db()
        .query(
          "SELECT last_reinforced_at FROM knowledge_meta WHERE logical_id = ?",
        )
        .get("kold") as { last_reinforced_at: number | null }
    ).last_reinforced_at;
    expect(lra).not.toBeNull();
    expect(lra as number).toBeGreaterThanOrEqual(before);
  });
});

describe("tier-aware table selection (D-2, #826)", () => {
  afterEach(() => db().exec("DELETE FROM profiles"));

  test("syncedTablesFor is cumulative: basic ⊆ pro ⊆ max", () => {
    const names = (t: "basic" | "pro" | "max") =>
      syncedTablesFor(t).map((m) => m.table);
    const basic = names("basic");
    const pro = names("pro");
    const max = names("max");
    // basic equals the registered basic set exactly
    expect(new Set(basic)).toEqual(
      new Set(SYNCED_TABLES.basic.map((m) => m.table)),
    );
    // cumulative containment: every lower-tier table is present in the higher tier
    for (const t of basic) expect(pro).toContain(t);
    for (const t of pro) expect(max).toContain(t);
    // no duplicate table within a tier's cumulative set
    expect(new Set(pro).size).toBe(pro.length);
    // non-cumulative accessor still returns exactly one tier's set
    expect(syncedTables("basic")).toBe(SYNCED_TABLES.basic);
  });

  test("currentSyncTier maps the plan tier from the profiles mirror", () => {
    const setPlan = (tier?: string) => {
      db().exec("DELETE FROM profiles");
      if (tier)
        db().query("INSERT INTO profiles (id, tier) VALUES ('u', ?)").run(tier);
    };
    setPlan(); // no profile pulled yet → default
    expect(currentSyncTier()).toBe("basic");
    setPlan("free");
    expect(currentSyncTier()).toBe("basic");
    setPlan("pro");
    expect(currentSyncTier()).toBe("pro");
    setPlan("max");
    expect(currentSyncTier()).toBe("max");
    setPlan("enterprise"); // unknown plan → safe default, never throws
    expect(currentSyncTier()).toBe("basic");
  });

  test("metaFor resolves any registered table regardless of tier; throws for unknown", () => {
    expect(metaFor("knowledge").table).toBe("knowledge");
    expect(() => metaFor("not_a_table")).toThrow(/not a synced table/);
  });
});
