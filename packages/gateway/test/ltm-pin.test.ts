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
});
