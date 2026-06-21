import { describe, it, expect, vi } from "vitest";
import { planStop, runStop, realStopIO, type StopIO } from "../src/cli/stop";
import { readPidFile } from "../src/pidfile";

function makeStopIO(overrides: Partial<StopIO> = {}): {
  io: StopIO;
  info: string[];
  errors: string[];
  killed: () => number[];
  removed: () => number[];
} {
  const info: string[] = [];
  const errors: string[] = [];
  const killed: number[] = [];
  const removed: number[] = [];
  const io: StopIO = {
    readPid: () => null,
    readPort: () => null,
    probe: async () => false,
    isAlive: () => false,
    kill: (pid) => killed.push(pid),
    removePid: (pid) => removed.push(pid),
    sleep: async () => {},
    now: () => 0,
    logInfo: (m) => info.push(m),
    logError: (m) => errors.push(m),
    ...overrides,
  };
  return { io, info, errors, killed: () => killed, removed: () => removed };
}

describe("planStop", () => {
  it("signals a live PID", () => {
    expect(
      planStop({ pid: 4242, pidAlive: true, port: 3207, portAlive: true }),
    ).toEqual({ action: "signal", pid: 4242 });
  });

  it("prefers signalling the PID even when the port is also alive", () => {
    expect(
      planStop({ pid: 4242, pidAlive: true, port: 3207, portAlive: true })
        .action,
    ).toBe("signal");
  });

  it("reports a foreground gateway when the PID is dead but the port answers", () => {
    expect(
      planStop({ pid: 4242, pidAlive: false, port: 3207, portAlive: true }),
    ).toEqual({ action: "foreground", port: 3207 });
  });

  it("reports a foreground gateway when there is no PID file but the port answers", () => {
    expect(
      planStop({ pid: null, pidAlive: false, port: 3207, portAlive: true }),
    ).toEqual({ action: "foreground", port: 3207 });
  });

  it("treats a dead PID with no live port as stale", () => {
    expect(
      planStop({ pid: 4242, pidAlive: false, port: null, portAlive: false }),
    ).toEqual({ action: "stale", pid: 4242 });
  });

  it("treats a dead PID with a dead port as stale", () => {
    expect(
      planStop({ pid: 4242, pidAlive: false, port: 3207, portAlive: false }),
    ).toEqual({ action: "stale", pid: 4242 });
  });

  it("reports nothing running when there is no PID and no live port", () => {
    expect(
      planStop({ pid: null, pidAlive: false, port: null, portAlive: false }),
    ).toEqual({ action: "none" });
  });
});

describe("runStop", () => {
  it("signals a live PID and reports success once it exits", async () => {
    let aliveChecks = 0;
    const { io, info, killed, removed } = makeStopIO({
      readPid: () => 4242,
      // planStop sees it alive; the wait loop then sees it die.
      isAlive: () => aliveChecks++ < 1,
    });
    const code = await runStop(io);
    expect(code).toBe(0);
    expect(killed()).toEqual([4242]);
    expect(removed()).toEqual([4242]);
    expect(info.join("\n")).toContain("Gateway stopped (pid 4242)");
  });

  it("returns 1 when the signalled process never exits", async () => {
    let t = 0;
    const { io, errors } = makeStopIO({
      readPid: () => 4242,
      isAlive: () => true, // never dies
      now: () => (t += 4000),
      timeoutMs: 5000,
    });
    const code = await runStop(io);
    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("did not stop");
  });

  it("reports a foreground gateway (live port, no PID) and returns 1", async () => {
    const { io, errors } = makeStopIO({
      readPid: () => null,
      readPort: () => 3207,
      probe: async () => true,
    });
    const code = await runStop(io);
    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("no PID file");
  });

  it("cleans up a stale PID file and returns 0", async () => {
    const { io, info, removed } = makeStopIO({
      readPid: () => 4242,
      isAlive: () => false, // dead
    });
    const code = await runStop(io);
    expect(code).toBe(0);
    expect(removed()).toEqual([4242]);
    expect(info.join("\n")).toContain("stale PID file");
  });

  it("reports nothing running and returns 0", async () => {
    const { io, info } = makeStopIO();
    const code = await runStop(io);
    expect(code).toBe(0);
    expect(info.join("\n")).toContain("No running gateway found");
  });
});

describe("realStopIO", () => {
  it("wires real dependencies (without killing anything)", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const io = realStopIO();
      expect(io.readPid).toBe(readPidFile);
      expect(typeof io.kill).toBe("function"); // not invoked here
      expect(io.now()).toBeGreaterThan(0);
      await io.sleep(0);
      io.logInfo("hi");
      io.logError("no");
      expect(log).toHaveBeenCalledWith("[lore] hi");
      expect(err).toHaveBeenCalledWith("[lore] no");
    } finally {
      log.mockRestore();
      err.mockRestore();
    }
  });
});
