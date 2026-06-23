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
import { log } from "@loreai/core";

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
  headers: Record<string, string> | null | undefined,
): AuthCredential | null {
  if (!headers) return null;

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
  // Only set _default when no explicit providerID was given (legacy callers).
  // When a named provider stores its credential (e.g. "minimax"), do NOT
  // overwrite _default — that causes cross-contamination: a MiniMax API key
  // stored as _default would be returned for Anthropic workers that resolve
  // auth without a providerID, causing 401 storms.
  // Fresh credential clears staleness for this specific provider.
  clearProviderStale(sessionID, key);
}

/**
 * Look up a credential for a session. When `providerID` is given, returns
 * ONLY the credential stored for that specific provider — never falls back
 * to `_default`. This prevents cross-contamination: a MiniMax key stored
 * under "minimax" must not be returned when "anthropic" is requested.
 *
 * When `providerID` is omitted, returns the `_default` slot (legacy callers
 * that don't track provider context).
 */
export function getSessionAuth(
  sessionID: string,
  providerID?: string,
): AuthCredential | null {
  const byProvider = sessionAuth.get(sessionID);
  if (!byProvider) return null;
  if (providerID) {
    const cred = byProvider.get(providerID) ?? null;
    // Diagnostic: an explicit-provider lookup MISS while the session holds
    // credentials under OTHER keys is the store-key vs lookup-key mismatch
    // footgun — the credential was stored under extractProviderHeader(...)
    // (pipeline) but the worker resolves by model.providerID. When they
    // disagree the worker silently gets null → no-auth, with no 401 to
    // explain it. Surface it (once per session+lookup-key) so it is never
    // silent. Stored keys include "_default" for header-less callers.
    if (cred === null && byProvider.size > 0) {
      warnAuthKeyMismatch(sessionID, providerID, [...byProvider.keys()]);
    }
    return cred;
  }
  return byProvider.get("_default") ?? null;
}

/** Dedup guard so the mismatch warning fires once per session+lookup-key. */
const warnedAuthKeyMismatch = new Set<string>();

function warnAuthKeyMismatch(
  sessionID: string,
  lookupKey: string,
  storedKeys: string[],
): void {
  const dedup = `${sessionID}:${lookupKey}`;
  if (warnedAuthKeyMismatch.has(dedup)) return;
  warnedAuthKeyMismatch.add(dedup);
  log.warn(
    `[auth] session=${sessionID.slice(0, 16)} worker lookup for provider ` +
      `"${lookupKey}" found no credential, but the session has credentials ` +
      `under [${storedKeys.join(", ")}]. Store-key vs lookup-key mismatch — ` +
      `background workers will get no-auth for this provider. The credential ` +
      `is stored under extractProviderHeader(req.rawHeaders); the worker ` +
      `resolves by model.providerID. These must agree.`,
  );
}

/** Delete a session's credentials (for eviction). */
export function deleteSessionAuth(sessionID: string): void {
  sessionAuth.delete(sessionID);
  clearAuthStale(sessionID);
  // Drop this session's mismatch-warning dedup entries so the set doesn't grow
  // unbounded over a long-lived gateway (keys are `${sessionID}:${lookupKey}`).
  const prefix = `${sessionID}:`;
  for (const key of warnedAuthKeyMismatch) {
    if (key.startsWith(prefix)) warnedAuthKeyMismatch.delete(key);
  }
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
  // Also mark _default stale when it currently holds the same credential
  // as the provider being marked. This prevents resolveAuth(sid) without
  // providerID from returning a stale credential via _default.
  // Only poisons _default when it actually points to the stale provider —
  // if another provider was set more recently, _default is left alone.
  if (providerID && providerID !== "_default") {
    const byProvider = sessionAuth.get(sessionID);
    const providerCred = byProvider?.get(providerID);
    const defaultCred = byProvider?.get("_default");
    if (
      providerCred &&
      defaultCred &&
      providerCred.value === defaultCred.value
    ) {
      providers.add("_default");
    }
  }
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

/**
 * Provider the global fallback credential was last captured for (the request's
 * `x-lore-provider`). `null` means unknown/agnostic — a legacy client that
 * sends no provider header. Used to stop a SPECIFIC-provider lookup from
 * borrowing a credential captured for a DIFFERENT provider (cross-contamination,
 * #829): a provider-A key handed to provider-B always 401s ("Incorrect API key").
 */
let lastSeenAuthProvider: string | null = null;

/**
 * When true, the global `lastSeenAuth` has been rejected by an upstream
 * provider (401/403) and no session-level credential refresh has cleared it.
 * Prevents session-less workers from hammering with a permanently-stale token.
 *
 * Reset when `setLastSeenAuth()` stores a fresh credential (a new client
 * request arrived with valid auth).
 */
let globalAuthStale = false;

export function setLastSeenAuth(
  cred: AuthCredential,
  providerID?: string,
): void {
  // A fresh credential clears global staleness — a new client request
  // arrived, so the token may be valid again.
  if (!lastSeenAuth || lastSeenAuth.value !== cred.value) {
    globalAuthStale = false;
  }
  lastSeenAuth = cred;
  lastSeenAuthProvider = providerID ?? null;
}

/**
 * Return the global fallback credential, or `null`.
 *
 * When `providerID` is given, the credential is returned ONLY if it was
 * captured for that same provider, or for an unknown/agnostic provider (a
 * legacy client that sent no `x-lore-provider` — kept working for single-
 * provider setups). A credential captured for a DIFFERENT known provider is
 * NEVER returned — that is the #829 cross-contamination (e.g. an Anthropic key
 * handed to an OpenAI worker, rejected as "Incorrect API key provided").
 */
export function getLastSeenAuth(providerID?: string): AuthCredential | null {
  if (globalAuthStale) return null;
  if (
    providerID &&
    lastSeenAuthProvider !== null &&
    lastSeenAuthProvider !== providerID
  ) {
    return null;
  }
  return lastSeenAuth;
}

/**
 * Mark the global fallback credential as stale. Called when a session-less
 * worker (no sessionID) receives a 401/403 — since there's no session to
 * attach staleness to, we mark the global credential directly.
 *
 * This prevents runaway 401 storms from session-less workers (e.g.
 * entity-rebuild) that would otherwise keep resolving the same expired
 * token on every retry.
 */
export function markGlobalAuthStale(): void {
  globalAuthStale = true;
}

/** Check if the global fallback is marked stale. */
export function isGlobalAuthStale(): boolean {
  return globalAuthStale;
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

    // CROSS-PROVIDER GUARD: when a SPECIFIC providerID is requested and this
    // session has no credential for it, do NOT borrow the global fallback —
    // it belongs to whatever provider the session authenticated with, NOT the
    // requested one. Returning it produces the exact production bug: a worker
    // configured for `minimax` borrows the session's Anthropic key and gets
    // sent off as a doomed cross-provider request (401 "invalid x-api-key"
    // loop). The global fallback is only safe for provider-agnostic callers
    // (no providerID) and for cold-start when the session genuinely has no
    // provider-specific store yet.
    if (providerID && !cred && sessionHasProviderStore(sessionID)) {
      return null;
    }

    // Global fallback — provider-aware (never borrows a different provider's
    // credential, #829) — and guarded against returning the same stale token.
    // In single-session OAuth setups, session and global hold the exact
    // same expired bearer token. Returning it would cause callers to make
    // a request that immediately 401s again.
    const global = getLastSeenAuth(providerID);
    if (cred && global && global.value === cred.value) return null;
    return global;
  }
  return getLastSeenAuth(providerID);
}

/**
 * Whether a session has any provider-specific credential stored (i.e. the
 * gateway has observed at least one real authenticated turn for it). Used by
 * `resolveAuth` to decide that a missing credential for a SPECIFIC provider is
 * a genuine "this provider isn't authenticated here" signal — not a cold-start
 * — so the global (foreign-provider) fallback must be suppressed.
 */
function sessionHasProviderStore(sessionID: string): boolean {
  const byProvider = sessionAuth.get(sessionID);
  if (!byProvider) return false;
  for (const key of byProvider.keys()) {
    if (key !== "_default") return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Reset all auth state — test-only. */
export function _resetAuthForTest(): void {
  sessionAuth.clear();
  staleSessionAuth.clear();
  warnedAuthKeyMismatch.clear();
  lastSeenAuth = null;
  lastSeenAuthProvider = null;
  globalAuthStale = false;
}

// Re-export for documentation — staleSessionAuth is Map<sessionID, Set<providerID>>.
// Invariant: markAuthStale(sid, pid) only poisons resolveAuth(sid, pid),
// NOT resolveAuth(sid, otherPid). Cross-provider credential poisoning is a bug.
