import { describe, test, expect, beforeEach } from "vitest";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { db, ensureProject } from "../../src/db";
import * as ltm from "../../src/ltm";
import { importStructuredEntries } from "../../src/import/structured";
import {
  LORE_IMPORT_VERSION,
  type LoreImportDoc,
} from "../../src/import/schema";
import { MAX_ENTRY_CONTENT_LENGTH } from "../../src/curator";

const PROJECT = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "__tmp_structured__",
);

function doc(
  entries: LoreImportDoc["entries"],
  source = "generic",
): LoreImportDoc {
  return {
    lore_import_version: LORE_IMPORT_VERSION,
    source: source as LoreImportDoc["source"],
    entries,
  };
}

function entriesForProject(projectPath: string) {
  return ltm.forProject(projectPath, false);
}

describe("importStructuredEntries", () => {
  beforeEach(() => {
    ensureProject(PROJECT);
  });

  test("creates knowledge entries", () => {
    const res = importStructuredEntries(
      doc([
        { content: "Use SQLite WAL mode", category: "architecture" },
        { content: "Prefer zod for validation", category: "preference" },
      ]),
      { defaultProjectPath: PROJECT },
    );
    expect(res.created).toBe(2);
    expect(res.updated).toBe(0);
    expect(res.skipped).toBe(0);

    const rows = entriesForProject(PROJECT);
    const titles = rows.map((r) => r.title).sort();
    expect(titles).toContain("Use SQLite WAL mode");
    expect(titles).toContain("Prefer zod for validation");
  });

  test("is idempotent — re-running skips duplicates", () => {
    const d = doc([
      { content: "Idempotent content here", category: "pattern" },
    ]);
    const first = importStructuredEntries(d, { defaultProjectPath: PROJECT });
    expect(first.created).toBe(1);

    const second = importStructuredEntries(d, { defaultProjectPath: PROJECT });
    expect(second.created).toBe(0);
    expect(second.skipped).toBe(1);
  });

  test("updates when content changes for a title-similar entry", () => {
    importStructuredEntries(
      doc([{ title: "Auth flow decision", content: "old content v1" }]),
      { defaultProjectPath: PROJECT },
    );
    const res = importStructuredEntries(
      doc([{ title: "Auth flow decision", content: "new content v2" }]),
      { defaultProjectPath: PROJECT },
    );
    expect(res.updated).toBe(1);
    expect(res.created).toBe(0);

    const rows = entriesForProject(PROJECT);
    const entry = rows.find((r) => r.title === "Auth flow decision");
    expect(entry?.content).toBe("new content v2");
  });

  test("truncates content over the 1200-char cap", () => {
    const long = "x".repeat(MAX_ENTRY_CONTENT_LENGTH + 500);
    importStructuredEntries(
      doc([{ title: "Long entry title", content: long }]),
      { defaultProjectPath: PROJECT },
    );
    const rows = entriesForProject(PROJECT);
    const entry = rows.find((r) => r.title === "Long entry title");
    expect(entry).toBeDefined();
    expect(entry!.content.length).toBeLessThanOrEqual(MAX_ENTRY_CONTENT_LENGTH);
    expect(entry!.content).toContain("[truncated");
  });

  test("synthesizes a title from content when absent", () => {
    importStructuredEntries(
      doc([{ content: "First line becomes the title\nrest of body" }]),
      { defaultProjectPath: PROJECT },
    );
    const rows = entriesForProject(PROJECT);
    const entry = rows.find((r) => r.title === "First line becomes the title");
    expect(entry).toBeDefined();
  });

  test("clamps confidence into [0,1]", () => {
    importStructuredEntries(
      doc([{ title: "Conf entry", content: "body", confidence: 0.3 }]),
      { defaultProjectPath: PROJECT },
    );
    const entry = entriesForProject(PROJECT).find(
      (r) => r.title === "Conf entry",
    );
    expect(entry?.confidence).toBeCloseTo(0.3, 5);
  });

  test("global option imports cross-project entries", () => {
    const res = importStructuredEntries(
      doc([{ title: "Global pref", content: "applies everywhere" }]),
      { defaultProjectPath: PROJECT, global: true },
    );
    expect(res.created).toBe(1);
    const row = db()
      .query("SELECT cross_project FROM knowledge_current WHERE title = ?")
      .get("Global pref") as { cross_project: number } | null;
    expect(row?.cross_project).toBe(1);
  });

  test("dry run does not write to the DB", () => {
    const before = entriesForProject(PROJECT).length;
    const res = importStructuredEntries(
      doc([{ title: "Dry entry", content: "not persisted" }]),
      { defaultProjectPath: PROJECT, dryRun: true },
    );
    expect(res.created).toBe(1);
    const after = entriesForProject(PROJECT).length;
    expect(after).toBe(before);
  });

  test("rejects an invalid document (defensive re-validation)", () => {
    expect(() =>
      importStructuredEntries(
        { lore_import_version: 1, source: "generic", entries: [{}] } as never,
        { defaultProjectPath: PROJECT },
      ),
    ).toThrow();
  });

  test("does not resurrect a tombstoned entry with the same title", () => {
    const P = PROJECT + "_tomb";
    ensureProject(P);
    const id = ltm.create({
      projectPath: P,
      category: "pattern",
      title: "Ghost entry",
      content: "original body",
      scope: "project",
    });
    ltm.remove(id);
    expect(ltm.isTombstoned(id)).toBe(true);

    const res = importStructuredEntries(
      doc([{ title: "Ghost entry", content: "resurrected body" }]),
      { defaultProjectPath: P },
    );
    expect(res.created).toBe(0);
    expect(res.skipped).toBe(1);
    expect(res.entries[0]?.reason).toBe("tombstoned");

    const live = entriesForProject(P).filter((r) => r.title === "Ghost entry");
    expect(live).toHaveLength(0);
  });

  test("does not resurrect a tombstoned global entry with the same title", () => {
    const id = ltm.create({
      category: "preference",
      title: "Ghost global pref",
      content: "original",
      scope: "global",
      crossProject: true,
    });
    ltm.remove(id);
    expect(ltm.isTombstoned(id)).toBe(true);

    const res = importStructuredEntries(
      doc([{ title: "Ghost global pref", content: "resurrected" }]),
      { defaultProjectPath: PROJECT, global: true },
    );
    expect(res.created).toBe(0);
    expect(res.skipped).toBe(1);
    expect(res.entries[0]?.reason).toBe("tombstoned");

    const live = db()
      .query(
        "SELECT COUNT(*) AS n FROM knowledge_current WHERE title = ? AND cross_project = 1",
      )
      .get("Ghost global pref") as { n: number };
    expect(live.n).toBe(0);
  });

  test("intra-batch: two entries with the same title dedup (last wins)", () => {
    const P = PROJECT + "_intrabatch";
    ensureProject(P);
    const res = importStructuredEntries(
      doc([
        { title: "Shared title", content: "first body" },
        { title: "Shared title", content: "second body wins" },
      ]),
      { defaultProjectPath: P },
    );
    expect(res.created).toBe(1);
    expect(res.updated).toBe(1);

    const rows = entriesForProject(P).filter((r) => r.title === "Shared title");
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe("second body wins");
  });

  test("confidence-only difference is a skip (content unchanged)", () => {
    const P = PROJECT + "_confonly";
    ensureProject(P);
    importStructuredEntries(
      doc([{ title: "Conf only", content: "identical body", confidence: 0.9 }]),
      { defaultProjectPath: P },
    );
    const res = importStructuredEntries(
      doc([{ title: "Conf only", content: "identical body", confidence: 0.2 }]),
      { defaultProjectPath: P },
    );
    expect(res.updated).toBe(0);
    expect(res.skipped).toBe(1);

    const row = db()
      .query("SELECT confidence FROM knowledge_current WHERE title = ?")
      .get("Conf only") as { confidence: number } | null;
    expect(row?.confidence).toBeCloseTo(0.9, 5);
  });

  test("re-import of a >cap entry is idempotent (compares truncated content)", () => {
    const P = PROJECT + "_trunc_reimport";
    ensureProject(P);
    const long = "z".repeat(MAX_ENTRY_CONTENT_LENGTH + 800);
    const d = doc([{ title: "Big one", content: long }]);
    const first = importStructuredEntries(d, { defaultProjectPath: P });
    expect(first.created).toBe(1);
    const second = importStructuredEntries(d, { defaultProjectPath: P });
    expect(second.updated).toBe(0);
    expect(second.skipped).toBe(1);
  });

  test("fuzzy near-title match updates the existing entry (not exact title)", () => {
    // Guard: findExactTitle misses (titles differ), but findFuzzyDuplicate
    // matches on word overlap (>=4 shared words, coefficient >=0.7). The entry
    // must UPDATE the fuzzy match, not create a second near-duplicate. Removing
    // the fuzzy branch in structured.ts makes this create a duplicate → fails.
    const P = PROJECT + "_fuzzy";
    ensureProject(P);
    importStructuredEntries(
      doc([
        {
          title: "Upgrade binary lock re-entry bug",
          content: "original description of the lock bug",
        },
      ]),
      { defaultProjectPath: P },
    );

    const res = importStructuredEntries(
      doc([
        {
          title: "Upgrade binary lock re-entry issue",
          content: "revised description of the lock bug",
        },
      ]),
      { defaultProjectPath: P },
    );
    expect(res.created).toBe(0);
    expect(res.updated).toBe(1);

    const rows = entriesForProject(P).filter((r) =>
      r.title.startsWith("Upgrade binary lock re-entry"),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe("revised description of the lock bug");
  });
});
