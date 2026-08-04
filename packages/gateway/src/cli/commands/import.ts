/**
 * `lore import` — typed Stricli command (Phase 3D.3e).
 *
 * Wraps the legacy `commandImport` from `../import` via the shared
 * `runLegacyAndCollect` bridge. The legacy handler reads flags from a
 * values dict (no positionals).
 *
 * Flags:
 *   - dry-run, yes/y, global, no-worktrees: booleans
 *   - agent, source, file, project: strings (filter / source paths)
 *   - mem0-qdrant, mem0-collection, mem0-server, mem0-token,
 *     mem0-path, mem0-user: mem0 provider config (strings)
 *
 * The kebab-case flag names are mapped to camelCase for the legacy
 * handler (e.g., `dry-run` → both `flags["dry-run"]` and `flags.dryRun`).
 *
 * Output shape:
 *   - human: rendered legacy text
 *   - JSON:  { output: <captured stdout> }
 *
 * Exit codes: legacy semantics preserved.
 */
import { buildOutputCommand } from "../lib/command";
import { runLegacyAndCollect } from "../lib/legacy-bridge";
import { commandImport } from "../import";

type ImportFlags = {
  // dry-run, yes, global, no-worktrees are required booleans because
  // they declare `default: false` (Stricli narrows the value type to
  // the literal false otherwise); --json auto-injected
  "dry-run": boolean;
  yes: boolean;
  agent?: string;
  source?: string;
  file?: string;
  global: boolean;
  "mem0-qdrant"?: string;
  "mem0-collection"?: string;
  "mem0-server"?: string;
  "mem0-token"?: string;
  "mem0-path"?: string;
  "mem0-user"?: string;
  "no-worktrees": boolean;
  project?: string;
};

export const importCommand = buildOutputCommand<string, ImportFlags, []>({
  brief: "Import knowledge from .lore.md / AGENTS.md files",
  fullDescription:
    "Bulk-import knowledge entries from .lore.md or AGENTS.md " +
    "files into the local lore DB. Flags: --dry-run, --yes/-y, " +
    "--agent, --source, --file, --global, --no-worktrees, --project, " +
    "and --mem0-* provider config. No positionals. " +
    "--json emits a structured envelope.",
  parameters: {
    // Single-character flag alias: -y → --yes (matching the legacy
    // OPTIONS table's `yes: { type: "boolean", short: "y" }`).
    aliases: { y: "yes" },
    flags: {
      "dry-run": {
        kind: "boolean",
        brief: "Show what would be imported without writing",
        default: false,
      },
      yes: {
        kind: "boolean",
        brief: "Skip confirmation prompts (alias: -y)",
        default: false,
      },
      agent: {
        kind: "parsed",
        parse: String,
        brief: "Filter imports to a specific agent (e.g., claude-code)",
        optional: true,
      },
      source: {
        kind: "parsed",
        parse: String,
        brief: "Source filter (e.g., user, repo, agent)",
        optional: true,
      },
      file: {
        kind: "parsed",
        parse: String,
        brief: "Import from a specific file (instead of scanning)",
        optional: true,
      },
      global: {
        kind: "boolean",
        brief: "Import to the global lore DB (default: project-scoped)",
        default: false,
      },
      "mem0-qdrant": {
        kind: "parsed",
        parse: String,
        brief: "Mem0 provider: Qdrant URL",
        optional: true,
      },
      "mem0-collection": {
        kind: "parsed",
        parse: String,
        brief: "Mem0 provider: collection name",
        optional: true,
      },
      "mem0-server": {
        kind: "parsed",
        parse: String,
        brief: "Mem0 provider: server URL",
        optional: true,
      },
      "mem0-token": {
        kind: "parsed",
        parse: String,
        brief: "Mem0 provider: auth token",
        optional: true,
      },
      "mem0-path": {
        kind: "parsed",
        parse: String,
        brief: "Mem0 provider: data path",
        optional: true,
      },
      "mem0-user": {
        kind: "parsed",
        parse: String,
        brief: "Mem0 provider: user identifier",
        optional: true,
      },
      "no-worktrees": {
        kind: "boolean",
        brief: "Skip worktree discovery (faster)",
        default: false,
      },
      project: {
        kind: "parsed",
        parse: String,
        brief: "Project directory (default: cwd)",
        optional: true,
      },
    },
  },
  config: {
    renderHuman: (data) => data,
    toJson: (data) => ({ output: data }),
  },
  async handler(flags) {
    // Forward the kebab-case flag names to the legacy handler, which
    // reads both the kebab and camelCase forms. We populate the legacy
    // camelCase aliases too so the legacy handler's existing checks
    // (flags.dryRun, flags.noWorktrees) work without modification.
    const values: Record<string, unknown> = {};
    if (flags["dry-run"]) {
      values["dry-run"] = true;
      values.dryRun = true;
    }
    if (flags.yes) {
      values.yes = true;
      values.y = true;
    }
    if (flags.agent !== undefined) values.agent = flags.agent;
    if (flags.source !== undefined) values.source = flags.source;
    if (flags.file !== undefined) values.file = flags.file;
    if (flags.global) values.global = true;
    if (flags["mem0-qdrant"] !== undefined)
      values["mem0-qdrant"] = flags["mem0-qdrant"];
    if (flags["mem0-collection"] !== undefined)
      values["mem0-collection"] = flags["mem0-collection"];
    if (flags["mem0-server"] !== undefined)
      values["mem0-server"] = flags["mem0-server"];
    if (flags["mem0-token"] !== undefined)
      values["mem0-token"] = flags["mem0-token"];
    if (flags["mem0-path"] !== undefined)
      values["mem0-path"] = flags["mem0-path"];
    if (flags["mem0-user"] !== undefined)
      values["mem0-user"] = flags["mem0-user"];
    if (flags["no-worktrees"]) {
      values["no-worktrees"] = true;
      values.noWorktrees = true;
    }
    if (flags.project !== undefined) values.project = flags.project;
    const { exitCode, captured } = await runLegacyAndCollect(() =>
      commandImport([], values),
    );
    if (exitCode !== 0) {
      process.exitCode = exitCode;
    }
    return { kind: "value" as const, data: captured };
  },
});
