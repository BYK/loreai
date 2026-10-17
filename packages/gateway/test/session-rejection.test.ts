import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { getTeamConfig, syncData } from "@loreai/core";
import {
  clearSession,
  getAuthedClient,
  getCurrentUser,
  loadPersistedSession,
  persistSession,
  SUPABASE_URL,
  type PersistedSession,
} from "../src/supabase";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_ID = "00000000-0000-4000-8000-000000000002";

function savedSession(userId = USER_ID): PersistedSession {
  const expires_at = Math.floor(Date.now() / 1000) + 3600;
  const access_token = [
    Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString(
      "base64url",
    ),
    Buffer.from(JSON.stringify({ exp: expires_at, sub: userId })).toString(
      "base64url",
    ),
    "test-signature",
  ].join(".");
  return {
    user_id: userId,
    access_token,
    refresh_token: "test-refresh",
    expires_at,
  };
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function userResponse(): Response {
  return response({
    id: USER_ID,
    aud: "authenticated",
    user_metadata: {},
    app_metadata: {},
  });
}

// This provider response becomes AuthSessionMissingError(status=400, code
// undefined) in the real SDK. A mock that returns its original code misses it.
function revokedResponse(): Response {
  return response(
    { error_code: "session_not_found", msg: "Session revoked" },
    401,
  );
}

function fakeFetch(handler: () => Response | Promise<Response>): void {
  vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== new URL(SUPABASE_URL).origin)
      throw new Error("Unexpected remote request in session rejection test");
    return Promise.resolve(handler());
  });
}

describe("real SDK session rejection classification", () => {
  beforeEach(() => clearSession());
  afterEach(() => {
    vi.unstubAllGlobals();
    clearSession();
    syncData.assertSyncInvariants();
  });

  test("an actual revoked-session response clears the matching saved login", async () => {
    persistSession(savedSession());
    fakeFetch(revokedResponse);
    expect(await getAuthedClient()).toBeNull();
    expect(loadPersistedSession()).toBeNull();
    expect(getTeamConfig("supabase.refresh.lease")).toBeNull();
  });

  test("verification clears an explicitly rejected login after successful restoration", async () => {
    persistSession(savedSession());
    let requests = 0;
    fakeFetch(() => (++requests === 1 ? userResponse() : revokedResponse()));
    expect(await getCurrentUser({ verify: true })).toBeNull();
    expect(requests).toBe(2);
    expect(loadPersistedSession()).toBeNull();
  });

  test("a transient verification failure preserves the saved login", async () => {
    const saved = savedSession();
    persistSession(saved);
    let requests = 0;
    fakeFetch(() =>
      ++requests === 1
        ? userResponse()
        : response({ msg: "Temporary outage" }, 503),
    );
    await expect(getCurrentUser({ verify: true })).rejects.toThrow(
      /unavailable/i,
    );
    expect(requests).toBe(2);
    expect(loadPersistedSession()).toMatchObject(saved);
  });

  test.each(["logout", "relogin", "switch"])(
    "late verification rejection cannot erase a %s successor",
    async (action) => {
      const saved = savedSession();
      persistSession(saved);
      let release!: (value: Response) => void;
      let started!: () => void;
      const verificationStarted = new Promise<void>((resolve) => {
        started = resolve;
      });
      let requests = 0;
      fakeFetch(() => {
        if (++requests === 1) return userResponse();
        started();
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      });
      const pending = getCurrentUser({ verify: true });
      const outcome = pending.then(
        () => "unexpected success",
        (error: unknown) => error,
      );
      await verificationStarted;
      clearSession();
      const successor = action === "switch" ? savedSession(OTHER_ID) : saved;
      if (action !== "logout") persistSession(successor);
      release(revokedResponse());
      expect(await outcome).toBeInstanceOf(Error);
      await expect(pending).rejects.toThrow(/changed/i);
      expect(loadPersistedSession()).toEqual(
        action === "logout" ? null : successor,
      );
    },
  );
});
