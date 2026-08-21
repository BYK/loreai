/**
 * Phase 3D.4 — typed `lore entity` with variadic positional + 11 flags.
 *
 * Pins the typed wrapper for `lore entity`. The legacy handler takes a
 * subcommand as `positionals[0]` plus subcommand-specific args, and
 * reads 11 flags from the values dict (all, cross, dry-run, interactive,
 * json, metadata, name, project, relation, type, value, yes) — 12 total
 * including --json auto-injection.
 *
 * Review findings addressed:
 *   - F-1: --yes flag added (was missing — entity dedup uses it)
 *   - F-2: -y alias added for --yes (matching legacy OPTIONS short)
 *   - F-3: -i alias added for --interactive
 *   - F-4: --json forwarded to legacy values.json (was missing —
 *     legacy cmdList gates JSON output on flags.json)
 *   - F-5: flag-count strings corrected to 11 (+ --json)
 *   - F-6: --metadata changed to parsed String (was boolean; legacy
 *           parses it as JSON.stringify)
 *   - F-7: dead defensive positionals.filter removed (ARGS = string[]
 *     means the filter is a no-op)
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

  test("entity declares 11 flags + --json (all, cross, dry-run, interactive, json, metadata, name, project, relation, type, value, yes)", async () => {
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
      "--dry-run",
      "--interactive",
      "--json",
      "--metadata",
      "--name",
      "--project",
      "--relation",
      "--type",
      "--value",
      "--yes",
    ];
    for (const flag of expected) {
      expect(seen.has(flag), `entity help should advertise ${flag}`).toBe(true);
    }
  });

  test("entity help explains explicit dedup preview and apply flags", async () => {
    const { commandEntity } = await import("../src/cli/entity");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    let help = "";
    try {
      await commandEntity(["help"], {});
      help = logSpy.mock.calls.flat().join("\n");
    } finally {
      logSpy.mockRestore();
    }
    expect(help).toContain("lore entity dedup --dry-run");
    expect(help).toContain("lore entity dedup --yes");
    expect(help).not.toMatch(/lore entity dedup\s+# dry-run/);
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

  // F-4 (HIGH): --json must reach the legacy handler as values.json
  // = true. Without this forwarding, legacy cmdList's `asJson` check
  // stays false and the human table is emitted under the --json
  // envelope (silently breaking CI/eval pipelines that parse the
  // legacy JSON array/object).
  test("entity --json forwards values.json=true to legacy handler", async () => {
    vi.resetModules();
    const calls: EntityCall[] = [];
    const entityImpl = vi.fn(
      async (positionals: string[], values: Record<string, unknown>) => {
        calls.push({ positionals: [...positionals], values: { ...values } });
        // Mimic what the legacy handler does: branch on values.json
        // to emit either JSON or human output.
        if (values.json === true) {
          console.log('{"entities":[]}');
        } else {
          console.log("human table here");
        }
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
    // Assert the legacy handler received the json flag.
    expect(calls[0]?.values.json).toBe(true);
    // Parse the typed envelope and verify the legacy's JSON branch
    // ran (the output field contains the legacy's JSON array/object,
    // not the human table).
    const envelope = JSON.parse(Buffer.concat(stdoutChunks).toString("utf8"));
    expect(envelope.output).toContain('{"entities":[]}');
    expect(envelope.output).not.toContain("human table");
    vi.resetModules();
  });

  // F-1 + F-2 (HIGH): --yes must be declared AND -y short alias must
  // route to it. The legacy entity dedup subcommand gates its apply
  // on `flags.yes` (`entity.ts:627`). Without the alias, `lore
  // entity dedup -y` was rejected with "No alias registered for -y".
  test("entity forwards --yes and -y short alias as values.yes = true", async () => {
    vi.resetModules();
    const calls: EntityCall[] = [];
    const entityImpl = vi.fn(
      async (positionals: string[], values: Record<string, unknown>) => {
        calls.push({ positionals: [...positionals], values: { ...values } });
        if (values.yes !== true) {
          console.error("yes flag missing");
          process.exitCode = 1;
        }
        console.log("dedup ok");
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
    process.argv = ["node", "lore", "entity", "dedup", "-y"];
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
    expect(calls[0]?.values.yes).toBe(true);
    expect(capturedExitCode).toBe(0);
    vi.resetModules();
  });

  // F-3 (HIGH): -i short alias for --interactive. Legacy OPTIONS
  // table has `interactive: { short: "i" }` (`main.ts:99`).
  test("entity forwards -i short alias as values.interactive = true", async () => {
    vi.resetModules();
    const calls: EntityCall[] = [];
    const entityImpl = vi.fn(
      async (positionals: string[], values: Record<string, unknown>) => {
        calls.push({ positionals: [...positionals], values: { ...values } });
        if (values.interactive !== true) {
          console.error("interactive flag missing");
          process.exitCode = 1;
        }
        console.log("add ok");
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
    process.argv = ["node", "lore", "entity", "add", "-i"];
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
    expect(calls[0]?.values.interactive).toBe(true);
    expect(capturedExitCode).toBe(0);
    vi.resetModules();
  });

  // F-6 (LOW): --metadata as parsed string (legacy parses JSON.stringify
  // metadata). Without this fix, --metadata '{"k":"v"}' was treated as
  // a boolean by the legacy CLI and the JSON string fell into the
  // positional array.
  test("entity forwards --metadata JSON string to legacy handler", async () => {
    vi.resetModules();
    const calls: EntityCall[] = [];
    const entityImpl = vi.fn(
      async (positionals: string[], values: Record<string, unknown>) => {
        calls.push({ positionals: [...positionals], values: { ...values } });
        console.log("metadata ok");
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
      "add",
      "--name",
      "alice",
      "--metadata",
      '{"role":"engineer"}',
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
    expect(calls[0]?.values.metadata).toBe('{"role":"engineer"}');
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

  test("entity --json never prompts and requires --yes for destructive commands", async () => {
    vi.resetModules();
    const calls: EntityCall[] = [];
    const entityImpl = vi.fn(
      async (positionals: string[], values: Record<string, unknown>) => {
        calls.push({ positionals: [...positionals], values: { ...values } });
      },
    );
    vi.doMock("../src/cli/entity", () => ({ commandEntity: entityImpl }));
    const { runCli } = await import("../src/cli/cli");
    process.argv = ["node", "lore", "entity", "delete", "entry-id", "--json"];
    const priorExitCode = process.exitCode;
    process.exitCode = undefined;
    let capturedExitCode: number | undefined;
    try {
      await runCli();
      capturedExitCode = process.exitCode;
    } finally {
      process.exitCode = priorExitCode;
    }
    expect(entityImpl).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
    expect(capturedExitCode).toBe(20);
    vi.resetModules();
  });

  test("entity --json --interactive rejects destructive before legacy handler", async () => {
    vi.resetModules();
    const calls: EntityCall[] = [];
    const entityImpl = vi.fn(
      async (positionals: string[], values: Record<string, unknown>) => {
        calls.push({ positionals: [...positionals], values: { ...values } });
      },
    );
    vi.doMock("../src/cli/entity", () => ({ commandEntity: entityImpl }));
    const { runCli } = await import("../src/cli/cli");
    const stderrChunks: Buffer[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk) => {
        stderrChunks.push(
          Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)),
        );
        return true;
      });
    process.argv = [
      "node",
      "lore",
      "entity",
      "dedup",
      "--interactive",
      "--json",
    ];
    const priorExitCode = process.exitCode;
    process.exitCode = undefined;
    let capturedExitCode: number | undefined;
    try {
      await runCli();
      capturedExitCode = process.exitCode;
    } finally {
      stderrSpy.mockRestore();
      process.exitCode = priorExitCode;
    }
    expect(entityImpl).not.toHaveBeenCalled();
    expect(capturedExitCode).toBe(20);
    expect(Buffer.concat(stderrChunks).toString("utf8")).toContain("--json");
    vi.resetModules();
  });

  test("entity --json --interactive rejects before any legacy handler", async () => {
    vi.resetModules();
    const entityImpl = vi.fn(async () => {});
    vi.doMock("../src/cli/entity", () => ({ commandEntity: entityImpl }));
    const { runCli } = await import("../src/cli/cli");
    process.argv = ["node", "lore", "entity", "add", "--json", "--interactive"];
    const priorExitCode = process.exitCode;
    process.exitCode = undefined;
    let capturedExitCode: number | undefined;
    try {
      await runCli();
      capturedExitCode = process.exitCode;
    } finally {
      process.exitCode = priorExitCode;
    }
    expect(entityImpl).not.toHaveBeenCalled();
    expect(capturedExitCode).toBe(20);
    vi.resetModules();
  });

  test("entity alias remove requires --yes before legacy handler", async () => {
    vi.resetModules();
    const entityImpl = vi.fn(async () => {});
    vi.doMock("../src/cli/entity", () => ({ commandEntity: entityImpl }));
    const { runCli } = await import("../src/cli/cli");
    process.argv = ["node", "lore", "entity", "alias", "remove", "alias-id"];
    const priorExitCode = process.exitCode;
    process.exitCode = undefined;
    let capturedExitCode: number | undefined;
    try {
      await runCli();
      capturedExitCode = process.exitCode;
    } finally {
      process.exitCode = priorExitCode;
    }
    expect(entityImpl).not.toHaveBeenCalled();
    expect(capturedExitCode).toBe(20);
    vi.resetModules();
  });

  test("entity --dry-run is limited to dedup", async () => {
    vi.resetModules();
    const entityImpl = vi.fn(async () => {});
    vi.doMock("../src/cli/entity", () => ({ commandEntity: entityImpl }));
    const { runCli } = await import("../src/cli/cli");
    process.argv = [
      "node",
      "lore",
      "entity",
      "delete",
      "entry-id",
      "--dry-run",
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
    expect(entityImpl).not.toHaveBeenCalled();
    expect(capturedExitCode).toBe(20);
    vi.resetModules();
  });

  test("entity dedup requires --yes before reaching the legacy handler", async () => {
    vi.resetModules();
    const calls: EntityCall[] = [];
    const entityImpl = vi.fn(
      async (positionals: string[], values: Record<string, unknown>) => {
        calls.push({ positionals: [...positionals], values: { ...values } });
      },
    );
    vi.doMock("../src/cli/entity", () => ({ commandEntity: entityImpl }));
    const { runCli } = await import("../src/cli/cli");
    process.argv = ["node", "lore", "entity", "dedup"];
    const priorExitCode = process.exitCode;
    process.exitCode = undefined;
    let capturedExitCode: number | undefined;
    try {
      await runCli();
      capturedExitCode = process.exitCode;
    } finally {
      process.exitCode = priorExitCode;
    }
    expect(calls).toHaveLength(0);
    expect(capturedExitCode).toBe(20);
    vi.resetModules();
  });

  test("entity dedup --interactive requires --yes before reaching the legacy handler", async () => {
    vi.resetModules();
    const entityImpl = vi.fn(async () => {});
    vi.doMock("../src/cli/entity", () => ({ commandEntity: entityImpl }));
    const { runCli } = await import("../src/cli/cli");
    process.argv = ["node", "lore", "entity", "dedup", "--interactive"];
    const priorExitCode = process.exitCode;
    process.exitCode = undefined;
    let capturedExitCode: number | undefined;
    try {
      await runCli();
      capturedExitCode = process.exitCode;
    } finally {
      process.exitCode = priorExitCode;
    }
    expect(entityImpl).not.toHaveBeenCalled();
    expect(capturedExitCode).toBe(20);
    vi.resetModules();
  });

  test("entity dedup --dry-run is allowed without --yes", async () => {
    vi.resetModules();
    const calls: EntityCall[] = [];
    const entityImpl = vi.fn(
      async (positionals: string[], values: Record<string, unknown>) => {
        calls.push({ positionals: [...positionals], values: { ...values } });
      },
    );
    vi.doMock("../src/cli/entity", () => ({ commandEntity: entityImpl }));
    const { runCli } = await import("../src/cli/cli");
    process.argv = ["node", "lore", "entity", "dedup", "--dry-run"];
    const priorExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await runCli();
    } finally {
      process.exitCode = priorExitCode;
    }
    expect(calls).toHaveLength(1);
    expect(calls[0]?.values.yes).toBeUndefined();
    expect(calls[0]?.values["dry-run"]).toBe(true);
    vi.resetModules();
  });

  test("entity dedup --interactive --yes reaches the legacy handler", async () => {
    vi.resetModules();
    const calls: EntityCall[] = [];
    const entityImpl = vi.fn(
      async (positionals: string[], values: Record<string, unknown>) => {
        calls.push({ positionals: [...positionals], values: { ...values } });
      },
    );
    vi.doMock("../src/cli/entity", () => ({ commandEntity: entityImpl }));
    const { runCli } = await import("../src/cli/cli");
    process.argv = [
      "node",
      "lore",
      "entity",
      "dedup",
      "--interactive",
      "--yes",
    ];
    const priorExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await runCli();
    } finally {
      process.exitCode = priorExitCode;
    }
    expect(calls).toHaveLength(1);
    expect(calls[0]?.positionals).toEqual(["dedup"]);
    expect(calls[0]?.values.interactive).toBe(true);
    expect(calls[0]?.values.yes).toBe(true);
    vi.resetModules();
  });

  test("direct legacy _cli enforces entity policy before dispatch", async () => {
    vi.resetModules();
    const priorArgv = process.argv;
    process.argv = ["node", "lore", "entity", "dedup", "--interactive"];
    try {
      const { _cli } = await import("../src/cli/main");
      await expect(_cli()).rejects.toMatchObject({
        name: "UsageError",
        exitCode: 20,
        message: "Refusing destructive `lore entity dedup` without --yes.",
      });
    } finally {
      process.argv = priorArgv;
      vi.resetModules();
    }
  });

  test("entity dedup --yes forwards apply path to legacy handler", async () => {
    vi.resetModules();
    const calls: EntityCall[] = [];
    const entityImpl = vi.fn(
      async (positionals: string[], values: Record<string, unknown>) => {
        calls.push({ positionals: [...positionals], values: { ...values } });
      },
    );
    vi.doMock("../src/cli/entity", () => ({ commandEntity: entityImpl }));
    const { runCli } = await import("../src/cli/cli");
    process.argv = ["node", "lore", "entity", "dedup", "--yes", "--json"];
    const priorExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await runCli();
    } finally {
      process.exitCode = priorExitCode;
    }
    expect(calls).toHaveLength(1);
    expect(calls[0]?.values.yes).toBe(true);
    expect(calls[0]?.values.json).toBe(true);
    vi.resetModules();
  });

  test("entity dedup --dry-run overrides --yes in legacy handler", async () => {
    vi.resetModules();
    const calls: EntityCall[] = [];
    const entityImpl = vi.fn(
      async (positionals: string[], values: Record<string, unknown>) => {
        calls.push({ positionals: [...positionals], values: { ...values } });
      },
    );
    vi.doMock("../src/cli/entity", () => ({ commandEntity: entityImpl }));
    const { runCli } = await import("../src/cli/cli");
    process.argv = ["node", "lore", "entity", "dedup", "--yes", "--dry-run"];
    const priorExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await runCli();
    } finally {
      process.exitCode = priorExitCode;
    }
    expect(calls).toHaveLength(1);
    expect(calls[0]?.values.yes).toBe(true);
    expect(calls[0]?.values["dry-run"]).toBe(true);
    expect(calls[0]?.values.dryRun).toBe(true);
    vi.resetModules();
  });
});
