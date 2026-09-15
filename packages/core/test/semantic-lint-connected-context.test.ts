import { describe, expect, it } from "vitest";
import {
  buildConnectedContext,
  renderConnectedContext,
} from "../src/semantic-lint/connected-context";
import type { DiffHunk } from "../src/semantic-lint/check";

const hunk = (file: string, text: string): DiffHunk => ({ file, text });

describe("connected semantic-lint context", () => {
  it("selects bounded deterministic companions without transitive fan-out", () => {
    const hunks = [
      hunk("src/core.ts", "@@\n const sharedSymbol = true;"),
      hunk("src/core.ts", "@@\n sharedSymbol = false;"),
      hunk("src/unrelated.ts", "@@\n totallyDifferent = true;"),
    ];
    const context = buildConnectedContext(hunks);
    expect(context.get(0)?.map((entry) => entry.hunkIndex)).toEqual([1]);
    expect(context.get(0)?.[0]?.reason).toBe("same-file");
    expect(context.get(2)).toEqual([]);
  });

  it("renders companion evidence with an explicit relationship label", () => {
    const hunks = [
      hunk("src/core.ts", "@@\n sharedSymbol = true;"),
      hunk("src/core.test.ts", "@@\n expect(sharedSymbol).toBe(true);"),
    ];
    const companions = buildConnectedContext(hunks).get(0) ?? [];
    const rendered = renderConnectedContext(hunks[0], companions, hunks);
    expect(rendered).toContain(
      "[connected context: test-pair; file=src/core.test.ts]",
    );
    expect(rendered).toContain("expect(sharedSymbol)");
  });

  it("resolves extensionless relative imports", () => {
    const hunks = [
      hunk("src/main.ts", '@@\n+import { helper } from "./utils";'),
      hunk("src/utils.ts", "@@\n+export const helper = true;"),
    ];
    expect(buildConnectedContext(hunks).get(0)?.[0]).toMatchObject({
      hunkIndex: 1,
      reason: "import-relationship",
    });
  });

  it("pairs Python test_ prefixes with their source module", () => {
    const hunks = [
      hunk("src/foo.py", "def foo(): return True"),
      hunk("tests/test_foo.py", "def test_foo(): assert foo()"),
    ];
    expect(buildConnectedContext(hunks).get(0)?.[0]).toMatchObject({
      hunkIndex: 1,
      reason: "test-pair",
    });
  });

  it("pairs Python suffix-style tests with their source module", () => {
    const hunks = [
      hunk("src/foo.py", "def foo(): return True"),
      hunk("tests/foo_test.py", "def test_foo(): assert foo()"),
    ];
    expect(buildConnectedContext(hunks).get(0)?.[0]).toMatchObject({
      hunkIndex: 1,
      reason: "test-pair",
    });
  });

  it("does not treat package-name substrings as import relationships", () => {
    const hunks = [
      hunk("src/main.ts", '@@\n+import lodash from "lodash";'),
      hunk("src/lodash-utils.ts", "@@\n+export const helper = true;"),
    ];
    expect(buildConnectedContext(hunks).get(0)).toEqual([]);
  });

  it("ignores imports that only appear in removed lines or comments", () => {
    const hunks = [
      hunk("src/main.ts", '@@\n-import { helper } from "./utils";'),
      hunk("src/utils.ts", "@@\n+export const helper = true;"),
    ];
    expect(buildConnectedContext(hunks).get(0)).toEqual([]);
  });

  it("does not connect files using only common syntax tokens", () => {
    const hunks = [
      hunk("src/a.ts", "@@\n+const value = true;\n+return value;"),
      hunk("src/b.ts", "@@\n+const other = true;\n+return other;"),
    ];
    expect(buildConnectedContext(hunks).get(0)).toEqual([]);
  });

  it("does not connect files using only common identifiers", () => {
    const hunks = [
      hunk("src/a.ts", "@@\n+const data = value;\n+return result;"),
      hunk("src/b.ts", "@@\n+const data = value;\n+return result;"),
    ];
    expect(buildConnectedContext(hunks).get(0)).toEqual([]);
  });

  it("prefers the nearest same-file hunk", () => {
    const hunks = [
      hunk("src/core.ts", "@@ -100,1 +100,1 @@\n+first"),
      hunk("src/core.ts", "@@ -110,1 +110,1 @@\n+near"),
      hunk("src/core.ts", "@@ -1000,1 +1000,1 @@\n+far"),
    ];
    expect(buildConnectedContext(hunks).get(0)?.[0]?.hunkIndex).toBe(1);
  });

  it("keeps oversized seed context within the byte bound", () => {
    const rendered = renderConnectedContext(
      hunk("src/large.ts", "x".repeat(40_000)),
      [],
      [],
    );
    expect(Buffer.byteLength(rendered, "utf8")).toBeLessThanOrEqual(12 * 1024);
    expect(rendered).toContain("seed hunk truncated");
  });

  it("bounds relation work for a maximum-sized diff", () => {
    const hunks = Array.from({ length: 1_000 }, (_, index) =>
      hunk(`src/dir-${index}/foo.ts`, `@@\n+const value${index} = true;`),
    );

    const context = buildConnectedContext(hunks);
    expect(context.size).toBe(1_000);
  });
});
