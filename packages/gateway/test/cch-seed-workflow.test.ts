import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRootUrl = new URL("../../../", import.meta.url);
const repoRoot = fileURLToPath(repoRootUrl);
const workflow = readFileSync(
  new URL(".github/workflows/cch-seed-check.yml", repoRootUrl),
  "utf8",
);

describe("CCH seed check workflow", () => {
  it("runs this regression test in the extraction job", () => {
    const verifyCommand = workflow
      .split("      - name: Verify tests pass\n")[1]
      ?.split("\n      - name: ")[0]
      ?.split("        run: |\n")[1];

    expect(verifyCommand).toContain(
      "packages/gateway/test/cch-seed-workflow.test.ts",
    );
  });

  it("runs every extractor invocation through tsx", () => {
    const invocations = workflow.match(
      /^\s*(?:node|pnpm exec tsx) scripts\/extract-cch-seed\.ts\b.*$/gm,
    );

    expect(invocations).not.toBeNull();
    expect(invocations).toHaveLength(3);
    expect(
      invocations?.every((line) => line.trim().startsWith("pnpm exec tsx ")),
    ).toBe(true);
  });

  it("loads the extractor through the workflow's TypeScript runtime", () => {
    const output = execFileSync(
      "pnpm",
      ["exec", "tsx", "scripts/extract-cch-seed.ts", "--help"],
      { cwd: repoRoot, encoding: "utf8" },
    );

    expect(output).toContain("Usage:");
    expect(output).toContain("scripts/extract-cch-seed.ts --version <VERSION>");
  });
});
