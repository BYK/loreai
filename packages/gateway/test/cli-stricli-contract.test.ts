/**
 * Phase 1 — Stricli surface contract.
 *
 * Verifies the typed `help` and `version` routes work end-to-end. The
 * legacy contract suite (`cli-routing-contract.test.ts` and
 * `cli-root-routing.test.ts`) already pins every other command path.
 *
 * These tests are deliberately hermetic — no DB, no model load, no network.
 * The Stricli app reads `process.argv`; tests set it explicitly so the
 * scanner resolves the route deterministically.
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

vi.mock("@loreai/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@loreai/core")>();
  return {
    ...actual,
    db: () => ({ query: () => ({ get: () => ({}) }) }),
    isVecAvailable: () => true,
    checkVecWorker: async () => ({
      status: "ready",
      vecAvailable: true,
      error: undefined,
    }),
    checkReadOffload: async () => ({ status: "ok", error: undefined }),
    embedding: { embed: async () => [[1, 2, 3]] },
    embeddingVendor: { vendorRegistration: () => null },
    discoverWorkspaceRoot: () => "/tmp/lore-stricli-contract",
  };
});

vi.mock("../src/cli/lib/version-check", () => ({
  shouldSuppressNotification: () => true,
  maybeCheckForUpdateInBackground: () => {},
  getUpdateNotification: () => null,
  abortPendingVersionCheck: () => {},
}));

import { runCli } from "../src/cli/cli";
import { VERSION } from "../src/cli/version";

describe("Phase 1 — Stricli app contract", () => {
  const origArgv = process.argv;
  const origNoUpdateCheck = process.env.LORE_NO_UPDATE_CHECK;

  beforeEach(() => {
    process.env.LORE_NO_UPDATE_CHECK = "1";
  });

  afterEach(() => {
    process.argv = origArgv;
  });

  afterAll(() => {
    if (origNoUpdateCheck === undefined) delete process.env.LORE_NO_UPDATE_CHECK;
    else process.env.LORE_NO_UPDATE_CHECK = origNoUpdateCheck;
  });

  async function runWith(argv: string[]): Promise<string> {
    process.argv = ["node", "lore", ...argv];
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    // `printHelp()` uses `console.log` — capture that too so the legacy
    // prose shows up in our collected stdout buffer.
    const logSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
      for (const a of args) {
        stdoutChunks.push(
          Buffer.isBuffer(a) ? a : Buffer.from(String(a)),
        );
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
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk) => {
        stderrChunks.push(
          Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)),
        );
        return true;
      });
    try {
      await runCli();
    } finally {
      logSpy.mockRestore();
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    }
    return Buffer.concat(stdoutChunks).toString("utf8");
  }

  test("`lore version` prints the build version and exits cleanly", async () => {
    const out = await runWith(["version"]);
    expect(out.trim()).toBe(VERSION);
  });

  test("`lore help` prints the human help text", async () => {
    const out = await runWith(["help"]);
    // Phase 1: `lore help` delegates to the legacy `printHelp()` which
    // ships the comprehensive command list. Subsequent phases will replace
    // this with a Stricli-generated help derived from the route tree.
    expect(out).toContain("Commands:");
    expect(out).toContain("run");
    expect(out).toContain("setup");
  });

  test("`lore help --json` returns structured Phase-1 stub", async () => {
    const out = await runWith(["help", "--json"]);
    const parsed = JSON.parse(out.trim());
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.name).toBe("lore");
    expect(parsed.version).toBe(VERSION);
    expect(parsed.note).toMatch(/Phase 4/i);
  });

  test("`lore --version` (no subcommand) prints the build version", async () => {
    const out = await runWith(["--version"]);
    expect(out.trim()).toBe(VERSION);
  });

  test("`lore --help` (no subcommand) renders Stricli-generated help", async () => {
    // `--help` and `-h` are intercepted by Stricli's built-in help
    // generator, which prints the route tree + flags. Phase 4 will
    // customize the formatter; for now the contract is that `--help`
    // works and prints the help for the route tree we registered.
    const out = await runWith(["--help"]);
    expect(out).toContain("help");
    expect(out).toContain("version");
    expect(out).toMatch(/COMMANDS|Commands:/);
  });
});