import { describe, expect, it, vi } from "vitest";
import {
  buildStartChildArgs,
  daemonLogPath,
  daemonProbeHost,
  daemonSpawnSpec,
  realDaemonIO,
  runDaemon,
  type DaemonIO,
} from "../src/cli/start";
import { removePortFile } from "../src/portfile";
import {
  readGatewayProcessFile,
  removeGatewayProcessFile,
  type GatewayProcessRecord,
} from "../src/pidfile";

const RECORD: GatewayProcessRecord = {
  version: 1,
  pid: 4242,
  port: 3207,
  hosts: ["127.0.0.1"],
  token: "a".repeat(32),
};

function makeDaemonIO(overrides: Partial<DaemonIO> = {}) {
  const info: string[] = [];
  const errors: string[] = [];
  let spawnCount = 0;
  const io: DaemonIO = {
    readProcess: () => null,
    authenticate: async () => null,
    probeHealth: async () => false,
    spawnDaemon: () => {
      spawnCount += 1;
      return 4242;
    },
    inspectProcess: () => ({
      state: "alive",
      identity: "child-generation",
    }),
    terminate: () => {},
    removeProcess: () => {},
    removePort: () => {},
    sleep: async () => {},
    now: () => 0,
    logInfo: (message) => info.push(message),
    logError: (message) => errors.push(message),
    ...overrides,
  };
  return { io, info, errors, spawned: () => spawnCount };
}

describe("daemon arguments", () => {
  it("reconstructs stable child arguments without daemonizing recursively", () => {
    expect(
      buildStartChildArgs({
        bg: true,
        port: 3207,
        hosts: ["127.0.0.1", "100.64.0.1"],
        debug: true,
        local: true,
        allowRemoteManagement: true,
        remoteUrl: "http://remote:3207",
      }),
    ).toEqual([
      "start",
      "--port",
      "3207",
      "--host",
      "127.0.0.1",
      "--host",
      "100.64.0.1",
      "--debug",
      "--local",
      "--allow-remote-management",
      "--remote",
      "http://remote:3207",
    ]);
    expect(buildStartChildArgs({ bg: true })).not.toContain("--bg");
  });

  it("uses process.execPath and prepends the script outside SEA", () => {
    const spec = daemonSpawnSpec({ port: 3299 });
    expect(spec.command).toBe(process.execPath);
    expect(spec.args[0]).toBe(process.argv[1]);
    expect(spec.args).toContain("start");
  });

  it("retains the host and log-path compatibility helpers", () => {
    expect(daemonProbeHost({})).toBe("127.0.0.1");
    expect(daemonProbeHost({ hosts: ["", "10.0.0.5"] })).toBe("10.0.0.5");
    expect(daemonLogPath()).toMatch(/gateway\.log$/);
  });
});

describe("runDaemon authenticated lifecycle", () => {
  it("reuses only an authenticated process record", async () => {
    const { io, info, spawned } = makeDaemonIO({
      readProcess: () => RECORD,
      authenticate: async () => "127.0.0.1",
    });
    expect(await runDaemon({}, io)).toBe(0);
    expect(spawned()).toBe(0);
    expect(info.join("\n")).toContain("already running");
  });

  it("spawns, polls, and reports an authenticated child record", async () => {
    let reads = 0;
    const { io, info, spawned } = makeDaemonIO({
      readProcess: () => (reads++ === 0 ? null : { ...RECORD, port: 3299 }),
      authenticate: async (record) => record.hosts[0],
    });
    expect(await runDaemon({ port: 3299 }, io)).toBe(0);
    expect(spawned()).toBe(1);
    expect(info.join("\n")).toContain("pid 4242");
    expect(info.join("\n")).toContain("3299");
  });

  it("does not reuse public-health spoofing on an explicit port", async () => {
    const { io, spawned, errors } = makeDaemonIO({
      readProcess: () => null,
      probeHealth: async () => true,
    });
    expect(await runDaemon({ port: 3207 }, io)).toBe(1);
    expect(spawned()).toBe(0);
    expect(errors.join("\n")).toContain("not an authenticated lore gateway");
  });

  it("terminates a timed-out child and cleans only its exact record", async () => {
    let now = 0;
    let alive = true;
    const signals: string[] = [];
    let removedProcess = false;
    let removedPort = false;
    const childRecord = {
      ...RECORD,
      version: 2 as const,
      processIdentity: "child-generation",
    };
    const { io, errors } = makeDaemonIO({
      readProcess: () => childRecord,
      authenticate: async () => null,
      now: () => (now += 5000),
      timeoutMs: 10_000,
      inspectProcess: () =>
        alive
          ? { state: "alive", identity: "child-generation" }
          : { state: "dead" },
      terminate: (_pid, signal) => {
        signals.push(signal);
        alive = false;
      },
      removeProcess: () => {
        removedProcess = true;
      },
      removePort: () => {
        removedPort = true;
      },
    });
    expect(await runDaemon({}, io)).toBe(1);
    expect(signals).toEqual(["SIGTERM"]);
    expect(removedProcess).toBe(true);
    expect(removedPort).toBe(true);
    expect(errors.join("\n")).toContain("terminated background pid 4242");
  });

  it("reports unknown state when SIGTERM/SIGKILL cannot confirm exit", async () => {
    let now = 0;
    const signals: string[] = [];
    const { io, errors } = makeDaemonIO({
      now: () => (now += 5000),
      timeoutMs: 10_000,
      cleanupTimeoutMs: 1000,
      inspectProcess: () => ({
        state: "alive",
        identity: "child-generation",
      }),
      terminate: (_pid, signal) => signals.push(signal),
    });
    expect(await runDaemon({}, io)).toBe(1);
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(errors.join("\n")).toContain("unknown child state");
  });

  it("does not signal a reused PID before SIGTERM", async () => {
    let now = 0;
    let inspections = 0;
    const signals: string[] = [];
    const { io, errors } = makeDaemonIO({
      now: () => (now += 5000),
      timeoutMs: 10_000,
      inspectProcess: () => ({
        state: "alive",
        identity: inspections++ === 0 ? "child-generation" : "successor",
      }),
      terminate: (_pid, signal) => signals.push(signal),
    });

    expect(await runDaemon({}, io)).toBe(1);
    expect(signals).toEqual([]);
    expect(errors.join("\n")).toContain("spawned process generation");
  });

  it("revalidates generation before SIGKILL and never signals a successor", async () => {
    let now = 0;
    let inspections = 0;
    const signals: string[] = [];
    const { io } = makeDaemonIO({
      now: () => (now += 5000),
      timeoutMs: 10_000,
      cleanupTimeoutMs: 0,
      inspectProcess: () => ({
        state: "alive",
        identity: inspections++ < 4 ? "child-generation" : "successor",
      }),
      terminate: (_pid, signal) => signals.push(signal),
    });

    expect(await runDaemon({}, io)).toBe(1);
    expect(signals).toEqual(["SIGTERM"]);
  });

  it("fails closed when the spawned process generation is unverifiable", async () => {
    let now = 0;
    const signals: string[] = [];
    const { io, errors } = makeDaemonIO({
      now: () => (now += 5000),
      timeoutMs: 10_000,
      inspectProcess: () => ({ state: "alive", identity: null }),
      terminate: (_pid, signal) => signals.push(signal),
    });

    expect(await runDaemon({}, io)).toBe(1);
    expect(signals).toEqual([]);
    expect(errors.join("\n")).toContain("unknown child state");
  });
});

describe("realDaemonIO", () => {
  it("wires production discovery and cleanup dependencies", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const io = realDaemonIO({ port: 3299 });
      expect(io.readProcess).toBe(readGatewayProcessFile);
      expect(io.removeProcess).toBe(removeGatewayProcessFile);
      expect(io.removePort).toBe(removePortFile);
      expect(typeof io.spawnDaemon).toBe("function");
      expect(typeof io.terminate).toBe("function");
      await io.sleep(0);
      io.logInfo("hello");
      io.logError("oops");
      expect(log).toHaveBeenCalledWith("[lore] hello");
      expect(error).toHaveBeenCalledWith("[lore] oops");
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });
});
