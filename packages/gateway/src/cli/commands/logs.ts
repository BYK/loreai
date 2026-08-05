/**
 * `lore logs` — view the persistent activity log.
 *
 * Two execution paths:
 *
 * 1. Default / non-follow: delegates to the legacy `commandLogs` via
 *    the shared `runLegacyAndCollect` bridge. The legacy's initial
 *    read is fully synchronous, so the bridge awaits cleanly.
 *
 * 2. Follow (`-f` / `--follow`): the legacy returns
 *    `new Promise(() => {})` after installing watchFile + signal
 *    handlers to block forever. The bridge can't await a
 *    non-resolving promise, so we invoke the legacy WITHOUT the
 *    bridge wrapper. The initial tail is printed synchronously to
 *    stdout; the watchFile poller streams new lines; the default
 *    SIGINT handler exits on Ctrl-C.
 *
 * Both paths accept the documented flags.
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
    // Forward both kebab-case and camelCase forms so the legacy
    // handler's existing `values.f || values.follow` /
    // `values.n || values.lines` checks work unchanged.
    const values: Record<string, unknown> = {};
    values.path = flags.path;
    values.follow = flags.follow;
    values.f = flags.follow;
    values.lines = flags.lines;
    values.n = flags.lines;

    if (!flags.follow) {
      // Non-follow path: bridge wrapper. The legacy's initial read is
      // synchronous and returns cleanly.
      const { exitCode, captured } = await runLegacyAndCollect(() =>
        commandLogs([], values),
      );
      if (exitCode !== 0) {
        process.exitCode = exitCode;
      }
      return { kind: "value" as const, data: captured };
    }

    // Follow path: the legacy `commandLogs` returns
    // `new Promise(() => {})` to block forever — the watchFile
    // poller + SIGINT/SIGTERM handlers (in the legacy itself) keep
    // Node alive on the event loop. The bridge can't await a
    // non-resolving promise, so we run the legacy WITHOUT the
    // bridge wrapper. The legacy's initial read is fully
    // synchronous (lines 62-68 of packages/gateway/src/cli/logs.ts):
    // it reads the file, splits on \n, and console.logs the tail
    // before returning the watchFile promise. By the time we reach
    // the void-call below, the initial-tail output has already
    // written to stdout (real stdout, not the bridge's captured
    // channel — because we bypassed it). The watchFile poll
    // continues in the background, and the default SIGINT handler
    // exits the process when the user presses Ctrl-C.
    //
    // We deliberately DO NOT await: `commandLogs` returns
    // `new Promise(() => {})` so awaiting would hang forever.
    // The `void` keyword makes the unawaited call explicit.
    void commandLogs([], values);
    // Return immediately. The streaming stdout of new lines is the
    // user-visible output for follow mode — there's nothing to
    // capture into the typed envelope.
    return { kind: "value" as const, data: "" };
  },
});
