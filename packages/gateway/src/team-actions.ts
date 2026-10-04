import {
  db,
  keystore,
  setProjectPromotionPolicy,
  scopeMemberRole,
  syncData,
} from "@loreai/core";
import type { GatewayConfig } from "./config";
import {
  accessFor,
  errorResponse,
  hostedRefusal,
  json,
  localIdentityLabel,
  readObjectBody,
  requestIsHosted,
  routeId,
} from "./folk-access";
import {
  createTeamInvite,
  isEmailAddress,
  removeTeamMember,
  sendInviteEmail,
  setTeamRole,
  teamMembers,
  TeamRpcError,
} from "./team";
import { sharingStatus } from "./folk-status";

const TEAM_ACTIONS = {
  add_by_id: "cli_only",
  offline_invite: "cli_only",
  list_invites: "unsupported",
  revoke_invite: "unsupported",
} as const;

function unavailableActions() {
  return {
    invite: "unavailable" as const,
    remove: "unavailable" as const,
    set_role: "unavailable" as const,
    ...TEAM_ACTIONS,
  };
}

function actionsFor(remote: string, role: string | null) {
  const capability =
    remote !== "ok"
      ? "unavailable"
      : role === "admin"
        ? "available"
        : "admin_only";
  return {
    invite: capability,
    remove: capability,
    set_role: capability,
    ...TEAM_ACTIONS,
  };
}

function teamName(scopeId: string): string | null {
  const row = db()
    .query("SELECT name FROM scopes WHERE id = ? AND kind = 'team'")
    .get(scopeId) as { name: string | null } | null;
  return row?.name ?? null;
}

function teamRpcError(error: unknown): Response {
  if (error instanceof TeamRpcError) {
    switch (error.code) {
      case "42501":
        return errorResponse(403, "forbidden", error.message);
      case "23514":
        return errorResponse(409, "last_admin", error.message);
      case "22023":
        return errorResponse(400, "invalid_request", error.message);
    }
  }
  return errorResponse(
    502,
    "remote_unreachable",
    error instanceof Error ? error.message : "Team service is unavailable",
  );
}

function unavailableAccess(remote: "anonymous" | "unreachable"): Response {
  return remote === "anonymous"
    ? errorResponse(403, "forbidden", "Sign in with `lore login` first.")
    : errorResponse(502, "remote_unreachable", "Team service is unavailable");
}

async function teamMembersStatus(
  scopeId: string,
  config: GatewayConfig,
): Promise<Response> {
  const access = await accessFor(config);
  if (access.remote !== "ok" || !access.client || !access.me) {
    return json({
      remote: access.remote,
      team: null,
      my_role: null,
      can_manage: false,
      members: [],
      actions: unavailableActions(),
    });
  }
  const myRole = scopeMemberRole(scopeId, access.me);
  if (myRole === null) return errorResponse(404, "not_found", "Team not found");

  const team = { id: scopeId, name: teamName(scopeId) };
  try {
    const members = await teamMembers(access.client, scopeId);
    return json({
      remote: "ok",
      team,
      my_role: myRole,
      can_manage: myRole === "admin",
      members: members.map((member) => ({
        user_id: member.userId,
        label:
          member.userId === access.me ? localIdentityLabel(access.me) : null,
        role: member.role,
        me: member.userId === access.me,
      })),
      actions: actionsFor("ok", myRole),
    });
  } catch {
    return json({
      remote: "unreachable",
      team,
      my_role: myRole,
      can_manage: false,
      members: [],
      actions: unavailableActions(),
    });
  }
}

async function teamMutationAccess(
  scopeId: string,
  config: GatewayConfig,
): Promise<
  | {
      client: NonNullable<Awaited<ReturnType<typeof accessFor>>["client"]>;
      me: string;
      role: string;
    }
  | Response
> {
  const access = await accessFor(config);
  if (access.remote !== "ok" || !access.client || !access.me) {
    return unavailableAccess(
      access.remote === "anonymous" ? "anonymous" : "unreachable",
    );
  }
  const role = scopeMemberRole(scopeId, access.me);
  if (role === null) return errorResponse(404, "not_found", "Team not found");
  if (keystore.encryptionState() !== "on") {
    return errorResponse(
      409,
      "encryption_locked",
      "Team key management needs encryption unlocked — run `lore sync enable` first.",
    );
  }
  if (!syncData.isSyncEnabled()) {
    return errorResponse(
      409,
      "sync_disabled",
      "Sync is not enabled — run `lore sync enable` first.",
    );
  }
  return { client: access.client, me: access.me, role };
}

async function createInvite(
  req: Request,
  scopeId: string,
  config: GatewayConfig,
): Promise<Response> {
  if (requestIsHosted(config))
    return hostedRefusal("Team actions are not available in hosted mode.");
  const body = await readObjectBody(req);
  if (body instanceof Response) return body;
  if (
    Object.keys(body).some((key) => key !== "role" && key !== "email") ||
    (body.role !== "editor" && body.role !== "viewer") ||
    (body.email !== undefined && typeof body.email !== "string")
  ) {
    return errorResponse(400, "invalid_request", "Invalid invite request");
  }
  if (
    typeof body.email === "string" &&
    (body.email.length > 320 || !isEmailAddress(body.email))
  ) {
    return errorResponse(
      400,
      "invalid_request",
      "email must be a valid address",
    );
  }
  const access = await teamMutationAccess(scopeId, config);
  if (access instanceof Response) return access;
  if (access.role !== "admin")
    return errorResponse(
      403,
      "not_admin",
      "Only team admins can invite members.",
    );
  try {
    const email =
      typeof body.email === "string" ? body.email.trim() : undefined;
    const token = await createTeamInvite(
      access.client,
      scopeId,
      body.role,
      email,
    );
    const emailed = email
      ? (await sendInviteEmail(access.client, token, email)).ok
      : false;
    return json(
      {
        invite: {
          team_id: scopeId,
          role: body.role,
          expires_in_days: 14,
          token,
          accept_command: `lore team accept ${token}`,
          emailed,
        },
      },
      201,
    );
  } catch (error) {
    return teamRpcError(error);
  }
}

async function changeMemberRole(
  req: Request,
  scopeId: string,
  userId: string,
  config: GatewayConfig,
): Promise<Response> {
  if (requestIsHosted(config))
    return hostedRefusal("Team actions are not available in hosted mode.");
  const body = await readObjectBody(req);
  if (body instanceof Response) return body;
  if (
    Object.keys(body).some(
      (key) => key !== "role" && key !== "expected_role",
    ) ||
    !["admin", "editor", "viewer"].includes(String(body.role)) ||
    !["admin", "editor", "viewer"].includes(String(body.expected_role))
  ) {
    return errorResponse(400, "invalid_request", "Invalid role request");
  }
  const access = await teamMutationAccess(scopeId, config);
  if (access instanceof Response) return access;
  if (userId === access.me) {
    return errorResponse(
      409,
      "self_action_unsupported",
      "You cannot change your own team role.",
    );
  }
  try {
    const target = (await teamMembers(access.client, scopeId)).find(
      (member) => member.userId === userId,
    );
    if (!target)
      return errorResponse(404, "not_found", "Team member not found");
    if (target.role !== body.expected_role) {
      return errorResponse(
        409,
        "stale_member",
        "Team member role changed; reload the team.",
        { current_role: target.role },
      );
    }
    await setTeamRole(
      access.client,
      scopeId,
      userId,
      body.role as "admin" | "editor" | "viewer",
    );
    return json({ member: { user_id: userId, role: body.role } });
  } catch (error) {
    return teamRpcError(error);
  }
}

async function removeMember(
  req: Request,
  scopeId: string,
  userId: string,
  config: GatewayConfig,
): Promise<Response> {
  if (requestIsHosted(config))
    return hostedRefusal("Team actions are not available in hosted mode.");
  const body = await readObjectBody(req);
  if (body instanceof Response) return body;
  if (
    Object.keys(body).some((key) => key !== "expected_role") ||
    !["admin", "editor", "viewer"].includes(String(body.expected_role))
  ) {
    return errorResponse(400, "invalid_request", "Invalid remove request");
  }
  const access = await teamMutationAccess(scopeId, config);
  if (access instanceof Response) return access;
  if (userId === access.me) {
    return errorResponse(
      409,
      "self_action_unsupported",
      "You cannot remove yourself from a team.",
    );
  }
  try {
    const target = (await teamMembers(access.client, scopeId)).find(
      (member) => member.userId === userId,
    );
    if (!target)
      return errorResponse(404, "not_found", "Team member not found");
    if (target.role !== body.expected_role) {
      return errorResponse(
        409,
        "stale_member",
        "Team member role changed; reload the team.",
        { current_role: target.role },
      );
    }
    const receipt = await removeTeamMember(access.client, scopeId, userId);
    return json({
      removed: userId,
      new_epoch: receipt.newEpoch,
      rewrapped: receipt.rewrapped,
      skipped_count: receipt.skipped.length,
    });
  } catch (error) {
    return teamRpcError(error);
  }
}

async function updateSharingPolicy(
  req: Request,
  projectId: string,
  config: GatewayConfig,
): Promise<Response> {
  if (requestIsHosted(config))
    return hostedRefusal(
      "Project sharing policy actions are not available in hosted mode.",
    );
  const body = await readObjectBody(req);
  if (body instanceof Response) return body;
  if (
    Object.keys(body).some(
      (key) => key !== "policy" && key !== "expected_override",
    ) ||
    (body.policy !== "manual" && body.policy !== "auto") ||
    !Object.hasOwn(body, "expected_override") ||
    (body.expected_override !== null &&
      body.expected_override !== "manual" &&
      body.expected_override !== "auto")
  ) {
    return errorResponse(
      400,
      "invalid_request",
      "Invalid sharing policy request",
    );
  }
  if (body.policy === "auto") {
    return errorResponse(
      400,
      "unsupported_policy",
      "Automatic promotion bypasses reviewer approval and is not supported here.",
    );
  }
  const current = sharingStatus(config, projectId);
  if (!current) return errorResponse(404, "not_found", "Project not found");
  if (!current.linked)
    return errorResponse(409, "not_linked", "Project is not linked to a team.");
  if (current.policy.project_override !== body.expected_override) {
    return errorResponse(
      409,
      "stale_policy",
      "Project sharing policy changed; reload the project.",
      { current_override: current.policy.project_override },
    );
  }
  setProjectPromotionPolicy(projectId, "manual");
  const updated = sharingStatus(config, projectId);
  return updated
    ? json(updated)
    : errorResponse(404, "not_found", "Project not found");
}

export async function handleTeamActionRequest(
  req: Request,
  url: URL,
  config: GatewayConfig,
): Promise<Response | null> {
  const path = url.pathname;
  let match: RegExpExecArray | null;
  if (req.method === "GET") {
    match = /^\/api\/v1\/teams\/([^/]+)\/members$/.exec(path);
    if (match) {
      const scopeId = routeId(match[1], "Team id");
      return scopeId instanceof Response
        ? scopeId
        : teamMembersStatus(scopeId, config);
    }
  }
  if (req.method === "POST") {
    match = /^\/api\/v1\/teams\/([^/]+)\/invites$/.exec(path);
    if (match) {
      const scopeId = routeId(match[1], "Team id");
      return scopeId instanceof Response
        ? scopeId
        : createInvite(req, scopeId, config);
    }
    match = /^\/api\/v1\/teams\/([^/]+)\/members\/([^/]+)\/role$/.exec(path);
    if (match) {
      const scopeId = routeId(match[1], "Team id");
      const userId = routeId(match[2], "User id");
      if (scopeId instanceof Response) return scopeId;
      return userId instanceof Response
        ? userId
        : changeMemberRole(req, scopeId, userId, config);
    }
    match = /^\/api\/v1\/teams\/([^/]+)\/members\/([^/]+)\/remove$/.exec(path);
    if (match) {
      const scopeId = routeId(match[1], "Team id");
      const userId = routeId(match[2], "User id");
      if (scopeId instanceof Response) return scopeId;
      return userId instanceof Response
        ? userId
        : removeMember(req, scopeId, userId, config);
    }
    match = /^\/api\/v1\/projects\/([^/]+)\/sharing\/policy$/.exec(path);
    if (match) {
      const projectId = routeId(match[1], "Project id");
      return projectId instanceof Response
        ? projectId
        : updateSharingPolicy(req, projectId, config);
    }
  }
  return null;
}
