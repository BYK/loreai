import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  RECALL_TOOL_DESCRIPTION,
  RECALL_TOOL_INPUT_SCHEMA,
  RECALL_TOOL_NAME,
} from "@loreai/core";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
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
  const tools: ToolDefinition[] = [];
  const handlers = new Map<string, AnyHandler>();
  const pi = {
    registerProvider(
      name: string,
      config: { baseUrl: string; headers: Record<string, string> },
    ): void {
      registrations.push({ name, config });
    },
    registerTool(tool: ToolDefinition): void {
      tools.push(tool);
    },
    on(event: string, handler: AnyHandler): void {
      handlers.set(event, handler);
    },
  };
  return { pi, registrations, tools, handlers };
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
    const { setUpstreamInterceptor } =
      (await import("../../gateway/src/pipeline")) as unknown as {
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
    config.remoteGateway = false;
    config.hostedMode = false;
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
      const { setUpstreamInterceptor, resetPipelineState } =
        (await import("../../gateway/src/pipeline")) as unknown as {
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

  test("registers recall as a native tool through Pi's extension API", () => {
    expect(mock.tools).toHaveLength(1);
    expect(mock.tools[0]?.parameters).not.toHaveProperty("anyOf");
    expect(mock.tools[0]).toMatchObject({
      name: RECALL_TOOL_NAME,
      description: RECALL_TOOL_DESCRIPTION,
      parameters: {
        type: RECALL_TOOL_INPUT_SCHEMA.type,
        additionalProperties: false,
      },
    });
  });

  test("does not register a local recall tool for a remote gateway", async () => {
    const previousEnv = { ...process.env };
    try {
      process.env.LORE_REMOTE_URL = baseURL;
      delete process.env.LORE_GATEWAY_URL;
      const remoteMock = createMockPi();
      await lorePiExtension(
        remoteMock.pi as unknown as Parameters<typeof lorePiExtension>[0],
      );
      expect(remoteMock.tools).toHaveLength(0);
    } finally {
      process.env = previousEnv;
    }
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
      {},
      {
        cwd: process.cwd(),
        sessionManager: {
          getSessionFile: () => "/tmp/lore-pi-e2e-session.json",
        },
      },
    );
    const after = mock.registrations.slice(before);
    expect(after.length).toBeGreaterThan(0);
    // The new registrations carry the derived (non-ephemeral) session id.
    const sid = after[0].config.headers["x-lore-session-id"];
    expect(sid).toMatch(/^pi-[0-9a-f]{24}$/);
  });

  test("re-registers when cwd changes without changing the session id", async () => {
    const root = mkdtempSync(join(tmpdir(), "lore-pi-workspace-"));
    try {
      const nested = join(root, "apps", "app");
      mkdirSync(nested, { recursive: true });
      writeFileSync(
        join(root, ".lore.json"),
        JSON.stringify({ workspaces: ["apps/*"] }),
      );
      const before = mock.registrations.length;
      const onStart = mock.handlers.get("session_start");
      await onStart?.(
        {},
        {
          cwd: nested,
          sessionManager: {
            getSessionFile: () => "/tmp/lore-pi-e2e-session.json",
          },
        },
      );
      const after = mock.registrations.slice(before);
      expect(after.length).toBeGreaterThan(0);
      expect(after[0].config.headers["x-lore-project"]).toBe(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
      },
      {},
    );
    // The gateway returns 404 session_not_found for a session that never sent
    // a turn; the handler must return undefined (use Pi's default compaction).
    expect(result).toBeUndefined();
  });

  test("native recall binds tool origins across rotation, model switches, overlap, and reload", async () => {
    const branch: unknown[] = [];
    let liveProvider = "anthropic";
    let sequence = 0;
    const sessionFile = "/tmp/lore-native-reinitialized.json";
    const context = {
      cwd: process.cwd(),
      sessionManager: {
        getSessionFile: () => sessionFile,
        getBranch: () => branch,
        getSessionName: () => "",
      },
      get model() {
        return { provider: liveProvider };
      },
    };
    const reload = async () => {
      const instance = createMockPi();
      await lorePiExtension(
        instance.pi as unknown as Parameters<typeof lorePiExtension>[0],
      );
      await instance.handlers.get("session_start")?.({}, context);
      return instance;
    };
    const first = await reload();
    const send = async (
      instance: ReturnType<typeof createMockPi>,
      provider: string,
      key: string,
      marker: string,
      calls: string[],
    ) => {
      const timestamp = ++sequence;
      await instance.handlers.get("turn_start")?.(
        { type: "turn_start", turnIndex: sequence, timestamp },
        context,
      );
      const registration = instance.registrations.findLast(
        (entry) => entry.name === "anthropic",
      )!;
      expect(registration.config.headers["x-lore-native-turn-id"]).toBeTruthy();
      const chat = await fetch(`${baseURL}/v1/messages`, {
        method: "POST",
        headers: {
          ...registration.config.headers,
          "content-type": "application/json",
          "x-api-key": key,
          "x-lore-agent": "build",
          "x-lore-provider": provider,
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1024,
          system: "You are a coding assistant. ".repeat(30),
          messages: [{ role: "user", content: marker }],
        }),
      });
      expect(chat.status).toBe(200);
      await chat.text();
      const message = {
        role: "assistant",
        provider,
        model: "claude-sonnet-4-20250514",
        timestamp,
        content: calls.map((id) => ({
          type: "toolCall",
          id,
          name: RECALL_TOOL_NAME,
          arguments: { query: "pi-turn-memory", scope: "session" },
        })),
      };
      await instance.handlers.get("message_start")?.(
        { type: "message_start", message },
        context,
      );
      branch.push({ type: "message", id: `entry-${timestamp}`, message });
    };
    const call = (
      instance: ReturnType<typeof createMockPi>,
      id: string,
      ctx = context,
    ) => {
      const tool = instance.tools[0]!;
      return tool
        .execute(
          id,
          { query: "pi-turn-memory", scope: "session" },
          new AbortController().signal,
          undefined,
          ctx as unknown as Parameters<typeof tool.execute>[4],
        )
        .then(JSON.stringify);
    };
    await send(first, "anthropic", "pi-token-a", "pi-turn-memory-alpha", [
      "call-a",
      "call-a-parallel",
    ]);
    await send(first, "minimax", "pi-token-b", "pi-turn-memory-beta", [
      "call-b",
    ]);
    liveProvider = "minimax";
    expect(await call(first, "call-a")).toContain("pi-turn-memory-alpha");
    expect(await call(first, "call-a-parallel")).toContain(
      "pi-turn-memory-alpha",
    );
    expect(await call(first, "call-b")).toContain("pi-turn-memory-beta");
    await send(
      first,
      "anthropic",
      "pi-rotated-token-a",
      "pi-turn-memory-rotated",
      ["call-rotated"],
    );
    expect(await call(first, "call-rotated")).toContain(
      "pi-turn-memory-rotated",
    );
    expect(await call(first, "call-a")).toContain("pi-turn-memory-alpha");
    const reloaded = await reload();
    await send(
      reloaded,
      "anthropic",
      "pi-reloaded-token",
      "pi-turn-memory-reloaded",
      ["call-reloaded"],
    );
    expect(await call(reloaded, "call-reloaded")).toContain(
      "pi-turn-memory-reloaded",
    );
    expect(await call(first, "call-rotated")).toContain(
      "pi-turn-memory-rotated",
    );
    expect(await call(reloaded, "call-a")).toContain("pi-turn-memory-alpha");
    expect(await call(first, "missing-call")).toContain("unavailable");
    expect(
      await call(first, "call-a", { ...context, cwd: "/other-project" }),
    ).toContain("unavailable");
    // A dynamically discovered provider has no static registration headers.
    // The first factory's shared interceptor must select this pending nonce,
    // never its original session/turn captured before extension reload.
    await reloaded.handlers.get("turn_start")?.(
      { type: "turn_start", turnIndex: 99, timestamp: 99 },
      context,
    );
    const custom = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "custom-provider-token",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1024,
        system: "You are a coding assistant. ".repeat(30),
        messages: [
          { role: "user", content: "pi-turn-memory-custom-after-reload" },
        ],
      }),
    });
    expect(custom.status).toBe(200);
    await custom.text();
    const customMessage = {
      role: "assistant",
      provider: "custom-provider",
      model: "claude-sonnet-4-20250514",
      timestamp: 99,
      content: [
        { type: "toolCall", id: "custom-call", name: RECALL_TOOL_NAME },
      ],
    };
    await reloaded.handlers.get("message_start")?.(
      { type: "message_start", message: customMessage },
      context,
    );
    branch.push({
      type: "message",
      id: "custom-entry",
      message: customMessage,
    });
    expect(await call(reloaded, "custom-call")).toContain(
      "pi-turn-memory-custom-after-reload",
    );
    expect(
      await call(first, "call-a", {
        ...context,
        sessionManager: {
          ...context.sessionManager,
          getSessionFile: () => "/tmp/other-session",
        },
      }),
    ).toContain("unavailable");
    // Overlap before either assistant starts is not attributable by timestamp
    // alone. Both credentials must remain unavailable, never use the latest.
    const pendingHeaders = [];
    for (const [turnIndex, instance] of [
      [100, first],
      [101, reloaded],
    ] as const) {
      await instance.handlers.get("agent_start")?.({}, context);
      await instance.handlers.get("turn_start")?.(
        { type: "turn_start", turnIndex, timestamp: turnIndex },
        context,
      );
      pendingHeaders.push(
        instance.registrations.findLast((entry) => entry.name === "anthropic")!
          .config.headers,
      );
    }
    for (const [index, headers] of pendingHeaders.entries()) {
      const response = await fetch(`${baseURL}/v1/messages`, {
        method: "POST",
        headers: {
          ...headers,
          "content-type": "application/json",
          "x-api-key": `overlapping-token-${index}`,
          "x-lore-agent": "build",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1024,
          system: "You are a coding assistant. ".repeat(30),
          messages: [
            { role: "user", content: `pi-turn-memory-overlap-${index}` },
          ],
        }),
      });
      expect(response.status).toBe(200);
      await response.text();
    }
    // Both account observations must already exist before either assistant
    // starts, otherwise a latest-turn mutant merely misses the second key.
    for (const index of [0, 1]) {
      const message = {
        role: "assistant",
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
        timestamp: 100 + index,
        content: [
          {
            type: "toolCall",
            id: `overlap-call-${index}`,
            name: RECALL_TOOL_NAME,
          },
        ],
      };
      await reloaded.handlers.get("message_start")?.(
        { type: "message_start", message },
        context,
      );
      branch.push({ type: "message", id: `overlap-entry-${index}`, message });
      expect(await call(reloaded, `overlap-call-${index}`)).toContain(
        "unavailable",
      );
    }
    await first.handlers.get("agent_end")?.({}, context);
    await reloaded.handlers.get("agent_end")?.({}, context);
    await send(
      reloaded,
      "anthropic",
      "after-overlap-token",
      "pi-turn-memory-after-overlap",
      ["after-overlap-call"],
    );
    expect(await call(reloaded, "after-overlap-call")).toContain(
      "pi-turn-memory-after-overlap",
    );
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
