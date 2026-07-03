-- Migration 0009 — remote mirror for the convergent confidence register (A2 3b-2, #823).
--
-- Local half (PR #941) already made these two tables synced on the client
-- (packages/core/src/sync-data.ts SYNCED_TABLES.basic). This migration adds the
-- Postgres mirror so basic-tier `confidence` finally CONVERGES across devices
-- instead of last-writer-wins. Until it lands remotely the client's pushes for
-- these two tables 404 and stall only their own per-table cursor (by design).
--
-- Two tables, mirroring the client contract:
--   knowledge_meta       — the per-entry metric register. VERSIONED (hash-LWW):
--                          carries content_hash/revision. Only the IMMUTABLE
--                          base_confidence syncs (the materialized `confidence`
--                          and the local decay clock are client-local, not synced).
--                          Keyed by the stable logical_id.
--   knowledge_meta_crdt  — the PN-counter state: grow-only (pos, neg) per
--                          (logical_id, replica_id). versioned:false (no
--                          content_hash/revision). SINGLE-OWNER: a device only
--                          ever pushes its OWN replica's row, monotonically, so the
--                          remote upsert is a plain OVERWRITE; the convergent
--                          per-key MAX merge is a PULL-side (client) operation and
--                          is NOT a remote concern.
--
-- Scope seam (0007): every row is owned/billed/isolated by scope_id and authored
-- by author_id, both defaulted to auth.uid() (v1: scope = author = user). Clients
-- NEVER send them; RLS WITH CHECK pins both to the writer.
--
-- (0008 is intentionally absent: it was reserved for a remote knowledge re-key on
-- logical_id, which sub-PR 3 (#897/#913) instead achieved entirely client-side —
-- the remote `knowledge.id` already held logical_ids from the pre-flip v1 pushes —
-- so no server migration was needed. This is the next migration after 0007.)

-- ===========================================================================
-- 1. Tables.
-- ===========================================================================
create table if not exists public.knowledge_meta (
  scope_id        uuid   not null default auth.uid() references auth.users (id) on delete cascade,
  author_id       uuid   not null default auth.uid(),
  logical_id      text   not null,
  base_confidence double precision not null default 1.0,
  content_hash    text,
  revision        integer not null default 0,
  is_deleted      boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  primary key (scope_id, logical_id)
);

create table if not exists public.knowledge_meta_crdt (
  scope_id    uuid   not null default auth.uid() references auth.users (id) on delete cascade,
  author_id   uuid   not null default auth.uid(),
  logical_id  text   not null,
  replica_id  text   not null,
  pos         double precision not null default 0,
  neg         double precision not null default 0,
  is_deleted  boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (scope_id, logical_id, replica_id)
);

-- ===========================================================================
-- 2. Size + numeric CHECK constraints (drop-then-add = idempotent). These bound
--    a malicious direct-PostgREST client that bypasses our gateway entirely.
-- ===========================================================================
-- base_confidence in [0,1]: it is the immutable create-time value, clamped [0,1]
-- locally. The bounds also reject a poisoned 'NaN'/'Infinity': in Postgres NaN
-- sorts as greater than every number, so `base_confidence <= 1` is false for NaN
-- (and for Infinity) → the CHECK fails, so a poisoned base can never corrupt the
-- summed materialization on a peer.
alter table public.knowledge_meta drop constraint if exists knowledge_meta_size_ck;
alter table public.knowledge_meta add constraint knowledge_meta_size_ck check (
  length(logical_id) <= 64
  and (content_hash is null or length(content_hash) <= 64)
  and base_confidence >= 0 and base_confidence <= 1
);

-- pos/neg are grow-only non-negative counters whose realistic magnitude is « 1
-- (each recorded delta is a small confidence step). A generous finite cap rejects
-- negatives, 'NaN' and 'Infinity' — any of which would poison the CRDT sum on a peer.
alter table public.knowledge_meta_crdt drop constraint if exists knowledge_meta_crdt_size_ck;
alter table public.knowledge_meta_crdt add constraint knowledge_meta_crdt_size_ck check (
  length(logical_id) <= 64
  and length(replica_id) <= 64
  and pos >= 0 and pos <= 1000000
  and neg >= 0 and neg <= 1000000
);

-- ===========================================================================
-- 3. updated_at trigger, pull-cursor index, RLS (one scope_all policy per table).
--    Mirrors 0002 + the scope-seam RLS shape from 0007.
-- ===========================================================================
do $$
declare t text;
begin
  foreach t in array array['knowledge_meta', 'knowledge_meta_crdt']
  loop
    -- server-stamped updated_at (the pull cursor). BEFORE UPDATE only: an INSERT
    -- keeps the client-sent updated_at (knowledge_meta) or the now() default (crdt).
    execute format('drop trigger if exists %1$s_set_updated_at on public.%1$s', t);
    execute format(
      'create trigger %1$s_set_updated_at before update on public.%1$s
         for each row execute function public.sync_set_updated_at()', t);

    -- incremental pull: "my rows changed since cursor", keyed on scope_id.
    execute format(
      'create index if not exists idx_%1$s_scope_updated
         on public.%1$s (scope_id, updated_at)', t);

    -- RLS: visibility gated by scope; WITH CHECK additionally pins author_id to the
    -- writer so a client cannot forge authorship (v1 invariant author_id = auth.uid()).
    execute format('alter table public.%1$s enable row level security', t);
    execute format('drop policy if exists %1$s_scope_all on public.%1$s', t);
    execute format(
      'create policy %1$s_scope_all on public.%1$s
         for all
         using (scope_id = auth.uid())
         with check (scope_id = auth.uid() and author_id = auth.uid())', t);
  end loop;
end $$;

-- ===========================================================================
-- 4. DML grants so PostgREST works (RLS still enforces per-row ownership).
-- ===========================================================================
grant select, insert, update, delete
  on public.knowledge_meta, public.knowledge_meta_crdt
  to authenticated;

-- ===========================================================================
-- 5. plan_limits: row + byte caps for both tables (free + pro).
--    knowledge_meta is 1 row per logical entry ⇒ bounded by knowledge's own cap.
--    knowledge_meta_crdt is 1 row per (logical_id, replica_id) ⇒ headroom for ~10
--    devices at the entry cap. Byte caps are generous (rows are tiny).
-- ===========================================================================
insert into public.plan_limits (tier, table_name, max_rows, max_bytes) values
  ('free', 'knowledge_meta',        500,      524288),   -- 512 KB
  ('free', 'knowledge_meta_crdt',   5000,    1048576),   -- 1 MB
  ('pro',  'knowledge_meta',       50000,    8388608),   -- 8 MB
  ('pro',  'knowledge_meta_crdt', 500000,   16777216)    -- 16 MB
on conflict (tier, table_name) do update
  set max_rows = excluded.max_rows, max_bytes = excluded.max_bytes;

-- ===========================================================================
-- 6. enforce_row_quota: extend the 0007 function with existence-probe branches
--    for the two new key shapes. 0007's generic probe assumes an `id` column and
--    would raise 42703 on knowledge_meta (keyed by logical_id) and
--    knowledge_meta_crdt (keyed by logical_id + replica_id). Everything else
--    (scope-immutability guard, advisory xact lock TOCTOU, PHYSICAL-footprint
--    counting, row + byte caps) is preserved verbatim from 0007.
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
  -- v1 invariant: scope_id is immutable (a row never changes owner). Loud backstop
  -- in addition to the RLS WITH CHECK. Teams (E) lift this AND update maintain_usage.
  if tg_op = 'UPDATE' and old.scope_id is distinct from new.scope_id then
    raise exception 'scope_id is immutable'
      using errcode = 'check_violation';
  end if;

  -- Do NOT read the victim's tier/usage for a row this caller cannot own. A BEFORE
  -- trigger fires BEFORE the RLS WITH CHECK, so a forged scope_id (≠ auth.uid())
  -- would otherwise reach the tier/usage read below and leak the victim's exact
  -- row_count/byte_count through the quota exception message — an at-cap existence
  -- oracle (needs only the victim's uuid). Such a row is ALWAYS rejected by the RLS
  -- WITH CHECK regardless, so skipping quota here changes NO legitimate outcome; it
  -- only removes the leak. auth.uid() IS NULL (service_role / migration backfill,
  -- which bypasses RLS) falls through and is quota-checked exactly as before.
  -- Global hardening applied here since 0009 already redefines this shared function.
  if auth.uid() is not null and new.scope_id is distinct from auth.uid() then
    return new;
  end if;

  -- Serialize this scope+table BEFORE the existence probe and counter read so a
  -- concurrent burst can't each observe an under-cap state and all proceed (0005
  -- TOCTOU guarantee). xact-scoped → held through the AFTER maintain_usage.
  perform pg_advisory_xact_lock(
    hashtextextended(new.scope_id::text || '|' || tg_table_name, 0));

  -- Physical-footprint delta (mirrors maintain_usage): INSERT adds a row; UPDATE
  -- keeps the row, may change bytes. No is_deleted special-casing — every physical
  -- row counts, so there is no soft-delete/revival slot to game.
  if tg_op = 'INSERT' then
    -- An upsert (ON CONFLICT DO UPDATE) fires BEFORE INSERT even when it resolves to
    -- an UPDATE. If the PK already exists, defer to the BEFORE UPDATE call so we don't
    -- double-count it as a new physical row. Probe the ACTUAL PK per table (0007's
    -- `id`-keyed probe throws 42703 on these logical_id/replica_id-keyed tables).
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
-- 7. Attach triggers: quota guard BEFORE, usage maintainer AFTER. (maintain_usage
--    and usage_row_bytes from 0007 are already generic over scope_id + to_jsonb.)
-- ===========================================================================
do $$
declare t text;
begin
  foreach t in array array['knowledge_meta', 'knowledge_meta_crdt']
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
-- 8. Backfill the usage counter from any existing rows (none on first apply; kept
--    for parity + idempotent re-apply). Writes user_table_usage directly, so the
--    triggers above do not fire → no double-count.
-- ===========================================================================
do $$
declare t text;
begin
  foreach t in array array['knowledge_meta', 'knowledge_meta_crdt']
  loop
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
