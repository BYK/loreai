/**
 * PID file management — lets `lore stop` find a gateway started in the
 * background (`lore start --bg`) or foreground.
 *
 * New gateways write an owner-only control record containing the PID, bound
 * address, and a random challenge token. `lore stop` must authenticate that
 * token against the gateway before signalling the PID, preventing PID reuse or
 * a spoofed public health response from causing an unrelated process to die.
 *
 * Mirrors `portfile.ts` semantics (write/read/remove-if-matches).
 */
import { randomBytes } from "node:crypto";
import { basename, join } from "node:path";
import { linkSync, lstatSync, renameSync, rmSync } from "node:fs";
import { dataDir } from "@loreai/core";
import { atomicWriteRuntimeFile, readRuntimeFile } from "./runtime-files";

const PIDFILE_NAME = "gateway.pid";

export interface GatewayProcessRecord {
  version: 1 | 2;
  pid: number;
  port: number;
  hosts: string[];
  token: string;
  processIdentity?: string;
}

export type ProcessFileInspection =
  | { state: "absent" }
  | { state: "valid"; record: GatewayProcessRecord }
  | { state: "invalid"; reason: string };

export interface LegacyPidFileIdentity {
  device: bigint;
  inode: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  birthtimeNs: bigint;
}

export interface LegacyPidFileRecord {
  pid: number;
  identity: LegacyPidFileIdentity;
}

export type LegacyPidRemovalResult = "removed" | "absent" | "changed";

export type PidFileInspection =
  | { state: "absent" }
  | { state: "process"; record: GatewayProcessRecord }
  | { state: "legacy"; record: LegacyPidFileRecord }
  | { state: "invalid"; reason: string };

function pidfilePath(): string {
  return join(dataDir(), PIDFILE_NAME);
}

function isPid(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function validProcessRecord(value: unknown): value is GatewayProcessRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<GatewayProcessRecord>;
  return (
    (record.version === 1 || record.version === 2) &&
    isPid(record.pid) &&
    typeof record.port === "number" &&
    Number.isSafeInteger(record.port) &&
    record.port > 0 &&
    record.port <= 65535 &&
    Array.isArray(record.hosts) &&
    record.hosts.length > 0 &&
    record.hosts.every(
      (host) =>
        typeof host === "string" && host.length > 0 && host.length <= 255,
    ) &&
    typeof record.token === "string" &&
    record.token.length >= 32 &&
    record.token.length <= 256 &&
    (record.version === 1 ||
      (typeof record.processIdentity === "string" &&
        record.processIdentity.length > 0 &&
        record.processIdentity.length <= 1024))
  );
}

function generationBoundProcessRecord(
  record: GatewayProcessRecord,
): record is GatewayProcessRecord & { version: 2; processIdentity: string } {
  return record.version === 2 && typeof record.processIdentity === "string";
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    normalized === "127.0.0.1" ||
    normalized === "localhost" ||
    normalized === "::1"
  );
}

function writeOwnerOnly(content: string): void {
  atomicWriteRuntimeFile(PIDFILE_NAME, content);
}

/** Write a legacy PID-only file. Kept for compatibility and focused tests. */
export function writePidFile(pid: number = process.pid): void {
  writeOwnerOnly(String(pid));
}

/** Write the authenticated process record used by new gateways. */
export function writeGatewayProcessFile(record: GatewayProcessRecord): void {
  if (!validProcessRecord(record)) {
    throw new Error("Invalid gateway process record");
  }
  writeOwnerOnly(`${JSON.stringify(record)}\n`);
}

/**
 * Remove the PID file on shutdown — but only if it still contains the PID
 * this instance wrote. Prevents a concurrent gateway from losing its PID file
 * when a different instance shuts down.
 */
export function removePidFile(expectedPid: number = process.pid): void {
  try {
    const inspection = inspectGatewayProcessFile();
    if (inspection.state === "valid" && inspection.record.pid === expectedPid) {
      removeGatewayProcessFile(inspection.record);
      return;
    }
    const legacy = readLegacyPidFile();
    if (legacy?.pid === expectedPid) removeLegacyPidFile(legacy);
  } catch {
    /* already gone or unreadable */
  }
}

function pidFileIdentity(path: string): LegacyPidFileIdentity {
  const info = lstatSync(path, { bigint: true });
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`Refusing non-regular PID file: ${path}`);
  }
  if (
    typeof process.getuid === "function" &&
    info.uid !== BigInt(process.getuid())
  ) {
    throw new Error(`Refusing PID file not owned by the current user: ${path}`);
  }
  if (process.platform !== "win32" && (info.mode & 0o077n) !== 0n) {
    throw new Error(`PID file is not owner-only: ${path}`);
  }
  return {
    device: info.dev,
    inode: info.ino,
    size: info.size,
    mtimeNs: info.mtimeNs,
    ctimeNs: info.ctimeNs,
    birthtimeNs: info.birthtimeNs,
  };
}

function sameLegacyPidIdentity(
  left: LegacyPidFileIdentity,
  right: LegacyPidFileIdentity,
): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.birthtimeNs === right.birthtimeNs
  );
}

function sameQuarantinedLegacyPidIdentity(
  left: LegacyPidFileIdentity,
  right: LegacyPidFileIdentity,
): boolean {
  // Renaming changes ctime on Unix. The inode binds the quarantined file to
  // the observed generation; size and mtime additionally reject in-place
  // content changes made before the rename.
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.birthtimeNs === right.birthtimeNs
  );
}

function inspectPidFileAt(
  path: string,
  runtimeName: string,
): PidFileInspection {
  try {
    const before = pidFileIdentity(path);
    const content = readRuntimeFile(runtimeName, { ownerOnly: true }).trim();
    const after = pidFileIdentity(path);
    if (!sameLegacyPidIdentity(before, after)) {
      return { state: "invalid", reason: "PID file changed while reading" };
    }
    if (/^[1-9]\d*$/.test(content)) {
      const pid = Number(content);
      return isPid(pid)
        ? { state: "legacy", record: { pid, identity: after } }
        : { state: "invalid", reason: "legacy PID is invalid" };
    }
    let value: unknown;
    try {
      value = JSON.parse(content);
    } catch {
      return { state: "invalid", reason: "PID file is malformed" };
    }
    return validProcessRecord(value)
      ? { state: "process", record: value }
      : { state: "invalid", reason: "process record has invalid fields" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { state: "absent" };
    }
    return {
      state: "invalid",
      reason: `PID file is unreadable or unsafe: ${String(error)}`,
    };
  }
}

/** Inspect one stable PID-file generation without conflating invalid evidence. */
export function inspectPidFile(): PidFileInspection {
  return inspectPidFileAt(pidfilePath(), PIDFILE_NAME);
}

/**
 * Read a legacy numeric PID together with the exact filesystem generation that
 * supplied it. Authenticated JSON records and raced/unsafe files return null.
 */
export function readLegacyPidFile(): LegacyPidFileRecord | null {
  const inspection = inspectPidFile();
  return inspection.state === "legacy" ? inspection.record : null;
}

/**
 * Quarantine and remove only the exact legacy PID-file generation observed by
 * the caller. A replacement is restored without clobbering a newer record, or
 * retained as a recovery artifact if another successor already occupies the
 * canonical path.
 */
export function removeLegacyPidFile(
  expected: LegacyPidFileRecord,
): LegacyPidRemovalResult {
  const path = pidfilePath();
  const claimName = `.gateway.pid.legacy-cleanup-${process.pid}-${randomBytes(8).toString("hex")}`;
  const claimPath = join(dataDir(), claimName);
  try {
    renameSync(path, claimPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw error;
  }

  const inspection = inspectPidFileAt(claimPath, claimName);
  const claimed = inspection.state === "legacy" ? inspection.record : null;
  if (
    claimed?.pid === expected.pid &&
    sameQuarantinedLegacyPidIdentity(claimed.identity, expected.identity)
  ) {
    rmSync(claimPath, { force: true });
    try {
      lstatSync(path);
      return "changed";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "removed";
      throw error;
    }
  }
  preserveQuarantinedSuccessor(claimPath, path);
  return "changed";
}

function preserveQuarantinedSuccessor(claimPath: string, path: string): void {
  try {
    linkSync(claimPath, path);
    rmSync(claimPath, { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    // A newer record already occupies the canonical path. Keep this displaced
    // generation quarantined rather than deleting an unrecognized successor.
  }
}

/**
 * Remove only the exact authenticated process generation. A raced-in successor
 * is restored with no-clobber semantics or retained as a recovery artifact.
 */
export function removeGatewayProcessFile(
  expected: Pick<GatewayProcessRecord, "pid" | "token" | "processIdentity">,
): void {
  const path = pidfilePath();
  const claimPath = join(
    dataDir(),
    `.gateway.pid.cleanup-${process.pid}-${randomBytes(8).toString("hex")}`,
  );
  try {
    renameSync(path, claimPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }

  const claimed = inspectGatewayProcessFileAt(claimPath);
  if (
    claimed.state === "valid" &&
    claimed.record.pid === expected.pid &&
    claimed.record.token === expected.token &&
    claimed.record.processIdentity === expected.processIdentity
  ) {
    rmSync(claimPath, { force: true });
    return;
  }
  preserveQuarantinedSuccessor(claimPath, path);
}

/** Read the PID file. Returns the PID or null if not found/invalid. */
export function readPidFile(): number | null {
  try {
    const content = readRuntimeFile(PIDFILE_NAME).trim();
    if (content.startsWith("{")) {
      const record = JSON.parse(content) as unknown;
      return validProcessRecord(record) ? record.pid : null;
    }
    const pid = Number.parseInt(content, 10);
    return pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Read a new authenticated process record. Legacy numeric PID files return
 * null: they cannot establish process ownership and must never be signalled.
 */
export function readGatewayProcessFile(): GatewayProcessRecord | null {
  try {
    const value = JSON.parse(
      readRuntimeFile(PIDFILE_NAME, { ownerOnly: true }),
    ) as unknown;
    return validProcessRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function inspectGatewayProcessFileAt(path?: string): ProcessFileInspection {
  try {
    const content = path
      ? readFileAtClaim(path)
      : readRuntimeFile(PIDFILE_NAME, { ownerOnly: true });
    let value: unknown;
    try {
      value = JSON.parse(content);
    } catch {
      return { state: "invalid", reason: "process record is malformed" };
    }
    if (!validProcessRecord(value)) {
      return { state: "invalid", reason: "process record has invalid fields" };
    }
    if (!generationBoundProcessRecord(value)) {
      return {
        state: "invalid",
        reason: "legacy process record lacks process-start identity",
      };
    }
    return { state: "valid", record: value };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { state: "absent" };
    }
    return {
      state: "invalid",
      reason: `process record is unreadable or unsafe: ${String(error)}`,
    };
  }
}

function readFileAtClaim(path: string): string {
  // The claim was produced by renaming a file already validated through the
  // runtime-file reader. Reuse that validation by addressing its basename.
  return readRuntimeFile(basename(path), { ownerOnly: true });
}

/** Strict discovery API for destructive lifecycle operations. */
export function inspectGatewayProcessFile(
  options: { requireLoopbackHosts?: boolean } = {},
): ProcessFileInspection {
  const inspection = inspectGatewayProcessFileAt();
  if (
    inspection.state === "valid" &&
    options.requireLoopbackHosts &&
    inspection.record.hosts.some((host) => !isLoopbackHost(host))
  ) {
    return {
      state: "invalid",
      reason: "process record contains a non-loopback listener",
    };
  }
  return inspection;
}

/**
 * Check whether a process with the given PID is alive. Uses signal 0, which
 * performs error checking without actually sending a signal. Returns false for
 * a dead PID (ESRCH) and true for a live one (including EPERM — the process
 * exists but we lack permission to signal it).
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
