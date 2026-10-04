import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { installStandalone } from "../src/cli/install";
import { commandUpgrade, standaloneUpgradeTargetDir } from "../src/cli/upgrade";
import {
  persistStandaloneUpgradeRecoveryJournal,
  recoverStandaloneUpgradePublication,
  standaloneUpgradeBackupTokens,
} from "../src/cli/upgrade-recovery";
import {
  formatStandaloneInstallReceipt,
  stageStandaloneUpgradeReceipt,
  standaloneInstallProvenance,
  type ExecutableIdentity,
} from "../src/cli/uninstall";
import {
  lifecycleLockPath,
  LifecycleLockBusyError,
} from "../src/lifecycle-lock";

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  rmSync(lifecycleLockPath(), { recursive: true, force: true });
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

interface UpgradeFixture {
  home: string;
  executable: string;
  receipt: string;
  installDir: string;
  oldExecutable: ExecutableIdentity;
  oldReceipt: ExecutableIdentity;
}

function fileIdentity(path: string): ExecutableIdentity {
  const info = lstatSync(path, { bigint: true });
  return {
    device: info.dev,
    inode: info.ino,
    size: info.size,
    mtimeNs: info.mtimeNs,
    sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
  };
}

function upgradeFixture(): UpgradeFixture {
  const home = mkdtempSync(join(tmpdir(), "lore-upgrade-recovery-"));
  temporaryDirectories.push(home);
  const installDir = join(home, "bin");
  const stateDir = join(home, ".lore");
  const executable = join(installDir, "lore");
  const receipt = join(stateDir, "install-path");
  mkdirSync(installDir, { mode: 0o700 });
  mkdirSync(stateDir, { mode: 0o700 });
  writeFileSync(executable, "old binary", { mode: 0o700 });
  const oldExecutable = fileIdentity(executable);
  writeFileSync(
    receipt,
    formatStandaloneInstallReceipt({
      executable,
      pathInstallDir: installDir,
      executableIdentity: oldExecutable,
    }),
    { mode: 0o600 },
  );
  return {
    home,
    executable,
    receipt,
    installDir,
    oldExecutable,
    oldReceipt: fileIdentity(receipt),
  };
}

function stageRecovery(
  fixture: UpgradeFixture,
  replacementContent = "new binary",
) {
  const previous = standaloneUpgradeBackupTokens(fixture.executable);
  const transaction = stageStandaloneUpgradeReceipt({
    executable: fixture.executable,
    executableIdentity: fixture.oldExecutable,
    receiptPath: fixture.receipt,
    receiptIdentity: fixture.oldReceipt,
    pathInstallDir: fixture.installDir,
    home: fixture.home,
  });
  const tokens = [...standaloneUpgradeBackupTokens(fixture.executable)].filter(
    (token) => !previous.has(token),
  );
  expect(tokens).toHaveLength(1);
  const token = tokens[0];
  const executableBackup = join(
    fixture.installDir,
    `.${basename(fixture.executable)}.upgrade-backup-${token}`,
  );
  const receiptBackup = join(
    dirname(fixture.receipt),
    `.${basename(fixture.receipt)}.upgrade-backup-${token}`,
  );
  const replacement = join(fixture.installDir, "replacement");
  writeFileSync(replacement, replacementContent, { mode: 0o700 });
  const replacementSha256 = fileIdentity(replacement).sha256;
  const journal = persistStandaloneUpgradeRecoveryJournal({
    executable: fixture.executable,
    receiptPath: fixture.receipt,
    pathInstallDir: fixture.installDir,
    oldExecutable: fixture.oldExecutable,
    oldReceipt: fixture.oldReceipt,
    replacementPath: replacement,
    expectedReplacementSha256: replacementSha256,
    previousBackupTokens: previous,
    home: fixture.home,
  });
  return {
    transaction,
    replacement,
    replacementSha256,
    token,
    executableBackup,
    receiptBackup,
    journal,
  };
}

function expectNoRecoveryArtifacts(fixture: UpgradeFixture): void {
  expect(
    readdirSync(fixture.installDir).filter((name) =>
      name.includes("upgrade-recovery"),
    ),
  ).toEqual([]);
  expect(
    readdirSync(dirname(fixture.receipt)).filter(
      (name) =>
        name.includes("upgrade-recovery") || name.includes("upgrade-backup"),
    ),
  ).toEqual([]);
  expect(standaloneUpgradeBackupTokens(fixture.executable).size).toBe(0);
}

describe("upgrade lifecycle lock", () => {
  test("package-managed upgrade cannot create an unmanaged standalone binary", () => {
    expect(() =>
      standaloneUpgradeTargetDir("/usr/bin/node", { hostedInstall: false }),
    ).toThrow(/npm install -g @loreai\/gateway@latest.*no standalone binary/i);
    expect(() =>
      standaloneUpgradeTargetDir("/usr/bin/node", { hostedInstall: false }),
    ).toThrow("curl -fsSL https://withlore.ai/install | bash`");
  });

  test("explains how to repair the receipt left behind by a 0.40.0 reinstall and upgrade", async () => {
    const fixture = upgradeFixture();
    // The 0.40.0 curl installer and upgrade both replaced the executable but
    // did not refresh an existing receipt from a previous nightly install.
    const oldInstallerBinary = join(fixture.installDir, "old-installer-binary");
    writeFileSync(oldInstallerBinary, "0.40.0 binary", { mode: 0o700 });
    renameSync(oldInstallerBinary, fixture.executable);
    const oldUpgradeBinary = join(fixture.installDir, "old-upgrade-binary");
    writeFileSync(oldUpgradeBinary, "nightly binary", { mode: 0o700 });
    renameSync(oldUpgradeBinary, fixture.executable);
    const originalReceipt = readFileSync(fixture.receipt);
    const provenance = standaloneInstallProvenance(fixture.executable, {
      seaBinary: true,
      home: fixture.home,
    });
    expect(provenance).toEqual({ hostedInstall: false });
    expect(() =>
      standaloneUpgradeTargetDir(
        fixture.executable,
        provenance,
        fixture.home,
        "nightly",
      ),
    ).toThrow(
      /curl -fsSL https:\/\/withlore\.ai\/install \| bash -s -- --version nightly/,
    );
    expect(readFileSync(fixture.receipt)).toEqual(originalReceipt);
    expect(standaloneUpgradeBackupTokens(fixture.executable).size).toBe(0);

    const verifiedDownload = join(fixture.home, "verified-download");
    writeFileSync(verifiedDownload, "verified nightly binary", { mode: 0o700 });
    await installStandalone({
      source: verifiedDownload,
      expectedSha256: fileIdentity(verifiedDownload).sha256,
      channel: "nightly",
      home: fixture.home,
      installDir: fixture.installDir,
      env: {},
      noModifyPath: true,
    });
    expect(
      standaloneInstallProvenance(fixture.executable, {
        seaBinary: true,
        home: fixture.home,
      }),
    ).toMatchObject({ hostedInstall: true });
  });

  test("verified hosted custom paths remain the upgrade target", () => {
    const fixture = upgradeFixture();
    expect(
      standaloneUpgradeTargetDir(
        fixture.executable,
        {
          hostedInstall: true,
          receiptPath: fixture.receipt,
          pathInstallDir: fixture.installDir,
          executableIdentity: fixture.oldExecutable,
          receiptIdentity: fixture.oldReceipt,
        },
        fixture.home,
      ),
    ).toBe(fixture.installDir);
  });

  test.skipIf(process.platform === "win32")(
    "rejects an unsafe install directory before staging upgrade backups",
    () => {
      const fixture = upgradeFixture();
      chmodSync(fixture.installDir, 0o775);
      expect(() =>
        standaloneUpgradeTargetDir(
          fixture.executable,
          {
            hostedInstall: true,
            receiptPath: fixture.receipt,
            pathInstallDir: fixture.installDir,
            executableIdentity: fixture.oldExecutable,
            receiptIdentity: fixture.oldReceipt,
          },
          fixture.home,
        ),
      ).toThrow(
        /unsafe standalone upgrade recovery directory.*group\/world-writable/,
      );
      expect(readdirSync(fixture.installDir)).toEqual(["lore"]);
      expect(readFileSync(fixture.executable, "utf8")).toBe("old binary");
      expect(standaloneUpgradeBackupTokens(fixture.executable).size).toBe(0);
    },
  );

  test("help does not acquire the lifecycle lock", async () => {
    const path = lifecycleLockPath();
    mkdirSync(path, { recursive: true, mode: 0o700 });
    writeFileSync(join(path, "owner.json"), "malformed lock", { mode: 0o600 });
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(commandUpgrade(["--help"])).resolves.toBeUndefined();
  });

  test("serializes check-only upgrades", async () => {
    vi.useFakeTimers();
    const path = lifecycleLockPath();
    mkdirSync(path, { recursive: true, mode: 0o700 });
    writeFileSync(join(path, "owner.json"), "malformed lock", { mode: 0o600 });
    const check = commandUpgrade(["--check"]);
    const rejection = expect(check).rejects.toBeInstanceOf(
      LifecycleLockBusyError,
    );
    await vi.advanceTimersByTimeAsync(5000);
    await rejection;
  });
});

describe("standalone upgrade crash recovery", () => {
  test("cleans a durable journal before binary publication", () => {
    const fixture = upgradeFixture();
    stageRecovery(fixture);
    expect(
      recoverStandaloneUpgradePublication({
        executable: fixture.executable,
        receiptPath: fixture.receipt,
        home: fixture.home,
      }),
    ).toEqual({ executable: fixture.executable, action: "cleaned" });
    expect(readFileSync(fixture.executable, "utf8")).toBe("old binary");
    expectNoRecoveryArtifacts(fixture);
  });

  test("completes receipt publication for the authenticated replacement", () => {
    const fixture = upgradeFixture();
    const staged = stageRecovery(fixture);
    renameSync(staged.replacement, fixture.executable);
    expect(
      recoverStandaloneUpgradePublication({
        executable: fixture.executable,
        receiptPath: fixture.receipt,
        home: fixture.home,
      }),
    ).toEqual({ executable: fixture.executable, action: "completed" });
    expect(readFileSync(fixture.executable, "utf8")).toBe("new binary");
    expect(
      standaloneInstallProvenance(fixture.executable, {
        seaBinary: true,
        home: fixture.home,
      }),
    ).toMatchObject({
      hostedInstall: true,
      executableIdentity: fileIdentity(fixture.executable),
    });
    expectNoRecoveryArtifacts(fixture);
  });

  test("restores the old pair when an unjournaled replacement wins", () => {
    const fixture = upgradeFixture();
    const staged = stageRecovery(fixture, "expected replacement");
    const attacker = join(fixture.installDir, "attacker");
    writeFileSync(attacker, "unjournaled replacement", { mode: 0o700 });
    renameSync(attacker, fixture.executable);
    expect(
      recoverStandaloneUpgradePublication({
        executable: fixture.executable,
        receiptPath: fixture.receipt,
        home: fixture.home,
      }).action,
    ).toBe("restored");
    expect(fileIdentity(fixture.executable)).toEqual(fixture.oldExecutable);
    expect(
      readFileSync(
        join(
          fixture.installDir,
          `.${basename(fixture.executable)}.upgrade-recovery-displaced-${staged.token}`,
        ),
        "utf8",
      ),
    ).toBe("unjournaled replacement");
  });

  test("preserves a coherent successor generation", () => {
    const fixture = upgradeFixture();
    stageRecovery(fixture);
    const successor = join(fixture.installDir, "successor");
    writeFileSync(successor, "coherent successor", { mode: 0o700 });
    renameSync(successor, fixture.executable);
    const successorReceipt = join(
      dirname(fixture.receipt),
      "successor-receipt",
    );
    writeFileSync(
      successorReceipt,
      formatStandaloneInstallReceipt({
        executable: fixture.executable,
        pathInstallDir: fixture.installDir,
        executableIdentity: fileIdentity(fixture.executable),
      }),
      { mode: 0o600 },
    );
    renameSync(successorReceipt, fixture.receipt);
    expect(
      recoverStandaloneUpgradePublication({
        executable: fixture.executable,
        receiptPath: fixture.receipt,
        home: fixture.home,
      }).action,
    ).toBe("cleaned");
    expect(readFileSync(fixture.executable, "utf8")).toBe("coherent successor");
    expectNoRecoveryArtifacts(fixture);
  });

  test("requires backup-path invocation when canonical publication is empty", () => {
    const fixture = upgradeFixture();
    const staged = stageRecovery(fixture);
    renameSync(fixture.executable, join(fixture.installDir, "quarantined"));
    expect(() =>
      recoverStandaloneUpgradePublication({
        executable: fixture.executable,
        receiptPath: fixture.receipt,
        home: fixture.home,
      }),
    ).toThrow(/invoke the authenticated upgrade backup path/i);
    expect(existsSync(staged.executableBackup)).toBe(true);
    expect(existsSync(staged.journal)).toBe(true);
  });

  test("recovers an empty canonical path when invoked through its backup", () => {
    const fixture = upgradeFixture();
    const staged = stageRecovery(fixture);
    renameSync(fixture.executable, join(fixture.installDir, "quarantined"));
    expect(
      recoverStandaloneUpgradePublication({
        executable: staged.executableBackup,
        receiptPath: fixture.receipt,
        home: fixture.home,
      }),
    ).toEqual({ executable: fixture.executable, action: "restored" });
    expect(fileIdentity(fixture.executable)).toEqual(fixture.oldExecutable);
  });

  test("refuses ambiguous valid generations without consuming artifacts", () => {
    const fixture = upgradeFixture();
    const staged = stageRecovery(fixture);
    const token = `2-${"f".repeat(16)}`;
    linkSync(
      staged.executableBackup,
      join(
        fixture.installDir,
        `.${basename(fixture.executable)}.upgrade-backup-${token}`,
      ),
    );
    linkSync(
      staged.receiptBackup,
      join(
        dirname(fixture.receipt),
        `.${basename(fixture.receipt)}.upgrade-backup-${token}`,
      ),
    );
    expect(() =>
      recoverStandaloneUpgradePublication({
        executable: fixture.executable,
        receiptPath: fixture.receipt,
        home: fixture.home,
      }),
    ).toThrow(/ambiguous with another valid backup generation/i);
    expect(standaloneUpgradeBackupTokens(fixture.executable).size).toBe(2);
    expect(existsSync(staged.journal)).toBe(true);
  });
});
