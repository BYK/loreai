import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertSafeRemovalPath,
  formatStandaloneInstallReceipt,
  gatewayRunning,
  parseInstallReceipt,
  planUninstall,
  preflightRemoval,
  removeBinary,
  removeInstallerPathBlock,
  removePath,
  removePathBlocks,
  runUninstall,
  standaloneInstallProvenance,
  type ExecutableIdentity,
  type StagedFileRemoval,
} from "../src/cli/uninstall";
import {
  commandSetup,
  prevalidateSetupUndo,
  stageSetupUndo,
} from "../src/cli/setup";
import { withLifecycleLock } from "../src/lifecycle-lock";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "lore-uninstall-"));
  temporaryDirectories.push(path);
  return path;
}

function fileIdentity(path: string): ExecutableIdentity {
  const info = statSync(path, { bigint: true });
  return {
    device: info.dev,
    inode: info.ino,
    size: info.size,
    mtimeNs: info.mtimeNs,
    sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
  };
}

function runSigkillChild(args: string[]): void {
  const child = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      join(import.meta.dirname, "uninstall-sigkill-child.ts"),
      ...args,
    ],
    { encoding: "utf8", timeout: 90_000 },
  );
  expect(child.error).toBeUndefined();
  expect(child.status, child.stderr).toBeNull();
  expect(child.signal).toBe("SIGKILL");
}

function uninstallClaims(parent: string): string[] {
  return readdirSync(parent).filter((name) => name.includes("lore-uninstall"));
}

function stagedRemoval(
  overrides: Partial<StagedFileRemoval> = {},
): StagedFileRemoval {
  return {
    stageDeletion: vi.fn(),
    assertDeleted: vi.fn(),
    state: vi.fn(() => "missing" as const),
    prepareCommit: vi.fn(),
    commit: vi.fn(),
    finalize: vi.fn(),
    rollback: vi.fn(() => "restored" as const),
    ...overrides,
  };
}

describe("uninstall planning", () => {
  it("preserves data by default and purges only the default data directory", () => {
    const base = {
      currentExecutable: "/home/me/.local/bin/lore",
      hostedInstall: true,
      receiptPath: "/home/me/.lore/install-path",
      executableIdentity: {
        device: 1n,
        inode: 2n,
        size: 3n,
        mtimeNs: 4n,
        sha256: "a".repeat(64),
      },
      receiptIdentity: {
        device: 5n,
        inode: 6n,
        size: 7n,
        mtimeNs: 8n,
        sha256: "b".repeat(64),
      },
      packageManaged: false,
      platform: "linux" as const,
      home: "/home/me",
      dataDir: "/home/me/.local/share/lore",
      configDir: "/home/me/.lore",
    };
    const preserved = planUninstall({ ...base, purge: false });
    expect(preserved.preservedDataPaths).toEqual([
      "/home/me/.local/share/lore",
    ]);
    expect(preserved.removals).not.toContainEqual({
      path: "/home/me/.local/share/lore",
      recursive: true,
    });

    const purged = planUninstall({ ...base, purge: true });
    expect(purged.preservedDataPaths).toEqual([]);
    expect(purged.removals).toContainEqual({
      path: "/home/me/.local/share/lore",
      recursive: true,
    });
  });

  it("never deletes package-managed executables or custom data", () => {
    const plan = planUninstall({
      currentExecutable: "/home/me/.cache/lore/node",
      hostedInstall: false,
      packageManaged: true,
      packageEntryPath: "/home/me/.cache/lore/package/bin.ts",
      platform: "linux",
      purge: true,
      home: "/home/me",
      dataDir: "/home/me/.cache/lore",
      configDir: "/tmp/custom-lore-config",
    });
    expect(plan.binaryPath).toBeNull();
    expect(plan.receiptPath).toBeNull();
    expect(
      plan.removals.some(({ path }) => path === "/home/me/.cache/lore"),
    ).toBe(false);
    expect(plan.preservedDataPaths).toEqual([
      "/home/me/.cache/lore",
      "/tmp/custom-lore-config",
    ]);
  });

  it("protects relative external databases from overlapping cleanup", () => {
    const plan = planUninstall({
      currentExecutable: "/home/me/.local/bin/lore",
      hostedInstall: false,
      packageManaged: false,
      platform: "linux",
      purge: true,
      home: "/home/me",
      cwd: "/home/me/.cache/lore",
      dataDir: "/home/me/.local/share/lore",
      configDir: "/home/me/.lore",
      dbPath: "lore.db",
    });
    expect(
      plan.removals.some(({ path }) => path === "/home/me/.cache/lore"),
    ).toBe(false);
    expect(plan.preservedDataPaths).toContain("lore.db");
  });

  it("keeps a verified Windows PATH install directory while retaining the running install", () => {
    const executableIdentity = {
      device: 1n,
      inode: 2n,
      size: 3n,
      mtimeNs: 4n,
      sha256: "a".repeat(64),
    };
    const receiptIdentity = {
      device: 5n,
      inode: 6n,
      size: 7n,
      mtimeNs: 8n,
      sha256: "b".repeat(64),
    };
    const plan = planUninstall({
      currentExecutable: "/home/me/.local/bin/lore.exe",
      hostedInstall: true,
      receiptPath: "/home/me/.lore/install-path",
      pathInstallDir: "/home/me/.local/bin",
      executableIdentity,
      receiptIdentity,
      packageManaged: false,
      platform: "win32",
      purge: false,
      home: "/home/me",
      dataDir: "/home/me/.local/share/lore",
      configDir: "/home/me/.lore",
    });

    expect(plan).toMatchObject({
      binaryPath: null,
      binaryIdentity: null,
      manualBinaryPath: "/home/me/.local/bin/lore.exe",
      receiptPath: null,
      receiptIdentity: null,
      manualReceiptPath: "/home/me/.lore/install-path",
      installDir: "/home/me/.local/bin",
    });
  });

  it("does not trust a receipt PATH directory without full hosted-install verification", () => {
    const plan = planUninstall({
      currentExecutable: "/home/me/.local/bin/lore.exe",
      hostedInstall: true,
      receiptPath: "/home/me/.lore/install-path",
      pathInstallDir: "/tmp/attacker-bin",
      packageManaged: false,
      platform: "win32",
      purge: false,
      home: "/home/me",
      dataDir: "/home/me/.local/share/lore",
      configDir: "/home/me/.lore",
    });

    expect(plan.installDir).toBeNull();
  });
});

describe("strict hosted receipt identity", () => {
  it("accepts a v3 identity-bound receipt and rejects the same bytes on a new inode", () => {
    const home = temporaryDirectory();
    const installDir = join(home, "bin");
    const stateDir = join(home, ".lore");
    const executable = join(installDir, "lore");
    const receipt = join(stateDir, "install-path");
    mkdirSync(installDir);
    mkdirSync(stateDir);
    writeFileSync(executable, "binary");
    writeFileSync(
      receipt,
      formatStandaloneInstallReceipt({
        executable,
        pathInstallDir: installDir,
        executableIdentity: fileIdentity(executable),
      }),
      { mode: 0o600 },
    );
    expect(parseInstallReceipt(readFileSync(receipt, "utf8"))).toMatchObject({
      version: 3,
      pathInstallDir: installDir,
      executableIdentity: fileIdentity(executable),
    });
    expect(
      standaloneInstallProvenance(executable, { seaBinary: true, home }),
    ).toMatchObject({ hostedInstall: true });

    renameSync(executable, `${executable}.old`);
    writeFileSync(executable, "binary");
    expect(
      standaloneInstallProvenance(executable, { seaBinary: true, home }),
    ).toEqual({ hostedInstall: false });
  });

  it("rejects path-only legacy receipts and symlinked state directories", () => {
    const home = temporaryDirectory();
    const executable = join(home, "bin", "lore");
    const state = join(home, "state");
    mkdirSync(dirname(executable));
    mkdirSync(state);
    writeFileSync(executable, "binary");
    writeFileSync(join(state, "install-path"), executable);
    symlinkSync(state, join(home, ".lore"));
    expect(
      standaloneInstallProvenance(executable, { seaBinary: true, home }),
    ).toEqual({ hostedInstall: false });
  });
});

describe("generation-bound deletion", () => {
  it("removes only the recursively preflighted generation", () => {
    const home = temporaryDirectory();
    const target = join(home, ".cache", "lore");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "old"), "old");
    const identity = preflightRemoval(target, true, home);

    const removal = removePath(target, true, identity, home, {
      afterQuarantine: () => {
        mkdirSync(target);
        writeFileSync(join(target, "successor"), "keep");
      },
    });
    removal.prepareCommit();
    removal.commit();
    expect(readFileSync(join(target, "successor"), "utf8")).toBe("keep");
  });

  it("refuses intermediate symlinks and preserves post-preflight successors", () => {
    const home = temporaryDirectory();
    const target = join(home, "target");
    mkdirSync(target);
    symlinkSync(target, join(home, ".cache"));
    expect(() =>
      assertSafeRemovalPath(join(home, ".cache", "lore"), home),
    ).toThrow(/intermediate symbolic link/);

    const missing = join(home, "safe", "lore");
    const identity = preflightRemoval(missing, true, home);
    mkdirSync(missing, { recursive: true });
    expect(() => removePath(missing, true, identity, home)).toThrow(
      /appeared after uninstall preflight/,
    );
  });

  it("stages executable deletion reversibly and preserves a successor", () => {
    const home = temporaryDirectory();
    const executable = join(home, "bin", "lore");
    mkdirSync(dirname(executable));
    writeFileSync(executable, "old");
    const removal = removeBinary(executable, fileIdentity(executable), home);
    removal.stageDeletion();
    writeFileSync(executable, "successor");
    expect(() => removal.assertDeleted()).toThrow(/replaced during uninstall/);
    expect(removal.rollback()).toBe("preserved");
    expect(readFileSync(executable, "utf8")).toBe("successor");
  });
});

describe.skipIf(process.platform === "win32")(
  "uninstall SIGKILL claim recovery",
  () => {
    it("recovers a shell profile stranded before replacement publication", () => {
      const home = temporaryDirectory();
      const installDir = join(home, "bin");
      const profile = join(home, ".zshrc");
      writeFileSync(
        profile,
        [
          "export KEEP=1",
          "# Added by lore installer",
          `export PATH='${installDir}':"$PATH"`,
          "",
        ].join("\n"),
      );

      runSigkillChild(["profile", home, profile, installDir]);
      expect(existsSync(profile)).toBe(false);
      expect(uninstallClaims(home).length).toBeGreaterThan(0);

      const recovery = removePathBlocks(installDir, () => {}, home);
      recovery.prepareCommit();
      recovery.commit();

      expect(readFileSync(profile, "utf8")).toBe("export KEEP=1\n");
      expect(uninstallClaims(home)).toEqual([]);
    });

    it("preserves a shell profile successor while committing its stranded claim", () => {
      const home = temporaryDirectory();
      const installDir = join(home, "bin");
      const profile = join(home, ".zshrc");
      writeFileSync(
        profile,
        `# Added by lore installer\nexport PATH='${installDir}':"$PATH"\n`,
      );

      runSigkillChild(["profile", home, profile, installDir]);
      writeFileSync(profile, "export SUCCESSOR=1\n");

      const recovery = removePathBlocks(installDir, () => {}, home);
      recovery.prepareCommit();
      recovery.commit();

      expect(readFileSync(profile, "utf8")).toBe("export SUCCESSOR=1\n");
      expect(uninstallClaims(home)).toEqual([]);
    });

    it("continues a purge claim stranded after canonical quarantine", () => {
      const home = temporaryDirectory();
      const target = join(home, ".local", "share", "lore");
      mkdirSync(target, { recursive: true });
      writeFileSync(join(target, "lore.db"), "memory");

      runSigkillChild(["purge", home, target]);
      expect(existsSync(target)).toBe(false);
      expect(uninstallClaims(dirname(target)).length).toBe(1);

      const recovery = removePath(
        target,
        true,
        preflightRemoval(target, true, home),
        home,
      );
      recovery.prepareCommit();
      recovery.commit();

      expect(existsSync(target)).toBe(false);
      expect(uninstallClaims(dirname(target))).toEqual([]);
    });

    it("preserves a purge successor while committing the stranded generation", () => {
      const home = temporaryDirectory();
      const target = join(home, ".cache", "lore");
      mkdirSync(target, { recursive: true });
      writeFileSync(join(target, "old"), "old");

      runSigkillChild(["purge", home, target]);
      mkdirSync(target);
      writeFileSync(join(target, "successor"), "keep");

      const recovery = removePath(
        target,
        true,
        preflightRemoval(target, true, home),
        home,
      );
      recovery.prepareCommit();
      recovery.commit();

      expect(readFileSync(join(target, "successor"), "utf8")).toBe("keep");
      expect(uninstallClaims(dirname(target))).toEqual([]);
    });
  },
);

describe("profile and uninstall transactions", () => {
  it("removes only the exact installer PATH block", () => {
    const installDir = "/home/me/.local/bin";
    const content = [
      "export KEEP=1",
      "# Added by lore installer",
      `export PATH='${installDir}':"$PATH"`,
      "",
    ].join("\n");
    expect(removeInstallerPathBlock(content, installDir)).toBe(
      "export KEEP=1\n",
    );
    expect(
      removeInstallerPathBlock(
        '# Added by lore installer\nexport PATH="/edited:$PATH"\n',
        installDir,
      ),
    ).toContain("/edited");
  });

  it("rolls back staged executable state when later cleanup fails", async () => {
    const rollback = vi.fn(() => "restored" as const);
    await expect(
      runUninstall(
        {
          binaryPath: "/home/me/bin/lore",
          binaryIdentity: {
            device: 1n,
            inode: 2n,
            size: 3n,
            mtimeNs: 4n,
            sha256: "a".repeat(64),
          },
          manualBinaryPath: null,
          manualReceiptPath: null,
          receiptPath: null,
          installDir: "/home/me/bin",
          removals: [],
          preservedDataPaths: [],
          packageManaged: false,
        },
        {
          gatewayRunning: async () => false,
          prevalidateSetupUndo: () => {},
          stageSetupUndo: () => ({
            prepareCommit: vi.fn(),
            commit: vi.fn(),
            rollback: vi.fn(),
          }),
          removeBinary: () => stagedRemoval({ rollback }),
          removePathBlocks: () => {
            throw new Error("profile changed");
          },
          removePath: vi.fn(),
          log: vi.fn(),
        },
      ),
    ).rejects.toThrow("profile changed");
    expect(rollback).toHaveBeenCalledOnce();
  });

  it("removes Windows hosted PATH blocks while retaining the executable and receipt", async () => {
    const home = temporaryDirectory();
    const installDir = join(home, ".local", "bin");
    const executable = join(installDir, "lore.exe");
    const receipt = join(home, ".lore", "install-path");
    const profile = join(home, ".bashrc");
    mkdirSync(installDir, { recursive: true });
    mkdirSync(dirname(receipt), { recursive: true });
    writeFileSync(executable, "windows-binary");
    writeFileSync(receipt, "verified-receipt");
    writeFileSync(
      profile,
      [
        "export KEEP=1",
        "# Added by lore installer",
        `export PATH='${installDir}':"$PATH"`,
        "export ALSO_KEEP=2",
        "",
      ].join("\n"),
    );
    const plan = planUninstall({
      currentExecutable: executable,
      hostedInstall: true,
      receiptPath: receipt,
      pathInstallDir: installDir,
      executableIdentity: fileIdentity(executable),
      receiptIdentity: fileIdentity(receipt),
      packageManaged: false,
      platform: "win32",
      purge: false,
      home,
      dataDir: join(home, ".local", "share", "lore"),
      configDir: join(home, ".lore"),
    });

    const removeBinarySpy = vi.fn();
    const removeReceiptSpy = vi.fn();
    await expect(
      runUninstall(plan, {
        gatewayRunning: async () => false,
        prevalidateSetupUndo: () => {},
        stageSetupUndo: () => ({
          prepareCommit: () => {},
          commit: () => {},
          rollback: () => {},
        }),
        removeBinary: removeBinarySpy,
        removeReceipt: removeReceiptSpy,
        removePathBlocks: (path, assertInstallRemoved) =>
          removePathBlocks(path, assertInstallRemoved, home),
        removePath: vi.fn(() => ({
          prepareCommit: () => {},
          commit: () => {},
          rollback: () => {},
        })),
        log: vi.fn(),
      }),
    ).resolves.toBe(0);

    expect(readFileSync(profile, "utf8")).toBe(
      "export KEEP=1\nexport ALSO_KEEP=2\n",
    );
    expect(readFileSync(executable, "utf8")).toBe("windows-binary");
    expect(readFileSync(receipt, "utf8")).toBe("verified-receipt");
    expect(removeBinarySpy).not.toHaveBeenCalled();
    expect(removeReceiptSpy).not.toHaveBeenCalled();
  });

  it("restores a Windows hosted PATH block when a later reversible step fails", async () => {
    const home = temporaryDirectory();
    const installDir = join(home, ".local", "bin");
    const executable = join(installDir, "lore.exe");
    const receipt = join(home, ".lore", "install-path");
    const profile = join(home, ".bashrc");
    mkdirSync(installDir, { recursive: true });
    mkdirSync(dirname(receipt), { recursive: true });
    writeFileSync(executable, "windows-binary");
    writeFileSync(receipt, "verified-receipt");
    const originalProfile = [
      "export KEEP=1",
      "# Added by lore installer",
      `export PATH='${installDir}':"$PATH"`,
      "export ALSO_KEEP=2",
      "",
    ].join("\n");
    writeFileSync(profile, originalProfile);
    const setupRollback = vi.fn();
    let pathCleanupStaged = false;
    const plan = planUninstall({
      currentExecutable: executable,
      hostedInstall: true,
      receiptPath: receipt,
      pathInstallDir: installDir,
      executableIdentity: fileIdentity(executable),
      receiptIdentity: fileIdentity(receipt),
      packageManaged: false,
      platform: "win32",
      purge: false,
      home,
      dataDir: join(home, ".local", "share", "lore"),
      configDir: join(home, ".lore"),
    });

    await expect(
      runUninstall(plan, {
        gatewayRunning: async () => false,
        prevalidateSetupUndo: () => {},
        stageSetupUndo: () => ({
          prepareCommit: () => {
            throw new Error("later setup validation failed");
          },
          commit: () => {},
          rollback: setupRollback,
        }),
        removeBinary: vi.fn(),
        removeReceipt: vi.fn(),
        removePathBlocks: (path, assertInstallRemoved) => {
          pathCleanupStaged = true;
          return removePathBlocks(path, assertInstallRemoved, home);
        },
        removePath: vi.fn(() => ({
          prepareCommit: () => {},
          commit: () => {},
          rollback: () => {},
        })),
        log: vi.fn(),
      }),
    ).rejects.toThrow("later setup validation failed");

    expect(readFileSync(profile, "utf8")).toBe(originalProfile);
    expect(readFileSync(executable, "utf8")).toBe("windows-binary");
    expect(readFileSync(receipt, "utf8")).toBe("verified-receipt");
    expect(setupRollback).toHaveBeenCalledOnce();
    expect(pathCleanupStaged).toBe(true);
  });

  it.each(["receipt", "binary"] as const)(
    "keeps setup and purge data intact when late %s validation fails",
    async (failureAt) => {
      let setupState: "configured" | "undone" = "configured";
      let dataState: "present" | "quarantined" = "present";
      const installationState: Record<
        "binary" | "receipt",
        "expected" | "missing"
      > = { binary: "expected", receipt: "expected" };
      const setupCommit = vi.fn();
      const dataCommit = vi.fn();

      const identifiedRemoval = (
        name: "binary" | "receipt",
      ): StagedFileRemoval => {
        return {
          stageDeletion: () => {
            installationState[name] = "missing";
          },
          assertDeleted: () => {
            if (installationState[name] !== "missing") {
              throw new Error(`${name} still present`);
            }
          },
          state: () => installationState[name],
          prepareCommit: vi.fn(),
          finalize: () => {
            if (name === failureAt) {
              throw new Error(`late ${name} validation failed`);
            }
          },
          commit: vi.fn(),
          rollback: () => {
            installationState[name] = "expected";
            return "restored";
          },
        };
      };

      await expect(
        runUninstall(
          {
            binaryPath: "/home/me/bin/lore",
            binaryIdentity: {
              device: 1n,
              inode: 2n,
              size: 3n,
              mtimeNs: 4n,
              sha256: "a".repeat(64),
            },
            manualBinaryPath: null,
            manualReceiptPath: null,
            receiptPath: "/home/me/.lore/install-path",
            receiptIdentity: {
              device: 5n,
              inode: 6n,
              size: 7n,
              mtimeNs: 8n,
              sha256: "b".repeat(64),
            },
            installDir: "/home/me/bin",
            removals: [{ path: "/home/me/.local/share/lore", recursive: true }],
            preservedDataPaths: [],
            packageManaged: false,
          },
          {
            gatewayRunning: async () => false,
            prevalidateSetupUndo: () => {},
            stageSetupUndo: () => {
              setupState = "undone";
              return {
                prepareCommit: vi.fn(),
                commit: setupCommit,
                rollback: () => {
                  setupState = "configured";
                },
              };
            },
            removeBinary: () => identifiedRemoval("binary"),
            removeReceipt: () => identifiedRemoval("receipt"),
            removePath: () => {
              dataState = "quarantined";
              return {
                prepareCommit: vi.fn(),
                commit: dataCommit,
                rollback: () => {
                  dataState = "present";
                },
              };
            },
            removePathBlocks: () => ({
              prepareCommit: vi.fn(),
              commit: vi.fn(),
              rollback: vi.fn(),
            }),
            log: vi.fn(),
          },
        ),
      ).rejects.toThrow(`late ${failureAt} validation failed`);

      expect(setupState).toBe("configured");
      expect(dataState).toBe("present");
      expect(installationState).toEqual({
        binary: "expected",
        receipt: "expected",
      });
      expect(setupCommit).not.toHaveBeenCalled();
      expect(dataCommit).not.toHaveBeenCalled();
    },
  );

  it("never attempts rollback after recursive deletion crosses the commit boundary", async () => {
    const setupCommit = vi.fn();
    const setupRollback = vi.fn();
    const dataRollback = vi.fn();

    await expect(
      runUninstall(
        {
          binaryPath: null,
          binaryIdentity: null,
          manualBinaryPath: null,
          manualReceiptPath: null,
          receiptPath: null,
          installDir: null,
          removals: [{ path: "/home/me/.local/share/lore", recursive: true }],
          preservedDataPaths: [],
          packageManaged: true,
        },
        {
          gatewayRunning: async () => false,
          prevalidateSetupUndo: () => {},
          stageSetupUndo: () => ({
            prepareCommit: vi.fn(),
            commit: setupCommit,
            rollback: setupRollback,
          }),
          removePath: () => ({
            prepareCommit: vi.fn(),
            commit: () => {
              throw new Error("partial recursive delete");
            },
            rollback: dataRollback,
          }),
          removePathBlocks: vi.fn(),
          removeBinary: vi.fn(),
          log: vi.fn(),
        },
      ),
    ).rejects.toThrow(/irreversible cleanup began/i);

    expect(setupCommit).toHaveBeenCalledOnce();
    expect(setupRollback).not.toHaveBeenCalled();
    expect(dataRollback).not.toHaveBeenCalled();
  });

  it("restores setup config and quarantined purge data on a late profile failure", async () => {
    const home = temporaryDirectory();
    const originalHome = process.env.HOME;
    const originalConfigDir = process.env.LORE_CONFIG_DIR;
    process.env.HOME = home;
    process.env.LORE_CONFIG_DIR = join(home, ".lore");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const config = join(home, ".claude", "settings.json");
      mkdirSync(dirname(config), { recursive: true });
      writeFileSync(config, '{"theme":"dark"}\n', { mode: 0o640 });
      await commandSetup(["claude-code"], { port: 3299 });
      const configured = readFileSync(config);
      const sidecar = `${config}.lore-backup`;
      const configuredSidecar = readFileSync(sidecar);

      const binary = join(home, "bin", "lore");
      mkdirSync(dirname(binary), { recursive: true });
      writeFileSync(binary, "standalone-binary");
      const purgeData = join(home, ".local", "share", "lore");
      mkdirSync(purgeData, { recursive: true });
      writeFileSync(join(purgeData, "lore.db"), "important-memory");
      const purgeIdentity = preflightRemoval(purgeData, true, home);

      await expect(
        withLifecycleLock("uninstall", (lock) =>
          runUninstall(
            {
              binaryPath: binary,
              binaryIdentity: fileIdentity(binary),
              manualBinaryPath: null,
              manualReceiptPath: null,
              receiptPath: null,
              installDir: dirname(binary),
              removals: [{ path: purgeData, recursive: true }],
              preservedDataPaths: [],
              packageManaged: false,
            },
            {
              gatewayRunning: async () => false,
              prevalidateSetupUndo,
              stageSetupUndo: () => stageSetupUndo(lock),
              removeBinary: (path, identity) =>
                removeBinary(path, identity, home),
              removePath: (path, recursive) =>
                removePath(path, recursive, purgeIdentity, home),
              removePathBlocks: () => ({
                prepareCommit: () => {
                  throw new Error("deterministic late profile failure");
                },
                commit: vi.fn(),
                rollback: vi.fn(),
              }),
              log: vi.fn(),
            },
          ),
        ),
      ).rejects.toThrow("deterministic late profile failure");

      expect(readFileSync(binary, "utf8")).toBe("standalone-binary");
      expect(readFileSync(join(purgeData, "lore.db"), "utf8")).toBe(
        "important-memory",
      );
      expect(readFileSync(config)).toEqual(configured);
      expect(readFileSync(sidecar)).toEqual(configuredSidecar);

      // Exact-generation restoration keeps the v3 sidecar usable, not merely
      // byte-equal. A real setup undo must still accept and consume it.
      await commandSetup(["undo", "claude-code"], {});
      expect(JSON.parse(readFileSync(config, "utf8"))).toEqual({
        theme: "dark",
      });
      expect(existsSync(sidecar)).toBe(false);
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalConfigDir === undefined) delete process.env.LORE_CONFIG_DIR;
      else process.env.LORE_CONFIG_DIR = originalConfigDir;
    }
  });
});

describe("gateway discovery", () => {
  it("fails closed on rejected process identity without probing a legacy port", async () => {
    const readPort = vi.fn(() => 4321);
    const probePort = vi.fn(async () => "healthy" as const);
    await expect(
      gatewayRunning({
        readProcessRecord: () => ({
          version: 1,
          pid: process.pid,
          port: 4321,
          hosts: ["127.0.0.1"],
          token: "a".repeat(32),
        }),
        authenticateProcess: async () => "rejected",
        readPort,
        probePort,
      }),
    ).rejects.toThrow(/identity check was rejected/);
    expect(readPort).not.toHaveBeenCalled();
    expect(probePort).not.toHaveBeenCalled();
  });
});
