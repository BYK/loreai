import { describe, test, expect, vi } from "vitest";
import { parseIndexSelection, selectIndices } from "../src/cli/import";

describe("parseIndexSelection", () => {
  test("empty / 'a' / 'all' select everything", () => {
    expect(parseIndexSelection("", 3)).toEqual([0, 1, 2]);
    expect(parseIndexSelection("  ", 3)).toEqual([0, 1, 2]);
    expect(parseIndexSelection("a", 3)).toEqual([0, 1, 2]);
    expect(parseIndexSelection("all", 3)).toEqual([0, 1, 2]);
    expect(parseIndexSelection("ALL", 3)).toEqual([0, 1, 2]);
  });

  test("comma-separated 1-based indices map to 0-based", () => {
    expect(parseIndexSelection("1,3", 3)).toEqual([0, 2]);
    expect(parseIndexSelection("2", 3)).toEqual([1]);
  });

  test("accepts whitespace and mixed separators", () => {
    expect(parseIndexSelection("1 3", 3)).toEqual([0, 2]);
    expect(parseIndexSelection(" 1 , 2 ", 3)).toEqual([0, 1]);
  });

  test("collapses duplicates and sorts ascending", () => {
    expect(parseIndexSelection("3,1,3,1", 3)).toEqual([0, 2]);
  });

  test("rejects out-of-range indices", () => {
    expect(parseIndexSelection("0", 3)).toBeNull(); // 1-based, 0 invalid
    expect(parseIndexSelection("4", 3)).toBeNull();
    expect(parseIndexSelection("1,9", 3)).toBeNull();
  });

  test("rejects non-numeric tokens", () => {
    expect(parseIndexSelection("x", 3)).toBeNull();
    expect(parseIndexSelection("1,x", 3)).toBeNull();
    expect(parseIndexSelection("1.5", 3)).toBeNull();
  });
});

describe("selectIndices", () => {
  test("returns parsed selection from the injected reader", async () => {
    const reader = vi.fn(async () => "1,3");
    const result = await selectIndices(3, { reader });
    expect(result).toEqual([0, 2]);
    expect(reader).toHaveBeenCalledTimes(1);
  });

  test("empty answer selects all", async () => {
    const reader = vi.fn(async () => "");
    const result = await selectIndices(2, { reader });
    expect(result).toEqual([0, 1]);
  });

  test("re-prompts on invalid input then accepts", async () => {
    const answers = ["nope", "9", "2"];
    let i = 0;
    const reader = vi.fn(async () => answers[i++]);
    const result = await selectIndices(3, { reader, maxTries: 3 });
    expect(result).toEqual([1]);
    expect(reader).toHaveBeenCalledTimes(3);
  });

  test("falls back to all after exhausting invalid attempts", async () => {
    const reader = vi.fn(async () => "bogus");
    const result = await selectIndices(3, { reader, maxTries: 2 });
    expect(result).toEqual([0, 1, 2]);
    expect(reader).toHaveBeenCalledTimes(2);
  });
});
