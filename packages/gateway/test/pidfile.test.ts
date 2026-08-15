import { chmodSync, lstatSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dataDir } from "@loreai/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  inspectGatewayProcessFile,
  inspectPidFile,
  isProcessAlive,
  readGatewayProcessFile,
  readLegacyPidFile,
  readPidFile,
  removeGatewayProcessFile,
  removeLegacyPidFile,
  removePidFile,
  writeGatewayProcessFile,
  writePidFile,
} from "../src/pidfile";

let base: string;
let previousXdg: string | undefined;

beforeEach(() => {
  previousXdg = process.env.XDG_DATA_HOME;
  base = mkdtempSync(join(tmpdir(), "lore-pidfile-test-"));
  process.env.XDG_DATA_HOME = base;
});

afterEach(() => {
  if (previousXdg === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = previousXdg;
  rmSync(base, { recursive: true, force: true });
});

describe("pidfile", () => {
  it("distinguishes absent, legacy, authenticated, and invalid evidence", () => {
    expect(inspectPidFile()).toEqual({ state: "absent" });
    expect(inspectGatewayProcessFile()).toEqual({ state: "absent" });

    writePidFile(4242);
    expect(readPidFile()).toBe(4242);
    expect(readGatewayProcessFile()).toBeNull();
    expect(inspectPidFile()).toMatchObject({
      state: "legacy",
      record: { pid: 4242 },
    });
    expect(inspectGatewayProcessFile()).toMatchObject({ state: "invalid" });

    const record = {
      version: 2 as const,
      pid: 5353,
      port: 3207,
      hosts: ["127.0.0.1", "::1"],
      token: "secret".repeat(8),
      processIdentity: "generation-one",
    };
    writeGatewayProcessFile(record);
    expect(readPidFile()).toBe(record.pid);
    expect(readGatewayProcessFile()).toEqual(record);
    expect(inspectPidFile()).toEqual({ state: "process", record });
    expect(inspectGatewayProcessFile()).toEqual({ state: "valid", record });

    writePidFile(0);
    expect(readPidFile()).toBeNull();
    expect(inspectPidFile()).toMatchObject({ state: "invalid" });
  });

  it("writes owner-only files and atomically overwrites legacy values", () => {
    writePidFile(4242);
    writePidFile(5353);
    expect(readPidFile()).toBe(5353);
    if (process.platform !== "win32") {
      chmodSync(join(dataDir(), "gateway.pid"), 0o666);
      writePidFile(6464);
      expect(lstatSync(join(dataDir(), "gateway.pid")).mode & 0o777).toBe(
        0o600,
      );
    }
  });

  it("removePidFile removes only a matching PID", () => {
    writePidFile(5353);
    removePidFile(4242);
    expect(readPidFile()).toBe(5353);
    removePidFile(5353);
    expect(readPidFile()).toBeNull();
    expect(() => removePidFile(5353)).not.toThrow();
  });

  it("token/identity cleanup preserves a same-PID successor", () => {
    const predecessor = {
      version: 2 as const,
      pid: 4242,
      port: 3207,
      hosts: ["127.0.0.1"],
      token: "predecessor".repeat(4),
      processIdentity: "generation-one",
    };
    const successor = {
      ...predecessor,
      token: "successor".repeat(4),
      processIdentity: "generation-two",
    };
    writeGatewayProcessFile(successor);
    removeGatewayProcessFile(predecessor);
    expect(readGatewayProcessFile()).toEqual(successor);
  });

  it("legacy identity cleanup preserves a same-PID replacement", () => {
    writePidFile(4242);
    const predecessor = readLegacyPidFile();
    if (!predecessor) throw new Error("missing legacy PID fixture");
    writePidFile(4242);
    expect(removeLegacyPidFile(predecessor)).toBe("changed");
    expect(readPidFile()).toBe(4242);
    expect(readLegacyPidFile()?.identity).not.toEqual(predecessor.identity);
  });

  it("requires loopback hosts when destructive discovery requests it", () => {
    const record = {
      version: 2 as const,
      pid: 4242,
      port: 3207,
      hosts: ["192.0.2.1"],
      token: "a".repeat(32),
      processIdentity: "generation-one",
    };
    writeGatewayProcessFile(record);
    expect(inspectGatewayProcessFile()).toEqual({ state: "valid", record });
    expect(
      inspectGatewayProcessFile({ requireLoopbackHosts: true }),
    ).toMatchObject({ state: "invalid" });
  });

  it("reports current and non-existent process liveness", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(2147483646)).toBe(false);
  });
});
