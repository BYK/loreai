/** Private, identity-bound staging for standalone upgrade downloads. */
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  ftruncateSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, parse, resolve } from "node:path";
import { UpgradeError } from "./errors";

const PREFIX = "lore-upgrade-download-";
const MARKER = ".owner";
const LINUX_O_TMPFILE = 0o20000000 | constants.O_DIRECTORY;

function requireHandleBoundDownloads(): void {
  if (process.platform === "win32") {
    throw new UpgradeError(
      "execution_failed",
      "Windows standalone upgrades require handle-bound download staging",
    );
  }
}

export interface UpgradeDownloadDirectory {
  readonly fd: number;
  readonly path: string;
  readonly device: bigint;
  readonly inode: bigint;
  outputName?: string;
  expectedScope?: string;
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
  return anchoredDirectoryFile(directory.fd, name);
}

function anchoredDirectoryFile(fd: number, name: string): string {
  const root =
    process.platform === "linux"
      ? `/proc/self/fd/${fd}`
      : process.platform === "darwin"
        ? `/dev/fd/${fd}`
        : "";
  return join(root, name);
}

function scope(executable: string, receiptPath: string): string {
  return createHash("sha256")
    .update(`${executable}\n${receiptPath}`)
    .digest("hex");
}

function reusableDownloadDirectory(
  executable: string,
  receiptPath: string,
): UpgradeDownloadDirectory | null {
  const root = trustedTempRoot();
  for (const name of readdirSync(root)) {
    if (!name.startsWith(PREFIX)) continue;
    try {
      const directory = openUpgradeDownloadDirectory(join(root, name));
      const selected = { value: false };
      try {
        if (
          readdirSync(anchoredPath(directory, ".")).join("\n") === MARKER &&
          hasMarker(directory, scope(executable, receiptPath))
        ) {
          directory.outputName = `${basename(executable)}.download`;
          directory.expectedScope = scope(executable, receiptPath);
          selected.value = true;
          return directory;
        }
      } finally {
        if (!selected.value) closeUpgradeDownloadDirectory(directory);
      }
    } catch {
      // Unrelated or changed names cannot be reused.
    }
  }
  return null;
}

export function openUpgradeDownloadDirectory(
  path: string,
): UpgradeDownloadDirectory {
  requireHandleBoundDownloads();
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
    if (directory.fileFd !== undefined) {
      try {
        ftruncateSync(directory.fileFd, 0);
      } catch {
        // Closing an unnamed inode always releases its bytes even if truncation fails.
      } finally {
        closeSync(directory.fileFd);
      }
    }
  } finally {
    if (directory.fd >= 0) closeSync(directory.fd);
  }
}

/** Open the output inode once; writers use its descriptor, never a replaceable name. */
export function openUpgradeDownloadFile(
  directory: UpgradeDownloadDirectory,
  name: string,
): string {
  requireHandleBoundDownloads();
  if (directory.fileFd !== undefined) {
    throw new Error("Upgrade download file has already been opened");
  }
  const fd =
    process.platform === "linux"
      ? (() => {
          try {
            return openSync(
              anchoredPath(directory, "."),
              constants.O_RDWR | LINUX_O_TMPFILE,
              0o700,
            );
          } catch {
            throw new UpgradeError(
              "execution_failed",
              "Anonymous standalone upgrade downloads are unavailable on this filesystem",
            );
          }
        })()
      : openSync(
          anchoredPath(directory, name),
          constants.O_CREAT |
            constants.O_EXCL |
            constants.O_RDWR |
            (constants.O_NOFOLLOW ?? 0),
          0o700,
        );
  directory.fileFd = fd;
  // Linux opens an unnamed inode. Darwin retains its exclusive filename and
  // never unlinks a potentially replaced directory entry.
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
  requireHandleBoundDownloads();
  const reused = reusableDownloadDirectory(executable, receiptPath);
  const path = reused?.path ?? mkdtempSync(join(trustedTempRoot(), PREFIX));
  const directory = reused ?? openUpgradeDownloadDirectory(path);
  directory.outputName = `${basename(executable)}.download`;
  directory.expectedScope = scope(executable, receiptPath);
  try {
    if (reused) return directory;
    const markerFd = openSync(
      anchoredPath(directory, MARKER),
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      writeFileSync(markerFd, `${scope(executable, receiptPath)}\n`);
      fsyncSync(markerFd);
      fsyncSync(directory.fd);
    } finally {
      closeSync(markerFd);
    }
    return directory;
  } catch (error) {
    // An interrupted setup has not established ownership of any new output.
    // Preserve ambiguous entries rather than deleting them on the error path.
    closeUpgradeDownloadDirectory(directory);
    throw error;
  }
}

/** Check the opened generation before closing it; leave unknown entries untouched. */
export function removeUpgradeDownloadDirectory(
  directory: UpgradeDownloadDirectory,
): boolean {
  if (directory.fd < 0) return false;
  const outputName = directory.outputName;
  if (!outputName) return false;
  const current = lstatSync(directory.path, { bigint: true });
  if (
    !current.isDirectory() ||
    current.dev !== directory.device ||
    current.ino !== directory.inode
  )
    return false;
  const names = readdirSync(anchoredPath(directory, "."));
  const expectedNames =
    process.platform === "darwin" && directory.fileFd !== undefined
      ? [MARKER, outputName]
      : [MARKER];
  if (
    names.length !== expectedNames.length ||
    expectedNames.some((name) => !names.includes(name))
  )
    return false;
  if (expectedNames.length === 2) {
    const fileFd = directory.fileFd;
    if (fileFd === undefined) return false;
    const output = lstatSync(anchoredPath(directory, outputName), {
      bigint: true,
    });
    const opened = fstatSync(fileFd, { bigint: true });
    if (
      !output.isFile() ||
      output.dev !== opened.dev ||
      output.ino !== opened.ino
    )
      return false;
  }
  return (
    directory.expectedScope !== undefined &&
    hasMarker(directory, directory.expectedScope) &&
    (() => {
      const final = lstatSync(directory.path, { bigint: true });
      return (
        final.isDirectory() &&
        final.dev === directory.device &&
        final.ino === directory.inode
      );
    })()
  );
}
