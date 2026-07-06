import { describe, expect, test } from "vitest";
import { factPresent, normalizeForMatch, scoreRetrieval } from "./recall-score";

describe("normalizeForMatch", () => {
  test("lowercases, collapses whitespace, and trims", () => {
    expect(normalizeForMatch("  The\tQuick   Brown\nFox ")).toBe(
      "the quick brown fox",
    );
  });
});

describe("factPresent", () => {
  const norm = normalizeForMatch("The migration bumps schema_version to 55.");
  test("matches case-insensitively and whitespace-insensitively", () => {
    expect(factPresent(norm, "SCHEMA_VERSION   to 55")).toBe(true);
  });
  test("does not match an absent fact", () => {
    expect(factPresent(norm, "version 54")).toBe(false);
  });
  test("an empty fact never matches", () => {
    expect(factPresent(norm, "   ")).toBe(false);
  });
});

describe("scoreRetrieval — anchors gating", () => {
  test("returns undefined when no anchors are declared", () => {
    expect(scoreRetrieval("anything", {})).toBeUndefined();
    expect(
      scoreRetrieval("anything", { expectedFacts: [], forbiddenFacts: [] }),
    ).toBeUndefined();
  });

  test("blank anchors are ignored (treated as no anchors)", () => {
    expect(
      scoreRetrieval("x", { expectedFacts: ["  "], forbiddenFacts: [""] }),
    ).toBeUndefined();
  });
});

describe("scoreRetrieval — expected facts (positive recall)", () => {
  test("full recall passes with factRecall = 1", () => {
    const s = scoreRetrieval(
      "We chose event-sourcing with CQRS for the ledger.",
      { expectedFacts: ["event-sourcing", "CQRS"] },
    );
    expect(s).toBeDefined();
    expect(s?.factRecall).toBe(1);
    expect(s?.matchedFacts).toEqual(["event-sourcing", "CQRS"]);
    expect(s?.missedFacts).toEqual([]);
    expect(s?.pass).toBe(true);
  });

  test("partial recall reports the fraction and fails the strict pass", () => {
    const s = scoreRetrieval("We chose event-sourcing.", {
      expectedFacts: ["event-sourcing", "CQRS"],
    });
    expect(s?.factRecall).toBe(0.5);
    expect(s?.missedFacts).toEqual(["CQRS"]);
    expect(s?.pass).toBe(false);
  });

  test("a fluent but fact-free answer scores zero recall (justifier-resistant)", () => {
    // The kind of padded answer a lenient LLM judge might over-reward.
    const s = scoreRetrieval(
      "Great question! There were several important architectural considerations discussed at length.",
      { expectedFacts: ["event-sourcing", "CQRS"] },
    );
    expect(s?.factRecall).toBe(0);
    expect(s?.pass).toBe(false);
  });
});

describe("scoreRetrieval — forbidden facts (negative controls)", () => {
  test("a pure negative control passes when nothing stale surfaced", () => {
    const s = scoreRetrieval("The timeout is now 30 seconds.", {
      forbiddenFacts: ["10 seconds"],
    });
    expect(s?.factRecall).toBeNull();
    expect(s?.expectedCount).toBe(0);
    expect(s?.leakedStaleFacts).toEqual([]);
    expect(s?.pass).toBe(true);
  });

  test("leaking a stale/superseded fact fails the pass", () => {
    const s = scoreRetrieval("The timeout is 10 seconds.", {
      forbiddenFacts: ["10 seconds"],
    });
    expect(s?.leakedStaleFacts).toEqual(["10 seconds"]);
    expect(s?.pass).toBe(false);
  });

  test("a short/numeric forbidden anchor does not match inside a larger token", () => {
    // "10 seconds" must NOT match inside "110 seconds" — a false leak would
    // spuriously fail a correct answer (adversarial review finding #2).
    const s = scoreRetrieval("The retry backoff is now 110 seconds.", {
      forbiddenFacts: ["10 seconds"],
    });
    expect(s?.leakedStaleFacts).toEqual([]);
    expect(s?.pass).toBe(true);
  });

  test("underscore counts as a word char (regex \\w semantics)", () => {
    // forbidden "10" must NOT match inside "schema_10_version".
    const s = scoreRetrieval("bumped to schema_10_version today.", {
      forbiddenFacts: ["10"],
    });
    expect(s?.leakedStaleFacts).toEqual([]);
    expect(s?.pass).toBe(true);
  });

  test("word-boundary matching still matches at punctuation edges", () => {
    const s = scoreRetrieval("We chose event-sourcing with CQRS.", {
      expectedFacts: ["event-sourcing", "CQRS"],
    });
    expect(s?.factRecall).toBe(1);
    expect(s?.pass).toBe(true);
  });

  test("expected present but a forbidden fact also leaked → fail", () => {
    const s = scoreRetrieval(
      "The value was 5 seconds, previously it was 10 seconds.",
      { expectedFacts: ["5 seconds"], forbiddenFacts: ["10 seconds"] },
    );
    expect(s?.factRecall).toBe(1);
    expect(s?.matchedFacts).toEqual(["5 seconds"]);
    expect(s?.leakedStaleFacts).toEqual(["10 seconds"]);
    expect(s?.pass).toBe(false);
  });
});
