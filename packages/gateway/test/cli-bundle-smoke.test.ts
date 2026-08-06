/**
 * Phase 1 — bundled CLI smoke (C-1 regression).
 *
 * Spawns the actual `dist/bin.cjs` produced by esbuild and asserts that
 * the typed commands reach the new Stricli surface (not the legacy
 * dispatcher). The npm tarball ships only `dist/bin.cjs`; if it routes to
 * legacy, every npm user is invisible to this migration.
 *
 * The test runs the bundle in a child process and asserts on stdout/stderr
 * + exit code. It is hermetic: no DB, no model, no network.
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";

const BUNDLE = resolve(process.cwd(), "packages/gateway/dist/bin.cjs");

async function runBundle(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  if (!existsSync(BUNDLE)) {
    throw new Error(
      `Bundle not found at ${BUNDLE} — run \`pnpm --filter @loreai/gateway run bundle\` first.`,
    );
  }
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [BUNDLE, ...args], {
      env: {
        ...process.env,
        // Suppress any background update check noise.
        LORE_NO_UPDATE_CHECK: "1",
        ...env,
      },
      timeout: 10_000,
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      resolveRun({
        stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
        stderr: Buffer.concat(stderrChunks).toString("utf-8"),
        code,
      });
    });
  });
}

describe("Phase 1 — bundled CLI reaches the typed commands", () => {
  const origNoUpdateCheck = process.env.LORE_NO_UPDATE_CHECK;

  beforeAll(() => {
    process.env.LORE_NO_UPDATE_CHECK = "1";
  });

  afterAll(() => {
    if (origNoUpdateCheck === undefined)
      delete process.env.LORE_NO_UPDATE_CHECK;
    else process.env.LORE_NO_UPDATE_CHECK = origNoUpdateCheck;
  });

  test("`lore version` through the bundle returns the build version", async () => {
    const { stdout, code } = await runBundle(["version"]);
    expect(code).toBe(0);
    // The version is a semver string from build-injected VERSION.
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  }, 15_000);

  test("`lore help --json` through the bundle returns the typed payload", async () => {
    const { stdout, code } = await runBundle(["help", "--json"]);
    expect(code).toBe(0);
    const payload = JSON.parse(stdout.trim());
    expect(payload.schemaVersion).toBe(1);
    expect(payload.name).toBe("lore");
  }, 15_000);

  test("`lore whoami` through the bundle returns the typed AuthError envelope when not logged in", async () => {
    // Force the bundle to see no persisted session. The smoke test only
    // verifies that the npm binary reaches the typed envelope shape, not
    // the underlying supabase state.
    const { stderr, code } = await runBundle(["whoami"], {
      HOME: "/tmp/lore-bundle-smoke",
      USERPROFILE: "/tmp/lore-bundle-smoke",
      LORE_DATA_DIR: "/tmp/lore-bundle-smoke",
    });
    // When no session exists, the typed adapter throws AuthError(10)
    // and the buildOutputCommand wrapper renders the human format with
    // a `Try: lore login` recovery command.
    expect(stderr).toContain("Not logged in");
    expect(stderr).toContain("Try: lore login");
    expect(code).toBe(10);
  }, 15_000);

  test.each([
    [[], "Please provide a search query."],
    [["auth", "--scope", "bogus"], "Invalid command arguments."],
    [["auth", "--scope", "bogus", "--json=true"], "Invalid command arguments."],
    [["auth", "--unexpected", "--json=true"], "Invalid command arguments."],
  ])(
    "`lore recall --json` through the bundle emits a stable UsageError envelope",
    async (args, message) => {
      const jsonFlag = args.includes("--json=true") ? [] : ["--json"];
      const { stdout, stderr, code } = await runBundle([
        "recall",
        ...args,
        ...jsonFlag,
      ]);

      expect(code).toBe(20);
      expect(stdout).toBe("");
      expect(JSON.parse(stderr)).toMatchObject({
        error: "UsageError",
        code: 20,
        message,
      });
    },
    15_000,
  );
});
