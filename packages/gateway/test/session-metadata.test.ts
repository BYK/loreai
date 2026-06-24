import { describe, expect, test } from "vitest";
import { buildSessionMetadata } from "../src/session-metadata";

describe("buildSessionMetadata (#627 Phase 1)", () => {
  test("returns undefined for undefined gitHead", () => {
    expect(buildSessionMetadata(undefined)).toBeUndefined();
  });

  test("returns { gitHead } for a valid SHA", () => {
    expect(buildSessionMetadata("abc1234deadbeef")).toEqual({
      gitHead: "abc1234deadbeef",
    });
  });

  test("never returns null (callers may spread unconditionally)", () => {
    // The whole point of this helper: callers do `metadata: buildSessionMetadata(state.gitHead)`
    // and the resulting object must be safely spreadable / passable to ltm.create.
    // A `null` would break every caller; an `undefined` is fine (optional field).
    const result = buildSessionMetadata(undefined);
    expect(result).toBeUndefined();
    expect(result ?? { gitHead: "fallback" }).toEqual({ gitHead: "fallback" });
  });
});
