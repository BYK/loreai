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
  // Fresh credential clears staleness for this specific provider.
  // Also clear _default when a named provider refreshes, since _default
  // tracks the latest-used provider.
  clearProviderStale(sessionID, key);
  if (key !== "_default") clearProviderStale(sessionID, "_default");
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
  clearAuthStale(sessionID);
}

// ---------------------------------------------------------------------------
// Staleness tracking (per-session, per-provider)
// ---------------------------------------------------------------------------

/**
 * Per-session, per-provider staleness registry. Outer key is session ID,
 * inner set contains provider IDs whose credentials returned 401/403.
 *
 * Tracked separately from AuthCredential to keep the type clean (follows
 * batch-queue's `disabledBatchSessions` pattern). Not persisted — on
 * process restart, the first client request provides fresh credentials.
 * Cleared per-provider when `setSessionAuth()` stores a new credential.
 *
 * Per-provider granularity prevents cross-contamination: a 401 from
 * MiniMax should not poison the Anthropic credential for the same session.
 */
const staleSessionAuth = new Map<string, Set<string>>();

/**
 * Mark a session's credential as stale (401/403 received).
 *
 * @param providerID - When provided, only the specific provider's credential
 *   is marked stale. When omitted, marks the `_default` slot (backward compat).
 */
export function markAuthStale(sessionID: string, providerID?: string): void {
  let providers = staleSessionAuth.get(sessionID);
  if (!providers) {
    providers = new Set();
    staleSessionAuth.set(sessionID, providers);
  }
  providers.add(providerID || "_default");
  // Also mark _default stale when a named provider is marked, since
  // _default tracks the latest-used provider (mirrors setSessionAuth's
  // dual-clear on refresh). Without this, resolveAuth(sid) without
  // providerID would return the stale credential via _default.
  if (providerID && providerID !== "_default") providers.add("_default");
}

/**
 * Check if a session's credential is marked stale.
 *
 * @param providerID - When provided, checks only that provider. When omitted,
 *   returns true if ANY provider for the session is stale (used by idle.ts
 *   for session-level skip decisions).
 */
export function isAuthStale(sessionID: string, providerID?: string): boolean {
  const providers = staleSessionAuth.get(sessionID);
  if (!providers) return false;
  if (providerID) return providers.has(providerID);
  return providers.size > 0;
}

/** Clear staleness for a session (eviction cleanup). */
export function clearAuthStale(sessionID: string): void {
  staleSessionAuth.delete(sessionID);
}

/**
 * Clear staleness for a specific (session, provider) pair.
 * Called when `setSessionAuth()` stores a fresh credential.
 */
function clearProviderStale(sessionID: string, providerID: string): void {
  const providers = staleSessionAuth.get(sessionID);
  if (!providers) return;
  providers.delete(providerID);
  if (providers.size === 0) staleSessionAuth.delete(sessionID);
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
 *    Skips credentials whose specific provider is marked stale (401/403)
 *    so the global fallback can provide a potentially-refreshed token.
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
    // Check staleness for the specific provider being requested.
    // A stale MiniMax credential should NOT cause the Anthropic credential
    // to be skipped (or vice versa).
    const staleKey = providerID || "_default";
    if (cred && !isAuthStale(sessionID, staleKey)) return cred;

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

// Re-export for documentation — staleSessionAuth is Map<sessionID, Set<providerID>>.
// Invariant: markAuthStale(sid, pid) only poisons resolveAuth(sid, pid),
// NOT resolveAuth(sid, otherPid). Cross-provider credential poisoning is a bug.
