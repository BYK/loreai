import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertNonEmptyShards, record } from "../../../scripts/test-shards.ts";

describe("test shard validation", () => {
  it("accepts plans where every shard has a test file", () => {
    expect(() =>
      assertNonEmptyShards([["one.test.ts"], ["two.test.ts"]]),
    ).not.toThrow();
  });

  it("rejects plans containing an empty shard", () => {
    expect(() => assertNonEmptyShards([["one.test.ts"], []])).toThrow(
      "empty shard(s): 2",
    );
  });

  it("fails the plan command instead of emitting an empty file list", () => {
    const testDirectory = dirname(fileURLToPath(import.meta.url));
    const rootDirectory = join(testDirectory, "..", "..", "..");
    const scriptPath = join(rootDirectory, "scripts", "test-shards.ts");
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", scriptPath, "plan", "--shard", "1/1000"],
      { cwd: rootDirectory, encoding: "utf8" },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("empty shard(s)");
  });
});

describe("duration manifest recording", () => {
  const temporaryReports: string[] = [];

  afterEach(() => {
    for (const report of temporaryReports.splice(0)) {
      rmSync(report, { recursive: true, force: true });
    }
  });

  it("does not rewrite the manifest from a partial report set", () => {
    const directory = mkdtempSync(join(tmpdir(), "test-shards-"));
    temporaryReports.push(directory);
    const reports = ["one", "two", "three"].map((name) => {
      const path = join(directory, `${name}.json`);
      writeFileSync(
        path,
        JSON.stringify({
          testResults: [{ name: `${name}.test.ts`, startTime: 0, endTime: 10 }],
        }),
      );
      return path;
    });
    const manifestPath = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "..",
      "scripts",
      "test-durations.json",
    );
    const before = readFileSync(manifestPath, "utf8");

    expect(() => record(reports)).toThrow("expected 4 shard reports, got 3");

    expect(readFileSync(manifestPath, "utf8")).toBe(before);
  });
});
