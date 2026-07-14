/**
 * Unit tests for the reorder-tolerant LTM diff-pin (system[2] cache stability).
 *
 * The pin reuses its rendered text verbatim whenever the *selected entry set*
 * is unchanged (same entry IDs, any order, same per-entry content), and re-pins
 * only when the set changes or an entry's content changes. This eliminates the
 * cache busts that the old positional `textDiffRatio` metric produced on pure
 * re-ranking. See packages/gateway/src/pipeline.ts.
 */
import { describe, test, expect } from "vitest";
import {
  entryKeyIds,
  fnv1a,
  ltmEntryKeys,
  sameEntryKeys,
  sameIdSet,
  shouldReanchorPinKeys,
  surfaceSignature,
} from "../src/pipeline";

type Entry = { id: string; title: string; content: string };

const A: Entry = { id: "a", title: "Alpha", content: "first" };
const B: Entry = { id: "b", title: "Bravo", content: "second" };
const C: Entry = { id: "c", title: "Charlie", content: "third" };

/**
 * Mirror the pin decision made in pipeline.ts step-6: given the previously
 * pinned key set and the freshly computed entries, decide whether the pin is
 * reused (no bust) or re-pinned (bust).
 */
function decide(
  pinnedKeys: string[] | undefined,
  entries: Entry[],
  renderedIds?: string[],
): { rePin: boolean; keys: string[] } {
  const keys = ltmEntryKeys(entries, renderedIds);
  const setUnchanged = sameEntryKeys(pinnedKeys, keys);
  return { rePin: !(pinnedKeys && setUnchanged), keys };
}

describe("fnv1a", () => {
  test("is deterministic and content-sensitive", () => {
    expect(fnv1a("hello")).toBe(fnv1a("hello"));
    expect(fnv1a("hello")).not.toBe(fnv1a("world"));
  });
});

describe("ltmEntryKeys", () => {
  test("is order-independent (canonical sorted output)", () => {
    expect(ltmEntryKeys([A, B, C])).toEqual(ltmEntryKeys([C, A, B]));
  });

  test("changes when an entry's content changes", () => {
    const before = ltmEntryKeys([A, B]);
    const after = ltmEntryKeys([{ ...A, content: "edited" }, B]);
    expect(before).not.toEqual(after);
  });

  test("changes when the selected set changes", () => {
    expect(ltmEntryKeys([A, B])).not.toEqual(ltmEntryKeys([A, B, C]));
  });

  test("restricts keys to rendered ids when provided", () => {
    // B was dropped by budget packing — only a and c rendered.
    expect(ltmEntryKeys([A, B, C], ["a", "c"])).toEqual(ltmEntryKeys([A, C]));
  });
});

describe("entryKeyIds", () => {
  test("extracts the id portion from entry keys (sticky-set hint)", () => {
    const keys = ltmEntryKeys([A, B, C]); // "<id>:<hash>" sorted
    expect(entryKeyIds(keys)).toEqual(new Set(["a", "b", "c"]));
  });

  test("returns empty set for undefined", () => {
    expect(entryKeyIds(undefined)).toEqual(new Set());
  });

  test("handles ids containing no colon defensively", () => {
    expect(entryKeyIds(["plainid"])).toEqual(new Set(["plainid"]));
  });

  test("uses last colon so UUID-with-colon ids survive (hash is last segment)", () => {
    expect(entryKeyIds(["a:b:c:deadbeef"])).toEqual(new Set(["a:b:c"]));
  });
});

describe("reorder-tolerant pin decision", () => {
  test("same entry set in a different order → pin reused (no re-pin)", () => {
    const first = decide(undefined, [A, B, C]); // first injection always pins
    expect(first.rePin).toBe(true);

    const reordered = decide(first.keys, [C, B, A]);
    expect(reordered.rePin).toBe(false);
  });

  test("one entry's content changed → re-pin", () => {
    const first = decide(undefined, [A, B, C]);
    const edited = decide(first.keys, [
      A,
      { ...B, content: "curator updated this" },
      C,
    ]);
    expect(edited.rePin).toBe(true);
  });

  test("selected set changes (entry added) → re-pin", () => {
    const first = decide(undefined, [A, B]);
    const grown = decide(first.keys, [A, B, C]);
    expect(grown.rePin).toBe(true);
  });

  test("selected set changes (entry removed) → re-pin", () => {
    const first = decide(undefined, [A, B, C]);
    const shrunk = decide(first.keys, [A, B]);
    expect(shrunk.rePin).toBe(true);
  });

  test("legacy pin with unknown keys → re-pin once", () => {
    // A restored pin without entryKeys is treated as unknown set.
    const decision = decide(undefined, [A, B]);
    expect(decision.rePin).toBe(true);
  });

  test("reorder that drops the same entry by budget → still reused", () => {
    // Turn 1: a,b,c selected but only a,c fit the budget.
    const first = decide(undefined, [A, B, C], ["a", "c"]);
    // Turn 2: re-ranked to c,a,b but again only a,c fit — same rendered set.
    const next = decide(first.keys, [C, A, B], ["a", "c"]);
    expect(next.rePin).toBe(false);
  });

  test("cosmetic reword → same key → pin reused (materiality gate)", () => {
    const first = decide(undefined, [A, B]);
    // Curator rewrites B with whitespace/punctuation/case-only differences.
    const reworded = decide(first.keys, [
      A,
      { ...B, content: "  SECOND.  " }, // was "second"
    ]);
    expect(reworded.rePin).toBe(false);
  });
});

describe("sameIdSet", () => {
  test("true when both sets contain the same ids", () => {
    expect(sameIdSet(new Set(["a", "b"]), new Set(["b", "a"]))).toBe(true);
  });
  test("false when sizes differ", () => {
    expect(sameIdSet(new Set(["a"]), new Set(["a", "b"]))).toBe(false);
  });
  test("false when an id differs", () => {
    expect(sameIdSet(new Set(["a", "b"]), new Set(["a", "c"]))).toBe(false);
  });
});

// Key-format migration (#1320 Seer HIGH): a pin persisted before the
// surfaceSignature change stores keys as `id:fnv1a(title\x1f content)`. The
// migration guard must recognize such a pin as the SAME selection (same id set
// + byte-identical rendered text) so it re-anchors to the new-format keys with
// zero cache bust, instead of treating every entry as "changed".
describe("shouldReanchorPinKeys — surfaceSignature key-format migration", () => {
  const legacyKey = (e: Entry) =>
    `${e.id}:${fnv1a(`${e.title}\x1f${e.content}`)}`;
  const legacy = [legacyKey(A), legacyKey(B)].sort();
  const current = ltmEntryKeys([A, B]);
  const rendered = "system[2] rendered bytes for A + B";

  test("legacy and new keys differ but share the same id set", () => {
    expect(sameEntryKeys(legacy, current)).toBe(false);
    expect(sameIdSet(entryKeyIds(legacy), entryKeyIds(current))).toBe(true);
  });

  test("re-anchors when id set matches AND rendered text is byte-identical", () => {
    expect(shouldReanchorPinKeys(legacy, current, rendered, rendered)).toBe(
      true,
    );
  });

  test("does NOT re-anchor when the rendered text differs (real content edit)", () => {
    expect(
      shouldReanchorPinKeys(legacy, current, rendered, `${rendered} EDITED`),
    ).toBe(false);
  });

  test("does NOT re-anchor when the id set changed", () => {
    const grownCurrent = ltmEntryKeys([A, B, C]);
    expect(
      shouldReanchorPinKeys(legacy, grownCurrent, rendered, rendered),
    ).toBe(false);
  });

  test("does NOT re-anchor when keys are already identical (no migration needed)", () => {
    expect(shouldReanchorPinKeys(current, current, rendered, rendered)).toBe(
      false,
    );
  });

  test("new signature is stable across a cosmetic reword (no legacy re-bust)", () => {
    expect(surfaceSignature("Bravo", "second")).toBe(
      surfaceSignature("Bravo", "  Second.  "),
    );
  });
});
