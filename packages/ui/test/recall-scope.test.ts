import { describe, expect, it } from "vitest";
import { parseRecallScope, RECALL_SCOPES } from "~/contracts";

describe("recall URL scope", () => {
  it.each(RECALL_SCOPES)("preserves the supported raw value %s", (scope) => {
    expect(parseRecallScope(scope)).toBe(scope);
  });

  it.each([
    undefined,
    null,
    "",
    "bogus",
    "__proto__",
    "constructor",
    "toString",
    "ALL",
    "knowledge ",
    ["session"],
    { scope: "knowledge" },
    0,
    false,
  ])("defaults unsupported input %j to all", (scope) => {
    expect(parseRecallScope(scope)).toBe("all");
  });
});
