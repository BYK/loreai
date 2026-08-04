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
 * Flags forwarded to the legacy values dict (10 + auto-injected --json):
 *   --all, --cross, --interactive/-i, --json, --metadata,
 *   --name, --project, --relation, --type, --value, --yes/-y
 *
 * Destructive subcommands: `delete`, `merge`, `dedup`. The plan
 * mandates a central destructive-operation confirmation policy
 * (Phase 3D.4 follow-up); this slice ships the typed wrapper only,
 * with confirmations deferred to the policy slice.
 *
 * Output shape:
 *   - human: rendered legacy text
 *   - JSON:  { output: <captured stdout> }
 *
 * Exit codes: legacy semantics preserved (0 success, 1 unknown
 * subcommand / invalid args / destructive error).
 */
import { buildOutputCommand } from "../lib/command";
import { runLegacyAndCollect } from "../lib/legacy-bridge";
import { commandEntity } from "../entity";

type EntityFlags = {
  all: boolean;
  cross: boolean;
  interactive: boolean;
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
    "are subcommand-specific args. Flags: --all, --cross, " +
    "--interactive/-i, --json, --metadata, --name, --project, " +
    "--relation, --type, --value, --yes/-y. Destructive " +
    "subcommands: delete, merge, dedup. Confirmation policy for " +
    "destructive operations is deferred (Phase 3D.4 follow-up).",
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
    const values: Record<string, unknown> = {};
    if (flags.all) values.all = true;
    if (flags.cross) values.cross = true;
    if (flags.interactive) values.interactive = true;
    if (flags.metadata !== undefined) values.metadata = flags.metadata;
    if (flags.name !== undefined) values.name = flags.name;
    if (flags.project !== undefined) values.project = flags.project;
    if (flags.relation !== undefined) values.relation = flags.relation;
    if (flags.type !== undefined) values.type = flags.type;
    if (flags.value !== undefined) values.value = flags.value;
    if (flags.yes) values.yes = true;
    // F-4 (HIGH): forward --json (auto-injected by buildOutputCommand)
    // to the legacy handler. Legacy cmdList gates JSON output on
    // `flags.json` — without this, the legacy emits human table text
    // even when the typed pipeline's --json envelope is active.
    if ((flags as { json?: boolean }).json) values.json = true;
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
