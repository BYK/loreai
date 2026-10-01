/** Private, identity-bound staging for standalone upgrade downloads. */
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, parse, resolve } from "node:path";
import { UpgradeError } from "./errors";

const PREFIX = "lore-upgrade-download-";
const MARKER = ".owner";
const RECORD_SUFFIX = ".upgrade-download-record-";

interface DownloadRecord {
  path: string;
  scope: string;
  device: string;
  inode: string;
}

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
  receiptPath?: string;
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

function recordName(executable: string, receiptPath: string): string {
  return `${basename(receiptPath)}${RECORD_SUFFIX}${scope(executable, receiptPath).slice(0, 16)}`;
}

function openRecordDirectory(receiptPath: string): number {
  const parent = resolve(dirname(receiptPath));
  const fd = openSync(
    parent,
    constants.O_RDONLY |
      (constants.O_DIRECTORY ?? 0) |
      (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const stat = fstatSync(fd, { bigint: true });
    if (
      !stat.isDirectory() ||
      realpathSync(parent) !== parent ||
      (process.getuid !== undefined && stat.uid !== BigInt(process.getuid())) ||
      (stat.mode & 0o022n) !== 0n
    ) {
      throw new UpgradeError(
        "execution_failed",
        "Standalone upgrade receipt directory is not trusted",
      );
    }
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function readRecords(
  executable: string,
  receiptPath: string,
): DownloadRecord[] {
  const parentFd = (() => {
    try {
      return openRecordDirectory(receiptPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  })();
  if (parentFd === null) return [];
  try {
    const records: DownloadRecord[] = [];
    const prefix = recordName(executable, receiptPath);
    for (const name of readdirSync(anchoredDirectoryFile(parentFd, "."))) {
      if (
        !name.startsWith(prefix) ||
        !/^[a-f0-9]{16}$/.test(name.slice(prefix.length))
      )
        continue;
      const fd = (() => {
        try {
          return openSync(
            anchoredDirectoryFile(parentFd, name),
            constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw error;
        }
      })();
      if (fd === null) continue;
      try {
        const stat = fstatSync(fd);
        if (
          !stat.isFile() ||
          stat.size > 1024 ||
          stat.size === 0 ||
          (process.getuid !== undefined && stat.uid !== process.getuid()) ||
          (stat.mode & 0o077) !== 0
        )
          continue;
        const value: unknown = JSON.parse(readFileSync(fd, "utf8"));
        if (!value || typeof value !== "object" || Array.isArray(value))
          continue;
        const record = value as Record<string, unknown>;
        const root = trustedTempRoot();
        if (
          typeof record.path !== "string" ||
          dirname(record.path) !== root ||
          !/^lore-upgrade-download-[\w-]+(?:\.cleanup-[a-f0-9]{32})?$/.test(
            basename(record.path),
          ) ||
          typeof record.scope !== "string" ||
          !/^[a-f0-9]{64}$/.test(record.scope) ||
          typeof record.device !== "string" ||
          !/^(0|[1-9][0-9]*)$/.test(record.device) ||
          typeof record.inode !== "string" ||
          !/^(0|[1-9][0-9]*)$/.test(record.inode)
        )
          continue;
        records.push(record as unknown as DownloadRecord);
      } catch {
        // An invalid record cannot authorize reuse or cleanup.
      } finally {
        closeSync(fd);
      }
    }
    return records;
  } finally {
    closeSync(parentFd);
  }
}

function writeRecord(
  directory: UpgradeDownloadDirectory,
  receiptPath: string,
  expected: string,
): void {
  const parentFd = openRecordDirectory(receiptPath);
  try {
    const fd = openSync(
      anchoredDirectoryFile(
        parentFd,
        `${basename(receiptPath)}${RECORD_SUFFIX}${expected.slice(0, 16)}${randomBytes(8).toString("hex")}`,
      ),
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      writeFileSync(
        fd,
        JSON.stringify({
          path: directory.path,
          scope: expected,
          device: directory.device.toString(),
          inode: directory.inode.toString(),
        }),
      );
      fsyncSync(fd);
      fsyncSync(parentFd);
    } finally {
      closeSync(fd);
    }
  } finally {
    closeSync(parentFd);
  }
}

function recordedEmptyDirectory(
  executable: string,
  receiptPath: string,
): UpgradeDownloadDirectory | null {
  const records = readRecords(executable, receiptPath).filter(
    (record) => record.scope === scope(executable, receiptPath),
  );
  const root = trustedTempRoot();
  for (const name of readdirSync(root)) {
    if (!name.startsWith(PREFIX)) continue;
    try {
      const directory = openUpgradeDownloadDirectory(join(root, name));
      try {
        if (
          records.some(
            (record) =>
              directory.device === BigInt(record.device) &&
              directory.inode === BigInt(record.inode),
          ) &&
          readdirSync(anchoredPath(directory, ".")).join("\n") === MARKER &&
          hasMarker(directory, scope(executable, receiptPath))
        ) {
          directory.outputName = `${basename(executable)}.download`;
          directory.receiptPath = receiptPath;
          directory.expectedScope = scope(executable, receiptPath);
          return directory;
        }
      } finally {
        if (!directory.receiptPath) closeUpgradeDownloadDirectory(directory);
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
  requireHandleBoundDownloads();
  if (directory.fileFd !== undefined) {
    throw new Error("Upgrade download file has already been opened");
  }
  const fd = openSync(
    anchoredPath(directory, name),
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_RDWR |
      (constants.O_NOFOLLOW ?? 0),
    0o700,
  );
  directory.fileFd = fd;
  // The open inode remains available through /proc/self/fd or /dev/fd.
  // A crash closes it and frees partial downloads without trusting filenames.
  unlinkSync(anchoredPath(directory, name));
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
  const reused = recordedEmptyDirectory(executable, receiptPath);
  const path = reused?.path ?? mkdtempSync(join(trustedTempRoot(), PREFIX));
  const directory = reused ?? openUpgradeDownloadDirectory(path);
  directory.outputName = `${basename(executable)}.download`;
  directory.receiptPath = receiptPath;
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
    writeRecord(directory, receiptPath, scope(executable, receiptPath));
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
  return (
    readdirSync(anchoredPath(directory, ".")).join("\n") === MARKER &&
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
