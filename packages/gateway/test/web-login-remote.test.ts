import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  _resetHostedModeForTest,
  enableHostedMode,
  withTenant,
} from "@loreai/core";

const auth = vi.hoisted(() => ({
  signInWithOtp: vi.fn(),
  verifyOtp: vi.fn(),
  signInWithOAuth: vi.fn(),
  exchangeCodeForSession: vi.fn(),
  refreshSession: vi.fn(),
  profile: vi.fn(),
}));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth,
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: auth.profile }) }),
    }),
  }),
}));

import { loadConfig } from "../src/config";
import { accountStatus } from "../src/folk-status";
import { startServer } from "../src/server";
import * as sessionStore from "../src/supabase";
import {
  clearSession,
  loadPersistedSession,
  persistSession,
} from "../src/supabase";
import { handleWebLoginRequest } from "../src/web-login";
import { loopbackRequest } from "./helpers/loopback-request";

const modes = ["local", "remote", "hosted", "runtime-hosted"] as const;
type Mode = (typeof modes)[number];
const origin = "https://gateway.example.test";
const session = {
  access_token: "fixture-access",
  refresh_token: "fixture-refresh",
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  user: { id: "fixture-user", email: "person@example.test", user_metadata: {} },
};

function configFor(mode: Mode, allowRemoteManagement = true) {
  return {
    ...loadConfig(),
    port: 0,
    hosts: ["127.0.0.1"],
    hostedMode: mode === "hosted",
    remoteGateway: mode === "remote" || mode === "hosted",
    allowRemoteManagement,
    managementOrigins: [origin, "http://gateway.example.test"],
  };
}

async function withServer(
  mode: Mode,
  run: (server: Awaited<ReturnType<typeof startServer>>) => Promise<void>,
  allowRemoteManagement = true,
  peerAddress = "192.0.2.10",
) {
  if (mode === "runtime-hosted") enableHostedMode();
  const server = await startServer(configFor(mode, allowRemoteManagement), {
    peerAddressForRequest: () => peerAddress,
  });
  try {
    await run(server);
  } finally {
    await server.stop();
  }
}

function request(
  server: Awaited<ReturnType<typeof startServer>>,
  path: string,
  body?: unknown,
  browserOrigin = origin,
) {
  return loopbackRequest(`http://127.0.0.1:${server.port}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      host: new URL(origin).host,
      ...(body === undefined
        ? {}
        : { origin: browserOrigin, "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeEach(() => {
  _resetHostedModeForTest();
  clearSession();
  vi.resetAllMocks();
  auth.signInWithOtp.mockResolvedValue({ error: null });
  auth.verifyOtp.mockResolvedValue({ data: { session }, error: null });
  auth.signInWithOAuth.mockResolvedValue({
    data: { url: "https://auth.example.test/authorize" },
    error: null,
  });
  auth.exchangeCodeForSession.mockResolvedValue({
    data: { session },
    error: null,
  });
  auth.profile.mockResolvedValue({ data: null, error: null });
});

afterEach(() => {
  vi.useRealTimers();
  clearSession();
  _resetHostedModeForTest();
});

describe.each(modes)("%s gateway browser sign-in", (mode) => {
  test.each(["startup", "interval"] as const)(
    "an embedded listener survives a throwing %s refresh read and later refreshes",
    async (phase) => {
      vi.useFakeTimers({
        toFake: [
          "Date",
          "setTimeout",
          "clearTimeout",
          "setInterval",
          "clearInterval",
        ],
      });
      persistSession({
        access_token: session.access_token,
        refresh_token: session.refresh_token,
        user_id: session.user.id,
        email: session.user.email,
        expires_at: 1,
      });
      auth.refreshSession.mockResolvedValue({
        data: {
          session: {
            ...session,
            access_token: "recovered-access",
            refresh_token: "recovered-refresh",
          },
        },
        error: null,
      });
      await withServer(mode, async (server) => {
        const read = vi.spyOn(sessionStore, "loadPersistedSession");
        try {
          if (phase === "interval") {
            read.mockReturnValueOnce(null);
            await vi.advanceTimersByTimeAsync(1);
          }
          read.mockImplementationOnce(() => {
            throw new Error("private-listener-read-sentinel");
          });
          await vi.advanceTimersByTimeAsync(phase === "startup" ? 1 : 30_000);
          expect(auth.refreshSession).not.toHaveBeenCalled();
          await vi.advanceTimersByTimeAsync(30_000);
          expect(auth.refreshSession).toHaveBeenCalledOnce();
          expect(loadPersistedSession()?.refresh_token).toBe(
            "recovered-refresh",
          );
          expect((await request(server, "/api/v1/account")).status).toBe(200);
        } finally {
          read.mockRestore();
        }
      });
    },
  );

  test.each(["rotated", "rejected", "temporary"] as const)(
    "the listener owns account refresh after browser login: %s",
    async (outcome) => {
      vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
      const initial = {
        ...session,
        expires_at: Math.floor(Date.now() / 1000) + 600,
      };
      const rotated = () => ({
        ...initial,
        access_token: "rotated-access",
        refresh_token: "rotated-refresh",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      });
      auth.verifyOtp.mockResolvedValue({
        data: { session: initial },
        error: null,
      });
      auth.refreshSession.mockImplementation(async () => ({
        data: { session: rotated() },
        error: null,
      }));
      if (outcome !== "rotated")
        auth.refreshSession.mockResolvedValueOnce({
          data: { session: null },
          error:
            outcome === "rejected"
              ? { status: 400, code: "refresh_token_not_found" }
              : { status: 503 },
        });

      await withServer(mode, async (server) => {
        const start = await request(server, "/api/v1/account/login/email", {
          email: initial.user.email,
        });
        const { attempt } = await start.json();
        const verified = await request(server, "/api/v1/account/login/verify", {
          attempt,
          code: "123456",
        });
        expect(verified.status).toBe(200);
        await vi.waitFor(() => expect(auth.profile).toHaveBeenCalledTimes(1));
        expect(
          await (await request(server, "/api/v1/account")).json(),
        ).toMatchObject({
          state: "signed_in",
        });
        expect(auth.refreshSession).not.toHaveBeenCalled();

        // Optional login work has settled. Only the listener lifecycle can now
        // refresh this account; account-status reads must remain read-only.
        vi.setSystemTime((initial.expires_at + 1) * 1000);
        await vi.advanceTimersByTimeAsync(30_000);
        expect(auth.refreshSession).toHaveBeenCalledExactlyOnceWith({
          refresh_token: initial.refresh_token,
        });
        const account = await (await request(server, "/api/v1/account")).json();
        if (outcome === "rejected") {
          expect(account).toMatchObject({ state: "anonymous", user: null });
          expect(loadPersistedSession()).toBeNull();
        } else if (outcome === "temporary") {
          expect(account).toMatchObject({
            state: "unavailable",
            signed_in: false,
          });
          expect(loadPersistedSession()?.refresh_token).toBe(
            initial.refresh_token,
          );
          await vi.advanceTimersByTimeAsync(30_000);
          expect(
            await (await request(server, "/api/v1/account")).json(),
          ).toMatchObject({
            state: "signed_in",
            user: { id: initial.user.id },
          });
          expect(loadPersistedSession()?.refresh_token).toBe("rotated-refresh");
        } else {
          expect(account).toMatchObject({
            state: "signed_in",
            user: { id: initial.user.id },
          });
          expect(loadPersistedSession()?.refresh_token).toBe("rotated-refresh");
        }
      });
    },
  );

  test("stopping the listener fences an unfinished operator refresh", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    const initial = {
      ...session,
      expires_at: Math.floor(Date.now() / 1000) + 600,
    };
    auth.verifyOtp.mockResolvedValue({
      data: { session: initial },
      error: null,
    });
    const response = Promise.withResolvers<unknown>();
    auth.refreshSession.mockReturnValue(response.promise);
    await withServer(mode, async (server) => {
      const { attempt } = await (
        await request(server, "/api/v1/account/login/email", {
          email: initial.user.email,
        })
      ).json();
      expect(
        (
          await request(server, "/api/v1/account/login/verify", {
            attempt,
            code: "123456",
          })
        ).status,
      ).toBe(200);
      await vi.waitFor(() => expect(auth.profile).toHaveBeenCalledTimes(1));
      vi.setSystemTime((initial.expires_at + 1) * 1000);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(auth.refreshSession).toHaveBeenCalledTimes(1);
      const stopped = vi.fn();
      const stopping = server.stop(50).then(() => stopped());
      try {
        // The transport deliberately ignores abort. Listener shutdown still
        // honors its existing drain deadline before this response is released.
        await vi.waitFor(() => expect(stopped).toHaveBeenCalledTimes(1), {
          timeout: 1_000,
        });
      } finally {
        response.resolve({
          data: {
            session: {
              ...initial,
              access_token: "late-access",
              refresh_token: "late-refresh",
            },
          },
          error: null,
        });
        await stopping;
      }
      await vi.advanceTimersByTimeAsync(90_000);
      expect(auth.refreshSession).toHaveBeenCalledTimes(1);
      expect(loadPersistedSession()?.refresh_token).toBe(initial.refresh_token);
    });
  });

  test("the management account reflects the operator's anonymous and signed-in state", async () => {
    await withServer(mode, async (server) => {
      const anonymous = await request(server, "/api/v1/account");
      expect(anonymous.status).toBe(200);
      expect(await anonymous.json()).toMatchObject({
        state: "anonymous",
        signed_in: false,
        user: null,
      });
      persistSession({
        access_token: session.access_token,
        refresh_token: session.refresh_token,
        user_id: session.user.id,
        email: session.user.email,
        expires_at: session.expires_at,
      });
      const signedIn = await request(server, "/api/v1/account");
      expect(signedIn.status).toBe(200);
      const body = await signedIn.json();
      expect(body).toMatchObject({
        state: "signed_in",
        signed_in: true,
        user: { id: session.user.id, email: session.user.email },
      });
      expect(JSON.stringify(body)).not.toContain(session.access_token);
      expect(JSON.stringify(body)).not.toContain(session.refresh_token);
    });
  });

  test("email verification signs in through the authorized remote management surface", async () => {
    await withServer(mode, async (server) => {
      const start = await request(server, "/api/v1/account/login/email", {
        email: session.user.email,
      });
      expect(start.status).toBe(200);
      expect(auth.signInWithOtp).toHaveBeenCalledWith({
        email: session.user.email,
        options: { emailRedirectTo: `${origin}/ui` },
      });
      const { attempt } = await start.json();
      const verified = await request(server, "/api/v1/account/login/verify", {
        attempt,
        code: "123456",
      });
      expect(verified.status).toBe(200);
      expect(auth.verifyOtp).toHaveBeenCalledWith({
        email: session.user.email,
        token: "123456",
        type: "email",
      });
      expect(loadPersistedSession()?.user_id).toBe(session.user.id);
      expect(
        await (await request(server, "/api/v1/account")).json(),
      ).toMatchObject({
        state: "signed_in",
        user: { id: session.user.id },
      });
    });
  });

  test.each([
    ["http:", "192.0.2.10"],
    ["https:", "192.0.2.10"],
    ["http:", "127.0.0.1"],
    ["https:", "127.0.0.1"],
  ])(
    "GitHub preserves the %s browser origin through peer %s and commits its callback once",
    async (protocol, peerAddress) => {
      const browserOrigin = new URL(origin);
      browserOrigin.protocol = protocol;
      await withServer(
        mode,
        async (server) => {
          const start = await request(
            server,
            "/api/v1/account/login/github",
            {},
            browserOrigin.origin,
          );
          expect(start.status).toBe(200);
          const { attempt } = await start.json();
          const callback = new URL(
            auth.signInWithOAuth.mock.calls[0][0].options.redirectTo,
          );
          expect(callback.origin).toBe(browserOrigin.origin);
          expect(callback.pathname).toBe("/api/v1/account/login/callback");
          expect(callback.searchParams.get("attempt")).toBe(attempt);
          callback.searchParams.set("code", "fixture-code");
          const response = await request(
            server,
            `${callback.pathname}${callback.search}`,
          );
          expect(response.status).toBe(303);
          expect(response.headers.get("location")).toBe(
            `/ui?login=success&login_attempt=${attempt}`,
          );
          expect(loadPersistedSession()?.user_id).toBe(session.user.id);
          const replay = await request(
            server,
            `${callback.pathname}${callback.search}`,
          );
          expect(replay.headers.get("location")).toBe(
            `/ui?login=failed&login_attempt=${attempt}`,
          );
          expect(auth.exchangeCodeForSession).toHaveBeenCalledExactlyOnceWith(
            "fixture-code",
          );
        },
        true,
        peerAddress,
      );
    },
  );

  test("remote sign-in still requires management opt-in and an accepted browser origin", async () => {
    await withServer(
      mode,
      async (server) => {
        const response = await request(server, "/api/v1/account/login/email", {
          email: session.user.email,
        });
        expect(response.status).toBe(404);
        expect(auth.signInWithOtp).not.toHaveBeenCalled();
      },
      false,
    );
    await withServer(mode, async (server) => {
      const response = await request(
        server,
        "/api/v1/account/login/github",
        {},
        "https://foreign.example.test",
      );
      expect(response.status).toBe(404);
      expect(auth.signInWithOAuth).not.toHaveBeenCalled();
    });
  });

  test("model-request tenant scope cannot read or replace the operator's account", async () => {
    const config = configFor(mode);
    persistSession({
      access_token: session.access_token,
      refresh_token: session.refresh_token,
      user_id: session.user.id,
    });
    const url = new URL(`${origin}/api/v1/account/login/email`);
    await withTenant("other-tenant", async () => {
      expect(accountStatus(config)).toMatchObject({
        signed_in: false,
        user: null,
      });
      const response = await handleWebLoginRequest(
        new Request(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: "other@example.test" }),
        }),
        url,
        config,
      );
      expect(response?.status).toBe(403);
    });
    expect(loadPersistedSession()?.user_id).toBe(session.user.id);
    expect(auth.signInWithOtp).not.toHaveBeenCalled();
  });
});
