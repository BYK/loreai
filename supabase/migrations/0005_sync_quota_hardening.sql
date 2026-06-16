-- Migration 0005 — quota/abuse hardening (pen-test fixes for 0003/0004).
--
-- 1. Un-tombstone bypass [HIGH]: the quota trigger fired only BEFORE INSERT, so
--    a user could soft-delete rows (freeing slots), INSERT new rows, then flip
--    is_deleted back to false via UPDATE — growing live rows past the cap with
--    no INSERT to gate it. Fix: also quota-check UPDATEs that REVIVE a row
--    (is_deleted true -> false).
-- 2. TOCTOU [MEDIUM]: count-then-insert had no lock, so concurrent inserts for
--    one user could overshoot the cap. Fix: a per-(user,table) advisory xact
--    lock serializes a single user's concurrent quota checks.
-- 3. Uncapped `id` [LOW]: id was the only user-controlled TEXT column without a
--    size cap (oversized id failed as 54000, not a clean 23514). Fix: cap it.
-- 4. guard_profile_tier read a GUC PostgREST doesn't set; gate on the real role.

-- ---------------------------------------------------------------------------
-- 1 + 2. Quota trigger: INSERT and revival-UPDATE, serialized per user+table.
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
  -- Only INSERTs and is_deleted false<-true REVIVALS grow the live-row count.
  -- Any other UPDATE (content edit, or soft-delete true) can never increase it.
  if tg_op = 'UPDATE' then
    if not (old.is_deleted is true and new.is_deleted is false) then
      return new;
    end if;
  end if;

  -- Serialize concurrent quota checks for THIS user+table so a parallel burst
  -- can't each read a stale under-cap count and all proceed (TOCTOU). Scoped to
  -- (owner, table) → only one user's own concurrent writes serialize.
  perform pg_advisory_xact_lock(
    hashtextextended(new.owner_user_id::text || '|' || tg_table_name, 0));

  -- An INSERT whose PK already exists is an upsert→UPDATE in disguise: not new
  -- growth. (Reference PK columns generically — to_jsonb avoids parse-time
  -- field errors on tables lacking a given column.)
  if tg_op = 'INSERT' then
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
        using (to_jsonb(new)->>'owner_user_id')::uuid, to_jsonb(new)->>'id';
    end if;
    if exists_pk then
      return new;
    end if;
  end if;

  select tier into user_tier from public.profiles where id = new.owner_user_id;
  if user_tier is null then user_tier := 'free'; end if;

  select max_rows into cap
    from public.plan_limits
   where tier = user_tier and table_name = tg_table_name;
  if cap is null then
    return new;
  end if;

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

-- Re-attach as BEFORE INSERT OR UPDATE on every synced table.
do $$
declare t text;
begin
  foreach t in array array[
    'knowledge', 'entities', 'entity_aliases', 'entity_relations', 'knowledge_entity_refs'
  ]
  loop
    execute format('drop trigger if exists %1$s_row_quota on public.%1$s', t);
    execute format(
      'create trigger %1$s_row_quota before insert or update on public.%1$s
         for each row execute function public.enforce_row_quota()', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Cap the user-controlled `id` column on the four id-keyed tables.
--    (knowledge_entity_refs already caps knowledge_id/entity_id <= 64.)
-- ---------------------------------------------------------------------------
alter table public.knowledge drop constraint if exists knowledge_id_size_ck;
alter table public.knowledge add constraint knowledge_id_size_ck check (length(id) <= 64);
alter table public.entities drop constraint if exists entities_id_size_ck;
alter table public.entities add constraint entities_id_size_ck check (length(id) <= 64);
alter table public.entity_aliases drop constraint if exists entity_aliases_id_size_ck;
alter table public.entity_aliases add constraint entity_aliases_id_size_ck check (length(id) <= 64);
alter table public.entity_relations drop constraint if exists entity_relations_id_size_ck;
alter table public.entity_relations add constraint entity_relations_id_size_ck check (length(id) <= 64);

-- ---------------------------------------------------------------------------
-- 4. guard_profile_tier: gate on the actual switched role, not a GUC PostgREST
--    does not set. The column GRANT (excluding tier) remains the primary defense.
-- ---------------------------------------------------------------------------
create or replace function public.guard_profile_tier()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.tier is distinct from old.tier
     and coalesce(auth.role(), current_user) <> 'service_role'
  then
    raise exception 'tier is not user-modifiable'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;
