import { describe, test, expect } from "vitest";
import {
  LoreImportDoc,
  parseImportDoc,
  safeParseImportDoc,
  LORE_IMPORT_VERSION,
} from "../../src/import/schema";

function validDoc(overrides?: Record<string, unknown>) {
  return {
    lore_import_version: LORE_IMPORT_VERSION,
    source: "generic",
    entries: [{ content: "hello world", category: "pattern" }],
    ...overrides,
  };
}

describe("LoreImportDoc schema", () => {
  test("accepts a minimal valid document", () => {
    const parsed = parseImportDoc(validDoc());
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0].content).toBe("hello world");
  });

  test("rejects a missing content field", () => {
    const res = safeParseImportDoc(
      validDoc({ entries: [{ category: "pattern" }] }),
    );
    expect(res.success).toBe(false);
  });

  test("rejects out-of-range confidence", () => {
    const lo = safeParseImportDoc(
      validDoc({ entries: [{ content: "x", confidence: -0.1 }] }),
    );
    const hi = safeParseImportDoc(
      validDoc({ entries: [{ content: "x", confidence: 1.5 }] }),
    );
    expect(lo.success).toBe(false);
    expect(hi.success).toBe(false);
  });

  test("rejects an unknown category", () => {
    const res = safeParseImportDoc(
      validDoc({ entries: [{ content: "x", category: "bugfix" }] }),
    );
    expect(res.success).toBe(false);
  });

  test("rejects content over the 64K ceiling", () => {
    const res = safeParseImportDoc(
      validDoc({ entries: [{ content: "x".repeat(65_537) }] }),
    );
    expect(res.success).toBe(false);
  });

  test("rejects unknown top-level keys via .strict()", () => {
    const res = safeParseImportDoc(validDoc({ extra: "nope" }));
    expect(res.success).toBe(false);
  });

  test("rejects unknown entry keys via .strict()", () => {
    const res = safeParseImportDoc(
      validDoc({ entries: [{ content: "x", weird: 1 }] }),
    );
    expect(res.success).toBe(false);
  });

  test("rejects a wrong lore_import_version", () => {
    const res = safeParseImportDoc(validDoc({ lore_import_version: 2 }));
    expect(res.success).toBe(false);
  });

  test("a raw Engram export fails .strict() (must go through the adapter)", () => {
    const rawEngram = {
      version: "1.0",
      exported_at: "2026-07-20 14:05:00",
      sessions: [],
      observations: [{ id: 1, type: "bugfix", title: "t", content: "c" }],
      prompts: [],
    };
    const res = safeParseImportDoc(rawEngram);
    expect(res.success).toBe(false);
  });

  test("a raw mem0 dump fails .strict() (must go through the adapter)", () => {
    const rawMem0 = {
      results: [{ id: "uuid", memory: "text", hash: "h" }],
    };
    const res = safeParseImportDoc(rawMem0);
    expect(res.success).toBe(false);
  });

  test("schema is exported as both a value and inferred type", () => {
    const parsed = LoreImportDoc.parse(validDoc());
    expect(parsed.source).toBe("generic");
  });
});
