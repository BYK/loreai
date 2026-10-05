create or replace function public.team_member_profiles(p_scope uuid)
returns table(user_id uuid, display_name text, github_login text, email text)
language plpgsql
security definer
stable
set search_path = pg_catalog, public
as $$
begin
  if not public.is_member(p_scope) then
    raise exception 'only scope members may read member profiles' using errcode = '42501';
  end if;

  return query
    select sm.user_id, p.display_name, p.github_login, p.email
      from public.scope_members sm
      join public.profiles p on p.id = sm.user_id
     where sm.scope_id = p_scope;
end
$$;

revoke all on function public.team_member_profiles(uuid) from public, anon;
grant execute on function public.team_member_profiles(uuid) to authenticated;
