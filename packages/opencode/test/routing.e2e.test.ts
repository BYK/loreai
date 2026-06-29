/**
 * End-to-end test: the OpenCode plugin's routing config against a REAL
 * in-process Lore gateway (upstream mocked — no real API call).
 *
 * Proves that:
 *   - `applyLoreProviderConfig` pins a provider's `options.baseURL` to the
 *     gateway, and
 *   - the gateway actually serves `/v1/messages` and returns a response when
 *     called with the `x-lore-*` headers the plugin's `chat.headers` hook
 *     injects.
 *
 * Complements the existing config-hook units (index.test.ts), per-project
 * header units (session-state.test.ts), and the gateway startup smoke test
 * (gateway-smoke.test.ts).
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { Hooks, PluginInput } from "@opencode-ai/plugin";
import { LorePlugin } from "../src/index";
import { applyLoreProviderConfig } from "../src/internal";

function createMockClient() {
  return {
    tui: { showToast: () => Promise.resolve() },
    session: {
      get: () => Promise.resolve({ data: {} }),
      list: () => Promise.resolve({ data: [] }),
      create: () => Promise.resolve({ data: { id: "worker_1" } }),
      messages: () => Promise.resolve({ data: [] }),
      message: () => Promise.resolve({ data: null }),
      prompt: () => Promise.resolve({ data: {} }),
    },
  } as unknown as PluginInput["client"];
}

function cannedAnthropicResponse(text: string): Response {
  return new Response(
    JSON.stringify({
      id: "msg_oc_e2e_0",
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

describe("opencode plugin — e2e routing against a real gateway", () => {
  let baseURL: string;
  let stopServer: () => void;
  let hooks: Hooks;
  let upstreamCalls = 0;

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
    setUpstreamInterceptor(async () => {
      upstreamCalls += 1;
      return cannedAnthropicResponse("hello from mock upstream");
    });

    const config = gw.loadConfig();
    config.port = 0;
    config.hosts = ["127.0.0.1"];
    const server = await gw.startServer(config);
    stopServer = () => server.stop();
    baseURL = `http://127.0.0.1:${server.port}`;

    hooks = await LorePlugin({
      client: createMockClient(),
      project: { id: "proj-e2e" } as unknown as PluginInput["project"],
      directory: process.cwd(),
      worktree: process.cwd(),
      serverUrl: new URL("http://localhost:0"),
      $: {} as unknown as PluginInput["$"],
    } as PluginInput);
  });

  afterAll(async () => {
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

  test("applyLoreProviderConfig pins provider baseURL to the gateway /v1", () => {
    const cfg: Record<string, unknown> = {
      provider: { anthropic: { options: { apiKey: "x" } } },
    };
    applyLoreProviderConfig(cfg, baseURL);
    const provider = (
      cfg.provider as Record<string, { options: { baseURL: string } }>
    ).anthropic;
    expect(provider.options.baseURL).toBe(`${baseURL}/v1`);
    // Existing options are preserved.
    expect((provider.options as unknown as { apiKey: string }).apiKey).toBe(
      "x",
    );
  });

  test("chat.headers injects x-lore attribution headers", async () => {
    const input = {
      sessionID: "oc-sess-1",
      agent: "build",
      model: { providerID: "anthropic", modelID: "claude-3-5-sonnet" },
      provider: { id: "anthropic" },
      message: { id: "msg-1" },
    } as unknown as Parameters<NonNullable<Hooks["chat.headers"]>>[0];
    const output = { headers: {} as Record<string, string> } as Parameters<
      NonNullable<Hooks["chat.headers"]>
    >[1];

    await hooks["chat.headers"]?.(input, output);
    expect(output.headers["x-lore-session-id"]).toBe("oc-sess-1");
    expect(output.headers["x-lore-agent"]).toBe("build");
    expect(output.headers["x-lore-provider"]).toBe("anthropic");
  });

  test("the gateway serves /v1/messages and returns the mocked response", async () => {
    const res = await fetch(`${baseURL}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "test-key",
        "anthropic-version": "2023-06-01",
        "x-lore-session-id": "oc-sess-1",
        "x-lore-agent": "build",
        "x-lore-provider": "anthropic",
        "x-lore-project": process.cwd(),
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 64,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(res.ok).toBe(true);
    const body = (await res.json()) as {
      content: Array<{ type: string; text: string }>;
    };
    expect(body.content[0].text).toBe("hello from mock upstream");
    expect(upstreamCalls).toBeGreaterThan(0);
  });
});
