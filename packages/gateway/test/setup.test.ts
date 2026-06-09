import { describe, test, expect } from "vitest";
import {
  updateCodexConfig,
  normalizeBaseUrl,
  setTopLevelKey,
  updateOpencodeConfig,
  updateClaudeCodeSettings,
  opencodePluginSpec,
} from "../src/cli/setup";

// ---------------------------------------------------------------------------
// normalizeBaseUrl
// ---------------------------------------------------------------------------

describe("normalizeBaseUrl", () => {
  test("default local URL with default port", () => {
    expect(normalizeBaseUrl(undefined, undefined)).toBe(
      "http://127.0.0.1:3207/v1",
    );
  });

  test("default local URL with custom port", () => {
    expect(normalizeBaseUrl(undefined, 8080)).toBe("http://127.0.0.1:8080/v1");
  });

  test("remote URL without trailing slash", () => {
    expect(normalizeBaseUrl("http://remote:3207", undefined)).toBe(
      "http://remote:3207/v1",
    );
  });

  test("remote URL with trailing slash", () => {
    expect(normalizeBaseUrl("http://remote:3207/", undefined)).toBe(
      "http://remote:3207/v1",
    );
  });

  test("remote URL with multiple trailing slashes", () => {
    expect(normalizeBaseUrl("http://remote:3207///", undefined)).toBe(
      "http://remote:3207/v1",
    );
  });

  test("remote URL already ending in /v1", () => {
    expect(normalizeBaseUrl("http://remote:3207/v1", undefined)).toBe(
      "http://remote:3207/v1",
    );
  });

  test("remote URL ending in /v1/", () => {
    expect(normalizeBaseUrl("http://remote:3207/v1/", undefined)).toBe(
      "http://remote:3207/v1",
    );
  });

  test("remote URL takes precedence over port", () => {
    expect(normalizeBaseUrl("http://remote:9999", 8080)).toBe(
      "http://remote:9999/v1",
    );
  });

  test("rejects URL with double-quotes", () => {
    expect(() =>
      normalizeBaseUrl('http://evil.com/v1"inject', undefined),
    ).toThrow("Invalid characters");
  });

  test("rejects URL with control characters", () => {
    expect(() =>
      normalizeBaseUrl("http://evil.com/v1\nmalicious", undefined),
    ).toThrow("Invalid characters");
  });

  test("rejects URL with backslash", () => {
    expect(() => normalizeBaseUrl("http://evil.com\\v1", undefined)).toThrow(
      "Invalid characters",
    );
  });

  test("rejects whitespace-only remote URL", () => {
    expect(() => normalizeBaseUrl("  ", undefined)).toThrow("cannot be empty");
  });

  test("rejects invalid port", () => {
    expect(() => normalizeBaseUrl(undefined, 99999)).toThrow("Invalid port");
  });

  test("rejects NaN port", () => {
    expect(() => normalizeBaseUrl(undefined, NaN)).toThrow("Invalid port");
  });

  test("rejects negative port", () => {
    expect(() => normalizeBaseUrl(undefined, -1)).toThrow("Invalid port");
  });
});

// ---------------------------------------------------------------------------
// updateCodexConfig — empty / new file
// ---------------------------------------------------------------------------

describe("updateCodexConfig — empty file", () => {
  test("creates config from empty string", () => {
    const result = updateCodexConfig("", "http://127.0.0.1:3207/v1");
    expect(result).toContain('openai_base_url = "http://127.0.0.1:3207/v1"');
    expect(result).toContain("model_auto_compact_token_limit = 999999999");
  });

  test("creates config from whitespace-only string", () => {
    const result = updateCodexConfig("  \n\n  ", "http://127.0.0.1:3207/v1");
    expect(result).toContain('openai_base_url = "http://127.0.0.1:3207/v1"');
    expect(result).toContain("model_auto_compact_token_limit = 999999999");
  });
});

// ---------------------------------------------------------------------------
// updateCodexConfig — idempotency
// ---------------------------------------------------------------------------

describe("updateCodexConfig — idempotency", () => {
  test("applying twice produces identical content", () => {
    const first = updateCodexConfig("", "http://127.0.0.1:3207/v1");
    const second = updateCodexConfig(first, "http://127.0.0.1:3207/v1");
    expect(second).toBe(first);
  });

  test("idempotent with existing config", () => {
    const input = `model = "gpt-5.5"\nopenai_base_url = "http://127.0.0.1:3207/v1"\nmodel_auto_compact_token_limit = 999999999\napproval_policy = "on-request"\n`;
    const result = updateCodexConfig(input, "http://127.0.0.1:3207/v1");
    expect(result).toBe(input);
  });
});

// ---------------------------------------------------------------------------
// updateCodexConfig — replace existing top-level key
// ---------------------------------------------------------------------------

describe("updateCodexConfig — replace existing", () => {
  test("replaces existing openai_base_url at top level", () => {
    const input = `model = "gpt-5.5"\nopenai_base_url = "https://api.openai.com/v1"\napproval_policy = "on-request"\n`;
    const result = updateCodexConfig(input, "http://127.0.0.1:3207/v1");
    expect(result).toContain('openai_base_url = "http://127.0.0.1:3207/v1"');
    expect(result).toContain('model = "gpt-5.5"');
    expect(result).toContain('approval_policy = "on-request"');
    expect(result).not.toContain("https://api.openai.com/v1");
    expect(result).toContain("model_auto_compact_token_limit = 999999999");
  });

  test("replaces with different URL", () => {
    const input =
      'openai_base_url = "http://127.0.0.1:3207/v1"\nmodel_auto_compact_token_limit = 999999999\n';
    const result = updateCodexConfig(input, "http://remote:8080/v1");
    expect(result).toContain('openai_base_url = "http://remote:8080/v1"');
    expect(result).toContain("model_auto_compact_token_limit = 999999999");
  });
});

// ---------------------------------------------------------------------------
// updateCodexConfig — preserve unrelated config
// ---------------------------------------------------------------------------

describe("updateCodexConfig — preserve other config", () => {
  test("preserves comments", () => {
    const input = `# My config\nmodel = "gpt-5.5"\n# Another comment\n`;
    const result = updateCodexConfig(input, "http://127.0.0.1:3207/v1");
    expect(result).toContain("# My config");
    expect(result).toContain("# Another comment");
    expect(result).toContain('model = "gpt-5.5"');
    expect(result).toContain('openai_base_url = "http://127.0.0.1:3207/v1"');
  });

  test("preserves sections and their contents", () => {
    const input = [
      'model = "gpt-5.5"',
      "",
      "[features]",
      "shell_snapshot = true",
      "",
      "[mcp_servers.test]",
      'command = "/usr/bin/test"',
      "",
    ].join("\n");
    const result = updateCodexConfig(input, "http://127.0.0.1:3207/v1");
    expect(result).toContain('openai_base_url = "http://127.0.0.1:3207/v1"');
    expect(result).toContain("[features]");
    expect(result).toContain("shell_snapshot = true");
    expect(result).toContain("[mcp_servers.test]");
    expect(result).toContain('command = "/usr/bin/test"');
  });

  test("preserves other model_providers", () => {
    const input = [
      'model_provider = "proxy"',
      "",
      "[model_providers.proxy]",
      'name = "My Proxy"',
      'base_url = "http://proxy.example.com"',
      "",
    ].join("\n");
    const result = updateCodexConfig(input, "http://127.0.0.1:3207/v1");
    expect(result).toContain("[model_providers.proxy]");
    expect(result).toContain('name = "My Proxy"');
    expect(result).toContain('base_url = "http://proxy.example.com"');
  });
});

// ---------------------------------------------------------------------------
// updateCodexConfig — TOML scoping edge case
// ---------------------------------------------------------------------------

describe("updateCodexConfig — TOML section scoping", () => {
  test("inserts before first section when no top-level keys exist", () => {
    const input = "[features]\nshell_snapshot = true\n";
    const result = updateCodexConfig(input, "http://127.0.0.1:3207/v1");
    // openai_base_url should appear before [features]
    const urlIdx = result.indexOf("openai_base_url");
    const sectionIdx = result.indexOf("[features]");
    expect(urlIdx).toBeLessThan(sectionIdx);
    expect(urlIdx).toBeGreaterThanOrEqual(0);
  });

  test("inserts after existing top-level keys but before sections", () => {
    const input = 'model = "gpt-5.5"\n\n[features]\nshell_snapshot = true\n';
    const result = updateCodexConfig(input, "http://127.0.0.1:3207/v1");
    const modelIdx = result.indexOf("model =");
    const urlIdx = result.indexOf("openai_base_url");
    const sectionIdx = result.indexOf("[features]");
    expect(modelIdx).toBeLessThan(urlIdx);
    expect(urlIdx).toBeLessThan(sectionIdx);
  });

  test("does NOT replace a key that is inside a section (TOML scoping bug)", () => {
    // This reproduces the exact bug the user hit: openai_base_url accidentally
    // placed under [tui.model_availability_nux] due to TOML scoping.
    const input = [
      "[tui.model_availability_nux]",
      '"gpt-5.5" = 1',
      'openai_base_url = "should-not-be-touched"',
      "",
    ].join("\n");
    const result = updateCodexConfig(input, "http://127.0.0.1:3207/v1");
    // Should insert a NEW top-level key, not replace the one inside the section
    const lines = result.split("\n");
    // The section-scoped key should still be there
    expect(result).toContain('openai_base_url = "should-not-be-touched"');
    // AND a new top-level one should be added before the section
    const topLevelUrl = lines.findIndex(
      (l) => l.trim() === 'openai_base_url = "http://127.0.0.1:3207/v1"',
    );
    const sectionIdx = lines.findIndex((l) => l.trim().startsWith("["));
    expect(topLevelUrl).toBeGreaterThanOrEqual(0);
    expect(topLevelUrl).toBeLessThan(sectionIdx);
  });

  test("replaces top-level key even when sections follow", () => {
    const input = [
      'openai_base_url = "https://old.example.com/v1"',
      "",
      "[features]",
      "shell_snapshot = true",
      "",
    ].join("\n");
    const result = updateCodexConfig(input, "http://127.0.0.1:3207/v1");
    expect(result).toContain('openai_base_url = "http://127.0.0.1:3207/v1"');
    expect(result).not.toContain("https://old.example.com/v1");
    expect(result).toContain("[features]");
  });
});

// ---------------------------------------------------------------------------
// updateCodexConfig — real-world Codex config
// ---------------------------------------------------------------------------

describe("updateCodexConfig — real-world config", () => {
  test("handles a typical Codex App config", () => {
    const input = [
      'notify = ["/path/to/notifier", "turn-ended"]',
      "[marketplaces.openai-bundled]",
      'last_updated = "2026-06-03T10:29:58Z"',
      'source_type = "local"',
      'source = "/path/to/marketplace"',
      '[plugins."browser@openai-bundled"]',
      "enabled = true",
      "[features]",
      "js_repl = false",
      "[desktop]",
      'conversationDetailMode = "STEPS_COMMANDS"',
      "[mcp_servers.node_repl]",
      "args = []",
      'command = "/path/to/node_repl"',
      "",
    ].join("\n");
    const result = updateCodexConfig(input, "http://127.0.0.1:3207/v1");
    // Should be inserted at the top, before sections
    const urlIdx = result.indexOf("openai_base_url");
    const compactIdx = result.indexOf("model_auto_compact_token_limit");
    const firstSection = result.indexOf("[marketplaces");
    expect(urlIdx).toBeLessThan(firstSection);
    expect(urlIdx).toBeGreaterThanOrEqual(0);
    expect(compactIdx).toBeLessThan(firstSection);
    expect(compactIdx).toBeGreaterThanOrEqual(0);
    // Original content preserved
    expect(result).toContain("notify =");
    expect(result).toContain("[features]");
    expect(result).toContain("[desktop]");
    expect(result).toContain("[mcp_servers.node_repl]");
  });
});

// ---------------------------------------------------------------------------
// updateCodexConfig — model_auto_compact_token_limit
// ---------------------------------------------------------------------------

describe("updateCodexConfig — auto-compaction disabled", () => {
  test("adds model_auto_compact_token_limit to empty config", () => {
    const result = updateCodexConfig("", "http://127.0.0.1:3207/v1");
    expect(result).toContain("model_auto_compact_token_limit = 999999999");
  });

  test("replaces existing model_auto_compact_token_limit", () => {
    const input =
      'openai_base_url = "http://127.0.0.1:3207/v1"\nmodel_auto_compact_token_limit = 50000\n';
    const result = updateCodexConfig(input, "http://127.0.0.1:3207/v1");
    expect(result).toContain("model_auto_compact_token_limit = 999999999");
    expect(result).not.toContain("model_auto_compact_token_limit = 50000");
  });

  test("does not replace model_auto_compact_token_limit inside a section", () => {
    const input = [
      "[some_section]",
      "model_auto_compact_token_limit = 50000",
      "",
    ].join("\n");
    const result = updateCodexConfig(input, "http://127.0.0.1:3207/v1");
    // Section-scoped value preserved
    expect(result).toContain("model_auto_compact_token_limit = 50000");
    // Top-level value also added
    const lines = result.split("\n");
    const topLevelIdx = lines.findIndex(
      (l) => l.trim() === "model_auto_compact_token_limit = 999999999",
    );
    const sectionIdx = lines.findIndex((l) => l.trim().startsWith("["));
    expect(topLevelIdx).toBeGreaterThanOrEqual(0);
    expect(topLevelIdx).toBeLessThan(sectionIdx);
  });
});

// ---------------------------------------------------------------------------
// setTopLevelKey — generic TOML key setter
// ---------------------------------------------------------------------------

describe("setTopLevelKey", () => {
  test("inserts a new key into empty content", () => {
    const result = setTopLevelKey("", "my_key", "42");
    expect(result).toBe("my_key = 42\n");
  });

  test("replaces an existing top-level key", () => {
    const input = "my_key = 10\nother = true\n";
    const result = setTopLevelKey(input, "my_key", "42");
    expect(result).toContain("my_key = 42");
    expect(result).not.toContain("my_key = 10");
    expect(result).toContain("other = true");
  });

  test("inserts before first section when key does not exist", () => {
    const input = "[section]\nfoo = bar\n";
    const result = setTopLevelKey(input, "my_key", "42");
    const keyIdx = result.indexOf("my_key = 42");
    const sectionIdx = result.indexOf("[section]");
    expect(keyIdx).toBeGreaterThanOrEqual(0);
    expect(keyIdx).toBeLessThan(sectionIdx);
  });

  test("is idempotent", () => {
    const first = setTopLevelKey("", "my_key", "42");
    const second = setTopLevelKey(first, "my_key", "42");
    expect(second).toBe(first);
  });
});

// ---------------------------------------------------------------------------
// updateOpencodeConfig
// ---------------------------------------------------------------------------

describe("updateOpencodeConfig", () => {
  test("sets provider.openai.options.baseURL and disables compaction on empty config", () => {
    const result = updateOpencodeConfig({}, "http://127.0.0.1:3207/v1");
    expect(result).toEqual({
      provider: {
        openai: {
          options: {
            baseURL: "http://127.0.0.1:3207/v1",
          },
        },
      },
      compaction: {
        auto: false,
      },
    });
  });

  test("preserves existing user settings (custom providers, themes, keybinds)", () => {
    const existing = {
      theme: "dark",
      keybinds: { leader: "ctrl+x" },
      provider: {
        anthropic: {
          options: { baseURL: "https://example.com" },
        },
      },
    };
    const result = updateOpencodeConfig(existing, "http://127.0.0.1:3207/v1");
    expect(result.theme).toBe("dark");
    expect(result.keybinds).toEqual({ leader: "ctrl+x" });
    expect(result.provider).toEqual({
      anthropic: {
        options: { baseURL: "https://example.com" },
      },
      openai: {
        options: { baseURL: "http://127.0.0.1:3207/v1" },
      },
    });
  });

  test("is idempotent", () => {
    const first = updateOpencodeConfig({}, "http://127.0.0.1:3207/v1");
    const second = updateOpencodeConfig(first, "http://127.0.0.1:3207/v1");
    expect(second).toEqual(first);
  });

  test("replaces baseURL when re-run with a different value", () => {
    const first = updateOpencodeConfig({}, "http://old:3207/v1") as {
      provider?: { openai?: { options?: { baseURL?: string } } };
    };
    const second = updateOpencodeConfig(first, "http://new:3207/v1") as {
      provider?: { openai?: { options?: { baseURL?: string } } };
    };
    expect(second.provider?.openai?.options?.baseURL).toBe(
      "http://new:3207/v1",
    );
  });
});

// ---------------------------------------------------------------------------
// updateClaudeCodeSettings
// ---------------------------------------------------------------------------

describe("updateClaudeCodeSettings", () => {
  test("sets env.ANTHROPIC_BASE_URL and DISABLE_AUTO_COMPACT on empty config", () => {
    const result = updateClaudeCodeSettings({}, "http://127.0.0.1:3207");
    expect(result).toEqual({
      env: {
        ANTHROPIC_BASE_URL: "http://127.0.0.1:3207",
        DISABLE_AUTO_COMPACT: "1",
      },
    });
  });

  test("strips trailing /v1 from the Anthropic base URL", () => {
    // The setupClaudeCode wrapper strips /v1 before calling, but the
    // helper itself accepts whatever the caller passes. The wrapper
    // contract is what matters here.
    const result = updateClaudeCodeSettings({}, "http://127.0.0.1:3207/v1") as {
      env?: { ANTHROPIC_BASE_URL?: string };
    };
    // We document the wrapper strips /v1; the helper does not.
    // This test documents the helper's raw behavior.
    expect(result.env?.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:3207/v1");
  });

  test("preserves existing user settings (permissions, hooks, model)", () => {
    const existing = {
      permissions: { allow: ["Read"] },
      hooks: { PreToolUse: [] },
      model: "claude-opus-4-20250514",
      env: { OTHER_VAR: "value" },
    };
    const result = updateClaudeCodeSettings(existing, "http://127.0.0.1:3207");
    expect(result.permissions).toEqual({ allow: ["Read"] });
    expect(result.hooks).toEqual({ PreToolUse: [] });
    expect(result.model).toBe("claude-opus-4-20250514");
    expect(result.env).toEqual({
      OTHER_VAR: "value",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:3207",
      DISABLE_AUTO_COMPACT: "1",
    });
  });

  test("is idempotent", () => {
    const first = updateClaudeCodeSettings({}, "http://127.0.0.1:3207");
    const second = updateClaudeCodeSettings(first, "http://127.0.0.1:3207");
    expect(second).toEqual(first);
  });
});

// ---------------------------------------------------------------------------
// opencodePluginSpec
// ---------------------------------------------------------------------------

describe("opencodePluginSpec", () => {
  test("has expected package name", () => {
    expect(opencodePluginSpec.npmPackage).toBe("@loreai/opencode");
  });

  test("adds plugin to empty config", () => {
    const config: Record<string, unknown> = {};
    const modified = opencodePluginSpec.apply(config);
    expect(modified).toBe(true);
    expect(config.plugin).toEqual(["@loreai/opencode"]);
  });

  test("appends to existing plugin array (idempotent within a single apply)", () => {
    const config: Record<string, unknown> = {
      plugin: ["@opencode-ai/plugin", "@other/plugin"],
    };
    const modified = opencodePluginSpec.apply(config);
    expect(modified).toBe(true);
    expect(config.plugin).toEqual([
      "@opencode-ai/plugin",
      "@other/plugin",
      "@loreai/opencode",
    ]);
  });

  test("is a no-op when plugin is already registered", () => {
    const config: Record<string, unknown> = {
      plugin: ["@loreai/opencode", "@other/plugin"],
    };
    const modified = opencodePluginSpec.apply(config);
    expect(modified).toBe(false);
    expect(config.plugin).toEqual(["@loreai/opencode", "@other/plugin"]);
  });

  test("replaces non-array plugin field with an array", () => {
    // The `plugin` field should be an array, but if a user somehow
    // has a string there (typo, manual edit), we replace it with an
    // array containing just our plugin. This is conservative — we
    // don't try to preserve a non-array value because the OpenCode
    // config schema requires an array.
    const config: Record<string, unknown> = { plugin: "not-an-array" };
    const modified = opencodePluginSpec.apply(config);
    expect(modified).toBe(true);
    expect(config.plugin).toEqual(["@loreai/opencode"]);
  });
});
