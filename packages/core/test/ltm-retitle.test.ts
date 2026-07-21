import { describe, expect, test } from "vitest";
import { db, projectId } from "../src/db";
import * as ltm from "../src/ltm";

// D1b: the curator `update` op can re-title an entry whose scope broadened after
// a merge. Title is BOTH the top-weighted FTS field AND the exact-match dedup
// identity key, so re-titling must: append a new version, re-index FTS, and
// NEVER silently create two live entries with the same title in one scope.

const PROJECT = "/test/d1b/retitle";

function titleOf(logicalId: string): string {
  return ltm.getByLogical(logicalId)?.title ?? "";
}

describe("ltm.update re-title (D1b)", () => {
  test("a title-only change appends a new version with the new title", () => {
    const id = ltm.create({
      projectPath: PROJECT,
      scope: "project",
      category: "gotcha",
      title: "Narrow original title",
      content: "same content",
    });
    ltm.update(id, { title: "Broader merged title" });

    const h = ltm.versionHistory(id);
    expect(h.map((v) => v.title)).toEqual([
      "Narrow original title",
      "Broader merged title",
    ]);
    // content carried forward on the title-only new version
    expect(h.map((v) => v.content)).toEqual(["same content", "same content"]);
    expect(titleOf(ltm.logicalIdOf(id))).toBe("Broader merged title");
  });

  test("FTS re-indexes: the new title matches, the old title no longer does", () => {
    const id = ltm.create({
      projectPath: PROJECT,
      scope: "project",
      category: "gotcha",
      title: "Zebra widget crash",
      content: "body text",
    });
    expect(
      ltm.search({ query: "Zebra", projectPath: PROJECT }).map((e) => e.id),
    ).toContain(ltm.getByLogical(ltm.logicalIdOf(id))?.id);

    ltm.update(id, { title: "Giraffe widget crash" });

    const zebra = ltm.search({ query: "Zebra", projectPath: PROJECT });
    const logical = ltm.logicalIdOf(id);
    expect(zebra.some((e) => ltm.logicalIdOf(e.id) === logical)).toBe(false);
    const giraffe = ltm.search({ query: "Giraffe", projectPath: PROJECT });
    expect(giraffe.some((e) => ltm.logicalIdOf(e.id) === logical)).toBe(true);
  });

  test("a re-title that collides with another live entry in-scope is DROPPED (no duplicate)", () => {
    const a = ltm.create({
      projectPath: PROJECT,
      scope: "project",
      category: "gotcha",
      title: "Postgres connection pool exhaustion",
      content: "a body",
    });
    ltm.create({
      projectPath: PROJECT,
      scope: "project",
      category: "gotcha",
      title: "Redis eviction thrash under load",
      content: "b body",
    });
    // Try to re-title A onto B's title (case-insensitive) — must be a no-op title.
    ltm.update(a, {
      title: "redis EVICTION thrash under LOAD",
      content: "a body v2",
    });

    // A keeps its own title (collision dropped); the content update still applied.
    expect(titleOf(ltm.logicalIdOf(a))).toBe(
      "Postgres connection pool exhaustion",
    );
    expect(ltm.getByLogical(ltm.logicalIdOf(a))?.content).toBe("a body v2");

    // Exactly ONE live entry owns the B title (no silent duplicate).
    const bTitled = ltm
      .search({ query: "Redis eviction thrash", projectPath: PROJECT })
      .filter(
        (e) => e.title.toLowerCase() === "redis eviction thrash under load",
      );
    expect(bTitled).toHaveLength(1);
  });

  test("a case-only re-title of the same entry is not a collision (excludes self)", () => {
    const id = ltm.create({
      projectPath: PROJECT,
      scope: "project",
      category: "gotcha",
      title: "casing matters here",
      content: "c body",
    });
    ltm.update(id, { title: "Casing Matters Here" });
    expect(titleOf(ltm.logicalIdOf(id))).toBe("Casing Matters Here");
  });

  test("re-title + content together append one version with both", () => {
    const id = ltm.create({
      projectPath: PROJECT,
      scope: "project",
      category: "gotcha",
      title: "Old T",
      content: "old c",
    });
    ltm.update(id, { title: "New T", content: "new c" });
    const cur = ltm.getByLogical(ltm.logicalIdOf(id));
    expect(cur?.title).toBe("New T");
    expect(cur?.content).toBe("new c");
    // one create + one update = two versions
    expect(ltm.versionHistory(id).map((v) => v.version)).toEqual([1, 2]);
  });

  test("re-title to the identical title is a no-op (no version growth)", () => {
    const id = ltm.create({
      projectPath: PROJECT,
      scope: "project",
      category: "gotcha",
      title: "Idempotent title",
      content: "body",
    });
    ltm.update(id, { title: "Idempotent title" });
    expect(ltm.versionHistory(id).map((v) => v.version)).toEqual([1]);
  });

  test("a PROMOTED entry re-titled onto a same-project sibling's title is DROPPED", () => {
    // Regression for the titleCollides promoted-entry scope gap: a promoted entry
    // (project_id set, cross_project=1) is still surfaced in its home project, so a
    // same-project sibling with that title is a real duplicate and must be caught.
    const promoted = ltm.create({
      projectPath: PROJECT,
      scope: "project",
      category: "gotcha",
      title: "Promoted OAuth refresh bug",
      content: "p body",
    });
    const sibling = ltm.create({
      projectPath: PROJECT,
      scope: "project",
      category: "gotcha",
      title: "Plain DNS resolver timeout",
      content: "s body",
    });
    // Promote the first entry in place (project_id kept, cross_project flipped) —
    // the exact state promoteCrossProject produces, without the embed/cluster cost.
    db()
      .query(
        "UPDATE knowledge SET cross_project = 1 WHERE logical_id = ? AND is_current = 1",
      )
      .run(ltm.logicalIdOf(promoted));
    expect(ltm.getByLogical(ltm.logicalIdOf(promoted))?.cross_project).toBe(1);

    // Re-title the promoted entry onto the sibling's title → must be dropped.
    ltm.update(promoted, { title: "Plain DNS resolver timeout" });
    expect(ltm.getByLogical(ltm.logicalIdOf(promoted))?.title).toBe(
      "Promoted OAuth refresh bug",
    );
    // Exactly ONE live entry owns the sibling title in this project.
    const pid = projectId(PROJECT) as string;
    const live = db()
      .query(
        `SELECT COUNT(*) AS n FROM knowledge_current
           WHERE LOWER(title) = LOWER(?)
             AND (project_id = ? OR cross_project = 1 OR project_id IS NULL)`,
      )
      .get("Plain DNS resolver timeout", pid) as { n: number };
    expect(live.n).toBe(1);
    expect(sibling).toBeTruthy();
  });
});
