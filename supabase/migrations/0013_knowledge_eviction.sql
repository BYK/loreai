-- Migration 0013: continuous top-N eviction for knowledge (server-side, #1191b PR1).
--
-- WHY. The value-ranked seed (#1189/#1194/#1196/#1198) makes the best-N sync at
-- `lore sync enable` time, but once a table is at its free-tier row cap, new writes
-- just pause — so an active free user's freshest, high-confidence knowledge stops
-- backing up while older, lower-value rows keep their slots. This makes the server
-- KEEP the best-N as the base grows: on a knowledge INSERT that would exceed the row
-- cap, evict the LOWEST-value entry for that scope instead of rejecting.
--
-- WHY SERVER-SIDE (not the client). Eviction here fires on INSERT-over-quota, so its
-- churn is bounded by the WRITE rate, not the 60s poll rate — it structurally cannot
-- thrash the way a client poll-loop could, needs no extra round-trips, and enforces
-- the churn budget where a client cannot bypass it. (Client latency-polish is a
-- separate follow-up.)
--
-- VALUE SIGNAL. A knowledge row carries no confidence — it lives in
-- `knowledge_meta.base_confidence` (already synced). We rank off THAT via a join
-- rather than denormalising a rank column onto `knowledge`: such a column would have
-- to track confidence, so every reinforce/decay would re-sync the big content row —
-- exactly the churn the knowledge_meta split removed. New entries are created near
-- confidence 1.0, so the incoming row is essentially never the lowest; ranking the
-- EXISTING rows by base_confidence is exact in practice.
--
-- EVICTION = HARD DELETE, NOT a tombstone. Local SQLite is the source of truth, so an
-- evicted remote row is a CACHE eviction, never data loss — and it must NOT propagate
-- as a deletion to peers (a soft-delete `is_deleted=true` would). A hard delete frees
-- the slot and is invisible to keyset pulls. It cascades to the entry's
-- knowledge_meta + knowledge_meta_crdt (by logical_id) so the trio stays aligned and
-- their slots free too — which means the paired meta/crdt INSERTs (pushed after
-- knowledge) then fit with no push-order change.
--
-- COST GUARD. A per-scope hourly circuit breaker (`sync_eviction_budget`) caps
-- evictions/hour/scope; over the cap the trigger falls back to raising (pause), like
-- today. The cap lives in `sync_config` (RLS-locked, admin/migration-managed) — NOT a
-- session GUC, so a client can't raise its own budget to force runaway eviction churn.
--
-- SCOPE (PR1). knowledge only, ROW cap only, FREE tier only. Byte-cap overflow still
-- raises (a large entry needs byte eviction — a follow-up). entities/aliases/relations
-- still raise until they get a self-contained rank (the `sync_rank` column follow-up).
-- Eviction is the FREE-tier relief valve: a capped pro tier (knowledge max_rows=50000 in
-- plan_limits) PAUSES instead of evicting, so a paying user gets a visible, recoverable
-- signal (bump the cap) rather than silent eviction of their remote cache. Revisit if a
-- new capped tier is added.

-- ---------------------------------------------------------------------------
-- 1. Per-scope eviction circuit breaker (rolling hourly window). Written only by the
--    security-definer quota trigger; RLS on with NO policies denies all direct client
--    access (the trigger bypasses RLS as definer).
-- ---------------------------------------------------------------------------
create table if not exists public.sync_eviction_budget (
  scope_id     uuid        not null primary key references auth.users (id) on delete cascade,
  window_start timestamptz not null default now(),
  evicted      integer     not null default 0
);
alter table public.sync_eviction_budget enable row level security;

-- Server-only config (RLS on, NO policies → clients can't read/write it; the
-- security-definer trigger bypasses RLS). Holds the eviction cap so it CANNOT be
-- overridden per-session by a client (a GUC could be `SET` by anyone).
create table if not exists public.sync_config (
  key   text   not null primary key,
  value bigint not null
);
alter table public.sync_config enable row level security;
insert into public.sync_config (key, value) values ('eviction_budget_per_hour', 200)
  on conflict (key) do nothing;

-- Belt-and-suspenders (mirrors 0007's user_table_usage): Supabase grants ALL on new
-- public tables to anon/authenticated by default, so RLS is the real gate — but revoke
-- the grants too, so a client attempt is a hard 42501 (permission denied) rather than a
-- silent RLS-filtered no-op. Definer functions (owned by the migration runner) keep access.
revoke all on public.sync_config, public.sync_eviction_budget from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Quota guard + knowledge eviction. Full 0010 body preserved verbatim; the only
--    addition is the eviction block between the usage read and the raise checks.
-- ---------------------------------------------------------------------------
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
  -- eviction locals
  evb_start timestamptz;
  evb_count int;
  evb_cap   int;
  victim    text;
begin
  if tg_op = 'UPDATE' and old.scope_id is distinct from new.scope_id then
    raise exception 'scope_id is immutable'
      using errcode = 'check_violation';
  end if;

  -- Do NOT read the victim's tier/usage for a row this caller cannot own (an at-cap
  -- existence oracle via the quota exception). Such a row is ALWAYS rejected by RLS
  -- WITH CHECK regardless, so skipping quota here changes NO legitimate outcome.
  if auth.uid() is not null and new.scope_id is distinct from auth.uid() then
    return new;
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(new.scope_id::text || '|' || tg_table_name, 0));

  if tg_op = 'INSERT' then
    if tg_table_name = 'knowledge_entity_refs' then
      select exists(
        select 1 from public.knowledge_entity_refs
         where scope_id     = (to_jsonb(new)->>'scope_id')::uuid
           and knowledge_id = to_jsonb(new)->>'knowledge_id'
           and entity_id    = to_jsonb(new)->>'entity_id')
        into exists_pk;
    elsif tg_table_name = 'knowledge_meta' then
      select exists(
        select 1 from public.knowledge_meta
         where scope_id   = (to_jsonb(new)->>'scope_id')::uuid
           and logical_id = to_jsonb(new)->>'logical_id')
        into exists_pk;
    elsif tg_table_name = 'knowledge_meta_crdt' then
      select exists(
        select 1 from public.knowledge_meta_crdt
         where scope_id   = (to_jsonb(new)->>'scope_id')::uuid
           and logical_id = to_jsonb(new)->>'logical_id'
           and replica_id = to_jsonb(new)->>'replica_id')
        into exists_pk;
    elsif tg_table_name = 'account_escrow' then
      select exists(
        select 1 from public.account_escrow
         where scope_id = (to_jsonb(new)->>'scope_id')::uuid
           and id       = (to_jsonb(new)->>'id')::int)
        into exists_pk;
    elsif tg_table_name = 'scope_keys' then
      select exists(
        select 1 from public.scope_keys
         where scope_id       = (to_jsonb(new)->>'scope_id')::uuid
           and member_user_id = to_jsonb(new)->>'member_user_id')
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

  -- ── Continuous top-N eviction (knowledge, row cap) ────────────────────────
  -- When a genuine new knowledge row would exceed the row cap, evict the lowest-value
  -- LIVE entry for this scope (by knowledge_meta.base_confidence; ties → oldest touched)
  -- instead of rejecting, then re-read usage so the checks below see the freed slot.
  -- Bounded by the per-scope hourly circuit breaker.
  if tg_op = 'INSERT' and tg_table_name = 'knowledge' and user_tier = 'free'
     and cap_rows is not null and d_rows > 0 and cur_rows + d_rows > cap_rows then
    select value into evb_cap from public.sync_config
      where key = 'eviction_budget_per_hour';
    evb_cap := coalesce(evb_cap, 200);
    insert into public.sync_eviction_budget (scope_id) values (new.scope_id)
      on conflict (scope_id) do nothing;
    select window_start, evicted into evb_start, evb_count
      from public.sync_eviction_budget
     where scope_id = new.scope_id
       for update;
    if now() - evb_start > interval '1 hour' then
      update public.sync_eviction_budget
         set window_start = now(), evicted = 0
       where scope_id = new.scope_id;
      evb_count := 0;
    end if;

    if evb_count < evb_cap then
      -- COALESCE(base_confidence, 1.0): a meta-less knowledge row is treated as HIGH
      -- value (protected), NOT low. This is deliberate on two counts: (1) it matches the
      -- knowledge_current view's COALESCE(confidence, 1.0) — meta-less = default 1.0
      -- everywhere; (2) meta-less is the NORMAL transient state during a push, since the
      -- client pushes all `knowledge` rows before their `knowledge_meta`. Ranking it 0.0
      -- would let the next at-cap INSERT evict a JUST-pushed fresh entry before its meta
      -- arrives — evicting the newest, highest-value data. Genuine orphans (permanent
      -- meta loss) are rare, bounded, and the reaper's (#909) job, not eviction's.
      select k.id into victim
        from public.knowledge k
        left join public.knowledge_meta m
          on m.scope_id = k.scope_id and m.logical_id = k.id
       where k.scope_id = new.scope_id and k.is_deleted = false
       order by coalesce(m.base_confidence, 1.0) asc, k.updated_at asc, k.id asc
       limit 1;

      if victim is not null then
        -- HARD delete + cascade (keeps knowledge/meta/crdt aligned; frees their slots).
        -- maintain_usage AFTER DELETE decrements user_table_usage for each.
        delete from public.knowledge_meta_crdt
         where scope_id = new.scope_id and logical_id = victim;
        delete from public.knowledge_meta
         where scope_id = new.scope_id and logical_id = victim;
        delete from public.knowledge
         where scope_id = new.scope_id and id = victim;
        update public.sync_eviction_budget
           set evicted = evicted + 1
         where scope_id = new.scope_id;

        select row_count, byte_count into cur_rows, cur_bytes
          from public.user_table_usage
         where scope_id = new.scope_id and table_name = tg_table_name;
        cur_rows  := coalesce(cur_rows, 0);
        cur_bytes := coalesce(cur_bytes, 0);
      end if;
    end if;
    -- breaker tripped or nothing to evict → fall through to the raise below (pause).
  end if;

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
