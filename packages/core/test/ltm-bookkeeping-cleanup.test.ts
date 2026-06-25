import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import * as data from "../src/data";
import { db, ensureProject } from "../src/db";
import * as ltm from "../src/ltm";

// #990: every knowledge hard-delete path must purge the per-entry validation
// bookkeeping tables (knowledge_ref_validity + knowledge_symbol_presence), which
// are keyed on the stable logical_id and have no FK CASCADE. An UPDATE (new
// version, same logical_id) must NOT purge them — they survive version edits.

let root: string;
let seedCounter = 0;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lore-bookkeep-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function seed(): { id: string; logicalId: string } {
  const id = ltm.create({
    projectPath: root,
    scope: "project",
    crossProject: false,
    category: "gotcha",
    title: `Bookkeeping entry ${++seedCounter}`,
    content: "an entry that cites src/real.ts:1 and `someSymbol`",
  });
  const logicalId = ltm.get(id)?.logical_id;
  if (!logicalId) throw new Error("seed failed");
  return { id, logicalId };
}

// Seed one row in each bookkeeping table for this logical_id. Direct inserts
// keep the test deterministic — the cleanup is under test, not the validator.
function seedBookkeeping(logicalId: string): void {
  db()
    .query(
      "INSERT OR REPLACE INTO knowledge_ref_validity (logical_id, broken, total, checked_at) VALUES (?, 1, 2, ?)",
    )
    .run(logicalId, Date.now());
  db()
    .query(
      "INSERT OR REPLACE INTO knowledge_symbol_presence (logical_id, symbol, last_present_at) VALUES (?, 'someSymbol', ?)",
    )
    .run(logicalId, Date.now());
}

function bookkeepingCount(logicalId: string): number {
  const rv = db()
    .query(
      "SELECT COUNT(*) AS c FROM knowledge_ref_validity WHERE logical_id = ?",
    )
    .get(logicalId) as { c: number };
  const sp = db()
    .query(
      "SELECT COUNT(*) AS c FROM knowledge_symbol_presence WHERE logical_id = ?",
    )
    .get(logicalId) as { c: number };
  return rv.c + sp.c;
}

describe("orphan bookkeeping cleanup on knowledge delete (#990)", () => {
  test("remove() purges ref_validity + symbol_presence for the entry", () => {
    const { logicalId } = seed();
    seedBookkeeping(logicalId);
    expect(bookkeepingCount(logicalId)).toBe(2);

    ltm.remove(logicalId);

    expect(bookkeepingCount(logicalId)).toBe(0);
  });

  test("update() (new version) PRESERVES bookkeeping — survives version edits", () => {
    const { id, logicalId } = seed();
    seedBookkeeping(logicalId);

    // A content change appends a new version; the logical_id is unchanged, so the
    // logical_id-keyed bookkeeping must stay (it intentionally outlives versions).
    // NB: `id` is now a superseded version, so resolve via logical_id — get()
    // only exposes the current version.
    ltm.update(id, {
      content: "changed content forces a brand new version row",
    });

    const current = ltm.getByLogical(logicalId);
    expect(current?.logical_id).toBe(logicalId); // entry still present
    expect(current?.content).toContain("brand new version"); // update materialized
    expect(bookkeepingCount(logicalId)).toBe(2); // not purged
  });

  test("clearKnowledge() purges bookkeeping for the project's entries", () => {
    const { logicalId } = seed();
    seedBookkeeping(logicalId);
    expect(bookkeepingCount(logicalId)).toBe(2);

    data.clearKnowledge(root);

    expect(bookkeepingCount(logicalId)).toBe(0);
  });

  test("clearProject() purges bookkeeping for the project's entries", () => {
    const { logicalId } = seed();
    seedBookkeeping(logicalId);
    expect(bookkeepingCount(logicalId)).toBe(2);

    data.clearProject(root);

    expect(bookkeepingCount(logicalId)).toBe(0);
  });

  test("deleteProject() purges bookkeeping for the project's entries", () => {
    const { logicalId } = seed();
    seedBookkeeping(logicalId);
    expect(bookkeepingCount(logicalId)).toBe(2);

    data.deleteProject(ensureProject(root));

    expect(bookkeepingCount(logicalId)).toBe(0);
  });
});
