/**
 * Phase 3D.3e — typed `lore import` with 14-flag schema.
 *
 * Pins the typed wrapper for `lore import`. The legacy handler reads
 * 14 flags from the values dict (no positionals). Each flag is
 * forwarded with both kebab-case and camelCase aliases so the legacy
 * handler's existing checks work without modification.
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

interface ImportCall {
  positionals: string[];
  values: Record<string, unknown>;
}

describe("Phase 3D.3e — typed lore import", () => {
  test("import is registered in STRICLI_ROUTES", async () => {
    const { STRICLI_ROUTES } = await import("../src/cli/lib/argv");
    expect(STRICLI_ROUTES.has("import")).toBe(true);
  });

  test("import is NOT in LEGACY_ROUTES", async () => {
    const { LEGACY_ROUTES } = await import("../src/cli/app");
    expect(LEGACY_ROUTES.has("import")).toBe(false);
  });

  test("import declares all 14 flags", async () => {
    const { buildApplication, buildRouteMap, run } =
      await import("@stricli/core");
    const { importCommand } = await import("../src/cli/commands/import");
    const { buildContext } = await import("../src/cli/context");

    const app = buildApplication(
      buildRouteMap({
        routes: { import: importCommand },
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
      await run(app, ["import", "--help"], buildContext(process));
    } finally {
      process.stdout.write = origWrite;
    }
    const expected = [
      "--dry-run",
      "--yes",
      "--agent",
      "--source",
      "--file",
      "--global",
      "--mem0-qdrant",
      "--mem0-collection",
      "--mem0-server",
      "--mem0-token",
      "--mem0-path",
      "--mem0-user",
      "--no-worktrees",
      "--project",
    ];
    for (const flag of expected) {
      expect(seen.has(flag), `import help should advertise ${flag}`).toBe(true);
    }
  });

  test("import forwards flags as values dict (with camelCase aliases)", async () => {
    vi.resetModules();
    const calls: ImportCall[] = [];
    const importImpl = vi.fn(
      async (positionals: string[], values: Record<string, unknown>) => {
        calls.push({ positionals: [...positionals], values: { ...values } });
        console.log("imported 3 entries");
      },
    );
    vi.doMock("../src/cli/import", () => ({
      commandImport: importImpl,
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
      "import",
      "--dry-run",
      "--yes",
      "--agent",
      "claude-code",
      "--source",
      "user",
      "--file",
      "/tmp/test.md",
      "--global",
      "--mem0-qdrant",
      "http://localhost:6333",
      "--no-worktrees",
      "--project",
      "/tmp/project",
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
    expect(importImpl).toHaveBeenCalledTimes(1);
    expect(calls[0]?.positionals).toEqual([]);
    expect(calls[0]?.values["dry-run"]).toBe(true);
    expect(calls[0]?.values.dryRun).toBe(true);
    expect(calls[0]?.values.yes).toBe(true);
    expect(calls[0]?.values.y).toBe(true);
    expect(calls[0]?.values.agent).toBe("claude-code");
    expect(calls[0]?.values.source).toBe("user");
    expect(calls[0]?.values.file).toBe("/tmp/test.md");
    expect(calls[0]?.values.global).toBe(true);
    expect(calls[0]?.values["mem0-qdrant"]).toBe("http://localhost:6333");
    expect(calls[0]?.values["no-worktrees"]).toBe(true);
    expect(calls[0]?.values.noWorktrees).toBe(true);
    expect(calls[0]?.values.project).toBe("/tmp/project");
    expect(Buffer.concat(stdoutChunks).toString("utf8")).toContain(
      "imported 3 entries",
    );
    vi.resetModules();
  });

  test("import does NOT forward absent flags", async () => {
    vi.resetModules();
    const calls: ImportCall[] = [];
    const importImpl = vi.fn(
      async (positionals: string[], values: Record<string, unknown>) => {
        calls.push({ positionals: [...positionals], values: { ...values } });
        console.log("imported 0 entries");
      },
    );
    vi.doMock("../src/cli/import", () => ({
      commandImport: importImpl,
    }));
    const { runCli } = await import("../src/cli/cli");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    process.argv = ["node", "lore", "import"];
    const priorExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await runCli();
    } finally {
      logSpy.mockRestore();
      stdoutSpy.mockRestore();
      process.exitCode = priorExitCode;
    }
    expect(calls[0]?.values["dry-run"]).toBeUndefined();
    expect(calls[0]?.values.dryRun).toBeUndefined();
    expect(calls[0]?.values.yes).toBeUndefined();
    expect(calls[0]?.values.global).toBeUndefined();
    expect(calls[0]?.values["no-worktrees"]).toBeUndefined();
    expect(calls[0]?.values.agent).toBeUndefined();
    vi.resetModules();
  });

  test("import --json produces the structured envelope", async () => {
    vi.resetModules();
    const importImpl = vi.fn(async () => {
      console.log("json-mode ok");
    });
    vi.doMock("../src/cli/import", () => ({
      commandImport: importImpl,
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
    process.argv = ["node", "lore", "import", "--json"];
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

  test("import rejects unknown flag with exit code 20 (UsageError), not 252", async () => {
    // F-1 regression: unknown flags trigger Stricli's UnknownFlagError
    // which sets process.exitCode = -4. The remap in cli.ts converts to
    // 20 (UsageError). Verify the typed import command catches this.
    const { runCli } = await import("../src/cli/cli");
    process.argv = ["node", "lore", "import", "--unknown-flag"];
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

  test("import propagates legacy exit code", async () => {
    vi.resetModules();
    const importImpl = vi.fn(async () => {
      process.exitCode = 1;
      console.error("no .lore.md files found");
    });
    vi.doMock("../src/cli/import", () => ({
      commandImport: importImpl,
    }));
    const { runCli } = await import("../src/cli/cli");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    process.argv = ["node", "lore", "import"];
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
