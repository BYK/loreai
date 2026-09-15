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
      hunk("src/main.ts", 'import { helper } from "./utils";'),
      hunk("src/utils.ts", "export const helper = true;"),
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
});
