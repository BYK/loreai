# Folk Lore — Supabase backend

This directory holds the remote schema for Folk Lore's cloud features (Phase 1+
of the multi-DB sync architecture — see
[#467](https://github.com/BYK/loreai/issues/467)).

**Architecture:** a single shared multi-tenant Postgres isolated by **Row-Level
Security** (each row scoped to its owner via `auth.uid()` — e.g. `profiles.id =
auth.uid()` here; sync tables scope each row via a `scope_id` column), not a
database per user. The local
SQLite DB stays the source of truth on each machine; the gateway syncs rows over
HTTP via `@supabase/supabase-js`. Identity is Supabase Auth (GitHub OAuth +
email magic-link). The publishable (anon) key is safe to ship — RLS is the
security boundary.

## Project

| | |
|---|---|
| Project ref | `jlwxsrmvomocgngbxmcf` |
| URL | `https://jlwxsrmvomocgngbxmcf.supabase.co` |
| Region | `us-east-2` (Ohio) |
| Engine | Postgres (default), automatic-RLS on, Data API on, auto-expose off |

The gateway reads `SUPABASE_URL` / `SUPABASE_ANON_KEY` (build-time defaults,
env-overridable). Never commit the service-role key.

## Applying migrations

```bash
# one-time
supabase link --project-ref jlwxsrmvomocgngbxmcf
# apply everything in supabase/migrations
supabase db push
```

Migrations are plain SQL, applied in filename order:

- `0001_accounts.sql` — `public.profiles` (one row per auth user) + RLS +
  auto-provision trigger on `auth.users` insert.
- `0002_sync_basic.sql` — Basic-tier sync tables (`knowledge`, `entities`,
  `entity_aliases`, `entity_relations`, `knowledge_entity_refs`) mirroring the
  local SQLite schema, with `owner_user_id` (renamed to `scope_id` + `author_id`
  added in 0007)/`content_hash`/`revision`/`is_deleted`/server-stamped
  `updated_at`, RLS scoped to the owner, and per-owner+updated_at pull-cursor
  indexes.
- `0003_sync_limits.sql` — anti-abuse for the direct-PostgREST write model.
  Clients write to the REST API directly, so limits are enforced **in-DB**
  (RLS only governs ownership, not volume/size):
  - `profiles.tier` + a tunable `plan_limits(tier, table_name → max_rows)` table.
  - `BEFORE INSERT` quota trigger per table (free: knowledge ≤ 500, entities ≤
    30, aliases ≤ 300, relations ≤ 300, refs ≤ 2000; pro generous; null =
    unlimited). `SECURITY DEFINER` so it reads tier/limits past RLS.
  - `CHECK` constraints capping per-field size (title ≤ 512, content ≤ 8192, …).
  Per-request RATE limiting is intentionally deferred to an edge layer / hosted
  backend (paid tiers); these caps bound storage + cardinality + payload, which
  is what stops "sync my entire history" on the free tier. Distillations and raw
  conversation logs are paid-tier-only and are NOT in the Basic synced set.
- `0004_sync_hardening.sql` — security hardening (adversarial-review fixes):
  - **`profiles.tier` is not user-writable** — column-scoped `GRANT UPDATE
    (display_name, github_login, email)` (excludes `tier`) + a BEFORE UPDATE
    trigger rejecting any non-service-role `tier` change. (Otherwise a user
    could `PATCH /profiles {tier:'pro'}` and defeat all quotas.)
  - **Every user-controlled TEXT column is size-capped** (not just the obvious
    ones) — row-count caps alone don't bound storage; an uncapped column let a
    30-row user store 30×~1GB blobs.
  - **DML `GRANT`s to `authenticated`** so PostgREST actually works (RLS is the
    2nd gate; without a table grant every call is denied). Landed in the SAME
    migration as the tier lock so write-access never precedes the guard.
  - **Quota counts LIVE rows only and skips when the PK exists**, so an at-cap
    user can still UPDATE / soft-delete (incl. the deletes that free quota) via
    the `ON CONFLICT DO UPDATE` write path.

- `0005_sync_quota_hardening.sql` — quota TOCTOU fix (per-(user,table) advisory
  xact lock) + gate revival UPDATEs + cap the `id` column.
- `0006_tier_upgrade_path.sql` — `service_role` path to upgrade `profiles.tier`.
- `0007_scope_seam.sql` — the team/org **scope seam** + a maintained usage
  counter. Renames `owner_user_id` → `scope_id` (RLS/PK/billing axis) and adds
  `author_id` (who wrote it; v1 `= scope_id = auth.uid()`, both enforced by RLS
  `WITH CHECK`; `scope_id` immutable). Replaces the per-write `count(*)` quota
  with a trigger-maintained `user_table_usage(scope_id, table_name, row_count,
  byte_count)` counter (O(1), written only by `SECURITY DEFINER` triggers) and a
  `plan_limits.max_bytes` budget. Counting is **physical** (every row counts
  regardless of `is_deleted`) — abuse-proof and forward-compatible with the
  append-only knowledge model; a hard delete (reaper/compaction) frees footprint.

## Conflict resolution (last-writer-to-remote-wins)

The gateway syncs push-then-pull. When the same row was changed on two machines
before either pulled, the engine resolves **remote-wins**: the row already on the
server is kept, and the local edit is overwritten. To avoid silent data loss, the
discarded local row is preserved in the local `sync_conflicts` table
(`local_content` = JSON of the overwritten row), so a conflicting edit is
recoverable rather than destroyed. This is a deliberate, documented policy for the
Basic tier; richer merge strategies can come later.

## Dashboard configuration (one-time, not in code)

These live in the Supabase dashboard because they involve secrets:

1. **Authentication → Providers → GitHub**: enable, paste the GitHub OAuth App
   Client ID + secret. The GitHub OAuth App's *Authorization callback URL* must
   be `https://jlwxsrmvomocgngbxmcf.supabase.co/auth/v1/callback`.
2. **Authentication → Providers → Email**: enabled by default. The CLI uses a
   numeric OTP code (not a magic link — links are useless on a headless/remote
   box; the OTP length is configurable, commonly 6–8 digits). Edit **BOTH**
   email templates to include `{{ .Token }}` in the body:
   - **Email Templates → Confirm signup** (sent on a first-time email login)
   - **Email Templates → Magic Link** (sent to returning emails)

   Without `{{ .Token }}`, the user receives a `{{ .ConfirmationURL }}` link
   whose `?code=` is a PKCE code (not the OTP) — the CLI will reject it.
3. **Authentication → URL Configuration → Redirect URLs**: the CLI redirects to
   a loopback `…/callback` path, so the allow-list entries must be **path-aware
   wildcards** (Supabase treats `/` as a separator, so a bare `http://127.0.0.1`
   or `http://127.0.0.1:*` will NOT match `/callback`). Add:
   - `http://127.0.0.1:*/**` — browser flow (ephemeral port + `/callback`)
   - `http://127.0.0.1/**` — headless `--no-browser` flow (`http://127.0.0.1/callback`)

## Verifying

After `supabase db push` and a `lore login`, a row should appear in
`public.profiles` scoped to your `auth.uid()`, and a second account must not be
able to see it (RLS).
