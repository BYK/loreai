/**
 * Phase 3D.3c — typed `lore team` with explicit positional + flag schema.
 *
 * Pins the typed wrapper for `lore team`. The legacy handler takes a
 * subcommand as `positionals[0]` plus subcommand-specific args, and
 * reads five flags (invite, role, email, offline, project) from the
 * values dict.
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

interface TeamCall {
  positionals: string[];
  values: Record<string, unknown>;
}

describe("Phase 3D.3c — typed lore team", () => {
  test("team is registered in STRICLI_ROUTES", async () => {
    const { STRICLI_ROUTES } = await import("../src/cli/lib/argv");
    expect(STRICLI_ROUTES.has("team")).toBe(true);
  });

  test("team is NOT in LEGACY_ROUTES", async () => {
    const { LEGACY_ROUTES } = await import("../src/cli/app");
    expect(LEGACY_ROUTES.has("team")).toBe(false);
  });

  test("team declares --invite, --role, --email, --offline, --project flags", async () => {
    const { buildApplication, buildRouteMap, run } =
      await import("@stricli/core");
    const { teamCommand } = await import("../src/cli/commands/team");
    const { buildContext } = await import("../src/cli/context");

    const app = buildApplication(
      buildRouteMap({
        routes: { team: teamCommand },
        docs: { brief: "lore" },
      }),
      { name: "lore" },
    );
    const seen = new Set<string>();
    const origWrite = process.stdout.write;
    const writeSpy = ((chunk: string | Buffer) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
      for (const m of text.matchAll(/--[a-z][a-zA-Z0-9-]*/g)) seen.add(m[0]);
      return true;
    }) as never;
    process.stdout.write = writeSpy;
    try {
      await run(app, ["team", "--help"], buildContext(process));
    } finally {
      process.stdout.write = origWrite;
    }
    expect(seen.has("--invite")).toBe(true);
    expect(seen.has("--role")).toBe(true);
    expect(seen.has("--email")).toBe(true);
    expect(seen.has("--offline")).toBe(true);
    expect(seen.has("--project")).toBe(true);
  });

  test("team forwards subcommand + flags to legacy handler", async () => {
    vi.resetModules();
    const calls: TeamCall[] = [];
    const teamImpl = vi.fn(
      async (positionals: string[], values: Record<string, unknown>) => {
        calls.push({ positionals: [...positionals], values: { ...values } });
        console.log("team ok");
      },
    );
    vi.doMock("../src/cli/team-cmd", () => ({
      commandTeam: teamImpl,
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
      "team",
      "invite",
      "alice",
      "--role",
      "viewer",
      "--email",
      "alice@example.com",
      "--project",
      "/tmp/test",
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
    expect(teamImpl).toHaveBeenCalledTimes(1);
    expect(calls[0]?.positionals).toEqual(["invite", "alice"]);
    expect(calls[0]?.values.role).toBe("viewer");
    expect(calls[0]?.values.email).toBe("alice@example.com");
    expect(calls[0]?.values.project).toBe("/tmp/test");
    expect(Buffer.concat(stdoutChunks).toString("utf8")).toContain("team ok");
    vi.resetModules();
  });

  // F-1 (HIGH): variadic positional — 3+ args must reach the legacy
  // handler unchanged. A regression swapping kind: "array" back to
  // a fixed-shape tuple would still pass the 2-arg test above.
  test("team forwards 3+ positional args (variadic)", async () => {
    vi.resetModules();
    const calls: TeamCall[] = [];
    const teamImpl = vi.fn(
      async (positionals: string[], values: Record<string, unknown>) => {
        calls.push({ positionals: [...positionals], values: { ...values } });
        console.log("team ok");
      },
    );
    vi.doMock("../src/cli/team-cmd", () => ({
      commandTeam: teamImpl,
    }));
    const { runCli } = await import("../src/cli/cli");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    process.argv = [
      "node",
      "lore",
      "team",
      "add",
      "scope-1",
      "user-1",
      "viewer",
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
    expect(teamImpl).toHaveBeenCalledTimes(1);
    expect(calls[0]?.positionals).toEqual([
      "add",
      "scope-1",
      "user-1",
      "viewer",
    ]);
    vi.resetModules();
  });

  // F-2 (HIGH): default subcommand — 0 positionals must reach the
  // legacy handler with an empty array. commandTeam defaults to
  // `positionals[0] ?? "list"` so a schema with `minimum: 1` would
  // silently break `lore team` (the most common invocation).
  test("team with no positional still reaches legacy handler (default subcommand)", async () => {
    vi.resetModules();
    const calls: TeamCall[] = [];
    const teamImpl = vi.fn(
      async (positionals: string[], values: Record<string, unknown>) => {
        calls.push({ positionals: [...positionals], values: { ...values } });
        console.log("list ok");
      },
    );
    vi.doMock("../src/cli/team-cmd", () => ({
      commandTeam: teamImpl,
    }));
    const { runCli } = await import("../src/cli/cli");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    process.argv = ["node", "lore", "team"];
    const priorExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await runCli();
    } finally {
      logSpy.mockRestore();
      stdoutSpy.mockRestore();
      process.exitCode = priorExitCode;
    }
    expect(teamImpl).toHaveBeenCalledTimes(1);
    expect(calls[0]?.positionals).toEqual([]);
    vi.resetModules();
  });

  // F-3 (MEDIUM): --offline (default: false) must be forwarded as
  // true when set, and absent when not set (NOT false, NOT undefined).
  test("team forwards --offline as values.offline = true", async () => {
    vi.resetModules();
    const calls: TeamCall[] = [];
    const teamImpl = vi.fn(
      async (positionals: string[], values: Record<string, unknown>) => {
        calls.push({ positionals: [...positionals], values: { ...values } });
        console.log("team ok");
      },
    );
    vi.doMock("../src/cli/team-cmd", () => ({
      commandTeam: teamImpl,
    }));
    const { runCli } = await import("../src/cli/cli");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    process.argv = ["node", "lore", "team", "invite", "alice", "--offline"];
    const priorExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await runCli();
    } finally {
      logSpy.mockRestore();
      stdoutSpy.mockRestore();
      process.exitCode = priorExitCode;
    }
    expect(calls[0]?.values.offline).toBe(true);
    vi.resetModules();
  });

  test("team does NOT forward --offline when absent", async () => {
    vi.resetModules();
    const calls: TeamCall[] = [];
    const teamImpl = vi.fn(
      async (positionals: string[], values: Record<string, unknown>) => {
        calls.push({ positionals: [...positionals], values: { ...values } });
        console.log("team ok");
      },
    );
    vi.doMock("../src/cli/team-cmd", () => ({
      commandTeam: teamImpl,
    }));
    const { runCli } = await import("../src/cli/cli");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    process.argv = ["node", "lore", "team", "list"];
    const priorExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await runCli();
    } finally {
      logSpy.mockRestore();
      stdoutSpy.mockRestore();
      process.exitCode = priorExitCode;
    }
    // --offline absent → values.offline must be undefined (skip on
    // absent), NOT true and NOT false. The wrapper only sets it when
    // the user actually passed --offline.
    expect(calls[0]?.values.offline).toBeUndefined();
    vi.resetModules();
  });

  // F-4 (MEDIUM): --json auto-injection must produce the structured
  // envelope { output: <captured stdout> } on the typed pipeline.
  test("team --json produces the structured envelope", async () => {
    vi.resetModules();
    const teamImpl = vi.fn(async () => {
      console.log("json-mode ok");
    });
    vi.doMock("../src/cli/team-cmd", () => ({
      commandTeam: teamImpl,
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
    process.argv = ["node", "lore", "team", "list", "--json"];
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

  test("team propagates legacy exit code", async () => {
    vi.resetModules();
    const teamImpl = vi.fn(async () => {
      process.exitCode = 1;
      console.error("not logged in");
    });
    vi.doMock("../src/cli/team-cmd", () => ({
      commandTeam: teamImpl,
    }));
    const { runCli } = await import("../src/cli/cli");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    process.argv = ["node", "lore", "team", "list"];
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
});
