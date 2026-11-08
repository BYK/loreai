import { afterEach, expect, test, vi } from "vitest";
import { close, dbReadGeneration } from "../../core/src/db";
import { loadConfig } from "../src/config";
import { startServer } from "../src/server";
import * as account from "../src/supabase";

const realFetch = globalThis.fetch;
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
const user = {
  id: "00000000-0000-4000-8000-000000000001",
  email: "fixture@example.test",
};
const token = [
  Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString(
    "base64url",
  ),
  Buffer.from(
    JSON.stringify({ sub: user.id, exp: Math.floor(Date.now() / 1000) + 3600 }),
  ).toString("base64url"),
  Buffer.from("fixture-signature").toString("base64url"),
].join(".");
const saved = {
  user_id: user.id,
  email: user.email,
  access_token: token,
  refresh_token: "fixture-refresh",
  expires_at: Math.floor(Date.now() / 1000) + 3600,
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  account.clearSession();
});

test.each([false, true])(
  "on-demand restoration cannot reopen SQLite after shutdown (connected control: %s)",
  async (connected) => {
    account.persistSession(saved);
    const entered = Promise.withResolvers<void>();
    const response = Promise.withResolvers<Response>();
    const signals: AbortSignal[] = [];
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(
          input instanceof Request ? input.url : String(input),
        );
        if (url.hostname === "127.0.0.1") return await realFetch(input, init);
        if (url.pathname.endsWith("/user")) {
          if (init?.signal) signals.push(init.signal);
          entered.resolve();
          return await response.promise;
        }
        return Response.json([]);
      },
    );
    const gateway = await startServer(
      {
        ...loadConfig(),
        port: 0,
        hosts: ["127.0.0.1"],
        hostedMode: false,
        remoteGateway: false,
      },
      { shutdownDeadlineMs: 25 },
    );
    const pending = realFetch(
      `http://127.0.0.1:${gateway.port}/api/v1/teams/00000000-0000-4000-8000-000000000002/members`,
    )
      .then(async (result) => ({
        status: result.status,
        body: await result.json(),
      }))
      .catch(() => null);
    try {
      await Promise.race([
        entered.promise,
        pending.then((result) => {
          throw new Error(
            `Restoration was not reached: ${JSON.stringify(result)}`,
          );
        }),
      ]);
      if (connected) {
        response.resolve(Response.json(user));
        const result = await pending;
        expect(result?.status).toBe(404);
        expect(signals[0]?.aborted).toBe(false);
      } else {
        await gateway.stop();
        close();
        const closed = dbReadGeneration();
        response.resolve(Response.json(user));
        await pending;
        await turn();
        await turn();
        expect(dbReadGeneration()).toBe(closed);
        expect(signals[0]?.aborted).toBe(true);
      }
    } finally {
      response.resolve(Response.json(user));
      await pending;
      await gateway.stop();
      await turn();
    }
  },
);

test.each([0, 1])(
  "stopping listener %s preserves the other owner's shared restoration",
  async (stopped) => {
    account.persistSession({ ...saved, expires_at: 1 });
    const entered = Promise.withResolvers<void>();
    const response = Promise.withResolvers<Response>();
    const signals: AbortSignal[] = [];
    const restores = vi.spyOn(account, "getAuthedClient");
    vi.stubGlobal(
      "fetch",
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.signal) signals.push(init.signal);
        entered.resolve();
        return await response.promise;
      },
    );
    const config = {
      ...loadConfig(),
      port: 0,
      hosts: ["127.0.0.1"],
      hostedMode: false,
      remoteGateway: false,
    };
    const first = await startServer(config, { shutdownDeadlineMs: 25 });
    await entered.promise;
    const second = await startServer(config, { shutdownDeadlineMs: 25 });
    const listeners = [first, second];
    try {
      await vi.waitFor(() => expect(restores).toHaveBeenCalledTimes(2));
      expect(signals).toHaveLength(1);
      await listeners[stopped].stop();
      expect(signals[0]?.aborted).toBe(false);
      response.resolve(
        Response.json({
          access_token: "rotated-access",
          refresh_token: "rotated-refresh",
          expires_in: 3600,
          token_type: "bearer",
          user,
        }),
      );
      await vi.waitFor(() =>
        expect(account.loadPersistedSession()?.access_token).toBe(
          "rotated-access",
        ),
      );
    } finally {
      response.resolve(
        Response.json({
          access_token: "rotated-access",
          refresh_token: "rotated-refresh",
          expires_in: 3600,
          token_type: "bearer",
          user,
        }),
      );
      await Promise.all(listeners.map((listener) => listener.stop()));
      await turn();
    }
  },
);
