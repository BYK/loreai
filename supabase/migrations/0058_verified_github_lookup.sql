-- GitHub discovery and invite recipients must use GoTrue's server-owned linked
-- identities. raw_user_meta_data is editable by the account holder and can never
-- establish GitHub ownership, even when the lookup itself is service-role-only.
-- Do not backfill identities from metadata: that would preserve forged claims.

create or replace function public.lore_users_for_github_ids(p_github_ids bigint[])
returns table (github_id bigint)
language sql
security definer
set search_path = pg_catalog, public
as $$
  select distinct requested.github_id
  from unnest(p_github_ids) as requested(github_id)
  join auth.identities i
    on i.provider = 'github'
   and i.provider_id = requested.github_id::text
  -- Refuse ambiguity even if a legacy identity table lacks GoTrue's unique key.
  where not exists (
    select 1 from auth.identities conflicting
    where conflicting.provider = 'github'
      and conflicting.provider_id = i.provider_id
      and conflicting.user_id <> i.user_id
  );
$$;

create or replace function public.lore_emails_for_github_ids(p_github_ids bigint[])
returns table (github_id bigint, email text)
language sql
security definer
set search_path = pg_catalog, public
as $$
  select distinct requested.github_id, u.email::text
  from unnest(p_github_ids) as requested(github_id)
  join auth.identities i
    on i.provider = 'github'
   and i.provider_id = requested.github_id::text
  join auth.users u on u.id = i.user_id
  where u.email is not null
    -- Never choose an invite recipient by row order when ownership is ambiguous.
    and not exists (
      select 1 from auth.identities conflicting
      where conflicting.provider = 'github'
        and conflicting.provider_id = i.provider_id
        and conflicting.user_id <> i.user_id
    );
$$;

-- Keep both enumeration surfaces restricted to the trusted Edge Functions.
revoke all on function public.lore_users_for_github_ids(bigint[])
  from public, anon, authenticated;
revoke all on function public.lore_emails_for_github_ids(bigint[])
  from public, anon, authenticated;
grant execute on function public.lore_users_for_github_ids(bigint[]) to service_role;
grant execute on function public.lore_emails_for_github_ids(bigint[]) to service_role;

comment on function public.lore_users_for_github_ids(bigint[]) is
  'Service-role-only GitHub collaborator lookup. Matches only server-owned linked '
  'auth.identities with provider github. Returns requested GitHub ids, never Lore '
  'user ids or emails; editable user metadata never establishes ownership.';
comment on function public.lore_emails_for_github_ids(bigint[]) is
  'Service-role-only invite-recipient lookup. Resolves requested GitHub ids through '
  'server-owned linked auth.identities to auth.users.email. Never returns Lore '
  'user ids and never trusts editable user metadata.';
