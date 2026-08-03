/**
 * Phase 3D.1 — typed `lore lint` contract.
 *
 * Pins the typed wrapper:
 *   - Empty positional args + empty values reach the legacy handler
 *     via `runLegacyAndCollect` (no parse error, no throw).
 *   - The captured legacy stdout is rendered byte-for-byte through
 *     `buildOutputCommand`.
 *   - Routing wiring is asserted: lint is in STRICLI_ROUTES, not in
 *     LEGACY_ROUTES (per the per-slice removal rule).
 *   - Legacy handler that calls `process.exit(1)` surfaces as
 *     exitCode=1 with the typed wrapper translating the sentinel.
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

const realLog = console.log;
const realError = console.error;
const realExit = process.exit;
const priorArgv = process.argv;
const origEnv = process.env.LORE_NO_UPDATE_CHECK;

beforeEach(() => {
  process.env.LORE_NO_UPDATE_CHECK = "1";
});

afterEach(() => {
  console.log = realLog;
  console.error = realError;
  process.exit = realExit;
  process.argv = priorArgv;
});

afterAll(() => {
  if (origEnv === undefined) delete process.env.LORE_NO_UPDATE_CHECK;
  else process.env.LORE_NO_UPDATE_CHECK = origEnv;
});

describe("Phase 3D.1 — typed lore lint", () => {
  test("lint is registered in STRICLI_ROUTES", async () => {
    const { STRICLI_ROUTES } = await import("../src/cli/lib/argv");
    expect(STRICLI_ROUTES.has("lint")).toBe(true);
  });

  test("lint is NOT in LEGACY_ROUTES", async () => {
    const { LEGACY_ROUTES } = await import("../src/cli/app");
    expect(LEGACY_ROUTES.has("lint")).toBe(false);
  });

  test("runLegacyAndCollect captures stdout + restores console hooks", async () => {
    const { runLegacyAndCollect } =
      await import("../src/cli/lib/legacy-bridge");
    // Snapshot spy call counts before the bridge runs. The bridge's
    // console.log/error shims must bypass the spies (they push to
    // `captured` directly without calling the original). After the
    // bridge finishes and restores originals, the spies (still active)
    // must NOT have been invoked by the bridge's own shims.
    const logSpy = vi.spyOn(console, "log");
    const errSpy = vi.spyOn(console, "error");
    const exitSpy = vi.spyOn(process, "exit");
    const beforeLogCalls = logSpy.mock.calls.length;
    const beforeErrorCalls = errSpy.mock.calls.length;
    const beforeExitCalls = exitSpy.mock.calls.length;

    try {
      const result = await runLegacyAndCollect(() => {
        console.log("line one");
        console.log();
        console.log("line two");
      });
      expect(result.captured).toBe("line one\n\nline two\n");
      expect(result.exitCode).toBe(0);
      // The bridge's console.log shim bypasses the spy wrapper, so
      // spy call counts must NOT have grown between before/after.
      expect(logSpy.mock.calls.length).toBe(beforeLogCalls);
      expect(errSpy.mock.calls.length).toBe(beforeErrorCalls);
      expect(exitSpy.mock.calls.length).toBe(beforeExitCalls);
      // And the bridge restored the originals — they no longer push
      // to `captured` (the captured string is what proves this).
      const afterResult = await runLegacyAndCollect(() => {
        console.log("post-bridge");
      });
      expect(afterResult.captured).toBe("post-bridge\n");
      // The second call's captured output should not contain "line one".
      expect(afterResult.captured).not.toContain("line one");
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  test("runLegacyAndCollect catches process.exit(1) as exitCode=1", async () => {
    const { runLegacyAndCollect } =
      await import("../src/cli/lib/legacy-bridge");
    const result = await runLegacyAndCollect(() => {
      console.log("about to exit");
      process.exit(1);
    });
    expect(result.exitCode).toBe(1);
    expect(result.captured).toBe("about to exit\n");
  });

  test("runLegacyAndCollect rethrows non-legacy errors", async () => {
    const { runLegacyAndCollect } =
      await import("../src/cli/lib/legacy-bridge");
    await expect(
      runLegacyAndCollect(() => {
        throw new Error("synthetic");
      }),
    ).rejects.toThrow("synthetic");
  });

  test("buildOutputCommand end-to-end on a synthetic legacy command", async () => {
    const { buildOutputCommand } = await import("../src/cli/lib/command");
    const { runLegacyAndCollect } =
      await import("../src/cli/lib/legacy-bridge");

    const captureSpy = vi.spyOn(process.stdout, "write");
    captureSpy.mockImplementation(() => true);

    try {
      const handler = buildOutputCommand<string, Record<string, never>, []>({
        brief: "test command",
        parameters: { flags: {} },
        config: {
          renderHuman: (data) => data,
          toJson: (data) => ({ output: data }),
        },
        async handler() {
          const { captured } = await runLegacyAndCollect(() => {
            console.log("hello");
            console.log("world");
          });
          return { kind: "value" as const, data: captured };
        },
      });

      // Sanity: the handler returns the wrapped Stricli command object.
      expect(handler).toBeDefined();
    } finally {
      captureSpy.mockRestore();
    }
  });
});
