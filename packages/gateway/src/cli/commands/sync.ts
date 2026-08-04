/**
 * `lore sync` — typed Stricli command (Phase 3D.3b).
 *
 * Wraps the legacy `commandSync` from `../sync-cmd` via the shared
 * `runLegacyAndCollect` bridge. The legacy handler takes:
 *
 *   - positionals[0]: subcommand (enable | disable | status | now;
 *     defaults to "status" if absent)
 *
 * No flags — `commandSync` ignores the values dict (it reads flags from
 * process.argv itself if needed). The Stricli adapter declares only the
 * positional schema; flags are auto-injected (`--json` only).
 *
 * Output shape:
 *   - human: rendered legacy text
 *   - JSON:  { output: <captured stdout> }
 *
 * Exit codes: legacy semantics preserved (0 normal, 1 unknown
 * subcommand).
 */
import { buildOutputCommand } from "../lib/command";
import { runLegacyAndCollect } from "../lib/legacy-bridge";
import { commandSync } from "../sync-cmd";

type SyncFlags = Record<string, never>;

export const syncCommand = buildOutputCommand<string, SyncFlags, [string?]>({
  brief: "Sync data between the local lore DB and Supabase",
  fullDescription:
    "Bidirectional sync between the local lore DB and Supabase. " +
    "Subcommands: status (default), enable, disable, now. The " +
    "first positional selects the subcommand; --json emits a " +
    "structured envelope.",
  parameters: {
    flags: {},
    positional: {
      kind: "tuple",
      parameters: [
        {
          parse: String,
          brief: "Subcommand (status | enable | disable | now)",
          optional: true,
        },
      ],
    },
  },
  config: {
    renderHuman: (data) => data,
    toJson: (data) => ({ output: data }),
  },
  async handler(_flags, sub) {
    // Stricli spreads ARGS = [string?] into individual args, so
    // `sub` is the optional subcommand string itself (or undefined).
    // The legacy commandSync wants a positionals string[].
    const { exitCode, captured } = await runLegacyAndCollect(() =>
      commandSync(typeof sub === "string" ? [sub] : [], {}),
    );
    if (exitCode !== 0 && process.exitCode === 0) {
      process.exitCode = exitCode;
    }
    return { kind: "value" as const, data: captured };
  },
});
