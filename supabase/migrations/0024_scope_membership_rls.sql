-- Migration 0024 — Membership-based RLS (E-2, #827): swap the content-table scope predicate
-- from `scope_id = auth.uid()` to `public.is_member(scope_id)`, delivering A1's promised
-- "one-line RLS predicate swap" so a scope can be a TEAM, not just a user.
--
-- BEHAVIOR-PRESERVING: every scope today is personal with a single owner=admin member, and
-- is_member(personal_scope, owner) is true (0023), so this is byte-identical for personal
-- scopes. The auth.uid() author-forgery guard (WITH CHECK author_id = auth.uid()) is KEPT
-- verbatim. The pro insert gate current_tier()='pro' → effective_tier(scope_id)='pro' is the
-- same value for a personal scope (personal effective_tier reads profiles.tier, = the caller's
-- own tier). No policy STRUCTURE changes here.
--
-- DEFERRED to E-4 (both need real teams/viewers/team-writes to matter, and both are bigger,
-- riskier changes teams motivate):
--   * the scope_role in ('editor','admin') WRITE-gate — requires splitting each `for all`
--     policy into select/insert/update/delete so a `viewer` can read but not write;
--   * enforce_row_quota's oracle-guard (scope_id distinct from auth.uid() → not is_member) +
--     tier read (profiles → effective_tier) — no-ops until a team scope (scope_id ≠ auth.uid())
--     is actually written.

-- ===========================================================================
-- 1. Simple `<t>_scope_all` content tables (from 0007 + 0009 + 0022): visibility gated by
--    membership; author still pinned to the writer.
-- ===========================================================================
do $$
declare t text;
begin
  foreach t in array array[
    'knowledge', 'entities', 'entity_aliases', 'entity_relations', 'knowledge_entity_refs',
    'knowledge_meta', 'knowledge_meta_crdt', 'projects'
  ]
  loop
    execute format('drop policy if exists %1$s_scope_all on public.%1$s', t);
    execute format(
      'create policy %1$s_scope_all on public.%1$s
         for all
         using (public.is_member(scope_id))
         with check (public.is_member(scope_id) and author_id = auth.uid())', t);
  end loop;
end $$;

-- ===========================================================================
-- 2. Pro table `distillations` (0020): USING stays open to any member (a downgraded ex-pro
--    member can still PULL their backup); WITH CHECK pins author + requires the scope's tier
--    to be pro to WRITE (effective_tier walks scope→org; = the caller's own tier for personal).
-- ===========================================================================
drop policy if exists distillations_scope_all on public.distillations;
create policy distillations_scope_all on public.distillations
  for all
  using (public.is_member(scope_id))
  with check (
    public.is_member(scope_id)
    and author_id = auth.uid()
    and public.effective_tier(scope_id) = 'pro'
  );

-- ===========================================================================
-- 3. Pro table `temporal_messages` (0021, append-only): split policies — read/delete open to
--    members, insert pins author + requires pro.
-- ===========================================================================
drop policy if exists temporal_messages_scope_select on public.temporal_messages;
create policy temporal_messages_scope_select on public.temporal_messages
  for select using (public.is_member(scope_id));

drop policy if exists temporal_messages_scope_insert on public.temporal_messages;
create policy temporal_messages_scope_insert on public.temporal_messages
  for insert
  with check (
    public.is_member(scope_id)
    and author_id = auth.uid()
    and public.effective_tier(scope_id) = 'pro'
  );

drop policy if exists temporal_messages_scope_delete on public.temporal_messages;
create policy temporal_messages_scope_delete on public.temporal_messages
  for delete using (public.is_member(scope_id));
