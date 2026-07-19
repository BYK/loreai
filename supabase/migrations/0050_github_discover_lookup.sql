-- Migration 0050 — E-5-d (#630, Slice 1): Lore-membership lookup for GitHub repo-collaborator
-- discovery. The github-discover Edge Function reads a caller's repo collaborators FROM GitHub with
-- the caller's own token, then calls this to learn which of those github ids already have a Lore
-- account — so the caller can invite the rest to a team they admin.
--
-- SECURITY / privacy: this returns ONLY the SET of github ids present (never Lore user_ids, emails,
-- or profiles), and is SERVICE-ROLE-ONLY. A client can never call it directly, so it is not an open
-- "is GitHub user X on Lore" enumeration oracle — the Edge Function only ever asks about github ids
-- of collaborators the caller could already read on GitHub.
--
-- Identity source: Supabase stores the GitHub OAuth numeric id in
-- auth.users.raw_user_meta_data->>'provider_id' (the same field resolveJwtGithubId falls back to and
-- handle_new_user reads for github_login). Keyed on that so it works against both production and the
-- test shim (which has auth.users.raw_user_meta_data but no auth.identities).

create or replace function public.lore_users_for_github_ids(p_github_ids bigint[])
returns table (github_id bigint)
language sql
security definer
set search_path = pg_catalog, public
as $$
  select distinct (u.raw_user_meta_data ->> 'provider_id')::bigint as github_id
  from auth.users u
  where u.raw_user_meta_data ->> 'provider_id' is not null
    and (u.raw_user_meta_data ->> 'provider_id') ~ '^[0-9]+$'
    and (u.raw_user_meta_data ->> 'provider_id')::bigint = any(p_github_ids);
$$;

-- SERVICE-ROLE-ONLY: only the github-discover Edge Function may call this. Direct client access
-- would turn it into an account-enumeration oracle.
revoke all on function public.lore_users_for_github_ids(bigint[])
  from public, anon, authenticated;
grant execute on function public.lore_users_for_github_ids(bigint[]) to service_role;

comment on function public.lore_users_for_github_ids(bigint[]) is
  'E-5-d (#630): service-role-only. Given a set of GitHub numeric ids, returns the subset that have '
  'a Lore account (matched on auth.users.raw_user_meta_data->>provider_id). Returns only github ids, '
  'never Lore user_ids/emails — the enumeration surface is bounded by the Edge Function to a '
  'caller''s own repo collaborators.';
