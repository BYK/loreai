-- Migration 0020 — remote mirror for the Pro tier: distillations + the
-- distillation-referenced subset of temporal_messages (epic #821 piece D, #826).
--
-- These back up + cross-device sync a Pro user's compressed conversation memory,
-- ENCRYPTED (C-4 envelope; the client seals the content columns before push, so
-- Postgres only ever stores ciphertext) and TIER-GATED to pro. The client half
-- (metas, distillation-driven capture, subset-aware seed, prune-as-eviction) lands
-- in a follow-up; until then these tables just sit empty (nothing pushes yet).
--
--   distillations       — VERSIONED (content_hash/revision): the `archived` flip is
--                         a real UPDATE that must re-push. Keyed by id. Encrypted
--                         columns: narrative, facts, observations (sealed on the
--                         wire). `source_ids` stays cleartext — it is only id
--                         references (like FKs), needed for the client's subset
--                         capture, and carries no conversation content.
--   temporal_messages   — APPEND-ONLY (versioned:false, no content_hash/revision):
--                         rows are only ever inserted, never updated or tombstoned.
--                         Keyed by id. Encrypted columns: content, metadata (raw
--                         conversation). The LOCAL `distilled` residency flag is
--                         NOT mirrored (it is per-device cache state).
--
-- Scope seam (0007): every row owned/billed/isolated by scope_id, authored by
-- author_id, both defaulted to auth.uid(). Clients NEVER send them; RLS WITH CHECK
-- pins both to the writer AND additionally requires the pro tier (see §3).
--
-- Lifecycle (epic decisions #1/#2/#3): the remote is bounded by the per-scope
-- quota counter (§5-§7), NOT a TTL reaper. The client's local prune is
-- sync-invisible (clears sync_state under capture-suppression, never a tombstone),
-- so a pruned local row does not delete the remote backup. No is_deleted reaper
-- participation is needed here (temporal never tombstones; distillations archive-
-- flip is an UPDATE, not a delete).

-- ===========================================================================
-- 1. Tier gate function. current_tier() reads the caller's own plan tier from the
--    profiles mirror. SECURITY DEFINER so it bypasses profiles RLS to read the one
--    row it is scoped to (id = auth.uid()); STABLE (one value per statement).
--    Used by the RLS WITH CHECK below so only paid users can WRITE pro tables;
--    reads stay open so a downgraded ex-pro user can still pull their backup.
-- ===========================================================================
create or replace function public.current_tier()
returns text
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select coalesce(
    (select tier from public.profiles where id = auth.uid()),
    'free'
  );
$$;

grant execute on function public.current_tier() to authenticated;

-- ===========================================================================
-- 2. Tables.
-- ===========================================================================
create table if not exists public.distillations (
  scope_id           uuid not null default auth.uid() references auth.users (id) on delete cascade,
  author_id          uuid not null default auth.uid(),
  id                 text not null,
  project_id         text,
  session_id         text,
  narrative          text,   -- encrypted on the wire (C-4)
  facts              text,   -- encrypted on the wire
  observations       text,   -- encrypted on the wire
  source_ids         text,   -- cleartext: JSON array of temporal_messages.id refs
  generation         integer not null default 0,
  token_count        integer not null default 0,
  r_compression      double precision,
  c_norm             double precision,
  call_type          text,
  worker_provider_id text,
  worker_model_id    text,
  archived           boolean not null default false, -- the archived flip is a versioned UPDATE → re-pushes
  content_hash       text,
  revision           integer not null default 0,
  is_deleted         boolean not null default false,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  primary key (scope_id, id)
);

create table if not exists public.temporal_messages (
  scope_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  author_id   uuid not null default auth.uid(),
  id          text not null,
  project_id  text,
  session_id  text,
  role        text,
  content     text,   -- encrypted on the wire (C-4)
  tokens      integer not null default 0,
  metadata    text,   -- encrypted on the wire (raw per-message context)
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (scope_id, id)
);

-- ===========================================================================
-- 3. Size + numeric CHECK constraints (drop-then-add = idempotent). Anti-abuse
--    backstop for a direct-PostgREST client bypassing the gateway; the row/byte
--    quota (§5-§7) is the primary bound. Encrypted-column caps carry ~1.5×
--    base64/envelope headroom over the plaintext expectation (cf. 0011).
-- ===========================================================================
alter table public.distillations drop constraint if exists distillations_size_ck;
alter table public.distillations add constraint distillations_size_ck check (
  length(id) <= 64
  and (content_hash is null or length(content_hash) <= 64)
  and (project_id is null or length(project_id) <= 128)
  and (session_id is null or length(session_id) <= 128)
  and (narrative is null or length(narrative) <= 262144)
  and (facts is null or length(facts) <= 262144)
  and (observations is null or length(observations) <= 262144)
  and (source_ids is null or length(source_ids) <= 131072)
  and (call_type is null or length(call_type) <= 64)
  and (worker_provider_id is null or length(worker_provider_id) <= 128)
  and (worker_model_id is null or length(worker_model_id) <= 128)
  and generation >= 0
  and token_count >= 0
);

alter table public.temporal_messages drop constraint if exists temporal_messages_size_ck;
alter table public.temporal_messages add constraint temporal_messages_size_ck check (
  length(id) <= 64
  and (project_id is null or length(project_id) <= 128)
  and (session_id is null or length(session_id) <= 128)
  and (role is null or length(role) <= 64)
  and (content is null or length(content) <= 1048576)
  and (metadata is null or length(metadata) <= 262144)
  and tokens >= 0
);

-- ===========================================================================
-- 4. updated_at trigger (the pull cursor), pull-cursor index, RLS. Mirrors 0009,
--    but the WITH CHECK adds the tier gate. Neither table has a LOCAL updated_at
--    column, so the client never sends it: INSERT takes the now() default; the
--    archived-flip UPDATE on distillations is server-stamped by the trigger, which
--    makes it re-pullable by peers. temporal_messages is never updated (the trigger
--    is inert there, kept for shape parity).
-- ===========================================================================
do $$
declare t text;
begin
  foreach t in array array['distillations', 'temporal_messages']
  loop
    execute format('drop trigger if exists %1$s_set_updated_at on public.%1$s', t);
    execute format(
      'create trigger %1$s_set_updated_at before update on public.%1$s
         for each row execute function public.sync_set_updated_at()', t);

    execute format(
      'create index if not exists idx_%1$s_scope_updated
         on public.%1$s (scope_id, updated_at)', t);

    execute format('alter table public.%1$s enable row level security', t);
    execute format('drop policy if exists %1$s_scope_all on public.%1$s', t);
    -- USING open (a downgraded ex-pro user can still PULL their backup); WITH CHECK
    -- pins scope_id + author_id to the writer AND requires the pro tier to WRITE.
    execute format(
      'create policy %1$s_scope_all on public.%1$s
         for all
         using (scope_id = auth.uid())
         with check (
           scope_id = auth.uid()
           and author_id = auth.uid()
           and public.current_tier() = ''pro''
         )', t);
  end loop;
end $$;

-- ===========================================================================
-- 5. DML grants so PostgREST works (RLS still enforces ownership + tier).
-- ===========================================================================
grant select, insert, update, delete
  on public.distillations, public.temporal_messages
  to authenticated;

-- ===========================================================================
-- 6. plan_limits: PRO rows only. There is deliberately NO 'free' row — the RLS tier
--    gate already denies free-tier writes (42501), so a free plan_limits row would
--    be dead. Caps are generous placeholders for a compressed-memory backup (tune).
-- ===========================================================================
insert into public.plan_limits (tier, table_name, max_rows, max_bytes) values
  ('pro', 'distillations',     200000, 268435456),   -- 256 MB
  ('pro', 'temporal_messages', 1000000, 536870912)   -- 512 MB
on conflict (tier, table_name) do update
  set max_rows = excluded.max_rows, max_bytes = excluded.max_bytes;

-- ===========================================================================
-- 7. Attach the shared quota triggers. Both tables are (scope_id, id)-keyed, so the
--    0009 enforce_row_quota GENERIC branch (probes scope_id + id) already fits — no
--    new elsif and no function redefinition needed. maintain_usage / usage_row_bytes
--    (0007) are generic over scope_id + to_jsonb.
-- ===========================================================================
do $$
declare t text;
begin
  foreach t in array array['distillations', 'temporal_messages']
  loop
    execute format('drop trigger if exists %1$s_row_quota on public.%1$s', t);
    execute format(
      'create trigger %1$s_row_quota before insert or update on public.%1$s
         for each row execute function public.enforce_row_quota()', t);

    execute format('drop trigger if exists %1$s_maintain_usage on public.%1$s', t);
    execute format(
      'create trigger %1$s_maintain_usage after insert or update or delete on public.%1$s
         for each row execute function public.maintain_usage()', t);
  end loop;
end $$;

-- ===========================================================================
-- 8. Backfill the usage counter (none on first apply; kept for idempotent re-apply).
--    Writes user_table_usage directly so the triggers above do not double-count.
-- ===========================================================================
do $$
declare t text;
begin
  foreach t in array array['distillations', 'temporal_messages']
  loop
    execute format($f$
      insert into public.user_table_usage (scope_id, table_name, row_count, byte_count)
      select scope_id, %1$L,
             count(*),
             coalesce(sum(public.usage_row_bytes(to_jsonb(x))), 0)
        from public.%1$I x
       group by scope_id
      on conflict (scope_id, table_name) do update
        set row_count = excluded.row_count, byte_count = excluded.byte_count
    $f$, t);
  end loop;
end $$;
