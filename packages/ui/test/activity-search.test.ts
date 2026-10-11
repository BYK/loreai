import { describe, expect, it } from "vitest";

import { activitySearchTitle } from "~/lib/activity-search";

describe("activity search header title", () => {
  it.each([
    ["in:inbox", "Inbox 1 – 4"],
    ["type:session", "Sessions 1 – 4"],
    ["type:knowledge", "Knowledge 1 – 4"],
    ["type:contradiction,promotion", "Needs attention 1 – 4"],
    ["is:unread", "Unread 1 – 4"],
  ])("names built-in query %s", (query, expected) => {
    expect(activitySearchTitle(query, 4)).toBe(expected);
  });

  it("uses a saved title or echoes a free query", () => {
    expect(activitySearchTitle("type:session", 0, "My sessions")).toBe(
      "Sessions 0",
    );
    expect(activitySearchTitle("with:codex SQLite", 2)).toBe(
      'Search "with:codex SQLite" 1 – 2',
    );
  });
});
