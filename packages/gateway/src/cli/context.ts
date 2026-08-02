/**
 * Command context — dependencies injected into every Lore command.
 *
 * Lore's handlers historically read `process`, `console`, and globals directly.
 * The Stricli migration routes commands through a single context object so tests
 * do not have to monkey-patch `process` and production code stays explicit about
 * what each handler can touch.
 *
 * Only the fields actually consumed by the current CLI are injected. Add more
 * (clock, filesystem, etc.) when a handler demonstrably needs them rather than
 * speculatively.
 */
import type { CommandContext } from "@stricli/core";

/**
 * Lore's command context extends Stricli's `CommandContext` with the fields
 * Lore handlers actually consume.
 *
 * Stricli binds this object as `this` inside every command handler. Handlers
 * reach the standard streams through `this.process.stdout` / `this.process.stderr`
 * (matching Stricli's `WritableStreams`) and reach Lore-specific fields via
 * `this.cwd`, `this.homeDir`, etc.
 *
 * The `process` field is inherited from Stricli's `CommandContext`. The shape
 * there is `WritableStreams` (i.e. `{ stdout: Writable; stderr: Writable }`).
 * When Stricli runs the app it augments this with a full `StricliProcess`
 * (which extends `WritableStreams` with `env`, `exitCode`, etc.) — handlers
 * that need those fields read them through the same `process` object.
 */
export interface LoreCommandContext extends CommandContext {
  /** Effective `process.cwd()` snapshot at command entry. */
  cwd: string;
  /** User home directory (snapshot at command entry). */
  homeDir: string;
  /** Resolved process environment snapshot. */
  env: NodeJS.ProcessEnv;
  /** Process argv SLICED past the entry path (just the user-supplied args). */
  userArgv: readonly string[];
  /** Snapshot of `process.platform`/`process.arch`. */
  platform: NodeJS.Platform;
  arch: string;
  /** TTY flags captured at command entry. */
  isStdoutTTY: boolean;
  isStderrTTY: boolean;
  /** Whether stdin appears to be interactive. */
  isStdinTTY: boolean;
  /** The dotted command path that produced this invocation, e.g. `data.list`. */
  commandPath: readonly string[];
}

/**
 * Build a context from the running `process`. Used by the orchestrator's
 * `forCommand` hook so every command handler receives the same baseline.
 *
 * Future phases can grow this signature with overrides for tests (capture
 * stdout/stderr into a buffer, pin cwd/homeDir, etc.) without changing the
 * public shape commands depend on.
 */
export function buildContext(proc: NodeJS.Process): LoreCommandContext {
  return {
    process,
    cwd: proc.cwd(),
    homeDir: proc.env.HOME ?? "",
    env: proc.env,
    userArgv: proc.argv.slice(2),
    platform: proc.platform,
    arch: proc.arch,
    isStdoutTTY: proc.stdout.isTTY ?? false,
    isStderrTTY: proc.stderr.isTTY ?? false,
    isStdinTTY: proc.stdin.isTTY ?? false,
    commandPath: [],
  };
}