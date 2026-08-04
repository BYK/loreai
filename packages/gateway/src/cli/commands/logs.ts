/**
 * `lore logs` — view the persistent activity log.
 *
 * Phase 3D.4b fix: delegates to the legacy `commandLogs` via the shared
 * `runLegacyAndCollect` bridge. The legacy handler implements the
 * follow-mode (`-f` / `--follow`) using `fs.watchFile` polling at 300ms
 * intervals and emits new content as it arrives. The typed wrapper
 * used to re-implement a one-shot `readFileSync` snapshot that silently
 * dropped `--follow`, which made the advertised `-f` alias reject.
 *
 * Output shape:
 *   - human: rendered legacy text
 *   - JSON:  { output: <captured stdout> }
 *
 * Exit codes: legacy semantics preserved.
 */
import { buildOutputCommand } from "../lib/command";
import { runLegacyAndCollect } from "../lib/legacy-bridge";
import { commandLogs } from "../logs";

type LogsFlags = {
  path: boolean;
  follow: boolean;
  lines: number;
};

export const logsCommand = buildOutputCommand<string, LogsFlags, []>({
  brief: "Show lore activity log (last N lines by default)",
  fullDescription:
    "Print the last 50 lines of the gateway activity log by default. " +
    "Use `--lines <n>` / `-n <n>` to change the count, `--path` to print " +
    "the log file path and exit. `--follow` / `-f` tails the log and " +
    "prints new lines as they arrive (Ctrl-C to stop). " +
    "--json emits a structured envelope.",
  parameters: {
    // Single-character aliases: -n → --lines, -f → --follow
    // (matching the legacy OPTIONS table at packages/gateway/src/cli/main.ts).
    aliases: { n: "lines", f: "follow" },
    flags: {
      path: {
        kind: "boolean",
        brief: "Print the log file path and exit",
        default: false,
      },
      follow: {
        kind: "boolean",
        brief:
          "Tail the log and print new lines as they arrive (Ctrl-C to stop)",
        default: false,
      },
      lines: {
        kind: "parsed",
        parse: Number,
        brief: "Number of lines to show (alias: -n)",
        default: "50",
      },
    },
  },
  config: {
    renderHuman: (data) => data,
    toJson: (data) => ({ output: data }),
  },
  async handler(flags) {
    // Forward all flags to the legacy handler, which reads `flags.n`
    // OR `flags.lines` AND `flags.f` OR `flags.follow`. We populate
    // BOTH kebab-case and camelCase forms so the legacy handler's
    // existing `values.f || values.follow` checks work unchanged.
    const values: Record<string, unknown> = {};
    values.path = flags.path;
    values.follow = flags.follow;
    values.f = flags.follow;
    values.lines = flags.lines;
    values.n = flags.lines;
    const { exitCode, captured } = await runLegacyAndCollect(() =>
      commandLogs([], values),
    );
    if (exitCode !== 0) {
      process.exitCode = exitCode;
    }
    return { kind: "value" as const, data: captured };
  },
});
