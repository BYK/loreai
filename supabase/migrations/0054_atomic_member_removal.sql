create or replace function public.set_scope_role(
  p_scope uuid,
  p_user uuid,
  p_role text
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
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
    raise exception 'cannot demote the last admin; promote another member to admin first'
      using errcode = '23514';
  end if;
  update public.scope_members set role = p_role where scope_id = p_scope and user_id = p_user;
end;
$$;

create or replace function public.remove_scope_member_rotating(
  p_scope uuid,
  p_user uuid,
  p_expected_epoch integer,
  p_wraps jsonb
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_epoch integer;
  v_new_epoch integer;
  v_target_role text;
  v_item jsonb;
  v_member_user_id text;
  v_wrapped_dek text;
  v_wrap_members text[] := array[]::text[];
  v_field_count integer;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_scope::text, 0));
  if public.scope_role(p_scope) is distinct from 'admin' then
    raise exception 'only a scope admin may remove members' using errcode = '42501';
  end if;

  select role into v_target_role
    from public.scope_members
   where scope_id = p_scope and user_id = p_user;
  if not found then
    raise exception 'team member not found' using errcode = 'P0002';
  end if;
  if v_target_role = 'admin'
     and (select count(*) from public.scope_members where scope_id = p_scope and role = 'admin') <= 1
  then
    raise exception 'cannot remove the last admin; promote another member to admin first'
      using errcode = '23514';
  end if;

  select key_epoch into v_epoch
    from public.scopes
   where id = p_scope
   for update;
  if v_epoch is distinct from p_expected_epoch then
    raise exception 'team key changed concurrently; retry' using errcode = '40001';
  end if;

  if jsonb_typeof(p_wraps) is distinct from 'array' then
    raise exception 'wraps must be an array' using errcode = '22023';
  end if;

  for v_item in select value from jsonb_array_elements(p_wraps) as wraps(value)
  loop
    if jsonb_typeof(v_item) is distinct from 'object'
       or jsonb_typeof(v_item -> 'member_user_id') is distinct from 'string'
       or jsonb_typeof(v_item -> 'wrapped_dek') is distinct from 'string'
    then
      raise exception 'each wrap must include member_user_id and wrapped_dek strings'
        using errcode = '22023';
    end if;
    select count(*) into v_field_count from jsonb_object_keys(v_item);
    if v_field_count <> 2 then
      raise exception 'each wrap must include only member_user_id and wrapped_dek'
        using errcode = '22023';
    end if;

    v_member_user_id := v_item ->> 'member_user_id';
    v_wrapped_dek := v_item ->> 'wrapped_dek';
    if length(v_wrapped_dek) < 1 or length(v_wrapped_dek) > 4096 then
      raise exception 'wrapped_dek length must be between 1 and 4096'
        using errcode = '22023';
    end if;
    if v_member_user_id = any(v_wrap_members) then
      raise exception 'duplicate member_user_id in wraps' using errcode = '22023';
    end if;
    if v_member_user_id = p_user::text
       or not exists (
         select 1 from public.scope_members
          where scope_id = p_scope and user_id::text = v_member_user_id
       )
    then
      raise exception 'wrap target must be a remaining team member'
        using errcode = '22023';
    end if;
    v_wrap_members := array_append(v_wrap_members, v_member_user_id);
  end loop;

  if exists (
    select 1
      from public.scope_members sm
     where sm.scope_id = p_scope
       and sm.user_id <> p_user
       and exists (
         select 1 from public.identity_pub ip where ip.user_id = sm.user_id
       )
       and not (sm.user_id::text = any(v_wrap_members))
  ) then
    raise exception 'wraps must cover every remaining member with an identity key'
      using errcode = '22023';
  end if;

  delete from public.scope_members where scope_id = p_scope and user_id = p_user;
  delete from public.scope_keys
   where scope_id = p_scope and member_user_id = p_user::text;
  delete from public.org_members om
   where om.user_id = p_user
     and om.role <> 'owner'
     and om.org_id = (select org_id from public.scopes where id = p_scope)
     and not exists (
       select 1
         from public.scope_members sm
         join public.scopes s on s.id = sm.scope_id
        where sm.user_id = p_user and s.org_id = om.org_id
     );
  delete from public.pending_invites where scope_id = p_scope;

  v_new_epoch := p_expected_epoch + 1;
  update public.scopes set key_epoch = v_new_epoch where id = p_scope;

  for v_item in select value from jsonb_array_elements(p_wraps) as wraps(value)
  loop
    insert into public.scope_keys (
      scope_id,
      author_id,
      member_user_id,
      wrapped_dek,
      key_epoch,
      updated_at
    )
    values (
      p_scope,
      auth.uid(),
      v_item ->> 'member_user_id',
      v_item ->> 'wrapped_dek',
      v_new_epoch,
      now()
    );
  end loop;

  return v_new_epoch;
end;
$$;

revoke all on function public.remove_scope_member(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.remove_scope_member_rotating(uuid, uuid, integer, jsonb)
  from public, anon, authenticated;
grant execute on function public.remove_scope_member_rotating(uuid, uuid, integer, jsonb)
  to authenticated;
