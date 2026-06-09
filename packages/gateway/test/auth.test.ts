import { describe, test, expect, beforeEach } from "vitest";
import {
  setSessionAuth,
  getSessionAuth,
  deleteSessionAuth,
  setLastSeenAuth,
  resolveAuth,
  markAuthStale,
  isAuthStale,
  clearAuthStale,
  _resetAuthForTest,
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

  test("marking named provider stale marks _default when _default holds same credential", () => {
    setSessionAuth("sess-1", minimaxCred, "minimax");
    // _default was set to minimaxCred by setSessionAuth's dual-write
    setLastSeenAuth(apiKeyCred);

    // Mark only minimax stale — should automatically mark _default too,
    // since _default currently holds the same credential as minimax.
    markAuthStale("sess-1", "minimax");

    // _default should be stale (auto-marked — same credential)
    expect(isAuthStale("sess-1", "_default")).toBe(true);
    // No providerID → checks _default → stale → falls through to global
    expect(resolveAuth("sess-1")).toEqual(apiKeyCred);
  });

  test("marking named provider stale does NOT mark _default when another provider was set last", () => {
    // MiniMax set first, then Anthropic set last → _default = anthropic
    setSessionAuth("sess-1", minimaxCred, "minimax");
    setSessionAuth("sess-1", apiKeyCred, "anthropic");
    setLastSeenAuth(bearerCred);

    // Mark minimax stale — _default points to anthropic (different cred),
    // so _default should NOT be marked stale.
    markAuthStale("sess-1", "minimax");

    expect(isAuthStale("sess-1", "minimax")).toBe(true);
    // _default should NOT be stale — it holds the anthropic credential
    expect(isAuthStale("sess-1", "_default")).toBe(false);
    // resolveAuth without providerID returns _default (anthropic) — not stale
    expect(resolveAuth("sess-1")).toEqual(apiKeyCred);
    // Anthropic also not stale
    expect(resolveAuth("sess-1", "anthropic")).toEqual(apiKeyCred);
    // MiniMax stale → falls to global
    expect(resolveAuth("sess-1", "minimax")).toEqual(bearerCred);
  });

  test("refreshing one provider clears only that provider staleness", () => {
    setSessionAuth("sess-1", apiKeyCred, "anthropic");
    setSessionAuth("sess-1", minimaxCred, "minimax");
    setLastSeenAuth(apiKeyCred);

    markAuthStale("sess-1", "anthropic");
    markAuthStale("sess-1", "minimax");

    // Refresh only anthropic — clears anthropic + _default staleness
    setSessionAuth("sess-1", bearerCred2, "anthropic");

    // Anthropic is fresh — resolves to new credential
    expect(resolveAuth("sess-1", "anthropic")).toEqual(bearerCred2);
    // MiniMax still stale — falls through to global
    expect(resolveAuth("sess-1", "minimax")).toEqual(apiKeyCred);
    // _default was cleared by setSessionAuth refresh
    expect(isAuthStale("sess-1", "_default")).toBe(false);
    // But session-level still stale (minimax)
    expect(isAuthStale("sess-1")).toBe(true);
  });
});
