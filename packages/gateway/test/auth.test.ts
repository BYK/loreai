import { describe, test, expect, beforeEach, vi } from "vitest";
import { log } from "@loreai/core";
import {
  extractAuth,
  setSessionAuth,
  getSessionAuth,
  deleteSessionAuth,
  setLastSeenAuth,
  resolveAuth,
  markAuthStale,
  isAuthStale,
  clearAuthStale,
  markGlobalAuthStale,
  isGlobalAuthStale,
  _resetAuthForTest,
  workerKeyScheme,
  type AuthCredential,
} from "../src/auth";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  _resetAuthForTest();
});

const bearerCred: AuthCredential = {
  scheme: "bearer",
  value: "tok-session-abc",
};
const bearerCred2: AuthCredential = {
  scheme: "bearer",
  value: "tok-session-xyz",
};
const apiKeyCred: AuthCredential = { scheme: "api-key", value: "sk-test-key" };
const minimaxCred: AuthCredential = {
  scheme: "api-key",
  value: "sk-cp-minimax-key",
};

// ---------------------------------------------------------------------------
// Header extraction
// ---------------------------------------------------------------------------

describe("extractAuth", () => {
  test("extracts x-api-key as api-key credential", () => {
    expect(extractAuth({ "x-api-key": "sk-123" })).toEqual({
      scheme: "api-key",
      value: "sk-123",
    });
  });

  test("extracts Bearer token as bearer credential", () => {
    expect(extractAuth({ authorization: "Bearer tok-abc" })).toEqual({
      scheme: "bearer",
      value: "tok-abc",
    });
  });

  test("returns null when no auth headers present", () => {
    expect(extractAuth({})).toBeNull();
  });

  // Regression: a fuzzer (/opt/audit/fuzz-exports.js) called extractAuth()
  // with undefined, triggering "Cannot read properties of undefined
  // (reading 'x-api-key')" (Sentry LOREAI-GATEWAY-28). Guard returns null.
  test("returns null for null/undefined headers instead of throwing", () => {
    expect(extractAuth(null)).toBeNull();
    expect(extractAuth(undefined)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Staleness tracking
// ---------------------------------------------------------------------------

describe("markAuthStale / isAuthStale", () => {
  test("session is not stale by default", () => {
    expect(isAuthStale("sess-1")).toBe(false);
  });

  test("marks a session as stale (no providerID → _default)", () => {
    markAuthStale("sess-1");
    expect(isAuthStale("sess-1")).toBe(true);
  });

  test("staleness is per-session", () => {
    markAuthStale("sess-1");
    expect(isAuthStale("sess-1")).toBe(true);
    expect(isAuthStale("sess-2")).toBe(false);
  });

  test("marking stale is idempotent", () => {
    markAuthStale("sess-1");
    markAuthStale("sess-1");
    expect(isAuthStale("sess-1")).toBe(true);
  });

  test("staleness is per-provider within a session", () => {
    markAuthStale("sess-1", "minimax");
    // Session-level: any provider stale → true
    expect(isAuthStale("sess-1")).toBe(true);
    // Provider-level: only minimax is stale
    expect(isAuthStale("sess-1", "minimax")).toBe(true);
    expect(isAuthStale("sess-1", "anthropic")).toBe(false);
  });

  test("multiple providers can be stale independently", () => {
    markAuthStale("sess-1", "minimax");
    markAuthStale("sess-1", "anthropic");
    expect(isAuthStale("sess-1", "minimax")).toBe(true);
    expect(isAuthStale("sess-1", "anthropic")).toBe(true);
    expect(isAuthStale("sess-1", "openai")).toBe(false);
    expect(isAuthStale("sess-1")).toBe(true);
  });
});

describe("clearAuthStale", () => {
  test("clears staleness for a session", () => {
    markAuthStale("sess-1");
    expect(isAuthStale("sess-1")).toBe(true);
    clearAuthStale("sess-1");
    expect(isAuthStale("sess-1")).toBe(false);
  });

  test("clears all providers for a session", () => {
    markAuthStale("sess-1", "minimax");
    markAuthStale("sess-1", "anthropic");
    clearAuthStale("sess-1");
    expect(isAuthStale("sess-1")).toBe(false);
    expect(isAuthStale("sess-1", "minimax")).toBe(false);
    expect(isAuthStale("sess-1", "anthropic")).toBe(false);
  });

  test("clearing a non-stale session is a no-op", () => {
    clearAuthStale("sess-1");
    expect(isAuthStale("sess-1")).toBe(false);
  });
});

describe("getSessionAuth store-key vs lookup-key mismatch warning", () => {
  test("warns once when explicit-provider lookup misses but other keys exist", () => {
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});
    try {
      // Credential stored under "_default" (header-less store) ...
      setSessionAuth("sess-mismatch", bearerCred);
      // ... but the worker looks it up by an explicit provider it doesn't match.
      expect(getSessionAuth("sess-mismatch", "opencode")).toBeNull();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]?.[0]).toContain("opencode");
      // Deduped: a second identical miss does not re-warn.
      expect(getSessionAuth("sess-mismatch", "opencode")).toBeNull();
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("does NOT warn when the explicit-provider lookup hits", () => {
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});
    try {
      setSessionAuth("sess-ok", bearerCred, "opencode");
      expect(getSessionAuth("sess-ok", "opencode")).toEqual(bearerCred);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("does NOT warn when the session has no credentials at all", () => {
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});
    try {
      expect(getSessionAuth("sess-empty", "opencode")).toBeNull();
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("setSessionAuth clears staleness", () => {
  test("setting a new credential clears staleness", () => {
    setSessionAuth("sess-1", bearerCred);
    markAuthStale("sess-1");
    expect(isAuthStale("sess-1")).toBe(true);

    // Setting a new credential should clear staleness
    setSessionAuth("sess-1", bearerCred2);
    expect(isAuthStale("sess-1")).toBe(false);
  });

  test("setting credential for one provider clears only that provider", () => {
    setSessionAuth("sess-1", bearerCred, "anthropic");
    setSessionAuth("sess-1", minimaxCred, "minimax");
    markAuthStale("sess-1", "anthropic");
    markAuthStale("sess-1", "minimax");

    // Refresh only anthropic
    setSessionAuth("sess-1", bearerCred2, "anthropic");
    expect(isAuthStale("sess-1", "anthropic")).toBe(false);
    // minimax should still be stale
    expect(isAuthStale("sess-1", "minimax")).toBe(true);
    // Session-level: still stale (minimax)
    expect(isAuthStale("sess-1")).toBe(true);
  });
});

describe("deleteSessionAuth clears staleness", () => {
  test("deleting a session credential also clears staleness", () => {
    setSessionAuth("sess-1", bearerCred);
    markAuthStale("sess-1");
    expect(isAuthStale("sess-1")).toBe(true);

    deleteSessionAuth("sess-1");
    expect(isAuthStale("sess-1")).toBe(false);
    expect(getSessionAuth("sess-1")).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// resolveAuth with staleness
// ---------------------------------------------------------------------------

describe("resolveAuth with staleness", () => {
  test("returns session credential when not stale", () => {
    setSessionAuth("sess-1", bearerCred);
    setLastSeenAuth(apiKeyCred);

    const result = resolveAuth("sess-1");
    expect(result).toEqual(bearerCred);
  });

  test("skips stale session credential and falls through to global", () => {
    setSessionAuth("sess-1", bearerCred);
    setLastSeenAuth(apiKeyCred);
    markAuthStale("sess-1");

    const result = resolveAuth("sess-1");
    // Should skip the stale session credential and return global
    expect(result).toEqual(apiKeyCred);
  });

  test("returns null when session is stale and no global set", () => {
    setSessionAuth("sess-1", bearerCred);
    markAuthStale("sess-1");

    const result = resolveAuth("sess-1");
    expect(result).toBe(null);
  });

  test("returns global when no session ID provided", () => {
    setLastSeenAuth(apiKeyCred);

    const result = resolveAuth();
    expect(result).toEqual(apiKeyCred);
  });

  test("returns null when no credentials at all", () => {
    const result = resolveAuth("sess-1");
    expect(result).toBe(null);
  });

  test("returns null when stale session and global hold the same token", () => {
    // Single-session OAuth setup: session and global have the same expired token
    setSessionAuth("sess-1", bearerCred);
    setLastSeenAuth(bearerCred);
    markAuthStale("sess-1");

    // Global fallback has the same value as the stale session credential —
    // returning it would cause another 401, so resolveAuth returns null
    expect(resolveAuth("sess-1")).toBe(null);
  });

  test("returns global when stale session and global hold different tokens", () => {
    // Multi-session setup: another client refreshed the global credential
    setSessionAuth("sess-1", bearerCred);
    setLastSeenAuth(bearerCred2);
    markAuthStale("sess-1");

    // Global has a different (potentially fresh) token — return it
    expect(resolveAuth("sess-1")).toEqual(bearerCred2);
  });

  // -------------------------------------------------------------------------
  // Cross-provider fallback guard (production 401-loop regression)
  // -------------------------------------------------------------------------

  test("does NOT borrow the global credential for a provider the session never authenticated", () => {
    // Session authenticated ONLY with Anthropic (stored under "anthropic").
    setSessionAuth("sess-1", apiKeyCred, "anthropic");
    // Global fallback holds that same Anthropic key.
    setLastSeenAuth(apiKeyCred);

    // A worker configured for "minimax" must NOT get the Anthropic key — that
    // produced the production cross-provider 401 loop. Fail closed (null).
    expect(resolveAuth("sess-1", "minimax")).toBe(null);
    // The legitimate provider still resolves correctly.
    expect(resolveAuth("sess-1", "anthropic")).toEqual(apiKeyCred);
  });

  test("returns the provider's own credential when the session has it", () => {
    setSessionAuth("sess-1", apiKeyCred, "anthropic");
    setSessionAuth("sess-1", minimaxCred, "minimax");
    setLastSeenAuth(apiKeyCred);

    expect(resolveAuth("sess-1", "minimax")).toEqual(minimaxCred);
    expect(resolveAuth("sess-1", "anthropic")).toEqual(apiKeyCred);
  });

  test("still allows global fallback for cold-start sessions with no provider store", () => {
    // No setSessionAuth at all — a cold-start worker before the first turn's
    // credential was registered. The global fallback is still legitimate here.
    setLastSeenAuth(apiKeyCred);
    expect(resolveAuth("sess-cold", "anthropic")).toEqual(apiKeyCred);
  });

  // -------------------------------------------------------------------------
  // Provider-aware global fallback (#829 cross-contamination)
  //
  // The global fallback is captured WITH the request's provider tag. A lookup
  // for a DIFFERENT known provider must never receive it — handing an Anthropic
  // key to an OpenAI worker is rejected upstream as "Incorrect API key
  // provided", which is the persistent 401 reported in #829.
  // -------------------------------------------------------------------------

  test("does NOT borrow a provider-tagged global credential for a different provider (#829)", () => {
    // An Anthropic foreground request captured the global, tagged "anthropic".
    setLastSeenAuth(apiKeyCred, "anthropic");

    // A session-less OpenAI worker must NOT receive the Anthropic key.
    expect(resolveAuth(undefined, "openai")).toBe(null);
    // The matching provider still resolves via the global.
    expect(resolveAuth(undefined, "anthropic")).toEqual(apiKeyCred);
    // A provider-agnostic caller still gets the global.
    expect(resolveAuth(undefined)).toEqual(apiKeyCred);
  });

  test("a _default-only session does not leak a cross-provider global (#829)", () => {
    // Foreground request arrived WITHOUT x-lore-provider → stored under
    // _default — while the global was tagged with the real provider. A
    // _default store does not satisfy a specific-provider lookup, and
    // sessionHasProviderStore() is false, so the 359 guard cannot fire: the
    // provider-aware global is the only thing standing between the OpenAI
    // worker and the Anthropic key.
    setSessionAuth("sess-1", apiKeyCred); // no providerID → _default
    setLastSeenAuth(apiKeyCred, "anthropic");

    expect(resolveAuth("sess-1", "openai")).toBe(null);
    // The captured provider still resolves through the global fallback.
    expect(resolveAuth("sess-1", "anthropic")).toEqual(apiKeyCred);
  });

  test("end-to-end #829: Anthropic session + OpenAI worker resolves null, not the Anthropic key", () => {
    // Mixed-provider setup: chat on Anthropic, a worker/aux model on OpenAI.
    // NOTE: this scenario is actually closed by the pre-existing 359 guard
    // (the session has a non-_default "anthropic" store, so
    // sessionHasProviderStore() is true and the global fallback is never
    // reached) — it passes even WITHOUT the provider-aware tag. It documents
    // the full #829 shape; the provider-tag logic itself is guarded by the
    // session-less and _default-only tests above.
    setSessionAuth("sess-1", apiKeyCred, "anthropic");
    setLastSeenAuth(apiKeyCred, "anthropic");

    const workerCred = resolveAuth("sess-1", "openai");
    expect(workerCred).toBe(null);
    expect(workerCred).not.toEqual(apiKeyCred);
  });

  test("an UNTAGGED global still serves any provider (legacy single-provider client)", () => {
    // A client that sends no x-lore-provider produces a null tag. Single-
    // provider setups must keep working: the global is the only credential and
    // is necessarily the right one — suppressing it would break their workers.
    setLastSeenAuth(minimaxCred); // no providerID → null tag
    expect(resolveAuth("sess-cold", "openai")).toEqual(minimaxCred);
    expect(resolveAuth(undefined, "anthropic")).toEqual(minimaxCred);
  });

  test("re-resolves to session credential after staleness cleared", () => {
    setSessionAuth("sess-1", bearerCred);
    setLastSeenAuth(apiKeyCred);
    markAuthStale("sess-1");

    // Stale — returns global
    expect(resolveAuth("sess-1")).toEqual(apiKeyCred);

    // Fresh credential arrives, clears staleness
    setSessionAuth("sess-1", bearerCred2);

    // Now returns the fresh session credential
    expect(resolveAuth("sess-1")).toEqual(bearerCred2);
  });
});

// ---------------------------------------------------------------------------
// Per-provider staleness isolation (cross-provider credential poisoning fix)
// ---------------------------------------------------------------------------

describe("resolveAuth per-provider staleness", () => {
  test("stale MiniMax does not poison Anthropic credential", () => {
    // Session uses both Anthropic and MiniMax
    setSessionAuth("sess-1", apiKeyCred, "anthropic");
    setSessionAuth("sess-1", minimaxCred, "minimax");
    setLastSeenAuth(apiKeyCred);

    // MiniMax goes stale (e.g. cache-warmer 401)
    markAuthStale("sess-1", "minimax");

    // Anthropic credential should still resolve normally
    expect(resolveAuth("sess-1", "anthropic")).toEqual(apiKeyCred);
    // MiniMax should fall through to global
    expect(resolveAuth("sess-1", "minimax")).toEqual(apiKeyCred);
  });

  test("stale Anthropic does not poison MiniMax credential", () => {
    setSessionAuth("sess-1", apiKeyCred, "anthropic");
    setSessionAuth("sess-1", minimaxCred, "minimax");
    setLastSeenAuth(apiKeyCred);

    markAuthStale("sess-1", "anthropic");

    // MiniMax credential should still resolve
    expect(resolveAuth("sess-1", "minimax")).toEqual(minimaxCred);
    // Anthropic falls through to global (same value → null)
    expect(resolveAuth("sess-1", "anthropic")).toBe(null);
  });

  test("named provider does NOT contaminate _default slot", () => {
    // Storing a named provider credential must NOT set _default — this
    // prevents cross-contamination (e.g. MiniMax key leaking to Anthropic
    // workers that resolve auth without a providerID).
    setSessionAuth("sess-1", minimaxCred, "minimax");
    setLastSeenAuth(apiKeyCred);

    // _default was never set (no dual-write), so resolveAuth without
    // providerID falls through to global.
    expect(getSessionAuth("sess-1")).toBe(null);
    expect(resolveAuth("sess-1")).toEqual(apiKeyCred);

    // minimax credential resolves correctly via its providerID
    expect(resolveAuth("sess-1", "minimax")).toEqual(minimaxCred);
  });

  test("marking named provider stale does not affect _default when _default was set independently", () => {
    // _default set via legacy caller (no providerID), then a named provider set separately
    setSessionAuth("sess-1", apiKeyCred); // sets _default
    setSessionAuth("sess-1", minimaxCred, "minimax");
    setLastSeenAuth(bearerCred);

    // Mark minimax stale — _default holds apiKeyCred (different),
    // so _default should NOT be marked stale.
    markAuthStale("sess-1", "minimax");

    expect(isAuthStale("sess-1", "minimax")).toBe(true);
    // _default should NOT be stale — it holds a different credential
    expect(isAuthStale("sess-1", "_default")).toBe(false);
    // resolveAuth without providerID returns _default — not stale
    expect(resolveAuth("sess-1")).toEqual(apiKeyCred);
    // MiniMax stale → falls to global
    expect(resolveAuth("sess-1", "minimax")).toEqual(bearerCred);
  });

  test("refreshing one provider clears only that provider staleness", () => {
    setSessionAuth("sess-1", apiKeyCred, "anthropic");
    setSessionAuth("sess-1", minimaxCred, "minimax");
    setLastSeenAuth(apiKeyCred);

    markAuthStale("sess-1", "anthropic");
    markAuthStale("sess-1", "minimax");

    // Refresh only anthropic — clears anthropic staleness
    setSessionAuth("sess-1", bearerCred2, "anthropic");

    // Anthropic is fresh — resolves to new credential
    expect(resolveAuth("sess-1", "anthropic")).toEqual(bearerCred2);
    // MiniMax still stale — falls through to global
    expect(resolveAuth("sess-1", "minimax")).toEqual(apiKeyCred);
    // _default was never set (named providers don't dual-write to _default)
    expect(isAuthStale("sess-1", "_default")).toBe(false);
    // But session-level still stale (minimax)
    expect(isAuthStale("sess-1")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Global auth staleness (session-less worker protection)
// ---------------------------------------------------------------------------

describe("global auth staleness", () => {
  test("global auth is not stale by default", () => {
    expect(isGlobalAuthStale()).toBe(false);
  });

  test("markGlobalAuthStale prevents resolveAuth(undefined) from returning stale token", () => {
    setLastSeenAuth(bearerCred);
    expect(resolveAuth()).toEqual(bearerCred);

    // Session-less worker gets 401 → marks global stale
    markGlobalAuthStale();
    expect(isGlobalAuthStale()).toBe(true);

    // resolveAuth(undefined) should return null — the token is rejected
    expect(resolveAuth()).toBe(null);
  });

  test("setLastSeenAuth with a fresh credential clears global staleness", () => {
    setLastSeenAuth(bearerCred);
    markGlobalAuthStale();
    expect(resolveAuth()).toBe(null);

    // A new client request arrives with a different token
    setLastSeenAuth(bearerCred2);
    expect(isGlobalAuthStale()).toBe(false);
    expect(resolveAuth()).toEqual(bearerCred2);
  });

  test("setLastSeenAuth with the same credential does NOT clear global staleness", () => {
    setLastSeenAuth(bearerCred);
    markGlobalAuthStale();

    // Same expired token re-set — staleness persists
    setLastSeenAuth(bearerCred);
    expect(isGlobalAuthStale()).toBe(true);
    expect(resolveAuth()).toBe(null);
  });

  test("global staleness does not affect session-level auth resolution", () => {
    setSessionAuth("sess-1", apiKeyCred);
    setLastSeenAuth(bearerCred);
    markGlobalAuthStale();

    // Session-level auth resolves normally — global staleness is irrelevant
    expect(resolveAuth("sess-1")).toEqual(apiKeyCred);
    // Session-less path is blocked
    expect(resolveAuth()).toBe(null);
  });

  test("stale session + stale global returns null (both exhausted)", () => {
    // Realistic scenario: session-less worker poisons global, then session
    // worker's credential also goes stale (e.g. OAuth token expired).
    setSessionAuth("sess-1", bearerCred);
    setLastSeenAuth(bearerCred2);

    // Session-less worker 401 → global stale
    markGlobalAuthStale();
    // Session worker 401 → session stale
    markAuthStale("sess-1");

    // Both paths exhausted — must return null, not the stale token
    expect(resolveAuth("sess-1")).toBe(null);
    expect(resolveAuth()).toBe(null);
  });

  test("_resetAuthForTest clears global staleness", () => {
    setLastSeenAuth(bearerCred);
    markGlobalAuthStale();
    expect(isGlobalAuthStale()).toBe(true);

    _resetAuthForTest();
    expect(isGlobalAuthStale()).toBe(false);
  });
});

describe("workerKeyScheme (dedicated-key provider→scheme)", () => {
  test("github-models needs a Bearer token", () => {
    expect(workerKeyScheme("github-models")).toBe("bearer");
  });

  test("every other provider uses api-key (x-api-key)", () => {
    for (const p of [
      "anthropic",
      "openai",
      "minimax",
      "deepseek",
      "openrouter",
      undefined,
    ]) {
      expect(workerKeyScheme(p)).toBe("api-key");
    }
  });
});
