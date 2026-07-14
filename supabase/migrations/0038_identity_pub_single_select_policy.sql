-- 0038_identity_pub_single_select_policy.sql
-- Performance: collapse the two permissive SELECT policies on identity_pub into
-- one, fixing the 6 `multiple_permissive_policies` advisor warnings (one per
-- role, all for SELECT on identity_pub).
--
-- Before (0025, initplan-wrapped in 0036):
--   identity_pub_owner          FOR ALL    using (user_id = (select auth.uid()))
--                                          with check (user_id = (select auth.uid()))
--   identity_pub_read_comembers FOR SELECT using (public.shares_scope(user_id))
-- A `FOR ALL` policy also applies to SELECT, so every SELECT evaluated BOTH
-- permissive policies and OR-ed them: effective read = owner OR co-member.
--
-- After: a single SELECT policy carrying that exact OR, and the owner policy
-- narrowed to the write verbs it actually needs (authenticated is granted only
-- SELECT/INSERT/UPDATE on this table — 0025:57 — so no DELETE policy is needed).
--
-- Behavior-preserving:
--  * READ — `user_id = (select auth.uid()) OR shares_scope(user_id)` is byte-
--    equivalent to the prior OR of the owner + co-member policies. The explicit
--    owner disjunct is retained (NOT folded into shares_scope alone) so a user
--    can always read their OWN row even in the degenerate case where they have
--    no scope_members row and shares_scope(self) would return false.
--  * WRITE — INSERT/UPDATE keep the identical `user_id = (select auth.uid())`
--    self-ownership gate the FOR ALL policy enforced.
-- auth.uid() stays wrapped as (select …) to preserve the 0036 initplan fix.

alter table public.identity_pub enable row level security;

-- Drop the FOR ALL owner policy and the standalone co-member read policy.
drop policy if exists identity_pub_owner on public.identity_pub;
drop policy if exists identity_pub_read_comembers on public.identity_pub;

-- Single SELECT policy: own row OR a co-member's row.
drop policy if exists identity_pub_read on public.identity_pub;
create policy identity_pub_read on public.identity_pub
  for select
  using (user_id = (select auth.uid()) or public.shares_scope(user_id));

-- Owner-only write policies (self-ownership), matching the granted write verbs.
drop policy if exists identity_pub_insert on public.identity_pub;
create policy identity_pub_insert on public.identity_pub
  for insert
  with check (user_id = (select auth.uid()));

drop policy if exists identity_pub_update on public.identity_pub;
create policy identity_pub_update on public.identity_pub
  for update
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
