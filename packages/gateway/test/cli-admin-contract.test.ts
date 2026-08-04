/**
 * Phase 3D.3d — typed `lore admin` with 3-positional tuple.
 *
 * Pins the typed wrapper for `lore admin`. The legacy handler takes 3
 * positionals: sub (must be "grant"), target UUID or email, tier
 * (free | team | pro). No flags.
 */
import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";

const origNoUpdateCheck = process.env.LORE_NO_UPDATE_CHECK;
const origArgv = process.argv;

beforeEach(() => {
  process.env.LORE_NO_UPDATE_CHECK = "1";
  process.argv = origArgv;
});

afterAll(() => {
  if (origNoUpdateCheck === undefined) delete process.env.LORE_NO_UPDATE_CHECK;
  else process.env.LORE_NO_UPDATE_CHECK = origNoUpdateCheck;
  process.argv = origArgv;
});

interface AdminCall {
  positionals: string[];
  values: Record<string, unknown>;
}

describe("Phase 3D.3d — typed lore admin", () => {
  test("admin is registered in STRICLI_ROUTES", async () => {
    const { STRICLI_ROUTES } = await import("../src/cli/lib/argv");
    expect(STRICLI_ROUTES.has("admin")).toBe(true);
  });

  test("admin is NOT in LEGACY_ROUTES", async () => {
    const { LEGACY_ROUTES } = await import("../src/cli/app");
    expect(LEGACY_ROUTES.has("admin")).toBe(false);
  });

  test("admin declares 3-positional tuple (sub, target, tier)", async () => {
    const { buildApplication, buildRouteMap, run } =
      await import("@stricli/core");
    const { adminCommand } = await import("../src/cli/commands/admin");
    const { buildContext } = await import("../src/cli/context");

    const app = buildApplication(
      buildRouteMap({
        routes: { admin: adminCommand },
        docs: { brief: "lore" },
      }),
      { name: "lore" },
    );
    const seen = new Set<string>();
    const origWrite = process.stdout.write;
    const writeSpy = ((chunk: string | Buffer) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
      for (const m of text.matchAll(/(grant|tier|target|subcommand)/g))
        seen.add(m[0]);
      return true;
    }) as never;
    process.stdout.write = writeSpy;
    try {
      await run(app, ["admin", "--help"], buildContext(process));
    } finally {
      process.stdout.write = origWrite;
    }
    expect(seen.has("subcommand")).toBe(true);
    expect(seen.has("target")).toBe(true);
    expect(seen.has("tier")).toBe(true);
  });

  test("admin forwards 3 positionals to legacy handler", async () => {
    vi.resetModules();
    const calls: AdminCall[] = [];
    const adminImpl = vi.fn(
      async (positionals: string[], values: Record<string, unknown>) => {
        calls.push({ positionals: [...positionals], values: { ...values } });
        console.log("admin ok");
      },
    );
    vi.doMock("../src/cli/admin-cmd", () => ({
      commandAdmin: adminImpl,
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
    process.argv = [
      "node",
      "lore",
      "admin",
      "grant",
      "00000000-0000-0000-0000-000000000000",
      "team",
    ];
    const priorExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await runCli();
    } finally {
      logSpy.mockRestore();
      stdoutSpy.mockRestore();
      process.exitCode = priorExitCode;
    }
    expect(adminImpl).toHaveBeenCalledTimes(1);
    expect(calls[0]?.positionals).toEqual([
      "grant",
      "00000000-0000-0000-0000-000000000000",
      "team",
    ]);
    expect(Buffer.concat(stdoutChunks).toString("utf8")).toContain("admin ok");
    vi.resetModules();
  });

  // M-1: partial-positional coverage. The admin positional schema
  // declares all 3 as optional, so the Stricli scanner accepts 0/1/2/3
  // inputs. Every partial case reaches the legacy handler, which calls
  // `usage()` and exits 1. Pin that each partial case reaches
  // commandAdmin with the right positionals-prefixed array.
  test("admin with no positional reaches legacy handler with []", async () => {
    vi.resetModules();
    const calls: AdminCall[] = [];
    const adminImpl = vi.fn(
      async (positionals: string[], values: Record<string, unknown>) => {
        calls.push({ positionals: [...positionals], values: { ...values } });
        process.exitCode = 1;
      },
    );
    vi.doMock("../src/cli/admin-cmd", () => ({
      commandAdmin: adminImpl,
    }));
    const { runCli } = await import("../src/cli/cli");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    process.argv = ["node", "lore", "admin"];
    const priorExitCode = process.exitCode;
    process.exitCode = undefined;
    let capturedExitCode: number | undefined;
    try {
      await runCli();
      capturedExitCode = process.exitCode;
    } finally {
      logSpy.mockRestore();
      stdoutSpy.mockRestore();
      process.exitCode = priorExitCode;
    }
    expect(adminImpl).toHaveBeenCalledTimes(1);
    expect(calls[0]?.positionals).toEqual([]);
    expect(capturedExitCode).toBe(1);
    vi.resetModules();
  });

  test("admin with 1 positional ('grant') reaches legacy handler with ['grant']", async () => {
    vi.resetModules();
    const calls: AdminCall[] = [];
    const adminImpl = vi.fn(
      async (positionals: string[], values: Record<string, unknown>) => {
        calls.push({ positionals: [...positionals], values: { ...values } });
        process.exitCode = 1;
      },
    );
    vi.doMock("../src/cli/admin-cmd", () => ({
      commandAdmin: adminImpl,
    }));
    const { runCli } = await import("../src/cli/cli");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    process.argv = ["node", "lore", "admin", "grant"];
    const priorExitCode = process.exitCode;
    process.exitCode = undefined;
    let capturedExitCode: number | undefined;
    try {
      await runCli();
      capturedExitCode = process.exitCode;
    } finally {
      logSpy.mockRestore();
      stdoutSpy.mockRestore();
      process.exitCode = priorExitCode;
    }
    expect(adminImpl).toHaveBeenCalledTimes(1);
    expect(calls[0]?.positionals).toEqual(["grant"]);
    expect(capturedExitCode).toBe(1);
    vi.resetModules();
  });

  test("admin with 2 positionals ('grant <target>') reaches legacy handler with ['grant', '<target>']", async () => {
    vi.resetModules();
    const calls: AdminCall[] = [];
    const adminImpl = vi.fn(
      async (positionals: string[], values: Record<string, unknown>) => {
        calls.push({ positionals: [...positionals], values: { ...values } });
        process.exitCode = 1;
      },
    );
    vi.doMock("../src/cli/admin-cmd", () => ({
      commandAdmin: adminImpl,
    }));
    const { runCli } = await import("../src/cli/cli");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    process.argv = [
      "node",
      "lore",
      "admin",
      "grant",
      "00000000-0000-0000-0000-000000000000",
    ];
    const priorExitCode = process.exitCode;
    process.exitCode = undefined;
    let capturedExitCode: number | undefined;
    try {
      await runCli();
      capturedExitCode = process.exitCode;
    } finally {
      logSpy.mockRestore();
      stdoutSpy.mockRestore();
      process.exitCode = priorExitCode;
    }
    expect(adminImpl).toHaveBeenCalledTimes(1);
    expect(calls[0]?.positionals).toEqual([
      "grant",
      "00000000-0000-0000-0000-000000000000",
    ]);
    expect(capturedExitCode).toBe(1);
    vi.resetModules();
  });

  test("admin propagates legacy exit code", async () => {
    vi.resetModules();
    const adminImpl = vi.fn(async () => {
      process.exitCode = 1;
      console.error("SUPABASE_SERVICE_ROLE_KEY not set");
    });
    vi.doMock("../src/cli/admin-cmd", () => ({
      commandAdmin: adminImpl,
    }));
    const { runCli } = await import("../src/cli/cli");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    process.argv = ["node", "lore", "admin", "grant", "x", "team"];
    const priorExitCode = process.exitCode;
    process.exitCode = undefined;
    let capturedExitCode: number | undefined;
    try {
      await runCli();
      capturedExitCode = process.exitCode;
    } finally {
      logSpy.mockRestore();
      stdoutSpy.mockRestore();
      process.exitCode = priorExitCode;
    }
    expect(capturedExitCode).toBe(1);
    vi.resetModules();
  });

  test("admin rejects extra positional with exit code 20 (UsageError), not 252", async () => {
    // The F-1 scanner-error exit-code remap from PR #1569 covers all
    // Stricli routes. Pin it on admin too — the only consumer here
    // is the UnknownPositionalError path (4 args vs the declared 3).
    const { runCli } = await import("../src/cli/cli");
    process.argv = [
      "node",
      "lore",
      "admin",
      "grant",
      "00000000-0000-0000-0000-000000000000",
      "team",
      "extra-arg",
    ];
    const priorExitCode = process.exitCode;
    process.exitCode = undefined;
    let capturedExitCode: number | undefined;
    try {
      await runCli();
      capturedExitCode = process.exitCode;
    } finally {
      process.exitCode = priorExitCode;
    }
    expect(capturedExitCode).toBe(20);
  });

  // L-3: --json auto-injection must produce the structured envelope.
  test("admin --json produces the structured envelope", async () => {
    vi.resetModules();
    const adminImpl = vi.fn(async () => {
      console.log("Set <uuid> tier → team");
    });
    vi.doMock("../src/cli/admin-cmd", () => ({
      commandAdmin: adminImpl,
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
    process.argv = [
      "node",
      "lore",
      "admin",
      "grant",
      "00000000-0000-0000-0000-000000000000",
      "team",
      "--json",
    ];
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
    expect(parsed).toEqual({ output: "Set <uuid> tier → team\n" });
    vi.resetModules();
  });
});
