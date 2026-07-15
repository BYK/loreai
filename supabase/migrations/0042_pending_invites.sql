-- Migration 0042 — direct email invite: pending_invites + create/accept RPCs (E-5-c, #827).
--
-- Onboard a member who isn't yet resolvable to a user_id, with NO manual follow-up. An admin
-- mints a capability token for a scope; the invitee redeems it with `lore team accept <token>`,
-- which self-adds them + publishes their identity key. The admin's next idle sync then wraps the
-- DEK to the new member (client-side, reuses E-4c-2) — the invitee decrypts once that lands.
--
-- This is the SECOND cross-user `scope_members` write path (after add_scope_member, 0029). It is
-- safe for the same reasons + these invite-specific guards:
--   * the token is an unguessable secret (server-generated); redemption adds ONLY auth.uid();
--   * single-use (deleted on accept) and expiring (14 days);
--   * NO email oracle — invitee_hint is a free-text label the admin typed, never resolved or
--     verified against auth.users; not-found and expired return the SAME error (no probing);
--   * admin-only mint (scope_role = 'admin'); role ceiling editor/viewer (an invite link must
--     NEVER be an admin-escalation vector — admin promotion stays an explicit set_scope_role);
--   * additive — accept is `on conflict do nothing`, so redeeming for a scope you're already in
--     never downgrades your existing role.
-- Membership grants FETCH only (RLS is_member); it does NOT grant DECRYPT until an admin wraps
-- the DEK to the new member — so a leaked/forged token can never read content, only join.
--
-- `eph_pub` (nullable) is added now for E-5-c-2's `--offline` ephemeral-key path (a token that
-- carries a decryption-capable key + rotate-on-accept for the admin-never-returns case). It stays
-- NULL for capability invites; adding the column now avoids a second migration later.

-- ---------------------------------------------------------------------------
-- Table. RPC-only: RLS enabled with NO policies ⇒ deny-all to anon/authenticated (the accept
-- path must read a token for a scope the caller isn't yet a member of, so no member-scoped
-- SELECT policy could serve it — both create + accept go through SECURITY DEFINER RPCs).
-- ---------------------------------------------------------------------------
create table if not exists public.pending_invites (
  token        text primary key,
  scope_id     uuid not null references public.scopes (id) on delete cascade,
  role         text not null default 'editor' check (role in ('editor', 'viewer')),
  invited_by   uuid not null references auth.users (id) on delete cascade,
  invitee_hint text,
  eph_pub      text,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  constraint pending_invites_size_ck check (
    length(token) <= 128
    and (invitee_hint is null or length(invitee_hint) <= 320)
    and (eph_pub is null or length(eph_pub) <= 512)
  )
);
create index if not exists idx_pending_invites_scope on public.pending_invites (scope_id);

alter table public.pending_invites enable row level security;
revoke all on public.pending_invites from anon, authenticated;

-- ---------------------------------------------------------------------------
-- create_scope_invite: a scope ADMIN mints a token. Returns the token string.
-- ---------------------------------------------------------------------------
create or replace function public.create_scope_invite(
  p_scope uuid, p_role text default 'editor', p_hint text default null, p_eph_pub text default null)
returns text language plpgsql security definer set search_path = pg_catalog, public
as $$
declare
  v_token text;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_scope::text, 0));
  -- scope_role() defaults to auth.uid() → checks the CALLER is an admin of the scope.
  if public.scope_role(p_scope) is distinct from 'admin' then
    raise exception 'only a scope admin may create invites' using errcode = '42501';
  end if;
  -- Invites are for TEAM scopes only. A personal scope (kind='personal', id = the owner's uid) is
  -- single-user by definition — inviting a second member would break personal-scope isolation.
  if (select kind from public.scopes where id = p_scope) is distinct from 'team' then
    raise exception 'invites are only for team scopes' using errcode = '22023';
  end if;
  -- Role ceiling: an invite may grant editor/viewer only — NEVER admin (no escalation via a link).
  if p_role not in ('editor', 'viewer') then
    raise exception 'invite role must be editor or viewer' using errcode = '22023';
  end if;
  -- Unguessable capability token: two random UUIDv4s (pg_catalog.gen_random_uuid, no pgcrypto /
  -- search_path dependency). 72 chars of 122 bits each — infeasible to guess.
  v_token := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  insert into public.pending_invites (token, scope_id, role, invited_by, invitee_hint, eph_pub, expires_at)
    values (v_token, p_scope, p_role, auth.uid(), p_hint, p_eph_pub, now() + interval '14 days');
  return v_token;
end $$;

-- ---------------------------------------------------------------------------
-- accept_scope_invite: the CALLER redeems a token, self-adding to the scope. Single-use.
-- Returns the joined scope's id + role + any ephemeral pubkey (used by the E-5-c-2 offline path).
-- ---------------------------------------------------------------------------
create or replace function public.accept_scope_invite(p_token text)
returns table (out_scope_id uuid, out_role text, out_eph_pub text)
language plpgsql security definer set search_path = pg_catalog, public
as $$
declare
  rec   public.pending_invites%rowtype;
  v_org uuid;
begin
  select * into rec from public.pending_invites where token = p_token;
  -- IDENTICAL error for not-found vs expired → no "is this token real?" oracle. Lock AFTER the
  -- lookup (we need the scope id first); a concurrent second accept serializes on the same lock
  -- and then finds the row already deleted (single-use) → same invalid error.
  if not found then
    raise exception 'invalid or expired invite' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(rec.scope_id::text, 0));
  select * into rec from public.pending_invites where token = p_token; -- re-read under lock
  if not found or rec.expires_at < now() then
    raise exception 'invalid or expired invite' using errcode = '22023';
  end if;
  select org_id into v_org from public.scopes where id = rec.scope_id;
  if v_org is null then
    raise exception 'invalid or expired invite' using errcode = '22023';
  end if;
  -- Org membership (plain member) so the invitee can see the org; then the scope role. Additive:
  -- an existing higher role is preserved (do nothing), never downgraded by redeeming an invite.
  insert into public.org_members (org_id, user_id, role) values (v_org, auth.uid(), 'member')
    on conflict (org_id, user_id) do nothing;
  insert into public.scope_members (scope_id, user_id, role) values (rec.scope_id, auth.uid(), rec.role)
    on conflict (scope_id, user_id) do nothing;
  delete from public.pending_invites where token = p_token; -- single-use
  -- OUT columns are prefixed out_* so they never collide with table column names inside the body
  -- (a same-named OUT column makes an unqualified table reference ambiguous — the accept_scope_invite
  -- "column reference scope_id is ambiguous" bug this prefix avoids).
  return query select rec.scope_id, rec.role, rec.eph_pub;
end $$;

grant execute on function public.create_scope_invite(uuid, text, text, text) to authenticated;
grant execute on function public.accept_scope_invite(text) to authenticated;
