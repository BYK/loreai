-- Migration 0022 — remote mirror for the projects identity mapping (#1246, epic #821).
--
-- project_id is a random per-device UUID; git_remote is the ONLY stable cross-device
-- key. Syncing id→git_remote lets a pulled content row's FK parent (projects.id) exist
-- on any device, and lets a later local checkout ADOPT the pulled id via the client's
-- ensureProject git-remote match. This is a BASIC-tier table (syncs for every tier) —
-- no current_tier() gate (contrast 0020's pro tables).
--
--   projects  — VERSIONED (content_hash/revision): git_remote backfill + name edits are
--               real UPDATEs that must re-push. Keyed by id. ENCRYPTED columns:
--               git_remote, name (sealed on the wire — repo URLs never reach the server
--               in plaintext; correlation is entirely client-side). `path` is DEVICE-
--               LOCAL and is NEVER synced (not a column here). No local updated_at column
--               → the client never sends it; INSERT takes now(), UPDATE is server-stamped
--               by the trigger (makes the row re-pullable by peers).
--
-- Scope seam (0007): every row owned/billed/isolated by scope_id, authored by author_id,
-- both defaulted to auth.uid(); clients NEVER send them; RLS WITH CHECK pins both to the
-- writer. Lifecycle: bounded by the per-scope quota counter (§4-§6), NOT a TTL reaper.
-- The client never captures a projects DELETE (a local convergence merge deletes the
-- loser locally; the remote loser row + its content are left for the reaper).

-- ===========================================================================
-- 1. Table.
-- ===========================================================================
create table if not exists public.projects (
  scope_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  author_id    uuid not null default auth.uid(),
  id           text not null,
  git_remote   text,   -- encrypted on the wire (C-4); NULL for remote-less projects
  name         text,   -- encrypted on the wire (C-4)
  content_hash text,
  revision     integer not null default 0,
  is_deleted   boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (scope_id, id)
);

-- ===========================================================================
-- 2. Size CHECK (drop-then-add = idempotent). Anti-abuse backstop for a direct-
--    PostgREST client bypassing the gateway. Encrypted-column caps carry envelope/
--    base64 headroom over the short plaintext expectation (a git URL is < ~200 chars).
-- ===========================================================================
alter table public.projects drop constraint if exists projects_size_ck;
alter table public.projects add constraint projects_size_ck check (
  length(id) <= 64
  and (content_hash is null or length(content_hash) <= 64)
  and (git_remote is null or length(git_remote) <= 4096)
  and (name is null or length(name) <= 2048)
);

-- ===========================================================================
-- 3. updated_at trigger (the pull cursor), pull-cursor index, RLS. Basic tier: the
--    WITH CHECK pins scope_id + author_id to the writer, with NO tier gate.
-- ===========================================================================
drop trigger if exists projects_set_updated_at on public.projects;
create trigger projects_set_updated_at before update on public.projects
  for each row execute function public.sync_set_updated_at();

create index if not exists idx_projects_scope_updated
  on public.projects (scope_id, updated_at);

alter table public.projects enable row level security;
drop policy if exists projects_scope_all on public.projects;
create policy projects_scope_all on public.projects
  for all
  using (scope_id = auth.uid())
  with check (scope_id = auth.uid() and author_id = auth.uid());

-- ===========================================================================
-- 4. DML grants so PostgREST works (RLS still enforces ownership).
-- ===========================================================================
grant select, insert, update, delete on public.projects to authenticated;

-- ===========================================================================
-- 5. plan_limits: BOTH free and pro (basic-tier table). Projects are low-volume (one
--    per repo); caps are generous anti-abuse backstops.
-- ===========================================================================
insert into public.plan_limits (tier, table_name, max_rows, max_bytes) values
  ('free', 'projects', 1000,  1048576),   -- 1 MB
  ('pro',  'projects', 10000, 8388608)    -- 8 MB
on conflict (tier, table_name) do update
  set max_rows = excluded.max_rows, max_bytes = excluded.max_bytes;

-- ===========================================================================
-- 6. Attach the shared quota triggers. projects is (scope_id, id)-keyed, so the 0009
--    enforce_row_quota GENERIC branch already fits — no new elsif. maintain_usage /
--    usage_row_bytes (0007) are generic over scope_id + to_jsonb.
-- ===========================================================================
drop trigger if exists projects_row_quota on public.projects;
create trigger projects_row_quota before insert or update on public.projects
  for each row execute function public.enforce_row_quota();

drop trigger if exists projects_maintain_usage on public.projects;
create trigger projects_maintain_usage after insert or update or delete on public.projects
  for each row execute function public.maintain_usage();

-- ===========================================================================
-- 7. Backfill the usage counter (none on first apply; kept for idempotent re-apply).
-- ===========================================================================
insert into public.user_table_usage (scope_id, table_name, row_count, byte_count)
select scope_id, 'projects',
       count(*),
       coalesce(sum(public.usage_row_bytes(to_jsonb(x))), 0)
  from public.projects x
 group by scope_id
on conflict (scope_id, table_name) do update
  set row_count = excluded.row_count, byte_count = excluded.byte_count;
