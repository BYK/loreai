/**
 * Anthropic OAuth usage/quota integration.
 *
 * Claude Pro/Max OAuth tokens have 5-hour and 7-day usage quotas that
 * Anthropic tracks server-side. This module queries the OAuth usage API
 * (`GET https://api.anthropic.com/api/oauth/usage`) to surface remaining
 * entitlement and feed it into Lore's throttle + worker-pause decisions.
 *
 * Applicability — Anthropic OAuth ONLY:
 *   - The endpoint is Anthropic-specific. A `scheme: "bearer"` credential is
 *     NOT sufficient: non-Anthropic providers (OpenAI-protocol, MiniMax,
 *     vLLM, etc.) also authenticate with `Authorization: Bearer`. Sending
 *     their tokens to api.anthropic.com would leak the token and 401/403.
 *   - The gate (`isAnthropicOAuthSession`) requires BOTH a bearer credential
 *     AND a Claude Code OAuth session (detected via cch.ts billing-header
 *     signal). API-key sessions and all non-Anthropic providers are no-ops.
 *
 * Caching is keyed by `authFingerprint(cred)` (per OAuth account), so multiple
 * sessions sharing one token share one quota entry and one API call. Two
 * layers prevent redundant calls:
 *   - In-flight memoization (per fingerprint): collapses concurrent duplicate
 *     requests for the SAME account into one underlying fetch.
 *   - Serial gate (global, ≥1s spacing): spaces calls across DIFFERENT
 *     accounts to minimize 429 risk (mirrors CortexKit's QuotaManager).
 */

import { log } from "@loreai/core";
import type { AuthCredential } from "./auth";
import { authFingerprint, resolveAuth } from "./auth";
import { runBackground } from "./background-limiter";
import { isClaudeCodeOAuthSession } from "./cch";
import { parseRetryAfter } from "./llm-adapter";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single usage window (5-hour or 7-day). */
export type QuotaWindow = {
  /** Utilization 0-100 (percent), clamped. */
  utilization: number;
  /** Epoch ms when this window resets, or null if unparseable. */
  resetsAt: number | null;
};

/** A point-in-time snapshot of an OAuth account's usage quotas. */
export type QuotaSnapshot = {
  fiveHour: QuotaWindow | null;
  sevenDay: QuotaWindow | null;
  /** Epoch ms when this snapshot was fetched. */
  fetchedAt: number;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const QUOTA_URL = "https://api.anthropic.com/api/oauth/usage";
const QUOTA_BETA = "oauth-2025-04-20";
const QUOTA_ANTHROPIC_VERSION = "2023-06-01";

/** Refresh quota at most once per 5 minutes per OAuth account. */
const QUOTA_FETCH_INTERVAL_MS = 5 * 60 * 1000;

/** Minimum gap between any two quota API calls (across all accounts). */
const QUOTA_SERIAL_GAP_MS = 1_000;

/** Request timeout for the quota endpoint. */
const QUOTA_FETCH_TIMEOUT_MS = 10_000;

/** 5h utilization (%) at/above which background workers are paused. */
const QUOTA_PAUSE_THRESHOLD = 95;

/** Utilization (%) below which there is no quota throttle pressure. */
const QUOTA_PRESSURE_FLOOR = 80;

// ---------------------------------------------------------------------------
// State (module-global)
// ---------------------------------------------------------------------------

/** Latest quota snapshot per OAuth account, keyed by authFingerprint. */
const quotaCache = new Map<string, QuotaSnapshot>();

/** Last fetch time (epoch ms) per fingerprint, for the 5-min cooldown. */
const quotaFetchCooldown = new Map<string, number>();

/** Fingerprints whose account is near exhaustion (workers paused). */
const quotaPausedFingerprints = new Set<string>();

/** In-flight fetches keyed by fingerprint (deduplicates concurrent requests). */
const inflight = new Map<string, Promise<QuotaSnapshot | null>>();

/** Serial gate: chained so calls are spaced ≥1s apart across accounts. */
let quotaFetchGate: Promise<void> = Promise.resolve();

// ---------------------------------------------------------------------------
// Parsing (defensive — tolerate schema variations)
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Parse a raw window object into a QuotaWindow, or null if unusable. */
function parseWindow(raw: unknown): QuotaWindow | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;

  const utilRaw = Number(obj.utilization);
  if (!Number.isFinite(utilRaw)) return null;
  const utilization = Math.min(100, Math.max(0, utilRaw));

  let resetsAt: number | null = null;
  if (typeof obj.resets_at === "string") {
    const parsed = Date.parse(obj.resets_at);
    if (!Number.isNaN(parsed)) resetsAt = parsed;
  }

  return { utilization, resetsAt };
}

/** Parse a raw API body into a QuotaSnapshot. Missing keys → null windows. */
function parseSnapshot(body: unknown): QuotaSnapshot {
  const obj =
    body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  return {
    fiveHour: parseWindow(obj.five_hour),
    sevenDay: parseWindow(obj.seven_day),
    fetchedAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

/**
 * Fetch a fresh quota snapshot for the given credential.
 *
 * Returns null for non-bearer credentials and for any expected failure
 * (429, 401/403, timeout, network error) — never throws. Expected failures
 * are logged at `warn` level only (not `error`) to avoid Sentry noise.
 *
 * The Anthropic-OAuth-session gate is applied by callers (`maybeFetchQuota`);
 * the bearer guard here is a type safety net.
 */
export async function fetchOAuthQuotaSnapshot(
  cred: AuthCredential,
): Promise<QuotaSnapshot | null> {
  if (cred.scheme !== "bearer") return null;

  // Serial gate: wait for the previous call to finish + a minimum spacing.
  const release = (() => {
    let resolveFn: () => void = () => {};
    const next = new Promise<void>((r) => {
      resolveFn = r;
    });
    const prev = quotaFetchGate;
    quotaFetchGate = prev.then(() => next);
    return { prev, done: resolveFn };
  })();
  await release.prev;

  try {
    const response = await fetch(QUOTA_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${cred.value}`,
        "anthropic-beta": QUOTA_BETA,
        "anthropic-version": QUOTA_ANTHROPIC_VERSION,
      },
      signal: AbortSignal.timeout(QUOTA_FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      if (response.status === 429) {
        const retryAfterMs = parseRetryAfter(response);
        log.warn(
          `quota: rate limited (429)${
            retryAfterMs != null ? `, retry-after ${retryAfterMs}ms` : ""
          }`,
        );
      } else {
        // 401/403 (token issue, handled by auth-staleness elsewhere) or other
        log.warn(`quota: fetch failed with status ${response.status}`);
      }
      return null;
    }

    const body = (await response.json()) as unknown;
    return parseSnapshot(body);
  } catch (err) {
    // Timeout / network / JSON parse — expected, non-fatal. Warn only.
    log.warn("quota: fetch error", err);
    return null;
  } finally {
    // Space out the next call by the serial gap, then release the gate.
    await sleep(QUOTA_SERIAL_GAP_MS);
    release.done();
  }
}

/**
 * In-flight-memoized fetch wrapper. Concurrent calls for the same fingerprint
 * join a single underlying request; the result is stored in `quotaCache`.
 */
export function fetchQuotaDeduped(
  cred: AuthCredential,
): Promise<QuotaSnapshot | null> {
  const fp = authFingerprint(cred);
  const existing = inflight.get(fp);
  if (existing) return existing;

  const p = fetchOAuthQuotaSnapshot(cred)
    .then((snap) => {
      if (snap) {
        quotaCache.set(fp, snap);
        // Update worker-pause state from the 5-hour window.
        const util = snap.fiveHour?.utilization ?? 0;
        if (util >= QUOTA_PAUSE_THRESHOLD) quotaPausedFingerprints.add(fp);
        else quotaPausedFingerprints.delete(fp);
      }
      return snap;
    })
    .finally(() => {
      inflight.delete(fp);
    });

  inflight.set(fp, p);
  return p;
}

// ---------------------------------------------------------------------------
// Applicability gate
// ---------------------------------------------------------------------------

/**
 * Whether a session should have its Anthropic OAuth quota tracked.
 *
 * Requires BOTH a bearer credential AND a Claude Code OAuth session (billing
 * header observed). Strictly excludes API-key sessions and all non-Anthropic
 * providers (a non-Anthropic bearer token never carries the billing header).
 */
export function isAnthropicOAuthSession(
  sessionID: string,
  cred?: AuthCredential | null,
): boolean {
  const c = cred ?? resolveAuth(sessionID);
  if (!c || c.scheme !== "bearer") return false;
  return isClaudeCodeOAuthSession(sessionID);
}

// ---------------------------------------------------------------------------
// Scheduling (called from the idle scheduler)
// ---------------------------------------------------------------------------

/**
 * Refresh quota for a session if due. No-op unless the session is a genuine
 * Anthropic OAuth session and the per-account 5-minute cooldown has elapsed.
 * Runs the fetch as background work (deduplicated per account).
 */
export function maybeFetchQuota(sessionID: string, cred: AuthCredential): void {
  if (!isAnthropicOAuthSession(sessionID, cred)) return;

  const fp = authFingerprint(cred);
  const now = Date.now();
  const last = quotaFetchCooldown.get(fp) ?? 0;
  if (now - last < QUOTA_FETCH_INTERVAL_MS) return;
  quotaFetchCooldown.set(fp, now);

  void runBackground(
    () => fetchQuotaDeduped(cred),
    `quota fp=${fp.slice(0, 8)}`,
  ).catch((err) => {
    log.warn("quota: background fetch failed", err);
  });
}

// ---------------------------------------------------------------------------
// Accessors
// ---------------------------------------------------------------------------

/** Get the cached quota snapshot for an account fingerprint, if any. */
export function getQuotaForFingerprint(fp: string): QuotaSnapshot | null {
  return quotaCache.get(fp) ?? null;
}

/** Get the cached quota snapshot for a credential, if any. */
export function getQuotaForCredential(
  cred: AuthCredential | null,
): QuotaSnapshot | null {
  if (!cred) return null;
  return getQuotaForFingerprint(authFingerprint(cred));
}

/** Whether background workers should be paused for this credential's account. */
export function isQuotaPaused(cred: AuthCredential | null): boolean {
  if (!cred) return false;
  return quotaPausedFingerprints.has(authFingerprint(cred));
}

// ---------------------------------------------------------------------------
// Throttle pressure
// ---------------------------------------------------------------------------

/**
 * Quota-derived throttle pressure in [0, 1].
 *
 * Uses the higher of the 5-hour and 7-day utilizations, ramping from 0 at the
 * QUOTA_PRESSURE_FLOOR (80%) to 1 at 100%. Below the floor there is no
 * quota-driven throttle.
 */
export function computeQuotaPressure(
  snapshot: QuotaSnapshot | null,
): number {
  if (!snapshot) return 0;
  const u5 = snapshot.fiveHour?.utilization ?? 0;
  const u7 = snapshot.sevenDay?.utilization ?? 0;
  const util = Math.max(u5, u7);
  if (util <= QUOTA_PRESSURE_FLOOR) return 0;
  const pressure = (util - QUOTA_PRESSURE_FLOOR) / (100 - QUOTA_PRESSURE_FLOOR);
  return Math.min(1, Math.max(0, pressure));
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

/** Drop all cached state for an account fingerprint (eviction GC). */
export function deleteQuotaForFingerprint(fp: string): void {
  quotaCache.delete(fp);
  quotaFetchCooldown.delete(fp);
  quotaPausedFingerprints.delete(fp);
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Reset all quota state — test-only. */
export function _resetQuotaForTest(): void {
  quotaCache.clear();
  quotaFetchCooldown.clear();
  quotaPausedFingerprints.clear();
  inflight.clear();
  quotaFetchGate = Promise.resolve();
}
