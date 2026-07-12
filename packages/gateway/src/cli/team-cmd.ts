/**
 * `lore team` — manage shared team scopes (E-4c-4, #827): membership + per-member DEK wrapping +
 * key rotation on removal. Thin CLI over the client-injected orchestration in ../team.ts.
 */
import { resolve } from "node:path";
import {
  effectivePromotionPolicy,
  keystore,
  ltm,
  projectId,
  resolveWritableScope,
  setProjectPromotionPolicy,
  setProjectScope,
  syncData,
} from "@loreai/core";
import { getAuthedClient, getCurrentUser } from "../supabase";
import {
  addTeamMember,
  createTeam,
  listTeams,
  removeTeamMember,
  setTeamRole,
  teamMembers,
} from "../team";

const USAGE =
  "Usage: lore team [list | members <scope> | create <name> | add <scope> <userId> [role] | remove <scope> <userId> | set-role <scope> <userId> <role> | link <team> [--project <path>] | unlink [--project <path>] | review [--project <path>] | approve <id> | reject <id> | policy <manual|auto> [--project <path>]]";

export async function commandTeam(
  positionals: string[],
  values: Record<string, unknown>,
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
      case "link": {
        // Bind THIS project (cwd or --project) to a team scope: the promotion TARGET. Local only —
        // content is not shared until it is promoted+approved (F3-2/F3-3). Resolves the team from
        // the pulled registry mirror (F1), requiring the caller to be a write member.
        const teamRef = positionals[1];
        if (!teamRef) return usage();
        const projectPath = resolve(
          (values.project as string) ?? process.cwd(),
        );
        const pid = projectId(projectPath);
        if (!pid) {
          console.error(
            `No lore project for ${projectPath} yet — use lore here first, or pass --project <path>.`,
          );
          process.exitCode = 1;
          return;
        }
        const user = await getCurrentUser();
        if (!user) {
          console.error("Not logged in — run `lore login` first.");
          process.exitCode = 1;
          return;
        }
        const scope = resolveWritableScope(teamRef, user.user_id);
        if (!scope) {
          console.error(
            `No team "${teamRef}" you can write to in the local registry. Run \`lore sync now\` to refresh, then \`lore team list\`.`,
          );
          process.exitCode = 1;
          return;
        }
        setProjectScope(pid, scope.id);
        const policy = effectivePromotionPolicy(pid);
        console.log(
          `Linked this project to team "${scope.name ?? scope.id}" (${scope.id}).`,
        );
        console.log(
          policy === "auto"
            ? "Policy: AUTO — new knowledge here will be shared to the team."
            : "Policy: MANUAL — knowledge here stays personal until you approve it for the team (`lore team review`).",
        );
        break;
      }
      case "unlink": {
        const projectPath = resolve(
          (values.project as string) ?? process.cwd(),
        );
        const pid = projectId(projectPath);
        if (!pid) {
          console.error(`No lore project for ${projectPath}.`);
          process.exitCode = 1;
          return;
        }
        setProjectScope(pid, null);
        console.log("Unlinked — this project's knowledge stays personal.");
        break;
      }
      case "review": {
        // List knowledge awaiting team-promotion review. Scoped to --project if given, else all
        // team-bound projects. An explicit but unknown --project errors (don't silently widen to all).
        let proj: string | undefined;
        if (values.project) {
          const rp = resolve(values.project as string);
          proj = projectId(rp);
          if (!proj) {
            console.error(`No lore project for ${rp}.`);
            process.exitCode = 1;
            return;
          }
        }
        const pending = ltm.listPendingTeamPromotions(proj);
        if (pending.length === 0) {
          console.log("Nothing pending team review.");
          break;
        }
        for (const p of pending)
          console.log(`${p.logicalId}  [${p.category}]  ${p.title}`);
        console.log(
          "\nApprove with `lore team approve <id>`, reject with `lore team reject <id>`.",
        );
        break;
      }
      case "approve": {
        const id = positionals[1];
        if (!id) return usage();
        const user = await getCurrentUser();
        if (!ltm.approveForTeam(id, user?.user_id)) {
          console.error(`No current knowledge entry "${id}".`);
          process.exitCode = 1;
          return;
        }
        console.log(`Approved ${id} for team promotion.`);
        break;
      }
      case "reject": {
        const id = positionals[1];
        if (!id) return usage();
        if (!ltm.rejectForTeam(id)) {
          console.error(`No current knowledge entry "${id}".`);
          process.exitCode = 1;
          return;
        }
        console.log(`Rejected ${id} — it stays personal.`);
        break;
      }
      case "policy": {
        const policy = positionals[1];
        if (policy !== "manual" && policy !== "auto") return usage();
        const projectPath = resolve(
          (values.project as string) ?? process.cwd(),
        );
        const pid = projectId(projectPath);
        if (!pid) {
          console.error(`No lore project for ${projectPath}.`);
          process.exitCode = 1;
          return;
        }
        setProjectPromotionPolicy(pid, policy);
        console.log(`Set this project's team-promotion policy to ${policy}.`);
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
