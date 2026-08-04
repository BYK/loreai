/**
 * Phase 3D.3b — typed `lore sync` with explicit positional schema.
 *
 * Pins the typed wrapper for `lore sync` and verifies it correctly
 * forwards the positional subcommand to the legacy `commandSync`
 * handler. This test specifically exercises the documented invocations
 * (enable | disable | status | now) — the C-1 regression on PR #1560
 * was that the typed wrapper had no positional schema, so every
 * positional invocation failed before reaching the handler.
 */
import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";

const origNoUpdateCheck = process.env.LORE_NO_UPDATE_CHECK;

beforeEach(() => {
  process.env.LORE_NO_UPDATE_CHECK = "1";
});

afterAll(() => {
  if (origNoUpdateCheck === undefined) delete process.env.LORE_NO_UPDATE_CHECK;
  else process.env.LORE_NO_UPDATE_CHECK = origNoUpdateCheck;
});

interface SyncCall {
  positionals: string[];
  values: Record<string, unknown>;
}

describe("Phase 3D.3b — typed lore sync", () => {
  test("sync is registered in STRICLI_ROUTES", async () => {
    const { STRICLI_ROUTES } = await import("../src/cli/lib/argv");
    expect(STRICLI_ROUTES.has("sync")).toBe(true);
  });

  test("sync is NOT in LEGACY_ROUTES", async () => {
    const { LEGACY_ROUTES } = await import("../src/cli/app");
    expect(LEGACY_ROUTES.has("sync")).toBe(false);
  });

  test("sync declares a positional schema (one optional positional)", async () => {
    const { buildApplication, buildRouteMap, run } =
      await import("@stricli/core");
    const { syncCommand } = await import("../src/cli/commands/sync");
    const { buildContext } = await import("../src/cli/context");

    const app = buildApplication(
      buildRouteMap({
        routes: { sync: syncCommand },
        docs: { brief: "lore" },
      }),
      { name: "lore" },
    );
    // Drive `lore sync --help` and capture stdout.write output. We
    // look for the positional subcommand hint in the help text.
    const seen = new Set<string>();
    const origWrite = process.stdout.write.bind(process.stdout);
    const writeSpy = ((chunk: string | Buffer) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
      for (const m of text.matchAll(/[a-z][a-z|]*/g)) seen.add(m[0]);
      return true;
    }) as never;
    process.stdout.write = writeSpy;
    try {
      await run(app, ["sync", "--help"], buildContext(process));
    } finally {
      process.stdout.write = origWrite;
    }
    // Each documented subcommand must appear in the help text.
    expect(seen.has("enable")).toBe(true);
    expect(seen.has("disable")).toBe(true);
    expect(seen.has("status")).toBe(true);
    expect(seen.has("now")).toBe(true);
  });

  test("sync forwards positional subcommand to legacy handler", async () => {
    vi.resetModules();
    const calls: SyncCall[] = [];
    const syncImpl = vi.fn(
      async (positionals: string[], values: Record<string, unknown>) => {
        calls.push({ positionals: [...positionals], values: { ...values } });
        console.log("sync ok");
      },
    );
    vi.doMock("../src/cli/sync-cmd", () => ({
      commandSync: syncImpl,
    }));
    const { runCli } = await import("../src/cli/cli");
    const stdoutChunks: Buffer[] = [];
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
    process.argv = ["node", "lore", "sync", "enable"];
    const priorExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await runCli();
    } finally {
      logSpy.mockRestore();
      stdoutSpy.mockRestore();
      process.exitCode = priorExitCode;
    }
    expect(syncImpl).toHaveBeenCalledTimes(1);
    expect(calls[0]?.positionals).toEqual(["enable"]);
    expect(Buffer.concat(stdoutChunks).toString("utf8")).toContain("sync ok");
    vi.resetModules();
  });

  test("sync with no positional still reaches legacy handler (default subcommand)", async () => {
    vi.resetModules();
    const calls: SyncCall[] = [];
    const syncImpl = vi.fn(
      async (positionals: string[], values: Record<string, unknown>) => {
        calls.push({ positionals: [...positionals], values: { ...values } });
        console.log("status ok");
      },
    );
    vi.doMock("../src/cli/sync-cmd", () => ({
      commandSync: syncImpl,
    }));
    const { runCli } = await import("../src/cli/cli");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    process.argv = ["node", "lore", "sync"];
    const priorExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await runCli();
    } finally {
      logSpy.mockRestore();
      stdoutSpy.mockRestore();
      process.exitCode = priorExitCode;
    }
    expect(syncImpl).toHaveBeenCalledTimes(1);
    expect(calls[0]?.positionals).toEqual([]);
    vi.resetModules();
  });

  test("sync --json produces the structured envelope", async () => {
    vi.resetModules();
    const syncImpl = vi.fn(async () => {
      console.log("json-mode ok");
    });
    vi.doMock("../src/cli/sync-cmd", () => ({
      commandSync: syncImpl,
    }));
    const { runCli } = await import("../src/cli/cli");
    const stdoutChunks: Buffer[] = [];
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
    process.argv = ["node", "lore", "sync", "status", "--json"];
    const priorExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await runCli();
    } finally {
      logSpy.mockRestore();
      stdoutSpy.mockRestore();
      process.exitCode = priorExitCode;
    }
    const parsed = JSON.parse(Buffer.concat(stdoutChunks).toString("utf8"));
    expect(parsed).toEqual({ output: "json-mode ok\n" });
    vi.resetModules();
  });

  test("sync rejects extra positional with exit code 20 (UsageError), not 252 (F-1)", async () => {
    // Per-slice F-1 (CRITICAL): Stricli's ExitCode.InvalidArgument = -4
    // is silently truncated by Node's process exit code (mod 256) to
    // 252 without an explicit determineExitCode mapping (Stricli's
    // determineExitCode only fires for thrown values, not scanner
    // errors). We remap the exit code in runCli() to 20 (UsageError)
    // after detecting scanner errors via stderr monitoring.
    const { runCli } = await import("../src/cli/cli");
    process.argv = ["node", "lore", "sync", "enable", "extra-arg"];
    // Do NOT pre-set process.exitCode — Stricli's `??=` only writes
    // when exitCode is null/undefined, so a pre-existing 0 would mask
    // the InvalidArgument exit code entirely.
    const priorExitCode = process.exitCode;
    process.exitCode = undefined;
    let capturedExitCode: number | undefined;
    try {
      await runCli();
      capturedExitCode = process.exitCode;
    } finally {
      process.exitCode = priorExitCode;
    }
    // The remapping sets process.exitCode = 20 (UsageError).
    expect(capturedExitCode).toBe(20);
  });
});
