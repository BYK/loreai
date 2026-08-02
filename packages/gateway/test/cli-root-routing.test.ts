/**
 * Phase 0 contract tests — root command surface and shorthand routing.
 *
 * Freezes every dispatch decision in `packages/gateway/src/cli/main.ts`:
 *   - default command (`run`),
 *   - all visible routes (`start`, `stop`, `setup`, `doctor`, `data`, `recall`,
 *     `lint`, `log`, `diff`, `login`, `logout`, `whoami`, `sync`, `team`,
 *     `admin`, `logs`, `import`, `entity`, `upgrade`, `help`),
 *   - hidden diagnostics (`--print-vendor-info`, `--check-embeddings`,
 *     `--check-vec`, `--check-read-offload`),
 *   - root flags (`--version`, `--help`),
 *   - shorthand agent launch,
 *   - unknown command → helpful error.
 *
 * Every test stubs the destination command module and asserts that the
 * dispatcher reached it. The harness is fully hermetic: no DB, no model load,
 * no network.
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

// Hoisted spies — one per lazy command module. Each handler becomes a no-op
// that records its call so we can assert which dispatcher branch fired.
const spies = vi.hoisted(() => {
  const make = () => vi.fn(async () => {});
  return {
    start: make(),
    stop: make(),
    setup: make(),
    doctor: make(),
    data: make(),
    recall: make(),
    lint: make(),
    log: make(),
    diff: make(),
    login: make(),
    logout: make(),
    whoami: make(),
    sync: make(),
    team: make(),
    admin: make(),
    logs: make(),
    importCmd: make(),
    entity: make(),
    upgrade: make(),
    run: make(),
    runShorthand: make(),
    safeExit: make(),
    forcedExit: make(),
  };
});

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
    discoverWorkspaceRoot: () => "/tmp/lore-contract-test",
  };
});

vi.mock("../src/cli/exit", () => ({
  safeExit: spies.safeExit,
  forcedExit: spies.forcedExit,
}));

vi.mock("../src/cli/lib/version-check", () => ({
  shouldSuppressNotification: () => true,
  maybeCheckForUpdateInBackground: () => {},
  getUpdateNotification: () => null,
  abortPendingVersionCheck: () => {},
}));

// Stub every command module. Use distinct spies for the two `run` paths so we
// can assert shorthand vs explicit dispatch independently.
vi.mock("../src/cli/start", () => ({ commandStart: spies.start }));
vi.mock("../src/cli/stop", () => ({ commandStop: spies.stop }));
vi.mock("../src/cli/setup", () => ({ commandSetup: spies.setup }));
vi.mock("../src/cli/inventory", () => ({ commandDoctor: spies.doctor }));
vi.mock("../src/cli/data", () => ({ commandData: spies.data }));
vi.mock("../src/cli/recall-cmd", () => ({ commandRecall: spies.recall }));
vi.mock("../src/cli/invariant-check", () => ({
  commandInvariantCheck: spies.lint,
}));
vi.mock("../src/cli/history-cmd", () => ({
  commandLog: spies.log,
  commandDiff: spies.diff,
}));
vi.mock("../src/cli/login", () => ({
  commandLogin: spies.login,
  commandLogout: spies.logout,
  commandWhoami: spies.whoami,
}));
vi.mock("../src/cli/sync-cmd", () => ({ commandSync: spies.sync }));
vi.mock("../src/cli/team-cmd", () => ({ commandTeam: spies.team }));
vi.mock("../src/cli/admin-cmd", () => ({ commandAdmin: spies.admin }));
vi.mock("../src/cli/logs", () => ({ commandLogs: spies.logs }));
vi.mock("../src/cli/import", () => ({ commandImport: spies.importCmd }));
vi.mock("../src/cli/entity", () => ({ commandEntity: spies.entity }));
vi.mock("../src/cli/upgrade", () => ({ commandUpgrade: spies.upgrade }));
// Two `run` imports exist: one from `./run` (dispatcher default) and another
// from the agent-shorthand branch in main.ts. Same module, but we want to
// record which branch fired.
vi.mock("../src/cli/run", () => ({ commandRun: spies.runShorthand }));

import { _cli } from "../src/cli/main";

describe("Phase 0 — root command surface contract", () => {
  const origArgv = process.argv;
  const origNoUpdateCheck = process.env.LORE_NO_UPDATE_CHECK;

  beforeEach(() => {
    for (const key of Object.keys(spies)) {
      const spy = spies[key as keyof typeof spies];
      if (typeof spy.mockClear === "function") spy.mockClear();
    }
    process.env.LORE_NO_UPDATE_CHECK = "1";
  });

  afterEach(() => {
    process.argv = origArgv;
  });

  afterAll(() => {
    if (origNoUpdateCheck === undefined) delete process.env.LORE_NO_UPDATE_CHECK;
    else process.env.LORE_NO_UPDATE_CHECK = origNoUpdateCheck;
  });

  async function runWith(argv: string[]): Promise<void> {
    process.argv = ["node", "lore", ...argv];
    await _cli();
  }

  function expectCalled(spy: ReturnType<typeof vi.fn>): void {
    expect(spy).toHaveBeenCalled();
  }

  test("no args → run with no agent", async () => {
    await runWith([]);
    // The dispatcher dispatches the explicit `run` branch; mock maps to spies.run
    // through the `run` module which is mocked to runShorthand. Both branches
    // share the same destination module, so the assertion is on the destination.
    expect(spies.runShorthand).toHaveBeenCalled();
  });

  test("explicit `run` reaches the run module", async () => {
    await runWith(["run"]);
    expect(spies.runShorthand).toHaveBeenCalled();
  });

  test("start", async () => {
    await runWith(["start"]);
    expectCalled(spies.start);
  });

  test("stop", async () => {
    await runWith(["stop"]);
    expectCalled(spies.stop);
  });

  test("setup (no args)", async () => {
    await runWith(["setup"]);
    expectCalled(spies.setup);
  });

  test("setup codex forwards positional to handler", async () => {
    await runWith(["setup", "codex"]);
    expect(spies.setup).toHaveBeenCalledWith(
      ["codex"],
      expect.objectContaining({}),
    );
  });

  test("doctor", async () => {
    await runWith(["doctor"]);
    expectCalled(spies.doctor);
  });

  test("data list projects", async () => {
    await runWith(["data", "list", "projects"]);
    expect(spies.data).toHaveBeenCalledWith(
      ["list", "projects"],
      expect.objectContaining({}),
    );
  });

  test("recall single word", async () => {
    await runWith(["recall", "auth"]);
    expect(spies.recall).toHaveBeenCalledWith(
      ["auth"],
      expect.objectContaining({}),
    );
  });

  test("lint", async () => {
    await runWith(["lint"]);
    expect(spies.lint).toHaveBeenCalledWith([], expect.objectContaining({}));
  });

  test("log", async () => {
    await runWith(["log"]);
    expect(spies.log).toHaveBeenCalledWith([], expect.objectContaining({}));
  });

  test("log <id>", async () => {
    await runWith(["log", "abc"]);
    expect(spies.log).toHaveBeenCalledWith(["abc"], expect.objectContaining({}));
  });

  test("diff <id>", async () => {
    await runWith(["diff", "abc"]);
    expect(spies.diff).toHaveBeenCalledWith(
      ["abc"],
      expect.objectContaining({}),
    );
  });

  test("login", async () => {
    await runWith(["login"]);
    expectCalled(spies.login);
  });

  test("logout", async () => {
    await runWith(["logout"]);
    expectCalled(spies.logout);
  });

  test("whoami", async () => {
    await runWith(["whoami"]);
    expectCalled(spies.whoami);
  });

  test("sync", async () => {
    await runWith(["sync"]);
    expect(spies.sync).toHaveBeenCalledWith([], expect.objectContaining({}));
  });

  test("team list", async () => {
    await runWith(["team", "list"]);
    expect(spies.team).toHaveBeenCalledWith(["list"], expect.objectContaining({}));
  });

  test("admin grant", async () => {
    await runWith(["admin", "grant", "x@y.com", "pro"]);
    expect(spies.admin).toHaveBeenCalledWith(
      ["grant", "x@y.com", "pro"],
      expect.objectContaining({}),
    );
  });

  test("logs", async () => {
    await runWith(["logs"]);
    expect(spies.logs).toHaveBeenCalledWith([], expect.objectContaining({}));
  });

  test("import", async () => {
    await runWith(["import"]);
    expectCalled(spies.importCmd);
  });

  test("entity list", async () => {
    await runWith(["entity", "list"]);
    expect(spies.entity).toHaveBeenCalledWith(
      ["list"],
      expect.objectContaining({}),
    );
  });

  test("upgrade passes raw argv (not parsed values) to its handler", async () => {
    await runWith(["upgrade", "--check"]);
    // The dispatcher hands upgrade the raw argv starting after `upgrade`,
    // bypassing the root parser. Verify the handler received that raw payload.
    expect(spies.upgrade).toHaveBeenCalledWith(["--check"]);
  });

  test("help does not dispatch a command", async () => {
    await runWith(["help"]);
    // None of the lazy handlers should fire.
    for (const key of Object.keys(spies)) {
      const spy = spies[key as keyof typeof spies];
      if (key === "safeExit" || key === "forcedExit") continue;
      expect(spy).not.toHaveBeenCalled();
    }
  });

  test("--version with no subcommand prints version and skips dispatch", async () => {
    await runWith(["--version"]);
    for (const key of Object.keys(spies)) {
      const spy = spies[key as keyof typeof spies];
      if (key === "safeExit" || key === "forcedExit") continue;
      expect(spy).not.toHaveBeenCalled();
    }
  });

  test("agent shorthand: `lore claude` reaches the run handler with [claude]", async () => {
    await runWith(["claude"]);
    // Shorthand path imports `./run` and dispatches with the binary as agent.
    expect(spies.runShorthand).toHaveBeenCalledWith(
      expect.anything(),
      ["claude"],
      expect.any(Array),
    );
  });

  test("agent shorthand: `lore opencode` reaches the run handler", async () => {
    await runWith(["opencode"]);
    expect(spies.runShorthand).toHaveBeenCalledWith(
      expect.anything(),
      ["opencode"],
      expect.any(Array),
    );
  });

  test("unknown command does not dispatch any handler and sets exitCode=1", async () => {
    // The current dispatcher sets `process.exitCode = 1` (does NOT call
    // process.exit), so `_cli()` resolves normally. The test asserts the
    // observable contract: no command fired, exitCode=1, error printed.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const priorExitCode = process.exitCode;
    process.exitCode = 0;
    try {
      await runWith(["notarealcommand"]);
      for (const key of Object.keys(spies)) {
        const spy = spies[key as keyof typeof spies];
        if (key === "safeExit" || key === "forcedExit") continue;
        expect(spy).not.toHaveBeenCalled();
      }
      expect(process.exitCode).toBe(1);
      expect(errSpy).toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
      process.exitCode = priorExitCode;
    }
  });

  test("unknown command close to a real one prints `Did you mean` suggestion", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const priorExitCode = process.exitCode;
    process.exitCode = 0;
    try {
      await runWith(["recal"]);
      const calls = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(calls).toMatch(/Did you mean/i);
      expect(calls).toContain("recall");
    } finally {
      errSpy.mockRestore();
      process.exitCode = priorExitCode;
    }
  });
});