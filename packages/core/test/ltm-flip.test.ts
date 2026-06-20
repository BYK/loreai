import { beforeEach, describe, expect, test } from "vitest";
import { db, ensureProject } from "../src/db";
import * as entities from "../src/entities";
import * as ltm from "../src/ltm";

const PROJECT = "/test/a2/flip";
const OTHER = "/test/a2/flip-other";

const countVersions = (logicalId: string) =>
  (
    db()
      .query("SELECT COUNT(*) c FROM knowledge WHERE logical_id = ?")
      .get(logicalId) as { c: number }
  ).c;

// 2b-2b wires update()/remove() onto appendVersion. These tests pin the new
// invariants: content changes append immutable versions, mutable metadata stays
// in place, and remove() appends a death certificate AND cleans cross-references
// explicitly (FK ON DELETE CASCADE is dormant because nothing is physically deleted).
describe("A2 sub-PR 2b-2b: update()/remove() append flip", () => {
  beforeEach(() => {
    const pid = ensureProject(PROJECT);
    db().query("DELETE FROM knowledge_refs").run();
    db().query("DELETE FROM knowledge_entity_refs").run();
    db().query("DELETE FROM knowledge_transfers").run();
    db().query("DELETE FROM knowledge WHERE project_id = ?").run(pid);
  });

  const mk = (title: string, content: string, confidence = 1.0) =>
    ltm.create({
      projectPath: PROJECT,
      scope: "project",
      category: "decision",
      title,
      content,
      confidence,
    });

  test("update() with a content change appends a version and applies confidence to it", () => {
    const id = mk("ContentUpd", "v1body", 1.0);
    ltm.update(id, { content: "v2body", confidence: 0.7 });
    expect(countVersions(id)).toBe(2);
    const cur = ltm.getByLogical(id);
    expect(cur?.content).toBe("v2body");
    expect(cur?.confidence).toBe(0.7);
    expect(cur?.id).not.toBe(id); // current row moved to the new version
    // The prior version is preserved, immutable, with its original content.
    const v1 = db()
      .query("SELECT content, confidence FROM knowledge WHERE id = ?")
      .get(id) as { content: string; confidence: number };
    expect(v1.content).toBe("v1body");
  });

  test("update() with only mutable fields does NOT append a version", () => {
    const id = mk("MutableUpd", "body", 1.0);
    ltm.update(id, { confidence: 0.4 });
    expect(countVersions(id)).toBe(1); // no new version row
    const cur = ltm.getByLogical(id);
    expect(cur?.id).toBe(id); // still the original row, mutated in place
    expect(cur?.confidence).toBe(0.4);
  });

  test("remove() appends a death certificate; the entry is gone and tombstoned", () => {
    const id = mk("RemoveMe", "body");
    ltm.remove(id);
    expect(countVersions(id)).toBe(2); // v1 + is_deleted death cert
    expect(ltm.get(id)).toBeNull();
    expect(ltm.getByLogical(id)).toBeNull(); // no current, live version
    expect(ltm.isTombstoned(id)).toBe(true);
    // Append-only: the original row is NOT physically deleted.
    expect(
      (
        db().query("SELECT COUNT(*) c FROM knowledge WHERE id = ?").get(id) as {
          c: number;
        }
      ).c,
    ).toBe(1);
  });

  test("remove() explicitly cleans entity refs, wiki refs, and transfers (FK CASCADE dormant)", () => {
    const target = mk("FlipTarget", "target body");
    const src = mk("FlipSrc", `links to [[${target}]] here`);
    expect(ltm.syncRefs(src)).toBe(1);
    const eid = entities.create({
      projectPath: PROJECT,
      entityType: "tool",
      canonicalName: "FlipWidget",
    }).id;
    entities.linkKnowledge(src, eid);
    ltm.recordTransfer({
      knowledgeId: src,
      recalledInProjectId: ensureProject(OTHER),
    });

    // Sanity: the refs exist before removal.
    expect(entities.knowledgeForEntity(eid)).toContain(src);
    expect(ltm.transferCount(src)).toBe(1);
    const refRows = () =>
      (
        db()
          .query(
            "SELECT COUNT(*) c FROM knowledge_refs WHERE from_id = ? OR to_id = ?",
          )
          .get(src, src) as { c: number }
      ).c;
    expect(refRows()).toBe(1);

    ltm.remove(src);

    // The row was NOT physically deleted (append-only) so ON DELETE CASCADE never
    // fired — remove() must have cleaned every cross-reference explicitly.
    expect(countVersions(src)).toBe(2);
    expect(entities.knowledgeForEntity(eid)).not.toContain(src);
    expect(ltm.transferCount(src)).toBe(0);
    expect(refRows()).toBe(0);
  });

  test("remove() on an already-deleted entry is a no-op (no extra death cert)", () => {
    const id = mk("DoubleRemove", "body");
    ltm.remove(id);
    const after1 = countVersions(id);
    ltm.remove(id);
    expect(countVersions(id)).toBe(after1); // no second death-cert version
  });

  test("a second update() appends v3 and refs still resolve to the current version", () => {
    const id = mk("Chain", "c1");
    ltm.update(id, { content: "c2" });
    ltm.update(id, { content: "c3" });
    expect(countVersions(id)).toBe(3);
    const cur = ltm.getByLogical(id);
    expect(cur?.content).toBe("c3");
    // syncRefs invoked with the ORIGINAL id (now superseded) still keys on logical_id.
    const eid = entities.create({
      projectPath: PROJECT,
      entityType: "tool",
      canonicalName: "ChainWidget",
    }).id;
    entities.syncEntityRefs(id, "mentions ChainWidget"); // id is superseded
    expect(entities.knowledgeForEntity(eid)).toEqual([id]); // stored as logical_id
    expect(ltm.getByLogical(entities.knowledgeForEntity(eid)[0])?.id).toBe(
      cur?.id,
    );
  });
});
