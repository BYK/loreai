import { db, ensureProject, entities, ltm } from "@loreai/core";
import { beforeEach, describe, expect, it } from "vitest";
import {
  acceptEntityDuplicate,
  acceptKnowledgeDuplicate,
  dismissContradiction,
  rejectEntityDuplicate,
  rejectKnowledgeDuplicate,
  resolveContradiction,
} from "../src/review-actions";

// Guarded review decisions for #1123 (contradictions) and #462 (dedup
// feedback). Detection is covered in core; here we exercise the decision
// wiring that used to live in the legacy dashboard's POST handlers.

const PROJECT = "/test/review-actions";

function createEntry(title: string): string {
  return ltm.create({
    projectPath: PROJECT,
    category: "preference",
    title,
    content: `${title} content`,
    scope: "project",
    confidence: 0.9,
  });
}

function seedPair(
  titleA: string,
  titleB: string,
): { a: string; b: string; pid: string } {
  const pid = ensureProject(PROJECT);
  const a = createEntry(titleA);
  const b = createEntry(titleB);
  ltm.recordContradiction({
    logicalIdA: a,
    logicalIdB: b,
    projectId: pid,
    similarity: 0.97,
    rationale: "opposite directives",
  });
  return { a, b, pid };
}

function feedbackRows(kind: "knowledge" | "entity") {
  return db()
    .query(
      "SELECT entry_a_title, entry_b_title, accepted, similarity, source FROM dedup_feedback WHERE kind = ? ORDER BY created_at",
    )
    .all(kind) as Array<{
    entry_a_title: string;
    entry_b_title: string;
    accepted: number;
    similarity: number;
    source: string;
  }>;
}

/**
 * Produce a version id of `logicalId` that is neither the logical id nor the
 * current head: bump twice and hand back the middle version's id.
 */
function staleVersionId(logicalId: string): string {
  ltm.update(logicalId, { content: `${logicalId} v2` });
  const middle = ltm.getByLogical(logicalId);
  if (!middle) throw new Error("entry vanished");
  ltm.update(logicalId, { content: `${logicalId} v3` });
  expect(middle.id).not.toBe(logicalId);
  expect(ltm.get(middle.id)).toBeNull();
  expect(ltm.logicalIdOf(middle.id)).toBe(logicalId);
  return middle.id;
}

beforeEach(() => {
  for (const c of ltm.listOpenContradictions()) {
    ltm.setContradictionStatus(c.logicalIdA, c.logicalIdB, "dismissed");
  }
  db().exec("DELETE FROM dedup_feedback");
});

describe("contradiction decisions (#1123)", () => {
  it("dismiss keeps both entries but removes the pair from the open list", () => {
    const { a, b } = seedPair("Deploy from main", "Deploy from release");
    expect(ltm.listOpenContradictions()).toHaveLength(1);

    dismissContradiction(a, b);

    expect(ltm.listOpenContradictions()).toHaveLength(0);
    expect(ltm.get(a)).not.toBeNull();
    expect(ltm.get(b)).not.toBeNull();
    // Never re-surfaced / re-judged.
    expect(ltm.contradictionExists(a, b)).toBe(true);
  });

  it("resolve keeps one entry, removes the other, and clears the pair", () => {
    const { a, b } = seedPair("Never mock the DB", "Always mock the DB");

    expect(resolveContradiction(a, b)).toBe(true);

    expect(ltm.get(b)).toBeNull();
    expect(ltm.isTombstoned(b)).toBe(true);
    expect(ltm.get(a)).not.toBeNull();
    expect(ltm.listOpenContradictions()).toHaveLength(0);
    // remove() purged the pair row entirely.
    expect(ltm.contradictionExists(a, b)).toBe(false);
  });

  it("resolve accepts the pair in either order", () => {
    const { a, b } = seedPair("Tabs", "Spaces");
    expect(resolveContradiction(b, a)).toBe(true);
    expect(ltm.get(a)).toBeNull();
    expect(ltm.get(b)).not.toBeNull();
  });

  it("resolve is a no-op when no contradiction is recorded between the two ids", () => {
    const x = createEntry("Standalone rule X");
    const y = createEntry("Standalone rule Y");
    expect(ltm.contradictionExists(x, y)).toBe(false);

    expect(resolveContradiction(x, y)).toBe(false);
    // Neither entry deleted — this is not a generic delete.
    expect(ltm.get(x)).not.toBeNull();
    expect(ltm.get(y)).not.toBeNull();
  });

  it("resolve is a no-op when keep and remove are the same id", () => {
    const { a } = seedPair("Rule one", "Rule two");
    expect(resolveContradiction(a, a)).toBe(false);
    expect(ltm.get(a)).not.toBeNull();
  });

  it("resolve is a no-op when the losing entry is already gone", () => {
    const { a, b } = seedPair("Rule three", "Rule four");
    ltm.remove(b);
    expect(resolveContradiction(a, b)).toBe(false);
    expect(ltm.get(a)).not.toBeNull();
  });

  it("resolve is a no-op if another reviewer already dismissed the pair", () => {
    const { a, b } = seedPair("Concurrent rule A", "Concurrent rule B");
    ltm.setContradictionStatus(a, b, "dismissed");

    expect(resolveContradiction(a, b)).toBe(false);
    expect(ltm.getByLogical(a)).not.toBeNull();
    expect(ltm.getByLogical(b)).not.toBeNull();
    expect(ltm.listOpenContradictions()).toHaveLength(0);
  });

  it("resolve accepts superseded version ids for either side", () => {
    const { a, b } = seedPair("Rule five", "Rule six");
    const staleA = staleVersionId(a);
    const staleB = staleVersionId(b);

    expect(resolveContradiction(staleA, staleB)).toBe(true);

    expect(ltm.getByLogical(b)).toBeNull();
    expect(ltm.isTombstoned(b)).toBe(true);
    expect(ltm.getByLogical(a)).not.toBeNull();
    expect(ltm.listOpenContradictions()).toHaveLength(0);
  });

  it("resolve is a no-op when both ids are versions of the same entry", () => {
    const { a, b } = seedPair("Rule seven", "Rule eight");
    const staleA = staleVersionId(a);
    const currentA = ltm.getByLogical(a);
    if (!currentA) throw new Error("entry a vanished");
    expect(currentA.id).not.toBe(staleA);

    expect(resolveContradiction(staleA, currentA.id)).toBe(false);
    expect(ltm.getByLogical(a)).not.toBeNull();
    expect(ltm.getByLogical(b)).not.toBeNull();
    expect(ltm.listOpenContradictions()).toHaveLength(1);
  });

  it("dismiss accepts superseded version ids and refuses a second decision", () => {
    const { a, b } = seedPair("Rule nine", "Rule ten");
    const staleB = staleVersionId(b);

    expect(dismissContradiction(a, staleB)).toBe(true);
    expect(dismissContradiction(a, staleB)).toBe(false);

    expect(ltm.listOpenContradictions()).toHaveLength(0);
    expect(ltm.getByLogical(a)).not.toBeNull();
    expect(ltm.getByLogical(b)).not.toBeNull();
    expect(ltm.contradictionExists(a, b)).toBe(true);
  });
});

describe("knowledge dedup decisions (#462)", () => {
  it("accept removes the source, keeps the survivor, and records accept feedback", () => {
    const surviving = createEntry("Use pnpm");
    const source = createEntry("Use pnpm for installs");

    expect(
      acceptKnowledgeDuplicate(surviving, source, { similarity: 0.93 }),
    ).toBe(true);

    expect(ltm.get(source)).toBeNull();
    expect(ltm.get(surviving)).not.toBeNull();
    const rows = feedbackRows("knowledge");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      entry_a_title: "Use pnpm for installs",
      entry_b_title: "Use pnpm",
      accepted: 1,
      similarity: 0.93,
      source: "dashboard",
    });
  });

  it("accept skips feedback for a title-overlap-only match (similarity 0)", () => {
    const surviving = createEntry("Alpha");
    const source = createEntry("Alpha copy");
    expect(acceptKnowledgeDuplicate(surviving, source, { similarity: 0 })).toBe(
      true,
    );
    expect(ltm.get(source)).toBeNull();
    expect(feedbackRows("knowledge")).toHaveLength(0);
  });

  it("accept refuses unknown ids and the same id on both sides", () => {
    const only = createEntry("Only one");
    expect(acceptKnowledgeDuplicate(only, only, { similarity: 0.9 })).toBe(
      false,
    );
    expect(acceptKnowledgeDuplicate(only, "missing", { similarity: 0.9 })).toBe(
      false,
    );
    expect(ltm.get(only)).not.toBeNull();
  });

  it("reject keeps both entries and records reject feedback", () => {
    const surviving = createEntry("Keep A");
    const source = createEntry("Keep B");
    expect(
      rejectKnowledgeDuplicate(surviving, source, { similarity: 0.88 }),
    ).toBe(true);
    expect(ltm.get(source)).not.toBeNull();
    expect(ltm.get(surviving)).not.toBeNull();
    expect(feedbackRows("knowledge")[0]).toMatchObject({
      entry_a_title: "Keep B",
      entry_b_title: "Keep A",
      accepted: 0,
    });
  });

  it("reject records nothing without usable titles or a finite similarity", () => {
    const surviving = createEntry("Lonely");
    expect(
      rejectKnowledgeDuplicate(surviving, "missing", { similarity: 0.5 }),
    ).toBe(false);
    expect(
      rejectKnowledgeDuplicate(surviving, surviving, {
        similarity: Number.NaN,
      }),
    ).toBe(false);
    expect(feedbackRows("knowledge")).toHaveLength(0);
  });
});

describe("entity dedup decisions (#462)", () => {
  it("accept merges same-type entities and records accept feedback", () => {
    const target = entities.create({
      projectPath: PROJECT,
      entityType: "tool",
      canonicalName: "Vitest",
    }).id;
    const source = entities.create({
      projectPath: PROJECT,
      entityType: "tool",
      canonicalName: "vitest runner",
    }).id;

    expect(acceptEntityDuplicate(target, source, { similarity: 0.91 })).toBe(
      true,
    );

    expect(entities.get(source)).toBeNull();
    expect(entities.get(target)).not.toBeNull();
    expect(feedbackRows("entity")[0]).toMatchObject({
      entry_a_title: "vitest runner",
      entry_b_title: "Vitest",
      accepted: 1,
      source: "dashboard",
    });
  });

  it("accept refuses incompatible entity types", () => {
    const target = entities.create({
      projectPath: PROJECT,
      entityType: "tool",
      canonicalName: "Rust",
    }).id;
    const source = entities.create({
      projectPath: PROJECT,
      entityType: "person",
      canonicalName: "Rusty",
    }).id;
    expect(acceptEntityDuplicate(target, source, { similarity: 0.9 })).toBe(
      false,
    );
    expect(entities.get(source)).not.toBeNull();
    expect(feedbackRows("entity")).toHaveLength(0);
  });

  it("reject keeps both entities and records reject feedback", () => {
    const a = entities.create({
      projectPath: PROJECT,
      entityType: "repo",
      canonicalName: "lore",
    }).id;
    const b = entities.create({
      projectPath: PROJECT,
      entityType: "repo",
      canonicalName: "loreai",
    }).id;
    expect(rejectEntityDuplicate(a, b, { similarity: 0.8 })).toBe(true);
    expect(rejectEntityDuplicate(a, "missing", { similarity: 0.8 })).toBe(
      false,
    );
    expect(entities.get(a)).not.toBeNull();
    expect(entities.get(b)).not.toBeNull();
    expect(feedbackRows("entity")).toHaveLength(1);
  });
});
