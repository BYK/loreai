import { describe, test, expect } from "bun:test";
import { updateCodexConfig, normalizeBaseUrl } from "../src/cli/setup";

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
    expect(result).toBe('openai_base_url = "http://127.0.0.1:3207/v1"\n');
  });

  test("creates config from whitespace-only string", () => {
    const result = updateCodexConfig("  \n\n  ", "http://127.0.0.1:3207/v1");
    expect(result).toBe('openai_base_url = "http://127.0.0.1:3207/v1"\n');
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
    const input = `model = "gpt-5.5"\nopenai_base_url = "http://127.0.0.1:3207/v1"\napproval_policy = "on-request"\n`;
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
  });

  test("replaces with different URL", () => {
    const input = 'openai_base_url = "http://127.0.0.1:3207/v1"\n';
    const result = updateCodexConfig(input, "http://remote:8080/v1");
    expect(result).toBe('openai_base_url = "http://remote:8080/v1"\n');
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
    const firstSection = result.indexOf("[marketplaces");
    expect(urlIdx).toBeLessThan(firstSection);
    expect(urlIdx).toBeGreaterThanOrEqual(0);
    // Original content preserved
    expect(result).toContain("notify =");
    expect(result).toContain("[features]");
    expect(result).toContain("[desktop]");
    expect(result).toContain("[mcp_servers.node_repl]");
  });
});
