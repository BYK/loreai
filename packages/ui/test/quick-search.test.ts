import { describe, expect, it } from "vitest";

import { formatCount, isFindShortcut } from "~/reader/quick-search";

const key = (init: Partial<KeyboardEvent> & { key: string }) =>
  new KeyboardEvent("keydown", init);

describe("isFindShortcut", () => {
  it("matches Ctrl+F and Cmd+F only", () => {
    expect(isFindShortcut(key({ key: "f", ctrlKey: true }))).toBe(true);
    expect(isFindShortcut(key({ key: "F", metaKey: true }))).toBe(true);
    expect(isFindShortcut(key({ key: "f" }))).toBe(false);
    expect(isFindShortcut(key({ key: "f", ctrlKey: true, altKey: true }))).toBe(
      false,
    );
    expect(
      isFindShortcut(key({ key: "f", ctrlKey: true, shiftKey: true })),
    ).toBe(false);
    expect(isFindShortcut(key({ key: "g", ctrlKey: true }))).toBe(false);
  });
});

describe("formatCount", () => {
  it("renders n/m with 0 before any cycling and … while scanning", () => {
    expect(formatCount(-1, 17, false)).toBe("0/17");
    expect(formatCount(2, 17, false)).toBe("3/17");
    expect(formatCount(0, 17, true)).toBe("…/17");
    expect(formatCount(-1, 0, true)).toBe("…/0");
  });
});
