import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { randomUUID } from "node:crypto";
import {
  crypto,
  db,
  ensureProject,
  keystore,
  ltm,
  setProjectScope,
} from "@loreai/core";
import { loadConfig, type GatewayConfig } from "../src/config";
import {
  handlePromotionRequest,
  autoProposePending,
  applyPromotionDecisions,
} from "../src/promotions";
import { clearSession, persistSession } from "../src/supabase";
import { makeEncryptionResolver, openString } from "../src/sync";
import { startServer } from "../src/server";
import { loopbackRequest } from "./helpers/loopback-request";

const supabase = vi.hoisted(() => ({ createClient: vi.fn() }));
vi.mock("@supabase/supabase-js", () => ({
  createClient: supabase.createClient,
  FunctionsHttpError: class extends Error {},
  FunctionsRelayError: class extends Error {},
}));

const USER = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";
const UNKNOWN = "00000000-0000-4000-8000-000000000003";
const TEAM = "10000000-0000-4000-8000-000000000001";
const REQUEST = "20000000-0000-4000-8000-000000000001";
const FAST = { params: { t: 1, m: 256, p: 1 } };

type Filter = { op: "eq" | "in" | "is"; column: string; value: unknown };
type Row = Record<string, unknown> & {
  id: string;
  scope_id: string;
  logical_id: string;
  entry_version_id: string;
  entry_version: number;
  category: string;
  title_enc: string;
  content_enc: string;
  proposer_id: string;
  status: "pending" | "approved" | "rejected" | "withdrawn";
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
  applied: "applied" | "stale" | null;
  applied_at: string | null;
  created_at: string;
};

let rows: Row[] = [];
let insertError: { code?: string; message: string } | null = null;
let selectError: { code?: string; message: string } | null = null;
let rpcError: { code?: string; message: string } | null = null;
let rpcThrow: Error | null = null;
let teamPolicy: "manual" | "auto" = "manual";
let rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
let fakeClient: Record<string, unknown>;

function queryResult(
  table: string,
  operation: string,
  payload: unknown,
  filters: Filter[],
  limit: number,
) {
  if (table === "scopes") {
    return {
      data: { promotion_policy: teamPolicy },
      error: null,
    };
  }
  if (table === "scope_members") {
    const scopeFilter = filters.find((filter) => filter.column === "scope_id");
    if (!scopeFilter) {
      return {
        data: [
          {
            scope_id: TEAM,
            role: "admin",
            scopes: { name: "Acme", kind: "team" },
          },
        ],
        error: null,
      };
    }
    return {
      data: [
        { user_id: USER, role: "admin" },
        { user_id: OTHER, role: "editor" },
      ],
      error: null,
    };
  }
  if (table !== "promotion_requests") return { data: [], error: null };
  if (operation === "insert") {
    if (insertError) return { data: null, error: insertError };
    const inserted = payload as Partial<Row>;
    const row: Row = {
      id: String(inserted.id),
      scope_id: String(inserted.scope_id),
      logical_id: String(inserted.logical_id),
      entry_version_id: String(inserted.entry_version_id),
      entry_version: Number(inserted.entry_version),
      category: String(inserted.category),
      title_enc: String(inserted.title_enc),
      content_enc: String(inserted.content_enc),
      proposer_id: String(inserted.proposer_id),
      status: "pending",
      decided_by: null,
      decided_at: null,
      decision_note: null,
      applied: null,
      applied_at: null,
      created_at: new Date().toISOString(),
    };
    rows.push(row);
    return { data: row, error: null };
  }
  if (selectError) return { data: null, error: selectError };
  let result = [...rows];
  for (const filter of filters) {
    result = result.filter((row) => {
      const value = row[filter.column];
      if (filter.op === "eq") return value === filter.value;
      if (filter.op === "is") return value === filter.value;
      return (filter.value as unknown[]).includes(value);
    });
  }
  result.sort((a, b) => b.created_at.localeCompare(a.created_at));
  return { data: result.slice(0, limit), error: null };
}

function makeQuery(table: string) {
  let operation = "select";
  let payload: unknown;
  let filters: Filter[] = [];
  let limit = Number.POSITIVE_INFINITY;
  const builder: Record<string, unknown> = {};
  builder.select = () => builder;
  builder.insert = (value: unknown) => {
    operation = "insert";
    payload = value;
    return builder;
  };
  builder.eq = (column: string, value: unknown) => {
    filters.push({ op: "eq", column, value });
    return builder;
  };
  builder.in = (column: string, value: unknown[]) => {
    filters.push({ op: "in", column, value });
    return builder;
  };
  builder.is = (column: string, value: unknown) => {
    filters.push({ op: "is", column, value });
    return builder;
  };
  builder.order = () => builder;
  builder.limit = (value: number) => {
    limit = value;
    return builder;
  };
  builder.single = () => builder;
  builder.maybeSingle = () => builder;
  // oxlint-disable-next-line unicorn/no-thenable -- models the Supabase query builder
  builder.then = (
    resolve: (value: unknown) => unknown,
    reject?: (error: unknown) => unknown,
  ) =>
    Promise.resolve(
      queryResult(table, operation, payload, filters, limit),
    ).then(resolve, reject);
  return builder;
}

function makeClient() {
  return {
    auth: {
      setSession: async () => ({
        data: {
          session: {
            access_token: "access-token",
            refresh_token: "refresh-token",
            expires_at: Math.floor(Date.now() / 1000) + 3600,
            user: {
              id: USER,
              email: "user@example.test",
              user_metadata: { user_name: "folk-user" },
            },
          },
        },
        error: null,
      }),
    },
    from: (table: string) => makeQuery(table),
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      if (rpcThrow) throw rpcThrow;
      if (rpcError) return { data: null, error: rpcError };
      if (name === "team_member_profiles") {
        return {
          data: [
            {
              user_id: USER,
              display_name: null,
              github_login: "folk-user",
              email: "user@example.test",
            },
            {
              user_id: OTHER,
              display_name: "Other Member",
              github_login: "other",
              email: "other@example.test",
            },
          ],
          error: null,
        };
      }
      if (name === "propose_promotion") {
        const row: Row = {
          id: String(args.p_id),
          scope_id: String(args.p_scope),
          logical_id: String(args.p_logical_id),
          entry_version_id: String(args.p_entry_version_id),
          entry_version: Number(args.p_entry_version),
          category: String(args.p_category),
          title_enc: String(args.p_title_enc),
          content_enc: String(args.p_content_enc),
          proposer_id: USER,
          status: teamPolicy === "auto" ? "approved" : "pending",
          decided_by: teamPolicy === "auto" ? USER : null,
          decided_at: teamPolicy === "auto" ? new Date().toISOString() : null,
          decision_note:
            teamPolicy === "auto"
              ? "auto-approved: team does not require review"
              : null,
          applied: null,
          applied_at: null,
          created_at: new Date().toISOString(),
        };
        rows.push(row);
        return { data: row, error: null };
      }
      if (name === "set_team_promotion_policy") {
        teamPolicy = args.p_policy as "manual" | "auto";
        return { data: teamPolicy, error: null };
      }
      if (name === "mark_promotion_applied") {
        const row = rows.find((item) => item.id === args.p_id);
        if (row) {
          row.applied = args.p_outcome as Row["applied"];
          row.applied_at = new Date().toISOString();
        }
        return { data: row ?? null, error: null };
      }
      const row = rows.find((item) => item.id === args.p_id);
      if (!row)
        return {
          data: null,
          error: { code: "P0002", message: "promotion request not found" },
        };
      if (name === "withdraw_promotion") row.status = "withdrawn";
      else {
        row.status = args.p_decision as Row["status"];
        row.decided_by = USER;
        row.decided_at = new Date().toISOString();
        row.decision_note = (args.p_note as string | null) ?? null;
      }
      return { data: row, error: null };
    },
  };
}

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

function linkTeam(projectId: string): void {
  db()
    .query(
      "INSERT OR REPLACE INTO scopes (id, kind, name, promotion_policy) VALUES (?, 'team', 'Acme', 'manual')",
    )
    .run(TEAM);
  db()
    .query(
      "INSERT OR REPLACE INTO scope_members (scope_id, user_id, role) VALUES (?, ?, 'admin')",
    )
    .run(TEAM, USER);
  setProjectScope(projectId, TEAM);
}

function makeEntry(
  opts: {
    project?: boolean;
    linked?: boolean;
    approval?: "pending" | "approved" | "rejected";
    sensitivity?: "normal" | "sensitive" | "restricted";
  } = {},
): string {
  const projectPath = `/tmp/promotion-${randomUUID()}`;
  const projectId = opts.project === false ? null : ensureProject(projectPath);
  if (projectId && opts.linked !== false) linkTeam(projectId);
  const id = ltm.create({
    id: randomUUID(),
    ...(projectId ? { projectPath } : {}),
    category: "pattern",
    title: "Promotion title",
    content: "Exact team content",
    scope: projectId ? "project" : "global",
    sensitivity: opts.sensitivity ?? "normal",
  });
  if (opts.approval === "approved") ltm.approveForTeam(id, USER);
  if (opts.approval === "rejected") ltm.rejectForTeam(id);
  return id;
}

function enableAutoShare(id: string): void {
  const candidate = ltm.teamPromotionCandidate(id);
  if (!candidate?.projectId) throw new Error("expected a project candidate");
  db()
    .query("UPDATE projects SET promotion_policy='auto' WHERE id=?")
    .run(candidate.projectId);
}

async function unlockTeam(): Promise<void> {
  keystore.setPassphrase("test passphrase", FAST);
  await keystore.getScopeKey(TEAM, USER, { mint: true });
}

async function request(
  path: string,
  method = "GET",
  body?: string,
  config = makeConfig(),
): Promise<Response> {
  const url = new URL(path, "http://127.0.0.1");
  const response = await handlePromotionRequest(
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

function rowFor(logicalId: string, overrides: Partial<Row> = {}): Row {
  return {
    id: REQUEST,
    scope_id: TEAM,
    logical_id: logicalId,
    entry_version_id: logicalId,
    entry_version: 1,
    category: "pattern",
    title_enc: "not-an-envelope",
    content_enc: "not-an-envelope",
    proposer_id: USER,
    status: "approved",
    decided_by: OTHER,
    decided_at: new Date().toISOString(),
    decision_note: null,
    applied: null,
    applied_at: null,
    created_at: new Date().toISOString(),
    ...overrides,
  };
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
  keystore.lock();
  db().exec(
    "DELETE FROM account_identity; DELETE FROM account_escrow; DELETE FROM scope_keys; DELETE FROM scope_members; DELETE FROM scopes; DELETE FROM knowledge;",
  );
  rows = [];
  insertError = null;
  selectError = null;
  rpcError = null;
  rpcThrow = null;
  teamPolicy = "manual";
  rpcCalls = [];
  fakeClient = makeClient();
  supabase.createClient.mockImplementation(() => fakeClient);
});

describe("promotion request routes", () => {
  it("rejects malformed JSON, non-object bodies, and wrong field types", async () => {
    const id = makeEntry({ linked: true });
    expect(
      (await request(`/api/v1/knowledge/${id}/promote`, "POST", "{")).status,
    ).toBe(400);
    expect(
      (
        await request(
          `/api/v1/knowledge/${id}/promote`,
          "POST",
          JSON.stringify([]),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await request(
          `/api/v1/knowledge/${id}/promote`,
          "POST",
          JSON.stringify({}),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await request(
          `/api/v1/knowledge/${id}/promote`,
          "POST",
          JSON.stringify({ version_id: id, extra: true }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await request(
          `/api/v1/knowledge/${id}/promote`,
          "POST",
          JSON.stringify({ version_id: 1 }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await request(
          `/api/v1/promotions/${REQUEST}/approve`,
          "POST",
          JSON.stringify({ note: 4 }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await request(
          `/api/v1/promotions/${REQUEST}/reject`,
          "POST",
          JSON.stringify({ note: null }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await request(
          `/api/v1/promotions/${REQUEST}/approve`,
          "POST",
          JSON.stringify({ extra: "field" }),
        )
      ).status,
    ).toBe(400);
    for (const path of [
      `/api/v1/promotions/${REQUEST}/approve`,
      `/api/v1/promotions/${REQUEST}/reject`,
      `/api/v1/promotions/${REQUEST}/withdraw`,
    ]) {
      expect((await request(path, "POST", "{")).status).toBe(400);
      expect((await request(path, "POST", JSON.stringify([]))).status).toBe(
        400,
      );
    }
    expect(
      (
        await request(
          `/api/v1/promotions/${REQUEST}/approve`,
          "POST",
          JSON.stringify({ note: "x".repeat(501) }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await request(
          `/api/v1/promotions/${REQUEST}/withdraw`,
          "POST",
          JSON.stringify({ note: "not accepted" }),
        )
      ).status,
    ).toBe(400);
  });

  it("returns 400 for non-UUID knowledge and request path ids", async () => {
    expect(
      (await request("/api/v1/knowledge/not-a-uuid/promotion")).status,
    ).toBe(400);
    expect(
      (
        await request(
          "/api/v1/knowledge/not-a-uuid/promote",
          "POST",
          JSON.stringify({ version_id: REQUEST }),
        )
      ).status,
    ).toBe(400);
    for (const action of ["approve", "reject", "withdraw"]) {
      expect(
        (await request(`/api/v1/promotions/not-a-uuid/${action}`, "POST", "{}"))
          .status,
      ).toBe(400);
    }
  });

  it("rejects malformed list filters, including in hosted mode", async () => {
    expect(
      (
        await request(
          "/api/v1/promotions?team=not-a-uuid",
          "GET",
          undefined,
          makeConfig({ hostedMode: true, remoteGateway: true }),
        )
      ).status,
    ).toBe(400);
    expect(
      (await request(`/api/v1/promotions?team=${TEAM}&status=unknown`)).status,
    ).toBe(400);
  });

  it("reports remote status before requiring a team for signed-out access", async () => {
    const anonymous = await request("/api/v1/promotions");
    expect(await anonymous.json()).toEqual({
      remote: "anonymous",
      requests: [],
      complete: true,
    });

    const hosted = await request(
      "/api/v1/promotions",
      "GET",
      undefined,
      makeConfig({ hostedMode: true, remoteGateway: true }),
    );
    expect(await hosted.json()).toEqual({
      remote: "hosted",
      requests: [],
      complete: true,
    });

    signIn();
    const required = await request("/api/v1/promotions");
    expect(required.status).toBe(400);
    expect(await required.json()).toMatchObject({
      error: { message: "team is required" },
    });
  });

  it("reports remote unavailability when the team filter is omitted", async () => {
    signIn();
    supabase.createClient.mockImplementationOnce(() => {
      throw new Error("offline");
    });
    const response = await request("/api/v1/promotions");
    expect(await response.json()).toEqual({
      remote: "unreachable",
      requests: [],
      complete: true,
    });
  });

  it("returns 404 for an unknown knowledge id", async () => {
    const response = await request(
      "/api/v1/knowledge/30000000-0000-4000-8000-000000000001/promotion",
    );
    expect(response.status).toBe(404);
  });

  it("uses the ordered eligibility reasons", async () => {
    const noProject = makeEntry({ project: false, sensitivity: "restricted" });
    let body = await (
      await request(`/api/v1/knowledge/${noProject}/promotion`)
    ).json();
    expect(body.eligibility.reason).toBe("no_project");

    const notLinked = makeEntry({ linked: false });
    body = await (
      await request(`/api/v1/knowledge/${notLinked}/promotion`)
    ).json();
    expect(body.eligibility.reason).toBe("not_linked");

    const approved = makeEntry({ approval: "approved" });
    body = await (
      await request(`/api/v1/knowledge/${approved}/promotion`)
    ).json();
    expect(body.eligibility.reason).toBe("already_shared");

    const restricted = makeEntry({ sensitivity: "restricted" });
    body = await (
      await request(`/api/v1/knowledge/${restricted}/promotion`)
    ).json();
    expect(body.eligibility.reason).toBe("restricted");

    const hosted = makeEntry();
    body = await (
      await request(
        `/api/v1/knowledge/${hosted}/promotion`,
        "GET",
        undefined,
        makeConfig({ hostedMode: true, remoteGateway: true }),
      )
    ).json();
    expect(body.eligibility.reason).toBe("hosted");

    const accountRequired = makeEntry();
    body = await (
      await request(`/api/v1/knowledge/${accountRequired}/promotion`)
    ).json();
    expect(body.eligibility.reason).toBe("account_required");

    const unavailable = makeEntry();
    signIn();
    supabase.createClient.mockImplementationOnce(() => {
      throw new Error("offline");
    });
    body = await (
      await request(`/api/v1/knowledge/${unavailable}/promotion`)
    ).json();
    expect(body.eligibility.reason).toBe("remote_unavailable");

    const locked = makeEntry();
    signIn();
    body = await (
      await request(`/api/v1/knowledge/${locked}/promotion`)
    ).json();
    expect(body.eligibility.reason).toBe("encryption_locked");
  });

  it("recomputes preview eligibility when the pending-request lookup fails", async () => {
    const id = makeEntry();
    signIn();
    await unlockTeam();
    selectError = { code: "PGRST000", message: "offline" };

    const body = await (
      await request(`/api/v1/knowledge/${id}/promotion`)
    ).json();
    expect(body).toMatchObject({
      remote: "unreachable",
      eligibility: { promotable: false, reason: "remote_unavailable" },
    });
  });

  it("returns 503 when the promotion remote is unavailable", async () => {
    const id = makeEntry();
    signIn();
    supabase.createClient.mockImplementationOnce(() => {
      throw new Error("offline");
    });

    const response = await request(
      `/api/v1/knowledge/${id}/promote`,
      "POST",
      JSON.stringify({ version_id: id }),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { type: "remote_unreachable", reason: "remote_unavailable" },
    });
  });

  it("rejects a stale version and returns the current version id", async () => {
    const id = makeEntry();
    signIn();
    await unlockTeam();
    const response = await request(
      `/api/v1/knowledge/${id}/promote`,
      "POST",
      JSON.stringify({ version_id: OTHER }),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { type: "stale_version", current_version_id: id },
    });
  });

  it("returns an encrypted receipt without changing local approval state", async () => {
    const id = makeEntry();
    signIn();
    await unlockTeam();
    const response = await request(
      `/api/v1/knowledge/${id}/promote`,
      "POST",
      JSON.stringify({ version_id: id }),
    );
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.request).toMatchObject({
      team: { id: TEAM, name: "Acme" },
      logical_id: id,
      entry_version_id: id,
      entry_version: 1,
      category: "pattern",
      title: "Promotion title",
      content: "Exact team content",
      sealed: false,
      proposer: { id: USER, label: "@folk-user" },
      mine: true,
      status: "pending",
      can_decide: true,
      decide_blocked_reason: null,
    });
    expect(rpcCalls[0]).toMatchObject({
      name: "propose_promotion",
      args: {
        p_id: body.request.id,
        p_scope: TEAM,
        p_logical_id: id,
        p_entry_version_id: id,
      },
    });
    expect(body.request.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(ltm.teamPromotionCandidate(id)?.approvalStatus).toBe("pending");
    const stored = rows[0];
    const resolver = makeEncryptionResolver();
    const ctx = await resolver.ctxForScope(TEAM);
    expect(ctx).not.toBeNull();
    expect(
      openString(
        ctx!,
        crypto.buildAad(TEAM, "promotion_requests", "title", stored.id),
        stored.title_enc,
      ),
    ).toBe("Promotion title");
  });

  it("maps all promotion Postgres errors", async () => {
    signIn();
    for (const [code, status, type] of [
      ["P0002", 404, "not_found"],
      ["42501", 403, "forbidden"],
      ["55000", 409, "already_decided"],
      ["22023", 400, "invalid_request"],
      ["22001", 400, "invalid_request"],
    ] as const) {
      rpcError = { code, message: `db ${code}` };
      const response = await request(
        `/api/v1/promotions/${REQUEST}/approve`,
        "POST",
        "{}",
      );
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({
        error: { type, message: `db ${code}` },
      });
      rpcError = null;
    }

    const id = makeEntry();
    await unlockTeam();
    rpcError = { code: "23505", message: "duplicate pending" };
    let response = await request(
      `/api/v1/knowledge/${id}/promote`,
      "POST",
      JSON.stringify({ version_id: id }),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { type: "already_pending" },
    });

    rpcError = { code: "42501", message: "row-level security denied" };
    response = await request(
      `/api/v1/knowledge/${id}/promote`,
      "POST",
      JSON.stringify({ version_id: id }),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: {
        type: "forbidden",
        message: "row-level security denied",
      },
    });
  });

  it("lists decrypted requests and seals rows when the key is locked", async () => {
    const id = makeEntry();
    signIn();
    await unlockTeam();
    const proposed = await request(
      `/api/v1/knowledge/${id}/promote`,
      "POST",
      JSON.stringify({ version_id: id }),
    );
    expect(proposed.status).toBe(201);

    let response = await request(`/api/v1/promotions?team=${TEAM}&status=all`);
    let body = await response.json();
    expect(body.remote).toBe("ok");
    expect(body.requests[0]).toMatchObject({
      title: "Promotion title",
      content: "Exact team content",
      sealed: false,
    });

    keystore.lock();
    db().query("DELETE FROM account_identity").run();
    response = await request(`/api/v1/promotions?team=${TEAM}`);
    body = await response.json();
    expect(body.requests[0]).toMatchObject({
      title: null,
      content: null,
      sealed: true,
    });
  });

  it("leaves unknown reviewer labels null instead of exposing raw ids", async () => {
    signIn();
    rows = [rowFor("logical-1", { decided_by: UNKNOWN })];

    const body = await (
      await request(`/api/v1/promotions?team=${TEAM}&status=all`)
    ).json();
    expect(body.requests[0].decided_by).toEqual({
      id: UNKNOWN,
      label: null,
    });
  });

  it("uses cached identity only for self when the profile RPC fails", async () => {
    signIn();
    rows = [
      rowFor("logical-1", {
        proposer_id: UNKNOWN,
        status: "pending",
        decided_by: USER,
      }),
    ];
    rpcError = { code: "42501", message: "profile lookup denied" };

    const body = await (
      await request(`/api/v1/promotions?team=${TEAM}&status=all`)
    ).json();

    expect(body.requests[0].proposer).toEqual({
      id: UNKNOWN,
      label: null,
    });
    expect(body.requests[0].decided_by).toEqual({
      id: USER,
      label: "@folk-user",
    });
  });

  it("returns only 100 of 101 requests and marks the list incomplete", async () => {
    signIn();
    rows = Array.from({ length: 101 }, (_, index) =>
      rowFor(`logical-${index}`, {
        id: `40000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        created_at: new Date(1_700_000_000_000 + index).toISOString(),
      }),
    );
    const body = await (
      await request(`/api/v1/promotions?team=${TEAM}&status=all`)
    ).json();
    expect(body.requests).toHaveLength(100);
    expect(body.complete).toBe(false);
  });

  it("returns hosted refusal for each POST route", async () => {
    const hosted = makeConfig({ hostedMode: true, remoteGateway: true });
    for (const [path, body] of [
      [`/api/v1/knowledge/${REQUEST}/promote`, { version_id: REQUEST }],
      [`/api/v1/promotions/${REQUEST}/approve`, {}],
      [`/api/v1/promotions/${REQUEST}/reject`, {}],
      [`/api/v1/promotions/${REQUEST}/withdraw`, {}],
    ] as const) {
      const response = await request(
        path,
        "POST",
        JSON.stringify(body),
        hosted,
      );
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        error: { type: "forbidden" },
      });
    }
  });

  it("routes team review-policy PUT through the management API", async () => {
    signIn();
    const url = new URL(
      `/api/v1/teams/${TEAM}/review-policy`,
      "http://127.0.0.1",
    );
    const { handleAPIRequest } = await import("../src/api");
    const response = await handleAPIRequest(
      new Request(url, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          policy: "auto",
          expected_policy: "manual",
        }),
      }),
      url,
      makeConfig(),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ policy: "auto" });
    expect(rpcCalls).toContainEqual({
      name: "set_team_promotion_policy",
      args: {
        p_scope: TEAM,
        p_policy: "auto",
        p_expected: "manual",
      },
    });
  });

  it("rejects malformed review-policy PUT requests and refuses them when hosted", async () => {
    const malformed = await request(
      `/api/v1/teams/${TEAM}/review-policy`,
      "PUT",
      "{",
    );
    expect(malformed.status).toBe(400);
    const invalid = await request(
      `/api/v1/teams/${TEAM}/review-policy`,
      "PUT",
      JSON.stringify({ policy: "automatic", expected_policy: "manual" }),
    );
    expect(invalid.status).toBe(400);

    const hosted = await request(
      `/api/v1/teams/${TEAM}/review-policy`,
      "PUT",
      JSON.stringify({ policy: "auto", expected_policy: "manual" }),
      makeConfig({ hostedMode: true, remoteGateway: true }),
    );
    expect(hosted.status).toBe(403);
    expect(await hosted.json()).toMatchObject({
      error: { type: "forbidden" },
    });
  });

  it("maps stale team review policy to a revision conflict", async () => {
    signIn();
    teamPolicy = "auto";
    rpcError = { code: "40001", message: "stale expected policy" };
    const response = await request(
      `/api/v1/teams/${TEAM}/review-policy`,
      "PUT",
      JSON.stringify({ policy: "manual", expected_policy: "manual" }),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: {
        type: "stale_policy",
        current_policy: "auto",
      },
    });
  });

  it("returns hosted status without promotion data from GET routes", async () => {
    const entryId = makeEntry({ linked: true });
    const hosted = makeConfig({ hostedMode: true, remoteGateway: true });
    const previewResponse = await request(
      `/api/v1/knowledge/${entryId}/promotion`,
      "GET",
      undefined,
      hosted,
    );
    expect(previewResponse.status).toBe(200);
    expect(await previewResponse.json()).toMatchObject({
      remote: "hosted",
      pending_request: null,
    });

    const listResponse = await request(
      `/api/v1/promotions?team=${TEAM}`,
      "GET",
      undefined,
      hosted,
    );
    expect(listResponse.status).toBe(200);
    expect(await listResponse.json()).toEqual({
      remote: "hosted",
      requests: [],
      complete: true,
    });
  });

  it("returns 404 off-loopback for every promotion route", async () => {
    const paths = [
      ["GET", `/api/v1/knowledge/${REQUEST}/promotion`],
      ["POST", `/api/v1/knowledge/${REQUEST}/promote`],
      ["GET", `/api/v1/promotions?team=${TEAM}`],
      ["POST", `/api/v1/promotions/${REQUEST}/approve`],
      ["POST", `/api/v1/promotions/${REQUEST}/reject`],
      ["POST", `/api/v1/promotions/${REQUEST}/withdraw`],
      ["PUT", `/api/v1/teams/${TEAM}/review-policy`],
    ] as const;
    for (const [method, path] of paths) {
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
});

describe("autoProposePending", () => {
  it("proposes eligible auto-share entries once and skips the same version", async () => {
    signIn();
    const id = makeEntry();
    enableAutoShare(id);
    await unlockTeam();

    await autoProposePending(fakeClient as never, makeConfig());
    await autoProposePending(fakeClient as never, makeConfig());

    expect(
      rpcCalls.filter((call) => call.name === "propose_promotion"),
    ).toHaveLength(1);
    expect(rows[0].logical_id).toBe(id);
    expect(rows[0].entry_version_id).toBe(id);
  });

  it("does not repropose a rejected request for the same version", async () => {
    signIn();
    const id = makeEntry();
    enableAutoShare(id);
    await unlockTeam();
    await autoProposePending(fakeClient as never, makeConfig());
    rows[0].status = "rejected";
    rpcCalls = [];

    await autoProposePending(fakeClient as never, makeConfig());

    expect(
      rpcCalls.filter((call) => call.name === "propose_promotion"),
    ).toHaveLength(0);
    expect(rows).toHaveLength(1);
  });

  it("proposes a new version after the prior version was rejected", async () => {
    signIn();
    const id = makeEntry();
    enableAutoShare(id);
    await unlockTeam();
    await autoProposePending(fakeClient as never, makeConfig());
    rows[0].status = "rejected";
    expect(ltm.rejectForTeam(id)).toBe(true);
    ltm.update(id, { content: "Updated team content" });

    await autoProposePending(fakeClient as never, makeConfig());

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.entry_version_id)).toEqual([
      id,
      ltm.teamPromotionCandidate(id)?.versionId,
    ]);
  });

  it("does not propose when the effective policy is manual", async () => {
    signIn();
    const id = makeEntry();
    await unlockTeam();

    await autoProposePending(fakeClient as never, makeConfig());

    expect(ltm.teamPromotionCandidate(id)?.approvalStatus).toBe("pending");
    expect(
      rpcCalls.filter((call) => call.name === "propose_promotion"),
    ).toHaveLength(0);
  });

  it("reuses route eligibility and skips restricted entries", async () => {
    signIn();
    const id = makeEntry({ sensitivity: "restricted" });
    enableAutoShare(id);
    await unlockTeam();

    await autoProposePending(fakeClient as never, makeConfig());

    expect(
      rpcCalls.filter((call) => call.name === "propose_promotion"),
    ).toHaveLength(0);
  });
});

describe("applyPromotionDecisions", () => {
  beforeEach(() => {
    signIn();
    rows = [];
  });

  it("applies matching approvals and rejections locally and records the outcomes", async () => {
    const approved = makeEntry();
    const rejected = makeEntry();
    rows = [
      rowFor(approved, {
        id: "50000000-0000-4000-8000-000000000001",
        entry_version_id: approved,
        proposer_id: USER,
        status: "approved",
      }),
      rowFor(rejected, {
        id: "50000000-0000-4000-8000-000000000002",
        logical_id: rejected,
        entry_version_id: rejected,
        proposer_id: USER,
        status: "rejected",
      }),
    ];
    await applyPromotionDecisions(fakeClient as never);
    expect(ltm.teamPromotionCandidate(approved)?.approvalStatus).toBe(
      "approved",
    );
    expect(ltm.teamPromotionCandidate(rejected)?.approvalStatus).toBe(
      "rejected",
    );
    expect(rpcCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "mark_promotion_applied",
          args: expect.objectContaining({ p_outcome: "applied" }),
        }),
      ]),
    );
    expect(rows.every((row) => row.applied === "applied")).toBe(true);
  });

  it("marks changed versions stale without changing local approval", async () => {
    const id = makeEntry();
    rows = [
      rowFor(id, {
        entry_version_id: OTHER,
        proposer_id: USER,
        status: "approved",
      }),
    ];
    await applyPromotionDecisions(fakeClient as never);
    expect(ltm.teamPromotionCandidate(id)?.approvalStatus).toBe("pending");
    expect(rows[0].applied).toBe("stale");
  });

  it("marks deleted entries stale without changing local knowledge", async () => {
    const id = makeEntry();
    rows = [
      rowFor(id, {
        entry_version_id: id,
        proposer_id: USER,
        status: "rejected",
      }),
    ];
    ltm.remove(id);

    await applyPromotionDecisions(fakeClient as never);

    expect(ltm.teamPromotionCandidate(id)).toBeNull();
    expect(rows[0].applied).toBe("stale");
    expect(rpcCalls.at(-1)).toMatchObject({
      name: "mark_promotion_applied",
      args: { p_outcome: "stale" },
    });
  });

  it("does not throw when recording an applied outcome fails", async () => {
    signIn();
    const id = makeEntry();
    rows = [
      rowFor(id, {
        entry_version_id: id,
        proposer_id: USER,
        status: "approved",
      }),
    ];
    rpcError = { code: "PGRST000", message: "offline" };
    await expect(applyPromotionDecisions(fakeClient as never)).resolves.toBe(
      undefined,
    );
    expect(rpcCalls).toContainEqual({
      name: "mark_promotion_applied",
      args: { p_id: REQUEST, p_outcome: "applied" },
    });
    rpcError = null;
    rpcThrow = new Error("offline");
    await expect(applyPromotionDecisions(fakeClient as never)).resolves.toBe(
      undefined,
    );
  });

  it("does not throw when selecting promotion decisions fails", async () => {
    signIn();
    selectError = { code: "PGRST000", message: "offline" };
    await expect(applyPromotionDecisions(fakeClient as never)).resolves.toBe(
      undefined,
    );
  });
});
