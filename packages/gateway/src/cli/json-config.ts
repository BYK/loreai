import { randomBytes } from "node:crypto";
import { Buffer } from "node:buffer";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  dirname,
  join,
  parse as parsePath,
  resolve,
} from "node:path";
import {
  applyEdits,
  modify,
  parse,
  printParseErrorCode,
  type FormattingOptions,
  type ParseError,
} from "jsonc-parser";

const formatting: FormattingOptions = {
  insertSpaces: true,
  tabSize: 2,
  eol: "\n",
};

export interface TrustedFileIdentity {
  dev: bigint;
  ino: bigint;
  mode: bigint;
  uid: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  birthtimeNs: bigint;
}

export interface TrustedTextFile {
  text: string;
  bytes: Buffer;
  identity: TrustedFileIdentity;
}

export interface TrustedFileSnapshot {
  bytes: Buffer | null;
  identity: TrustedFileIdentity | null;
  mode: number | null;
}

export interface TrustedFileTransaction {
  snapshot(file: string): TrustedFileSnapshot;
  assertSnapshotIdentity(
    file: string,
    expectedIdentity: TrustedFileIdentity | null,
  ): void;
  assertCurrentIdentity(file: string): void;
  write(
    file: string,
    text: string,
    options?: { mode?: number },
  ): TrustedFileIdentity;
  remove(file: string): void;
}

export interface StagedTrustedFileMutation<T> {
  result: T;
  prepareCommit: () => void;
  commit: () => void;
  rollback: () => void;
}

interface TrustedFileArtifact {
  path: string;
  identity: TrustedFileIdentity;
}

type TrustedFileCommitHook = (file: string, commit: number) => void;
type TrustedFilePublishHook = (
  operation: "write" | "remove",
  file: string,
) => void;
type TrustedFileRollbackHook = (
  file: string,
  target: "present" | "absent",
  phase: "after-stage" | "after-publication",
) => void;
type StagedTrustedFileCommitHook = () => void;

let trustedFileCommitHook: TrustedFileCommitHook | null = null;
let trustedFilePublishHook: TrustedFilePublishHook | null = null;
let trustedFileRollbackHook: TrustedFileRollbackHook | null = null;
let trustedDirectoryFsyncHook: ((directory: string) => void) | null = null;
let stagedTrustedFileCommitHook: StagedTrustedFileCommitHook | null = null;

export class CommittedAtomicWriteError extends Error {
  constructor(
    cause: unknown,
    readonly identity: TrustedFileIdentity,
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
  }
}

class CommittedAtomicRemoveError extends Error {}

/** Test-only failure injection after a transaction commit. */
export function _setTrustedFileCommitHookForTest(
  hook: TrustedFileCommitHook | null,
): void {
  trustedFileCommitHook = hook;
}

/** Test-only adversarial hook immediately before path publication/removal. */
export function _setTrustedFilePublishHookForTest(
  hook: TrustedFilePublishHook | null,
): void {
  trustedFilePublishHook = hook;
}

/** Test-only adversarial hook after rollback stages the current generation. */
export function _setTrustedFileRollbackHookForTest(
  hook: TrustedFileRollbackHook | null,
): void {
  trustedFileRollbackHook = hook;
}

/** Test-only observation of durable directory publication. */
export function _setTrustedDirectoryFsyncHookForTest(
  hook: ((directory: string) => void) | null,
): void {
  trustedDirectoryFsyncHook = hook;
}

/** Test-only failure injection before a staged mutation releases rollback data. */
export function _setStagedTrustedFileCommitHookForTest(
  hook: StagedTrustedFileCommitHook | null,
): void {
  stagedTrustedFileCommitHook = hook;
}

interface TrustedDirectoryIdentity {
  dev: bigint;
  ino: bigint;
  mode: bigint;
  uid: bigint;
}

function currentUid(): bigint | null {
  return typeof process.getuid === "function" ? BigInt(process.getuid()) : null;
}

function unsafePath(file: string, reason: string): Error {
  return new Error(`Unsafe setup path ${file}: ${reason}.`);
}

function assertOwned(file: string, uid: bigint): void {
  const expected = currentUid();
  if (expected !== null && uid !== expected) {
    throw unsafePath(file, `owned by uid ${uid}, expected uid ${expected}`);
  }
}

function fileIdentity(
  stats: ReturnType<typeof lstatBigInt>,
): TrustedFileIdentity {
  return {
    dev: stats.dev,
    ino: stats.ino,
    mode: stats.mode,
    uid: stats.uid,
    size: stats.size,
    mtimeNs: stats.mtimeNs,
    ctimeNs: stats.ctimeNs,
    birthtimeNs: stats.birthtimeNs,
  };
}

function directoryIdentity(
  stats: ReturnType<typeof lstatBigInt>,
): TrustedDirectoryIdentity {
  return {
    dev: stats.dev,
    ino: stats.ino,
    mode: stats.mode,
    uid: stats.uid,
  };
}

function lstatBigInt(file: string) {
  return lstatSync(file, { bigint: true });
}

function sameFileIdentity(
  left: TrustedFileIdentity | null,
  right: TrustedFileIdentity | null,
): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.birthtimeNs === right.birthtimeNs
  );
}

function sameFileGeneration(
  left: TrustedFileIdentity | null,
  right: TrustedFileIdentity | null,
): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs
  );
}

function sameDirectoryIdentity(
  left: TrustedDirectoryIdentity,
  right: TrustedDirectoryIdentity,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.uid === right.uid
  );
}

function inspectTrustedDirectory(
  directory: string,
  allowMissing = false,
): TrustedDirectoryIdentity | null {
  let stats: ReturnType<typeof lstatBigInt>;
  try {
    stats = lstatBigInt(directory);
  } catch (error: unknown) {
    if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
  if (stats.isSymbolicLink()) {
    throw unsafePath(directory, "symbolic-link directories are not allowed");
  }
  if (!stats.isDirectory()) {
    throw unsafePath(directory, "expected a directory");
  }
  assertOwned(directory, stats.uid);
  return directoryIdentity(stats);
}

/**
 * Resolve a same-owner symlink to its real path, otherwise return the path
 * unchanged. Personal dotfile managers (GNU Stow, chezmoi, etc.) routinely
 * replace a config file with a symlink into a separately version-controlled
 * location; rejecting every symlink outright makes setup unusable for that
 * (very common) layout.
 *
 * Only a symlink whose entire chain resolves to a regular file owned by the
 * same uid as the process is followed — anything else (broken link, a
 * directory, a device, a target owned by someone else) still fails closed
 * with the same "unsafe path" error as before. Following is safe here
 * because every trusted-file operation below re-resolves and re-validates
 * this path on every check, so a same-owner symlink is no more trustworthy
 * than the real file it points to, and nothing ever performs a rename/link
 * against the symlink itself (which would silently sever it from its
 * target).
 */
function trustedRealPath(file: string): string {
  let stats: ReturnType<typeof lstatBigInt>;
  try {
    stats = lstatBigInt(file);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return file;
    throw error;
  }
  if (!stats.isSymbolicLink()) return file;

  let real: string;
  try {
    real = realpathSync.native(file);
  } catch {
    throw unsafePath(file, "symbolic link does not resolve");
  }
  let target: ReturnType<typeof lstatBigInt>;
  try {
    target = lstatBigInt(real);
  } catch {
    throw unsafePath(file, "symbolic link does not resolve");
  }
  if (!target.isFile()) {
    throw unsafePath(file, "symbolic link target is not a regular file");
  }
  const expected = currentUid();
  if (expected === null || stats.uid !== expected || target.uid !== expected) {
    throw unsafePath(file, "symbolic link is not owned by the current user");
  }
  return real;
}

function inspectTrustedFile(file: string): TrustedFileIdentity | null {
  let stats: ReturnType<typeof lstatBigInt>;
  try {
    stats = lstatBigInt(file);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (stats.isSymbolicLink()) {
    throw unsafePath(file, "symbolic links are not allowed");
  }
  if (!stats.isFile()) {
    throw unsafePath(file, "expected a regular file");
  }
  assertOwned(file, stats.uid);
  return fileIdentity(stats);
}

function fsyncDirectory(directory: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      directory,
      constants.O_RDONLY |
        (constants.O_DIRECTORY ?? 0) |
        (constants.O_NOFOLLOW ?? 0),
    );
    fsyncSync(descriptor);
    trustedDirectoryFsyncHook?.(directory);
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    const unsupported =
      code === "EINVAL" ||
      code === "ENOTSUP" ||
      code === "ENOSYS" ||
      (process.platform === "win32" &&
        (code === "EACCES" || code === "EISDIR" || code === "EPERM"));
    if (!unsupported) throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

/**
 * Reject existing symlink components in an explicit custom config root. Missing
 * suffixes are allowed so setup can create a new custom directory.
 */
export function assertNoSymlinkPathComponents(
  directory: string,
  source: string,
): void {
  const absolute = resolve(directory);
  const root = parsePath(absolute).root;
  let current = root;
  for (const part of absolute
    .slice(root.length)
    .split(/[\\/]+/)
    .filter(Boolean)) {
    current = join(current, part);
    let stats: ReturnType<typeof lstatBigInt>;
    try {
      stats = lstatBigInt(current);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (stats.isSymbolicLink()) {
      throw unsafePath(source, `path component ${current} is a symbolic link`);
    }
    if (!stats.isDirectory()) {
      throw unsafePath(source, `path component ${current} is not a directory`);
    }
  }
}

/** Create a config directory, then verify its final component and ownership. */
export function ensureTrustedDirectory(directory: string): void {
  if (inspectTrustedDirectory(directory, true)) return;
  const absolute = resolve(directory);
  const root = parsePath(absolute).root;
  let current = root;
  for (const part of absolute
    .slice(root.length)
    .split(/[\\/]+/)
    .filter(Boolean)) {
    const parent = current;
    current = join(current, part);
    try {
      const existing = lstatBigInt(current);
      if (existing.isSymbolicLink() || !existing.isDirectory()) {
        throw unsafePath(current, "expected a non-symbolic-link directory");
      }
      continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      mkdirSync(current, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (!inspectTrustedDirectory(current)) {
      throw unsafePath(current, "directory creation failed");
    }
    // Persist every newly published component before creating its child.
    fsyncDirectory(parent);
  }
  if (!inspectTrustedDirectory(directory)) {
    throw unsafePath(directory, "directory creation failed");
  }
}

/** Return whether a trusted regular file exists, without following it. */
export function trustedFileExists(file: string): boolean {
  file = trustedRealPath(file);
  if (!inspectTrustedDirectory(dirname(file), true)) return false;
  return inspectTrustedFile(file) !== null;
}

/**
 * Read an owner-controlled regular file without following its final component.
 * The path and descriptor identities must agree before and after the read.
 */
export function readTrustedTextFile(
  file: string,
  options: { allowMissing?: boolean } = {},
): TrustedTextFile | null {
  file = trustedRealPath(file);
  const parent = inspectTrustedDirectory(dirname(file), options.allowMissing);
  if (!parent) return null;
  const before = inspectTrustedFile(file);
  if (!before) {
    if (options.allowMissing) return null;
    const error = new Error(
      `ENOENT: no such file or directory, open '${file}'`,
    );
    (error as NodeJS.ErrnoException).code = "ENOENT";
    throw error;
  }

  let descriptor: number | undefined;
  try {
    descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const openedStats = fstatSync(descriptor, { bigint: true });
    if (!openedStats.isFile()) {
      throw unsafePath(file, "expected a regular file");
    }
    assertOwned(file, openedStats.uid);
    const opened = fileIdentity(openedStats);
    if (!sameFileIdentity(before, opened)) {
      throw unsafePath(file, "file identity changed before it could be read");
    }
    const bytes = readFileSync(descriptor);
    const after = fileIdentity(fstatSync(descriptor, { bigint: true }));
    if (!sameFileIdentity(opened, after)) {
      throw unsafePath(file, "file changed while it was being read");
    }
    if (!sameFileIdentity(inspectTrustedFile(file), after)) {
      throw unsafePath(file, "file path changed while it was being read");
    }
    const parentAfter = inspectTrustedDirectory(dirname(file));
    if (!parentAfter || !sameDirectoryIdentity(parent, parentAfter)) {
      throw unsafePath(
        file,
        "parent directory changed while it was being read",
      );
    }
    return { text: bytes.toString("utf8"), bytes, identity: after };
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

/** Capture the exact text, existence, identity, and permission bits of a file. */
export function snapshotTrustedFile(file: string): TrustedFileSnapshot {
  const current = readTrustedTextFile(file, { allowMissing: true });
  if (!current) return { bytes: null, identity: null, mode: null };
  return {
    bytes: current.bytes,
    identity: current.identity,
    mode: Number(current.identity.mode & 0o7777n),
  };
}

/**
 * Atomically replace a trusted file using an exclusive 0600 temporary file in
 * the same directory. Existing config permissions are preserved.
 */
export function atomicWriteTrustedFile(
  file: string,
  content: string | Uint8Array,
  options: {
    expectedIdentity?: TrustedFileIdentity | null;
    mode?: number;
    preserveDisplaced?: (artifact: TrustedFileArtifact) => void;
  } = {},
): TrustedFileIdentity {
  file = trustedRealPath(file);
  const parent = inspectTrustedDirectory(dirname(file));
  if (!parent) throw unsafePath(file, "parent directory does not exist");
  const current = inspectTrustedFile(file);
  const expected =
    options.expectedIdentity === undefined ? current : options.expectedIdentity;
  if (!sameFileIdentity(current, expected)) {
    throw unsafePath(file, "file changed after it was read");
  }

  const temp = join(
    dirname(file),
    `.${basename(file)}.lore-tmp-${process.pid}-${randomBytes(12).toString("hex")}`,
  );
  let descriptor: number | undefined;
  let published = false;
  let tempPresent = true;
  let tempIdentity: TrustedFileIdentity | null = null;
  let displaced: string | null = null;
  try {
    descriptor = openSync(
      temp,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    const mode =
      options.mode ??
      (expected === null ? 0o600 : Number(expected.mode & 0o7777n));
    writeFileSync(descriptor, content);
    // Install the final permission bits while the inode still has only its
    // unpredictable temporary name. Publication must never expose the wrong
    // mode, even briefly.
    fchmodSync(descriptor, mode);
    fsyncSync(descriptor);
    tempIdentity = fileIdentity(fstatSync(descriptor, { bigint: true }));

    const parentBeforeRename = inspectTrustedDirectory(dirname(file));
    if (
      !parentBeforeRename ||
      !sameDirectoryIdentity(parent, parentBeforeRename)
    ) {
      throw unsafePath(file, "parent directory changed before atomic replace");
    }
    if (!sameFileIdentity(inspectTrustedFile(file), expected)) {
      throw unsafePath(file, "file changed before atomic replace");
    }
    trustedFilePublishHook?.("write", file);
    if (!sameFileIdentity(inspectTrustedFile(file), expected)) {
      throw unsafePath(file, "file changed immediately before publication");
    }
    if (expected !== null) {
      displaced = join(
        dirname(file),
        `.${basename(file)}.lore-displaced-${process.pid}-${randomBytes(12).toString("hex")}`,
      );
      renameSync(file, displaced);
      const moved = inspectTrustedFile(displaced);
      if (
        !moved ||
        moved.dev !== expected.dev ||
        moved.ino !== expected.ino ||
        moved.uid !== expected.uid ||
        moved.size !== expected.size ||
        moved.mtimeNs !== expected.mtimeNs
      ) {
        if (inspectTrustedFile(file) === null) renameSync(displaced, file);
        displaced = null;
        throw unsafePath(file, "file changed while staging atomic replace");
      }
      if (!moved) throw unsafePath(file, "displaced generation is missing");
    }
    try {
      // link(2) is an atomic no-clobber publication. A concurrent creator wins
      // with EEXIST and is preserved; Lore's old generation remains displaced
      // for explicit recovery rather than being silently overwritten.
      linkSync(temp, file);
      published = true;
      if (displaced && options.preserveDisplaced) {
        const artifactIdentity = inspectTrustedFile(displaced);
        if (!artifactIdentity) {
          throw unsafePath(file, "displaced generation is missing");
        }
        options.preserveDisplaced({
          path: displaced,
          identity: artifactIdentity,
        });
        displaced = null;
      }
    } catch (error) {
      if (displaced && inspectTrustedFile(file) === null) {
        renameSync(displaced, file);
        displaced = null;
      }
      throw error;
    }
    unlinkSync(temp);
    tempPresent = false;
    const installed = inspectTrustedFile(file);
    if (
      !installed ||
      installed.dev !== tempIdentity.dev ||
      installed.ino !== tempIdentity.ino
    ) {
      throw unsafePath(file, "atomic replace installed an unexpected file");
    }
    if (displaced) {
      const artifactIdentity = inspectTrustedFile(displaced);
      if (!artifactIdentity) {
        throw unsafePath(file, "displaced generation is missing");
      }
      unlinkSync(displaced);
      displaced = null;
    }
    // The file inode was synced before publication; sync the complete
    // publication/displacement cleanup as one durable directory state.
    fsyncDirectory(dirname(file));
    return installed;
  } catch (error) {
    if (published && tempIdentity) {
      let committed = tempIdentity;
      if (descriptor !== undefined) {
        try {
          committed = fileIdentity(fstatSync(descriptor, { bigint: true }));
        } catch {
          // Keep the last trusted descriptor identity and preserve the original
          // post-rename failure as the transaction's cause.
        }
      }
      throw new CommittedAtomicWriteError(error, committed);
    }
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (tempPresent) {
      try {
        unlinkSync(temp);
      } catch {
        // Best effort only: a cleanup failure must not replace the trust-boundary
        // error that prevented the atomic install.
      }
    }
  }
}

/** Remove a trusted regular file without following its final component. */
export function removeTrustedFile(
  file: string,
  expectedIdentity?: TrustedFileIdentity | null,
  preserveRemoved?: (artifact: TrustedFileArtifact) => void,
): boolean {
  file = trustedRealPath(file);
  const parent = inspectTrustedDirectory(dirname(file), true);
  if (!parent) return false;
  const current = inspectTrustedFile(file);
  const expected = expectedIdentity === undefined ? current : expectedIdentity;
  if (!sameFileIdentity(current, expected)) {
    throw unsafePath(file, "file changed before removal");
  }
  if (!current) return false;
  const parentBeforeUnlink = inspectTrustedDirectory(dirname(file));
  if (
    !parentBeforeUnlink ||
    !sameDirectoryIdentity(parent, parentBeforeUnlink)
  ) {
    throw unsafePath(file, "parent directory changed before removal");
  }
  if (!sameFileIdentity(inspectTrustedFile(file), current)) {
    throw unsafePath(file, "file changed before removal");
  }
  trustedFilePublishHook?.("remove", file);
  if (!sameFileIdentity(inspectTrustedFile(file), current)) {
    throw unsafePath(file, "file changed immediately before removal");
  }
  const displaced = join(
    dirname(file),
    `.${basename(file)}.lore-removing-${process.pid}-${randomBytes(12).toString("hex")}`,
  );
  renameSync(file, displaced);
  const moved = inspectTrustedFile(displaced);
  if (!sameFileGeneration(moved, current)) {
    if (inspectTrustedFile(file) === null) renameSync(displaced, file);
    throw unsafePath(file, "file changed while staging removal");
  }
  if (!moved) throw unsafePath(file, "staged removal generation is missing");
  try {
    if (preserveRemoved) {
      preserveRemoved({ path: displaced, identity: moved });
    } else {
      unlinkSync(displaced);
    }
    fsyncDirectory(dirname(file));
  } catch (error) {
    throw new CommittedAtomicRemoveError(
      error instanceof Error ? error.message : String(error),
      { cause: error },
    );
  }
  return true;
}

function cleanupTrustedArtifact(artifact: TrustedFileArtifact): void {
  removeTrustedFile(artifact.path, artifact.identity);
}

function cleanupTrustedArtifacts(
  artifacts: readonly TrustedFileArtifact[],
): void {
  for (const artifact of artifacts) {
    try {
      cleanupTrustedArtifact(artifact);
    } catch {
      // Canonical config + journal state has already committed or rolled back.
      // Preserve an artifact that cannot be identified and removed exactly.
    }
  }
}

function restoreTrustedFileSnapshot(
  file: string,
  snapshot: TrustedFileSnapshot,
  expectedIdentity: TrustedFileIdentity | null,
  artifacts: TrustedFileArtifact[],
): void {
  file = trustedRealPath(file);
  const current = readTrustedTextFile(file, { allowMissing: true });
  if (!sameFileIdentity(current?.identity ?? null, expectedIdentity)) {
    throw unsafePath(file, "file changed before transaction rollback");
  }
  if (snapshot.bytes === null) {
    if (current) {
      try {
        removeTrustedFile(file, current.identity, (artifact) =>
          artifacts.push(artifact),
        );
      } catch (error) {
        if (!readTrustedTextFile(file, { allowMissing: true })) return;
        throw error;
      }
    }
    trustedFileRollbackHook?.(file, "absent", "after-stage");
    if (inspectTrustedFile(file) !== null) {
      throw unsafePath(
        file,
        "replacement appeared during transaction rollback",
      );
    }
    return;
  }

  const originalArtifact = artifacts.find(
    (artifact) =>
      snapshot.identity !== null &&
      sameFileGeneration(artifact.identity, snapshot.identity),
  );
  if (originalArtifact) {
    if (current) {
      removeTrustedFile(file, current.identity, (artifact) =>
        artifacts.push(artifact),
      );
    }
    trustedFileRollbackHook?.(file, "present", "after-stage");
    try {
      linkSync(originalArtifact.path, file);
    } catch (error) {
      throw unsafePath(
        file,
        `could not republish the exact rollback generation: ${String(error)}`,
      );
    }
    const restored = inspectTrustedFile(file);
    if (!sameFileGeneration(restored, snapshot.identity)) {
      throw unsafePath(file, "rollback installed an unexpected generation");
    }
    trustedFileRollbackHook?.(file, "present", "after-publication");
    fsyncDirectory(dirname(file));
    if (!sameFileGeneration(inspectTrustedFile(file), snapshot.identity)) {
      throw unsafePath(file, "rollback generation changed before completion");
    }
    const refreshedArtifact = inspectTrustedFile(originalArtifact.path);
    if (
      refreshedArtifact &&
      sameFileGeneration(refreshedArtifact, snapshot.identity)
    ) {
      originalArtifact.identity = refreshedArtifact;
    }
    return;
  }

  if (
    current?.bytes.equals(snapshot.bytes) &&
    Number(current.identity.mode & 0o7777n) === snapshot.mode
  ) {
    return;
  }
  try {
    atomicWriteTrustedFile(file, snapshot.bytes, {
      expectedIdentity: current?.identity ?? null,
      mode: snapshot.mode ?? 0o600,
    });
  } catch (error) {
    const restored = readTrustedTextFile(file, { allowMissing: true });
    if (
      restored?.bytes.equals(snapshot.bytes) &&
      Number(restored.identity.mode & 0o7777n) === snapshot.mode
    ) {
      return;
    }
    throw error;
  }
}

/**
 * Run a synchronous group of trusted atomic file writes as a small transaction.
 * If the action throws, every attempted path is restored to its pre-action
 * bytes, existence, and permission bits. Rollback uses the same trusted atomic
 * IO and attempts every path even if restoring an earlier path fails.
 */
export function withTrustedFileTransaction<T>(
  files: readonly string[],
  action: (transaction: TrustedFileTransaction) => T,
): T {
  if (files.length === 0) {
    throw new Error("Trusted file transaction requires at least one file.");
  }
  const paths = [...new Set(files)];
  const directory = dirname(paths[0]);
  if (paths.some((file) => dirname(file) !== directory)) {
    throw new Error("Trusted file transaction paths must share a directory.");
  }
  const snapshots = new Map(
    paths.map((file) => [file, snapshotTrustedFile(file)] as const),
  );
  const currentIdentities = new Map(
    paths.map((file) => [file, snapshots.get(file)?.identity ?? null] as const),
  );
  const committed: string[] = [];
  const artifacts: TrustedFileArtifact[] = [];
  let commit = 0;

  const requireSnapshot = (file: string): TrustedFileSnapshot => {
    const snapshot = snapshots.get(file);
    if (!snapshot) {
      throw new Error(`File ${file} is not part of this trusted transaction.`);
    }
    return snapshot;
  };

  const transaction: TrustedFileTransaction = {
    snapshot: requireSnapshot,
    assertSnapshotIdentity: (file, expectedIdentity) => {
      if (!sameFileIdentity(requireSnapshot(file).identity, expectedIdentity)) {
        throw unsafePath(file, "file changed after it was read");
      }
    },
    assertCurrentIdentity: (file) => {
      requireSnapshot(file);
      if (
        !sameFileIdentity(
          inspectTrustedFile(trustedRealPath(file)),
          currentIdentities.get(file) ?? null,
        )
      ) {
        throw unsafePath(file, "file changed during trusted transaction");
      }
    },
    write: (file, text, options = {}) => {
      requireSnapshot(file);
      const expectedIdentity = currentIdentities.get(file) ?? null;
      let identity: TrustedFileIdentity;
      try {
        identity = atomicWriteTrustedFile(file, text, {
          expectedIdentity,
          mode: options.mode,
          preserveDisplaced: (artifact) => artifacts.push(artifact),
        });
      } catch (error) {
        if (error instanceof CommittedAtomicWriteError) {
          // The atomic rename committed, but a later chmod/fsync/verification
          // step failed. Track that visible write so the outer catch restores
          // it rather than leaving a half-committed transaction.
          currentIdentities.set(file, error.identity);
          committed.push(file);
        }
        throw error;
      }
      currentIdentities.set(file, identity);
      committed.push(file);
      commit += 1;
      trustedFileCommitHook?.(file, commit);
      return identity;
    },
    remove: (file) => {
      requireSnapshot(file);
      const expectedIdentity = currentIdentities.get(file) ?? null;
      let removed = false;
      try {
        removed = removeTrustedFile(file, expectedIdentity, (artifact) =>
          artifacts.push(artifact),
        );
      } catch (error) {
        if (error instanceof CommittedAtomicRemoveError) {
          currentIdentities.set(file, null);
          committed.push(file);
        }
        throw error;
      }
      if (!removed) return;
      currentIdentities.set(file, null);
      committed.push(file);
      commit += 1;
      trustedFileCommitHook?.(file, commit);
    },
  };

  try {
    const result = action(transaction);
    cleanupTrustedArtifacts(artifacts);
    return result;
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    // Restore the primary config before its recovery sidecar. If config CAS
    // fails, the untouched journal is the only durable path to recovery.
    const committedSet = new Set(committed);
    const rollbackPaths = paths.filter((file) => committedSet.has(file));
    for (const file of rollbackPaths) {
      try {
        restoreTrustedFileSnapshot(
          file,
          requireSnapshot(file),
          currentIdentities.get(file) ?? null,
          artifacts,
        );
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
        break;
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        "Trusted file transaction failed and could not be fully rolled back.",
      );
    }
    cleanupTrustedArtifacts(artifacts);
    throw error;
  }
}

/**
 * Run an arbitrary synchronous trusted-file mutation while retaining hard-link
 * claims for every original generation. The caller must either commit those
 * claims after all other fallible work is prepared, or roll the mutation back.
 *
 * This outer transaction intentionally complements `withTrustedFileTransaction`:
 * setup operations keep their per-config crash journals, while uninstall can
 * still restore several already-completed setup undos if a later phase fails.
 */
export function stageTrustedFileMutation<T>(
  files: readonly string[],
  action: () => T,
): StagedTrustedFileMutation<T> {
  if (files.length === 0) {
    throw new Error("Staged trusted file mutation requires at least one file.");
  }
  // Resolved once, up front: every other file in this function is keyed by
  // this same `paths` array, and staged backup artifacts are created
  // alongside it (`dirname(file)`), which must be the file's real directory
  // for the same-directory rename/link operations below to stay atomic.
  const paths = [...new Set(files.map(trustedRealPath))];
  const snapshots = new Map(
    paths.map((file) => [file, snapshotTrustedFile(file)] as const),
  );
  const artifacts: TrustedFileArtifact[] = [];

  const refreshArtifacts = (): void => {
    for (const artifact of artifacts) {
      const current = inspectTrustedFile(artifact.path);
      if (current && sameFileGeneration(current, artifact.identity)) {
        artifact.identity = current;
      }
    }
  };
  const cleanupArtifacts = (): void => {
    refreshArtifacts();
    cleanupTrustedArtifacts(artifacts);
    artifacts.length = 0;
  };

  try {
    for (const file of paths) {
      const snapshot = snapshots.get(file);
      if (!snapshot?.identity) continue;
      if (!sameFileIdentity(inspectTrustedFile(file), snapshot.identity)) {
        throw unsafePath(file, "file changed before uninstall staging");
      }
      const artifactPath = join(
        dirname(file),
        `.${basename(file)}.lore-uninstall-original-${process.pid}-${randomBytes(12).toString("hex")}`,
      );
      linkSync(file, artifactPath);
      const artifactIdentity = inspectTrustedFile(artifactPath);
      if (artifactIdentity) {
        artifacts.push({ path: artifactPath, identity: artifactIdentity });
      }
      const current = inspectTrustedFile(file);
      if (
        !artifactIdentity ||
        !sameFileGeneration(artifactIdentity, snapshot.identity) ||
        !sameFileGeneration(current, snapshot.identity)
      ) {
        throw unsafePath(file, "file changed while staging uninstall rollback");
      }
      fsyncDirectory(dirname(file));
    }
  } catch (error) {
    cleanupArtifacts();
    throw error;
  }

  let result: T;
  try {
    result = action();
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    refreshArtifacts();
    for (const file of paths) {
      const snapshot = snapshots.get(file);
      if (!snapshot) continue;
      const current = inspectTrustedFile(file);
      if (sameFileGeneration(current, snapshot.identity)) continue;
      try {
        restoreTrustedFileSnapshot(file, snapshot, current, artifacts);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
        break;
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        "Staged trusted file mutation failed and could not be fully rolled back.",
      );
    }
    cleanupArtifacts();
    throw error;
  }

  const currentIdentities = new Map(
    paths.map((file) => [file, inspectTrustedFile(file)] as const),
  );
  let active = true;
  let prepared = false;

  return {
    result,
    prepareCommit: () => {
      if (!active) return;
      refreshArtifacts();
      for (const file of paths) {
        if (
          !sameFileIdentity(
            inspectTrustedFile(file),
            currentIdentities.get(file) ?? null,
          )
        ) {
          throw unsafePath(file, "file changed before uninstall commit");
        }
        const snapshot = snapshots.get(file);
        if (!snapshot?.identity) continue;
        const original = artifacts.find((artifact) =>
          sameFileGeneration(artifact.identity, snapshot.identity),
        );
        if (!original) {
          throw unsafePath(file, "uninstall rollback generation is missing");
        }
      }
      stagedTrustedFileCommitHook?.();
      prepared = true;
    },
    commit: () => {
      if (!active) return;
      if (!prepared) {
        throw new Error("Staged trusted file mutation was not prepared.");
      }
      cleanupArtifacts();
      active = false;
    },
    rollback: () => {
      if (!active) return;
      const rollbackErrors: unknown[] = [];
      refreshArtifacts();
      for (const file of paths) {
        const snapshot = snapshots.get(file);
        if (!snapshot) continue;
        const expected = currentIdentities.get(file) ?? null;
        if (sameFileGeneration(expected, snapshot.identity)) continue;
        try {
          restoreTrustedFileSnapshot(file, snapshot, expected, artifacts);
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
          break;
        }
      }
      if (rollbackErrors.length > 0) {
        throw new AggregateError(
          rollbackErrors,
          "Staged trusted file mutation could not be fully rolled back.",
        );
      }
      cleanupArtifacts();
      active = false;
    },
  };
}

export function parseJsonConfigText(
  text: string,
  file: string,
): Record<string, unknown> {
  const errors: ParseError[] = [];
  const value = parse(text, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  }) as unknown;
  if (
    errors.length > 0 ||
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    const detail = errors[0]
      ? printParseErrorCode(errors[0].error)
      : "root must be an object";
    throw new Error(`Could not parse ${file} as JSON/JSONC (${detail}).`);
  }
  return value as Record<string, unknown>;
}

export function readJsonConfigFile(file: string): {
  text: string;
  config: Record<string, unknown>;
  identity: TrustedFileIdentity;
} {
  const trusted = readTrustedTextFile(file);
  if (!trusted) throw new Error(`Could not read ${file}.`);
  return {
    text: trusted.text,
    config: parseJsonConfigText(trusted.text, file),
    identity: trusted.identity,
  };
}

export function readJsonConfigFileIfExists(file: string): {
  text: string;
  config: Record<string, unknown>;
  identity: TrustedFileIdentity;
} | null {
  const trusted = readTrustedTextFile(file, { allowMissing: true });
  if (!trusted) return null;
  return {
    text: trusted.text,
    config: parseJsonConfigText(trusted.text, file),
    identity: trusted.identity,
  };
}

export function setJsonConfigValue(
  text: string,
  path: string[],
  value: unknown,
): string {
  return applyEdits(
    text,
    modify(text, path, value, { formattingOptions: formatting }),
  );
}

export function deleteJsonConfigValue(text: string, path: string[]): string {
  return applyEdits(
    text,
    modify(text, path, undefined, { formattingOptions: formatting }),
  );
}

export function resolveOpencodeConfigPath(defaultJsonPath: string): string {
  for (const candidate of opencodeConfigPaths(defaultJsonPath)) {
    if (trustedFileExists(candidate)) return candidate;
  }
  return defaultJsonPath;
}

export function opencodeConfigPaths(defaultJsonPath: string): string[] {
  const dir = dirname(defaultJsonPath);
  return ["opencode.jsonc", "opencode.json", "config.json"].map((name) =>
    join(dir, name),
  );
}
