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
import { once } from "node:events";
import { createServer, type Server } from "node:http";

const BUNDLE = resolve(process.cwd(), "packages/gateway/dist/bin.cjs");
// The full suite can saturate CPU with large cache-stability fixtures. Give the
// real bundled subprocess enough wall time to start instead of reporting a
// synthetic `code === null` timeout under load.
const BUNDLE_TIMEOUT_MS = 30_000;
const TEST_TIMEOUT_MS = 45_000;

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
      timeout: BUNDLE_TIMEOUT_MS,
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

async function startRecallServer(
  statusCode = 200,
): Promise<{ server: Server; url: string }> {
  const server = createServer((_request, response) => {
    response.statusCode = statusCode;
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        query: "query",
        scope: "project",
        projectPath: "/tmp/project",
        result: "recalled result",
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected TCP recall server address");
  }
  return { server, url: `http://127.0.0.1:${address.port}` };
}

async function stopRecallServer(server: Server): Promise<void> {
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => (error ? reject(error) : resolveClose()));
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

  test(
    "`lore version` through the bundle returns the build version",
    async () => {
      const { stdout, code } = await runBundle(["version"]);
      expect(code).toBe(0);
      // The version is a semver string from build-injected VERSION.
      expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "`lore help --json` through the bundle returns the typed payload",
    async () => {
      const { stdout, code } = await runBundle(["help", "--json"]);
      expect(code).toBe(0);
      const payload = JSON.parse(stdout.trim());
      expect(payload.schemaVersion).toBe(1);
      expect(payload.name).toBe("lore");
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "`lore whoami` through the bundle returns the typed AuthError envelope when not logged in",
    async () => {
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
    },
    TEST_TIMEOUT_MS,
  );

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
    TEST_TIMEOUT_MS,
  );

  test.each([["--json"], ["--json=true"]])(
    "`lore recall` runtime failures emit one JSON error envelope through the bundle with %s",
    async (jsonFlag) => {
      const { server, url } = await startRecallServer(503);
      try {
        const { stdout, stderr, code } = await runBundle(
          ["recall", "query", jsonFlag],
          { LORE_REMOTE_URL: url },
        );

        expect(code).toBe(30);
        expect(stdout).toBe("");
        expect(JSON.parse(stderr)).toMatchObject({
          error: "NetworkError",
          code: 30,
        });
      } finally {
        await stopRecallServer(server);
      }
    },
    TEST_TIMEOUT_MS,
  );

  test("`lore recall --json` preserves successful remote JSON output", async () => {
    const { server, url } = await startRecallServer();
    try {
      const { stdout, stderr, code } = await runBundle(
        ["recall", "query", "--json"],
        { LORE_REMOTE_URL: url },
      );

      expect(code).toBe(0);
      expect(stderr).toBe("");
      expect(JSON.parse(stdout)).toMatchObject({ result: "recalled result" });
    } finally {
      await stopRecallServer(server);
    }
  });

  test("`lore recall` preserves successful remote raw output", async () => {
    const { server, url } = await startRecallServer();
    try {
      const { stdout, stderr, code } = await runBundle(["recall", "query"], {
        LORE_REMOTE_URL: url,
      });

      expect(code).toBe(0);
      expect(stderr).toBe("");
      expect(stdout).toBe("recalled result\n");
    } finally {
      await stopRecallServer(server);
    }
  });
});
