-- Migration 0029 — team lifecycle RPCs (E-4c, #827).
--
-- SECURITY DEFINER RPCs to create teams and manage scope membership + roles. These are the
-- FIRST path by which a cross-user `scope_members` row can be created — safe ONLY because the
-- deferred team gates already landed: 0027 (per-verb write-gate, viewer read-only, role-gated
-- DELETE), 0028 (enforce_row_quota membership guard + effective_tier), and the
-- sync_device_progress → is_member swap. Membership writes go through these role-checked,
-- transactional RPCs — NEVER the generic client push (org/scope/member tables are pull-only
-- mirrors on the client).
--
-- The per-scope DEK wrap is NOT done here: adding a member only grants FETCH (RLS is_member);
-- the member cannot DECRYPT until an admin group-wraps the DEK to them (client-side, E-4c-2).
-- Rotation on remove (bump key_epoch + re-wrap to remaining) is likewise client-side (E-4c-3);
-- this RPC only deletes the removed member's row + their now-unreadable wrap.

-- ---------------------------------------------------------------------------
-- create_team: a new team org + team scope; the caller becomes org owner + scope admin.
-- Returns the new team scope id. (Multi-team-per-org / standalone org creation: later.)
-- ---------------------------------------------------------------------------
create or replace function public.create_team(p_name text)
returns uuid language plpgsql security definer set search_path = pg_catalog, public
as $$
declare
  v_uid   uuid := auth.uid();
  v_org   uuid;
  v_scope uuid;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  insert into public.orgs (kind, owner_user_id, name) values ('team', v_uid, p_name)
    returning id into v_org;
  insert into public.org_members (org_id, user_id, role) values (v_org, v_uid, 'owner');
  insert into public.scopes (org_id, kind, name) values (v_org, 'team', p_name)
    returning id into v_scope;
  insert into public.scope_members (scope_id, user_id, role) values (v_scope, v_uid, 'admin');
  return v_scope;
end $$;

-- ---------------------------------------------------------------------------
-- add_scope_member: a scope ADMIN adds a user to the scope (and, implicitly, its org).
-- role ∈ {admin, editor, viewer}. Idempotent (re-adding updates the role).
-- ---------------------------------------------------------------------------
create or replace function public.add_scope_member(
  p_scope uuid, p_user uuid, p_role text default 'editor')
returns void language plpgsql security definer set search_path = pg_catalog, public
as $$
declare
  v_org      uuid;
  v_existing text;
begin
  -- Serialize all membership mutations on this scope so the last-admin checks below can't race
  -- (two concurrent demotions of distinct admins would each read count>1 and orphan the scope).
  perform pg_advisory_xact_lock(hashtextextended(p_scope::text, 0));
  -- scope_role() defaults to auth.uid() → this checks the CALLER is an admin of the scope.
  if public.scope_role(p_scope) is distinct from 'admin' then
    raise exception 'only a scope admin may add members' using errcode = '42501';
  end if;
  if p_role not in ('admin', 'editor', 'viewer') then
    raise exception 'invalid scope role: %', p_role using errcode = '22023';
  end if;
  -- Last-admin guard: the upsert below can RE-ROLE an existing member, so demoting the sole
  -- admin down to editor/viewer here must be blocked exactly like set_scope_role.
  select role into v_existing from public.scope_members where scope_id = p_scope and user_id = p_user;
  if v_existing = 'admin' and p_role <> 'admin'
     and (select count(*) from public.scope_members where scope_id = p_scope and role = 'admin') <= 1
  then
    raise exception 'cannot demote the last admin of a scope' using errcode = '23514';
  end if;
  select org_id into v_org from public.scopes where id = p_scope;
  if v_org is null then
    raise exception 'no such scope' using errcode = '23503';
  end if;
  -- Org membership (plain member) so the new member can see the org; then the scope role.
  insert into public.org_members (org_id, user_id, role) values (v_org, p_user, 'member')
    on conflict (org_id, user_id) do nothing;
  insert into public.scope_members (scope_id, user_id, role) values (p_scope, p_user, p_role)
    on conflict (scope_id, user_id) do update set role = excluded.role;
end $$;

-- ---------------------------------------------------------------------------
-- remove_scope_member: a scope ADMIN removes a member. Refuses to orphan the last admin. Also
-- drops the member's DEK wrap (server-side housekeeping; their local copy is inherently theirs).
-- ---------------------------------------------------------------------------
create or replace function public.remove_scope_member(p_scope uuid, p_user uuid)
returns void language plpgsql security definer set search_path = pg_catalog, public
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(p_scope::text, 0));
  if public.scope_role(p_scope) is distinct from 'admin' then
    raise exception 'only a scope admin may remove members' using errcode = '42501';
  end if;
  if (select role from public.scope_members where scope_id = p_scope and user_id = p_user) = 'admin'
     and (select count(*) from public.scope_members where scope_id = p_scope and role = 'admin') <= 1
  then
    raise exception 'cannot remove the last admin of a scope' using errcode = '23514';
  end if;
  delete from public.scope_members where scope_id = p_scope and user_id = p_user;
  delete from public.scope_keys where scope_id = p_scope and member_user_id = p_user::text;
  -- Also drop the org membership IF the user no longer belongs to ANY scope of that org (and
  -- isn't the org owner) — otherwise a removed member lingers as an org member with roster
  -- visibility. A member of OTHER scopes in the same org keeps their org membership.
  delete from public.org_members om
   where om.user_id = p_user
     and om.role <> 'owner'
     and om.org_id = (select org_id from public.scopes where id = p_scope)
     and not exists (
       select 1 from public.scope_members sm
         join public.scopes s on s.id = sm.scope_id
        where sm.user_id = p_user and s.org_id = om.org_id);
end $$;

-- ---------------------------------------------------------------------------
-- set_scope_role: a scope ADMIN changes a member's role. Refuses to demote the last admin.
-- ---------------------------------------------------------------------------
create or replace function public.set_scope_role(p_scope uuid, p_user uuid, p_role text)
returns void language plpgsql security definer set search_path = pg_catalog, public
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(p_scope::text, 0));
  if public.scope_role(p_scope) is distinct from 'admin' then
    raise exception 'only a scope admin may change roles' using errcode = '42501';
  end if;
  if p_role not in ('admin', 'editor', 'viewer') then
    raise exception 'invalid scope role: %', p_role using errcode = '22023';
  end if;
  if p_role <> 'admin'
     and (select role from public.scope_members where scope_id = p_scope and user_id = p_user) = 'admin'
     and (select count(*) from public.scope_members where scope_id = p_scope and role = 'admin') <= 1
  then
    raise exception 'cannot demote the last admin of a scope' using errcode = '23514';
  end if;
  update public.scope_members set role = p_role where scope_id = p_scope and user_id = p_user;
end $$;

grant execute on function public.create_team(text) to authenticated;
grant execute on function public.add_scope_member(uuid, uuid, text) to authenticated;
grant execute on function public.remove_scope_member(uuid, uuid) to authenticated;
grant execute on function public.set_scope_role(uuid, uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Harden the shares_scope oracle now that cross-user co-membership can exist. It is only ever
-- called 1-arg (p_uid defaults to auth.uid()) by identity_pub_read_comembers, so pinning p_uid
-- to the caller (or service_role) is transparent to every legitimate use while closing a
-- co-membership social-graph oracle (an arbitrary caller probing "do A and B share a scope").
-- ---------------------------------------------------------------------------
create or replace function public.shares_scope(p_other uuid, p_uid uuid default auth.uid())
returns boolean language sql stable security definer set search_path = pg_catalog, public
as $$
  select case
    when p_uid is distinct from auth.uid() and coalesce(auth.role(), '') <> 'service_role'
      then false
    else exists(
      select 1
        from public.scope_members a
        join public.scope_members b on b.scope_id = a.scope_id
       where a.user_id = p_uid and b.user_id = p_other)
  end;
$$;
