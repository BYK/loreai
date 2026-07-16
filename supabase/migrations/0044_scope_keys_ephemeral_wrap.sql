-- Migration 0044 — allow ephemeral-invite DEK wraps in scope_keys (E-5-c-2 offline invites, #827).
--
-- The `--offline` invite path (admin-never-returns case) wraps the scope DEK to an EPHEMERAL
-- X25519 public key whose secret lives only inside the invite token. That wrap is stored as a
-- scope_keys row keyed `member_user_id = 'eph:<eph_pub_b64>'` — a synthetic, non-user member so a
-- fresh invitee (who is not yet in scope_members when the admin mints, and may accept while the
-- admin is offline) can unwrap the DEK with the token's ephemeral secret, re-wrap it to their own
-- identity, and rotate.
--
-- 0043 tightened scope_keys writes to a CURRENT member (scope_has_member) — which correctly rejects
-- an 'eph:' target. Relax it to ALSO permit an 'eph:' capability wrap. This stays safe:
--   * still admin-only (scope_role='admin') and author_id = auth.uid();
--   * the admin already holds the DEK, so wrapping it to an ephemeral key they minted grants no
--     access the admin doesn't already have;
--   * the ephemeral secret never reaches the server (only the DEK wrapped to the eph PUBLIC key is
--     stored); it is delivered out-of-band in the token, single-use, short-lived;
--   * accept-side rotation supersedes the epoch, so a leaked token cannot read post-accept writes.
-- The removed-member re-wrap gap 0043 closed is unaffected: a removed member's uuid is still not a
-- member and still rejected; only the 'eph:' escape hatch is added.

-- Predicate helper: a legitimate scope_keys write target is EITHER a current member OR an
-- ephemeral-invite capability key (member_user_id like 'eph:%'). Kept as a small definer helper so
-- both the insert and update policies share one definition (and it is only reachable after the
-- admin gate, so it reveals nothing new).
create or replace function public.scope_key_target_ok(p_scope uuid, p_member text)
returns boolean language sql stable security definer set search_path = pg_catalog, public
as $$
  select p_member like 'eph:%' or public.scope_has_member(p_scope, p_member);
$$;
grant execute on function public.scope_key_target_ok(uuid, text) to authenticated;

drop policy if exists scope_keys_insert on public.scope_keys;
create policy scope_keys_insert on public.scope_keys
  for insert with check (
    public.scope_role(scope_id) = 'admin'
    and author_id = (select auth.uid())
    and public.scope_key_target_ok(scope_id, member_user_id)
  );

drop policy if exists scope_keys_update on public.scope_keys;
create policy scope_keys_update on public.scope_keys
  for update
  using (public.scope_role(scope_id) = 'admin')
  with check (
    public.scope_role(scope_id) = 'admin'
    and author_id = (select auth.uid())
    and public.scope_key_target_ok(scope_id, member_user_id)
  );

-- Read: a member normally reads ONLY their own wrap (member_user_id = auth.uid()). An accepting
-- invitee must ALSO be able to fetch the 'eph:' capability wrap for a scope they now belong to, so
-- they can unwrap the DEK with the token's ephemeral secret. Safe: the ciphertext is unreadable
-- without that secret (delivered out-of-band in the token), so exposing the eph row to co-members
-- reveals nothing. Both branches remain gated by is_member(scope_id).
drop policy if exists scope_keys_read on public.scope_keys;
create policy scope_keys_read on public.scope_keys
  for select using (
    public.is_member(scope_id)
    and (
      member_user_id = (select auth.uid())::text
      or member_user_id like 'eph:%'
    )
  );

-- Retire a spent ephemeral-invite wrap: any MEMBER of the scope may delete an 'eph:' row (the
-- accepting invitee calls this right after adopting the DEK, so the token's ephemeral secret has
-- nothing left to unwrap). Member-callable (not admin) because the invitee joins as editor/viewer
-- and retiring their own single-use capability wrap is not a privileged team-management action.
-- Restricted to 'eph:%' rows so a member can NEVER delete another member's real wrap through this
-- path (that stays admin-only via scope_keys_delete). SECURITY DEFINER so it bypasses the
-- admin-only scope_keys_delete policy, but the is_member gate + eph-only filter keep it safe.
create or replace function public.retire_ephemeral_invite(p_scope uuid, p_eph_pub text)
returns integer language plpgsql security definer set search_path = pg_catalog, public
as $$
declare v_n integer;
begin
  if not public.is_member(p_scope) then
    raise exception 'not a member of this scope' using errcode = '42501';
  end if;
  delete from public.scope_keys
    where scope_id = p_scope and member_user_id = 'eph:' || p_eph_pub;
  get diagnostics v_n = row_count;
  return v_n;
end $$;
grant execute on function public.retire_ephemeral_invite(uuid, text) to authenticated;


