import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { planStop, realStopIO, runStop, type StopIO } from "../src/cli/stop";
import {
  inspectPidFile,
  readLegacyPidFile,
  readPidFile,
  removePidFile,
  writePidFile,
  type GatewayProcessRecord,
  type LegacyPidFileRecord,
} from "../src/pidfile";

const PROCESS_IDENTITY = "test-process-generation";
const PROCESS_RECORD: GatewayProcessRecord = {
  version: 2,
  pid: 4242,
  port: 3207,
  hosts: ["127.0.0.1"],
  token: "a".repeat(32),
  processIdentity: PROCESS_IDENTITY,
};

let base: string;
let previousXdg: string | undefined;

beforeEach(() => {
  previousXdg = process.env.XDG_DATA_HOME;
  base = mkdtempSync(join(tmpdir(), "lore-stop-test-"));
  process.env.XDG_DATA_HOME = base;
});

afterEach(() => {
  vi.restoreAllMocks();
  if (previousXdg === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = previousXdg;
  rmSync(base, { recursive: true, force: true });
});

function legacyPid(pid: number): LegacyPidFileRecord {
  return {
    pid,
    identity: {
      device: 1n,
      inode: 2n,
      size: 4n,
      mtimeNs: 5n,
      ctimeNs: 6n,
      birthtimeNs: 7n,
    },
  };
}

function makeStopIO(overrides: Partial<StopIO> = {}) {
  const info: string[] = [];
  const errors: string[] = [];
  const killed: number[] = [];
  const removed: number[] = [];
  const io: StopIO = {
    inspectPidFile: () => ({ state: "absent" }),
    readRecord: () => null,
    readPort: () => null,
    authenticate: async () => false,
    requestShutdown: async () => "failed",
    probeHealth: async () => false,
    isAlive: () => false,
    kill: (pid) => killed.push(pid),
    removeRecord: (record) => removed.push(record.pid),
    removeLegacyPid: (record) => {
      removed.push(record.pid);
      return "removed";
    },
    sleep: async () => {},
    now: () => 0,
    logInfo: (message) => info.push(message),
    logError: (message) => errors.push(message),
    ...overrides,
  };
  return { io, info, errors, killed, removed };
}

describe("planStop", () => {
  it("signals only an authenticated live PID", () => {
    expect(
      planStop({
        pid: 4242,
        pidState: "alive",
        port: 3207,
        portAlive: true,
        pidMatchesGateway: true,
      }),
    ).toEqual({ action: "signal", pid: 4242 });
    expect(
      planStop({
        pid: 4242,
        pidState: "alive",
        port: null,
        portAlive: false,
        pidMatchesGateway: false,
      }),
    ).toEqual({ action: "uncertain", pid: 4242 });
  });

  it("distinguishes foreground, stale, uncertain, and absent states", () => {
    expect(
      planStop({
        pid: null,
        pidState: "dead",
        port: 3207,
        portAlive: true,
        pidMatchesGateway: false,
      }),
    ).toEqual({ action: "foreground", port: 3207 });
    expect(
      planStop({
        pid: 4242,
        pidState: "dead",
        port: null,
        portAlive: false,
        pidMatchesGateway: false,
      }),
    ).toEqual({ action: "stale", pid: 4242 });
    expect(
      planStop({
        pid: 4242,
        pidState: "unknown",
        port: null,
        portAlive: false,
        pidMatchesGateway: false,
      }),
    ).toEqual({ action: "uncertain", pid: 4242 });
    expect(
      planStop({
        pid: null,
        pidState: "dead",
        port: null,
        portAlive: false,
        pidMatchesGateway: false,
      }),
    ).toEqual({ action: "none" });
  });
});

describe("runStop", () => {
  it("reauthenticates and rechecks process identity immediately before signal", async () => {
    let inspections = 0;
    const { io, info, killed, removed } = makeStopIO({
      inspectPidFile: () => ({ state: "process", record: PROCESS_RECORD }),
      readRecord: () => PROCESS_RECORD,
      authenticate: async () => true,
      requestShutdown: async () => "unsupported",
      inspectProcess: () =>
        inspections++ < 2
          ? { state: "alive", identity: PROCESS_IDENTITY }
          : { state: "dead" },
    });
    expect(await runStop(io)).toBe(0);
    expect(killed).toEqual([4242]);
    expect(removed).toEqual([4242]);
    expect(info.join("\n")).toContain("Gateway stopped (pid 4242)");
  });

  it("does not signal when PID generation changes after authentication", async () => {
    const { io, errors, killed } = makeStopIO({
      inspectPidFile: () => ({ state: "process", record: PROCESS_RECORD }),
      readRecord: () => PROCESS_RECORD,
      authenticate: async () => true,
      requestShutdown: async () => "unsupported",
      inspectProcess: () => ({
        state: "alive",
        identity: "reused-pid-generation",
      }),
    });
    expect(await runStop(io)).toBe(1);
    expect(killed).toEqual([]);
    expect(errors.join("\n")).toContain("changed before signalling");
  });

  it("succeeds without signalling when authenticated shutdown removes an unverifiable generation", async () => {
    const unverifiedRecord: GatewayProcessRecord = {
      ...PROCESS_RECORD,
      processIdentity: `unverified:${PROCESS_RECORD.token}`,
    };
    let record: GatewayProcessRecord | null = unverifiedRecord;
    let now = 0;
    const { io, info, killed } = makeStopIO({
      inspectPidFile: () => ({ state: "process", record: unverifiedRecord }),
      readRecord: () => record,
      authenticate: async () => true,
      requestShutdown: async () => "accepted",
      inspectProcess: () => ({ state: "alive", identity: null }),
      sleep: async (ms) => {
        now += ms;
        record = null;
      },
      now: () => now,
    });
    expect(await runStop(io)).toBe(0);
    expect(killed).toEqual([]);
    expect(info.join("\n")).toContain("Gateway stopped (pid 4242)");
  });

  it("does not remove or signal a token replacement raced into the request", async () => {
    const replacement = {
      ...PROCESS_RECORD,
      token: "b".repeat(32),
    };
    let record: GatewayProcessRecord | null = PROCESS_RECORD;
    const { io, errors, killed, removed } = makeStopIO({
      inspectPidFile: () => ({ state: "process", record: PROCESS_RECORD }),
      readRecord: () => record,
      authenticate: async () => true,
      requestShutdown: async () => {
        record = replacement;
        return "accepted";
      },
      inspectProcess: () => ({ state: "alive", identity: PROCESS_IDENTITY }),
    });
    expect(await runStop(io)).toBe(1);
    expect(killed).toEqual([]);
    expect(removed).toEqual([]);
    expect(record).toBe(replacement);
    expect(errors.join("\n")).toContain("changed during the shutdown request");
  });

  it("preserves the exact record without signalling when graceful shutdown fails", async () => {
    const { io, errors, killed, removed } = makeStopIO({
      inspectPidFile: () => ({ state: "process", record: PROCESS_RECORD }),
      readRecord: () => PROCESS_RECORD,
      authenticate: async () => true,
      requestShutdown: async () => {
        throw new Error("injected request failure");
      },
      inspectProcess: () => ({ state: "alive", identity: PROCESS_IDENTITY }),
    });
    expect(await runStop(io)).toBe(1);
    expect(killed).toEqual([]);
    expect(removed).toEqual([]);
    expect(errors.join("\n")).toContain("preserving the process record");
  });

  it("preserves a live generation when control authentication is unavailable", async () => {
    const { io, errors, killed, removed } = makeStopIO({
      inspectPidFile: () => ({ state: "process", record: PROCESS_RECORD }),
      readRecord: () => PROCESS_RECORD,
      authenticate: async () => false,
      inspectProcess: () => ({ state: "alive", identity: PROCESS_IDENTITY }),
    });
    expect(await runStop(io)).toBe(1);
    expect(killed).toEqual([]);
    expect(removed).toEqual([]);
    expect(errors.join("\n")).toContain("preserving its process record");
  });

  it("preserves a legacy PID that becomes live before stale cleanup", async () => {
    let inspections = 0;
    const { io, errors, killed, removed } = makeStopIO({
      inspectPidFile: () => ({ state: "legacy", record: legacyPid(4242) }),
      inspectProcess: () =>
        inspections++ === 0
          ? { state: "dead" }
          : { state: "alive", identity: "reused-pid-generation" },
    });
    expect(await runStop(io)).toBe(1);
    expect(killed).toEqual([]);
    expect(removed).toEqual([]);
    expect(errors.join("\n")).toContain("preserving its process record");
  });

  it("cleans an exact dead legacy generation and reports foreground/absent", async () => {
    const stale = makeStopIO({
      inspectPidFile: () => ({ state: "legacy", record: legacyPid(4242) }),
    });
    expect(await runStop(stale.io)).toBe(0);
    expect(stale.removed).toEqual([4242]);

    const foreground = makeStopIO({
      readPort: () => 3207,
      probeHealth: async () => true,
    });
    expect(await runStop(foreground.io)).toBe(1);
    expect(foreground.errors.join("\n")).toContain("no matching PID");

    const absent = makeStopIO();
    expect(await runStop(absent.io)).toBe(0);
    expect(absent.info.join("\n")).toContain("No running gateway found");
  });

  it("fails closed on invalid PID evidence", async () => {
    const { io, errors, killed, removed } = makeStopIO({
      inspectPidFile: () => ({
        state: "invalid",
        reason: "PID file changed while reading",
      }),
    });
    expect(await runStop(io)).toBe(1);
    expect(killed).toEqual([]);
    expect(removed).toEqual([]);
    expect(errors.join("\n")).toContain("preserving it");
  });
});

describe("realStopIO", () => {
  it("wires production inspection and removes an exact stale legacy record", async () => {
    const pid = 2147483646;
    writePidFile(pid);
    const io = realStopIO();
    expect(io.inspectPidFile).toBe(inspectPidFile);
    io.readPort = () => null;
    io.inspectProcess = () => ({ state: "dead" });
    io.logInfo = () => {};
    io.logError = () => {};
    expect(await runStop(io)).toBe(0);
    expect(readPidFile()).toBeNull();
  });

  it("preserves a same-PID replacement raced into stale cleanup", async () => {
    const pid = 2147483646;
    writePidFile(pid);
    const observed = readLegacyPidFile();
    let inspections = 0;
    const errors: string[] = [];
    const io = realStopIO();
    io.readPort = () => null;
    io.inspectProcess = () => {
      inspections += 1;
      if (inspections === 2) writePidFile(pid);
      return { state: "dead" };
    };
    io.logInfo = () => {};
    io.logError = (message) => errors.push(message);
    expect(await runStop(io)).toBe(1);
    expect(readPidFile()).toBe(pid);
    expect(readLegacyPidFile()?.identity).not.toEqual(observed?.identity);
    expect(errors.join("\n")).toContain("changed before stale cleanup");
    removePidFile(pid);
  });
});
