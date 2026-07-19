/**
 * END-TO-END integration for direct email invites (E-5-c, #827) against a REAL Postgres + PostgREST:
 * an admin mints a capability token (create_scope_invite), an invitee redeems it (accept_scope_invite)
 * to self-join, and the admin's next sync auto-wraps the team DEK to the new member
 * (reconcileScopeWraps) — zero follow-up on either side.
 *
 * Gated behind LORE_INTEGRATION=1 (needs Docker). Run:
 *   LORE_INTEGRATION=1 pnpm exec vitest run packages/gateway/test/sync-team-invite.integration.test.ts
 */
import { execFileSync } from "node:child_process";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { db, keystore, setKV, syncData } from "@loreai/core";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { publishIdentityPub, reconcileScopeWraps } from "../src/sync";
import {
  acceptTeamInvite,
  addTeamMember,
  createTeam,
  createTeamInvite,
} from "../src/team";
import { type PgHarness, startPgHarness } from "./helpers/pg-harness";

let mockUid = "";
vi.mock("../src/supabase", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/supabase")>()),
  getCurrentUser: () => Promise.resolve(mockUid ? { user_id: mockUid } : null),
}));

function dockerReady(): boolean {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore", timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

const RUN = process.env.LORE_INTEGRATION === "1";
const SKIP = !RUN
  ? "LORE_INTEGRATION!=1"
  : !dockerReady()
    ? "docker unavailable"
    : false;

const FAST = { t: 1, m: 256, p: 1 } as const;
let h: PgHarness;
let admin: string; // A — team creator/admin
let invitee: string; // B — the invited member

function clientFor(uid: string): SupabaseClient {
  const jwt = h.userJwt(uid);
  const rewriteFetch = (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    return fetch(url.replace("/rest/v1", ""), init);
  };
  return createClient(h.restUrl as string, jwt, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      headers: { Authorization: `Bearer ${jwt}` },
      fetch: rewriteFetch as unknown as typeof fetch,
    },
  });
}

function wipeLocalIdentity(): void {
  keystore.lock();
  db().exec(
    "DELETE FROM account_identity; DELETE FROM account_escrow; DELETE FROM scope_keys;" +
      " DELETE FROM knowledge; DELETE FROM knowledge_meta; DELETE FROM knowledge_meta_crdt;" +
      " DELETE FROM entity_aliases; DELETE FROM entity_relations; DELETE FROM entities;" +
      " DELETE FROM projects; DELETE FROM scope_members; DELETE FROM scopes;" +
      " DELETE FROM sync_outbox; DELETE FROM sync_state; DELETE FROM temp._sync_applying",
  );
  for (const m of syncData.syncedTables("basic"))
    setKV(`sync.push.${m.table}`, "0");
}

/** Set A up as a fresh admin device with a team scope; returns the scope id. */
async function freshAdminTeam(name: string): Promise<string> {
  wipeLocalIdentity();
  mockUid = admin;
  keystore.setPassphrase("admin pass", { params: FAST });
  syncData.enableSync("basic");
  return createTeam(clientFor(admin), name);
}

/**
 * B publishes its identity public key to the remote directory (as `lore team accept` would). Runs
 * as a self-contained "B device" flow, then leaves local state wiped so the caller can set up A
 * fresh — B's key persists on the REMOTE (identity_pub), which is where the admin reads it from.
 */
async function publishAsInvitee(): Promise<void> {
  wipeLocalIdentity();
  mockUid = invitee;
  keystore.setPassphrase("member pass", { params: FAST });
  await publishIdentityPub(clientFor(invitee));
}

/** Direct DB read (superuser) of a member's role in a scope, or undefined if absent. */
async function remoteRole(
  scopeId: string,
  userId: string,
): Promise<string | undefined> {
  return h.client
    .query(
      "select role from public.scope_members where scope_id=$1 and user_id=$2",
      [scopeId, userId],
    )
    .then((r) => (r.rows[0]?.role as string) ?? undefined);
}

beforeAll(async () => {
  if (SKIP) return;
  h = await startPgHarness({ postgrest: true });
  admin = await h.createUser("invite-admin@test.dev");
  invitee = await h.createUser("invite-member@test.dev");
}, 240_000);

afterAll(async () => {
  if (h) await h.stop();
});

beforeEach(() => {
  if (SKIP) return;
  wipeLocalIdentity();
});

describe.skipIf(SKIP)("lore team — direct email invite (E-5-c)", () => {
  it("invite → accept: invitee self-joins with the invite role; token is single-use", async () => {
    const scope = await freshAdminTeam("Invited Team");
    const token = await createTeamInvite(clientFor(admin), scope, "editor");
    expect(token).toMatch(/^[0-9a-f]{64}$/); // two uuidv4s, hyphens stripped

    mockUid = invitee;
    const res = await acceptTeamInvite(clientFor(invitee), token);
    expect(res.scopeId).toBe(scope);
    expect(res.role).toBe("editor");
    expect(await remoteRole(scope, invitee)).toBe("editor");
    // Single-use: the token row is consumed.
    expect(
      await h.client
        .query(
          "select count(*)::int n from public.pending_invites where token=$1",
          [token],
        )
        .then((r) => r.rows[0].n),
    ).toBe(0);
    // A second redemption fails identically to an unknown token (no oracle).
    await expect(acceptTeamInvite(clientFor(invitee), token)).rejects.toThrow(
      /invalid or expired invite/,
    );
  });

  it("only a scope admin may mint an invite (42501)", async () => {
    // B publishes its key FIRST (its own device), then A (fresh) creates the team and adds B.
    await publishAsInvitee();
    const scope = await freshAdminTeam("Admin-Only");
    await addTeamMember(clientFor(admin), scope, invitee, "editor");

    mockUid = invitee;
    await expect(
      createTeamInvite(clientFor(invitee), scope, "viewer"),
    ).rejects.toThrow(/create_scope_invite/);
  });

  it("an invite cannot grant admin (role ceiling, 22023)", async () => {
    const scope = await freshAdminTeam("Ceiling");
    // The typed client API only allows editor|viewer; call the RPC directly to prove the server
    // rejects an admin invite even if a client bypasses the type.
    const { error } = await clientFor(admin).rpc("create_scope_invite", {
      p_scope: scope,
      p_role: "admin",
    });
    expect(error?.message).toMatch(/editor or viewer/);
  });

  it("an invite cannot be minted for a PERSONAL scope (isolation, 22023)", async () => {
    // A's personal scope (kind='personal'): even though A is its admin, invites are team-only —
    // a personal scope is single-user, so a second member would break its isolation.
    wipeLocalIdentity();
    mockUid = admin;
    keystore.setPassphrase("admin pass", { params: FAST });
    syncData.enableSync("basic");
    const personalScope = await h.client
      .query(
        "select id from public.scopes where kind='personal' and id in (select scope_id from public.scope_members where user_id=$1)",
        [admin],
      )
      .then((r) => r.rows[0]?.id as string | undefined);
    expect(personalScope).toBeDefined();
    const { error } = await clientFor(admin).rpc("create_scope_invite", {
      p_scope: personalScope,
      p_role: "editor",
    });
    expect(error?.message).toMatch(/only for team scopes/);
  });

  it("an expired invite cannot be accepted (adversarial: expiry present before accept)", async () => {
    const scope = await freshAdminTeam("Expired");
    const token = await createTeamInvite(clientFor(admin), scope, "editor");
    // Force the row to be already expired BEFORE the invitee accepts.
    await h.client.query(
      "update public.pending_invites set expires_at = now() - interval '1 minute' where token=$1",
      [token],
    );
    mockUid = invitee;
    await expect(acceptTeamInvite(clientFor(invitee), token)).rejects.toThrow(
      /invalid or expired invite/,
    );
    expect(await remoteRole(scope, invitee)).toBeUndefined();
  });

  it("a never-existed token fails with the SAME error as expired (no oracle)", async () => {
    mockUid = invitee;
    await expect(
      acceptTeamInvite(clientFor(invitee), "deadbeef".repeat(8)),
    ).rejects.toThrow(/invalid or expired invite/);
  });

  it("accepting an invite never downgrades an existing higher role (additive)", async () => {
    // B publishes first, then A creates the team and makes B an ADMIN directly.
    await publishAsInvitee();
    const scope = await freshAdminTeam("Additive");
    await addTeamMember(clientFor(admin), scope, invitee, "admin");
    const token = await createTeamInvite(clientFor(admin), scope, "viewer");

    mockUid = invitee;
    await acceptTeamInvite(clientFor(invitee), token);
    // B stays admin — the editor/viewer invite did NOT downgrade them.
    expect(await remoteRole(scope, invitee)).toBe("admin");
  });

  it("accept also grants org membership so the invitee sees the org", async () => {
    const scope = await freshAdminTeam("Org-Vis");
    const orgId = await h.client
      .query("select org_id from public.scopes where id=$1", [scope])
      .then((r) => r.rows[0].org_id as string);
    const token = await createTeamInvite(clientFor(admin), scope, "editor");
    mockUid = invitee;
    await acceptTeamInvite(clientFor(invitee), token);
    expect(
      await h.client
        .query(
          "select count(*)::int n from public.org_members where org_id=$1 and user_id=$2",
          [orgId, invitee],
        )
        .then((r) => r.rows[0].n),
    ).toBe(1);
  });

  it("a token for scope A does not join scope B (cross-scope isolation)", async () => {
    const scopeA = await freshAdminTeam("Team A");
    const scopeB = await createTeam(clientFor(admin), "Team B");
    const tokenA = await createTeamInvite(clientFor(admin), scopeA, "editor");
    mockUid = invitee;
    const res = await acceptTeamInvite(clientFor(invitee), tokenA);
    expect(res.scopeId).toBe(scopeA);
    expect(await remoteRole(scopeA, invitee)).toBe("editor");
    expect(await remoteRole(scopeB, invitee)).toBeUndefined();
  });

  it("pending_invites is RPC-only: an authenticated client cannot read/write it directly", async () => {
    const scope = await freshAdminTeam("Deny-All");
    const token = await createTeamInvite(clientFor(admin), scope, "editor");
    const aClient = clientFor(admin);
    // Direct SELECT/INSERT/DELETE all denied by RLS (no policy → deny-all for authenticated).
    const sel = await aClient.from("pending_invites").select("token");
    expect(sel.data ?? []).toHaveLength(0); // RLS filters everything out
    const ins = await aClient
      .from("pending_invites")
      .insert({ token: "x".repeat(20), scope_id: scope, role: "editor" });
    expect(ins.error).toBeTruthy();
    const del = await aClient
      .from("pending_invites")
      .delete()
      .eq("token", token);
    expect(del.error ?? del.data).toBeTruthy(); // rejected or a no-op (RLS filters the row)
    // The token still works via the RPC — the RPC is the ONLY path.
    mockUid = invitee;
    const res = await acceptTeamInvite(clientFor(invitee), token);
    expect(res.scopeId).toBe(scope);
  });

  it("send-invite-email authorization signals: only the admin who CREATED the token can email it (E-5-e)", async () => {
    // The send-invite-email Edge Function authorizes on the invite TOKEN, not client input: it
    // requires (a) scope_role(scope)='admin' for the caller AND (b) invited_by = caller. This proves
    // both DB-level signals it reads, so it can never be used as an open email-spam relay. (The Deno
    // function itself isn't run here — the harness has no Deno runtime — but its exact authz reads are.)
    const scope = await freshAdminTeam("Email-Authz");
    await createTeamInvite(clientFor(admin), scope, "editor");
    // The invite row, read as the service does (superuser stands in for the service-role read).
    const row = await h.client
      .query(
        "select scope_id, invited_by from public.pending_invites where scope_id=$1",
        [scope],
      )
      .then((r) => r.rows[0] as { scope_id: string; invited_by: string });
    expect(row.invited_by).toBe(admin); // creator is the admin

    // Signal (a): scope_role resolves 'admin' for the creator, and NOT for a non-member.
    const adminRole = await clientFor(admin)
      .rpc("scope_role", { p_scope: scope })
      .then((r) => r.data);
    expect(adminRole).toBe("admin");
    const outsiderRole = await clientFor(invitee)
      .rpc("scope_role", { p_scope: scope })
      .then((r) => r.data);
    expect(outsiderRole == null || outsiderRole !== "admin").toBe(true);

    // Signal (b): invited_by binds the token to its creator — a different user fails the creator gate.
    expect(row.invited_by === invitee).toBe(false);
  });

  it("admin's sync auto-wraps the DEK to an invited member — zero follow-up (reconcileScopeWraps)", async () => {
    // B publishes its identity key to the remote directory (its own device), then local is wiped.
    await publishAsInvitee();

    // A (fresh) creates a team, and B is added as a member WITHOUT a wrap yet — simulate the
    // post-accept state (member row present, no scope_keys wrap) by adding B via the RPC directly
    // and then deleting the wrap addTeamMember created, so reconcile has exactly one member to heal.
    const scope = await freshAdminTeam("Auto-Wrap");
    const aClient = clientFor(admin);
    // Add B through the membership RPC (no client-side wrap) to model "joined, not yet keyed".
    const { error: addErr } = await aClient.rpc("add_scope_member", {
      p_scope: scope,
      p_user: invitee,
      p_role: "editor",
    });
    expect(addErr).toBeNull();
    // Drop any wrap for B locally + remotely so reconcile must create it.
    db()
      .query("DELETE FROM scope_keys WHERE scope_id=? AND member_user_id=?")
      .run(scope, invitee);
    await h.client.query(
      "delete from public.scope_keys where scope_id=$1 and member_user_id=$2",
      [scope, invitee],
    );
    // Pull so B's scope_members row is in A's local mirror (A never wiped → still holds DEK@0).
    const { pullOnce } = await import("../src/sync");
    await pullOnce(aClient);

    // The reconcile finds B (a member with a published key but no wrap) and wraps the DEK to them.
    const { wrapped } = await reconcileScopeWraps(aClient);
    expect(wrapped).toBe(1);
    // Remote now holds a wrap for B at A's epoch (0), under the TEAM scope.
    expect(
      await h.client
        .query(
          "select count(*)::int n from public.scope_keys where scope_id=$1 and member_user_id=$2",
          [scope, invitee],
        )
        .then((r) => r.rows[0].n),
    ).toBe(1);
    // Idempotent: a second reconcile wraps nobody new.
    expect((await reconcileScopeWraps(aClient)).wrapped).toBe(0);
  });

  it("a wrap CANNOT be written for a non-member — closes the removed-member re-wrap gap (F-1, 0043)", async () => {
    // A creates a team; B is NOT a member of it. A (admin) tries to write a DEK wrap targeting B.
    // The scope_keys_insert policy now requires the TARGET be a current member → RLS rejects it.
    // This is the server-side backstop for reconcileScopeWraps re-wrapping a member who was removed
    // on one admin's device but still lingers in a second admin's stale local scope_members mirror.
    const scope = await freshAdminTeam("No-Rewrap");
    const aClient = clientFor(admin);
    const ins = await aClient.from("scope_keys").insert({
      scope_id: scope,
      member_user_id: invitee, // NOT a member of this scope
      wrapped_dek: Buffer.from(new Uint8Array(48)).toString("base64"),
      key_epoch: 0,
    });
    expect(ins.error).toBeTruthy(); // RLS WITH CHECK (scope_has_member) rejects it
    expect(
      await h.client
        .query(
          "select count(*)::int n from public.scope_keys where scope_id=$1 and member_user_id=$2",
          [scope, invitee],
        )
        .then((r) => r.rows[0].n),
    ).toBe(0);
    // Sanity: the SAME insert for a real member (A itself) is allowed — the guard is target-scoped,
    // not a blanket block.
    const selfIns = await aClient.from("scope_keys").insert({
      scope_id: scope,
      member_user_id: admin,
      wrapped_dek: Buffer.from(new Uint8Array(48)).toString("base64"),
      key_epoch: 5, // a distinct epoch so it doesn't collide with A's real epoch-0 wrap
    });
    expect(selfIns.error).toBeNull();
  });

  it("revokes the scope's outstanding invite tokens on member removal (F-2, #1345)", async () => {
    // A removed member (or anyone holding a live/leaked token) must not be able to re-join via a
    // still-valid invite. remove_scope_member now wipes ALL of the scope's pending_invites.
    const scope = await freshAdminTeam("Revoke-On-Remove");
    await addTeamMember(clientFor(admin), scope, invitee, "editor");
    // An admin mints an outstanding invite (for some future member) that is still live.
    const token = await createTeamInvite(clientFor(admin), scope, "editor");
    expect(
      await h.client
        .query(
          "select count(*)::int n from public.pending_invites where scope_id=$1",
          [scope],
        )
        .then((r) => r.rows[0].n),
    ).toBe(1);
    // Admin removes the member → the removal revokes ALL of the scope's outstanding tokens.
    const { error: rmErr } = await clientFor(admin).rpc("remove_scope_member", {
      p_scope: scope,
      p_user: invitee,
    });
    expect(rmErr).toBeNull();
    expect(
      await h.client
        .query(
          "select count(*)::int n from public.pending_invites where scope_id=$1",
          [scope],
        )
        .then((r) => r.rows[0].n),
    ).toBe(0);
    // The revoked token can no longer be redeemed (fails identically to an unknown/expired one).
    mockUid = invitee;
    await expect(acceptTeamInvite(clientFor(invitee), token)).rejects.toThrow(
      /invalid or expired invite/,
    );
    // And the invitee is NOT a member of the scope (the removal + revoke held).
    expect(await remoteRole(scope, invitee)).toBeUndefined();
  });
});

describe.skipIf(SKIP)("lore team — offline invite (E-5-c-2)", () => {
  // Highest-scope epoch that exists on the remote for a scope (across all members).
  async function remoteMaxEpoch(scopeId: string): Promise<number> {
    return h.client
      .query(
        "select coalesce(max(key_epoch),-1)::int e from public.scope_keys where scope_id=$1",
        [scopeId],
      )
      .then((r) => r.rows[0].e as number);
  }
  async function remoteEphRows(scopeId: string): Promise<number> {
    return h.client
      .query(
        "select count(*)::int n from public.scope_keys where scope_id=$1 and member_user_id like 'eph:%'",
        [scopeId],
      )
      .then((r) => r.rows[0].n);
  }

  it("offline invite → fresh device adopts the DEK and retires the ephemeral wrap", async () => {
    // A creates a team (DEK@0) and mints an OFFLINE invite: an eph wrap of the DEK is pushed and the
    // token carries the ephemeral secret. Capture A's real DEK@0 to compare after B adopts.
    const scope = await freshAdminTeam("Offline");
    const aDek = Buffer.from(await keystore.getScopeKey(scope, admin)).toString(
      "hex",
    );
    const token = await createTeamInvite(
      clientFor(admin),
      scope,
      "editor",
      undefined,
      {
        offline: true,
      },
    );
    expect(token).toMatch(/^[0-9a-f]{64}\.[A-Za-z0-9_-]+$/); // capability.ephSecret
    expect(await remoteEphRows(scope)).toBe(1); // eph wrap landed on the remote

    // B, a FRESH device (no prior wrap, admin never comes back online), accepts.
    mockUid = invitee;
    keystore.setPassphrase("member pass", { params: FAST });
    const res = await acceptTeamInvite(clientFor(invitee), token);
    expect(res).toEqual({ scopeId: scope, role: "editor" });

    // B now holds the SAME DEK A minted — proving the ephemeral unwrap delivered the real key
    // (not a divergent fresh mint), re-wrapped to B's own identity at epoch 0.
    const bDek = Buffer.from(
      await keystore.getScopeKey(scope, invitee),
    ).toString("hex");
    expect(bDek).toBe(aDek);
    // B's self-wrap is LOCAL-ONLY (scope_keys_insert is admin-only; the admin's reconcile writes
    // B's remote wrap later). It exists locally so B can decrypt now.
    expect(
      db()
        .query(
          "SELECT count(*) AS n FROM scope_keys WHERE scope_id = ? AND member_user_id = ?",
        )
        .get(scope, invitee) as { n: number },
    ).toEqual({ n: 1 });

    // The spent ephemeral wrap is RETIRED: gone from both the remote and B's local store, so the
    // token's ephemeral secret can never unwrap it again.
    expect(await remoteEphRows(scope)).toBe(0);
    expect(
      db()
        .query(
          "SELECT count(*) AS n FROM scope_keys WHERE scope_id = ? AND member_user_id LIKE 'eph:%'",
        )
        .get(scope) as { n: number },
    ).toEqual({ n: 0 });
  });

  it("retire_ephemeral_invite is member-callable but only deletes eph rows, never a real wrap", async () => {
    // A member may retire a spent eph capability wrap (self-service), but the RPC is scoped to
    // 'eph:%' rows — a member can NEVER delete another member's real DEK wrap through it.
    const scope = await freshAdminTeam("Retire-Scope");
    await keystore.getScopeKey(scope, admin); // A's real wrap @0
    await addTeamMember(clientFor(admin), scope, invitee); // B is a real member with a wrap
    // B (a plain member) retiring a non-existent eph pub deletes nothing and leaves real wraps intact.
    const { error } = await clientFor(invitee).rpc("retire_ephemeral_invite", {
      p_scope: scope,
      p_eph_pub: "no-such-eph",
    });
    expect(error).toBeNull();
    expect(await remoteMaxEpoch(scope)).toBe(0); // real wraps untouched (still present @0)
    expect(
      await h.client
        .query(
          "select count(*)::int n from public.scope_keys where scope_id=$1 and member_user_id=$2",
          [scope, admin],
        )
        .then((r) => r.rows[0].n),
    ).toBe(1); // A's real wrap still there
    // Passing a REAL member's uuid as p_eph_pub retires only `eph:<uuid>` — the bare `<uuid>` real
    // wrap is never touched (the RPC concatenates the 'eph:' prefix, so it can't address a real row).
    await clientFor(invitee).rpc("retire_ephemeral_invite", {
      p_scope: scope,
      p_eph_pub: admin,
    });
    expect(
      await h.client
        .query(
          "select count(*)::int n from public.scope_keys where scope_id=$1 and member_user_id=$2",
          [scope, admin],
        )
        .then((r) => r.rows[0].n),
    ).toBe(1); // A's real wrap STILL there — only eph:<admin> would have been eligible
  });

  it("a capability (non-offline) token has no ephemeral suffix and mints no eph wrap", async () => {
    const scope = await freshAdminTeam("Cap-Only");
    await keystore.getScopeKey(scope, admin); // A holds DEK@0
    const token = await createTeamInvite(clientFor(admin), scope, "editor");
    expect(token).not.toContain("."); // pure capability — no ephemeral secret
    expect(await remoteEphRows(scope)).toBe(0);

    mockUid = invitee;
    keystore.setPassphrase("member pass", { params: FAST });
    await acceptTeamInvite(clientFor(invitee), token);
    // No eph wrap ever created — the admin's auto-wrap reconcile, not the invitee, delivers the DEK.
    expect(await remoteEphRows(scope)).toBe(0);
  });
});
