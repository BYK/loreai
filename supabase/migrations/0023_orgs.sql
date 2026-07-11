-- Migration 0023 — Org → Scope registry (foundation for teams/orgs, epic #821 / E, #827).
--
-- WHY: A1 (0007) split ownership into scope_id (owns/bills/sees) + author_id (writes),
--   promising teams would be "a one-line RLS predicate swap, no PK change, no re-key."
--   E delivers that. This migration is the ADDITIVE, BEHAVIOR-PRESERVING groundwork (E-1):
--   it introduces the registry that a scope_id points at, so a scope can later be a TEAM
--   and not just a user. The actual RLS/quota predicate swap is E-2 (separate migration);
--   the helper functions defined here are DEFINED-BUT-UNWIRED until then.
--
-- MODEL (Sentry-grounded, two-level, NOT nested):
--   Org      — billing + membership + roles. Holds many teams. Holds NO content + NO DEK.
--   Scope    — the content unit (has a per-scope DEK). kind='personal' (id = user_id) or
--              kind='team' (under an org). Every existing row is a personal scope whose
--              id already equals its owner's user id ⇒ ZERO re-key.
--   Members  — org_members(role owner|manager|billing|member) govern; scope_members
--              (role admin|editor|viewer) gate content (RLS-enforced in E-2).
--   A solo user = a 1-member personal org (billing rolls up to an org, uniformly).
--
-- BEHAVIOR-PRESERVING CLAIM (verified by the Tier-1 tests): every current scope_id keeps its
--   value; content isolation + the auth.users-delete → content cascade are unchanged (the
--   cascade now runs through orgs→scopes but reaches the same rows); enforce_row_quota and
--   the content RLS policies are UNTOUCHED here.

-- ===========================================================================
-- 1. Registry tables.
-- ===========================================================================
create table if not exists public.orgs (
  id            uuid primary key default gen_random_uuid(),
  kind          text not null default 'team' check (kind in ('personal', 'team')),
  owner_user_id uuid not null references auth.users (id) on delete cascade,
  tier          text not null default 'free',   -- TEAM billing tier; personal tier comes from
                                                 -- profiles (see effective_tier). service-role-only.
  slug          text unique,
  name          text,
  created_at    timestamptz not null default now()
);

create table if not exists public.org_members (
  org_id  uuid not null references public.orgs (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role    text not null default 'member' check (role in ('owner', 'manager', 'billing', 'member')),
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);

-- id is the scope boundary already stamped on every content row. For a personal scope it
-- EQUALS the owner's user id (⇒ zero re-key); a team scope gets a fresh uuid.
create table if not exists public.scopes (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.orgs (id) on delete cascade,
  kind       text not null check (kind in ('personal', 'team')),
  name       text,
  created_at timestamptz not null default now()
);

create table if not exists public.scope_members (
  scope_id uuid not null references public.scopes (id) on delete cascade,
  user_id  uuid not null references auth.users (id) on delete cascade,
  role     text not null default 'editor' check (role in ('admin', 'editor', 'viewer')),
  created_at timestamptz not null default now(),
  primary key (scope_id, user_id)
);

create index if not exists idx_org_members_user on public.org_members (user_id);
create index if not exists idx_scope_members_user on public.scope_members (user_id);
create index if not exists idx_scopes_org on public.scopes (org_id);
-- Hard invariant: at most one personal org per user (backstops the find-first in
-- provision_personal_scope against a concurrent signup/backfill race).
create unique index if not exists idx_orgs_one_personal
  on public.orgs (owner_user_id) where kind = 'personal';

-- ===========================================================================
-- 2. Membership / entitlement helpers. SECURITY DEFINER (bypass RLS → no policy
--    recursion when used inside RLS) with a pinned search_path. DEFINED HERE, WIRED IN E-2.
-- ===========================================================================
create or replace function public.is_member(p_scope uuid, p_uid uuid default auth.uid())
returns boolean language sql stable security definer set search_path = pg_catalog, public
as $$ select exists(select 1 from public.scope_members where scope_id = p_scope and user_id = p_uid) $$;

create or replace function public.is_org_member(p_org uuid, p_uid uuid default auth.uid())
returns boolean language sql stable security definer set search_path = pg_catalog, public
as $$ select exists(select 1 from public.org_members where org_id = p_org and user_id = p_uid) $$;

create or replace function public.scope_role(p_scope uuid, p_uid uuid default auth.uid())
returns text language sql stable security definer set search_path = pg_catalog, public
as $$ select role from public.scope_members where scope_id = p_scope and user_id = p_uid $$;

create or replace function public.org_role(p_org uuid, p_uid uuid default auth.uid())
returns text language sql stable security definer set search_path = pg_catalog, public
as $$ select role from public.org_members where org_id = p_org and user_id = p_uid $$;

-- effective_tier(scope): entitlement attaches to the scope. Dual-read so E-1 changes NO
-- billing path — a PERSONAL scope's tier still comes from profiles (Stripe writes profiles.tier
-- today, unchanged); a TEAM scope reads orgs.tier. Replaces current_tier()'s per-caller read
-- when the quota/RLS are swapped in E-2.
create or replace function public.effective_tier(p_scope uuid)
returns text language sql stable security definer set search_path = pg_catalog, public
as $$
  select coalesce(
    case (select kind from public.scopes where id = p_scope)
      when 'personal' then (select tier from public.profiles where id = p_scope)
      when 'team'     then (select o.tier from public.scopes s
                              join public.orgs o on o.id = s.org_id where s.id = p_scope)
    end, 'free');
$$;

grant execute on function
  public.is_member(uuid, uuid), public.is_org_member(uuid, uuid),
  public.scope_role(uuid, uuid), public.org_role(uuid, uuid),
  public.effective_tier(uuid) to authenticated;

-- ===========================================================================
-- 3. orgs.tier is service-role-only (mirrors guard_profile_tier, 0006). Stripe webhook
--    (service_role) is the sole tier writer; a client can never self-upgrade a team.
-- ===========================================================================
create or replace function public.guard_org_tier()
returns trigger language plpgsql security definer set search_path = pg_catalog, public
as $$
begin
  if new.tier is distinct from old.tier and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'orgs.tier is service-role-only' using errcode = 'check_violation';
  end if;
  return new;
end $$;
drop trigger if exists guard_org_tier on public.orgs;
create trigger guard_org_tier before update on public.orgs
  for each row execute function public.guard_org_tier();

-- ===========================================================================
-- 4. RLS on the registry. Read-own (via SECURITY DEFINER helpers → no recursion); ALL
--    writes go through SECURITY DEFINER paths (the backfill/trigger here, lifecycle RPCs in
--    E-4). No write grant to authenticated.
-- ===========================================================================
alter table public.orgs enable row level security;
alter table public.org_members enable row level security;
alter table public.scopes enable row level security;
alter table public.scope_members enable row level security;

drop policy if exists orgs_read on public.orgs;
create policy orgs_read on public.orgs for select using (public.is_org_member(id));
drop policy if exists org_members_read on public.org_members;
create policy org_members_read on public.org_members for select using (user_id = auth.uid());
drop policy if exists scopes_read on public.scopes;
create policy scopes_read on public.scopes for select using (public.is_member(id));
drop policy if exists scope_members_read on public.scope_members;
create policy scope_members_read on public.scope_members
  for select using (user_id = auth.uid() or public.is_member(scope_id));

revoke all on public.orgs, public.org_members, public.scopes, public.scope_members
  from anon, authenticated;
grant select on public.orgs, public.org_members, public.scopes, public.scope_members
  to authenticated;

-- ===========================================================================
-- 5. Personal-scope provisioning. Idempotent (re-runnable): finds an existing personal org
--    for the user, else creates one; every insert is ON CONFLICT DO NOTHING. Used by BOTH
--    the new-user trigger and the one-shot backfill below.
-- ===========================================================================
create or replace function public.provision_personal_scope(p_user uuid)
returns void language plpgsql security definer set search_path = pg_catalog, public
as $$
declare v_org uuid;
begin
  select id into v_org from public.orgs where kind = 'personal' and owner_user_id = p_user limit 1;
  if v_org is null then
    insert into public.orgs (kind, owner_user_id, name) values ('personal', p_user, 'Personal')
      on conflict (owner_user_id) where kind = 'personal' do nothing
      returning id into v_org;
    if v_org is null then  -- lost a concurrent race; the other txn created it
      select id into v_org from public.orgs where kind = 'personal' and owner_user_id = p_user limit 1;
    end if;
  end if;
  insert into public.org_members (org_id, user_id, role) values (v_org, p_user, 'owner')
    on conflict (org_id, user_id) do nothing;
  -- personal scope id = user id (this is what makes every existing content row zero-re-key).
  insert into public.scopes (id, org_id, kind, name) values (p_user, v_org, 'personal', 'Personal')
    on conflict (id) do nothing;
  insert into public.scope_members (scope_id, user_id, role) values (p_user, p_user, 'admin')
    on conflict (scope_id, user_id) do nothing;
end $$;

-- New users: provision on signup (independent of profiles — order-agnostic with 0001's
-- handle_new_user; effective_tier reads profiles live, so the personal org's tier is unused).
create or replace function public.on_auth_user_provision_scope()
returns trigger language plpgsql security definer set search_path = pg_catalog, public
as $$ begin perform public.provision_personal_scope(new.id); return new; end $$;
drop trigger if exists provision_personal_scope_on_signup on auth.users;
create trigger provision_personal_scope_on_signup after insert on auth.users
  for each row execute function public.on_auth_user_provision_scope();

-- Existing users: one-shot backfill (must run BEFORE the FK relax so a scopes row exists for
-- every content scope_id — the current scope_id → auth.users FK guarantees every scope_id is
-- a real user, so auth.users is a complete superset).
do $$
declare u uuid;
begin
  for u in select id from auth.users loop
    perform public.provision_personal_scope(u);
  end loop;
end $$;

-- ===========================================================================
-- 6. FK relax: every scope_id-keyed table now references the scopes registry instead of
--    auth.users. Discover + drop the existing single-column scope_id FK by catalog (its
--    name has drifted through the 0007 rename), then add scope_id → scopes(id) ON DELETE
--    CASCADE. The cascade chain auth.users → orgs(owner) → scopes(org) → content reaches the
--    exact same rows the old direct cascade did (verified by the Tier-1 delete test).
--    Includes the eviction/reaper infra tables (sync_eviction_budget/sync_device_progress):
--    once a scope can be a TEAM, their scope_id-keyed writes must FK the registry too, else
--    an eviction/pull against a team scope would FK-violate against auth.users.
-- ===========================================================================
do $$
declare t text; c text;
begin
  foreach t in array array[
    'knowledge', 'entities', 'entity_aliases', 'entity_relations', 'knowledge_entity_refs',
    'knowledge_meta', 'knowledge_meta_crdt', 'account_escrow', 'scope_keys',
    'distillations', 'temporal_messages', 'projects',
    'sync_eviction_budget', 'sync_device_progress'
  ]
  loop
    for c in
      select con.conname
        from pg_constraint con
        join pg_class rel on rel.oid = con.conrelid
        join pg_namespace nsp on nsp.oid = rel.relnamespace
       where nsp.nspname = 'public' and rel.relname = t and con.contype = 'f'
         and array_length(con.conkey, 1) = 1
         and (select a.attname from pg_attribute a
               where a.attrelid = con.conrelid and a.attnum = con.conkey[1]) = 'scope_id'
    loop
      execute format('alter table public.%I drop constraint %I', t, c);
    end loop;
    execute format(
      'alter table public.%1$I add constraint %1$I_scope_fk
         foreign key (scope_id) references public.scopes (id) on delete cascade', t);
  end loop;
end $$;
