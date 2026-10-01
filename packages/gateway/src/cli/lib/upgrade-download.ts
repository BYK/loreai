/** Private, identity-bound staging for standalone upgrade downloads. */
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";
import { UpgradeError } from "./errors";

const PREFIX = "lore-upgrade-download-";
const MARKER = ".owner";

export interface UpgradeDownloadDirectory {
  readonly fd: number;
  readonly path: string;
  readonly device: bigint;
  readonly inode: bigint;
  fileFd?: number;
}

function trustedTempRoot(): string {
  const root = realpathSync(tmpdir());
  const uid = process.getuid?.();
  if (uid === undefined) return root;
  for (let path = resolve(root); ; path = dirname(path)) {
    const stat = lstatSync(path);
    if (
      !stat.isDirectory() ||
      (stat.uid !== uid && stat.uid !== 0) ||
      ((stat.mode & 0o022) !== 0 &&
        !((stat.mode & 0o1000) !== 0 && stat.uid === 0))
    ) {
      throw new UpgradeError(
        "execution_failed",
        "Standalone upgrade temporary directory has an unsafe ancestor",
      );
    }
    if (path === parse(path).root) break;
  }
  return root;
}

function anchoredPath(
  directory: UpgradeDownloadDirectory,
  name: string,
): string {
  const root =
    process.platform === "linux"
      ? `/proc/self/fd/${directory.fd}`
      : process.platform === "darwin"
        ? `/dev/fd/${directory.fd}`
        : directory.path;
  return join(root, name);
}

function scope(executable: string, receiptPath: string): string {
  return createHash("sha256")
    .update(`${executable}\n${receiptPath}`)
    .digest("hex");
}

export function openUpgradeDownloadDirectory(
  path: string,
): UpgradeDownloadDirectory {
  if (process.platform === "win32") {
    const stat = lstatSync(path, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new UpgradeError(
        "execution_failed",
        "Standalone upgrade download directory is not private",
      );
    }
    // Windows does not permit ordinary read-only directory descriptors. Its
    // private temp directory is still checked by generation before cleanup.
    return { fd: -1, path, device: stat.dev, inode: stat.ino };
  }
  const fd = openSync(
    path,
    constants.O_RDONLY |
      (constants.O_DIRECTORY ?? 0) |
      (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const stat = fstatSync(fd, { bigint: true });
    if (
      !stat.isDirectory() ||
      (process.getuid !== undefined && stat.uid !== BigInt(process.getuid())) ||
      (stat.mode & 0o077n) !== 0n
    ) {
      throw new UpgradeError(
        "execution_failed",
        "Standalone upgrade download directory is not private",
      );
    }
    return { fd, path, device: stat.dev, inode: stat.ino };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

export function closeUpgradeDownloadDirectory(
  directory: UpgradeDownloadDirectory,
): void {
  try {
    if (directory.fileFd !== undefined) closeSync(directory.fileFd);
  } finally {
    if (directory.fd >= 0) closeSync(directory.fd);
  }
}

/** Open the output inode once; writers use its descriptor, never a replaceable name. */
export function openUpgradeDownloadFile(
  directory: UpgradeDownloadDirectory,
  name: string,
): string {
  if (directory.fileFd !== undefined) {
    throw new Error("Upgrade download file has already been opened");
  }
  if (process.platform === "win32") return anchoredPath(directory, name);
  const fd = openSync(
    anchoredPath(directory, name),
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_RDWR |
      (constants.O_NOFOLLOW ?? 0),
    0o700,
  );
  directory.fileFd = fd;
  return process.platform === "linux"
    ? `/proc/self/fd/${fd}`
    : process.platform === "darwin"
      ? `/dev/fd/${fd}`
      : anchoredPath(directory, name);
}

function hasMarker(
  directory: UpgradeDownloadDirectory,
  expected: string,
): boolean {
  const fd = openSync(
    anchoredPath(directory, MARKER),
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.size !== 65 ||
      (process.getuid !== undefined && stat.uid !== process.getuid()) ||
      (process.platform !== "win32" && (stat.mode & 0o077) !== 0)
    )
      return false;
    return readFileSync(fd, "utf8") === `${expected}\n`;
  } finally {
    closeSync(fd);
  }
}

export function createUpgradeDownloadDirectory(
  executable: string,
  receiptPath: string,
): UpgradeDownloadDirectory {
  const path = mkdtempSync(join(trustedTempRoot(), PREFIX));
  const directory = openUpgradeDownloadDirectory(path);
  try {
    writeFileSync(
      anchoredPath(directory, MARKER),
      `${scope(executable, receiptPath)}\n`,
      {
        flag: "wx",
        mode: 0o600,
      },
    );
    return directory;
  } catch (error) {
    try {
      removeUpgradeDownloadDirectory(directory);
    } catch {
      // Preserve the original staging error; leave unsafe paths untouched.
    } finally {
      closeUpgradeDownloadDirectory(directory);
    }
    throw error;
  }
}

/** Remove only the directory generation that this caller opened. */
export function removeUpgradeDownloadDirectory(
  directory: UpgradeDownloadDirectory,
): boolean {
  const current = lstatSync(directory.path, { bigint: true });
  if (
    !current.isDirectory() ||
    current.dev !== directory.device ||
    current.ino !== directory.inode
  )
    return false;
  const quarantine = `${directory.path}.cleanup-${randomBytes(16).toString("hex")}`;
  renameSync(directory.path, quarantine);
  const displaced = lstatSync(quarantine, { bigint: true });
  if (
    !displaced.isDirectory() ||
    displaced.dev !== directory.device ||
    displaced.ino !== directory.inode
  ) {
    // Never delete a different generation, even if it replaced the pathname
    // between inspection and quarantine. Keep it for manual recovery.
    return false;
  }
  rmSync(quarantine, { recursive: true, force: true });
  return true;
}

/** A crash can leave large partial binaries. Reclaim only our scoped, private generations. */
export function reclaimUpgradeDownloads(
  executable: string,
  receiptPath: string,
): void {
  const root = trustedTempRoot();
  const expected = scope(executable, receiptPath);
  for (const name of readdirSync(root)) {
    if (!name.startsWith(PREFIX) || name.includes(".cleanup-")) continue;
    try {
      const directory = openUpgradeDownloadDirectory(join(root, name));
      try {
        if (hasMarker(directory, expected)) {
          removeUpgradeDownloadDirectory(directory);
        }
      } finally {
        closeUpgradeDownloadDirectory(directory);
      }
    } catch {
      // Unknown or changed paths are never authorized for removal.
    }
  }
}
