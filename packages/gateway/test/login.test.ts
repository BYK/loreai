import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  auth: {
    setSession: vi.fn(),
    getUser: vi.fn(),
    signInWithOtp: vi.fn(),
    verifyOtp: vi.fn(),
    signInWithOAuth: vi.fn(),
    exchangeCodeForSession: vi.fn(),
    signOut: vi.fn(),
  },
  from: vi.fn(),
  answer: { value: "" },
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ auth: h.auth, from: h.from }),
}));

vi.mock("node:readline/promises", () => ({
  createInterface: () => ({
    question: async () => h.answer.value,
    close: () => {},
  }),
}));

import {
  canOpenBrowser,
  commandLogin,
  commandLogout,
  commandWhoami,
} from "../src/cli/login";
import {
  clearSession,
  loadPersistedSession,
  persistSession,
} from "../src/supabase";

const SAMPLE = {
  access_token: "at-1",
  refresh_token: "rt-1",
  user_id: "user-123",
  email: "me@example.com",
  github_login: "octocat",
  display_name: "Octo Cat",
};

function profileChain(data: unknown) {
  return {
    select: () => ({
      eq: () => ({ maybeSingle: async () => ({ data, error: null }) }),
    }),
  };
}

let logs: string[];
let errs: string[];
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  clearSession();
  for (const fn of Object.values(h.auth)) fn.mockReset();
  h.from.mockReset();
  h.answer.value = "";
  process.exitCode = undefined;
  logs = [];
  errs = [];
  logSpy = vi.spyOn(console, "log").mockImplementation((m?: unknown) => {
    logs.push(String(m));
  });
  errSpy = vi.spyOn(console, "error").mockImplementation((m?: unknown) => {
    errs.push(String(m));
  });
});

afterEach(() => {
  logSpy.mockRestore();
  errSpy.mockRestore();
});

describe("commandWhoami", () => {
  test("reports not logged in and sets a failure exit code", async () => {
    await commandWhoami([], {});
    expect(logs.join("\n")).toMatch(/Not logged in/);
    expect(process.exitCode).toBe(1);
  });

  test("prints the GitHub identity when logged in", async () => {
    persistSession(SAMPLE);
    await commandWhoami([], {});
    expect(logs.join("\n")).toContain("@octocat");
    expect(process.exitCode).not.toBe(1);
  });

  test("--json also prints account details", async () => {
    persistSession(SAMPLE);
    await commandWhoami([], { json: true });
    const joined = logs.join("\n");
    expect(joined).toContain("@octocat");
    expect(joined).toContain('"user_id": "user-123"');
  });

  test("--verify clears a stale session the server rejects", async () => {
    persistSession(SAMPLE);
    // getAuthedClient() -> setSession() fails -> session is dead.
    h.auth.setSession.mockResolvedValue({
      data: { session: null },
      error: { message: "refresh_token_not_found" },
    });

    await commandWhoami([], { verify: true });

    expect(loadPersistedSession()).toBeNull(); // cleared
    expect(logs.join("\n")).toMatch(/Session expired/);
    expect(process.exitCode).toBe(1);
  });
});

describe("commandLogout", () => {
  test("no-ops when not logged in", async () => {
    await commandLogout();
    expect(logs.join("\n")).toMatch(/Not logged in/);
  });

  test("clears the local session", async () => {
    persistSession(SAMPLE);
    h.auth.setSession.mockResolvedValue({ data: {}, error: null });
    h.auth.signOut.mockResolvedValue({ error: null });
    await commandLogout();
    expect(loadPersistedSession()).toBeNull();
    expect(logs.join("\n")).toMatch(/Logged out/);
  });

  test("clears locally even when server sign-out fails", async () => {
    persistSession(SAMPLE);
    h.auth.setSession.mockRejectedValue(new Error("network"));
    await commandLogout();
    expect(loadPersistedSession()).toBeNull();
  });
});

describe("commandLogin (email OTP)", () => {
  test("verifies the code, persists the session, and confirms identity", async () => {
    h.answer.value = "123456";
    h.auth.signInWithOtp.mockResolvedValue({ error: null });
    h.auth.verifyOtp.mockResolvedValue({
      data: {
        session: {
          access_token: "at-new",
          refresh_token: "rt-new",
          expires_at: 1_900_000_000,
          user: {
            id: "user-123",
            email: "me@example.com",
            user_metadata: { user_name: "octocat", name: "Octo Cat" },
          },
        },
      },
      error: null,
    });
    h.from.mockReturnValue(
      profileChain({
        github_login: "octocat",
        display_name: "Octo Cat",
        email: "me@example.com",
      }),
    );

    await commandLogin([], { email: "me@example.com" });

    expect(h.auth.signInWithOtp).toHaveBeenCalledWith({
      email: "me@example.com",
    });
    expect(h.auth.verifyOtp).toHaveBeenCalledWith({
      email: "me@example.com",
      token: "123456",
      type: "email",
    });
    const persisted = loadPersistedSession();
    expect(persisted?.access_token).toBe("at-new");
    expect(persisted?.github_login).toBe("octocat");
    expect(logs.join("\n")).toMatch(/Signed in as @octocat/);
  });

  test("falls back to the signup token type for a first-time email", async () => {
    h.answer.value = "123456";
    h.auth.signInWithOtp.mockResolvedValue({ error: null });
    // First-time email: type:"email" is rejected, type:"signup" succeeds.
    h.auth.verifyOtp
      .mockResolvedValueOnce({
        data: { session: null },
        error: { message: "Token has expired or is invalid" },
      })
      .mockResolvedValueOnce({
        data: {
          session: {
            access_token: "at-su",
            refresh_token: "rt-su",
            user: {
              id: "user-123",
              email: "me@example.com",
              user_metadata: {},
            },
          },
        },
        error: null,
      });
    h.from.mockReturnValue(profileChain(null));

    await commandLogin([], { email: "me@example.com" });

    expect(h.auth.verifyOtp).toHaveBeenCalledTimes(2);
    expect(h.auth.verifyOtp).toHaveBeenLastCalledWith({
      email: "me@example.com",
      token: "123456",
      type: "signup",
    });
    expect(loadPersistedSession()?.access_token).toBe("at-su");
  });

  test("surfaces a network error immediately without a second verify attempt", async () => {
    h.answer.value = "123456";
    h.auth.signInWithOtp.mockResolvedValue({ error: null });
    h.auth.verifyOtp.mockResolvedValue({
      data: { session: null },
      error: { message: "fetch failed: ECONNREFUSED" },
    });
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);

    await commandLogin([], { email: "me@example.com" });

    // Non-token error → fail fast, no redundant second verifyOtp call.
    expect(h.auth.verifyOtp).toHaveBeenCalledTimes(1);
    expect(errs.join("\n")).toMatch(/ECONNREFUSED/);
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  test("rejects a pasted magic-link URL with a helpful hint", async () => {
    h.answer.value =
      "http://localhost:3000/?code=53a25354-2f36-4822-8a8f-8a26345214c5";
    h.auth.signInWithOtp.mockResolvedValue({ error: null });
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);

    await commandLogin([], { email: "me@example.com" });

    // Never reaches verifyOtp — caught by the shape guard.
    expect(h.auth.verifyOtp).not.toHaveBeenCalled();
    expect(errs.join("\n")).toMatch(/\{\{ \.Token \}\}/);
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  test("short-circuits when already logged in", async () => {
    persistSession(SAMPLE);
    await commandLogin([], { email: "me@example.com" });
    expect(h.auth.signInWithOtp).not.toHaveBeenCalled();
    expect(logs.join("\n")).toMatch(/Already logged in/);
  });
});

describe("canOpenBrowser", () => {
  const SNAPSHOT = [
    "LORE_NO_BROWSER",
    "CI",
    "SSH_CONNECTION",
    "SSH_TTY",
    "SSH_CLIENT",
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "WSL_DISTRO_NAME",
  ];
  let saved: Record<string, string | undefined>;
  const savedPlatform = process.platform;

  beforeEach(() => {
    saved = {};
    for (const k of SNAPSHOT) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of SNAPSHOT) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    Object.defineProperty(process, "platform", {
      value: savedPlatform,
      configurable: true,
    });
  });

  test("false when LORE_NO_BROWSER=1", () => {
    process.env.LORE_NO_BROWSER = "1";
    expect(canOpenBrowser()).toBe(false);
  });

  test("false inside CI", () => {
    process.env.CI = "true";
    expect(canOpenBrowser()).toBe(false);
  });

  test("false over SSH", () => {
    process.env.SSH_CONNECTION = "10.0.0.1 22 10.0.0.2 51000";
    expect(canOpenBrowser()).toBe(false);
  });

  test("false on headless Linux (no display)", () => {
    Object.defineProperty(process, "platform", {
      value: "linux",
      configurable: true,
    });
    expect(canOpenBrowser()).toBe(false);
  });

  test("true on Linux with a display", () => {
    Object.defineProperty(process, "platform", {
      value: "linux",
      configurable: true,
    });
    process.env.DISPLAY = ":0";
    expect(canOpenBrowser()).toBe(true);
  });

  test("true under WSL even without a display", () => {
    Object.defineProperty(process, "platform", {
      value: "linux",
      configurable: true,
    });
    process.env.WSL_DISTRO_NAME = "Ubuntu";
    expect(canOpenBrowser()).toBe(true);
  });
});

describe("commandLogin (GitHub --no-browser)", () => {
  test("prints the URL and exchanges a pasted redirect URL for a session", async () => {
    h.auth.signInWithOAuth.mockResolvedValue({
      data: { url: "https://gh.example/oauth?x=1" },
      error: null,
    });
    // User pastes the full redirect URL; we extract ?code=.
    h.answer.value = "http://127.0.0.1/callback?code=abc-123-def";
    h.auth.exchangeCodeForSession.mockResolvedValue({
      data: {
        session: {
          access_token: "at-gh",
          refresh_token: "rt-gh",
          user: {
            id: "user-123",
            email: "me@example.com",
            user_metadata: { user_name: "octocat", name: "Octo Cat" },
          },
        },
      },
      error: null,
    });
    h.from.mockReturnValue(profileChain(null));

    await commandLogin([], { "no-browser": true });

    expect(h.auth.signInWithOAuth).toHaveBeenCalledWith({
      provider: "github",
      options: {
        skipBrowserRedirect: true,
        redirectTo: "http://127.0.0.1/callback",
        scopes: "read:org",
      },
    });
    // The pasted URL's ?code= is extracted before exchange.
    expect(h.auth.exchangeCodeForSession).toHaveBeenCalledWith("abc-123-def");
    expect(loadPersistedSession()?.access_token).toBe("at-gh");
    expect(logs.join("\n")).toContain("https://gh.example/oauth?x=1");
  });
});
