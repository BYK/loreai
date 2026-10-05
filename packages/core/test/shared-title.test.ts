import { afterAll, describe, expect, test } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uuidv7 } from "uuidv7";
import { db, ensureProject } from "../src/db";
import * as data from "../src/data";
import { applyOps } from "../src/curator";
import * as knowledgeEdit from "../src/knowledge-edit";
import * as ltm from "../src/ltm";
import { importLoreFile } from "../src/agents-file";
import { importStructuredEntries } from "../src/import/structured";
import { LORE_IMPORT_VERSION } from "../src/import/schema";

const ROOT = mkdtempSync(join(tmpdir(), "lore-shared-title-"));

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

function project(name: string): string {
  const path = join(ROOT, name);
  mkdirSync(path, { recursive: true });
  ensureProject(path, name);
  return path;
}

function createEntry(
  title: string,
  projectPath?: string,
  opts: { crossProject?: boolean; content?: string; id?: string } = {},
): string {
  return ltm.create({
    ...(opts.id ? { id: opts.id } : {}),
    ...(projectPath ? { projectPath } : {}),
    category: "decision",
    title,
    content: opts.content ?? `Content for ${title}`,
    scope: projectPath ? "project" : "global",
    crossProject: opts.crossProject,
  });
}

function currentRow(logicalId: string): {
  id: string;
  version: number;
  project_id: string | null;
  cross_project: number;
  title: string;
  content: string;
} {
  const row = db()
    .query(
      `SELECT id, version, project_id, cross_project, title, content
         FROM knowledge_current WHERE logical_id = ?`,
    )
    .get(logicalId) as {
    id: string;
    version: number;
    project_id: string | null;
    cross_project: number;
    title: string;
    content: string;
  } | null;
  if (!row) throw new Error(`Missing current entry ${logicalId}`);
  return row;
}

function makeLegacyShared(logicalId: string, title: string): void {
  db()
    .query(
      `UPDATE knowledge SET title = ?, cross_project = 1
        WHERE logical_id = ? AND is_current = 1`,
    )
    .run(title, logicalId);
}

function errorOf(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error("expected action to throw");
}

describe("shared title normalization and conflict handling", () => {
  test("normalizes trim and case without collapsing internal whitespace", () => {
    const suffix = uuidv7();
    const title = `X ${suffix}`;
    const existing = createEntry(title, undefined, { id: uuidv7() });

    for (const variant of [
      title,
      `x ${suffix}`,
      `  X ${suffix}  `,
      `\tX ${suffix}\n`,
    ]) {
      expect(ltm.normalizeTitleKey(variant)).toBe(ltm.normalizeTitleKey(title));
      expect(ltm.findSharedTitleConflict(null, variant)?.logical_id).toBe(
        existing,
      );
    }

    const spaced = createEntry(`X Y ${suffix}`, undefined, {
      id: uuidv7(),
    });
    expect(ltm.findSharedTitleConflict(null, `X  Y ${suffix}`)).toBeNull();
    expect(ltm.normalizeTitleKey(`X Y ${suffix}`)).not.toBe(
      ltm.normalizeTitleKey(`X  Y ${suffix}`),
    );
    expect(spaced).not.toBe(existing);
  });

  test.each([
    ["X", "X"],
    ["x", " X "],
  ])(
    "allows project-only duplicates but rejects a second promotion (%s / %s)",
    (titleA, titleB) => {
      const suffix = uuidv7();
      const projectA = project(`project-a-${uuidv7()}`);
      const projectB = project(`project-b-${uuidv7()}`);
      const entryTitleA = `${titleA.trim()} ${suffix}`;
      const entryTitleB =
        titleB === titleB.trim()
          ? `${titleB} ${suffix}`
          : ` ${titleB.trim()} ${suffix} `;
      const entryA = createEntry(entryTitleA, projectA, {
        id: uuidv7(),
      });
      const entryB = createEntry(entryTitleB, projectB, {
        id: uuidv7(),
      });

      const promoted = knowledgeEdit.editKnowledge(entryB, {
        expectedRevision: 1,
        actor: "test",
        scope: "shared",
      });
      expect(promoted.revision).toBe(2);
      expect(currentRow(entryB).cross_project).toBe(1);

      const before = currentRow(entryA);
      const error = errorOf(() =>
        knowledgeEdit.editKnowledge(entryA, {
          expectedRevision: 1,
          actor: "test",
          scope: "shared",
        }),
      );
      expect(error).toMatchObject({
        code: "title_conflict",
        conflicting_entry: {
          id: entryB,
          title: entryTitleB,
          project_id: currentRow(entryB).project_id,
          scope: "shared",
        },
      });
      expect(currentRow(entryA)).toEqual(before);
    },
  );

  test("checks a changed shared title and reports the existing entry", () => {
    const suffix = uuidv7();
    const existingTitle = `X ${suffix}`;
    const existing = createEntry(existingTitle, undefined, {
      id: uuidv7(),
    });
    const target = createEntry(`Original ${suffix}`, undefined, {
      id: uuidv7(),
    });

    const error = errorOf(() =>
      knowledgeEdit.editKnowledge(target, {
        expectedRevision: 1,
        actor: "test",
        title: ` x ${suffix} `,
      }),
    );
    expect(error).toMatchObject({
      code: "title_conflict",
      conflicting_entry: {
        id: existing,
        title: existingTitle,
        project_id: null,
        scope: "shared",
      },
    });
    expect(currentRow(target)).toMatchObject({
      version: 1,
      title: `Original ${suffix}`,
    });
  });

  test("checks the next scope when title and scope change together", () => {
    const suffix = uuidv7();
    const projectPath = project(`next-scope-${uuidv7()}`);
    const existingTitle = `x ${suffix}`;
    const existing = createEntry(existingTitle, undefined, {
      id: uuidv7(),
    });
    const target = createEntry(`Original ${suffix}`, projectPath, {
      id: uuidv7(),
    });
    const before = currentRow(target);

    const error = errorOf(() =>
      knowledgeEdit.editKnowledge(target, {
        expectedRevision: 1,
        actor: "test",
        title: ` X ${suffix} `,
        scope: "shared",
      }),
    );

    expect(error).toMatchObject({
      code: "title_conflict",
      conflicting_entry: {
        id: existing,
        title: existingTitle,
        scope: "shared",
      },
    });
    expect(currentRow(target)).toEqual(before);
  });

  test("permits cosmetic retitles and content edits of legacy duplicates", () => {
    const suffix = uuidv7();
    const projectA = project(`legacy-a-${uuidv7()}`);
    const projectB = project(`legacy-b-${uuidv7()}`);
    const first = createEntry(`Legacy first ${suffix}`, projectA, {
      id: uuidv7(),
    });
    const second = createEntry(`Legacy second ${suffix}`, projectB, {
      id: uuidv7(),
    });
    makeLegacyShared(first, `X ${suffix}`);
    makeLegacyShared(second, `x ${suffix}`);

    const cosmetic = knowledgeEdit.editKnowledge(first, {
      expectedRevision: 1,
      actor: "test",
      title: ` X ${suffix} `,
    });
    expect(cosmetic.revision).toBe(2);
    expect(currentRow(first).title).toBe(` X ${suffix} `);

    const contentEdit = knowledgeEdit.editKnowledge(second, {
      expectedRevision: 1,
      actor: "test",
      content: "Updated legacy duplicate content",
    });
    expect(contentEdit.revision).toBe(2);
    expect(currentRow(second)).toMatchObject({
      title: `x ${suffix}`,
      content: "Updated legacy duplicate content",
    });
  });

  test("restore reports a conflict with the target historical version", () => {
    const suffix = uuidv7();
    const originalTitle = `X ${suffix}`;
    const target = createEntry(originalTitle, undefined, { id: uuidv7() });
    knowledgeEdit.editKnowledge(target, {
      expectedRevision: 1,
      actor: "test",
      title: `Renamed target ${suffix}`,
    });
    const existing = createEntry(originalTitle, undefined, { id: uuidv7() });

    const error = errorOf(() =>
      knowledgeEdit.restoreKnowledge(target, {
        expectedRevision: 2,
        actor: "test",
        versionId: target,
      }),
    );
    expect(error).toMatchObject({
      code: "title_conflict",
      conflicting_entry: {
        id: existing,
        title: originalTitle,
        project_id: null,
        scope: "shared",
      },
    });
    expect(currentRow(target)).toMatchObject({
      version: 2,
      title: `Renamed target ${suffix}`,
    });
  });

  test("deduplicates projectless and explicit-id shared creates by normalized title", () => {
    const suffix = uuidv7();
    const ownerProject = project(`create-owner-${uuidv7()}`);
    const title = `X ${suffix}`;
    const existing = createEntry(title, ownerProject, {
      id: uuidv7(),
      crossProject: true,
      content: "Original shared content",
    });

    const merged = createEntry(`x ${suffix} `, undefined, {
      content: "Projectless imported content",
    });
    expect(merged).toBe(existing);
    expect(currentRow(existing).content).toBe("Projectless imported content");

    const tryResult = ltm.tryCreate({
      category: "decision",
      title: `  X ${suffix}`,
      content: "Try-create content",
      scope: "global",
    });
    expect(tryResult).toMatchObject({ id: existing, created: false });
    expect(currentRow(existing).content).toBe("Try-create content");

    const explicitId = uuidv7();
    const explicitResult = createEntry(` x ${suffix} `, undefined, {
      id: explicitId,
      content: "Explicit-id content",
    });
    expect(explicitResult).toBe(existing);
    expect(currentRow(existing).content).toBe("Explicit-id content");
    expect(
      db()
        .query("SELECT COUNT(*) AS count FROM knowledge WHERE logical_id = ?")
        .get(explicitId),
    ).toMatchObject({ count: 0 });
  });

  test("ltm.update drops a colliding retitle but applies other fields", () => {
    const suffix = uuidv7();
    const existingTitle = `X ${suffix}`;
    const existing = createEntry(existingTitle, undefined, { id: uuidv7() });
    const projectB = project(`update-target-${uuidv7()}`);
    const target = createEntry(`Target ${suffix}`, projectB, {
      id: uuidv7(),
      crossProject: true,
    });

    ltm.update(target, {
      title: ` x ${suffix} `,
      content: "Content still applies",
    });

    expect(currentRow(target)).toMatchObject({
      title: `Target ${suffix}`,
      content: "Content still applies",
    });
    expect(currentRow(existing).title).toBe(existingTitle);
  });

  test("curator cross-project create merges a normalized shared title", () => {
    const suffix = uuidv7();
    const title = `X ${suffix}`;
    const existingProject = project(`curator-existing-${uuidv7()}`);
    const curatorProject = project(`curator-source-${uuidv7()}`);
    const existing = createEntry(title, existingProject, {
      id: uuidv7(),
      crossProject: true,
    });

    const result = applyOps(
      [
        {
          op: "create",
          category: "decision",
          title: ` x ${suffix} `,
          content: "Curator update content",
          scope: "project",
          crossProject: true,
        },
      ],
      { projectPath: curatorProject },
    );

    expect(result).toMatchObject({ created: 0, updated: 1 });
    expect(currentRow(existing).content).toBe("Curator update content");
  });

  test("rejects a move into shared scope without changing rows or transfers", () => {
    const suffix = uuidv7();
    const title = `X ${suffix}`;
    const sourceProject = project(`move-source-${uuidv7()}`);
    const targetProject = project(`move-target-${uuidv7()}`);
    const existingProject = project(`move-existing-${uuidv7()}`);
    const target = createEntry(title, sourceProject, { id: uuidv7() });
    createEntry(title, existingProject, {
      crossProject: true,
      id: uuidv7(),
    });
    const sourceProjectId = ensureProject(sourceProject);
    const before = currentRow(target);
    db()
      .query(
        `INSERT INTO knowledge_transfers
          (knowledge_id, recalled_in_project_id, hit_count, first_recalled_at, last_recalled_at)
         VALUES (?, ?, 2, 1, 2)`,
      )
      .run(target, sourceProjectId);

    const transfersBefore = db()
      .query(
        "SELECT * FROM knowledge_transfers WHERE knowledge_id = ? ORDER BY recalled_in_project_id",
      )
      .all(target);
    const error = errorOf(() => data.reassignKnowledge(target, targetProject));

    expect(error).toBeInstanceOf(ltm.TitleConflictError);
    expect(error).toMatchObject({
      code: "title_conflict",
      conflicting: { title },
    });
    expect(currentRow(target)).toEqual(before);
    expect(
      db()
        .query(
          "SELECT * FROM knowledge_transfers WHERE knowledge_id = ? ORDER BY recalled_in_project_id",
        )
        .all(target),
    ).toEqual(transfersBefore);
  });

  test("reports legacy shared duplicates without mutating entries", () => {
    const suffix = uuidv7();
    const firstTitle = `X ${suffix}`;
    const projectA = project(`duplicates-a-${uuidv7()}`);
    const projectB = project(`duplicates-b-${uuidv7()}`);
    const projectOnly = project(`duplicates-project-${uuidv7()}`);
    const tombProject = project(`duplicates-tomb-${uuidv7()}`);
    const zeroProject = project(`duplicates-zero-${uuidv7()}`);
    const first = createEntry(`Legacy A ${suffix}`, projectA, {
      id: uuidv7(),
    });
    const second = createEntry(`Legacy B ${suffix}`, projectB, {
      id: uuidv7(),
    });
    const privateEntry = createEntry(firstTitle, projectOnly, {
      id: uuidv7(),
    });
    const tombstone = createEntry(`Tombstoned ${suffix}`, tombProject, {
      id: uuidv7(),
      crossProject: true,
    });
    const zeroConfidence = createEntry(
      `Zero confidence ${suffix}`,
      zeroProject,
      {
        id: uuidv7(),
        crossProject: true,
      },
    );
    makeLegacyShared(first, firstTitle);
    makeLegacyShared(second, ` x ${suffix} `);
    ltm.remove(tombstone);
    ltm.update(zeroConfidence, { confidence: 0 });

    const before = db()
      .query(
        `SELECT logical_id, id, title, project_id, cross_project, confidence
           FROM knowledge_current
          WHERE logical_id IN (?, ?, ?, ?, ?)
          ORDER BY logical_id`,
      )
      .all(first, second, privateEntry, tombstone, zeroConfidence);
    const groups = ltm.listSharedTitleDuplicates();
    const titleKey = ltm.normalizeTitleKey(firstTitle);
    const group = groups.find((item) => item.title_key === titleKey);

    expect(group?.title_key).toBe(titleKey);
    expect(
      Object.fromEntries(
        group?.entries.map((entry) => [entry.id, entry.title]) ?? [],
      ),
    ).toEqual({
      [first]: firstTitle,
      [second]: ` x ${suffix} `,
    });
    expect(group?.entries.every((entry) => entry.cross_project === 1)).toBe(
      true,
    );
    expect(group?.entries).not.toContainEqual(
      expect.objectContaining({ id: privateEntry }),
    );
    expect(
      db()
        .query(
          `SELECT logical_id, id, title, project_id, cross_project, confidence
             FROM knowledge_current
            WHERE logical_id IN (?, ?, ?, ?, ?)
            ORDER BY logical_id`,
        )
        .all(first, second, privateEntry, tombstone, zeroConfidence),
    ).toEqual(before);
  });

  test("structured global import updates a shared normalized-title match", () => {
    const suffix = uuidv7();
    const projectPath = project(`structured-global-${uuidv7()}`);
    const existing = createEntry(`X ${suffix}`, projectPath, {
      id: uuidv7(),
      crossProject: true,
    });
    const result = importStructuredEntries(
      {
        lore_import_version: LORE_IMPORT_VERSION,
        source: "generic",
        entries: [
          { title: ` x ${suffix} `, content: "Structured import content" },
        ],
      },
      { defaultProjectPath: projectPath, global: true },
    );

    expect(result).toMatchObject({ created: 0, updated: 1 });
    expect(currentRow(existing).content).toBe("Structured import content");
  });

  test("lore-file hand-written entries merge into a shared match without loss", () => {
    const suffix = uuidv7();
    const title = `X ${suffix}`;
    const projectA = project(`lore-shared-a-${uuidv7()}`);
    const projectB = project(`lore-shared-b-${uuidv7()}`);
    const shared = createEntry(title, projectA, {
      id: uuidv7(),
      crossProject: true,
    });
    writeFileSync(
      join(projectB, ".lore.md"),
      `<!-- Managed by lore -->\n\n## Long-term Knowledge\n\n### Decision\n\n* ** x ${suffix} **: Imported from project B\n`,
    );

    expect(() => importLoreFile(projectB)).not.toThrow();
    expect(currentRow(shared).content).toBe("Imported from project B");
    const normalizedSharedCount = db()
      .query(
        `SELECT COUNT(DISTINCT logical_id) AS count
           FROM knowledge_current
          WHERE (project_id IS NULL OR cross_project = 1)
            AND confidence > 0
            AND LOWER(TRIM(title, ' ' || char(9) || char(10) || char(13))) = ?`,
      )
      .get(ltm.normalizeTitleKey(title)) as { count: number };
    expect(normalizedSharedCount.count).toBe(1);
  });

  test("lore-file unknown UUID entries are created project-only", () => {
    const projectPath = project(`lore-unknown-${uuidv7()}`);
    const unknownId = uuidv7();
    writeFileSync(
      join(projectPath, ".lore.md"),
      `<!-- Managed by lore -->\n\n## Long-term Knowledge\n\n### Decision\n\n<!-- lore:${unknownId} -->\n* **X**: Unknown UUID content\n`,
    );

    importLoreFile(projectPath);

    expect(currentRow(unknownId)).toMatchObject({
      project_id: ensureProject(projectPath),
      cross_project: 0,
      content: "Unknown UUID content",
    });
  });
});
