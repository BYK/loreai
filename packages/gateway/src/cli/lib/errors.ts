/**
 * Semantic CLI error hierarchy.
 *
 * Two compatible constructor shapes:
 *   - Modern: `new UsageError({ message, tryCommand, alternatives, note, details })`.
 *   - Legacy: `new UpgradeError(reason, message)` — used by the upgrade stack
 *     (see `binary.ts`, `ghcr.ts`, `upgrade.ts`). The `reason` becomes the
 *     error's `code` (e.g. "network_error") and the message is preserved.
 *
 * The wrapper (`emitCliError`) renders the modern shape. The legacy shape
 * still works for backward compatibility — its `reason` is mapped to a
 * stable exit code in the upgrade range.
 */
import type { LoreCommandContext } from "../context";

export interface CliErrorInit {
  /** Short message describing the failure. */
  message: string;
  /** Suggested recovery command (e.g. `lore login`). */
  tryCommand?: string;
  /** Optional alternatives the user can run instead. */
  alternatives?: ReadonlyArray<string>;
  /** Free-form diagnostic detail (stack traces go here, not in `message`). */
  note?: string;
  /** Structured payload for JSON mode. Never includes secrets. */
  details?: Record<string, unknown>;
  /** Machine-readable reason code (kept for legacy compatibility). */
  reason?: string;
}

export class CliError extends Error {
  readonly exitCode: number;
  readonly tryCommand?: string;
  readonly alternatives?: ReadonlyArray<string>;
  readonly note?: string;
  readonly details?: Record<string, unknown>;
  /** Machine-readable reason code. */
  readonly reason?: string;

  constructor(exitCode: number, initOrMessage: CliErrorInit | string) {
    const init: CliErrorInit =
      typeof initOrMessage === "string"
        ? { message: initOrMessage }
        : initOrMessage;
    super(init.message);
    this.name = this.constructor.name;
    this.exitCode = exitCode;
    this.tryCommand = init.tryCommand;
    this.alternatives = init.alternatives;
    this.note = init.note;
    this.details = init.details;
    this.reason = init.reason;
  }

  /**
   * Format the error for the human terminal.
   *
   * Shape (stable, asserted by tests):
   *   <failure message>
   *
   *   Try: <tryCommand>
   *   Or:  <alt1>
   *         <alt2>
   *   Note: <diagnostic>
   */
  formatHuman(): string {
    const lines: string[] = [this.message];
    if (this.tryCommand) {
      lines.push("", `Try: ${this.tryCommand}`);
    }
    if (this.alternatives && this.alternatives.length > 0) {
      lines.push("Or:");
      for (const alt of this.alternatives) {
        lines.push(`  ${alt}`);
      }
    }
    if (this.note) {
      lines.push("", `Note: ${this.note}`);
    }
    return lines.join("\n");
  }

  /**
   * Stable JSON payload for machine consumers. Omits secrets, never includes
   * raw provider responses or sensitive argv.
   */
  toJson(): Record<string, unknown> {
    const out: Record<string, unknown> = {
      error: this.name,
      code: this.exitCode,
      message: this.message,
    };
    if (this.reason) out.reason = this.reason;
    if (this.tryCommand) out.try = this.tryCommand;
    if (this.alternatives && this.alternatives.length > 0) {
      out.alternatives = this.alternatives;
    }
    if (this.note) out.note = this.note;
    if (this.details) out.details = this.details;
    return out;
  }
}

// -----------------------------------------------------------------------------
// Specific error categories
// -----------------------------------------------------------------------------

/** 10-19: authentication / account failures. */
export class AuthError extends CliError {
  constructor(init: CliErrorInit) {
    super(10, init);
  }
}

/** 20-29: usage, validation, configuration failures. */
export class UsageError extends CliError {
  constructor(init: CliErrorInit) {
    super(20, init);
  }
}

/** 20-29: missing required context. */
export class ContextError extends CliError {
  constructor(init: CliErrorInit) {
    super(21, init);
  }
}

/** 20-29: identifier could not be resolved. */
export class ResolutionError extends CliError {
  constructor(init: CliErrorInit) {
    super(22, init);
  }
}

/** 20-29: malformed input. */
export class ValidationError extends CliError {
  constructor(init: CliErrorInit) {
    super(23, init);
  }
}

/** 30-39: gateway, network, provider reachability. */
export class NetworkError extends CliError {
  constructor(init: CliErrorInit) {
    super(30, init);
  }
}

/** 30-39: provider rejected the request (4xx). */
export class ProviderError extends CliError {
  constructor(init: CliErrorInit) {
    super(31, init);
  }
}

/** 40-49: feature unavailable in this environment. */
export class UnsupportedError extends CliError {
  constructor(init: CliErrorInit) {
    super(40, init);
  }
}

/** 50-59: filesystem / database / import / sync / upgrade operations. */
export class StorageError extends CliError {
  constructor(init: CliErrorInit) {
    super(50, init);
  }
}

/** 50-59: import-specific failures. */
export class ImportError extends CliError {
  constructor(init: CliErrorInit) {
    super(51, init);
  }
}

/** 50-59: sync-specific failures. */
export class SyncError extends CliError {
  constructor(init: CliErrorInit) {
    super(52, init);
  }
}

/** 50-59: upgrade-specific failures. Supports legacy `(reason, message)` ctor. */
export class UpgradeError extends CliError {
  constructor(init: CliErrorInit);
  constructor(reason: string, message: string);
  constructor(initOrReason: CliErrorInit | string, maybeMessage?: string) {
    if (typeof initOrReason === "string") {
      super(53, { message: maybeMessage ?? "", reason: initOrReason });
    } else {
      super(53, initOrReason);
    }
  }
}

/**
 * Render a CliError in the mode implied by the context.
 *
 * Human mode: prints `formatHuman()` to stderr.
 * JSON mode:   prints `toJson()` to stderr.
 * In both modes the function sets `process.exitCode = exitCode` so the
 * wrapper can call `safeExit(exitCode)` at the end of the command.
 */
export function emitCliError(
  err: CliError,
  ctx: LoreCommandContext,
  json: boolean,
): void {
  if (json) {
    ctx.process.stderr.write(`${JSON.stringify(err.toJson(), null, 2)}\n`);
  } else {
    ctx.process.stderr.write(`${err.formatHuman()}\n`);
  }
  // Type-narrowing: `process` is `WritableStreams` per Stricli's
  // CommandContext, but the real Node process has `exitCode`. Cast through
  // the runtime value (always NodeJS.Process in production, and tests use
  // a real process too).
  (ctx.process as unknown as { exitCode?: number }).exitCode = err.exitCode;
}

/**
 * Stringify an unknown value for inclusion in error messages. Preserves the
 * existing helper used across `binary.ts`, `ghcr.ts`, `upgrade.ts`, and
 * `main.ts`.
 */
export function stringifyUnknown(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value instanceof Error) {
    return value.stack ?? `${value.name}: ${value.message}`;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}