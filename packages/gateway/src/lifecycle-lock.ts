import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";

const LOCK_VERSION = 1;
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const OWNER_FILE = "owner.json";
const UNINSTALL_TOMBSTONE_FILE = "uninstalled.json";
const INITIALIZATION_CLAIM_MARKER = ".init.";
const INITIALIZATION_QUARANTINE_MARKER = ".claim.init.";
const RELEASE_CLAIM_MARKER = ".release.";
const MAX_OWNER_BYTES = 16 * 1024;
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_RETRY_DELAY_MS = 50;
const NO_FOLLOW = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;

/** Lifecycle transitions serialized by the per-user lock. */
export type LifecycleOperation =
  | "gateway-start"
  | "gateway-shutdown"
  | "upgrade"
  | "setup"
  | "uninstall"
  | "hosted-install";

export interface LifecycleLockOwner {
  version: 1;
  token: string;
  pid: number;
  operation: LifecycleOperation;
  createdAt: string;
  processStartedAt: string;
  processIdentity: string;
}

export type ProcessInspection =
  | { state: "alive"; identity: string | null }
  | { state: "dead" }
  | { state: "unknown" };

export interface LifecycleLockOptions {
  /** Override used by focused tests and embedders with an isolated home. */
  lockPath?: string;
  timeoutMs?: number;
  retryDelayMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  createToken?: () => string;
  pid?: number;
  processIdentity?: string;
  processStartedAt?: string;
  inspectProcess?: (pid: number) => ProcessInspection;
  /** Package CLI entry used to recover a tombstone after a fresh install. */
  packageEntryPath?: string;
  /** Explicit SEA state for tests; defaults to node:sea inspection. */
  seaBinary?: boolean;
  /** Focused crash-injection seam; called after mkdir and before owner publication. */
  _afterLockDirectoryCreated?: () => void;
  /** Focused crash-injection seam; called after owner removal and before rmdir. */
  _afterLockOwnerRemoved?: () => void;
  /** Focused crash-injection seam after incomplete-generation validation. */
  _afterLockRecoveryValidated?: () => void;
}

interface ResolvedOptions {
  lockPath: string;
  timeoutMs: number;
  retryDelayMs: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  createToken: () => string;
  pid: number;
  processIdentity?: string;
  processStartedAt?: string;
  inspectProcess: (pid: number) => ProcessInspection;
  packageEntryPath?: string;
  seaBinary: boolean;
  afterLockDirectoryCreated?: () => void;
  afterLockOwnerRemoved?: () => void;
  afterLockRecoveryValidated?: () => void;
}

export interface LifecycleLock {
  readonly path: string;
  readonly owner: LifecycleLockOwner;
  assertOwned(): void;
  release(): void;
}

export interface UninstallTombstone {
  version: 1;
  token: string;
  createdAt: string;
}

export interface UninstallTombstoneTransaction {
  readonly tombstone: UninstallTombstone;
  rollback(): void;
}

export class LifecycleLockBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LifecycleLockBusyError";
  }
}

export class LifecycleLockLostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LifecycleLockLostError";
  }
}

interface LockSnapshot {
  owner: LifecycleLockOwner;
  directory: Stats;
  ownerFile: Stats;
  ownerContent: string;
}

interface OwnerRecordSnapshot {
  owner: LifecycleLockOwner;
  file: Stats;
  content: string;
}

interface OwnerStage extends OwnerRecordSnapshot {
  path: string;
  initializationClaimPath: string;
}

interface ReleaseClaim {
  version: 1;
  token: string;
  directoryDevice: string;
  directoryInode: string;
  directoryBirthtimeMs: string;
  ownerDevice: string;
  ownerInode: string;
  ownerSha256: string;
}

interface ReleaseClaimSnapshot {
  claim: ReleaseClaim;
  file: Stats;
  content: string;
  path: string;
}

interface UninstallTombstoneSnapshot {
  marker: UninstallTombstone;
  file: Stats;
  content: string;
}

interface PackageInvocationEvidence {
  entryPath: string;
  entryIdentity: string;
  manifestPath: string;
  manifestIdentity: string;
}

interface CapturedRegularFile {
  content: Buffer;
  identity: string;
}

const lockContext = new AsyncLocalStorage<LifecycleLock>();

/** Run work without propagating the current lifecycle lock to async resources. */
export function withoutLifecycleLock<T>(action: () => T): T {
  return lockContext.exit(action);
}
const processEntryPath = (() => {
  try {
    return require.main?.filename;
  } catch {
    return undefined;
  }
})();

function errno(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function isMissing(error: unknown): boolean {
  return errno(error) === "ENOENT";
}

function assertCurrentOwner(info: Stats, path: string): void {
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new LifecycleLockBusyError(
      `Refusing lifecycle lock path not owned by the current user: ${path}`,
    );
  }
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameGeneration(left: Stats, right: Stats): boolean {
  return (
    sameFile(left, right) &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function fsyncDirectory(path: string): void {
  // Node does not expose a portable Windows directory-flush primitive. The
  // file itself is still flushed before publication there; on Unix, also
  // persist every directory-entry transition used by the protocol.
  if (process.platform === "win32") return;
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function validateDirectory(path: string, tighten: boolean): Stats {
  const before = lstatSync(path);
  if (before.isSymbolicLink() || !before.isDirectory()) {
    throw new LifecycleLockBusyError(
      `Refusing non-directory lifecycle lock path: ${path}`,
    );
  }
  assertCurrentOwner(before, path);

  if (process.platform === "win32") return before;

  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const opened = fstatSync(fd);
    if (!opened.isDirectory() || !sameFile(before, opened)) {
      throw new LifecycleLockBusyError(
        `Lifecycle lock directory changed while opening: ${path}`,
      );
    }
    assertCurrentOwner(opened, path);
    if (tighten && (opened.mode & 0o777) !== DIRECTORY_MODE) {
      fchmodSync(fd, DIRECTORY_MODE);
    }
    const finalInfo = fstatSync(fd);
    if ((finalInfo.mode & 0o077) !== 0) {
      throw new LifecycleLockBusyError(
        `Lifecycle lock directory is not owner-only: ${path}`,
      );
    }
    if (!sameFile(lstatSync(path), finalInfo)) {
      throw new LifecycleLockBusyError(
        `Lifecycle lock directory changed while validating: ${path}`,
      );
    }
    return finalInfo;
  } finally {
    closeSync(fd);
  }
}

function ensureLockParent(lockPath: string): string {
  const parent = dirname(lockPath);
  mkdirSync(parent, { recursive: true, mode: DIRECTORY_MODE });
  validateDirectory(parent, true);
  return parent;
}

function validTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 64 &&
    Number.isFinite(Date.parse(value))
  );
}

const OPERATIONS = new Set<LifecycleOperation>([
  "gateway-start",
  "gateway-shutdown",
  "upgrade",
  "setup",
  "uninstall",
  "hosted-install",
]);

function validOwner(value: unknown): value is LifecycleLockOwner {
  if (typeof value !== "object" || value === null) return false;
  const owner = value as Partial<LifecycleLockOwner>;
  return (
    owner.version === LOCK_VERSION &&
    typeof owner.token === "string" &&
    /^[A-Za-z0-9_-]{32,256}$/.test(owner.token) &&
    typeof owner.pid === "number" &&
    Number.isSafeInteger(owner.pid) &&
    owner.pid > 0 &&
    typeof owner.operation === "string" &&
    OPERATIONS.has(owner.operation) &&
    validTimestamp(owner.createdAt) &&
    validTimestamp(owner.processStartedAt) &&
    typeof owner.processIdentity === "string" &&
    owner.processIdentity.length > 0 &&
    owner.processIdentity.length <= 1024
  );
}

function readOwnerRecord(ownerPath: string): OwnerRecordSnapshot {
  const before = lstatSync(ownerPath);
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new LifecycleLockBusyError(
      `Refusing non-regular lifecycle lock owner file: ${ownerPath}`,
    );
  }
  assertCurrentOwner(before, ownerPath);
  if (before.size > MAX_OWNER_BYTES) {
    throw new LifecycleLockBusyError(
      `Lifecycle lock owner record is too large: ${ownerPath}`,
    );
  }

  const fd = openSync(
    ownerPath,
    constants.O_RDONLY | constants.O_NONBLOCK | NO_FOLLOW,
  );
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || !sameFile(before, opened)) {
      throw new LifecycleLockBusyError(
        `Lifecycle lock owner file changed while opening: ${ownerPath}`,
      );
    }
    assertCurrentOwner(opened, ownerPath);
    if (process.platform !== "win32" && (opened.mode & 0o077) !== 0) {
      throw new LifecycleLockBusyError(
        `Lifecycle lock owner file is not owner-only: ${ownerPath}`,
      );
    }
    const content = readFileSync(fd, "utf8");
    const finalInfo = fstatSync(fd);
    if (
      content.length > MAX_OWNER_BYTES ||
      !sameGeneration(opened, finalInfo) ||
      !sameFile(lstatSync(ownerPath), finalInfo)
    ) {
      throw new LifecycleLockBusyError(
        `Lifecycle lock owner record changed while reading: ${ownerPath}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new LifecycleLockBusyError(
        `Lifecycle lock owner record is malformed: ${ownerPath}`,
      );
    }
    if (!validOwner(parsed)) {
      throw new LifecycleLockBusyError(
        `Lifecycle lock owner record is invalid: ${ownerPath}`,
      );
    }
    return { owner: parsed, file: finalInfo, content };
  } finally {
    closeSync(fd);
  }
}

function inspectLockPath(lockPath: string): LockSnapshot {
  const directory = validateDirectory(lockPath, false);
  const ownerRecord = readOwnerRecord(join(lockPath, OWNER_FILE));
  if (!sameFile(lstatSync(lockPath), directory)) {
    throw new LifecycleLockBusyError(
      `Lifecycle lock changed while inspecting: ${lockPath}`,
    );
  }
  return {
    owner: ownerRecord.owner,
    directory,
    ownerFile: ownerRecord.file,
    ownerContent: ownerRecord.content,
  };
}

export interface StableUnixProcessMetadata {
  /** Stable boot generation, such as Linux procfs boot_id. */
  bootId?: string | null;
  /** Monotonic process start tick within that boot generation. */
  startTicks?: string | null;
  /**
   * Weak compatibility metadata, intentionally never sufficient for identity.
   * macOS/BSD `ps -o lstart=` has only one-second resolution, so two process
   * generations can share it.
   */
  secondResolutionStartedAt?: string | null;
}

/** Build an identity only from stable sub-second process-generation metadata. */
export function stableUnixProcessIdentity(
  metadata: StableUnixProcessMetadata,
  prefix = "unix-procfs",
): string | null {
  const bootId = metadata.bootId?.trim();
  const startTicks = metadata.startTicks?.trim();
  if (!bootId || !startTicks || !/^\d+$/.test(startTicks)) return null;
  return `${prefix}:${bootId}:${startTicks}`;
}

function procfsProcessIdentity(pid: number, prefix: string): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const closeParen = stat.lastIndexOf(")");
    if (closeParen === -1) return null;
    // The suffix begins at field 3 (state); process start ticks are field 22.
    const fields = stat
      .slice(closeParen + 2)
      .trim()
      .split(/\s+/);
    const startTicks = fields[19];
    if (!startTicks || !/^\d+$/.test(startTicks)) return null;
    const bootId = readFileSync(
      "/proc/sys/kernel/random/boot_id",
      "utf8",
    ).trim();
    return stableUnixProcessIdentity({ bootId, startTicks }, prefix);
  } catch {
    return null;
  }
}

function processIdentity(pid: number): string | null {
  if (process.platform === "win32") return null;
  // Linux keeps its established boot-id/start-ticks representation. Other
  // Unix platforms may use the same strong procfs metadata when available;
  // otherwise fail closed. Never fall back to one-second `ps lstart` output.
  if (process.platform === "linux") return procfsProcessIdentity(pid, "linux");
  return procfsProcessIdentity(pid, "unix-procfs");
}

/** Stable process-start identity when the current platform exposes one. */
export function currentProcessIdentity(
  pid: number = process.pid,
): string | null {
  return processIdentity(pid);
}

/** Inspect liveness and process-start identity as one generation check. */
export function inspectProcessGeneration(pid: number): ProcessInspection {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (errno(error) === "ESRCH") return { state: "dead" };
    return { state: "unknown" };
  }
  return { state: "alive", identity: processIdentity(pid) };
}

function defaultLifecycleRoot(): string {
  // The global test harness isolates LORE_DB_PATH but intentionally does not
  // replace HOME. Derive an equally isolated config root so gateway tests can
  // never create a lock in the developer's real ~/.lore directory.
  if (process.env.NODE_ENV === "test" && process.env.LORE_DB_PATH) {
    return join(dirname(process.env.LORE_DB_PATH), ".lore");
  }
  const home = process.env.HOME ?? process.env.USERPROFILE ?? homedir();
  // Install provenance and lifecycle serialization are fixed per-user state,
  // not relocatable runtime configuration. The hosted installer uses this
  // same path even when LORE_CONFIG_DIR points elsewhere.
  return join(home, ".lore");
}

/** Path to the per-user lifecycle lock, outside purgeable runtime/data state. */
export function lifecycleLockPath(): string {
  return join(defaultLifecycleRoot(), "lifecycle.lock");
}

function resolveOptions(options: LifecycleLockOptions): ResolvedOptions {
  return {
    lockPath: options.lockPath ?? lifecycleLockPath(),
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    retryDelayMs: options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS,
    now: options.now ?? Date.now,
    sleep:
      options.sleep ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    createToken:
      options.createToken ?? (() => randomBytes(32).toString("base64url")),
    pid: options.pid ?? process.pid,
    processIdentity: options.processIdentity,
    processStartedAt: options.processStartedAt,
    inspectProcess: options.inspectProcess ?? inspectProcessGeneration,
    packageEntryPath: options.packageEntryPath ?? processEntryPath,
    seaBinary: options.seaBinary ?? isSeaBinary(),
    afterLockDirectoryCreated: options._afterLockDirectoryCreated,
    afterLockOwnerRemoved: options._afterLockOwnerRemoved,
    afterLockRecoveryValidated: options._afterLockRecoveryValidated,
  };
}

function isSeaBinary(): boolean {
  try {
    const sea = require("node:sea") as { isSea?: () => boolean };
    return typeof sea.isSea === "function" ? sea.isSea() : false;
  } catch {
    return false;
  }
}

function pathIsInside(path: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function captureRegularFile(path: string): CapturedRegularFile | null {
  let fd: number | undefined;
  try {
    const before = lstatSync(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink()) return null;
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | NO_FOLLOW);
    const opened = fstatSync(fd, { bigint: true });
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    ) {
      return null;
    }
    const content = readFileSync(fd);
    const final = fstatSync(fd, { bigint: true });
    if (
      opened.dev !== final.dev ||
      opened.ino !== final.ino ||
      opened.size !== final.size ||
      opened.mtimeNs !== final.mtimeNs ||
      opened.ctimeNs !== final.ctimeNs
    ) {
      return null;
    }
    return {
      content,
      identity: [
        final.dev,
        final.ino,
        final.size,
        final.mtimeNs,
        final.ctimeNs,
        createHash("sha256").update(content).digest("hex"),
      ].join(":"),
    };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function regularFileIdentity(path: string): string | null {
  return captureRegularFile(path)?.identity ?? null;
}

function packageInvocationEvidence(input: {
  entryPath?: string;
  seaBinary: boolean;
}): PackageInvocationEvidence | null {
  if (input.seaBinary || !input.entryPath) return null;
  try {
    const entryPath = realpathSync.native(input.entryPath);
    const packageRoot = dirname(dirname(entryPath));
    if (
      basename(entryPath) !== "bin.cjs" ||
      basename(dirname(entryPath)) !== "dist" ||
      basename(packageRoot) !== "gateway" ||
      basename(dirname(packageRoot)) !== "@loreai" ||
      basename(dirname(dirname(packageRoot))) !== "node_modules" ||
      !pathIsInside(entryPath, packageRoot)
    ) {
      return null;
    }
    const manifestPath = join(packageRoot, "package.json");
    if (realpathSync.native(manifestPath) !== manifestPath) return null;
    const entry = captureRegularFile(entryPath);
    const capturedManifest = captureRegularFile(manifestPath);
    if (entry === null || capturedManifest === null) return null;
    const manifest = JSON.parse(capturedManifest.content.toString("utf8")) as {
      name?: unknown;
      bin?: unknown;
    };
    if (
      manifest.name !== "@loreai/gateway" ||
      typeof manifest.bin !== "object" ||
      manifest.bin === null
    ) {
      return null;
    }
    const bins = manifest.bin as Record<string, unknown>;
    const declaredEntries = [bins.lore, bins["lore-gateway"]].filter(
      (value): value is string => typeof value === "string",
    );
    if (
      declaredEntries.length === 0 ||
      !declaredEntries.some((declared) => {
        const declaredPath = resolve(packageRoot, declared);
        return (
          pathIsInside(declaredPath, packageRoot) &&
          realpathSync.native(declaredPath) === entryPath
        );
      })
    ) {
      return null;
    }
    return {
      entryPath,
      entryIdentity: entry.identity,
      manifestPath,
      manifestIdentity: capturedManifest.identity,
    };
  } catch {
    return null;
  }
}

/** True only for the declared CLI entry of an installed @loreai/gateway package. */
export function isVerifiedPackageInvocation(input: {
  entryPath?: string;
  seaBinary?: boolean;
}): boolean {
  return (
    packageInvocationEvidence({
      entryPath: input.entryPath,
      seaBinary: input.seaBinary ?? isSeaBinary(),
    }) !== null
  );
}

function packageEvidenceStillMatches(
  evidence: PackageInvocationEvidence,
): boolean {
  return (
    regularFileIdentity(evidence.entryPath) === evidence.entryIdentity &&
    regularFileIdentity(evidence.manifestPath) === evidence.manifestIdentity
  );
}

function uninstallTombstonePath(lockPath: string): string {
  return join(dirname(lockPath), UNINSTALL_TOMBSTONE_FILE);
}

function validUninstallTombstone(value: unknown): value is UninstallTombstone {
  if (typeof value !== "object" || value === null) return false;
  const marker = value as Partial<UninstallTombstone>;
  return (
    marker.version === 1 &&
    typeof marker.token === "string" &&
    /^[A-Za-z0-9_-]{32,256}$/.test(marker.token) &&
    validTimestamp(marker.createdAt)
  );
}

function readUninstallTombstoneSnapshot(
  lockPath: string,
): UninstallTombstoneSnapshot | null {
  const path = uninstallTombstonePath(lockPath);
  let before: Stats;
  try {
    before = lstatSync(path);
  } catch (error) {
    if (isMissing(error)) return null;
    throw new LifecycleLockBusyError(
      `Uninstall marker could not be inspected: ${path}: ${String(error)}`,
    );
  }
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new LifecycleLockBusyError(
      `Refusing unsafe uninstall marker: ${path}`,
    );
  }
  assertCurrentOwner(before, path);
  if (before.size > MAX_OWNER_BYTES) {
    throw new LifecycleLockBusyError(`Uninstall marker is too large: ${path}`);
  }
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_NONBLOCK | NO_FOLLOW,
  );
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || !sameFile(before, opened)) {
      throw new LifecycleLockBusyError(
        `Uninstall marker changed while opening: ${path}`,
      );
    }
    assertCurrentOwner(opened, path);
    if (process.platform !== "win32" && (opened.mode & 0o077) !== 0) {
      throw new LifecycleLockBusyError(
        `Uninstall marker is not owner-only: ${path}`,
      );
    }
    let content: string;
    let parsed: unknown;
    try {
      content = readFileSync(fd, "utf8");
      parsed = JSON.parse(content);
    } catch {
      throw new LifecycleLockBusyError(
        `Uninstall marker is malformed: ${path}`,
      );
    }
    if (!validUninstallTombstone(parsed)) {
      throw new LifecycleLockBusyError(`Uninstall marker is invalid: ${path}`);
    }
    const final = fstatSync(fd);
    if (!sameGeneration(opened, final)) {
      throw new LifecycleLockBusyError(
        `Uninstall marker changed while reading: ${path}`,
      );
    }
    return { marker: parsed, file: final, content };
  } finally {
    closeSync(fd);
  }
}

function readUninstallTombstone(lockPath: string): UninstallTombstone | null {
  return readUninstallTombstoneSnapshot(lockPath)?.marker ?? null;
}

function publishUninstallTombstone(
  lock: LifecycleLock,
  marker: UninstallTombstone,
): void {
  lock.assertOwned();
  const parent = ensureLockParent(lock.path);
  const path = uninstallTombstonePath(lock.path);
  const temp = join(parent, `.${UNINSTALL_TOMBSTONE_FILE}.${marker.token}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(
      temp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
      FILE_MODE,
    );
    if (process.platform !== "win32") fchmodSync(fd, FILE_MODE);
    writeFileSync(fd, `${JSON.stringify(marker)}\n`, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    lock.assertOwned();
    renameSync(temp, path);
    if (readUninstallTombstone(lock.path)?.token !== marker.token) {
      throw new LifecycleLockLostError(
        `Uninstall marker changed during publication: ${path}`,
      );
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(temp, { force: true });
  }
}

function removeUninstallTombstone(
  lock: LifecycleLock,
  expectedToken: string,
  expected?: UninstallTombstoneSnapshot,
): void {
  lock.assertOwned();
  const current = readUninstallTombstoneSnapshot(lock.path);
  if (current === null) {
    if (expected) {
      throw new LifecycleLockLostError(
        "Uninstall marker changed during expected-token quarantine",
      );
    }
    return;
  }
  if (current.marker.token !== expectedToken) {
    throw new LifecycleLockLostError(
      "Refusing to remove a successor uninstall marker",
    );
  }
  if (
    expected &&
    (!sameFile(current.file, expected.file) ||
      current.content !== expected.content)
  ) {
    throw new LifecycleLockLostError(
      "Refusing to remove a successor uninstall marker",
    );
  }
  const path = uninstallTombstonePath(lock.path);
  const claim = join(
    dirname(path),
    `.${UNINSTALL_TOMBSTONE_FILE}.claim.${expectedToken}.${randomBytes(8).toString("hex")}`,
  );
  try {
    renameSync(path, claim);
  } catch (error) {
    if (isMissing(error)) {
      throw new LifecycleLockLostError(
        "Uninstall marker changed during expected-token quarantine",
      );
    }
    throw error;
  }
  try {
    const claimInfo = lstatSync(claim);
    if (
      !claimInfo.isFile() ||
      claimInfo.isSymbolicLink() ||
      !sameFile(current.file, claimInfo)
    ) {
      throw new LifecycleLockLostError(
        "Uninstall marker changed during expected-token quarantine",
      );
    }
    assertCurrentOwner(claimInfo, claim);
    const claimFd = openSync(
      claim,
      constants.O_RDONLY | constants.O_NONBLOCK | NO_FOLLOW,
    );
    try {
      const opened = fstatSync(claimFd);
      const content = readFileSync(claimFd, "utf8");
      const final = fstatSync(claimFd);
      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch {
        parsed = null;
      }
      if (
        !sameFile(claimInfo, opened) ||
        !sameGeneration(opened, final) ||
        content !== current.content ||
        !validUninstallTombstone(parsed) ||
        parsed.token !== expectedToken
      ) {
        throw new LifecycleLockLostError(
          "Uninstall marker changed during expected-token quarantine",
        );
      }
    } finally {
      closeSync(claimFd);
    }
    unlinkSync(claim);
    if (readUninstallTombstoneSnapshot(lock.path) !== null) {
      throw new LifecycleLockLostError(
        "Refusing to remove a successor uninstall marker",
      );
    }
  } catch (error) {
    try {
      lstatSync(path);
    } catch (pathError) {
      if (isMissing(pathError)) {
        try {
          linkSync(claim, path);
          unlinkSync(claim);
        } catch {
          // Preserve the claim if a safe no-clobber restoration is impossible.
        }
      }
    }
    throw error;
  }
}

/** Publish a persistent uninstall generation before destructive mutation. */
export function createUninstallTombstone(
  lock: LifecycleLock,
): UninstallTombstoneTransaction {
  lock.assertOwned();
  const previous = readUninstallTombstone(lock.path);
  const tombstone: UninstallTombstone = {
    version: 1,
    token: randomBytes(32).toString("base64url"),
    createdAt: new Date().toISOString(),
  };
  publishUninstallTombstone(lock, tombstone);
  return {
    tombstone,
    rollback: () => {
      lock.assertOwned();
      if (readUninstallTombstone(lock.path)?.token !== tombstone.token) {
        throw new LifecycleLockLostError(
          "Refusing to roll back a successor uninstall marker",
        );
      }
      if (previous) publishUninstallTombstone(lock, previous);
      else removeUninstallTombstone(lock, tombstone.token);
    },
  };
}

export function currentUninstallTombstoneToken(
  lock: LifecycleLock,
): string | null {
  lock.assertOwned();
  return readUninstallTombstone(lock.path)?.token ?? null;
}

/** Clear a marker only after a fresh installer verifies binary and receipt. */
export function clearUninstallTombstoneForVerifiedInstall(
  lock: LifecycleLock,
  expectedToken: string,
  verifyInstalledGeneration: () => boolean,
): void {
  lock.assertOwned();
  const expected = readUninstallTombstoneSnapshot(lock.path);
  if (expected?.marker.token !== expectedToken) {
    throw new LifecycleLockLostError(
      "Fresh install no longer matches the current uninstall generation",
    );
  }
  if (!verifyInstalledGeneration()) {
    throw new Error(
      "Refusing to clear uninstall marker before binary/receipt verification",
    );
  }
  removeUninstallTombstone(lock, expectedToken, expected);
}

function sameTombstoneGeneration(
  left: UninstallTombstone | null,
  right: UninstallTombstone | null,
): boolean {
  return left?.token === right?.token && (left === null) === (right === null);
}

function observationMayProceed(
  operation: LifecycleOperation,
  observed: UninstallTombstone | null,
  current: UninstallTombstone | null,
): boolean {
  if (operation === "uninstall" || operation === "gateway-shutdown")
    return true;
  if (operation === "hosted-install") {
    // A fresh installer loaded after uninstall may recover. An installer that
    // was already waiting when the marker appeared is stale and must abort.
    return sameTombstoneGeneration(observed, current);
  }
  return current === null && sameTombstoneGeneration(observed, current);
}

function lockArtifactPrefix(lockPath: string, marker: string): string {
  return `.${basename(lockPath)}${marker}`;
}

function sameOwnerRecord(
  left: OwnerRecordSnapshot,
  right: OwnerRecordSnapshot,
): boolean {
  return sameFile(left.file, right.file) && left.content === right.content;
}

function createOwnerStage(
  lockPath: string,
  owner: LifecycleLockOwner,
): OwnerStage {
  const parent = dirname(lockPath);
  const path = join(
    parent,
    `${lockArtifactPrefix(lockPath, ".owner.")}${owner.token}.${randomBytes(8).toString("hex")}.tmp`,
  );
  const initializationClaimPath = join(
    parent,
    `${lockArtifactPrefix(lockPath, INITIALIZATION_CLAIM_MARKER)}${owner.token}`,
  );
  let fd: number | undefined;
  try {
    fd = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
      FILE_MODE,
    );
    const info = fstatSync(fd);
    if (!info.isFile()) {
      throw new Error(`Failed to stage lifecycle lock owner: ${path}`);
    }
    assertCurrentOwner(info, path);
    if (process.platform !== "win32") fchmodSync(fd, FILE_MODE);
    writeFileSync(fd, `${JSON.stringify(owner)}\n`, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    fsyncDirectory(parent);
    const staged = readOwnerRecord(path);
    if (
      staged.owner.token !== owner.token ||
      staged.owner.pid !== owner.pid ||
      staged.owner.processIdentity !== owner.processIdentity
    ) {
      throw new LifecycleLockLostError(
        `Lifecycle lock owner changed during staging: ${path}`,
      );
    }
    return { ...staged, path, initializationClaimPath };
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    rmSync(path, { force: true });
    throw error;
  }
}

function removeExpectedOwnerRecord(
  path: string,
  expected: OwnerRecordSnapshot,
): void {
  let current: OwnerRecordSnapshot;
  try {
    current = readOwnerRecord(path);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  if (!sameOwnerRecord(current, expected)) {
    throw new LifecycleLockLostError(
      `Refusing to remove a changed lifecycle generation artifact: ${path}`,
    );
  }
  unlinkSync(path);
  fsyncDirectory(dirname(path));
}

function publishInitializationClaim(stage: OwnerStage): void {
  const currentStage = readOwnerRecord(stage.path);
  if (!sameOwnerRecord(currentStage, stage)) {
    throw new LifecycleLockLostError(
      `Lifecycle owner stage changed before claim publication: ${stage.path}`,
    );
  }
  try {
    linkSync(stage.path, stage.initializationClaimPath);
  } catch (error) {
    if (errno(error) !== "EEXIST") throw error;
    const existing = readOwnerRecord(stage.initializationClaimPath);
    if (!sameOwnerRecord(existing, stage)) {
      throw new LifecycleLockBusyError(
        `Refusing occupied lifecycle initialization claim: ${stage.initializationClaimPath}`,
      );
    }
  }
  const claim = readOwnerRecord(stage.initializationClaimPath);
  if (!sameOwnerRecord(claim, stage)) {
    throw new LifecycleLockLostError(
      `Lifecycle initialization claim changed during publication: ${stage.initializationClaimPath}`,
    );
  }
  fsyncDirectory(dirname(stage.initializationClaimPath));
}

function emptyLockDirectory(lockPath: string): Stats | null {
  try {
    const before = validateDirectory(lockPath, false);
    if (readdirSync(lockPath).length !== 0) return null;
    const after = validateDirectory(lockPath, false);
    return sameGeneration(before, after) ? after : null;
  } catch (error) {
    if (isMissing(error) || error instanceof LifecycleLockBusyError)
      return null;
    throw error;
  }
}

interface InitializationClaimSnapshot extends OwnerRecordSnapshot {
  path: string;
}

function initializationClaims(lockPath: string): InitializationClaimSnapshot[] {
  const parent = dirname(lockPath);
  const prefix = lockArtifactPrefix(lockPath, INITIALIZATION_CLAIM_MARKER);
  const before = validateDirectory(parent, false);
  const claims = readdirSync(parent)
    .filter((entry) => entry.startsWith(prefix))
    .map((entry) => {
      const token = entry.slice(prefix.length);
      if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) {
        throw new LifecycleLockBusyError(
          `Refusing malformed lifecycle initialization claim: ${join(parent, entry)}`,
        );
      }
      const path = join(parent, entry);
      const snapshot = readOwnerRecord(path);
      if (snapshot.owner.token !== token) {
        throw new LifecycleLockBusyError(
          `Lifecycle initialization claim token does not match its path: ${path}`,
        );
      }
      return { ...snapshot, path };
    });
  const after = validateDirectory(parent, false);
  if (!sameGeneration(before, after)) {
    throw new LifecycleLockBusyError(
      `Lifecycle initialization claims changed while inspecting: ${parent}`,
    );
  }
  return claims;
}

function statComponent(value: number): string {
  return String(value);
}

function releaseClaimFor(snapshot: LockSnapshot): ReleaseClaim {
  return {
    version: 1,
    token: snapshot.owner.token,
    directoryDevice: statComponent(snapshot.directory.dev),
    directoryInode: statComponent(snapshot.directory.ino),
    directoryBirthtimeMs: String(snapshot.directory.birthtimeMs),
    ownerDevice: statComponent(snapshot.ownerFile.dev),
    ownerInode: statComponent(snapshot.ownerFile.ino),
    ownerSha256: createHash("sha256")
      .update(snapshot.ownerContent)
      .digest("hex"),
  };
}

function validReleaseClaim(value: unknown): value is ReleaseClaim {
  if (typeof value !== "object" || value === null) return false;
  const claim = value as Partial<ReleaseClaim>;
  return (
    claim.version === 1 &&
    typeof claim.token === "string" &&
    /^[A-Za-z0-9_-]{32,256}$/.test(claim.token) &&
    typeof claim.directoryDevice === "string" &&
    /^\d+$/.test(claim.directoryDevice) &&
    typeof claim.directoryInode === "string" &&
    /^\d+$/.test(claim.directoryInode) &&
    typeof claim.directoryBirthtimeMs === "string" &&
    /^\d+(?:\.\d+)?$/.test(claim.directoryBirthtimeMs) &&
    typeof claim.ownerDevice === "string" &&
    /^\d+$/.test(claim.ownerDevice) &&
    typeof claim.ownerInode === "string" &&
    /^\d+$/.test(claim.ownerInode) &&
    typeof claim.ownerSha256 === "string" &&
    /^[a-f0-9]{64}$/.test(claim.ownerSha256)
  );
}

function readReleaseClaim(path: string): ReleaseClaimSnapshot {
  const before = lstatSync(path);
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new LifecycleLockBusyError(
      `Refusing non-regular lifecycle release claim: ${path}`,
    );
  }
  assertCurrentOwner(before, path);
  if (before.size > MAX_OWNER_BYTES) {
    throw new LifecycleLockBusyError(
      `Lifecycle release claim is too large: ${path}`,
    );
  }
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_NONBLOCK | NO_FOLLOW,
  );
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || !sameFile(before, opened)) {
      throw new LifecycleLockBusyError(
        `Lifecycle release claim changed while opening: ${path}`,
      );
    }
    assertCurrentOwner(opened, path);
    if (process.platform !== "win32" && (opened.mode & 0o077) !== 0) {
      throw new LifecycleLockBusyError(
        `Lifecycle release claim is not owner-only: ${path}`,
      );
    }
    const content = readFileSync(fd, "utf8");
    const finalInfo = fstatSync(fd);
    if (
      !sameGeneration(opened, finalInfo) ||
      !sameFile(lstatSync(path), finalInfo)
    ) {
      throw new LifecycleLockBusyError(
        `Lifecycle release claim changed while reading: ${path}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new LifecycleLockBusyError(
        `Lifecycle release claim is malformed: ${path}`,
      );
    }
    if (!validReleaseClaim(parsed)) {
      throw new LifecycleLockBusyError(
        `Lifecycle release claim is invalid: ${path}`,
      );
    }
    return { claim: parsed, file: finalInfo, content, path };
  } finally {
    closeSync(fd);
  }
}

function releaseClaimMatchesDirectory(
  claim: ReleaseClaim,
  directory: Stats,
): boolean {
  return (
    claim.directoryDevice === statComponent(directory.dev) &&
    claim.directoryInode === statComponent(directory.ino) &&
    claim.directoryBirthtimeMs === String(directory.birthtimeMs)
  );
}

function matchingReleaseClaims(
  lockPath: string,
  directory: Stats,
): ReleaseClaimSnapshot[] {
  const parent = dirname(lockPath);
  const prefix = lockArtifactPrefix(lockPath, RELEASE_CLAIM_MARKER);
  const claims = readdirSync(parent)
    .filter((entry) => entry.startsWith(prefix))
    .map((entry) => {
      const token = entry.slice(prefix.length);
      if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) {
        throw new LifecycleLockBusyError(
          `Refusing malformed lifecycle release claim: ${join(parent, entry)}`,
        );
      }
      const claim = readReleaseClaim(join(parent, entry));
      if (claim.claim.token !== token) {
        throw new LifecycleLockBusyError(
          `Lifecycle release claim token does not match its path: ${claim.path}`,
        );
      }
      return claim;
    })
    .filter((claim) => releaseClaimMatchesDirectory(claim.claim, directory));
  if (claims.length > 1) {
    throw new LifecycleLockBusyError(
      `Multiple lifecycle release claims match the same directory: ${lockPath}`,
    );
  }
  return claims;
}

function publishOwnerLink(
  lockPath: string,
  directory: Stats,
  stage: OwnerStage,
): boolean {
  const ownerPath = join(lockPath, OWNER_FILE);
  try {
    linkSync(stage.path, ownerPath);
  } catch (error) {
    if (errno(error) === "EEXIST" || isMissing(error)) return false;
    throw error;
  }
  const published = readOwnerRecord(ownerPath);
  const currentDirectory = validateDirectory(lockPath, false);
  if (
    !sameOwnerRecord(published, stage) ||
    !sameFile(directory, currentDirectory)
  ) {
    throw new LifecycleLockLostError(
      `Lifecycle lock changed during atomic owner publication: ${lockPath}`,
    );
  }
  fsyncDirectory(lockPath);
  return true;
}

function quarantineInitializationClaim(
  lockPath: string,
  claim: InitializationClaimSnapshot,
): void {
  const token = claim.owner.token;
  const target = join(
    dirname(lockPath),
    `${lockArtifactPrefix(lockPath, INITIALIZATION_QUARANTINE_MARKER)}${token}`,
  );
  try {
    linkSync(claim.path, target);
  } catch (error) {
    if (isMissing(error)) return;
    if (errno(error) !== "EEXIST") throw error;
    const existing = readOwnerRecord(target);
    if (!sameOwnerRecord(existing, claim)) {
      throw new LifecycleLockBusyError(
        `Refusing occupied lifecycle initialization quarantine: ${target}`,
      );
    }
  }
  const quarantined = readOwnerRecord(target);
  if (!sameOwnerRecord(quarantined, claim)) {
    throw new LifecycleLockLostError(
      `Lifecycle initialization claim changed during quarantine: ${claim.path}`,
    );
  }
  const current = readOwnerRecord(claim.path);
  if (!sameOwnerRecord(current, claim)) {
    throw new LifecycleLockLostError(
      `Lifecycle initialization claim changed before quarantine removal: ${claim.path}`,
    );
  }
  unlinkSync(claim.path);
  fsyncDirectory(dirname(lockPath));
}

function removeReleaseClaim(claim: ReleaseClaimSnapshot): void {
  let current: ReleaseClaimSnapshot;
  try {
    current = readReleaseClaim(claim.path);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  if (
    !sameFile(current.file, claim.file) ||
    current.content !== claim.content
  ) {
    throw new LifecycleLockLostError(
      `Refusing to remove a changed lifecycle release claim: ${claim.path}`,
    );
  }
  unlinkSync(claim.path);
  fsyncDirectory(dirname(claim.path));
}

function createLockDirectory(
  options: ResolvedOptions,
  stage: OwnerStage,
): boolean {
  const lockPath = options.lockPath;
  let claimPublished = false;
  try {
    publishInitializationClaim(stage);
    claimPublished = true;

    let directory: Stats;
    let created = false;
    try {
      mkdirSync(lockPath, { mode: DIRECTORY_MODE });
      created = true;
      fsyncDirectory(dirname(lockPath));
      options.afterLockDirectoryCreated?.();
      directory = validateDirectory(lockPath, false);
    } catch (error) {
      if (errno(error) !== "EEXIST") throw error;
      const empty = emptyLockDirectory(lockPath);
      if (empty === null) return false;
      directory = empty;
    }

    const releaseClaims = created
      ? []
      : matchingReleaseClaims(lockPath, directory);
    const claims = initializationClaims(lockPath);
    const ownClaim = claims.find(
      (claim) =>
        claim.path === stage.initializationClaimPath &&
        sameOwnerRecord(claim, stage),
    );
    if (!ownClaim) {
      throw new LifecycleLockLostError(
        `Lifecycle initialization claim disappeared: ${stage.initializationClaimPath}`,
      );
    }
    const deadClaims: InitializationClaimSnapshot[] = [];
    for (const claim of claims) {
      if (claim.path === ownClaim.path) continue;
      if (ownerIsDefinitivelyStale(claim.owner, options)) {
        deadClaims.push(claim);
      } else if (!created && releaseClaims.length === 0) {
        return false;
      }
    }
    if (!created && releaseClaims.length === 0 && deadClaims.length === 0) {
      // A trusted but otherwise unclaimed empty path is ambiguous. Only a
      // dead initializer generation proves this shell is recoverable.
      return false;
    }
    for (const claim of deadClaims) {
      quarantineInitializationClaim(lockPath, claim);
    }
    if (!created) {
      options.afterLockRecoveryValidated?.();
    }

    if (!publishOwnerLink(lockPath, directory, stage)) return false;
    for (const claim of releaseClaims) removeReleaseClaim(claim);
    return true;
  } catch (error) {
    if (error instanceof LifecycleLockBusyError) return false;
    throw error;
  } finally {
    if (claimPublished) {
      removeExpectedOwnerRecord(stage.initializationClaimPath, stage);
    }
  }
}

function ownerIsDefinitivelyStale(
  owner: LifecycleLockOwner,
  options: ResolvedOptions,
): boolean {
  const processState = options.inspectProcess(owner.pid);
  if (processState.state === "dead") return true;
  if (
    processState.state !== "alive" ||
    processState.identity === null ||
    owner.processIdentity.startsWith("unverified:")
  ) {
    return false;
  }
  return processState.identity !== owner.processIdentity;
}

function claimPathFor(lockPath: string, token: string): string {
  return join(dirname(lockPath), `.${basename(lockPath)}.claim.${token}`);
}

function moveToTokenClaim(
  snapshot: LockSnapshot,
  lockPath: string,
): string | null {
  const claimPath = claimPathFor(lockPath, snapshot.owner.token);
  try {
    // On Unix, rename may replace an attacker-created empty directory or
    // symlink. Any pre-existing destination is therefore conservatively busy;
    // legitimate successful claims are deliberately non-empty and persistent.
    lstatSync(claimPath);
    return null;
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  try {
    // The claim directory remains non-empty. If another reclaimer moves the old
    // lock first, any delayed rename of a successor fails because rename cannot
    // replace this non-empty expected-token directory on Unix or Windows.
    renameSync(lockPath, claimPath);
  } catch (error) {
    if (
      isMissing(error) ||
      ["EEXIST", "ENOTEMPTY", "EPERM", "EACCES"].includes(errno(error) ?? "")
    ) {
      return null;
    }
    throw error;
  }

  const claimed = inspectLockPath(claimPath);
  if (
    claimed.owner.token !== snapshot.owner.token ||
    !sameFile(claimed.directory, snapshot.directory) ||
    !sameFile(claimed.ownerFile, snapshot.ownerFile) ||
    claimed.ownerContent !== snapshot.ownerContent
  ) {
    throw new LifecycleLockLostError(
      `Lifecycle lock changed during expected-token quarantine: ${lockPath}`,
    );
  }
  fsyncDirectory(dirname(lockPath));
  return claimPath;
}

function quarantineStaleLock(
  snapshot: LockSnapshot,
  options: ResolvedOptions,
): boolean {
  const initializationClaimPath = join(
    dirname(options.lockPath),
    `${lockArtifactPrefix(options.lockPath, INITIALIZATION_CLAIM_MARKER)}${snapshot.owner.token}`,
  );
  try {
    const initializationClaim = readOwnerRecord(initializationClaimPath);
    if (
      !sameOwnerRecord(initializationClaim, {
        owner: snapshot.owner,
        file: snapshot.ownerFile,
        content: snapshot.ownerContent,
      })
    ) {
      return false;
    }
    quarantineInitializationClaim(options.lockPath, {
      ...initializationClaim,
      path: initializationClaimPath,
    });
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const claimPath = moveToTokenClaim(snapshot, options.lockPath);
  if (!claimPath) return false;
  // Intentionally preserve stale claim directories. They are tiny and make the
  // expected-token rename safe against arbitrarily delayed reclaimers/releases.
  return true;
}

function sameLockSnapshot(left: LockSnapshot, right: LockSnapshot): boolean {
  return (
    sameFile(left.directory, right.directory) &&
    sameFile(left.ownerFile, right.ownerFile) &&
    left.ownerContent === right.ownerContent &&
    left.owner.token === right.owner.token &&
    left.owner.pid === right.owner.pid &&
    left.owner.processIdentity === right.owner.processIdentity
  );
}

function publishReleaseClaim(
  lockPath: string,
  snapshot: LockSnapshot,
): ReleaseClaimSnapshot {
  const claim = releaseClaimFor(snapshot);
  const content = `${JSON.stringify(claim)}\n`;
  const parent = dirname(lockPath);
  const path = join(
    parent,
    `${lockArtifactPrefix(lockPath, RELEASE_CLAIM_MARKER)}${claim.token}`,
  );
  try {
    const existing = readReleaseClaim(path);
    if (existing.content !== content) {
      throw new LifecycleLockLostError(
        `Refusing occupied lifecycle release claim: ${path}`,
      );
    }
    return existing;
  } catch (error) {
    if (!isMissing(error)) throw error;
  }

  const temp = join(
    parent,
    `${lockArtifactPrefix(lockPath, ".release-stage.")}${claim.token}.${randomBytes(8).toString("hex")}.tmp`,
  );
  let fd: number | undefined;
  try {
    fd = openSync(
      temp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
      FILE_MODE,
    );
    const info = fstatSync(fd);
    if (!info.isFile()) {
      throw new Error(`Failed to stage lifecycle release claim: ${temp}`);
    }
    assertCurrentOwner(info, temp);
    if (process.platform !== "win32") fchmodSync(fd, FILE_MODE);
    writeFileSync(fd, content, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    linkSync(temp, path);
    fsyncDirectory(parent);
    const published = readReleaseClaim(path);
    const staged = readReleaseClaim(temp);
    if (
      published.content !== content ||
      !sameFile(published.file, staged.file)
    ) {
      throw new LifecycleLockLostError(
        `Lifecycle release claim changed during publication: ${path}`,
      );
    }
    return published;
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(temp, { force: true });
    fsyncDirectory(parent);
  }
}

class LifecycleLockHandle implements LifecycleLock {
  private released = false;

  constructor(
    readonly path: string,
    readonly owner: LifecycleLockOwner,
    private readonly generation: LockSnapshot,
    private readonly afterOwnerRemoved?: () => void,
  ) {}

  assertOwned(): void {
    if (this.released) {
      throw new LifecycleLockLostError(
        `Lifecycle lock has already been released: ${this.path}`,
      );
    }
    let snapshot: LockSnapshot;
    try {
      snapshot = inspectLockPath(this.path);
    } catch (error) {
      throw new LifecycleLockLostError(
        `Lifecycle lock ownership could not be verified: ${this.path}: ${String(error)}`,
      );
    }
    if (!sameLockSnapshot(snapshot, this.generation)) {
      throw new LifecycleLockLostError(
        `Lifecycle lock is now owned by another operation: ${this.path}`,
      );
    }
  }

  release(): void {
    if (this.released) return;
    this.assertOwned();
    const snapshot = inspectLockPath(this.path);
    if (!sameLockSnapshot(snapshot, this.generation)) {
      throw new LifecycleLockLostError(
        `Refusing to release a successor lifecycle lock: ${this.path}`,
      );
    }

    // Durably bind the impending empty-directory window to this exact directory
    // and owner generation. Recovery accepts that window only while this claim
    // matches the still-empty directory identity.
    const releaseClaim = publishReleaseClaim(this.path, snapshot);
    const finalSnapshot = inspectLockPath(this.path);
    if (!sameLockSnapshot(finalSnapshot, snapshot)) {
      throw new LifecycleLockLostError(
        `Lifecycle lock changed before release: ${this.path}`,
      );
    }
    unlinkSync(join(this.path, OWNER_FILE));
    this.released = true;
    fsyncDirectory(this.path);
    this.afterOwnerRemoved?.();
    let removedDirectory = false;
    try {
      rmdirSync(this.path);
      removedDirectory = true;
    } catch (error) {
      if (
        !isMissing(error) &&
        !["EEXIST", "ENOTEMPTY"].includes(errno(error) ?? "")
      ) {
        throw error;
      }
    }
    if (removedDirectory) fsyncDirectory(dirname(this.path));
    removeReleaseClaim(releaseClaim);
  }
}

/**
 * Acquire the per-user lifecycle lock with bounded contention.
 *
 * Valid live owners are never stolen based on age. Reclamation is limited to
 * definitively dead owners or a live PID whose process-start identity differs.
 * Malformed, untrusted, or unverifiable records remain conservatively busy.
 */
export async function acquireLifecycleLock(
  operation: LifecycleOperation,
  lockOptions: LifecycleLockOptions = {},
): Promise<LifecycleLock> {
  const options = resolveOptions(lockOptions);
  if (
    !Number.isFinite(options.timeoutMs) ||
    options.timeoutMs < 0 ||
    !Number.isFinite(options.retryDelayMs) ||
    options.retryDelayMs <= 0
  ) {
    throw new TypeError(
      "Lifecycle lock timeout and retry delay must be finite",
    );
  }

  ensureLockParent(options.lockPath);
  const createdAtMs = options.now();
  const token = options.createToken();
  const observedIdentity =
    options.processIdentity ?? processIdentity(options.pid);
  const owner: LifecycleLockOwner = {
    version: LOCK_VERSION,
    token,
    pid: options.pid,
    operation,
    createdAt: new Date(createdAtMs).toISOString(),
    processStartedAt:
      options.processStartedAt ??
      new Date(createdAtMs - process.uptime() * 1000).toISOString(),
    processIdentity: observedIdentity ?? `unverified:${token}`,
  };
  if (!validOwner(owner)) {
    throw new TypeError("Invalid lifecycle lock owner identity");
  }
  const ownerStage = createOwnerStage(options.lockPath, owner);
  let ownerStageRemoved = false;

  try {
    const deadline = createdAtMs + options.timeoutMs;
    const packageEvidence = packageInvocationEvidence({
      entryPath: options.packageEntryPath,
      seaBinary: options.seaBinary,
    });
    const observedTombstone = readUninstallTombstoneSnapshot(options.lockPath);
    let lastOwner: LifecycleLockOwner | null = null;
    while (true) {
      if (createLockDirectory(options, ownerStage)) {
        removeExpectedOwnerRecord(ownerStage.path, ownerStage);
        ownerStageRemoved = true;
        const generation = inspectLockPath(options.lockPath);
        const handle = new LifecycleLockHandle(
          options.lockPath,
          owner,
          generation,
          options.afterLockOwnerRemoved,
        );
        try {
          handle.assertOwned();
          const currentTombstone = readUninstallTombstoneSnapshot(
            options.lockPath,
          );
          const packageMayRecover =
            operation !== "uninstall" &&
            operation !== "gateway-shutdown" &&
            operation !== "hosted-install" &&
            packageEvidence !== null &&
            observedTombstone !== null &&
            currentTombstone !== null &&
            observedTombstone.marker.token === currentTombstone.marker.token &&
            observedTombstone.content === currentTombstone.content &&
            sameFile(observedTombstone.file, currentTombstone.file);
          if (packageMayRecover) {
            if (!packageEvidenceStillMatches(packageEvidence)) {
              throw new Error(
                "Package-managed Lore invocation changed before uninstall recovery",
              );
            }
            removeUninstallTombstone(
              handle,
              currentTombstone.marker.token,
              currentTombstone,
            );
          } else if (
            !observationMayProceed(
              operation,
              observedTombstone?.marker ?? null,
              currentTombstone?.marker ?? null,
            )
          ) {
            throw new Error(
              observedTombstone === null
                ? `Refusing stale ${operation} invocation because uninstall completed while it was waiting`
                : `Lore is uninstalled; run a fresh verified install before ${operation}`,
            );
          }
          return handle;
        } catch (error) {
          try {
            handle.release();
          } catch (releaseError) {
            throw new AggregateError(
              [error, releaseError],
              "Lifecycle acquisition failed and its lock could not be released",
            );
          }
          throw error;
        }
      }

      try {
        const snapshot = inspectLockPath(options.lockPath);
        lastOwner = snapshot.owner;
        if (ownerIsDefinitivelyStale(snapshot.owner, options)) {
          if (quarantineStaleLock(snapshot, options)) continue;
        }
      } catch (error) {
        if (isMissing(error)) {
          try {
            // Missing canonical path is an acquisition race: retry immediately.
            // A present, empty directory is recovered only by createLockDirectory
            // when a dead init or matching release generation proves its origin.
            lstatSync(options.lockPath);
          } catch (pathError) {
            if (isMissing(pathError)) continue;
            throw pathError;
          }
        } else if (!(error instanceof LifecycleLockBusyError)) {
          throw error;
        }
        // Malformed/untrusted locks are intentionally false-busy until the
        // bounded contention deadline rather than being guessed stale.
      }

      if (options.now() >= deadline) {
        const detail = lastOwner
          ? ` by pid ${lastOwner.pid} (${lastOwner.operation})`
          : " by an untrusted or malformed owner";
        throw new LifecycleLockBusyError(
          `Lore lifecycle is busy${detail}; retry after the operation completes`,
        );
      }
      await options.sleep(
        Math.min(options.retryDelayMs, Math.max(0, deadline - options.now())),
      );
    }
  } finally {
    if (!ownerStageRemoved) {
      removeExpectedOwnerRecord(ownerStage.initializationClaimPath, ownerStage);
      removeExpectedOwnerRecord(ownerStage.path, ownerStage);
    }
  }
}

/** Run a lifecycle transition under the lock, with async-context reentrancy. */
export async function withLifecycleLock<T>(
  operation: LifecycleOperation,
  action: (lock: LifecycleLock) => Promise<T> | T,
  options: LifecycleLockOptions = {},
): Promise<T> {
  const inherited = lockContext.getStore();
  if (inherited) {
    inherited.assertOwned();
    return action(inherited);
  }

  const lock = await acquireLifecycleLock(operation, options);
  return lockContext.run(lock, async () => {
    try {
      const result = await action(lock);
      if (
        operation === "hosted-install" &&
        readUninstallTombstone(lock.path) !== null
      ) {
        throw new Error(
          "Fresh install did not clear the uninstall marker after verifying its binary/receipt generation",
        );
      }
      return result;
    } finally {
      lock.release();
    }
  });
}
