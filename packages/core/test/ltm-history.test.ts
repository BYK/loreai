import { describe, expect, test } from "vitest";
import { projectId } from "../src/db";
import * as ltm from "../src/ltm";

const PROJECT = "/test/962/history";

describe("knowledge version history (#962)", () => {
  test("versionHistory returns every version oldest→newest, resolving a version id OR logical_id", () => {
    const id = ltm.create({
      projectPath: PROJECT,
      scope: "project",
      category: "pattern",
      title: "T1",
      content: "c1",
    });
    ltm.update(id, { content: "c2" }); // v2 (content-only: title/category carry forward)
    ltm.update(id, { content: "c3" }); // v3

    const h = ltm.versionHistory(id);
    expect(h.map((v) => v.version)).toEqual([1, 2, 3]);
    expect(h.map((v) => v.content)).toEqual(["c1", "c2", "c3"]);
    expect(h[0].is_current).toBe(0); // superseded
    expect(h[2].is_current).toBe(1); // head
    expect(h.every((v) => v.title === "T1")).toBe(true); // carried forward

    // Resolves by logical_id AND by any SUPERSEDED version id (logicalIdOf).
    const logical = h[0].logical_id;
    expect(ltm.versionHistory(logical).map((v) => v.version)).toEqual([
      1, 2, 3,
    ]);
    expect(ltm.versionHistory(h[0].id).map((v) => v.version)).toEqual([
      1, 2, 3,
    ]);
  });

  test("versionHistory reflects a title/category change (appendVersion path)", () => {
    const id = ltm.create({
      projectPath: PROJECT,
      scope: "project",
      category: "pattern",
      title: "Old",
      content: "x1",
    });
    ltm.appendVersion(ltm.logicalIdOf(id), {
      title: "New",
      category: "gotcha",
      content: "x2",
    });
    const h = ltm.versionHistory(id);
    expect(h.map((v) => v.title)).toEqual(["Old", "New"]);
    expect(h.map((v) => v.category)).toEqual(["pattern", "gotcha"]);
  });

  test("versionHistory includes the death-cert head after remove()", () => {
    const id = ltm.create({
      projectPath: PROJECT,
      scope: "project",
      category: "pattern",
      title: "D",
      content: "d1",
    });
    ltm.remove(id);
    const h = ltm.versionHistory(id);
    const head = h[h.length - 1];
    expect(head.is_deleted).toBe(1);
    expect(head.is_current).toBe(1);
  });

  test("versionHistory is empty for an unknown id", () => {
    expect(ltm.versionHistory("does-not-exist")).toEqual([]);
  });

  test("recentKnowledgeChanges returns the project's version rows newest-first, limited", () => {
    const pid = projectId(PROJECT);
    expect(pid).toBeTruthy();
    const rows = ltm.recentKnowledgeChanges(pid as string, 50);
    expect(rows.length).toBeGreaterThan(0);
    for (let i = 1; i < rows.length; i++)
      expect(rows[i - 1].updated_at).toBeGreaterThanOrEqual(rows[i].updated_at);
    expect(
      ltm.recentKnowledgeChanges(pid as string, 1).length,
    ).toBeLessThanOrEqual(1);
  });
});
