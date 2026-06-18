-- Migration 0002 — Basic-tier logical sync (knowledge + entity graph).
--
-- Remote mirror of the local SQLite synced tables (see packages/core/src/sync-data.ts
-- and the v43 local migration). Each row is owned by exactly one user and isolated
-- by Row-Level Security (owner_user_id = auth.uid()) — a single shared multi-tenant
-- Postgres, NOT a database per user.
--
-- Sync columns carried on every table:
--   owner_user_id  uuid       — owner; RLS boundary. Defaulted to auth.uid() so a
--                               client INSERT need not (and cannot forge) it.
--   content_hash   text       — client-computed semantic hash (sync-data.ts contentHash);
--                               server stores it verbatim (the updated_at trigger does
--                               NOT touch content_hash/revision — they are carried as-is).
--   revision       integer    — client-carried distributed version (fast-forward vs conflict).
--   is_deleted     boolean    — soft delete (tombstone) so peers learn of removals on pull.
--   updated_at     timestamptz— server-stamped on write (the pull cursor).
--   created_at     timestamptz
--
-- knowledge_entity_refs is the composite-key join table (no content_hash/revision).

-- ---------------------------------------------------------------------------
-- Shared helper: stamp updated_at on every write WITHOUT clobbering the
-- client-carried content_hash / revision.
-- ---------------------------------------------------------------------------
create or replace function public.sync_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- knowledge
-- ---------------------------------------------------------------------------
create table if not exists public.knowledge (
  id             text not null,
  owner_user_id  uuid not null default auth.uid() references auth.users (id) on delete cascade,
  project_id     text,
  category       text not null,
  title          text not null,
  content        text not null,
  source_session text,
  cross_project  integer default 0,
  confidence     double precision default 1.0,
  metadata       text,
  created_by     text,
  updated_by     text,
  sensitivity    text,
  promotion_status text,
  content_hash   text,
  revision       integer not null default 0,
  is_deleted     boolean not null default false,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  primary key (owner_user_id, id)
);

-- ---------------------------------------------------------------------------
-- entities
-- ---------------------------------------------------------------------------
create table if not exists public.entities (
  id             text not null,
  owner_user_id  uuid not null default auth.uid() references auth.users (id) on delete cascade,
  project_id     text,
  entity_type    text not null,
  canonical_name text not null,
  metadata       text,
  cross_project  integer default 0,
  content_hash   text,
  revision       integer not null default 0,
  is_deleted     boolean not null default false,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  primary key (owner_user_id, id)
);

-- ---------------------------------------------------------------------------
-- entity_aliases
-- ---------------------------------------------------------------------------
create table if not exists public.entity_aliases (
  id            text not null,
  owner_user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  entity_id     text not null,
  alias_type    text not null,
  alias_value   text not null,
  source        text,
  content_hash  text,
  revision      integer not null default 0,
  is_deleted    boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (owner_user_id, id)
);

-- ---------------------------------------------------------------------------
-- entity_relations
-- ---------------------------------------------------------------------------
create table if not exists public.entity_relations (
  id            text not null,
  owner_user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  entity_a      text not null,
  entity_b      text not null,
  relation      text not null,
  metadata      text,
  source        text,
  content_hash  text,
  revision      integer not null default 0,
  is_deleted    boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (owner_user_id, id)
);

-- ---------------------------------------------------------------------------
-- knowledge_entity_refs (composite join; no content_hash/revision)
-- ---------------------------------------------------------------------------
create table if not exists public.knowledge_entity_refs (
  owner_user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  knowledge_id  text not null,
  entity_id     text not null,
  is_deleted    boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (owner_user_id, knowledge_id, entity_id)
);

-- ---------------------------------------------------------------------------
-- updated_at triggers + pull-cursor indexes + RLS (one policy per table).
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'knowledge', 'entities', 'entity_aliases', 'entity_relations', 'knowledge_entity_refs'
  ]
  loop
    -- server-stamped updated_at (pull cursor)
    execute format(
      'drop trigger if exists %1$s_set_updated_at on public.%1$s', t);
    execute format(
      'create trigger %1$s_set_updated_at before update on public.%1$s
         for each row execute function public.sync_set_updated_at()', t);

    -- incremental pull: "my rows changed since cursor"
    execute format(
      'create index if not exists idx_%1$s_owner_updated
         on public.%1$s (owner_user_id, updated_at)', t);

    -- RLS: a user sees and writes ONLY their own rows. WITH CHECK on the
    -- default-auth.uid() owner column prevents writing rows for another user.
    execute format('alter table public.%1$s enable row level security', t);
    execute format('drop policy if exists %1$s_owner_all on public.%1$s', t);
    execute format(
      'create policy %1$s_owner_all on public.%1$s
         for all
         using (owner_user_id = auth.uid())
         with check (owner_user_id = auth.uid())', t);
  end loop;
end $$;
