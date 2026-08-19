/**
 * `lore entity` — typed Stricli command (Phase 3D.4 + 3D.4 follow-up).
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
 * Destructive-operation confirmation policy (Phase 3D.4 follow-up):
 *   - `delete`, `merge`, `alias rm`, `relation rm` write by default;
 *     the typed wrapper rejects non-interactive invocations without
 *     `--yes` (mirrors `lore data`).
 *   - `dedup` writes only when `--yes` is supplied. `--dry-run` overrides
 *     `--yes` and forces the legacy preview path.
 *   - `--json --interactive` is rejected before delegating, so the legacy
 *     handler never enters the interactive prompt-and-mutate path under
 *     machine output.
 */
import { UsageError } from "../lib/errors";
import { buildOutputCommand } from "../lib/command";
import { runLegacyAndCollect } from "../lib/legacy-bridge";
import { commandEntity } from "../entity";

// Destructive top-level subcommands that write by default (require
// --yes when stdin is not a TTY). None of the legacy entity write
// handlers prompt the user; the wrapper enforces the confirm gate so
// CI runs cannot mutate state silently.
const WRITE_BY_DEFAULT = new Set<string>(["delete", "merge"]);

function isDestructive(
  subcommand: string,
  positionals: readonly string[],
): boolean {
  if (subcommand === "dedup") return true;
  if (WRITE_BY_DEFAULT.has(subcommand)) return true;
  // `alias rm` / `relation rm` reach the writer through a two-level
  // dispatcher; treat them as destructive when the user invokes the
  // rm/remove subverb.
  if (subcommand === "alias" && positionals[0] === "rm") return true;
  if (
    subcommand === "relation" &&
    (positionals[0] === "rm" || positionals[0] === "remove")
  ) {
    return true;
  }
  return false;
}

type EntityFlags = {
  all: boolean;
  cross: boolean;
  "dry-run": boolean;
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
      "dry-run": {
        kind: "boolean",
        brief: "Preview entity dedup without applying auto-merges",
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
    const subcommand = positionals[0];
    const subArgs = positionals.slice(1);
    const jsonFlag = (flags as { json?: boolean }).json;

    // JSON + interactive prompt together would corrupt machine output
    // and produce interactive prompt behavior. Reject before delegating.
    if (
      jsonFlag &&
      flags.interactive &&
      isDestructive(subcommand ?? "", subArgs)
    ) {
      throw new UsageError({
        message: `Refusing \`--json --interactive\` for destructive \`lore entity ${subcommand}\`.`,
        tryCommand: `lore entity ${subcommand} --json --yes`,
      });
    }

    // Central destructive confirmation policy: a destructive subcommand
    // is only flagged when it WILL mutate state. For `dedup`, legacy
    // gates the apply path on --yes, so without --yes it's a preview
    // (non-mutating). For other write-by-default subcommands (delete,
    // merge, alias rm, relation rm), any invocation without --yes in a
    // non-interactive environment will mutate state silently because
    // the legacy handlers do not prompt.
    const sub = subcommand ?? "";
    const destructive = isDestructive(sub, subArgs);
    const dryRun = flags["dry-run"];
    const willWrite =
      destructive && !dryRun && (sub === "dedup" ? flags.yes === true : true);
    if (willWrite && !flags.yes && (!process.stdin.isTTY || !!jsonFlag)) {
      throw new UsageError({
        message: `Refusing non-interactive \`lore entity ${sub}\` without --yes.`,
        tryCommand: `lore entity ${sub} --yes`,
      });
    }

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
    // Legacy dedup applies only when values.yes is true. Do not forward it
    // when --dry-run is present, so --dry-run always wins over --yes.
    if (flags.yes && !dryRun) values.yes = true;
    // F-4 (HIGH): forward --json (auto-injected by buildOutputCommand)
    // to the legacy handler. Legacy cmdList gates JSON output on
    // `flags.json` — without this, the legacy emits human table text
    // even when the typed pipeline's --json envelope is active.
    if (jsonFlag) values.json = true;
    // Stricli spreads the variadic positional array into individual
    // handler params; collect back into the legacy string[].
    const { exitCode, captured } = await runLegacyAndCollect(() =>
      commandEntity([subcommand ?? "", ...subArgs], values),
    );
    if (exitCode !== 0) {
      process.exitCode = exitCode;
    }
    return { kind: "value" as const, data: captured };
  },
});
