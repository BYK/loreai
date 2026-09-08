/** Durable, generation-checked publication of an installation's related files. */
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  linkSync,
  openSync,
  renameSync,
  lstatSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  atomicWriteTrustedFile,
  assertNoSymlinkPathComponents,
  CommittedAtomicWriteError,
  readTrustedTextFile,
  removeTrustedFile,
  type TrustedFileIdentity,
  type TrustedTextFile,
} from "../json-config";

interface Generation {
  dev: string;
  ino: string;
  size: string;
  mtime: string;
  mode: string;
  sha256: string;
}
export interface InstallFile {
  path: string;
  stage: string;
  backup: string;
  displaced: string;
  before: Generation | null;
  after: Generation;
}
interface Journal {
  version: 1;
  direction: "complete" | "rollback";
  epoch?: string;
  files: InstallFile[];
}
const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
function generation(file: TrustedTextFile | null): Generation | null {
  if (!file) return null;
  const i = file.identity;
  return {
    dev: String(i.dev),
    ino: String(i.ino),
    size: String(i.size),
    mtime: String(i.mtimeNs),
    mode: String(i.mode),
    sha256: digest(file.bytes),
  };
}
function equal(left: Generation | null, right: Generation | null): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
function readFile(path: string): TrustedTextFile | null {
  assertNoSymlinkPathComponents(dirname(path), path);
  try {
    if (lstatSync(path).isSymbolicLink())
      throw new Error(`Refusing symlinked installation file: ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return readTrustedTextFile(path, {
    allowMissing: true,
    followSymlinks: false,
  });
}
function inspect(path: string): Generation | null {
  return generation(readFile(path));
}
let publicationHook:
  | ((phase: "quarantined" | "linked", path: string) => void)
  | undefined;
export function _setInstallPublicationHookForTest(
  hook: typeof publicationHook,
): void {
  publicationHook = hook;
}

function syncDirectory(path: string): void {
  if (process.platform === "win32") return;
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function removeExpected(path: string, expected: Generation): void {
  const current = readFile(path);
  if (!current) return;
  if (!equal(generation(current), expected))
    throw new Error(`Installation recovery artifact changed: ${path}`);
  removeTrustedFile(path, current.identity, undefined, {
    followSymlinks: false,
  });
}
export function stageInstallFile(
  path: string,
  bytes: Uint8Array | string,
  mode: number,
  expected?: TrustedTextFile | null,
): InstallFile {
  const token = randomBytes(16).toString("hex");
  const prefix = join(
    dirname(path),
    `.${basename(path)}.lore-install-${token}`,
  );
  const entry = {
    path,
    stage: `${prefix}.new`,
    backup: `${prefix}.old`,
    displaced: `${prefix}.displaced`,
    before: inspect(path),
    after: null as Generation | null,
  };
  if (expected !== undefined && !equal(entry.before, generation(expected)))
    throw new Error(`Installation changed before staging: ${path}`);
  const stagedGeneration = (identity: TrustedFileIdentity): Generation => ({
    dev: String(identity.dev),
    ino: String(identity.ino),
    size: String(identity.size),
    mtime: String(identity.mtimeNs),
    mode: String(identity.mode),
    sha256: digest(typeof bytes === "string" ? Buffer.from(bytes) : bytes),
  });
  let backupLinked = false;
  try {
    const identity = atomicWriteTrustedFile(entry.stage, bytes, {
      expectedIdentity: null,
      followSymlinks: false,
      mode,
    });
    entry.after = stagedGeneration(identity);
    if (!equal(inspect(entry.stage), entry.after))
      throw new Error("Installation stage changed after publication");
    if (entry.before) {
      linkSync(path, entry.backup);
      backupLinked = true;
      if (
        !equal(inspect(path), entry.before) ||
        !equal(inspect(entry.backup), entry.before)
      )
        throw new Error(`Installation changed during staging: ${path}`);
      syncDirectory(dirname(path));
    }
    return { ...entry, after: entry.after };
  } catch (error) {
    // Publication can succeed before its final fsync fails. Use the identity
    // reported by the writer, never a replacement found at the staging path.
    if (entry.after === null && error instanceof CommittedAtomicWriteError)
      entry.after = stagedGeneration(error.identity);
    const cleanupErrors: unknown[] = [];
    for (const [artifact, expected] of [
      [entry.stage, entry.after],
      [entry.backup, backupLinked ? entry.before : null],
    ] as const) {
      if (expected === null) continue;
      try {
        removeExpected(artifact, expected);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (cleanupErrors.length)
      throw new AggregateError(
        [error, ...cleanupErrors],
        "Installation staging failed; changed recovery artifacts retained",
      );
    throw error;
  }
}
export function stagedInstallIdentity(file: InstallFile) {
  return {
    device: BigInt(file.after.dev),
    inode: BigInt(file.after.ino),
    size: BigInt(file.after.size),
    mtimeNs: BigInt(file.after.mtime),
    sha256: file.after.sha256,
  };
}
export function verifyInstallFiles(files: InstallFile[]): boolean {
  return files.every((file) => equal(inspect(file.path), file.after));
}
function validateJournal(
  value: unknown,
  assertPath: (path: string) => void,
): Journal {
  if (!value || typeof value !== "object")
    throw new Error("Invalid install recovery journal");
  const j = value as Journal;
  if (
    j.version !== 1 ||
    !["complete", "rollback"].includes(j.direction) ||
    !Array.isArray(j.files) ||
    j.files.length < 1 ||
    j.files.length > 8
  )
    throw new Error("Invalid install recovery journal");
  const seen = new Set<string>();
  const validGeneration = (v: Generation | null) =>
    v === null ||
    (typeof v === "object" &&
      [v.dev, v.ino, v.size, v.mtime, v.mode].every(
        (n) => typeof n === "string" && /^\d+$/.test(n),
      ) &&
      typeof v.sha256 === "string" &&
      /^[a-f0-9]{64}$/.test(v.sha256));
  for (const f of j.files) {
    if (
      !f ||
      typeof f.path !== "string" ||
      resolve(f.path) !== f.path ||
      seen.has(f.path) ||
      !f.after ||
      !validGeneration(f.before) ||
      !validGeneration(f.after)
    )
      throw new Error("Invalid install recovery entry");
    seen.add(f.path);
    assertPath(f.path);
    const prefix = join(dirname(f.path), `.${basename(f.path)}.lore-install-`);
    if (
      typeof f.stage !== "string" ||
      !f.stage.startsWith(prefix) ||
      !/^[a-f0-9]{32}\.new$/.test(f.stage.slice(prefix.length)) ||
      f.backup !== f.stage.slice(0, -4) + ".old" ||
      f.displaced !== f.stage.slice(0, -4) + ".displaced"
    )
      throw new Error("Invalid install recovery paths");
    for (const artifact of [f.stage, f.backup, f.displaced])
      assertPath(artifact);
  }
  return j;
}
function publish(
  file: InstallFile,
  direction: Journal["direction"],
  assertOwned: () => void,
): void {
  const desired = direction === "complete" ? file.after : file.before;
  const prior = direction === "complete" ? file.before : file.after;
  const source = direction === "complete" ? file.stage : file.backup;
  assertOwned();
  const current = inspect(file.path);
  if (equal(current, desired)) return;
  if (current !== null && !equal(current, prior))
    throw new Error(
      `Refusing to overwrite an installation successor: ${file.path}`,
    );
  if (desired && !equal(inspect(source), desired))
    throw new Error(`Installation recovery source changed: ${source}`);
  if (current) {
    // Rename first so a replacement in the race window can be identified and
    // restored without unlinking a generation we never owned.
    const displaced = inspect(file.displaced);
    if (displaced) {
      if (!equal(displaced, file.before) && !equal(displaced, file.after))
        throw new Error(`Occupied install recovery claim: ${file.displaced}`);
      removeExpected(file.displaced, displaced);
    }
    renameSync(file.path, file.displaced);
    const moved = inspect(file.displaced);
    if (!equal(moved, current)) {
      if (inspect(file.path) === null) linkSync(file.displaced, file.path);
      throw new Error(`Installation changed during publication: ${file.path}`);
    }
    syncDirectory(dirname(file.path));
    publicationHook?.("quarantined", file.path);
  }
  assertOwned();
  if (desired) linkSync(source, file.path);
  publicationHook?.("linked", file.path);
  syncDirectory(dirname(file.path));
  if (!equal(inspect(file.path), desired))
    throw new Error(`Installation changed after publication: ${file.path}`);
  if (current) removeExpected(file.displaced, current);
}
function cleanup(files: InstallFile[], assertOwned: () => void): void {
  for (const f of files) {
    assertOwned();
    removeExpected(f.stage, f.after);
    assertOwned();
    if (f.before) removeExpected(f.backup, f.before);
    const displaced = inspect(f.displaced);
    if (displaced) {
      if (!equal(displaced, f.before) && !equal(displaced, f.after))
        throw new Error(`Unknown install recovery claim: ${f.displaced}`);
      assertOwned();
      removeExpected(f.displaced, displaced);
    }
  }
}
function reconcile(
  journal: Journal,
  assertOwned: () => void,
  afterPublish?: (path: string, index: number) => void,
): void {
  // Validate every target before changing any of them. Unknown successors
  // preserve both the successor and the journal for explicit recovery.
  for (const f of journal.files) {
    const current = inspect(f.path);
    if (current && !equal(current, f.before) && !equal(current, f.after))
      throw new Error(
        `Refusing to overwrite an installation successor: ${f.path}`,
      );
  }
  const files =
    journal.direction === "complete"
      ? journal.files
      : [...journal.files].reverse();
  files.forEach((f, index) => {
    publish(f, journal.direction, assertOwned);
    afterPublish?.(f.path, index);
  });
}
export function recoverInstallTransaction(
  journalPath: string,
  assertOwned: () => void,
  assertPath: (path: string) => void,
  epoch?: string,
  stalePolicy: "discard" | "rollback" = "discard",
): void {
  const stored = readFile(journalPath);
  if (!stored) return;
  if (stored.bytes.length > 65536)
    throw new Error("Install recovery journal is too large");
  if (process.platform !== "win32" && (stored.identity.mode & 0o077n) !== 0n)
    throw new Error("Install recovery journal is not private");
  const journal = validateJournal(JSON.parse(stored.text), assertPath);
  // A later uninstall supersedes pending publication. Dispose of only our
  // verified artifacts; never replay its old executable or configuration.
  if (journal.epoch === epoch) {
    reconcile(journal, assertOwned);
    assertOwned();
    if (
      !journal.files.every((f) =>
        equal(
          inspect(f.path),
          journal.direction === "complete" ? f.after : f.before,
        ),
      )
    )
      throw new Error("Recovered installation changed before commit");
  }
  if (journal.epoch !== epoch && stalePolicy === "rollback") {
    // Preserve newer user edits. Restore only an owned interrupted profile,
    // including its original text when it was quarantined before a crash.
    for (const f of [...journal.files].reverse()) {
      const current = inspect(f.path);
      if (
        current === null ||
        equal(current, f.before) ||
        equal(current, f.after)
      )
        publish(f, "rollback", assertOwned);
    }
  }
  cleanup(journal.files, assertOwned);
  assertOwned();
  removeTrustedFile(journalPath, stored.identity, undefined, {
    followSymlinks: false,
  });
}
export function commitInstallTransaction(
  journalPath: string,
  files: InstallFile[],
  assertOwned: () => void,
  verify: () => void,
  afterPublish?: (path: string, index: number) => void,
  epoch?: string,
): void {
  assertOwned();
  let identity: TrustedFileIdentity;
  try {
    identity = atomicWriteTrustedFile(
      journalPath,
      JSON.stringify({ version: 1, direction: "complete", epoch, files }),
      { expectedIdentity: null, followSymlinks: false, mode: 0o600 },
    );
  } catch (error) {
    // A visible journal owns its stages even if its final fsync failed.
    // Only an absent journal proves these files are still unpublished work.
    if (!(error instanceof CommittedAtomicWriteError)) {
      assertOwned();
      if (readFile(journalPath) === null) cleanup(files, assertOwned);
    }
    throw error;
  }
  try {
    reconcile(
      { version: 1, direction: "complete", files },
      assertOwned,
      afterPublish,
    );
    assertOwned();
    verify();
  } catch (error) {
    assertOwned();
    identity = atomicWriteTrustedFile(
      journalPath,
      JSON.stringify({ version: 1, direction: "rollback", epoch, files }),
      { expectedIdentity: identity, followSymlinks: false, mode: 0o600 },
    );
    try {
      reconcile({ version: 1, direction: "rollback", files }, assertOwned);
      assertOwned();
      if (!files.every((f) => equal(inspect(f.path), f.before)))
        throw new Error("Rolled-back installation changed before cleanup");
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "Installation failed; recovery evidence retained",
      );
    }
    cleanup(files, assertOwned);
    assertOwned();
    removeTrustedFile(journalPath, identity, undefined, {
      followSymlinks: false,
    });
    throw error;
  }
  cleanup(files, assertOwned);
  assertOwned();
  removeTrustedFile(journalPath, identity, undefined, {
    followSymlinks: false,
  });
}

/** Remove only known pre-journal artifacts after a staging failure. */
export function discardInstallStages(
  files: InstallFile[],
  assertOwned: () => void,
): void {
  cleanup(files, assertOwned);
}
