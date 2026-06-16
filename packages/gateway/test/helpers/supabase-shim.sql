-- Minimal Supabase-compatible shim so supabase/migrations/0001..0006 can be
-- applied and exercised against a PLAIN Postgres (no GoTrue / PostgREST stack).
-- Replicates ONLY what the migrations depend on:
--   auth schema + auth.users, auth.uid(), auth.role(), and the three roles.
-- RLS is exercised by `set local role authenticated; set local request.jwt.claims`
-- exactly as PostgREST does after validating a JWT.

create schema if not exists auth;

-- The subset of auth.users the migrations reference (FK target + handle_new_user).
create table if not exists auth.users (
  id                 uuid primary key default gen_random_uuid(),
  email              text,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now()
);

-- auth.uid()/auth.role() read the request JWT claims GUC, exactly like Supabase.
create or replace function auth.uid()
returns uuid
language sql stable
as $$
  select nullif(
    current_setting('request.jwt.claims', true)::json ->> 'sub', ''
  )::uuid
$$;

create or replace function auth.role()
returns text
language sql stable
as $$
  select current_setting('request.jwt.claims', true)::json ->> 'role'
$$;

-- The PostgREST role family. NOLOGIN; the connecting superuser SETs ROLE into
-- them per transaction. None may bypass RLS (so RLS is genuinely enforced).
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    -- Matches Supabase: service_role BYPASSES RLS (trusted server-side role).
    -- anon/authenticated do NOT, so their RLS is genuinely enforced in tests.
    create role service_role nologin noinherit bypassrls;
  end if;
end $$;

-- Let the connecting role assume the PostgREST roles (for SET ROLE in tests).
grant anon, authenticated, service_role to current_user;

-- `authenticator`: the login role PostgREST connects as; it SET ROLEs into
-- anon/authenticated/service_role based on the verified JWT's `role` claim.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then
    create role authenticator login password 'authenticator' noinherit;
  end if;
end $$;
grant anon, authenticated, service_role to authenticator;

-- PostgREST grants usage on schemas to these roles; mirror it.
grant usage on schema public to anon, authenticated, service_role;
grant usage on schema auth to anon, authenticated, service_role;
