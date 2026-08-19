import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { basename, join, win32 } from "node:path";
import { dataDir } from "@loreai/core";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const WINDOWS_PRIVATE_MARKER = "LORE_RUNTIME_ACL_PRIVATE";
const WINDOWS_ACL_TIMEOUT_MS = 15_000;

type RuntimeFileKind = "directory" | "file";
type RuntimeFileWindowsSecurityAction = "secure" | "verify";

export interface RuntimeFileWindowsSecurityRequest {
  path: string;
  kind: RuntimeFileKind;
  action: RuntimeFileWindowsSecurityAction;
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

export interface RuntimeFileWindowsSecurityResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

interface RuntimeFileWindowsSecurityTestHooks {
  platform?: NodeJS.Platform;
  powershellPath?: string;
  run?: (
    request: RuntimeFileWindowsSecurityRequest,
  ) => RuntimeFileWindowsSecurityResult;
}

let windowsSecurityTestHooks: RuntimeFileWindowsSecurityTestHooks | undefined;

/** @internal Deterministic Windows-security seam for non-Windows unit tests. */
export function _setRuntimeFileWindowsSecurityForTest(
  hooks: RuntimeFileWindowsSecurityTestHooks | null,
): void {
  windowsSecurityTestHooks = hooks ?? undefined;
}

/*
 * Windows ignores POSIX creation modes. Use Windows' supported ACL APIs to
 * replace inheritance with one full-control ACE for the current user's SID,
 * then independently verify the resulting descriptor. The path is supplied in
 * the child environment rather than interpolated into this script, so spaces,
 * quotes, metacharacters, and non-ASCII usernames remain data rather than code.
 *
 * The ancestor checks reject reparse points and any non-privileged principal
 * that can delete, replace, or rewrite an ancestor ACL. Once those checks pass,
 * another local user cannot swap the validated object during the remaining
 * lstat/ACL/open sequence; same-user and administrator attacks are outside an
 * owner-only confidentiality boundary on both Windows and Unix.
 */
const WINDOWS_ACL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$path = [Environment]::GetEnvironmentVariable('LORE_RUNTIME_ACL_PATH', 'Process')
$kind = [Environment]::GetEnvironmentVariable('LORE_RUNTIME_ACL_KIND', 'Process')
$action = [Environment]::GetEnvironmentVariable('LORE_RUNTIME_ACL_ACTION', 'Process')
if ([String]::IsNullOrWhiteSpace($path)) { throw 'runtime ACL path is missing' }
if ($kind -ne 'directory' -and $kind -ne 'file') { throw 'runtime ACL kind is invalid' }
if ($action -ne 'secure' -and $action -ne 'verify') { throw 'runtime ACL action is invalid' }

$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
if ($null -eq $sid) { throw 'current Windows SID is unavailable' }
$trustedSids = @(
  $sid.Value,
  'S-1-5-18',
  'S-1-5-32-544',
  'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'
)
$dangerousAncestorRights =
  [Security.AccessControl.FileSystemRights]::Delete -bor
  [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
  [Security.AccessControl.FileSystemRights]::ChangePermissions -bor
  [Security.AccessControl.FileSystemRights]::TakeOwnership

function Assert-NotReparsePoint($item) {
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "runtime path contains a reparse point: $($item.FullName)"
  }
}

function Assert-StableAncestors($leaf) {
  $item = $leaf.Parent
  while ($null -ne $item) {
    Assert-NotReparsePoint $item
    $acl = [IO.Directory]::GetAccessControl($item.FullName)
    $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    if ($trustedSids -notcontains $owner) {
      throw "runtime path has an untrusted ancestor owner: $($item.FullName)"
    }
    $rules = @($acl.GetAccessRules(
      $true,
      $true,
      [Security.Principal.SecurityIdentifier]
    ))
    foreach ($rule in $rules) {
      $inheritOnly =
        ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0
      if (
        -not $inheritOnly -and
        $rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
        $trustedSids -notcontains $rule.IdentityReference.Value -and
        ($rule.FileSystemRights -band $dangerousAncestorRights) -ne 0
      ) {
        throw "runtime path has a replaceable ancestor: $($item.FullName)"
      }
    }
    $item = $item.Parent
  }
}

function Get-RuntimeItem {
  $item = if ($kind -eq 'directory') {
    [IO.DirectoryInfo]::new($path)
  } else {
    [IO.FileInfo]::new($path)
  }
  $item.Refresh()
  if (-not $item.Exists) { throw 'runtime ACL path does not exist' }
  return $item
}

$item = Get-RuntimeItem
Assert-NotReparsePoint $item
Assert-StableAncestors $item

if ($action -eq 'secure') {
  if ($kind -eq 'directory') {
    $newAcl = [Security.AccessControl.DirectorySecurity]::new()
    $inheritance =
      [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
      [Security.AccessControl.InheritanceFlags]::ObjectInherit
  } else {
    $newAcl = [Security.AccessControl.FileSecurity]::new()
    $inheritance = [Security.AccessControl.InheritanceFlags]::None
  }
  $newAcl.SetAccessRuleProtection($true, $false)
  $newAcl.SetOwner($sid)
  $rule = [Security.AccessControl.FileSystemAccessRule]::new(
    $sid,
    [Security.AccessControl.FileSystemRights]::FullControl,
    $inheritance,
    [Security.AccessControl.PropagationFlags]::None,
    [Security.AccessControl.AccessControlType]::Allow
  )
  [void]$newAcl.AddAccessRule($rule)
  if ($kind -eq 'directory') {
    [IO.Directory]::SetAccessControl($path, $newAcl)
  } else {
    [IO.File]::SetAccessControl($path, $newAcl)
  }
}

$item = Get-RuntimeItem
Assert-NotReparsePoint $item
Assert-StableAncestors $item
$actual = if ($kind -eq 'directory') {
  [IO.Directory]::GetAccessControl($path)
} else {
  [IO.File]::GetAccessControl($path)
}
$owner = $actual.GetOwner([Security.Principal.SecurityIdentifier]).Value
if ($owner -ne $sid.Value) { throw 'runtime ACL owner is not the current user' }
if (-not $actual.AreAccessRulesProtected) { throw 'runtime ACL remains inherited' }
$rules = @($actual.GetAccessRules(
  $true,
  $true,
  [Security.Principal.SecurityIdentifier]
))
if ($rules.Count -ne 1) { throw 'runtime ACL contains a broad access rule' }
$rule = $rules[0]
if ($rule.IsInherited) { throw 'runtime ACL contains an inherited access rule' }
if ($rule.IdentityReference.Value -ne $sid.Value) { throw 'runtime ACL grants another principal' }
if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) {
  throw 'runtime ACL contains a non-allow rule'
}
if ($rule.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl) {
  throw 'runtime ACL does not grant current-user full control'
}
$expectedInheritance = if ($kind -eq 'directory') {
  [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
  [Security.AccessControl.InheritanceFlags]::ObjectInherit
} else {
  [Security.AccessControl.InheritanceFlags]::None
}
if ($rule.InheritanceFlags -ne $expectedInheritance) {
  throw 'runtime ACL has unexpected inheritance flags'
}
if ($rule.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None) {
  throw 'runtime ACL has unexpected propagation flags'
}
[Console]::Out.WriteLine('${WINDOWS_PRIVATE_MARKER}')
`;

const WINDOWS_ACL_ARGS = [
  "-NoLogo",
  "-NoProfile",
  "-NonInteractive",
  "-ExecutionPolicy",
  "Bypass",
  "-EncodedCommand",
  Buffer.from(WINDOWS_ACL_SCRIPT, "utf16le").toString("base64"),
];

function runtimePlatform(): NodeJS.Platform {
  return windowsSecurityTestHooks?.platform ?? process.platform;
}

function noFollowFlag(): number {
  return runtimePlatform() === "win32" ? 0 : constants.O_NOFOLLOW;
}

function windowsPowerShellPath(): string {
  if (windowsSecurityTestHooks?.powershellPath) {
    return windowsSecurityTestHooks.powershellPath;
  }
  const windowsRoot = process.env.SystemRoot ?? process.env.WINDIR;
  if (!windowsRoot || !win32.isAbsolute(windowsRoot)) {
    throw new Error(
      "Windows runtime ACL enforcement is unavailable: SystemRoot is missing or invalid",
    );
  }
  return win32.join(
    windowsRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

function windowsSecurityEnvironment(
  path: string,
  kind: RuntimeFileKind,
  action: RuntimeFileWindowsSecurityAction,
): NodeJS.ProcessEnv {
  const reserved = new Set([
    "LORE_RUNTIME_ACL_PATH",
    "LORE_RUNTIME_ACL_KIND",
    "LORE_RUNTIME_ACL_ACTION",
  ]);
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!reserved.has(name.toUpperCase())) env[name] = value;
  }
  env.LORE_RUNTIME_ACL_PATH = path;
  env.LORE_RUNTIME_ACL_KIND = kind;
  env.LORE_RUNTIME_ACL_ACTION = action;
  return env;
}

function runWindowsSecurityCommand(
  request: RuntimeFileWindowsSecurityRequest,
): RuntimeFileWindowsSecurityResult {
  if (windowsSecurityTestHooks?.run) {
    return windowsSecurityTestHooks.run(request);
  }
  const result = spawnSync(request.command, request.args, {
    env: request.env,
    encoding: "utf8",
    windowsHide: true,
    shell: false,
    timeout: WINDOWS_ACL_TIMEOUT_MS,
  });
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    ...(result.error ? { error: result.error } : {}),
  };
}

function commandFailureDetail(
  result: RuntimeFileWindowsSecurityResult,
): string {
  return (result.stderr || result.stdout)
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 500);
}

function enforceWindowsPrivacy(
  path: string,
  kind: RuntimeFileKind,
  action: RuntimeFileWindowsSecurityAction,
): void {
  const request: RuntimeFileWindowsSecurityRequest = {
    path,
    kind,
    action,
    command: windowsPowerShellPath(),
    args: [...WINDOWS_ACL_ARGS],
    env: windowsSecurityEnvironment(path, kind, action),
  };
  const result = runWindowsSecurityCommand(request);
  if (result.error) {
    throw new Error(
      `Windows runtime ACL command failed for ${path}: ${result.error.message}`,
      { cause: result.error },
    );
  }
  if (result.status !== 0 || result.signal !== null) {
    const detail = commandFailureDetail(result);
    throw new Error(
      `Windows runtime ACL ${action} failed for ${path}${detail ? `: ${detail}` : ""}`,
    );
  }
  if (result.stdout.trim() !== WINDOWS_PRIVATE_MARKER) {
    throw new Error(
      `Windows runtime ACL ${action} returned unverifiable output for ${path}`,
    );
  }
}

function assertRuntimeFileName(name: string): void {
  if (name.length === 0 || name !== basename(name) || name === ".") {
    throw new Error(`Invalid runtime file name: ${name}`);
  }
}

function assertCurrentOwner(info: Stats, path: string): void {
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new Error(
      `Refusing runtime path not owned by the current user: ${path}`,
    );
  }
}

function assertRegularFile(info: Stats, path: string): void {
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`Refusing non-regular runtime file: ${path}`);
  }
  assertCurrentOwner(info, path);
}

function assertSameFile(before: Stats, after: Stats, path: string): void {
  if (before.dev !== after.dev || before.ino !== after.ino) {
    throw new Error(`Runtime file changed while opening: ${path}`);
  }
}

function validateRuntimeDataDir(
  dir: string,
  windowsAction: RuntimeFileWindowsSecurityAction = "verify",
): void {
  const pathInfo = lstatSync(dir);
  if (pathInfo.isSymbolicLink() || !pathInfo.isDirectory()) {
    throw new Error(`Refusing non-directory runtime data path: ${dir}`);
  }
  assertCurrentOwner(pathInfo, dir);

  if (runtimePlatform() === "win32") {
    enforceWindowsPrivacy(dir, "directory", windowsAction);
    const finalInfo = lstatSync(dir);
    if (finalInfo.isSymbolicLink() || !finalInfo.isDirectory()) {
      throw new Error(`Refusing non-directory runtime data path: ${dir}`);
    }
    assertCurrentOwner(finalInfo, dir);
    assertSameFile(pathInfo, finalInfo, dir);
    return;
  }

  // Validate and tighten through an open descriptor. O_NOFOLLOW closes the
  // lstat/open race for the final path component, while O_DIRECTORY ensures a
  // replacement non-directory cannot be chmodded or subsequently trusted.
  const fd = openSync(
    dir,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const info = fstatSync(fd);
    if (!info.isDirectory()) {
      throw new Error(`Refusing non-directory runtime data path: ${dir}`);
    }
    assertCurrentOwner(info, dir);
    assertSameFile(pathInfo, info, dir);
    if ((info.mode & 0o777) !== DIRECTORY_MODE) {
      fchmodSync(fd, DIRECTORY_MODE);
    }
    const finalInfo = fstatSync(fd);
    if ((finalInfo.mode & 0o077) !== 0) {
      throw new Error(`Runtime data directory is not owner-only: ${dir}`);
    }
    assertSameFile(lstatSync(dir), finalInfo, dir);
  } finally {
    closeSync(fd);
  }
}

/** Create, validate, and tighten the gateway runtime data directory. */
export function ensureRuntimeDataDir(): string {
  const dir = dataDir();
  mkdirSync(dir, { recursive: true, mode: DIRECTORY_MODE });
  validateRuntimeDataDir(dir, "secure");
  return dir;
}

/** Validate an existing runtime directory without creating one. */
function existingRuntimeDataDir(): string {
  const dir = dataDir();
  validateRuntimeDataDir(dir);
  return dir;
}

/** Atomically replace a runtime record with an owner-only regular file. */
export function atomicWriteRuntimeFile(name: string, content: string): void {
  assertRuntimeFileName(name);
  const dir = ensureRuntimeDataDir();
  const path = join(dir, name);
  const temp = join(
    dir,
    `.${name}.${process.pid}.${randomBytes(12).toString("hex")}.tmp`,
  );
  let fd: number | undefined;
  try {
    fd = openSync(
      temp,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        noFollowFlag(),
      FILE_MODE,
    );
    const info = fstatSync(fd);
    assertRegularFile(info, temp);
    validateRuntimeDataDir(dir);
    if (runtimePlatform() === "win32") {
      enforceWindowsPrivacy(temp, "file", "secure");
      const securedInfo = lstatSync(temp);
      assertRegularFile(securedInfo, temp);
      assertSameFile(info, securedInfo, temp);
    } else {
      fchmodSync(fd, FILE_MODE);
    }
    writeFileSync(fd, content, "utf8");
    fsyncSync(fd);
    const completedFd = fd;
    fd = undefined;
    closeSync(completedFd);

    // The directory privacy and identity must still hold immediately before
    // the private temporary generation becomes the published record.
    validateRuntimeDataDir(dir);
    assertSameFile(info, lstatSync(temp), temp);

    // rename replaces a final symlink itself rather than following it and is
    // atomic because the temporary file lives in the same directory.
    renameSync(temp, path);
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(temp, { force: true });
  }
}

/** Read an owned regular runtime record without following its final symlink. */
export function readRuntimeFile(
  name: string,
  options: { ownerOnly?: boolean } = {},
): string {
  assertRuntimeFileName(name);
  const path = join(existingRuntimeDataDir(), name);
  const pathInfo = lstatSync(path);
  assertRegularFile(pathInfo, path);

  const fd = openSync(path, constants.O_RDONLY | noFollowFlag());
  try {
    const info = fstatSync(fd);
    assertRegularFile(info, path);
    validateRuntimeDataDir(dataDir());
    assertSameFile(pathInfo, info, path);
    if (runtimePlatform() === "win32") {
      enforceWindowsPrivacy(path, "file", "verify");
      const securedInfo = lstatSync(path);
      assertRegularFile(securedInfo, path);
      assertSameFile(info, securedInfo, path);
    }
    if (
      options.ownerOnly &&
      runtimePlatform() !== "win32" &&
      (info.mode & 0o077) !== 0
    ) {
      throw new Error(`Runtime file is not owner-only: ${path}`);
    }
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

/**
 * Open an owner-only regular runtime file for append without following its
 * final symlink. The returned descriptor is owned by the caller.
 */
export function openRuntimeFileForAppend(name: string): number {
  assertRuntimeFileName(name);
  const path = join(ensureRuntimeDataDir(), name);
  try {
    const existing = lstatSync(path);
    assertRegularFile(existing, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  // O_NONBLOCK prevents a raced-in FIFO from blocking before fstat rejects it.
  const fd = openSync(
    path,
    constants.O_WRONLY |
      constants.O_APPEND |
      constants.O_CREAT |
      constants.O_NONBLOCK |
      noFollowFlag(),
    FILE_MODE,
  );
  try {
    const info = fstatSync(fd);
    assertRegularFile(info, path);
    validateRuntimeDataDir(dataDir());
    try {
      assertSameFile(lstatSync(path), info, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`Runtime file changed while opening: ${path}`);
      }
      throw error;
    }
    if (runtimePlatform() === "win32") {
      enforceWindowsPrivacy(path, "file", "secure");
      const securedInfo = lstatSync(path);
      assertRegularFile(securedInfo, path);
      assertSameFile(info, securedInfo, path);
    } else {
      fchmodSync(fd, FILE_MODE);
    }
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}
