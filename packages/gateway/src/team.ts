/**
 * `lore team` orchestration (E-4c-4, #827) — the live caller for group DEK wrapping (E-4c-2) and
 * key rotation (E-4c-3), layered over the team lifecycle RPCs (E-4c-1). Every function takes an
 * injected authed `SupabaseClient` so it is testable against a real Postgres (pg-harness), exactly
 * like the sync engine's pushOnce/pullOnce.
 *
 * These manage a TEAM scope's KEY material (membership + per-member DEK wraps + rotation). Encrypting
 * CONTENT under a team scope is a later story; here the scope id is the team's `scopes.id`, and all
 * keystore calls key on it.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { keystore } from "@loreai/core";
import { getCurrentUser } from "./supabase";
import { publishIdentityPub, pullOnce, pushOnce } from "./sync";

export interface TeamSummary {
  scopeId: string;
  name: string;
  role: string;
}
export interface MemberSummary {
  userId: string;
  role: string;
}

async function selfUserId(): Promise<string> {
  const u = await getCurrentUser();
  if (!u) throw new Error("not logged in — run `lore login` first");
  return u.user_id;
}

/** A member's published identity public key (base64 → bytes), or null if they haven't published. */
async function memberPubKey(
  client: SupabaseClient,
  userId: string,
): Promise<Uint8Array | null> {
  const { data, error } = await client
    .from("identity_pub")
    .select("public_key")
    .eq("user_id", userId)
    .maybeSingle();
  if (error || !data?.public_key) return null;
  return Buffer.from(data.public_key as string, "base64");
}

/** List the team members of a scope (RLS: readable by any member). */
export async function teamMembers(
  client: SupabaseClient,
  scopeId: string,
): Promise<MemberSummary[]> {
  const { data, error } = await client
    .from("scope_members")
    .select("user_id, role")
    .eq("scope_id", scopeId);
  if (error) throw new Error(`team members: ${error.message}`);
  return (data ?? []).map((r) => ({
    userId: r.user_id as string,
    role: r.role as string,
  }));
}

/** The teams (shared scopes) the current user belongs to. */
export async function listTeams(
  client: SupabaseClient,
): Promise<TeamSummary[]> {
  const self = await selfUserId();
  const { data, error } = await client
    .from("scope_members")
    .select("scope_id, role, scopes(name, kind)")
    .eq("user_id", self);
  if (error) throw new Error(`team list: ${error.message}`);
  // PostgREST embeds a to-one relationship but supabase-js types it as an array — normalize.
  const scopeOf = (r: { scopes: unknown }) =>
    (Array.isArray(r.scopes) ? r.scopes[0] : r.scopes) as
      | { name: string; kind: string }
      | undefined;
  return (data ?? [])
    .filter((r) => scopeOf(r)?.kind === "team")
    .map((r) => ({
      scopeId: r.scope_id as string,
      name: scopeOf(r)?.name ?? "",
      role: r.role as string,
    }));
}

/**
 * Create a team scope and mint its DEK wrapped to the creator (admin + first member). The
 * scope_keys@0 row is pushed so it lands on the remote for later group-wrapping. Returns the id.
 */
export async function createTeam(
  client: SupabaseClient,
  name: string,
): Promise<string> {
  const { data, error } = await client.rpc("create_team", { p_name: name });
  if (error) throw new Error(`create_team: ${error.message}`);
  const scopeId = data as string;
  // Mint the team DEK (epoch 0), wrapped to the creator's own identity key.
  await keystore.getScopeKey(scopeId, await selfUserId());
  await pushOnce(client);
  return scopeId;
}

/**
 * Add a member and wrap the team DEK to their published identity key so they can decrypt. If the
 * member hasn't published an identity key yet, membership still lands but no wrap is written
 * (`wrapped:false`) — re-run `add` once they've synced (published their key).
 */
export async function addTeamMember(
  client: SupabaseClient,
  scopeId: string,
  userId: string,
  role: "admin" | "editor" | "viewer" = "editor",
): Promise<{ wrapped: boolean }> {
  const { error } = await client.rpc("add_scope_member", {
    p_scope: scopeId,
    p_user: userId,
    p_role: role,
  });
  if (error) throw new Error(`add_scope_member: ${error.message}`);
  const pub = await memberPubKey(client, userId);
  if (!pub) return { wrapped: false };
  await keystore.wrapScopeKeyForMember(
    scopeId,
    await selfUserId(),
    userId,
    pub,
  );
  await pushOnce(client);
  return { wrapped: true };
}

/** Change a member's role (admin/editor/viewer). Last-admin demotion is blocked server-side. */
export async function setTeamRole(
  client: SupabaseClient,
  scopeId: string,
  userId: string,
  role: "admin" | "editor" | "viewer",
): Promise<void> {
  const { error } = await client.rpc("set_scope_role", {
    p_scope: scopeId,
    p_user: userId,
    p_role: role,
  });
  if (error) throw new Error(`set_scope_role: ${error.message}`);
}

/**
 * Remove a member and ROTATE the scope key so they cannot read FUTURE content. Order: drop
 * membership first (which also deletes their remote wraps), then allocate the next epoch
 * server-atomically and re-wrap a FRESH DEK to the remaining members. `self` is always re-wrapped
 * via the LOCAL identity key (never self-lockout, even if self never published to identity_pub);
 * other members via their published key — a member with no published key is skipped (`skipped`)
 * and regains access when re-wrapped later. Returns the new epoch + counts.
 */
export async function removeTeamMember(
  client: SupabaseClient,
  scopeId: string,
  userId: string,
): Promise<{ newEpoch: number; rewrapped: number; skipped: string[] }> {
  const self = await selfUserId();
  // NOT atomic across the two RPCs: if rotate_scope_key throws after remove_scope_member commits,
  // the member is gone (RLS already blocks their reads) but the key isn't rotated. Re-running
  // `remove` on the already-removed member re-throws remove_scope_member — safe (no key exposure),
  // just not auto-resuming. Forward-secrecy-only impact; acceptable for v1.
  const { error: rmErr } = await client.rpc("remove_scope_member", {
    p_scope: scopeId,
    p_user: userId,
  });
  if (rmErr) throw new Error(`remove_scope_member: ${rmErr.message}`);

  const { data: ep, error: rotErr } = await client.rpc("rotate_scope_key", {
    p_scope: scopeId,
  });
  if (rotErr) throw new Error(`rotate_scope_key: ${rotErr.message}`);
  const newEpoch = ep as number;

  // Re-wrap the fresh DEK to the REMAINING members (the removed member is already gone from the
  // roster). self uses the LOCAL key so the rotator can never lock itself out.
  const members = await teamMembers(client, scopeId);
  const wraps: { userId: string; publicKey: Uint8Array }[] = [];
  const skipped: string[] = [];
  for (const m of members) {
    const pub =
      m.userId === self
        ? keystore.getAccountIdentity().publicKey
        : await memberPubKey(client, m.userId);
    if (pub) wraps.push({ userId: m.userId, publicKey: pub });
    else skipped.push(m.userId);
  }
  await keystore.rotateScopeKey(scopeId, newEpoch, wraps);
  await pushOnce(client);
  return { newEpoch, rewrapped: wraps.length, skipped };
}

/**
 * Mint a capability invite token for a scope (E-5-c). Admin-only + role ≤ editor is enforced
 * server-side (create_scope_invite). The token is an unguessable secret; whoever holds it and is
 * logged in can `acceptTeamInvite` to JOIN — it grants FETCH only (RLS is_member), never decrypt
 * (the DEK is wrapped to the new member by the admin's next sync, see reconcileScopeWraps).
 * `hint` is a free-text label for the admin's own reference; it is NOT resolved/verified.
 */
export async function createTeamInvite(
  client: SupabaseClient,
  scopeId: string,
  role: "editor" | "viewer" = "editor",
  hint?: string,
): Promise<string> {
  const { data, error } = await client.rpc("create_scope_invite", {
    p_scope: scopeId,
    p_role: role,
    p_hint: hint ?? null,
  });
  if (error) throw new Error(`create_scope_invite: ${error.message}`);
  return data as string;
}

/**
 * Redeem an invite token (E-5-c): self-add to the scope, publish this device's identity key so the
 * admin can wrap the DEK, and pull so the joined team shows in `lore team list`. Returns the scope
 * id + role. Content stays unreadable until the admin's next sync wraps the DEK to this member
 * (reconcileScopeWraps) — which is automatic, no follow-up on either side.
 */
export async function acceptTeamInvite(
  client: SupabaseClient,
  token: string,
): Promise<{ scopeId: string; role: string }> {
  const { data, error } = await client.rpc("accept_scope_invite", {
    p_token: token,
  });
  if (error) throw new Error(`accept_scope_invite: ${error.message}`);
  // The RPC returns a single-row set: [{ out_scope_id, out_role, out_eph_pub }] (OUT columns are
  // prefixed to avoid a name collision with the table columns inside the function body).
  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.out_scope_id) throw new Error("accept_scope_invite: empty result");
  // Publish our identity key so the admin's reconcile can wrap the DEK to us, then pull the
  // membership mirror so the team is visible locally.
  await publishIdentityPub(client);
  await pullOnce(client);
  return {
    scopeId: row.out_scope_id as string,
    role: row.out_role as string,
  };
}
