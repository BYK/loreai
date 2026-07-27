import { describe, expect, test } from "vitest";
import { close, db } from "../src/db";
import * as ltm from "../src/ltm";

// D2c PR-2: knowledge_file_refs sidecar, keyed on logical_id. Associations
// are project-context (NOT user knowledge), so they live in a per-entry
// sidecar that survives version edits (keyed on logical_id, not on a
// version row). setFileRefs replaces; knowledgeFileRefsBatch reads.

const PROJECT = "/test/d2c-pr2/file-refs";

describe("ltm.setFileRefs / knowledgeFileRefsBatch (D2c PR-2)", () => {
  test("setFileRefs persists, batch reader returns sorted unique paths", () => {
    const id = ltm.create({
      projectPath: PROJECT,
      scope: "project",
      category: "decision",
      title: "Stripe retry uses idempotency key",
      content: "...",
    });
    const out = ltm.setFileRefs(id, [
      "src/lib/retry.ts",
      "src/auth/stripe-client.ts",
      "src/auth/stripe-client.ts", // duplicate → ignored
      "  ", // whitespace-only → dropped
    ]);
    expect(out).toEqual(["src/auth/stripe-client.ts", "src/lib/retry.ts"]); // sorted + deduped
    const got = ltm.knowledgeFileRefsBatch([id]).get(id);
    expect(got).toEqual(["src/auth/stripe-client.ts", "src/lib/retry.ts"]);
  });

  test("setFileRefs caps at MAX_FILE_REFS_PER_ENTRY (20) defensively", () => {
    const id = ltm.create({
      projectPath: PROJECT,
      scope: "project",
      category: "decision",
      title: "Wide entry",
      content: "...",
    });
    const paths = Array.from({ length: 50 }, (_, i) => `src/file-${i}.ts`);
    const out = ltm.setFileRefs(id, paths);
    expect(out).toHaveLength(ltm.MAX_FILE_REFS_PER_ENTRY);
    expect(out).toHaveLength(20);
  });

  test("setFileRefs is idempotent (re-call replaces, not appends)", () => {
    const id = ltm.create({
      projectPath: PROJECT,
      scope: "project",
      category: "decision",
      title: "Idempotent tag",
      content: "...",
    });
    ltm.setFileRefs(id, ["a.ts", "b.ts"]);
    ltm.setFileRefs(id, ["c.ts"]);
    const got = ltm.knowledgeFileRefsBatch([id]).get(id);
    expect(got).toEqual(["c.ts"]);
  });

  test("knowledgeFileRefsBatch caps reader output at MAX_RECALL_FILES_PER_ENTRY (3)", () => {
    const id = ltm.create({
      projectPath: PROJECT,
      scope: "project",
      category: "decision",
      title: "Many files",
      content: "...",
    });
    // Write 10 (under MAX_FILE_REFS_PER_ENTRY=20)
    const paths = Array.from({ length: 10 }, (_, i) => `src/f-${i}.ts`);
    ltm.setFileRefs(id, paths);
    const got = ltm.knowledgeFileRefsBatch([id]).get(id);
    expect(got).toHaveLength(ltm.MAX_RECALL_FILES_PER_ENTRY);
    expect(got).toHaveLength(3);
    // First 3 (alphabetically)
    expect(got).toEqual(["src/f-0.ts", "src/f-1.ts", "src/f-2.ts"]);
  });

  test("knowledgeFileRefsBatch: empty input → empty map (no query)", () => {
    const got = ltm.knowledgeFileRefsBatch([]);
    expect(got.size).toBe(0);
  });

  test("knowledgeFileRefsBatch: entry with no associations → absent from map", () => {
    const id = ltm.create({
      projectPath: PROJECT,
      scope: "project",
      category: "decision",
      title: "Untagged entry",
      content: "...",
    });
    const got = ltm.knowledgeFileRefsBatch([id]);
    expect(got.has(id)).toBe(false);
  });

  test("setFileRefs updates updated_at clock (monotonic per row)", async () => {
    const id = ltm.create({
      projectPath: PROJECT,
      scope: "project",
      category: "decision",
      title: "Clock test",
      content: "...",
    });
    ltm.setFileRefs(id, ["a.ts"]);
    const t1 = (
      db()
        .query(
          "SELECT updated_at AS t FROM knowledge_file_refs WHERE logical_id = ?",
        )
        .get(id) as { t: number }
    ).t;
    // Tiny pause to guarantee the unixepoch('now') value changes (second-grain
    // on most platforms — for SQLite ≥3.38 it can be sub-second).
    await new Promise((r) => setTimeout(r, 1100));
    ltm.setFileRefs(id, ["b.ts"]);
    const t2 = (
      db()
        .query(
          "SELECT updated_at AS t FROM knowledge_file_refs WHERE logical_id = ?",
        )
        .get(id) as { t: number }
    ).t;
    expect(t2).toBeGreaterThan(t1);
  });

  test("recoverMissingObjects: missing knowledge_file_refs table is recreated", () => {
    // Simulate the failure mode: drop the table, close, reopen.
    db().exec("DROP TABLE knowledge_file_refs");
    close();
    // Reopen triggers recoverMissingObjects.
    db();
    // New entry should work cleanly.
    const id = ltm.create({
      projectPath: PROJECT,
      scope: "project",
      category: "decision",
      title: "Post-recovery entry",
      content: "...",
    });
    expect(() => ltm.setFileRefs(id, ["x.ts"])).not.toThrow();
    expect(ltm.knowledgeFileRefsBatch([id]).get(id)).toEqual(["x.ts"]);
  });
});
