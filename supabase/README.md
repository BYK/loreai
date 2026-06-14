# Folk Lore — Supabase backend

This directory holds the remote schema for Folk Lore's cloud features (Phase 1+
of the multi-DB sync architecture — see
[#467](https://github.com/BYK/loreai/issues/467)).

**Architecture:** a single shared multi-tenant Postgres isolated by **Row-Level
Security** (each row scoped to its owner via `auth.uid()` — e.g. `profiles.id =
auth.uid()` here; future sync tables use an `owner_user_id` column), not a
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
  auto-provision trigger on `auth.users` insert. **Accounts only**; the sync
  tables (knowledge / entities / …) land in a later migration.

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
