-- Migration 0018: server-side tombstone reaper (#909)
--
-- Completes the append-only lifecycle (create -> update -> delete -> REAP). Soft-
-- deleted rows (is_deleted=true) stay physically on the remote and count toward the
-- per-scope row/byte quota (A1 physical accounting), so a heavy deleter can wedge their
-- own cap with dead tombstones. Content is already scrubbed to ''/null on delete (#897)
-- — only the row slot remains. This physically purges tombstones older than a retention
-- window and reclaims the slot.
--
-- The DELETEs fire the existing per-table `maintain_usage` AFTER-DELETE trigger, which
-- decrements the per-scope usage counters automatically — no accounting needed here.
--
-- CORRECTNESS (resurrection constraint, #909): a client offline longer than the
-- retention window could miss a deletion and, if it then modifies+pushes that stale
-- row, resurrect it. Age is measured from `updated_at` — the delete-push stamps it to
-- ~deletion time (client value on INSERT; `sync_set_updated_at` on the UPDATE path) —
-- and the default window (90 days) is chosen to exceed the expected client-offline
-- period. The robust alternative — a per-scope purge epoch that forces a stale-cursor
-- client to re-pull from scratch — is deferred as a follow-up. The client already can't
-- resurrect a synced-unchanged row: seedOutbox only enqueues rows whose content_hash
-- diverges from sync_state, so a reaped tombstone is never re-pushed.
--
-- This is a centralized SERVER task (pg_cron), never client-driven.

create or replace function public.reap_tombstones(retention_days integer default 90)
returns bigint
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  t      text;
  cutoff timestamptz := now() - make_interval(days => greatest(retention_days, 0));
  total  bigint := 0;
  n      bigint;
begin
  -- The knowledge + entity-graph tables (0002 base + 0009 meta) — each has is_deleted +
  -- updated_at. The keystore tables (account_escrow / scope_keys, 0010) also carry those
  -- columns but are intentionally EXCLUDED: they are single-row-per-scope in v1 (a
  -- delete+recreate is an upsert on the same PK, so no tombstones accumulate) and hold
  -- encryption-key state a background task must never delete. Revisit scope_keys for
  -- teams mode (multi-member could grow it multi-row).
  foreach t in array array[
    'knowledge', 'entities', 'entity_aliases', 'entity_relations',
    'knowledge_entity_refs', 'knowledge_meta', 'knowledge_meta_crdt'
  ] loop
    execute format(
      'delete from public.%I where is_deleted = true and updated_at < $1', t
    ) using cutoff;
    get diagnostics n = row_count;
    total := total + n;
  end loop;
  return total;
end;
$$;

-- System task only — a regular user must not be able to trigger a cross-scope reap
-- (the function is SECURITY DEFINER and bypasses RLS). pg_cron runs as the owner; a
-- service_role admin may invoke it manually.
revoke all on function public.reap_tombstones(integer) from public;
grant execute on function public.reap_tombstones(integer) to service_role;

-- Schedule a daily reap, but only where pg_cron exists (Supabase). The stock
-- postgres:16-alpine image the integration harness uses lacks it, so this whole block
-- is skipped there and the function is exercised by calling it directly in tests.
-- (The inner cron.* references are only parsed when the branch runs, so they don't
-- error when the cron schema is absent.)
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    if exists (select 1 from cron.job where jobname = 'reap-tombstones') then
      perform cron.unschedule('reap-tombstones');
    end if;
    perform cron.schedule(
      'reap-tombstones', '17 3 * * *', 'select public.reap_tombstones(90)'
    );
  end if;
end
$$;
