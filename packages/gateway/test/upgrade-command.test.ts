import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { commandUpgrade } from "../src/cli/upgrade";
import { VERSION } from "../src/cli/version";
import { executeUpgrade, fetchLatestVersion } from "../src/cli/lib/upgrade";
import {
  closeUpgradeDownloadDirectory,
  createUpgradeDownloadDirectory,
} from "../src/cli/lib/upgrade-download";
import { formatStandaloneInstallReceipt } from "../src/cli/uninstall";
import { standaloneUpgradeBackupTokens } from "../src/cli/upgrade-recovery";

const state = vi.hoisted(() => ({ home: "" }));
const leftoverDirs: string[] = [];

vi.mock("../src/lifecycle-lock", () => ({
  withLifecycleLock: async (
    _operation: string,
    callback: (lock: { assertOwned: () => void }) => Promise<void>,
  ) => callback({ assertOwned: () => {} }),
}));

vi.mock("../src/cli/lib/upgrade", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/cli/lib/upgrade")>()),
  getReleaseChannel: () => "nightly",
  fetchLatestVersion: vi.fn(),
  executeUpgrade: vi.fn(),
}));

vi.mock("../src/cli/upgrade-recovery", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/cli/upgrade-recovery")>();
  return {
    ...actual,
    recoverStandaloneUpgradePublication: (input: { executable: string }) =>
      actual.recoverStandaloneUpgradePublication({
        ...input,
        home: state.home,
      }),
  };
});

const originalExecutable = process.execPath;

afterEach(() => {
  process.execPath = originalExecutable;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const path of leftoverDirs.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
  if (state.home) rmSync(state.home, { recursive: true, force: true });
  state.home = "";
});

function receiptFixture(stale = true): {
  executable: string;
  receipt: string;
  installDir: string;
} {
  const home = mkdtempSync(join(tmpdir(), "lore-upgrade-command-"));
  state.home = home;
  vi.stubEnv("HOME", home);
  const installDir = join(home, "bin");
  const stateDir = join(home, ".lore");
  const executable = join(installDir, "lore");
  const receipt = join(stateDir, "install-path");
  mkdirSync(installDir, { mode: 0o700 });
  mkdirSync(stateDir, { mode: 0o700 });
  writeFileSync(executable, "previous nightly", { mode: 0o700 });
  const identity = lstatSync(executable, { bigint: true });
  writeFileSync(
    receipt,
    formatStandaloneInstallReceipt({
      executable,
      pathInstallDir: installDir,
      executableIdentity: {
        device: identity.dev,
        inode: identity.ino,
        size: identity.size,
        mtimeNs: identity.mtimeNs,
        sha256: createHash("sha256")
          .update(readFileSync(executable))
          .digest("hex"),
      },
    }),
    { mode: 0o600 },
  );
  if (stale) {
    // An old curl reinstall followed by an old nightly upgrade left this
    // receipt bound to a binary that no longer exists.
    for (const binary of ["0.40.0", "nightly"]) {
      const replacement = join(installDir, "replacement");
      writeFileSync(replacement, binary, { mode: 0o700 });
      renameSync(replacement, executable);
    }
  }
  process.execPath = executable;
  vi.spyOn(
    require("node:sea") as typeof import("node:sea"),
    "isSea",
  ).mockReturnValue(true);
  vi.spyOn(console, "error").mockImplementation(() => {});
  return { executable, receipt, installDir };
}

describe("upgrade command stale-receipt ordering", () => {
  test.skipIf(process.platform === "win32")(
    "preserves a verified Windows already-current upgrade as a no-op",
    async () => {
      const fixture = receiptFixture(false);
      vi.mocked(fetchLatestVersion).mockResolvedValue(VERSION);
      vi.mocked(executeUpgrade).mockClear();
      const platform = Object.getOwnPropertyDescriptor(process, "platform");
      if (!platform) throw new Error("Missing process platform descriptor");
      try {
        Object.defineProperty(process, "platform", {
          ...platform,
          value: "win32",
        });
        await commandUpgrade([]);
        expect(executeUpgrade).not.toHaveBeenCalled();
        expect(readFileSync(fixture.executable, "utf8")).toBe(
          "previous nightly",
        );
      } finally {
        Object.defineProperty(process, "platform", platform);
        vi.mocked(fetchLatestVersion).mockClear();
      }
    },
  );

  test("explains receipt repair even when the installed version is current", async () => {
    const fixture = receiptFixture();
    const receipt = readFileSync(fixture.receipt);
    vi.mocked(fetchLatestVersion).mockResolvedValue(VERSION);

    await expect(commandUpgrade([])).rejects.toThrow(
      /curl -fsSL https:\/\/withlore\.ai\/install \| bash -s -- --version nightly/,
    );
    expect(fetchLatestVersion).not.toHaveBeenCalled();
    expect(readFileSync(fixture.receipt)).toEqual(receipt);
    expect(readdirSync(fixture.installDir)).toEqual(["lore"]);
    expect(standaloneUpgradeBackupTokens(fixture.executable).size).toBe(0);
  });

  test("explains receipt repair before an uncached offline target fails", async () => {
    const fixture = receiptFixture();
    const receipt = readFileSync(fixture.receipt);

    await expect(commandUpgrade(["--offline"])).rejects.toThrow(
      /curl -fsSL https:\/\/withlore\.ai\/install \| bash -s -- --version nightly/,
    );
    expect(fetchLatestVersion).not.toHaveBeenCalled();
    expect(readFileSync(fixture.receipt)).toEqual(receipt);
    expect(readdirSync(fixture.installDir)).toEqual(["lore"]);
    expect(standaloneUpgradeBackupTokens(fixture.executable).size).toBe(0);
  });

  test.skipIf(process.platform === "win32")(
    "rejects permissions changed during download before staging backups",
    async () => {
      const fixture = receiptFixture(false);
      const receipt = readFileSync(fixture.receipt);
      const download = join(state.home, "download");
      writeFileSync(download, "verified download", { mode: 0o700 });
      vi.mocked(fetchLatestVersion).mockResolvedValue("0.41.0-dev.9999999999");
      vi.mocked(executeUpgrade).mockImplementation(async (...args) => {
        const downloadDir = args[5]?.path;
        if (downloadDir === undefined) {
          throw new Error("Upgrade download directory was not provided");
        }
        expect(dirname(downloadDir)).toBe(realpathSync(tmpdir()));
        expect(statSync(downloadDir).mode & 0o777).toBe(0o700);
        chmodSync(fixture.installDir, 0o775);
        return { tempBinaryPath: download };
      });

      await expect(commandUpgrade([])).rejects.toThrow(
        /unsafe standalone upgrade recovery directory.*group\/world-writable/,
      );
      expect(executeUpgrade).toHaveBeenCalledOnce();
      expect(readFileSync(fixture.receipt)).toEqual(receipt);
      expect(readFileSync(fixture.executable, "utf8")).toBe("previous nightly");
      expect(readdirSync(fixture.installDir)).toEqual(["lore"]);
      expect(readdirSync(join(state.home, ".lore"))).toEqual(["install-path"]);
      expect(standaloneUpgradeBackupTokens(fixture.executable).size).toBe(0);
    },
  );

  test.skipIf(process.platform === "win32")(
    "preserves a replacement private directory during upgrade cleanup",
    async () => {
      const fixture = receiptFixture(false);
      const download = join(state.home, "download");
      writeFileSync(download, "verified download", { mode: 0o700 });
      vi.mocked(fetchLatestVersion).mockResolvedValue("0.41.0-dev.9999999999");
      let replacement = "";
      vi.mocked(executeUpgrade).mockImplementation(async (...args) => {
        const directory = args[5];
        if (!directory) throw new Error("Missing private download directory");
        replacement = directory.path;
        renameSync(replacement, `${replacement}-moved`);
        leftoverDirs.push(`${replacement}-moved`, replacement);
        mkdirSync(replacement, { mode: 0o700 });
        writeFileSync(join(replacement, "unrelated"), "keep this");
        chmodSync(fixture.installDir, 0o775);
        return { tempBinaryPath: download };
      });

      await expect(commandUpgrade([])).rejects.toThrow(
        /unsafe standalone upgrade recovery directory/,
      );
      expect(readFileSync(join(replacement, "unrelated"), "utf8")).toBe(
        "keep this",
      );
    },
  );

  test("leaves an interrupted named file and its symlink target untouched", async () => {
    const fixture = receiptFixture(false);
    const tempRoot = join(state.home, "temp");
    mkdirSync(tempRoot, { mode: 0o700 });
    vi.stubEnv("TMPDIR", tempRoot);
    const interrupted = createUpgradeDownloadDirectory(
      fixture.executable,
      fixture.receipt,
    );
    const abandoned = interrupted.path;
    closeUpgradeDownloadDirectory(interrupted);
    writeFileSync(join(abandoned, "lore.download"), "partial binary");
    const victim = join(state.home, "victim");
    writeFileSync(victim, "do not change", { mode: 0o600 });
    if (process.platform !== "win32") {
      rmSync(join(abandoned, "lore.download"));
      symlinkSync(victim, join(abandoned, "lore.download"));
    }
    const unrelated = mkdtempSync(join(tempRoot, "lore-upgrade-download-"));
    writeFileSync(join(unrelated, "other"), "preserve");
    const otherOwner = mkdtempSync(join(tempRoot, "lore-upgrade-download-"));
    writeFileSync(join(otherOwner, ".owner"), `${"0".repeat(64)}\n`, {
      mode: 0o600,
    });
    writeFileSync(join(otherOwner, "other"), "other installation");
    vi.mocked(fetchLatestVersion).mockResolvedValue("0.41.0-dev.9999999999");
    vi.mocked(executeUpgrade).mockRejectedValue(new Error("stopped"));

    await expect(commandUpgrade([])).rejects.toThrow("stopped");
    expect(existsSync(abandoned)).toBe(true);
    expect(readFileSync(victim, "utf8")).toBe("do not change");
    expect(readFileSync(join(unrelated, "other"), "utf8")).toBe("preserve");
    expect(readFileSync(join(otherOwner, "other"), "utf8")).toBe(
      "other installation",
    );
  });

  test("leaves an interrupted named file untouched on an already-current return", async () => {
    const fixture = receiptFixture(false);
    const tempRoot = join(state.home, "temp");
    mkdirSync(tempRoot, { mode: 0o700 });
    vi.stubEnv("TMPDIR", tempRoot);
    const interrupted = createUpgradeDownloadDirectory(
      fixture.executable,
      fixture.receipt,
    );
    const abandoned = interrupted.path;
    closeUpgradeDownloadDirectory(interrupted);
    writeFileSync(join(abandoned, "lore.download"), "partial binary");
    vi.mocked(fetchLatestVersion).mockResolvedValue(VERSION);
    vi.mocked(executeUpgrade).mockClear();

    await commandUpgrade([]);
    expect(readFileSync(join(abandoned, "lore.download"), "utf8")).toBe(
      "partial binary",
    );
    expect(executeUpgrade).not.toHaveBeenCalled();
    expect(readFileSync(fixture.executable, "utf8")).toBe("previous nightly");
  });
});
