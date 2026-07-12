import { describe, test, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { LorePlugin } from "../src/index";
import { applyLoreProviderConfig } from "../src/internal";
import type { Plugin } from "@opencode-ai/plugin";

/**
 * Minimal mock of the OpenCode client. Only stubs the methods the plugin
 * actually calls during initialization.
 */
function createMockClient() {
  return {
    tui: {
      showToast: () => Promise.resolve(),
    },
    session: {
      get: () => Promise.resolve({ data: {} }),
      list: () => Promise.resolve({ data: [] }),
      create: () => Promise.resolve({ data: { id: "worker_1" } }),
      messages: () => Promise.resolve({ data: [] }),
      message: () => Promise.resolve({ data: null }),
      prompt: () => Promise.resolve({ data: {} }),
    },
  } as unknown as Parameters<Exclude<Plugin, undefined>>[0]["client"];
}

/**
 * Initialize the plugin with a mock client and temp directory.
 * Returns the plugin hooks.
 */
async function initPlugin() {
  const client = createMockClient();
  const tmpDir = `${fileURLToPath(new URL(".", import.meta.url))}/__tmp_plugin_${Date.now()}__`;
  const { mkdirSync, rmSync } = await import("node:fs");
  mkdirSync(tmpDir, { recursive: true });

  type PluginInput = Parameters<typeof LorePlugin>[0];
  const hooks = await LorePlugin({
    client,
    project: { id: "test", path: tmpDir } as unknown as PluginInput["project"],
    directory: tmpDir,
    worktree: tmpDir,
    serverUrl: new URL("http://localhost:0"),
    $: {} as unknown as PluginInput["$"],
  });

  return {
    hooks,
    tmpDir,
    cleanup: () => rmSync(tmpDir, { recursive: true, force: true }),
  };
}

describe("LorePlugin config hook", () => {
  test("disables built-in compaction", async () => {
    const { hooks, cleanup } = await initPlugin();
    try {
      const cfg: Record<string, unknown> = {};
      await hooks.config?.(cfg);

      expect(cfg.compaction).toEqual({ auto: false, prune: false });
    } finally {
      cleanup();
    }
  });

  test("registers hidden worker agents", async () => {
    const { hooks, cleanup } = await initPlugin();
    try {
      const cfg: Record<string, unknown> = {};
      await hooks.config?.(cfg);

      const agents = cfg.agent as Record<
        string,
        { mode?: string; hidden: boolean; description: string }
      >;
      expect(agents["lore-distill"]).toEqual({
        mode: "subagent",
        hidden: true,
        description: "Lore memory distillation worker",
      });
      expect(agents["lore-curator"]).toEqual({
        mode: "subagent",
        hidden: true,
        description: "Lore knowledge curator worker",
      });
      expect(agents["lore-query-expand"]).toEqual({
        mode: "subagent",
        hidden: true,
        description: "Lore query expansion worker",
      });

      // `hidden` is only honored by OpenCode for subagent-mode agents; assert
      // every internal worker is explicitly mode:"subagent" (not "all"/"primary")
      // so it never surfaces in the host project's agent/skill picker.
      for (const name of [
        "lore-distill",
        "lore-curator",
        "lore-query-expand",
      ]) {
        expect(agents[name].mode).toBe("subagent");
        expect(agents[name].hidden).toBe(true);
      }
    } finally {
      cleanup();
    }
  });

  test("preserves existing agent config", async () => {
    const { hooks, cleanup } = await initPlugin();
    try {
      const cfg: Record<string, unknown> = {
        agent: { "my-agent": { hidden: false, description: "Custom" } },
      };
      await hooks.config?.(cfg);

      const agents = cfg.agent as Record<string, unknown>;
      expect(agents["my-agent"]).toEqual({
        hidden: false,
        description: "Custom",
      });
      expect(agents["lore-distill"]).toBeDefined();
    } finally {
      cleanup();
    }
  });

  test("pins baseURL for every provider in cfg.provider (anthropic, openai, google, ...)", () => {
    // Regression test for the /messages-vs-/v1/messages 404: OpenCode can
    // derive the Anthropic baseURL from OPENAI_BASE_URL (stripping /v1),
    // which would send the SDK to `http://host/messages` (no /v1) and get
    // a 404 from the gateway. The plugin must pin EVERY provider's baseURL
    // to `${gatewayBase}/v1` because opencode's resolveSDK() bypasses the
    // OPENAI_BASE_URL/ANTHROPIC_BASE_URL env vars and every other @ai-sdk
    // provider has no baseURL env var at all.
    const cfg: Record<string, unknown> = {
      provider: {
        openai: { npm: "@ai-sdk/openai" },
        anthropic: { npm: "@ai-sdk/anthropic" },
        google: { npm: "@ai-sdk/google" },
        mistral: { npm: "@ai-sdk/mistral" },
      },
    };
    applyLoreProviderConfig(cfg, "http://127.0.0.1:3207");

    const provider = cfg.provider as Record<string, Record<string, unknown>>;
    for (const id of ["openai", "anthropic", "google", "mistral"]) {
      const options = provider[id].options as Record<string, unknown>;
      expect(options.baseURL).toBe("http://127.0.0.1:3207/v1");
    }
  });

  test("preserves existing per-provider options (e.g. custom headers)", () => {
    const cfg: Record<string, unknown> = {
      provider: {
        anthropic: {
          options: {
            defaultHeaders: { "X-Custom": "value" },
          },
        },
      },
    };
    applyLoreProviderConfig(cfg, "http://127.0.0.1:3207");

    const provider = cfg.provider as Record<string, Record<string, unknown>>;
    const options = provider.anthropic.options as Record<string, unknown>;
    // baseURL was pinned
    expect(options.baseURL).toBe("http://127.0.0.1:3207/v1");
    // Custom headers preserved by deep-merge
    expect(options.defaultHeaders).toEqual({ "X-Custom": "value" });
  });

  test("is a no-op when gatewayBase is empty (test env / startup failure)", () => {
    // In NODE_ENV=test the plugin's init skips gateway start, so
    // gatewayBase is "". We must not overwrite the user's provider config
    // with a broken "/v1" value in that case.
    const cfg: Record<string, unknown> = {
      provider: { openai: { npm: "@ai-sdk/openai" } },
    };
    applyLoreProviderConfig(cfg, "");
    const provider = cfg.provider as Record<string, unknown>;
    const openai = provider.openai as Record<string, unknown>;
    expect(openai.options).toBeUndefined();
  });

  test("is a no-op when cfg.provider is empty or absent", () => {
    const cfg: Record<string, unknown> = {};
    applyLoreProviderConfig(cfg, "http://127.0.0.1:3207");
    expect(cfg.provider).toBeUndefined();
  });

  test("skips non-object provider entries (defensive against malformed config)", () => {
    const cfg: Record<string, unknown> = {
      provider: {
        anthropic: { npm: "@ai-sdk/anthropic" },
        // Malformed: a string instead of an object. The plugin must not
        // crash or produce invalid config.
        glitch: "not-an-object" as unknown as Record<string, unknown>,
      },
    };
    applyLoreProviderConfig(cfg, "http://127.0.0.1:3207");
    const provider = cfg.provider as Record<string, unknown>;
    const anthropic = provider.anthropic as Record<string, unknown>;
    expect((anthropic.options as Record<string, unknown>).baseURL).toBe(
      "http://127.0.0.1:3207/v1",
    );
  });
});

describe("LorePlugin hooks", () => {
  test("returns an empty tool map", async () => {
    const { hooks, cleanup } = await initPlugin();
    try {
      expect(hooks.tool).toEqual({});
    } finally {
      cleanup();
    }
  });

  test("returns only config and tool hooks (no event/transform hooks)", async () => {
    const { hooks, cleanup } = await initPlugin();
    try {
      expect(hooks.config).toBeDefined();
      expect(hooks.tool).toBeDefined();
      // Only config, tool, and chat.headers hooks should be registered
      expect(hooks.event).toBeUndefined();
      expect(hooks["experimental.chat.system.transform"]).toBeUndefined();
      expect(hooks["experimental.chat.messages.transform"]).toBeUndefined();
      expect(hooks["experimental.session.compacting"]).toBeUndefined();
    } finally {
      cleanup();
    }
  });
});

describe("plugin entry module export shape", () => {
  // Regression guard for the v1.17.4 crash (`undefined is not an object
  // (evaluating 'A.event')`). OpenCode's legacy plugin loader iterates
  // `Object.values(mod)` (`getLegacyPlugins`/`getServerPlugin`): every
  // FUNCTION export is invoked as a plugin (and its return value pushed into
  // the host hooks array — `applyLoreProviderConfig` returned `undefined`,
  // which then crashed the dispatch loops), and every NON-function export
  // makes the loader throw `Plugin export is not a function`, dropping the
  // plugin entirely. So the entry module must export ONLY the plugin (the
  // named `LorePlugin` and the same-reference `default`) — nothing else.
  test("exports only the plugin (LorePlugin + same-ref default)", async () => {
    const mod = (await import("../src/index")) as Record<string, unknown>;

    // The default export must be the LorePlugin function reference.
    expect(typeof mod.default).toBe("function");
    expect(mod.default).toBe(mod.LorePlugin);

    // The ONLY export keys allowed are `LorePlugin` and `default`. Any other
    // export — function OR not — breaks the legacy loader (functions get
    // invoked as bogus plugins; non-functions make it throw). This is the
    // strict guard: it catches both failure modes, including a future
    // `export const FOO = ...` that a function-only filter would miss.
    expect(Object.keys(mod).sort()).toEqual(["LorePlugin", "default"]);

    // Belt-and-suspenders: simulate getLegacyPlugins' reference dedup so the
    // host invokes exactly one plugin function (the named + default pair).
    const uniqueFns = new Set<unknown>(
      Object.values(mod).filter((value) => typeof value === "function"),
    );
    expect(uniqueFns.size).toBe(1);
    expect(uniqueFns.has(mod.LorePlugin)).toBe(true);
  });
});
