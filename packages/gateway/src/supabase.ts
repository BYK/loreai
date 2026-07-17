/**
 * Supabase client + auth-session persistence for Folk Lore individual accounts.
 *
 * The local SQLite DB stays the source of truth on each machine; the cloud
 * features (accounts now, sync later) talk to a single shared multi-tenant
 * Supabase Postgres isolated by Row-Level Security. Identity is Supabase Auth
 * (GitHub OAuth + email magic-link).
 *
 * Credentials policy:
 *  - SUPABASE_URL / SUPABASE_ANON_KEY are PUBLIC (publishable) values — safe to
 *    ship as build-time defaults; RLS is the real security boundary. Overridable
 *    via env for self-hosting / testing.
 *  - The user's auth session (access + refresh token) is persisted in the
 *    `team_config` table (see @loreai/core), NOT browser localStorage. It lives
 *    only on the user's machine.
 */

import {
  createClient,
  type Session,
  type SupabaseClient,
} from "@supabase/supabase-js";
import {
  deleteTeamConfig,
  getTeamConfig,
  setTeamConfig,
  syncData,
} from "@loreai/core";

/** Public project URL. Build-time default → Folk Lore's project; env override. */
export const SUPABASE_URL =
  process.env.SUPABASE_URL ?? "https://jlwxsrmvomocgngbxmcf.supabase.co";

/** Public (publishable/anon) key — safe to ship; RLS enforces access. */
export const SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY ??
  "sb_publishable_P7FJq3V-Sui53nkbPsdpYg_N0U6lyZi";

/** team_config key under which the auth session is persisted. */
const SESSION_KEY = "supabase.session";

/**
 * The persisted shape of an authenticated session. A trimmed projection of the
 * Supabase `Session` plus the cached profile identity for cheap `whoami`.
 */
export interface PersistedSession {
  access_token: string;
  refresh_token: string;
  /** Unix seconds when the access token expires (from Supabase). */
  expires_at?: number;
  user_id: string;
  email?: string | null;
  github_login?: string | null;
  display_name?: string | null;
}

// ---------------------------------------------------------------------------
// Session persistence (team_config)
// ---------------------------------------------------------------------------

/** Load the persisted session, or null if not logged in / unparsable. */
export function loadPersistedSession(): PersistedSession | null {
  const raw = getTeamConfig(SESSION_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as PersistedSession;
    if (!parsed?.access_token || !parsed?.refresh_token) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Persist (or replace) the auth session. */
export function persistSession(session: PersistedSession): void {
  const prev = loadPersistedSession();
  // Account switch (different user_id) — drop the previous user's pulled profile
  // mirror so currentTier() can't report the prior account's tier and the new
  // account's profile is re-pulled fresh. A token refresh (same user_id) keeps
  // the mirror intact.
  if (prev && prev.user_id !== session.user_id) {
    syncData.clearPullOnlyMirrors();
  }
  setTeamConfig(SESSION_KEY, JSON.stringify(session));
}

/** Remove any persisted session (logout). */
export function clearSession(): void {
  deleteTeamConfig(SESSION_KEY);
  // The mirrored plan tier is server-authoritative; it must not survive a
  // sign-out (otherwise currentTier() would keep reporting the logged-out
  // user's tier until a future login + pull).
  syncData.clearPullOnlyMirrors();
}

/** True when a session is persisted locally. Does NOT verify with the server. */
export function isLoggedIn(): boolean {
  return loadPersistedSession() !== null;
}

/**
 * Project a Supabase `Session` into our persisted shape, pulling the GitHub
 * handle / display name out of the OAuth identity metadata when present.
 * `prev` supplies fallbacks (e.g. on a token refresh where user is unchanged).
 */
export function sessionToPersisted(
  session: Session,
  prev?: Partial<PersistedSession>,
): PersistedSession {
  const meta = (session.user?.user_metadata ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string | undefined =>
    typeof v === "string" ? v : undefined;
  return {
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expires_at: session.expires_at,
    user_id: session.user?.id ?? prev?.user_id ?? "",
    email: session.user?.email ?? prev?.email ?? null,
    github_login:
      str(meta.user_name) ??
      str(meta.preferred_username) ??
      prev?.github_login ??
      null,
    display_name:
      str(meta.name) ?? str(meta.full_name) ?? prev?.display_name ?? null,
  };
}

// ---------------------------------------------------------------------------
// Client construction
// ---------------------------------------------------------------------------

/** Minimal in-memory storage adapter (Node has no localStorage). Holds the
 *  PKCE code verifier between signInWithOAuth() and exchangeCodeForSession()
 *  within a single CLI invocation. */
function memoryStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (key: string): string | null => m.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      m.set(key, value);
    },
    removeItem: (key: string): void => {
      m.delete(key);
    },
  };
}

/**
 * Construct a fresh Supabase client. We manage session persistence ourselves
 * (team_config), so the client's own persistence is in-memory and refresh is
 * manual. `flowType: "pkce"` is required for the CLI loopback OAuth flow.
 */
export function createSupabaseClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      flowType: "pkce",
      persistSession: true,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      storage: memoryStorage(),
    },
  });
}

/**
 * Build a SERVICE-ROLE client from the `SUPABASE_SERVICE_ROLE_KEY` env var — an
 * OPERATOR-ONLY escape hatch (e.g. `lore admin grant`) for privileged writes the
 * RLS/tier guards deliberately block for normal users. The key bypasses RLS and
 * is NEVER persisted or shipped: it is read from the environment at call time and
 * lives only in this in-memory client. Returns null when the env var is unset so
 * the caller can print a clear "operator-only" message rather than 401.
 *
 * SECURITY: this client BYPASSES RLS entirely. It is intentionally scoped to the
 * operator `lore admin` command (tier writes only). Any NEW caller is a security-
 * review trigger — do not use it to reach around RLS for ordinary features.
 */
export function getServiceRoleClient(): SupabaseClient | null {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) return null;
  return createClient(SUPABASE_URL, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}

/**
 * Build a client with the persisted session restored (and refreshed if the
 * access token expired). Re-persists the refreshed tokens. Returns null when
 * not logged in or the session could not be restored (expired refresh token,
 * revoked, etc.) — the caller decides whether to clear the stale session.
 */
export async function getAuthedClient(): Promise<SupabaseClient | null> {
  const persisted = loadPersistedSession();
  if (!persisted) return null;

  const client = createSupabaseClient();
  const { data, error } = await client.auth.setSession({
    access_token: persisted.access_token,
    refresh_token: persisted.refresh_token,
  });
  if (error || !data.session) return null;

  // setSession may have refreshed the tokens — persist the new values.
  persistSession(sessionToPersisted(data.session, persisted));
  return client;
}

/**
 * Return the current account identity. Cheap path returns the cached persisted
 * identity; when `verify` is set, round-trips to the server (auth + RLS check)
 * and returns null if the session is no longer valid.
 */
export async function getCurrentUser(
  opts: { verify?: boolean } = {},
): Promise<PersistedSession | null> {
  const persisted = loadPersistedSession();
  if (!persisted) return null;
  if (!opts.verify) return persisted;

  const client = await getAuthedClient();
  if (!client) return null;
  const { data, error } = await client.auth.getUser();
  if (error || !data.user) return null;
  return loadPersistedSession();
}
