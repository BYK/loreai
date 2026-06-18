-- Migration 0004 — security hardening for direct-PostgREST sync.
--
-- Addresses an adversarial review of 0002/0003:
--   1. profiles.tier must NOT be user-writable (else free→pro self-escalation
--      defeats the quota system). Column-scoped UPDATE grant + a BEFORE UPDATE
--      trigger that rejects tier changes from non-privileged callers.
--   2. Cap ALL user-controlled TEXT columns (row-count caps alone don't bound
--      storage — a 30-row user could otherwise store 30 × ~1GB blobs).
--   3. Add the missing DML GRANTs to `authenticated`. RLS is the *second* gate;
--      without a table GRANT every PostgREST call is denied. These grants are
--      landed in the SAME migration as the tier guard so escalation is never
--      possible the instant writes become possible.
--   4. Quota trigger counts LIVE rows only and skips when the PK already exists,
--      so an at-cap user can still UPDATE / soft-delete (incl. the deletes that
--      free quota) via the upsert write path.

-- ---------------------------------------------------------------------------
-- 1. Lock down profiles.tier
-- ---------------------------------------------------------------------------
-- Column-scoped UPDATE: users may edit profile display fields but NOT tier.
-- (Postgres RLS is row-level; column safety needs a column GRANT and/or trigger.)
revoke update on public.profiles from authenticated;
grant select on public.profiles to authenticated;
grant update (github_login, display_name, email) on public.profiles to authenticated;

-- Belt-and-suspenders: even a future careless `GRANT UPDATE` can't change tier.
-- Only the table owner / service_role (which bypasses RLS and runs as a
-- superuser-ish role) may mutate tier; everyone else is rejected.
create or replace function public.guard_profile_tier()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.tier is distinct from old.tier
     and current_setting('request.jwt.role', true) is distinct from 'service_role'
  then
    raise exception 'tier is not user-modifiable'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_guard_tier on public.profiles;
create trigger profiles_guard_tier
  before update on public.profiles
  for each row execute function public.guard_profile_tier();

-- ---------------------------------------------------------------------------
-- 2. Bound EVERY user-controlled TEXT column (drop-then-add = idempotent).
--    Small caps for type/status/hash/id-ish columns; larger for real content.
--    knowledge_entity_refs PK columns are btree-bounded but we add an explicit
--    CHECK so an oversize value fails as a clean 400 (check_violation), not 54000.
-- ---------------------------------------------------------------------------
alter table public.knowledge drop constraint if exists knowledge_size_ck;
alter table public.knowledge add constraint knowledge_size_ck check (
  length(title) <= 512
  and length(content) <= 8192
  and length(category) <= 64
  and (metadata is null or length(metadata) <= 8192)
  and (project_id is null or length(project_id) <= 1024)
  and (source_session is null or length(source_session) <= 256)
  and (created_by is null or length(created_by) <= 256)
  and (updated_by is null or length(updated_by) <= 256)
  and (sensitivity is null or length(sensitivity) <= 32)
  and (promotion_status is null or length(promotion_status) <= 32)
  and (content_hash is null or length(content_hash) <= 64)
);

alter table public.entities drop constraint if exists entities_size_ck;
alter table public.entities add constraint entities_size_ck check (
  length(canonical_name) <= 512
  and length(entity_type) <= 64
  and (metadata is null or length(metadata) <= 8192)
  and (project_id is null or length(project_id) <= 1024)
  and (content_hash is null or length(content_hash) <= 64)
);

alter table public.entity_aliases drop constraint if exists entity_aliases_size_ck;
alter table public.entity_aliases add constraint entity_aliases_size_ck check (
  length(alias_value) <= 512
  and length(alias_type) <= 64
  and length(entity_id) <= 64
  and (source is null or length(source) <= 256)
  and (content_hash is null or length(content_hash) <= 64)
);

alter table public.entity_relations drop constraint if exists entity_relations_size_ck;
alter table public.entity_relations add constraint entity_relations_size_ck check (
  length(relation) <= 128
  and length(entity_a) <= 64
  and length(entity_b) <= 64
  and (source is null or length(source) <= 256)
  and (metadata is null or length(metadata) <= 8192)
  and (content_hash is null or length(content_hash) <= 64)
);

alter table public.knowledge_entity_refs drop constraint if exists knowledge_entity_refs_size_ck;
alter table public.knowledge_entity_refs add constraint knowledge_entity_refs_size_ck check (
  length(knowledge_id) <= 64 and length(entity_id) <= 64
);

-- ---------------------------------------------------------------------------
-- 3. DML grants so PostgREST works (RLS still enforces per-row ownership).
-- ---------------------------------------------------------------------------
grant select, insert, update, delete on
  public.knowledge, public.entities, public.entity_aliases,
  public.entity_relations, public.knowledge_entity_refs
  to authenticated;
grant select on public.plan_limits to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Quota trigger: count LIVE rows only; skip when the PK already exists
--    (an upsert that resolves to UPDATE is not new growth). This lets an at-cap
--    user still edit and soft-delete existing rows.
-- ---------------------------------------------------------------------------
create or replace function public.enforce_row_quota()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  user_tier text;
  cap       integer;
  used      integer;
  exists_pk boolean;
begin
  -- An INSERT whose PK already exists is an upsert→UPDATE in disguise: not new
  -- growth, so it must never be quota-blocked (else at-cap users freeze).
  -- NOTE: reference `new.<col>` only inside the matching branch — PL/pgSQL
  -- parses field access for the actual row type, so referencing a column that
  -- doesn't exist on this table (e.g. new.knowledge_id on `entities`) errors
  -- with 42703. Use `to_jsonb(new)` to read PK values generically instead.
  if tg_table_name = 'knowledge_entity_refs' then
    select exists(
      select 1 from public.knowledge_entity_refs
       where owner_user_id = (to_jsonb(new)->>'owner_user_id')::uuid
         and knowledge_id = to_jsonb(new)->>'knowledge_id'
         and entity_id = to_jsonb(new)->>'entity_id')
      into exists_pk;
  else
    execute format(
      'select exists(select 1 from public.%I where owner_user_id = $1 and id = $2)',
      tg_table_name)
      into exists_pk
      using
        (to_jsonb(new)->>'owner_user_id')::uuid,
        to_jsonb(new)->>'id';
  end if;
  if exists_pk then
    return new;
  end if;

  select tier into user_tier from public.profiles where id = new.owner_user_id;
  if user_tier is null then user_tier := 'free'; end if;

  select max_rows into cap
    from public.plan_limits
   where tier = user_tier and table_name = tg_table_name;
  if cap is null then
    return new;  -- unlimited for this (tier, table)
  end if;

  -- Count LIVE rows only — tombstones (is_deleted=true) don't consume quota,
  -- so a delete immediately frees a slot.
  execute format(
    'select count(*) from public.%I where owner_user_id = $1 and is_deleted = false',
    tg_table_name)
    into used using new.owner_user_id;

  if used >= cap then
    raise exception
      'sync quota exceeded for % on tier %: % of % rows. Upgrade to sync more.',
      tg_table_name, user_tier, used, cap
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;
