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
