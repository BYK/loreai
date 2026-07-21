/**
 * Regression test for issue #1398: `lore import --source engram` failed with
 * `Unexpected token 'E', "Exported t"... is not valid JSON`.
 *
 * Root cause: `engram export [file]` writes the JSON to a FILE (default
 * `engram-export.json`) and prints a human-readable summary ("Exported to …",
 * possibly preceded by an "Update available" banner) to stdout. The old code
 * ran `engram export` with no file arg and `JSON.parse`d stdout — which is the
 * summary text, not JSON. The fix passes an explicit temp file and reads it.
 *
 * We mock `node:child_process.execFileSync` to reproduce the real binary's
 * behavior: the `which`/`where` probe succeeds, and `engram export <file>`
 * writes JSON to the file path it was given while emitting summary text to
 * stdout. A correct implementation must read the FILE, not parse stdout.
 */
import { describe, test, expect, vi, beforeEach } from "vitest";
import { writeFileSync } from "node:fs";

const EXPORT_JSON = {
  version: "1.0",
  exported_at: "2026-07-21 18:37:34",
  sessions: [{ id: "s1", directory: "/repo" }],
  observations: [
    {
      session_id: "s1",
      type: "architecture",
      title: "Auth uses JWT",
      content: "The auth layer validates JWT in middleware",
      scope: "project",
    },
  ],
  prompts: [],
};

const SUMMARY_STDOUT =
  "Update available: 0.0.0 -> 1.20.0\nTo update:\n  brew upgrade engram\n\n" +
  "Exported to engram-export.json\n  Sessions:     1\n  Observations: 1\n  Prompts:      0\n";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn((cmd: string, args: readonly string[]) => {
    // `which engram` / `where engram` probe → succeed (binary present).
    if (cmd === "which" || cmd === "where") return "";
    // `engram export <file>` → write JSON to the file arg, "print" summary.
    if (cmd === "engram" && args[0] === "export") {
      const outFile = args[1];
      if (typeof outFile === "string") {
        writeFileSync(outFile, JSON.stringify(EXPORT_JSON), "utf8");
      }
      return SUMMARY_STDOUT;
    }
    throw new Error(`unexpected execFileSync call: ${cmd} ${args?.join(" ")}`);
  }),
}));

describe("engramSource.produceDoc (binary path, #1398 regression)", () => {
  beforeEach(() => vi.clearAllMocks());

  test("reads the export FILE, never parses stdout summary text", async () => {
    // Imported after the mock is registered.
    const { engramSource } =
      await import("../../src/import/structured-sources");
    const doc = await engramSource.produceDoc();
    expect(doc.source).toBe("engram");
    expect(doc.entries).toHaveLength(1);
    expect(doc.entries[0].title).toBe("Auth uses JWT");
    expect(doc.entries[0].category).toBe("architecture");
    expect(doc.entries[0].project).toBe("/repo");
  });

  test("passes an explicit output file to `engram export`", async () => {
    const cp = await import("node:child_process");
    const { engramSource } =
      await import("../../src/import/structured-sources");
    await engramSource.produceDoc();
    const exportCall = (
      cp.execFileSync as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls.find((c) => c[0] === "engram");
    expect(exportCall).toBeDefined();
    // args = ["export", "<tmpfile>"] — the file arg is required for the fix.
    const args = exportCall?.[1] as string[];
    expect(args[0]).toBe("export");
    expect(typeof args[1]).toBe("string");
    expect(args[1].length).toBeGreaterThan(0);
  });
});
