-- Migration 0031 — count scope_keys per epoch in the quota probe (E-4c-3b, #827).
--
-- Key rotation (E-4c-3) writes a NEW scope_keys row per epoch (PK now includes key_epoch, 0030).
-- The 0028 enforce_row_quota INSERT probe keyed only on (scope_id, member_user_id), so a
-- rotation's epoch-(N+1) row for an EXISTING member matched the member's epoch-0 row → exists_pk
-- true → the new row was NOT counted, letting rotations accrue uncounted rows past the cap. This
-- reproduces 0028's function VERBATIM except the scope_keys probe, which now also matches
-- key_epoch so each epoch row is counted. (No new-epoch row existed before 3b, so this was
-- unreachable until now — deferred from 0030 as documented.)

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
  -- WITH CHECK regardless, so skipping quota here changes NO legitimate outcome. E-4b:
  -- keyed on membership (not self) so a team member's write to a shared scope is metered.
  if auth.uid() is not null and not public.is_member(new.scope_id) then
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
           and member_user_id = to_jsonb(new)->>'member_user_id'
           and key_epoch       = (to_jsonb(new)->>'key_epoch')::int)
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

  user_tier := public.effective_tier(new.scope_id);
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
            -- entity_aliases / knowledge_entity_refs belong to the single evicted entity —
            -- meaningless without it, so cascade unconditionally (frees their slots).
            delete from public.entity_aliases
             where scope_id = new.scope_id and entity_id = victim;
            delete from public.knowledge_entity_refs
             where scope_id = new.scope_id and entity_id = victim;
            -- entity_relations connect TWO entities: delete a relation touching the victim
            -- ONLY when its OTHER endpoint is also gone (not a live synced entity). A relation
            -- to a surviving entity is that entity's edge — keep it (deleting it would be
            -- permanent: the client marks it synced and never re-pushes). FIX 2 (#1191b).
            delete from public.entity_relations r
             where r.scope_id = new.scope_id
               and (r.entity_a = victim or r.entity_b = victim)
               and not exists (
                 select 1 from public.entities e
                  where e.scope_id = new.scope_id
                    and e.is_deleted = false
                    and e.id <> victim  -- victim is still live here; a self-relation's
                                        -- "other endpoint" IS the victim → treat as gone
                    and e.id = case when r.entity_a = victim
                                    then r.entity_b else r.entity_a end);
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
