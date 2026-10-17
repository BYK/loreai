import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { getTeamConfig } from "@loreai/core";
import {
  clearSession,
  getAuthedClient,
  loadCachedProviderToken,
  loadPersistedSession,
  persistProviderTokenCache,
  persistSession,
  SUPABASE_URL,
} from "../src/supabase";
import { startSessionRefreshScheduler } from "../src/session-refresh";
import { acquireGitHubProviderToken, commandLogout } from "../src/cli/login";

vi.mock("node:readline/promises", () => ({
  createInterface: () => ({
    question: async () => "fixture-pkce-code",
    close: () => {},
  }),
}));
vi.mock("qrcode-terminal", () => ({
  default: {
    setErrorLevel: () => {},
    generate: (_url: string, _options: unknown, done: (qr: string) => void) =>
      done("fixture QR"),
  },
}));

const jwt = (user: string, exp: number) =>
  [
    Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString(
      "base64url",
    ),
    Buffer.from(JSON.stringify({ exp, sub: user })).toString("base64url"),
    "test-signature",
  ].join(".");
const seconds = () => Math.floor(Date.now() / 1000);
const user = (id: string) => ({
  id,
  aud: "authenticated",
  email: `${id}@example.com`,
  user_metadata: {},
  app_metadata: {},
});
const saved = (id: string, remaining: number) => ({
  access_token: jwt(id, seconds() + remaining),
  refresh_token: `refresh-${id}`,
  expires_at: seconds() + remaining,
  user_id: id,
});
const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });

describe("real SDK authenticated client lifecycle", () => {
  let rotations: string[];
  let dataTokens: string[];
  let functionTokens: string[];
  let pkceGate: Promise<void> | undefined;
  let pkceStarted: (() => void) | undefined;
  let stop: (() => Promise<void>) | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    rotations = [];
    dataTokens = [];
    functionTokens = [];
    pkceGate = undefined;
    pkceStarted = undefined;
    clearSession();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(
          input instanceof Request ? input.url : String(input),
        );
        if (url.origin !== new URL(SUPABASE_URL).origin)
          throw new Error("Unexpected origin in isolated auth fixture");
        const token = new Headers(init?.headers)
          .get("Authorization")
          ?.replace(/^Bearer /, "");
        if (url.pathname === "/auth/v1/user") {
          const payload = JSON.parse(
            Buffer.from(token!.split(".")[1], "base64url").toString(),
          ) as { sub: string };
          return json(user(payload.sub));
        }
        if (url.pathname === "/auth/v1/token") {
          if (url.searchParams.get("grant_type") === "pkce") {
            pkceStarted?.();
            await pkceGate;
            return json({
              ...saved("user-a", 3600),
              expires_in: 3600,
              token_type: "bearer",
              provider_token: "fixture-github-token",
              user: user("user-a"),
            });
          }
          if (typeof init?.body !== "string")
            throw new Error("Expected JSON text in fixture refresh request");
          const body = JSON.parse(init.body) as {
            refresh_token: string;
          };
          rotations.push(body.refresh_token);
          const id = body.refresh_token
            .replace(/^refresh-/, "")
            .replace(/-rotated$/, "");
          return json({
            access_token: jwt(id, seconds() + 3600),
            refresh_token: `refresh-${id}-rotated`,
            expires_in: 3600,
            token_type: "bearer",
            user: user(id),
          });
        }
        if (url.pathname === "/rest/v1/profiles") {
          dataTokens.push(token ?? "");
          return json([]);
        }
        if (url.pathname === "/functions/v1/fixture") {
          functionTokens.push(token ?? "");
          return json({ ok: true });
        }
        throw new Error(`Unexpected fixture request: ${url.pathname}`);
      }),
    );
  });

  afterEach(async () => {
    const stopping = stop?.();
    // Drain the SDK's retry backoff on the unfixed implementation as well.
    await vi.advanceTimersByTimeAsync(60_000);
    await stopping;
    stop = undefined;
    clearSession();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  test("a data request inside the SDK's expiry margin persists its rotated token", async () => {
    persistSession(saved("user-a", 70));
    const client = await getAuthedClient();
    expect(client).not.toBeNull();
    const result = await client!.from("profiles").select("*");
    expect(result.error).toBeNull();
    // The coordinator may rotate proactively, or bypass the SDK's eager
    // refresh while this token remains valid. A rotation must never be lost.
    expect(rotations.length).toBeLessThanOrEqual(1);
    expect(loadPersistedSession()?.refresh_token).toBe(
      rotations.length ? "refresh-user-a-rotated" : "refresh-user-a",
    );
    expect(dataTokens).toEqual([loadPersistedSession()!.access_token]);
  });

  test("an existing client coordinates its next request after the token reaches expiry", async () => {
    persistSession(saved("user-a", 3600));
    const client = await getAuthedClient();
    await vi.advanceTimersByTimeAsync(3_550_000);
    const result = await client!.from("profiles").select("*");
    expect(result.error).toBeNull();
    expect(rotations).toHaveLength(1);
    expect(loadPersistedSession()?.refresh_token).toBe(
      "refresh-user-a-rotated",
    );
    expect(dataTokens).toEqual([loadPersistedSession()!.access_token]);
  });

  test("a fresh OAuth provider client persists later refreshes through the coordinator", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { client, providerToken } = await acquireGitHubProviderToken({
      noBrowser: true,
    });
    expect(providerToken).toBe("fixture-github-token");
    dataTokens = [];
    await vi.advanceTimersByTimeAsync(3_550_000);
    const result = await client.from("profiles").select("*");
    expect(result.error).toBeNull();
    expect(rotations).toHaveLength(1);
    expect(loadPersistedSession()?.refresh_token).toBe(
      "refresh-user-a-rotated",
    );
    expect(dataTokens).toEqual([loadPersistedSession()!.access_token]);
  });

  test.each(["later login", "anonymous logout"])(
    "a pending OAuth exchange cannot ignore %s",
    async (action) => {
      vi.spyOn(console, "log").mockImplementation(() => {});
      let release!: () => void;
      pkceGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        pkceStarted = resolve;
      });
      const pending = acquireGitHubProviderToken({ noBrowser: true });
      const outcome = pending.then(
        () => null,
        (error: unknown) => error,
      );
      void pending.catch(() => {});
      try {
        await started;
        const later = action === "later login" ? saved("user-b", 3600) : null;
        if (later) {
          const revision = persistSession(later);
          persistProviderTokenCache("fixture-provider-b", 3600, revision);
        } else {
          await commandLogout();
        }
        const provider = loadCachedProviderToken();
        release();
        const error = await outcome;
        expect(loadPersistedSession()).toEqual(later);
        expect(loadCachedProviderToken()).toEqual(provider);
        expect(error).toBeInstanceOf(Error);
        expect(error).toMatchObject({
          message: expect.stringMatching(/login|session|account/i),
        });
        expect(dataTokens).toEqual([]);
      } finally {
        release();
        await pending.catch(() => {});
      }
    },
  );

  test.each(["logout", "relogin", "switch"])(
    "an existing client refuses data requests after %s changes its login generation",
    async (action) => {
      const original = saved("user-a", 3600);
      persistSession(original);
      const client = await getAuthedClient();
      clearSession();
      if (action !== "logout")
        persistSession(action === "switch" ? saved("user-b", 3600) : original);
      await expect(
        client!.from("profiles").select("*").throwOnError().retry(false),
      ).rejects.toThrow(/login|session|account/i);
      const invoked = await client!.functions.invoke("fixture");
      expect(invoked.error).not.toBeNull();
      expect(dataTokens).toEqual([]);
      expect(functionTokens).toEqual([]);
      expect(rotations).toEqual([]);
      expect(loadPersistedSession()?.user_id ?? null).toBe(
        action === "logout" ? null : action === "switch" ? "user-b" : "user-a",
      );
    },
  );

  test("scheduler cancellation stops real SDK retry backoff promptly", async () => {
    persistSession(saved("user-a", -1));
    let attempts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        attempts++;
        return new Promise<Response>((_resolve, reject) => {
          const aborted = () =>
            reject(
              new DOMException("Fixture authentication aborted", "AbortError"),
            );
          if (init?.signal?.aborted) aborted();
          else init?.signal?.addEventListener("abort", aborted, { once: true });
        });
      }),
    );
    stop = startSessionRefreshScheduler({
      hostedMode: false,
      remoteGateway: false,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(attempts).toBe(1);
    let stopped = false;
    const stopping = stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(stopped).toBe(true);
    await stopping;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(attempts).toBe(1);
    expect(loadPersistedSession()?.refresh_token).toBe("refresh-user-a");
    expect(getTeamConfig("supabase.refresh.lease")).toBeNull();
  });
});
