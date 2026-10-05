/**
 * Phase 3C slice 2 — typed `lore data` with variadic positional + 14 flags.
 *
 * Pins the typed wrapper for `lore data`. The legacy handler takes a
 * subcommand as `positionals[0]` plus subcommand-specific args, and
 * reads 14 flags from the values dict.
 *
 * The typed wrapper owns machine-mode confirmation while preserving each
 * legacy handler's own prompt and preview behavior.
 */
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";
import { WRITE_DATA_SUBCOMMANDS } from "../src/cli/commands/data";

const origNoUpdateCheck = process.env.LORE_NO_UPDATE_CHECK;
const origArgv = process.argv;

beforeEach(() => {
  // Clear any `vi.doMock("../src/cli/data", ...)` mock factories left over
  // from prior tests so each test gets a fresh module instance.
  vi.resetModules();
  process.env.LORE_NO_UPDATE_CHECK = "1";
  process.argv = origArgv;
});

afterAll(() => {
  if (origNoUpdateCheck === undefined) delete process.env.LORE_NO_UPDATE_CHECK;
  else process.env.LORE_NO_UPDATE_CHECK = origNoUpdateCheck;
  process.argv = origArgv;
});

interface DataCall {
  positionals: string[];
  values: Record<string, unknown>;
}

describe("Phase 3C slice 1 — typed lore data (read-only)", () => {
  test("data is registered in STRICLI_ROUTES", async () => {
    const { STRICLI_ROUTES } = await import("../src/cli/lib/argv");
    expect(STRICLI_ROUTES.has("data")).toBe(true);
  });

  test("data is NOT in LEGACY_ROUTES", async () => {
    const { LEGACY_ROUTES } = await import("../src/cli/app");
    expect(LEGACY_ROUTES.has("data")).toBe(false);
  });

  test("data declares 14 flags (all, distillations, interactive, json, knowledge, limit, project, temporal, to, yes, dry-run, no-children, no-backup, min-confidence)", async () => {
    const { buildApplication, buildRouteMap, run } =
      await import("@stricli/core");
    const { dataCommand } = await import("../src/cli/commands/data");
    const { buildContext } = await import("../src/cli/context");

    const app = buildApplication(
      buildRouteMap({
        routes: { data: dataCommand },
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
      await run(app, ["data", "--help"], buildContext(process));
    } finally {
      process.stdout.write = origWrite;
    }
    const expected = [
      "--all",
      "--distillations",
      "--interactive",
      "--json",
      "--knowledge",
      "--limit",
      "--project",
      "--temporal",
      "--to",
      "--yes",
      "--dry-run",
      "--no-children",
      "--no-backup",
      "--min-confidence",
    ];
    for (const flag of expected) {
      expect(seen.has(flag), `data help should advertise ${flag}`).toBe(true);
    }
  });

  test("data forwards subcommand + flags to legacy handler", async () => {
    vi.resetModules();
    const calls: DataCall[] = [];
    const dataImpl = vi.fn(
      async (positionals: string[], values: Record<string, unknown>) => {
        calls.push({ positionals: [...positionals], values: { ...values } });
        console.log("data ok");
      },
    );
    vi.doMock("../src/cli/data", () => ({
      commandData: dataImpl,
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
      "data",
      "list",
      "--all",
      "--project",
      "/tmp/test",
      "--limit",
      "100",
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
    expect(dataImpl).toHaveBeenCalledTimes(1);
    expect(calls[0]?.positionals).toEqual(["list"]);
    expect(calls[0]?.values.all).toBe(true);
    expect(calls[0]?.values.project).toBe("/tmp/test");
    expect(calls[0]?.values.limit).toBe(100);
    expect(Buffer.concat(stdoutChunks).toString("utf8")).toContain("data ok");
    vi.resetModules();
  });

  test("data forwards destructive subcommand with explicit --yes (variadic positional)", async () => {
    // The variadic positional schema accepts any subcommand name and
    // forwards it to the legacy commandData. The destructive
    // central confirmation policy requires --yes in non-interactive
    // runs. The variadic schema still forwards all subcommand args.
    vi.resetModules();
    const calls: DataCall[] = [];
    const dataImpl = vi.fn(
      async (positionals: string[], values: Record<string, unknown>) => {
        calls.push({ positionals: [...positionals], values: { ...values } });
        console.log("delete ok");
      },
    );
    vi.doMock("../src/cli/data", () => ({
      commandData: dataImpl,
    }));
    const { runCli } = await import("../src/cli/cli");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    process.argv = [
      "node",
      "lore",
      "data",
      "delete",
      "entry-id-1",
      "entry-id-2",
      "--yes",
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
      "delete",
      "entry-id-1",
      "entry-id-2",
    ]);
    expect(calls[0]?.values.yes).toBe(true);
    vi.resetModules();
  });

  test("data blocks a destructive command without --yes when non-interactive", async () => {
    vi.resetModules();
    const dataImpl = vi.fn(async () => {});
    vi.doMock("../src/cli/data", () => ({
      commandData: dataImpl,
      confirm: vi.fn(),
    }));
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
    process.argv = ["node", "lore", "data", "delete", "entry-id"];
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
    expect(dataImpl).not.toHaveBeenCalled();
    expect(capturedExitCode).toBe(20);
    expect(Buffer.concat(stderrChunks).toString("utf8")).toContain("--yes");
    vi.resetModules();
  });

  test("data --json never prompts and requires --yes for destructive commands", async () => {
    vi.resetModules();
    const dataImpl = vi.fn(async () => {});
    const confirm = vi.fn(async () => true);
    vi.doMock("../src/cli/data", () => ({
      commandData: dataImpl,
      confirm,
    }));
    const { runCli } = await import("../src/cli/cli");
    process.argv = ["node", "lore", "data", "delete", "entry-id", "--json"];
    const priorExitCode = process.exitCode;
    process.exitCode = undefined;
    let capturedExitCode: number | undefined;
    try {
      await runCli();
      capturedExitCode = process.exitCode;
    } finally {
      process.exitCode = priorExitCode;
    }
    expect(dataImpl).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    expect(capturedExitCode).toBe(20);
    vi.resetModules();
  });

  test("data --json rejects interactive flows before the legacy handler", async () => {
    vi.resetModules();
    const dataImpl = vi.fn(async () => {});
    vi.doMock("../src/cli/data", () => ({ commandData: dataImpl }));
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
    process.argv = ["node", "lore", "data", "dedup", "--interactive", "--json"];
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
    expect(dataImpl).not.toHaveBeenCalled();
    expect(capturedExitCode).toBe(20);
    expect(Buffer.concat(stderrChunks).toString("utf8")).toContain(
      "--interactive cannot be used with --json",
    );
    vi.resetModules();
  });

  test("data --dry-run stays non-mutating and needs no --yes", async () => {
    vi.resetModules();
    const calls: DataCall[] = [];
    const dataImpl = vi.fn(
      async (positionals: string[], values: Record<string, unknown>) => {
        calls.push({ positionals: [...positionals], values: { ...values } });
      },
    );
    vi.doMock("../src/cli/data", () => ({
      commandData: dataImpl,
      confirm: vi.fn(),
    }));
    const { runCli } = await import("../src/cli/cli");
    process.argv = [
      "node",
      "lore",
      "data",
      "move",
      "session",
      "entry-id",
      "--dry-run",
    ];
    const priorExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await runCli();
    } finally {
      process.exitCode = priorExitCode;
    }
    expect(calls[0]?.values["dry-run"]).toBe(true);
    expect(calls[0]?.values.yes).toBeUndefined();
    vi.resetModules();
  });

  test("data clear --dry-run still requires --yes", async () => {
    vi.resetModules();
    const dataImpl = vi.fn(async () => {});
    vi.doMock("../src/cli/data", () => ({
      commandData: dataImpl,
      confirm: vi.fn(),
    }));
    const { runCli } = await import("../src/cli/cli");
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    process.argv = ["node", "lore", "data", "clear", "--dry-run"];
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
    expect(dataImpl).not.toHaveBeenCalled();
    expect(capturedExitCode).toBe(20);
    vi.resetModules();
  });

  test("interactive legacy-confirmed commands retain their operation-specific prompt", async () => {
    vi.resetModules();
    const calls: DataCall[] = [];
    const confirm = vi.fn(async () => true);
    const dataImpl = vi.fn(
      async (positionals: string[], values: Record<string, unknown>) => {
        calls.push({ positionals: [...positionals], values: { ...values } });
      },
    );
    vi.doMock("../src/cli/data", () => ({
      commandData: dataImpl,
      confirm,
    }));
    const isTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: true,
    });
    const { runCli } = await import("../src/cli/cli");
    process.argv = ["node", "lore", "data", "delete", "entry-id"];
    const priorExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await runCli();
    } finally {
      if (isTTY) Object.defineProperty(process.stdin, "isTTY", isTTY);
      else Reflect.deleteProperty(process.stdin, "isTTY");
      process.exitCode = priorExitCode;
    }
    expect(confirm).not.toHaveBeenCalled();
    expect(calls[0]?.values.yes).toBeUndefined();
    vi.resetModules();
  });

  test("move from untracked project surfaces Project not found before Session not found", async () => {
    // Previous tests use `vi.doMock("../src/cli/data", ...)` which leaves
    // a mock factory in vitest's mock registry. Unmock before importing
    // so the wrapper sees the real `commandData` and reaches the
    // untracked-project branch we fixed.
    vi.resetModules();
    vi.doUnmock("../src/cli/data");
    vi.doUnmock("../src/cli/commands/data");
    const { runCli } = await import("../src/cli/cli");
    const stdoutChunks: Buffer[] = [];
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
      "data",
      "move",
      "session",
      "missing-session",
      "--to",
      "/tmp/some-target",
      "--project",
      "/tmp/truly-untracked-project",
      "--yes",
    ];
    const priorExitCode = process.exitCode;
    process.exitCode = undefined;
    const priorRemote = process.env.LORE_REMOTE_URL;
    delete process.env.LORE_REMOTE_URL;
    delete process.env.LORE_REMOTE;
    delete process.env.LORE_HOSTED_MODE;
    let capturedExitCode: number | undefined;
    try {
      await runCli();
      capturedExitCode = process.exitCode;
    } finally {
      stdoutSpy.mockRestore();
      process.exitCode = priorExitCode;
      if (priorRemote !== undefined) {
        process.env.LORE_REMOTE_URL = priorRemote;
      }
    }
    expect(capturedExitCode).toBe(1);
    const stdout = Buffer.concat(stdoutChunks).toString("utf8");
    expect(stdout).toContain("Error: Project not found for sessions");
    expect(stdout).not.toContain("Session not found");
    vi.resetModules();
  });

  test("explicit --yes forwards to legacy-confirmed commands without a wrapper prompt", async () => {
    vi.resetModules();
    const calls: DataCall[] = [];
    const confirm = vi.fn(async () => true);
    const dataImpl = vi.fn(
      async (positionals: string[], values: Record<string, unknown>) => {
        calls.push({ positionals: [...positionals], values: { ...values } });
      },
    );
    vi.doMock("../src/cli/data", () => ({ commandData: dataImpl, confirm }));
    const { runCli } = await import("../src/cli/cli");
    process.argv = ["node", "lore", "data", "delete", "entry-id", "--yes"];
    const priorExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await runCli();
    } finally {
      process.exitCode = priorExitCode;
    }
    expect(confirm).not.toHaveBeenCalled();
    expect(calls[0]?.values.yes).toBe(true);
    vi.resetModules();
  });

  test("interactive confirmation supplies yes only for write commands without a legacy prompt", async () => {
    vi.resetModules();
    const calls: DataCall[] = [];
    const confirm = vi.fn(async () => true);
    const dataImpl = vi.fn(
      async (positionals: string[], values: Record<string, unknown>) => {
        calls.push({ positionals: [...positionals], values: { ...values } });
      },
    );
    vi.doMock("../src/cli/data", () => ({ commandData: dataImpl, confirm }));
    const isTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: true,
    });
    const { runCli } = await import("../src/cli/cli");
    process.argv = ["node", "lore", "data", "vacuum"];
    const priorExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await runCli();
    } finally {
      if (isTTY) Object.defineProperty(process.stdin, "isTTY", isTTY);
      else Reflect.deleteProperty(process.stdin, "isTTY");
      process.exitCode = priorExitCode;
    }
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(calls[0]?.values.yes).toBe(true);
    vi.resetModules();
  });

  test("write registry classifies every default-mutating subcommand", () => {
    expect(WRITE_DATA_SUBCOMMANDS).toEqual(
      new Set([
        "clear",
        "delete",
        "export",
        "merge",
        "move",
        "recover",
        "reindex",
        "rerank",
        "reground-entities",
        "vacuum",
      ]),
    );
  });

  test("data propagates legacy exit code", async () => {
    vi.resetModules();
    const dataImpl = vi.fn(async () => {
      process.exitCode = 1;
      console.error('Unknown subcommand "bogus".');
    });
    vi.doMock("../src/cli/data", () => ({
      commandData: dataImpl,
    }));
    const { runCli } = await import("../src/cli/cli");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    process.argv = ["node", "lore", "data", "bogus"];
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

  test("data --json forwards values.json=true to legacy handler", async () => {
    vi.resetModules();
    const calls: DataCall[] = [];
    const dataImpl = vi.fn(
      async (positionals: string[], values: Record<string, unknown>) => {
        calls.push({ positionals: [...positionals], values: { ...values } });
        if (values.json === true) {
          console.log("[]");
        } else {
          console.log("human table");
        }
      },
    );
    vi.doMock("../src/cli/data", () => ({
      commandData: dataImpl,
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
    process.argv = ["node", "lore", "data", "list", "--json"];
    const priorExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await runCli();
    } finally {
      logSpy.mockRestore();
      stdoutSpy.mockRestore();
      process.exitCode = priorExitCode;
    }
    expect(calls[0]?.values.json).toBe(true);
    const envelope = JSON.parse(Buffer.concat(stdoutChunks).toString("utf8"));
    expect(envelope.output).toBe("[]\n");
    vi.resetModules();
  });

  test("data rejects unknown flag with exit code 20 (UsageError), not 252", async () => {
    const { runCli } = await import("../src/cli/cli");
    process.argv = ["node", "lore", "data", "list", "--unknown-flag"];
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

  // F-1 (HIGH): per-flag forwarding tests for the 4 destructive-subcommand
  // flags. A regression that drops the forwarding line in the handler
  // for any of these would silently break `data split --no-backup`,
  // `data move session X --no-children`, etc.
  test("data forwards --dry-run as values['dry-run']+dryRun", async () => {
    vi.resetModules();
    const calls: DataCall[] = [];
    const dataImpl = vi.fn(
      async (positionals: string[], values: Record<string, unknown>) => {
        calls.push({ positionals: [...positionals], values: { ...values } });
        console.log("dry-run ok");
      },
    );
    vi.doMock("../src/cli/data", () => ({
      commandData: dataImpl,
    }));
    const { runCli } = await import("../src/cli/cli");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    process.argv = [
      "node",
      "lore",
      "data",
      "move",
      "session",
      "x",
      "--dry-run",
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
    expect(calls[0]?.values["dry-run"]).toBe(true);
    expect(calls[0]?.values.dryRun).toBe(true);
    vi.resetModules();
  });

  test("data forwards --no-children as values['no-children']+noChildren", async () => {
    vi.resetModules();
    const calls: DataCall[] = [];
    const dataImpl = vi.fn(
      async (positionals: string[], values: Record<string, unknown>) => {
        calls.push({ positionals: [...positionals], values: { ...values } });
        console.log("no-children ok");
      },
    );
    vi.doMock("../src/cli/data", () => ({
      commandData: dataImpl,
    }));
    const { runCli } = await import("../src/cli/cli");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    process.argv = [
      "node",
      "lore",
      "data",
      "move",
      "session",
      "x",
      "--no-children",
      "--dry-run",
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
    expect(calls[0]?.values["no-children"]).toBe(true);
    expect(calls[0]?.values.noChildren).toBe(true);
    vi.resetModules();
  });

  test("data forwards --no-backup as values['no-backup']+noBackup", async () => {
    vi.resetModules();
    const calls: DataCall[] = [];
    const dataImpl = vi.fn(
      async (positionals: string[], values: Record<string, unknown>) => {
        calls.push({ positionals: [...positionals], values: { ...values } });
        console.log("no-backup ok");
      },
    );
    vi.doMock("../src/cli/data", () => ({
      commandData: dataImpl,
    }));
    const { runCli } = await import("../src/cli/cli");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    process.argv = ["node", "lore", "data", "split", "session", "--no-backup"];
    const priorExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await runCli();
    } finally {
      logSpy.mockRestore();
      stdoutSpy.mockRestore();
      process.exitCode = priorExitCode;
    }
    expect(calls[0]?.values["no-backup"]).toBe(true);
    expect(calls[0]?.values.noBackup).toBe(true);
    vi.resetModules();
  });

  test("data forwards --min-confidence as values['min-confidence']", async () => {
    vi.resetModules();
    const calls: DataCall[] = [];
    const dataImpl = vi.fn(
      async (positionals: string[], values: Record<string, unknown>) => {
        calls.push({ positionals: [...positionals], values: { ...values } });
        console.log("min-confidence ok");
      },
    );
    vi.doMock("../src/cli/data", () => ({
      commandData: dataImpl,
    }));
    const { runCli } = await import("../src/cli/cli");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    process.argv = [
      "node",
      "lore",
      "data",
      "split",
      "session",
      "--min-confidence",
      "low",
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
    expect(calls[0]?.values["min-confidence"]).toBe("low");
    vi.resetModules();
  });

  test("local knowledge move refuses a normalized shared-title conflict", async () => {
    vi.resetModules();
    vi.doUnmock("../src/cli/data");
    vi.doUnmock("../src/cli/commands/data");
    const root = mkdtempSync(join(tmpdir(), "lore-cli-title-conflict-"));
    const titleSuffix = randomUUID();
    const title = `CLI move title conflict ${titleSuffix}`;
    const source = join(root, "source");
    const shared = join(root, "shared");
    const target = join(root, "target");
    mkdirSync(source);
    mkdirSync(shared);
    mkdirSync(target);
    const { ensureProject, ltm } = await import("@loreai/core");
    ensureProject(source, "move-source");
    ensureProject(shared, "move-shared");
    const id = ltm.create({
      projectPath: source,
      category: "decision",
      title,
      content: "Project-only source",
      scope: "project",
    });
    const sharedId = ltm.create({
      id: randomUUID(),
      projectPath: shared,
      category: "decision",
      title: ` ${title.toLowerCase()} `,
      content: "Existing shared entry",
      scope: "project",
      crossProject: true,
    });
    expect(ltm.getByLogical(id)?.project_id).toBe(ensureProject(source));
    expect(ltm.getByLogical(sharedId)?.cross_project).toBe(1);
    expect(ltm.findSharedTitleConflict(id, title)?.logical_id).toBe(sharedId);

    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });
    const priorRemoteUrl = process.env.LORE_REMOTE_URL;
    const priorRemote = process.env.LORE_REMOTE;
    const priorHostedMode = process.env.LORE_HOSTED_MODE;
    delete process.env.LORE_REMOTE_URL;
    delete process.env.LORE_REMOTE;
    delete process.env.LORE_HOSTED_MODE;
    try {
      const { commandData } = await import("../src/cli/data");
      await expect(
        commandData(["move", "knowledge", id], {
          project: source,
          to: target,
          yes: true,
        }),
      ).rejects.toThrow("process.exit called");
      expect(stderr).toHaveBeenCalledWith(
        `Refusing to move: title "${title}" is already used by shared entry " ${title.toLowerCase()} " (${sharedId}). Rename one entry or review duplicates in the Lore UI.`,
      );
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      stderr.mockRestore();
      exit.mockRestore();
      if (priorRemoteUrl === undefined) delete process.env.LORE_REMOTE_URL;
      else process.env.LORE_REMOTE_URL = priorRemoteUrl;
      if (priorRemote === undefined) delete process.env.LORE_REMOTE;
      else process.env.LORE_REMOTE = priorRemote;
      if (priorHostedMode === undefined) delete process.env.LORE_HOSTED_MODE;
      else process.env.LORE_HOSTED_MODE = priorHostedMode;
      rmSync(root, { recursive: true, force: true });
    }
    vi.resetModules();
  });

  // F-4 (MEDIUM): 0-positionals reach the legacy handler with []. The
  // variadic positional schema should accept zero inputs.
  test("data with no positional reaches legacy handler with []", async () => {
    vi.resetModules();
    const calls: DataCall[] = [];
    const dataImpl = vi.fn(
      async (positionals: string[], values: Record<string, unknown>) => {
        calls.push({ positionals: [...positionals], values: { ...values } });
        console.log("no-positional ok");
      },
    );
    vi.doMock("../src/cli/data", () => ({
      commandData: dataImpl,
    }));
    const { runCli } = await import("../src/cli/cli");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    process.argv = ["node", "lore", "data"];
    const priorExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await runCli();
    } finally {
      logSpy.mockRestore();
      stdoutSpy.mockRestore();
      process.exitCode = priorExitCode;
    }
    expect(calls[0]?.positionals).toEqual([]);
    vi.resetModules();
  });
});
