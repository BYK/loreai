import { afterAll, beforeAll, describe, expect, test } from "vitest";
import lorePiExtension from "../src/index";
import { ANTHROPIC_PROVIDERS, OPENAI_PROVIDERS } from "../src/internal";

/**
 * End-to-end test: the Pi extension wired against a REAL in-process Lore
 * gateway. Proves the extension goes active, registers every gateway-routable
 * provider with the correct base URL + attribution headers, re-registers with
 * the real session id on `session_start`, gracefully falls back when the
 * gateway can't compact an unrouted session, and that the gateway actually
 * serves the `/v1/messages` route the extension points providers at (upstream
 * mocked — no real API call).
 */

// --- Mock Pi ExtensionAPI (captures registerProvider calls + event handlers) ---
type AnyHandler = (...args: unknown[]) => unknown;
interface Registration {
  name: string;
  config: { baseUrl: string; headers: Record<string, string> };
}
function createMockPi() {
  const registrations: Registration[] = [];
  const handlers = new Map<string, AnyHandler>();
  const pi = {
    registerProvider(
      name: string,
      config: { baseUrl: string; headers: Record<string, string> },
    ): void {
      registrations.push({ name, config });
    },
    on(event: string, handler: AnyHandler): void {
      handlers.set(event, handler);
    },
  };
  return { pi, registrations, handlers };
}

/** Minimal non-streaming Anthropic response (what the mocked upstream returns). */
function cannedAnthropicResponse(text: string): Response {
  return new Response(
    JSON.stringify({
      id: "msg_e2e_0",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text }],
      model: "claude-sonnet-4-20250514",
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 10 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("pi extension — e2e against a real gateway", () => {
  let baseURL: string;
  let stopServer: () => void;
  let mock: ReturnType<typeof createMockPi>;
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  // Upstream request bodies the gateway forwarded (proves a turn reached it).
  const upstreamSessions: Array<string | undefined> = [];

  beforeAll(async () => {
    const gwPkg = "@loreai/gateway";
    const gw = (await import(gwPkg)) as unknown as {
      loadConfig: () => { port: number } & Record<string, unknown>;
      startServer: (c: unknown) => Promise<{ stop: () => void; port: number }>;
      resetPipelineState: () => Promise<void>;
    };
    const { close: closeDB } = (await import("@loreai/core")) as unknown as {
      close: () => void;
    };
    const { setUpstreamInterceptor } = (await import(
      "../../gateway/src/pipeline"
    )) as unknown as {
      setUpstreamInterceptor: (
        fn:
          | ((
              body: unknown,
              model: string,
              streaming: boolean,
              makeReal: () => Promise<Response>,
            ) => Promise<Response>)
          | undefined,
      ) => void;
    };

    closeDB();
    await gw.resetPipelineState();

    // Mock upstream: never hit a real API; capture the x-lore session routing.
    setUpstreamInterceptor(async (body) => {
      const b = body as { metadata?: { user_id?: string } } | undefined;
      upstreamSessions.push(b?.metadata?.user_id);
      return cannedAnthropicResponse("hello from mock upstream");
    });

    const config = gw.loadConfig();
    config.port = 0;
    config.hosts = ["127.0.0.1"];
    const server = await gw.startServer(config);
    stopServer = () => server.stop();
    baseURL = `http://127.0.0.1:${server.port}`;

    // Activate the extension against the real gateway.
    process.env.LORE_PI_FORCE_ACTIVE = "1";
    process.env.LORE_GATEWAY_URL = baseURL;
    delete process.env.LORE_DISABLED;
    delete process.env.LORE_REMOTE_URL;

    mock = createMockPi();
    await lorePiExtension(
      mock.pi as unknown as Parameters<typeof lorePiExtension>[0],
    );
  });

  afterAll(async () => {
    globalThis.fetch = originalFetch;
    process.env = { ...originalEnv };
    stopServer?.();
    // Mirror the gateway harness teardown so no pipeline timers / interceptor
    // state leak into other tests sharing this worker.
    try {
      const { setUpstreamInterceptor, resetPipelineState } = (await import(
        "../../gateway/src/pipeline"
      )) as unknown as {
        setUpstreamInterceptor: (fn: undefined) => void;
        resetPipelineState: (opts?: { fast?: boolean }) => Promise<void>;
      };
      const { close: closeDB } = (await import("@loreai/core")) as unknown as {
        close: () => void;
      };
      setUpstreamInterceptor(undefined);
      closeDB();
      await resetPipelineState({ fast: true });
    } catch {
      /* best-effort */
    }
  });

  test("goes active and registers every gateway-routable provider", () => {
    const names = mock.registrations.map((r) => r.name);
    for (const p of [...ANTHROPIC_PROVIDERS, ...OPENAI_PROVIDERS]) {
      expect(names).toContain(p);
    }
    // Wired up its lifecycle hooks.
    expect(mock.handlers.get("session_start")).toBeTypeOf("function");
    expect(mock.handlers.get("session_before_compact")).toBeTypeOf("function");
  });

  test("points Anthropic providers at the gateway root and OpenAI at /v1", () => {
    const byName = new Map(mock.registrations.map((r) => [r.name, r.config]));
    expect(byName.get("anthropic")?.baseUrl).toBe(baseURL);
    expect(byName.get("openai")?.baseUrl).toBe(`${baseURL}/v1`);
    // Attribution header present on every registration.
    for (const r of mock.registrations) {
      expect(r.config.headers["x-lore-provider"]).toBe(r.name);
      expect(r.config.headers["x-lore-session-id"]).toBeTypeOf("string");
    }
  });

  test("re-registers with the derived session id on session_start", async () => {
    const before = mock.registrations.length;
    const onStart = mock.handlers.get("session_start");
    await onStart?.(
      {} as never,
      {
        cwd: process.cwd(),
        sessionManager: {
          getSessionFile: () => "/tmp/lore-pi-e2e-session.json",
        },
      } as never,
    );
    const after = mock.registrations.slice(before);
    expect(after.length).toBeGreaterThan(0);
    // The new registrations carry the derived (non-ephemeral) session id.
    const sid = after[0].config.headers["x-lore-session-id"];
    expect(sid).toMatch(/^pi-[0-9a-f]{24}$/);
  });

  test("compaction for an unrouted session falls back gracefully (real /v1/compact)", async () => {
    const onCompact = mock.handlers.get("session_before_compact");
    const result = await onCompact?.(
      {
        preparation: {
          previousSummary: "",
          firstKeptEntryId: "e1",
          tokensBefore: 100,
        },
      } as never,
      {} as never,
    );
    // The gateway returns 404 session_not_found for a session that never sent
    // a turn; the handler must return undefined (use Pi's default compaction).
    expect(result).toBeUndefined();
  });

  test("the gateway serves /v1/messages at the registered Anthropic baseUrl", async () => {
    const anthropic = mock.registrations.find((r) => r.name === "anthropic");
    expect(anthropic).toBeDefined();
    // POST to the exact base URL + headers the extension configured for Pi.
    const res = await originalFetch(
      `${anthropic?.config.baseUrl}/v1/messages`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": "test-key",
          "anthropic-version": "2023-06-01",
          ...anthropic?.config.headers,
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 64,
          messages: [{ role: "user", content: "hi" }],
        }),
      },
    );
    expect(res.ok).toBe(true);
    const body = (await res.json()) as {
      content: Array<{ type: string; text: string }>;
    };
    // The response is the mocked upstream — proving the turn flowed through the
    // gateway pipeline, not a real Anthropic endpoint.
    expect(body.content[0].text).toBe("hello from mock upstream");
    // The gateway forwarded under the extension's session attribution.
    expect(upstreamSessions.length).toBeGreaterThan(0);
  });
});
