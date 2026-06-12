import { describe, expect, test } from "vitest";
import { applyOps } from "../src/curator";
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
