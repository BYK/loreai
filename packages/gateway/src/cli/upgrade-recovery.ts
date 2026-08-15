import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  parseInstallReceipt,
  recoverReplacementInstallReceipt,
  refreshStandaloneInstallReceipt,
  type ExecutableIdentity,
} from "./uninstall";

const BACKUP_TOKEN = /^\d+-[a-f0-9]{16}$/;
const JOURNAL_VERSION = 1;

interface CapturedFile extends ExecutableIdentity {
  content: Buffer;
}

interface BackupPair {
  token: string;
  executable: string;
  receiptPath: string;
  pathInstallDir: string;
  executableBackup: string;
  receiptBackup: string;
  oldExecutable: ExecutableIdentity;
  oldReceipt: ExecutableIdentity;
}

type RecoveryMode = "complete" | "rollback";

interface RecoveryJournalData {
  version: 1;
  mode: RecoveryMode;
  token: string;
  executable: string;
  receiptPath: string;
  pathInstallDir: string;
  executableBackup: string;
  receiptBackup: string;
  oldExecutable: SerializedIdentity;
  oldReceipt: SerializedIdentity;
  replacement: SerializedIdentity;
}

interface RecoveryJournal extends BackupPair {
  mode: RecoveryMode;
  replacement: ExecutableIdentity;
  journalPath: string;
  journalIdentity: ExecutableIdentity;
}

interface SerializedIdentity {
  device: string;
  inode: string;
  size: string;
  mtimeNs: string;
  sha256: string;
}

export interface StandaloneUpgradeRecoveryOptions {
  executable: string;
  receiptPath?: string;
  home?: string;
  uid?: number;
}

export interface StandaloneUpgradeRecoveryResult {
  executable: string;
  action: "none" | "completed" | "restored" | "cleaned";
}

export interface PersistStandaloneUpgradeRecoveryInput {
  executable: string;
  receiptPath: string;
  pathInstallDir: string;
  oldExecutable: ExecutableIdentity;
  oldReceipt: ExecutableIdentity;
  replacementPath: string;
  expectedReplacementSha256: string;
  previousBackupTokens?: ReadonlySet<string>;
  home?: string;
  uid?: number;
}

function identityEqual(
  left: ExecutableIdentity,
  right: ExecutableIdentity,
): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.sha256 === right.sha256
  );
}

function serializeIdentity(identity: ExecutableIdentity): SerializedIdentity {
  return {
    device: identity.device.toString(),
    inode: identity.inode.toString(),
    size: identity.size.toString(),
    mtimeNs: identity.mtimeNs.toString(),
    sha256: identity.sha256,
  };
}

function deserializeIdentity(value: unknown): ExecutableIdentity | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Partial<SerializedIdentity>;
  if (
    typeof candidate.device !== "string" ||
    typeof candidate.inode !== "string" ||
    typeof candidate.size !== "string" ||
    typeof candidate.mtimeNs !== "string" ||
    typeof candidate.sha256 !== "string" ||
    !/^\d+$/.test(candidate.device) ||
    !/^\d+$/.test(candidate.inode) ||
    !/^\d+$/.test(candidate.size) ||
    !/^\d+$/.test(candidate.mtimeNs) ||
    !/^[a-f0-9]{64}$/.test(candidate.sha256)
  ) {
    return null;
  }
  return {
    device: BigInt(candidate.device),
    inode: BigInt(candidate.inode),
    size: BigInt(candidate.size),
    mtimeNs: BigInt(candidate.mtimeNs),
    sha256: candidate.sha256,
  };
}

function captureFile(
  path: string,
  uid: number | undefined,
  ownerOnly: boolean,
): CapturedFile | null {
  let descriptor: number | null = null;
  try {
    const initial = lstatSync(path, { bigint: true });
    if (
      !initial.isFile() ||
      initial.isSymbolicLink() ||
      (uid !== undefined && initial.uid !== BigInt(uid)) ||
      (process.platform !== "win32" && (initial.mode & 0o022n) !== 0n) ||
      (process.platform !== "win32" &&
        ownerOnly &&
        (initial.mode & 0o077n) !== 0n)
    ) {
      return null;
    }
    const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
    descriptor = openSync(path, constants.O_RDONLY | noFollow);
    const opened = fstatSync(descriptor, { bigint: true });
    if (
      !opened.isFile() ||
      opened.isSymbolicLink() ||
      opened.dev !== initial.dev ||
      opened.ino !== initial.ino ||
      (uid !== undefined && opened.uid !== BigInt(uid))
    ) {
      return null;
    }
    const content = readFileSync(descriptor);
    const final = fstatSync(descriptor, { bigint: true });
    if (
      opened.dev !== final.dev ||
      opened.ino !== final.ino ||
      opened.size !== final.size ||
      opened.mtimeNs !== final.mtimeNs ||
      (uid !== undefined && final.uid !== BigInt(uid)) ||
      (process.platform !== "win32" && (final.mode & 0o022n) !== 0n) ||
      (process.platform !== "win32" &&
        ownerOnly &&
        (final.mode & 0o077n) !== 0n)
    ) {
      return null;
    }
    return {
      device: final.dev,
      inode: final.ino,
      size: final.size,
      mtimeNs: final.mtimeNs,
      sha256: createHash("sha256").update(content).digest("hex"),
      content,
    };
  } catch {
    return null;
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function assertTrustedDirectory(
  path: string,
  uid: number | undefined,
  requireOwner: boolean,
): void {
  const info = lstatSync(path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (requireOwner && uid !== undefined && info.uid !== uid) ||
    (process.platform !== "win32" && (info.mode & 0o022) !== 0) ||
    realpathSync.native(path) !== resolve(path)
  ) {
    throw new Error(
      `Refusing unsafe standalone upgrade recovery directory: ${path}`,
    );
  }
}

function assertTrustedPaths(
  executable: string,
  receiptPath: string,
  home: string,
  uid: number | undefined,
): void {
  const executableDirectory = dirname(executable);
  const receiptDirectory = dirname(receiptPath);
  assertTrustedDirectory(executableDirectory, uid, true);
  assertTrustedDirectory(receiptDirectory, uid, true);
  if (
    realpathSync.native(receiptDirectory) !==
    join(realpathSync.native(home), ".lore")
  ) {
    throw new Error(
      `Refusing standalone upgrade recovery outside the trusted state directory: ${receiptPath}`,
    );
  }
}

function receiptBindsExecutable(
  receipt: CapturedFile,
  executable: CapturedFile,
  executablePath: string,
  pathInstallDir: string,
): boolean {
  const parsed = parseInstallReceipt(receipt.content.toString("utf8"));
  return (
    parsed?.version === 3 &&
    parsed.executableIdentity !== undefined &&
    resolve(parsed.executable) === resolve(executablePath) &&
    parsed.pathInstallDir !== undefined &&
    resolve(parsed.pathInstallDir) === resolve(pathInstallDir) &&
    resolve(pathInstallDir) === resolve(dirname(executablePath)) &&
    identityEqual(parsed.executableIdentity, executable)
  );
}

function backupName(path: string, token: string): string {
  return `.${basename(path)}.upgrade-backup-${token}`;
}

function journalName(receiptPath: string, token: string): string {
  return `.${basename(receiptPath)}.upgrade-recovery-${token}.json`;
}

function tokenFromBackupName(path: string, name: string): string | null {
  const prefix = `.${basename(path)}.upgrade-backup-`;
  if (!name.startsWith(prefix)) return null;
  const token = name.slice(prefix.length);
  return BACKUP_TOKEN.test(token) ? token : null;
}

function tokenFromJournalName(
  receiptPath: string,
  name: string,
): string | null {
  const prefix = `.${basename(receiptPath)}.upgrade-recovery-`;
  if (!name.startsWith(prefix) || !name.endsWith(".json")) return null;
  const token = name.slice(prefix.length, -".json".length);
  return BACKUP_TOKEN.test(token) ? token : null;
}

function tokenFromTemporaryJournalName(
  receiptPath: string,
  name: string,
): string | null {
  const prefix = `.${basename(receiptPath)}.upgrade-recovery-`;
  if (!name.startsWith(prefix)) return null;
  const match = /^(\d+-[a-f0-9]{16})\.json\.temporary-\d+-[a-f0-9]{16}$/.exec(
    name.slice(prefix.length),
  );
  return match?.[1] ?? null;
}

function directoryEntries(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

export function standaloneUpgradeBackupTokens(
  executable: string,
): ReadonlySet<string> {
  const tokens = directoryEntries(dirname(executable))
    .map((name) => tokenFromBackupName(executable, name))
    .filter((token): token is string => token !== null);
  return new Set(tokens);
}

function inspectBackupPair(
  executable: string,
  receiptPath: string,
  token: string,
  uid: number | undefined,
): BackupPair | null {
  const executableBackup = join(
    dirname(executable),
    backupName(executable, token),
  );
  const receiptBackup = join(
    dirname(receiptPath),
    backupName(receiptPath, token),
  );
  const oldExecutable = captureFile(executableBackup, uid, false);
  const oldReceipt = captureFile(receiptBackup, uid, true);
  if (
    oldExecutable === null ||
    oldReceipt === null ||
    !receiptBindsExecutable(
      oldReceipt,
      oldExecutable,
      executable,
      dirname(executable),
    )
  ) {
    return null;
  }
  return {
    token,
    executable,
    receiptPath,
    pathInstallDir: dirname(executable),
    executableBackup,
    receiptBackup,
    oldExecutable,
    oldReceipt,
  };
}

function inspectBackupPairs(
  executable: string,
  receiptPath: string,
  uid: number | undefined,
): BackupPair[] {
  return [...standaloneUpgradeBackupTokens(executable)]
    .map((token) => inspectBackupPair(executable, receiptPath, token, uid))
    .filter((pair): pair is BackupPair => pair !== null);
}

function cleanupCoherentSingletonBackups(
  executable: string,
  receiptPath: string,
  executableFile: CapturedFile,
  receiptFile: CapturedFile,
  pairedTokens: ReadonlySet<string>,
  uid: number | undefined,
): number {
  let removed = 0;
  for (const name of directoryEntries(dirname(executable))) {
    const token = tokenFromBackupName(executable, name);
    if (token === null || pairedTokens.has(token)) continue;
    const path = join(dirname(executable), name);
    const artifact = captureFile(path, uid, false);
    if (artifact !== null && identityEqual(artifact, executableFile)) {
      removeIdentifiedFile(path, artifact, uid, false);
      removed++;
    }
  }
  for (const name of directoryEntries(dirname(receiptPath))) {
    const token = tokenFromBackupName(receiptPath, name);
    if (token === null || pairedTokens.has(token)) continue;
    const path = join(dirname(receiptPath), name);
    const artifact = captureFile(path, uid, true);
    if (artifact !== null && identityEqual(artifact, receiptFile)) {
      removeIdentifiedFile(path, artifact, uid, true);
      removed++;
    }
  }
  if (removed > 0)
    fsyncDirectories([dirname(executable), dirname(receiptPath)]);
  return removed;
}

function discardMatchingTemporaryJournals(
  recovery: RecoveryJournal,
  uid: number | undefined,
): void {
  for (const name of directoryEntries(dirname(recovery.receiptPath))) {
    if (
      tokenFromTemporaryJournalName(recovery.receiptPath, name) !==
      recovery.token
    ) {
      continue;
    }
    const path = join(dirname(recovery.receiptPath), name);
    const temporary = captureFile(path, uid, true);
    if (
      temporary !== null &&
      identityEqual(temporary, recovery.journalIdentity)
    ) {
      removeIdentifiedFile(path, temporary, uid, true);
    }
  }
}

function fsyncFile(path: string): void {
  let descriptor: number | null = null;
  try {
    const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
    descriptor = openSync(path, constants.O_RDONLY | noFollow);
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function fsyncDirectory(path: string): void {
  if (process.platform === "win32") return;
  let descriptor: number | null = null;
  try {
    descriptor = openSync(path, constants.O_RDONLY);
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function fsyncDirectories(paths: string[]): void {
  for (const path of new Set(paths)) fsyncDirectory(path);
}

function writeJournal(
  pair: BackupPair,
  mode: RecoveryMode,
  replacement: ExecutableIdentity,
  uid: number | undefined,
): RecoveryJournal {
  const journalPath = join(
    dirname(pair.receiptPath),
    journalName(pair.receiptPath, pair.token),
  );
  const data: RecoveryJournalData = {
    version: JOURNAL_VERSION,
    mode,
    token: pair.token,
    executable: pair.executable,
    receiptPath: pair.receiptPath,
    pathInstallDir: pair.pathInstallDir,
    executableBackup: pair.executableBackup,
    receiptBackup: pair.receiptBackup,
    oldExecutable: serializeIdentity(pair.oldExecutable),
    oldReceipt: serializeIdentity(pair.oldReceipt),
    replacement: serializeIdentity(replacement),
  };
  const content = `${JSON.stringify(data)}\n`;
  const existing = captureFile(journalPath, uid, true);
  if (existing !== null) {
    if (existing.content.toString("utf8") !== content) {
      throw new Error(
        `Standalone upgrade recovery journal changed: ${journalPath}`,
      );
    }
    return {
      ...pair,
      mode,
      replacement,
      journalPath,
      journalIdentity: existing,
    };
  }

  fsyncDirectories([
    dirname(pair.executableBackup),
    dirname(pair.receiptBackup),
  ]);
  const temporary = join(
    dirname(journalPath),
    `.${basename(journalPath)}.temporary-${process.pid}-${randomBytes(8).toString("hex")}`,
  );
  let descriptor: number | null = null;
  let operationError: unknown;
  try {
    descriptor = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    writeFileSync(descriptor, content, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    linkSync(temporary, journalPath);
    fsyncDirectory(dirname(journalPath));
  } catch (error) {
    operationError = error;
  } finally {
    if (descriptor !== null) closeSync(descriptor);
    try {
      unlinkSync(temporary);
      fsyncDirectory(dirname(temporary));
    } catch (error) {
      if (
        operationError === undefined &&
        (error as NodeJS.ErrnoException).code !== "ENOENT"
      ) {
        operationError = error;
      }
    }
  }
  if (operationError !== undefined) throw operationError;
  const journal = captureFile(journalPath, uid, true);
  if (journal === null || journal.content.toString("utf8") !== content) {
    throw new Error(
      `Could not verify standalone upgrade recovery journal: ${journalPath}`,
    );
  }
  return {
    ...pair,
    mode,
    replacement,
    journalPath,
    journalIdentity: journal,
  };
}

export function persistStandaloneUpgradeRecoveryJournal(
  input: PersistStandaloneUpgradeRecoveryInput,
): string {
  if (!/^[a-f0-9]{64}$/.test(input.expectedReplacementSha256)) {
    throw new Error("Refusing invalid standalone upgrade replacement hash");
  }
  const home = input.home ?? homedir();
  const uid = input.uid ?? process.getuid?.();
  assertTrustedPaths(input.executable, input.receiptPath, home, uid);
  const previous = input.previousBackupTokens ?? new Set<string>();
  const candidates = inspectBackupPairs(
    input.executable,
    input.receiptPath,
    uid,
  ).filter(
    (pair) =>
      !previous.has(pair.token) &&
      identityEqual(pair.oldExecutable, input.oldExecutable) &&
      identityEqual(pair.oldReceipt, input.oldReceipt) &&
      resolve(pair.pathInstallDir) === resolve(input.pathInstallDir),
  );
  if (candidates.length !== 1) {
    throw new Error(
      `Could not identify one newly staged standalone upgrade backup pair (found ${candidates.length})`,
    );
  }
  fsyncFile(input.replacementPath);
  const replacement = captureFile(input.replacementPath, uid, false);
  if (
    replacement === null ||
    replacement.sha256 !== input.expectedReplacementSha256 ||
    identityEqual(replacement, input.oldExecutable)
  ) {
    throw new Error(
      `Could not authenticate the staged standalone upgrade replacement: ${input.replacementPath}`,
    );
  }
  return writeJournal(candidates[0], "complete", replacement, uid).journalPath;
}

function parseJournal(
  journalPath: string,
  token: string,
  executable: string,
  receiptPath: string,
  uid: number | undefined,
): RecoveryJournal {
  const journal = captureFile(journalPath, uid, true);
  if (journal === null) {
    throw new Error(
      `Standalone upgrade recovery journal is not an owner-only regular file: ${journalPath}`,
    );
  }
  let data: Partial<RecoveryJournalData>;
  try {
    data = JSON.parse(
      journal.content.toString("utf8"),
    ) as Partial<RecoveryJournalData>;
  } catch (error) {
    throw new Error(
      `Standalone upgrade recovery journal is malformed: ${journalPath}`,
      {
        cause: error,
      },
    );
  }
  const oldExecutable = deserializeIdentity(data.oldExecutable);
  const oldReceipt = deserializeIdentity(data.oldReceipt);
  const replacement = deserializeIdentity(data.replacement);
  const expectedExecutableBackup = join(
    dirname(executable),
    backupName(executable, token),
  );
  const expectedReceiptBackup = join(
    dirname(receiptPath),
    backupName(receiptPath, token),
  );
  if (
    data.version !== JOURNAL_VERSION ||
    (data.mode !== "complete" && data.mode !== "rollback") ||
    data.token !== token ||
    typeof data.executable !== "string" ||
    resolve(data.executable) !== resolve(executable) ||
    typeof data.receiptPath !== "string" ||
    resolve(data.receiptPath) !== resolve(receiptPath) ||
    typeof data.pathInstallDir !== "string" ||
    resolve(data.pathInstallDir) !== resolve(dirname(executable)) ||
    data.executableBackup !== expectedExecutableBackup ||
    data.receiptBackup !== expectedReceiptBackup ||
    oldExecutable === null ||
    oldReceipt === null ||
    replacement === null
  ) {
    throw new Error(
      `Standalone upgrade recovery journal fields are invalid: ${journalPath}`,
    );
  }

  const executableBackup = captureFile(expectedExecutableBackup, uid, false);
  const receiptBackup = captureFile(expectedReceiptBackup, uid, true);
  if (
    (executableBackup !== null &&
      !identityEqual(executableBackup, oldExecutable)) ||
    (receiptBackup !== null && !identityEqual(receiptBackup, oldReceipt))
  ) {
    throw new Error(
      `Standalone upgrade recovery artifact changed; refusing recovery for ${executable}`,
    );
  }
  if (receiptBackup !== null) {
    const executableForBinding = executableBackup ?? {
      ...oldExecutable,
      content: Buffer.alloc(0),
    };
    const parsed = parseInstallReceipt(receiptBackup.content.toString("utf8"));
    if (
      parsed?.version !== 3 ||
      parsed.executableIdentity === undefined ||
      resolve(parsed.executable) !== resolve(executable) ||
      resolve(parsed.pathInstallDir ?? "") !== resolve(dirname(executable)) ||
      !identityEqual(parsed.executableIdentity, executableForBinding)
    ) {
      throw new Error(
        `Standalone upgrade receipt backup is not identity-bound: ${expectedReceiptBackup}`,
      );
    }
  }
  return {
    token,
    executable,
    receiptPath,
    pathInstallDir: dirname(executable),
    executableBackup: expectedExecutableBackup,
    receiptBackup: expectedReceiptBackup,
    oldExecutable,
    oldReceipt,
    mode: data.mode,
    replacement,
    journalPath,
    journalIdentity: journal,
  };
}

function inspectJournals(
  executable: string,
  receiptPath: string,
  uid: number | undefined,
): RecoveryJournal[] {
  const journals: RecoveryJournal[] = [];
  for (const name of directoryEntries(dirname(receiptPath))) {
    const token = tokenFromJournalName(receiptPath, name);
    if (token === null) continue;
    journals.push(
      parseJournal(
        join(dirname(receiptPath), name),
        token,
        executable,
        receiptPath,
        uid,
      ),
    );
  }
  return journals;
}

function recoverTemporaryJournals(
  executable: string,
  receiptPath: string,
  uid: number | undefined,
): void {
  const temporaryByToken = new Map<string, string[]>();
  for (const name of directoryEntries(dirname(receiptPath))) {
    const token = tokenFromTemporaryJournalName(receiptPath, name);
    if (token === null) continue;
    const paths = temporaryByToken.get(token) ?? [];
    paths.push(join(dirname(receiptPath), name));
    temporaryByToken.set(token, paths);
  }
  for (const [token, paths] of temporaryByToken) {
    if (paths.length !== 1) {
      throw new Error(
        `Multiple temporary standalone upgrade journals exist for ${token}; no artifact was consumed`,
      );
    }
    const temporaryPath = paths[0];
    let temporary: RecoveryJournal;
    try {
      temporary = parseJournal(
        temporaryPath,
        token,
        executable,
        receiptPath,
        uid,
      );
    } catch {
      continue;
    }
    const canonicalPath = join(
      dirname(receiptPath),
      journalName(receiptPath, token),
    );
    const canonical = captureFile(canonicalPath, uid, true);
    if (canonical === null) {
      if (existsSync(canonicalPath)) {
        throw new Error(
          `Standalone upgrade recovery journal is not trusted: ${canonicalPath}`,
        );
      }
      linkSync(temporaryPath, canonicalPath);
      fsyncDirectory(dirname(canonicalPath));
      assertIdentity(canonicalPath, temporary.journalIdentity, uid, true);
    } else if (!identityEqual(canonical, temporary.journalIdentity)) {
      throw new Error(
        `Temporary standalone upgrade journal conflicts with ${canonicalPath}`,
      );
    }
    removeIdentifiedFile(temporaryPath, temporary.journalIdentity, uid, true);
    fsyncDirectory(dirname(temporaryPath));
  }
}

function assertIdentity(
  path: string,
  expected: ExecutableIdentity,
  uid: number | undefined,
  ownerOnly: boolean,
): CapturedFile {
  const current = captureFile(path, uid, ownerOnly);
  if (current === null || !identityEqual(current, expected)) {
    throw new Error(`Standalone upgrade recovery artifact changed: ${path}`);
  }
  return current;
}

function removeIdentifiedFile(
  path: string,
  expected: ExecutableIdentity,
  uid: number | undefined,
  ownerOnly: boolean,
): void {
  if (!existsSync(path)) return;
  assertIdentity(path, expected, uid, ownerOnly);
  unlinkSync(path);
}

function durableCoherentPair(
  executable: string,
  receiptPath: string,
  uid: number | undefined,
): { executable: CapturedFile; receipt: CapturedFile } {
  const executableFile = captureFile(executable, uid, false);
  const receiptFile = captureFile(receiptPath, uid, true);
  if (
    executableFile === null ||
    receiptFile === null ||
    !receiptBindsExecutable(
      receiptFile,
      executableFile,
      executable,
      dirname(executable),
    )
  ) {
    throw new Error(
      "Standalone upgrade recovery did not establish a coherent executable and receipt",
    );
  }
  fsyncFile(executable);
  fsyncFile(receiptPath);
  fsyncDirectories([dirname(executable), dirname(receiptPath)]);
  const verifiedExecutable = captureFile(executable, uid, false);
  const verifiedReceipt = captureFile(receiptPath, uid, true);
  if (
    verifiedExecutable === null ||
    verifiedReceipt === null ||
    !identityEqual(verifiedExecutable, executableFile) ||
    !identityEqual(verifiedReceipt, receiptFile)
  ) {
    throw new Error(
      "Standalone executable or receipt changed during recovery durability verification",
    );
  }
  return { executable: verifiedExecutable, receipt: verifiedReceipt };
}

function recoveryScratchPath(
  executable: string,
  kind: "displaced" | "publish",
  token: string,
): string {
  return join(
    dirname(executable),
    `.${basename(executable)}.upgrade-recovery-${kind}-${token}`,
  );
}

function ensureHardLink(
  source: string,
  destination: string,
  expected: ExecutableIdentity,
  uid: number | undefined,
  ownerOnly: boolean,
): void {
  try {
    linkSync(source, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  assertIdentity(destination, expected, uid, ownerOnly);
}

function restoreOldGeneration(
  recovery: RecoveryJournal,
  currentExecutable: CapturedFile | null,
  currentReceipt: CapturedFile | null,
  uid: number | undefined,
): void {
  if (currentReceipt === null) {
    assertIdentity(recovery.receiptBackup, recovery.oldReceipt, uid, true);
    ensureHardLink(
      recovery.receiptBackup,
      recovery.receiptPath,
      recovery.oldReceipt,
      uid,
      true,
    );
    fsyncDirectory(dirname(recovery.receiptPath));
  } else if (!identityEqual(currentReceipt, recovery.oldReceipt)) {
    if (
      receiptBindsExecutable(
        currentReceipt,
        assertIdentity(
          recovery.executableBackup,
          recovery.oldExecutable,
          uid,
          false,
        ),
        recovery.executable,
        recovery.pathInstallDir,
      )
    ) {
      throw new Error(
        "Standalone receipt content matches the recovery generation but its inode was replaced; artifacts were preserved",
      );
    }
    assertIdentity(recovery.receiptBackup, recovery.oldReceipt, uid, true);
    const displacedReceipt = recoveryScratchPath(
      recovery.receiptPath,
      "displaced",
      recovery.token,
    );
    ensureHardLink(
      recovery.receiptPath,
      displacedReceipt,
      currentReceipt,
      uid,
      true,
    );
    const publishReceipt = recoveryScratchPath(
      recovery.receiptPath,
      "publish",
      recovery.token,
    );
    ensureHardLink(
      recovery.receiptBackup,
      publishReceipt,
      recovery.oldReceipt,
      uid,
      true,
    );
    fsyncDirectory(dirname(recovery.receiptPath));
    assertIdentity(recovery.receiptPath, currentReceipt, uid, true);
    renameSync(publishReceipt, recovery.receiptPath);
    assertIdentity(recovery.receiptPath, recovery.oldReceipt, uid, true);
    fsyncDirectory(dirname(recovery.receiptPath));
  }

  if (currentExecutable === null) {
    assertIdentity(
      recovery.executableBackup,
      recovery.oldExecutable,
      uid,
      false,
    );
    ensureHardLink(
      recovery.executableBackup,
      recovery.executable,
      recovery.oldExecutable,
      uid,
      false,
    );
    fsyncDirectory(dirname(recovery.executable));
    return;
  }
  if (identityEqual(currentExecutable, recovery.oldExecutable)) return;

  assertIdentity(recovery.executableBackup, recovery.oldExecutable, uid, false);
  const displaced = recoveryScratchPath(
    recovery.executable,
    "displaced",
    recovery.token,
  );
  ensureHardLink(recovery.executable, displaced, currentExecutable, uid, false);
  const publish = recoveryScratchPath(
    recovery.executable,
    "publish",
    recovery.token,
  );
  ensureHardLink(
    recovery.executableBackup,
    publish,
    recovery.oldExecutable,
    uid,
    false,
  );
  fsyncDirectory(dirname(recovery.executable));
  assertIdentity(recovery.executable, currentExecutable, uid, false);
  renameSync(publish, recovery.executable);
  assertIdentity(recovery.executable, recovery.oldExecutable, uid, false);
  fsyncDirectory(dirname(recovery.executable));
}

function cleanupRecovery(
  recovery: RecoveryJournal,
  coherentExecutable: CapturedFile,
  coherentReceipt: CapturedFile,
  uid: number | undefined,
): void {
  removeIdentifiedFile(
    recovery.executableBackup,
    recovery.oldExecutable,
    uid,
    false,
  );
  removeIdentifiedFile(recovery.receiptBackup, recovery.oldReceipt, uid, true);

  const publish = recoveryScratchPath(
    recovery.executable,
    "publish",
    recovery.token,
  );
  removeIdentifiedFile(publish, recovery.oldExecutable, uid, false);
  const displaced = recoveryScratchPath(
    recovery.executable,
    "displaced",
    recovery.token,
  );
  const displacedFile = captureFile(displaced, uid, false);
  if (
    displacedFile !== null &&
    recovery.mode === "complete" &&
    identityEqual(displacedFile, recovery.replacement)
  ) {
    removeIdentifiedFile(displaced, displacedFile, uid, false);
  }
  const receiptPublish = recoveryScratchPath(
    recovery.receiptPath,
    "publish",
    recovery.token,
  );
  removeIdentifiedFile(receiptPublish, recovery.oldReceipt, uid, true);

  const downloadPath = `${recovery.executable}.download`;
  const retainedDownload = captureFile(downloadPath, uid, false);
  if (
    retainedDownload !== null &&
    (identityEqual(retainedDownload, coherentExecutable) ||
      (recovery.mode === "complete" &&
        identityEqual(retainedDownload, recovery.replacement)))
  ) {
    removeIdentifiedFile(downloadPath, retainedDownload, uid, false);
  }

  for (const name of directoryEntries(dirname(recovery.executable))) {
    const path = join(dirname(recovery.executable), name);
    if (
      name.startsWith(`${basename(recovery.executable)}.upgrade-displaced-`)
    ) {
      const artifact = captureFile(path, uid, false);
      if (
        artifact !== null &&
        identityEqual(artifact, recovery.oldExecutable)
      ) {
        removeIdentifiedFile(path, artifact, uid, false);
      }
    }
  }
  for (const name of directoryEntries(dirname(recovery.receiptPath))) {
    const path = join(dirname(recovery.receiptPath), name);
    if (
      name.startsWith(`${basename(recovery.receiptPath)}.upgrade-displaced-`)
    ) {
      const artifact = captureFile(path, uid, true);
      if (artifact !== null && identityEqual(artifact, recovery.oldReceipt)) {
        removeIdentifiedFile(path, artifact, uid, true);
      }
    }
    if (
      name.startsWith(`.${basename(recovery.receiptPath)}.upgrade-`) &&
      /^\d+-[a-f0-9]{16}$/.test(
        name.slice(`.${basename(recovery.receiptPath)}.upgrade-`.length),
      )
    ) {
      const artifact = captureFile(path, uid, true);
      if (artifact !== null && identityEqual(artifact, coherentReceipt)) {
        removeIdentifiedFile(path, artifact, uid, true);
      }
    }
  }

  fsyncDirectories([
    dirname(recovery.executable),
    dirname(recovery.receiptPath),
  ]);
  discardMatchingTemporaryJournals(recovery, uid);
  removeIdentifiedFile(
    recovery.journalPath,
    recovery.journalIdentity,
    uid,
    true,
  );
  fsyncDirectory(dirname(recovery.journalPath));
}

function journalForLegacyPair(
  pair: BackupPair,
  uid: number | undefined,
): RecoveryJournal {
  return writeJournal(pair, "rollback", pair.oldExecutable, uid);
}

function invokedBackupCandidate(
  invokedExecutable: string,
  receiptPath: string,
  uid: number | undefined,
): { executable: string; token: string } | null {
  const name = basename(invokedExecutable);
  const marker = ".upgrade-backup-";
  const markerIndex = name.lastIndexOf(marker);
  if (!name.startsWith(".") || markerIndex <= 1) return null;
  const token = name.slice(markerIndex + marker.length);
  if (!BACKUP_TOKEN.test(token)) return null;
  const executable = join(
    dirname(invokedExecutable),
    name.slice(1, markerIndex),
  );
  const pair = inspectBackupPair(executable, receiptPath, token, uid);
  if (
    pair === null ||
    resolve(pair.executableBackup) !== resolve(invokedExecutable)
  ) {
    return null;
  }
  return { executable, token };
}

/** Recover an interrupted standalone publication before provenance is checked. */
export function recoverStandaloneUpgradePublication(
  options: StandaloneUpgradeRecoveryOptions,
): StandaloneUpgradeRecoveryResult {
  const home = options.home ?? homedir();
  const uid = options.uid ?? process.getuid?.();
  const receiptPath =
    options.receiptPath ?? join(home, ".lore", "install-path");
  const backupInvocation = invokedBackupCandidate(
    options.executable,
    receiptPath,
    uid,
  );
  const executable = backupInvocation?.executable ?? options.executable;

  const hasPossibleArtifacts =
    standaloneUpgradeBackupTokens(executable).size > 0 ||
    directoryEntries(dirname(receiptPath)).some(
      (name) => tokenFromJournalName(receiptPath, name) !== null,
    );
  if (!hasPossibleArtifacts) return { executable, action: "none" };

  assertTrustedPaths(executable, receiptPath, home, uid);
  recoverTemporaryJournals(executable, receiptPath, uid);
  const journals = inspectJournals(executable, receiptPath, uid);
  const pairs = inspectBackupPairs(executable, receiptPath, uid);
  const currentExecutable = captureFile(executable, uid, false);
  const currentReceipt = captureFile(receiptPath, uid, true);
  const coherent =
    currentExecutable !== null &&
    currentReceipt !== null &&
    receiptBindsExecutable(
      currentReceipt,
      currentExecutable,
      executable,
      dirname(executable),
    );

  if (coherent) {
    if (journals.length > 1) {
      throw new Error(
        "Multiple standalone upgrade recovery journals are present; no artifacts were consumed",
      );
    }
    if (
      journals.length === 1 &&
      pairs.some((pair) => pair.token !== journals[0].token)
    ) {
      throw new Error(
        "Standalone upgrade recovery journal is ambiguous with another valid backup generation; no artifacts were consumed",
      );
    }
    const durable = durableCoherentPair(executable, receiptPath, uid);
    const recoveries = [...journals];
    for (const pair of pairs) {
      if (!recoveries.some((journal) => journal.token === pair.token)) {
        recoveries.push(journalForLegacyPair(pair, uid));
      }
    }
    for (const recovery of recoveries) {
      cleanupRecovery(recovery, durable.executable, durable.receipt, uid);
    }
    const removedSingletons = cleanupCoherentSingletonBackups(
      executable,
      receiptPath,
      durable.executable,
      durable.receipt,
      new Set(recoveries.map((recovery) => recovery.token)),
      uid,
    );
    return {
      executable,
      action:
        recoveries.length > 0 || removedSingletons > 0 ? "cleaned" : "none",
    };
  }

  let recovery: RecoveryJournal | undefined;
  if (journals.length > 0) {
    const matching = journals.filter(
      (journal) =>
        (currentReceipt !== null &&
          identityEqual(currentReceipt, journal.oldReceipt)) ||
        (currentExecutable !== null &&
          journal.mode === "complete" &&
          identityEqual(currentExecutable, journal.replacement)) ||
        (currentExecutable === null && currentReceipt === null) ||
        (backupInvocation !== null && journal.token === backupInvocation.token),
    );
    if (matching.length === 1) recovery = matching[0];
    else if (journals.length === 1) recovery = journals[0];
  }
  if (recovery === undefined) {
    const matchingPairs = pairs.filter(
      (pair) =>
        (currentReceipt !== null &&
          identityEqual(currentReceipt, pair.oldReceipt)) ||
        currentExecutable === null ||
        (backupInvocation !== null && pair.token === backupInvocation.token),
    );
    if (matchingPairs.length === 1) {
      recovery = journalForLegacyPair(matchingPairs[0], uid);
    }
  }
  if (recovery === undefined) {
    throw new Error(
      "Interrupted standalone upgrade artifacts do not authenticate one recovery generation; no files were changed",
    );
  }

  if (currentExecutable === null && backupInvocation === null) {
    throw new Error(
      "Canonical standalone executable is missing; invoke the authenticated upgrade backup path to recover it",
    );
  }

  if (
    recovery.mode === "complete" &&
    currentExecutable !== null &&
    identityEqual(currentExecutable, recovery.replacement)
  ) {
    if (currentReceipt === null) {
      recoverReplacementInstallReceipt(
        executable,
        receiptPath,
        dirname(executable),
        home,
        uid,
      );
    } else if (identityEqual(currentReceipt, recovery.oldReceipt)) {
      refreshStandaloneInstallReceipt({
        executable,
        executableSha256: recovery.replacement.sha256,
        receiptPath,
        receiptIdentity: recovery.oldReceipt,
        pathInstallDir: dirname(executable),
        home,
        uid,
      });
    } else {
      restoreOldGeneration(recovery, currentExecutable, currentReceipt, uid);
      const durable = durableCoherentPair(executable, receiptPath, uid);
      cleanupRecovery(recovery, durable.executable, durable.receipt, uid);
      return { executable, action: "restored" };
    }
    const durable = durableCoherentPair(executable, receiptPath, uid);
    cleanupRecovery(recovery, durable.executable, durable.receipt, uid);
    return { executable, action: "completed" };
  }

  restoreOldGeneration(recovery, currentExecutable, currentReceipt, uid);
  const durable = durableCoherentPair(executable, receiptPath, uid);
  cleanupRecovery(recovery, durable.executable, durable.receipt, uid);
  return { executable, action: "restored" };
}

/** Verify and flush the published pair before any recovery link is removed. */
export function verifyStandaloneUpgradePublicationDurable(input: {
  executable: string;
  receiptPath: string;
  home?: string;
  uid?: number;
}): void {
  const home = input.home ?? homedir();
  const uid = input.uid ?? process.getuid?.();
  assertTrustedPaths(input.executable, input.receiptPath, home, uid);
  durableCoherentPair(input.executable, input.receiptPath, uid);
}
