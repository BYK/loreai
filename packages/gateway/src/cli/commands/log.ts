/**
 * `lore log` / `lore diff` — knowledge entry version timeline + diff.
 *
 * Phase 3A.4: typed Stricli commands that wrap `commandLog` and `commandDiff`
 * in `../history-cmd.ts`. The legacy handlers print directly; the adapters
 * sink their stdout/stderr so the typed envelope is the only thing emitted.
 */
import { buildOutputCommand } from "../lib/command";
import {
  CliError,
  ContextError,
  ResolutionError,
  UsageError,
} from "../lib/errors";
import { commandLog, commandDiff } from "../history-cmd";

type LogFlags = {
  limit: number;
  project?: string;
};

interface LogResult {
  /** What kind of log output this is. */
  kind: "timeline" | "recent";
  /** ID of the entry (timeline mode), or null (recent mode). */
  id: string | null;
  /** The captured human-mode output (markdown). */
  text: string;
}

function renderHuman(data: LogResult): string {
  return data.text;
}

function toJson(data: LogResult): unknown {
  return data;
}

async function runLegacyAndCollect(
  call: () => Promise<void>,
): Promise<{ exitCode: number; captured: string }> {
  const captured: string[] = [];
  const realLog = console.log;
  const realError = console.error;
  // The legacy `commandLog` and `commandDiff` call `process.exit(1)`
  // directly on error. Replace `process.exit` with a throwing shim so
  // we capture the failure as an exception instead of killing the test
  // runner (or the process) mid-run.
  const realExit = process.exit;
  const priorExitCode = process.exitCode;
  process.exitCode = 0;
  console.log = (...args: unknown[]) => {
    // Mirror Node's behavior: `console.log()` with zero args prints a
    // newline. Without this guard, blank-line separators in the legacy
    // output collapse during capture (Seer finding #6).
    if (args.length === 0) {
      captured.push("\n");
      return;
    }
    for (const a of args) {
      captured.push(typeof a === "string" ? a : String(a));
    }
  };
  console.error = (...args: unknown[]) => {
    if (args.length === 0) {
      captured.push("\n");
      return;
    }
    for (const a of args) {
      captured.push(typeof a === "string" ? a : String(a));
    }
  };
  process.exit = (code?: number): never => {
    throw new Error(`__legacy_exit:${code ?? "undefined"}`);
  };
  let thrown: unknown;
  try {
    await call();
  } catch (err) {
    thrown = err;
  } finally {
    console.log = realLog;
    console.error = realError;
    process.exit = realExit;
  }
  const exitCode = process.exitCode ?? 0;
  process.exitCode = priorExitCode;
  if (thrown instanceof Error && /__legacy_exit:/.test(thrown.message)) {
    // Legacy handler called `process.exit(1)` — surface it through the
    // typed output pipeline as a typed error rather than rethrowing.
    return { exitCode: 1, captured: captured.join("") };
  }
  if (thrown) throw thrown;
  return { exitCode, captured: captured.join("") };
}

/**
 * Classify the legacy command's captured output into a `LogResult.kind`.
 * Only invoked on the happy path (exitCode === 0, no id); the error path
 * uses `translateError` which throws a typed CliError.
 */
function classify(_text: string): LogResult["kind"] {
  return "recent";
}

/**
 * Map a legacy failure into a typed CliError. Always called with
 * `exitCode !== 0` (see `logCommand.handler`), so we dispatch purely on
 * the captured text — no need for the exitCode term in the conditional.
 *
 * Exported for unit testing (Phase 3A.4 Seer finding #2).
 *
 * Mapping (Phase 3A.4 Seer findings #2, #5):
 *   - `No knowledge entry …`  → ResolutionError(22) — Try: lore recall
 *   - `No tracked project …`   → ContextError(21)   — Try: lore run (start tracking)
 *   - `Usage: …`               → UsageError(20)     — Try: lore diff --help
 *   - anything else             → UsageError(20)     — generic fallback
 */
export function translateError(text: string): CliError {
  // Trim leading whitespace/newlines so blank-line separators from
  // `console.log()` (captured as "\n" by runLegacyAndCollect) don't
  // break the prefix-dispatch (Seer finding #6 follow-on).
  const trimmed = text.trimStart();
  if (trimmed.startsWith("No knowledge entry")) {
    return new ResolutionError({
      message: text.trim() || "No knowledge entry found.",
      tryCommand: "lore recall",
    });
  }
  if (trimmed.startsWith("No tracked project")) {
    return new ContextError({
      message: text.trim() || "No tracked project at the current directory.",
      tryCommand: "lore run",
    });
  }
  if (trimmed.startsWith("Usage:")) {
    return new UsageError({
      message: text.trim(),
      tryCommand: "lore diff --help",
    });
  }
  return new UsageError({ message: text.trim() || "Unknown error." });
}

export const logCommand = buildOutputCommand<LogResult, LogFlags, [string?]>({
  brief:
    "Show knowledge version history (an entry's timeline, or recent changes)",
  fullDescription:
    "With no ID, prints recent knowledge changes for the project. " +
    "With an ID, prints the version timeline for that knowledge entry. " +
    "Use --json to get a structured payload; --limit controls the recent-changes " +
    "count (default 20); --project targets a specific project directory.",
  parameters: {
    flags: {
      limit: {
        kind: "parsed",
        parse: Number,
        brief: "Max recent-changes to show (default 20)",
        default: "20",
      },
      project: {
        kind: "parsed",
        parse: String,
        brief: "Target project directory (default: cwd)",
        optional: true,
      },
    },
    positional: {
      kind: "tuple",
      parameters: [
        {
          brief: "Optional knowledge entry id",
          parse: String,
          optional: true,
        },
      ],
    },
  },
  config: { renderHuman, toJson },
  async handler(flags, id) {
    const values: Record<string, unknown> = {
      json: (flags as { json?: boolean }).json,
      limit: flags.limit.toString(),
    };
    if (flags.project) values.project = flags.project;
    const { exitCode, captured } = await runLegacyAndCollect(() =>
      commandLog(id ? [id] : [], values),
    );
    if (exitCode !== 0) throw translateError(captured);
    return {
      kind: "value" as const,
      data: {
        kind: id ? "timeline" : classify(captured),
        id: id ?? null,
        text: captured,
      },
    };
  },
});

type DiffFlags = Record<string, never>;

interface DiffResult {
  id: string | null;
  text: string;
}

export const diffCommand = buildOutputCommand<
  DiffResult,
  DiffFlags,
  [string?, string?, string?]
>({
  brief: "Show what changed between two versions of a knowledge entry",
  fullDescription:
    "Prints a textual diff between two versions of a knowledge entry. " +
    "If only one ID is supplied, defaults to the latest superseded version " +
    "versus the current. Use --json for the structured envelope.",
  parameters: {
    flags: {},
    positional: {
      kind: "tuple",
      parameters: [
        { brief: "Knowledge entry id", parse: String, optional: true },
        { brief: "First version number", parse: String, optional: true },
        { brief: "Second version number", parse: String, optional: true },
      ],
    },
  },
  config: {
    renderHuman: (data: DiffResult) => data.text,
    toJson: (data: DiffResult) => data,
  },
  async handler(flags, id, v1, v2) {
    if (!id) {
      throw new UsageError({
        message: "Usage: lore diff <id> [<v1> <v2>] [--json]",
        tryCommand: "lore diff --help",
      });
    }
    const args: string[] = [id];
    if (v1) args.push(v1);
    if (v2) args.push(v2);
    const { exitCode, captured } = await runLegacyAndCollect(() =>
      commandDiff(args, { json: (flags as { json?: boolean }).json }),
    );
    if (exitCode !== 0) throw translateError(captured);
    return {
      kind: "value" as const,
      data: { id, text: captured },
    };
  },
});
