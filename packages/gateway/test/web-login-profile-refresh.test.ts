import { afterEach, expect, test, vi } from "vitest";
import { getTeamConfig } from "@loreai/core";
import { loadConfig } from "../src/config";
import {
  clearSession,
  loadPersistedSession,
  persistSession,
} from "../src/supabase";
import { handleWebLoginRequest } from "../src/web-login";

afterEach(() => {
  clearSession();
  vi.unstubAllGlobals();
});

test.each([false, true])(
  "browser profile refresh is coordinated and fenced when the account changes: %s",
  async (switchAccount) => {
    clearSession();
    const refresh = Promise.withResolvers<Response>();
    const refreshing = Promise.withResolvers<void>();
    const profiles: string[] = [];
    const leases: Array<string | null> = [];
    const session = (rotated: boolean) => ({
      access_token: rotated ? "rotated-access" : "initial-access",
      refresh_token: rotated ? "rotated-refresh" : "initial-refresh",
      expires_in: rotated ? 3600 : 30,
      token_type: "bearer",
      user: {
        id: "profile-user",
        email: "person@example.test",
        user_metadata: {},
      },
    });
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(
          input instanceof Request ? input.url : String(input),
        );
        if (url.pathname.endsWith("/otp")) return Response.json({});
        if (url.pathname.endsWith("/verify"))
          return Response.json(session(false));
        if (url.pathname.endsWith("/token")) {
          leases.push(getTeamConfig("supabase.refresh.lease"));
          refreshing.resolve();
          return await refresh.promise;
        }
        if (url.pathname.endsWith("/profiles")) {
          profiles.push(new Headers(init?.headers).get("authorization") ?? "");
          return Response.json({ display_name: "Profile fixture" });
        }
        throw new Error("Unexpected fixture endpoint");
      },
    );
    const config = { ...loadConfig(), hostedMode: false, remoteGateway: false };
    const request = async (path: string, body: unknown) => {
      const url = new URL(`http://127.0.0.1:1234/api/v1/account/login/${path}`);
      return await handleWebLoginRequest(
        new Request(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        url,
        config,
      );
    };
    try {
      const started = await request("email", { email: "person@example.test" });
      expect(started?.status).toBe(200);
      const { attempt } = await started!.json();
      const verified = await request("verify", { attempt, code: "123456" });
      expect(verified?.status).toBe(200);
      await refreshing.promise;
      if (switchAccount) {
        persistSession({
          access_token: "other-access",
          refresh_token: "other-refresh",
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          user_id: "other-user",
          email: "other@example.test",
          github_login: null,
          display_name: null,
        });
      }
      refresh.resolve(Response.json(session(true)));
      if (switchAccount) {
        // Drain the real SDK's response parsing and token-acquisition promise
        // chain before asserting that the retired login never dispatched REST.
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(profiles).toEqual([]);
        expect(loadPersistedSession()?.user_id).toBe("other-user");
      } else {
        await vi.waitFor(() =>
          expect(profiles).toEqual(["Bearer rotated-access"]),
        );
        expect(loadPersistedSession()?.access_token).toBe("rotated-access");
        expect(loadPersistedSession()?.refresh_token).toBe("rotated-refresh");
      }
      expect(leases).toHaveLength(1);
      expect(leases[0]).toBeTypeOf("string");
    } finally {
      refresh.resolve(Response.json(session(true)));
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  },
);
