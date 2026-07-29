-- Migration 0051 — E-5-d (#630) invite-email plumbing. Companion to 0050:
-- lore_users_for_github_ids reveals the SET of github ids that map to a Lore account.
-- For the invite-by-email flow, the Edge Function (github-discover --invite and
-- send-invite-email-with-login) needs the EMAIL for each present id, so a one-shot
-- "I want to email this set of github users" lookup can land.
--
-- SECURITY / privacy: same envelope as 0050. The RPC:
--   (1) returns a row per present github id (github_id, email) — never Lore user_ids.
--   (2) is SERVICE-ROLE-ONLY. A client cannot enumerate "is GitHub user X on Lore
--       AND what is their email" directly; the EF (which authorizes its caller as the
--       team admin OR as the creator of an existing invite) is the only path.
--   (3) reads auth.users for emails of users whose raw_user_meta_data->>'provider_id'
--       matches one of the queried github_ids. The WHERE clause is positional —
--       '= any(p_github_ids)'. No LIKE, no ILIKE — fixed precision match.
--
-- WHEN NOT TO WIDEN: adding columns / relaxing filters would turn this into a profile
-- oracle. Keep this RPC narrow; if a future use case needs more columns, add a new RPC.

create or replace function public.lore_emails_for_github_ids(p_github_ids bigint[])
returns table (github_id bigint, email text)
language sql
security definer
set search_path = pg_catalog, public
as $$
  select
    (u.raw_user_meta_data ->> 'provider_id')::bigint as github_id,
    u.email::text as email
  from auth.users u
  where u.raw_user_meta_data ->> 'provider_id' is not null
    and (u.raw_user_meta_data ->> 'provider_id') ~ '^[0-9]+$'
    and (u.raw_user_meta_data ->> 'provider_id')::bigint = any(p_github_ids)
    and u.email is not null;
$$;

revoke all on function public.lore_emails_for_github_ids(bigint[])
  from public, anon, authenticated;
grant execute on function public.lore_emails_for_github_ids(bigint[]) to service_role;

comment on function public.lore_emails_for_github_ids(bigint[]) is
  'E-5-d (#630): service-role-only. Given a set of GitHub numeric ids, returns the Lore '
  'email for those that have a Lore account with one (github_id, email). Returns only '
  'github ids + emails of present users — never Lore user_ids, never profile data. Used '
  'by github-discover --invite and send-invite-email-with-login to email invites without '
  'ever exposing the email back to the CLI.';
