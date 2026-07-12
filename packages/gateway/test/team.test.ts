/**
 * Unit coverage for the `lore team` orchestration (E-4c-4, #827). Runs WITHOUT Docker (the Tier-2
 * end-to-end lives in team.integration.test.ts): a lightweight mock `SupabaseClient` (rpc + select)
 * plus the REAL keystore against the test SQLite exercises every branch — RPC error paths, the
 * group-wrap with/without a published key, and the remove→rotate→re-wrap flow (self via the local
 * key; a keyless remaining member skipped).
 */
import { db, keystore, setKV } from "@loreai/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const SELF = "self-user-id";
const MEMBER = "member-user-id";

// Controllable local session (drives selfUserId()).
let currentUser: { user_id: string } | null = { user_id: SELF };
vi.mock("../src/supabase", () => ({
  getCurrentUser: () => Promise.resolve(currentUser),
}));
// pushOnce is a no-op spy — the wrap writes are asserted directly against the local scope_keys.
vi.mock("../src/sync", () => ({
  pushOnce: vi.fn().mockResolvedValue({ pushed: 0 }),
}));

import { pushOnce } from "../src/sync";
import {
  addTeamMember,
  createTeam,
  listTeams,
  removeTeamMember,
  setTeamRole,
  teamMembers,
} from "../src/team";

interface ClientOpts {
  scopeId?: string;
  newEpoch?: number;
  pub?: string | null; // identity_pub public_key returned for any user
  pubFor?: (userId: string) => string | null; // per-user override
  members?: { user_id: string; role: string }[]; // scope_members rows
  listRows?: Record<string, unknown>[]; // listTeams embed rows
  membersErr?: { message: string };
  identityErr?: { message: string };
  rpc?: (
    name: string,
    params: Record<string, unknown>,
  ) => { data?: unknown; error?: { message: string } } | null;
}

function makeClient(opts: ClientOpts = {}) {
  const rpcCalls: { name: string; params: Record<string, unknown> }[] = [];
  const client = {
    rpcCalls,
    rpc(name: string, params: Record<string, unknown>) {
      rpcCalls.push({ name, params });
      const override = opts.rpc?.(name, params);
      if (override) return Promise.resolve(override);
      if (name === "create_team")
        return Promise.resolve({
          data: opts.scopeId ?? "scope-uuid",
          error: null,
        });
      if (name === "rotate_scope_key")
        return Promise.resolve({ data: opts.newEpoch ?? 1, error: null });
      return Promise.resolve({ data: null, error: null });
    },
    from(table: string) {
      return {
        select(cols: string) {
          return {
            eq(_col: string, val: string) {
              if (table === "identity_pub") {
                return {
                  maybeSingle() {
                    if (opts.identityErr)
                      return Promise.resolve({
                        data: null,
                        error: opts.identityErr,
                      });
                    const pub = opts.pubFor ? opts.pubFor(val) : opts.pub;
                    return Promise.resolve({
                      data: pub ? { public_key: pub } : null,
                      error: null,
                    });
                  },
                };
              }
              // scope_members — awaited directly
              if (opts.membersErr)
                return Promise.resolve({ data: null, error: opts.membersErr });
              if (cols.includes("scopes"))
                return Promise.resolve({
                  data: opts.listRows ?? [],
                  error: null,
                });
              return Promise.resolve({ data: opts.members ?? [], error: null });
            },
          };
        },
      };
    },
  };
  return client as unknown as import("@supabase/supabase-js").SupabaseClient & {
    rpcCalls: { name: string; params: Record<string, unknown> }[];
  };
}

const FAST = { t: 1, m: 256, p: 1 } as const;
let selfPubB64: string;

function wraps(scopeId: string): { member: string; epoch: number }[] {
  return (
    db()
      .query(
        "SELECT member_user_id AS m, key_epoch AS e FROM scope_keys WHERE scope_id = ? ORDER BY member_user_id, key_epoch",
      )
      .all(scopeId) as { m: string; e: number }[]
  ).map((r) => ({ member: r.m, epoch: r.e }));
}

beforeEach(() => {
  currentUser = { user_id: SELF };
  keystore.lock();
  db().exec(
    "DELETE FROM account_identity; DELETE FROM account_escrow; DELETE FROM scope_keys",
  );
  setKV("sync.enabled", "0"); // no capture noise; pushOnce is mocked anyway
  keystore.setPassphrase("pw", { params: FAST });
  selfPubB64 = Buffer.from(keystore.getAccountIdentity().publicKey).toString(
    "base64",
  );
  vi.mocked(pushOnce).mockClear();
});

describe("createTeam", () => {
  it("calls create_team, mints the DEK wrapped to self@0, pushes, returns the scope id", async () => {
    const c = makeClient({ scopeId: "s-1" });
    const scope = await createTeam(c, "Rockets");
    expect(scope).toBe("s-1");
    expect(c.rpcCalls[0]).toEqual({
      name: "create_team",
      params: { p_name: "Rockets" },
    });
    expect(vi.mocked(pushOnce)).toHaveBeenCalledOnce();
    expect(wraps("s-1")).toEqual([{ member: SELF, epoch: 0 }]);
  });

  it("throws on an RPC error", async () => {
    const c = makeClient({
      rpc: (n) =>
        n === "create_team" ? { data: null, error: { message: "boom" } } : null,
    });
    await expect(createTeam(c, "X")).rejects.toThrow(/create_team: boom/);
  });
});

describe("addTeamMember", () => {
  it("adds + group-wraps the DEK to a member's published key", async () => {
    const c = makeClient({ scopeId: "s-2", pub: selfPubB64 });
    await createTeam(c, "T");
    vi.mocked(pushOnce).mockClear();
    const r = await addTeamMember(c, "s-2", MEMBER);
    expect(r.wrapped).toBe(true);
    expect(c.rpcCalls.at(-1)).toEqual({
      name: "add_scope_member",
      params: { p_scope: "s-2", p_user: MEMBER, p_role: "editor" },
    });
    expect(wraps("s-2")).toEqual([
      { member: MEMBER, epoch: 0 },
      { member: SELF, epoch: 0 },
    ]);
    expect(vi.mocked(pushOnce)).toHaveBeenCalledOnce();
  });

  it("passes a non-default role through", async () => {
    const c = makeClient({ scopeId: "s-2b", pub: selfPubB64 });
    await createTeam(c, "T");
    await addTeamMember(c, "s-2b", MEMBER, "admin");
    expect(c.rpcCalls.at(-1)?.params.p_role).toBe("admin");
  });

  it("returns wrapped:false and writes no wrap when the member has no published key", async () => {
    const c = makeClient({ scopeId: "s-3", pub: null });
    await createTeam(c, "T");
    vi.mocked(pushOnce).mockClear();
    const r = await addTeamMember(c, "s-3", MEMBER);
    expect(r.wrapped).toBe(false);
    expect(wraps("s-3")).toEqual([{ member: SELF, epoch: 0 }]); // only the creator
    expect(vi.mocked(pushOnce)).not.toHaveBeenCalled();
  });

  it("treats an identity_pub read error as no key (wrapped:false)", async () => {
    const c = makeClient({ scopeId: "s-3b", identityErr: { message: "rls" } });
    await createTeam(c, "T");
    expect((await addTeamMember(c, "s-3b", MEMBER)).wrapped).toBe(false);
  });

  it("throws on an add_scope_member RPC error", async () => {
    const c = makeClient({
      rpc: (n) =>
        n === "add_scope_member"
          ? { data: null, error: { message: "denied" } }
          : null,
    });
    await expect(addTeamMember(c, "s", MEMBER)).rejects.toThrow(
      /add_scope_member: denied/,
    );
  });
});

describe("removeTeamMember", () => {
  it("removes, rotates, and re-wraps the fresh DEK to the remaining members (self via local key)", async () => {
    const c = makeClient({
      scopeId: "s-4",
      newEpoch: 1,
      members: [{ user_id: SELF, role: "admin" }], // B already removed server-side
    });
    await createTeam(c, "T");
    const r = await removeTeamMember(c, "s-4", MEMBER);
    expect(r).toEqual({ newEpoch: 1, rewrapped: 1, skipped: [] });
    expect(c.rpcCalls.map((x) => x.name)).toEqual([
      "create_team",
      "remove_scope_member",
      "rotate_scope_key",
    ]);
    expect(wraps("s-4")).toEqual([
      { member: SELF, epoch: 0 },
      { member: SELF, epoch: 1 }, // fresh epoch-1 wrap for the survivor
    ]);
  });

  it("skips a remaining member that has no published key (self still re-wrapped via local key)", async () => {
    const c = makeClient({
      scopeId: "s-5",
      newEpoch: 1,
      members: [
        { user_id: SELF, role: "admin" },
        { user_id: "other", role: "editor" },
      ],
      pubFor: (uid) => (uid === "other" ? null : selfPubB64),
    });
    await createTeam(c, "T");
    const r = await removeTeamMember(c, "s-5", MEMBER);
    expect(r.newEpoch).toBe(1);
    expect(r.rewrapped).toBe(1); // only self
    expect(r.skipped).toEqual(["other"]);
  });

  it("throws on a remove_scope_member RPC error (no rotate attempted)", async () => {
    const c = makeClient({
      rpc: (n) =>
        n === "remove_scope_member"
          ? { data: null, error: { message: "not admin" } }
          : null,
    });
    await expect(removeTeamMember(c, "s", MEMBER)).rejects.toThrow(
      /remove_scope_member: not admin/,
    );
    expect(c.rpcCalls.some((x) => x.name === "rotate_scope_key")).toBe(false);
  });

  it("throws on a rotate_scope_key RPC error", async () => {
    const c = makeClient({
      rpc: (n) =>
        n === "rotate_scope_key"
          ? { data: null, error: { message: "locked" } }
          : null,
    });
    await expect(removeTeamMember(c, "s", MEMBER)).rejects.toThrow(
      /rotate_scope_key: locked/,
    );
  });
});

describe("setTeamRole", () => {
  it("calls set_scope_role", async () => {
    const c = makeClient();
    await setTeamRole(c, "s", MEMBER, "admin");
    expect(c.rpcCalls[0]).toEqual({
      name: "set_scope_role",
      params: { p_scope: "s", p_user: MEMBER, p_role: "admin" },
    });
  });

  it("throws on an RPC error", async () => {
    const c = makeClient({
      rpc: (n) =>
        n === "set_scope_role"
          ? { data: null, error: { message: "last admin" } }
          : null,
    });
    await expect(setTeamRole(c, "s", MEMBER, "editor")).rejects.toThrow(
      /set_scope_role: last admin/,
    );
  });
});

describe("teamMembers", () => {
  it("maps rows to {userId, role}", async () => {
    const c = makeClient({
      members: [
        { user_id: "a", role: "admin" },
        { user_id: "b", role: "editor" },
      ],
    });
    expect(await teamMembers(c, "s")).toEqual([
      { userId: "a", role: "admin" },
      { userId: "b", role: "editor" },
    ]);
  });

  it("throws on a query error", async () => {
    const c = makeClient({ membersErr: { message: "boom" } });
    await expect(teamMembers(c, "s")).rejects.toThrow(/team members: boom/);
  });
});

describe("listTeams", () => {
  it("keeps only kind=team scopes and normalizes the embedded scope (object or array form)", async () => {
    const c = makeClient({
      listRows: [
        { scope_id: "s1", role: "admin", scopes: { name: "T1", kind: "team" } },
        {
          scope_id: "s2",
          role: "member",
          scopes: { name: "P", kind: "personal" },
        },
        {
          scope_id: "s3",
          role: "editor",
          scopes: [{ name: "T3", kind: "team" }],
        },
      ],
    });
    expect(await listTeams(c)).toEqual([
      { scopeId: "s1", name: "T1", role: "admin" },
      { scopeId: "s3", name: "T3", role: "editor" },
    ]);
  });

  it("throws on a query error", async () => {
    const c = makeClient({ membersErr: { message: "boom" } });
    await expect(listTeams(c)).rejects.toThrow(/team list: boom/);
  });

  it("throws 'not logged in' when there is no session", async () => {
    currentUser = null;
    await expect(listTeams(makeClient())).rejects.toThrow(/not logged in/);
  });
});
