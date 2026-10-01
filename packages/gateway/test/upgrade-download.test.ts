import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { applyPatch } from "binpatch";
import { expect, test, vi } from "vitest";
import {
  closeUpgradeDownloadDirectory,
  createUpgradeDownloadDirectory,
  openUpgradeDownloadDirectory,
  openUpgradeDownloadFile,
  reclaimUpgradeDownloads,
  removeUpgradeDownloadDirectory,
} from "../src/cli/lib/upgrade-download";

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    lstatSync: vi.fn(fs.lstatSync),
    rmSync: vi.fn(fs.rmSync),
  };
});

test.skipIf(process.platform === "win32")(
  "preserves a file added to the opened directory after quarantine moves",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "lore-upgrade-moved-"));
    vi.stubEnv("TMPDIR", root);
    const directory = createUpgradeDownloadDirectory(
      "/home/user/lore",
      "/home/user/.lore/install-path",
    );
    writeFileSync(join(directory.path, "lore.download"), "partial binary");
    const originalFs =
      await vi.importActual<typeof import("node:fs")>("node:fs");
    const moved = `${directory.path}.moved`;
    const swapped = { value: false };
    vi.mocked(lstatSync).mockImplementation((path) => {
      const stat = originalFs.lstatSync(path, { bigint: true });
      if (!swapped.value && String(path).includes(".cleanup-")) {
        swapped.value = true;
        renameSync(String(path), moved);
        writeFileSync(join(moved, "unrelated"), "keep this");
      }
      return stat;
    });
    try {
      try {
        removeUpgradeDownloadDirectory(directory);
      } catch {
        // The original implementation also fails its final path check.
      }
      expect(swapped.value).toBe(true);
      expect(readFileSync(join(moved, "unrelated"), "utf8")).toBe("keep this");
    } finally {
      vi.mocked(lstatSync).mockRestore();
      closeUpgradeDownloadDirectory(directory);
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "never removes an empty replacement after the final identity check",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "lore-upgrade-empty-swap-"));
    vi.stubEnv("TMPDIR", root);
    const directory = createUpgradeDownloadDirectory(
      "/home/user/lore",
      "/home/user/.lore/install-path",
    );
    const originalFs =
      await vi.importActual<typeof import("node:fs")>("node:fs");
    const moved = `${directory.path}.moved`;
    const replacement = { path: "" };
    const checked = { count: 0 };
    vi.mocked(lstatSync).mockImplementation((path) => {
      const stat = originalFs.lstatSync(path, { bigint: true });
      if (String(path).includes(".cleanup-") && ++checked.count === 2) {
        replacement.path = String(path);
        renameSync(String(path), moved);
        mkdirSync(String(path), { mode: 0o700 });
      }
      return stat;
    });
    try {
      removeUpgradeDownloadDirectory(directory);
      expect(replacement.path).not.toBe("");
      expect(existsSync(replacement.path)).toBe(true);
    } finally {
      vi.mocked(lstatSync).mockRestore();
      closeUpgradeDownloadDirectory(directory);
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "does not consume a fabricated scoped directory with unrelated contents",
  () => {
    const root = mkdtempSync(join(tmpdir(), "lore-upgrade-forged-"));
    vi.stubEnv("TMPDIR", root);
    const executable = "/home/user/lore";
    const receipt = "/home/user/.lore/install-path";
    const forged = mkdtempSync(join(root, "lore-upgrade-download-"));
    const scope = createHash("sha256")
      .update(`${executable}\n${receipt}`)
      .digest("hex");
    writeFileSync(join(forged, ".owner"), `${scope}\n`, { mode: 0o600 });
    writeFileSync(join(forged, "unrelated"), "keep this");
    try {
      reclaimUpgradeDownloads(executable, receipt);
      expect(readFileSync(join(forged, "unrelated"), "utf8")).toBe("keep this");
    } finally {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "binpatch writes to an opened inode after its output name is swapped",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "lore-upgrade-delta-fd-"));
    vi.stubEnv("TMPDIR", root);
    const directory = openUpgradeDownloadDirectory(root);
    try {
      const old = join(root, "old-binary");
      const victim = join(root, "victim");
      writeFileSync(old, "previous binary");
      writeFileSync(victim, "do not change", { mode: 0o600 });
      const output = openUpgradeDownloadFile(directory, "lore.download");
      unlinkSync(join(root, "lore.download"));
      symlinkSync(victim, join(root, "lore.download"));

      const replacement = Buffer.from("patched binary");
      const control = Buffer.alloc(24);
      control.writeBigUInt64LE(BigInt(replacement.length), 8);
      const compressedControl = zstdCompressSync(control);
      const compressedDiff = zstdCompressSync(Buffer.alloc(0));
      const compressedExtra = zstdCompressSync(replacement);
      const header = Buffer.alloc(32);
      header.write("TRDIFF10");
      header.writeBigUInt64LE(BigInt(compressedControl.length), 8);
      header.writeBigUInt64LE(BigInt(compressedDiff.length), 16);
      header.writeBigUInt64LE(BigInt(replacement.length), 24);
      const patch = Buffer.concat([
        header,
        compressedControl,
        compressedDiff,
        compressedExtra,
      ]);

      await applyPatch(old, patch, output);
      expect(readFileSync(output)).toEqual(replacement);
      expect(readFileSync(victim, "utf8")).toBe("do not change");
    } finally {
      closeUpgradeDownloadDirectory(directory);
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "preserves a replacement swapped after quarantine identity verification",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "lore-upgrade-cleanup-race-"));
    vi.stubEnv("TMPDIR", root);
    const directory = createUpgradeDownloadDirectory(
      "/home/user/lore",
      "/home/user/.lore/install-path",
    );
    writeFileSync(join(directory.path, "lore.download"), "partial binary");
    const originalFs =
      await vi.importActual<typeof import("node:fs")>("node:fs");
    const moved = `${directory.path}.moved`;
    const replacement = { path: "" };
    const checked = { count: 0 };
    vi.mocked(lstatSync).mockImplementation((path) => {
      const stat = originalFs.lstatSync(path, { bigint: true });
      if (String(path).includes(".cleanup-") && ++checked.count === 2) {
        replacement.path = String(path);
        renameSync(String(path), moved);
        mkdirSync(String(path), { mode: 0o700 });
        writeFileSync(join(String(path), "unrelated"), "keep this");
      }
      return stat;
    });
    try {
      removeUpgradeDownloadDirectory(directory);
      expect(replacement.path).not.toBe("");
      expect(readFileSync(join(replacement.path, "unrelated"), "utf8")).toBe(
        "keep this",
      );
    } finally {
      vi.mocked(lstatSync).mockRestore();
      closeUpgradeDownloadDirectory(directory);
      vi.unstubAllEnvs();
      rmSync(directory.path, { recursive: true, force: true });
      if (replacement.path) {
        rmSync(replacement.path, { recursive: true, force: true });
      }
      rmSync(moved, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "reclaims a scoped download left in quarantine after a crash",
  () => {
    const root = mkdtempSync(join(tmpdir(), "lore-upgrade-crash-"));
    vi.stubEnv("TMPDIR", root);
    const executable = "/home/user/lore";
    const receipt = "/home/user/.lore/install-path";
    const directory = createUpgradeDownloadDirectory(executable, receipt);
    const quarantined = `${directory.path}.cleanup-${"a".repeat(32)}`;
    const victim = join(root, "victim");
    writeFileSync(victim, "do not change");
    symlinkSync(victim, join(directory.path, "lore.download"));
    closeUpgradeDownloadDirectory(directory);
    renameSync(directory.path, quarantined);
    try {
      reclaimUpgradeDownloads(executable, receipt);
      expect(readdirSync(quarantined)).toEqual([]);
      expect(readFileSync(victim, "utf8")).toBe("do not change");
    } finally {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("refuses Windows pathname staging before creating an output file", () => {
  const root = mkdtempSync(join(tmpdir(), "lore-upgrade-windows-guard-"));
  vi.stubEnv("TMPDIR", root);
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  if (!platform) throw new Error("Missing process platform descriptor");
  try {
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    expect(() =>
      createUpgradeDownloadDirectory(
        "C:/Users/user/lore.exe",
        "C:/Users/user/install-path",
      ),
    ).toThrow(/Windows.*handle-bound/i);
    expect(existsSync(join(root, "lore.download"))).toBe(false);
  } finally {
    Object.defineProperty(process, "platform", platform);
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
});
