-- Migration 0034 — team-level promotion policy (E-5-F3, #827).
--
-- `promotion_policy` is the team scope's DEFAULT policy for whether a member's project knowledge
-- auto-promotes into this team scope (`auto`) or requires an explicit review first (`manual`,
-- the default — "never auto-promote to a team without review"). A project may override it
-- locally; the effective policy is `project.promotion_policy ?? scope.promotion_policy`.
--
-- Written only by team admins (via an RPC added in F3-2) / service_role; RLS already scopes SELECT
-- to members (0023 scopes_read = is_member), so it is pulled read-only into the client mirror.
alter table public.scopes
  add column if not exists promotion_policy text not null default 'manual'
    check (promotion_policy in ('manual', 'auto'));
