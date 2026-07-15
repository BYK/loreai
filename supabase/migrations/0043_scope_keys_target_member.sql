-- Migration 0043 — scope_keys writes must target a CURRENT member (E-5-c hardening, #827).
--
-- Adversarial review of E-5-c (invites + auto-wrap) found a forward-secrecy gap: the auto-wrap
-- reconcile (reconcileScopeWraps) wraps the scope DEK to every co-member its LOCAL scope_members
-- mirror lists that lacks a current-epoch wrap. After an admin removes a member and rotates, a
-- SECOND admin's mirror can still list the removed member (remote scope_members has no is_deleted;
-- the incremental pull never sees the DELETE — the #1294 gap), so that second admin would re-wrap
-- the FRESH DEK to the removed member, re-granting the rotated key.
--
-- Root cause is server-side: scope_keys_insert / scope_keys_update only checked that the WRITER is
-- an admin — not that the TARGET (member_user_id) is still a member. Close it at the source: a wrap
-- may only be written for a member who is CURRENTLY in scope_members. This holds regardless of any
-- client's stale local mirror.
--
-- We cannot reuse public.is_member() in the WITH CHECK: 0032 pinned its 2-arg form to return false
-- for a cross-user probe (p_uid <> auth.uid()), which is exactly the case here (the admin checks a
-- DIFFERENT member). A dedicated helper scoped to this use is safe — it is only ever reached AFTER
-- the policy's own `scope_role(scope_id) = 'admin'` clause, so only an admin of the scope (who may
-- already read the full roster via scope_members_read) can observe its result: no new oracle.

-- member_user_id is TEXT. Compare on user_id::text so a NON-uuid target (e.g. a future ephemeral
-- "eph:<id>" wrap, E-5-c-2) can never be a member → the guard cleanly rejects it instead of raising
-- 22P02 on a ::uuid cast. Real members are uuid strings and match exactly.
create or replace function public.scope_has_member(p_scope uuid, p_member text)
returns boolean language sql stable security definer set search_path = pg_catalog, public
as $$
  select exists(
    select 1 from public.scope_members
      where scope_id = p_scope and user_id::text = p_member
  );
$$;
-- Not granted to anon; authenticated may call it but it is only meaningful inside the admin-gated
-- scope_keys policies below (and returns a plain boolean about a scope, no PII).
grant execute on function public.scope_has_member(uuid, text) to authenticated;

-- Reproduce the scope_keys write policies from 0036 verbatim, adding the target-membership clause.
drop policy if exists scope_keys_insert on public.scope_keys;
create policy scope_keys_insert on public.scope_keys
  for insert with check (
    public.scope_role(scope_id) = 'admin'
    and author_id = (select auth.uid())
    and public.scope_has_member(scope_id, member_user_id)
  );

drop policy if exists scope_keys_update on public.scope_keys;
create policy scope_keys_update on public.scope_keys
  for update
  using (public.scope_role(scope_id) = 'admin')
  with check (
    public.scope_role(scope_id) = 'admin'
    and author_id = (select auth.uid())
    and public.scope_has_member(scope_id, member_user_id)
  );
