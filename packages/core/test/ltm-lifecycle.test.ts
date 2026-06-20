import { describe, test, expect, beforeEach } from "vitest";
import { db } from "../src/db";
import * as ltm from "../src/ltm";

const PROJECT = "/test/ltm/lifecycle";
const OTHER = "/test/ltm/lifecycle-other";

function clearKnowledge() {
  db().query("DELETE FROM knowledge").run();
  db().query("UPDATE projects SET last_decay_at = NULL").run();
}

function reinforcedAt(id: string): number | null {
  // Resolve by logical_id: a content update() appends a new current version, so
  // the decay-clock reset lives on the current version, not the original row id.
  return ltm.getByLogical(id)?.last_reinforced_at ?? null;
}

describe("ltm reinforcement", () => {
  beforeEach(clearKnowledge);

  test("create() stamps last_reinforced_at", () => {
    const id = ltm.create({
      projectPath: PROJECT,
      category: "gotcha",
      title: "Fresh",
      content: "x",
      scope: "project",
    });
    expect(reinforcedAt(id)).toBeGreaterThan(0);
  });

  test("markInjected resets the decay clock WITHOUT changing confidence", () => {
    const id = ltm.create({
      projectPath: PROJECT,
      category: "gotcha",
      title: "Injected",
      content: "x",
      scope: "project",
    });
    // Backdate the clock so we can observe a forward move.
    db()
      .query("UPDATE knowledge SET last_reinforced_at = 1000 WHERE id = ?")
      .run(id);
    const beforeConf = ltm.get(id)?.confidence;

    ltm.markInjected([id]);

    expect(reinforcedAt(id)).toBeGreaterThan(1000);
    expect(ltm.get(id)?.confidence).toBe(beforeConf); // unchanged
  });

  test("markInjected is a no-op for an empty id list", () => {
    expect(() => ltm.markInjected([])).not.toThrow();
  });

  test("update() resets the decay clock (any edit is a re-confirmation)", () => {
    const id = ltm.create({
      projectPath: PROJECT,
      category: "gotcha",
      title: "Edited",
      content: "x",
      scope: "project",
    });
    db()
      .query("UPDATE knowledge SET last_reinforced_at = 1000 WHERE id = ?")
      .run(id);
    ltm.update(id, { content: "y" });
    expect(reinforcedAt(id)).toBeGreaterThan(1000);
  });

  test("reinforce boosts confidence (clamped) and resets the clock", () => {
    const id = ltm.create({
      projectPath: PROJECT,
      category: "gotcha",
      title: "Boosted",
      content: "x",
      scope: "project",
      confidence: 0.5,
    });
    db()
      .query("UPDATE knowledge SET last_reinforced_at = 1000 WHERE id = ?")
      .run(id);
    ltm.reinforce(id, 0.2);
    expect(ltm.get(id)?.confidence).toBeCloseTo(0.7, 5);
    expect(reinforcedAt(id)).toBeGreaterThan(1000);

    ltm.reinforce(id, 1.0); // clamps at 1.0
    expect(ltm.get(id)?.confidence).toBe(1.0);

    ltm.reinforce(id, -2.0); // clamps at 0.0
    expect(ltm.get(id)?.confidence).toBe(0.0);
  });
});

describe("ltm.decayProject", () => {
  beforeEach(clearKnowledge);

  test("decays only entries unreinforced past the grace window", () => {
    const base = Date.now();
    const stale = ltm.create({
      projectPath: PROJECT,
      category: "gotcha",
      title: "Stale",
      content: "x",
      scope: "project",
    });
    const fresh = ltm.create({
      projectPath: PROJECT,
      category: "gotcha",
      title: "Fresh",
      content: "y",
      scope: "project",
    });
    // Run decay far enough in the future that BOTH are past grace, then re-mark
    // `fresh` as reinforced just before the run so only `stale` decays.
    const decayNow = base + ltm.DECAY_GRACE_MS + 60_000;
    db()
      .query("UPDATE knowledge SET last_reinforced_at = ? WHERE id = ?")
      .run(decayNow - 1000, fresh); // reinforced after the cutoff

    const decayed = ltm.decayProject(PROJECT, decayNow);

    expect(decayed).toBe(1);
    expect(ltm.get(stale)?.confidence).toBeCloseTo(1.0 - ltm.DECAY_STEP, 5);
    expect(ltm.get(fresh)?.confidence).toBe(1.0);
  });

  test("is interval-gated: a second run within the interval is a no-op", () => {
    const base = Date.now();
    ltm.create({
      projectPath: PROJECT,
      category: "gotcha",
      title: "Stale",
      content: "x",
      scope: "project",
    });
    const decayNow = base + ltm.DECAY_GRACE_MS + 60_000;
    expect(ltm.decayProject(PROJECT, decayNow)).toBe(1);
    // Same timestamp → within the interval since last_decay_at was just set.
    expect(ltm.decayProject(PROJECT, decayNow)).toBe(0);
    // Just under the interval → still gated.
    expect(
      ltm.decayProject(PROJECT, decayNow + ltm.DECAY_INTERVAL_MS - 1),
    ).toBe(0);
  });

  test("never decays another project's entries", () => {
    const base = Date.now();
    const other = ltm.create({
      projectPath: OTHER,
      category: "gotcha",
      title: "OtherStale",
      content: "x",
      scope: "project",
    });
    ltm.decayProject(PROJECT, base + ltm.DECAY_GRACE_MS + 60_000);
    expect(ltm.get(other)?.confidence).toBe(1.0);
  });

  test("does not count (or touch) already-dead entries below the floor (Seer #816 count accuracy)", () => {
    const base = Date.now();
    const live = ltm.create({
      projectPath: PROJECT,
      category: "gotcha",
      title: "Live stale",
      content: "x",
      scope: "project",
    });
    const dead = ltm.create({
      projectPath: PROJECT,
      category: "gotcha",
      title: "Dead stale",
      content: "y",
      scope: "project",
    });
    // dead is below the relevance floor; both are long-unreinforced.
    db().query("UPDATE knowledge SET confidence = 0.15 WHERE id = ?").run(dead);

    const decayed = ltm.decayProject(
      PROJECT,
      base + ltm.DECAY_GRACE_MS + 60_000,
    );

    // Only the live entry is decayed and counted; the dead one is left for
    // pruneDeadEntries and excluded from the count.
    expect(decayed).toBe(1);
    expect(ltm.get(live)?.confidence).toBeCloseTo(1.0 - ltm.DECAY_STEP, 5);
    expect(ltm.get(dead)?.confidence).toBe(0.15);
  });

  test("never decays a promoted cross-project entry that kept its origin project_id (Seer #816)", () => {
    const base = Date.now();
    const promoted = ltm.create({
      projectPath: PROJECT,
      category: "preference",
      title: "Promoted shared",
      content: "x",
      scope: "project",
    });
    // Promote in place (origin project_id retained) and backdate reinforcement.
    db()
      .query(
        "UPDATE knowledge SET cross_project = 1, last_reinforced_at = 1000 WHERE id = ?",
      )
      .run(promoted);
    ltm.decayProject(PROJECT, base + ltm.DECAY_GRACE_MS + 60_000);
    expect(ltm.get(promoted)?.confidence).toBe(1.0); // shared knowledge untouched
  });
});

describe("ltm.evictLowestValue", () => {
  beforeEach(clearKnowledge);

  test("evicts the lowest-confidence entries, tombstones them, returns the rows", () => {
    const high = ltm.create({
      projectPath: PROJECT,
      category: "gotcha",
      title: "High",
      content: "x",
      scope: "project",
      confidence: 0.9,
    });
    const low = ltm.create({
      projectPath: PROJECT,
      category: "gotcha",
      title: "Low",
      content: "y",
      scope: "project",
      confidence: 0.3,
    });
    const mid = ltm.create({
      projectPath: PROJECT,
      category: "gotcha",
      title: "Mid",
      content: "z",
      scope: "project",
      confidence: 0.6,
    });

    const evicted = ltm.evictLowestValue(PROJECT, 1);

    expect(evicted.map((e) => e.id)).toEqual([low]);
    expect(ltm.get(low)).toBeNull();
    expect(ltm.isTombstoned(low)).toBe(true);
    expect(ltm.get(high)).not.toBeNull();
    expect(ltm.get(mid)).not.toBeNull();
  });

  test("breaks ties by least-recently-reinforced", () => {
    const older = ltm.create({
      projectPath: PROJECT,
      category: "gotcha",
      title: "Older",
      content: "x",
      scope: "project",
      confidence: 0.5,
    });
    const newer = ltm.create({
      projectPath: PROJECT,
      category: "gotcha",
      title: "Newer",
      content: "y",
      scope: "project",
      confidence: 0.5,
    });
    db()
      .query("UPDATE knowledge SET last_reinforced_at = 1000 WHERE id = ?")
      .run(older);
    db()
      .query("UPDATE knowledge SET last_reinforced_at = 9000 WHERE id = ?")
      .run(newer);

    const evicted = ltm.evictLowestValue(PROJECT, 1);
    expect(evicted.map((e) => e.id)).toEqual([older]);
  });

  test("never evicts dead (<= floor) entries — they belong to pruneDeadEntries, and evicting them would not reduce the live count (Seer #816)", () => {
    const dead = ltm.create({
      projectPath: PROJECT,
      category: "gotcha",
      title: "Dead",
      content: "x",
      scope: "project",
    });
    ltm.update(dead, { confidence: 0.1 }); // below the 0.2 relevance floor
    const liveLow = ltm.create({
      projectPath: PROJECT,
      category: "gotcha",
      title: "LiveLow",
      content: "y",
      scope: "project",
      confidence: 0.5,
    });

    // enforceEntryCap counts only live entries, so a request to evict 1 must
    // remove the lowest LIVE entry — not the cheaper dead one.
    const evicted = ltm.evictLowestValue(PROJECT, 1);
    expect(evicted.map((e) => e.id)).toEqual([liveLow]);
    expect(ltm.get(dead)).not.toBeNull(); // dead entry untouched
  });

  test("count <= 0 is a no-op; never evicts global or promoted cross-project entries", () => {
    const g = ltm.create({
      category: "preference",
      title: "Global",
      content: "x",
      scope: "global",
      crossProject: true,
      confidence: 0.1,
    });
    // Promoted-in-place: cross_project = 1 while keeping this project's id.
    const promoted = ltm.create({
      projectPath: PROJECT,
      category: "preference",
      title: "Promoted shared",
      content: "p",
      scope: "project",
      confidence: 0.25,
    });
    db()
      .query("UPDATE knowledge SET cross_project = 1 WHERE id = ?")
      .run(promoted);
    ltm.create({
      projectPath: PROJECT,
      category: "gotcha",
      title: "Proj",
      content: "y",
      scope: "project",
      confidence: 0.9,
    });
    expect(ltm.evictLowestValue(PROJECT, 0)).toHaveLength(0);
    // Both the global and the promoted entry are lower confidence than "Proj",
    // yet neither is ever a victim — shared knowledge is protected (Seer #816).
    const evicted = ltm.evictLowestValue(PROJECT, 5);
    expect(evicted.some((e) => e.id === g)).toBe(false);
    expect(evicted.some((e) => e.id === promoted)).toBe(false);
    expect(ltm.get(g)).not.toBeNull();
    expect(ltm.get(promoted)).not.toBeNull();
  });
});

describe("preference reinforcement on injection (forSession fast path)", () => {
  beforeEach(clearKnowledge);

  test("injecting a project-scoped preference resets its decay clock so decay does not delete it while in use", async () => {
    const id = ltm.create({
      projectPath: PROJECT,
      category: "preference",
      title: "Always run the linter before committing",
      content: "Run the linter before every commit.",
      scope: "project",
    });
    // Simulate a long-unreinforced entry that WOULD decay on the next pass.
    db()
      .query("UPDATE knowledge SET last_reinforced_at = 1000 WHERE id = ?")
      .run(id);

    // The preference-only fast path is the ONLY injection path for preferences
    // (context blocks pass excludeCategories: ["preference"]).
    const injected = await ltm.forSession(PROJECT, "sess-pref", 10_000, {
      categories: ["preference"],
    });
    expect(injected.some((e) => e.id === id)).toBe(true);

    // Injection moved the decay clock forward without touching confidence.
    const after = ltm.get(id);
    expect(after?.last_reinforced_at ?? 0).toBeGreaterThan(1000);
    expect(after?.confidence).toBe(1.0);

    // A decay pass within the grace window of the injection leaves it untouched —
    // an actively-injected preference is never aged out. (Adversarial-review fix.)
    const decayNow =
      (after?.last_reinforced_at as number) + ltm.DECAY_GRACE_MS - 1000;
    ltm.decayProject(PROJECT, decayNow);
    expect(ltm.get(id)?.confidence).toBe(1.0);
    expect(ltm.get(id)).not.toBeNull();
  });
});
