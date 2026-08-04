/**
 * Phase 3D.4 — typed `lore entity` with variadic positional + 8 flags.
 *
 * Pins the typed wrapper for `lore entity`. The legacy handler takes a
 * subcommand as `positionals[0]` plus subcommand-specific args, and
 * reads 8 flags from the values dict (all, cross, interactive,
 * metadata, name, project, relation, type, value).
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

interface EntityCall {
  positionals: string[];
  values: Record<string, unknown>;
}

describe("Phase 3D.4 — typed lore entity", () => {
  test("entity is registered in STRICLI_ROUTES", async () => {
    const { STRICLI_ROUTES } = await import("../src/cli/lib/argv");
    expect(STRICLI_ROUTES.has("entity")).toBe(true);
  });

  test("entity is NOT in LEGACY_ROUTES", async () => {
    const { LEGACY_ROUTES } = await import("../src/cli/app");
    expect(LEGACY_ROUTES.has("entity")).toBe(false);
  });

  test("entity declares 8 flags (all, cross, interactive, metadata, name, project, relation, type, value)", async () => {
    const { buildApplication, buildRouteMap, run } =
      await import("@stricli/core");
    const { entityCommand } = await import("../src/cli/commands/entity");
    const { buildContext } = await import("../src/cli/context");

    const app = buildApplication(
      buildRouteMap({
        routes: { entity: entityCommand },
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
      await run(app, ["entity", "--help"], buildContext(process));
    } finally {
      process.stdout.write = origWrite;
    }
    const expected = [
      "--all",
      "--cross",
      "--interactive",
      "--metadata",
      "--name",
      "--project",
      "--relation",
      "--type",
      "--value",
    ];
    for (const flag of expected) {
      expect(seen.has(flag), `entity help should advertise ${flag}`).toBe(true);
    }
  });

  test("entity forwards subcommand + flags to legacy handler", async () => {
    vi.resetModules();
    const calls: EntityCall[] = [];
    const entityImpl = vi.fn(
      async (positionals: string[], values: Record<string, unknown>) => {
        calls.push({ positionals: [...positionals], values: { ...values } });
        console.log("entity ok");
      },
    );
    vi.doMock("../src/cli/entity", () => ({
      commandEntity: entityImpl,
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
      "entity",
      "list",
      "--all",
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
    expect(entityImpl).toHaveBeenCalledTimes(1);
    expect(calls[0]?.positionals).toEqual(["list"]);
    expect(calls[0]?.values.all).toBe(true);
    expect(calls[0]?.values.project).toBe("/tmp/test");
    expect(Buffer.concat(stdoutChunks).toString("utf8")).toContain("entity ok");
    vi.resetModules();
  });

  test("entity forwards sub-subcommand + args (entity alias add <a> <b>)", async () => {
    vi.resetModules();
    const calls: EntityCall[] = [];
    const entityImpl = vi.fn(
      async (positionals: string[], values: Record<string, unknown>) => {
        calls.push({ positionals: [...positionals], values: { ...values } });
        console.log("alias ok");
      },
    );
    vi.doMock("../src/cli/entity", () => ({
      commandEntity: entityImpl,
    }));
    const { runCli } = await import("../src/cli/cli");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    process.argv = [
      "node",
      "lore",
      "entity",
      "alias",
      "add",
      "short-name",
      "target-id",
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
    expect(calls[0]?.positionals).toEqual([
      "alias",
      "add",
      "short-name",
      "target-id",
    ]);
    vi.resetModules();
  });

  test("entity propagates legacy exit code", async () => {
    vi.resetModules();
    const entityImpl = vi.fn(async () => {
      process.exitCode = 1;
      console.error('Unknown subcommand "bogus".');
    });
    vi.doMock("../src/cli/entity", () => ({
      commandEntity: entityImpl,
    }));
    const { runCli } = await import("../src/cli/cli");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    process.argv = ["node", "lore", "entity", "bogus"];
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

  test("entity --json produces the structured envelope", async () => {
    vi.resetModules();
    const entityImpl = vi.fn(async () => {
      console.log("json-mode ok");
    });
    vi.doMock("../src/cli/entity", () => ({
      commandEntity: entityImpl,
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
    process.argv = ["node", "lore", "entity", "list", "--json"];
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

  test("entity rejects unknown flag with exit code 20 (UsageError), not 252", async () => {
    const { runCli } = await import("../src/cli/cli");
    process.argv = ["node", "lore", "entity", "list", "--unknown-flag"];
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
});
