-- Migration 0019: reaper safe-reap watermark (#909 purge epoch, correct form)
--
-- The literal purge-epoch (a stale client re-pulls + reconciles deletions BY ABSENCE)
-- conflicts with the eviction model: the remote is a bounded cache, so a row absent from
-- it is ambiguous — evicted-but-valid vs deleted-and-reaped — and reconcile-by-absence
-- would wrongly drop valid local data (forbidden: "reconcile never treats remote-absence
-- as a delete"). Instead the SERVER holds off reaping until EVERY active device in the
-- scope has pulled past a tombstone. Then no active device can miss a deletion and no
-- client reconcile is ever needed. The cutoff is LEAST(watermark, now()-retention): the
-- watermark never lets us outrun a slow ACTIVE device, and the retention floor is kept as
-- a safety net so a device that isn't reporting yet (mid-rollout) keeps the same
-- protection as the old fixed window. So this is at-least-as-safe as the fixed window and
-- additionally protects an active-but-slow device BEYOND the window. Residual bound: a
-- device abandoned past the active-TTL may miss a deletion reaped in its absence — equal
-- to the old fixed window.

-- ===========================================================================
-- 1. sync_device_progress — each device's per-table pull cursor. Control-plane: NOT a
--    synced data table; the client writes it directly, out-of-band. `pulled_through` is
--    the device's keyset cursor timestamp; `last_seen` is server-stamped (see the
--    trigger) so a client can't fake activity to stall reaping. scope_id defaults to
--    auth.uid() (the v1 scope).
-- ===========================================================================
create table if not exists public.sync_device_progress (
  scope_id       uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  device_id      text        not null,
  table_name     text        not null,
  pulled_through timestamptz not null,
  last_seen      timestamptz not null default now(),
  primary key (scope_id, device_id, table_name)
);

alter table public.sync_device_progress drop constraint if exists sync_device_progress_size_ck;
alter table public.sync_device_progress add constraint sync_device_progress_size_ck check (
  length(device_id) <= 64 and length(table_name) <= 64
);

-- ===========================================================================
-- 2. Server-stamp last_seen on every write — activity is server-observed, never client-
--    claimed. `pulled_through` stays client-set: over/under-claiming only self-harms
--    (a premature self-miss / a self-DoS on the scope's own quota), never another tenant.
-- ===========================================================================
create or replace function public.sync_device_progress_touch()
returns trigger language plpgsql as $$
begin
  new.last_seen = now();
  return new;
end;
$$;

drop trigger if exists sync_device_progress_touch on public.sync_device_progress;
create trigger sync_device_progress_touch
  before insert or update on public.sync_device_progress
  for each row execute function public.sync_device_progress_touch();

-- ===========================================================================
-- 3. Anti-abuse: cap rows-per-scope so a client can't fabricate unbounded device ids
--    (generous headroom across a device's reported tables). RLS already restricts writes
--    to the caller's own scope, so this only bounds self-inflicted growth.
-- ===========================================================================
create or replace function public.sync_device_progress_cap()
returns trigger language plpgsql as $$
begin
  -- Only a genuinely NEW (scope, device, table) row counts against the cap. BEFORE INSERT
  -- also fires for an `insert ... on conflict do update` that resolves to an UPDATE, so
  -- without the existence guard a re-report (a mere last_seen/pulled_through refresh of an
  -- existing row) would wrongly trip the cap once a scope is full.
  if not exists (
    select 1 from public.sync_device_progress
     where scope_id = new.scope_id
       and device_id = new.device_id
       and table_name = new.table_name
  ) and (
    select count(*) from public.sync_device_progress where scope_id = new.scope_id
  ) >= 700 then
    raise exception 'sync_device_progress: too many devices for scope'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists sync_device_progress_cap on public.sync_device_progress;
create trigger sync_device_progress_cap
  before insert on public.sync_device_progress
  for each row execute function public.sync_device_progress_cap();

-- Index for the reaper's per-scope correlated min(pulled_through).
create index if not exists idx_sync_device_progress_reap
  on public.sync_device_progress (table_name, scope_id, last_seen);

-- ===========================================================================
-- 4. RLS + DML grants (per-row ownership by scope; PostgREST needs the grants).
-- ===========================================================================
alter table public.sync_device_progress enable row level security;
drop policy if exists sync_device_progress_scope_all on public.sync_device_progress;
create policy sync_device_progress_scope_all on public.sync_device_progress
  for all
  using (scope_id = auth.uid())
  with check (scope_id = auth.uid());

grant select, insert, update, delete on public.sync_device_progress to authenticated;

-- ===========================================================================
-- 5. Reaper: reap a tombstone only when it is older than LEAST(watermark, retention floor).
--    watermark = min(pulled_through) across the scope's ACTIVE devices (last_seen within
--    active_ttl) — never outrun a slow active device. The retention floor (now()-retention)
--    is kept via LEAST so a device that isn't reporting yet (mid-rollout) or a dormant
--    scope with no active device stays protected (LEAST ignores the NULL watermark → the
--    floor). `updated_at < cutoff` (strict) ⇒ every active device's keyset cursor already
--    passed the tombstone ⇒ each applied the deletion ⇒ safe to reap.
--    Drop-first avoids overload ambiguity with 0018's 1-arg version; the pg_cron call
--    `reap_tombstones(90)` re-binds (the 2nd arg is defaulted).
-- ===========================================================================
drop function if exists public.reap_tombstones(integer);

create or replace function public.reap_tombstones(
  retention_days  integer default 90,
  active_ttl_days integer default 90
)
returns bigint
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  t            text;
  total        bigint := 0;
  n            bigint;
  floor_ts     timestamptz := now() - make_interval(days => greatest(retention_days, 0));
  active_since timestamptz := now() - make_interval(days => greatest(active_ttl_days, 0));
begin
  -- The knowledge + entity-graph tables (0002 base + 0009 meta) each carry is_deleted +
  -- updated_at. Keystore tables (account_escrow / scope_keys, 0010) are single-row-per-
  -- scope and intentionally excluded (no tombstone accrual; key state).
  foreach t in array array[
    'knowledge', 'entities', 'entity_aliases', 'entity_relations',
    'knowledge_entity_refs', 'knowledge_meta', 'knowledge_meta_crdt'
  ] loop
    -- LEAST ignores a NULL watermark (no active device) → falls back to the floor.
    execute format($q$
      delete from public.%1$I k
       where k.is_deleted = true
         and k.updated_at < least(
           (select min(p.pulled_through)
              from public.sync_device_progress p
             where p.scope_id = k.scope_id
               and p.table_name = %1$L
               and p.last_seen > $1),
           $2
         )
    $q$, t) using active_since, floor_ts;
    get diagnostics n = row_count;
    total := total + n;
  end loop;

  -- Drop progress rows for long-abandoned devices (2× the active window) so the control
  -- table doesn't accrue dead device rows forever.
  delete from public.sync_device_progress
   where last_seen < now() - make_interval(days => greatest(active_ttl_days, 0) * 2);

  return total;
end;
$$;

-- System task only (SECURITY DEFINER bypasses RLS to reap cross-scope); pg_cron runs as
-- the owner, a service_role admin may invoke it manually.
revoke all on function public.reap_tombstones(integer, integer) from public;
grant execute on function public.reap_tombstones(integer, integer) to service_role;
