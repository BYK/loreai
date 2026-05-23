import { describe, test, expect, beforeEach } from "bun:test";
import {
  setSessionAuth,
  getSessionAuth,
  deleteSessionAuth,
  setLastSeenAuth,
  getLastSeenAuth,
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

const bearerCred: AuthCredential = { scheme: "bearer", value: "tok-session-abc" };
const bearerCred2: AuthCredential = { scheme: "bearer", value: "tok-session-xyz" };
const apiKeyCred: AuthCredential = { scheme: "api-key", value: "sk-test-key" };

// ---------------------------------------------------------------------------
// Staleness tracking
// ---------------------------------------------------------------------------

describe("markAuthStale / isAuthStale", () => {
  test("session is not stale by default", () => {
    expect(isAuthStale("sess-1")).toBe(false);
  });

  test("marks a session as stale", () => {
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
});

describe("clearAuthStale", () => {
  test("clears staleness for a session", () => {
    markAuthStale("sess-1");
    expect(isAuthStale("sess-1")).toBe(true);
    clearAuthStale("sess-1");
    expect(isAuthStale("sess-1")).toBe(false);
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
