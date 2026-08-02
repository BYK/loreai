/**
 * Phase 3B — typed `lore stop` contract.
 *
 * The legacy `commandStop` reads PID/port files and signals processes.
 * Tests stub the PID file, port file, and signal machinery so the
 * command runs hermetically. The adapter captures stdout/stderr and
 * derives `action` from the log lines.
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

vi.mock("../src/cli/lib/version-check", () => ({
  shouldSuppressNotification: () => true,
  maybeCheckForUpdateInBackground: () => {},
  getUpdateNotification: () => null,
  abortPendingVersionCheck: () => {},
}));

// Mutable state used by the realPidFile / realPortFile mocks.
const state = vi.hoisted(() => ({
  pid: null as number | null,
  port: null as number | null,
  pidAlive: false,
  portAlive: false,
  killed: [] as number[],
  removed: [] as number[],
}));

vi.mock("../src/pidfile", () => ({
  readPidFile: () => state.pid,
  removePidFile: (pid: number) => {
    state.removed.push(pid);
  },
  isProcessAlive: (pid: number) => pid === state.pid && state.pidAlive,
}));

vi.mock("../src/portfile", () => ({
  readPortFile: () => state.port,
}));

vi.mock("../src/cli/start", () => ({
  probeGateway: async (url: string) => {
    if (!state.port) return false;
    return state.portAlive && url.endsWith(`:${state.port}`);
  },
}));

import { runCli } from "../src/cli/cli";

async function runWith(argv: string[]): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number | null;
}> {
  process.argv = ["node", "lore", ...argv];
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
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
  const stderrSpy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk) => {
      stderrChunks.push(
        Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)),
      );
      return true;
    });
  const priorExitCode = process.exitCode;
  process.exitCode = 0;
  try {
    await runCli();
  } finally {
    logSpy.mockRestore();
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  }
  const exitCode = process.exitCode;
  process.exitCode = priorExitCode;
  return {
    stdout: Buffer.concat(stdoutChunks).toString("utf8"),
    stderr: Buffer.concat(stderrChunks).toString("utf8"),
    exitCode,
  };
}

describe("Phase 3B — typed lore stop", () => {
  const origArgv = process.argv;
  const origNoUpdateCheck = process.env.LORE_NO_UPDATE_CHECK;
  const realProcessKill = process.kill;

  beforeEach(() => {
    state.pid = null;
    state.port = null;
    state.pidAlive = false;
    state.portAlive = false;
    state.killed.length = 0;
    state.removed.length = 0;
    process.env.LORE_NO_UPDATE_CHECK = "1";
    // Stub process.kill so the legacy command signals our fake PID without
    // affecting the test runner.
    process.kill = ((pid: number, signal?: NodeJS.Signals): true => {
      state.killed.push(pid);
      if (signal === "SIGTERM" && pid === state.pid) state.pidAlive = false;
      return true;
    }) as typeof process.kill;
  });

  afterEach(() => {
    process.argv = origArgv;
    process.kill = realProcessKill;
  });

  afterAll(() => {
    if (origNoUpdateCheck === undefined) delete process.env.LORE_NO_UPDATE_CHECK;
    else process.env.LORE_NO_UPDATE_CHECK = origNoUpdateCheck;
  });

  test("nothing running → action: none, ok: true", async () => {
    const { stdout, exitCode } = await runWith(["stop"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("No running gateway found");
  });

  test("live PID → action: stopped, signals the PID, ok: true", async () => {
    state.pid = 4242;
    state.pidAlive = true;
    const { stdout, exitCode } = await runWith(["stop"]);
    expect(exitCode).toBe(0);
    expect(state.killed).toEqual([4242]);
    expect(stdout).toContain("Gateway stopped (pid 4242)");
  });

  test("--json returns structured payload with action: stopped", async () => {
    state.pid = 1234;
    state.pidAlive = true;
    const { stdout, exitCode } = await runWith(["stop", "--json"]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.action).toBe("stopped");
    expect(parsed.pid).toBe(1234);
    expect(parsed.ok).toBe(true);
  });

  test("stale PID file → action: stale, removes the file, ok: true", async () => {
    state.pid = 9999;
    state.pidAlive = false;
    state.port = null;
    const { stdout, exitCode } = await runWith(["stop"]);
    expect(exitCode).toBe(0);
    expect(state.removed).toEqual([9999]);
    expect(stdout).toContain("stale PID file");
  });
});