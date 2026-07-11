-- Migration 0025 — identity_pub directory + member-aware scope_keys RLS (E-3, #827).
--
-- WHY: group DEK wrapping needs (a) a place to look up a member's PUBLIC key so an admin can
-- wrap the per-scope DEK to them, and (b) scope_keys RLS that lets a MEMBER read their own wrap
-- (not just the scope owner) and an ADMIN write wraps for co-members. The identity PRIVATE key
-- never leaves the device — only the public key is published here (client publish = E-3b).
--
-- BEHAVIOR-PRESERVING for personal scopes: is_member(personal,owner)=true and
-- scope_role(personal,owner)='admin' (0023), and today member_user_id is always the owner's own
-- id, so the split scope_keys policies are byte-identical to the old owner-only scope_all.
-- identity_pub starts empty; shares_scope() is false for everyone until a shared (team) scope
-- exists, so no global pubkey directory is exposed.

-- ===========================================================================
-- 1. shares_scope(other): do the caller and `other` co-inhabit ANY scope? SECURITY DEFINER
--    (bypasses scope_members RLS → no recursion) with a pinned search_path.
-- ===========================================================================
create or replace function public.shares_scope(p_other uuid, p_uid uuid default auth.uid())
returns boolean language sql stable security definer set search_path = pg_catalog, public
as $$
  select exists(
    select 1
      from public.scope_members a
      join public.scope_members b on b.scope_id = a.scope_id
     where a.user_id = p_uid and b.user_id = p_other);
$$;
grant execute on function public.shares_scope(uuid, uuid) to authenticated;

-- ===========================================================================
-- 2. identity_pub: one public key per user. Publish own (write self); read own + co-members'
--    (so an admin can wrap the DEK to them). Public keys are not secret, but we still avoid a
--    global directory — you only see the pubkeys of people you share a scope with.
-- ===========================================================================
create table if not exists public.identity_pub (
  user_id    uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  public_key bytea not null,
  updated_at timestamptz not null default now()
);
-- Anti-abuse: a real identity public key is tiny (X25519 = 32 bytes; leave HPKE headroom).
alter table public.identity_pub drop constraint if exists identity_pub_size_ck;
alter table public.identity_pub add constraint identity_pub_size_ck
  check (octet_length(public_key) <= 256);

create index if not exists idx_identity_pub_updated on public.identity_pub (updated_at);

alter table public.identity_pub enable row level security;
-- Full control of your OWN row (publish/rotate); this also covers select-own.
drop policy if exists identity_pub_owner on public.identity_pub;
create policy identity_pub_owner on public.identity_pub
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
-- Additionally READ the pubkeys of people you share a scope with (OR-ed with the owner policy).
drop policy if exists identity_pub_read_comembers on public.identity_pub;
create policy identity_pub_read_comembers on public.identity_pub
  for select using (public.shares_scope(user_id));

revoke all on public.identity_pub from anon, authenticated;
grant select, insert, update on public.identity_pub to authenticated;

drop trigger if exists identity_pub_set_updated_at on public.identity_pub;
create trigger identity_pub_set_updated_at before update on public.identity_pub
  for each row execute function public.sync_set_updated_at();

-- ===========================================================================
-- 3. scope_keys: owner-only scope_all → member-aware, split per verb.
--    READ  — a member reads only THEIR OWN wrap (member_user_id = self) in scopes they belong to.
--    WRITE — only a scope ADMIN may create/update/delete wraps (group wrapping + rotation);
--            author still pinned to the writer. The 0012 first-write-wins guard still applies.
-- ===========================================================================
drop policy if exists scope_keys_scope_all on public.scope_keys;

drop policy if exists scope_keys_read on public.scope_keys;
create policy scope_keys_read on public.scope_keys
  for select using (
    public.is_member(scope_id) and member_user_id = auth.uid()::text
  );

drop policy if exists scope_keys_insert on public.scope_keys;
create policy scope_keys_insert on public.scope_keys
  for insert with check (
    public.scope_role(scope_id) = 'admin' and author_id = auth.uid()
  );

drop policy if exists scope_keys_update on public.scope_keys;
create policy scope_keys_update on public.scope_keys
  for update
  using (public.scope_role(scope_id) = 'admin')
  with check (public.scope_role(scope_id) = 'admin' and author_id = auth.uid());

drop policy if exists scope_keys_delete on public.scope_keys;
create policy scope_keys_delete on public.scope_keys
  for delete using (public.scope_role(scope_id) = 'admin');
