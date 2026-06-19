import { describe, test, expect, beforeEach } from "vitest";
import { db } from "../src/db";
import * as ltm from "../src/ltm";

const PROJECT = "/test/ltm/curator-budget";
const OTHER = "/test/ltm/curator-budget-other";

function clearKnowledge() {
  db().query("DELETE FROM knowledge").run();
}

// ---------------------------------------------------------------------------
// pruneDeadEntries
// ---------------------------------------------------------------------------

describe("ltm.pruneDeadEntries", () => {
  beforeEach(clearKnowledge);

  test("deletes only project entries at/below the 0.2 floor and tombstones them", () => {
    const dead = ltm.create({
      projectPath: PROJECT,
      category: "gotcha",
      title: "Dead",
      content: "decayed out",
      scope: "project",
    });
    ltm.update(dead, { confidence: 0.1 });
    const boundary = ltm.create({
      projectPath: PROJECT,
      category: "gotcha",
      title: "Boundary",
      content: "exactly at floor",
      scope: "project",
    });
    ltm.update(boundary, { confidence: 0.2 }); // forProject filters > 0.2, so 0.2 is dead
    const alive = ltm.create({
      projectPath: PROJECT,
      category: "gotcha",
      title: "Alive",
      content: "still useful",
      scope: "project",
    });

    const pruned = ltm.pruneDeadEntries(PROJECT);

    expect(pruned.map((e) => e.id).sort()).toEqual([dead, boundary].sort());
    expect(ltm.get(dead)).toBeNull();
    expect(ltm.get(boundary)).toBeNull();
    expect(ltm.isTombstoned(dead)).toBe(true);
    expect(ltm.get(alive)).not.toBeNull();
  });

  test("never prunes a promoted cross-project entry that kept its origin project_id (Seer #815)", () => {
    // Promotion (promoteCrossProject) flips cross_project = 1 in place, keeping
    // the origin project_id. A decayed promoted entry must NOT be reaped by its
    // origin project — that would delete shared knowledge for everyone.
    const promoted = ltm.create({
      projectPath: PROJECT,
      category: "preference",
      title: "Promoted shared",
      content: "x",
      scope: "project",
    });
    db()
      .query(
        "UPDATE knowledge SET cross_project = 1, confidence = 0.1 WHERE id = ?",
      )
      .run(promoted);

    const pruned = ltm.pruneDeadEntries(PROJECT);

    expect(pruned).toHaveLength(0);
    expect(ltm.get(promoted)).not.toBeNull();
  });

  test("never touches other-project or cross-project (global) dead entries", () => {
    const otherDead = ltm.create({
      projectPath: OTHER,
      category: "gotcha",
      title: "OtherDead",
      content: "x",
      scope: "project",
    });
    ltm.update(otherDead, { confidence: 0.0 });
    const globalDead = ltm.create({
      category: "preference",
      title: "GlobalDead",
      content: "z",
      scope: "global",
      crossProject: true,
    });
    ltm.update(globalDead, { confidence: 0.0 });

    const pruned = ltm.pruneDeadEntries(PROJECT);

    expect(pruned).toHaveLength(0);
    expect(ltm.get(otherDead)).not.toBeNull();
    expect(ltm.get(globalDead)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// forCurator (token-budgeted existing-entries context)
// ---------------------------------------------------------------------------

describe("ltm.forCurator", () => {
  beforeEach(clearKnowledge);

  test("returns the full set unchanged when it fits the budget", () => {
    for (let i = 0; i < 5; i++) {
      ltm.create({
        projectPath: PROJECT,
        category: "gotcha",
        title: `T${i}`,
        content: "short",
        scope: "project",
      });
    }
    const out = ltm.forCurator(PROJECT, 1_000_000);
    expect(out).toHaveLength(5);
  });

  test("over budget: always includes cross-project entries, packs project-scoped by confidence, never exceeds budget", () => {
    const global = ltm.create({
      category: "preference",
      title: "Global pref",
      content: "g".repeat(300),
      scope: "global",
      crossProject: true,
    });
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) {
      ids.push(
        ltm.create({
          projectPath: PROJECT,
          category: "gotcha",
          title: `T${i}`,
          content: "c".repeat(300),
          scope: "project",
          confidence: 1 - i * 0.01, // T0 highest → T19 lowest
        }),
      );
    }

    const budget = 400; // tokens — only a few entries fit
    const out = ltm.forCurator(PROJECT, budget);

    // Cross-project entry is always visible (shared; must be dedup/update-able).
    expect(out.some((e) => e.id === global)).toBe(true);
    // Highest-confidence project entry kept; lowest dropped.
    expect(out.some((e) => e.id === ids[0])).toBe(true);
    expect(out.some((e) => e.id === ids[19])).toBe(false);
    // The project-scoped slice never exceeds the token budget.
    const projTokens = out
      .filter((e) => e.project_id !== null && e.cross_project !== 1)
      .reduce(
        (sum, e) =>
          sum +
          Math.ceil(
            `[${e.id}] (${e.category}) ${e.title}: ${e.content}`.length / 3,
          ),
        0,
      );
    expect(projTokens).toBeLessThanOrEqual(budget);
    // Result preserves forProject ordering (confidence DESC).
    const projOut = out.filter((e) => e.cross_project !== 1);
    const confs = projOut.map((e) => e.confidence);
    expect(confs).toEqual([...confs].sort((a, b) => b - a));
  });

  test("an oversized top-confidence entry does not starve smaller lower-confidence entries (continue, not break)", () => {
    // The highest-confidence entry alone blows the budget. A break-on-overflow
    // packer would drop EVERYTHING after it (curator sees nothing); the
    // continue-on-overflow packer skips just the oversized entry and keeps the
    // smaller ones it can still afford — maximising dedup coverage.
    const huge = ltm.create({
      projectPath: PROJECT,
      category: "gotcha",
      title: "Huge",
      content: "h".repeat(3000), // ~1000 tokens — exceeds the budget alone
      scope: "project",
      confidence: 1.0,
    });
    const small: string[] = [];
    for (let i = 0; i < 3; i++) {
      small.push(
        ltm.create({
          projectPath: PROJECT,
          category: "gotcha",
          title: `Small ${i}`,
          content: "s".repeat(30), // ~tens of tokens each
          scope: "project",
          confidence: 0.9 - i * 0.01,
        }),
      );
    }

    const out = ltm.forCurator(PROJECT, 300);

    expect(out.some((e) => e.id === huge)).toBe(false); // oversized → skipped
    // ...but the smaller, lower-confidence entries are still visible.
    expect(small.every((id) => out.some((e) => e.id === id))).toBe(true);
  });
});
