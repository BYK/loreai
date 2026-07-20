import { describe, test, expect, afterAll } from "vitest";
import { fileURLToPath } from "node:url";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  engramSource,
  getStructuredSource,
  getStructuredSources,
} from "../../src/import/structured-sources";
import { LORE_IMPORT_VERSION } from "../../src/import/schema";

const TMP = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "__tmp_structured_sources__",
);
mkdirSync(TMP, { recursive: true });

afterAll(() => rmSync(TMP, { recursive: true, force: true }));

function writeFixture(name: string, obj: unknown): string {
  const p = join(TMP, name);
  writeFileSync(p, JSON.stringify(obj), "utf8");
  return p;
}

describe("structured sources registry", () => {
  test("registers engram", () => {
    expect(getStructuredSource("engram")).toBe(engramSource);
    expect(getStructuredSources().map((s) => s.name)).toContain("engram");
  });

  test("unknown source returns undefined", () => {
    expect(getStructuredSource("nope")).toBeUndefined();
  });
});

describe("engramSource.produceDoc", () => {
  test("converts a native Engram export file", () => {
    const file = writeFixture("engram.json", {
      version: "1.0",
      exported_at: "2026-07-20 14:05:00",
      sessions: [{ id: "s1", directory: "/repo" }],
      observations: [
        {
          session_id: "s1",
          type: "bugfix",
          title: "Fix",
          content: "batched query",
          scope: "project",
        },
      ],
      prompts: [],
    });
    const doc = engramSource.produceDoc({ filePath: file });
    expect(doc.source).toBe("engram");
    expect(doc.entries).toHaveLength(1);
    expect(doc.entries[0].category).toBe("gotcha");
    expect(doc.entries[0].project).toBe("/repo");
  });

  test("passes through an already-generic LoreImportDoc file", () => {
    const file = writeFixture("generic.json", {
      lore_import_version: LORE_IMPORT_VERSION,
      source: "generic",
      entries: [{ content: "already normalized", category: "pattern" }],
    });
    const doc = engramSource.produceDoc({ filePath: file });
    expect(doc.source).toBe("generic");
    expect(doc.entries[0].content).toBe("already normalized");
  });

  test("throws a helpful error when neither file nor binary is available", () => {
    let hasEngram = false;
    try {
      hasEngram = engramSource.detect();
    } catch {
      hasEngram = false;
    }
    if (hasEngram) {
      expect(hasEngram).toBe(true);
      return;
    }
    expect(() => engramSource.produceDoc()).toThrow(/Engram not found/);
  });
});
