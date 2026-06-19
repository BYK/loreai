-- Migration 0007 — Scope seam (author_id / scope_id) + maintained usage counter.
--
-- WHY (forward-compat for team/org sharing — see epic #821):
--   Today every synced row is owned by a single user via `owner_user_id`, which
--   serves as BOTH "who wrote it" and "who owns/sees/bills it". Teams need those
--   to differ. We split the axis NOW, while the tables are small, so team sharing
--   later is a one-line RLS predicate swap (scope_id = auth.uid() -> is_member())
--   with NO PK change, NO data migration, NO counter re-key.
--     scope_id  uuid — owner/billing/visibility boundary (RLS + PK + quota key).
--                      Renamed from owner_user_id (it already played this role).
--     author_id uuid — who wrote the row. New; backfilled to scope_id.
--   v1 invariants (enforced, not just documented): scope_id = author_id = auth.uid()
--   for every row (RLS WITH CHECK), and scope_id is immutable (enforce_row_quota).
--   Teams (E) change the RLS membership predicate AND lift scope immutability — at
--   which point maintain_usage must move footprint between scope counters (see its
--   comment). Until then there is no counter re-key.
--
-- WHY (counter): the 0003/0004/0005 quota did COUNT(*) of the user's rows on every
--   write — fine for 30 entities, an O(n) scan at the 100k–500k rows the Pro tables
--   (#826) will hold. Replace it with a trigger-maintained O(1) counter that ALSO
--   tracks bytes (a byte budget). The counter is the single source of truth for
--   quota; written ONLY by SECURITY DEFINER triggers (no client write grant).
--
-- COUNTING MODEL — PHYSICAL footprint, not "live" rows. Every physical row counts
--   toward row_count and byte_count regardless of is_deleted. Rationale: (1) it is
--   the actual storage/cost a scope imposes on the shared DB; (2) it is forward-
--   compatible with the append-only knowledge model (A2, #823), where a delete is
--   an immutable is_deleted=true VERSION row that is appended and entries accrue
--   many version rows — all real storage; (3) it inherently closes the tombstone-
--   flood abuse (a tombstone INSERT, or insert-then-soft-delete churn, all count).
--   Consequence: soft-deleting does NOT free quota — only a hard DELETE does (the
--   reaper / compaction in A2). Acceptable: greenfield, generous caps, A2 follows.

-- ===========================================================================
-- 1. Rename owner_user_id -> scope_id and add author_id on every synced table.
--    RENAME is a cheap metadata op; the PK, FK and default follow automatically.
-- ===========================================================================
do $$
declare t text;
begin
  foreach t in array array[
    'knowledge', 'entities', 'entity_aliases', 'entity_relations', 'knowledge_entity_refs'
  ]
  loop
    execute format('alter table public.%I rename column owner_user_id to scope_id', t);
    execute format('alter table public.%I add column if not exists author_id uuid', t);
    -- existing rows: author = scope (personal data was authored by its owner).
    execute format('update public.%I set author_id = scope_id where author_id is null', t);
    execute format('alter table public.%I alter column author_id set not null', t);
    execute format('alter table public.%I alter column author_id set default auth.uid()', t);
  end loop;
end $$;

-- ===========================================================================
-- 2. RLS + pull-cursor index keyed on scope_id (drop/recreate explicitly — a
--    security boundary should not rely on rename-cascade being obvious).
-- ===========================================================================
do $$
declare t text;
begin
  foreach t in array array[
    'knowledge', 'entities', 'entity_aliases', 'entity_relations', 'knowledge_entity_refs'
  ]
  loop
    execute format('drop policy if exists %1$s_owner_all on public.%1$s', t);
    -- USING gates visibility by scope; WITH CHECK additionally pins author_id to
    -- the writer so a client cannot forge authorship (v1 invariant: author_id =
    -- auth.uid()). In teams (E) the scope predicate relaxes to is_member(scope_id)
    -- but author_id = auth.uid() stays (the author is always the writer).
    execute format(
      'create policy %1$s_scope_all on public.%1$s
         for all
         using (scope_id = auth.uid())
         with check (scope_id = auth.uid() and author_id = auth.uid())', t);
    -- pull cursor index now keyed on scope_id
    execute format('drop index if exists idx_%1$s_owner_updated', t);
    execute format(
      'create index if not exists idx_%1$s_scope_updated
         on public.%1$s (scope_id, updated_at)', t);
  end loop;
end $$;

-- ===========================================================================
-- 3. plan_limits gains a byte budget. (Pro-tier rows are added in #826.)
-- ===========================================================================
alter table public.plan_limits add column if not exists max_bytes bigint;

update public.plan_limits set max_bytes = v.max_bytes
  from (values
    ('knowledge',              8388608::bigint),   -- 8 MB
    ('entities',               1048576::bigint),   -- 1 MB
    ('entity_aliases',         2097152::bigint),   -- 2 MB
    ('entity_relations',       2097152::bigint),   -- 2 MB
    ('knowledge_entity_refs',  1048576::bigint)    -- 1 MB
  ) as v(table_name, max_bytes)
 where public.plan_limits.tier = 'free'
   and public.plan_limits.table_name = v.table_name;

-- ===========================================================================
-- 4. Byte accounting helper: size of a row's USER-controlled columns only
--    (sync-management columns are excluded — they are fixed overhead, not usage).
-- ===========================================================================
create or replace function public.usage_row_bytes(r jsonb)
returns bigint
language sql
immutable
set search_path = pg_catalog, public
as $$
  select coalesce(sum(octet_length(value)), 0)::bigint
    from jsonb_each_text(r)
   where key not in (
     'scope_id', 'author_id',
     'created_at', 'updated_at', 'revision', 'content_hash', 'is_deleted'
   )
$$;

-- ===========================================================================
-- 5. Maintained usage counter. Trigger-written ONLY (SECURITY DEFINER); no DML
--    grant to authenticated, so a client can never desync it to bypass quota.
-- ===========================================================================
create table if not exists public.user_table_usage (
  scope_id   uuid   not null,
  table_name text   not null,
  row_count  bigint not null default 0,
  byte_count bigint not null default 0,
  primary key (scope_id, table_name)
);

alter table public.user_table_usage enable row level security;
drop policy if exists user_table_usage_read on public.user_table_usage;
-- Owner may READ their usage (dashboards); nobody may write it via the API.
create policy user_table_usage_read on public.user_table_usage
  for select using (scope_id = auth.uid());
-- Explicit grants (don't rely on Supabase default-privilege behavior): clients
-- may SELECT their own row (gated by the policy) and NOTHING else. The counter is
-- written ONLY by the SECURITY DEFINER triggers below. RLS (no write policy) is
-- the real guarantee; the missing write grant is belt-and-suspenders.
revoke all on public.user_table_usage from anon, authenticated;
grant select on public.user_table_usage to authenticated;

-- AFTER INSERT/UPDATE/DELETE: apply the PHYSICAL footprint delta (every row that
-- physically exists counts, regardless of is_deleted). This is model-agnostic and
-- forward-compatible with the append-only knowledge model (A2, #823), where a
-- "delete" is an immutable is_deleted=true VERSION row that is appended (not a
-- toggle) and a logical entry accrues multiple version rows — all of which are
-- real storage. Compaction/GC (A2) reclaims footprint; soft-deleting does NOT.
-- Counting physically also inherently bounds the tombstone-flood (an INSERT of a
-- tombstone, or insert-then-soft-delete churn, all count toward the caps).
--   INSERT: +1 row, +bytes(new).   DELETE: -1 row, -bytes(old).
--   UPDATE: row unchanged (still one physical row); byte delta from content edit.
create or replace function public.maintain_usage()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_scope uuid;
  d_rows  int    := 0;
  d_bytes bigint := 0;
begin
  if tg_op = 'INSERT' then
    v_scope := new.scope_id;
    d_rows  := 1;
    d_bytes := public.usage_row_bytes(to_jsonb(new));
  elsif tg_op = 'DELETE' then
    v_scope := old.scope_id;
    d_rows  := -1;
    d_bytes := -public.usage_row_bytes(to_jsonb(old));
  else  -- UPDATE: physical row count unchanged; only the content byte delta.
    v_scope := new.scope_id;
    d_bytes := public.usage_row_bytes(to_jsonb(new))
             - public.usage_row_bytes(to_jsonb(old));
  end if;

  if d_rows = 0 and d_bytes = 0 then
    return null;
  end if;

  insert into public.user_table_usage (scope_id, table_name, row_count, byte_count)
    values (v_scope, tg_table_name, greatest(d_rows, 0), greatest(d_bytes, 0))
  on conflict (scope_id, table_name) do update
    set row_count  = greatest(public.user_table_usage.row_count  + d_rows,  0),
        byte_count = greatest(public.user_table_usage.byte_count + d_bytes, 0);
  return null;
end;
$$;

-- ===========================================================================
-- 6. Quota guard rewritten to read the O(1) counter and enforce BOTH row and
--    byte caps. Gates only GROWTH (a new physical row, or a byte increase);
--    preserves the 0005 upsert-in-disguise + advisory-lock TOCTOU protections.
-- ===========================================================================
create or replace function public.enforce_row_quota()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  user_tier text;
  cap_rows  bigint;
  cap_bytes bigint;
  cur_rows  bigint;
  cur_bytes bigint;
  d_rows    int    := 0;
  d_bytes   bigint := 0;
  exists_pk boolean;
begin
  -- v1 invariant: scope_id is immutable (a row never changes owner). Re-parenting
  -- is already blocked by RLS WITH CHECK for `authenticated`; this is a loud,
  -- explicit backstop. When teams (E) make scope mutable, lift this AND update
  -- maintain_usage to move the footprint between the old and new scope counters.
  if tg_op = 'UPDATE' and old.scope_id is distinct from new.scope_id then
    raise exception 'scope_id is immutable'
      using errcode = 'check_violation';
  end if;

  -- Serialize this scope+table BEFORE the existence probe and counter read, so a
  -- concurrent burst can't each observe an under-cap state and all proceed (the
  -- 0005 TOCTOU guarantee). xact-scoped → held through the AFTER maintain_usage.
  perform pg_advisory_xact_lock(
    hashtextextended(new.scope_id::text || '|' || tg_table_name, 0));

  -- Physical-footprint delta (mirrors maintain_usage): INSERT adds a row; UPDATE
  -- keeps the row, may change bytes. No is_deleted special-casing — every
  -- physical row counts, so there is no soft-delete/revival slot to game.
  if tg_op = 'INSERT' then
    -- An upsert (ON CONFLICT DO UPDATE) fires BEFORE INSERT even when it resolves
    -- to an UPDATE. If the PK already exists, defer to the BEFORE UPDATE call so
    -- we don't double-count it as a new physical row.
    if tg_table_name = 'knowledge_entity_refs' then
      select exists(
        select 1 from public.knowledge_entity_refs
         where scope_id     = (to_jsonb(new)->>'scope_id')::uuid
           and knowledge_id = to_jsonb(new)->>'knowledge_id'
           and entity_id    = to_jsonb(new)->>'entity_id')
        into exists_pk;
    else
      execute format(
        'select exists(select 1 from public.%I where scope_id = $1 and id = $2)',
        tg_table_name)
        into exists_pk
        using (to_jsonb(new)->>'scope_id')::uuid, to_jsonb(new)->>'id';
    end if;
    if exists_pk then
      return new;
    end if;
    d_rows  := 1;
    d_bytes := public.usage_row_bytes(to_jsonb(new));
  else  -- UPDATE: row count unchanged; gate only byte growth.
    d_bytes := public.usage_row_bytes(to_jsonb(new))
             - public.usage_row_bytes(to_jsonb(old));
  end if;

  -- Only growth needs gating; shrink / no-op pass freely.
  if d_rows <= 0 and d_bytes <= 0 then
    return new;
  end if;

  select tier into user_tier from public.profiles where id = new.scope_id;
  if user_tier is null then user_tier := 'free'; end if;

  select max_rows, max_bytes into cap_rows, cap_bytes
    from public.plan_limits
   where tier = user_tier and table_name = tg_table_name;
  if cap_rows is null and cap_bytes is null then
    return new;
  end if;

  select row_count, byte_count into cur_rows, cur_bytes
    from public.user_table_usage
   where scope_id = new.scope_id and table_name = tg_table_name;
  cur_rows  := coalesce(cur_rows, 0);
  cur_bytes := coalesce(cur_bytes, 0);

  if cap_rows is not null and d_rows > 0 and cur_rows + d_rows > cap_rows then
    raise exception
      'sync quota exceeded for % on tier %: % of % rows. Upgrade to sync more.',
      tg_table_name, user_tier, cur_rows, cap_rows
      using errcode = 'check_violation';
  end if;
  if cap_bytes is not null and d_bytes > 0 and cur_bytes + d_bytes > cap_bytes then
    raise exception
      'sync byte quota exceeded for % on tier %: % of % bytes. Upgrade to sync more.',
      tg_table_name, user_tier, cur_bytes, cap_bytes
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

-- ===========================================================================
-- 7. (Re)attach triggers: quota guard BEFORE, usage maintainer AFTER.
-- ===========================================================================
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

    execute format('drop trigger if exists %1$s_maintain_usage on public.%1$s', t);
    execute format(
      'create trigger %1$s_maintain_usage after insert or update or delete on public.%1$s
         for each row execute function public.maintain_usage()', t);
  end loop;
end $$;

-- ===========================================================================
-- 8. Backfill the counter from existing rows (one-shot, in this migration txn,
--    before any client can write the renamed tables). Triggers above never fire
--    on this (it writes user_table_usage directly), so no double-count.
-- ===========================================================================
do $$
declare t text;
begin
  foreach t in array array[
    'knowledge', 'entities', 'entity_aliases', 'entity_relations', 'knowledge_entity_refs'
  ]
  loop
    -- PHYSICAL footprint: every row counts (matches the trigger accounting).
    execute format($f$
      insert into public.user_table_usage (scope_id, table_name, row_count, byte_count)
      select scope_id, %1$L,
             count(*),
             coalesce(sum(public.usage_row_bytes(to_jsonb(x))), 0)
        from public.%1$I x
       group by scope_id
      on conflict (scope_id, table_name) do update
        set row_count = excluded.row_count, byte_count = excluded.byte_count
    $f$, t);
  end loop;
end $$;
