import { log } from "@loreai/core";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  ANTHROPIC_PROVIDERS,
  buildProviderRegistrations,
  gatewayAccessHeadersForRemote,
  GATEWAY_PROVIDERS,
  OPENAI_PROVIDERS,
  resolveGatewayUrl,
  runCompaction,
  sessionIDFor,
} from "../src/internal";

const GW = "http://127.0.0.1:31234";

const silentSink = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  captureException: vi.fn(),
};

afterEach(() => {
  log.registerSink(silentSink);
  vi.restoreAllMocks();
});

describe("buildProviderRegistrations", () => {
  test("routes Anthropic providers to the gateway root, OpenAI to /v1", () => {
    const regs = buildProviderRegistrations({
      gatewayBase: GW,
      sessionID: "sess-1",
      projectPath: "/proj",
      env: {},
    });
    const byProvider = new Map(regs.map((r) => [r.provider, r]));

    // One registration per gateway-routable provider.
    expect(regs).toHaveLength(GATEWAY_PROVIDERS.length);

    for (const p of ANTHROPIC_PROVIDERS) {
      expect(byProvider.get(p)?.baseUrl).toBe(GW);
    }
    for (const p of OPENAI_PROVIDERS) {
      expect(byProvider.get(p)?.baseUrl).toBe(`${GW}/v1`);
    }
  });

  test("every registration carries session/project/provider attribution headers", () => {
    const regs = buildProviderRegistrations({
      gatewayBase: GW,
      sessionID: "sess-2",
      projectPath: "/work/repo",
      env: {},
    });
    for (const reg of regs) {
      expect(reg.headers["x-lore-session-id"]).toBe("sess-2");
      expect(reg.headers["x-lore-project"]).toBe("/work/repo");
      expect(reg.headers["x-lore-provider"]).toBe(reg.provider);
    }
  });

  test("injects git remote only when provided", () => {
    const withRemote = buildProviderRegistrations({
      gatewayBase: GW,
      sessionID: "s",
      projectPath: "/p",
      gitRemote: "git@github.com:acme/repo.git",
      env: {},
    });
    expect(withRemote[0].headers["x-lore-git-remote"]).toBe(
      "git@github.com:acme/repo.git",
    );

    const withoutRemote = buildProviderRegistrations({
      gatewayBase: GW,
      sessionID: "s",
      projectPath: "/p",
      env: {},
    });
    for (const reg of withoutRemote) {
      expect(reg.headers["x-lore-git-remote"]).toBeUndefined();
    }
  });

  test("injects x-lore-upstream-url from LORE_UPSTREAM_<PROVIDER> on that provider only", () => {
    const regs = buildProviderRegistrations({
      gatewayBase: GW,
      sessionID: "s",
      projectPath: "/p",
      env: { LORE_UPSTREAM_VLLM: "http://localhost:8000" },
    });
    const byProvider = new Map(regs.map((r) => [r.provider, r]));
    expect(byProvider.get("vllm")?.headers["x-lore-upstream-url"]).toBe(
      "http://localhost:8000",
    );
    // A different provider must NOT pick up vllm's upstream.
    expect(
      byProvider.get("ollama")?.headers["x-lore-upstream-url"],
    ).toBeUndefined();
  });

  test("injects remote gateway access into every provider registration", () => {
    const token = "pi-remote-gateway-access-token-at-least-32";
    const regs = buildProviderRegistrations({
      gatewayBase: "https://lore.example",
      sessionID: "s",
      projectPath: "/p",
      env: {
        LORE_REMOTE_URL: "https://lore.example/",
        LORE_GATEWAY_AUTH_TOKEN: token,
      },
    });
    for (const reg of regs) {
      expect(reg.headers["x-lore-gateway-token"]).toBe(token);
    }
  });

  test("keeps local/non-matching gateways free of the remote access token", () => {
    const env = {
      LORE_REMOTE_URL: "https://lore.example",
      LORE_GATEWAY_AUTH_TOKEN: "pi-remote-gateway-access-token-at-least-32",
    };
    expect(gatewayAccessHeadersForRemote(GW, env)).toEqual({});
    const regs = buildProviderRegistrations({
      gatewayBase: GW,
      sessionID: "s",
      projectPath: "/p",
      env,
    });
    expect(regs.every((reg) => !reg.headers["x-lore-gateway-token"])).toBe(
      true,
    );
  });
});

describe("sessionIDFor", () => {
  test("returns an ephemeral, per-process id when no session file", () => {
    expect(sessionIDFor(undefined)).toBe(`pi-ephemeral-${process.pid}`);
  });

  test("derives a stable pi-<24hex> id from the session file path", () => {
    const a = sessionIDFor("/home/u/.pi/sessions/abc.json");
    const b = sessionIDFor("/home/u/.pi/sessions/abc.json");
    expect(a).toBe(b); // stable
    expect(a).toMatch(/^pi-[0-9a-f]{24}$/);
    // Different files → different ids.
    expect(sessionIDFor("/home/u/.pi/sessions/def.json")).not.toBe(a);
  });
});

describe("runCompaction", () => {
  const base = {
    gatewayBase: GW,
    sessionID: "sess-c",
    projectPath: "/proj",
    previousSummary: "prev",
    firstKeptEntryId: "entry-7",
    tokensBefore: 4242,
    authHeaders: { authorization: "Bearer pi-auth" },
  };

  test("passes gateway access separately from provider authorization", async () => {
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify({ cancel: true }), { status: 200 }),
    );
    await runCompaction({
      ...base,
      authHeaders: {
        authorization: "Bearer pi-provider-auth",
        "x-lore-gateway-token": "pi-gateway-access-token-at-least-32",
      },
      fetchImpl,
    });

    const headers = fetchImpl.mock.calls[0][1]?.headers as Record<
      string,
      string
    >;
    expect(headers.authorization).toBe("Bearer pi-provider-auth");
    expect(headers["x-lore-gateway-token"]).toBe(
      "pi-gateway-access-token-at-least-32",
    );
  });

  test("POSTs to /v1/compact with session header + body, returns shaped result", async () => {
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify({ summary: "fresh summary" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const result = await runCompaction({ ...base, fetchImpl });

    expect(fetchImpl).toHaveBeenCalledOnce();
    const call = fetchImpl.mock.calls[0];
    if (!call) throw new Error("missing compaction fetch call");
    const [url, init] = call;
    if (!init) throw new Error("missing compaction fetch options");
    expect(url).toBe(`${GW}/v1/compact`);
    expect((init.headers as Record<string, string>)["x-lore-session-id"]).toBe(
      "sess-c",
    );
    expect((init.headers as Record<string, string>).authorization).toBe(
      "Bearer pi-auth",
    );
    expect(JSON.parse(init?.body as string)).toEqual({
      project_path: "/proj",
      previous_summary: "prev",
      tokens_before: 4242,
    });

    expect(result).toEqual({
      compaction: {
        summary: "fresh summary",
        firstKeptEntryId: "entry-7",
        tokensBefore: 4242,
      },
    });
  });

  test("relays { cancel: true } from the gateway as { cancel: true } (no summary fetch)", async () => {
    // The gateway is the authoritative source for "does this session fit?".
    // When it says cancel: true, the plugin MUST relay that as-is to Pi's
    // session_before_compact hook. The fetch still happens (we don't know
    // until we ask) but the summary branch is skipped entirely.
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ cancel: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const result = await runCompaction({ ...base, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(result).toEqual({ cancel: true });
  });

  test("prefers cancel over summary if the gateway returns both (cancel wins)", async () => {
    // Defensive: if a future gateway version returns { cancel: true, summary: "..." },
    // the cancel signal must win. (Current gateway never returns both, but the
    // precedence is part of the relay contract.)
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ cancel: true, summary: "should be ignored" }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const result = await runCompaction({ ...base, fetchImpl });
    expect(result).toEqual({ cancel: true });
  });

  test("returns undefined on 404 session_not_found (graceful fallback)", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "session_not_found" }), {
          status: 404,
        }),
    );
    expect(await runCompaction({ ...base, fetchImpl })).toBeUndefined();
  });

  test("returns undefined on a non-2xx error", async () => {
    const fetchImpl = vi.fn(async () => new Response("boom", { status: 500 }));
    expect(await runCompaction({ ...base, fetchImpl })).toBeUndefined();
  });

  test("logs only status diagnostics for rejected compactions, never response text or statusText", async () => {
    const bodyMarker = "PRIVATE_PI_RESPONSE_BODY_MARKER";
    const reasonMarker = "PRIVATE_PI_REASON_MARKER";
    const messages: string[] = [];
    log.registerSink({
      info: (message) => messages.push(message),
      warn: (message) => messages.push(message),
      error: (message) => messages.push(message),
      captureException: vi.fn(),
    });
    const fetchImpl = vi.fn(
      async () =>
        new Response(bodyMarker, {
          status: 502,
          statusText: reasonMarker,
        }),
    );

    expect(await runCompaction({ ...base, fetchImpl })).toBeUndefined();

    const output = messages.join("\n");
    expect(output).toContain("502");
    expect(output).not.toContain(bodyMarker);
    expect(output).not.toContain(reasonMarker);
  });

  test("does not log thrown request details", async () => {
    const thrownMarker = "PRIVATE_PI_THROWN_ERROR_MARKER";
    const messages: string[] = [];
    log.registerSink({
      info: (message) => messages.push(message),
      warn: (message) => messages.push(message),
      error: (message) => messages.push(message),
      captureException: vi.fn(),
    });
    const fetchImpl = vi.fn(async () => {
      throw new Error(thrownMarker);
    });

    expect(await runCompaction({ ...base, fetchImpl })).toBeUndefined();
    expect(messages.join("\n")).not.toContain(thrownMarker);
  });

  test("does not log a malformed successful response prefix", async () => {
    const bodyMarker = "PRIVATE_PI_MALFORMED_PREFIX";
    const messages: string[] = [];
    log.registerSink({
      info: (message) => messages.push(message),
      warn: (message) => messages.push(message),
      error: (message) => messages.push(message),
      captureException: vi.fn(),
    });
    const fetchImpl = vi.fn(
      async () => new Response(`${bodyMarker} not-json`, { status: 200 }),
    );

    expect(await runCompaction({ ...base, fetchImpl })).toBeUndefined();
    expect(messages.join("\n")).not.toContain(bodyMarker);
  });

  test("returns undefined when the request throws", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    expect(await runCompaction({ ...base, fetchImpl })).toBeUndefined();
  });

  test("returns undefined on a 2xx with an empty summary and no cancel", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ summary: "" }), { status: 200 }),
    );
    expect(await runCompaction({ ...base, fetchImpl })).toBeUndefined();
  });
});

describe("resolveGatewayUrl diagnostics", () => {
  test("returns and probes a remote URL without userinfo, query, or fragment", async () => {
    const previousRemote = process.env.LORE_REMOTE_URL;
    const previousGateway = process.env.LORE_GATEWAY_URL;
    const previousFetch = globalThis.fetch;
    try {
      process.env.LORE_REMOTE_URL =
        "https://user:PRIVATE_PI_SUCCESS_USERINFO@example.com/gateway" +
        "?token=PRIVATE_PI_SUCCESS_QUERY#PRIVATE_PI_SUCCESS_FRAGMENT";
      delete process.env.LORE_GATEWAY_URL;
      const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
      globalThis.fetch = fetchMock;

      await expect(resolveGatewayUrl()).resolves.toBe(
        "https://example.com/gateway",
      );
      expect(fetchMock).toHaveBeenCalledWith(
        "https://example.com/gateway/health",
        expect.anything(),
      );
    } finally {
      if (previousRemote === undefined) delete process.env.LORE_REMOTE_URL;
      else process.env.LORE_REMOTE_URL = previousRemote;
      if (previousGateway === undefined) delete process.env.LORE_GATEWAY_URL;
      else process.env.LORE_GATEWAY_URL = previousGateway;
      globalThis.fetch = previousFetch;
    }
  });

  test("strips URL userinfo, query, and fragment from the remote failure log", async () => {
    const previousRemote = process.env.LORE_REMOTE_URL;
    const previousGateway = process.env.LORE_GATEWAY_URL;
    const previousFetch = globalThis.fetch;
    const userinfoMarker = "PRIVATE_PI_URL_USERINFO";
    const queryMarker = "PRIVATE_PI_URL_QUERY";
    const fragmentMarker = "PRIVATE_PI_URL_FRAGMENT";
    const messages: string[] = [];
    try {
      process.env.LORE_REMOTE_URL =
        `https://user:${userinfoMarker}@example.com/gateway` +
        `?token=${queryMarker}#${fragmentMarker}`;
      delete process.env.LORE_GATEWAY_URL;
      globalThis.fetch = vi.fn(async () => {
        throw new Error("unreachable");
      });
      log.registerSink({
        info: (message) => messages.push(message),
        warn: (message) => messages.push(message),
        error: (message) => messages.push(message),
        captureException: vi.fn(),
      });

      await resolveGatewayUrl();

      const output = messages.join("\n");
      expect(output).toContain("https://example.com/gateway");
      expect(output).not.toContain(userinfoMarker);
      expect(output).not.toContain(queryMarker);
      expect(output).not.toContain(fragmentMarker);
    } finally {
      if (previousRemote === undefined) delete process.env.LORE_REMOTE_URL;
      else process.env.LORE_REMOTE_URL = previousRemote;
      if (previousGateway === undefined) delete process.env.LORE_GATEWAY_URL;
      else process.env.LORE_GATEWAY_URL = previousGateway;
      globalThis.fetch = previousFetch;
    }
  });
});
