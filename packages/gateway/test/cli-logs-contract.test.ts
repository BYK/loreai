/**
 * Phase 3A — typed `lore logs` contract.
 *
 * Verifies:
 *   - `--path` prints only the path
 *   - default tail prints the last 50 lines
 *   - `-n`/`--lines` changes the count
 *   - missing log file yields a ContextError with `Try: lore start`
 *   - JSON envelope includes path, totalLines, lines[]
 */
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../src/cli/lib/version-check", () => ({
  shouldSuppressNotification: () => true,
  maybeCheckForUpdateInBackground: () => {},
  getUpdateNotification: () => null,
  abortPendingVersionCheck: () => {},
}));

// Mutable state for the mocked log.logFilePath.
const fakeState = vi.hoisted(() => ({ path: "" }));

vi.mock("@loreai/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@loreai/core")>();
  return {
    ...actual,
    log: {
      logFilePath: () => fakeState.path,
    },
  };
});

import { runCli } from "../src/cli/cli";

async function runWith(argv: string[]): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number | null;
}> {
  process.argv = ["node", "lore", ...argv];
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  const logSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
    for (const a of args) {
      stdoutChunks.push(Buffer.isBuffer(a) ? a : Buffer.from(String(a)));
    }
  });
  const stdoutSpy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk) => {
      stdoutChunks.push(
        Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)),
      );
      return true;
    });
  const stderrSpy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk) => {
      stderrChunks.push(
        Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)),
      );
      return true;
    });
  const priorExitCode = process.exitCode;
  process.exitCode = 0;
  try {
    await runCli();
  } finally {
    logSpy.mockRestore();
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  }
  const exitCode = process.exitCode;
  process.exitCode = priorExitCode;
  return {
    stdout: Buffer.concat(stdoutChunks).toString("utf8"),
    stderr: Buffer.concat(stderrChunks).toString("utf8"),
    exitCode,
  };
}

describe("Phase 3A — typed lore logs", () => {
  const origArgv = process.argv;
  const origNoUpdateCheck = process.env.LORE_NO_UPDATE_CHECK;
  let tmpDir: string;
  let logFile: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "lore-logs-"));
    logFile = join(tmpDir, "lore.log");
    // Build a deterministic 100-line log.
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`);
    writeFileSync(logFile, lines.join("\n") + "\n");
    fakeState.path = logFile;
    process.env.LORE_NO_UPDATE_CHECK = "1";
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    process.argv = origArgv;
  });

  afterAll(() => {
    if (origNoUpdateCheck === undefined)
      delete process.env.LORE_NO_UPDATE_CHECK;
    else process.env.LORE_NO_UPDATE_CHECK = origNoUpdateCheck;
  });

  test("default prints the last 50 lines", async () => {
    const { stdout, exitCode } = await runWith(["logs"]);
    expect(exitCode).toBe(0);
    const lines = stdout.trim().split("\n");
    expect(lines).toHaveLength(50);
    expect(lines[0]).toBe("line 51");
    expect(lines[49]).toBe("line 100");
  });

  test("--lines 5 returns the last 5 lines", async () => {
    const { stdout, exitCode } = await runWith(["logs", "--lines", "5"]);
    expect(exitCode).toBe(0);
    expect(stdout.trim().split("\n")).toEqual([
      "line 96",
      "line 97",
      "line 98",
      "line 99",
      "line 100",
    ]);
  });

  test("-n accepts the short alias", async () => {
    const { stdout } = await runWith(["logs", "-n", "3"]);
    expect(stdout.trim().split("\n")).toEqual([
      "line 98",
      "line 99",
      "line 100",
    ]);
  });

  // Stricli's `aliases` map only resolves single-character shorthands
  // (`-n`); the long form (`--n`) is treated as an unknown positional and
  // rejected with a "Too many arguments" error. This pins the documented
  // behavior so a future Stricli upgrade that changes alias semantics
  // trips the test.
  test("--n (long form) is rejected as unknown positional (Stricli alias semantics)", async () => {
    const { stderr } = await runWith(["logs", "--n", "5"]);
    // Stricli's parser rejects the long form as a positional it didn't
    // expect. The diagnostic goes to stderr.
    expect(stderr).toMatch(/Too many arguments|Unknown|unexpected|--n/i);
  });

  test("--path prints just the path", async () => {
    const { stdout, exitCode } = await runWith(["logs", "--path"]);
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe(logFile);
  });

  test("--json returns structured payload", async () => {
    const { stdout, exitCode } = await runWith(["logs", "--json", "-n", "3"]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.path).toBe(logFile);
    expect(parsed.totalLines).toBe(100);
    expect(parsed.lines).toEqual(["line 98", "line 99", "line 100"]);
  });

  test("missing log file → ContextError with Try: lore start and exitCode 21", async () => {
    fakeState.path = join(tmpDir, "does-not-exist.log");
    const { stderr, exitCode } = await runWith(["logs"]);
    expect(exitCode).toBe(21);
    expect(stderr).toContain("No log file found");
    expect(stderr).toContain("Try: lore start");
  });
});
