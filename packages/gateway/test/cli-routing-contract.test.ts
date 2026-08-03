/**
 * Phase 0 contract tests — `lore run` argv forwarding.
 *
 * Freezes the current parser's pass-through behavior so the Stricli migration
 * can swap the implementation without changing semantics. The test matrix
 * comes directly from the production `extractAgentArgs` contract documented at
 * `packages/gateway/src/cli/main.ts:43-88`.
 *
 * Harness:
 *  - Mocks `@loreai/core` so the gateway, database, embeddings, and node:sqlite
 *    worker are never started.
 *  - Stubs `safeExit`/`forcedExit` so the process can return to the runner.
 *  - Stubs `version-check` so no network calls happen.
 *  - Stubs every lazy command module so we can assert which handler was
 *    dispatched, with which `(startOpts, agentName, agentArgs)` payload.
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

// Hoisted mocks run before module imports. Each test can steer what `commandRun`
// reports, then assert which argv reached it.
const runSpy = vi.hoisted(() =>
  vi.fn(async (_opts: unknown, _agent: string[], _args: string[]) => {}),
);
const safeExit = vi.hoisted(() => vi.fn());
const forcedExit = vi.hoisted(() => vi.fn());

vi.mock("@loreai/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@loreai/core")>();
  return {
    ...actual,
    // The check-vec / check-embeddings / check-read-offload branches never
    // appear in run argv forwarding — leaving no-op stubs here is fine.
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

// Stub the safeExit helpers — process.exit is a no-op so the harness can keep
// running additional cases.
vi.mock("../src/cli/exit", () => ({ safeExit, forcedExit }));

// Stub background update checks and notifications — these run as fire-and-forget
// timers and would otherwise spawn network requests.
vi.mock("../src/cli/lib/version-check", () => ({
  shouldSuppressNotification: () => true,
  maybeCheckForUpdateInBackground: () => {},
  getUpdateNotification: () => null,
  abortPendingVersionCheck: () => {},
}));

// Stub every command module the dispatcher lazy-imports. The agent-launch path
// is the one we exercise here.
vi.mock("../src/cli/run", () => ({ commandRun: runSpy }));

import { _cli } from "../src/cli/main";

describe("Phase 0 — lore run argv forwarding contract", () => {
  const origArgv = process.argv;
  const origNoUpdateCheck = process.env.LORE_NO_UPDATE_CHECK;

  beforeEach(() => {
    runSpy.mockClear();
    safeExit.mockClear();
    forcedExit.mockClear();
    process.env.LORE_NO_UPDATE_CHECK = "1";
  });

  afterEach(() => {
    process.argv = origArgv;
  });

  afterAll(() => {
    if (origNoUpdateCheck === undefined)
      delete process.env.LORE_NO_UPDATE_CHECK;
    else process.env.LORE_NO_UPDATE_CHECK = origNoUpdateCheck;
  });

  async function runWith(argv: string[]): Promise<void> {
    process.argv = ["node", "lore", ...argv];
    await _cli();
  }

  function lastRunCall(): {
    opts: unknown;
    agent: string[];
    args: string[];
  } {
    const calls = runSpy.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const last = calls[calls.length - 1];
    return {
      opts: last[0],
      agent: last[1],
      args: last[2],
    };
  }

  test("no args defaults to `run` with no agent", async () => {
    await runWith([]);
    const call = lastRunCall();
    expect(call.agent).toEqual([]);
    expect(call.args).toEqual([]);
  });

  test("explicit `run` with no agent forwards nothing", async () => {
    await runWith(["run"]);
    const call = lastRunCall();
    expect(call.agent).toEqual([]);
    expect(call.args).toEqual([]);
  });

  test("explicit agent: `run claude` forwards no agent argv", async () => {
    await runWith(["run", "claude"]);
    const call = lastRunCall();
    expect(call.agent).toEqual(["claude"]);
    expect(call.args).toEqual([]);
  });

  test("explicit agent + value-bearing flag: `run opencode --model gpt-4`", async () => {
    await runWith(["run", "opencode", "--model", "gpt-4"]);
    const call = lastRunCall();
    expect(call.agent).toEqual(["opencode"]);
    expect(call.args).toEqual(["--model", "gpt-4"]);
  });

  test("explicit agent + boolean flag: `run claude --verbose`", async () => {
    await runWith(["run", "claude", "--verbose"]);
    const call = lastRunCall();
    expect(call.agent).toEqual(["claude"]);
    expect(call.args).toEqual(["--verbose"]);
  });

  test("auto-detect: unknown boolean flag forwarded to default agent", async () => {
    await runWith(["--dangerously-skip-permissions"]);
    const call = lastRunCall();
    expect(call.agent).toEqual([]);
    expect(call.args).toEqual(["--dangerously-skip-permissions"]);
  });

  test("auto-detect: lore-known flag before agent flags is NOT forwarded", async () => {
    // `-d` is lore's `--debug`. It must be consumed by lore and NOT appear in
    // agentArgs, even though auto-detect normally forwards unknown flags.
    await runWith(["-d", "--dangerously-skip-permissions"]);
    const call = lastRunCall();
    expect(call.agent).toEqual([]);
    expect(call.args).toEqual(["--dangerously-skip-permissions"]);
  });

  test("`--` terminator: everything after is forwarded verbatim", async () => {
    await runWith(["run", "claude", "--", "--port", "8080", "--debug"]);
    const call = lastRunCall();
    expect(call.agent).toEqual(["claude"]);
    expect(call.args).toEqual(["--port", "8080", "--debug"]);
  });

  // Known limitation: the current `extractAgentArgs` only forwards tokens after
  // `--` if there is also an agent selected. With `--` alone, parseArgs
  // consumes known flags (e.g. `--debug`) before reaching the terminator,
  // and any remaining unknown token becomes a positional — ending up as an
  // "Unknown command" error instead of agent args. Phase 1 (Stricli + an
  // opaque agent-argv preprocessor) MUST fix this; until then the test
  // records the regression so the migration cannot ship without addressing it.
  test("`--` alone with no agent: forwards everything after the terminator (KNOWN LIMITATION)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await runWith(["--", "--verbose", "--debug"]);
      // Today this prints "Unknown command `--verbose`" to stderr and does
      // NOT forward agent args. The contract test pins this so the Stricli
      // migration can flip the assertion when it fixes the bug.
      expect(runSpy).not.toHaveBeenCalled();
      const messages = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(messages).toMatch(/Unknown command/i);
    } finally {
      errSpy.mockRestore();
    }
  });

  test("root shorthand: `lore claude` becomes `run claude`", async () => {
    await runWith(["claude"]);
    const call = lastRunCall();
    expect(call.agent).toEqual(["claude"]);
    expect(call.args).toEqual([]);
  });

  test("root shorthand: `lore claude --dangerously-skip-permissions` forwards flag", async () => {
    await runWith(["claude", "--dangerously-skip-permissions"]);
    const call = lastRunCall();
    expect(call.agent).toEqual(["claude"]);
    expect(call.args).toEqual(["--dangerously-skip-permissions"]);
  });

  test("value-bearing flag value is NOT split into a positional", async () => {
    // `lore --port 8080 claude` — lore consumes --port (the value becomes
    // 8080), and claude should still receive the trailing flag-forwarded args.
    await runWith([
      "--port",
      "8080",
      "claude",
      "--dangerously-skip-permissions",
    ]);
    const call = lastRunCall();
    expect(call.agent).toEqual(["claude"]);
    expect(call.args).toEqual(["--dangerously-skip-permissions"]);
  });
});
