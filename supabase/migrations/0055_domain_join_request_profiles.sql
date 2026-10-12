create or replace function public.domain_join_request_profiles(p_org uuid)
returns table(
  request_id uuid,
  user_id uuid,
  display_name text,
  github_login text,
  email text
)
language plpgsql
security definer
stable
set search_path = pg_catalog, public
as $$
begin
  if coalesce(public.org_role(p_org), '') not in ('owner', 'manager') then
    raise exception 'only an org owner/manager may read join requests'
      using errcode = '42501';
  end if;

  return query
    select djr.id, djr.user_id, p.display_name, p.github_login, p.email
      from public.domain_join_requests djr
      left join public.profiles p on p.id = djr.user_id
     where djr.org_id = p_org
       and djr.status = 'pending'
     order by djr.requested_at asc;
end
$$;

revoke all on function public.domain_join_request_profiles(uuid) from public, anon;
grant execute on function public.domain_join_request_profiles(uuid) to authenticated;
