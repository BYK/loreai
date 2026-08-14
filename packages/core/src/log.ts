/**
 * Lightweight logger that suppresses informational messages by default.
 *
 * In TUI mode, all stderr output renders as red "error" text — confusing
 * for routine status messages like "incremental distillation" or "pruned
 * temporal messages". Only actual errors should be visible by default.
 *
 * Set LORE_DEBUG=1 to see informational messages (useful when debugging
 * the plugin itself).
 *
 * ## Sink registration
 *
 * An optional {@link LogSink} can be registered via {@link registerSink}.
 * When registered, every log call (regardless of `isDebug`) also forwards
 * to the sink. This is used by the gateway to bridge logs → Sentry without
 * adding a Sentry dependency to `@loreai/core`.
 *
 * ## File logging
 *
 * All log calls (info, warn, error) are written to a persistent log file
 * at `~/.local/share/lore/lore.log` regardless of `LORE_DEBUG`.
 * The file is rotated when it exceeds 5 MB (single `.log.1` backup).
 * Use `lore logs` to view; disabled during tests (`NODE_ENV=test`).
 */

import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { redactCredentialHeaderAssignments } from "./credential-headers";
import { join } from "node:path";
import { dataDir } from "./data-dir";

// ---------------------------------------------------------------------------
// Sink — optional external log consumer (e.g. Sentry)
// ---------------------------------------------------------------------------

/** External log consumer registered by the host (e.g. gateway → Sentry). */
export interface LogSink {
  info(message: string, attrs?: Record<string, unknown>): void;
  warn(message: string, attrs?: Record<string, unknown>): void;
  error(message: string, attrs?: Record<string, unknown>): void;
  captureException(err: unknown): void;
  /**
   * Optional DB-query tracer. When provided, the DB layer's tracing Proxy
   * (see `db/traced.ts`) routes every `get`/`run`/`all` execution through this
   * hook so the host can wrap it in a span (e.g. `Sentry.startSpan`). Keeping
   * this on the sink — rather than importing `@sentry/*` into core — preserves
   * the invariant that `@loreai/core` has zero Sentry dependencies.
   */
  withDbSpan?<T>(sql: string, fn: () => T): T;
}

let sink: LogSink | null = null;

/** Register an external log sink. Only one sink is supported at a time. */
export function registerSink(s: LogSink): void {
  sink = s;
}

/**
 * Route a DB query execution through the registered tracer, if any.
 *
 * 🔴 INVARIANT: when no sink (or no `withDbSpan`) is registered — the common
 * case for the CLI, tests, and the Pi extension — this is a transparent
 * pass-through: it calls `fn()` exactly once and returns its value verbatim,
 * with no wrapping and no behavioral change. The DB Proxy may call this on
 * every query, so the no-tracer path must stay allocation-free beyond one
 * optional-chain check.
 */
export function traceDbQuery<T>(sql: string, fn: () => T): T {
  return sink?.withDbSpan ? sink.withDbSpan(sql, fn) : fn();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Match the gateway config's `isTruthy` semantics: only "1" or "true" enable
// debug. The naive `!!process.env.LORE_DEBUG` treated `LORE_DEBUG=0` and
// `LORE_DEBUG=false` as ENABLED (non-empty strings are truthy), which meant a
// user who set `LORE_DEBUG=0` to silence Lore still got `[lore]` status lines
// printed to stderr — fatal inside a full-screen TUI (e.g. the Pi agent).
const isDebug =
  process.env.LORE_DEBUG === "1" ||
  process.env.LORE_DEBUG?.toLowerCase() === "true";

// ---------------------------------------------------------------------------
// Embedded / TUI-safe mode
// ---------------------------------------------------------------------------

// When the gateway runs *in-process* inside a host that owns a full-screen TUI
// — the Pi extension and the OpenCode plugin both `import("@loreai/gateway")`
// and call `startGateway()` rather than spawning a separate process — ANY byte
// written to stdout/stderr corrupts that TUI. This is the exact class of bug
// that broke Pi on Windows (raw `console.*` lines bleeding into the render),
// and `log.error` is just as fatal there as a stray `console.log`.
//
// The host enables this switch once, on activation, via `silenceStderr()`.
// From then on the logger writes ONLY to the persistent log file and the
// registered {@link LogSink} (e.g. Sentry) — NEVER to stderr, for every level
// including `error`, and even when `LORE_DEBUG=1`. The TUI is sacrosanct;
// operators read embedded-gateway logs with `lore logs` or by running the
// gateway standalone. Standalone `lore`/CLI processes never call this, so they
// keep full stderr visibility.
//
// 🔴 The flag lives on `globalThis`, NOT a module-level `let`. The in-process
// gateway can be a SECOND copy of @loreai/core: the gateway's Node/CJS bundle
// (`dist/index.cjs`) bundles core in, so it is a distinct module instance from
// the one the plugin imports (only the Bun bundle keeps core external — see
// gateway `script/bundle.ts`). A module-level flag set by the plugin's core
// instance would NOT be seen by the gateway's bundled core instance, leaving
// the in-process gateway's own `[lore]` lines writing to the TUI. `globalThis`
// is the single object shared across every core instance in the main thread,
// so one `silenceStderr()` call silences them all.
const STDERR_SILENCED_KEY = "__loreStderrSilenced";

function readStderrSilenced(): boolean {
  return (globalThis as Record<string, unknown>)[STDERR_SILENCED_KEY] === true;
}

/**
 * Silence ALL stderr output from the logger (`info`/`warn`/`notice`/`error`),
 * unconditionally — including when `LORE_DEBUG=1`. The file sink and the
 * registered {@link LogSink} keep receiving everything, so nothing is lost.
 *
 * Call this from a host that runs the gateway in-process inside a full-screen
 * TUI (the Pi extension, the OpenCode plugin). Process-global and idempotent,
 * so it is honored even by a separately-bundled core instance.
 */
export function silenceStderr(silenced = true): void {
  (globalThis as Record<string, unknown>)[STDERR_SILENCED_KEY] = silenced;
}

/** Whether stderr output is currently silenced (embedded/TUI mode). */
export function isStderrSilenced(): boolean {
  return readStderrSilenced();
}

/** Format variadic args into a single string for the sink. */
function formatArgs(args: unknown[]): string {
  return args
    .map((a) =>
      typeof a === "string" ? a : a instanceof Error ? a.message : String(a),
    )
    .join(" ");
}

/** Extract the first Error instance from the args list, if any. */
function findError(args: unknown[]): Error | undefined {
  for (const a of args) {
    if (a instanceof Error) return a;
  }
  return undefined;
}

const LOG_FILTERED = "[Filtered]";
const LOG_SENSITIVE_KEY = String.raw`(?:proxy[\s._-]*authorization|authorization|x[\s._-]*api[\s._-]*key|api[\s._-]*key|(?:api|access|auth|bearer|client|consumer|identity|private|refresh|security|subscription)[\s._-]*(?:id|key|secret|token)|ocp[\s._-]*apim[\s._-]*subscription[\s._-]*key|cf[\s._-]*access[\s._-]*client[\s._-]*id|set[\s._-]*cookie|(?:[a-z0-9]+[\s._-]+)*signatures?|token|secret|password|passwd|passphrase|credentials?|cookies?)`;

/**
 * Redact practical credential/header forms before text reaches stderr, an
 * external sink, or persistent storage. This deliberately preserves ordinary
 * operational text, paths, and entity names; raw response bodies are omitted
 * at their call sites because free-form text cannot identify them reliably.
 */
export function redactSensitiveLogText(value: string): string {
  return redactCredentialHeaderAssignments(value, LOG_FILTERED)
    .replace(
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
      LOG_FILTERED,
    )
    .replace(
      /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi,
      (match, scheme: string, offset: number, source: string) =>
        /(?:^|[\s._-])scheme\s*=\s*$/i.test(
          source.slice(Math.max(0, offset - 32), offset),
        )
          ? match
          : `${scheme} ${LOG_FILTERED}`,
    )
    .replace(
      new RegExp(
        String.raw`(^|[\r\n])([\t ]*(?:${LOG_SENSITIVE_KEY})[\t ]*:[\t ]*)[^\r\n]*`,
        "gi",
      ),
      `$1$2${LOG_FILTERED}`,
    )
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, LOG_FILTERED)
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, LOG_FILTERED)
    .replace(/\bAKIA[A-Z0-9]{16}\b/g, LOG_FILTERED)
    .replace(
      /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
      LOG_FILTERED,
    );
}

function safeArgs(args: unknown[]): string[] {
  return args.map((arg) =>
    redactSensitiveLogText(
      typeof arg === "string"
        ? arg
        : arg instanceof Error
          ? (arg.stack ?? arg.message)
          : String(arg),
    ),
  );
}

function sanitizedError(error: Error): Error {
  const copy = new Error(redactSensitiveLogText(error.message));
  copy.name = error.name;
  if (error.stack) copy.stack = redactSensitiveLogText(error.stack);
  return copy;
}

// ---------------------------------------------------------------------------
// File sink — persistent log file, independent of LORE_DEBUG
// ---------------------------------------------------------------------------

const LOG_MAX_BYTES = 5 * 1024 * 1024; // 5 MB
const ROTATION_CHECK_INTERVAL = 1000; // check size every N writes
const LOG_DIRECTORY_MODE = 0o700;
const LOG_FILE_MODE = 0o600;
const NO_FOLLOW = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;

let logPath: string | undefined;
let logPathResolved = false;
let writeCount = 0;

function assertCurrentOwner(info: Stats, path: string): void {
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new Error(`Refusing log path not owned by the current user: ${path}`);
  }
}

function assertSameFile(before: Stats, after: Stats, path: string): void {
  if (before.dev !== after.dev || before.ino !== after.ino) {
    throw new Error(`Log path changed while opening: ${path}`);
  }
}

function validateLogDirectory(dir: string): void {
  const pathInfo = lstatSync(dir);
  if (pathInfo.isSymbolicLink() || !pathInfo.isDirectory()) {
    throw new Error(`Refusing non-directory log data path: ${dir}`);
  }
  assertCurrentOwner(pathInfo, dir);

  if (process.platform === "win32") return;
  const fd = openSync(
    dir,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const info = fstatSync(fd);
    if (!info.isDirectory()) {
      throw new Error(`Refusing non-directory log data path: ${dir}`);
    }
    assertCurrentOwner(info, dir);
    assertSameFile(pathInfo, info, dir);
    if ((info.mode & 0o7777) !== LOG_DIRECTORY_MODE) {
      fchmodSync(fd, LOG_DIRECTORY_MODE);
    }
    const finalInfo = fstatSync(fd);
    if ((finalInfo.mode & 0o077) !== 0) {
      throw new Error(`Log data directory is not owner-only: ${dir}`);
    }
    assertSameFile(lstatSync(dir), finalInfo, dir);
  } finally {
    closeSync(fd);
  }
}

function openLogFileForAppend(path: string): number {
  let existing: Stats | undefined;
  try {
    existing = lstatSync(path);
    if (!existing.isFile() || existing.isSymbolicLink()) {
      throw new Error(`Refusing non-regular log file: ${path}`);
    }
    assertCurrentOwner(existing, path);
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
      NO_FOLLOW,
    LOG_FILE_MODE,
  );
  try {
    const info = fstatSync(fd);
    if (!info.isFile())
      throw new Error(`Refusing non-regular log file: ${path}`);
    assertCurrentOwner(info, path);
    validateLogDirectory(dataDir());
    assertSameFile(lstatSync(path), info, path);
    if (existing) assertSameFile(existing, info, path);
    if (process.platform !== "win32") fchmodSync(fd, LOG_FILE_MODE);
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function tightenExistingLogFile(path: string): void {
  const existing = lstatSync(path);
  if (!existing.isFile() || existing.isSymbolicLink()) {
    throw new Error(`Refusing non-regular log file: ${path}`);
  }
  assertCurrentOwner(existing, path);
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_APPEND | constants.O_NONBLOCK | NO_FOLLOW,
  );
  try {
    const info = fstatSync(fd);
    if (!info.isFile())
      throw new Error(`Refusing non-regular log file: ${path}`);
    assertCurrentOwner(info, path);
    assertSameFile(existing, info, path);
    if (process.platform !== "win32") fchmodSync(fd, LOG_FILE_MODE);
  } finally {
    closeSync(fd);
  }
}

function removeExistingRotationBackup(path: string): void {
  let existing: Stats;
  try {
    existing = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!existing.isFile() || existing.isSymbolicLink()) {
    throw new Error(`Refusing non-regular rotated log file: ${path}`);
  }
  assertCurrentOwner(existing, path);
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_NONBLOCK | NO_FOLLOW,
  );
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) {
      throw new Error(`Refusing non-regular rotated log file: ${path}`);
    }
    assertCurrentOwner(info, path);
    assertSameFile(existing, info, path);
    unlinkSync(path);
  } finally {
    closeSync(fd);
  }
}

/**
 * Resolve the log file path. Returns `undefined` in test environments
 * or if the directory cannot be created.
 */
function resolveLogPath(): string | undefined {
  if (process.env.NODE_ENV === "test") return undefined;
  try {
    const dir = dataDir();
    mkdirSync(dir, { recursive: true, mode: LOG_DIRECTORY_MODE });
    validateLogDirectory(dir);
    const path = join(dir, "lore.log");
    // Harden both active and previously rotated logs immediately. Otherwise a
    // legacy 0644 backup could remain readable indefinitely.
    for (const existingPath of [path, `${path}.1`]) {
      try {
        tightenExistingLogFile(existingPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return path;
  } catch {
    return undefined;
  }
}

/** Return the resolved log file path (or `undefined` if unavailable). */
export function logFilePath(): string | undefined {
  if (!logPathResolved) {
    logPath = resolveLogPath();
    logPathResolved = true;
  }
  return logPath;
}

/** Rotate the log file if it exceeds the size cap. */
function maybeRotate(): void {
  if (!logPath) return;
  let fd: number | undefined;
  try {
    // Tighten the active file before it becomes the rotated backup.
    fd = openLogFileForAppend(logPath);
    const stat = fstatSync(fd);
    if (stat.size > LOG_MAX_BYTES) {
      closeSync(fd);
      fd = undefined;
      const backup = `${logPath}.1`;
      removeExistingRotationBackup(backup);
      renameSync(logPath, backup);
      // Another process may have raced the rename. Validate what now occupies
      // the backup name before leaving it as persistent sensitive data.
      tightenExistingLogFile(backup);
    }
  } catch {
    // File doesn't exist yet or stat failed — fine
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Append a single log line to the persistent log file. */
function writeToFile(level: string, message: string): void {
  const path = logFilePath();
  if (!path) return;

  // Periodic rotation check
  if (++writeCount % ROTATION_CHECK_INTERVAL === 0) {
    maybeRotate();
  }

  const ts = new Date().toISOString();
  const tag = level.toUpperCase().padEnd(5);
  // Flatten multiline messages for clean tail -f output
  const flat = message.replace(/\n/g, "\\n");
  const line = `${ts} [${tag}] ${flat}\n`;

  let fd: number | undefined;
  try {
    fd = openLogFileForAppend(path);
    writeFileSync(fd, line, "utf8");
  } catch {
    // Silently degrade — logging failure shouldn't crash the app
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Log an informational status message. Suppressed unless LORE_DEBUG=1. */
export function info(...args: unknown[]): void {
  const msg = redactSensitiveLogText(formatArgs(args));
  if (isDebug && !readStderrSilenced())
    console.error("[lore]", ...safeArgs(args));
  sink?.info(msg);
  writeToFile("info", msg);
}

/** Log a warning. Suppressed unless LORE_DEBUG=1. */
export function warn(...args: unknown[]): void {
  const msg = redactSensitiveLogText(formatArgs(args));
  if (isDebug && !readStderrSilenced())
    console.error("[lore] WARN:", ...safeArgs(args));
  sink?.warn(msg);
  writeToFile("warn", msg);
}

/**
 * Log a user-facing notice — a warning the user likely needs to act on (e.g.
 * data misattribution, an ignored malformed env var). Unlike {@link warn} it
 * is NOT debug-gated, so it stays visible on a standalone CLI/terminal; unlike
 * {@link error} it is reported to the sink at *warning* severity (these are not
 * failures, so they must not inflate the error stream). Like every level it is
 * silenced on stderr in embedded/TUI mode but still hits the file and sink.
 */
export function notice(...args: unknown[]): void {
  const msg = redactSensitiveLogText(formatArgs(args));
  if (!readStderrSilenced()) console.error("[lore]", ...safeArgs(args));
  sink?.warn(msg);
  writeToFile("warn", msg);
}

/** Log an error. Always visible — these indicate real failures. */
export function error(...args: unknown[]): void {
  const msg = redactSensitiveLogText(formatArgs(args));
  if (!readStderrSilenced()) console.error("[lore]", ...safeArgs(args));
  sink?.error(msg);
  writeToFile("error", msg);

  const err = findError(args);
  if (err) sink?.captureException(sanitizedError(err));
}
