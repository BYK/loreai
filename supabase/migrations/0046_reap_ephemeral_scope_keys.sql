-- Migration 0046 — reap orphaned ephemeral-invite scope_keys rows (E-5-c-2 follow-up, #1353).
--
-- An `--offline` invite (0044) mints a synthetic scope_keys row keyed `member_user_id = 'eph:<pub>'`
-- holding the scope DEK wrapped to an ephemeral public key. On accept the invitee RETIRES it (delete
-- both sides via retire_ephemeral_invite). But if the invite is NEVER accepted, or retirement fails
-- after adoption (the two steps aren't atomic), the eph row lingers forever — the token's decryption
-- capability against that row outlives the pending_invites 14-day join window (0042).
--
-- Blast radius is bounded (eph rows are is_member-gated on read, so only existing members — who
-- already hold the DEK — can read them; no leak to non-members). This is hygiene / defense-in-depth,
-- so a periodic server-side reap keyed off the same 14-day window as the invite expiry is sufficient.
--
-- Mirrors reap_tombstones (0018): SECURITY DEFINER, service_role-only, daily pg_cron where available.
-- NOTE 0018 deliberately EXCLUDES scope_keys from the tombstone reaper (real per-member wraps must
-- never be background-deleted); this reaper is the narrow complement — it touches ONLY 'eph:%' rows,
-- never a real member wrap.

create or replace function public.reap_ephemeral_scope_keys(retention_days integer default 14)
returns bigint
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  cutoff timestamptz := now() - make_interval(days => greatest(retention_days, 0));
  n      bigint;
begin
  -- Only ephemeral capability wraps, and only those older than the retention window. `created_at`
  -- (not updated_at) is the age basis: an eph row is written once and never updated, and its purpose
  -- expires with the invite token — a real member wrap (member_user_id = a uuid) is never matched.
  delete from public.scope_keys
    where member_user_id like 'eph:%'
      and created_at < cutoff;
  get diagnostics n = row_count;
  return n;
end;
$$;

-- System task only — a regular user must never trigger a cross-scope reap (the function is SECURITY
-- DEFINER and bypasses RLS). pg_cron runs as the owner; a service_role admin may invoke it manually.
revoke all on function public.reap_ephemeral_scope_keys(integer) from public;
grant execute on function public.reap_ephemeral_scope_keys(integer) to service_role;

-- Schedule a daily reap, but only where pg_cron exists (Supabase). The stock postgres:16-alpine image
-- the integration harness uses lacks it, so this whole block is skipped there and the function is
-- exercised by calling it directly in tests. (The inner cron.* references are only parsed when the
-- branch runs, so they don't error when the cron schema is absent.)
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    if exists (select 1 from cron.job where jobname = 'reap-ephemeral-scope-keys') then
      perform cron.unschedule('reap-ephemeral-scope-keys');
    end if;
    perform cron.schedule(
      'reap-ephemeral-scope-keys', '43 3 * * *',
      'select public.reap_ephemeral_scope_keys(14)'
    );
  end if;
end
$$;
