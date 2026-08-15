import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readGatewayProcessFile,
  writeGatewayProcessFile,
} from "../src/pidfile";
import { readPortFile, writePortFile } from "../src/portfile";
import { openDaemonLogFile } from "../src/cli/start";
import {
  _setRuntimeFileWindowsSecurityForTest,
  readRuntimeFile,
  type RuntimeFileWindowsSecurityRequest,
  type RuntimeFileWindowsSecurityResult,
} from "../src/runtime-files";

const RECORD = {
  version: 1 as const,
  pid: 4242,
  port: 3207,
  hosts: ["127.0.0.1"],
  token: "a".repeat(32),
};

describe.skipIf(process.platform === "win32")("gateway runtime files", () => {
  let base: string;
  let previousXdg: string | undefined;

  beforeEach(() => {
    previousXdg = process.env.XDG_DATA_HOME;
    base = mkdtempSync(join(tmpdir(), "lore-runtime-test-"));
    process.env.XDG_DATA_HOME = base;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (previousXdg === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previousXdg;
    rmSync(base, { recursive: true, force: true });
  });

  const runtimeDir = () => join(base, "lore");

  it("creates owner-only runtime records in an owner-only directory", () => {
    writePortFile(3207);
    writeGatewayProcessFile(RECORD);
    expect(lstatSync(runtimeDir()).mode & 0o777).toBe(0o700);
    expect(lstatSync(join(runtimeDir(), "gateway.port")).mode & 0o777).toBe(
      0o600,
    );
    expect(lstatSync(join(runtimeDir(), "gateway.pid")).mode & 0o777).toBe(
      0o600,
    );
  });

  it("tightens an existing runtime directory before writing", () => {
    mkdirSync(runtimeDir(), { recursive: true, mode: 0o777 });
    chmodSync(runtimeDir(), 0o777);
    writePortFile(3207);
    expect(lstatSync(runtimeDir()).mode & 0o777).toBe(0o700);
  });

  it("rejects a symlink used as the runtime data directory", () => {
    const target = join(base, "target");
    mkdirSync(target);
    symlinkSync(target, runtimeDir(), "dir");
    expect(() => writePortFile(3207)).toThrow(/non-directory runtime data/);
    expect(existsSync(join(target, "gateway.port"))).toBe(false);
  });

  it("atomically replaces runtime-record symlinks without touching targets", () => {
    mkdirSync(runtimeDir(), { mode: 0o700 });
    const portTarget = join(base, "victim-port");
    const pidTarget = join(base, "victim-pid");
    writeFileSync(portTarget, "preserve port target");
    writeFileSync(pidTarget, "preserve pid target");
    symlinkSync(portTarget, join(runtimeDir(), "gateway.port"));
    symlinkSync(pidTarget, join(runtimeDir(), "gateway.pid"));

    writePortFile(3207);
    writeGatewayProcessFile(RECORD);

    expect(readFileSync(portTarget, "utf8")).toBe("preserve port target");
    expect(readFileSync(pidTarget, "utf8")).toBe("preserve pid target");
    expect(lstatSync(join(runtimeDir(), "gateway.port")).isSymbolicLink()).toBe(
      false,
    );
    expect(lstatSync(join(runtimeDir(), "gateway.pid")).isSymbolicLink()).toBe(
      false,
    );
    expect(readPortFile()).toBe(3207);
    expect(readGatewayProcessFile()).toEqual(RECORD);
  });

  it("appends to an existing log and tightens its permissions", () => {
    mkdirSync(runtimeDir(), { mode: 0o700 });
    const logPath = join(runtimeDir(), "gateway.log");
    writeFileSync(logPath, "before");
    chmodSync(logPath, 0o666);
    const fd = openDaemonLogFile();
    try {
      writeSync(fd, " after");
    } finally {
      closeSync(fd);
    }
    expect(readFileSync(logPath, "utf8")).toBe("before after");
    expect(lstatSync(logPath).mode & 0o777).toBe(0o600);
  });

  it("rejects unsafe daemon log targets", () => {
    mkdirSync(runtimeDir(), { mode: 0o700 });
    const target = join(base, "victim.log");
    writeFileSync(target, "preserve");
    symlinkSync(target, join(runtimeDir(), "gateway.log"));
    expect(() => openDaemonLogFile()).toThrow(/non-regular runtime file/);
    expect(readFileSync(target, "utf8")).toBe("preserve");
  });

  it("rejects runtime paths owned by another user", () => {
    if (typeof process.getuid !== "function") return;
    mkdirSync(runtimeDir(), { mode: 0o700 });
    const uid = process.getuid();
    vi.spyOn(process, "getuid").mockReturnValue(uid + 1);
    expect(() => writePortFile(3207)).toThrow(/not owned by the current user/);
  });
});

const WINDOWS_PRIVATE_RESULT: RuntimeFileWindowsSecurityResult = {
  status: 0,
  signal: null,
  stdout: "LORE_RUNTIME_ACL_PRIVATE\n",
  stderr: "",
};

describe("Windows gateway runtime ACLs", () => {
  let base: string;
  let customDataHome: string;
  let previousXdg: string | undefined;

  beforeEach(() => {
    previousXdg = process.env.XDG_DATA_HOME;
    base = mkdtempSync(join(tmpdir(), "lore-windows-runtime-test-"));
    customDataHome = join(base, "User & (private)! data");
    mkdirSync(customDataHome);
    process.env.XDG_DATA_HOME = customDataHome;
  });

  afterEach(() => {
    _setRuntimeFileWindowsSecurityForTest(null);
    vi.restoreAllMocks();
    if (previousXdg === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previousXdg;
    rmSync(base, { recursive: true, force: true });
  });

  const installWindowsSecurity = (
    run: (
      request: RuntimeFileWindowsSecurityRequest,
    ) => RuntimeFileWindowsSecurityResult,
  ): void => {
    _setRuntimeFileWindowsSecurityForTest({
      platform: "win32",
      powershellPath:
        "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      run,
    });
  };

  it("publishes and reads records only after private ACL validation", () => {
    const requests: RuntimeFileWindowsSecurityRequest[] = [];
    installWindowsSecurity((request) => {
      requests.push(request);
      if (request.kind === "file" && request.action === "secure") {
        // The replayable token must not be written before the DACL is private.
        expect(readFileSync(request.path, "utf8")).toBe("");
      }
      return WINDOWS_PRIVATE_RESULT;
    });

    const token = "private-token".repeat(4);
    const record = { ...RECORD, token };
    writePortFile(record.port, token);
    writeGatewayProcessFile(record);

    expect(readPortFile()).toBe(record.port);
    expect(readGatewayProcessFile()).toEqual(record);
    expect(
      requests.some(
        ({ action, kind }) => action === "secure" && kind === "directory",
      ),
    ).toBe(true);
    expect(
      requests.filter(
        ({ action, kind }) => action === "secure" && kind === "file",
      ),
    ).toHaveLength(2);
    expect(
      requests.some(
        ({ action, kind }) => action === "verify" && kind === "file",
      ),
    ).toBe(true);
    for (const request of requests) {
      // Paths (and therefore usernames) travel through the child environment,
      // never through a command line or shell-interpreted script fragment.
      expect(request.args).not.toContain(request.path);
      expect(request.env.LORE_RUNTIME_ACL_PATH).toBe(request.path);
    }
  });

  it("refuses to read a token-bearing record with a broad DACL", () => {
    installWindowsSecurity(() => WINDOWS_PRIVATE_RESULT);
    writeGatewayProcessFile(RECORD);

    installWindowsSecurity((request) =>
      request.kind === "file" && request.action === "verify"
        ? {
            status: 1,
            signal: null,
            stdout: "",
            stderr: "runtime ACL contains a broad access rule",
          }
        : WINDOWS_PRIVATE_RESULT,
    );

    expect(() => readRuntimeFile("gateway.pid", { ownerOnly: true })).toThrow(
      /broad access rule/,
    );
    expect(readGatewayProcessFile()).toBeNull();
  });

  it("does not publish record content when a private file DACL cannot be established", () => {
    installWindowsSecurity((request) =>
      request.kind === "file" && request.action === "secure"
        ? {
            status: 1,
            signal: null,
            stdout: "",
            stderr: "runtime ACL remains inherited",
          }
        : WINDOWS_PRIVATE_RESULT,
    );

    expect(() => writeGatewayProcessFile(RECORD)).toThrow(
      /runtime ACL remains inherited/,
    );
    expect(readdirSync(join(customDataHome, "lore"))).toEqual([]);
  });

  it("fails closed and leaves no record when the Windows ACL command fails", () => {
    const commandError = Object.assign(new Error("spawn failed"), {
      code: "ENOENT",
    });
    installWindowsSecurity(() => ({
      status: null,
      signal: null,
      stdout: "",
      stderr: "",
      error: commandError,
    }));

    expect(() => writeGatewayProcessFile(RECORD)).toThrow(
      /Windows runtime ACL command failed/,
    );
    expect(existsSync(join(customDataHome, "lore", "gateway.pid"))).toBe(false);
  });

  it("rejects a runtime directory replaced during ACL establishment", () => {
    let replaced = false;
    installWindowsSecurity((request) => {
      if (
        !replaced &&
        request.kind === "directory" &&
        request.action === "secure"
      ) {
        replaced = true;
        renameSync(request.path, `${request.path}.replaced`);
        mkdirSync(request.path);
      }
      return WINDOWS_PRIVATE_RESULT;
    });

    expect(() => writeGatewayProcessFile(RECORD)).toThrow(
      /changed while opening/,
    );
    expect(existsSync(join(customDataHome, "lore", "gateway.pid"))).toBe(false);
  });
});
