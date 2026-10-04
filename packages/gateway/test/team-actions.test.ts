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
import { clearSession, persistSession } from "../src/supabase";
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
    teamMembers: vi.fn(),
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
  teamMocks.setTeamRole.mockResolvedValue(undefined);
  teamMocks.removeTeamMember.mockResolvedValue({
    newEpoch: 3,
    rewrapped: 2,
    skipped: ["30000000-0000-4000-8000-000000000001"],
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
  it("lists mirrored membership with only the local identity label", async () => {
    signIn();
    mirrorTeam();
    const response = await request(`/api/v1/teams/${TEAM}/members`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      remote: "ok",
      team: { id: TEAM, name: "Acme" },
      my_role: "admin",
      can_manage: true,
      members: [
        { user_id: USER, label: "@folk-user", role: "admin", me: true },
        { user_id: OTHER, label: null, role: "editor", me: false },
      ],
      actions: {
        invite: "available",
        remove: "available",
        set_role: "available",
        add_by_id: "cli_only",
        offline_invite: "cli_only",
        list_invites: "unsupported",
        revoke_invite: "unsupported",
      },
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

  it("refuses every team POST in hosted mode before parsing the body", async () => {
    const hosted = makeConfig({ hostedMode: true, remoteGateway: true });
    const paths = [
      `/api/v1/teams/${TEAM}/invites`,
      `/api/v1/teams/${TEAM}/members/${OTHER}/role`,
      `/api/v1/teams/${TEAM}/members/${OTHER}/remove`,
      `/api/v1/projects/${TEAM}/sharing/policy`,
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
    for (const body of ["{", "[]", JSON.stringify({ role: "admin" })]) {
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

  it("checks self-targeting, existence, and stale roles before role changes", async () => {
    enableWrites();
    const self = await request(
      `/api/v1/teams/${TEAM}/members/${USER}/role`,
      "POST",
      JSON.stringify({ role: "viewer", expected_role: "admin" }),
    );
    expect(self.status).toBe(409);
    expect(await self.json()).toMatchObject({
      error: { type: "self_action_unsupported" },
    });
    const selfRemoval = await request(
      `/api/v1/teams/${TEAM}/members/${USER}/remove`,
      "POST",
      JSON.stringify({ expected_role: "admin" }),
    );
    expect(selfRemoval.status).toBe(409);
    expect(await selfRemoval.json()).toMatchObject({
      error: { type: "self_action_unsupported" },
    });

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

  it("maps role RPC codes and preserves last-admin protection", async () => {
    enableWrites();
    const cases = [
      ["42501", 403, "forbidden"],
      ["23514", 409, "last_admin"],
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

  it("returns only a skipped count from member-removal receipts", async () => {
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

  it("refuses auto policy and writes manual overrides locally without sync preconditions", async () => {
    const projectId = makeProject();
    const unsupported = await request(
      `/api/v1/projects/${projectId}/sharing/policy`,
      "POST",
      JSON.stringify({ policy: "auto", expected_override: null }),
    );
    expect(unsupported.status).toBe(400);
    expect(await unsupported.json()).toMatchObject({
      error: { type: "unsupported_policy" },
    });

    const response = await request(
      `/api/v1/projects/${projectId}/sharing/policy`,
      "POST",
      JSON.stringify({ policy: "manual", expected_override: null }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      linked: true,
      policy: {
        effective: "manual",
        project_override: "manual",
      },
    });
    expect(syncData.isSyncEnabled()).toBe(false);
  });
});
