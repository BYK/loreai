import {
  db,
  keystore,
  scopeMemberRole,
  setProjectScope,
  setProjectPromotionPolicy,
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
  addTeamMember,
  acceptTeamInvite,
  approveDomainJoin,
  claimOrgDomain,
  createTeam,
  discoverGitHubContributors,
  identityLabel,
  isEmailAddress,
  listDomainJoinRequests,
  listTeams,
  removeTeamMember,
  rejectDomainJoin,
  requestDomainJoin,
  sendInviteEmail,
  setTeamRole,
  teamMembers,
  teamMemberProfiles,
  TeamRpcError,
} from "./team";
import { sharingStatus } from "./folk-status";
import { loadCachedProviderToken, loadPersistedSession } from "./supabase";

const UNSUPPORTED_TEAM_ACTIONS = {
  list_invites: "unsupported",
  revoke_invite: "unsupported",
} as const;

function unavailableActions() {
  return {
    invite: "unavailable" as const,
    remove: "unavailable" as const,
    set_role: "unavailable" as const,
    add_by_id: "unavailable" as const,
    offline_invite: "unavailable" as const,
    ...UNSUPPORTED_TEAM_ACTIONS,
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
    add_by_id: capability,
    offline_invite: capability,
    ...UNSUPPORTED_TEAM_ACTIONS,
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
      case "40001":
        return errorResponse(409, "rotation_conflict", error.message);
      case "P0002":
        return errorResponse(404, "not_found", error.message);
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
    let profiles: Awaited<ReturnType<typeof teamMemberProfiles>> = [];
    let profileLookupFailed = false;
    try {
      profiles = await teamMemberProfiles(access.client, scopeId);
    } catch {
      profileLookupFailed = true;
    }
    const profilesByUser = new Map(
      profiles.map((profile) => [profile.user_id, profile]),
    );
    return json({
      remote: "ok",
      team,
      my_role: myRole,
      can_manage: myRole === "admin",
      members: members.map((member) => {
        const profile = profilesByUser.get(member.userId);
        return {
          user_id: member.userId,
          label: profile
            ? identityLabel(profile)
            : profileLookupFailed && member.userId === access.me
              ? localIdentityLabel(access.me)
              : null,
          role: member.role,
          me: member.userId === access.me,
        };
      }),
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

async function signedMutationAccess(config: GatewayConfig): Promise<
  | {
      client: NonNullable<Awaited<ReturnType<typeof accessFor>>["client"]>;
      me: string;
    }
  | Response
> {
  const access = await accessFor(config);
  if (access.remote !== "ok" || !access.client || !access.me) {
    return unavailableAccess(
      access.remote === "anonymous" ? "anonymous" : "unreachable",
    );
  }
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
  return { client: access.client, me: access.me };
}

async function createTeamRoute(
  req: Request,
  config: GatewayConfig,
): Promise<Response> {
  if (requestIsHosted(config))
    return hostedRefusal("Team actions are not available in hosted mode.");
  const body = await readObjectBody(req);
  if (body instanceof Response) return body;
  if (
    Object.keys(body).some((key) => key !== "name") ||
    typeof body.name !== "string" ||
    body.name.trim().length < 1 ||
    body.name.trim().length > 120
  ) {
    return errorResponse(400, "invalid_request", "Invalid team name");
  }
  const access = await signedMutationAccess(config);
  if (access instanceof Response) return access;
  const name = body.name.trim();
  try {
    const id = await createTeam(access.client, name);
    return json({ team: { id, name } }, 201);
  } catch (error) {
    return teamRpcError(error);
  }
}

async function addMemberById(
  req: Request,
  scopeId: string,
  config: GatewayConfig,
): Promise<Response> {
  if (requestIsHosted(config))
    return hostedRefusal("Team actions are not available in hosted mode.");
  const body = await readObjectBody(req);
  if (body instanceof Response) return body;
  if (
    Object.keys(body).some((key) => key !== "user_id" && key !== "role") ||
    typeof body.user_id !== "string" ||
    !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(body.user_id) ||
    (body.role !== undefined &&
      body.role !== "admin" &&
      body.role !== "editor" &&
      body.role !== "viewer")
  ) {
    return errorResponse(400, "invalid_request", "Invalid member request");
  }
  const access = await teamMutationAccess(scopeId, config);
  if (access instanceof Response) return access;
  if (access.role !== "admin")
    return errorResponse(403, "not_admin", "Only team admins can add members.");
  try {
    const role = body.role ?? "editor";
    const result = await addTeamMember(
      access.client,
      scopeId,
      body.user_id,
      role,
    );
    return json(
      { member: { user_id: body.user_id, role, wrapped: result.wrapped } },
      201,
    );
  } catch (error) {
    return teamRpcError(error);
  }
}

async function acceptInvite(
  req: Request,
  config: GatewayConfig,
): Promise<Response> {
  if (requestIsHosted(config))
    return hostedRefusal("Team actions are not available in hosted mode.");
  const body = await readObjectBody(req);
  if (body instanceof Response) return body;
  if (
    Object.keys(body).some((key) => key !== "token") ||
    typeof body.token !== "string" ||
    body.token.length < 1 ||
    body.token.length > 4096 ||
    body.token.trim() !== body.token
  ) {
    return errorResponse(400, "invalid_request", "Invalid invite token");
  }
  const access = await signedMutationAccess(config);
  if (access instanceof Response) return access;
  try {
    const joined = await acceptTeamInvite(access.client, body.token);
    return json({
      joined: { scope_id: joined.scopeId, role: joined.role },
    });
  } catch (error) {
    return teamRpcError(error);
  }
}

async function updateProjectLink(
  req: Request,
  projectId: string,
  config: GatewayConfig,
): Promise<Response> {
  if (requestIsHosted(config))
    return hostedRefusal(
      "Project sharing actions are not available in hosted mode.",
    );
  const body = await readObjectBody(req);
  if (body instanceof Response) return body;
  if (
    Object.keys(body).some(
      (key) => key !== "scope_id" && key !== "expected_scope_id",
    ) ||
    !Object.hasOwn(body, "scope_id") ||
    !Object.hasOwn(body, "expected_scope_id") ||
    (body.scope_id !== null &&
      (typeof body.scope_id !== "string" ||
        !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(
          body.scope_id,
        ))) ||
    (body.expected_scope_id !== null &&
      (typeof body.expected_scope_id !== "string" ||
        !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(
          body.expected_scope_id,
        )))
  ) {
    return errorResponse(400, "invalid_request", "Invalid team link request");
  }
  const currentStatus = sharingStatus(config, projectId);
  if (!currentStatus)
    return errorResponse(404, "not_found", "Project not found");
  const currentScope = currentStatus.linked ? currentStatus.team?.id : null;
  if (currentScope !== body.expected_scope_id) {
    return errorResponse(
      409,
      "stale_link",
      "Project team link changed; reload the project.",
      { current_scope_id: currentScope },
    );
  }
  const nextScope = body.scope_id;
  if (nextScope !== null) {
    const access = await accessFor(config);
    if (access.remote !== "ok" || !access.client || !access.me)
      return unavailableAccess(
        access.remote === "anonymous" ? "anonymous" : "unreachable",
      );
    const teams = await listTeams(access.client);
    const team = teams.find((item) => item.scopeId === nextScope);
    if (!team) return errorResponse(404, "not_found", "Team not found");
    if (team.role === "viewer")
      return errorResponse(
        403,
        "forbidden",
        "Editors or admins can link a project.",
      );
  }
  setProjectScope(projectId, nextScope);
  const status = sharingStatus(config, projectId);
  return status
    ? json(status)
    : errorResponse(404, "not_found", "Project not found");
}

function orgList(config: GatewayConfig): Response {
  if (requestIsHosted(config)) return json({ organizations: [] });
  const session = loadPersistedSession();
  if (!session) return json({ organizations: [] });
  const organizations = db()
    .query(
      `SELECT o.id, o.name, om.role
       FROM org_members om JOIN orgs o ON o.id = om.org_id
       WHERE om.user_id = ? AND o.kind = 'team'
       ORDER BY o.name`,
    )
    .all(session.user_id) as Array<{
    id: string;
    name: string | null;
    role: string;
  }>;
  return json({ organizations });
}

async function discoverContributors(
  req: Request,
  scopeId: string,
  config: GatewayConfig,
): Promise<Response> {
  if (requestIsHosted(config))
    return hostedRefusal("Team actions are not available in hosted mode.");
  const body = await readObjectBody(req);
  if (body instanceof Response) return body;
  const allowedKeys = new Set(["repos", "invite_role", "invite_logins"]);
  const repos = body.repos;
  const inviteLogins = body.invite_logins;
  if (
    Object.keys(body).some((key) => !allowedKeys.has(key)) ||
    (repos !== undefined &&
      (!Array.isArray(repos) ||
        repos.length > 50 ||
        repos.some(
          (repo) =>
            typeof repo !== "string" || repo.length < 1 || repo.length > 255,
        ))) ||
    (body.invite_role !== undefined &&
      body.invite_role !== "editor" &&
      body.invite_role !== "viewer") ||
    (inviteLogins !== undefined &&
      (!Array.isArray(inviteLogins) ||
        inviteLogins.length < 1 ||
        inviteLogins.length > 200 ||
        inviteLogins.some(
          (login) =>
            typeof login !== "string" || !/^[A-Za-z0-9-]{1,39}$/.test(login),
        )))
  ) {
    return errorResponse(400, "invalid_request", "Invalid contributor request");
  }
  const access = await teamMutationAccess(scopeId, config);
  if (access instanceof Response) return access;
  if (access.role !== "admin")
    return errorResponse(
      403,
      "not_admin",
      "Only team admins can discover contributors.",
    );
  const cached = loadCachedProviderToken();
  if (!cached)
    return errorResponse(
      409,
      "github_auth_required",
      "A current GitHub authorization is required to discover contributors.",
    );
  try {
    const invite: { scopeId: string; role: "editor" | "viewer" } | undefined =
      inviteLogins
        ? {
            scopeId,
            role: body.invite_role === "viewer" ? "viewer" : "editor",
          }
        : undefined;
    const result = await discoverGitHubContributors(
      access.client,
      cached.provider_token,
      repos as string[] | undefined,
      invite,
      inviteLogins as string[] | undefined,
    );
    return result
      ? json(result)
      : errorResponse(
          409,
          "github_auth_required",
          "A current GitHub authorization is required to discover contributors.",
        );
  } catch (error) {
    return teamRpcError(error);
  }
}

function validDomain(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 253 &&
    /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(value) &&
    value.includes(".") &&
    !value.includes("..")
  );
}

async function updateDomain(
  req: Request,
  orgId: string,
  action: "claim" | "request",
  config: GatewayConfig,
): Promise<Response> {
  if (requestIsHosted(config))
    return hostedRefusal(
      "Organization domain actions are not available in hosted mode.",
    );
  const body = await readObjectBody(req);
  if (body instanceof Response) return body;
  if (
    Object.keys(body).some((key) => key !== "domain" && key !== "role") ||
    !validDomain(body.domain) ||
    (action === "request" && body.role !== undefined) ||
    (action === "claim" &&
      body.role !== undefined &&
      body.role !== "manager" &&
      body.role !== "billing" &&
      body.role !== "member")
  ) {
    return errorResponse(
      400,
      "invalid_request",
      "Invalid organization domain request",
    );
  }
  const access = await accessFor(config);
  if (access.remote !== "ok" || !access.client)
    return unavailableAccess(
      access.remote === "anonymous" ? "anonymous" : "unreachable",
    );
  try {
    if (action === "claim") {
      await claimOrgDomain(
        access.client,
        orgId,
        body.domain,
        (body.role ?? "member") as "manager" | "billing" | "member",
      );
      return json({ claimed: body.domain });
    }
    const id = await requestDomainJoin(access.client, orgId, body.domain);
    return json({ request_id: id }, 201);
  } catch (error) {
    return teamRpcError(error);
  }
}

async function domainRequests(
  orgId: string,
  config: GatewayConfig,
): Promise<Response> {
  if (requestIsHosted(config))
    return hostedRefusal(
      "Organization domain actions are not available in hosted mode.",
    );
  const access = await accessFor(config);
  if (access.remote !== "ok" || !access.client)
    return unavailableAccess(
      access.remote === "anonymous" ? "anonymous" : "unreachable",
    );
  try {
    const requests = await listDomainJoinRequests(access.client, orgId);
    return json({
      requests: requests.map((request) => ({
        id: request.id,
        domain: request.domain,
        user_id: request.userId,
        status: request.status,
        requested_at: request.requestedAt,
      })),
    });
  } catch (error) {
    return teamRpcError(error);
  }
}

async function decideDomainRequest(
  orgId: string,
  requestId: string,
  decision: "approve" | "reject",
  config: GatewayConfig,
): Promise<Response> {
  if (requestIsHosted(config))
    return hostedRefusal(
      "Organization domain actions are not available in hosted mode.",
    );
  const access = await accessFor(config);
  if (access.remote !== "ok" || !access.client)
    return unavailableAccess(
      access.remote === "anonymous" ? "anonymous" : "unreachable",
    );
  try {
    if (decision === "approve")
      await approveDomainJoin(access.client, requestId);
    else await rejectDomainJoin(access.client, requestId);
    return json({
      request_id: requestId,
      status: decision === "approve" ? "approved" : "rejected",
    });
  } catch (error) {
    return teamRpcError(error);
  }
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
    Object.keys(body).some(
      (key) => key !== "role" && key !== "email" && key !== "offline",
    ) ||
    (body.role !== "editor" && body.role !== "viewer") ||
    (body.email !== undefined && typeof body.email !== "string") ||
    (body.offline !== undefined && typeof body.offline !== "boolean")
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
      { offline: body.offline === true },
    );
    const emailed =
      email && body.offline !== true
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
  if (access.role !== "admin") {
    return errorResponse(
      403,
      "not_admin",
      "Only team admins can change or remove members.",
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
  if (access.role !== "admin") {
    return errorResponse(
      403,
      "not_admin",
      "Only team admins can change or remove members.",
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
      unlinked_projects: receipt.unlinkedProjects,
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
  setProjectPromotionPolicy(projectId, body.policy);
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
    if (path === "/api/v1/orgs") return orgList(config);
    match = /^\/api\/v1\/orgs\/([^/]+)\/domains\/requests$/.exec(path);
    if (match) {
      const orgId = routeId(match[1], "Organization id");
      return orgId instanceof Response ? orgId : domainRequests(orgId, config);
    }
    match = /^\/api\/v1\/teams\/([^/]+)\/members$/.exec(path);
    if (match) {
      const scopeId = routeId(match[1], "Team id");
      return scopeId instanceof Response
        ? scopeId
        : teamMembersStatus(scopeId, config);
    }
  }
  if (req.method === "POST") {
    if (path === "/api/v1/teams") return createTeamRoute(req, config);
    if (path === "/api/v1/teams/accept") return acceptInvite(req, config);
    match = /^\/api\/v1\/orgs\/([^/]+)\/domains\/(claim|request)$/.exec(path);
    if (match) {
      const orgId = routeId(match[1], "Organization id");
      return orgId instanceof Response
        ? orgId
        : updateDomain(req, orgId, match[2] as "claim" | "request", config);
    }
    match =
      /^\/api\/v1\/orgs\/([^/]+)\/domains\/requests\/([^/]+)\/(approve|reject)$/.exec(
        path,
      );
    if (match) {
      const orgId = routeId(match[1], "Organization id");
      const requestId = routeId(match[2], "Domain request id");
      if (orgId instanceof Response) return orgId;
      return requestId instanceof Response
        ? requestId
        : decideDomainRequest(
            orgId,
            requestId,
            match[3] as "approve" | "reject",
            config,
          );
    }
    match = /^\/api\/v1\/teams\/([^/]+)\/members$/.exec(path);
    if (match) {
      const scopeId = routeId(match[1], "Team id");
      return scopeId instanceof Response
        ? scopeId
        : addMemberById(req, scopeId, config);
    }
    match = /^\/api\/v1\/teams\/([^/]+)\/discover$/.exec(path);
    if (match) {
      const scopeId = routeId(match[1], "Team id");
      return scopeId instanceof Response
        ? scopeId
        : discoverContributors(req, scopeId, config);
    }
    match = /^\/api\/v1\/projects\/([^/]+)\/sharing\/link$/.exec(path);
    if (match) {
      const projectId = routeId(match[1], "Project id");
      return projectId instanceof Response
        ? projectId
        : updateProjectLink(req, projectId, config);
    }
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
