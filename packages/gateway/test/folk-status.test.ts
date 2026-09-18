/**
 * FOLK-01 (#1806): read-only account / teams / sharing / sync status routes.
 *
 * Runs against a real server on an ephemeral port (same pattern as
 * api.test.ts). Account state is driven by writing the persisted session
 * projection into `team_config` exactly as `lore login` does — no Supabase
 * client is ever constructed, and the routes must never reach one.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import {
  db,
  ensureProject,
  keystore,
  setKV,
  setProjectScope,
  setProjectPromotionPolicy,
  syncData,
  withTenant,
} from "@loreai/core";
import { loadConfig, type GatewayConfig } from "../src/config";
import { startServer } from "../src/server";
import {
  clearSession,
  persistProviderTokenCache,
  persistSession,
} from "../src/supabase";
import { accountStatus, sharingStatus, syncStatus } from "../src/folk-status";
import { loopbackRequest } from "./helpers/loopback-request";

// Any attempt to build a Supabase client from these routes is a bug: the
// status surface must be answerable from local state alone.
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => {
    throw new Error("status routes must not construct a Supabase client");
  },
}));

type ServerHandle = Awaited<ReturnType<typeof startServer>>;

const USER = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";
const TEAM = "10000000-0000-4000-8000-000000000001";
const ACCESS_TOKEN = "eyJ-access-token-SECRET-4f9c";
const REFRESH_TOKEN = "refresh-token-SECRET-88ab";
const PROVIDER_TOKEN = "gho_providerSECRET_1234";

function makeConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    ...loadConfig(),
    port: 0,
    hosts: ["127.0.0.1"],
    debug: false,
    remoteGateway: false,
    hostedMode: false,
    allowRemoteManagement: false,
    ...overrides,
  };
}

function signIn(
  opts: { expiresAt?: number; githubLogin?: string | null } = {},
) {
  persistSession({
    access_token: ACCESS_TOKEN,
    refresh_token: REFRESH_TOKEN,
    expires_at: opts.expiresAt ?? Math.floor(Date.now() / 1000) + 3600,
    user_id: USER,
    email: "octo@example.com",
    github_login: opts.githubLogin === undefined ? "octocat" : opts.githubLogin,
    display_name: "Octo Cat",
  });
  persistProviderTokenCache(PROVIDER_TOKEN);
}

function mirrorTeam(
  scopeId = TEAM,
  opts: {
    name?: string | null;
    policy?: string | null;
    members?: Array<[string, string]>;
  } = {},
) {
  db()
    .query(
      "INSERT OR REPLACE INTO scopes (id, kind, name, promotion_policy) VALUES (?, 'team', ?, ?)",
    )
    .run(
      scopeId,
      opts.name === undefined ? "Acme" : opts.name,
      opts.policy ?? null,
    );
  for (const [uid, role] of opts.members ?? [[USER, "editor"]]) {
    db()
      .query(
        "INSERT OR REPLACE INTO scope_members (scope_id, user_id, role) VALUES (?, ?, ?)",
      )
      .run(scopeId, uid, role);
  }
}

/** Fresh-device shape: escrow pulled, identity not installed → "locked". */
function lockKeys() {
  keystore.setPassphrase("pw", { params: { t: 1, m: 256, p: 1 } });
  db().exec("DELETE FROM account_identity");
  keystore.lock();
  expect(keystore.encryptionState()).toBe("locked");
}

function makeProject(): string {
  const id = ensureProject(
    `/tmp/folk-status-${Math.random().toString(36).slice(2)}`,
  );
  syncData.withApplying(() =>
    db()
      .query("UPDATE projects SET git_remote = 'test:remote' WHERE id = ?")
      .run(id),
  );
  return id;
}

describe("Folk Lore status routes", () => {
  let server: ServerHandle;
  let remotePeer: ServerHandle;
  let hosted: ServerHandle;
  const config = makeConfig();

  const get = (s: ServerHandle, path: string) =>
    loopbackRequest(`http://127.0.0.1:${s.port}${path}`);

  beforeAll(async () => {
    server = await startServer(config);
    remotePeer = await startServer(makeConfig(), {
      peerAddressForRequest: () => "192.0.2.10",
    });
    hosted = await startServer(
      makeConfig({
        hostedMode: true,
        gatewayAuthToken: "test-gateway-auth-token-0123456789abcdef",
      }),
    );
  });

  afterAll(async () => {
    await Promise.all([server.stop(), remotePeer.stop(), hosted.stop()]);
  });

  beforeEach(() => {
    clearSession();
    syncData.disableSync();
    db().exec("DELETE FROM scope_members");
    db().exec("DELETE FROM scopes");
    db().exec("DELETE FROM account_identity");
    db().exec("DELETE FROM account_escrow");
    db().exec("DELETE FROM scope_keys");
    db().exec("DELETE FROM sync_outbox");
    keystore.lock();
    for (const meta of syncData.syncedTablesFor("max")) {
      setKV(`sync.push.${meta.table}`, "0");
    }
  });

  // -------------------------------------------------------------------------
  // /api/v1/account
  // -------------------------------------------------------------------------

  describe("GET /api/v1/account", () => {
    test("anonymous when no session is persisted", async () => {
      const res = await get(server, "/api/v1/account");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        signed_in: false,
        user: null,
        provider: null,
        expires_at: null,
        state: "anonymous",
      });
    });

    test("signed in: identity fields only, provider inferred from github_login", async () => {
      const exp = Math.floor(Date.now() / 1000) + 3600;
      signIn({ expiresAt: exp });
      const res = await get(server, "/api/v1/account");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        signed_in: true,
        user: { id: USER, email: "octo@example.com", display_name: "Octo Cat" },
        provider: "github",
        expires_at: new Date(exp * 1000).toISOString(),
        state: "signed_in",
      });
    });

    test("provider is null when no github_login is stored", async () => {
      signIn({ githubLogin: null });
      const body = await (await get(server, "/api/v1/account")).json();
      expect(body.provider).toBeNull();
      expect(body.state).toBe("signed_in");
    });

    test("expired when the cached access token is past expiry", async () => {
      const exp = Math.floor(Date.now() / 1000) - 60;
      signIn({ expiresAt: exp });
      const body = await (await get(server, "/api/v1/account")).json();
      expect(body).toMatchObject({
        signed_in: false,
        state: "expired",
        expires_at: new Date(exp * 1000).toISOString(),
      });
      expect(body.user.id).toBe(USER);
    });

    test("expiry boundary is inclusive and unit-testable via nowMs", () => {
      signIn({ expiresAt: 1_700_000_000 });
      expect(accountStatus(config, 1_700_000_000 * 1000 - 1).state).toBe(
        "signed_in",
      );
      expect(accountStatus(config, 1_700_000_000 * 1000).state).toBe("expired");
    });

    test("a session without expires_at reports null and is not expired", async () => {
      persistSession({
        access_token: ACCESS_TOKEN,
        refresh_token: REFRESH_TOKEN,
        user_id: USER,
      });
      const body = await (await get(server, "/api/v1/account")).json();
      expect(body).toEqual({
        signed_in: true,
        user: { id: USER, email: null, display_name: null },
        provider: null,
        expires_at: null,
        state: "signed_in",
      });
    });

    test("hosted mode never discloses the operator's installation-global session", async () => {
      signIn();
      const body = await (await get(hosted, "/api/v1/account")).json();
      expect(body).toEqual({
        signed_in: false,
        user: null,
        provider: null,
        expires_at: null,
        state: "anonymous",
      });
    });

    test("a non-local tenant context is treated as anonymous", () => {
      signIn();
      expect(accountStatus(config).state).toBe("signed_in");
      expect(withTenant("tenant-a", () => accountStatus(config)).state).toBe(
        "anonymous",
      );
    });
  });

  // -------------------------------------------------------------------------
  // /api/v1/teams
  // -------------------------------------------------------------------------

  describe("GET /api/v1/teams", () => {
    test("anonymous → empty array even when mirrors have rows", async () => {
      mirrorTeam();
      const body = await (await get(server, "/api/v1/teams")).json();
      expect(body).toEqual({ teams: [] });
    });

    test("signed in → the current user's team memberships from the local mirror", async () => {
      mirrorTeam(TEAM, {
        name: "Acme",
        members: [
          [USER, "admin"],
          [OTHER, "editor"],
        ],
      });
      // A team the user is NOT a member of must not appear.
      mirrorTeam("10000000-0000-4000-8000-000000000002", {
        name: "Strangers",
        members: [[OTHER, "admin"]],
      });
      // A non-team scope (personal/org) the user is a member of must be filtered.
      db()
        .query(
          "INSERT INTO scopes (id, kind, name) VALUES (?, 'personal', 'me')",
        )
        .run("10000000-0000-4000-8000-000000000003");
      db()
        .query(
          "INSERT INTO scope_members (scope_id, user_id, role) VALUES (?, ?, 'owner')",
        )
        .run("10000000-0000-4000-8000-000000000003", USER);
      signIn();
      const body = await (await get(server, "/api/v1/teams")).json();
      expect(body).toEqual({
        teams: [{ id: TEAM, name: "Acme", role: "admin", member_count: 2 }],
      });
    });

    test("expired session still lists memberships (they are local knowledge)", async () => {
      mirrorTeam();
      signIn({ expiresAt: 1 });
      const body = await (await get(server, "/api/v1/teams")).json();
      expect(body.teams).toHaveLength(1);
    });

    test("hosted mode → empty array", async () => {
      mirrorTeam();
      signIn();
      expect(await (await get(hosted, "/api/v1/teams")).json()).toEqual({
        teams: [],
      });
    });
  });

  // -------------------------------------------------------------------------
  // /api/v1/projects/:id/sharing
  // -------------------------------------------------------------------------

  describe("GET /api/v1/projects/:id/sharing", () => {
    test("unknown project → 404", async () => {
      const res = await get(server, "/api/v1/projects/does-not-exist/sharing");
      expect(res.status).toBe(404);
      expect((await res.json()).error.type).toBe("not_found");
    });

    test("malformed percent-encoding in :id → 404, not 500", async () => {
      const res = await get(server, "/api/v1/projects/%E0%A4%A/sharing");
      expect(res.status).toBe(404);
    });

    test("not linked (anonymous)", async () => {
      const pid = makeProject();
      const res = await get(server, `/api/v1/projects/${pid}/sharing`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        linked: false,
        team: null,
        policy: {
          effective: "manual",
          project_override: null,
          team_default: null,
        },
        state: "not_linked",
        detail: null,
      });
    });

    test("linked + signed in + sync on + keys unlocked → linked", async () => {
      const pid = makeProject();
      mirrorTeam(TEAM, { policy: "auto" });
      setProjectScope(pid, TEAM);
      signIn();
      syncData.enableSync();
      keystore.setPassphrase("pw", { params: { t: 1, m: 256, p: 1 } });
      const body = await (
        await get(server, `/api/v1/projects/${pid}/sharing`)
      ).json();
      expect(body).toEqual({
        linked: true,
        team: { id: TEAM, name: "Acme" },
        policy: {
          effective: "auto",
          project_override: null,
          team_default: "auto",
        },
        state: "linked",
        detail: null,
      });
    });

    test("project override wins over the team default", async () => {
      const pid = makeProject();
      mirrorTeam(TEAM, { policy: "auto" });
      setProjectScope(pid, TEAM);
      setProjectPromotionPolicy(pid, "manual");
      const body = await (
        await get(server, `/api/v1/projects/${pid}/sharing`)
      ).json();
      expect(body.policy).toEqual({
        effective: "manual",
        project_override: "manual",
        team_default: "auto",
      });
    });

    test("linked with encryption escrow but no unlocked identity → locked", async () => {
      const pid = makeProject();
      mirrorTeam();
      setProjectScope(pid, TEAM);
      signIn();
      syncData.enableSync();
      lockKeys();
      const body = await (
        await get(server, `/api/v1/projects/${pid}/sharing`)
      ).json();
      expect(body).toMatchObject({ linked: true, state: "locked" });
      expect(body.detail).toMatch(/locked/i);
    });

    test("encryption never set up (state 'off') is not locked", async () => {
      const pid = makeProject();
      mirrorTeam();
      setProjectScope(pid, TEAM);
      signIn();
      syncData.enableSync();
      expect(keystore.encryptionState()).toBe("off");
      const body = await (
        await get(server, `/api/v1/projects/${pid}/sharing`)
      ).json();
      expect(body.state).toBe("linked");
    });

    test.each([
      ["anonymous", () => {}, /not signed in/i],
      ["expired session", () => signIn({ expiresAt: 1 }), /expired/i],
      [
        "sync disabled",
        () => {
          signIn();
        },
        /disabled/i,
      ],
      [
        "team missing from mirror",
        () => {
          signIn();
          syncData.enableSync();
          db().exec("DELETE FROM scopes");
        },
        /registry mirror/i,
      ],
      [
        "user not a member",
        () => {
          signIn();
          syncData.enableSync();
          db().exec("DELETE FROM scope_members");
        },
        /not a member/i,
      ],
    ])("linked but %s → degraded", async (_label, arrange, detail) => {
      const pid = makeProject();
      mirrorTeam();
      setProjectScope(pid, TEAM);
      // Locked keys must not mask the more fundamental degradation.
      lockKeys();
      arrange();
      const body = await (
        await get(server, `/api/v1/projects/${pid}/sharing`)
      ).json();
      expect(body).toMatchObject({
        linked: true,
        team: { id: TEAM },
        state: "degraded",
      });
      expect(body.detail).toMatch(detail);
    });

    test("team missing from mirror keeps the id but reports name null", () => {
      const pid = makeProject();
      setProjectScope(pid, TEAM);
      const s = sharingStatus(config, pid);
      expect(s?.team).toEqual({ id: TEAM, name: null });
    });

    test("hosted mode → not linked with an explanatory detail, no team disclosed", async () => {
      const pid = makeProject();
      mirrorTeam();
      setProjectScope(pid, TEAM);
      signIn();
      const body = await (
        await get(hosted, `/api/v1/projects/${pid}/sharing`)
      ).json();
      expect(body).toMatchObject({
        linked: false,
        team: null,
        state: "not_linked",
      });
      expect(body.detail).toMatch(/hosted/i);
    });
  });

  // -------------------------------------------------------------------------
  // /api/v1/sync/status
  // -------------------------------------------------------------------------

  describe("GET /api/v1/sync/status", () => {
    test("disabled when sync is off (pending count unknown)", async () => {
      const body = await (await get(server, "/api/v1/sync/status")).json();
      expect(body).toEqual({
        enabled: false,
        state: "disabled",
        pending_changes: null,
      });
    });

    test("idle with pending changes counted past the push cursor per table", async () => {
      signIn();
      syncData.enableSync();
      db().exec("DELETE FROM sync_outbox");
      const ins = db().query(
        "INSERT INTO sync_outbox (table_name, row_id, op, changed_at, tenant_id) VALUES (?, ?, 'upsert', 1, '')",
      );
      ins.run("knowledge", "k1"); // seq 1 (below cursor → already pushed)
      ins.run("knowledge", "k2"); // seq 2
      ins.run("knowledge", "k2"); // seq 3 — same row, coalesces to one change
      ins.run("entities", "e1"); // seq 4
      ins.run("profiles", "p1"); // pull-only table — never counted
      const maxSeq = (
        db().query("SELECT MAX(seq) AS s FROM sync_outbox").get() as {
          s: number;
        }
      ).s;
      setKV("sync.push.knowledge", String(maxSeq - 4)); // k1 pushed
      const body = await (await get(server, "/api/v1/sync/status")).json();
      expect(body).toEqual({
        enabled: true,
        state: "idle",
        pending_changes: 2,
      });
    });

    test("another tenant's outbox rows are never counted", () => {
      signIn();
      syncData.enableSync();
      db().exec("DELETE FROM sync_outbox");
      db()
        .query(
          "INSERT INTO sync_outbox (table_name, row_id, op, changed_at, tenant_id) VALUES ('knowledge', 'x', 'upsert', 1, 'tenant-b')",
        )
        .run();
      expect(syncStatus(config).pending_changes).toBe(0);
    });

    test("hosted mode → disabled regardless of local enablement", async () => {
      signIn();
      syncData.enableSync();
      const body = await (await get(hosted, "/api/v1/sync/status")).json();
      expect(body).toEqual({
        enabled: false,
        state: "disabled",
        pending_changes: null,
      });
    });
  });

  // -------------------------------------------------------------------------
  // Security
  // -------------------------------------------------------------------------

  describe("security", () => {
    test("no configured secret value ever appears in any status response", async () => {
      const pid = makeProject();
      mirrorTeam();
      setProjectScope(pid, TEAM);
      signIn();
      syncData.enableSync();
      const secrets = [ACCESS_TOKEN, REFRESH_TOKEN, PROVIDER_TOKEN, "SECRET"];
      for (const path of [
        "/api/v1/account",
        "/api/v1/teams",
        `/api/v1/projects/${pid}/sharing`,
        "/api/v1/sync/status",
      ]) {
        const res = await get(server, path);
        expect(res.status).toBe(200);
        const text = await res.text();
        for (const s of secrets)
          expect(text, `${path} leaks ${s}`).not.toContain(s);
        expect(text).not.toMatch(/access_token|refresh_token|provider_token/);
      }
    });

    test.each([
      "/api/v1/account",
      "/api/v1/teams",
      "/api/v1/projects/anything/sharing",
      "/api/v1/sync/status",
    ])(
      "remote peer without remote management → hidden 404 for %s",
      async (path) => {
        signIn();
        const res = await get(remotePeer, path);
        expect(res.status).toBe(404);
        expect(res.headers.get("connection")).toBe("close");
        expect(await res.text()).toBe("");
      },
    );

    test("routes are GET-only (POST falls through to the generic 404)", async () => {
      const res = await loopbackRequest(
        `http://127.0.0.1:${server.port}/api/v1/account`,
        {
          method: "POST",
        },
      );
      expect(res.status).toBe(404);
    });
  });
});
