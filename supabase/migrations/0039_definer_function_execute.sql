-- 0039_definer_function_execute.sql
-- Security: lock down direct EXECUTE on the SECURITY DEFINER functions that
-- Postgres granted to PUBLIC by default at CREATE time. PostgREST exposes ANY
-- executable function at /rest/v1/rpc/<name>, so the blanket PUBLIC grant let
-- `anon` and `authenticated` invoke every definer function directly — the 40
-- `{anon,authenticated}_security_definer_function_executable` advisor warnings.
--
-- Correct posture:
--   * PUBLIC + anon: revoke EXECUTE on ALL of them. No definer function here is
--     meant to be called by an unauthenticated client.
--   * authenticated: revoke on everything EXCEPT the five client-facing team
--     RPCs the CLI actually calls (create_team, add_scope_member,
--     remove_scope_member, set_scope_role, rotate_scope_key — the ONLY .rpc()
--     names in src). NB: on today's schema the trigger/internal functions have
--     no DIRECT authenticated grant (only PUBLIC), so authenticated loses them
--     via the step-1 PUBLIC revoke; the explicit step-2 revoke is defensive.
--
-- `authenticated` KEEPS EXECUTE on the RLS helpers (is_member / is_org_member /
--   scope_role / org_role / shares_scope / current_tier / effective_tier):
--   an RLS policy expression is evaluated AS THE QUERYING ROLE, so Postgres
--   checks function-call permission against `authenticated`, NOT the policy
--   owner — even for a SECURITY DEFINER function. Revoking it breaks every
--   membership-gated query with `permission denied for function is_member`.
--   The helpers are already probe-hardened by the 2-arg oracle guard (0032),
--   so keeping authenticated EXECUTE leaks nothing. Only PUBLIC + anon are
--   revoked on them (anon never runs an authenticated RLS-gated query).
--
-- Why revoking the trigger functions from authenticated is SAFE:
--   enforce_row_quota / guard_org_tier / guard_profile_tier / handle_new_user /
--   maintain_usage / on_auth_user_provision_scope / rls_auto_enable /
--   provision_personal_scope are fired by (event) triggers or called by other
--   definer functions, never directly by a client. Triggers run the function in
--   the definer context regardless of the caller's EXECUTE grant.
--
-- service_role / postgres keep EXECUTE throughout — the payment/admin/migration
-- paths.
--
-- NOTE on existence guards: `rls_auto_enable()` is a platform-managed event-
-- trigger function that exists on the hosted project but NOT in this migration
-- set, so a bare `revoke ... on function public.rls_auto_enable()` would fail
-- when applying migrations to a fresh DB (integration harness, preview branches).
-- Each revoke is therefore guarded by `to_regprocedure(sig) is not null` so it
-- silently skips a function absent from the target DB.

-- ---------------------------------------------------------------------------
-- 1. Revoke the blanket PUBLIC grant and anon on every flagged function.
-- ---------------------------------------------------------------------------
do $$
declare
  sig text;
  all_sigs text[] := array[
    -- client RPCs
    'public.create_team(text)',
    'public.add_scope_member(uuid, uuid, text)',
    'public.remove_scope_member(uuid, uuid)',
    'public.set_scope_role(uuid, uuid, text)',
    'public.rotate_scope_key(uuid)',
    -- RLS helpers
    'public.is_member(uuid, uuid)',
    'public.is_org_member(uuid, uuid)',
    'public.scope_role(uuid, uuid)',
    'public.org_role(uuid, uuid)',
    'public.shares_scope(uuid, uuid)',
    'public.current_tier()',
    'public.effective_tier(uuid)',
    -- trigger / internal definer functions
    'public.enforce_row_quota()',
    'public.guard_org_tier()',
    'public.guard_profile_tier()',
    'public.handle_new_user()',
    'public.maintain_usage()',
    'public.on_auth_user_provision_scope()',
    'public.rls_auto_enable()',
    'public.provision_personal_scope(uuid)'
  ];
begin
  foreach sig in array all_sigs loop
    if to_regprocedure(sig) is not null then
      execute format('revoke all on function %s from public', sig);
      execute format('revoke all on function %s from anon', sig);
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Belt-and-suspenders: explicitly revoke `authenticated` on the trigger /
--    internal functions. On the current schema these have no DIRECT
--    authenticated grant (authenticated only ever reached them via PUBLIC,
--    already revoked in step 1), so this is a no-op today — it exists so a
--    future accidental `grant ... to authenticated` on one of these cannot
--    silently re-expose it via /rpc. (RLS helpers + client RPCs keep
--    authenticated — see header.)
-- ---------------------------------------------------------------------------
do $$
declare
  sig text;
  trigger_sigs text[] := array[
    'public.enforce_row_quota()',
    'public.guard_org_tier()',
    'public.guard_profile_tier()',
    'public.handle_new_user()',
    'public.maintain_usage()',
    'public.on_auth_user_provision_scope()',
    'public.rls_auto_enable()',
    'public.provision_personal_scope(uuid)'
  ];
begin
  foreach sig in array trigger_sigs loop
    if to_regprocedure(sig) is not null then
      execute format('revoke all on function %s from authenticated', sig);
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Re-affirm `authenticated` EXECUTE on the five client-facing team RPCs
--    (idempotent — they already hold it; explicit so intent is self-evident
--    and a future default-privilege change can't silently drop them).
-- ---------------------------------------------------------------------------
grant execute on function public.create_team(text)                        to authenticated;
grant execute on function public.add_scope_member(uuid, uuid, text)       to authenticated;
grant execute on function public.remove_scope_member(uuid, uuid)          to authenticated;
grant execute on function public.set_scope_role(uuid, uuid, text)         to authenticated;
grant execute on function public.rotate_scope_key(uuid)                   to authenticated;
