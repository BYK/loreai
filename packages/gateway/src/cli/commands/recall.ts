/**
 * `lore recall` — typed Stricli command.
 *
 * Recall writes its established markdown or raw JSON format directly, rather
 * than wrapping it in the generic output envelope. This keeps it useful in
 * shell pipelines and preserves the remote gateway response format.
 */
import { commandRecall } from "../recall-cmd";
import { buildCommand } from "../lib/command";
import { emitCliError, NetworkError, UsageError } from "../lib/errors";
import { runLegacyAndCollect } from "../lib/legacy-bridge";

const RECALL_SCOPES = new Set(["all", "session", "project", "knowledge"]);

function parseScope(input: string): string {
  if (!RECALL_SCOPES.has(input)) {
    throw new Error(`Invalid recall scope: ${input}`);
  }
  return input;
}

function parseLimit(input: string): number {
  const limit = Number(input);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new Error("Recall limit must be an integer from 1 to 50");
  }
  return limit;
}

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
        parse: parseScope,
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
        parse: parseLimit,
        brief: "Maximum results, from 1 to 50 (default: 10)",
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
    if (positionals.length === 0) {
      emitCliError(
        new UsageError({
          message: "Please provide a search query.",
          tryCommand: "lore recall <query>",
        }),
        this,
        flags.json,
      );
      return;
    }
    if (flags.scope === "session" && !flags.session) {
      emitCliError(
        new UsageError({
          message: "--scope session requires --session <id>.",
          tryCommand: "lore recall <query> --scope session --session <id>",
        }),
        this,
        flags.json,
      );
      return;
    }

    const values: Record<string, unknown> = { json: flags.json };
    if (flags.project) values.project = flags.project;
    if (flags.scope) values.scope = flags.scope;
    if (flags.session) values.session = flags.session;
    if (flags.limit !== undefined) values.limit = flags.limit;
    const { captured, exitCode } = await runLegacyAndCollect(() =>
      commandRecall([...positionals], values),
    );
    if (exitCode !== 0) {
      emitCliError(
        new NetworkError({ message: captured.trim() || "Recall failed." }),
        this,
        Boolean(flags.json),
      );
      return;
    }

    this.process.stdout.write(captured);
  },
});
