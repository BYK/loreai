import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  db,
  ensureProject,
  keystore,
  setProjectPromotionPolicy,
  setProjectScope,
  setKV,
  syncData,
} from "@loreai/core";
import {
  clearSession,
  persistProviderTokenCache,
  persistSession,
} from "../src/supabase";
import { loadConfig, type GatewayConfig } from "../src/config";
import { handleTeamActionRequest } from "../src/team-actions";
import { TeamRpcError } from "../src/team";
import { startServer } from "../src/server";
import { loopbackRequest } from "./helpers/loopback-request";

const USER = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";
const TEAM = "10000000-0000-4000-8000-000000000001";
const FAST = { params: { t: 1, m: 256, p: 1 } };

const teamMocks = vi.hoisted(() => {
  class MockTeamRpcError extends Error {
    constructor(
      message: string,
      readonly code: string | null,
    ) {
      super(message);
    }
  }
  return {
    TeamRpcError: MockTeamRpcError,
    identityLabel: (profile: {
      display_name: string | null;
      github_login: string | null;
      email: string | null;
    }) =>
      profile.display_name ??
      (profile.github_login ? `@${profile.github_login}` : null) ??
      profile.email ??
      null,
    teamMembers: vi.fn(),
    teamMemberProfiles: vi.fn(),
    listTeams: vi.fn(),
    createTeam: vi.fn(),
    addTeamMember: vi.fn(),
    acceptTeamInvite: vi.fn(),
    discoverGitHubContributors: vi.fn(),
    claimOrgDomain: vi.fn(),
    requestDomainJoin: vi.fn(),
    listDomainJoinRequests: vi.fn(),
    approveDomainJoin: vi.fn(),
    rejectDomainJoin: vi.fn(),
    setTeamRole: vi.fn(),
    removeTeamMember: vi.fn(),
    createTeamInvite: vi.fn(),
    sendInviteEmail: vi.fn(),
    isEmailAddress: vi.fn(),
  };
});

const authMock = vi.hoisted(() => ({ createClient: vi.fn() }));

vi.mock("../src/team", () => teamMocks);
vi.mock("@supabase/supabase-js", () => ({
  createClient: authMock.createClient,
  FunctionsHttpError: class extends Error {},
  FunctionsRelayError: class extends Error {},
}));

function makeConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    ...loadConfig(),
    port: 0,
    hosts: ["127.0.0.1"],
    remoteGateway: false,
    hostedMode: false,
    allowRemoteManagement: false,
    ...overrides,
  };
}

function signIn(): void {
  persistSession({
    access_token: "access-token",
    refresh_token: "refresh-token",
    user_id: USER,
    email: "user@example.test",
    github_login: "folk-user",
    display_name: "Folk User",
  });
}

function mirrorTeam(role = "admin"): void {
  db()
    .query(
      "INSERT OR REPLACE INTO scopes (id, kind, name) VALUES (?, 'team', 'Acme')",
    )
    .run(TEAM);
  db()
    .query(
      "INSERT OR REPLACE INTO scope_members (scope_id, user_id, role) VALUES (?, ?, ?)",
    )
    .run(TEAM, USER, role);
}

function makeProject(linked = true): string {
  const projectId = ensureProject(`/tmp/team-actions-${Math.random()}`);
  if (linked) {
    db()
      .query(
        "INSERT OR REPLACE INTO scopes (id, kind, name, promotion_policy) VALUES (?, 'team', 'Acme', 'manual')",
      )
      .run(TEAM);
    setProjectScope(projectId, TEAM);
  }
  return projectId;
}

function enableWrites(): void {
  signIn();
  mirrorTeam();
  keystore.setPassphrase("test passphrase", FAST);
  syncData.enableSync();
}

async function request(
  path: string,
  method = "GET",
  body?: string,
  config = makeConfig(),
): Promise<Response> {
  const url = new URL(path, "http://127.0.0.1");
  const response = await handleTeamActionRequest(
    new Request(url, {
      method,
      ...(body === undefined
        ? {}
        : {
            headers: { "Content-Type": "application/json" },
            body,
          }),
    }),
    url,
    config,
  );
  if (!response) throw new Error(`route not handled: ${method} ${path}`);
  return response;
}

let remoteServer: Awaited<ReturnType<typeof startServer>>;

beforeAll(async () => {
  remoteServer = await startServer(makeConfig(), {
    peerAddressForRequest: () => "192.0.2.10",
  });
});

afterAll(async () => {
  await remoteServer.stop();
});

beforeEach(() => {
  clearSession();
  syncData.disableSync();
  keystore.lock();
  db().exec(
    "DELETE FROM account_identity; DELETE FROM account_escrow; DELETE FROM scope_keys; DELETE FROM scope_members; DELETE FROM scopes;",
  );
  for (const meta of syncData.syncedTablesFor("max")) {
    setKV(`sync.push.${meta.table}`, "0");
  }
  authMock.createClient.mockReturnValue({
    auth: {
      setSession: async ({
        access_token,
        refresh_token,
      }: {
        access_token: string;
        refresh_token: string;
      }) => ({
        data: {
          session: {
            access_token,
            refresh_token,
            expires_at: Math.floor(Date.now() / 1000) + 3600,
            user: {
              id: USER,
              user_metadata: { preferred_username: "folk-user" },
            },
          },
        },
        error: null,
      }),
    },
  });
  teamMocks.teamMembers.mockResolvedValue([
    { userId: USER, role: "admin" },
    { userId: OTHER, role: "editor" },
  ]);
  teamMocks.teamMemberProfiles.mockResolvedValue([]);
  teamMocks.listTeams.mockResolvedValue([
    { scopeId: TEAM, role: "admin", name: "Acme" },
  ]);
  teamMocks.createTeam.mockResolvedValue(TEAM);
  teamMocks.addTeamMember.mockResolvedValue({ wrapped: true });
  teamMocks.acceptTeamInvite.mockResolvedValue({
    scopeId: TEAM,
    role: "editor",
  });
  teamMocks.discoverGitHubContributors.mockResolvedValue({ repos: [] });
  teamMocks.claimOrgDomain.mockResolvedValue(undefined);
  teamMocks.requestDomainJoin.mockResolvedValue("domain-request-1");
  teamMocks.listDomainJoinRequests.mockResolvedValue([
    {
      id: "domain-request-1",
      domain: "example.test",
      userId: OTHER,
      label: "Other User",
      status: "pending",
      requestedAt: "2025-01-01T00:00:00.000Z",
    },
  ]);
  teamMocks.approveDomainJoin.mockResolvedValue(undefined);
  teamMocks.rejectDomainJoin.mockResolvedValue(undefined);
  teamMocks.setTeamRole.mockResolvedValue(undefined);
  teamMocks.removeTeamMember.mockResolvedValue({
    newEpoch: 3,
    rewrapped: 2,
    skipped: ["30000000-0000-4000-8000-000000000001"],
    unlinkedProjects: 0,
  });
  teamMocks.createTeamInvite.mockResolvedValue("one-time-secret-token");
  teamMocks.sendInviteEmail.mockResolvedValue({
    ok: true,
    resolvedVia: "explicit_email",
  });
  teamMocks.isEmailAddress.mockImplementation((email: string) =>
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()),
  );
  for (const mock of Object.values(teamMocks)) {
    if (typeof mock === "function" && "mockClear" in mock) mock.mockClear();
  }
});

describe("team action routes", () => {
  it("lists member identities from server profiles", async () => {
    signIn();
    mirrorTeam();
    teamMocks.teamMemberProfiles.mockResolvedValue([
      {
        user_id: USER,
        display_name: "Folk User",
        github_login: "folk-user",
        email: "user@example.test",
      },
      {
        user_id: OTHER,
        display_name: null,
        github_login: "other-user",
        email: "other@example.test",
      },
    ]);
    const response = await request(`/api/v1/teams/${TEAM}/members`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      remote: "ok",
      team: { id: TEAM, name: "Acme" },
      my_role: "admin",
      can_manage: true,
      members: [
        { user_id: USER, label: "Folk User", role: "admin", me: true },
        { user_id: OTHER, label: "@other-user", role: "editor", me: false },
      ],
      actions: {
        invite: "available",
        remove: "available",
        set_role: "available",
        add_by_id: "available",
        offline_invite: "available",
        list_invites: "unsupported",
        revoke_invite: "unsupported",
      },
    });
  });

  it("uses the cached local identity for self only when profile lookup fails", async () => {
    signIn();
    mirrorTeam();
    teamMocks.teamMemberProfiles.mockRejectedValueOnce(
      new Error("profile lookup failed"),
    );
    const response = await request(`/api/v1/teams/${TEAM}/members`);
    expect(await response.json()).toMatchObject({
      members: [
        { user_id: USER, label: "@folk-user", me: true },
        { user_id: OTHER, label: null, me: false },
      ],
    });
  });

  it("keeps roster data hidden from non-members and exposes anonymous status", async () => {
    signIn();
    const nonMember = await request(`/api/v1/teams/${TEAM}/members`);
    expect(nonMember.status).toBe(404);

    clearSession();
    const anonymous = await request(`/api/v1/teams/${TEAM}/members`);
    expect(await anonymous.json()).toMatchObject({
      remote: "anonymous",
      members: [],
      actions: {
        invite: "unavailable",
        remove: "unavailable",
        set_role: "unavailable",
      },
    });
  });

  it("rejects malformed team and member UUIDs", async () => {
    expect((await request("/api/v1/teams/not-a-uuid/members")).status).toBe(
      400,
    );
    expect(
      (
        await request(
          `/api/v1/teams/${TEAM}/members/not-a-uuid/role`,
          "POST",
          "{}",
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await request(
          `/api/v1/teams/${TEAM}/members/${OTHER}/role`,
          "POST",
          JSON.stringify({ role: 4, expected_role: "editor" }),
        )
      ).status,
    ).toBe(400);
  });

  it("creates teams and adds members by account id through team services", async () => {
    enableWrites();
    const created = await request(
      "/api/v1/teams",
      "POST",
      JSON.stringify({ name: "  New Team " }),
    );
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({
      team: { id: TEAM, name: "New Team" },
    });
    expect(teamMocks.createTeam).toHaveBeenCalledWith(
      expect.anything(),
      "New Team",
    );

    const malformedCreate = await request(
      "/api/v1/teams",
      "POST",
      JSON.stringify({ name: " " }),
    );
    expect(malformedCreate.status).toBe(400);

    const added = await request(
      `/api/v1/teams/${TEAM}/members`,
      "POST",
      JSON.stringify({ user_id: OTHER, role: "viewer" }),
    );
    expect(added.status).toBe(201);
    expect(await added.json()).toEqual({
      member: { user_id: OTHER, role: "viewer", wrapped: true },
    });
    expect(teamMocks.addTeamMember).toHaveBeenCalledWith(
      expect.anything(),
      TEAM,
      OTHER,
      "viewer",
    );

    const malformedAdd = await request(
      `/api/v1/teams/${TEAM}/members`,
      "POST",
      JSON.stringify({ user_id: "not-a-uuid" }),
    );
    expect(malformedAdd.status).toBe(400);
    teamMocks.addTeamMember.mockRejectedValueOnce(
      new TeamRpcError("membership denied", "42501"),
    );
    const forbidden = await request(
      `/api/v1/teams/${TEAM}/members`,
      "POST",
      JSON.stringify({ user_id: OTHER }),
    );
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toMatchObject({
      error: { type: "forbidden", message: "membership denied" },
    });
  });

  it("accepts invite tokens only from the request body", async () => {
    enableWrites();
    const token = "private-invite-token";
    const accepted = await request(
      "/api/v1/teams/accept",
      "POST",
      JSON.stringify({ token }),
    );
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({
      joined: { scope_id: TEAM, role: "editor" },
    });
    expect(teamMocks.acceptTeamInvite).toHaveBeenCalledWith(
      expect.anything(),
      token,
    );
    expect(JSON.stringify(accepted)).not.toContain(token);
    expect(
      (
        await request(
          "/api/v1/teams/accept",
          "POST",
          JSON.stringify({ token, extra: "not-allowed" }),
        )
      ).status,
    ).toBe(400);
  });

  it("runs GitHub discovery only via the explicit admin route and filters selected invites", async () => {
    enableWrites();
    persistProviderTokenCache("cached-github-token", 300);
    teamMocks.discoverGitHubContributors.mockResolvedValue({
      repos: [
        {
          repo: "owner/repo",
          contributors: [{ login: "contributor", githubId: 7, onLore: false }],
        },
      ],
    });
    const searched = await request(
      `/api/v1/teams/${TEAM}/discover`,
      "POST",
      JSON.stringify({ repos: ["owner/repo"] }),
    );
    expect(searched.status).toBe(200);
    expect(teamMocks.discoverGitHubContributors).toHaveBeenLastCalledWith(
      expect.anything(),
      "cached-github-token",
      ["owner/repo"],
      undefined,
      undefined,
    );
    const invited = await request(
      `/api/v1/teams/${TEAM}/discover`,
      "POST",
      JSON.stringify({
        repos: ["owner/repo"],
        invite_role: "viewer",
        invite_logins: ["contributor"],
      }),
    );
    expect(invited.status).toBe(200);
    expect(teamMocks.discoverGitHubContributors).toHaveBeenLastCalledWith(
      expect.anything(),
      "cached-github-token",
      ["owner/repo"],
      { scopeId: TEAM, role: "viewer" },
      ["contributor"],
    );
    expect(
      (
        await request(
          `/api/v1/teams/${TEAM}/discover`,
          "POST",
          JSON.stringify({ invite_logins: ["invalid login"] }),
        )
      ).status,
    ).toBe(400);
  });

  it("supports organization domain claim, request, list, and decisions", async () => {
    signIn();
    const claimed = await request(
      `/api/v1/orgs/${TEAM}/domains/claim`,
      "POST",
      JSON.stringify({ domain: "example.test", role: "manager" }),
    );
    expect(claimed.status).toBe(200);
    expect(teamMocks.claimOrgDomain).toHaveBeenCalledWith(
      expect.anything(),
      TEAM,
      "example.test",
      "manager",
    );
    const requested = await request(
      `/api/v1/orgs/${TEAM}/domains/request`,
      "POST",
      JSON.stringify({ domain: "example.test" }),
    );
    expect(requested.status).toBe(201);
    expect(await requested.json()).toEqual({ request_id: "domain-request-1" });
    const listed = await request(`/api/v1/orgs/${TEAM}/domains/requests`);
    expect(await listed.json()).toMatchObject({
      requests: [
        {
          id: "domain-request-1",
          user_id: OTHER,
          label: "Other User",
        },
      ],
    });
    const approved = await request(
      `/api/v1/orgs/${TEAM}/domains/requests/${OTHER}/approve`,
      "POST",
      "{}",
    );
    expect(approved.status).toBe(200);
    expect(teamMocks.approveDomainJoin).toHaveBeenCalledWith(
      expect.anything(),
      OTHER,
    );
    const rejected = await request(
      `/api/v1/orgs/${TEAM}/domains/requests/${OTHER}/reject`,
      "POST",
      "{}",
    );
    expect(rejected.status).toBe(200);

    const malformed = await request(
      `/api/v1/orgs/${TEAM}/domains/claim`,
      "POST",
      JSON.stringify({ domain: "bad..domain" }),
    );
    expect(malformed.status).toBe(400);
    teamMocks.claimOrgDomain.mockRejectedValueOnce(
      new TeamRpcError("org ownership required", "42501"),
    );
    const forbidden = await request(
      `/api/v1/orgs/${TEAM}/domains/claim`,
      "POST",
      JSON.stringify({ domain: "example.test" }),
    );
    expect(forbidden.status).toBe(403);
  });

  it("links and unlinks projects with an expected-scope revision", async () => {
    signIn();
    const projectId = makeProject(false);
    const linked = await request(
      `/api/v1/projects/${projectId}/sharing/link`,
      "POST",
      JSON.stringify({ scope_id: TEAM, expected_scope_id: null }),
    );
    expect(linked.status).toBe(200);
    expect(await linked.json()).toMatchObject({
      linked: true,
      team: { id: TEAM },
    });
    const stale = await request(
      `/api/v1/projects/${projectId}/sharing/link`,
      "POST",
      JSON.stringify({ scope_id: null, expected_scope_id: null }),
    );
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      error: { type: "stale_link", current_scope_id: TEAM },
    });
    const unlinked = await request(
      `/api/v1/projects/${projectId}/sharing/link`,
      "POST",
      JSON.stringify({ scope_id: null, expected_scope_id: TEAM }),
    );
    expect(unlinked.status).toBe(200);
    expect(await unlinked.json()).toMatchObject({ linked: false });
  });

  it("refuses every team POST in hosted mode before parsing the body", async () => {
    const hosted = makeConfig({ hostedMode: true, remoteGateway: true });
    const paths = [
      `/api/v1/teams/${TEAM}/invites`,
      `/api/v1/teams/${TEAM}/members/${OTHER}/role`,
      `/api/v1/teams/${TEAM}/members/${OTHER}/remove`,
      `/api/v1/projects/${TEAM}/sharing/policy`,
      "/api/v1/teams",
      "/api/v1/teams/accept",
      `/api/v1/teams/${TEAM}/members`,
      `/api/v1/teams/${TEAM}/discover`,
      `/api/v1/projects/${TEAM}/sharing/link`,
      `/api/v1/orgs/${TEAM}/domains/claim`,
      `/api/v1/orgs/${TEAM}/domains/request`,
      `/api/v1/orgs/${TEAM}/domains/requests/${OTHER}/approve`,
      `/api/v1/orgs/${TEAM}/domains/requests/${OTHER}/reject`,
    ];
    for (const path of paths) {
      const response = await request(path, "POST", "{", hosted);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        error: { type: "forbidden" },
      });
    }
  });

  it("requires encryption and sync before team mutations", async () => {
    signIn();
    mirrorTeam();
    const locked = await request(
      `/api/v1/teams/${TEAM}/invites`,
      "POST",
      JSON.stringify({ role: "viewer" }),
    );
    expect(locked.status).toBe(409);
    expect(await locked.json()).toMatchObject({
      error: { type: "encryption_locked" },
    });

    keystore.setPassphrase("test passphrase", FAST);
    const syncDisabled = await request(
      `/api/v1/teams/${TEAM}/invites`,
      "POST",
      JSON.stringify({ role: "viewer" }),
    );
    expect(syncDisabled.status).toBe(409);
    expect(await syncDisabled.json()).toMatchObject({
      error: { type: "sync_disabled" },
    });
  });

  it("returns a receipt and sends email only for an explicit address", async () => {
    enableWrites();
    const stdout = vi.spyOn(console, "log").mockImplementation(() => {});
    const withoutEmail = await request(
      `/api/v1/teams/${TEAM}/invites`,
      "POST",
      JSON.stringify({ role: "viewer" }),
    );
    expect(withoutEmail.status).toBe(201);
    expect(await withoutEmail.json()).toEqual({
      invite: {
        team_id: TEAM,
        role: "viewer",
        expires_in_days: 14,
        token: "one-time-secret-token",
        accept_command: "lore team accept one-time-secret-token",
        emailed: false,
      },
    });
    expect(teamMocks.sendInviteEmail).not.toHaveBeenCalled();

    const offlineInvite = await request(
      `/api/v1/teams/${TEAM}/invites`,
      "POST",
      JSON.stringify({ role: "viewer", offline: true }),
    );
    expect(offlineInvite.status).toBe(201);
    expect(teamMocks.createTeamInvite).toHaveBeenLastCalledWith(
      expect.anything(),
      TEAM,
      "viewer",
      undefined,
      { offline: true },
    );
    expect(teamMocks.sendInviteEmail).not.toHaveBeenCalled();

    const withEmail = await request(
      `/api/v1/teams/${TEAM}/invites`,
      "POST",
      JSON.stringify({ role: "editor", email: "person@example.test" }),
    );
    expect(withEmail.status).toBe(201);
    expect(teamMocks.sendInviteEmail).toHaveBeenCalledWith(
      expect.anything(),
      "one-time-secret-token",
      "person@example.test",
    );
    expect((await withEmail.json()).invite.emailed).toBe(true);
    expect(stdout).not.toHaveBeenCalledWith(
      expect.stringContaining("one-time-secret-token"),
    );
    stdout.mockRestore();
  });

  it("rejects malformed invite bodies, email addresses, and non-admin invitations", async () => {
    enableWrites();
    for (const body of [
      "{",
      "[]",
      JSON.stringify({ role: "admin" }),
      JSON.stringify({ role: "viewer", offline: "true" }),
    ]) {
      expect(
        (await request(`/api/v1/teams/${TEAM}/invites`, "POST", body)).status,
      ).toBe(400);
    }
    expect(
      (
        await request(
          `/api/v1/teams/${TEAM}/invites`,
          "POST",
          JSON.stringify({ role: "viewer", email: "invalid" }),
        )
      ).status,
    ).toBe(400);

    db()
      .query("UPDATE scope_members SET role = 'editor' WHERE scope_id = ?")
      .run(TEAM);
    const notAdmin = await request(
      `/api/v1/teams/${TEAM}/invites`,
      "POST",
      JSON.stringify({ role: "viewer" }),
    );
    expect(notAdmin.status).toBe(403);
    expect(await notAdmin.json()).toMatchObject({
      error: { type: "not_admin" },
    });
  });

  it("allows self role changes and checks existence and stale roles", async () => {
    enableWrites();
    const self = await request(
      `/api/v1/teams/${TEAM}/members/${USER}/role`,
      "POST",
      JSON.stringify({ role: "viewer", expected_role: "admin" }),
    );
    expect(self.status).toBe(200);
    expect(await self.json()).toMatchObject({
      member: { user_id: USER, role: "viewer" },
    });
    expect(teamMocks.setTeamRole).toHaveBeenCalledWith(
      expect.anything(),
      TEAM,
      USER,
      "viewer",
    );

    const selfRemoval = await request(
      `/api/v1/teams/${TEAM}/members/${USER}/remove`,
      "POST",
      JSON.stringify({ expected_role: "admin" }),
    );
    expect(selfRemoval.status).toBe(200);
    expect(await selfRemoval.json()).toMatchObject({
      removed: USER,
      unlinked_projects: 0,
    });
    expect(teamMocks.removeTeamMember).toHaveBeenCalledWith(
      expect.anything(),
      TEAM,
      USER,
      "admin",
    );

    teamMocks.teamMembers.mockResolvedValueOnce([
      { userId: USER, role: "admin" },
    ]);
    const missing = await request(
      `/api/v1/teams/${TEAM}/members/${OTHER}/role`,
      "POST",
      JSON.stringify({ role: "viewer", expected_role: "editor" }),
    );
    expect(missing.status).toBe(404);

    const stale = await request(
      `/api/v1/teams/${TEAM}/members/${OTHER}/role`,
      "POST",
      JSON.stringify({ role: "viewer", expected_role: "viewer" }),
    );
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      error: { type: "stale_member", current_role: "editor" },
    });
  });

  it("rejects non-admin role changes and removals before cloud calls", async () => {
    enableWrites();
    db()
      .query("UPDATE scope_members SET role = 'editor' WHERE scope_id = ?")
      .run(TEAM);

    const roleChange = await request(
      `/api/v1/teams/${TEAM}/members/${OTHER}/role`,
      "POST",
      JSON.stringify({ role: "viewer", expected_role: "editor" }),
    );
    expect(roleChange.status).toBe(403);
    expect(await roleChange.json()).toMatchObject({
      error: {
        type: "not_admin",
        message: "Only team admins can change or remove members.",
      },
    });

    const removal = await request(
      `/api/v1/teams/${TEAM}/members/${OTHER}/remove`,
      "POST",
      JSON.stringify({ expected_role: "editor" }),
    );
    expect(removal.status).toBe(403);
    expect(await removal.json()).toMatchObject({
      error: {
        type: "not_admin",
        message: "Only team admins can remove members.",
      },
    });

    expect(teamMocks.teamMembers).not.toHaveBeenCalled();
    expect(teamMocks.setTeamRole).not.toHaveBeenCalled();
    expect(teamMocks.removeTeamMember).not.toHaveBeenCalled();
  });

  it("rejects non-admin self-removal before cloud calls", async () => {
    enableWrites();
    db()
      .query("UPDATE scope_members SET role = 'editor' WHERE scope_id = ?")
      .run(TEAM);
    teamMocks.teamMembers.mockResolvedValue([
      { userId: USER, role: "editor" },
      { userId: OTHER, role: "editor" },
    ]);

    const response = await request(
      `/api/v1/teams/${TEAM}/members/${USER}/remove`,
      "POST",
      JSON.stringify({ expected_role: "editor" }),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { type: "not_admin" },
    });
    expect(teamMocks.teamMembers).not.toHaveBeenCalled();
    expect(teamMocks.removeTeamMember).not.toHaveBeenCalled();
  });

  it("maps role and removal RPC codes, including atomic rotation conflicts", async () => {
    enableWrites();
    const cases = [
      ["42501", 403, "forbidden"],
      ["23514", 409, "last_admin"],
      ["40001", 409, "rotation_conflict"],
      ["P0002", 404, "not_found"],
      ["P0001", 409, "stale_member"],
      ["22023", 400, "invalid_request"],
      ["XX000", 502, "remote_unreachable"],
      [null, 502, "remote_unreachable"],
    ] as const;
    for (const [code, status, type] of cases) {
      teamMocks.setTeamRole.mockRejectedValueOnce(
        new TeamRpcError("set_scope_role: database message", code),
      );
      const response = await request(
        `/api/v1/teams/${TEAM}/members/${OTHER}/role`,
        "POST",
        JSON.stringify({ role: "viewer", expected_role: "editor" }),
      );
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ error: { type } });
    }
  });

  it("returns only counts from member-removal receipts", async () => {
    enableWrites();
    const response = await request(
      `/api/v1/teams/${TEAM}/members/${OTHER}/remove`,
      "POST",
      JSON.stringify({ expected_role: "editor" }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      removed: OTHER,
      new_epoch: 3,
      rewrapped: 2,
      skipped_count: 1,
      unlinked_projects: 0,
    });
    expect(JSON.stringify(body)).not.toContain("30000000-0000-4000-8000");
  });

  it("hides every team action route from non-loopback peers", async () => {
    const paths = [
      ["/api/v1/teams", "GET"],
      [`/api/v1/teams/${TEAM}/members`, "GET"],
      [`/api/v1/teams/${TEAM}/invites`, "POST"],
      [`/api/v1/teams/${TEAM}/members/${OTHER}/role`, "POST"],
      [`/api/v1/teams/${TEAM}/members/${OTHER}/remove`, "POST"],
      [`/api/v1/projects/${TEAM}/sharing/policy`, "POST"],
      ["/api/v1/teams", "POST"],
      ["/api/v1/teams/accept", "POST"],
      [`/api/v1/teams/${TEAM}/members`, "POST"],
      [`/api/v1/teams/${TEAM}/discover`, "POST"],
      ["/api/v1/orgs", "GET"],
      [`/api/v1/orgs/${TEAM}/domains/requests`, "GET"],
      [`/api/v1/orgs/${TEAM}/domains/claim`, "POST"],
      [`/api/v1/orgs/${TEAM}/domains/request`, "POST"],
      [`/api/v1/orgs/${TEAM}/domains/requests/${OTHER}/approve`, "POST"],
      [`/api/v1/orgs/${TEAM}/domains/requests/${OTHER}/reject`, "POST"],
      [`/api/v1/projects/${TEAM}/sharing/link`, "POST"],
    ] as const;
    for (const [path, method] of paths) {
      const response = await loopbackRequest(
        `http://127.0.0.1:${remoteServer.port}${path}`,
        {
          method,
          ...(method === "POST"
            ? {
                headers: { "Content-Type": "application/json" },
                body: "{}",
              }
            : {}),
        },
      );
      expect(response.status, `${method} ${path}`).toBe(404);
    }
  });

  it("requires linked projects and an exact expected override for manual review policy", async () => {
    const unknown = await request(
      `/api/v1/projects/${TEAM}/sharing/policy`,
      "POST",
      JSON.stringify({ policy: "manual", expected_override: null }),
    );
    expect(unknown.status).toBe(404);

    const unlinkedId = makeProject(false);
    const unlinked = await request(
      `/api/v1/projects/${unlinkedId}/sharing/policy`,
      "POST",
      JSON.stringify({ policy: "manual", expected_override: null }),
    );
    expect(unlinked.status).toBe(409);
    expect(await unlinked.json()).toMatchObject({
      error: { type: "not_linked" },
    });

    const projectId = makeProject();
    setProjectPromotionPolicy(projectId, "auto");
    const stale = await request(
      `/api/v1/projects/${projectId}/sharing/policy`,
      "POST",
      JSON.stringify({ policy: "manual", expected_override: null }),
    );
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      error: { type: "stale_policy", current_override: "auto" },
    });
  });

  it("sets automatic and manual project overrides locally without sync preconditions", async () => {
    const projectId = makeProject();
    const automatic = await request(
      `/api/v1/projects/${projectId}/sharing/policy`,
      "POST",
      JSON.stringify({ policy: "auto", expected_override: null }),
    );
    expect(automatic.status).toBe(200);
    expect(await automatic.json()).toMatchObject({
      linked: true,
      policy: {
        effective: "auto",
        project_override: "auto",
      },
      auto_share: true,
    });

    const response = await request(
      `/api/v1/projects/${projectId}/sharing/policy`,
      "POST",
      JSON.stringify({ policy: "manual", expected_override: "auto" }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      linked: true,
      policy: {
        effective: "manual",
        project_override: "manual",
      },
      auto_share: false,
    });
    expect(syncData.isSyncEnabled()).toBe(false);
  });
});
