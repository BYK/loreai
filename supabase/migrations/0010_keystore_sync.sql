-- Migration 0010 — remote mirror for the client-side encryption key store (C-3, #825).
--
-- Local half (packages/core, C-2 #1167) created account_identity (LOCAL-ONLY, never
-- synced — it holds the plaintext account secret) plus account_escrow + scope_keys.
-- This migration adds the Postgres mirror for the two SYNCABLE tables so a fresh
-- device can recover the account key (escrow) and its per-scope DEKs across devices.
-- Everything stored here is CIPHERTEXT (+ KDF params) — the server never sees a
-- plaintext key or passphrase.
--
-- Two tables, mirroring the client contract (packages/core/src/sync-data.ts):
--   account_escrow  — single row per user (keyed (scope_id, id), id=1): the account
--                     secret wrapped by a passphrase KEK (+ optional recovery code,
--                     with its OWN kdf params). VERSIONED (hash-LWW: latest set wins).
--   scope_keys      — per-scope DEK wrapped (HPKE) to a member's account key, keyed
--                     (scope_id, member_user_id). v1 personal: member_user_id ==
--                     scope_id == the user. VERSIONED.
--
-- BLOB columns (wrapped_secret, kdf_salt, recovery_wrapped, recovery_salt, wrapped_dek)
-- are stored as `text` (base64) — the client base64-encodes them over the PostgREST
-- JSON wire (toRemoteRow) and decodes on apply (decodeBlobColumns / applyRemoteScopeKey).
--
-- Scope seam (0007): every row is owned/billed/isolated by scope_id and authored by
-- author_id, both defaulted to auth.uid() (v1: scope = author = user). Clients NEVER
-- send scope_id/author_id; RLS WITH CHECK pins both to the writer.

-- ===========================================================================
-- 1. Tables.
-- ===========================================================================
create table if not exists public.account_escrow (
  scope_id         uuid    not null default auth.uid() references auth.users (id) on delete cascade,
  author_id        uuid    not null default auth.uid(),
  id               integer not null,
  wrapped_secret   text    not null,
  kdf_salt         text    not null,
  kdf_t            integer not null,
  kdf_m            integer not null,
  kdf_p            integer not null,
  recovery_wrapped text,
  recovery_salt    text,
  recovery_kdf_t   integer,
  recovery_kdf_m   integer,
  recovery_kdf_p   integer,
  key_epoch        integer not null default 0,
  content_hash     text,
  revision         integer not null default 0,
  is_deleted       boolean not null default false,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  primary key (scope_id, id)
);

create table if not exists public.scope_keys (
  scope_id       uuid    not null default auth.uid() references auth.users (id) on delete cascade,
  author_id      uuid    not null default auth.uid(),
  member_user_id text    not null,
  wrapped_dek    text    not null,
  key_epoch      integer not null default 0,
  content_hash   text,
  revision       integer not null default 0,
  is_deleted     boolean not null default false,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  primary key (scope_id, member_user_id)
);

-- ===========================================================================
-- 2. Size + numeric CHECK constraints (drop-then-add = idempotent). These bound a
--    malicious direct-PostgREST client that bypasses our gateway. The base64 blobs
--    are small (a 32-byte key wraps to well under 1 KB); caps are generous but finite.
-- ===========================================================================
alter table public.account_escrow drop constraint if exists account_escrow_size_ck;
alter table public.account_escrow add constraint account_escrow_size_ck check (
  id = 1
  and length(wrapped_secret) <= 4096
  and length(kdf_salt) <= 256
  and (recovery_wrapped is null or length(recovery_wrapped) <= 4096)
  and (recovery_salt is null or length(recovery_salt) <= 256)
  and (content_hash is null or length(content_hash) <= 64)
  and kdf_t between 1 and 16 and kdf_m between 8 and 4194304 and kdf_p between 1 and 16
  -- recovery_* params share the same sane bounds (nullable when no recovery code).
  and (recovery_kdf_t is null or recovery_kdf_t between 1 and 16)
  and (recovery_kdf_m is null or recovery_kdf_m between 8 and 4194304)
  and (recovery_kdf_p is null or recovery_kdf_p between 1 and 16)
);

alter table public.scope_keys drop constraint if exists scope_keys_size_ck;
alter table public.scope_keys add constraint scope_keys_size_ck check (
  length(member_user_id) <= 64
  and length(wrapped_dek) <= 4096
  and (content_hash is null or length(content_hash) <= 64)
);

-- ===========================================================================
-- 3. updated_at trigger, pull-cursor index, RLS (one scope_all policy per table).
--    v1 RLS gates by scope_id (== member_user_id == user). Teams (E) will relax
--    scope_keys to member-read / owner-write — deferred (documented in C-2/C-3).
-- ===========================================================================
do $$
declare t text;
begin
  foreach t in array array['account_escrow', 'scope_keys']
  loop
    execute format('drop trigger if exists %1$s_set_updated_at on public.%1$s', t);
    execute format(
      'create trigger %1$s_set_updated_at before update on public.%1$s
         for each row execute function public.sync_set_updated_at()', t);

    execute format(
      'create index if not exists idx_%1$s_scope_updated
         on public.%1$s (scope_id, updated_at)', t);

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
  on public.account_escrow, public.scope_keys
  to authenticated;

-- ===========================================================================
-- 5. plan_limits: row + byte caps (free + pro). account_escrow is one row per user;
--    scope_keys is one row per (scope, member) — headroom for team members later.
-- ===========================================================================
insert into public.plan_limits (tier, table_name, max_rows, max_bytes) values
  ('free', 'account_escrow',    2,      65536),   -- 64 KB
  ('free', 'scope_keys',      100,     262144),   -- 256 KB
  ('pro',  'account_escrow',    2,      65536),
  ('pro',  'scope_keys',    10000,   16777216)     -- 16 MB
on conflict (tier, table_name) do update
  set max_rows = excluded.max_rows, max_bytes = excluded.max_bytes;

-- ===========================================================================
-- 6. enforce_row_quota: extend with existence-probe branches for the two new key
--    shapes. account_escrow is (scope_id, id::int)-keyed; scope_keys is (scope_id,
--    member_user_id)-keyed. Everything else (scope-immutability guard, oracle-close
--    early return, advisory xact lock, physical-footprint counting, caps) is
--    preserved verbatim from 0009.
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
-- 7. Attach triggers: quota guard BEFORE, usage maintainer AFTER (both from 0007
--    are generic over scope_id + to_jsonb).
-- ===========================================================================
do $$
declare t text;
begin
  foreach t in array array['account_escrow', 'scope_keys']
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
-- 8. Backfill the usage counter from existing rows (none on first apply; kept for
--    idempotent re-apply). Writes user_table_usage directly, so the triggers above
--    do not fire → no double-count.
-- ===========================================================================
do $$
declare t text;
begin
  foreach t in array array['account_escrow', 'scope_keys']
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
