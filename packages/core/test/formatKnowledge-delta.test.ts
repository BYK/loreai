import { describe, test, expect } from "vitest";
import {
  formatKnowledgeDelta,
  shortId,
  DELTA_MAX_ENTRIES,
  DELTA_TOKEN_BUDGET,
} from "../src/prompt";

describe("formatKnowledgeDelta", () => {
  // Test that empty input produces empty string
  test("returns empty string for empty input", () => {
    const result = formatKnowledgeDelta([]);
    expect(result).toBe("");
  });

  // Test that delta includes header, entries, and epilogue
  test("includes header, entries, and epilogue for non-empty input", () => {
    const entries = [
      {
        op: "new" as const,
        id: "019eb1c4",
        category: "Preference",
        title: "Use tabs not spaces",
        content: "tabs are 2 spaces wide",
      },
      {
        op: "changed" as const,
        id: "019e187a",
        category: "Gotcha",
        title: "Prefer const over let",
        content: "Always use const unless reassignment is required.",
      },
      {
        op: "removed" as const,
        id: "019e1842",
        category: "Style",
        title: "Always use semicolons",
        content: "",
      },
    ];
    const result = formatKnowledgeDelta(entries);

    expect(result).toContain("[System Notification - Knowledge Update]");
    expect(result).toContain(
      "The following entries supersede any conflicting entries in the system prompt's",
    );
    expect(result).toContain(
      "Long-term Knowledge section AND any earlier delta messages with the same short ID.",
    );

    expect(result).toContain(
      "+ NEW [019eb1c4] Preference: Use tabs not spaces",
    );
    expect(result).toContain("tabs are 2 spaces wide");
    expect(result).toContain(
      "~ CHANGED [019e187a] Gotcha: Prefer const over let",
    );
    expect(result).toContain(
      "Always use const unless reassignment is required.",
    );
    expect(result).toContain(
      "- REMOVED [019e1842] Style: Always use semicolons",
    );

    expect(result).toContain(
      "Use the recall tool for full content of any entry.",
    );
  });

  // Test greedy packing with token budget
  test("caps entries at DELTA_MAX_ENTRIES", () => {
    const entries = [];
    for (let i = 0; i < 30; i++) {
      entries.push({
        op: "new" as const,
        id: `019eb${i.toString().padStart(8, "0")}`,
        category: "Test",
        title: `Title ${i}`,
        content: `Content ${i}...`.repeat(10),
      });
    }

    const result = formatKnowledgeDelta(entries);
    const newCount = (result.match(/\+ NEW \[/g) || []).length;
    expect(newCount).toBeLessThanOrEqual(20);
  });

  // Test order of entries (new -> changed -> removed)
  test("orders entries: new, then changed, then removed", () => {
    const entries = [
      {
        op: "changed" as const,
        id: "019eb1",
        category: "A",
        title: "B",
        content: "X",
      },
      {
        op: "new" as const,
        id: "019eb2",
        category: "A",
        title: "A",
        content: "Y",
      },
      {
        op: "removed" as const,
        id: "019eb3",
        category: "A",
        title: "C",
        content: "Z",
      },
    ];
    const result = formatKnowledgeDelta(entries);

    const newIndex = result.indexOf("+ NEW [019eb2]");
    const changedIndex = result.indexOf("~ CHANGED [019eb1]");
    const removedIndex = result.indexOf("- REMOVED [019eb3]");

    expect(newIndex).toBeLessThan(changedIndex);
    expect(changedIndex).toBeLessThan(removedIndex);
  });

  // Test truncated summary when cap is reached
  test("includes summary line when entries are truncated", () => {
    const entries = [];
    for (let i = 0; i < 30; i++) {
      entries.push({
        op: "new" as const,
        id: `019eb${i.toString().padStart(8, "0")}`,
        category: "Test",
        title: `Title ${i}`,
        content: `Content ${i}`,
      });
    }

    const result = formatKnowledgeDelta(entries);
    expect(result).toContain(
      "(+10 more changes; use the recall tool to inspect.)",
    );
  });

  // Test that removed entries don't have content in the delta
  test("removed entries don't include content field", () => {
    const entries = [
      {
        op: "removed" as const,
        id: "019e1842",
        category: "Style",
        title: "Always use semicolons",
        content: "old content",
      },
    ];
    const result = formatKnowledgeDelta(entries);
    expect(result).not.toContain("old content");
  });

  // Test short ID extraction
  test("shortId returns first 8 characters of UUID", () => {
    const uuid = "019e18ec-e328-76c4-9c3c-09dbe8d51c6c";
    expect(shortId(uuid)).toBe("019e18ec");
  });

  test("shortId handles shorter UUIDs", () => {
    const uuid = "123";
    expect(shortId(uuid)).toBe("123");
  });

  // Test constants are exported
  test("DELTA_MAX_ENTRIES and DELTA_TOKEN_BUDGET are exported", () => {
    expect(DELTA_MAX_ENTRIES).toBe(20);
    expect(DELTA_TOKEN_BUDGET).toBe(2000);
  });

  // Test ephemeral behavior (no content for removed entries)
  test("removed entries don't bloat the delta with content", () => {
    const entries = [
      {
        op: "new" as const,
        id: "019eb1234567",
        category: "New",
        title: "Useful Entry",
        content: "This is a useful entry.",
      },
      {
        op: "removed" as const,
        id: "019eb7654321",
        category: "Old",
        title: "Old Entry",
        content: "This is old content that shouldn't appear.",
      },
    ];
    const result = formatKnowledgeDelta(entries);
    expect(result).toContain("+ NEW [019eb123]");
    expect(result).not.toContain("Old content");
  });
});
