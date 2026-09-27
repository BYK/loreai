import { describe, expect, test } from "vitest";
import {
  db,
  ensureProject,
  loadSessionTracking,
  saveSessionTracking,
} from "../src/db";
import * as ltm from "../src/ltm";
import { clearAllEmbeddings, storeEmbedding } from "../src/db/vec-store";
import { withTenant } from "../src/tenant";

describe("context LTM selection revision", () => {
  test("keeps v91 cache stamp layout until a vector index changes", () => {
    const path = `/tmp/ltm-v91-stamp-${crypto.randomUUID()}`;
    const pid = ensureProject(path);
    expect(ltm.selectionRevision(path).split(":")).toHaveLength(4);
    expect(
      ltm.selectionRevision(path, ["distillation", "temporal"]).split(":"),
    ).toHaveLength(8);
    const id = crypto.randomUUID();
    db()
      .query(
        "INSERT INTO knowledge (id, project_id, category, title, content, created_at, updated_at, logical_id) VALUES (?, ?, 'gotcha', 'Still valid after the migration', 'Accepted selection', ?, ?, ?)",
      )
      .run(id, pid, Date.now(), Date.now(), id);
    expect(ltm.selectionRevision(path).split(":")).toHaveLength(4);
    storeEmbedding(db(), "knowledge", id, new Float32Array([1, 0, 0, 0]));
    expect(ltm.selectionRevision(path).split(":")).toHaveLength(6);
  });
  test("tracks other sessions' knowledge writes, imports, confidence changes, and removals", () => {
    const projectPath = `/tmp/ltm-revision-${crypto.randomUUID()}`;
    const revision = () => ltm.selectionRevision(projectPath);
    const original = revision();
    const id = ltm.create({
      projectPath,
      scope: "project",
      category: "gotcha",
      title: "Note from another session",
      content: "Original content",
      session: "session-b",
    });
    const created = revision();
    expect(created).not.toBe(original);
    db()
      .query("UPDATE knowledge SET title = ? WHERE id = ?")
      .run("Updated remotely", id);
    const updated = revision();
    expect(updated).not.toBe(created);

    const { logical_id } = db()
      .query("SELECT logical_id FROM knowledge WHERE id = ?")
      .get(id) as { logical_id: string };
    db()
      .query("UPDATE knowledge_meta SET confidence = 0.1 WHERE logical_id = ?")
      .run(logical_id);
    const pruned = revision();
    expect(pruned).not.toBe(updated);
    db()
      .query("UPDATE knowledge_meta SET confidence = 0.8 WHERE logical_id = ?")
      .run(logical_id);
    const revived = revision();
    expect(revived).not.toBe(pruned);
    ltm.remove(id);
    expect(revision()).not.toBe(revived);
  });

  test("confidence ranking changes invalidate selection above the eligibility floor", () => {
    const path = `/tmp/ltm-confidence-revision-${crypto.randomUUID()}`;
    const pid = ensureProject(path);
    const revision = () => ltm.selectionRevision(path);
    const logicalId = crypto.randomUUID();
    db()
      .query(
        "INSERT INTO knowledge (id, project_id, category, title, content, created_at, updated_at, logical_id) VALUES (?, ?, 'gotcha', 'Ranked candidate', 'Confidence affects packing', ?, ?, ?)",
      )
      .run(logicalId, pid, Date.now(), Date.now(), logicalId);
    const withoutMeta = revision();
    db()
      .query(
        "INSERT INTO knowledge_meta (logical_id, confidence, base_confidence, updated_at) VALUES (?, 0.3, 0.3, ?)",
      )
      .run(logicalId, Date.now());
    const createdMeta = revision();
    expect(createdMeta).not.toBe(withoutMeta);
    db()
      .query("UPDATE knowledge_meta SET confidence = 0.9 WHERE logical_id = ?")
      .run(logicalId);
    const rankedHigher = revision();
    expect(rankedHigher).not.toBe(createdMeta);
    db()
      .query(
        "UPDATE knowledge_meta SET last_reinforced_at = ? WHERE logical_id = ?",
      )
      .run(Date.now(), logicalId);
    expect(revision()).toBe(rankedHigher);
  });

  test("separates project knowledge while sharing global entries and tracking promotion", () => {
    const projectA = `/tmp/ltm-revision-a-${crypto.randomUUID()}`;
    const projectB = `/tmp/ltm-revision-b-${crypto.randomUUID()}`;
    const a = () => ltm.selectionRevision(projectA);
    const b = () => ltm.selectionRevision(projectB);
    const originalA = a();
    const originalB = b();
    const id = ltm.create({
      projectPath: projectA,
      scope: "project",
      category: "gotcha",
      title: "Scoped knowledge",
      content: "Project A only",
    });
    expect(a()).not.toBe(originalA);
    expect(b()).toBe(originalB);

    const beforePromotionB = b();
    db().query("UPDATE knowledge SET cross_project = 1 WHERE id = ?").run(id);
    expect(b()).not.toBe(beforePromotionB);

    const beforeMoveA = a();
    const beforeMoveB = b();
    db()
      .query(
        "UPDATE knowledge SET cross_project = 0, project_id = ? WHERE id = ?",
      )
      .run(ensureProject(projectB), id);
    expect(a()).not.toBe(beforeMoveA);
    expect(b()).not.toBe(beforeMoveB);
    expect(a().split(":")[0]).not.toBe(b().split(":")[0]);
  });

  test("keeps equal project paths from different tenants isolated", () => {
    const projectPath = `/tmp/ltm-tenant-revision-${crypto.randomUUID()}`;
    const a = () =>
      withTenant("revision-tenant-a", () => ltm.selectionRevision(projectPath));
    const b = () =>
      withTenant("revision-tenant-b", () => ltm.selectionRevision(projectPath));
    const beforeA = a();
    const beforeB = b();
    withTenant("revision-tenant-a", () => {
      ltm.create({
        projectPath,
        scope: "project",
        category: "gotcha",
        title: "Private tenant rule",
        content: "A tenant only",
      });
    });
    expect(a()).not.toBe(beforeA);
    expect(b()).toBe(beforeB);
  });

  test("tracks project-wide distillations even when older rows are archived or deleted", () => {
    const projectPath = `/tmp/ltm-revision-${crypto.randomUUID()}`;
    const projectID = ensureProject(projectPath);
    const revision = () => ltm.selectionRevision(projectPath, ["distillation"]);
    const before = revision();
    const first = crypto.randomUUID();
    const second = crypto.randomUUID();
    const insert = db().query(`INSERT INTO distillations
      (id, project_id, session_id, narrative, facts, source_ids, created_at)
      VALUES (?, ?, ?, '', '[]', '[]', ?)`);
    insert.run(first, projectID, "session-b", Date.now());
    insert.run(second, projectID, "session-c", Date.now());
    const inserted = revision();
    expect(inserted).not.toBe(before);
    db().query("UPDATE distillations SET archived = 1 WHERE id = ?").run(first);
    const archived = revision();
    expect(archived).not.toBe(inserted);
    db().query("DELETE FROM distillations WHERE id = ?").run(first);
    expect(revision()).not.toBe(archived);

    saveSessionTracking("session-b", { ltmCacheRevision: revision() });
    expect(loadSessionTracking("session-b")?.ltmCacheRevision).toBe(revision());
  });

  test("temporal sources track cross-session edits and deletions but skip bookkeeping", () => {
    const projectPath = `/tmp/ltm-revision-temporal-${crypto.randomUUID()}`;
    const projectID = ensureProject(projectPath);
    const revision = () => ltm.selectionRevision(projectPath, ["temporal"]);
    const before = revision();
    const first = crypto.randomUUID();
    const second = crypto.randomUUID();
    const insert = db().query(`INSERT INTO temporal_messages
      (id, project_id, session_id, role, content, created_at)
      VALUES (?, ?, 'other-session', 'user', ?, ?)`);
    insert.run(first, projectID, "Starting content", Date.now());
    insert.run(second, projectID, "Latest content", Date.now());
    const inserted = revision();
    expect(inserted).not.toBe(before);
    db()
      .query("UPDATE temporal_messages SET distilled = 1 WHERE id = ?")
      .run(first);
    expect(revision()).toBe(inserted);
    db()
      .query(
        "UPDATE temporal_messages SET content = 'New content' WHERE id = ?",
      )
      .run(first);
    const edited = revision();
    expect(edited).not.toBe(inserted);
    db().query("DELETE FROM temporal_messages WHERE id = ?").run(first);
    expect(revision()).not.toBe(edited);
  });

  test("tracks indexed lat.md sections independently of configured context sources", () => {
    const projectPath = `/tmp/ltm-revision-lat-${crypto.randomUUID()}`;
    const projectID = ensureProject(projectPath);
    const revision = () => ltm.selectionRevision(projectPath);
    const original = revision();
    const id = crypto.randomUUID();
    db()
      .query(`INSERT INTO lat_sections
        (id, project_id, file, heading, depth, content, content_hash, updated_at)
        VALUES (?, ?, 'rules.md', 'Rule', 1, 'Original rule', 'h1', ?)`)
      .run(id, projectID, Date.now());
    const inserted = revision();
    expect(inserted).not.toBe(original);
    db()
      .query("UPDATE lat_sections SET content = 'Revised rule' WHERE id = ?")
      .run(id);
    const revised = revision();
    expect(revised).not.toBe(inserted);
    db().query("DELETE FROM lat_sections WHERE id = ?").run(id);
    expect(revision()).not.toBe(revised);
  });

  test("late blob embeddings advance relevant selection revisions", () => {
    const path = `/tmp/ltm-blob-revision-${crypto.randomUUID()}`;
    const pid = ensureProject(path);
    const revKnowledge = () => ltm.selectionRevision(path);
    const revSources = () =>
      ltm.selectionRevision(path, ["distillation", "temporal"]);
    const id = ltm.create({
      projectPath: path,
      scope: "project",
      category: "gotcha",
      title: "Late vector",
      content: "Newly indexed after the selection",
    });
    const beforeKnowledge = revKnowledge();
    storeEmbedding(db(), "knowledge", id, new Float32Array([1, 0, 0, 0]));
    expect(revKnowledge()).not.toBe(beforeKnowledge);

    const distillId = crypto.randomUUID();
    db()
      .query(`INSERT INTO distillations (id, project_id, session_id, narrative, facts, source_ids, created_at)
      VALUES (?, ?, 'other', '', '[]', '[]', ?)`)
      .run(distillId, pid, Date.now());
    const beforeDistill = revSources();
    storeEmbedding(
      db(),
      "distillations",
      distillId,
      new Float32Array([1, 0, 0, 0]),
    );
    expect(revSources()).not.toBe(beforeDistill);

    const temporalId = crypto.randomUUID();
    db()
      .query(`INSERT INTO temporal_messages (id, project_id, session_id, role, content, created_at)
      VALUES (?, ?, 'other', 'user', 'Delayed vector', ?)`)
      .run(temporalId, pid, Date.now());
    const beforeTemporal = revSources();
    storeEmbedding(
      db(),
      "temporal",
      temporalId,
      new Float32Array([1, 0, 0, 0]),
    );
    expect(revSources()).not.toBe(beforeTemporal);
    const beforeClear = revSources();
    clearAllEmbeddings(db());
    expect(revSources()).not.toBe(beforeClear);
  });

  test("a failed revision write rolls back the blob vector", () => {
    const path = `/tmp/ltm-embedding-atomic-${crypto.randomUUID()}`;
    const id = ltm.create({
      projectPath: path,
      scope: "project",
      category: "gotcha",
      title: "Atomic indexing",
      content: "No searchable vector without a revision",
    });
    db().exec(`CREATE TEMP TRIGGER fail_context_revision
      BEFORE UPDATE ON context_ltm_revision BEGIN
        SELECT RAISE(ABORT, 'revision write failed');
      END`);
    try {
      expect(() =>
        storeEmbedding(db(), "knowledge", id, new Float32Array([1, 0, 0, 0])),
      ).toThrow("revision write failed");
      const row = db()
        .query("SELECT embedding FROM knowledge WHERE id = ?")
        .get(id) as { embedding: Uint8Array | null };
      expect(row.embedding).toBeNull();
    } finally {
      db().exec("DROP TRIGGER fail_context_revision");
    }
  });
});
