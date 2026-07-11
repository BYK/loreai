/**
 * `lore team` — manage shared team scopes (E-4c-4, #827): membership + per-member DEK wrapping +
 * key rotation on removal. Thin CLI over the client-injected orchestration in ../team.ts.
 */
import { keystore, syncData } from "@loreai/core";
import { getAuthedClient } from "../supabase";
import {
  addTeamMember,
  createTeam,
  listTeams,
  removeTeamMember,
  setTeamRole,
  teamMembers,
} from "../team";

const USAGE =
  "Usage: lore team [list | members <scope> | create <name> | add <scope> <userId> [role] | remove <scope> <userId> | set-role <scope> <userId> <role>]";

export async function commandTeam(
  positionals: string[],
  _values: Record<string, unknown>,
): Promise<void> {
  const sub = positionals[0] ?? "list";

  const client = await getAuthedClient();
  if (!client) {
    console.error("Not logged in — run `lore login` first.");
    process.exitCode = 1;
    return;
  }
  // Mutating a team's KEYS needs an unlocked identity (to mint/wrap DEKs) and sync enabled (so the
  // scope_keys writes are captured and pushed). Read-only list/members need neither — only auth.
  const MUTATING = new Set(["create", "add", "remove", "set-role"]);
  if (MUTATING.has(sub)) {
    if (keystore.encryptionState() !== "on") {
      console.error(
        "Team key management needs encryption unlocked — run `lore sync enable` first.",
      );
      process.exitCode = 1;
      return;
    }
    if (!syncData.isSyncEnabled()) {
      console.error("Sync is not enabled — run `lore sync enable` first.");
      process.exitCode = 1;
      return;
    }
  }

  try {
    switch (sub) {
      case "list": {
        const teams = await listTeams(client);
        if (teams.length === 0) {
          console.log(
            "No teams yet. Create one with `lore team create <name>`.",
          );
          break;
        }
        for (const t of teams)
          console.log(`${t.scopeId}  ${t.role.padEnd(6)}  ${t.name}`);
        break;
      }
      case "members": {
        const scope = positionals[1];
        if (!scope) return usage();
        for (const m of await teamMembers(client, scope))
          console.log(`${m.userId}  ${m.role}`);
        break;
      }
      case "create": {
        const name = positionals.slice(1).join(" ").trim();
        if (!name) return usage();
        const scopeId = await createTeam(client, name);
        console.log(`Created team "${name}" (${scopeId}).`);
        break;
      }
      case "add": {
        const [, scope, userId, role = "editor"] = positionals;
        if (!scope || !userId) return usage();
        if (role !== "admin" && role !== "editor" && role !== "viewer")
          return usage();
        const { wrapped } = await addTeamMember(client, scope, userId, role);
        console.log(
          wrapped
            ? `Added ${userId} and shared the team key.`
            : `Added ${userId}. They have not published an encryption key yet — re-run \`lore team add\` once they've synced so they can decrypt.`,
        );
        break;
      }
      case "remove": {
        const [, scope, userId] = positionals;
        if (!scope || !userId) return usage();
        const { newEpoch, rewrapped, skipped } = await removeTeamMember(
          client,
          scope,
          userId,
        );
        console.log(
          `Removed ${userId} and rotated the team key to epoch ${newEpoch} (${rewrapped} member(s) re-wrapped).`,
        );
        if (skipped.length > 0)
          console.log(
            `  Warning: ${skipped.length} member(s) had no published key and lost access until re-added: ${skipped.join(", ")}`,
          );
        break;
      }
      case "set-role": {
        const [, scope, userId, role] = positionals;
        if (!scope || !userId || !role) return usage();
        if (role !== "admin" && role !== "editor" && role !== "viewer")
          return usage();
        await setTeamRole(client, scope, userId, role);
        console.log(`Set ${userId} to ${role}.`);
        break;
      }
      default:
        return usage();
    }
  } catch (e) {
    console.error(`lore team: ${(e as Error).message}`);
    process.exitCode = 1;
  }
}

function usage(): void {
  console.error(USAGE);
  process.exitCode = 1;
}
