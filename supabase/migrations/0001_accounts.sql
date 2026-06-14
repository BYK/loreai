-- Milestone 1 — Folk Lore individual accounts.
--
-- This migration defines the per-user account record (`public.profiles`) that
-- every individual gets on first sign-in. It is the identity foundation for the
-- multi-DB sync architecture (see https://github.com/BYK/loreai/issues/467).
--
-- Security model: a single shared multi-tenant Postgres isolated by Row-Level
-- Security. A user only ever sees their own row (`id = auth.uid()`). The sync
-- tables (knowledge / entities / …) land in a later migration; this one is
-- accounts-only.
--
-- Apply with: `supabase db push` (see supabase/README.md).

-- ---------------------------------------------------------------------------
-- profiles: one row per auth user, created automatically on sign-up.
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  github_login text,
  display_name text,
  email        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

comment on table public.profiles is
  'Folk Lore individual account record; one row per auth.users, RLS-scoped to the owner.';

-- ---------------------------------------------------------------------------
-- Row-Level Security: a user can only read/update their OWN profile.
-- (Inserts happen via the SECURITY DEFINER trigger below, not by clients.)
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;

drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own"
  on public.profiles
  for select
  using (id = auth.uid());

drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own"
  on public.profiles
  for update
  using (id = auth.uid())
  with check (id = auth.uid());

-- ---------------------------------------------------------------------------
-- Keep updated_at fresh on every update.
-- ---------------------------------------------------------------------------
create or replace function public.set_profiles_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
  before update on public.profiles
  for each row
  execute function public.set_profiles_updated_at();

-- ---------------------------------------------------------------------------
-- Auto-provision a profile row when a new auth user is created. Runs as
-- SECURITY DEFINER so it can insert past RLS during the signup transaction.
-- github_login / display_name are pulled from the OAuth identity metadata when
-- present (GitHub provides `user_name` / `name`); null for email sign-ins.
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, github_login, display_name, email)
  values (
    new.id,
    coalesce(
      new.raw_user_meta_data ->> 'user_name',
      new.raw_user_meta_data ->> 'preferred_username'
    ),
    coalesce(
      new.raw_user_meta_data ->> 'name',
      new.raw_user_meta_data ->> 'full_name'
    ),
    new.email
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row
  execute function public.handle_new_user();
