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
import { UsageError } from "../lib/errors";
import { runLegacyAndCollect } from "../lib/legacy-bridge";
import { commandData, confirm } from "../data";

// These commands write by default. Preview-first operations such as dedup,
// split, and consolidate retain their legacy --yes-to-apply behavior and
// must not be promoted into mutations by this wrapper.
export const WRITE_DATA_SUBCOMMANDS = new Set([
  "clear",
  "delete",
  "export",
  "merge",
  "move",
  "recover",
  "reindex",
  "rerank",
  "reground-entities",
  "vacuum",
]);

// These legacy commands already show an operation-specific preview and ask
// for confirmation. Keep that richer prompt rather than replacing it with a
// generic wrapper prompt.
const LEGACY_CONFIRMED_DATA_SUBCOMMANDS = new Set([
  "clear",
  "delete",
  "merge",
  "move",
  "recover",
  "reground-entities",
]);

// These are the only write commands whose handlers implement a true no-write
// dry-run. Do not infer this from merely accepting a --dry-run flag.
const DRY_RUN_DATA_SUBCOMMANDS = new Set(["move", "reground-entities"]);

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
  // Reviewer F-1 (HIGH): flags read by destructive subcommands.
  // Without these in the schema, `data split --no-backup` or
  // `data move session <id> --to /tmp --no-children` would be
  // rejected with "No flag registered" (exit 20) before reaching
  // the legacy commandData dispatcher.
  "dry-run"?: boolean;
  "no-children"?: boolean;
  "no-backup"?: boolean;
  "min-confidence"?: string;
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
      // Reviewer F-1 (HIGH): flags used by destructive subcommands.
      // Declared optional+boolean/string so the legacy OPTIONS table
      // accepts them without breakage.
      "dry-run": {
        kind: "boolean",
        brief:
          "Show what would change without writing (data move/split/consolidate/reground)",
        optional: true,
      },
      "no-children": {
        kind: "boolean",
        brief: "Don't move/split child entities (data move)",
        optional: true,
      },
      "no-backup": {
        kind: "boolean",
        brief: "Don't back up before destructive operations (data split)",
        optional: true,
      },
      "min-confidence": {
        kind: "parsed",
        parse: String,
        brief: "Minimum confidence threshold for split operations (data split)",
        optional: true,
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
    const subcommand = positionals[0];
    const json = (flags as { json?: boolean }).json === true;
    const writesByDefault =
      subcommand !== undefined &&
      WRITE_DATA_SUBCOMMANDS.has(subcommand) &&
      !(flags["dry-run"] && DRY_RUN_DATA_SUBCOMMANDS.has(subcommand));
    let wrapperConfirmed = false;

    if (writesByDefault && !flags.yes) {
      if (json || !process.stdin.isTTY) {
        throw new UsageError({
          message: `Refusing non-interactive \`lore data ${subcommand}\` without --yes.`,
          tryCommand: `lore data ${subcommand} --yes`,
        });
      }
      if (
        !LEGACY_CONFIRMED_DATA_SUBCOMMANDS.has(subcommand) &&
        !(await confirm(
          `This runs \`lore data ${subcommand}\` and may permanently change Lore data.`,
        ))
      ) {
        console.log("Cancelled.");
        return { kind: "empty" as const };
      }
      wrapperConfirmed = !LEGACY_CONFIRMED_DATA_SUBCOMMANDS.has(subcommand);
    }

    const values: Record<string, unknown> = {};
    if (flags.all) values.all = true;
    if (flags.distillations) values.distillations = true;
    if (flags.interactive) values.interactive = true;
    if (flags.knowledge) values.knowledge = true;
    if (flags.limit !== undefined) values.limit = flags.limit;
    if (flags.project !== undefined) values.project = flags.project;
    if (flags.temporal) values.temporal = true;
    if (flags.to !== undefined) values.to = flags.to;
    // Keep legacy operation-specific prompts. Only suppress a prompt when
    // the caller explicitly opted in, or when this wrapper supplied the only
    // confirmation for a command without one.
    if (flags.yes || wrapperConfirmed) values.yes = true;
    // F-1 (HIGH): forward the 4 flags used by destructive subcommands.
    // Populate BOTH kebab-case and camelCase forms so the legacy
    // handler's existing checks work unchanged (matches the import.ts
    // dual-form pattern established in PR #1570).
    if (flags["dry-run"]) {
      values["dry-run"] = true;
      values.dryRun = true;
    }
    if (flags["no-children"]) {
      values["no-children"] = true;
      values.noChildren = true;
    }
    if (flags["no-backup"]) {
      values["no-backup"] = true;
      values.noBackup = true;
    }
    if (flags["min-confidence"] !== undefined) {
      values["min-confidence"] = flags["min-confidence"];
    }
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
