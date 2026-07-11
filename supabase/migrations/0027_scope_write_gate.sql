-- Migration 0027 — per-verb write-gate: viewers read, editors/admins write (E-4a, #827).
--
-- Splits every content policy into SELECT / INSERT / UPDATE / DELETE so that:
--   * SELECT stays membership-gated (any member reads);
--   * INSERT/UPDATE require scope_role in ('editor','admin') (a `viewer` is read-only);
--   * DELETE carries the role gate in its USING clause — PostgreSQL never evaluates WITH CHECK
--     for DELETE, so a `for all` policy let ANY member delete ANY member's rows (Seer HIGH on
--     #1257). The per-verb DELETE USING closes that.
-- Author is still pinned to the writer on INSERT/UPDATE (author_id = auth.uid()). Pro tables
-- keep the effective_tier(scope_id) = 'pro' write gate; reads stay open (a downgraded ex-pro
-- can still PULL their backup).
--
-- 🔴 PREREQUISITE for team lifecycle (E-4c): a `viewer` must be read-only and cross-member
-- DELETE must be blocked BEFORE any cross-user scope_members row can be created. BEHAVIOR-
-- PRESERVING today: every scope is personal with a single owner whose role is 'admin', so
-- scope_role(personal, owner) in ('editor','admin') is always true — byte-identical to the
-- prior membership-only policies. `temporal_messages` (missed by 0024, still on scope_id =
-- auth.uid()) is also brought onto is_member/effective_tier/scope_role here.

-- ===========================================================================
-- 1. Simple content tables (from 0024): membership read; editor/admin write; author-pinned.
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
    execute format('drop policy if exists %1$s_scope_select on public.%1$s', t);
    execute format('drop policy if exists %1$s_scope_insert on public.%1$s', t);
    execute format('drop policy if exists %1$s_scope_update on public.%1$s', t);
    execute format('drop policy if exists %1$s_scope_delete on public.%1$s', t);
    execute format(
      'create policy %1$s_scope_select on public.%1$s
         for select using (public.is_member(scope_id))', t);
    execute format(
      'create policy %1$s_scope_insert on public.%1$s
         for insert with check (
           public.is_member(scope_id)
           and author_id = auth.uid()
           and public.scope_role(scope_id) in (''editor'', ''admin''))', t);
    execute format(
      'create policy %1$s_scope_update on public.%1$s
         for update
         using (public.is_member(scope_id) and public.scope_role(scope_id) in (''editor'', ''admin''))
         with check (
           public.is_member(scope_id)
           and author_id = auth.uid()
           and public.scope_role(scope_id) in (''editor'', ''admin''))', t);
    execute format(
      'create policy %1$s_scope_delete on public.%1$s
         for delete using (
           public.is_member(scope_id) and public.scope_role(scope_id) in (''editor'', ''admin''))', t);
  end loop;
end $$;

-- ===========================================================================
-- 2. distillations (pro, versioned): same per-verb split; writes also require pro tier.
-- ===========================================================================
drop policy if exists distillations_scope_all on public.distillations;
drop policy if exists distillations_scope_select on public.distillations;
drop policy if exists distillations_scope_insert on public.distillations;
drop policy if exists distillations_scope_update on public.distillations;
drop policy if exists distillations_scope_delete on public.distillations;

create policy distillations_scope_select on public.distillations
  for select using (public.is_member(scope_id));
create policy distillations_scope_insert on public.distillations
  for insert with check (
    public.is_member(scope_id)
    and author_id = auth.uid()
    and public.scope_role(scope_id) in ('editor', 'admin')
    and public.effective_tier(scope_id) = 'pro');
create policy distillations_scope_update on public.distillations
  for update
  using (public.is_member(scope_id) and public.scope_role(scope_id) in ('editor', 'admin'))
  with check (
    public.is_member(scope_id)
    and author_id = auth.uid()
    and public.scope_role(scope_id) in ('editor', 'admin')
    and public.effective_tier(scope_id) = 'pro');
create policy distillations_scope_delete on public.distillations
  for delete using (
    public.is_member(scope_id) and public.scope_role(scope_id) in ('editor', 'admin'));

-- ===========================================================================
-- 3. temporal_messages (pro, append-only — NO update; missed by 0024): swap scope_id=auth.uid()
--    + current_tier() → is_member + effective_tier + scope_role. UPDATE stays privilege-revoked.
-- ===========================================================================
drop policy if exists temporal_messages_scope_all on public.temporal_messages;
drop policy if exists temporal_messages_scope_select on public.temporal_messages;
drop policy if exists temporal_messages_scope_insert on public.temporal_messages;
drop policy if exists temporal_messages_scope_delete on public.temporal_messages;

create policy temporal_messages_scope_select on public.temporal_messages
  for select using (public.is_member(scope_id));
create policy temporal_messages_scope_insert on public.temporal_messages
  for insert with check (
    public.is_member(scope_id)
    and author_id = auth.uid()
    and public.scope_role(scope_id) in ('editor', 'admin')
    and public.effective_tier(scope_id) = 'pro');
create policy temporal_messages_scope_delete on public.temporal_messages
  for delete using (
    public.is_member(scope_id) and public.scope_role(scope_id) in ('editor', 'admin'));

-- ===========================================================================
-- 4. sync_device_progress (control table): a member records their own device's pull cursor for
--    any scope they belong to. Not content — no role gate (viewers pull + report too), just
--    membership. Swap scope_id=auth.uid() → is_member.
-- ===========================================================================
drop policy if exists sync_device_progress_scope_all on public.sync_device_progress;
create policy sync_device_progress_scope_all on public.sync_device_progress
  for all
  using (public.is_member(scope_id))
  with check (public.is_member(scope_id));
