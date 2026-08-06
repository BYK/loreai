/**
 * `lore recall` — typed Stricli command.
 *
 * Recall writes its established markdown or raw JSON format directly, rather
 * than wrapping it in the generic output envelope. This keeps it useful in
 * shell pipelines and preserves the remote gateway response format.
 */
import { commandRecall } from "../recall-cmd";
import { buildCommand } from "../lib/command";

type RecallFlags = {
  project?: string;
  scope?: string;
  session?: string;
  limit?: number;
  json: boolean;
};

export const recallCommand = buildCommand<RecallFlags, readonly string[]>({
  brief: "Search Lore project memory",
  fullDescription:
    "Search local project memory, or the configured remote gateway when " +
    "LORE_REMOTE_URL is set. Query words are joined with spaces. Use " +
    "--scope session with --session to search one session.",
  parameters: {
    flags: {
      project: {
        kind: "parsed",
        parse: String,
        brief: "Project directory (default: current directory)",
        optional: true,
      },
      scope: {
        kind: "parsed",
        parse: String,
        brief: "Search scope (all | session | project | knowledge)",
        optional: true,
      },
      session: {
        kind: "parsed",
        parse: String,
        brief: "Session ID (required with --scope session)",
        optional: true,
      },
      limit: {
        kind: "parsed",
        parse: Number,
        brief: "Maximum results (default: 10)",
        optional: true,
      },
      json: {
        kind: "boolean",
        brief: "Output raw JSON instead of formatted markdown",
        default: false,
      },
    },
    positional: {
      kind: "array",
      parameter: {
        parse: String,
        brief: "Search query",
      },
    },
  },
  async handler(flags, ...positionals) {
    const values: Record<string, unknown> = { json: flags.json };
    if (flags.project) values.project = flags.project;
    if (flags.scope) values.scope = flags.scope;
    if (flags.session) values.session = flags.session;
    if (flags.limit !== undefined) values.limit = flags.limit;
    await commandRecall([...positionals], values);
  },
});
