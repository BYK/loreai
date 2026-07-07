import { afterEach, describe, expect, test, vi } from "vitest";
import { ltm } from "@loreai/core";
import { commandDiff, commandLog, lineDiff } from "../src/cli/history-cmd";

describe("lore log / lore diff commands (#962)", () => {
  afterEach(() => vi.restoreAllMocks());

  function captureLog(): string[] {
    const out: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      out.push(a.map(String).join(" "));
    });
    return out;
  }

  test("commandLog <id> renders the version timeline", async () => {
    const id = ltm.create({
      projectPath: "/test/962/cmd",
      scope: "project",
      category: "pattern",
      title: "Cmd Entry",
      content: "v1 body",
    });
    ltm.update(id, { content: "v2 body" });
    const out = captureLog();
    await commandLog([id], {});
    const text = out.join("\n");
    expect(text).toContain("Cmd Entry");
    expect(text).toContain("v2");
    expect(text).toContain("v1");
    expect(text).toContain("current");
  });

  test("commandLog <id> --json emits the raw version array", async () => {
    const id = ltm.create({
      projectPath: "/test/962/cmd",
      scope: "project",
      category: "pattern",
      title: "JSON Entry",
      content: "only",
    });
    const out = captureLog();
    await commandLog([id], { json: true });
    const parsed = JSON.parse(out.join("\n"));
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].title).toBe("JSON Entry");
  });

  test("commandDiff default picks latest superseded → current (not the first version)", async () => {
    const id = ltm.create({
      projectPath: "/test/962/cmd",
      scope: "project",
      category: "pattern",
      title: "Multi",
      content: "base",
    });
    ltm.update(id, { content: "second" }); // v2
    ltm.update(id, { content: "third" }); // v3 (current)
    const out = captureLog();
    await commandDiff([id], {});
    const text = out.join("\n");
    expect(text).toContain("v2 → v3"); // default = latest superseded (v2) → current (v3)
    expect(text).toContain("- second");
    expect(text).toContain("+ third");
    expect(text).not.toContain("base"); // v1 content is NOT involved
  });

  test("commandDiff <id> renders a content diff (default latest→current)", async () => {
    const id = ltm.create({
      projectPath: "/test/962/cmd",
      scope: "project",
      category: "pattern",
      title: "Diffable",
      content: "alpha\nbeta",
    });
    ltm.update(id, { content: "alpha\ngamma" });
    const out = captureLog();
    await commandDiff([id], {});
    const text = out.join("\n");
    expect(text).toContain("- beta");
    expect(text).toContain("+ gamma");
    expect(text).toContain(" alpha"); // context line retained
  });
});

describe("lineDiff (lore diff, #962)", () => {
  test("identical content → all context lines", () => {
    const d = lineDiff("a\nb\nc", "a\nb\nc");
    expect(d.every((l) => l.kind === " ")).toBe(true);
    expect(d.map((l) => l.text)).toEqual(["a", "b", "c"]);
  });

  test("classifies added / removed / context lines", () => {
    const d = lineDiff("a\nb\nc", "a\nB\nc\nd");
    expect(d.filter((l) => l.kind === "-").map((l) => l.text)).toEqual(["b"]);
    expect(d.filter((l) => l.kind === "+").map((l) => l.text)).toEqual([
      "B",
      "d",
    ]);
    expect(d.filter((l) => l.kind === " ").map((l) => l.text)).toEqual([
      "a",
      "c",
    ]);
  });

  test("invariant: keeping context+additions reconstructs the target", () => {
    const a = "one\ntwo\nthree";
    const b = "one\ntwo point five\nthree\nfour";
    const d = lineDiff(a, b);
    expect(d.filter((l) => l.kind !== "-").map((l) => l.text)).toEqual(
      b.split("\n"),
    );
    // …and keeping context+removals reconstructs the source.
    expect(d.filter((l) => l.kind !== "+").map((l) => l.text)).toEqual(
      a.split("\n"),
    );
  });
});
