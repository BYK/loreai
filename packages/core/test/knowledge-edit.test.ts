import { afterAll, describe, expect, test, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uuidv7 } from "uuidv7";

vi.mock("../src/agents-file", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/agents-file")>();
  return { ...mod, exportLoreFile: vi.fn(mod.exportLoreFile) };
});

import * as agentsFile from "../src/agents-file";
import { db, ensureProject, withTransaction } from "../src/db";
import * as dedupApply from "../src/dedup-apply";
import * as knowledgeEdit from "../src/knowledge-edit";
import * as ltm from "../src/ltm";

const ROOT = mkdtempSync(join(tmpdir(), "lore-knowledge-edit-"));
const PROJECT = join(ROOT, "project");
mkdirSync(PROJECT);
const projectId = ensureProject(PROJECT, "knowledge-edit-tests");
const exportLoreFile = vi.mocked(agentsFile.exportLoreFile);

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

function createEntry(title = `Entry ${uuidv7()}`): string {
  return ltm.create({
    id: uuidv7(),
    projectPath: PROJECT,
    category: "decision",
    title,
    content: `Content for ${title}`,
    scope: "project",
  });
}

function revisionOf(id: string): number {
  const row = db()
    .query(
      "SELECT version FROM knowledge WHERE logical_id = ? AND is_current = 1",
    )
    .get(ltm.logicalIdOf(id)) as { version: number } | undefined;
  if (!row) throw new Error(`no current version for ${id}`);
  return row.version;
}

function expectEditError(
  action: () => unknown,
  expected: Record<string, unknown>,
): void {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toMatchObject(expected);
}

function deleteEntry(id: string, expectedRevision: number) {
  return knowledgeEdit.deleteKnowledgeChecked(id, {
    expectedRevision,
    actor: "reviewer",
  });
}

describe("revision-checked knowledge editing", () => {
  test("rejects a second tab's edit after another tab advances the head", () => {
    const id = createEntry();
    knowledgeEdit.editKnowledge(id, {
      expectedRevision: 1,
      actor: "tab-a",
      content: "Changed in the first tab",
    });

    expectEditError(
      () =>
        knowledgeEdit.editKnowledge(id, {
          expectedRevision: 1,
          actor: "tab-b",
          title: "A stale title",
        }),
      {
        code: "stale_revision",
        expected_revision: 1,
        current_revision: 2,
      },
    );
    expect(ltm.getByLogical(id)?.title).not.toBe("A stale title");
  });

  test("a dedup apply racing an edit makes the old PATCH revision stale", () => {
    const keep = createEntry();
    const merged = createEntry();
    const revisions = {
      [keep]: revisionOf(keep),
      [merged]: revisionOf(merged),
    };
    dedupApply.applyDedupDecisions(db(), {
      projectId,
      operationId: uuidv7(),
      reviewedAt: Date.now(),
      actor: "dedup-reviewer",
      decisions: [
        { keepId: keep, mergeIds: [merged], expectedRevisions: revisions },
      ],
    });

    expectEditError(
      () =>
        knowledgeEdit.editKnowledge(merged, {
          expectedRevision: 1,
          actor: "editor",
          content: "The dedup apply already deleted this entry",
        }),
      {
        code: "stale_revision",
        expected_revision: 1,
        current_revision: 2,
      },
    );
    expect(revisionOf(merged)).toBe(2);
  });

  test("confidence-only changes the register without appending a version", () => {
    const id = createEntry();
    const result = knowledgeEdit.editKnowledge(id, {
      expectedRevision: 1,
      actor: "reviewer",
      confidence: 0.35,
    });

    expect(result.revision).toBe(1);
    expect(result.changed).toEqual(["confidence"]);
    expect(ltm.versionHistory(id)).toHaveLength(1);
    expect(ltm.getByLogical(id)?.confidence).toBeCloseTo(0.35);
    expect(ltm.getByLogical(id)?.updated_by).toBe("reviewer");
  });

  test("scope changes append cross-project state and can be restored", () => {
    const id = createEntry();
    const shared = knowledgeEdit.editKnowledge(id, {
      expectedRevision: 1,
      actor: "reviewer",
      scope: "shared",
    });
    expect(shared.revision).toBe(2);
    expect(shared.effects.scope).toBe("shared");
    expect(
      db()
        .query(
          "SELECT cross_project FROM knowledge WHERE logical_id = ? AND is_current = 1",
        )
        .get(id),
    ).toEqual({ cross_project: 1 });

    const restored = knowledgeEdit.restoreKnowledge(id, {
      expectedRevision: 2,
      actor: "reviewer",
      versionId: id,
    });
    expect(restored.revision).toBe(3);
    expect(restored.effects.scope).toBe("project");
    expect(restored.restored_from).toEqual({ version_id: id, version: 1 });
  });

  test("rejects changing a projectless shared entry to project scope", () => {
    const id = ltm.create({
      id: uuidv7(),
      category: "decision",
      title: `Shared ${uuidv7()}`,
      content: "Shared content",
      scope: "global",
    });
    expectEditError(
      () =>
        knowledgeEdit.editKnowledge(id, {
          expectedRevision: 1,
          actor: "reviewer",
          scope: "project",
        }),
      { code: "invalid_request" },
    );
    expect(revisionOf(id)).toBe(1);
  });

  test("refuses stale restore after a restored entry is deleted again", () => {
    const id = createEntry();
    deleteEntry(id, 1);
    const restored = knowledgeEdit.restoreKnowledge(id, {
      expectedRevision: 2,
      actor: "reviewer",
    });
    deleteEntry(id, restored.revision);

    expectEditError(
      () =>
        knowledgeEdit.restoreKnowledge(id, {
          expectedRevision: 2,
          actor: "stale-tab",
        }),
      {
        code: "stale_revision",
        expected_revision: 2,
        current_revision: 4,
      },
    );
  });

  test("refuses restore when its historical title is now taken", () => {
    const id = createEntry();
    deleteEntry(id, 1);
    createEntry(ltm.versionHistory(id)[0].title);

    expectEditError(
      () =>
        knowledgeEdit.restoreKnowledge(id, {
          expectedRevision: 2,
          actor: "reviewer",
        }),
      { code: "title_conflict" },
    );
    expect(revisionOf(id)).toBe(2);
  });

  test("no-op and refused edits do not export", () => {
    const id = createEntry();
    exportLoreFile.mockClear();
    const title = ltm.getByLogical(id)?.title ?? "";
    const result = knowledgeEdit.editKnowledge(id, {
      expectedRevision: 1,
      actor: "reviewer",
      title,
    });
    expect(result.changed).toEqual([]);
    expect(exportLoreFile).not.toHaveBeenCalled();

    expectEditError(
      () =>
        knowledgeEdit.editKnowledge(id, {
          expectedRevision: 9,
          actor: "reviewer",
          content: "Stale",
        }),
      { code: "stale_revision" },
    );
    expect(exportLoreFile).not.toHaveBeenCalled();
  });

  test("refuses mutation inside a caller-owned transaction", () => {
    const id = createEntry();
    expectEditError(
      () =>
        withTransaction(() =>
          knowledgeEdit.editKnowledge(id, {
            expectedRevision: 1,
            actor: "reviewer",
            content: "Nested mutation",
          }),
        ),
      { code: "invalid_request" },
    );
    expect(revisionOf(id)).toBe(1);
  });
});
