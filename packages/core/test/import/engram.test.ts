import { describe, test, expect } from "vitest";
import { parseEngramExport } from "../../src/import/sources/engram";
import { MAX_ENTRY_CONTENT_LENGTH } from "../../src/curator";

function engramExport(observations: unknown[], sessions: unknown[] = []) {
  return {
    version: "1.0",
    exported_at: "2026-07-20 14:05:00",
    sessions,
    observations,
    prompts: [],
  };
}

describe("parseEngramExport", () => {
  test("maps observations to entries with category mapping", () => {
    const doc = parseEngramExport(
      engramExport([
        { type: "bugfix", title: "N+1 fix", content: "batched query" },
        { type: "decision", title: "Chose zod", content: "for validation" },
        { type: "config", title: "CI setup", content: "gha" },
        { type: "unknown", title: "Misc", content: "misc body" },
      ]),
    );
    expect(doc.source).toBe("engram");
    const byTitle = new Map(doc.entries.map((e) => [e.title, e.category]));
    expect(byTitle.get("N+1 fix")).toBe("gotcha"); // bugfix -> gotcha
    expect(byTitle.get("Chose zod")).toBe("decision");
    expect(byTitle.get("CI setup")).toBe("architecture"); // config -> architecture
    expect(byTitle.get("Misc")).toBe("pattern"); // unknown -> pattern
  });

  test("resolves project from the session directory", () => {
    const doc = parseEngramExport(
      engramExport(
        [
          {
            session_id: "s1",
            type: "pattern",
            title: "P",
            content: "body",
            scope: "project",
          },
        ],
        [{ id: "s1", project: "engram", directory: "/home/u/code/engram" }],
      ),
    );
    expect(doc.entries[0].project).toBe("/home/u/code/engram");
  });

  test("skips soft-deleted observations", () => {
    const doc = parseEngramExport(
      engramExport([
        { type: "pattern", title: "Live", content: "kept" },
        {
          type: "pattern",
          title: "Dead",
          content: "removed",
          deleted_at: "2026-07-20 10:00:00",
        },
      ]),
    );
    const titles = doc.entries.map((e) => e.title);
    expect(titles).toContain("Live");
    expect(titles).not.toContain("Dead");
  });

  test("personal/global scope observations get no project (become global)", () => {
    const doc = parseEngramExport(
      engramExport(
        [
          {
            session_id: "s1",
            type: "preference",
            title: "Global pref",
            content: "everywhere",
            scope: "personal",
          },
        ],
        [{ id: "s1", directory: "/home/u/code/engram" }],
      ),
    );
    expect(doc.entries[0].project).toBeUndefined();
  });

  test("carries sync_id as external_id and preserves long content", () => {
    const long = "y".repeat(MAX_ENTRY_CONTENT_LENGTH + 300);
    const doc = parseEngramExport(
      engramExport([
        {
          type: "pattern",
          title: "Long",
          content: long,
          sync_id: "obs-abc123",
        },
      ]),
    );
    expect(doc.entries[0].external_id).toBe("obs-abc123");
    // The adapter preserves content; the importer truncates.
    expect(doc.entries[0].content.length).toBe(long.length);
  });

  test("skips observations with empty content", () => {
    const doc = parseEngramExport(
      engramExport([
        { type: "pattern", title: "Empty", content: "   " },
        { type: "pattern", title: "Full", content: "real" },
      ]),
    );
    expect(doc.entries.map((e) => e.title)).toEqual(["Full"]);
  });

  test("handles missing sessions/observations gracefully", () => {
    const doc = parseEngramExport({});
    expect(doc.entries).toEqual([]);
    expect(doc.source).toBe("engram");
  });

  test("deleted_at falsy-but-present (empty string) is NOT treated as deleted", () => {
    // The adapter skips only on a TRUTHY deleted_at (a real timestamp). A
    // falsy-but-present value (empty string) means "live" → kept. Guards against
    // silently dropping a live observation because of an empty deleted_at.
    const doc = parseEngramExport(
      engramExport([
        { type: "pattern", title: "EmptyDel", content: "body", deleted_at: "" },
      ]),
    );
    expect(doc.entries.map((e) => e.title)).toEqual(["EmptyDel"]);
  });

  test("clamps out-of-range Engram confidence into [0,1]", () => {
    const doc = parseEngramExport(
      engramExport([
        { type: "pattern", title: "HiConf", content: "a", confidence: 1.7 },
        { type: "pattern", title: "LoConf", content: "b", confidence: -0.5 },
      ]),
    );
    const byTitle = new Map(doc.entries.map((e) => [e.title, e.confidence]));
    expect(byTitle.get("HiConf")).toBe(1);
    expect(byTitle.get("LoConf")).toBe(0);
  });

  test("an oversized observation is truncated, not rejected (no whole-import abort)", () => {
    // A single >64K observation must NOT throw a ZodError that aborts the entire
    // export. The adapter clamps to the schema ceiling; the importer truncates
    // further downstream. Other entries in the same export survive.
    const huge = "h".repeat(80_000);
    const doc = parseEngramExport(
      engramExport([
        { type: "pattern", title: "Huge", content: huge },
        { type: "pattern", title: "Small", content: "ok" },
      ]),
    );
    const titles = doc.entries.map((e) => e.title);
    expect(titles).toContain("Huge");
    expect(titles).toContain("Small");
    const hugeEntry = doc.entries.find((e) => e.title === "Huge");
    expect(hugeEntry!.content.length).toBeLessThanOrEqual(65_536);
  });
});
