drop function if exists public.set_scope_role(uuid, uuid, text);

create function public.set_scope_role(
  p_scope uuid,
  p_user uuid,
  p_role text,
  p_expected_role text
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_target_role text;
begin
  -- Serialize client role changes with removal and key-rotation operations.
  perform pg_advisory_xact_lock(hashtextextended(p_scope::text, 0));
  if public.scope_role(p_scope) is distinct from 'admin' then
    raise exception 'only a scope admin may change roles' using errcode = '42501';
  end if;
  if p_role not in ('admin', 'editor', 'viewer') then
    raise exception 'invalid scope role: %', p_role using errcode = '22023';
  end if;
  if p_expected_role is null or p_expected_role not in ('admin', 'editor', 'viewer') then
    raise exception 'invalid expected scope role' using errcode = '22023';
  end if;

  -- GitHub provisioning uses row writes without this advisory lock; lock before checking the role.
  select role into v_target_role
    from public.scope_members
   where scope_id = p_scope and user_id = p_user
   for update;
  if not found then
    raise exception 'team member not found' using errcode = 'P0002';
  end if;
  if v_target_role is distinct from p_expected_role then
    raise exception 'team member role changed; reload the team' using errcode = 'P0001';
  end if;
  if p_role <> 'admin'
     and v_target_role = 'admin'
     and (select count(*) from public.scope_members where scope_id = p_scope and role = 'admin') <= 1
  then
    raise exception 'cannot demote the last admin; promote another member to admin first'
      using errcode = '23514';
  end if;

  update public.scope_members
     set role = p_role
   where scope_id = p_scope and user_id = p_user;
end;
$$;

revoke all on function public.set_scope_role(uuid, uuid, text, text) from public, anon;
grant execute on function public.set_scope_role(uuid, uuid, text, text) to authenticated;
