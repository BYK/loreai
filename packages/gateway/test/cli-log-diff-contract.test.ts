/**
 * Phase 3A.4 — typed `lore log` / `lore diff` regression.
 *
 * Pins the C-2 fix: when the legacy handler calls `process.exit(1)`
 * (e.g. for a missing ID), `runLegacyAndCollect` must NOT terminate
 * the test runner. Instead it captures the exit as exitCode=1 and
 * lets the typed wrapper translate it into a `ResolutionError` or
 * `UsageError`.
 *
 * The contract: `lore log <missing-id>` does NOT crash; it surfaces
 * a typed error envelope (exit code 22 — ResolutionError).
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

vi.mock("../src/cli/lib/version-check", () => ({
  shouldSuppressNotification: () => true,
  maybeCheckForUpdateInBackground: () => {},
  getUpdateNotification: () => null,
  abortPendingVersionCheck: () => {},
}));

// Mock @loreai/core so the legacy commandLog path doesn't actually touch
// the database or embeddings. We return an empty version history for the
// missing-id test so commandLog hits the "No knowledge entry found" branch
// and process.exit(1)s.
vi.mock("@loreai/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@loreai/core")>();
  return {
    ...actual,
    ltm: {
      versionHistory: () => [],
      recentKnowledgeChanges: () => [],
    },
    projectId: () => "test-project",
  };
});

// Exercise the runLegacyAndCollect console.log/error stubs directly so we
// can pin the zero-arg + trailing-newline contract (Seer findings #6 + #7).
describe("Phase 3A.4 — runLegacyAndCollect console hooks (Seer #6 + #7)", () => {
  // Mirror of `commands/log.ts:runLegacyAndCollect` so we can pin the
  // captured output contract directly. When the production helper
  // changes, mirror the change here too.
  function mirrorRunLegacyAndCollect(call: () => void): {
    exitCode: number;
    captured: string;
  } {
    const captured: string[] = [];
    const realLog = console.log;
    const realError = console.error;
    const realExit = process.exit;
    const priorExitCode = process.exitCode;
    process.exitCode = 0;
    console.log = (...args: unknown[]) => {
      if (args.length === 0) {
        captured.push("\n");
        return;
      }
      for (const a of args)
        captured.push(typeof a === "string" ? a : String(a));
      captured.push("\n");
    };
    console.error = (...args: unknown[]) => {
      if (args.length === 0) {
        captured.push("\n");
        return;
      }
      for (const a of args)
        captured.push(typeof a === "string" ? a : String(a));
      captured.push("\n");
    };
    process.exit = (code?: number): never => {
      throw new Error(`__legacy_exit:${code ?? "undefined"}`);
    };
    let thrown: unknown;
    try {
      call();
    } catch (err) {
      thrown = err;
    } finally {
      console.log = realLog;
      console.error = realError;
      process.exit = realExit;
    }
    const exitCode = process.exitCode ?? 0;
    process.exitCode = priorExitCode;
    if (thrown instanceof Error && /__legacy_exit:/.test(thrown.message)) {
      return { exitCode: 1, captured: captured.join("") };
    }
    if (thrown) throw thrown;
    return { exitCode, captured: captured.join("") };
  }

  test("console.log() with zero args still captures a blank line (Seer #6)", async () => {
    const { translateError } = await import("../src/cli/commands/log");
    const result = mirrorRunLegacyAndCollect(() => {
      console.log();
      console.log("No knowledge entry found: abc");
      process.exit(1);
    });
    expect(result.exitCode).toBe(1);
    // Mirror pushes: "\n" (from console.log()), "No knowledge entry
    // found: abc", "\n" (trailing newline), joined as "".
    expect(result.captured).toBe("\nNo knowledge entry found: abc\n");
    const err = translateError(result.captured);
    expect(err.name).toBe("ResolutionError");
  });

  // Seer finding #7 (MEDIUM follow-on): each console.log call must
  // append a trailing newline, matching Node's behavior. Without this,
  // two consecutive `log("foo"); log("bar");` collapse into "foobar".
  test("consecutive console.log calls produce a newline-separated capture (Seer #7)", () => {
    const result = mirrorRunLegacyAndCollect(() => {
      console.log("foo");
      console.log("bar");
    });
    expect(result.captured).toBe("foo\nbar\n");
  });
});

// Capture stdout/stderr so the test can assert envelope shape.
async function runWith(
  argv: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  process.argv = ["node", "lore", ...argv];
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  const logSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
    for (const a of args) {
      stdoutChunks.push(Buffer.isBuffer(a) ? a : Buffer.from(String(a)));
    }
  });
  const errorSpy = vi.spyOn(console, "error").mockImplementation((...args) => {
    for (const a of args) {
      stderrChunks.push(Buffer.isBuffer(a) ? a : Buffer.from(String(a)));
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
    const { runCli } = await import("../src/cli/cli");
    await runCli();
  } finally {
    logSpy.mockRestore();
    errorSpy.mockRestore();
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

describe("Phase 3A.4 — typed lore log / diff error paths (C-2)", () => {
  const origArgv = process.argv;
  const origNoUpdateCheck = process.env.LORE_NO_UPDATE_CHECK;

  beforeEach(() => {
    process.env.LORE_NO_UPDATE_CHECK = "1";
  });

  afterEach(() => {
    process.argv = origArgv;
  });

  afterAll(() => {
    if (origNoUpdateCheck === undefined)
      delete process.env.LORE_NO_UPDATE_CHECK;
    else process.env.LORE_NO_UPDATE_CHECK = origNoUpdateCheck;
  });

  test("lore diff without an id returns UsageError envelope", async () => {
    const { stderr, exitCode } = await runWith(["diff"]);
    // The typed wrapper translates a missing-id call into a typed error.
    expect(exitCode).toBe(20); // UsageError
    expect(stderr).toContain("Usage: lore diff <id>");
    expect(stderr).toContain("Try: lore diff --help");
  });

  // M-NEW-3 (independent review agent): the doc-comment on this file
  // promises `lore log <missing-id>` returns ResolutionError(22), but
  // until now nothing exercised the legacy → translateError path. With
  // @loreai/core mocked to return an empty version history, the legacy
  // commandLog prints "No knowledge entry found…" and process.exit(1)s;
  // runLegacyAndCollect catches the exit and translateError dispatches
  // on the captured text to ResolutionError(22), Try: lore recall.
  test("lore log <missing-id> returns ResolutionError envelope (M-NEW-3)", async () => {
    const { stderr, exitCode } = await runWith(["log", "no-such-entry"]);
    expect(exitCode).toBe(22); // ResolutionError
    expect(stderr).toContain("No knowledge entry");
    expect(stderr).toContain("Try: lore recall");
  });
});
