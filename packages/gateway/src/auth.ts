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

  const authHeader = headers["authorization"] || headers["Authorization"];
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

const sessionAuth = new Map<string, AuthCredential>();

export function setSessionAuth(sessionID: string, cred: AuthCredential): void {
  sessionAuth.set(sessionID, cred);
  staleSessionAuth.delete(sessionID); // Fresh credential clears staleness
}

export function getSessionAuth(sessionID: string): AuthCredential | null {
  return sessionAuth.get(sessionID) ?? null;
}

/** Delete a session's credential (for future eviction). */
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
 * Resolve auth credentials for a given session.
 *
 * 1. If `sessionID` is provided, check the per-session registry first.
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
export function resolveAuth(sessionID?: string): AuthCredential | null {
  if (sessionID) {
    const cred = getSessionAuth(sessionID);
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
