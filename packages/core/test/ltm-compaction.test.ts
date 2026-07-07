import { beforeEach, describe, expect, test } from "vitest";
import { db } from "../src/db";
import * as entities from "../src/entities";
import { enableSync } from "../src/sync-data";
import * as ltm from "../src/ltm";

const PROJECT = "/test/909/compaction";

function versionNums(logicalId: string): number[] {
  return (
    db()
      .query(
        "SELECT version FROM knowledge WHERE logical_id = ? ORDER BY version",
      )
      .all(logicalId) as Array<{ version: number }>
  ).map((r) => r.version);
}

function makeVersions(seed: string, appends: number): string {
  const id = ltm.create({
    projectPath: PROJECT,
    scope: "project",
    category: "decision",
    title: `T-${seed}`,
    content: `${seed}-v1`,
  });
  for (let i = 0; i < appends; i++) {
    ltm.appendVersion(id, { content: `${seed}-v${i + 2}` });
  }
  return id;
}

describe("#909 compactKnowledgeVersions", () => {
  beforeEach(() => {
    // Isolate each test from prior versions/refs in the shared file DB.
    db().exec(
      "DELETE FROM knowledge_entity_refs; DELETE FROM knowledge_refs; DELETE FROM knowledge; DELETE FROM entities; DELETE FROM sync_outbox",
    );
  });

  test("keeps the head + 2 most-recent superseded; prunes the rest (count cap)", () => {
    const id = makeVersions("count", 4); // v1..v5, v5 current
    expect(versionNums(id)).toEqual([1, 2, 3, 4, 5]);
    const pruned = ltm.compactKnowledgeVersions();
    expect(pruned).toBe(2); // v1, v2
    expect(versionNums(id)).toEqual([3, 4, 5]); // head v5 + 2 most-recent superseded
    // The head is untouched and still current.
    expect(
      db()
        .query("SELECT version FROM knowledge_current WHERE logical_id = ?")
        .get(id),
    ).toEqual({ version: 5 });
  });

  test("age cap drops a superseded version older than 60d even within the count window", () => {
    const id = makeVersions("age", 2); // v1,v2 superseded (both within count cap of 2), v3 current
    const v1 = db()
      .query("SELECT id FROM knowledge WHERE logical_id = ? AND version = 1")
      .get(id) as { id: string };
    // Age v1 past the ~60d cap; v2 stays recent.
    db()
      .query("UPDATE knowledge SET updated_at = ? WHERE id = ?")
      .run(Date.now() - 200 * 24 * 60 * 60 * 1000, v1.id);
    const pruned = ltm.compactKnowledgeVersions();
    expect(pruned).toBe(1); // only the aged v1
    expect(versionNums(id)).toEqual([2, 3]);
  });

  test("never touches the current head (single-version entry is a no-op)", () => {
    const id = makeVersions("head", 0); // v1 current only
    expect(ltm.compactKnowledgeVersions()).toBe(0);
    expect(versionNums(id)).toEqual([1]);
  });

  test("prunes the v1 anchor safely — entity + wiki refs survive and still resolve", () => {
    const id = makeVersions("anchor", 3); // v1(anchor)..v4, v4 current; v1..v3 superseded
    const ent = entities.create({
      projectPath: PROJECT,
      entityType: "tool",
      canonicalName: "Widget",
    });
    entities.linkKnowledge(id, ent.id); // keyed by logical_id (== v1 anchor id)
    // A wiki ref keyed on logical_id (from this entry to itself is fine for the FK test).
    db()
      .query("INSERT INTO knowledge_refs (from_id, to_id) VALUES (?, ?)")
      .run(id, id);

    const pruned = ltm.compactKnowledgeVersions();
    expect(pruned).toBe(1); // v1 anchor (beyond the 2 most-recent superseded)
    // The v1 anchor row (id == logical_id) is gone...
    expect(
      db().query("SELECT 1 FROM knowledge WHERE id = ?").get(id),
    ).toBeNull();
    // ...but the refs did NOT cascade (FK dropped in v66) and still resolve via logical_id.
    expect(
      db()
        .query(
          "SELECT COUNT(*) AS n FROM knowledge_entity_refs WHERE knowledge_id = ? AND entity_id = ?",
        )
        .get(id, ent.id),
    ).toEqual({ n: 1 });
    expect(
      db()
        .query("SELECT COUNT(*) AS n FROM knowledge_refs WHERE from_id = ?")
        .get(id),
    ).toEqual({ n: 1 });
    expect(entities.entitiesForKnowledge(id).map((e) => e.id)).toEqual([
      ent.id,
    ]);
  });

  test("runs under sync-suppression — pruning enqueues NO outbox rows", () => {
    const id = makeVersions("sync", 4); // v1..v5
    enableSync(); // capture triggers now enqueue on mutation (unless suppressed)
    db().exec("DELETE FROM sync_outbox"); // clear the seed
    const pruned = ltm.compactKnowledgeVersions();
    expect(pruned).toBeGreaterThan(0);
    expect(db().query("SELECT COUNT(*) AS n FROM sync_outbox").get()).toEqual({
      n: 0,
    });
    // The live entry is unchanged and still resolves.
    expect(versionNums(id)).toEqual([3, 4, 5]);
  });
});
