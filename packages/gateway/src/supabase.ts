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

import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
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
  db,
  withSavepoint,
  withTransaction,
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
const SESSION_REVISION_KEY = "supabase.session.revision";
const REFRESH_LEASE_KEY = "supabase.refresh.lease";
const REFRESH_LEASE_MS = 15_000;
export const SESSION_REFRESH_MARGIN_SECONDS = 60;

/** Temporary failures and concurrent login changes must never erase credentials. */
export class SessionUnavailableError extends Error {
  constructor(
    message = "Account service unavailable. Your saved login has been kept; retry shortly.",
  ) {
    super(message);
    this.name = "SessionUnavailableError";
  }
}

const restores = new Map<
  string,
  { promise: Promise<SupabaseClient | null>; controller: AbortController }
>();
let unavailableSessionKey: string | null = null;
const clientRevisions = new WeakMap<SupabaseClient, string>();

function sessionSnapshot(): { raw: string; revision: string | null } | null {
  return db()
    .query(
      "SELECT s.value AS raw, r.value AS revision FROM team_config s LEFT JOIN team_config r ON r.key = ? WHERE s.key = ?",
    )
    .get(SESSION_REVISION_KEY, SESSION_KEY) as {
    raw: string;
    revision: string | null;
  } | null;
}

function snapshotKey(snapshot: {
  raw: string;
  revision: string | null;
}): string {
  const session = parsePersistedSession(snapshot.raw);
  // Profile enrichment is not a new credential generation and must not
  // invalidate an in-flight rotation of the same refresh token.
  return JSON.stringify([
    snapshot.revision,
    session?.user_id,
    session?.access_token,
    session?.refresh_token,
    session?.expires_at,
  ]);
}

/** Read-only status for an expired token whose last restore was transiently unsuccessful. */
export function sessionRefreshUnavailable(): boolean {
  const snapshot = sessionSnapshot();
  return snapshot !== null && unavailableSessionKey === snapshotKey(snapshot);
}

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
  return parsePersistedSession(raw);
}

function parsePersistedSession(raw: string | null): PersistedSession | null {
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
export function persistSession(
  session: PersistedSession,
  expectedRevision?: string | null,
): string {
  const commit = () => {
    if (
      expectedRevision !== undefined &&
      getTeamConfig(SESSION_REVISION_KEY) !== expectedRevision
    )
      throw new SessionUnavailableError(
        "Active login changed while sign-in was in progress. Retry the request.",
      );
    const prev = loadPersistedSession();
    // Account switch (different user_id) — drop the previous user's pulled profile
    // mirror so currentTier() can't report the prior account's tier and the new
    // account's profile is re-pulled fresh. A token refresh (same user_id) keeps
    // the mirror intact.
    if (prev && prev.user_id !== session.user_id) {
      syncData.clearPullOnlyMirrors();
      clearProviderTokenCache();
    }
    setTeamConfig(SESSION_KEY, JSON.stringify(session));
    const revision = randomUUID();
    setTeamConfig(SESSION_REVISION_KEY, revision);
    unavailableSessionKey = null;
    return revision;
  };
  return expectedRevision === undefined
    ? withSavepoint("persist_account_session", commit)
    : withTransaction(commit);
}

/** Pin a login attempt before waiting for an OAuth/OTP response or user input. */
export function captureLoginRevision(requireAnonymous = false): string | null {
  return withTransaction(() => {
    if (requireAnonymous && loadPersistedSession())
      throw new SessionUnavailableError(
        "Active login changed. Sign out before starting another login.",
      );
    return getTeamConfig(SESSION_REVISION_KEY);
  });
}

/** Enrich only this login generation, preserving any concurrently rotated tokens. */
export function updateSessionProfile(
  revision: string,
  profile: Pick<PersistedSession, "email" | "github_login" | "display_name">,
): PersistedSession | null {
  return withTransaction(() => {
    if (getTeamConfig(SESSION_REVISION_KEY) !== revision) return null;
    const current = loadPersistedSession();
    if (!current) return null;
    const enriched = {
      ...current,
      email: profile.email ?? current.email,
      github_login: profile.github_login ?? current.github_login,
      display_name: profile.display_name ?? current.display_name,
    };
    setTeamConfig(SESSION_KEY, JSON.stringify(enriched));
    return enriched;
  });
}

/** Remove any persisted session (logout). */
export function clearSession(): void {
  withSavepoint("clear_account_session", () => {
    deleteTeamConfig(SESSION_KEY);
    // The mirrored plan tier is server-authoritative; it must not survive a
    // sign-out (otherwise currentTier() would keep reporting the logged-out
    // user's tier until a future login + pull).
    syncData.clearPullOnlyMirrors();
    clearProviderTokenCache();
    // Even re-login with identical credentials is a new login generation.
    setTeamConfig(SESSION_REVISION_KEY, randomUUID());
    unavailableSessionKey = null;
  });
}

/** True when a session is persisted locally. Does NOT verify with the server. */
export function isLoggedIn(): boolean {
  return loadPersistedSession() !== null;
}

// ---------------------------------------------------------------------------
// provider_token disk cache (E-5-d, #630) — short-lived, scoped to session
// ---------------------------------------------------------------------------

/**
 * The cached GitHub provider_token shape. The token is short-lived (GitHub
 * OAuth tokens via Supabase often expire in ~8h) and is persisted alongside the
 * Supabase access_token so that `lore team discover` within the expiry window
 * avoids re-prompting the OAuth dance.
 */
export interface CachedProviderToken {
  provider_token: string;
  expires_at: number; // unix seconds
}

/** team_config key under which the cached provider_token lives. */
const CACHED_PROVIDER_TOKEN_KEY = "github.provider_token";

/**
 * Load a previously cached GitHub provider_token, or null when expired / absent.
 * The token is scoped to the CURRENT Supabase session (access_token); a session
 * switch (login/logout/account change) naturally invalidates the cache because
 * clearSession() / persistSession-on-account-switch clear it.
 */
export function loadCachedProviderToken(): CachedProviderToken | null {
  const raw = getTeamConfig(CACHED_PROVIDER_TOKEN_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as CachedProviderToken;
    if (!parsed.provider_token || typeof parsed.expires_at !== "number")
      return null;
    // Expired — discard.
    if (Date.now() / 1000 >= parsed.expires_at) {
      deleteTeamConfig(CACHED_PROVIDER_TOKEN_KEY);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Persist the GitHub provider_token and its expiry. The expiry is derived from
 * `expires_in` (seconds from now) on the OAuth session if available, falling
 * back to a conservative 50-minute default for GitHub tokens that don't carry
 * an explicit expiry (the Supabase relay sets one on the provider_token when
 * the upstream GitHub response includes one; when it doesn't, we assume 1h and
 * shave 10min for clock skew).
 */
export function persistProviderTokenCache(
  providerToken: string,
  expiresIn?: number,
  revision?: string,
): void {
  const ttl = typeof expiresIn === "number" && expiresIn > 0 ? expiresIn : 3000; // default 50 min
  const entry: CachedProviderToken = {
    provider_token: providerToken,
    expires_at: Math.floor(Date.now() / 1000) + ttl,
  };
  withTransaction(() => {
    if (
      revision !== undefined &&
      getTeamConfig(SESSION_REVISION_KEY) !== revision
    )
      throw new SessionUnavailableError(
        "Active login changed while GitHub authorization was in progress.",
      );
    setTeamConfig(CACHED_PROVIDER_TOKEN_KEY, JSON.stringify(entry));
  });
}

/** Clear the cached provider_token — called on logout and account switch. */
export function clearProviderTokenCache(): void {
  deleteTeamConfig(CACHED_PROVIDER_TOKEN_KEY);
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
export function createSupabaseClient(
  signal?: () => AbortSignal | undefined,
  accessToken?: () => Promise<string>,
): SupabaseClient {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    ...(accessToken ? { accessToken } : {}),
    ...(signal
      ? {
          global: {
            fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
              const active = signal();
              // The SDK retries thrown fetch errors and 5xx responses with
              // uninterruptible backoff. Local scheduling owns retries; turn
              // temporary/aborted auth failures into a non-retryable SDK error.
              const unavailable = () =>
                Response.json(
                  { msg: "Account service unavailable" },
                  { status: 499 },
                );
              try {
                if (active?.aborted) return unavailable();
                const response = await fetch(input, {
                  ...init,
                  ...(active
                    ? {
                        signal: init?.signal
                          ? AbortSignal.any([active, init.signal])
                          : active,
                      }
                    : {}),
                });
                return active && response.status >= 500
                  ? unavailable()
                  : response;
              } catch (error) {
                if (active) return unavailable();
                throw error;
              }
            }) as typeof fetch,
          },
        }
      : {}),
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
 * access token is near expiry). Returns null for no session or an explicit
 * server rejection (clears that login only); temporary failures throw a safe
 * SessionUnavailableError and preserve credentials. A lifecycle signal cancels
 * shared authentication work but never limits the returned client's lifetime.
 */
export async function getAuthedClient(
  signal?: AbortSignal,
): Promise<SupabaseClient | null> {
  const snapshot = sessionSnapshot();
  const persisted = parsePersistedSession(snapshot?.raw ?? null);
  if (!persisted) return null;
  const { raw, revision } = snapshot!;
  const key = snapshotKey(snapshot!);
  const existing = restores.get(key);
  if (existing) {
    // A scheduler joining an on-demand restore still owns gateway shutdown.
    // Its lifecycle abort must cancel the shared operation whichever caller
    // started it first.
    const abort = () => existing.controller.abort();
    if (signal?.aborted) abort();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      return await existing.promise;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }
  // Shared by on-demand callers and the scheduler. A SQLite lease additionally
  // serializes CLI/gateway processes consuming the same rotating refresh token.
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  signal?.addEventListener("abort", abort, { once: true });
  const pending = restoreSession(persisted, raw, revision, controller.signal);
  const record = { promise: pending, controller };
  restores.set(key, record);
  try {
    return await pending;
  } finally {
    signal?.removeEventListener("abort", abort);
    if (restores.get(key) === record) restores.delete(key);
  }
}

function rejectedSession(error: {
  code?: string;
  status?: number;
  name?: string;
}): boolean {
  return (
    error.status !== undefined &&
    error.status >= 400 &&
    error.status < 500 &&
    (error.name === "AuthSessionMissingError" ||
      [
        "refresh_token_not_found",
        "refresh_token_already_used",
        "session_not_found",
        "user_not_found",
        "user_banned",
      ].includes(error.code ?? ""))
  );
}

async function restoreSession(
  persisted: PersistedSession,
  raw: string,
  revision: string | null,
  parentSignal?: AbortSignal,
): Promise<SupabaseClient | null> {
  const signal = parentSignal
    ? AbortSignal.any([parentSignal, AbortSignal.timeout(10_000)])
    : AbortSignal.timeout(10_000);
  const expectedKey = snapshotKey({ raw, revision });
  const sameSession = () => {
    const current = sessionSnapshot();
    return current !== null && snapshotKey(current) === expectedKey;
  };
  const changed = () =>
    new SessionUnavailableError(
      "Active login changed while authentication was in progress. Retry the request.",
    );
  const lease = JSON.stringify({
    owner: randomUUID(),
    expiresAt: Date.now() + REFRESH_LEASE_MS,
  });
  let owned = false;
  const releaseLease = () => {
    if (!owned) return;
    db()
      .query("DELETE FROM team_config WHERE key = ? AND value = ?")
      .run(REFRESH_LEASE_KEY, lease);
    owned = false;
  };
  // Release synchronously when shutdown aborts, while SQLite is still open.
  // A later SDK response only observes the aborted signal and cannot reopen it.
  parentSignal?.addEventListener("abort", releaseLease, { once: true });
  try {
    while (!owned) {
      signal.throwIfAborted();
      const acquired = withTransaction(() => {
        if (!sameSession()) {
          const next = sessionSnapshot();
          // A different process may have just rotated this login's tokens.
          // A login/logout changes the generation, so only rotation is retried.
          if (
            next?.revision === revision &&
            parsePersistedSession(next.raw)?.user_id === persisted.user_id
          )
            return "rotated" as const;
          throw changed();
        }
        const current = getTeamConfig(REFRESH_LEASE_KEY);
        if (current) {
          const held = JSON.parse(current) as { expiresAt: number };
          if (held.expiresAt > Date.now()) return false;
        }
        setTeamConfig(REFRESH_LEASE_KEY, lease);
        return true;
      });
      if (acquired === "rotated") return await getAuthedClient(signal);
      owned = acquired;
      if (!owned) await delay(50, undefined, { signal });
    }
    const client = createSupabaseClient(() => signal);
    const needsRefresh =
      persisted.expires_at !== undefined &&
      persisted.expires_at <=
        Date.now() / 1000 + SESSION_REFRESH_MARGIN_SECONDS;
    let result = needsRefresh
      ? await client.auth.refreshSession({
          refresh_token: persisted.refresh_token,
        })
      : await client.auth.setSession({
          access_token: persisted.access_token,
          refresh_token: persisted.refresh_token,
        });
    // An access-token rejection can still be recovered with the refresh token.
    if (
      !needsRefresh &&
      result.error?.status === 401 &&
      !rejectedSession(result.error)
    ) {
      result = await client.auth.refreshSession({
        refresh_token: persisted.refresh_token,
      });
    }
    signal.throwIfAborted();
    return withTransaction(() => {
      if (!sameSession() || getTeamConfig(REFRESH_LEASE_KEY) !== lease)
        throw changed();
      if (result.error && rejectedSession(result.error)) {
        clearSession();
        return null;
      }
      const session = result.data.session;
      if (
        result.error ||
        !session?.access_token ||
        !session.refresh_token ||
        session.user?.id !== persisted.user_id
      ) {
        unavailableSessionKey = snapshotKey({ raw, revision });
        throw new SessionUnavailableError();
      }
      const current = loadPersistedSession()!;
      const next = sessionToPersisted(session, current);
      for (const field of ["email", "github_login", "display_name"] as const) {
        if (current[field] !== persisted[field]) next[field] = current[field];
      }
      const nextRaw = JSON.stringify(next);
      setTeamConfig(SESSION_KEY, nextRaw);
      unavailableSessionKey = null;
      const dataClient = accountDataClient(revision, next);
      clientRevisions.set(dataClient, snapshotKey({ raw: nextRaw, revision }));
      return dataClient;
    });
  } catch (error) {
    if (!parentSignal?.aborted && sameSession())
      unavailableSessionKey = snapshotKey({ raw, revision });
    // Never expose provider error bodies or tokens through logs / CLI output.
    throw error instanceof SessionUnavailableError
      ? error
      : new SessionUnavailableError();
  } finally {
    parentSignal?.removeEventListener("abort", releaseLease);
    if (!parentSignal?.aborted) releaseLease();
  }
}

/**
 * Build a data client for an already authenticated login (restoration or fresh
 * OAuth). Data requests use the coordinator instead of the SDK's implicit
 * getSession refresh, and refuse another login's credentials. Auth methods
 * belong to the private auth client; this client serves REST/functions reads.
 */
export function accountDataClient(
  revision: string | null,
  initial: PersistedSession,
): SupabaseClient {
  let initialized = false;
  const read = () => {
    const current = sessionSnapshot();
    const session = parsePersistedSession(current?.raw ?? null);
    if (
      !session ||
      current?.revision !== revision ||
      session.user_id !== initial.user_id
    )
      throw new SessionUnavailableError(
        "Active login changed. Retry with the current account.",
      );
    return session;
  };
  const client = createSupabaseClient(undefined, async () => {
    let session = read();
    // The SDK eagerly requests a realtime token in its constructor. The
    // authenticated initial token is already restored; avoid recursive work.
    if (
      initialized &&
      session.expires_at !== undefined &&
      session.expires_at <= Date.now() / 1000 + SESSION_REFRESH_MARGIN_SECONDS
    ) {
      if (!(await getAuthedClient())) throw new SessionUnavailableError();
      session = read();
    }
    return session.access_token;
  });
  initialized = true;
  return client;
}

/**
 * Return the current account identity. Cheap path returns the cached persisted
 * identity while the access token is valid; expired tokens are restored first.
 * `verify` additionally checks the server identity, with temporary failures
 * reported separately from an explicitly rejected login.
 */
export async function getCurrentUser(
  opts: { verify?: boolean } = {},
): Promise<PersistedSession | null> {
  const persisted = loadPersistedSession();
  if (!persisted) return null;
  if (
    !opts.verify &&
    (persisted.expires_at === undefined ||
      persisted.expires_at > Date.now() / 1000)
  )
    return persisted;

  const client = await getAuthedClient();
  if (!client) return null;
  const restoredSnapshot = sessionSnapshot();
  const restored = parsePersistedSession(restoredSnapshot?.raw ?? null);
  if (
    !restored ||
    restored.user_id !== persisted.user_id ||
    !restoredSnapshot ||
    clientRevisions.get(client) !== snapshotKey(restoredSnapshot)
  )
    throw new SessionUnavailableError(
      "Active login changed while authentication was in progress. Retry the request.",
    );
  if (!opts.verify) return restored;
  const deadline = AbortSignal.timeout(10_000);
  const verifier = createSupabaseClient(() => deadline);
  const { data, error } = await verifier.auth.getUser(restored.access_token);
  return withTransaction(() => {
    const verifiedSnapshot = sessionSnapshot();
    if (
      !verifiedSnapshot ||
      snapshotKey(verifiedSnapshot) !== snapshotKey(restoredSnapshot)
    )
      throw new SessionUnavailableError(
        "Active login changed while authentication was in progress. Retry the request.",
      );
    if (error && rejectedSession(error)) {
      clearSession();
      return null;
    }
    if (error || !data.user || data.user.id !== restored.user_id)
      throw new SessionUnavailableError();
    return parsePersistedSession(verifiedSnapshot.raw);
  });
}
