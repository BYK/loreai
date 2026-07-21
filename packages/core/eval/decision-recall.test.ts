import { describe, expect, test } from "vitest";
import { scoreRetrieval } from "./recall-score";
import { scenarios } from "./scenarios/decision-recall";

const scenario = scenarios[0];
const byId = new Map(scenario.questions.map((q) => [q.id, q]));

describe("DEC-1 decision-recall scenario (#1403)", () => {
  test("registers one scenario with 3 evolving sessions and the no-memory control arm", () => {
    expect(scenario.id).toBe("dec-1-decision-evolution");
    expect(scenario.sessions).toHaveLength(3);
    expect(scenario.applicableBaselines).toContain("no-memory");
    expect(scenario.applicableBaselines).toContain("lore");
  });

  test("every question carries deterministic anchors (expected or forbidden facts)", () => {
    for (const q of scenario.questions) {
      const hasAnchors =
        (q.expectedFacts?.length ?? 0) > 0 ||
        (q.forbiddenFacts?.length ?? 0) > 0;
      expect(hasAnchors).toBe(true);
    }
  });

  test("at least two questions are strict negative controls (forbid a superseded value)", () => {
    const negControls = scenario.questions.filter(
      (q) => (q.forbiddenFacts?.length ?? 0) > 0,
    );
    expect(negControls.length).toBeGreaterThanOrEqual(2);
  });

  // --- Prove the negative-control scoring actually bites (deterministic) ---

  test("datastore negctl: SQLite-only answer PASSES; a Postgres leak FAILS", () => {
    const q = byId.get("dec1-q2-datastore-negctl")!;
    const anchors = {
      expectedFacts: q.expectedFacts,
      forbiddenFacts: q.forbiddenFacts,
    };
    const clean = scoreRetrieval("SQLite.", anchors)!;
    expect(clean.pass).toBe(true);
    expect(clean.leakedStaleFacts).toEqual([]);

    const stale = scoreRetrieval("The datastore is PostgreSQL.", anchors)!;
    // Even though it never says SQLite (miss) AND it leaks Postgres — must fail.
    expect(stale.pass).toBe(false);
    expect(stale.leakedStaleFacts).toContain("PostgreSQL");

    // A subtler failure: mentions the current value but ALSO resurfaces stale.
    const mixed = scoreRetrieval("It's SQLite now (was PostgreSQL).", anchors)!;
    expect(mixed.pass).toBe(false);
    expect(mixed.matchedFacts).toContain("SQLite");
    expect(mixed.leakedStaleFacts).toContain("PostgreSQL");
  });

  test("ttl negctl: '300' passes and does NOT spuriously match the forbidden '30' (word boundary)", () => {
    const q = byId.get("dec1-q4-ttl-value-negctl")!;
    const anchors = {
      expectedFacts: q.expectedFacts, // ["300"]
      forbiddenFacts: q.forbiddenFacts, // ["30"]
    };
    const clean = scoreRetrieval("300", anchors)!;
    // Critical: "300" must NOT trigger the "30" forbidden fact (word-boundary).
    expect(clean.leakedStaleFacts).toEqual([]);
    expect(clean.matchedFacts).toContain("300");
    expect(clean.pass).toBe(true);

    // The stale standalone value must fail.
    const stale = scoreRetrieval("30", anchors)!;
    expect(stale.leakedStaleFacts).toContain("30");
    expect(stale.pass).toBe(false);
  });

  test("decision-recall (why) questions do NOT forbid the historical value", () => {
    // q1/q3 explain the switch, so a correct answer legitimately mentions the
    // old value — these must have NO forbiddenFacts (else we'd penalize a
    // correct evolution narrative).
    expect(
      byId.get("dec1-q1-current-datastore")!.forbiddenFacts,
    ).toBeUndefined();
    expect(byId.get("dec1-q3-current-ttl")!.forbiddenFacts).toBeUndefined();
    // A full "why" answer that recounts history still PASSES its retrieval score.
    const q3 = byId.get("dec1-q3-current-ttl")!;
    const s = scoreRetrieval(
      "The TTL is now 5 minutes, raised from 30 seconds to stop a refetch stampede.",
      { expectedFacts: q3.expectedFacts, forbiddenFacts: q3.forbiddenFacts },
    )!;
    expect(s.pass).toBe(true);
  });
});
