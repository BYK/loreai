import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import { createServer, request as httpRequest } from "node:http";
import * as supabase from "../src/supabase";

const auth = vi.hoisted(() => ({
  signInWithOtp: vi.fn(),
  verifyOtp: vi.fn(),
  signInWithOAuth: vi.fn(),
  exchangeCodeForSession: vi.fn(),
  profile: vi.fn(),
  provision: vi.fn(),
}));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth,
    functions: { invoke: auth.provision },
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: auth.profile }),
      }),
    }),
  }),
}));

import { loadConfig } from "../src/config";
import { handleNodeRequest, startServer } from "../src/server";
import { handleWebLoginRequest } from "../src/web-login";
import {
  clearSession,
  loadPersistedSession,
  persistSession,
} from "../src/supabase";
import { loopbackRequest } from "./helpers/loopback-request";

describe("web login management ingress", () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  const config = {
    ...loadConfig(),
    port: 0,
    hosts: ["127.0.0.1"],
    hostedMode: false,
    remoteGateway: false,
    allowRemoteManagement: false,
  };
  const request = (
    path: string,
    body: unknown,
    origin = `http://127.0.0.1:${server.port}`,
  ) =>
    loopbackRequest(`http://127.0.0.1:${server.port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify(body),
    });
  beforeAll(async () => {
    server = await startServer(config);
  });
  afterAll(async () => {
    await server.stop();
  });
  beforeEach(() => {
    clearSession();
    vi.resetAllMocks();
    auth.profile.mockResolvedValue({ data: null });
    auth.provision.mockResolvedValue({ data: null, error: null });
    auth.signInWithOtp.mockResolvedValue({ error: null });
    auth.verifyOtp.mockResolvedValue({
      data: {
        session: {
          access_token: "access",
          refresh_token: "refresh",
          user: {
            id: "user-a",
            email: "person@example.com",
            user_metadata: {},
          },
        },
      },
      error: null,
    });
  });

  test("blocks a foreign browser origin before starting email login", async () => {
    const response = await request(
      "/api/v1/account/login/email",
      { email: "person@example.com" },
      "https://evil.example",
    );
    expect([403, 404]).toContain(response.status);
    expect(auth.signInWithOtp).not.toHaveBeenCalled();
  });

  test("bounds incomplete request bodies and recovers after disconnect", async () => {
    const held: ReturnType<typeof httpRequest>[] = [];
    try {
      for (let i = 0; i < 16; i++) {
        const req = httpRequest({
          host: "127.0.0.1",
          port: server.port,
          path: "/api/v1/account/login/cancel",
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: `http://127.0.0.1:${server.port}`,
          },
        });
        req.on("error", () => {});
        held.push(req);
        req.write('{"attempt":');
        await new Promise<void>((resolve) =>
          req.once("socket", (socket) => socket.once("connect", resolve)),
        );
      }
      const excess = httpRequest({
        host: "127.0.0.1",
        port: server.port,
        path: "/api/v1/account/login/cancel",
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: `http://127.0.0.1:${server.port}`,
        },
      });
      held.push(excess);
      const result = new Promise<number>((resolve, reject) => {
        excess.once("response", (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        });
        excess.once("error", reject);
      });
      excess.write('{"attempt":');
      expect(
        await Promise.race([
          result,
          new Promise<number>((resolve) => setTimeout(() => resolve(0), 1000)),
        ]),
      ).toBe(400);
    } finally {
      for (const req of held) req.destroy();
    }
    await vi.waitFor(async () => {
      const response = await request("/api/v1/account/login/email", {
        email: "person@example.com",
      });
      expect(response.status).toBe(200);
    });
  });

  test.each(["none", "accepted", "rejected"])(
    "closes incomplete management preflight uploads (origin: %s)",
    async (originKind) => {
      const origin =
        originKind === "rejected"
          ? "https://evil.example"
          : `http://127.0.0.1:${server.port}`;
      const hasOrigin = originKind !== "none";
      const headers = {
        "content-length": "100",
        ...(hasOrigin ? { origin } : {}),
      };
      const req = httpRequest({
        host: "127.0.0.1",
        port: server.port,
        path: "/api/v1/account/login/email",
        method: "OPTIONS",
        headers,
      });
      let closed = false;
      req.on("error", () => {});
      req.once("socket", (socket) =>
        socket.once("close", () => {
          closed = true;
        }),
      );
      try {
        const response = new Promise<{
          status: number;
          cors: string | undefined;
        }>((resolve, reject) => {
          req.once("response", (res) => {
            res.resume();
            resolve({
              status: res.statusCode ?? 0,
              cors: res.headers["access-control-allow-origin"],
            });
          });
          req.once("error", reject);
        });
        req.write("partial");
        expect(await response).toEqual({
          status: originKind === "rejected" ? 404 : 204,
          cors: originKind === "accepted" ? origin : undefined,
        });
        await vi.waitFor(() => expect(closed).toBe(true), { timeout: 1000 });
        const normal = await loopbackRequest(
          `http://127.0.0.1:${server.port}/api/v1/account/login/email`,
          { method: "OPTIONS", headers: hasOrigin ? { origin } : {} },
        );
        expect(normal.status).toBe(originKind === "rejected" ? 404 : 204);
        expect(normal.headers.get("access-control-allow-origin")).toBe(
          originKind === "accepted" ? origin : null,
        );
      } finally {
        req.destroy();
      }
    },
  );

  test.each(["/unknown-preflight-path", "/v1/chat/completions"])(
    "closes incomplete generic preflight uploads for %s",
    async (path) => {
      const req = httpRequest({
        host: "127.0.0.1",
        port: server.port,
        path,
        method: "OPTIONS",
        headers: { "content-length": "100" },
      });
      let closed = false;
      req.on("error", () => {});
      req.once("socket", (socket) =>
        socket.once("close", () => {
          closed = true;
        }),
      );
      try {
        const response = new Promise<{
          status: number;
          cors: string | undefined;
        }>((resolve, reject) => {
          req.once("response", (res) => {
            res.resume();
            resolve({
              status: res.statusCode ?? 0,
              cors: res.headers["access-control-allow-origin"],
            });
          });
          req.once("error", reject);
        });
        req.write("partial");
        expect(await response).toEqual({ status: 204, cors: undefined });
        await vi.waitFor(() => expect(closed).toBe(true), { timeout: 1000 });
        const normal = await loopbackRequest(
          `http://127.0.0.1:${server.port}${path}`,
          { method: "OPTIONS" },
        );
        expect(normal.status).toBe(204);
        expect(normal.headers.get("access-control-allow-origin")).toBeNull();
      } finally {
        req.destroy();
      }
    },
  );

  test.each(["email", "github"])(
    "closes incomplete %s uploads rejected for an existing session",
    async (kind) => {
      persistSession({
        access_token: "access",
        refresh_token: "refresh",
        user_id: "user-a",
        email: null,
        display_name: null,
        github_login: null,
      });
      const req = httpRequest({
        host: "127.0.0.1",
        port: server.port,
        path: `/api/v1/account/login/${kind}`,
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: `http://127.0.0.1:${server.port}`,
        },
      });
      let closed = false;
      req.on("error", () => {});
      req.once("socket", (socket) =>
        socket.once("close", () => {
          closed = true;
        }),
      );
      try {
        const response = new Promise<number>((resolve, reject) => {
          req.once("response", (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          });
          req.once("error", reject);
        });
        req.write('{"partial":');
        expect(await response).toBe(409);
        await vi.waitFor(() => expect(closed).toBe(true), { timeout: 1000 });
      } finally {
        req.destroy();
      }
    },
  );

  test.each([
    ["hosted", "POST", 403],
    ["method", "PUT", 405],
    ["callback", "GET", 303],
  ])(
    "closes incomplete uploads on %s early responses through the Node bridge",
    async (kind, method, status) => {
      const local = createServer((req, res) => {
        void handleNodeRequest(
          req,
          res,
          async (request) => {
            const response = await handleWebLoginRequest(
              request,
              new URL(request.url),
              { ...config, hostedMode: kind === "hosted" },
            );
            return response ?? new Response(null, { status: 404 });
          },
          "127.0.0.1",
          0,
        );
      });
      await new Promise<void>((resolve) =>
        local.listen(0, "127.0.0.1", resolve),
      );
      const address = local.address();
      if (!address || typeof address === "string")
        throw new Error("Expected TCP listener");
      const req = httpRequest({
        host: "127.0.0.1",
        port: address.port,
        path:
          kind === "callback"
            ? "/api/v1/account/login/callback"
            : "/api/v1/account/login/email",
        method,
        headers: {
          "content-type": "application/json",
          "content-length": "100",
        },
      });
      let closed = false;
      req.on("error", () => {});
      req.once("socket", (socket) =>
        socket.once("close", () => {
          closed = true;
        }),
      );
      try {
        const response = new Promise<number>((resolve, reject) => {
          req.once("response", (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          });
          req.once("error", reject);
        });
        req.write('{"partial":');
        expect(await response).toBe(status);
        await vi.waitFor(() => expect(closed).toBe(true), { timeout: 1000 });
      } finally {
        req.destroy();
        await new Promise<void>((resolve, reject) =>
          local.close((error) => (error ? reject(error) : resolve())),
        );
      }
    },
  );

  test.each([false, true])(
    "a delayed valid verification respects client disconnection (%s)",
    async (disconnected) => {
      let signal: (() => AbortSignal | undefined) | undefined;
      const create = supabase.createSupabaseClient;
      const spy = vi
        .spyOn(supabase, "createSupabaseClient")
        .mockImplementation((getSignal, token) => {
          signal = getSignal;
          return create(getSignal, token);
        });
      let finish!: (result: unknown) => void;
      auth.verifyOtp.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const start = await request("/api/v1/account/login/email", {
        email: "person@example.com",
      });
      const { attempt } = (await start.json()) as { attempt: string };
      const verification = httpRequest({
        host: "127.0.0.1",
        port: server.port,
        path: "/api/v1/account/login/verify",
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: `http://127.0.0.1:${server.port}`,
        },
      });
      verification.on("error", () => {});
      const completion = new Promise<number>((resolve) => {
        verification.once("response", (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        });
      });
      try {
        verification.end(JSON.stringify({ attempt, code: "123456" }));
        await vi.waitFor(() => expect(auth.verifyOtp).toHaveBeenCalledOnce());
        const active = signal?.();
        expect(active?.aborted).toBe(false);
        if (disconnected) {
          verification.destroy();
          await vi.waitFor(() => expect(active?.aborted).toBe(true));
        }
        finish({
          data: {
            session: {
              access_token: "access",
              refresh_token: "refresh",
              user: {
                id: "user-a",
                email: "person@example.com",
                user_metadata: {},
              },
            },
          },
          error: null,
        });
        if (!disconnected) {
          expect(await completion).toBe(200);
          expect(loadPersistedSession()?.user_id).toBe("user-a");
          return;
        }
        await vi.waitFor(() => expect(loadPersistedSession()).toBeNull());
        const retry = await request("/api/v1/account/login/verify", {
          attempt,
          code: "123456",
        });
        expect(retry.status).toBe(400);
        expect(
          (
            await request("/api/v1/account/login/email", {
              email: "person@example.com",
            })
          ).status,
        ).toBe(200);
      } finally {
        verification.destroy();
        finish?.({ data: { session: null }, error: new Error("cancelled") });
        spy.mockRestore();
      }
    },
  );

  test("stalled optional profile work is bounded and never blocks later sign-ins", async () => {
    const releases: Array<() => void> = [];
    auth.profile.mockImplementation(
      () =>
        new Promise((resolve) => releases.push(() => resolve({ data: null }))),
    );
    try {
      for (let i = 0; i < 17; i++) {
        clearSession();
        const start = await request("/api/v1/account/login/email", {
          email: "person@example.com",
        });
        expect(start.status).toBe(200);
        const { attempt } = (await start.json()) as { attempt: string };
        expect(
          (
            await request("/api/v1/account/login/verify", {
              attempt,
              code: "123456",
            })
          ).status,
        ).toBe(200);
        if (i < 16)
          await vi.waitFor(() =>
            expect(auth.profile).toHaveBeenCalledTimes(i + 1),
          );
      }
      expect(auth.profile).toHaveBeenCalledTimes(16);
    } finally {
      for (const release of releases) release();
    }
  });

  test("a later account switch prevents a pending email login from replacing it", async () => {
    const start = await request("/api/v1/account/login/email", {
      email: "person@example.com",
    });
    expect(start.status).toBe(200);
    expect(start.headers.get("cache-control")).toBe("no-store");
    const { attempt } = (await start.json()) as { attempt: string };
    persistSession({
      access_token: "other-access",
      refresh_token: "other-refresh",
      user_id: "user-b",
      email: null,
      display_name: null,
      github_login: null,
    });
    const finish = await request("/api/v1/account/login/verify", {
      attempt,
      code: "123456",
    });
    expect(finish.status).toBe(400);
    expect(loadPersistedSession()?.user_id).toBe("user-b");
  });

  test("acknowledged cancellation fences an in-flight verification before another login", async () => {
    const first = await request("/api/v1/account/login/email", {
      email: "person@example.com",
    });
    const { attempt: attemptA } = (await first.json()) as { attempt: string };
    let finish!: (result: unknown) => void;
    auth.verifyOtp.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const verification = request("/api/v1/account/login/verify", {
      attempt: attemptA,
      code: "123456",
    });
    await vi.waitFor(() => expect(auth.verifyOtp).toHaveBeenCalledOnce());
    const cancellation = await request("/api/v1/account/login/cancel", {
      attempt: attemptA,
    });
    expect(cancellation.status).toBe(200);
    const second = await request("/api/v1/account/login/email", {
      email: "person@example.com",
    });
    const { attempt: attemptB } = (await second.json()) as { attempt: string };
    finish({
      data: {
        session: {
          access_token: "a",
          refresh_token: "a",
          user: {
            id: "user-a",
            email: "person@example.com",
            user_metadata: {},
          },
        },
      },
      error: null,
    });
    expect((await verification).status).toBe(400);
    expect(loadPersistedSession()).toBeNull();
    const success = await request("/api/v1/account/login/verify", {
      attempt: attemptB,
      code: "123456",
    });
    expect(success.status).toBe(200);
    expect(loadPersistedSession()?.user_id).toBe("user-a");
  });

  test("cancellation reports a completed login while profile loading is pending", async () => {
    let release!: (result: unknown) => void;
    auth.profile.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const start = await request("/api/v1/account/login/email", {
      email: "person@example.com",
    });
    const { attempt } = (await start.json()) as { attempt: string };
    const verification = request("/api/v1/account/login/verify", {
      attempt,
      code: "123456",
    });
    await vi.waitFor(() => expect(auth.profile).toHaveBeenCalledOnce());
    expect(loadPersistedSession()?.user_id).toBe("user-a");
    try {
      const newer = await request("/api/v1/account/login/email", {
        email: "person@example.com",
      });
      expect(newer.status).toBe(409);
      const cancellation = await request("/api/v1/account/login/cancel", {
        attempt,
      });
      expect(await cancellation.json()).toEqual({ ok: false });
    } finally {
      release({ data: null });
    }
    expect((await verification).status).toBe(200);
  });

  test("cancellation cannot report success after completed attempt bookkeeping expires", async () => {
    const start = await request("/api/v1/account/login/email", {
      email: "person@example.com",
    });
    const { attempt } = (await start.json()) as { attempt: string };
    const verification = await request("/api/v1/account/login/verify", {
      attempt,
      code: "123456",
    });
    expect(verification.status).toBe(200);
    expect(loadPersistedSession()?.user_id).toBe("user-a");
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 11 * 60_000);
    try {
      const cancellation = await request("/api/v1/account/login/cancel", {
        attempt,
      });
      expect(await cancellation.json()).toEqual({ ok: false });
      expect(loadPersistedSession()?.user_id).toBe("user-a");
    } finally {
      clock.mockRestore();
    }
  });

  test("email login completes while optional profile loading is stalled", async () => {
    let release!: (result: unknown) => void;
    auth.profile.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const start = await request("/api/v1/account/login/email", {
      email: "person@example.com",
    });
    const { attempt } = (await start.json()) as { attempt: string };
    const verification = request("/api/v1/account/login/verify", {
      attempt,
      code: "123456",
    });
    await vi.waitFor(() => expect(auth.profile).toHaveBeenCalledOnce());
    try {
      const result = await Promise.race([
        verification.then((response) => response.status),
        new Promise<"stalled">((resolve) =>
          setTimeout(() => resolve("stalled"), 500),
        ),
      ]);
      expect(result).toBe(200);
    } finally {
      release({ data: null });
      await verification;
    }
  });

  test("a late profile cannot update a different account", async () => {
    const updateProfile = vi.spyOn(supabase, "updateSessionProfile");
    let release!: (result: unknown) => void;
    auth.profile.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const start = await request("/api/v1/account/login/email", {
      email: "person@example.com",
    });
    const { attempt } = (await start.json()) as { attempt: string };
    expect(
      (
        await request("/api/v1/account/login/verify", {
          attempt,
          code: "123456",
        })
      ).status,
    ).toBe(200);
    persistSession({
      access_token: "other-access",
      refresh_token: "other-refresh",
      user_id: "user-b",
      email: null,
      display_name: null,
      github_login: null,
    });
    release({ data: { display_name: "Old profile" } });
    await vi.waitFor(() => expect(updateProfile).toHaveBeenCalled());
    expect(loadPersistedSession()?.user_id).toBe("user-b");
    expect(loadPersistedSession()?.display_name).toBeNull();
  });

  test("GitHub login completes while optional provisioning is stalled", async () => {
    auth.signInWithOAuth.mockResolvedValue({
      data: { url: "https://example.com/authorize" },
      error: null,
    });
    auth.exchangeCodeForSession.mockResolvedValue({
      data: {
        session: {
          access_token: "access",
          refresh_token: "refresh",
          provider_token: "github-token",
          user: { id: "user-a", user_metadata: {} },
        },
      },
      error: null,
    });
    let release!: (result: unknown) => void;
    auth.provision.mockImplementationOnce(
      () => new Promise((resolve) => (release = resolve)),
    );
    const start = await request("/api/v1/account/login/github", {});
    const { attempt } = (await start.json()) as { attempt: string };
    const callback = new URL(
      auth.signInWithOAuth.mock.calls[0][0].options.redirectTo,
    );
    callback.searchParams.set("code", "oauth-code");
    const completion = loopbackRequest(callback);
    await vi.waitFor(() => expect(auth.provision).toHaveBeenCalledOnce());
    try {
      const result = await Promise.race([
        completion.then((response) => response.headers.get("location")),
        new Promise<"stalled">((resolve) =>
          setTimeout(() => resolve("stalled"), 500),
        ),
      ]);
      expect(result).toBe(`/ui?login=success&login_attempt=${attempt}`);
      expect(
        await (
          await request("/api/v1/account/login/cancel", { attempt })
        ).json(),
      ).toEqual({ ok: false });
    } finally {
      release({ data: null, error: null });
      await completion;
    }
  });

  test("late GitHub provisioning never reports success for a switched account", async () => {
    auth.signInWithOAuth.mockResolvedValue({
      data: { url: "https://example.com/authorize" },
      error: null,
    });
    auth.exchangeCodeForSession.mockResolvedValue({
      data: {
        session: {
          access_token: "access",
          refresh_token: "refresh",
          provider_token: "github-token",
          user: { id: "user-a", user_metadata: {} },
        },
      },
      error: null,
    });
    let release!: (result: unknown) => void;
    auth.provision.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const revision = vi.spyOn(supabase, "captureLoginRevision");
    try {
      await request("/api/v1/account/login/github", {});
      const callback = new URL(
        auth.signInWithOAuth.mock.calls[0][0].options.redirectTo,
      );
      callback.searchParams.set("code", "oauth-code");
      expect((await loopbackRequest(callback)).headers.get("location")).toBe(
        `/ui?login=success&login_attempt=${callback.searchParams.get("attempt")}`,
      );
      await vi.waitFor(() => expect(auth.provision).toHaveBeenCalledOnce());
      persistSession({
        access_token: "other-access",
        refresh_token: "other-refresh",
        user_id: "user-b",
      });
      revision.mockClear();
      release({ data: { teams: 1 }, error: null });
      await vi.waitFor(() => expect(revision).toHaveBeenCalled());
      expect(log).not.toHaveBeenCalledWith("Synced 1 GitHub team to Lore.");
    } finally {
      log.mockRestore();
      revision.mockRestore();
    }
  });

  test("late GitHub provisioning never reports success after its deadline", async () => {
    const deadlines: AbortController[] = [];
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
      const controller = new AbortController();
      deadlines.push(controller);
      return controller.signal;
    });
    auth.signInWithOAuth.mockResolvedValue({
      data: { url: "https://example.com/authorize" },
      error: null,
    });
    auth.exchangeCodeForSession.mockResolvedValue({
      data: {
        session: {
          access_token: "access",
          refresh_token: "refresh",
          provider_token: "github-token",
          user: { id: "user-a", user_metadata: {} },
        },
      },
      error: null,
    });
    let release!: (result: unknown) => void;
    let operationDeadline!: AbortController;
    auth.provision.mockImplementationOnce(() => {
      // saveSession starts provisioning before its independent profile lookup.
      operationDeadline = deadlines[deadlines.length - 2];
      return new Promise((resolve) => {
        release = resolve;
      });
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await request("/api/v1/account/login/github", {});
      const callback = new URL(
        auth.signInWithOAuth.mock.calls[0][0].options.redirectTo,
      );
      callback.searchParams.set("code", "oauth-code");
      expect((await loopbackRequest(callback)).headers.get("location")).toBe(
        `/ui?login=success&login_attempt=${callback.searchParams.get("attempt")}`,
      );
      await vi.waitFor(() => expect(auth.provision).toHaveBeenCalledOnce());
      operationDeadline.abort();
      release({ data: { teams: 1 }, error: null });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(log).not.toHaveBeenCalledWith("Synced 1 GitHub team to Lore.");
    } finally {
      timeout.mockRestore();
      log.mockRestore();
    }
  });

  test("a duplicate GitHub callback cannot leave an exchange able to persist after failure and dismissal", async () => {
    auth.signInWithOAuth.mockResolvedValue({
      data: { url: "https://example.com/authorize" },
      error: null,
    });
    let finish!: (result: unknown) => void;
    auth.exchangeCodeForSession.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const start = await request("/api/v1/account/login/github", {});
    const { attempt } = (await start.json()) as { attempt: string };
    const callback = new URL(
      auth.signInWithOAuth.mock.calls[0][0].options.redirectTo,
    );
    callback.searchParams.set("code", "oauth-code");
    const first = loopbackRequest(callback);
    await vi.waitFor(() =>
      expect(auth.exchangeCodeForSession).toHaveBeenCalledOnce(),
    );
    const duplicate = await loopbackRequest(callback);
    expect(duplicate.headers.get("location")).toBe(
      `/ui?login=failed&login_attempt=${attempt}`,
    );
    expect((await request("/api/v1/account/login/cancel", {})).status).toBe(
      200,
    );
    finish({
      data: {
        session: {
          access_token: "access",
          refresh_token: "refresh",
          user: { id: "user-a", user_metadata: {} },
        },
      },
      error: null,
    });
    expect((await first).headers.get("location")).toBe(
      `/ui?login=failed&login_attempt=${attempt}`,
    );
    expect(loadPersistedSession()).toBeNull();
    expect(
      (await request("/api/v1/account/login/cancel", { attempt })).status,
    ).toBe(200);
  });

  test("GitHub cancellation reports completion while profile loading is pending", async () => {
    auth.signInWithOAuth.mockResolvedValue({
      data: { url: "https://example.com/authorize" },
      error: null,
    });
    auth.exchangeCodeForSession.mockResolvedValue({
      data: {
        session: {
          access_token: "access",
          refresh_token: "refresh",
          user: { id: "user-a", user_metadata: {} },
        },
      },
      error: null,
    });
    let release!: (result: unknown) => void;
    auth.profile.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const start = await request("/api/v1/account/login/github", {});
    const { attempt } = (await start.json()) as { attempt: string };
    const callback = new URL(
      auth.signInWithOAuth.mock.calls[0][0].options.redirectTo,
    );
    callback.searchParams.set("code", "oauth-code");
    const completion = loopbackRequest(callback);
    await vi.waitFor(() => expect(auth.profile).toHaveBeenCalledOnce());
    try {
      const cancellation = await request("/api/v1/account/login/cancel", {
        attempt,
      });
      expect(await cancellation.json()).toEqual({ ok: false });
    } finally {
      release({ data: null });
    }
    expect((await completion).headers.get("location")).toBe(
      `/ui?login=success&login_attempt=${attempt}`,
    );
  });

  test("an older request with a delayed body cannot supersede a newer attempt", async () => {
    await request("/api/v1/account/login/cancel", {});
    const capture = vi.spyOn(supabase, "captureLoginRevision");
    const older = httpRequest({
      host: "127.0.0.1",
      port: server.port,
      path: "/api/v1/account/login/email",
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: `http://127.0.0.1:${server.port}`,
      },
    });
    const response = new Promise<number | string>((resolve) => {
      older.once("response", (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      older.once("error", (error: NodeJS.ErrnoException) =>
        resolve(error.code ?? "error"),
      );
    });
    older.write('{"email":');
    await vi.waitFor(() => expect(capture).toHaveBeenCalled());
    const newer = await request("/api/v1/account/login/email", {
      email: "person@example.com",
    });
    expect(newer.status).toBe(200);
    const { attempt } = (await newer.json()) as { attempt: string };
    expect([409, "ECONNRESET"]).toContain(await response);
    const verified = await request("/api/v1/account/login/verify", {
      attempt,
      code: "123456",
    });
    expect(verified.status).toBe(200);
    capture.mockRestore();
  });

  test("logout fences a start whose request body is still arriving", async () => {
    await request("/api/v1/account/login/cancel", {});
    const capture = vi.spyOn(supabase, "captureLoginRevision");
    const older = httpRequest({
      host: "127.0.0.1",
      port: server.port,
      path: "/api/v1/account/login/email",
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: `http://127.0.0.1:${server.port}`,
      },
    });
    const response = new Promise<number>((resolve, reject) => {
      older.once("response", (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      older.once("error", reject);
    });
    older.write('{"email":');
    await vi.waitFor(() => expect(capture).toHaveBeenCalled());
    clearSession();
    older.end('"person@example.com"}');
    expect(await response).toBe(409);
    expect(auth.signInWithOtp).not.toHaveBeenCalled();
    expect(loadPersistedSession()).toBeNull();
    capture.mockRestore();
  });

  test.each([
    ["email", "valid"],
    ["email", "invalid"],
    ["email", "aborted"],
    ["github", "valid"],
    ["github", "invalid"],
    ["github", "aborted"],
  ])(
    "a newer delayed %s start fences an in-flight completion when %s",
    async (kind, bodyOutcome) => {
      let finish!: (result: unknown) => void;
      const waitForCompletion = () =>
        new Promise((resolve) => {
          finish = resolve;
        });
      let completion: Promise<Response>;
      if (kind === "email") {
        const start = await request("/api/v1/account/login/email", {
          email: "person@example.com",
        });
        const { attempt } = (await start.json()) as { attempt: string };
        auth.verifyOtp.mockImplementationOnce(waitForCompletion);
        completion = request("/api/v1/account/login/verify", {
          attempt,
          code: "123456",
        });
        await vi.waitFor(() => expect(auth.verifyOtp).toHaveBeenCalledOnce());
      } else {
        auth.signInWithOAuth.mockResolvedValue({
          data: { url: "https://example.com/authorize" },
          error: null,
        });
        auth.exchangeCodeForSession.mockImplementationOnce(waitForCompletion);
        const start = await request("/api/v1/account/login/github", {});
        expect(start.status).toBe(200);
        const callback = new URL(
          auth.signInWithOAuth.mock.calls[0][0].options.redirectTo,
        );
        callback.searchParams.set("code", "example");
        completion = loopbackRequest(callback.toString());
        await vi.waitFor(() =>
          expect(auth.exchangeCodeForSession).toHaveBeenCalledOnce(),
        );
      }
      const capture = vi.spyOn(supabase, "captureLoginRevision");
      const newer = httpRequest({
        host: "127.0.0.1",
        port: server.port,
        path: "/api/v1/account/login/email",
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: `http://127.0.0.1:${server.port}`,
        },
      });
      const response = new Promise<number>((resolve, reject) => {
        newer.once("response", (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        newer.once("error", reject);
      });
      newer.write('{"email":');
      await vi.waitFor(() => expect(capture).toHaveBeenCalled());
      finish({
        data: {
          session: {
            access_token: "access",
            refresh_token: "refresh",
            user: {
              id: "user-a",
              email: "person@example.com",
              user_metadata: {},
            },
          },
        },
        error: null,
      });
      const result = await completion;
      if (bodyOutcome === "aborted") newer.destroy();
      else
        newer.end(
          bodyOutcome === "valid" ? '"person@example.com"}' : "invalid}",
        );
      const newerStatus = await response.catch(() => 0);
      expect(
        kind === "email" ? result.status : result.headers.get("location"),
      ).toBe(
        kind === "email"
          ? 400
          : `/ui?login=failed&login_attempt=${new URL(auth.signInWithOAuth.mock.calls[0][0].options.redirectTo).searchParams.get("attempt")}`,
      );
      expect(loadPersistedSession()).toBeNull();
      expect(newerStatus).toBe(
        bodyOutcome === "valid" ? 200 : bodyOutcome === "invalid" ? 400 : 0,
      );
      capture.mockRestore();
    },
  );
});
