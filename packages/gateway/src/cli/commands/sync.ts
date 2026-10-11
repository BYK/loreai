/**
 * `lore sync` — typed Stricli command (Phase 3D.3b).
 *
 * Wraps the legacy `commandSync` from `../sync-cmd` via the shared
 * `runLegacyAndCollect` bridge. The legacy handler takes:
 *
 *   - positionals[0]: subcommand (enable | disable | status | now | conflicts;
 *     defaults to "status" if absent)
 *   - positionals[1]: conflict action
 *   - positionals[2]: conflict id
 *
 * `--expected-version` is forwarded for the conflict recovery command.
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

type SyncFlags = {
  "expected-version"?: string;
};

export const syncCommand = buildOutputCommand<
  string,
  SyncFlags,
  [string?, string?, string?]
>({
  brief: "Sync data between the local lore DB and Supabase",
  fullDescription:
    "Bidirectional sync between the local lore DB and Supabase. " +
    "Subcommands: status (default), enable, disable, now, conflicts. " +
    "Use `sync conflicts keep <id> --expected-version <version-id>` to " +
    "resolve a conflict. --json emits a structured envelope.",
  parameters: {
    flags: {
      "expected-version": {
        kind: "parsed",
        parse: String,
        brief: "Current knowledge version required to keep a conflict",
        optional: true,
      },
    },
    positional: {
      kind: "tuple",
      parameters: [
        {
          parse: String,
          brief: "Subcommand (status | enable | disable | now | conflicts)",
          optional: true,
        },
        {
          parse: String,
          brief: "Conflict action (list | keep | discard)",
          optional: true,
        },
        {
          parse: String,
          brief: "Conflict ID",
          optional: true,
        },
      ],
    },
  },
  config: {
    renderHuman: (data) => data,
    toJson: (data) => ({ output: data }),
  },
  async handler(flags, sub, action, conflictId) {
    // Stricli spreads ARGS = [string?] into individual args, so
    // `sub` is the optional subcommand string itself (or undefined).
    // The legacy commandSync wants a positionals string[].
    const expectedVersion = flags["expected-version"];
    const syncOptions =
      expectedVersion === undefined
        ? {}
        : { "expected-version": expectedVersion };
    const { exitCode, captured } = await runLegacyAndCollect(() =>
      commandSync(
        [sub, action, conflictId].filter(
          (value): value is string => typeof value === "string",
        ),
        syncOptions,
      ),
    );
    // Propagate the legacy handler's exit code. runLegacyAndCollect
    // restores process.exitCode to its prior value (typically
    // undefined) before returning, so we must use the exitCode returned
    // by the bridge — NOT process.exitCode (which is now restored).
    // The earlier `if (... && process.exitCode === 0)` guard silently
    // dropped every non-zero exit code because the bridge always
    // clears process.exitCode to undefined before returning (H1 +
    // Seer MEDIUM #3708574324).
    if (exitCode !== 0) {
      process.exitCode = exitCode;
    }
    return { kind: "value" as const, data: captured };
  },
});
