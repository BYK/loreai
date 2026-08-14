/**
 * `lore uninstall` — reverse persistent setup and remove the standalone CLI.
 *
 * The default preserves the Lore data directory. `--purge` additionally
 * removes the database, logs, and runtime state. Project-owned `.lore.md`,
 * `.lore.json`, and agent instruction files are never searched for or removed.
 */
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  parse,
  posix,
  relative,
  resolve,
  sep,
  win32,
} from "node:path";
import { createInterface } from "node:readline/promises";
import type { GatewayProcessRecord, ProcessFileInspection } from "../pidfile";
import type { PortFileInspection } from "../portfile";
import type { GatewayHealthStatus } from "./start";
import { getConfigDir } from "./lib/binary";
import { createUninstallTombstone, withLifecycleLock } from "../lifecycle-lock";

const INSTALLER_PATH_MARKER = "# Added by lore installer";
const UNINSTALL_USAGE = `Usage: lore uninstall [--purge] [--yes] [--dry-run]

Undo persistent agent setup and remove the standalone Lore CLI.
By default, the database and project files are preserved.

  --purge  Also delete local Lore data, logs, credentials, and runtime state
  --yes    Skip the --purge confirmation prompt
  --dry-run  Show the cleanup plan without changing anything`;

export interface UninstallPlan {
  binaryPath: string | null;
  binaryIdentity: ExecutableIdentity | null;
  manualBinaryPath: string | null;
  manualReceiptPath: string | null;
  receiptPath: string | null;
  receiptIdentity?: InstallReceiptIdentity | null;
  installDir: string | null;
  removals: Array<{ path: string; recursive: boolean }>;
  preservedDataPaths: string[];
  packageManaged: boolean;
}

export interface ExecutableIdentity {
  device: bigint;
  inode: bigint;
  size: bigint;
  mtimeNs: bigint;
  sha256: string;
}

export type InstallReceiptIdentity = ExecutableIdentity;

export interface StandaloneInstallProvenance {
  hostedInstall: boolean;
  receiptPath?: string;
  pathInstallDir?: string;
  executableIdentity?: ExecutableIdentity;
  receiptIdentity?: InstallReceiptIdentity;
}

export interface ParsedInstallReceipt {
  version: "legacy" | 1 | 2 | 3;
  executable: string;
  pathInstallDir?: string;
  executableIdentity?: ExecutableIdentity;
  executableSha256?: string;
}

export interface StagedFileRemoval {
  stageDeletion: () => void;
  assertDeleted: () => void;
  state: () => "expected" | "missing" | "replaced" | "unknown";
  prepareCommit: () => void;
  commit: () => void;
  finalize: () => void;
  rollback: (restore?: boolean) => "restored" | "preserved";
}

export interface StandaloneUpgradeReceiptTransaction {
  refresh: (replacementSha256: string) => void;
  rollback: () => "restored" | "preserved";
  commit: () => void;
}

export interface UpgradePublicationHooks {
  beforeReceiptPublish?: () => void;
  afterReceiptPublish?: () => void;
}

export interface PathBlockRemoval {
  prepareCommit: () => void;
  commit: () => void;
  rollback: (restore?: boolean) => void;
}

export class IrreversibleUninstallError extends AggregateError {
  constructor(errors: Iterable<unknown>) {
    super(
      errors,
      "Uninstall failed after irreversible cleanup began; automatic rollback was not attempted.",
    );
    this.name = "IrreversibleUninstallError";
  }
}

export interface RemovalPathIdentity {
  device: bigint;
  inode: bigint;
  directory: boolean;
}

export interface RemovalPathHooks {
  beforeQuarantine?: () => void;
  afterQuarantine?: () => void;
}

export interface PathBlockRemovalHooks {
  beforeProfileQuarantine?: (path: string) => void;
  beforeProfilePublish?: (path: string) => void;
}

export interface UninstallIO {
  gatewayRunning: () => Promise<boolean>;
  prevalidateSetupUndo: () => void;
  stageSetupUndo: () => PathBlockRemoval | Promise<PathBlockRemoval>;
  removePathBlocks: (
    installDir: string,
    assertInstallRemoved: () => void,
  ) => PathBlockRemoval;
  removePath: (path: string, recursive: boolean) => PathBlockRemoval;
  removeBinary: (
    path: string,
    identity: ExecutableIdentity,
  ) => StagedFileRemoval;
  removeReceipt?: (
    path: string,
    identity: InstallReceiptIdentity,
  ) => StagedFileRemoval;
  recoverReplacementReceipt?: (
    executable: string,
    receiptPath: string,
    pathInstallDir: string,
  ) => void;
  log: (message: string) => void;
  beginUninstall?: () => { rollback: () => void };
}

export interface GatewayRunningIO {
  inspectProcessRecord?: () => ProcessFileInspection;
  readProcessRecord: () => GatewayProcessRecord | null;
  authenticateProcess: (
    record: GatewayProcessRecord,
  ) => Promise<"authenticated" | "rejected" | "unavailable" | "timeout">;
  inspectPort?: () => PortFileInspection;
  readPort: () => number | null;
  probePort: (baseURL: string) => Promise<GatewayHealthStatus>;
}

/** Build a deterministic cleanup plan without touching the filesystem. */
export function planUninstall(input: {
  currentExecutable: string;
  hostedInstall: boolean;
  receiptPath?: string;
  pathInstallDir?: string;
  packageManaged: boolean;
  platform: NodeJS.Platform;
  purge: boolean;
  home: string;
  cwd?: string;
  dataDir: string;
  configDir: string;
  dbPath?: string;
  executableIdentity?: ExecutableIdentity;
  receiptIdentity?: InstallReceiptIdentity;
  packageEntryPath?: string;
  canonicalProtectedPaths?: string[];
}): UninstallPlan {
  const defaultConfigDir = join(input.home, ".lore");
  const defaultDataDir = join(input.home, ".local", "share", "lore");
  const removals: Array<{ path: string; recursive: boolean }> = [
    { path: join(defaultConfigDir, "channel"), recursive: false },
    { path: join(defaultConfigDir, "latest-version"), recursive: false },
    { path: join(defaultConfigDir, "version-check.json"), recursive: false },
    { path: join(defaultConfigDir, "patch-cache"), recursive: true },
    { path: join(defaultConfigDir, "embeddings-vendored"), recursive: true },
    { path: join(input.home, ".cache", "lore"), recursive: true },
  ];
  const dataDirIsDefault = resolve(input.dataDir) === resolve(defaultDataDir);
  const configDirIsDefault =
    resolve(input.configDir) === resolve(defaultConfigDir);
  const verifiedInstall =
    !input.packageManaged &&
    input.hostedInstall &&
    input.receiptPath &&
    input.executableIdentity !== undefined &&
    input.receiptIdentity !== undefined;
  const installReceiptPresent =
    !input.packageManaged && input.hostedInstall && input.receiptPath;
  const binaryPath =
    verifiedInstall &&
    input.platform !== "win32" &&
    input.executableIdentity !== undefined &&
    pathIsInside(input.currentExecutable, input.home)
      ? resolve(input.currentExecutable)
      : null;
  const manualBinaryPath =
    !input.packageManaged && binaryPath === null
      ? resolve(input.currentExecutable)
      : null;
  const externalDbPath =
    input.dbPath &&
    (!isAbsolute(input.dbPath) || !pathIsInside(input.dbPath, defaultDataDir))
      ? input.dbPath
      : null;
  const protectedPaths = [
    ...(!dataDirIsDefault ? [input.dataDir] : []),
    ...(!configDirIsDefault ? [input.configDir] : []),
    ...(externalDbPath
      ? [
          isAbsolute(externalDbPath)
            ? externalDbPath
            : resolve(input.cwd ?? process.cwd(), externalDbPath),
        ]
      : []),
    ...(binaryPath === null ? [input.currentExecutable] : []),
    ...(input.packageManaged && input.packageEntryPath
      ? [input.packageEntryPath]
      : []),
    ...(input.canonicalProtectedPaths ?? []),
  ].map((path) => resolve(path));

  if (input.purge && dataDirIsDefault) {
    removals.push({ path: defaultDataDir, recursive: true });
  }

  const uniqueRemovals = new Map<string, boolean>();
  for (const removal of removals) {
    const path = resolve(removal.path);
    const overlapsProtectedPath = protectedPaths.some(
      (protectedPath) =>
        pathIsInside(path, protectedPath) ||
        (removal.recursive && pathIsInside(protectedPath, path)),
    );
    if (overlapsProtectedPath) continue;
    uniqueRemovals.set(
      path,
      removal.recursive || (uniqueRemovals.get(path) ?? false),
    );
  }

  return {
    binaryPath,
    binaryIdentity:
      binaryPath === null || input.executableIdentity === undefined
        ? null
        : { ...input.executableIdentity },
    manualBinaryPath,
    manualReceiptPath:
      installReceiptPresent && binaryPath === null && input.receiptPath
        ? resolve(input.receiptPath)
        : null,
    receiptPath:
      binaryPath !== null && input.receiptPath
        ? resolve(input.receiptPath)
        : null,
    receiptIdentity:
      binaryPath !== null && input.receiptIdentity !== undefined
        ? { ...input.receiptIdentity }
        : null,
    installDir:
      verifiedInstall && input.pathInstallDir !== undefined
        ? input.pathInstallDir
        : null,
    removals: [...uniqueRemovals].map(([path, recursive]) => ({
      path,
      recursive,
    })),
    preservedDataPaths: [
      ...(!input.purge || !dataDirIsDefault ? [input.dataDir] : []),
      ...(!configDirIsDefault ? [input.configDir] : []),
      ...(externalDbPath ? [externalDbPath] : []),
    ],
    packageManaged: input.packageManaged,
  };
}

function pathIsInside(path: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function syncUninstallDirectory(directory: string): void {
  let descriptor: number | null = null;
  try {
    descriptor = openSync(
      directory,
      constants.O_RDONLY |
        (constants.O_DIRECTORY ?? 0) |
        (constants.O_NOFOLLOW ?? 0),
    );
    fsyncSync(descriptor);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (
      code !== "EINVAL" &&
      code !== "ENOTSUP" &&
      code !== "ENOSYS" &&
      !(
        process.platform === "win32" &&
        (code === "EACCES" || code === "EISDIR" || code === "EPERM")
      )
    ) {
      throw error;
    }
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function syncUninstallFile(path: string, expected: ExecutableIdentity): void {
  let descriptor: number | null = null;
  try {
    const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
    descriptor = openSync(path, constants.O_RDONLY | noFollow);
    const info = fstatSync(descriptor, { bigint: true });
    if (
      !info.isFile() ||
      info.dev !== expected.device ||
      info.ino !== expected.inode ||
      info.size !== expected.size ||
      info.mtimeNs !== expected.mtimeNs
    ) {
      throw new Error(`Uninstall recovery file changed before sync: ${path}`);
    }
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

/** Remove the exact two-line PATH stanza emitted by the hosted installer. */
export function removeInstallerPathBlock(
  content: string,
  installDir: string,
  shell: "posix" | "fish" = "posix",
): string {
  const expected =
    shell === "fish"
      ? [
          `set -gx PATH '${installDir.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}' $PATH`,
          `set -gx PATH "${installDir}" $PATH`,
        ]
      : [
          `export PATH='${installDir.replaceAll("'", `'"'"'`)}':"$PATH"`,
          `export PATH="${installDir}:$PATH"`,
        ];
  const lines = content.split("\n");
  const output: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (
      lines[i] === INSTALLER_PATH_MARKER &&
      expected.includes(lines[i + 1] ?? "")
    ) {
      if (output.at(-1) === "") output.pop();
      i++;
      continue;
    }
    output.push(lines[i]);
  }

  return output.join("\n");
}

/** Execute cleanup in an order that never strands a running gateway. */
export async function runUninstall(
  plan: UninstallPlan,
  io: UninstallIO,
): Promise<number> {
  if (await io.gatewayRunning()) {
    io.log(
      "A gateway may still be running. Run `lore stop`, verify it stopped, then run uninstall again.",
    );
    return 1;
  }

  io.prevalidateSetupUndo();

  let binaryRemoval: StagedFileRemoval | null = null;
  let receiptRemoval: StagedFileRemoval | null = null;
  let pathRemoval: PathBlockRemoval | null = null;
  let setupRemoval: PathBlockRemoval | null = null;
  const stagedPathRemovals: PathBlockRemoval[] = [];
  if (plan.binaryPath) {
    if (!plan.binaryIdentity) {
      throw new Error("Refusing to remove an executable without file identity");
    }
    binaryRemoval = io.removeBinary(plan.binaryPath, plan.binaryIdentity);
  }
  if (plan.receiptPath) {
    if (!plan.receiptIdentity) {
      binaryRemoval?.rollback();
      throw new Error("Refusing to remove an install receipt without identity");
    }
    if (!io.removeReceipt) {
      binaryRemoval?.rollback();
      throw new Error("Install receipt removal is unavailable");
    }
    try {
      receiptRemoval = io.removeReceipt(plan.receiptPath, plan.receiptIdentity);
    } catch (error) {
      binaryRemoval?.rollback();
      throw error;
    }
  }

  const assertInstallRemoved = (): void => {
    binaryRemoval?.assertDeleted();
    receiptRemoval?.assertDeleted();
  };

  let uninstallMarker: { rollback: () => void } | null = null;
  let irreversibleCommitStarted = false;
  try {
    uninstallMarker = plan.binaryPath ? (io.beginUninstall?.() ?? null) : null;
    setupRemoval = await io.stageSetupUndo();
    if (
      binaryRemoval?.state() === "replaced" ||
      receiptRemoval?.state() === "replaced"
    ) {
      throw new Error(
        "Executable or install receipt replaced during uninstall",
      );
    }
    binaryRemoval?.stageDeletion();
    receiptRemoval?.stageDeletion();
    assertInstallRemoved();
    for (const removal of plan.removals) {
      stagedPathRemovals.push(io.removePath(removal.path, removal.recursive));
    }
    if (plan.installDir) {
      pathRemoval = io.removePathBlocks(plan.installDir, assertInstallRemoved);
    }
    assertInstallRemoved();
    setupRemoval.prepareCommit();
    for (const stagedRemoval of stagedPathRemovals) {
      stagedRemoval.prepareCommit();
    }
    pathRemoval?.prepareCommit();
    receiptRemoval?.prepareCommit();
    binaryRemoval?.prepareCommit();
    receiptRemoval?.finalize();
    binaryRemoval?.finalize();

    // No canonical state may be rolled back after this point: recursive
    // deletion can partially succeed before reporting an IO error. Every
    // remaining operation has already validated its exact staged generation.
    irreversibleCommitStarted = true;
    const commitErrors: unknown[] = [];
    const commit = (action: () => void): void => {
      try {
        action();
      } catch (error) {
        commitErrors.push(error);
      }
    };
    for (const stagedRemoval of stagedPathRemovals) {
      commit(() => stagedRemoval.commit());
    }
    commit(() => setupRemoval?.commit());
    commit(() => receiptRemoval?.commit());
    commit(() => binaryRemoval?.commit());
    commit(() => pathRemoval?.commit());
    if (commitErrors.length > 0) {
      throw new IrreversibleUninstallError(commitErrors);
    }
  } catch (error) {
    if (irreversibleCommitStarted) {
      if (error instanceof IrreversibleUninstallError) throw error;
      throw new IrreversibleUninstallError([error]);
    }
    const rollbacks: unknown[] = [];
    const binaryState = binaryRemoval?.state();
    let receiptState = receiptRemoval?.state();
    if (binaryState === "replaced" && receiptState === "expected") {
      try {
        receiptRemoval?.stageDeletion();
        receiptState = receiptRemoval?.state();
      } catch (receiptError) {
        receiptState = receiptRemoval?.state();
        if (receiptState !== "replaced") rollbacks.push(receiptError);
      }
    }
    const states = [binaryState, receiptState].filter(
      (state): state is ReturnType<StagedFileRemoval["state"]> =>
        state !== undefined,
    );
    const identityUnknown = states.includes("unknown");
    const replacementPresent = states.includes("replaced");
    let recoveredReplacementReceipt = false;
    if (
      !identityUnknown &&
      binaryState === "replaced" &&
      receiptState === "missing" &&
      plan.binaryPath &&
      plan.receiptPath &&
      plan.installDir &&
      io.recoverReplacementReceipt
    ) {
      try {
        io.recoverReplacementReceipt(
          plan.binaryPath,
          plan.receiptPath,
          plan.installDir,
        );
        receiptState = receiptRemoval?.state();
        recoveredReplacementReceipt = receiptState === "replaced";
      } catch (recoveryError) {
        rollbacks.push(recoveryError);
      }
    }
    try {
      pathRemoval?.rollback();
    } catch (rollbackError) {
      rollbacks.push(rollbackError);
    }
    for (const stagedRemoval of [...stagedPathRemovals].reverse()) {
      try {
        stagedRemoval.rollback();
      } catch (rollbackError) {
        rollbacks.push(rollbackError);
      }
    }
    if (!identityUnknown) {
      try {
        binaryRemoval?.rollback(!replacementPresent);
      } catch (rollbackError) {
        rollbacks.push(rollbackError);
      }
      try {
        receiptRemoval?.rollback(
          recoveredReplacementReceipt || receiptState === "replaced"
            ? false
            : true,
        );
      } catch (rollbackError) {
        rollbacks.push(rollbackError);
      }
    }
    if (identityUnknown) {
      rollbacks.push(
        new Error(
          "Could not establish the current executable and receipt identity; recovery data was preserved.",
        ),
      );
    }
    try {
      setupRemoval?.rollback();
    } catch (rollbackError) {
      rollbacks.push(rollbackError);
    }
    try {
      uninstallMarker?.rollback();
    } catch (rollbackError) {
      rollbacks.push(rollbackError);
    }
    if (rollbacks.length > 0) {
      throw new AggregateError(
        [error, ...rollbacks],
        "Uninstall failed and the standalone installation could not be restored deterministically.",
      );
    }
    throw error;
  }
  return 0;
}

export async function gatewayRunning(io: GatewayRunningIO): Promise<boolean> {
  const processInspection = io.inspectProcessRecord?.();
  if (processInspection?.state === "invalid") {
    throw new Error(
      `Gateway process discovery evidence is invalid: ${processInspection.reason}. Run \`lore stop\`, inspect runtime records, then retry uninstall.`,
    );
  }
  const record =
    processInspection?.state === "valid"
      ? processInspection.record
      : io.readProcessRecord();
  if (record !== null) {
    const status = await io.authenticateProcess(record);
    if (status === "timeout") {
      throw new Error(
        "Gateway identity check timed out; run `lore stop` and retry uninstall.",
      );
    }
    if (status === "unavailable") {
      throw new Error(
        "Gateway identity check was unavailable; a gateway may still be running. Run `lore stop` and retry uninstall.",
      );
    }
    if (status === "rejected") {
      throw new Error(
        "Gateway identity check was rejected; the recorded gateway identity may have changed or another listener may be running. Run `lore stop`, verify it stopped, then retry uninstall.",
      );
    }
    return true;
  }

  const portInspection = io.inspectPort?.();
  if (portInspection?.state === "invalid") {
    throw new Error(
      `Gateway port discovery evidence is invalid: ${portInspection.reason}. Run \`lore stop\`, inspect runtime records, then retry uninstall.`,
    );
  }
  const port =
    portInspection?.state === "valid"
      ? portInspection.record.port
      : io.readPort();
  if (port === null) return false;
  switch (await io.probePort(`http://127.0.0.1:${port}`)) {
    case "healthy":
      return true;
    case "not-running":
      return false;
    case "timeout":
      throw new Error(
        "Gateway health check timed out; a gateway may still be running. Run `lore stop` and retry uninstall.",
      );
    case "error":
      throw new Error(
        "Gateway health check failed; could not safely determine whether a gateway is running. Run `lore stop` and retry uninstall.",
      );
  }
}

function isSeaBinary(): boolean {
  try {
    const sea = require("node:sea") as { isSea?: () => boolean };
    return typeof sea.isSea === "function" ? sea.isSea() : false;
  } catch {
    return false;
  }
}

function resolvedDataDir(): string {
  const base = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(base, "lore");
}

function canonicalPath(path: string): string | null {
  try {
    return realpathSync.native(path);
  } catch {
    return null;
  }
}

export function standaloneInstallProvenance(
  executable: string,
  options: {
    seaBinary?: boolean;
    home?: string;
    uid?: number;
    platform?: NodeJS.Platform;
  } = {},
): StandaloneInstallProvenance {
  if (!(options.seaBinary ?? isSeaBinary())) return { hostedInstall: false };
  const home = options.home ?? homedir();
  const uid = options.uid ?? process.getuid?.();
  const platform = options.platform ?? process.platform;
  const statePath = join(home, ".lore", "install-path");

  try {
    const state = lstatSync(statePath);
    if (!state.isFile() || state.isSymbolicLink()) {
      return { hostedInstall: false };
    }
    if (uid !== undefined && state.uid !== uid) return { hostedInstall: false };
    const canonicalHome = realpathSync.native(home);
    const canonicalParent = realpathSync.native(dirname(statePath));
    const expectedCanonicalParent = join(canonicalHome, ".lore");
    if (canonicalParent !== expectedCanonicalParent) {
      return { hostedInstall: false };
    }
    const parent = lstatSync(canonicalParent);
    if (
      !parent.isDirectory() ||
      parent.isSymbolicLink() ||
      (uid !== undefined && parent.uid !== uid) ||
      (platform !== "win32" && (parent.mode & 0o022) !== 0)
    ) {
      return { hostedInstall: false };
    }

    const capturedReceipt = captureFile(statePath, uid);
    if (capturedReceipt === null) return { hostedInstall: false };
    const receipt = parseInstallReceipt(
      capturedReceipt.content.toString("utf8"),
    );
    if (
      receipt === null ||
      !executablePathsMatch(receipt.executable, executable, platform)
    ) {
      return { hostedInstall: false };
    }
    const capturedExecutable = captureFile(executable, uid);
    if (
      capturedExecutable === null ||
      !receiptMatchesExecutable(
        receipt,
        capturedExecutable,
        executable,
        platform,
      ) ||
      !fileStillMatches(statePath, capturedReceipt) ||
      !fileStillMatches(executable, capturedExecutable)
    ) {
      return { hostedInstall: false };
    }
    return {
      hostedInstall: true,
      receiptPath: statePath,
      receiptIdentity: fileIdentity(capturedReceipt),
      pathInstallDir: receipt.pathInstallDir,
      executableIdentity: fileIdentity(capturedExecutable),
    };
  } catch {
    return { hostedInstall: false };
  }
}

function receiptMatchesExecutable(
  receipt: ParsedInstallReceipt,
  executable: CapturedFile,
  executablePath: string,
  platform: NodeJS.Platform,
): receipt is ParsedInstallReceipt & { pathInstallDir: string } {
  if (
    receipt.pathInstallDir === undefined ||
    !executablePathsMatch(receipt.executable, executablePath, platform)
  ) {
    return false;
  }
  if (
    platform !== "win32" &&
    resolve(receipt.pathInstallDir) !== dirname(resolve(executablePath))
  ) {
    return false;
  }
  if (receipt.version === 2) {
    return receipt.executableSha256 === executable.sha256;
  }
  if (receipt.version !== 3 || receipt.executableIdentity === undefined) {
    return false;
  }
  return identitiesEqual(receipt.executableIdentity, executable);
}

function identitiesEqual(
  expected: ExecutableIdentity,
  actual: ExecutableIdentity,
): boolean {
  return (
    expected.device === actual.device &&
    expected.inode === actual.inode &&
    expected.size === actual.size &&
    expected.mtimeNs === actual.mtimeNs &&
    expected.sha256 === actual.sha256
  );
}

export function formatStandaloneInstallReceipt(input: {
  executable: string;
  pathInstallDir: string;
  executableIdentity: ExecutableIdentity;
  platform?: NodeJS.Platform;
}): string {
  const platform = input.platform ?? process.platform;
  const pathApi = platform === "win32" ? win32 : posix;
  if (
    !pathApi.isAbsolute(input.executable) ||
    !posix.isAbsolute(input.pathInstallDir) ||
    input.executable.includes("\n") ||
    input.executable.includes("\r") ||
    input.pathInstallDir.includes("\n") ||
    input.pathInstallDir.includes("\r") ||
    !/^[a-f0-9]{64}$/.test(input.executableIdentity.sha256) ||
    input.executableIdentity.device < 0n ||
    input.executableIdentity.inode < 0n ||
    input.executableIdentity.size < 0n ||
    input.executableIdentity.mtimeNs < 0n ||
    input.executableIdentity.device === 0n ||
    input.executableIdentity.inode === 0n ||
    (platform !== "win32" &&
      resolve(input.pathInstallDir) !== dirname(resolve(input.executable)))
  ) {
    throw new Error("Refusing invalid standalone install receipt fields");
  }
  return [
    "lore-install-receipt-v3",
    `executable=${input.executable}`,
    `path-install-dir=${input.pathInstallDir}`,
    `sha256=${input.executableIdentity.sha256}`,
    `device=${input.executableIdentity.device}`,
    `inode=${input.executableIdentity.inode}`,
    `size=${input.executableIdentity.size}`,
    `mtime-ns=${input.executableIdentity.mtimeNs}`,
    "",
  ].join("\n");
}

export function refreshStandaloneInstallReceipt(input: {
  executable: string;
  executableSha256: string;
  receiptPath: string;
  receiptIdentity: InstallReceiptIdentity;
  pathInstallDir: string;
  home?: string;
  uid?: number;
  hooks?: UpgradePublicationHooks;
}): void {
  const home = input.home ?? homedir();
  const uid = input.uid ?? process.getuid?.();
  const canonicalHome = realpathSync.native(home);
  const canonicalParent = realpathSync.native(dirname(input.receiptPath));
  if (canonicalParent !== join(canonicalHome, ".lore")) {
    throw new Error(
      `Refusing installer receipt outside the trusted state directory: ${input.receiptPath}`,
    );
  }
  assertFileIdentity(
    input.receiptPath,
    input.receiptIdentity,
    home,
    "Install receipt",
  );
  const executable = captureFile(input.executable, uid);
  if (executable === null || executable.sha256 !== input.executableSha256) {
    throw new Error(
      `Upgraded executable changed before receipt commit: ${input.executable}`,
    );
  }
  const content = formatStandaloneInstallReceipt({
    executable: input.executable,
    pathInstallDir: input.pathInstallDir,
    executableIdentity: executable,
  });
  const temp = join(
    dirname(input.receiptPath),
    `.${basename(input.receiptPath)}.upgrade-${process.pid}-${randomBytes(8).toString("hex")}`,
  );
  try {
    writeFileSync(temp, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    assertFileIdentity(
      input.receiptPath,
      input.receiptIdentity,
      home,
      "Install receipt",
    );
    assertFileIdentity(input.executable, executable, home);
    const claim = `${input.receiptPath}.upgrade-displaced-${process.pid}-${randomBytes(8).toString("hex")}`;
    renameSync(input.receiptPath, claim);
    try {
      assertFileIdentity(claim, input.receiptIdentity, home, "Install receipt");
      input.hooks?.beforeReceiptPublish?.();
      linkSync(temp, input.receiptPath);
    } catch (error) {
      try {
        if (!existsSync(input.receiptPath)) linkSync(claim, input.receiptPath);
      } catch {
        // Preserve the displaced receipt for recovery.
      }
      throw error;
    }
    input.hooks?.afterReceiptPublish?.();
    const refreshed = captureFile(input.receiptPath, uid);
    if (
      refreshed === null ||
      parseInstallReceipt(refreshed.content.toString("utf8"))?.version !== 3 ||
      !fileStillMatches(input.executable, executable)
    ) {
      throw new Error(
        `Install receipt or executable changed during receipt commit: ${input.receiptPath}`,
      );
    }
    rmSync(claim, { force: true });
  } finally {
    rmSync(temp, { force: true });
  }
}

export function stageStandaloneUpgradeReceipt(input: {
  executable: string;
  receiptPath: string;
  receiptIdentity: InstallReceiptIdentity;
  executableIdentity: ExecutableIdentity;
  pathInstallDir: string;
  home?: string;
  uid?: number;
  hooks?: UpgradePublicationHooks;
}): StandaloneUpgradeReceiptTransaction {
  const home = input.home ?? homedir();
  const uid = input.uid ?? process.getuid?.();
  assertFileIdentity(input.executable, input.executableIdentity, home);
  assertFileIdentity(
    input.receiptPath,
    input.receiptIdentity,
    home,
    "Install receipt",
  );

  const token = `${process.pid}-${randomBytes(8).toString("hex")}`;
  const executableBackup = join(
    dirname(input.executable),
    `.${basename(input.executable)}.upgrade-backup-${token}`,
  );
  const receiptBackup = join(
    dirname(input.receiptPath),
    `.${basename(input.receiptPath)}.upgrade-backup-${token}`,
  );
  try {
    linkSync(input.executable, executableBackup);
    linkSync(input.receiptPath, receiptBackup);
    assertFileIdentity(executableBackup, input.executableIdentity, home);
    assertFileIdentity(
      receiptBackup,
      input.receiptIdentity,
      home,
      "Install receipt",
    );
  } catch (error) {
    rmSync(executableBackup, { force: true });
    rmSync(receiptBackup, { force: true });
    throw error;
  }

  let active = true;
  let replacement: CapturedFile | null = null;
  let replacementReceipt: CapturedFile | null = null;
  const cleanup = (): void => {
    rmSync(executableBackup, { force: true });
    rmSync(receiptBackup, { force: true });
    active = false;
  };
  const preserveCoherentGeneration = (): boolean => {
    const currentExecutable = captureFile(input.executable, uid);
    const currentReceipt = captureFile(input.receiptPath, uid);
    if (currentExecutable === null || currentReceipt === null) return false;
    const parsed = parseInstallReceipt(currentReceipt.content.toString("utf8"));
    return (
      parsed !== null &&
      receiptMatchesExecutable(
        parsed,
        currentExecutable,
        input.executable,
        process.platform,
      )
    );
  };
  const captureReplacement = (sha256: string): CapturedFile => {
    const captured = captureFile(input.executable, uid);
    if (
      captured === null ||
      captured.sha256 !== sha256 ||
      (captured.device === input.executableIdentity.device &&
        captured.inode === input.executableIdentity.inode)
    ) {
      throw new Error(
        `Upgraded executable identity is invalid: ${input.executable}`,
      );
    }
    replacement = captured;
    return captured;
  };

  return {
    refresh: (replacementSha256) => {
      if (!active) throw new Error("Standalone upgrade transaction is closed");
      captureReplacement(replacementSha256);
      refreshStandaloneInstallReceipt({
        executable: input.executable,
        executableSha256: replacementSha256,
        receiptPath: input.receiptPath,
        receiptIdentity: input.receiptIdentity,
        pathInstallDir: input.pathInstallDir,
        home,
        uid,
        hooks: input.hooks,
      });
      const refreshed = captureFile(input.receiptPath, uid);
      if (refreshed === null) {
        throw new Error(
          `Could not capture refreshed install receipt: ${input.receiptPath}`,
        );
      }
      replacementReceipt = refreshed;
    },
    rollback: () => {
      if (!active) return "preserved";
      const currentExecutable = captureFile(input.executable, uid);
      const currentReceipt = captureFile(input.receiptPath, uid);
      if (currentExecutable === null || currentReceipt === null) {
        if (preserveCoherentGeneration()) {
          cleanup();
          return "preserved";
        }
        throw new Error(
          "Could not establish executable and receipt identity during upgrade rollback; recovery links were preserved.",
        );
      }
      const oldExecutable = identitiesEqual(
        currentExecutable,
        input.executableIdentity,
      );
      const oldReceipt = identitiesEqual(currentReceipt, input.receiptIdentity);
      const replacementExecutable =
        replacement !== null && identitiesEqual(currentExecutable, replacement);
      const parsedReceipt = parseInstallReceipt(
        currentReceipt.content.toString("utf8"),
      );
      const coherentCurrentReceipt =
        parsedReceipt !== null &&
        receiptMatchesExecutable(
          parsedReceipt,
          currentExecutable,
          input.executable,
          process.platform,
        );
      const coherentReplacementReceipt =
        replacement !== null &&
        parsedReceipt !== null &&
        replacementReceipt !== null &&
        identitiesEqual(currentReceipt, replacementReceipt) &&
        receiptMatchesExecutable(
          parsedReceipt,
          replacement,
          input.executable,
          process.platform,
        );
      if (oldExecutable && oldReceipt) {
        cleanup();
        return "restored";
      }
      if (!replacementExecutable) {
        if (coherentCurrentReceipt) {
          cleanup();
          return "preserved";
        }
        if (
          replacementReceipt !== null &&
          identitiesEqual(currentReceipt, replacementReceipt)
        ) {
          refreshStandaloneInstallReceipt({
            executable: input.executable,
            executableSha256: currentExecutable.sha256,
            receiptPath: input.receiptPath,
            receiptIdentity: currentReceipt,
            pathInstallDir: input.pathInstallDir,
            home,
            uid,
          });
          cleanup();
          return "preserved";
        }
        throw new Error(
          "Executable changed during upgrade rollback; recovery links were preserved.",
        );
      }
      if (!oldReceipt && !coherentReplacementReceipt) {
        throw new Error(
          "Install receipt changed during upgrade rollback; recovery links were preserved.",
        );
      }
      if (replacement === null) {
        throw new Error(
          "Replacement executable identity was lost during upgrade rollback.",
        );
      }
      assertFileIdentity(input.executable, replacement, home);
      assertFileIdentity(
        input.receiptPath,
        oldReceipt ? input.receiptIdentity : currentReceipt,
        home,
        "Install receipt",
      );
      renameSync(executableBackup, input.executable);
      try {
        if (coherentReplacementReceipt) {
          assertFileIdentity(
            input.receiptPath,
            currentReceipt,
            home,
            "Install receipt",
          );
          renameSync(receiptBackup, input.receiptPath);
        }
        assertFileIdentity(input.executable, input.executableIdentity, home);
        assertFileIdentity(
          input.receiptPath,
          input.receiptIdentity,
          home,
          "Install receipt",
        );
      } catch (error) {
        throw new Error(
          `Standalone upgrade rollback did not restore a coherent generation: ${String(error)}`,
          { cause: error },
        );
      }
      cleanup();
      return "restored";
    },
    commit: () => {
      if (!active) return;
      if (replacement === null) {
        throw new Error("Standalone receipt was not refreshed");
      }
      const currentExecutable = captureFile(input.executable, uid);
      const currentReceipt = captureFile(input.receiptPath, uid);
      const parsedReceipt =
        currentReceipt === null
          ? null
          : parseInstallReceipt(currentReceipt.content.toString("utf8"));
      if (
        currentExecutable === null ||
        currentReceipt === null ||
        !identitiesEqual(currentExecutable, replacement) ||
        parsedReceipt === null ||
        !receiptMatchesExecutable(
          parsedReceipt,
          currentExecutable,
          input.executable,
          process.platform,
        )
      ) {
        throw new Error(
          "Standalone executable or receipt changed before upgrade commit",
        );
      }
      cleanup();
    },
  };
}

export function recoverReplacementInstallReceipt(
  executablePath: string,
  receiptPath: string,
  pathInstallDir: string,
  home: string = homedir(),
  uid: number | undefined = process.getuid?.(),
): void {
  const canonicalHome = realpathSync.native(home);
  if (
    realpathSync.native(dirname(receiptPath)) !== join(canonicalHome, ".lore")
  ) {
    throw new Error(
      `Refusing installer receipt outside the trusted state directory: ${receiptPath}`,
    );
  }
  const executable = captureFile(executablePath, uid);
  if (executable === null) {
    throw new Error(
      `Could not establish replacement executable identity: ${executablePath}`,
    );
  }
  if (!fileStillMatches(executablePath, executable)) {
    throw new Error(
      `Replacement executable changed before receipt recovery: ${executablePath}`,
    );
  }
  const content = formatStandaloneInstallReceipt({
    executable: executablePath,
    pathInstallDir,
    executableIdentity: executable,
  });
  const temp = join(
    dirname(receiptPath),
    `.${basename(receiptPath)}.recovery-${process.pid}-${randomBytes(8).toString("hex")}`,
  );
  let linked = false;
  try {
    writeFileSync(temp, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    try {
      linkSync(temp, receiptPath);
      linked = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (linked) {
      const linkedReceipt = captureFile(receiptPath, uid);
      if (
        linkedReceipt === null ||
        linkedReceipt.sha256 !==
          createHash("sha256").update(content).digest("hex")
      ) {
        throw new Error(
          `Install receipt changed during replacement recovery: ${receiptPath}`,
        );
      }
    }
    if (!fileStillMatches(executablePath, executable)) {
      if (linked) {
        const generatedReceipt = captureFile(receiptPath, uid);
        if (generatedReceipt !== null) {
          assertFileIdentity(
            receiptPath,
            generatedReceipt,
            home,
            "Install receipt",
          );
          unlinkSync(receiptPath);
        }
      }
      throw new Error(
        `Replacement executable changed during receipt recovery: ${executablePath}`,
      );
    }
    const receipt = captureFile(receiptPath, uid);
    const parsed =
      receipt === null
        ? null
        : parseInstallReceipt(receipt.content.toString("utf8"));
    if (
      parsed === null ||
      !receiptMatchesExecutable(
        parsed,
        executable,
        executablePath,
        process.platform,
      )
    ) {
      throw new Error(
        `A concurrent install receipt does not match the live executable: ${receiptPath}`,
      );
    }
  } finally {
    rmSync(temp, { force: true });
  }
}

interface CapturedFile extends InstallReceiptIdentity {
  content: Buffer;
}

function captureFile(
  path: string,
  uid: number | undefined,
): CapturedFile | null {
  let fd: number | null = null;
  try {
    const initial = lstatSync(path, { bigint: true });
    if (!initial.isFile() || initial.isSymbolicLink()) return null;
    const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
    fd = openSync(path, constants.O_RDONLY | noFollow);
    const info = fstatSync(fd, { bigint: true });
    if (!info.isFile() || info.isSymbolicLink()) return null;
    if (uid !== undefined && info.uid !== BigInt(uid)) return null;
    if (initial.dev !== info.dev || initial.ino !== info.ino) return null;
    const content = readFileSync(fd);
    const final = fstatSync(fd, { bigint: true });
    if (
      info.dev !== final.dev ||
      info.ino !== final.ino ||
      info.size !== final.size ||
      info.mtimeNs !== final.mtimeNs
    ) {
      return null;
    }
    return {
      device: info.dev,
      inode: info.ino,
      size: info.size,
      mtimeNs: info.mtimeNs,
      sha256: createHash("sha256").update(content).digest("hex"),
      content,
    };
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function fileIdentity(file: CapturedFile): InstallReceiptIdentity {
  return {
    device: file.device,
    inode: file.inode,
    size: file.size,
    mtimeNs: file.mtimeNs,
    sha256: file.sha256,
  };
}

function fileStillMatches(
  path: string,
  expected: InstallReceiptIdentity,
): boolean {
  try {
    const info = lstatSync(path, { bigint: true });
    return (
      info.isFile() &&
      !info.isSymbolicLink() &&
      info.dev === expected.device &&
      info.ino === expected.inode &&
      info.size === expected.size &&
      info.mtimeNs === expected.mtimeNs
    );
  } catch {
    return false;
  }
}

export function parseInstallReceipt(
  content: string,
): ParsedInstallReceipt | null {
  if (!content.includes("\n") && !content.includes("\r")) {
    return content.length > 0
      ? { version: "legacy", executable: content }
      : null;
  }

  const lines = content.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const version = lines[0];
  if (
    version !== "lore-install-receipt-v1" &&
    version !== "lore-install-receipt-v2" &&
    version !== "lore-install-receipt-v3"
  ) {
    return null;
  }
  const expectedLines =
    version === "lore-install-receipt-v3"
      ? 8
      : version === "lore-install-receipt-v2"
        ? 4
        : 3;
  if (
    lines.length !== expectedLines ||
    !lines[1]?.startsWith("executable=") ||
    !lines[2]?.startsWith("path-install-dir=") ||
    (version !== "lore-install-receipt-v1" &&
      !lines[3]?.startsWith("sha256=")) ||
    (version === "lore-install-receipt-v3" &&
      (!lines[4]?.startsWith("device=") ||
        !lines[5]?.startsWith("inode=") ||
        !lines[6]?.startsWith("size=") ||
        !lines[7]?.startsWith("mtime-ns=")))
  ) {
    return null;
  }
  const executable = lines[1].slice("executable=".length);
  const pathInstallDir = lines[2].slice("path-install-dir=".length);
  const executableSha256 =
    version !== "lore-install-receipt-v1"
      ? lines[3].slice("sha256=".length)
      : undefined;
  if (
    executable.length === 0 ||
    !posix.isAbsolute(pathInstallDir) ||
    executable.includes("\r") ||
    pathInstallDir.includes("\r") ||
    (executableSha256 !== undefined && !/^[a-f0-9]{64}$/.test(executableSha256))
  ) {
    return null;
  }
  if (version === "lore-install-receipt-v1") {
    return { version: 1, executable, pathInstallDir };
  }
  if (version === "lore-install-receipt-v2") {
    return { version: 2, executable, pathInstallDir, executableSha256 };
  }
  if (executableSha256 === undefined) return null;
  const identityValues = [
    lines[4].slice("device=".length),
    lines[5].slice("inode=".length),
    lines[6].slice("size=".length),
    lines[7].slice("mtime-ns=".length),
  ];
  if (identityValues.some((value) => !/^\d+$/.test(value))) return null;
  const [device, inode, size, mtimeNs] = identityValues.map(BigInt) as [
    bigint,
    bigint,
    bigint,
    bigint,
  ];
  return {
    version: 3,
    executable,
    pathInstallDir,
    executableSha256,
    executableIdentity: {
      device,
      inode,
      size,
      mtimeNs,
      sha256: executableSha256,
    },
  };
}

function executablePathsMatch(
  recorded: string,
  current: string,
  platform: NodeJS.Platform,
): boolean {
  const pathApi = platform === "win32" ? win32 : posix;
  if (!pathApi.isAbsolute(recorded) || !pathApi.isAbsolute(current))
    return false;
  const recordedPath = pathApi.resolve(recorded);
  const currentPath = pathApi.resolve(current);
  return platform === "win32"
    ? recordedPath.toLowerCase() === currentPath.toLowerCase()
    : recordedPath === currentPath;
}

function shellConfigPaths(home: string): Array<{
  path: string;
  shell: "posix" | "fish";
}> {
  return [
    { path: join(home, ".zshrc"), shell: "posix" },
    { path: join(home, ".bash_profile"), shell: "posix" },
    { path: join(home, ".bashrc"), shell: "posix" },
    { path: join(home, ".profile"), shell: "posix" },
    { path: join(home, ".config", "fish", "config.fish"), shell: "fish" },
  ];
}

export function removePathBlocks(
  installDir: string,
  assertInstallRemoved: () => void,
  homeDirectory: string = homedir(),
  hooks: PathBlockRemovalHooks = {},
): PathBlockRemoval {
  const canonicalHome = realpathSync.native(homeDirectory);
  interface ProfileBackup {
    path: string;
    originalClaim: string;
    afterClaim: string;
    journalPath: string;
    journal: CapturedFile;
    before: ExecutableIdentity;
    after: ExecutableIdentity;
  }
  interface ProfileJournal {
    version: 1;
    token: string;
    profile: string;
    before: {
      device: string;
      inode: string;
      size: string;
      mtimeNs: string;
      sha256: string;
    };
    after: {
      device: string;
      inode: string;
      size: string;
      mtimeNs: string;
      sha256: string;
    };
  }
  const backups: ProfileBackup[] = [];
  const successorRecoveries: Array<{
    backup: ProfileBackup;
    successor: CapturedFile;
  }> = [];
  const recoveredSuccessorPaths = new Set<string>();
  const uid = process.getuid?.();
  const encodeIdentity = (identity: ExecutableIdentity) => ({
    device: identity.device.toString(),
    inode: identity.inode.toString(),
    size: identity.size.toString(),
    mtimeNs: identity.mtimeNs.toString(),
    sha256: identity.sha256,
  });
  const parseIdentity = (value: unknown): ExecutableIdentity | null => {
    if (typeof value !== "object" || value === null) return null;
    const record = value as Record<string, unknown>;
    if (
      typeof record.device !== "string" ||
      typeof record.inode !== "string" ||
      typeof record.size !== "string" ||
      typeof record.mtimeNs !== "string" ||
      typeof record.sha256 !== "string" ||
      !/^\d+$/.test(record.device) ||
      !/^\d+$/.test(record.inode) ||
      !/^\d+$/.test(record.size) ||
      !/^\d+$/.test(record.mtimeNs) ||
      !/^[a-f0-9]{64}$/.test(record.sha256)
    ) {
      return null;
    }
    return {
      device: BigInt(record.device),
      inode: BigInt(record.inode),
      size: BigInt(record.size),
      mtimeNs: BigInt(record.mtimeNs),
      sha256: record.sha256,
    };
  };
  const captureProfile = (path: string): CapturedFile | null => {
    assertSafeRemovalPath(path, homeDirectory);
    try {
      const info = lstatSync(path);
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new Error(`Refusing unsafe shell profile recovery path: ${path}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const captured = captureFile(path, uid);
    if (captured === null) {
      throw new Error(`Shell profile changed during uninstall: ${path}`);
    }
    return captured;
  };
  const assertProfileIdentity = (
    path: string,
    expected: ExecutableIdentity,
    phase: "uninstall" | "uninstall rollback",
  ): void => {
    assertSafeRemovalPath(path, homeDirectory);
    const current = captureFile(path, uid);
    if (current === null || !identitiesEqual(current, expected)) {
      throw new Error(`Shell profile changed during ${phase}: ${path}`);
    }
  };
  const removeProfileRecoveryFile = (
    path: string,
    expected: ExecutableIdentity,
  ): void => {
    assertProfileIdentity(path, expected, "uninstall");
    const deleting = `${path}.deleting-${process.pid}-${randomBytes(8).toString("hex")}`;
    renameSync(path, deleting);
    assertProfileIdentity(deleting, expected, "uninstall");
    syncUninstallDirectory(dirname(path));
    unlinkSync(deleting);
    syncUninstallDirectory(dirname(path));
  };
  const cleanupProfileRecovery = (
    backup: ProfileBackup,
    options: { original?: boolean; after?: boolean } = {},
  ): void => {
    if (options.after !== false && existsSync(backup.afterClaim)) {
      removeProfileRecoveryFile(backup.afterClaim, backup.after);
    }
    if (options.original !== false && existsSync(backup.originalClaim)) {
      removeProfileRecoveryFile(backup.originalClaim, backup.before);
    }
    removeProfileRecoveryFile(backup.journalPath, backup.journal);
  };
  const assertProfileRecovery = (backup: ProfileBackup): void => {
    if (existsSync(backup.afterClaim)) {
      assertProfileIdentity(backup.afterClaim, backup.after, "uninstall");
    }
    if (existsSync(backup.originalClaim)) {
      assertProfileIdentity(backup.originalClaim, backup.before, "uninstall");
    }
    assertProfileIdentity(backup.journalPath, backup.journal, "uninstall");
  };
  const recoverProfile = (config: {
    path: string;
    shell: "posix" | "fish";
  }): void => {
    const parent = dirname(config.path);
    if (!existsSync(parent)) return;
    const profileName = basename(config.path);
    const journalPrefix = `${profileName}.lore-uninstall-profile-`;
    const originalPrefix = `${profileName}.lore-uninstall-original-`;
    const afterPrefix = `${profileName}.lore-uninstall-`;
    const entries = readdirSync(parent);
    const journals = entries.filter((name) => name.startsWith(journalPrefix));
    const rawClaims = entries.filter(
      (name) =>
        name.startsWith(originalPrefix) ||
        (name.startsWith(afterPrefix) &&
          !name.startsWith(journalPrefix) &&
          !name.startsWith(`${profileName}.lore-uninstall-rollback-`)),
    );
    if (journals.length === 0) {
      if (rawClaims.length > 0) {
        throw new Error(
          `Shell profile recovery metadata is missing for: ${config.path}`,
        );
      }
      return;
    }
    if (journals.length !== 1) {
      throw new Error(
        `Multiple shell profile recovery generations exist for: ${config.path}`,
      );
    }

    const journalPath = join(parent, journals[0]);
    const journalFile = captureProfile(journalPath);
    if (journalFile === null) {
      throw new Error(
        `Shell profile recovery journal vanished: ${journalPath}`,
      );
    }
    let value: unknown;
    try {
      value = JSON.parse(journalFile.content.toString("utf8"));
    } catch (error) {
      throw new Error(
        `Invalid shell profile recovery journal: ${journalPath}`,
        {
          cause: error,
        },
      );
    }
    if (typeof value !== "object" || value === null) {
      throw new Error(`Invalid shell profile recovery journal: ${journalPath}`);
    }
    const record = value as Record<string, unknown>;
    const token = record.token;
    const beforeIdentity = parseIdentity(record.before);
    const afterIdentity = parseIdentity(record.after);
    if (
      record.version !== 1 ||
      typeof token !== "string" ||
      !/^\d+-[a-f0-9]{16}$/.test(token) ||
      record.profile !== config.path ||
      (journals[0] !== `${journalPrefix}${token}.json` &&
        !(
          journals[0].startsWith(`${journalPrefix}${token}.json.deleting-`) &&
          /^\d+-[a-f0-9]{16}$/.test(
            journals[0].slice(`${journalPrefix}${token}.json.deleting-`.length),
          )
        )) ||
      beforeIdentity === null ||
      afterIdentity === null
    ) {
      throw new Error(`Invalid shell profile recovery journal: ${journalPath}`);
    }
    const originalBase = `${profileName}.lore-uninstall-original-${token}`;
    const afterBase = `${profileName}.lore-uninstall-${token}`;
    const matchesClaim = (name: string, base: string): boolean =>
      name === base ||
      (name.startsWith(`${base}.deleting-`) &&
        /^\d+-[a-f0-9]{16}$/.test(name.slice(`${base}.deleting-`.length)));
    const originalClaims = rawClaims.filter((name) =>
      matchesClaim(name, originalBase),
    );
    const afterClaims = rawClaims.filter((name) =>
      matchesClaim(name, afterBase),
    );
    if (
      originalClaims.length > 1 ||
      afterClaims.length > 1 ||
      rawClaims.some(
        (name) =>
          !matchesClaim(name, originalBase) && !matchesClaim(name, afterBase),
      )
    ) {
      throw new Error(
        `Multiple shell profile recovery generations exist for: ${config.path}`,
      );
    }
    const originalClaim = join(parent, originalClaims[0] ?? originalBase);
    const afterClaim = join(parent, afterClaims[0] ?? afterBase);
    const original = captureProfile(originalClaim);
    const stagedAfter = captureProfile(afterClaim);
    const current = captureProfile(config.path);
    if (original && !identitiesEqual(original, beforeIdentity)) {
      throw new Error(
        `Shell profile recovery generation changed: ${originalClaim}`,
      );
    }
    if (stagedAfter && !identitiesEqual(stagedAfter, afterIdentity)) {
      throw new Error(
        `Shell profile recovery generation changed: ${afterClaim}`,
      );
    }
    if (original) {
      const expectedAfter = removeInstallerPathBlock(
        original.content.toString("utf8"),
        installDir,
        config.shell,
      );
      if (
        (stagedAfter &&
          stagedAfter.content.toString("utf8") !== expectedAfter) ||
        (current &&
          identitiesEqual(current, afterIdentity) &&
          current.content.toString("utf8") !== expectedAfter)
      ) {
        throw new Error(
          `Shell profile recovery content is inconsistent: ${config.path}`,
        );
      }
    }
    const recovery: ProfileBackup = {
      path: config.path,
      originalClaim,
      afterClaim,
      journalPath,
      journal: journalFile,
      before: beforeIdentity,
      after: afterIdentity,
    };

    assertInstallRemoved();
    if (current && identitiesEqual(current, beforeIdentity)) {
      cleanupProfileRecovery(recovery);
      return;
    }
    if (current && identitiesEqual(current, afterIdentity)) {
      if (original) {
        recovery.before = original;
        recovery.after = current;
        backups.push(recovery);
      } else {
        cleanupProfileRecovery(recovery, { original: false });
      }
      return;
    }
    if (current) {
      successorRecoveries.push({ backup: recovery, successor: current });
      recoveredSuccessorPaths.add(config.path);
      return;
    }
    if (!original) {
      throw new Error(
        `Shell profile recovery generation is missing: ${originalClaim}`,
      );
    }
    linkSync(originalClaim, config.path);
    assertProfileIdentity(config.path, beforeIdentity, "uninstall rollback");
    syncUninstallDirectory(parent);
    recovery.before = original;
    cleanupProfileRecovery(recovery);
  };
  const restoreBackups = (): void => {
    while (backups.length > 0) {
      const backup = backups.at(-1);
      if (!backup) break;
      assertProfileIdentity(backup.path, backup.after, "uninstall rollback");
      const displaced = `${backup.path}.lore-uninstall-rollback-${process.pid}-${randomBytes(8).toString("hex")}`;
      try {
        renameSync(backup.path, displaced);
        assertProfileIdentity(displaced, backup.after, "uninstall rollback");
        syncUninstallDirectory(dirname(backup.path));
        linkSync(backup.originalClaim, backup.path);
        assertProfileIdentity(backup.path, backup.before, "uninstall rollback");
        syncUninstallDirectory(dirname(backup.path));
        unlinkSync(displaced);
        syncUninstallDirectory(dirname(backup.path));
        cleanupProfileRecovery(backup);
        backups.pop();
      } catch (error) {
        try {
          if (!existsSync(backup.path)) linkSync(displaced, backup.path);
        } catch {
          // Preserve both claims instead of clobbering a successor.
        }
        throw error;
      }
    }
  };
  const discardBackups = (): void => {
    for (const backup of backups) {
      try {
        cleanupProfileRecovery(backup);
      } catch {
        // Preserve unidentified recovery claims.
      }
    }
    backups.length = 0;
  };

  try {
    for (const config of shellConfigPaths(homeDirectory)) {
      recoverProfile(config);
      if (recoveredSuccessorPaths.has(config.path)) continue;
      if (!existsSync(config.path)) continue;
      const initial = lstatSync(config.path);
      if (!initial.isFile() || initial.isSymbolicLink()) continue;
      if (
        typeof process.getuid === "function" &&
        initial.uid !== process.getuid()
      ) {
        continue;
      }
      const canonicalParent = realpathSync.native(dirname(config.path));
      if (!pathIsInside(canonicalParent, canonicalHome)) continue;
      const beforeFile = captureFile(config.path, uid);
      if (beforeFile === null) {
        throw new Error(
          `Shell profile changed during uninstall: ${config.path}`,
        );
      }
      const before = beforeFile.content.toString("utf8");
      const after = removeInstallerPathBlock(before, installDir, config.shell);
      if (after === before) continue;

      const token = `${process.pid}-${randomBytes(8).toString("hex")}`;
      const temp = `${config.path}.lore-uninstall-${token}`;
      const originalClaim = `${config.path}.lore-uninstall-original-${token}`;
      const journalPath = `${config.path}.lore-uninstall-profile-${token}.json`;
      let quarantined = false;
      let journalFile: CapturedFile | null = null;
      let afterFile: CapturedFile | null = null;
      try {
        assertInstallRemoved();
        writeFileSync(temp, after, {
          encoding: "utf8",
          flag: "wx",
          mode: initial.mode,
        });
        afterFile = captureFile(temp, uid);
        if (afterFile === null) {
          throw new Error(
            `Shell profile changed during uninstall: ${config.path}`,
          );
        }
        syncUninstallFile(temp, afterFile);
        writeFileSync(
          journalPath,
          `${JSON.stringify({
            version: 1,
            token,
            profile: config.path,
            before: encodeIdentity(beforeFile),
            after: encodeIdentity(afterFile),
          } satisfies ProfileJournal)}\n`,
          { encoding: "utf8", flag: "wx", mode: 0o600 },
        );
        journalFile = captureFile(journalPath, uid);
        if (journalFile === null) {
          throw new Error(
            `Could not verify shell profile recovery journal: ${journalPath}`,
          );
        }
        syncUninstallFile(journalPath, journalFile);
        syncUninstallDirectory(dirname(config.path));
        hooks.beforeProfileQuarantine?.(config.path);
        assertProfileIdentity(config.path, beforeFile, "uninstall");
        renameSync(config.path, originalClaim);
        quarantined = true;
        assertProfileIdentity(originalClaim, beforeFile, "uninstall");
        syncUninstallDirectory(dirname(config.path));
        assertInstallRemoved();
        hooks.beforeProfilePublish?.(config.path);
        linkSync(temp, config.path);
        assertProfileIdentity(config.path, afterFile, "uninstall");
        syncUninstallDirectory(dirname(config.path));
        backups.push({
          path: config.path,
          originalClaim,
          afterClaim: temp,
          journalPath,
          journal: journalFile,
          before: beforeFile,
          after: afterFile,
        });
        quarantined = false;
      } catch (error) {
        if (quarantined) {
          try {
            if (!existsSync(config.path)) {
              linkSync(originalClaim, config.path);
              assertProfileIdentity(config.path, beforeFile, "uninstall");
              if (afterFile && journalFile) {
                cleanupProfileRecovery({
                  path: config.path,
                  originalClaim,
                  afterClaim: temp,
                  journalPath,
                  journal: journalFile,
                  before: beforeFile,
                  after: afterFile,
                });
              }
            }
          } catch {
            // Preserve original claim when no-clobber restoration is impossible.
          }
        } else {
          if (afterFile && existsSync(temp)) {
            removeProfileRecoveryFile(temp, afterFile);
          }
          if (journalFile && existsSync(journalPath)) {
            removeProfileRecoveryFile(journalPath, journalFile);
          }
        }
        throw error;
      }
    }
  } catch (error) {
    try {
      restoreBackups();
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "PATH cleanup failed and shell profiles could not be restored.",
      );
    }
    throw error;
  }
  return {
    prepareCommit: () => {
      assertInstallRemoved();
      for (const backup of backups) {
        assertProfileIdentity(backup.path, backup.after, "uninstall");
      }
      for (const recovery of successorRecoveries) {
        assertProfileIdentity(
          recovery.backup.path,
          recovery.successor,
          "uninstall",
        );
        assertProfileRecovery(recovery.backup);
      }
    },
    commit: () => {
      discardBackups();
      for (const recovery of successorRecoveries) {
        try {
          cleanupProfileRecovery(recovery.backup);
        } catch {
          // Preserve unidentified recovery claims and the canonical successor.
        }
      }
      successorRecoveries.length = 0;
    },
    rollback: (restore = true) => {
      if (restore) restoreBackups();
      else discardBackups();
    },
  };
}

export function assertSafeRemovalPath(
  path: string,
  homeDirectory: string = homedir(),
): void {
  const target = resolve(path);
  const home = resolve(homeDirectory);
  if (
    target === parse(target).root ||
    target === home ||
    !pathIsInside(target, home)
  ) {
    throw new Error(`Refusing to remove unsafe path: ${target}`);
  }
  const canonicalHome = realpathSync.native(homeDirectory);
  if (canonicalHome === parse(canonicalHome).root) {
    throw new Error(`Refusing unsafe home directory: ${home}`);
  }
  const canonicalTarget = resolve(canonicalHome, relative(home, target));
  const parts = relative(canonicalHome, canonicalTarget).split(sep);
  let ancestor = canonicalHome;
  for (const part of parts.slice(0, -1)) {
    ancestor = join(ancestor, part);
    try {
      if (lstatSync(ancestor).isSymbolicLink()) {
        throw new Error(
          `Refusing to follow an intermediate symbolic link: ${target}`,
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  let existingAncestor = dirname(canonicalTarget);
  while (!existsSync(existingAncestor)) {
    const parent = dirname(existingAncestor);
    if (parent === existingAncestor) break;
    existingAncestor = parent;
  }
  const canonicalAncestor = realpathSync.native(existingAncestor);
  if (!pathIsInside(canonicalAncestor, canonicalHome)) {
    throw new Error(
      `Refusing to follow a path outside the home directory: ${target}`,
    );
  }
}

function assertRemovalIdentity(
  path: string,
  expected: RemovalPathIdentity,
  homeDirectory: string,
): void {
  assertSafeRemovalPath(path, homeDirectory);
  const info = lstatSync(path, { bigint: true });
  if (
    info.isSymbolicLink() ||
    info.isDirectory() !== expected.directory ||
    info.dev !== expected.device ||
    info.ino !== expected.inode
  ) {
    throw new Error(
      `Removal path changed during uninstall quarantine: ${path}`,
    );
  }
  if (
    typeof process.getuid === "function" &&
    info.uid !== BigInt(process.getuid())
  ) {
    throw new Error(`Refusing to remove a path owned by another user: ${path}`);
  }
}

function discoverRemovalClaim(
  path: string,
  recursive: boolean,
  homeDirectory: string,
): { path: string; identity: RemovalPathIdentity } | null {
  const parent = dirname(path);
  if (!existsSync(parent)) return null;
  const prefix = `.${basename(path)}.lore-uninstall-claim-v1-`;
  const names = readdirSync(parent).filter((name) => name.startsWith(prefix));
  if (names.length === 0) return null;
  if (names.length !== 1) {
    throw new Error(`Multiple removal recovery claims exist for: ${path}`);
  }
  const claimPath = join(parent, names[0]);
  const fields = names[0].slice(prefix.length).split("-");
  if (
    fields.length !== 5 ||
    !/^\d+$/.test(fields[0]) ||
    !/^\d+$/.test(fields[1]) ||
    (fields[2] !== "d" && fields[2] !== "f") ||
    !/^\d+$/.test(fields[3]) ||
    !/^[a-f0-9]{16}$/.test(fields[4])
  ) {
    throw new Error(`Invalid removal recovery claim: ${claimPath}`);
  }
  const identity: RemovalPathIdentity = {
    device: BigInt(fields[0]),
    inode: BigInt(fields[1]),
    directory: fields[2] === "d",
  };
  if (identity.directory !== recursive) {
    throw new Error(`Removal recovery claim type changed: ${claimPath}`);
  }
  assertRemovalIdentity(claimPath, identity, homeDirectory);
  return { path: claimPath, identity };
}

function removalClaimPath(path: string, identity: RemovalPathIdentity): string {
  return join(
    dirname(path),
    `.${basename(path)}.lore-uninstall-claim-v1-${identity.device}-${identity.inode}-${identity.directory ? "d" : "f"}-${process.pid}-${randomBytes(8).toString("hex")}`,
  );
}

function stagedRemovalClaim(
  path: string,
  claim: string,
  expected: RemovalPathIdentity,
  recursive: boolean,
  homeDirectory: string,
  successorIdentity: RemovalPathIdentity | null,
): PathBlockRemoval {
  let currentClaim = claim;
  let active = true;
  let prepared = false;
  return {
    prepareCommit: () => {
      if (!active) return;
      assertRemovalIdentity(currentClaim, expected, homeDirectory);
      if (successorIdentity) {
        assertRemovalIdentity(path, successorIdentity, homeDirectory);
      }
      prepared = true;
    },
    commit: () => {
      if (!active) return;
      if (!prepared) {
        throw new Error(`Removal path was not prepared for commit: ${path}`);
      }
      assertRemovalIdentity(currentClaim, expected, homeDirectory);
      const deletingClaim = removalClaimPath(path, expected);
      renameSync(currentClaim, deletingClaim);
      currentClaim = deletingClaim;
      assertRemovalIdentity(currentClaim, expected, homeDirectory);
      syncUninstallDirectory(dirname(currentClaim));
      rmSync(currentClaim, { recursive, force: false });
      syncUninstallDirectory(dirname(currentClaim));
      active = false;
    },
    rollback: () => {
      if (!active) return;
      assertRemovalIdentity(currentClaim, expected, homeDirectory);
      if (existsSync(path)) {
        // A successor owns the canonical name. Preserve both generations and
        // let a later uninstall safely continue the durable claim.
        return;
      }
      renameSync(currentClaim, path);
      assertRemovalIdentity(path, expected, homeDirectory);
      syncUninstallDirectory(dirname(path));
      active = false;
    },
  };
}

export function removePath(
  path: string,
  recursive: boolean,
  preflight?: RemovalPathIdentity | null,
  homeDirectory: string = homedir(),
  hooks: RemovalPathHooks = {},
): PathBlockRemoval {
  const expected =
    preflight === undefined
      ? preflightRemoval(path, recursive, homeDirectory)
      : preflight;
  assertSafeRemovalPath(path, homeDirectory);
  const recoveredClaim = discoverRemovalClaim(path, recursive, homeDirectory);
  if (recoveredClaim) {
    return stagedRemovalClaim(
      path,
      recoveredClaim.path,
      recoveredClaim.identity,
      recursive,
      homeDirectory,
      expected,
    );
  }
  if (expected === null) {
    try {
      lstatSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return {
          prepareCommit: () => {
            try {
              lstatSync(path);
            } catch (prepareError) {
              if ((prepareError as NodeJS.ErrnoException).code === "ENOENT") {
                return;
              }
              throw prepareError;
            }
            throw new Error(
              `Removal path appeared after uninstall preflight: ${path}`,
            );
          },
          commit: () => {},
          rollback: () => {},
        };
      }
      throw error;
    }
    throw new Error(`Removal path appeared after uninstall preflight: ${path}`);
  }
  assertRemovalIdentity(path, expected, homeDirectory);
  hooks.beforeQuarantine?.();
  const claim = removalClaimPath(path, expected);
  try {
    renameSync(path, claim);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `Removal path changed during uninstall quarantine: ${path}`,
      );
    }
    throw error;
  }
  // Never republish a claim whose exact staged generation is unknown.
  assertRemovalIdentity(claim, expected, homeDirectory);
  try {
    syncUninstallDirectory(dirname(claim));
  } catch (error) {
    try {
      assertRemovalIdentity(claim, expected, homeDirectory);
      if (!existsSync(path)) {
        renameSync(claim, path);
        assertRemovalIdentity(path, expected, homeDirectory);
        syncUninstallDirectory(dirname(path));
      }
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        `Removal path quarantine was not durable and could not be restored: ${path}`,
      );
    }
    throw error;
  }
  try {
    hooks.afterQuarantine?.();
  } catch (error) {
    try {
      assertRemovalIdentity(claim, expected, homeDirectory);
      if (!existsSync(path)) {
        renameSync(claim, path);
        assertRemovalIdentity(path, expected, homeDirectory);
        syncUninstallDirectory(dirname(path));
      }
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        `Removal path quarantine failed and could not be restored: ${path}`,
      );
    }
    throw error;
  }
  assertRemovalIdentity(claim, expected, homeDirectory);

  return stagedRemovalClaim(
    path,
    claim,
    expected,
    recursive,
    homeDirectory,
    null,
  );
}

export function preflightRemoval(
  path: string,
  recursive: boolean,
  homeDirectory: string = homedir(),
): RemovalPathIdentity | null {
  assertSafeRemovalPath(path, homeDirectory);
  let info: ReturnType<typeof lstatSync>;
  try {
    info = lstatSync(path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (info.isSymbolicLink())
    throw new Error(`Refusing symbolic link removal: ${path}`);
  if (
    typeof process.getuid === "function" &&
    info.uid !== BigInt(process.getuid())
  ) {
    throw new Error(`Refusing to remove a path owned by another user: ${path}`);
  }
  if (info.isDirectory() && !recursive) {
    throw new Error(`Refusing recursive removal for: ${path}`);
  }
  if (recursive && !info.isDirectory()) {
    throw new Error(`Refusing recursive removal for non-directory: ${path}`);
  }
  return {
    device: info.dev,
    inode: info.ino,
    directory: info.isDirectory(),
  };
}

function assertFileIdentity(
  path: string,
  expected: ExecutableIdentity,
  homeDirectory: string = homedir(),
  description: "Executable" | "Install receipt" = "Executable",
): void {
  assertSafeRemovalPath(path, homeDirectory);
  const info = lstatSync(path, { bigint: true });
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(
      `Refusing to remove a replaced ${description.toLowerCase()}: ${path}`,
    );
  }
  if (
    typeof process.getuid === "function" &&
    info.uid !== BigInt(process.getuid())
  ) {
    throw new Error(`Refusing to remove a path owned by another user: ${path}`);
  }
  if (
    info.dev !== expected.device ||
    info.ino !== expected.inode ||
    info.size !== expected.size ||
    info.mtimeNs !== expected.mtimeNs
  ) {
    throw new Error(`${description} changed during uninstall: ${path}`);
  }
  const content = readFileSync(path);
  const final = lstatSync(path, { bigint: true });
  if (
    final.dev !== expected.device ||
    final.ino !== expected.inode ||
    final.size !== expected.size ||
    final.mtimeNs !== expected.mtimeNs ||
    createHash("sha256").update(content).digest("hex") !== expected.sha256
  ) {
    throw new Error(`${description} changed during uninstall: ${path}`);
  }
}

function pathIdentityState(
  path: string,
  expected: ExecutableIdentity,
  homeDirectory: string,
): ReturnType<StagedFileRemoval["state"]> {
  try {
    assertSafeRemovalPath(path, homeDirectory);
    const info = lstatSync(path, { bigint: true });
    if (!info.isFile() || info.isSymbolicLink()) return "replaced";
    if (info.dev !== expected.device || info.ino !== expected.inode) {
      return "replaced";
    }
    assertFileIdentity(path, expected, homeDirectory);
    return "expected";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    return "unknown";
  }
}

function removeIdentifiedFile(
  path: string,
  expected: ExecutableIdentity,
  homeDirectory: string,
  description: "Executable" | "Install receipt",
): StagedFileRemoval {
  const stageDir = `${path}.lore-uninstall`;
  const stagedPath = join(stageDir, basename(path));
  const assertExpected = (target: string): void =>
    assertFileIdentity(target, expected, homeDirectory, description);
  const state = (): ReturnType<StagedFileRemoval["state"]> =>
    pathIdentityState(path, expected, homeDirectory);

  if (existsSync(stageDir)) {
    assertSafeRemovalPath(stageDir, homeDirectory);
    const stageInfo = lstatSync(stageDir);
    if (!stageInfo.isDirectory() || stageInfo.isSymbolicLink()) {
      throw new Error(
        `Refusing unsafe ${description.toLowerCase()} recovery path: ${stageDir}`,
      );
    }
    const stagedFiles = readdirSync(stageDir).map((name) =>
      join(stageDir, name),
    );
    const recoverySource = stagedFiles.find((file) => {
      try {
        assertExpected(file);
        return true;
      } catch {
        return false;
      }
    });
    const currentState = state();
    if (currentState === "missing" && recoverySource) {
      linkSync(recoverySource, path);
      assertExpected(path);
    } else if (currentState !== "expected") {
      throw new Error(`${description} changed during uninstall: ${path}`);
    }
    for (const file of stagedFiles) {
      assertExpected(file);
      unlinkSync(file);
    }
    rmdirSync(stageDir);
  }
  mkdirSync(stageDir, { mode: 0o700 });
  try {
    assertExpected(path);
    linkSync(path, stagedPath);
    assertExpected(stagedPath);
  } catch (error) {
    if (existsSync(stagedPath)) unlinkSync(stagedPath);
    rmdirSync(stageDir);
    throw error;
  }

  let active = true;
  let committed = false;
  let finalized = false;
  let stagedDeleted = false;
  const recoverySource = (): string | null => {
    if (!existsSync(stageDir)) return null;
    for (const name of readdirSync(stageDir)) {
      const candidate = join(stageDir, name);
      try {
        assertExpected(candidate);
        return candidate;
      } catch {
        // A mismatched file is not a recovery source.
      }
    }
    return null;
  };
  const cleanupStage = (): void => {
    if (!existsSync(stageDir)) return;
    for (const name of readdirSync(stageDir)) {
      const candidate = join(stageDir, name);
      assertExpected(candidate);
      unlinkSync(candidate);
    }
    rmdirSync(stageDir);
  };
  const discardRecovery = (): void => {
    try {
      cleanupStage();
    } catch {
      // Never remove an unidentified recovery artifact.
    }
    active = false;
  };
  return {
    stageDeletion: () => {
      if (!active || stagedDeleted) return;
      assertExpected(path);
      assertExpected(stagedPath);
      const removingPath = join(
        stageDir,
        `removing-${randomBytes(8).toString("hex")}`,
      );
      renameSync(path, removingPath);
      try {
        assertExpected(removingPath);
        if (existsSync(path)) {
          throw new Error(`${description} replaced during uninstall: ${path}`);
        }
        unlinkSync(removingPath);
        stagedDeleted = true;
      } catch (error) {
        try {
          if (!existsSync(path)) linkSync(removingPath, path);
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            `A ${description.toLowerCase()} was moved during cleanup and could not be restored.`,
          );
        }
        throw error;
      }
    },
    assertDeleted: () => {
      if (!stagedDeleted || state() !== "missing") {
        throw new Error(`${description} replaced during uninstall: ${path}`);
      }
      if (active && !recoverySource()) {
        throw new Error(
          `${description} recovery data is missing from: ${stageDir}`,
        );
      }
    },
    state,
    prepareCommit: () => {
      if (!active) return;
      if (!stagedDeleted)
        throw new Error(`${description} deletion was not staged`);
      if (state() !== "missing") {
        throw new Error(`${description} replaced during uninstall: ${path}`);
      }
      committed = true;
    },
    commit: () => {
      if (!active) return;
      if (!committed) {
        if (!stagedDeleted)
          throw new Error(`${description} deletion was not staged`);
        committed = true;
      }
      if (!finalized && state() !== "missing") {
        throw new Error(`${description} replaced during uninstall: ${path}`);
      }
      try {
        cleanupStage();
      } catch {
        // Preserve unidentified recovery artifacts.
      }
      active = false;
    },
    finalize: () => {
      if (!active) return;
      if (!committed || state() !== "missing") {
        throw new Error(`${description} replaced during uninstall: ${path}`);
      }
      finalized = true;
    },
    rollback: (restore = true) => {
      if (!active) return restore ? "restored" : "preserved";
      const currentState = state();
      if (currentState === "unknown") {
        throw new Error(
          `Could not establish ${description.toLowerCase()} identity: ${path}`,
        );
      }
      if (!restore && currentState !== "expected") {
        if (currentState === "replaced") discardRecovery();
        return "preserved";
      }
      let result: "restored" | "preserved";
      if (currentState === "missing" && restore) {
        const source = recoverySource();
        if (!source) {
          throw new Error(
            `${description} recovery data is missing from: ${stageDir}`,
          );
        }
        linkSync(source, path);
        assertExpected(path);
        result = "restored";
      } else if (currentState === "expected") {
        result = "restored";
      } else {
        result = "preserved";
      }
      cleanupStage();
      active = false;
      return result;
    },
  };
}

export function removeBinary(
  path: string,
  expected: ExecutableIdentity,
  homeDirectory: string = homedir(),
): StagedFileRemoval {
  return removeIdentifiedFile(path, expected, homeDirectory, "Executable");
}

export function removeReceipt(
  path: string,
  expected: InstallReceiptIdentity,
  homeDirectory: string = homedir(),
): StagedFileRemoval {
  return removeIdentifiedFile(path, expected, homeDirectory, "Install receipt");
}

function printPlan(plan: UninstallPlan): void {
  console.log("[lore] Planned cleanup:");
  console.log("[lore]   restore configs changed by `lore setup`");
  for (const removal of plan.removals) {
    console.log(`[lore]   remove ${removal.path}`);
  }
  if (plan.binaryPath) console.log(`[lore]   remove ${plan.binaryPath}`);
  if (plan.receiptPath) console.log(`[lore]   remove ${plan.receiptPath}`);
  if (plan.manualBinaryPath) {
    console.log(
      `[lore]   preserve executable for manual deletion ${plan.manualBinaryPath}`,
    );
  }
  if (plan.manualReceiptPath) {
    console.log(`[lore]   preserve install receipt ${plan.manualReceiptPath}`);
  }
  for (const path of plan.preservedDataPaths) {
    console.log(`[lore]   preserve ${path}`);
  }
}

async function confirmPurge(): Promise<boolean> {
  if (!process.stdin.isTTY) {
    console.error(
      "[lore] --purge requires confirmation in non-interactive mode. Re-run with --yes.",
    );
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(
      'Delete Lore\'s database, logs, credentials, and runtime data? Type "yes" to confirm: ',
    );
    return answer.trim().toLowerCase() === "yes";
  } finally {
    rl.close();
  }
}

export async function commandUninstall(
  args: string[],
  values: Record<string, unknown>,
): Promise<void> {
  if (values.help === true) {
    console.log(UNINSTALL_USAGE);
    return;
  }
  if (args.length > 0) {
    console.error(`[lore] Unknown uninstall argument: ${args[0]}`);
    console.error(UNINSTALL_USAGE);
    process.exitCode = 1;
    return;
  }
  const allowedOptions = new Set(["purge", "yes", "help", "dry-run"]);
  const unsupportedOption = Object.keys(values).find(
    (name) => !allowedOptions.has(name),
  );
  if (unsupportedOption) {
    console.error(`[lore] Unknown uninstall option: --${unsupportedOption}`);
    console.error(UNINSTALL_USAGE);
    process.exitCode = 1;
    return;
  }

  const purge = values.purge === true;
  const standalone = isSeaBinary();
  const packageManaged = !standalone;
  const executable = process.execPath;
  const home = homedir();
  const dataDir = resolvedDataDir();
  const configDir = getConfigDir();
  const dbPath = process.env.LORE_DB_PATH;
  const provenance = standaloneInstallProvenance(executable);
  const defaultDataDir = join(home, ".local", "share", "lore");
  const defaultConfigDir = join(home, ".lore");
  const externalDbPath =
    dbPath && (!isAbsolute(dbPath) || !pathIsInside(dbPath, defaultDataDir))
      ? isAbsolute(dbPath)
        ? dbPath
        : resolve(process.cwd(), dbPath)
      : null;
  const canonicalProtectedPaths = [
    ...(resolve(dataDir) !== resolve(defaultDataDir) ? [dataDir] : []),
    ...(resolve(configDir) !== resolve(defaultConfigDir) ? [configDir] : []),
    ...(externalDbPath ? [externalDbPath] : []),
    ...(!provenance.hostedInstall || process.platform === "win32"
      ? [executable]
      : []),
    ...(packageManaged && process.argv[1] ? [resolve(process.argv[1])] : []),
  ]
    .map(canonicalPath)
    .filter((path): path is string => path !== null);
  const plan = planUninstall({
    currentExecutable: executable,
    hostedInstall: provenance.hostedInstall,
    receiptPath: provenance.receiptPath,
    pathInstallDir: provenance.pathInstallDir,
    packageManaged,
    platform: process.platform,
    purge,
    home,
    cwd: process.cwd(),
    dataDir,
    configDir,
    dbPath,
    executableIdentity: provenance.executableIdentity,
    receiptIdentity: provenance.receiptIdentity,
    packageEntryPath:
      packageManaged && process.argv[1] ? resolve(process.argv[1]) : undefined,
    canonicalProtectedPaths,
  });
  printPlan(plan);

  if (values["dry-run"] === true || values.dryRun === true) return;
  if (purge && values.yes !== true && !(await confirmPurge())) {
    console.log("[lore] Uninstall cancelled; no files were changed.");
    process.exitCode = 1;
    return;
  }

  const {
    prevalidateSetupUndo,
    reconcileSetupExternalEffects,
    stageSetupUndo,
  } = await import("./setup");
  const { inspectGatewayProcessFile, readGatewayProcessFile } =
    await import("../pidfile");
  const { inspectPortFile, readPortFile } = await import("../portfile");
  const { probeGatewayStatus, probeGatewayProcessStatus } =
    await import("./start");
  let code: number;
  let executionStarted = false;
  try {
    const removalPreflights = new Map<string, RemovalPathIdentity | null>();
    for (const removal of plan.removals) {
      removalPreflights.set(
        removal.path,
        preflightRemoval(removal.path, removal.recursive, home),
      );
    }
    if (plan.binaryPath && plan.binaryIdentity) {
      assertFileIdentity(plan.binaryPath, plan.binaryIdentity);
    }
    if (plan.receiptPath && plan.receiptIdentity) {
      assertFileIdentity(
        plan.receiptPath,
        plan.receiptIdentity,
        home,
        "Install receipt",
      );
    }
    executionStarted = true;
    code = await withLifecycleLock("uninstall", (lifecycleLock) => {
      lifecycleLock.assertOwned();
      reconcileSetupExternalEffects(lifecycleLock);
      lifecycleLock.assertOwned();
      return runUninstall(plan, {
        gatewayRunning: () =>
          gatewayRunning({
            inspectProcessRecord: () =>
              inspectGatewayProcessFile({ requireLoopbackHosts: true }),
            readProcessRecord: readGatewayProcessFile,
            authenticateProcess: probeGatewayProcessStatus,
            inspectPort: inspectPortFile,
            readPort: readPortFile,
            probePort: probeGatewayStatus,
          }),
        prevalidateSetupUndo,
        stageSetupUndo: () => stageSetupUndo(lifecycleLock),
        removePathBlocks,
        removePath: (path, recursive) => {
          if (!removalPreflights.has(path)) {
            throw new Error(`Removal path was not preflighted: ${path}`);
          }
          return removePath(
            path,
            recursive,
            removalPreflights.get(path) ?? null,
            home,
          );
        },
        removeBinary,
        removeReceipt,
        recoverReplacementReceipt: recoverReplacementInstallReceipt,
        beginUninstall: plan.binaryPath
          ? () => createUninstallTombstone(lifecycleLock)
          : undefined,
        log: (message) => console.error(`[lore] ${message}`),
      });
    });
  } catch (error) {
    console.error(
      `[lore] ${error instanceof Error ? error.message : String(error)}`,
    );
    console.error(
      error instanceof IrreversibleUninstallError
        ? "[lore] Irreversible cleanup began; no unsafe rollback was attempted and recovery artifacts may remain."
        : executionStarted
          ? "[lore] Uninstall did not complete; rollback was attempted and recovery artifacts may remain."
          : "[lore] No files were changed.",
    );
    process.exitCode = 1;
    return;
  }
  if (code !== 0) {
    process.exitCode = code;
    return;
  }

  for (const path of plan.preservedDataPaths) {
    console.log(`[lore] Preserved data: ${path}`);
  }
  if (plan.preservedDataPaths.length > 0) {
    console.log(
      purge
        ? "[lore] Custom data paths are never deleted automatically; review them manually."
        : "[lore] Use `lore uninstall --purge` to delete the default data directory too.",
    );
  }
  console.log(
    "[lore] Project .lore.md, .lore.json, AGENTS.md, and CLAUDE.md files were not removed.",
  );

  if (packageManaged) {
    const script = process.argv[1]
      ? basename(process.argv[1])
      : "package entry";
    console.log(`[lore] Package-managed CLI detected (${script}).`);
    console.log(
      "[lore] Remove it with your package manager (global npm: npm uninstall -g @loreai/gateway).",
    );
  } else if (plan.binaryPath) {
    console.log("[lore] Lore uninstalled. Restart your shell to refresh PATH.");
  } else if (plan.manualBinaryPath) {
    const reason =
      process.platform === "win32" && provenance.hostedInstall
        ? "Windows cannot remove its running executable; delete it after this command exits"
        : "Executable provenance could not be verified; remove it with its installer or package manager";
    console.log(`[lore] ${reason}: ${plan.manualBinaryPath}`);
    if (plan.manualReceiptPath) {
      console.log(
        `[lore] After deleting the executable, also delete: ${plan.manualReceiptPath}`,
      );
    }
  }
  console.log(
    "[lore] If setup installed the OpenCode plugin globally, remove it with: npm uninstall -g @loreai/opencode",
  );
}
