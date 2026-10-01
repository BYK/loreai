import { createHash } from "node:crypto";
import {
  constants,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  openSync,
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
  removeUpgradeDownloadDirectory,
} from "../src/cli/lib/upgrade-download";

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    lstatSync: vi.fn(fs.lstatSync),
    openSync: vi.fn(fs.openSync),
    readdirSync: vi.fn(fs.readdirSync),
    rmSync: vi.fn(fs.rmSync),
    unlinkSync: vi.fn(fs.unlinkSync),
  };
});

test.skipIf(process.platform === "win32")(
  "writes the marker to the opened staging directory after a path swap",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "lore-upgrade-record-parent-"));
    vi.stubEnv("TMPDIR", root);
    const moved = join(root, "staging-moved");
    const victim = join(root, "victim");
    mkdirSync(victim, { mode: 0o700 });
    writeFileSync(join(victim, "sentinel"), "keep this");
    const originalFs =
      await vi.importActual<typeof import("node:fs")>("node:fs");
    const swapped = { value: false };
    vi.mocked(openSync).mockImplementation((...args) => {
      if (
        !swapped.value &&
        String(args[0]).endsWith("/.owner") &&
        (Number(args[1]) & constants.O_CREAT) !== 0
      ) {
        swapped.value = true;
        const staging = readdirSync(root).find((name) =>
          name.startsWith("lore-upgrade-download-"),
        );
        if (!staging) throw new Error("Missing staging directory");
        renameSync(join(root, staging), moved);
        symlinkSync(victim, join(root, staging));
      }
      return Reflect.apply(originalFs.openSync, originalFs, args);
    });
    try {
      const directory = createUpgradeDownloadDirectory(
        join(root, "lore"),
        join(root, "install-path"),
      );
      closeUpgradeDownloadDirectory(directory);
      expect(swapped.value).toBe(true);
      expect(readdirSync(victim)).toEqual(["sentinel"]);
      expect(readdirSync(moved)).toEqual([".owner"]);
    } finally {
      vi.mocked(openSync).mockRestore();
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "preserves a file added to the opened directory after its pathname moves",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "lore-upgrade-moved-"));
    vi.stubEnv("TMPDIR", root);
    const directory = createUpgradeDownloadDirectory(
      join(root, "lore"),
      join(root, "install-path"),
    );
    writeFileSync(join(directory.path, "lore.download"), "partial binary");
    const originalFs =
      await vi.importActual<typeof import("node:fs")>("node:fs");
    const moved = `${directory.path}.moved`;
    const swapped = { value: false };
    vi.mocked(lstatSync).mockImplementation((path) => {
      const stat = originalFs.lstatSync(path, { bigint: true });
      if (!swapped.value && String(path) === directory.path) {
        swapped.value = true;
        renameSync(directory.path, moved);
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
      join(root, "lore"),
      join(root, "install-path"),
    );
    const originalFs =
      await vi.importActual<typeof import("node:fs")>("node:fs");
    const moved = `${directory.path}.moved`;
    const replacement = { path: "" };
    const checked = { count: 0 };
    vi.mocked(lstatSync).mockImplementation((path) => {
      const stat = originalFs.lstatSync(path, { bigint: true });
      if (String(path) === directory.path && ++checked.count === 1) {
        replacement.path = directory.path;
        renameSync(directory.path, moved);
        mkdirSync(directory.path, { mode: 0o700 });
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
    const executable = join(root, "lore");
    const receipt = join(root, "install-path");
    const forged = mkdtempSync(join(root, "lore-upgrade-download-"));
    const scope = createHash("sha256")
      .update(`${executable}\n${receipt}`)
      .digest("hex");
    writeFileSync(join(forged, ".owner"), `${scope}\n`, { mode: 0o600 });
    writeFileSync(join(forged, "unrelated"), "keep this");
    try {
      const staged = createUpgradeDownloadDirectory(executable, receipt);
      expect(staged.path).not.toBe(forged);
      closeUpgradeDownloadDirectory(staged);
      expect(readFileSync(join(forged, "unrelated"), "utf8")).toBe("keep this");
    } finally {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "preserves an unrecorded directory even when its marker and output name match",
  () => {
    const root = mkdtempSync(join(tmpdir(), "lore-upgrade-forged-output-"));
    vi.stubEnv("TMPDIR", root);
    const executable = join(root, "lore");
    const receipt = join(root, "install-path");
    const forged = mkdtempSync(join(root, "lore-upgrade-download-"));
    const scope = createHash("sha256")
      .update(`${executable}\n${receipt}`)
      .digest("hex");
    writeFileSync(join(forged, ".owner"), `${scope}\n`, { mode: 0o600 });
    writeFileSync(join(forged, "lore.download"), "keep this");
    try {
      const staged = createUpgradeDownloadDirectory(executable, receipt);
      expect(staged.path).not.toBe(forged);
      closeUpgradeDownloadDirectory(staged);
      expect(readFileSync(join(forged, "lore.download"), "utf8")).toBe(
        "keep this",
      );
    } finally {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform !== "linux")(
  "reuses one recorded empty staging generation across upgrades",
  () => {
    const root = mkdtempSync(join(tmpdir(), "lore-upgrade-reuse-"));
    vi.stubEnv("TMPDIR", root);
    const executable = join(root, "lore");
    const receipt = join(root, "install-path");
    try {
      for (const attempt of [1, 2, 3]) {
        const directory = createUpgradeDownloadDirectory(executable, receipt);
        const output = openUpgradeDownloadFile(directory, "lore.download");
        writeFileSync(output, `attempt ${attempt}`);
        expect(existsSync(join(directory.path, "lore.download"))).toBe(false);
        expect(removeUpgradeDownloadDirectory(directory)).toBe(true);
        closeUpgradeDownloadDirectory(directory);
        expect(
          readdirSync(root).filter((name) =>
            name.startsWith("lore-upgrade-download-"),
          ),
        ).toHaveLength(1);
      }
    } finally {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "releases an interrupted download when its opened descriptor closes",
  () => {
    const root = mkdtempSync(join(tmpdir(), "lore-upgrade-unlinked-"));
    vi.stubEnv("TMPDIR", root);
    try {
      const directory = createUpgradeDownloadDirectory(
        join(root, "lore"),
        join(root, "install-path"),
      );
      const output = openUpgradeDownloadFile(directory, "lore.download");
      writeFileSync(output, "partial binary");
      expect(readFileSync(output, "utf8")).toBe("partial binary");
      expect(readdirSync(directory.path)).toEqual(
        process.platform === "linux" ? [".owner"] : [".owner", "lore.download"],
      );
      closeUpgradeDownloadDirectory(directory);
      expect(() => readFileSync(output)).toThrow();
    } finally {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform !== "linux")(
  "never unlinks a replacement swapped into the output name after opening",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "lore-upgrade-open-unlink-"));
    vi.stubEnv("TMPDIR", root);
    const directory = createUpgradeDownloadDirectory(
      join(root, "lore"),
      join(root, "install-path"),
    );
    const victim = join(root, "victim");
    writeFileSync(victim, "keep this");
    const originalFs =
      await vi.importActual<typeof import("node:fs")>("node:fs");
    const swapped = { value: false };
    vi.mocked(unlinkSync).mockImplementation((...args) => {
      if (!swapped.value && String(args[0]).endsWith("lore.download")) {
        swapped.value = true;
        renameSync(String(args[0]), `${String(args[0])}.opened`);
        renameSync(victim, String(args[0]));
      }
      return Reflect.apply(originalFs.unlinkSync, originalFs, args);
    });
    try {
      const output = openUpgradeDownloadFile(directory, "lore.download");
      writeFileSync(output, "replacement");
      if (swapped.value) {
        expect(
          readFileSync(join(directory.path, "lore.download"), "utf8"),
        ).toBe("keep this");
      } else {
        expect(readFileSync(victim, "utf8")).toBe("keep this");
      }
    } finally {
      vi.mocked(unlinkSync).mockRestore();
      closeUpgradeDownloadDirectory(directory);
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "reclaims the recorded inode without consuming a matching forged sibling",
  () => {
    const root = mkdtempSync(join(tmpdir(), "lore-upgrade-recorded-"));
    vi.stubEnv("TMPDIR", root);
    const executable = join(root, "lore");
    const receipt = join(root, "install-path");
    const owned = createUpgradeDownloadDirectory(executable, receipt);
    const output = openUpgradeDownloadFile(owned, "lore.download");
    writeFileSync(output, "partial binary");
    closeUpgradeDownloadDirectory(owned);
    const forged = mkdtempSync(join(root, "lore-upgrade-download-"));
    const scope = createHash("sha256")
      .update(`${executable}\n${receipt}`)
      .digest("hex");
    writeFileSync(join(forged, ".owner"), `${scope}\n`, { mode: 0o600 });
    writeFileSync(join(forged, "lore.download"), "keep this");
    try {
      expect(existsSync(owned.path)).toBe(true);
      const reused = createUpgradeDownloadDirectory(executable, receipt);
      expect(reused.path).toBe(owned.path);
      closeUpgradeDownloadDirectory(reused);
      expect(readFileSync(join(forged, "lore.download"), "utf8")).toBe(
        "keep this",
      );
    } finally {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "keeps reusable staging scoped to the verified install path",
  () => {
    const root = mkdtempSync(join(tmpdir(), "lore-upgrade-path-change-"));
    vi.stubEnv("TMPDIR", root);
    const receipt = join(root, "install-path");
    try {
      const oldExecutable = join(root, "old", "lore");
      const oldDirectory = createUpgradeDownloadDirectory(
        oldExecutable,
        receipt,
      );
      closeUpgradeDownloadDirectory(oldDirectory);
      const newDirectory = createUpgradeDownloadDirectory(
        join(root, "new", "lore"),
        receipt,
      );
      expect(newDirectory.path).not.toBe(oldDirectory.path);
      closeUpgradeDownloadDirectory(newDirectory);
      const reused = createUpgradeDownloadDirectory(oldExecutable, receipt);
      expect(reused.path).toBe(oldDirectory.path);
      closeUpgradeDownloadDirectory(reused);
    } finally {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "stages another upgrade after the OS removes its recorded temp directory",
  () => {
    const root = mkdtempSync(join(tmpdir(), "lore-upgrade-stale-record-"));
    vi.stubEnv("TMPDIR", root);
    const executable = join(root, "lore");
    const receipt = join(root, "install-path");
    try {
      const first = createUpgradeDownloadDirectory(executable, receipt);
      closeUpgradeDownloadDirectory(first);
      rmSync(first.path, { recursive: true });
      const second = createUpgradeDownloadDirectory(executable, receipt);
      expect(second.path).not.toBe(first.path);
      closeUpgradeDownloadDirectory(second);
    } finally {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "does not accumulate durable records after repeated temp cleanup",
  () => {
    const root = mkdtempSync(join(tmpdir(), "lore-upgrade-stale-records-"));
    vi.stubEnv("TMPDIR", root);
    const executable = join(root, "lore");
    const receipt = join(root, "install-path");
    try {
      for (const _attempt of [1, 2, 3]) {
        const directory = createUpgradeDownloadDirectory(executable, receipt);
        closeUpgradeDownloadDirectory(directory);
        rmSync(directory.path, { recursive: true });
      }
      expect(
        readdirSync(root).filter((name) =>
          name.startsWith("install-path.upgrade-download-record-"),
        ),
      ).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "does not consume a forged scoped directory containing an output",
  () => {
    const root = mkdtempSync(join(tmpdir(), "lore-upgrade-forged-record-"));
    vi.stubEnv("TMPDIR", root);
    const executable = join(root, "lore");
    const receipt = join(root, "install-path");
    try {
      const owned = createUpgradeDownloadDirectory(executable, receipt);
      closeUpgradeDownloadDirectory(owned);
      const forged = mkdtempSync(join(root, "lore-upgrade-download-"));
      const scope = createHash("sha256")
        .update(`${executable}\n${receipt}`)
        .digest("hex");
      writeFileSync(join(forged, ".owner"), `${scope}\n`, { mode: 0o600 });
      writeFileSync(join(forged, "lore.download"), "keep this");
      const staged = createUpgradeDownloadDirectory(executable, receipt);
      expect(staged.path).toBe(owned.path);
      closeUpgradeDownloadDirectory(staged);
      expect(readFileSync(join(forged, "lore.download"), "utf8")).toBe(
        "keep this",
      );
    } finally {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "preserves an unrelated output substituted after its first identity check",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "lore-upgrade-late-output-"));
    vi.stubEnv("TMPDIR", root);
    const directory = createUpgradeDownloadDirectory(
      join(root, "lore"),
      join(root, "install-path"),
    );
    const output = join(directory.path, "lore.download");
    writeFileSync(output, "original");
    directory.fileFd = openSync(output, constants.O_RDONLY);
    const victim = join(root, "victim");
    writeFileSync(victim, "keep this");
    const originalFs =
      await vi.importActual<typeof import("node:fs")>("node:fs");
    const moved = { value: false };
    vi.mocked(lstatSync).mockImplementation((...args) => {
      if (String(args[0]) === directory.path && !moved.value) {
        moved.value = true;
        rmSync(output);
        renameSync(victim, output);
      }
      return Reflect.apply(originalFs.lstatSync, originalFs, args);
    });
    try {
      expect(removeUpgradeDownloadDirectory(directory)).toBe(false);
      expect(readFileSync(output, "utf8")).toBe("keep this");
    } finally {
      vi.mocked(lstatSync).mockRestore();
      closeUpgradeDownloadDirectory(directory);
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
      if (process.platform === "darwin")
        renameSync(
          join(root, "lore.download"),
          join(root, "lore.download.opened"),
        );
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
  "preserves a replacement swapped after the first directory identity check",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "lore-upgrade-cleanup-race-"));
    vi.stubEnv("TMPDIR", root);
    const directory = createUpgradeDownloadDirectory(
      join(root, "lore"),
      join(root, "install-path"),
    );
    writeFileSync(join(directory.path, "lore.download"), "partial binary");
    const originalFs =
      await vi.importActual<typeof import("node:fs")>("node:fs");
    const moved = `${directory.path}.moved`;
    const replacement = { path: "" };
    vi.mocked(readdirSync).mockImplementation((...args) => {
      const names = Reflect.apply(originalFs.readdirSync, originalFs, args);
      if (
        /\/(?:proc\/self|dev)\/fd\/\d+$/.test(String(args[0])) &&
        !replacement.path
      ) {
        replacement.path = directory.path;
        renameSync(directory.path, moved);
        mkdirSync(directory.path, { mode: 0o700 });
        writeFileSync(join(directory.path, "unrelated"), "keep this");
      }
      return names;
    });
    try {
      expect(removeUpgradeDownloadDirectory(directory)).toBe(false);
      expect(replacement.path).not.toBe("");
      expect(readFileSync(join(replacement.path, "unrelated"), "utf8")).toBe(
        "keep this",
      );
    } finally {
      vi.mocked(readdirSync).mockRestore();
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
    const executable = join(root, "lore");
    const receipt = join(root, "install-path");
    const directory = createUpgradeDownloadDirectory(executable, receipt);
    const quarantined = `${directory.path}.cleanup-${"a".repeat(32)}`;
    const victim = join(root, "victim");
    writeFileSync(victim, "do not change");
    symlinkSync(victim, join(directory.path, "lore.download"));
    closeUpgradeDownloadDirectory(directory);
    renameSync(directory.path, quarantined);
    try {
      const staged = createUpgradeDownloadDirectory(executable, receipt);
      expect(staged.path).not.toBe(quarantined);
      closeUpgradeDownloadDirectory(staged);
      expect(readdirSync(quarantined)).toEqual([".owner", "lore.download"]);
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
