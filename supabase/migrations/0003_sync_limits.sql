-- Migration 0003 — anti-abuse limits for Basic-tier sync (direct-PostgREST model).
--
-- Clients write to Supabase's REST API directly (anon key + user JWT), so all
-- limits MUST be enforced server-side in Postgres — a malicious client bypasses
-- our gateway entirely. RLS only enforces OWNERSHIP, not VOLUME or SIZE, so we
-- add two in-DB controls that cannot be bypassed:
--   1. CHECK constraints  — bound per-row payload size.
--   2. BEFORE INSERT trigger — bound per-user LIVE row count, by tier.
-- (Per-request RATE limiting is intentionally NOT here — it belongs at the edge
-- and is deferred until paid tiers; see plan. These bound storage + cardinality
-- + payload, which is what stops "sync my entire history" on the free tier.)

-- ---------------------------------------------------------------------------
-- Tier on profiles (defaults to 'free').
-- ---------------------------------------------------------------------------
alter table public.profiles
  add column if not exists tier text not null default 'free';

-- ---------------------------------------------------------------------------
-- Tunable per-tier row caps (data, not code — change without a deploy).
-- A NULL cap means "unlimited" for that (tier, table).
-- ---------------------------------------------------------------------------
create table if not exists public.plan_limits (
  tier        text not null,
  table_name  text not null,
  max_rows    integer,            -- null = unlimited
  primary key (tier, table_name)
);

-- plan_limits is readable by all authenticated users (so clients can show
-- usage/limits), writable by no one via the API (service-role/SQL only).
alter table public.plan_limits enable row level security;
drop policy if exists plan_limits_read on public.plan_limits;
create policy plan_limits_read on public.plan_limits
  for select using (auth.role() = 'authenticated');

insert into public.plan_limits (tier, table_name, max_rows) values
  -- Free: knowledge + a small entity graph. Hostile to dumping history.
  ('free', 'knowledge',             500),
  ('free', 'entities',               30),
  ('free', 'entity_aliases',        300),   -- ~10x entities
  ('free', 'entity_relations',      300),
  ('free', 'knowledge_entity_refs', 2000),
  -- Paid tiers: generous (tune later). NULL elsewhere = unlimited.
  ('pro',  'knowledge',           50000),
  ('pro',  'entities',             5000),
  ('pro',  'entity_aliases',      50000),
  ('pro',  'entity_relations',    50000),
  ('pro',  'knowledge_entity_refs', 200000)
on conflict (tier, table_name) do update set max_rows = excluded.max_rows;

-- ---------------------------------------------------------------------------
-- Per-user row-count quota: BEFORE INSERT, reject if the user is at/over their
-- tier cap for this table. UPDATEs (incl. soft-delete via is_deleted) are not
-- counted — only growth in live rows. Tombstoned rows still occupy a row; a
-- future reaper can hard-delete old is_deleted=true rows to reclaim the slot.
-- ---------------------------------------------------------------------------
create or replace function public.enforce_row_quota()
returns trigger
language plpgsql
security definer            -- read profiles.tier / plan_limits past RLS
set search_path = public
as $$
declare
  user_tier text;
  cap       integer;
  used      integer;
begin
  select coalesce(tier, 'free') into user_tier
    from public.profiles where id = new.owner_user_id;
  if user_tier is null then user_tier := 'free'; end if;

  select max_rows into cap
    from public.plan_limits
   where tier = user_tier and table_name = tg_table_name;

  if cap is null then
    return new;  -- no limit configured for this (tier, table) → unlimited
  end if;

  execute format(
    'select count(*) from public.%I where owner_user_id = $1', tg_table_name)
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

-- ---------------------------------------------------------------------------
-- Payload-size CHECK constraints + attach the quota trigger to each table.
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'knowledge', 'entities', 'entity_aliases', 'entity_relations', 'knowledge_entity_refs'
  ]
  loop
    execute format(
      'drop trigger if exists %1$s_row_quota on public.%1$s', t);
    execute format(
      'create trigger %1$s_row_quota before insert on public.%1$s
         for each row execute function public.enforce_row_quota()', t);
  end loop;
end $$;

-- Per-field size caps (idempotent: drop-then-add). Mirrors the local intent
-- (e.g. ltm.content is ~1200 chars locally) but enforced where it can't be
-- bypassed. Generous enough for real entries, hostile to blobs.
alter table public.knowledge drop constraint if exists knowledge_size_ck;
alter table public.knowledge add constraint knowledge_size_ck check (
  length(title) <= 512 and length(content) <= 8192
  and (metadata is null or length(metadata) <= 8192)
);

alter table public.entities drop constraint if exists entities_size_ck;
alter table public.entities add constraint entities_size_ck check (
  length(canonical_name) <= 512
  and (metadata is null or length(metadata) <= 8192)
);

alter table public.entity_aliases drop constraint if exists entity_aliases_size_ck;
alter table public.entity_aliases add constraint entity_aliases_size_ck check (
  length(alias_value) <= 512 and length(alias_type) <= 64
);

alter table public.entity_relations drop constraint if exists entity_relations_size_ck;
alter table public.entity_relations add constraint entity_relations_size_ck check (
  length(relation) <= 128
  and (metadata is null or length(metadata) <= 8192)
);
