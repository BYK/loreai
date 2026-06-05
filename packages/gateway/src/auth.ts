/**
 * Gateway authentication: typed credentials, per-session registry, and
 * two-level lookup for background workers.
 *
 * Replaces the bare `lastSeenApiKey` string with a typed `AuthCredential`
 * that supports both API-key (`x-api-key`) and OAuth Bearer token
 * (`Authorization: Bearer`) authentication schemes.
 *
 * The per-session registry ensures background workers (distillation,
 * curation, batch queue) use the correct credential for their session
 * even when multiple clients are connected simultaneously.
 */

import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// AuthCredential type
// ---------------------------------------------------------------------------

/** Auth credential — either an API key or an OAuth bearer token. */
export type AuthCredential =
  | { scheme: "api-key"; value: string }
  | { scheme: "bearer"; value: string };

// ---------------------------------------------------------------------------
// Header extraction / formatting
// ---------------------------------------------------------------------------

/**
 * Extract auth from request headers.
 *
 * Prefers `x-api-key` (Anthropic SDK default), falls back to
 * `Authorization: Bearer` (OAuth / Claude Code subscriptions).
 * Returns `null` if neither is present.
 */
export function extractAuth(
  headers: Record<string, string>,
): AuthCredential | null {
  const apiKey = headers["x-api-key"] || headers["X-Api-Key"];
  if (apiKey) return { scheme: "api-key", value: apiKey };

  const authHeader = headers.authorization || headers.Authorization;
  if (authHeader) {
    const match = /^Bearer\s+(\S+)$/i.exec(authHeader);
    if (match) return { scheme: "bearer", value: match[1] };
  }

  return null;
}

/**
 * Format credential as the appropriate HTTP header(s).
 *
 * - `api-key` → `{ "x-api-key": value }`
 * - `bearer`  → `{ "Authorization": "Bearer <value>" }`
 */
export function authHeaders(cred: AuthCredential): Record<string, string> {
  switch (cred.scheme) {
    case "api-key":
      return { "x-api-key": cred.value };
    case "bearer":
      return { Authorization: `Bearer ${cred.value}` };
  }
}

/**
 * Privacy-safe credential fingerprint — SHA-256 of scheme + value, truncated
 * to 16 hex chars (64 bits).
 *
 * Used to differentiate sessions that share the same first message but use
 * different API keys or OAuth tokens. The scheme prefix prevents collisions
 * between an API key and a bearer token with the same value. Not reversible.
 */
export function authFingerprint(cred: AuthCredential): string {
  return createHash("sha256")
    .update(`${cred.scheme}|${cred.value}`)
    .digest("hex")
    .slice(0, 16);
}

// ---------------------------------------------------------------------------
// Per-session registry
// ---------------------------------------------------------------------------

/**
 * Per-session, per-provider credential registry. Outer key is Lore session ID,
 * inner key is provider ID (e.g. "anthropic", "minimax-coding-plan"). This
 * prevents cross-contamination when a user switches providers mid-conversation
 * within the same OpenCode session.
 */
const sessionAuth = new Map<string, Map<string, AuthCredential>>();

/**
 * Store a credential for a specific (session, provider) pair.
 *
 * @param providerID - Provider identifier. When omitted, falls back to
 *   the legacy `"_default"` key for backward compatibility with callers
 *   that don't yet track provider context.
 */
export function setSessionAuth(
  sessionID: string,
  cred: AuthCredential,
  providerID?: string,
): void {
  let byProvider = sessionAuth.get(sessionID);
  if (!byProvider) {
    byProvider = new Map();
    sessionAuth.set(sessionID, byProvider);
  }
  const key = providerID || "_default";
  byProvider.set(key, cred);
  // Also keep the _default slot in sync with the latest credential so
  // callers that don't pass a providerID still get a reasonable result.
  if (key !== "_default") byProvider.set("_default", cred);
  staleSessionAuth.delete(sessionID); // Fresh credential clears staleness
}

/**
 * Look up a credential for a session. When `providerID` is given, returns
 * the credential stored for that specific provider; otherwise returns the
 * most-recently-stored credential (the `_default` slot).
 */
export function getSessionAuth(
  sessionID: string,
  providerID?: string,
): AuthCredential | null {
  const byProvider = sessionAuth.get(sessionID);
  if (!byProvider) return null;
  if (providerID) {
    return byProvider.get(providerID) ?? byProvider.get("_default") ?? null;
  }
  return byProvider.get("_default") ?? null;
}

/** Delete a session's credentials (for eviction). */
export function deleteSessionAuth(sessionID: string): void {
  sessionAuth.delete(sessionID);
  staleSessionAuth.delete(sessionID);
}

// ---------------------------------------------------------------------------
// Staleness tracking (per-session)
// ---------------------------------------------------------------------------

/**
 * Session IDs whose stored credential returned a 401/403.
 *
 * Tracked separately from AuthCredential to keep the type clean (follows
 * batch-queue's `disabledBatchSessions` pattern). Not persisted — on
 * process restart, the first client request provides fresh credentials.
 * Cleared automatically when `setSessionAuth()` stores a new credential.
 */
const staleSessionAuth = new Set<string>();

/** Mark a session's credential as stale (401/403 received). */
export function markAuthStale(sessionID: string): void {
  staleSessionAuth.add(sessionID);
}

/** Check if a session's credential is marked stale. */
export function isAuthStale(sessionID: string): boolean {
  return staleSessionAuth.has(sessionID);
}

/** Clear staleness for a session (fresh credential arrived). */
export function clearAuthStale(sessionID: string): void {
  staleSessionAuth.delete(sessionID);
}

// ---------------------------------------------------------------------------
// Global fallback (replaces lastSeenApiKey)
// ---------------------------------------------------------------------------

let lastSeenAuth: AuthCredential | null = null;

export function setLastSeenAuth(cred: AuthCredential): void {
  lastSeenAuth = cred;
}

export function getLastSeenAuth(): AuthCredential | null {
  return lastSeenAuth;
}

// ---------------------------------------------------------------------------
// Two-level lookup
// ---------------------------------------------------------------------------

/**
 * Resolve auth credentials for a given session (and optionally a specific provider).
 *
 * 1. If `sessionID` is provided, check the per-session registry first.
 *    When `providerID` is also given, returns the credential stored for
 *    that specific provider — preventing cross-contamination when a session
 *    uses multiple providers (e.g. Anthropic + MiniMax).
 *    Skips stale credentials (401/403 received) so the global fallback
 *    can provide a potentially-refreshed token.
 * 2. Fall back to the global `lastSeenAuth` (for cold-start or callers
 *    that don't pass a session ID).
 * 3. If the global fallback holds the same value as the stale session
 *    credential, return `null` — the token is expired everywhere and
 *    retrying would just generate another 401. This prevents the
 *    background worker 401 storm in single-session OAuth setups where
 *    session and global credentials are the same expired token.
 */
export function resolveAuth(
  sessionID?: string,
  providerID?: string,
): AuthCredential | null {
  if (sessionID) {
    const cred = getSessionAuth(sessionID, providerID);
    if (cred && !staleSessionAuth.has(sessionID)) return cred;

    // Global fallback — but guard against returning the same stale token.
    // In single-session OAuth setups, session and global hold the exact
    // same expired bearer token. Returning it would cause callers to make
    // a request that immediately 401s again.
    const global = getLastSeenAuth();
    if (cred && global && global.value === cred.value) return null;
    return global;
  }
  return getLastSeenAuth();
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Reset all auth state — test-only. */
export function _resetAuthForTest(): void {
  sessionAuth.clear();
  staleSessionAuth.clear();
  lastSeenAuth = null;
}
