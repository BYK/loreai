-- 0036_rls_initplan.sql
-- Performance: wrap `auth.<function>()` calls in RLS policies as
-- `(select auth.<function>())` so Postgres evaluates them ONCE per query (as an
-- InitPlan) instead of re-evaluating per row. Fixes the 30 `auth_rls_initplan`
-- performance-advisor warnings.
--
-- These are BEHAVIOR-PRESERVING recreations: each policy is byte-identical to
-- its current definition except that a bare `auth.uid()` / `auth.role()` is
-- replaced by `(select auth.uid())` / `(select auth.role())`. The membership
-- helpers (`is_member`, `scope_role`, `effective_tier`, `shares_scope`) are NOT
-- wrapped — they take no per-row-varying argument and call `auth.uid()`
-- internally, so the planner already treats them as stable within the query
-- (the advisor does not flag them).
--
-- Reproduced from: 0027 (content per-verb split), 0025 (identity_pub/scope_keys),
-- 0023 (org_members/scope_members), 0010 (account_escrow scope_all), 0007
-- (user_table_usage), 0003 (plan_limits), 0001 (profiles).

-- ===========================================================================
-- 1. Simple content tables + distillations/temporal (from 0027): the flagged
--    `auth.uid()` is the `author_id = auth.uid()` clause in INSERT/UPDATE.
-- ===========================================================================
do $$
declare t text;
begin
  foreach t in array array[
    'knowledge', 'entities', 'entity_aliases', 'entity_relations', 'knowledge_entity_refs',
    'knowledge_meta', 'knowledge_meta_crdt', 'projects'
  ]
  loop
    execute format('drop policy if exists %1$s_scope_insert on public.%1$s', t);
    execute format(
      'create policy %1$s_scope_insert on public.%1$s
         for insert with check (
           public.is_member(scope_id)
           and author_id = (select auth.uid())
           and public.scope_role(scope_id) in (''editor'', ''admin''))', t);
    execute format('drop policy if exists %1$s_scope_update on public.%1$s', t);
    execute format(
      'create policy %1$s_scope_update on public.%1$s
         for update
         using (public.is_member(scope_id) and public.scope_role(scope_id) in (''editor'', ''admin''))
         with check (
           public.is_member(scope_id)
           and author_id = (select auth.uid())
           and public.scope_role(scope_id) in (''editor'', ''admin''))', t);
  end loop;
end $$;

-- distillations (pro, versioned)
drop policy if exists distillations_scope_insert on public.distillations;
create policy distillations_scope_insert on public.distillations
  for insert with check (
    public.is_member(scope_id)
    and author_id = (select auth.uid())
    and public.scope_role(scope_id) in ('editor', 'admin')
    and public.effective_tier(scope_id) = 'pro');
drop policy if exists distillations_scope_update on public.distillations;
create policy distillations_scope_update on public.distillations
  for update
  using (public.is_member(scope_id) and public.scope_role(scope_id) in ('editor', 'admin'))
  with check (
    public.is_member(scope_id)
    and author_id = (select auth.uid())
    and public.scope_role(scope_id) in ('editor', 'admin')
    and public.effective_tier(scope_id) = 'pro');

-- temporal_messages (pro, append-only — no update policy)
drop policy if exists temporal_messages_scope_insert on public.temporal_messages;
create policy temporal_messages_scope_insert on public.temporal_messages
  for insert with check (
    public.is_member(scope_id)
    and author_id = (select auth.uid())
    and public.scope_role(scope_id) in ('editor', 'admin')
    and public.effective_tier(scope_id) = 'pro');

-- ===========================================================================
-- 2. account_escrow (from 0010 scope_all loop).
-- ===========================================================================
drop policy if exists account_escrow_scope_all on public.account_escrow;
create policy account_escrow_scope_all on public.account_escrow
  for all
  using (scope_id = (select auth.uid()))
  with check (scope_id = (select auth.uid()) and author_id = (select auth.uid()));

-- ===========================================================================
-- 3. identity_pub owner + scope_keys (from 0025).
-- ===========================================================================
drop policy if exists identity_pub_owner on public.identity_pub;
create policy identity_pub_owner on public.identity_pub
  for all using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

drop policy if exists scope_keys_read on public.scope_keys;
create policy scope_keys_read on public.scope_keys
  for select using (
    public.is_member(scope_id) and member_user_id = (select auth.uid())::text
  );

drop policy if exists scope_keys_insert on public.scope_keys;
create policy scope_keys_insert on public.scope_keys
  for insert with check (
    public.scope_role(scope_id) = 'admin' and author_id = (select auth.uid())
  );

drop policy if exists scope_keys_update on public.scope_keys;
create policy scope_keys_update on public.scope_keys
  for update
  using (public.scope_role(scope_id) = 'admin')
  with check (public.scope_role(scope_id) = 'admin' and author_id = (select auth.uid()));

-- ===========================================================================
-- 4. org_members / scope_members registry reads (from 0023).
-- ===========================================================================
drop policy if exists org_members_read on public.org_members;
create policy org_members_read on public.org_members
  for select using (user_id = (select auth.uid()));

drop policy if exists scope_members_read on public.scope_members;
create policy scope_members_read on public.scope_members
  for select using (user_id = (select auth.uid()) or public.is_member(scope_id));

-- ===========================================================================
-- 5. user_table_usage read (from 0007).
-- ===========================================================================
drop policy if exists user_table_usage_read on public.user_table_usage;
create policy user_table_usage_read on public.user_table_usage
  for select using (scope_id = (select auth.uid()));

-- ===========================================================================
-- 6. plan_limits read (from 0003) — the only auth.role() call.
-- ===========================================================================
drop policy if exists plan_limits_read on public.plan_limits;
create policy plan_limits_read on public.plan_limits
  for select using ((select auth.role()) = 'authenticated');

-- ===========================================================================
-- 7. profiles select/update own (from 0001).
-- ===========================================================================
drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own
  on public.profiles
  for select
  using (id = (select auth.uid()));

drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own
  on public.profiles
  for update
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));
