import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { LifecycleLock } from "../src/lifecycle-lock";
import { getBinaryFilename, installBinary } from "../src/cli/lib/binary";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test("publishes a private download through an exclusive staged copy", async () => {
  const root = mkdtempSync(join(tmpdir(), "lore-install-copy-"));
  roots.push(root);
  const safe = join(root, "private");
  const installDir = join(root, "bin");
  mkdirSync(safe, { mode: 0o700 });
  mkdirSync(installDir, { mode: 0o700 });
  const source = join(safe, "download");
  const installed = join(installDir, getBinaryFilename());
  writeFileSync(source, "verified replacement");
  writeFileSync(installed, "previous binary");
  const lock = { assertOwned: vi.fn() } as unknown as LifecycleLock;

  expect(await installBinary(source, installDir, lock)).toBe(installed);
  expect(readFileSync(installed, "utf8")).toBe("verified replacement");
  expect(readFileSync(source, "utf8")).toBe("verified replacement");
  if (process.platform !== "win32") {
    expect(lstatSync(installed).mode & 0o777).toBe(0o755);
  }
});

test.skipIf(process.platform === "win32")(
  "rejects a staged-download symlink planted after cleanup without writing its target",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "lore-install-swap-"));
    roots.push(root);
    const safe = join(root, "private");
    const installDir = join(root, "bin");
    mkdirSync(safe, { mode: 0o700 });
    mkdirSync(installDir, { mode: 0o700 });
    const source = join(safe, "download");
    const victim = join(root, "victim");
    const tempPath = join(installDir, `${getBinaryFilename()}.download`);
    writeFileSync(source, "new binary");
    writeFileSync(victim, "do not change", { mode: 0o600 });
    const assertOwned = vi.fn(() => {
      if (assertOwned.mock.calls.length === 3) {
        chmodSync(installDir, 0o775);
        symlinkSync(victim, tempPath);
      }
    });
    const lock = { assertOwned } as unknown as LifecycleLock;

    await expect(installBinary(source, installDir, lock)).rejects.toThrow();
    expect(assertOwned).toHaveBeenCalledTimes(3);
    expect(readFileSync(victim, "utf8")).toBe("do not change");
    expect(lstatSync(victim).mode & 0o777).toBe(0o600);
  },
);
