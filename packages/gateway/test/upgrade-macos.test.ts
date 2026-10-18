/** Exercise the real Darwin filesystem: Linux platform mocks cannot model fdescfs. */
import {
  closeSync,
  constants,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { hashBinaryFile, installBinary } from "../src/cli/lib/binary";
import {
  closeUpgradeDownloadDirectory,
  createUpgradeDownloadDirectory,
  openUpgradeDownloadFile,
  removeUpgradeDownloadDirectory,
} from "../src/cli/lib/upgrade-download";
import type { LifecycleLock } from "../src/lifecycle-lock";

const lock = { assertOwned() {} } as LifecycleLock;

test.skipIf(process.platform !== "darwin")(
  "stages a binary on native macOS and installs it after the descriptor position advances",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "lore-upgrade-native-macos-"));
    let directory:
      | ReturnType<typeof createUpgradeDownloadDirectory>
      | undefined;
    try {
      directory = createUpgradeDownloadDirectory(
        join(root, "lore"),
        join(root, "install-path"),
      );
      const output = openUpgradeDownloadFile(directory, "lore.download");
      writeFileSync(output, "complete replacement binary");
      expect(readFileSync(join(directory.path, ".owner"), "utf8")).toMatch(
        /^[a-f0-9]{64}\n$/,
      );
      const installed = await installBinary(output, join(root, "bin"), lock);
      expect(readFileSync(installed, "utf8")).toBe(
        "complete replacement binary",
      );
      expect(removeUpgradeDownloadDirectory(directory)).toBe(true);
    } finally {
      if (directory) closeUpgradeDownloadDirectory(directory);
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform !== "darwin")(
  "copies a Darwin file descriptor from byte zero after a previous reader consumes it",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "lore-upgrade-fdesc-copy-"));
    const source = join(root, "source");
    writeFileSync(source, "all replacement bytes");
    const fd = openSync(source, constants.O_RDONLY);
    try {
      const path = `/dev/fd/${fd}`;
      expect(readFileSync(path, "utf8")).toBe("all replacement bytes");
      const expectedHash =
        "d695d26b4078d0ad95f53a5e43147edf666dc5ccbf83774cd613d371c2ae2e60";
      expect(await hashBinaryFile(path)).toBe(expectedHash);
      expect(await hashBinaryFile(path)).toBe(expectedHash);
      const installed = await installBinary(path, join(root, "bin"), lock);
      expect(readFileSync(installed, "utf8")).toBe("all replacement bytes");
    } finally {
      closeSync(fd);
      rmSync(root, { recursive: true, force: true });
    }
  },
);
