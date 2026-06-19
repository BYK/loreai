import { describe, expect, test } from "vitest";
import { applyOps, enforceEntryCap } from "../src/curator";
import type { ChangedEntry } from "../src/curator";
import { db, ensureProject } from "../src/db";
import * as ltm from "../src/ltm";

const PROJECT = "/tmp/lore-curator-delta/project";

describe("curator applyOps changedEntries", () => {
  test("returns createdEntries for genuine creates", () => {
    const result = applyOps(
      [
        {
          op: "create",
          category: "preference",
          title: "Delta Create Test",
          content: "Use durable prompt deltas for new knowledge.",
          scope: "project",
        },
      ],
      { projectPath: PROJECT, sessionID: "sess-create" },
    );

    expect(result.created).toBe(1);
    expect(result.changedEntries).toHaveLength(1);
    expect(result.changedEntries[0]).toMatchObject({
      op: "created",
      category: "preference",
      title: "Delta Create Test",
      content: "Use durable prompt deltas for new knowledge.",
    });
    expect(result.changedEntries[0]?.id).toBeTruthy();
  });

  test("reports dedup-merged creates as updated entries", () => {
    const id = ltm.create({
      projectPath: PROJECT,
      category: "preference",
      title: "Dedup Delta Test",
      content: "original",
      scope: "project",
    });

    const result = applyOps(
      [
        {
          op: "create",
          category: "preference",
          title: "Dedup Delta Test",
          content: "updated by dedup",
          scope: "project",
        },
      ],
      { projectPath: PROJECT, sessionID: "sess-dedup" },
    );

    expect(result.created).toBe(0);
    expect(result.updated).toBe(1);
    expect(result.changedEntries).toEqual([
      expect.objectContaining({
        op: "updated",
        id,
        category: "preference",
        title: "Dedup Delta Test",
        content: "updated by dedup",
        prevContent: "original",
      }),
    ]);
    expect(ltm.get(id)?.content).toBe("updated by dedup");
  });

  test("returns updatedEntries with previous and new content", () => {
    const id = ltm.create({
      projectPath: PROJECT,
      category: "gotcha",
      title: "Update Delta Test",
      content: "old content",
      scope: "project",
    });

    const result = applyOps([{ op: "update", id, content: "new content" }], {
      projectPath: PROJECT,
      sessionID: "sess-update",
    });

    expect(result.updated).toBe(1);
    expect(result.changedEntries).toEqual([
      expect.objectContaining({
        op: "updated",
        id,
        category: "gotcha",
        title: "Update Delta Test",
        content: "new content",
        prevContent: "old content",
      }),
    ]);
  });

  test("returns deletedEntries with pre-delete content", () => {
    const id = ltm.create({
      projectPath: PROJECT,
      category: "pattern",
      title: "Delete Delta Test",
      content: "content that will be removed",
      scope: "project",
    });

    const result = applyOps([{ op: "delete", id, reason: "stale" }], {
      projectPath: PROJECT,
      sessionID: "sess-delete",
    });

    expect(result.deleted).toBe(1);
    expect(result.changedEntries).toEqual([
      expect.objectContaining({
        op: "deleted",
        id,
        category: "pattern",
        title: "Delete Delta Test",
        prevContent: "content that will be removed",
      }),
    ]);
    expect(ltm.get(id)).toBeNull();
  });
});

describe("curator enforceEntryCap (soft-cap eviction)", () => {
  const CAP_PROJECT = "/tmp/lore-curator-cap/project";

  function reset() {
    const pid = ensureProject(CAP_PROJECT);
    db().query("DELETE FROM knowledge WHERE project_id = ?").run(pid);
  }

  test("no-op when at or under the cap", () => {
    reset();
    for (let i = 0; i < 3; i++) {
      ltm.create({
        projectPath: CAP_PROJECT,
        category: "gotcha",
        title: `Under ${i}`,
        content: "x",
        scope: "project",
      });
    }
    const result = { deleted: 0, changedEntries: [] as ChangedEntry[] };
    expect(enforceEntryCap(CAP_PROJECT, 3, result)).toBe(0);
    expect(result.deleted).toBe(0);
    expect(ltm.forProject(CAP_PROJECT, false)).toHaveLength(3);
  });

  test("evicts the lowest-value tail down to the cap and records deletes", () => {
    reset();
    const high = ltm.create({
      projectPath: CAP_PROJECT,
      category: "gotcha",
      title: "Keep high",
      content: "x",
      scope: "project",
      confidence: 0.9,
    });
    const lowA = ltm.create({
      projectPath: CAP_PROJECT,
      category: "gotcha",
      title: "Evict A",
      content: "x",
      scope: "project",
      confidence: 0.3,
    });
    const lowB = ltm.create({
      projectPath: CAP_PROJECT,
      category: "gotcha",
      title: "Evict B",
      content: "x",
      scope: "project",
      confidence: 0.4,
    });

    const result = { deleted: 0, changedEntries: [] as ChangedEntry[] };
    const evicted = enforceEntryCap(CAP_PROJECT, 1, result);

    expect(evicted).toBe(2);
    expect(result.deleted).toBe(2);
    // Highest-value entry survives; the two lowest are gone.
    expect(ltm.get(high)).not.toBeNull();
    expect(ltm.get(lowA)).toBeNull();
    expect(ltm.get(lowB)).toBeNull();
    expect(result.changedEntries.map((e) => e.id).sort()).toEqual(
      [lowA, lowB].sort(),
    );
  });

  test("promoted cross-project entries are counted toward the cap but evicted from owned rows only (converges)", () => {
    reset();
    // 3 exclusively-owned + 2 promoted-in-place (cross_project=1, same project_id).
    const owned = [0.9, 0.5, 0.7].map((c, i) =>
      ltm.create({
        projectPath: CAP_PROJECT,
        category: "gotcha",
        title: `Owned ${i}`,
        content: "x",
        scope: "project",
        confidence: c,
      }),
    );
    const promoted = [0.4, 0.45].map((c, i) => {
      const id = ltm.create({
        projectPath: CAP_PROJECT,
        category: "preference",
        title: `Promoted ${i}`,
        content: "p",
        scope: "project",
        confidence: c,
      });
      db().query("UPDATE knowledge SET cross_project = 1 WHERE id = ?").run(id);
      return id;
    });

    // forProject counts all 5 (project_id matches, confidence > 0.2) → overBy=2.
    const result = { deleted: 0, changedEntries: [] as ChangedEntry[] };
    const evicted = enforceEntryCap(CAP_PROJECT, 3, result);

    // Eviction draws ONLY from owned rows (the two lowest-confidence owned),
    // never the promoted/shared ones; the live count converges to the cap.
    expect(evicted).toBe(2);
    expect(promoted.every((id) => ltm.get(id) !== null)).toBe(true);
    expect(ltm.get(owned[0])).not.toBeNull(); // 0.9 survives
    expect(ltm.get(owned[1])).toBeNull(); // 0.5 evicted
    expect(ltm.get(owned[2])).toBeNull(); // 0.7 evicted
    expect(ltm.forProject(CAP_PROJECT, false)).toHaveLength(3);
  });
});
