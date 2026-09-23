import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const REPO_ROOT = resolve(__dirname, "../../..");
const RUN_SCRIPT = join(REPO_ROOT, "packages/core/eval/run.ts");
const PNPM = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const ownedParents = new Set<string>();

function standaloneEnvironment(parent: string): NodeJS.ProcessEnv {
  return {
    HOME: process.env.HOME,
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, "--conditions=development"]
      .filter(Boolean)
      .join(" "),
    NODE_ENV: "test",
    SENTRY_ENABLED: "0",
    LORE_DEBUG: "0",
    TMPDIR: parent,
    TMP: parent,
    TEMP: parent,
  };
}

function standaloneArguments(...args: string[]): string[] {
  return ["tsx", RUN_SCRIPT, ...args];
}

afterEach(async () => {
  await Promise.all(
    [...ownedParents].map((parent) =>
      rm(parent, { recursive: true, force: true }),
    ),
  );
  ownedParents.clear();
});

describe("standalone eval CLI isolation", () => {
  test("fixture mode owns and removes its database root without inherited isolation env", async () => {
    const parent = await mkdtemp(join(tmpdir(), "lore-standalone-eval-test-"));
    ownedParents.add(parent);

    const { stdout, stderr } = await execFileAsync(
      PNPM,
      standaloneArguments(
        "--mode",
        "fixture",
        "--dimensions",
        "context",
        "--scenarios",
        "no-such-scenario",
        "--baselines",
        "lore",
      ),
      {
        cwd: REPO_ROOT,
        env: standaloneEnvironment(parent),
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      },
    );

    expect(stderr, stderr).toBe("");
    expect(stdout).toContain("Total questions: 0");
    const remainingEntries = await readdir(parent);
    expect(
      remainingEntries.filter((entry) => entry.startsWith("lore-eval-run-")),
    ).toEqual([]);
  });

  test("a gateway connection failure still removes the owned run root", async () => {
    const parent = await mkdtemp(join(tmpdir(), "lore-standalone-eval-test-"));
    ownedParents.add(parent);

    await expect(
      execFileAsync(
        PNPM,
        standaloneArguments(
          "--mode",
          "live",
          "--gateway",
          "127.0.0.1:1",
          "--dimensions",
          "context",
          "--scenarios",
          "no-such-scenario",
        ),
        {
          cwd: REPO_ROOT,
          env: standaloneEnvironment(parent),
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
        },
      ),
    ).rejects.toThrow("Command failed");

    const remainingEntries = await readdir(parent);
    expect(
      remainingEntries.filter((entry) => entry.startsWith("lore-eval-run-")),
    ).toEqual([]);
  });
});
