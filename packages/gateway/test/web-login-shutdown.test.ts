import { afterEach, expect, test, vi } from "vitest";
import { dbReadGeneration } from "../../core/src/db";
import { startGateway } from "../src/cli/start";
import { loadConfig } from "../src/config";
import { startServer } from "../src/server";
import { clearSession, loadPersistedSession } from "../src/supabase";

const realFetch = globalThis.fetch;
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  clearSession();
});

function fixtureSession(nearExpiry = false, github = false) {
  return {
    access_token: "fixture-access",
    refresh_token: "fixture-refresh",
    expires_in: nearExpiry ? 30 : 3600,
    token_type: "bearer",
    ...(github ? { provider_token: "fixture-provider" } : {}),
    user: {
      id: "fixture-user",
      email: "person@example.test",
      user_metadata: {},
    },
  };
}

async function login(base: string, github = false): Promise<void> {
  const post = (path: string, body: unknown) =>
    realFetch(`${base}/api/v1/account/login/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const started = await post(github ? "github" : "email", {
    email: "person@example.test",
  });
  expect(started.status).toBe(200);
  const { attempt, url } = await started.json();
  if (github) {
    const callback = new URL(new URL(url).searchParams.get("redirect_to")!);
    callback.searchParams.set("code", "fixture-code");
    const verified = await realFetch(callback, { redirect: "manual" });
    expect(verified.status).toBe(303);
    expect(verified.headers.get("location")).toContain("login=success");
  } else {
    const verified = await post("verify", { attempt, code: "123456" });
    expect(verified.status).toBe(200);
    await verified.arrayBuffer();
  }
}

test.each(["profile", "refresh", "provision"] as const)(
  "embedded shutdown retires detached browser %s work before closing SQLite",
  async (kind) => {
    clearSession();
    const entered = Promise.withResolvers<void>();
    const response = Promise.withResolvers<Response>();
    const signals: AbortSignal[] = [];
    const publications = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(
          input instanceof Request ? input.url : String(input),
        );
        if (url.hostname === "127.0.0.1") return await realFetch(input, init);
        if (url.pathname.endsWith("/otp")) return Response.json({});
        if (url.pathname.endsWith("/verify"))
          return Response.json(fixtureSession(kind === "refresh"));
        if (url.pathname.endsWith("/token") && kind !== "refresh")
          return Response.json(fixtureSession(false, true));
        const held =
          (kind === "refresh" && url.pathname.endsWith("/token")) ||
          (kind === "profile" && url.pathname.endsWith("/profiles")) ||
          (kind === "provision" && url.pathname.endsWith("/github-provision"));
        if (held) {
          if (init?.signal) signals.push(init.signal);
          entered.resolve();
          // Deliberately ignore abort. Teardown must fence late continuations,
          // not rely on the remote transport obeying cancellation.
          return await response.promise;
        }
        if (url.pathname.endsWith("/profiles")) return Response.json(null);
        throw new Error("Unexpected fixture endpoint");
      },
    );
    const gateway = await startGateway({ port: 0, local: true, quiet: true });
    try {
      await turn();
      await login(`http://127.0.0.1:${gateway.port}`, kind === "provision");
      await entered.promise;
      expect(loadPersistedSession()?.user_id).toBe("fixture-user");
      await gateway.shutdown();
      const closedGeneration = dbReadGeneration();
      response.resolve(
        Response.json(
          kind === "refresh"
            ? fixtureSession()
            : kind === "profile"
              ? { display_name: "Late profile" }
              : { teams: 2 },
        ),
      );
      await turn();
      await turn();
      // This observer never calls db(), so the assertion cannot reopen SQLite.
      expect(dbReadGeneration()).toBe(closedGeneration);
      expect(signals).toHaveLength(1);
      expect(signals[0]?.aborted).toBe(true);
      expect(publications.mock.calls.flat().join(" ")).not.toContain(
        "Synced 2",
      );
    } finally {
      response.resolve(Response.json(null));
      await gateway.shutdown();
      await turn();
    }
  },
);

test("stopping another listener leaves the live owner's browser work available", async () => {
  clearSession();
  const entered = Promise.withResolvers<void>();
  const response = Promise.withResolvers<Response>();
  const config = {
    ...loadConfig(),
    port: 0,
    hosts: ["127.0.0.1"],
    hostedMode: false,
    remoteGateway: false,
  };
  const first = await startServer(config);
  const second = await startServer(config);
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname === "127.0.0.1") return await realFetch(input, init);
      if (url.pathname.endsWith("/otp")) return Response.json({});
      if (url.pathname.endsWith("/verify"))
        return Response.json(fixtureSession());
      if (url.pathname.endsWith("/profiles")) {
        entered.resolve();
        return await response.promise;
      }
      throw new Error("Unexpected fixture endpoint");
    },
  );
  try {
    await login(`http://127.0.0.1:${second.port}`);
    await entered.promise;
    await first.stop();
    response.resolve(Response.json({ display_name: "Live listener profile" }));
    await vi.waitFor(() =>
      expect(loadPersistedSession()?.display_name).toBe(
        "Live listener profile",
      ),
    );
  } finally {
    response.resolve(Response.json(null));
    await Promise.all([first.stop(), second.stop()]);
  }
});
