/**
 * `lore team` — typed Stricli command (Phase 3D.3c).
 *
 * Wraps the legacy `commandTeam` from `../team-cmd` via the shared
 * `runLegacyAndCollect` bridge. The legacy handler takes:
 *
 *   - positionals[0]: subcommand (list | members | discover | create | add
 *                     | remove | set-role | invite | accept | link | unlink
 *                     | review | approve | reject | policy | domain)
 *   - positionals[1+]: subcommand-specific args (e.g., `add <scope> <userId>`)
 *
 * Flags forwarded to the legacy values dict: --invite, --role, --email,
 * --offline, --project.
 *
 * Output shape:
 *   - human: rendered legacy text
 *   - JSON:  { output: <captured stdout> }
 *
 * Exit codes: legacy semantics preserved.
 */
import { buildOutputCommand } from "../lib/command";
import { runLegacyAndCollect } from "../lib/legacy-bridge";
import { commandTeam } from "../team-cmd";

type TeamFlags = {
  invite?: string;
  role?: string;
  email?: string;
  offline: boolean;
  project?: string;
};

export const teamCommand = buildOutputCommand<
  string,
  TeamFlags,
  readonly string[]
>({
  brief: "Manage team membership and roles",
  fullDescription:
    "Team configuration: list members, invite, assign roles, remove " +
    "members. Subcommands include list, members, discover, create, " +
    "add, remove, set-role, invite, accept, link, unlink, review, " +
    "approve, reject, policy, domain. The first positional selects " +
    "the subcommand; subsequent positionals are subcommand-specific " +
    "args. Flags --invite, --role, --email, --offline, --project " +
    "are forwarded as values. --json emits a structured envelope.",
  parameters: {
    flags: {
      invite: {
        kind: "parsed",
        parse: String,
        brief: "Team to invite discoverer to",
        optional: true,
      },
      role: {
        kind: "parsed",
        parse: String,
        brief: "Role to assign (editor | viewer | member)",
        optional: true,
      },
      email: {
        kind: "parsed",
        parse: String,
        brief: "Email hint for the invitee",
        optional: true,
      },
      offline: {
        kind: "boolean",
        brief: "Mark the invite as offline (no browser flow)",
        default: false,
      },
      project: {
        kind: "parsed",
        parse: String,
        brief: "Project directory (default: cwd)",
        optional: true,
      },
    },
    positional: {
      kind: "array",
      parameter: {
        parse: String,
        brief: "team subcommand + subcommand-specific args",
      },
    },
  },
  config: {
    renderHuman: (data) => data,
    toJson: (data) => ({ output: data }),
  },
  async handler(flags, ...positionals) {
    const values: Record<string, unknown> = {};
    if (flags.invite) values.invite = flags.invite;
    if (flags.role) values.role = flags.role;
    if (flags.email) values.email = flags.email;
    if (flags.offline) values.offline = true;
    if (flags.project) values.project = flags.project;
    // Stricli spreads the variadic positional array into individual
    // handler params; collect them back into the legacy string[].
    const positionalsArr = positionals.filter(
      (p): p is string => typeof p === "string",
    );
    const { exitCode, captured } = await runLegacyAndCollect(() =>
      commandTeam(positionalsArr, values),
    );
    if (exitCode !== 0) {
      process.exitCode = exitCode;
    }
    return { kind: "value" as const, data: captured };
  },
});
