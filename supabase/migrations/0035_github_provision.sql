-- 0035_github_provision.sql — E-5-a: GitHub Teams provisioning (#827)
-- Auto-provision a user into Lore orgs/scopes that mirror their GitHub org/team memberships.
--
-- SECURITY: the membership data is VERIFIED server-side — an Edge Function (E-5-a-2) calls the
-- GitHub API with the user's OWN provider_token, which is unforgeable for that user's own
-- memberships — then passes the verified result here. This RPC is SERVICE-ROLE-ONLY: a client can
-- NEVER call it to assert (forge) memberships (execute is revoked from authenticated/anon). That
-- boundary is what makes self-serve provisioning safe (a forged scope_members row would leak the
-- roster and could escalate to a DEK wrap).

-- ===========================================================================
-- 1. GitHub-identity mapping columns. Keyed by GitHub's NUMERIC ids (stable across renames) so
--    provisioning is idempotent-by-identity. NULL on personal orgs and manually-created teams;
--    the partial unique indexes only constrain GitHub-linked rows.
-- ===========================================================================
alter table public.orgs   add column if not exists github_org_id    bigint;
alter table public.orgs   add column if not exists github_login      text;
alter table public.scopes add column if not exists github_team_id    bigint;
alter table public.scopes add column if not exists github_team_slug  text;
create unique index if not exists idx_orgs_github_org
  on public.orgs(github_org_id) where github_org_id is not null;
create unique index if not exists idx_scopes_github_team
  on public.scopes(github_team_id) where github_team_id is not null;

-- ===========================================================================
-- 2. provision_github_membership: additive + idempotent + NEVER-demote.
--    Creates the Lore org/scope keyed by GitHub id on first sight, then adds the user with the
--    mapped role via ON CONFLICT DO NOTHING — so a re-sync NEVER changes an existing role. That
--    upholds the union-not-demote invariant: a member added via invite/domain/manual grant is
--    never downgraded, and a manual role change is never overridden. (Intra-user role UPGRADES on
--    re-sync — e.g. a member later promoted to GitHub owner — are a deliberate follow-up; v1 is
--    strictly additive.)
--
--    Role map (conservative, never over-grant): GitHub org owner/admin ⇒ org 'manager'; GitHub team
--    maintainer ⇒ scope 'admin'; plain member ⇒ org 'member' / scope 'editor'. The Edge Function
--    does the mapping; the CHECK constraints on org_members.role/scope_members.role are the backstop.
--
--    p_orgs:  jsonb array of {github_org_id:int, login:text, role:'manager'|'member'}
--    p_teams: jsonb array of {github_team_id:int, github_org_id:int, slug:text, name:text,
--                             role:'admin'|'editor'}
-- ===========================================================================
create or replace function public.provision_github_membership(
  p_user uuid, p_orgs jsonb, p_teams jsonb)
returns void language plpgsql security definer set search_path = pg_catalog, public
as $$
declare
  rec     jsonb;
  v_org   uuid;
  v_scope uuid;
  v_gid   bigint;
begin
  if p_user is null then
    raise exception 'p_user required' using errcode = '22004';
  end if;

  -- Orgs first: a team's org must exist before the team's scope can reference it.
  for rec in select value from jsonb_array_elements(coalesce(p_orgs, '[]'::jsonb)) as t(value) loop
    v_gid := (rec->>'github_org_id')::bigint;
    select id into v_org from public.orgs where github_org_id = v_gid;
    if v_org is null then
      insert into public.orgs (kind, owner_user_id, name, github_org_id, github_login)
        values ('team', p_user, rec->>'login', v_gid, rec->>'login')
        on conflict (github_org_id) where github_org_id is not null do nothing
        returning id into v_org;
      if v_org is null then  -- lost a concurrent race; re-read the winner's row
        select id into v_org from public.orgs where github_org_id = v_gid;
      end if;
    end if;
    insert into public.org_members (org_id, user_id, role)
      values (v_org, p_user, coalesce(rec->>'role', 'member'))
      on conflict (org_id, user_id) do nothing;
  end loop;

  -- Teams: create the scope keyed by GitHub team id, add org + scope membership.
  for rec in select value from jsonb_array_elements(coalesce(p_teams, '[]'::jsonb)) as t(value) loop
    v_gid := (rec->>'github_org_id')::bigint;
    select id into v_org from public.orgs where github_org_id = v_gid;
    if v_org is null then
      continue;  -- team's org was not provisioned (not in p_orgs) — skip defensively
    end if;
    select id into v_scope from public.scopes
      where github_team_id = (rec->>'github_team_id')::bigint;
    if v_scope is null then
      insert into public.scopes (org_id, kind, name, github_team_id, github_team_slug)
        values (v_org, 'team', rec->>'name', (rec->>'github_team_id')::bigint, rec->>'slug')
        on conflict (github_team_id) where github_team_id is not null do nothing
        returning id into v_scope;
      if v_scope is null then  -- lost a concurrent race
        select id into v_scope from public.scopes
          where github_team_id = (rec->>'github_team_id')::bigint;
      end if;
    end if;
    -- Org membership (so a scope member can see the org), then the scope role. Additive only.
    insert into public.org_members (org_id, user_id, role) values (v_org, p_user, 'member')
      on conflict (org_id, user_id) do nothing;
    insert into public.scope_members (scope_id, user_id, role)
      values (v_scope, p_user, coalesce(rec->>'role', 'editor'))
      on conflict (scope_id, user_id) do nothing;
  end loop;
end $$;

-- SERVICE-ROLE-ONLY: only the Edge Function (which verifies memberships against GitHub) may call
-- this. A client calling it directly would be asserting unverified (forgeable) memberships.
revoke all on function public.provision_github_membership(uuid, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.provision_github_membership(uuid, jsonb, jsonb) to service_role;
