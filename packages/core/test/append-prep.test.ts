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

  const confOf = (where: string, ...args: unknown[]) =>
    (
      db()
        .query(`SELECT confidence FROM knowledge WHERE ${where}`)
        .get(...(args as [])) as { confidence: number }
    ).confidence;

  test("pruneOversized never touches a superseded (oversized) version", () => {
    // v1 is oversized, v2 (current) is small. Discriminating: without the
    // is_current filter, pruneOversized would zero the superseded v1.
    const id = mk("OversizeEntry", "x".repeat(5000));
    const v2 = ltm.appendVersion(id, { content: "small" });
    ltm.pruneOversized(1000);
    expect(confOf("id = ?", v2)).toBe(1.0); // current is small → not oversized
    expect(confOf("logical_id = ? AND is_current = 0", id)).toBe(1.0); // superseded → untouched
  });

  test("decayProject decays only the current version, never a superseded one", () => {
    const id = mk("DecayEntry", "body");
    const v2 = ltm.appendVersion(id, { content: "body2" });
    // A future `now` makes both versions age past the decay grace window without
    // touching timestamps; the interval gate (last_decay_at=0) also opens.
    const future = Date.now() + 60 * 24 * 60 * 60 * 1000;
    const decayed = ltm.decayProject(PROJECT, future);
    expect(decayed).toBe(1); // exactly the current version
    expect(confOf("id = ?", v2)).toBeLessThan(1.0); // current decayed
    expect(confOf("logical_id = ? AND is_current = 0", id)).toBe(1.0); // superseded untouched
  });
});
