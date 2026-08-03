/**
 * Phase 3D.3 — typed `lore sync` / `lore team` / `lore admin` / `lore import`
 * routing wiring.
 *
 * Pins the typed wrappers for the four Phase 3D.3 commands. All four
 * follow the same pattern: wrapper around the legacy handler via the
 * shared `runLegacyAndCollect` bridge. Each command is hermetically
 * isolated by mocking its legacy handler at the module boundary.
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

describe("Phase 3D.3 — typed mutation commands", () => {
  test("sync is registered in STRICLI_ROUTES", async () => {
    const { STRICLI_ROUTES } = await import("../src/cli/lib/argv");
    expect(STRICLI_ROUTES.has("sync")).toBe(true);
  });

  test("sync is NOT in LEGACY_ROUTES", async () => {
    const { LEGACY_ROUTES } = await import("../src/cli/app");
    expect(LEGACY_ROUTES.has("sync")).toBe(false);
  });

  test("team is registered in STRICLI_ROUTES", async () => {
    const { STRICLI_ROUTES } = await import("../src/cli/lib/argv");
    expect(STRICLI_ROUTES.has("team")).toBe(true);
  });

  test("team is NOT in LEGACY_ROUTES", async () => {
    const { LEGACY_ROUTES } = await import("../src/cli/app");
    expect(LEGACY_ROUTES.has("team")).toBe(false);
  });

  test("admin is registered in STRICLI_ROUTES", async () => {
    const { STRICLI_ROUTES } = await import("../src/cli/lib/argv");
    expect(STRICLI_ROUTES.has("admin")).toBe(true);
  });

  test("admin is NOT in LEGACY_ROUTES", async () => {
    const { LEGACY_ROUTES } = await import("../src/cli/app");
    expect(LEGACY_ROUTES.has("admin")).toBe(false);
  });

  test("import is registered in STRICLI_ROUTES", async () => {
    const { STRICLI_ROUTES } = await import("../src/cli/lib/argv");
    expect(STRICLI_ROUTES.has("import")).toBe(true);
  });

  test("import is NOT in LEGACY_ROUTES", async () => {
    const { LEGACY_ROUTES } = await import("../src/cli/app");
    expect(LEGACY_ROUTES.has("import")).toBe(false);
  });

  test("sync forwards to commandSync and surfaces its stdout (mocked)", async () => {
    vi.resetModules();
    const calls: { positionals: string[]; values: Record<string, unknown> }[] =
      [];
    const syncImpl = vi.fn(
      async (positionals: string[], values: Record<string, unknown>) => {
        calls.push({ positionals: [...positionals], values: { ...values } });
        console.log("sync status: ok");
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
    process.argv = ["node", "lore", "sync"];
    const priorExitCode = process.exitCode;
    process.exitCode = 0;
    try {
      await runCli();
    } finally {
      logSpy.mockRestore();
      stdoutSpy.mockRestore();
      process.exitCode = priorExitCode;
    }
    expect(syncImpl).toHaveBeenCalledTimes(1);
    expect(Buffer.concat(stdoutChunks).toString("utf8")).toContain(
      "sync status: ok",
    );
    vi.resetModules();
  });

  test("import forwards to commandImport and surfaces its stdout (mocked)", async () => {
    vi.resetModules();
    const importImpl = vi.fn(async () => {
      console.log("imported 3 entries");
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
    process.argv = ["node", "lore", "import"];
    const priorExitCode = process.exitCode;
    process.exitCode = 0;
    try {
      await runCli();
    } finally {
      logSpy.mockRestore();
      stdoutSpy.mockRestore();
      process.exitCode = priorExitCode;
    }
    expect(importImpl).toHaveBeenCalledTimes(1);
    expect(Buffer.concat(stdoutChunks).toString("utf8")).toContain(
      "imported 3 entries",
    );
    vi.resetModules();
  });
});
