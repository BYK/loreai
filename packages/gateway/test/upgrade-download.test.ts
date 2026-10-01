import {
  mkdtempSync,
  readFileSync,
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
  openUpgradeDownloadDirectory,
  openUpgradeDownloadFile,
} from "../src/cli/lib/upgrade-download";

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
