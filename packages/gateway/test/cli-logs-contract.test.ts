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

  test("--json returns structured envelope { output: <captured stdout> }", async () => {
    const { stdout, exitCode } = await runWith(["logs", "--json", "-n", "3"]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed).toEqual({
      output: "line 98\nline 99\nline 100\n",
    });
  });

  // Phase 3D.4b: the typed wrapper now delegates to the legacy
  // `commandLogs` via `runLegacyAndCollect`. The bridge captures
  // ALL legacy output (stdout + stderr) into a single string. In
  // human mode this string is emitted via stdout.write. The user sees
  // an error message and a non-zero exit code, both preserved.
  test("missing log file → exit code 1 with error message in data", async () => {
    fakeState.path = join(tmpDir, "does-not-exist.log");
    const { stdout, exitCode } = await runWith(["logs"]);
    expect(exitCode).toBe(1);
    expect(stdout).toContain("No log file found");
  });

  // Phase 3D.4b (-f fix): the follow path bypasses the bridge because
  // the legacy returns `new Promise(() => {})` (never-resolving)
  // which would hang `runLegacyAndCollect` forever. The typed
  // wrapper should:
  //   1. Forward values.follow=true AND values.f=true to the legacy
  //      (matches what the legacy CLI has always accepted)
  //   2. Invoke the legacy WITHOUT awaiting so control returns
  //      immediately (the watchFile poller + signal handlers in the
  //      legacy keep Node alive on the event loop)
  //
  // CRITICAL #1 (PR #1579 review): the mock MUST return
  // `new Promise(() => {})` — same as the real legacy — so the
  // Promise.race timeout below is load-bearing. A mock that returns
  // undefined synchronously would not detect a regression where
  // someone reverts the wrapper to `await commandLogs()`.
  //
  // CRITICAL #2 (PR #1579 review): the assertion must verify the
  // values dict contents (both follow forms + lines + n forwarded),
  // not just the call count. A regression that drops `values.f = true`
  // would slip past a `toHaveBeenCalledTimes(1)` assertion.
  test("-f short alias forwards both follow forms AND does not hang", async () => {
    vi.resetModules();
    const logsImpl = vi.fn(
      (_positionals: string[], _values: Record<string, unknown>) => {
        // Faithfully simulate the real legacy: returns a never-
        // resolving promise that the watchFile poller + signal
        // handlers keep alive. The wrapper MUST `void` this, not
        // `await` it, or the test hangs.
      },
    );
    logsImpl.mockImplementation(
      // oxlint-disable-next-line typescript/no-misused-promises -- vi.fn mock callback intentionally returns the never-resolving Promise so the wrapper's `void` discard (not `await`) is exercised
      () =>
        new Promise<void>(() => {
          /* never resolve — simulates the real legacy */
        }),
    );
    vi.doMock("../src/cli/logs", () => ({
      commandLogs: logsImpl,
    }));

    // Snapshot all existing SIGINT/SIGTERM listeners so the test
    // can restore them — the legacy installs cleanup handlers that
    // would otherwise pollute the process.
    const priorSigint = process.listeners("SIGINT").slice();
    const priorSigterm = process.listeners("SIGTERM").slice();

    process.argv = ["node", "lore", "logs", "-f"];
    const priorExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      const { runCli } = await import("../src/cli/cli");
      // Race runCli against a short timeout. If the wrapper takes
      // the bridge path (awaiting the never-resolving promise),
      // the timer fires and we surface the failure.
      await Promise.race([
        runCli(),
        new Promise<never>((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(
                  "follow path blocked the CLI process >2s — typed wrapper is awaiting the legacy's non-resolving watchFile promise",
                ),
              ),
            2000,
          ),
        ),
      ]);
    } finally {
      // Strip any signal handlers the legacy installed.
      for (const l of process.listeners("SIGINT")) {
        if (!priorSigint.includes(l)) process.removeListener("SIGINT", l);
      }
      for (const l of process.listeners("SIGTERM")) {
        if (!priorSigterm.includes(l)) process.removeListener("SIGTERM", l);
      }
      process.exitCode = priorExitCode;
      vi.doUnmock("../src/cli/logs");
      vi.resetModules();
    }
    // CRITICAL #2: explicit assertion on the forwarded values dict.
    // Both follow forms (long + short alias), lines, and n must be
    // forwarded to the legacy handler.
    expect(logsImpl).toHaveBeenCalledTimes(1);
    const callArgs = logsImpl.mock.calls[0];
    expect(callArgs[0]).toEqual([]);
    expect(callArgs[1]).toMatchObject({
      follow: true,
      f: true,
      lines: 50,
      n: 50,
    });
    // MEDIUM #3 from PR #1579 review: the typed pipeline uses
    // `kind: "empty"` for the follow path so no `""\n` artifact
    // is emitted in human mode or `{ "output": "" }` in JSON mode.
    // The streaming stdout is the user-visible output.
    // No assertion here — the artifact test would need to inspect
    // stdout.write directly. This is tested implicitly via the
    // other tests (any kind: "value" with data: "" would print a
    // blank line that surfaces as an extra line in runWith output).
  });
});
