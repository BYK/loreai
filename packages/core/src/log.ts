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

import { appendFileSync, renameSync, statSync, mkdirSync } from "node:fs";
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

// ---------------------------------------------------------------------------
// File sink — persistent log file, independent of LORE_DEBUG
// ---------------------------------------------------------------------------

const LOG_MAX_BYTES = 5 * 1024 * 1024; // 5 MB
const ROTATION_CHECK_INTERVAL = 1000; // check size every N writes

let logPath: string | undefined;
let logPathResolved = false;
let writeCount = 0;

/**
 * Resolve the log file path. Returns `undefined` in test environments
 * or if the directory cannot be created.
 */
function resolveLogPath(): string | undefined {
  if (process.env.NODE_ENV === "test") return undefined;
  try {
    const dir = dataDir();
    mkdirSync(dir, { recursive: true });
    return join(dir, "lore.log");
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
  try {
    const stat = statSync(logPath);
    if (stat.size > LOG_MAX_BYTES) {
      renameSync(logPath, `${logPath}.1`);
    }
  } catch {
    // File doesn't exist yet or stat failed — fine
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

  try {
    appendFileSync(path, line);
  } catch {
    // Silently degrade — logging failure shouldn't crash the app
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Log an informational status message. Suppressed unless LORE_DEBUG=1. */
export function info(...args: unknown[]): void {
  if (isDebug) console.error("[lore]", ...args);
  const msg = formatArgs(args);
  sink?.info(msg);
  writeToFile("info", msg);
}

/** Log a warning. Suppressed unless LORE_DEBUG=1. */
export function warn(...args: unknown[]): void {
  if (isDebug) console.error("[lore] WARN:", ...args);
  const msg = formatArgs(args);
  sink?.warn(msg);
  writeToFile("warn", msg);
}

/** Log an error. Always visible — these indicate real failures. */
export function error(...args: unknown[]): void {
  console.error("[lore]", ...args);
  const msg = formatArgs(args);
  sink?.error(msg);
  writeToFile("error", msg);

  const err = findError(args);
  if (err) sink?.captureException(err);
}
