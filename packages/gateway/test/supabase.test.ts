import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Shared mock handles for the Supabase client (hoisted so the vi.mock factory
// can reference them safely).
const h = vi.hoisted(() => ({
  auth: {
    setSession: vi.fn(),
    refreshSession: vi.fn(),
    getUser: vi.fn(),
  },
  from: vi.fn(),
  createClient: vi.fn(),
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: (...args: unknown[]) => {
    h.createClient(...args);
    return { auth: h.auth, from: h.from };
  },
}));

import { db, syncData } from "@loreai/core";
import { startSessionRefreshScheduler } from "../src/session-refresh";
import {
  clearProviderTokenCache,
  clearSession,
  getAuthedClient,
  getCurrentUser,
  isLoggedIn,
  loadCachedProviderToken,
  loadPersistedSession,
  persistProviderTokenCache,
  persistSession,
  sessionToPersisted,
  SUPABASE_ANON_KEY,
  SUPABASE_URL,
} from "../src/supabase";

const SAMPLE = {
  access_token: "at-1",
  refresh_token: "rt-1",
  expires_at: 1_900_000_000,
  user_id: "user-123",
  email: "me@example.com",
  github_login: "octocat",
  display_name: "Octo Cat",
};

function fakeSupabaseSession(overrides: Record<string, unknown> = {}) {
  return {
    access_token: "at-2",
    refresh_token: "rt-2",
    expires_at: 1_900_000_999,
    user: {
      id: "user-123",
      email: "me@example.com",
      user_metadata: { user_name: "octocat", name: "Octo Cat" },
    },
    ...overrides,
  };
}

// The profiles mirror is touched here via clearSession()/persistSession(); assert
// the sync invariants hold after every test (#834).
afterEach(() => syncData.assertSyncInvariants());

describe("supabase session persistence", () => {
  beforeEach(() => {
    clearSession();
    h.auth.setSession.mockReset();
    h.auth.getUser.mockReset();
    h.from.mockReset();
    h.createClient.mockReset();
  });

  test("defaults point at the Folk Lore project", () => {
    expect(SUPABASE_URL).toMatch(/^https:\/\/.+\.supabase\.co$/);
    expect(SUPABASE_ANON_KEY).toBeTruthy();
  });

  test("isLoggedIn is false with no session", () => {
    expect(isLoggedIn()).toBe(false);
    expect(loadPersistedSession()).toBeNull();
  });

  test("persist / load / clear round-trip", () => {
    persistSession(SAMPLE);
    expect(isLoggedIn()).toBe(true);
    expect(loadPersistedSession()).toEqual(SAMPLE);
    clearSession();
    expect(isLoggedIn()).toBe(false);
    expect(loadPersistedSession()).toBeNull();
  });

  test("loadPersistedSession returns null for a malformed blob", () => {
    // A session missing the required tokens must be treated as not-logged-in.
    persistSession({ user_id: "x" } as never);
    expect(loadPersistedSession()).toBeNull();
  });

  test("sessionToPersisted projects identity from OAuth metadata", () => {
    const persisted = sessionToPersisted(fakeSupabaseSession() as never);
    expect(persisted).toEqual({
      access_token: "at-2",
      refresh_token: "rt-2",
      expires_at: 1_900_000_999,
      user_id: "user-123",
      email: "me@example.com",
      github_login: "octocat",
      display_name: "Octo Cat",
    });
  });

  test("sessionToPersisted falls back to prev for missing metadata", () => {
    const bare = {
      access_token: "at-3",
      refresh_token: "rt-3",
      user: { id: "user-9", user_metadata: {} },
    };
    const persisted = sessionToPersisted(bare as never, {
      github_login: "prevhandle",
      email: "prev@example.com",
    });
    expect(persisted.github_login).toBe("prevhandle");
    expect(persisted.email).toBe("prev@example.com");
    expect(persisted.user_id).toBe("user-9");
  });
});

describe("background account refresh", () => {
  beforeEach(() => {
    clearSession();
    vi.useFakeTimers();
    h.auth.refreshSession.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  test("refreshes before expiry even with sync disabled, then keeps fresh credentials", async () => {
    syncData.disableSync();
    persistSession({
      ...SAMPLE,
      expires_at: Math.floor(Date.now() / 1000) + 30,
    });
    h.auth.refreshSession.mockResolvedValue({
      data: { session: fakeSupabaseSession() },
      error: null,
    });
    const stop = startSessionRefreshScheduler({
      hostedMode: false,
      remoteGateway: false,
    });
    try {
      await vi.advanceTimersByTimeAsync(1);
      expect(loadPersistedSession()?.access_token).toBe("at-2");
      await vi.advanceTimersByTimeAsync(60_000);
      expect(h.auth.refreshSession).toHaveBeenCalledTimes(1);
    } finally {
      await stop();
    }
  });

  test("temporary failures retry on the next interval without deleting the login", async () => {
    persistSession({ ...SAMPLE, expires_at: 1 });
    h.auth.refreshSession
      .mockResolvedValueOnce({
        data: { session: null },
        error: { status: 503 },
      })
      .mockResolvedValue({
        data: { session: fakeSupabaseSession() },
        error: null,
      });
    const stop = startSessionRefreshScheduler({
      hostedMode: false,
      remoteGateway: false,
    });
    try {
      await vi.advanceTimersByTimeAsync(1);
      expect(loadPersistedSession()?.access_token).toBe("at-1");
      await vi.advanceTimersByTimeAsync(30_000);
      expect(loadPersistedSession()?.access_token).toBe("at-2");
    } finally {
      await stop();
    }
  });

  test.each([
    { hostedMode: true, remoteGateway: false },
    { hostedMode: false, remoteGateway: true },
  ])("never refreshes the operator's account in %j", async (mode) => {
    persistSession({ ...SAMPLE, expires_at: 1 });
    const stop = startSessionRefreshScheduler(mode);
    await vi.advanceTimersByTimeAsync(90_000);
    await stop();
    expect(h.auth.refreshSession).not.toHaveBeenCalled();
    expect(loadPersistedSession()?.access_token).toBe("at-1");
  });

  test("stopping cancels an in-flight response and prevents late token persistence", async () => {
    persistSession({ ...SAMPLE, expires_at: 1 });
    let finish!: (value: unknown) => void;
    h.auth.refreshSession.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const stop = startSessionRefreshScheduler({
      hostedMode: false,
      remoteGateway: false,
    });
    await vi.advanceTimersByTimeAsync(1);
    const stopped = stop();
    finish({ data: { session: fakeSupabaseSession() }, error: null });
    await stopped;
    expect(loadPersistedSession()?.access_token).toBe("at-1");
    await vi.advanceTimersByTimeAsync(90_000);
    expect(h.auth.refreshSession).toHaveBeenCalledTimes(1);
  });

  test("shutdown cancels a restore started by an on-demand caller before the scheduler joined", async () => {
    persistSession({ ...SAMPLE, expires_at: 1 });
    let finish!: (value: unknown) => void;
    h.auth.refreshSession.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const demand = getAuthedClient();
    const demandOutcome = demand.then(
      () => "saved",
      () => "cancelled",
    );
    const stop = startSessionRefreshScheduler({
      hostedMode: false,
      remoteGateway: false,
    });
    await vi.advanceTimersByTimeAsync(1);
    const stopped = stop();
    finish({ data: { session: fakeSupabaseSession() }, error: null });
    await stopped;
    expect(await demandOutcome).toBe("cancelled");
    expect(loadPersistedSession()?.access_token).toBe("at-1");
  });
});

describe("getAuthedClient / getCurrentUser", () => {
  beforeEach(() => {
    clearSession();
    h.auth.setSession.mockReset();
    h.auth.refreshSession.mockReset();
    h.auth.getUser.mockReset();
  });

  test("returns null when not logged in", async () => {
    expect(await getAuthedClient()).toBeNull();
    expect(await getCurrentUser()).toBeNull();
  });

  test("whoami restores an expired access token instead of reporting a cached login", async () => {
    persistSession({ ...SAMPLE, expires_at: 1 });
    h.auth.refreshSession.mockResolvedValue({
      data: { session: fakeSupabaseSession() },
      error: null,
    });
    expect((await getCurrentUser())?.access_token).toBe("at-2");
    expect(loadPersistedSession()?.refresh_token).toBe("rt-2");
  });

  test("concurrent restores share one session rotation", async () => {
    persistSession(SAMPLE);
    const finishes: Array<(value: unknown) => void> = [];
    h.auth.setSession.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishes.push(resolve);
        }),
    );
    const first = getAuthedClient();
    const second = getAuthedClient();
    for (const finish of finishes)
      finish({ data: { session: fakeSupabaseSession() }, error: null });
    const clients = await Promise.all([first, second]);
    expect(clients[0]).toBe(clients[1]);
    expect(h.auth.setSession).toHaveBeenCalledTimes(1);
  });

  test.each(["logout", "switch", "relogin"])(
    "a late refresh cannot overwrite %s",
    async (action) => {
      persistSession(SAMPLE);
      let finish!: (value: unknown) => void;
      h.auth.setSession.mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const pending = getAuthedClient();
      clearSession();
      if (action !== "logout")
        persistSession(
          action === "switch" ? { ...SAMPLE, user_id: "user-other" } : SAMPLE,
        );
      finish({ data: { session: fakeSupabaseSession() }, error: null });
      await expect(pending).rejects.toThrow(/changed/i);
      expect(loadPersistedSession()).toEqual(
        action === "logout"
          ? null
          : action === "switch"
            ? { ...SAMPLE, user_id: "user-other" }
            : SAMPLE,
      );
    },
  );

  test("temporary restore failures preserve credentials and report unavailable", async () => {
    persistSession(SAMPLE);
    h.auth.setSession.mockResolvedValue({
      data: { session: null },
      error: { status: 503, message: "secret provider response" },
    });
    await expect(getAuthedClient()).rejects.toThrow(/unavailable/i);
    expect(loadPersistedSession()).toEqual(SAMPLE);
  });

  test("explicit refresh-token rejection clears the rejected session", async () => {
    persistSession({ ...SAMPLE, expires_at: 1 });
    h.auth.refreshSession.mockResolvedValue({
      data: { session: null },
      error: { status: 400, code: "refresh_token_not_found" },
    });
    h.auth.setSession.mockResolvedValue({
      data: { session: null },
      error: { status: 400, code: "refresh_token_not_found" },
    });
    expect(await getAuthedClient()).toBeNull();
    expect(loadPersistedSession()).toBeNull();
  });

  test("restores the session and re-persists refreshed tokens", async () => {
    persistSession(SAMPLE);
    h.auth.setSession.mockResolvedValue({
      data: { session: fakeSupabaseSession() },
      error: null,
    });

    const client = await getAuthedClient();
    expect(client).not.toBeNull();
    expect(h.auth.setSession).toHaveBeenCalledWith({
      access_token: "at-1",
      refresh_token: "rt-1",
    });
    // Refreshed access/refresh tokens are written back to team_config.
    expect(loadPersistedSession()?.access_token).toBe("at-2");
    expect(loadPersistedSession()?.refresh_token).toBe("rt-2");
  });

  test("unclassified restore failures preserve the session and report unavailable", async () => {
    persistSession(SAMPLE);
    h.auth.setSession.mockResolvedValue({
      data: { session: null },
      error: { message: "refresh_token_not_found" },
    });
    await expect(getAuthedClient()).rejects.toThrow(/unavailable/i);
    expect(loadPersistedSession()).toEqual(SAMPLE);
  });

  test("getCurrentUser without verify returns the cached identity", async () => {
    persistSession(SAMPLE);
    const user = await getCurrentUser();
    expect(user?.github_login).toBe("octocat");
    // No network round-trip in the cheap path.
    expect(h.auth.setSession).not.toHaveBeenCalled();
  });

  test("getCurrentUser does not erase a session for an unclassified verification failure", async () => {
    persistSession(SAMPLE);
    h.auth.setSession.mockResolvedValue({
      data: { session: fakeSupabaseSession() },
      error: null,
    });
    h.auth.getUser.mockResolvedValue({
      data: { user: null },
      error: { message: "bad jwt" },
    });
    await expect(getCurrentUser({ verify: true })).rejects.toThrow(
      /unavailable/i,
    );
    expect(loadPersistedSession()?.access_token).toBe("at-2");
  });

  test("verification cannot mark another user as the cached account", async () => {
    persistSession(SAMPLE);
    h.auth.setSession.mockResolvedValue({
      data: { session: fakeSupabaseSession() },
      error: null,
    });
    h.auth.getUser.mockResolvedValue({
      data: { user: { id: "user-other" } },
      error: null,
    });
    await expect(getCurrentUser({ verify: true })).rejects.toThrow(
      /unavailable/i,
    );
    expect(loadPersistedSession()?.user_id).toBe("user-123");
  });
});

/**
 * Identity-lifecycle battery — the standing pattern for any per-user state the
 * client caches locally (today: the pulled `profiles` mirror; future: Pro
 * tables in #826, team scopes). Asserts the full identity state-machine, not
 * single operations: logout, account switch, and token refresh, plus
 * cross-account isolation in BOTH directions. The #828 tier-residue bug lived
 * exactly here (login→logout→read and A→B switch were never exercised). When a
 * second piece of per-user state is added, extend `seedState`/`readState` below
 * rather than re-deriving the sequences.
 */
describe("profile mirror lifecycle (tier must not leak across sessions)", () => {
  function seedProfile(tier: string): void {
    db()
      .query(
        "INSERT INTO profiles (id, tier, created_at, updated_at) VALUES ('u-mirror', ?, ?, ?)",
      )
      .run(tier, Date.now(), Date.now());
  }

  beforeEach(() => {
    db().exec("DELETE FROM profiles");
    clearSession();
    db().exec("DELETE FROM profiles"); // clearSession also clears it — reset again
  });

  test("clearSession() drops the pulled profile mirror (no tier residue after logout)", () => {
    persistSession(SAMPLE);
    seedProfile("pro");
    expect(syncData.currentTier()).toBe("pro");
    clearSession();
    expect(syncData.currentTier()).toBe("free");
  });

  test("persistSession() clears the mirror on an account switch (different user_id)", () => {
    persistSession(SAMPLE); // user-123
    seedProfile("pro");
    expect(syncData.currentTier()).toBe("pro");
    persistSession({ ...SAMPLE, user_id: "user-999" });
    expect(syncData.currentTier()).toBe("free"); // prior account's tier dropped
  });

  test("persistSession() KEEPS the mirror on a token refresh (same user_id)", () => {
    persistSession(SAMPLE);
    seedProfile("pro");
    persistSession({ ...SAMPLE, access_token: "at-refreshed" });
    expect(syncData.currentTier()).toBe("pro"); // refresh must not wipe the tier
  });

  test("no tier leak across an account switch in EITHER direction", () => {
    // A (pro) → switch to B: B must NOT inherit A's pro — the mirror is cleared
    // and B re-pulls its own 'free'. Switch back to A: A must NOT see a stale
    // pro either; it re-pulls fresh. The mirror always reflects exactly the
    // currently-authenticated account.
    persistSession(SAMPLE); // account A (user-123)
    seedProfile("pro");
    expect(syncData.currentTier()).toBe("pro");

    persistSession({ ...SAMPLE, user_id: "user-B" }); // switch to B
    expect(syncData.currentTier()).toBe("free"); // A's pro dropped, not inherited
    seedProfile("free"); // B pulls its own (free) profile
    expect(syncData.currentTier()).toBe("free");

    persistSession(SAMPLE); // switch back to A
    expect(syncData.currentTier()).toBe("free"); // A's stale pro NOT resurrected
  });
});

describe("github provider_token disk cache", () => {
  beforeEach(() => {
    clearSession();
    clearProviderTokenCache();
  });

  test("round-trips a valid token through the cache", () => {
    expect(loadCachedProviderToken()).toBeNull();
    persistProviderTokenCache("gh-token-1", 3600);
    const cached = loadCachedProviderToken();
    expect(cached?.provider_token).toBe("gh-token-1");
  });

  test("default TTL falls back to 50 minutes when expiresIn is missing/zero", () => {
    persistProviderTokenCache("gh-token-2");
    const cached = loadCachedProviderToken();
    // Should be valid for ~3000s, not 0s (which would have expired already).
    expect(cached).not.toBeNull();
    expect(cached!.expires_at - Math.floor(Date.now() / 1000)).toBeGreaterThan(
      2900,
    );
  });

  test("expired cache entries are dropped on load", () => {
    // Manually plant an already-expired entry.
    db()
      .query(
        "INSERT INTO team_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(
        "github.provider_token",
        JSON.stringify({
          provider_token: "stale",
          expires_at: Math.floor(Date.now() / 1000) - 10,
        }),
      );
    expect(loadCachedProviderToken()).toBeNull();
  });

  test("clearSession clears the cached provider_token", () => {
    persistProviderTokenCache("gh-token-3", 3600);
    expect(loadCachedProviderToken()).not.toBeNull();
    clearSession();
    expect(loadCachedProviderToken()).toBeNull();
  });

  test("account switch (different user_id) clears the cached provider_token", () => {
    persistSession(SAMPLE);
    persistProviderTokenCache("gh-token-4", 3600);
    expect(loadCachedProviderToken()).not.toBeNull();
    persistSession({ ...SAMPLE, user_id: "user-other" });
    expect(loadCachedProviderToken()).toBeNull();
  });

  test("token refresh (same user_id) preserves the cached provider_token", () => {
    persistSession(SAMPLE);
    persistProviderTokenCache("gh-token-5", 3600);
    // Refresh the session for the same user — different tokens, same identity.
    persistSession({ ...SAMPLE, access_token: "at-refreshed" });
    const cached = loadCachedProviderToken();
    expect(cached?.provider_token).toBe("gh-token-5");
  });
});
