/**
 * `lore logs` — view the persistent activity log.
 *
 * Phase 3A: typed Stricli command. The follow-mode is not exercised by the
 * typed wrapper (it blocks indefinitely); it stays available through the
 * legacy dispatcher. Future phases can add a dedicated `logs follow`
 * subcommand to the Stricli tree.
 */
import { buildOutputCommand } from "../lib/command";
import { ContextError, StorageError } from "../lib/errors";
import {
  readFileSync,
  statSync,
  existsSync,
} from "node:fs";
import { log } from "@loreai/core";

type LogsFlags = {
  json: boolean;
  path: boolean;
  follow: boolean;
  /** `-n` — number of lines to show. */
  n: number;
  /** `--lines` — number of lines to show. */
  lines: number;
};

interface LogsResult {
  /** Path of the log file. */
  path: string;
  /** Total lines in the file (after filtering empties). */
  totalLines: number;
  /** The lines returned (always at most `--lines`). */
  lines: string[];
}

function renderHuman(data: LogsResult): string {
  return data.lines.join("\n");
}

function toJson(data: LogsResult): unknown {
  return {
    path: data.path,
    totalLines: data.totalLines,
    lines: data.lines,
  };
}

export const logsCommand = buildOutputCommand<
  LogsResult,
  LogsFlags,
  []
>({
  brief: "Show lore activity log (last N lines by default)",
  fullDescription:
    "Print the last 50 lines of the gateway activity log by default. " +
    "Use `--lines <n>` / `-n <n>` to change the count, `--path` to print " +
    "the log file path and exit, and `--follow` / `-f` to stream new entries. " +
    "JSON output includes the path, total line count, and the returned lines.",
  parameters: {
    flags: {
      // `--json` is auto-injected by buildOutputCommand but we declare it
      // here so the FLAGS type matches the parameter schema's expectation.
      json: {
        kind: "boolean",
        brief: "Emit a stable JSON payload",
        default: false,
      },
      path: {
        kind: "boolean",
        brief: "Print the log file path and exit",
        default: false,
      },
      follow: {
        kind: "boolean",
        brief: "Follow log output in real-time (Ctrl-C to exit)",
        default: false,
      },
      n: {
        kind: "parsed",
        parse: Number,
        brief: "Number of lines to show (alias of --lines)",
        default: "50",
      },
      lines: {
        kind: "parsed",
        parse: Number,
        brief: "Number of lines to show (alias of -n)",
        default: "50",
      },
    },
    aliases: { n: "lines" },
  },
  config: { renderHuman, toJson },
  handler(flags) {
    const filePath = log.logFilePath();
    if (!filePath) {
      throw new StorageError({
        message: "Log file path could not be resolved.",
        tryCommand: "lore start",
      });
    }
    if (flags.path) {
      // `--path` is a side-channel exit: the user asked for the path,
      // not the log contents.
      return {
        kind: "value" as const,
        data: {
          path: filePath,
          totalLines: 0,
          lines: [filePath],
        },
      };
    }
    if (!existsSync(filePath)) {
      throw new ContextError({
        message: `No log file found at ${filePath}`,
        note: "Logs are created when lore starts processing requests.",
        tryCommand: "lore start",
      });
    }
    const requested = flags.lines ?? flags.n;
    const stat = statSync(filePath);
    if (!stat.isFile()) {
      throw new StorageError({
        message: `Log path ${filePath} is not a regular file.`,
      });
    }
    const content = readFileSync(filePath, "utf-8");
    const allLines = content.split("\n").filter(Boolean);
    const tail = allLines.slice(-requested);
    const hint = flags.follow
      ? "Streaming — press Ctrl-C to stop."
      : `Showing last ${tail.length} of ${allLines.length} lines. Run \`lore logs -f\` to follow.`;
    return {
      kind: "value" as const,
      data: { path: filePath, totalLines: allLines.length, lines: tail },
      hint,
    };
  },
});