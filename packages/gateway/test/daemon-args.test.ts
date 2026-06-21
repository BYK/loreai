import { describe, it, expect } from "vitest";
import { buildStartChildArgs } from "../src/cli/start";

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
