import { describe, expect, it } from "vitest";
import {
  buildConnectedContext,
  renderConnectedContext,
  renderConnectedContextDetails,
} from "../src/semantic-lint/connected-context";
import type { DiffHunk } from "../src/semantic-lint/check";

const hunk = (
  file: string,
  text: string,
  extras: Pick<DiffHunk, "oldFile"> = {},
): DiffHunk => ({ file, text, ...extras });

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

  it("does not treat a package name as a source-root suffix", () => {
    const hunks = [
      hunk("src/main.ts", '@@\n+import lodash from "lodash";'),
      hunk("src/lodash.ts", "@@\n+export const helper = true;"),
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

  it("filters common PascalCase identifiers from shared-symbol matching", () => {
    const hunks = [
      hunk("src/a.ts", "@@\n+const request = Request;\n+return Response;"),
      hunk("src/b.ts", "@@\n+const request = Request;\n+return Response;"),
    ];
    expect(buildConnectedContext(hunks).get(0)).toEqual([]);
  });

  it("parses multiline imports and ignores comment lookalikes", () => {
    const hunks = [
      hunk(
        "src/main.ts",
        '@@\n+/* import "./fake"; */\n+import {\n+  helper,\n+} from "./utils";',
      ),
      hunk("src/utils.ts", "@@\n+export const helper = true;"),
    ];
    expect(buildConnectedContext(hunks).get(0)?.[0]).toMatchObject({
      hunkIndex: 1,
      reason: "import-relationship",
    });
  });

  it("ignores import-looking text inside template literals", () => {
    const hunks = [
      hunk("src/main.ts", '@@\n+const text = `\nimport x from "./fake";\n`;'),
      hunk("src/fake.ts", "@@\n+export const x = true;"),
    ];
    expect(buildConnectedContext(hunks).get(0)).toEqual([]);
  });

  it("includes unchanged import context but excludes removed imports", () => {
    const hunks = [
      hunk(
        "src/main.ts",
        '@@\n import { helper } from "./utils";\n+helper();\n-import { removed } from "./wrong";',
      ),
      hunk("src/utils.ts", "@@\n+export const helper = true;"),
      hunk("src/wrong.ts", "@@\n+export const removed = true;"),
    ];
    expect(buildConnectedContext(hunks).get(0)?.[0]).toMatchObject({
      hunkIndex: 1,
      reason: "import-relationship",
    });
    expect(buildConnectedContext(hunks).get(0)).not.toContainEqual(
      expect.objectContaining({ hunkIndex: 2 }),
    );
  });

  it("uses removed code as evidence for a deletion-only hunk", () => {
    const hunks = [
      hunk(
        "src/main.ts",
        '@@ -1,2 +1,1 @@\n context\n-import x from "./utils";',
      ),
      hunk("src/utils.ts", "@@\n+export const x = true;"),
    ];
    expect(buildConnectedContext(hunks).get(0)?.[0]).toMatchObject({
      hunkIndex: 1,
      reason: "import-relationship",
    });
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

  it("skips an oversized companion and still considers later companions", () => {
    const hunks = [
      hunk("src/seed.ts", "x".repeat(100)),
      hunk("src/too-large.ts", "y".repeat(40_000)),
      hunk("src/small.ts", "small companion"),
    ];
    const details = renderConnectedContextDetails(
      hunks[0],
      [
        { hunkIndex: 1, reason: "shared-symbol", score: 2 },
        { hunkIndex: 2, reason: "shared-symbol", score: 1 },
      ],
      hunks,
    );
    expect(details.text).toContain("small companion");
    expect(details.text).toContain("omitted by size bound");
    expect(details.omittedCompanions).toBe(1);
    expect(details.truncated).toBe(false);
  });

  it("finds a test pair after unrelated same-stem source files", () => {
    const distractors = Array.from({ length: 80 }, (_, index) =>
      hunk(`packages/pkg-${index}/foo.ts`, "@@\n+const distractor = true;"),
    );
    const hunks = [
      hunk("src/foo.ts", "@@\n+const source = true;"),
      ...distractors,
      hunk("tests/foo.test.ts", "@@\n+expect(source).toBe(true);"),
    ];
    expect(buildConnectedContext(hunks).get(0)?.[0]).toMatchObject({
      hunkIndex: 81,
      reason: "test-pair",
    });
  });

  it("rejects same-named test files from unrelated packages", () => {
    const hunks = [
      hunk("packages/alpha/src/foo.ts", "@@\n+const source = true;"),
      hunk(
        "packages/beta/tests/foo.test.ts",
        "@@\n+expect(source).toBe(true);",
      ),
    ];
    expect(buildConnectedContext(hunks).get(0)).toEqual([]);
  });

  it("matches a renamed file through its old path", () => {
    const hunks = [
      hunk("src/main.ts", '@@\n+import x from "./old";'),
      hunk("src/new.ts", "@@\n+export const x = true;", {
        oldFile: "src/old.ts",
      }),
    ];
    expect(buildConnectedContext(hunks).get(0)?.[0]).toMatchObject({
      hunkIndex: 1,
      reason: "import-relationship",
    });
  });

  it("finds a test pair through a renamed source stem", () => {
    const hunks = [
      hunk("src/new-foo.ts", "@@\n+const source = true;", {
        oldFile: "src/foo.ts",
      }),
      hunk("tests/foo.test.ts", "@@\n+expect(source).toBe(true);"),
    ];
    expect(buildConnectedContext(hunks).get(0)?.[0]).toMatchObject({
      hunkIndex: 1,
      reason: "test-pair",
    });
  });

  it("honors an already-aborted context signal", () => {
    const controller = new AbortController();
    controller.abort();
    expect(() =>
      buildConnectedContext(
        [hunk("src/a.ts", "@@\n+const value = true;")],
        controller.signal,
      ),
    ).toThrow();
  });

  it("bounds relation work for a maximum-sized diff", () => {
    const hunks = Array.from({ length: 1_000 }, (_, index) =>
      hunk(`src/dir-${index}/foo.ts`, `@@\n+const value${index} = true;`),
    );

    const context = buildConnectedContext(hunks);
    expect(context.size).toBe(1_000);
  });
});
