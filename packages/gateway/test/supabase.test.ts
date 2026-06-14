import { describe, test, expect, beforeEach, vi } from "vitest";

// Shared mock handles for the Supabase client (hoisted so the vi.mock factory
// can reference them safely).
const h = vi.hoisted(() => ({
  auth: {
    setSession: vi.fn(),
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

import {
  clearSession,
  getAuthedClient,
  getCurrentUser,
  isLoggedIn,
  loadPersistedSession,
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

describe("getAuthedClient / getCurrentUser", () => {
  beforeEach(() => {
    clearSession();
    h.auth.setSession.mockReset();
    h.auth.getUser.mockReset();
  });

  test("returns null when not logged in", async () => {
    expect(await getAuthedClient()).toBeNull();
    expect(await getCurrentUser()).toBeNull();
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

  test("returns null and keeps the stale session on restore failure", async () => {
    persistSession(SAMPLE);
    h.auth.setSession.mockResolvedValue({
      data: { session: null },
      error: { message: "refresh_token_not_found" },
    });
    expect(await getAuthedClient()).toBeNull();
    // We do NOT clear here — the caller decides.
    expect(loadPersistedSession()).toEqual(SAMPLE);
  });

  test("getCurrentUser without verify returns the cached identity", async () => {
    persistSession(SAMPLE);
    const user = await getCurrentUser();
    expect(user?.github_login).toBe("octocat");
    // No network round-trip in the cheap path.
    expect(h.auth.setSession).not.toHaveBeenCalled();
  });

  test("getCurrentUser with verify round-trips and returns null when invalid", async () => {
    persistSession(SAMPLE);
    h.auth.setSession.mockResolvedValue({
      data: { session: fakeSupabaseSession() },
      error: null,
    });
    h.auth.getUser.mockResolvedValue({
      data: { user: null },
      error: { message: "bad jwt" },
    });
    expect(await getCurrentUser({ verify: true })).toBeNull();
  });
});
