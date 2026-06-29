/**
 * End-to-end test: the OpenCode plugin's REAL active path against a REAL
 * in-process Lore gateway (upstream mocked — no real API call).
 *
 * Unlike the config-hook units (index.test.ts) and per-project header units
 * (session-state.test.ts) — which run with the plugin inert under
 * `NODE_ENV=test` — this test forces the plugin active via
 * `LORE_OPENCODE_FORCE_ACTIVE=1` and points it at a controlled gateway via
 * `LORE_GATEWAY_URL`, then proves the wiring the whole #1036/#1039 series
 * exists to guard:
 *   1. the plugin DISCOVERS the gateway (gatewayBase is resolved, not ""),
 *      so its `config` hook actually pins provider baseURLs to it,
 *   2. the `chat.headers` hook injects the `x-lore-*` attribution headers, and
 *   3. the process-wide fetch interceptor it installs transparently reroutes a
 *      provider call (`api.anthropic.com`) through the gateway to the upstream.
 *
 * If discovery or interceptor install regressed, gatewayBase would stay "" and
 * `applyLoreProviderConfig` would no-op (test 1 fails) and `globalThis.fetch`
 * would stay un-patched so the provider call would escape to the real network
 * (test 3 fails) — i.e. these assertions are non-vacuous against the failure
 * mode this series guards.
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { Hooks, PluginInput } from "@opencode-ai/plugin";
import { LorePlugin } from "../src/index";

// Capture the pristine fetch BEFORE the plugin installs its interceptor so we
// can restore it in afterAll. The interceptor patches `globalThis.fetch`
// process-wide; leaving it patched would corrupt every other test in this
// worker. (The plugin only installs once per process and never under
// NODE_ENV=test unless LORE_OPENCODE_FORCE_ACTIVE=1.)
const originalFetch = globalThis.fetch;

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
  // Snapshot the env vars we mutate so we restore the process exactly.
  const savedEnv: Record<string, string | undefined> = {};

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

    // Force the plugin's ACTIVE path while keeping NODE_ENV=test, and point
    // discovery at the gateway we just started. Clearing the remote/disabled
    // vars guarantees discovery resolves to LORE_GATEWAY_URL deterministically.
    for (const key of [
      "LORE_OPENCODE_FORCE_ACTIVE",
      "LORE_GATEWAY_URL",
      "LORE_REMOTE_URL",
      "LORE_DISABLED",
    ]) {
      savedEnv[key] = process.env[key];
    }
    process.env.LORE_OPENCODE_FORCE_ACTIVE = "1";
    process.env.LORE_GATEWAY_URL = baseURL;
    delete process.env.LORE_REMOTE_URL;
    delete process.env.LORE_DISABLED;

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
    // Restore the pristine fetch the plugin's interceptor patched — otherwise
    // every later test in this worker routes through a now-dead gateway.
    globalThis.fetch = originalFetch;
    // Restore env vars exactly as they were.
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
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

  test("the plugin discovered the gateway and installed the fetch interceptor", () => {
    // If discovery/interceptor-install regressed, the plugin would have stayed
    // inert (gatewayBase "") and never patched fetch.
    expect(globalThis.fetch).not.toBe(originalFetch);
  });

  test("the plugin's config hook pins provider baseURL to the discovered gateway", async () => {
    const cfg: Record<string, unknown> = {
      provider: { anthropic: { options: { apiKey: "x" } } },
    };
    // Drive the REAL plugin hook (not applyLoreProviderConfig directly): this
    // only pins a baseURL if the plugin actually resolved gatewayBase via
    // discovery. An inert plugin (gatewayBase "") would no-op and leave the
    // user's provider config untouched.
    await hooks.config?.(cfg);
    const provider = (
      cfg.provider as Record<
        string,
        { options: { baseURL: string; apiKey: string } }
      >
    ).anthropic;
    expect(provider.options.baseURL).toBe(`${baseURL}/v1`);
    // Existing user options are preserved through the merge.
    expect(provider.options.apiKey).toBe("x");
    // And built-in compaction is disabled by the same hook.
    expect(cfg.compaction).toEqual({ auto: false, prune: false });
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

  test("the installed interceptor reroutes a provider call through the gateway to the upstream", async () => {
    const before = upstreamCalls;
    // A bare provider call (as the @ai-sdk would make) to a REMOTE host. The
    // interceptor the plugin installed rewrites api.anthropic.com → gateway,
    // which forwards to the mocked upstream. The x-lore-* headers mimic what
    // chat.headers would have attached on a real turn (the interceptor
    // preserves all original headers and adds x-lore-upstream-url).
    const res = await fetch("https://api.anthropic.com/v1/messages", {
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
    // The call to the remote provider host was rerouted to the in-process
    // gateway (not the real network), which hit the mocked upstream.
    expect(upstreamCalls).toBeGreaterThan(before);
  });
});
