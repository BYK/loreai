import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { diffText } from "~/lib/text-diff";

describe("diffText", () => {
  it("marks replacements without losing whitespace or punctuation", () => {
    expect(
      diffText("Use SQLite.\nKeep WAL.", "Use Postgres.\nKeep WAL."),
    ).toEqual([
      { kind: "equal", text: "Use " },
      { kind: "removed", text: "SQLite" },
      { kind: "added", text: "Postgres" },
      { kind: "equal", text: ".\nKeep WAL." },
    ]);
  });

  it.each([
    ["", "hello", [{ kind: "added", text: "hello" }]],
    ["hello", "", [{ kind: "removed", text: "hello" }]],
    ["same", "same", [{ kind: "equal", text: "same" }]],
    ["", "", []],
  ])("handles %j → %j", (before, after, expected) => {
    expect(diffText(before, after)).toEqual(expected);
  });

  it("preserves Unicode, markup, and repeated words as inert strings", () => {
    const before = "café 🐈 <script>old</script> café";
    const after = "café 🐕 <script>new</script> café";
    const parts = diffText(before, after)!;
    expect(
      parts
        .filter((p) => p.kind !== "added")
        .map((p) => p.text)
        .join(""),
    ).toBe(before);
    expect(
      parts
        .filter((p) => p.kind !== "removed")
        .map((p) => p.text)
        .join(""),
    ).toBe(after);
    expect(
      parts.some((p) => p.kind === "removed" && p.text.includes("old")),
    ).toBe(true);
    expect(
      parts.some((p) => p.kind === "added" && p.text.includes("new")),
    ).toBe(true);
  });

  it("declines oversized comparisons instead of blocking the reader", () => {
    expect(diffText("old ".repeat(1000), "new ".repeat(1000))).toBeNull();
  });

  it("reconstructs both originals across arbitrary edits", () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 80 }),
        fc.string({ maxLength: 80 }),
        (before, after) => {
          const changes = diffText(before, after)!;
          expect(
            changes
              .filter((part) => part.kind !== "added")
              .map((part) => part.text)
              .join(""),
          ).toBe(before);
          expect(
            changes
              .filter((part) => part.kind !== "removed")
              .map((part) => part.text)
              .join(""),
          ).toBe(after);
        },
      ),
      { numRuns: 200 },
    );
  });
});
