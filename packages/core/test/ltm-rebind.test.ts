import { beforeEach, describe, expect, test } from "vitest";
import { db, ensureProject } from "../src/db";
import * as entities from "../src/entities";
import * as ltm from "../src/ltm";

const PROJECT = "/test/a2/rebind";
const OTHER = "/test/a2/rebind-other";

// 2b-1 makes every stable-identity linkage key on logical_id rather than the
// per-version row id. These tests prove the links survive a version append by
// calling appendVersion() directly (which 2b-2 will wire into update()). Today
// id == logical_id, so they would ALSO pass if the code still keyed on id — the
// discriminating part is asserting the link resolves to the NEW current version
// (a different id) after the append.
describe("A2 sub-PR 2b-1: cross-references key on logical_id and survive version appends", () => {
  beforeEach(() => {
    const pid = ensureProject(PROJECT);
    db().query("DELETE FROM knowledge_refs").run();
    db().query("DELETE FROM knowledge_entity_refs").run();
    db().query("DELETE FROM knowledge_transfers").run();
    db().query("DELETE FROM knowledge WHERE project_id = ?").run(pid);
  });

  test("entity refs resolve to the new current version after appendVersion", () => {
    const id = ltm.create({
      projectPath: PROJECT,
      scope: "project",
      category: "decision",
      title: "EntityRefEntry",
      content: "v1 content",
    });
    const eid = entities.create({
      projectPath: PROJECT,
      entityType: "tool",
      canonicalName: "WidgetTool",
    }).id;
    entities.linkKnowledge(id, eid);
    expect(entities.knowledgeForEntity(eid)).toEqual([id]); // logical_id == id

    const v2 = ltm.appendVersion(id, { content: "v2 content" });
    expect(v2).not.toBeNull();
    expect(v2).not.toBe(id);

    // The ref still stores the stable logical_id (== original id)...
    expect(entities.knowledgeForEntity(eid)).toEqual([id]);
    // ...and resolving it yields the NEW current version, not the superseded v1.
    const cur = ltm.getByLogical(entities.knowledgeForEntity(eid)[0]);
    expect(cur?.id).toBe(v2);
    expect(cur?.content).toBe("v2 content");
    // entitiesForKnowledge resolves from a version id OR the logical_id.
    expect(
      entities.entitiesForKnowledge(v2 as string).map((e) => e.id),
    ).toEqual([eid]);
    expect(entities.entitiesForKnowledge(id).map((e) => e.id)).toEqual([eid]);
  });

  test("wiki refs (knowledge_refs) key on logical_id and survive a target append", () => {
    const target = ltm.create({
      projectPath: PROJECT,
      scope: "project",
      category: "decision",
      title: "TargetEntry",
      content: "target body",
    });
    const src = ltm.create({
      projectPath: PROJECT,
      scope: "project",
      category: "decision",
      title: "SrcEntry",
      content: "see [[TargetEntry]] for details",
    });
    expect(ltm.syncRefs(src)).toBe(1);
    const rows = () =>
      db().query("SELECT from_id, to_id FROM knowledge_refs").all() as Array<{
        from_id: string;
        to_id: string;
      }>;
    expect(rows()).toEqual([{ from_id: src, to_id: target }]);

    // Append a version of the TARGET — the ref's to_id (a logical_id) must keep
    // resolving, and cleanDeadRefs must NOT treat it as orphaned.
    const tv2 = ltm.appendVersion(target, { content: "updated target" });
    expect(ltm.cleanDeadRefs()).toBe(0);
    expect(rows()).toEqual([{ from_id: src, to_id: target }]);
    expect(ltm.getByLogical(target)?.id).toBe(tv2);
  });

  test("cleanDeadRefs drops a ref only once the target's last version is gone", () => {
    const target = ltm.create({
      projectPath: PROJECT,
      scope: "project",
      category: "decision",
      title: "DeadTarget",
      content: "doomed",
    });
    const src = ltm.create({
      projectPath: PROJECT,
      scope: "project",
      category: "decision",
      title: "DeadSrc",
      content: `points at [[${target}]] here`, // uuid link → content strip fires
    });
    ltm.syncRefs(src);
    // While the target has a current version, the ref is NOT dead.
    expect(ltm.cleanDeadRefs()).toBe(0);
    // Soft-delete the target via an is_deleted version append — no current version.
    ltm.appendVersion(target, { isDeleted: true });
    expect(ltm.cleanDeadRefs()).toBe(1); // now orphaned → row deleted + content stripped
    expect(
      db().query("SELECT COUNT(*) as c FROM knowledge_refs").get() as {
        c: number;
      },
    ).toEqual({ c: 0 });
  });

  test("transfer counts key on logical_id and survive a version append", () => {
    const id = ltm.create({
      projectPath: PROJECT,
      scope: "project",
      category: "decision",
      title: "TransferEntry",
      content: "x",
    });
    const otherPid = ensureProject(OTHER);
    ltm.recordTransfer({ knowledgeId: id, recalledInProjectId: otherPid });
    expect(ltm.transferCount(id)).toBe(1);

    const v2 = ltm.appendVersion(id, { content: "y" });
    expect(v2).not.toBe(id);
    expect(ltm.transferCount(id)).toBe(1); // keyed on logical_id, unaffected
  });

  test("remove() tombstones the logical_id", () => {
    const id = ltm.create({
      projectPath: PROJECT,
      scope: "project",
      category: "decision",
      title: "TombEntry",
      content: "z",
    });
    ltm.remove(id);
    expect(ltm.isTombstoned(id)).toBe(true); // id == logical_id
  });

  test("ref WRITES invoked with a superseded version id store the logical_id", () => {
    const id = ltm.create({
      projectPath: PROJECT,
      scope: "project",
      category: "decision",
      title: "WriteResolveEntry",
      content: "v1 body",
    });
    const eid = entities.create({
      projectPath: PROJECT,
      entityType: "tool",
      canonicalName: "GadgetTool",
    }).id;
    // Append a version so the current row id (v2) differs from the logical_id.
    const v2 = ltm.appendVersion(id, { content: "now mentions GadgetTool" });
    expect(v2).not.toBe(id);

    // Sync refs using the CURRENT version id (v2) — both writers must resolve to
    // the stable logical_id (id), not store the raw v2.
    entities.syncEntityRefs(v2 as string, "now mentions GadgetTool");
    const entRef = db()
      .query(
        "SELECT knowledge_id FROM knowledge_entity_refs WHERE entity_id = ?",
      )
      .all(eid) as Array<{ knowledge_id: string }>;
    expect(entRef).toEqual([{ knowledge_id: id }]); // logical_id, NOT v2

    // wiki-ref writer too: syncRefs(v2) must key from_id on the logical_id.
    const target = ltm.create({
      projectPath: PROJECT,
      scope: "project",
      category: "decision",
      title: "WRTarget",
      content: "target",
    });
    db()
      .query("UPDATE knowledge SET content = ? WHERE id = ?")
      .run(`now mentions GadgetTool and [[${target}]]`, v2);
    ltm.syncRefs(v2 as string);
    const wikiRef = db()
      .query("SELECT from_id, to_id FROM knowledge_refs")
      .all() as Array<{ from_id: string; to_id: string }>;
    expect(wikiRef).toEqual([{ from_id: id, to_id: target }]); // from_id = logical_id
  });

  test(".lore.md marker is the logical_id and stays stable across an append", () => {
    const id = ltm.create({
      projectPath: PROJECT,
      scope: "project",
      category: "decision",
      title: "MarkerEntry",
      content: "marker v1",
    });
    const cur = ltm.getByLogical(id);
    expect(cur?.logical_id).toBe(id); // marker uses logical_id
    const v2 = ltm.appendVersion(id, { content: "marker v2" });
    // logical_id (the marker) is unchanged though the current row id moved.
    expect(ltm.getByLogical(id)?.logical_id).toBe(id);
    expect(ltm.getByLogical(id)?.id).toBe(v2);
  });
});
