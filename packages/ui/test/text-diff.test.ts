import { describe, expect, it, vi } from "vitest";
import fc from "fast-check";

import { diffText } from "~/lib/text-diff";

function diffWithFixedClock(before: string, after: string) {
  // Reconstruction properties exercise the real diff independently of CPU
  // scheduling. Advancing-clock controls below verify the production deadline.
  const clock = vi.spyOn(Date, "now").mockReturnValue(0);
  try {
    return diffText(before, after);
  } finally {
    clock.mockRestore();
  }
}

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

  it("preserves the input-size boundary and unchanged-text fast path", () => {
    expect(diffText("a".repeat(10_000), "b".repeat(10_000))).not.toBeNull();
    expect(diffText("a".repeat(10_000), "b".repeat(10_001))).toBeNull();
    const unchanged = "a".repeat(20_001);
    expect(diffText(unchanged, unchanged)).toEqual([
      { kind: "equal", text: unchanged },
    ]);
  });

  it("preserves the token-pair budget boundary", () => {
    expect(diffText("!".repeat(499), "!".repeat(498) + "?")).not.toBeNull();
    expect(diffText("!".repeat(499), "!".repeat(500))).toBeNull();
  });

  it("falls back when the edit budget is exceeded", () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(0);
    try {
      expect(diffText("", "!".repeat(1000))).toEqual([
        { kind: "added", text: "!".repeat(1000) },
      ]);
      expect(diffText("", "!".repeat(1001))).toBeNull();
    } finally {
      clock.mockRestore();
    }
  });

  it.each([
    ["old", "new"],
    ["\t", "_🧑🏽‍💻<"],
  ])("falls back when the time budget expires (%j → %j)", (before, after) => {
    const clock = vi
      .spyOn(Date, "now")
      .mockReturnValueOnce(0)
      .mockReturnValue(26);
    try {
      expect(diffText(before, after)).toBeNull();
    } finally {
      clock.mockRestore();
    }
  });

  it("reconstructs both originals across arbitrary edits", () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 80 }),
        fc.string({ maxLength: 80 }),
        (before, after) => {
          const changes = diffWithFixedClock(before, after)!;
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

  it("preserves Unicode tokens and whitespace across arbitrary edits", () => {
    const text = fc
      .array(
        fc.constantFrom(
          "猫",
          "犬",
          "é",
          "e\u0301",
          "Привет",
          "🧑🏽‍💻",
          " ",
          "\r\n",
          "\t",
          "<",
          "_",
        ),
        { maxLength: 30 },
      )
      .map((parts) => parts.join(""));
    fc.assert(
      fc.property(text, text, (before, after) => {
        const changes = diffWithFixedClock(before, after)!;
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
      }),
      { numRuns: 200, examples: [["\t", "_🧑🏽‍💻<"]] },
    );
  });
});
