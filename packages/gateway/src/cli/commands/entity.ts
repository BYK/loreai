/**
 * `lore entity` — typed Stricli command (Phase 3D.4).
 *
 * Wraps the legacy `commandEntity` from `../entity` via the shared
 * `runLegacyAndCollect` bridge. The legacy handler takes:
 *
 *   - positionals[0]: subcommand (list | show | add | edit | alias |
 *                     relation | merge | dedup | search | delete |
 *                     help)
 *   - positionals[1+]: subcommand-specific args (e.g.,
 *                      `entity alias add <alias> <target>`,
 *                      `entity relation add <from> <to>`)
 *
 * Flags forwarded to the legacy values dict (11 + auto-injected --json):
 *   --all, --cross, --dry-run, --interactive/-i, --json, --metadata,
 *   --name, --project, --relation, --type, --value, --yes/-y
 *
 * Destructive-operation confirmation policy (Phase 3D.4 follow-up):
 *   - `delete`, `merge`, `alias rm/remove`, and `relation rm/remove` write by
 *     default and always require `--yes` before legacy dispatch.
 *   - Every destructive operation requires `--yes`; `--dry-run` is a
 *     non-interactive dedup preview and never mutates.
 *   - `--json --interactive` is rejected before delegating, so the legacy
 *     handler never enters an interactive path under machine output.
 *
 * Output shape:
 *   - human: rendered legacy text
 *   - JSON:  { output: <captured stdout> }
 *
 * Exit codes: legacy semantics preserved (0 success, 1 unknown
 * subcommand / invalid args / destructive error).
 */
import { UsageError } from "../lib/errors";
import { buildOutputCommand } from "../lib/command";
import { runLegacyAndCollect } from "../lib/legacy-bridge";
import { commandEntity } from "../entity";
import { entityOperationPolicy } from "../lib/entity-policy";

type EntityFlags = {
  all: boolean;
  cross: boolean;
  interactive: boolean;
  "dry-run"?: boolean;
  metadata?: string;
  name?: string;
  project?: string;
  relation?: string;
  type?: string;
  value?: string;
  yes: boolean;
};

export const entityCommand = buildOutputCommand<
  string,
  EntityFlags,
  readonly string[]
>({
  brief:
    "Manage knowledge entities (list, show, add, edit, alias, relation, merge, dedup, search, delete)",
  fullDescription:
    "Knowledge entity CRUD + alias/relation/merge/dedup/search. " +
    "First positional is the subcommand; subsequent positionals " +
    "are subcommand-specific args. Flags: --all, --cross, --dry-run, " +
    "--interactive/-i, --json, --metadata, --name, --project, " +
    "--relation, --type, --value, --yes/-y. Destructive " +
    "subcommands: delete, merge, dedup, alias rm/remove, relation " +
    "rm/remove. Destructive operations require --yes.",
  parameters: {
    // Single-character flag aliases: -i → --interactive, -y → --yes
    // (matching the legacy OPTIONS table at packages/gateway/src/cli/main.ts).
    aliases: { i: "interactive", y: "yes" },
    flags: {
      all: {
        kind: "boolean",
        brief: "List all entities across projects (entity list)",
        default: false,
      },
      cross: {
        kind: "boolean",
        brief: "Cross-project entity search (entity search)",
        default: false,
      },
      "dry-run": {
        kind: "boolean",
        brief: "Show dedup changes without applying them",
        optional: true,
      },
      interactive: {
        kind: "boolean",
        brief: "Prompt for missing fields (entity add/edit, alias: -i)",
        default: false,
      },
      // The legacy `cmdAdd`/`cmdEdit`/`cmdRelationAdd` parse this as
      // a JSON string (e.g., --metadata '{"k":"v"}'). The legacy
      // command-line parser treats unknown flags as boolean — so the
      // JSON string gets passed as a positional, which fails. We
      // fix this here by declaring metadata as a parsed string flag
      // with `parse: String` so it accepts any value as a single
      // string, then forwards as values.metadata.
      metadata: {
        kind: "parsed",
        parse: String,
        brief: "JSON metadata string (entity add/edit/relation add)",
        optional: true,
      },
      name: {
        kind: "parsed",
        parse: String,
        brief: "Entity name (entity show/edit/delete)",
        optional: true,
      },
      project: {
        kind: "parsed",
        parse: String,
        brief: "Project directory (default: cwd)",
        optional: true,
      },
      relation: {
        kind: "parsed",
        parse: String,
        brief: "Relation type filter (entity search)",
        optional: true,
      },
      type: {
        kind: "parsed",
        parse: String,
        brief: "Entity type filter (entity search/list)",
        optional: true,
      },
      value: {
        kind: "parsed",
        parse: String,
        brief: "Entity value (entity add)",
        optional: true,
      },
      yes: {
        kind: "boolean",
        brief: "Apply auto-merges (entity dedup, alias: -y)",
        default: false,
      },
    },
    positional: {
      kind: "array",
      parameter: {
        parse: String,
        brief: "entity subcommand + subcommand-specific args",
      },
    },
  },
  config: {
    renderHuman: (data) => data,
    toJson: (data) => ({ output: data }),
  },
  async handler(flags, ...positionals) {
    const subcommand = positionals[0];
    const subArgs = positionals.slice(1);
    const jsonFlag = (flags as { json?: boolean }).json;

    const sub = subcommand ?? "";

    // JSON + interactive prompt together would corrupt machine output and
    // produce interactive prompt behavior. Reject before delegating.
    const values: Record<string, unknown> = {};
    if (flags.all) values.all = true;
    if (flags.cross) values.cross = true;
    if (flags["dry-run"]) {
      values["dry-run"] = true;
      values.dryRun = true;
    }
    if (flags.interactive) values.interactive = true;
    if (flags.metadata !== undefined) values.metadata = flags.metadata;
    if (flags.name !== undefined) values.name = flags.name;
    if (flags.project !== undefined) values.project = flags.project;
    if (flags.relation !== undefined) values.relation = flags.relation;
    if (flags.type !== undefined) values.type = flags.type;
    if (flags.value !== undefined) values.value = flags.value;
    if (flags.yes) values.yes = true;
    if (jsonFlag) values.json = true;

    const policy = entityOperationPolicy([sub, ...subArgs], values);
    if (policy.jsonInteractive) {
      throw new UsageError({
        message: `Refusing \`--json --interactive\` for \`${policy.operation}\`.`,
        tryCommand: `${policy.operation} --json`,
      });
    }
    if (policy.invalidDryRun) {
      throw new UsageError({
        message: "`--dry-run` is supported only by `lore entity dedup`.",
        tryCommand: "lore entity dedup --dry-run",
      });
    }
    if (policy.requiresYes && !flags.yes) {
      throw new UsageError({
        message: `Refusing destructive \`${policy.operation}\` without --yes.`,
        tryCommand: `${policy.operation} --yes`,
      });
    }
    // Stricli spreads the variadic positional array into individual
    // handler params; collect back into the legacy string[].
    const { exitCode, captured } = await runLegacyAndCollect(() =>
      commandEntity([...positionals], values),
    );
    if (exitCode !== 0) {
      process.exitCode = exitCode;
    }
    return { kind: "value" as const, data: captured };
  },
});
