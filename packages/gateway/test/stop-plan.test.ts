import { describe, it, expect } from "vitest";
import { planStop } from "../src/cli/stop";

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
