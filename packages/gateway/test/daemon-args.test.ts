import { describe, it, expect, vi } from "vitest";
import {
  buildStartChildArgs,
  daemonProbeHost,
  daemonSpawnSpec,
  daemonLogPath,
  runDaemon,
  realDaemonIO,
  type DaemonIO,
} from "../src/cli/start";
import { readPortFile } from "../src/portfile";

/** Build a DaemonIO with sensible defaults, overridable per test. */
function makeDaemonIO(overrides: Partial<DaemonIO> = {}): {
  io: DaemonIO;
  info: string[];
  errors: string[];
  spawned: () => number;
} {
  const info: string[] = [];
  const errors: string[] = [];
  let spawnCount = 0;
  const io: DaemonIO = {
    readPort: () => null,
    probe: async () => false,
    spawnDaemon: () => {
      spawnCount++;
      return 4242;
    },
    sleep: async () => {},
    now: () => 0,
    logInfo: (m) => info.push(m),
    logError: (m) => errors.push(m),
    ...overrides,
  };
  return { io, info, errors, spawned: () => spawnCount };
}

describe("buildStartChildArgs", () => {
  it("always starts with the `start` command", () => {
    expect(buildStartChildArgs({})[0]).toBe("start");
  });

  it("never includes the daemonize flag (--bg / --daemon)", () => {
    // Even though the parent was invoked with --bg, the detached child must
    // run a plain foreground `start` or it would fork forever.
    const args = buildStartChildArgs({ bg: true, port: 3207 });
    expect(args).not.toContain("--bg");
    expect(args).not.toContain("--daemon");
  });

  it("reconstructs --port", () => {
    expect(buildStartChildArgs({ port: 8080 })).toEqual([
      "start",
      "--port",
      "8080",
    ]);
  });

  it("reconstructs multiple --host flags (one per host)", () => {
    const args = buildStartChildArgs({ hosts: ["127.0.0.1", "100.64.0.1"] });
    expect(args).toEqual([
      "start",
      "--host",
      "127.0.0.1",
      "--host",
      "100.64.0.1",
    ]);
  });

  it("reconstructs --debug only when true", () => {
    expect(buildStartChildArgs({ debug: true })).toContain("--debug");
    expect(buildStartChildArgs({ debug: false })).not.toContain("--debug");
  });

  it("reconstructs --local only when true", () => {
    expect(buildStartChildArgs({ local: true })).toContain("--local");
    expect(buildStartChildArgs({ local: false })).not.toContain("--local");
  });

  it("reconstructs --remote", () => {
    expect(buildStartChildArgs({ remoteUrl: "http://remote:3207" })).toEqual([
      "start",
      "--remote",
      "http://remote:3207",
    ]);
  });

  it("combines all options in a stable order", () => {
    const args = buildStartChildArgs({
      bg: true,
      port: 3207,
      hosts: ["127.0.0.1"],
      debug: true,
      local: true,
    });
    expect(args).toEqual([
      "start",
      "--port",
      "3207",
      "--host",
      "127.0.0.1",
      "--debug",
      "--local",
    ]);
  });

  it("emits just `start` for empty options", () => {
    expect(buildStartChildArgs({})).toEqual(["start"]);
  });
});

describe("daemonProbeHost", () => {
  it("defaults to loopback when no host is configured", () => {
    expect(daemonProbeHost({})).toBe("127.0.0.1");
    expect(daemonProbeHost({ hosts: [] })).toBe("127.0.0.1");
  });

  it("uses the first configured host (Seer #875: non-loopback bind)", () => {
    expect(daemonProbeHost({ hosts: ["100.64.0.1"] })).toBe("100.64.0.1");
  });

  it("skips empty host entries", () => {
    expect(daemonProbeHost({ hosts: ["", "10.0.0.5"] })).toBe("10.0.0.5");
  });
});

describe("daemonSpawnSpec", () => {
  it("uses process.execPath and includes the reconstructed start args", () => {
    const spec = daemonSpawnSpec({ port: 3299 });
    expect(spec.command).toBe(process.execPath);
    // In dev/test (not a SEA binary) the script path is prepended.
    expect(spec.args[0]).toBe(process.argv[1]);
    expect(spec.args).toContain("start");
    expect(spec.args).toContain("3299");
    expect(spec.args).not.toContain("--bg");
  });
});

describe("daemonLogPath", () => {
  it("points at gateway.log in the data dir", () => {
    expect(daemonLogPath().endsWith("gateway.log")).toBe(true);
  });
});

describe("runDaemon", () => {
  it("reuses an already-running gateway without spawning", async () => {
    const { io, info, spawned } = makeDaemonIO({
      readPort: () => 3207,
      probe: async () => true,
    });
    const code = await runDaemon({}, io);
    expect(code).toBe(0);
    expect(spawned()).toBe(0);
    expect(info.join("\n")).toContain("already running");
  });

  it("probes the configured non-loopback host (Seer #875)", async () => {
    const { io, info } = makeDaemonIO({
      readPort: () => 3207,
      probe: async (url) => url.includes("100.64.0.1"),
    });
    const code = await runDaemon({ hosts: ["100.64.0.1"] }, io);
    expect(code).toBe(0);
    expect(info.join("\n")).toContain("100.64.0.1:3207");
  });

  it("reuses a loopback gateway when configured for a non-overlapping host (issue #908)", async () => {
    // The existing gateway is reachable on 127.0.0.1 only; we asked for a
    // Tailscale/LAN IP nothing is bound to. The reuse-check must probe 127.0.0.1
    // in ADDITION to the configured host, find the gateway, and adopt it WITHOUT
    // spawning a child — otherwise the child's own pre-bind probe would
    // reuse-and-exit, leaving us polling 100.64.0.1 until the deadline.
    let t = 0;
    const { io, info, spawned } = makeDaemonIO({
      readPort: () => 3207,
      probe: async (url) => url.includes("127.0.0.1"),
      // Advance the clock so that a *regressed* spawn+poll path terminates
      // (times out) instead of hanging the test on a constant now() === 0.
      now: () => (t += 5000),
      timeoutMs: 10_000,
    });
    const code = await runDaemon({ hosts: ["100.64.0.1"] }, io);
    expect(code).toBe(0);
    expect(spawned()).toBe(0);
    expect(info.join("\n")).toContain("already running");
    expect(info.join("\n")).toContain("127.0.0.1:3207");

    // Regression guard: a single-host reuse-check (probing only the configured
    // 100.64.0.1) returns false → spawns a child → polls 100.64.0.1 forever →
    // times out (code 1, spawned 1), failing the assertions above.
  });

  it("spawns, polls, and reports the healthy gateway", async () => {
    let portCalls = 0;
    const { io, info, spawned } = makeDaemonIO({
      // existing-check → no port yet; first poll → port present
      readPort: () => (portCalls++ === 0 ? null : 3299),
      probe: async () => true,
    });
    const code = await runDaemon({ port: 3299 }, io);
    expect(code).toBe(0);
    expect(spawned()).toBe(1);
    expect(info.join("\n")).toContain("pid 4242");
    expect(info.join("\n")).toContain("3299");
  });

  it("brackets IPv6 hosts in the health-poll URL (Seer, PR #920)", async () => {
    // The post-spawn polling loop must bracket IPv6 literals via probeUrlFor:
    // a raw `http://${host}:${port}` template yields the malformed
    // `http://::1:3207`, the probe never connects, and the daemon times out.
    let t = 0;
    let portCalls = 0;
    let probedUrl = "";
    const { io, spawned } = makeDaemonIO({
      // existing-check → no port yet; first poll → port present
      readPort: () => (portCalls++ === 0 ? null : 3207),
      probe: async (url) => {
        probedUrl = url;
        return url.includes("[::1]");
      },
      // Advance the clock so the regressed (unbracketed) path times out
      // instead of hanging on a constant now() === 0.
      now: () => (t += 5000),
      timeoutMs: 10_000,
    });
    const code = await runDaemon({ hosts: ["::1"] }, io);
    expect(code).toBe(0);
    expect(spawned()).toBe(1);
    expect(probedUrl).toBe("http://[::1]:3207");
  });

  it("returns 1 and logs an error on health-poll timeout", async () => {
    let t = 0;
    const { io, errors, spawned } = makeDaemonIO({
      readPort: () => 3299,
      probe: async () => false, // never healthy
      now: () => (t += 5000), // 5000, 10000, 15000 → past the 10s deadline
      timeoutMs: 10_000,
    });
    const code = await runDaemon({}, io);
    expect(code).toBe(1);
    expect(spawned()).toBe(1);
    expect(errors.join("\n")).toContain("did not become healthy");
  });
});

describe("realDaemonIO", () => {
  it("wires real dependencies (without spawning)", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const io = realDaemonIO({ port: 3299 });
      expect(io.readPort).toBe(readPortFile);
      expect(typeof io.spawnDaemon).toBe("function"); // not invoked here
      expect(io.now()).toBeGreaterThan(0);
      await io.sleep(0);
      io.logInfo("hello");
      io.logError("oops");
      expect(log).toHaveBeenCalledWith("[lore] hello");
      expect(err).toHaveBeenCalledWith("[lore] oops");
    } finally {
      log.mockRestore();
      err.mockRestore();
    }
  });
});
