import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  _setSetupExternalEffectHookForTest,
  commandSetup,
  setupExternalEffectJournalPath,
} from "../src/cli/setup";
import {
  _setStagedTrustedFileCommitHookForTest,
  _setTrustedDirectoryFsyncHookForTest,
  _setTrustedFileCommitHookForTest,
  _setTrustedFilePublishHookForTest,
  atomicWriteTrustedFile,
  readTrustedTextFile,
  removeTrustedFile,
} from "../src/cli/json-config";
import {
  lifecycleLockPath,
  LifecycleLockLostError,
  withLifecycleLock,
} from "../src/lifecycle-lock";

interface FileState {
  bytes: Buffer | null;
  mode: number | null;
}

let home: string;
let originalHome: string | undefined;
let originalPath: string | undefined;
let logSpy: MockInstance;
let errorSpy: MockInstance;

function claudePath(): string {
  return join(home, ".claude", "settings.json");
}

function readState(file: string): FileState {
  if (!existsSync(file)) return { bytes: null, mode: null };
  return {
    bytes: readFileSync(file),
    mode: lstatSync(file).mode & 0o7777,
  };
}

function expectState(file: string, expected: FileState): void {
  expect(readState(file)).toEqual(expected);
}

function installFakeNpm(
  state: "installed" | "absent" | "unknown",
  installStatus = 0,
  logPath = join(home, "npm.log"),
): void {
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, "npm"),
    `#!/bin/sh
printf '%s\n' "$*" >> '${logPath}'
if [ "$1" = "ls" ]; then
  ${state === "installed" ? `printf '%s\n' '{"dependencies":{"@loreai/opencode":{}}}'; exit 0` : state === "absent" ? `printf '%s\n' '{"dependencies":{}}'; exit 0` : `printf '%s\n' 'not-json'; exit 2`}
fi
if [ "$1" = "install" ]; then
  exit ${installStatus}
fi
exit 0
`,
    { mode: 0o755 },
  );
  process.env.PATH = `${bin}:${originalPath ?? ""}`;
}

function installFakeAgent(binary: string): void {
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, binary), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
}

function useOnlyFakePath(): void {
  process.env.PATH = join(home, "bin");
}

interface FakeNpmPackageState {
  state: "absent" | "installed";
  version?: string;
  source?: string;
}

interface FakeNpmGeneration {
  packageDevice: string;
  packageInode: string;
  packageMtimeNs: string;
  packageCtimeNs: string;
  manifestDevice: string;
  manifestInode: string;
  manifestMtimeNs: string;
  manifestCtimeNs: string;
}

const FAKE_INSTALLED_PACKAGE: FakeNpmPackageState = {
  state: "installed",
  version: "9.9.9",
  source: "https://registry.example/@loreai/opencode/-/opencode-9.9.9.tgz",
};

function installStatefulFakeNpm(options: {
  initial: FakeNpmPackageState;
  installStatus?: number;
  uninstallStatus?: number;
}): void {
  const bin = join(home, "bin");
  const statePath = join(home, "npm-state.json");
  const logPath = join(home, "npm.log");
  const npmRoot = join(home, "npm-global", "node_modules");
  const packagePath = join(npmRoot, "@loreai", "opencode");
  mkdirSync(bin, { recursive: true });
  mkdirSync(npmRoot, { recursive: true });
  if (options.initial.state === "installed") {
    mkdirSync(packagePath, { recursive: true });
    writeFileSync(
      join(packagePath, "package.json"),
      JSON.stringify({
        name: "@loreai/opencode",
        version: options.initial.version,
      }),
    );
  }
  writeFileSync(statePath, JSON.stringify(options.initial));
  writeFileSync(
    join(bin, "npm"),
    `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const statePath = ${JSON.stringify(statePath)};
const logPath = ${JSON.stringify(logPath)};
const npmRoot = ${JSON.stringify(npmRoot)};
const packagePath = ${JSON.stringify(packagePath)};
const npmPackage = "@loreai/opencode";
const installedPackage = ${JSON.stringify(FAKE_INSTALLED_PACKAGE)};
const installStatus = ${options.installStatus ?? 0};
const uninstallStatus = ${options.uninstallStatus ?? 0};
const args = process.argv.slice(2);
fs.appendFileSync(logPath, args.join(" ") + "\\n");
let state = JSON.parse(fs.readFileSync(statePath, "utf8"));
if (args[0] === "ls") {
  const dependencies = state.state === "installed"
    ? { [npmPackage]: { version: state.version, resolved: state.source, path: packagePath } }
    : {};
  process.stdout.write(JSON.stringify({ dependencies }));
  process.exit(0);
}
if (args[0] === "root") {
  process.stdout.write(npmRoot + "\\n");
  process.exit(0);
}
if (args[0] === "install") {
  if (installStatus === 0) {
    fs.rmSync(packagePath, { recursive: true, force: true });
    fs.mkdirSync(packagePath, { recursive: true });
    fs.writeFileSync(path.join(packagePath, "package.json"), JSON.stringify({ name: npmPackage, version: installedPackage.version }));
    state = installedPackage;
    fs.writeFileSync(statePath, JSON.stringify(state));
  }
  process.exit(installStatus);
}
if (args[0] === "uninstall") {
  if (uninstallStatus === 0) {
    fs.rmSync(packagePath, { recursive: true, force: true });
    fs.writeFileSync(statePath, JSON.stringify({ state: "absent" }));
  }
  process.exit(uninstallStatus);
}
process.exit(2);
`,
    { mode: 0o755 },
  );
  process.env.PATH = `${bin}:${originalPath ?? ""}`;
}

function fakeNpmPackagePath(): string {
  return join(home, "npm-global", "node_modules", "@loreai", "opencode");
}

function fakeNpmGeneration(): FakeNpmGeneration {
  const packageStats = lstatSync(fakeNpmPackagePath(), { bigint: true });
  const manifestStats = lstatSync(join(fakeNpmPackagePath(), "package.json"), {
    bigint: true,
  });
  return {
    packageDevice: packageStats.dev.toString(),
    packageInode: packageStats.ino.toString(),
    packageMtimeNs: packageStats.mtimeNs.toString(),
    packageCtimeNs: packageStats.ctimeNs.toString(),
    manifestDevice: manifestStats.dev.toString(),
    manifestInode: manifestStats.ino.toString(),
    manifestMtimeNs: manifestStats.mtimeNs.toString(),
    manifestCtimeNs: manifestStats.ctimeNs.toString(),
  };
}

function replaceFakeNpmGeneration(): void {
  rmSync(fakeNpmPackagePath(), { recursive: true, force: true });
  mkdirSync(fakeNpmPackagePath(), { recursive: true });
  writeFileSync(
    join(fakeNpmPackagePath(), "package.json"),
    JSON.stringify({
      name: "@loreai/opencode",
      version: FAKE_INSTALLED_PACKAGE.version,
    }),
  );
}

function publishFakeNpmSuccessorGeneration(): void {
  replaceFakeNpmGeneration();
  writeFileSync(
    join(home, "npm-state.json"),
    JSON.stringify(FAKE_INSTALLED_PACKAGE),
  );
}

function removeFakeNpmPackage(): void {
  rmSync(fakeNpmPackagePath(), { recursive: true, force: true });
  writeFileSync(
    join(home, "npm-state.json"),
    JSON.stringify({ state: "absent" }),
  );
}

function fakeNpmState(): FakeNpmPackageState {
  return JSON.parse(
    readFileSync(join(home, "npm-state.json"), "utf8"),
  ) as FakeNpmPackageState;
}

function fakeNpmCommands(): string[] {
  return readFileSync(join(home, "npm.log"), "utf8").trim().split("\n");
}

function loggedOutput(): string {
  return [...logSpy.mock.calls, ...errorSpy.mock.calls]
    .map((call) => call.join(" "))
    .join("\n");
}

function externalJournalPath(): string {
  return setupExternalEffectJournalPath(lifecycleLockPath());
}

function opencodePath(): string {
  return join(home, ".config", "opencode", "opencode.json");
}

function hermesPath(): string {
  return join(home, ".hermes", ".env");
}

function installAutoFailureAgents(): void {
  installFakeAgent("opencode");
  installFakeAgent("claude");
  installFakeAgent("hermes");
  useOnlyFakePath();
}

function seedAutoFailureConfigs(): {
  opencode: FileState;
  claude: FileState;
} {
  mkdirSync(dirname(opencodePath()), { recursive: true });
  writeFileSync(opencodePath(), '{"theme":"dark"}\n', { mode: 0o640 });
  mkdirSync(dirname(claudePath()), { recursive: true });
  writeFileSync(claudePath(), '{"theme":"light"}\n', { mode: 0o600 });
  return {
    opencode: readState(opencodePath()),
    claude: readState(claudePath()),
  };
}

function failClaudeSetup(message: string): void {
  _setTrustedFileCommitHookForTest((file) => {
    if (file === claudePath()) throw new Error(message);
  });
}

function runSigkillChild(operation: "setup" | "undo", commit: number): void {
  const child = spawnSync(
    process.execPath,
    [
      "--conditions=development",
      "--import",
      "tsx",
      join(import.meta.dirname, "setup-sigkill-child.ts"),
      "claude-code",
      operation,
      String(commit),
    ],
    {
      env: {
        ...process.env,
        HOME: home,
        LORE_CONFIG_DIR: join(home, ".lore"),
      },
      encoding: "utf8",
      // A source-loaded child can take over 30 seconds to boot when the full
      // suite saturates CI workers. Keep a finite hang guard without turning
      // ordinary scheduler contention into a recovery failure.
      timeout: 90_000,
    },
  );
  expect(child.error).toBeUndefined();
  expect(child.status, child.stderr).toBeNull();
  expect(child.signal).toBe("SIGKILL");
}

function runExternalEffectSigkillChild(
  phase:
    | "after-installed-journal"
    | "before-journal-cleanup" = "after-installed-journal",
): void {
  const child = spawnSync(
    process.execPath,
    [
      "--conditions=development",
      "--import",
      "tsx",
      join(import.meta.dirname, "setup-external-sigkill-child.ts"),
      phase,
    ],
    {
      env: {
        ...process.env,
        HOME: home,
        LORE_CONFIG_DIR: join(home, ".lore"),
      },
      encoding: "utf8",
      timeout: 90_000,
    },
  );
  expect(child.error).toBeUndefined();
  expect(child.status, child.stderr).toBeNull();
  expect(child.signal).toBe("SIGKILL");
}

beforeEach(() => {
  originalHome = process.env.HOME;
  originalPath = process.env.PATH;
  home = mkdtempSync(join(tmpdir(), "lore-setup-transaction-"));
  process.env.HOME = home;
  rmSync(externalJournalPath(), { force: true });
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
});

afterEach(() => {
  _setSetupExternalEffectHookForTest(null);
  _setStagedTrustedFileCommitHookForTest(null);
  _setTrustedDirectoryFsyncHookForTest(null);
  _setTrustedFileCommitHookForTest(null);
  _setTrustedFilePublishHookForTest(null);
  vi.unstubAllGlobals();
  logSpy.mockRestore();
  errorSpy.mockRestore();
  process.exitCode = undefined;
  rmSync(externalJournalPath(), { force: true });
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  rmSync(home, { recursive: true, force: true });
});

describe("setup transaction publication", () => {
  it("preserves a replacement created immediately before publication", () => {
    const file = join(home, "publish.json");
    writeFileSync(file, '{"before":true}\n');
    const expected = readTrustedTextFile(file)?.identity;
    if (!expected) throw new Error("missing fixture identity");
    _setTrustedFilePublishHookForTest((operation, path) => {
      if (operation !== "write" || path !== file) return;
      rmSync(file);
      writeFileSync(file, '{"replacement":true}\n');
    });

    expect(() =>
      atomicWriteTrustedFile(file, '{"lore":true}\n', {
        expectedIdentity: expected,
      }),
    ).toThrow("immediately before publication");
    expect(readFileSync(file, "utf8")).toBe('{"replacement":true}\n');
  });

  it("preserves a replacement created immediately before removal", () => {
    const file = join(home, "remove.json");
    writeFileSync(file, '{"before":true}\n');
    const expected = readTrustedTextFile(file)?.identity;
    if (!expected) throw new Error("missing fixture identity");
    _setTrustedFilePublishHookForTest((operation, path) => {
      if (operation !== "remove" || path !== file) return;
      rmSync(file);
      writeFileSync(file, '{"replacement":true}\n');
    });

    expect(() => removeTrustedFile(file, expected)).toThrow(
      "immediately before removal",
    );
    expect(readFileSync(file, "utf8")).toBe('{"replacement":true}\n');
  });

  it.each([1, 2, 3])(
    "restores config and sidecar exactly after commit %i fails",
    async (commit) => {
      mkdirSync(dirname(claudePath()), { recursive: true });
      writeFileSync(claudePath(), '{"theme":"dark"}\n', { mode: 0o640 });
      const sidecar = `${claudePath()}.lore-backup`;
      const beforeConfig = readState(claudePath());
      const beforeSidecar = readState(sidecar);
      _setTrustedFileCommitHookForTest((_file, current) => {
        if (current === commit) throw new Error(`failure after ${commit}`);
      });

      await expect(
        commandSetup(["claude-code"], { port: 3299 }),
      ).rejects.toThrow(`failure after ${commit}`);
      expectState(claudePath(), beforeConfig);
      expectState(sidecar, beforeSidecar);
    },
  );

  it("publishes journal, config, then strict v3 sidecar", async () => {
    const sidecar = `${claudePath()}.lore-backup`;
    const commits: string[] = [];
    _setTrustedFileCommitHookForTest((file) => commits.push(file));

    await commandSetup(["claude-code"], { port: 3299 });

    expect(commits).toEqual([sidecar, claudePath(), sidecar]);
    expect(JSON.parse(readFileSync(sidecar, "utf8")).version).toBe(3);
  });

  it("fails closed on unknown npm state without files or success reporting", async () => {
    installFakeNpm("unknown");
    const config = join(home, ".config", "opencode", "opencode.json");

    await commandSetup(["opencode"], { port: 3299 });

    expect(process.exitCode).toBe(1);
    expect(existsSync(dirname(config))).toBe(false);
    expect(existsSync(config)).toBe(false);
    expect(existsSync(`${config}.lore-backup`)).toBe(false);
    const output = [...logSpy.mock.calls, ...errorSpy.mock.calls]
      .map((call) => call.join(" "))
      .join("\n");
    expect(output).not.toContain("OpenCode configured");
    expect(output).not.toContain("Gateway is reachable");
    expect(output).not.toContain("Gateway is not reachable");
    expect(output).not.toContain("Tip: for terminal use");
  });

  it("reports explicit OpenCode setup failure without success or liveness output when npm install fails", async () => {
    installFakeNpm("absent", 42);
    installFakeAgent("opencode");
    useOnlyFakePath();
    const config = join(home, ".config", "opencode", "opencode.json");

    await commandSetup(["opencode"], { port: 3299 });

    expect(process.exitCode).toBe(1);
    expect(readFileSync(join(home, "npm.log"), "utf8")).toContain(
      "install -g @loreai/opencode",
    );
    expect(existsSync(config)).toBe(false);
    expect(existsSync(`${config}.lore-backup`)).toBe(false);
    const output = [...logSpy.mock.calls, ...errorSpy.mock.calls]
      .map((call) => call.join(" "))
      .join("\n");
    expect(output).toContain("npm install failed");
    expect(output).not.toContain("OpenCode configured");
    expect(output).not.toContain("Gateway is reachable");
    expect(output).not.toContain("Gateway is not reachable");
    expect(output).not.toContain("Tip: for terminal use");
  });

  it("rolls back earlier apps and stops auto setup when OpenCode npm install fails", async () => {
    installFakeNpm("absent", 42);
    installFakeAgent("codex");
    installFakeAgent("opencode");
    installFakeAgent("claude");
    useOnlyFakePath();

    const codexConfig = join(home, ".codex", "config.toml");
    mkdirSync(dirname(codexConfig), { recursive: true });
    writeFileSync(codexConfig, 'model = "gpt-5.5"\n', { mode: 0o640 });
    const beforeCodex = readState(codexConfig);
    const opencodeConfig = join(home, ".config", "opencode", "opencode.json");
    const claudeConfig = join(home, ".claude", "settings.json");

    await commandSetup([], { port: 3299 });

    expect(process.exitCode).toBe(1);
    expectState(codexConfig, beforeCodex);
    expect(existsSync(opencodeConfig)).toBe(false);
    expect(existsSync(`${opencodeConfig}.lore-backup`)).toBe(false);
    expect(existsSync(claudeConfig)).toBe(false);
    expect(existsSync(`${claudeConfig}.lore-backup`)).toBe(false);
    const output = [...logSpy.mock.calls, ...errorSpy.mock.calls]
      .map((call) => call.join(" "))
      .join("\n");
    expect(output).toContain("npm install failed");
    expect(output).not.toContain("OpenCode configured");
    expect(output).not.toContain("Claude Code configured");
    expect(output).not.toContain("Gateway is reachable");
    expect(output).not.toContain("Gateway is not reachable");
    expect(output).not.toContain("Tip: for terminal use");
  });

  it("uninstalls a package first installed by this auto setup when a later app fails", async () => {
    installStatefulFakeNpm({ initial: { state: "absent" } });
    installAutoFailureAgents();
    const before = seedAutoFailureConfigs();
    failClaudeSetup("later Claude setup failure");

    await expect(commandSetup([], { port: 3299 })).rejects.toThrow(
      "later Claude setup failure",
    );

    expect(fakeNpmCommands()).toEqual([
      "ls -g @loreai/opencode --json --depth=0 --long",
      "ls -g @loreai/opencode --json --depth=0 --long",
      "ls -g @loreai/opencode --json --depth=0 --long",
      "install -g @loreai/opencode",
      "ls -g @loreai/opencode --json --depth=0 --long",
      "ls -g @loreai/opencode --json --depth=0 --long",
      "uninstall -g @loreai/opencode",
      "ls -g @loreai/opencode --json --depth=0 --long",
    ]);
    expect(fakeNpmState()).toEqual({ state: "absent" });
    expect(existsSync(externalJournalPath())).toBe(false);
    expectState(opencodePath(), before.opencode);
    expectState(`${opencodePath()}.lore-backup`, {
      bytes: null,
      mode: null,
    });
    expectState(claudePath(), before.claude);
    expectState(`${claudePath()}.lore-backup`, { bytes: null, mode: null });
    expect(existsSync(hermesPath())).toBe(false);
    const output = loggedOutput();
    expect(output).not.toContain("OpenCode configured");
    expect(output).not.toContain("Claude Code configured");
    expect(output).not.toContain("Hermes Agent configured");
    expect(output).not.toContain("Gateway is reachable");
    expect(output).not.toContain("Gateway is not reachable");
    expect(output).not.toContain("Tip: for terminal use");
  });

  it("never removes a pre-existing package when a later auto app fails", async () => {
    const initial: FakeNpmPackageState = {
      state: "installed",
      version: "1.2.3",
      source: "file:/user/opencode-plugin-1.2.3.tgz",
    };
    installStatefulFakeNpm({ initial });
    installAutoFailureAgents();
    const before = seedAutoFailureConfigs();
    failClaudeSetup("later setup failed with existing package");

    await expect(commandSetup([], { port: 3299 })).rejects.toThrow(
      "later setup failed with existing package",
    );

    expect(fakeNpmCommands()).toEqual([
      "ls -g @loreai/opencode --json --depth=0 --long",
      "ls -g @loreai/opencode --json --depth=0 --long",
    ]);
    expect(fakeNpmState()).toEqual(initial);
    expectState(opencodePath(), before.opencode);
    expectState(claudePath(), before.claude);
    expect(existsSync(hermesPath())).toBe(false);
    const output = loggedOutput();
    expect(output).not.toContain("OpenCode configured");
    expect(output).not.toContain("Gateway is reachable");
    expect(output).not.toContain("Gateway is not reachable");
    expect(output).not.toContain("Tip: for terminal use");
  });

  it("compensates npm when the aggregate staged-file commit fails", async () => {
    installStatefulFakeNpm({ initial: { state: "absent" } });
    installFakeAgent("opencode");
    useOnlyFakePath();
    mkdirSync(dirname(opencodePath()), { recursive: true });
    writeFileSync(opencodePath(), '{"theme":"dark"}\n', { mode: 0o640 });
    const before = readState(opencodePath());
    _setStagedTrustedFileCommitHookForTest(() => {
      throw new Error("aggregate setup commit failure");
    });

    await expect(commandSetup([], { port: 3299 })).rejects.toThrow(
      "aggregate setup commit failure",
    );

    expect(fakeNpmCommands()).toEqual([
      "ls -g @loreai/opencode --json --depth=0 --long",
      "ls -g @loreai/opencode --json --depth=0 --long",
      "ls -g @loreai/opencode --json --depth=0 --long",
      "install -g @loreai/opencode",
      "ls -g @loreai/opencode --json --depth=0 --long",
      "ls -g @loreai/opencode --json --depth=0 --long",
      "uninstall -g @loreai/opencode",
      "ls -g @loreai/opencode --json --depth=0 --long",
    ]);
    expect(fakeNpmState()).toEqual({ state: "absent" });
    expect(existsSync(externalJournalPath())).toBe(false);
    expectState(opencodePath(), before);
    expectState(`${opencodePath()}.lore-backup`, {
      bytes: null,
      mode: null,
    });
    const output = loggedOutput();
    expect(output).not.toContain("OpenCode configured");
    expect(output).not.toContain("Gateway is reachable");
    expect(output).not.toContain("Gateway is not reachable");
    expect(output).not.toContain("Tip: for terminal use");
  });

  it("commits a newly installed package and all files after successful auto setup", async () => {
    installStatefulFakeNpm({ initial: { state: "absent" } });
    installFakeAgent("opencode");
    installFakeAgent("claude");
    useOnlyFakePath();

    await commandSetup([], { port: 3299 });

    expect(fakeNpmCommands()).toEqual([
      "ls -g @loreai/opencode --json --depth=0 --long",
      "ls -g @loreai/opencode --json --depth=0 --long",
      "ls -g @loreai/opencode --json --depth=0 --long",
      "install -g @loreai/opencode",
      "ls -g @loreai/opencode --json --depth=0 --long",
      "ls -g @loreai/opencode --json --depth=0 --long",
      "ls -g @loreai/opencode --json --depth=0 --long",
      "ls -g @loreai/opencode --json --depth=0 --long",
      "ls -g @loreai/opencode --json --depth=0 --long",
    ]);
    expect(fakeNpmState()).toEqual(FAKE_INSTALLED_PACKAGE);
    expect(existsSync(externalJournalPath())).toBe(false);
    const opencode = JSON.parse(readFileSync(opencodePath(), "utf8"));
    expect(opencode.plugin).toContain("@loreai/opencode");
    expect(opencode.compaction.auto).toBe(false);
    const claude = JSON.parse(readFileSync(claudePath(), "utf8"));
    expect(claude.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:3299");
    const output = loggedOutput();
    expect(output).toContain("OpenCode configured");
    expect(output).toContain("Claude Code configured");
    expect(output).toContain("Gateway is not reachable");
    expect(process.exitCode).toBeUndefined();
  });

  it("reports compensation failure while still restoring all setup files", async () => {
    installStatefulFakeNpm({
      initial: { state: "absent" },
      uninstallStatus: 73,
    });
    installAutoFailureAgents();
    const before = seedAutoFailureConfigs();
    failClaudeSetup("later failure before failed compensation");

    await expect(commandSetup([], { port: 3299 })).rejects.toThrow(
      "Setup failed and could not be fully rolled back",
    );

    expect(fakeNpmCommands()).toEqual([
      "ls -g @loreai/opencode --json --depth=0 --long",
      "ls -g @loreai/opencode --json --depth=0 --long",
      "ls -g @loreai/opencode --json --depth=0 --long",
      "install -g @loreai/opencode",
      "ls -g @loreai/opencode --json --depth=0 --long",
      "ls -g @loreai/opencode --json --depth=0 --long",
      "uninstall -g @loreai/opencode",
      "ls -g @loreai/opencode --json --depth=0 --long",
    ]);
    expect(fakeNpmState()).toEqual(FAKE_INSTALLED_PACKAGE);
    expect(existsSync(externalJournalPath())).toBe(true);
    expectState(opencodePath(), before.opencode);
    expectState(claudePath(), before.claude);
    expect(existsSync(hermesPath())).toBe(false);
    expect(process.exitCode).toBe(1);
    const output = loggedOutput();
    expect(output).toContain("npm uninstall failed while rolling back");
    expect(output).toContain("Could not restore the prior global state");
    expect(output).not.toContain("OpenCode configured");
    expect(output).not.toContain("Gateway is reachable");
    expect(output).not.toContain("Gateway is not reachable");
    expect(output).not.toContain("Tip: for terminal use");
  });

  it("refuses file commit after concurrent package removal and preserves recovery evidence", async () => {
    installStatefulFakeNpm({ initial: { state: "absent" } });
    installFakeAgent("opencode");
    useOnlyFakePath();
    mkdirSync(dirname(opencodePath()), { recursive: true });
    writeFileSync(opencodePath(), '{"theme":"dark"}\n', { mode: 0o640 });
    const before = readState(opencodePath());
    _setSetupExternalEffectHookForTest((phase) => {
      if (phase === "before-prepare") removeFakeNpmPackage();
    });

    await expect(commandSetup([], { port: 3299 })).rejects.toThrow(
      "could not be fully rolled back",
    );

    expect(fakeNpmState()).toEqual({ state: "absent" });
    expect(fakeNpmCommands()).not.toContain("uninstall -g @loreai/opencode");
    expectState(opencodePath(), before);
    expect(existsSync(externalJournalPath())).toBe(true);
    const output = loggedOutput();
    expect(output).toContain("changed before setup commit");
    expect(output).toContain("successor state was preserved");
    expect(output).not.toContain("OpenCode configured");
    expect(output).not.toContain("Gateway is reachable");
    expect(output).not.toContain("Gateway is not reachable");
  });

  it("restores committed evidence when the package changes during journal removal", async () => {
    installStatefulFakeNpm({ initial: { state: "absent" } });
    installFakeAgent("opencode");
    useOnlyFakePath();
    _setTrustedFilePublishHookForTest((operation, path) => {
      if (operation === "remove" && path === externalJournalPath()) {
        replaceFakeNpmGeneration();
      }
    });

    await expect(commandSetup([], { port: 3299 })).rejects.toThrow(
      "changed during setup journal cleanup",
    );

    expect(fakeNpmState()).toEqual(FAKE_INSTALLED_PACKAGE);
    expect(existsSync(fakeNpmPackagePath())).toBe(true);
    expect(fakeNpmCommands()).not.toContain("uninstall -g @loreai/opencode");
    expect(JSON.parse(readFileSync(externalJournalPath(), "utf8")).phase).toBe(
      "committed",
    );
    const config = JSON.parse(readFileSync(opencodePath(), "utf8"));
    expect(config.plugin).toContain("@loreai/opencode");
    const output = loggedOutput();
    expect(output).toContain("recovery evidence was restored");
    expect(output).not.toContain("OpenCode configured");
    expect(output).not.toContain("Gateway is reachable");
    expect(output).not.toContain("Gateway is not reachable");

    await expect(commandSetup(["status"], {})).rejects.toThrow(
      "committed setup generation",
    );
    expect(existsSync(externalJournalPath())).toBe(true);
  });

  it("preserves package and config when committed-journal publication reports a later failure", async () => {
    installStatefulFakeNpm({ initial: { state: "absent" } });
    installFakeAgent("opencode");
    useOnlyFakePath();
    _setTrustedDirectoryFsyncHookForTest((directory) => {
      if (directory !== dirname(externalJournalPath())) return;
      if (!existsSync(externalJournalPath())) return;
      const journal = JSON.parse(readFileSync(externalJournalPath(), "utf8"));
      if (journal.phase === "committed") {
        throw new Error("committed journal post-publication failure");
      }
    });

    await expect(commandSetup([], { port: 3299 })).rejects.toThrow(
      "committed journal post-publication failure",
    );

    expect(fakeNpmState()).toEqual(FAKE_INSTALLED_PACKAGE);
    expect(existsSync(fakeNpmPackagePath())).toBe(true);
    expect(fakeNpmCommands()).not.toContain("uninstall -g @loreai/opencode");
    expect(JSON.parse(readFileSync(externalJournalPath(), "utf8")).phase).toBe(
      "committed",
    );
    const config = JSON.parse(readFileSync(opencodePath(), "utf8"));
    expect(config.plugin).toContain("@loreai/opencode");
    const output = loggedOutput();
    expect(output).toContain("crossed its durable commit point");
    expect(output).not.toContain("OpenCode configured");
    expect(output).not.toContain("Gateway is reachable");
    expect(output).not.toContain("Gateway is not reachable");

    _setTrustedDirectoryFsyncHookForTest(null);
    await commandSetup(["status"], {});
    expect(fakeNpmState()).toEqual(FAKE_INSTALLED_PACKAGE);
    expect(existsSync(externalJournalPath())).toBe(false);
    expect(JSON.parse(readFileSync(opencodePath(), "utf8"))).toEqual(config);
  });

  it("rolls back package and config when committed-journal publication never starts", async () => {
    installStatefulFakeNpm({ initial: { state: "absent" } });
    installFakeAgent("opencode");
    useOnlyFakePath();
    let journalWrites = 0;
    _setTrustedFilePublishHookForTest((operation, path) => {
      if (operation !== "write" || path !== externalJournalPath()) return;
      journalWrites += 1;
      if (journalWrites === 4) {
        throw new Error("committed journal pre-publication failure");
      }
    });

    await expect(commandSetup([], { port: 3299 })).rejects.toThrow(
      "committed journal pre-publication failure",
    );

    expect(fakeNpmState()).toEqual({ state: "absent" });
    expect(fakeNpmCommands()).toContain("uninstall -g @loreai/opencode");
    expect(existsSync(opencodePath())).toBe(false);
    expect(existsSync(externalJournalPath())).toBe(false);
  });

  it("rolls back package and config when committed evidence disappears after publication", async () => {
    installStatefulFakeNpm({ initial: { state: "absent" } });
    installFakeAgent("opencode");
    useOnlyFakePath();
    _setTrustedDirectoryFsyncHookForTest((directory) => {
      if (directory !== dirname(externalJournalPath())) return;
      if (!existsSync(externalJournalPath())) return;
      const journal = JSON.parse(readFileSync(externalJournalPath(), "utf8"));
      if (journal.phase === "committed") {
        rmSync(externalJournalPath());
        throw new Error("committed journal disappeared");
      }
    });

    await expect(commandSetup([], { port: 3299 })).rejects.toThrow(
      "committed journal disappeared",
    );

    expect(fakeNpmState()).toEqual({ state: "absent" });
    expect(fakeNpmCommands()).toContain("uninstall -g @loreai/opencode");
    expect(existsSync(opencodePath())).toBe(false);
    expect(existsSync(externalJournalPath())).toBe(false);
  });

  it("rolls back package and config while preserving malformed replacement evidence", async () => {
    installStatefulFakeNpm({ initial: { state: "absent" } });
    installFakeAgent("opencode");
    useOnlyFakePath();
    _setTrustedDirectoryFsyncHookForTest((directory) => {
      if (directory !== dirname(externalJournalPath())) return;
      if (!existsSync(externalJournalPath())) return;
      const journal = JSON.parse(readFileSync(externalJournalPath(), "utf8"));
      if (journal.phase === "committed") {
        writeFileSync(externalJournalPath(), "not-json\n");
        throw new Error("committed journal replaced with malformed evidence");
      }
    });

    await expect(commandSetup([], { port: 3299 })).rejects.toThrow(
      "could not be fully rolled back",
    );

    expect(fakeNpmState()).toEqual({ state: "absent" });
    expect(fakeNpmCommands()).toContain("uninstall -g @loreai/opencode");
    expect(existsSync(opencodePath())).toBe(false);
    expect(readFileSync(externalJournalPath(), "utf8")).toBe("not-json\n");
  });

  it("rolls back package and config while preserving a valid replacement journal generation", async () => {
    installStatefulFakeNpm({ initial: { state: "absent" } });
    installFakeAgent("opencode");
    useOnlyFakePath();
    _setTrustedDirectoryFsyncHookForTest((directory) => {
      if (directory !== dirname(externalJournalPath())) return;
      if (!existsSync(externalJournalPath())) return;
      const bytes = readFileSync(externalJournalPath());
      const journal = JSON.parse(bytes.toString("utf8"));
      if (journal.phase === "committed") {
        rmSync(externalJournalPath());
        writeFileSync(externalJournalPath(), bytes);
        throw new Error("committed journal generation replaced");
      }
    });

    await expect(commandSetup([], { port: 3299 })).rejects.toThrow(
      "could not be fully rolled back",
    );

    expect(fakeNpmState()).toEqual({ state: "absent" });
    expect(fakeNpmCommands()).toContain("uninstall -g @loreai/opencode");
    expect(existsSync(opencodePath())).toBe(false);
    expect(JSON.parse(readFileSync(externalJournalPath(), "utf8")).phase).toBe(
      "committed",
    );
  });

  it("distinguishes and preserves a same-version/source successor generation before commit", async () => {
    installStatefulFakeNpm({ initial: { state: "absent" } });
    installFakeAgent("opencode");
    useOnlyFakePath();
    _setSetupExternalEffectHookForTest((phase) => {
      if (phase === "before-prepare") replaceFakeNpmGeneration();
    });

    await expect(commandSetup([], { port: 3299 })).rejects.toThrow(
      "could not be fully rolled back",
    );

    expect(fakeNpmState()).toEqual(FAKE_INSTALLED_PACKAGE);
    expect(existsSync(fakeNpmPackagePath())).toBe(true);
    expect(fakeNpmCommands()).not.toContain("uninstall -g @loreai/opencode");
    expect(existsSync(opencodePath())).toBe(false);
    expect(existsSync(externalJournalPath())).toBe(true);
    const output = loggedOutput();
    expect(output).toContain("changed before setup commit");
    expect(output).toContain("successor state was preserved");
    expect(output).not.toContain("OpenCode configured");
    expect(output).not.toContain("Gateway is reachable");
    expect(output).not.toContain("Gateway is not reachable");
  });

  it("revalidates absence immediately before initial npm installation", async () => {
    installStatefulFakeNpm({ initial: { state: "absent" } });
    installFakeAgent("opencode");
    useOnlyFakePath();
    _setSetupExternalEffectHookForTest((phase) => {
      if (phase === "before-install-mutation") {
        publishFakeNpmSuccessorGeneration();
      }
    });

    await expect(commandSetup([], { port: 3299 })).rejects.toThrow(
      "could not be fully rolled back",
    );

    expect(fakeNpmState()).toEqual(FAKE_INSTALLED_PACKAGE);
    expect(existsSync(fakeNpmPackagePath())).toBe(true);
    expect(fakeNpmCommands()).not.toContain("install -g @loreai/opencode");
    expect(fakeNpmCommands()).not.toContain("uninstall -g @loreai/opencode");
    expect(existsSync(opencodePath())).toBe(false);
    expect(existsSync(externalJournalPath())).toBe(true);
    const output = loggedOutput();
    expect(output).toContain("changed immediately before installation");
    expect(output).toContain("successor state was preserved");
    expect(output).not.toContain("OpenCode configured");
    expect(output).not.toContain("Gateway is reachable");
    expect(output).not.toContain("Gateway is not reachable");
  });

  it("revalidates the installed generation immediately before destructive rollback", async () => {
    installStatefulFakeNpm({ initial: { state: "absent" } });
    installFakeAgent("opencode");
    useOnlyFakePath();
    _setSetupExternalEffectHookForTest((phase) => {
      if (phase === "before-prepare") {
        throw new Error("force rollback before the logical commit");
      }
      if (phase === "before-rollback-mutation") {
        replaceFakeNpmGeneration();
      }
    });

    await expect(commandSetup([], { port: 3299 })).rejects.toThrow(
      "could not be fully rolled back",
    );

    expect(fakeNpmState()).toEqual(FAKE_INSTALLED_PACKAGE);
    expect(existsSync(fakeNpmPackagePath())).toBe(true);
    expect(fakeNpmCommands()).not.toContain("uninstall -g @loreai/opencode");
    expect(existsSync(opencodePath())).toBe(false);
    expect(existsSync(externalJournalPath())).toBe(true);
    const output = loggedOutput();
    expect(output).toContain("no longer matches Lore's installed generation");
    expect(output).toContain("successor state was preserved");
    expect(output).not.toContain("OpenCode configured");
    expect(output).not.toContain("Gateway is reachable");
    expect(output).not.toContain("Gateway is not reachable");
  });

  it("revalidates the installed generation immediately before committed-journal cleanup", async () => {
    installStatefulFakeNpm({ initial: { state: "absent" } });
    installFakeAgent("opencode");
    useOnlyFakePath();
    _setSetupExternalEffectHookForTest((phase) => {
      if (phase === "before-journal-cleanup") replaceFakeNpmGeneration();
    });

    await expect(commandSetup([], { port: 3299 })).rejects.toThrow(
      "changed before setup journal cleanup",
    );

    expect(fakeNpmState()).toEqual(FAKE_INSTALLED_PACKAGE);
    expect(existsSync(fakeNpmPackagePath())).toBe(true);
    expect(fakeNpmCommands()).not.toContain("uninstall -g @loreai/opencode");
    expect(JSON.parse(readFileSync(externalJournalPath(), "utf8")).phase).toBe(
      "committed",
    );
    const config = JSON.parse(readFileSync(opencodePath(), "utf8"));
    expect(config.plugin).toContain("@loreai/opencode");
    const output = loggedOutput();
    expect(output).toContain("successor state");
    expect(output).not.toContain("OpenCode configured");
    expect(output).not.toContain("Gateway is reachable");
    expect(output).not.toContain("Gateway is not reachable");
  });

  it("does not roll back npm after lifecycle ownership is lost before external prepare", async () => {
    installStatefulFakeNpm({ initial: { state: "absent" } });
    installFakeAgent("opencode");
    useOnlyFakePath();
    _setSetupExternalEffectHookForTest((phase) => {
      if (phase === "before-prepare") {
        throw new LifecycleLockLostError("simulated lock theft before prepare");
      }
    });

    await expect(commandSetup([], { port: 3299 })).rejects.toThrow(
      "simulated lock theft before prepare",
    );

    expect(fakeNpmState()).toEqual(FAKE_INSTALLED_PACKAGE);
    expect(fakeNpmCommands()).not.toContain("uninstall -g @loreai/opencode");
    expect(existsSync(opencodePath())).toBe(false);
    expect(existsSync(externalJournalPath())).toBe(true);
    const output = loggedOutput();
    expect(output).toContain("Lifecycle-lock ownership was lost");
    expect(output).not.toContain("OpenCode configured");
    expect(output).not.toContain("Gateway is reachable");
    expect(output).not.toContain("Gateway is not reachable");
  });

  it("does not roll back npm when lifecycle ownership is lost immediately before rollback", async () => {
    installStatefulFakeNpm({ initial: { state: "absent" } });
    installFakeAgent("opencode");
    useOnlyFakePath();
    _setStagedTrustedFileCommitHookForTest(() => {
      throw new LifecycleLockLostError("simulated lock loss before rollback");
    });

    await expect(commandSetup([], { port: 3299 })).rejects.toThrow(
      "simulated lock loss before rollback",
    );

    expect(fakeNpmState()).toEqual(FAKE_INSTALLED_PACKAGE);
    expect(fakeNpmCommands()).not.toContain("uninstall -g @loreai/opencode");
    expect(existsSync(opencodePath())).toBe(false);
    expect(existsSync(externalJournalPath())).toBe(true);
    const output = loggedOutput();
    expect(output).toContain("Lifecycle-lock ownership was lost");
    expect(output).not.toContain("OpenCode configured");
    expect(output).not.toContain("Gateway is reachable");
    expect(output).not.toContain("Gateway is not reachable");
  });

  it("recovers the exact package generation on the next setup after SIGKILL", async () => {
    installStatefulFakeNpm({ initial: { state: "absent" } });
    installFakeAgent("opencode");
    useOnlyFakePath();

    runExternalEffectSigkillChild();
    expect(fakeNpmState()).toEqual(FAKE_INSTALLED_PACKAGE);
    expect(existsSync(externalJournalPath())).toBe(true);
    if (process.platform !== "win32") {
      expect(lstatSync(externalJournalPath()).mode & 0o777).toBe(0o600);
    }

    await commandSetup(["status"], {});

    expect(fakeNpmState()).toEqual({ state: "absent" });
    expect(existsSync(externalJournalPath())).toBe(false);
    expect(fakeNpmCommands()).toEqual([
      "ls -g @loreai/opencode --json --depth=0 --long",
      "ls -g @loreai/opencode --json --depth=0 --long",
      "ls -g @loreai/opencode --json --depth=0 --long",
      "install -g @loreai/opencode",
      "ls -g @loreai/opencode --json --depth=0 --long",
      "ls -g @loreai/opencode --json --depth=0 --long",
      "ls -g @loreai/opencode --json --depth=0 --long",
      "uninstall -g @loreai/opencode",
      "ls -g @loreai/opencode --json --depth=0 --long",
    ]);
    expect(loggedOutput()).toContain(
      "Recovering interrupted global installation",
    );
  });

  it("preserves an exact committed package and registered config after SIGKILL at the final boundary", async () => {
    installStatefulFakeNpm({ initial: { state: "absent" } });
    installFakeAgent("opencode");
    useOnlyFakePath();

    runExternalEffectSigkillChild("before-journal-cleanup");
    const installedGeneration = fakeNpmGeneration();
    expect(fakeNpmState()).toEqual(FAKE_INSTALLED_PACKAGE);
    expect(JSON.parse(readFileSync(externalJournalPath(), "utf8")).phase).toBe(
      "committed",
    );
    const committedConfig = JSON.parse(readFileSync(opencodePath(), "utf8"));
    expect(committedConfig.plugin).toContain("@loreai/opencode");
    expect(committedConfig.compaction.auto).toBe(false);

    await commandSetup(["status"], {});

    expect(fakeNpmState()).toEqual(FAKE_INSTALLED_PACKAGE);
    expect(fakeNpmGeneration()).toEqual(installedGeneration);
    expect(existsSync(externalJournalPath())).toBe(false);
    const reconciledConfig = JSON.parse(readFileSync(opencodePath(), "utf8"));
    expect(reconciledConfig).toEqual(committedConfig);
    expect(fakeNpmCommands()).not.toContain("uninstall -g @loreai/opencode");
    expect(loggedOutput()).not.toContain(
      "Recovering interrupted global installation",
    );
  });

  it("preserves a changed package generation on the next setup after SIGKILL", async () => {
    installStatefulFakeNpm({ initial: { state: "absent" } });
    installFakeAgent("opencode");
    useOnlyFakePath();

    runExternalEffectSigkillChild();
    replaceFakeNpmGeneration();

    await expect(commandSetup(["status"], {})).rejects.toThrow(
      "successor state",
    );

    expect(fakeNpmState()).toEqual(FAKE_INSTALLED_PACKAGE);
    expect(existsSync(fakeNpmPackagePath())).toBe(true);
    expect(existsSync(externalJournalPath())).toBe(true);
    expect(fakeNpmCommands()).not.toContain("uninstall -g @loreai/opencode");
    expect(loggedOutput()).not.toContain("OpenCode configured");
  });

  it("supports setup undo reentrantly under an uninstall lifecycle lock", async () => {
    await commandSetup(["claude-code"], { port: 3299 });
    await withLifecycleLock("uninstall", async (outerLock) => {
      await commandSetup(["undo", "claude-code"], {});
      outerLock.assertOwned();
    });
    expect(existsSync(`${claudePath()}.lore-backup`)).toBe(false);
    expect(existsSync(claudePath())).toBe(false);
  });
});

describe.skipIf(process.platform === "win32")(
  "SIGKILL journal recovery",
  () => {
    it.each([1, 2, 3])(
      "recovers setup and undo after hard kill at commit %i",
      async (commit) => {
        mkdirSync(dirname(claudePath()), { recursive: true });
        const original =
          '{"env":{"ANTHROPIC_BASE_URL":"https://api.anthropic.com"}}\n';
        writeFileSync(claudePath(), original);

        runSigkillChild("setup", commit);
        expect(
          JSON.parse(readFileSync(`${claudePath()}.lore-backup`, "utf8"))
            .version,
        ).toBe(commit < 3 ? 2 : 3);
        await commandSetup(["claude-code"], { port: 3299 });

        runSigkillChild("undo", commit);
        await commandSetup(["undo", "claude-code"], {});

        expect(JSON.parse(readFileSync(claudePath(), "utf8"))).toEqual(
          JSON.parse(original),
        );
        expect(existsSync(`${claudePath()}.lore-backup`)).toBe(false);
      },
    );
  },
);
