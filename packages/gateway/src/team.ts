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
import { crypto, keystore } from "@loreai/core";
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

/** A repo's collaborator roster with a Lore-membership flag per collaborator (E-5-d, #630). */
export interface DiscoveredCollaborator {
  login: string;
  githubId: number;
  onLore: boolean;
}
export interface DiscoveredRepo {
  repo: string; // "owner/name"
  collaborators: DiscoveredCollaborator[];
}

/**
 * E-5-d (#630, Slice 1): discover which of the caller's GitHub repo collaborators already have a Lore
 * account, so the caller can invite the rest to a team they admin. Server-side-verified via the
 * `github-discover` Edge Function using the caller's OWN `provider_token` (a fresh one from GitHub
 * OAuth) — the client never asserts collaborators or membership. Returns null when there is no
 * `read:org`/repo grant (e.g. an email-only login).
 *
 * `repos` is an optional explicit list ("owner/name" or a GitHub URL); when omitted the Edge Function
 * scans the caller's own repos (first page). Membership is disclosed only for collaborators of repos
 * the caller can actually read on GitHub, and only as an `onLore` boolean (never a Lore user id).
 */
export async function discoverGitHubCollaborators(
  client: SupabaseClient,
  providerToken: string | null | undefined,
  repos?: string[],
): Promise<DiscoveredRepo[] | null> {
  if (!providerToken) return null; // no read:org/repo grant (older session / non-github login)
  const { data, error } = await client.functions.invoke("github-discover", {
    body: { provider_token: providerToken, repos },
  });
  if (error) throw new Error(`github-discover: ${error.message}`);
  const payload = data as {
    repos?: Array<{
      repo: string;
      collaborators: Array<{
        login: string;
        github_id: number;
        on_lore: boolean;
      }>;
    }>;
  };
  return (payload.repos ?? []).map((r) => ({
    repo: r.repo,
    collaborators: r.collaborators.map((c) => ({
      login: c.login,
      githubId: c.github_id,
      onLore: c.on_lore,
    })),
  }));
}

/**
 * The DISTINCT collaborators across all discovered repos, deduped by GitHub login (a person on
 * several repos should get one invite, not one per repo). Sorted for stable output. Used by
 * `lore team discover --invite` to mint one invite per person (E-5-d-2).
 */
export function distinctCollaborators(
  repos: DiscoveredRepo[],
): DiscoveredCollaborator[] {
  const byLogin = new Map<string, DiscoveredCollaborator>();
  for (const r of repos)
    for (const c of r.collaborators)
      if (!byLogin.has(c.login)) byLogin.set(c.login, c);
  return Array.from(byLogin.values()).sort((a, b) =>
    a.login.localeCompare(b.login),
  );
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
 *
 * OFFLINE (`opts.offline`, E-5-c-2): the admin-never-returns escape hatch. Additionally mints an
 * ephemeral X25519 keypair, wraps the scope DEK to it (stored as an `eph:<pub>` scope_keys row,
 * pushed), and appends the ephemeral SECRET to the token (`<capability>.<base64url(secret)>`). The
 * invitee can then unwrap + adopt the DEK and RETIRE the ephemeral wrap WITHOUT the admin ever
 * coming back online. Cost: the token carries a decryption-capable key until the invitee accepts
 * (single-use) and retires it — hence opt-in, short expiry, private channel.
 */
export async function createTeamInvite(
  client: SupabaseClient,
  scopeId: string,
  role: "editor" | "viewer" = "editor",
  hint?: string,
  opts?: { offline?: boolean },
): Promise<string> {
  let ephPubB64: string | null = null;
  let ephSecretSeg = "";
  let ephKeypair: { publicKey: Uint8Array; secretKey: Uint8Array } | undefined;
  if (opts?.offline) {
    // Generate the ephemeral keypair up front (cheap, no DB write) so the RPC can record eph_pub —
    // but DO NOT wrap/store/push the DEK yet. If create_scope_invite fails, we must not have left an
    // orphaned eph scope_keys row on the server (it could never be retired without the token).
    ephKeypair = crypto.generateIdentityKeypair();
    ephPubB64 = Buffer.from(ephKeypair.publicKey).toString("base64");
    // base64url (no padding) so the secret survives as a single token segment.
    ephSecretSeg = `.${Buffer.from(ephKeypair.secretKey).toString("base64url")}`;
  }
  const { data, error } = await client.rpc("create_scope_invite", {
    p_scope: scopeId,
    p_role: role,
    p_hint: hint ?? null,
    p_eph_pub: ephPubB64,
  });
  if (error) throw new Error(`create_scope_invite: ${error.message}`);
  // Only AFTER the invite token exists: wrap the DEK to the ephemeral pubkey, store the eph row, and
  // push it. An RPC failure above short-circuits before any eph row is created/pushed — no orphan.
  if (ephKeypair) {
    await keystore.mintEphemeralInviteWrap(
      scopeId,
      await selfUserId(),
      ephKeypair,
    );
    await pushOnce(client); // ship the eph wrap so the invitee can pull it
  }
  return `${data as string}${ephSecretSeg}`;
}

/** Conservative "looks like an email" check — decides whether `--email` is a real address to send to. */
export function isEmailAddress(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

/**
 * E-5-e (#630/#827): email a team invitee their join link via the `send-invite-email` Edge Function
 * (SMTP2GO). Best-effort — returns false (never throws) on any failure so the caller can fall back to
 * printing the token link; the invite itself already exists server-side.
 */
export async function sendInviteEmail(
  client: SupabaseClient,
  token: string,
  email: string,
): Promise<boolean> {
  try {
    const { error } = await client.functions.invoke("send-invite-email", {
      body: { token, email },
    });
    return !error;
  } catch {
    return false;
  }
}

/**
 * Redeem an invite token (E-5-c): self-add to the scope, publish this device's identity key so the
 * admin can wrap the DEK, and pull so the joined team shows in `lore team list`. Returns the scope
 * id + role.
 *
 * DEFAULT (capability token): content stays unreadable until the admin's next sync wraps the DEK to
 * this member (reconcileScopeWraps) — automatic, no follow-up on either side.
 *
 * OFFLINE (token carries a `.` ephemeral-secret suffix, E-5-c-2): after joining, unwrap the DEK from
 * the pulled `eph:<pub>` wrap using the token secret, re-wrap it to THIS identity, then RETIRE the
 * ephemeral wrap (delete the `eph:` row locally + remotely via retire_ephemeral_invite) so the
 * token's secret has nothing left to unwrap. The invitee can read pre-existing content immediately —
 * zero admin action, admin may be offline forever. No rotation (that is an admin-only team action);
 * the token is already single-use + short-lived + member-gated read, so deleting the spent wrap is
 * the correct, self-service retirement for an editor/viewer invitee.
 */
export async function acceptTeamInvite(
  client: SupabaseClient,
  token: string,
): Promise<{ scopeId: string; role: string }> {
  // Split an optional ephemeral-secret suffix: `<capability>.<base64url(secret)>`. A capability-only
  // token has no `.`, so `capability` is the whole string and `ephSecretB64url` is undefined.
  const dot = token.indexOf(".");
  const capability = dot >= 0 ? token.slice(0, dot) : token;
  const ephSecretB64url = dot >= 0 ? token.slice(dot + 1) : undefined;

  const { data, error } = await client.rpc("accept_scope_invite", {
    p_token: capability,
  });
  if (error) throw new Error(`accept_scope_invite: ${error.message}`);
  // The RPC returns a single-row set: [{ out_scope_id, out_role, out_eph_pub }] (OUT columns are
  // prefixed to avoid a name collision with the table columns inside the function body).
  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.out_scope_id) throw new Error("accept_scope_invite: empty result");
  const scopeId = row.out_scope_id as string;
  const role = row.out_role as string;
  const ephPub = row.out_eph_pub as string | null;
  // A token carrying an ephemeral secret MUST correspond to an offline invite the server recorded an
  // eph_pub for. If the secret is present but eph_pub is null (token/invite mismatch or corruption),
  // fail loudly rather than silently returning "joined" while never adopting the DEK — that would
  // leave the invitee unable to decrypt with no signal that anything went wrong.
  if (ephSecretB64url && !ephPub) {
    throw new Error(
      "invite token carries an offline key but the server has no matching ephemeral key — the token may be corrupt or not an offline invite",
    );
  }
  // Publish our identity key so the admin's reconcile can wrap the DEK to us, then pull the
  // membership mirror (+ the eph wrap, now readable as a member) so the team is visible locally.
  await publishIdentityPub(client);
  await pullOnce(client);

  // Offline path: adopt the DEK via the ephemeral secret, then retire the spent ephemeral wrap.
  if (ephSecretB64url && ephPub) {
    const self = await selfUserId();
    const ephSecret = new Uint8Array(Buffer.from(ephSecretB64url, "base64url"));
    // Unwrap the DEK with the token secret and re-wrap it to our own identity (at the eph epoch).
    await keystore.adoptEphemeralInviteWrap(scopeId, self, ephPub, ephSecret);
    // Retire the ephemeral wrap so the token secret can never unwrap it again: delete the remote row
    // (member-callable definer RPC — the admin-only scope_keys_delete policy doesn't apply to us) and
    // the local copy (capture-suppressed — a non-admin can't push a scope_keys DELETE).
    const { error: retErr } = await client.rpc("retire_ephemeral_invite", {
      p_scope: scopeId,
      p_eph_pub: ephPub,
    });
    if (retErr) throw new Error(`retire_ephemeral_invite: ${retErr.message}`);
    keystore.deleteEphemeralInviteWrap(scopeId, ephPub);
    // B's freshly-adopted self-wrap stays LOCAL-ONLY: scope_keys_insert is admin-only, so an
    // editor/viewer invitee cannot push their own wrap (and must not try — a 42501 would wedge the
    // scope_keys cursor). B holds the DEK locally to decrypt now; the admin's reconcile writes B's
    // remote wrap on the admin's next sync. We suppress capture on the local self-wrap so no
    // un-pushable outbox row lingers.
  }
  return { scopeId, role };
}

// --- Domain auto-join (E-5-b, Model B) ------------------------------------------------------------
// Org-level membership only (never a team scope / DEK) — thin wrappers over the SECURITY DEFINER RPCs
// in migration 0045. Verification (verified-email @domain, freemail blocklist, admin gate) is entirely
// server-side; the client never asserts eligibility.

export interface DomainJoinRequest {
  id: string;
  domain: string;
  userId: string;
  status: string;
  requestedAt: string;
}

/** Claim an auto-join domain for an org (admin/manager; must own a verified email @domain). */
export async function claimOrgDomain(
  client: SupabaseClient,
  orgId: string,
  domain: string,
  joinRole: "manager" | "billing" | "member" = "member",
): Promise<void> {
  const { error } = await client.rpc("claim_org_domain", {
    p_org: orgId,
    p_domain: domain,
    p_join_role: joinRole,
  });
  if (error) throw new Error(`claim_org_domain: ${error.message}`);
}

/** Request to join an org whose claimed domain matches the caller's verified email. Returns the
 * request id (admins approve it via approveDomainJoin). */
export async function requestDomainJoin(
  client: SupabaseClient,
  orgId: string,
  domain: string,
): Promise<string> {
  const { data, error } = await client.rpc("request_domain_join", {
    p_org: orgId,
    p_domain: domain,
  });
  if (error) throw new Error(`request_domain_join: ${error.message}`);
  return data as string;
}

/** List pending domain-join requests for an org (admin/manager; RLS scopes to the caller's orgs). */
export async function listDomainJoinRequests(
  client: SupabaseClient,
  orgId: string,
): Promise<DomainJoinRequest[]> {
  const { data, error } = await client
    .from("domain_join_requests")
    .select("id, domain, user_id, status, requested_at")
    .eq("org_id", orgId)
    .eq("status", "pending")
    .order("requested_at", { ascending: true });
  if (error) throw new Error(`domain_join_requests: ${error.message}`);
  return (data ?? []).map((r) => ({
    id: r.id as string,
    domain: r.domain as string,
    userId: r.user_id as string,
    status: r.status as string,
    requestedAt: r.requested_at as string,
  }));
}

/** Approve a pending join request (admin/manager). Additive — never downgrades an existing role. */
export async function approveDomainJoin(
  client: SupabaseClient,
  requestId: string,
): Promise<void> {
  const { error } = await client.rpc("approve_domain_join", {
    p_request_id: requestId,
  });
  if (error) throw new Error(`approve_domain_join: ${error.message}`);
}

/** Reject a pending join request (admin/manager). */
export async function rejectDomainJoin(
  client: SupabaseClient,
  requestId: string,
): Promise<void> {
  const { error } = await client.rpc("reject_domain_join", {
    p_request_id: requestId,
  });
  if (error) throw new Error(`reject_domain_join: ${error.message}`);
}
