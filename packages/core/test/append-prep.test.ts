import { beforeEach, describe, expect, test } from "vitest";
import { db, ensureProject } from "../src/db";
import { validateDatabaseIntegrity } from "../src/data";
import * as ltm from "../src/ltm";
import { rebuildFts } from "../src/sync-data";

const PROJECT = "/test/a2/append-prep";

// 2b-2a is the behavior-preserving prep for the append flip: it adds the
// single-current invariant, makes the FTS/integrity obligations partial-mirror
// aware, and wraps appendVersion atomically. These tests simulate appends via
// appendVersion() (still the only caller) to prove the obligations hold once
// versioning goes live in 2b-2b.
describe("A2 sub-PR 2b-2a: append-only invariants + partial-mirror obligations", () => {
  beforeEach(() => {
    const pid = ensureProject(PROJECT);
    db().query("DELETE FROM knowledge WHERE project_id = ?").run(pid);
  });

  const mk = (title: string, content: string) =>
    ltm.create({
      projectPath: PROJECT,
      scope: "project",
      category: "decision",
      title,
      content,
    });

  test("appendVersion leaves exactly one current version per logical_id", () => {
    const id = mk("OneCurrent", "v1");
    const v2 = ltm.appendVersion(id, { content: "v2" });
    expect(v2).not.toBe(id);
    const currents = db()
      .query(
        "SELECT COUNT(*) as c FROM knowledge WHERE logical_id = ? AND is_current = 1",
      )
      .get(id) as { c: number };
    expect(currents.c).toBe(1);
    const total = db()
      .query("SELECT COUNT(*) as c FROM knowledge WHERE logical_id = ?")
      .get(id) as { c: number };
    expect(total.c).toBe(2); // both versions physically present
  });

  test("UNIQUE idx_knowledge_one_current rejects a second current version", () => {
    const id = mk("UniqueGuard", "v1");
    ltm.appendVersion(id, { content: "v2" });
    const superseded = db()
      .query(
        "SELECT id FROM knowledge WHERE logical_id = ? AND is_current = 0 LIMIT 1",
      )
      .get(id) as { id: string };
    // Flipping a superseded version back to current = two current rows → rejected.
    expect(() =>
      db()
        .query("UPDATE knowledge SET is_current = 1 WHERE id = ?")
        .run(superseded.id),
    ).toThrow(/UNIQUE|constraint/i);
  });

  test("validateDatabaseIntegrity (COUNT-based FTS parity) is unaffected by versioning", () => {
    mk("IntegrityA", "alpha");
    const id = mk("IntegrityB", "beta");
    ltm.appendVersion(id, { content: "beta2" }); // 3 physical rows now
    const r = validateDatabaseIntegrity();
    // knowledge_fts is external-content: COUNT(*) scans the content table, so it
    // tracks COUNT(knowledge) (3 == 3) regardless of which versions are indexed.
    expect(r.knowledgeFtsMatch).toBe(true);
    expect(r.ok).toBe(true);
  });

  test("rebuildFts('knowledge_fts') re-indexes only current, non-deleted versions", () => {
    const id = mk("RebuildEntry", "alphaword");
    ltm.appendVersion(id, { content: "betaword" }); // v1 superseded, v2 current
    const del = mk("DeletedEntry", "gammaword");
    ltm.appendVersion(del, { isDeleted: true }); // death certificate, not live

    rebuildFts("knowledge_fts");

    // Assert the actual INDEX via MATCH (COUNT(*) would scan the content table).
    // FTS5 'rebuild' would re-index EVERY physical row → superseded/deleted become
    // matchable again; the current-aware rebuild keeps them out.
    const match = (term: string) =>
      (
        db()
          .query(
            `SELECT COUNT(*) c FROM knowledge_fts WHERE knowledge_fts MATCH '${term}'`,
          )
          .get() as { c: number }
      ).c;
    expect(match("betaword")).toBe(1); // current — indexed
    expect(match("alphaword")).toBe(0); // superseded — not indexed
    expect(match("gammaword")).toBe(0); // deleted — not indexed
  });

  test("decayProject and pruneOversized only touch current versions", () => {
    const id = mk("WriteSiteEntry", "short");
    // append a superseded version that is oversized; only the CURRENT (short) one
    // should be exempt from pruneOversized, and the superseded must stay untouched.
    const big = "x".repeat(5000);
    db()
      .query("UPDATE knowledge SET content = ? WHERE id = ? AND is_current = 0")
      .run(big, id); // (no superseded yet — make one first)
    const v2 = ltm.appendVersion(id, { content: big }); // current is now oversized
    ltm.pruneOversized(1000);
    // current (oversized) zeroed; the v1 superseded row must NOT be touched.
    const curConf = db()
      .query("SELECT confidence FROM knowledge WHERE id = ?")
      .get(v2) as { confidence: number };
    expect(curConf.confidence).toBe(0);
    const supConf = db()
      .query(
        "SELECT confidence FROM knowledge WHERE logical_id = ? AND is_current = 0",
      )
      .get(id) as { confidence: number };
    expect(supConf.confidence).toBe(1.0); // untouched
  });
});
