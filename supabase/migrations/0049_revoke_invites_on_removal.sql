-- Migration 0049 — revoke outstanding invite tokens on scope member removal (#1345, E-5-c F-2).
--
-- Problem (from the E-5-c-1 adversarial review, F-2): `accept_scope_invite` tokens are single-use
-- and expire in 14 days, but `remove_scope_member` did NOT revoke a scope's outstanding *unredeemed*
-- invite tokens. A removed member holding a live token (or a leaked token) could re-join the scope as
-- editor/viewer within the 14-day window. Tokens are NOT bound to a specific invitee (any holder can
-- redeem one), so there is no per-user token to revoke — the only sound fix is to revoke ALL of the
-- scope's outstanding tokens on any member removal. An admin can simply re-issue a fresh invite.
--
-- Severity is low (membership grants FETCH only; DECRYPT needs a DEK wrap, and F-1 / migration 0043
-- already blocks re-wrapping the rotated DEK to a non-member), but this closes the roster re-join
-- nuisance cleanly. `pending_invites` already ON DELETE CASCADEs on scope_id, so scope DELETION
-- clears tokens; only member *removal* was uncovered — this is the missing piece.
--
-- Reproduced from 0029 verbatim except the single new DELETE at the end (marked #1345).

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
  -- #1345: revoke ALL of the scope's outstanding invite tokens. They are not invitee-bound, so the
  -- removed member could hold any live token; wiping the scope's tokens closes the re-join window.
  delete from public.pending_invites where scope_id = p_scope;
end $$;
