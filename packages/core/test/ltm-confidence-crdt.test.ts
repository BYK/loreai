import { beforeEach, describe, expect, test } from "vitest";
import { db, ensureProject, getKV } from "../src/db";
import * as ltm from "../src/ltm";

// A2 sub-PR 3b-2a: confidence is a materialized cache over a per-replica PN-counter
// CRDT. These tests pin the LOCAL mechanics (3b-2b adds the remote sync/merge):
//   value = clamp(base_confidence + Σpos − Σneg, 0, 1)  [clamp only at read]
//   each lifecycle op records a signed delta on THIS replica's grow-only counters.
const PROJECT = "/test/a2/conf-crdt";

const meta = (logicalId: string) =>
  db()
    .query(
      "SELECT confidence, base_confidence FROM knowledge_meta WHERE logical_id = ?",
    )
    .get(logicalId) as { confidence: number; base_confidence: number };

const crdtRows = (logicalId: string) =>
  db()
    .query(
      "SELECT replica_id, pos, neg FROM knowledge_meta_crdt WHERE logical_id = ? ORDER BY replica_id",
    )
    .all(logicalId) as Array<{ replica_id: string; pos: number; neg: number }>;

const mk = (title: string, confidence = 1.0) =>
  ltm.create({
    projectPath: PROJECT,
    scope: "project",
    category: "decision",
    title,
    content: `body ${title}`,
    confidence,
  });

describe("A2 3b-2a: confidence PN-counter register", () => {
  beforeEach(() => {
    const pid = ensureProject(PROJECT);
    db().query("DELETE FROM knowledge WHERE project_id = ?").run(pid);
    db().query("DELETE FROM knowledge_meta").run();
    db().query("DELETE FROM knowledge_meta_crdt").run();
  });

  test("create() sets base = confidence and records NO counters", () => {
    const id = mk("Created", 0.8);
    const m = meta(id);
    expect(m.base_confidence).toBeCloseTo(0.8, 6);
    expect(m.confidence).toBeCloseTo(0.8, 6);
    expect(crdtRows(id)).toHaveLength(0);
  });

  test("reinforce records a positive delta on the local replica and re-materializes", () => {
    const id = mk("Reinforced", 0.5);
    ltm.reinforce(id, 0.05);
    const rows = crdtRows(id);
    expect(rows).toHaveLength(1); // exactly one (local) replica
    expect(rows[0].pos).toBeCloseTo(0.05, 6);
    expect(rows[0].neg).toBe(0);
    expect(meta(id).confidence).toBeCloseTo(0.55, 6); // base 0.5 + 0.05
  });

  test("a negative delta accumulates into neg; interior values match step-clamping", () => {
    const id = mk("Decayed", 0.5);
    ltm.reinforce(id, -0.1); // negative delta = a decrement
    const rows = crdtRows(id);
    expect(rows[0].neg).toBeCloseTo(0.1, 6);
    expect(meta(id).confidence).toBeCloseTo(0.4, 6);
  });

  test("clamp is applied only at read — value floors at 0, counters keep the overshoot", () => {
    const id = mk("Floored", 0.3);
    ltm.reinforce(id, -0.5); // unclamped 0.3 − 0.5 = −0.2
    expect(meta(id).confidence).toBe(0); // clamped at read
    expect(crdtRows(id)[0].neg).toBeCloseTo(0.5, 6); // full overshoot retained
  });

  test("ACCEPTED hysteresis: excess banked past the ceiling absorbs a later decrement", () => {
    const banked = mk("Banked", 1.0); // base 1.0
    ltm.reinforce(banked, 0.2); // unclamped 1.2 → reads 1.0, banks +0.2
    expect(meta(banked).confidence).toBe(1.0);
    ltm.reinforce(banked, -0.1); // unclamped 1.1 → STILL reads 1.0 (hysteresis)
    expect(meta(banked).confidence).toBe(1.0);

    // Contrast: an un-banked entry at the ceiling drops immediately.
    const plain = mk("Plain", 1.0);
    ltm.reinforce(plain, -0.1);
    expect(meta(plain).confidence).toBeCloseTo(0.9, 6);
  });

  test("all local ops share ONE stable replica_id (KV-backed)", () => {
    const a = mk("A", 0.5);
    const b = mk("B", 0.5);
    ltm.reinforce(a, 0.05);
    ltm.reinforce(b, 0.05);
    const rid = getKV("sync.replica_id");
    expect(rid).toBeTruthy();
    expect(crdtRows(a)[0].replica_id).toBe(rid);
    expect(crdtRows(b)[0].replica_id).toBe(rid);
  });

  test("materialization SUMS across replicas (the convergent core of the CRDT)", () => {
    const id = mk("Converged", 0.5);
    ltm.reinforce(id, 0.05); // local replica pos = 0.05
    // Simulate a counter pulled from a second device (3b-2b merge installs these).
    db()
      .query(
        "INSERT INTO knowledge_meta_crdt (logical_id, replica_id, pos, neg, updated_at) VALUES (?, 'replica-B', 0.2, 0, 0)",
      )
      .run(id);
    // Any subsequent local op re-materializes over ALL replicas' counters.
    ltm.reinforce(id, 0.05); // local pos now 0.10
    // base 0.5 + (local 0.10 + B 0.20) = 0.80
    expect(meta(id).confidence).toBeCloseTo(0.8, 6);
    expect(crdtRows(id)).toHaveLength(2);
  });

  test("update(confidence) sets the value via a delta-to-target on the local replica", () => {
    const id = mk("Set", 1.0); // base 1.0
    ltm.update(id, { confidence: 0.4 });
    expect(meta(id).confidence).toBeCloseTo(0.4, 6);
    // delta = 0.4 − 1.0 = −0.6 recorded as neg.
    expect(crdtRows(id)[0].neg).toBeCloseTo(0.6, 6);
  });

  test("ACCEPTED hysteresis: update(confidence) on a BANKED entry lands above target, converges on a 2nd pass", () => {
    const id = mk("BankedSet", 1.0); // base 1.0
    ltm.reinforce(id, 0.2); // banks +0.2 (reads 1.0)
    ltm.update(id, { confidence: 0.4 }); // delta = 0.4 − read(1.0) = −0.6 → neg 0.6
    // clamp(1.0 + 0.2 − 0.6) = 0.6: the banked +0.2 absorbs part of the cut, so the
    // value lands ABOVE the requested 0.4 — the accepted cost of a faithful additive
    // CRDT (counters clamp only at read), NOT a per-step clamp. A re-apply converges.
    expect(meta(id).confidence).toBeCloseTo(0.6, 6);
    ltm.update(id, { confidence: 0.4 }); // delta = 0.4 − read(0.6) = −0.2 → neg 0.8
    expect(meta(id).confidence).toBeCloseTo(0.4, 6); // now exact
  });

  test("penalizeStaleReferences records a DURABLE counter delta (survives re-materialization)", () => {
    const id = mk("Stale", 0.8); // base 0.8
    ltm.penalizeStaleReferences(id, 0.1);
    expect(meta(id).confidence).toBeCloseTo(0.7, 6);
    // The penalty must be a neg COUNTER, not a direct confidence write — a direct
    // `UPDATE knowledge_meta SET confidence` (the pre-CRDT #627 code) records no row.
    const rows = crdtRows(id);
    expect(rows).toHaveLength(1);
    expect(rows[0].neg).toBeCloseTo(0.1, 6);
    // A later re-materialization (triggered by ANY subsequent confidence op) recomputes
    // confidence = base + Σpos − Σneg. The penalty must PERSIST — a direct write would
    // have been wiped back to base 0.8 here (the exact rebase-integration bug).
    ltm.rematerializeConfidence(id, Date.now());
    expect(meta(id).confidence).toBeCloseTo(0.7, 6);
  });

  test("pruneOversized drives confidence to 0 via a delta of −(current)", () => {
    const id = mk("Oversized", 0.7);
    db()
      .query("UPDATE knowledge SET content = ? WHERE logical_id = ?")
      .run("x".repeat(5000), id);
    const pruned = ltm.pruneOversized(1000);
    expect(pruned).toBe(1);
    expect(meta(id).confidence).toBe(0);
  });

  test("pruneOversized zeroes a BANKED entry using RAW (not clamped) confidence", () => {
    // Discriminates the hysteresis fix: a delta of −(clamped read) would leave the
    // banked overshoot behind. base 1.0 + banked +0.5 → raw 1.5, reads 1.0.
    const id = mk("BankedOversized", 1.0);
    ltm.reinforce(id, 0.5); // unclamped 1.5 → reads 1.0, banks +0.5
    expect(meta(id).confidence).toBe(1.0);
    db()
      .query("UPDATE knowledge SET content = ? WHERE logical_id = ?")
      .run("x".repeat(5000), id);

    const pruned = ltm.pruneOversized(1000);
    expect(pruned).toBe(1);
    // −(clamped 1.0) would leave raw 0.5 (reads 0.5); only −(raw 1.5) reaches 0.
    expect(meta(id).confidence).toBe(0);
    const rows = crdtRows(id);
    // The prune's negative delta must fully cancel the +0.5 pos bank: raw = 0.
    const raw =
      meta(id).base_confidence + rows.reduce((s, r) => s + r.pos - r.neg, 0);
    expect(raw).toBeCloseTo(0, 6);
  });
});
