/**
 * `lore data` — typed Stricli command (Phase 3C, slice 1).
 *
 * Phase 3C migration is split into per-subcommand slices because
 * `commandData` is 3312 lines with 18 subcommands and 9 flags,
 * including 7 destructive actions (delete, clear, merge, dedup,
 * reground-entities, move, split) that need the central
 * destructive-operation confirmation policy from Phase 3D.4 follow-up.
 *
 * This slice ships the typed wrapper for the read-only subcommands:
 *   list, show, cache-stats
 *
 * Destructive subcommands remain in LEGACY_ROUTES until Phase 3C
 * slice 2 (with destructive policy) lands. Each subcommand's flags
 * are typed correctly; the legacy handler's flags subcommand
 * dispatching is preserved.
 *
 * Output shape:
 *   - human: rendered legacy text
 *   - JSON:  { output: <captured stdout> }
 *
 * Exit codes: legacy semantics preserved.
 */
import { buildOutputCommand } from "../lib/command";
import { runLegacyAndCollect } from "../lib/legacy-bridge";
import { commandData } from "../data";

type DataFlags = {
  all: boolean;
  distillations: boolean;
  interactive: boolean;
  knowledge: boolean;
  limit?: number;
  project?: string;
  temporal: boolean;
  to?: string;
  yes: boolean;
};

export const dataCommand = buildOutputCommand<
  string,
  DataFlags,
  readonly string[]
>({
  brief:
    "Manage lore data (list, show, cache-stats — destructive subcommands deferred)",
  fullDescription:
    "Knowledge data CRUD. Slice 1 of Phase 3C: ships read-only " +
    "subcommands (list, show, cache-stats) via the typed tree. " +
    "Destructive subcommands (delete, clear, merge, dedup, " +
    "reground-entities, move, split) remain in the legacy dispatcher " +
    "until Phase 3C slice 2 (with destructive-operation confirmation " +
    "policy) lands. Flags: --all, --distillations, --interactive, " +
    "--json, --knowledge, --limit, --project, --temporal, --to, --yes. " +
    "No positionals; subcommand is the first positional.",
  parameters: {
    flags: {
      all: {
        kind: "boolean",
        brief: "Include all entries (default: pending only)",
        default: false,
      },
      distillations: {
        kind: "boolean",
        brief: "Show distillations (data show)",
        default: false,
      },
      interactive: {
        kind: "boolean",
        brief: "Prompt for missing fields",
        default: false,
      },
      knowledge: {
        kind: "boolean",
        brief: "Show knowledge entries (data show)",
        default: false,
      },
      limit: {
        kind: "parsed",
        parse: Number,
        brief: "Max entries to return (default: 50)",
        optional: true,
      },
      project: {
        kind: "parsed",
        parse: String,
        brief: "Project directory (default: cwd)",
        optional: true,
      },
      temporal: {
        kind: "boolean",
        brief: "Include temporal records (data show)",
        default: false,
      },
      to: {
        kind: "parsed",
        parse: String,
        brief: "Destination (data move)",
        optional: true,
      },
      yes: {
        kind: "boolean",
        brief: "Skip confirmation prompts",
        default: false,
      },
    },
    positional: {
      kind: "array",
      parameter: {
        parse: String,
        brief: "data subcommand + subcommand-specific args",
      },
    },
  },
  config: {
    renderHuman: (data) => data,
    toJson: (data) => ({ output: data }),
  },
  async handler(flags, ...positionals) {
    const values: Record<string, unknown> = {};
    if (flags.all) values.all = true;
    if (flags.distillations) values.distillations = true;
    if (flags.interactive) values.interactive = true;
    if (flags.knowledge) values.knowledge = true;
    if (flags.limit !== undefined) values.limit = flags.limit;
    if (flags.project !== undefined) values.project = flags.project;
    if (flags.temporal) values.temporal = true;
    if (flags.to !== undefined) values.to = flags.to;
    if (flags.yes) values.yes = true;
    // --json auto-injection forwarded (legacy gates JSON output on flags.json).
    if ((flags as { json?: boolean }).json) values.json = true;
    const { exitCode, captured } = await runLegacyAndCollect(() =>
      commandData([...positionals], values),
    );
    if (exitCode !== 0) {
      process.exitCode = exitCode;
    }
    return { kind: "value" as const, data: captured };
  },
});
