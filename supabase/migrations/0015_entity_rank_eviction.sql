-- Migration 0015: extend server-side eviction to `entities` by synced ref-count
-- (#1191b PR2b). Completes the entity-graph relief valve (0013 knowledge, 0014
-- aliases/relations).
--
-- entities (free cap 30) still hard-pause at the row cap. Unlike knowledge (value =
-- confidence) and aliases/relations (value = recency), an entity's value is its
-- REF-COUNT — and that is neither self-contained on the row nor known at INSERT: a new
-- entity starts at ~0 refs and its knowledge_entity_refs aren't synced yet, so the server
-- can't value the INCOMING row via a JOIN. So the client maintains a synced `sync_rank`
-- column (= ref-count) ON the entity row; the server evicts by it WITH an incoming-value
-- guard: only evict the lowest-rank existing entity when the incoming row strictly
-- outranks it (`new.sync_rank > floor`). A junk 0-ref entity therefore PAUSES (doesn't
-- displace a well-referenced one) until it accrues refs and its rank rises above the floor.
--
-- Eviction cascades the victim's graph edges — its entity_aliases, knowledge_entity_refs,
-- and entity_relations (either endpoint) — since they're meaningless without the entity;
-- this keeps the remote graph consistent and frees those tables' slots. HARD deletes (cache
-- eviction, not peer-propagating tombstones). FREE-tier + ROW-cap + circuit-breaker gated,
-- exactly as 0013/0014.
--
-- Changes from 0014: (1) add entities.sync_rank column; (2) the eviction block adds an
-- `entities` branch (guarded, cascading) and 'entities' to the table set.

alter table public.entities add column if not exists sync_rank integer not null default 0;

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
  evb_start  timestamptz;
  evb_count  int;
  evb_cap    int;
  victim     text;
  floor_rank int;
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

  -- ── Continuous top-N eviction (free tier, row cap) ──────────────────────────
  -- On a genuine new row that would exceed the row cap, evict the lowest-value LIVE entry
  -- for this scope instead of rejecting, then re-read usage so the checks below see the
  -- freed slot. Per-table value: knowledge → knowledge_meta.base_confidence; entities →
  -- sync_rank (ref-count) WITH an incoming-value guard; entity_aliases/entity_relations →
  -- recency. Bounded by the per-scope hourly circuit breaker.
  if tg_op = 'INSERT' and user_tier = 'free'
     and tg_table_name in ('knowledge', 'entities', 'entity_aliases', 'entity_relations')
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
      if tg_table_name = 'knowledge' then
        -- COALESCE(base_confidence, 1.0): a meta-less knowledge row is treated as HIGH
        -- value (protected). (1) matches knowledge_current's COALESCE(confidence, 1.0);
        -- (2) meta-less is the NORMAL transient state during a push (knowledge pushes
        -- before its meta), so 0.0 would evict a just-pushed fresh entry. Orphans are the
        -- reaper's (#909) job.
        select k.id into victim
          from public.knowledge k
          left join public.knowledge_meta m
            on m.scope_id = k.scope_id and m.logical_id = k.id
         where k.scope_id = new.scope_id and k.is_deleted = false
         order by coalesce(m.base_confidence, 1.0) asc, k.updated_at asc, k.id asc
         limit 1;
        if victim is not null then
          -- HARD delete + cascade (keeps knowledge/meta/crdt aligned; frees their slots).
          delete from public.knowledge_meta_crdt
           where scope_id = new.scope_id and logical_id = victim;
          delete from public.knowledge_meta
           where scope_id = new.scope_id and logical_id = victim;
          delete from public.knowledge
           where scope_id = new.scope_id and id = victim;
        end if;
      elsif tg_table_name = 'entities' then
        -- Value = sync_rank (client-maintained ref-count). Incoming-value GUARD: only evict
        -- when the incoming row strictly outranks the current floor. new.sync_rank is
        -- self-contained on the incoming row, so the guard is exact even though the row's
        -- refs aren't synced yet. A 0-ref newcomer that can't beat the floor PAUSES (never
        -- displaces a well-referenced entity) until its rank rises.
        select e.sync_rank into floor_rank
          from public.entities e
         where e.scope_id = new.scope_id and e.is_deleted = false
         order by e.sync_rank asc, e.updated_at asc, e.id asc
         limit 1;
        if floor_rank is not null and new.sync_rank > floor_rank then
          select e.id into victim
            from public.entities e
           where e.scope_id = new.scope_id and e.is_deleted = false
           order by e.sync_rank asc, e.updated_at asc, e.id asc
           limit 1;
          if victim is not null then
            -- Cascade the victim's graph edges — meaningless without the entity, and it
            -- frees those tables' slots. maintain_usage AFTER DELETE decrements each.
            delete from public.entity_aliases
             where scope_id = new.scope_id and entity_id = victim;
            delete from public.knowledge_entity_refs
             where scope_id = new.scope_id and entity_id = victim;
            delete from public.entity_relations
             where scope_id = new.scope_id
               and (entity_a = victim or entity_b = victim);
            delete from public.entities
             where scope_id = new.scope_id and id = victim;
          end if;
        end if;
      else
        -- entity_aliases / entity_relations: evict the OLDEST (recency). Leaf tables → no
        -- cascade. BEFORE INSERT ⇒ the incoming row isn't in the table yet, so it's never
        -- its own victim and always survives (timing invariant, not a value one) — no guard.
        execute format(
          'select id from public.%I
             where scope_id = $1 and is_deleted = false
             order by updated_at asc, id asc
             limit 1', tg_table_name)
          into victim using new.scope_id;
        if victim is not null then
          execute format(
            'delete from public.%I where scope_id = $1 and id = $2', tg_table_name)
            using new.scope_id, victim;
        end if;
      end if;

      if victim is not null then
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
    -- breaker tripped, guard failed, or nothing to evict → fall through to the raise (pause).
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
