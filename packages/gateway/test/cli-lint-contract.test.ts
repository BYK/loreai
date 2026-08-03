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

  // M-1: the sentinel must carry the actual exit code, not just be
  // hardcoded to 1. The bridge is used by `commands/lint.ts` to
  // surface --gate-mode exit code 2 from the legacy invariant-check
  // handler; if the bridge drops the code, the gate failure becomes a
  // silent 1 instead of the expected 2.
  test("runLegacyAndCollect preserves process.exit(2) as exitCode=2", async () => {
    const { runLegacyAndCollect } =
      await import("../src/cli/lib/legacy-bridge");
    const result = await runLegacyAndCollect(() => {
      process.exit(2);
    });
    expect(result.exitCode).toBe(2);
  });

  test("runLegacyAndCollect preserves process.exit(undefined) as exitCode=1", async () => {
    const { runLegacyAndCollect } =
      await import("../src/cli/lib/legacy-bridge");
    const result = await runLegacyAndCollect(() => {
      process.exit();
    });
    expect(result.exitCode).toBe(1);
  });

  // L-1: process.exitCode is preserved across bridge invocations.
  test("runLegacyAndCollect restores caller's process.exitCode on success", async () => {
    const { runLegacyAndCollect } =
      await import("../src/cli/lib/legacy-bridge");
    const priorExitCode = process.exitCode;
    process.exitCode = 7;
    try {
      const result = await runLegacyAndCollect(() => {});
      expect(result.exitCode).toBe(0);
      // Bridge restored the caller's pre-call exit code.
      expect(process.exitCode).toBe(7);
    } finally {
      process.exitCode = priorExitCode;
    }
  });

  // Seer #1 on PR #1559 (auth): interactive flows like login use
  // readline/promises which writes prompts directly via process.stdout
  // (NOT via console.log). The bridge must capture process.stdout.write
  // too (otherwise --json mode leaks prompt text into the JSON envelope).
  // Seer follow-on (PR #1559): capture-only would hang interactive
  // flows because the user never sees the prompt. Fix: tee through
  // to original stdout when stdin is a TTY.
  // Seer follow-on #2 (PR #1561): tee ALSO causes double-output for
  // non-interactive flows like makeSyncProgress progress bars. Fix:
  // only tee when stdin is a TTY.
  test("runLegacyAndCollect captures process.stdout.write; tees through ONLY when stdin is TTY", async () => {
    const { runLegacyAndCollect } =
      await import("../src/cli/lib/legacy-bridge");
    const sink: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    const origStdinIsTTY = process.stdin.isTTY;
    process.stdout.write = (chunk: unknown): boolean => {
      sink.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    };

    // --- Non-TTY (CI, --json, progress bars): capture-only ---
    Object.defineProperty(process.stdin, "isTTY", {
      value: false,
      configurable: true,
    });
    try {
      const result = await runLegacyAndCollect(() => {
        process.stdout.write("progress: 50%\n");
        console.log("done");
      });
      expect(result.captured).toBe("progress: 50%\ndone\n");
      // No tee: nothing reached the outer sink.
      expect(sink).toEqual([]);
    } finally {
      Object.defineProperty(process.stdin, "isTTY", {
        value: origStdinIsTTY,
        configurable: true,
      });
    }

    sink.length = 0;

    // --- TTY (interactive login): capture AND tee ---
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true,
    });
    try {
      const result = await runLegacyAndCollect(() => {
        process.stdout.write("Enter the code: ");
        console.log("abc123");
      });
      expect(result.captured).toBe("Enter the code: abc123\n");
      // Tee reached the outer sink.
      expect(sink).toEqual(["Enter the code: "]);
    } finally {
      Object.defineProperty(process.stdin, "isTTY", {
        value: origStdinIsTTY,
        configurable: true,
      });
      process.stdout.write = origWrite;
    }
  });

  // Bridge must restore process.stdout.write after the call so the
  // outer test runtime is unaffected. (We can't use Object.is
  // equality on bound function refs — each reassignment to
  // process.stdout.write wraps with another `bind` layer. Instead,
  // verify behavior: a write after the bridge returns reaches the
  // outside, not the captured array.)
  //
  // For this assertion we don't care about tee vs no-tee (the
  // previous test covers both TTY modes); we just want to confirm
  // the bridge's shim is gone after it returns. So we mock
  // process.stdout.write AFTER the bridge completes, and assert the
  // write reaches our sink (not the bridge's capture).
  test("runLegacyAndCollect restores process.stdout.write after the call", async () => {
    const { runLegacyAndCollect } =
      await import("../src/cli/lib/legacy-bridge");
    const sink: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    await runLegacyAndCollect(() => {});
    process.stdout.write = (chunk: unknown): boolean => {
      sink.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    };
    try {
      process.stdout.write("after-bridge");
      expect(sink).toEqual(["after-bridge"]);
    } finally {
      process.stdout.write = origWrite;
    }
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

  // H-2: regression coverage for the lint flag schema. Stricli parses
  // each flag from the command line; without an explicit schema, every
  // user-provided flag was rejected as "unknown". Pin each flag name
  // so a future refactor that drops one of them trips this test.
  test("lint declares the full flag schema (base, head, model, project, effort, gate, import-lore-md, jsonLines)", async () => {
    const { buildApplication, buildRouteMap, run } =
      await import("@stricli/core");
    const { lintCommand } = await import("../src/cli/commands/lint");
    const { buildContext } = await import("../src/cli/context");

    const app = buildApplication(
      buildRouteMap({
        routes: { lint: lintCommand },
        docs: { brief: "lore" },
      }),
      { name: "lore" },
    );
    const seen = new Set<string>();
    const origWrite = process.stdout.write;
    const writeSpy = ((chunk: string | Buffer) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
      for (const m of text.matchAll(/--[a-z][a-zA-Z0-9-]*/g)) {
        seen.add(m[0]);
      }
      return true;
    }) as never;
    process.stdout.write = writeSpy;
    try {
      await run(app, ["lint", "--help"], buildContext(process));
    } finally {
      process.stdout.write = origWrite;
    }
    // Each flag below must appear in the help text. If a refactor
    // drops one of them, this list will mismatch.
    const expected = [
      "--base",
      "--head",
      "--model",
      "--project",
      "--effort",
      "--gate",
      "--import-lore-md",
      "--jsonLines",
      "--json",
    ];
    for (const flag of expected) {
      expect(seen.has(flag), `lint help should advertise ${flag}`).toBe(true);
    }
  });

  // Integration with `buildOutputCommand` is exercised end-to-end by
  // `cli-doctor-contract.test.ts` (which goes through runCli) and
  // `cli-log-diff-contract.test.ts` (which exercises the same
  // runLegacyAndCollect → translateError → CliError envelope chain
  // that commands/lint.ts uses). The bridge unit tests above pin the
  // contract that this integration depends on.
});
