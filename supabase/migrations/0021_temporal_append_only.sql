-- Migration 0021 — enforce append-only on temporal_messages at the DB layer (D, #826).
--
-- 0020 gave both pro tables a single `for all` RLS policy. temporal_messages is
-- APPEND-ONLY by design (the client only ever inserts; a message's content is
-- never rewritten in place), but `for all` still PERMITTED an UPDATE — so a
-- direct-PostgREST client could rewrite its own stored conversation content
-- (self-harm only, but it contradicts the documented model and the versioned:false
-- + `(scope_id, updated_at)` pull-cursor assumptions). This closes that gap as
-- defense-in-depth (Sentry finding on #1240).
--
-- Enforcement is belt-and-suspenders:
--   1. REVOKE the UPDATE privilege from `authenticated` → a hard 42501 (not a
--      silent 0-row no-op) if anyone tries.
--   2. Replace the `for all` policy with explicit SELECT / INSERT / DELETE
--      policies (no UPDATE), so the policy set itself reflects append-only.
--
-- distillations is UNTOUCHED: it is versioned and legitimately UPDATEs (the
-- `archived` flip re-pushes), so it keeps its `for all` policy from 0020.
-- DELETE stays allowed (a user may purge their own backup — self-scoped, no tier
-- gate, matching 0020's behavior); the local prune is sync-invisible and the
-- server reaper handles remote lifecycle.

-- 1. Privilege-level hard deny of UPDATE.
revoke update on public.temporal_messages from authenticated;

-- 2. Policy set without UPDATE (idempotent: drop-then-create).
drop policy if exists temporal_messages_scope_all on public.temporal_messages;
drop policy if exists temporal_messages_scope_select on public.temporal_messages;
drop policy if exists temporal_messages_scope_insert on public.temporal_messages;
drop policy if exists temporal_messages_scope_delete on public.temporal_messages;

-- Reads open (a downgraded ex-pro can still PULL their backup).
create policy temporal_messages_scope_select on public.temporal_messages
  for select
  using (scope_id = auth.uid());

-- Writes: scope + author pinned to the caller AND pro tier required.
create policy temporal_messages_scope_insert on public.temporal_messages
  for insert
  with check (
    scope_id = auth.uid()
    and author_id = auth.uid()
    and public.current_tier() = 'pro'
  );

-- Self-purge allowed regardless of tier (matches 0020; no in-place rewrite path).
create policy temporal_messages_scope_delete on public.temporal_messages
  for delete
  using (scope_id = auth.uid());
