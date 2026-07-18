-- Migration 0048 — GitHub provisioning follow-ups (#1314 parts 2-4, E-5-a).
--
-- Reworks provision_github_membership (0035) with two behavioral fixes; the concurrent-race
-- re-read branches are unchanged (now covered by a regression test):
--
--   Part 2 — role UPGRADE-on-resync (still NEVER demote). 0035 used ON CONFLICT DO NOTHING, so a
--     member later promoted on GitHub (plain member → org owner/admin, or team editor → maintainer)
--     stayed at their first-seen role forever — a team could remain permanently admin-less. Now a
--     re-sync RATCHETS the role UP the GitHub-mappable ladder, and never down:
--       org:   member(1) < manager(2)      scope: viewer(1) < editor(2) < admin(3)
--     The manual-only, non-GitHub org roles `owner` and `billing` are treated as un-demotable and
--     are NEVER touched by a resync (a GitHub sync only ever maps to member/manager) — the UPDATE is
--     gated on the EXISTING role being on the GitHub ladder AND the incoming role strictly out-
--     ranking it. This upholds the union-not-demote invariant: manual grants / higher roles win.
--
--   Part 3 — explicit per-record role validation. 0035 passed rec->>'role' straight through, so a
--     bad value only failed via the CHECK constraint, rolling back the WHOLE provision with an
--     opaque error. Now each record's role is validated up front with a clear, actionable message.

-- Role-rank helpers (IMMUTABLE, pure). Rank 0 = unknown/off-ladder → never wins an upgrade compare.
-- Org: only the GitHub-mappable ladder is ranked (member<manager); owner/billing return 0 so they
-- are never the target of an upgrade and the resync WHERE clause (existing rank between 1 and 2)
-- excludes them entirely. Defined BEFORE provision_github_membership (it references them).
create or replace function public.org_role_rank(p_role text)
returns int language sql immutable set search_path = pg_catalog, public as $$
  select case p_role when 'member' then 1 when 'manager' then 2 else 0 end
$$;

create or replace function public.scope_role_rank(p_role text)
returns int language sql immutable set search_path = pg_catalog, public as $$
  select case p_role when 'viewer' then 1 when 'editor' then 2 when 'admin' then 3 else 0 end
$$;

create or replace function public.provision_github_membership(
  p_user uuid, p_orgs jsonb, p_teams jsonb)
returns void language plpgsql security definer set search_path = pg_catalog, public
as $$
declare
  rec       jsonb;
  v_org     uuid;
  v_scope   uuid;
  v_gid     bigint;
  v_role    text;
begin
  if p_user is null then
    raise exception 'p_user required' using errcode = '22004';
  end if;

  -- Orgs first: a team's org must exist before the team's scope can reference it.
  for rec in select value from jsonb_array_elements(coalesce(p_orgs, '[]'::jsonb)) as t(value) loop
    v_gid  := (rec->>'github_org_id')::bigint;
    -- Part 3: validate the mapped org role up front (GitHub sync only ever maps to member/manager).
    v_role := coalesce(rec->>'role', 'member');
    if v_role not in ('member', 'manager') then
      raise exception 'invalid github org role %; expected member or manager', v_role
        using errcode = '22023';
    end if;
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
    -- Part 2: additive insert; on conflict, UPGRADE-only along the org ladder. The WHERE clause
    -- leaves `owner`/`billing` (manual-only, off-ladder) untouched, and never lowers a rank.
    insert into public.org_members (org_id, user_id, role)
      values (v_org, p_user, v_role)
      on conflict (org_id, user_id) do update
        set role = excluded.role
        where public.org_role_rank(public.org_members.role) between 1 and 2
          and public.org_role_rank(excluded.role) > public.org_role_rank(public.org_members.role);
  end loop;

  -- Teams: create the scope keyed by GitHub team id, add org + scope membership.
  for rec in select value from jsonb_array_elements(coalesce(p_teams, '[]'::jsonb)) as t(value) loop
    v_gid  := (rec->>'github_org_id')::bigint;
    -- Part 3: validate the mapped scope role up front (GitHub sync maps to editor/admin).
    v_role := coalesce(rec->>'role', 'editor');
    if v_role not in ('editor', 'admin') then
      raise exception 'invalid github team role %; expected editor or admin', v_role
        using errcode = '22023';
    end if;
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
    -- Org membership (so a scope member can see the org) — additive only, never demote a manual role.
    insert into public.org_members (org_id, user_id, role) values (v_org, p_user, 'member')
      on conflict (org_id, user_id) do nothing;
    -- Part 2: scope role — additive insert; on conflict, UPGRADE-only along the scope ladder.
    insert into public.scope_members (scope_id, user_id, role)
      values (v_scope, p_user, v_role)
      on conflict (scope_id, user_id) do update
        set role = excluded.role
        where public.scope_role_rank(excluded.role) > public.scope_role_rank(public.scope_members.role);
  end loop;
end $$;

-- Re-assert the service-role-only boundary (create-or-replace does not change grants, but be explicit
-- so a fresh apply of this file alone is self-contained).
revoke all on function public.provision_github_membership(uuid, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.provision_github_membership(uuid, jsonb, jsonb) to service_role;
-- The rank helpers are only called from within the SECURITY DEFINER function (as its owner), so no
-- external grant is needed. Revoke the default PUBLIC EXECUTE to keep the surface minimal.
revoke all on function public.org_role_rank(text)   from public, anon, authenticated;
revoke all on function public.scope_role_rank(text) from public, anon, authenticated;
