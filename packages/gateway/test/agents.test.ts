import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { AGENTS } from "../src/cli/agents";

// ---------------------------------------------------------------------------
// Claude Code agent
// ---------------------------------------------------------------------------

describe("Claude Code agent envVars", () => {
  const claude = AGENTS.find((a) => a.name === "claude-code");
  if (!claude) throw new Error("claude-code agent not registered");

  // appendCustomHeader reads env[key] ?? process.env[key] to merge with
  // existing headers. Save and restore to avoid test pollution.
  let savedHeaders: string | undefined;
  beforeEach(() => {
    savedHeaders = process.env.ANTHROPIC_CUSTOM_HEADERS;
    delete process.env.ANTHROPIC_CUSTOM_HEADERS;
  });
  afterEach(() => {
    if (savedHeaders !== undefined) {
      process.env.ANTHROPIC_CUSTOM_HEADERS = savedHeaders;
    } else {
      delete process.env.ANTHROPIC_CUSTOM_HEADERS;
    }
  });

  test("injects X-Lore-Project in ANTHROPIC_CUSTOM_HEADERS", () => {
    const env = claude.envVars(
      "http://127.0.0.1:3207",
      "/home/user/my-project",
    );
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toContain(
      "X-Lore-Project: /home/user/my-project",
    );
  });

  test("both X-Lore-Project and X-Lore-Git-Remote coexist when git remote is available", () => {
    // Use the actual repo cwd so safeRemote() finds a real git remote.
    const env = claude.envVars("http://127.0.0.1:3207", process.cwd());
    const headers = env.ANTHROPIC_CUSTOM_HEADERS ?? "";
    expect(headers).toContain("X-Lore-Project:");
    expect(headers).toContain("X-Lore-Git-Remote:");
    // Project header should appear first (injected before git remote).
    const projectIdx = headers.indexOf("X-Lore-Project:");
    const remoteIdx = headers.indexOf("X-Lore-Git-Remote:");
    expect(projectIdx).toBeLessThan(remoteIdx);
  });

  test("preserves user-set ANTHROPIC_CUSTOM_HEADERS", () => {
    process.env.ANTHROPIC_CUSTOM_HEADERS = "X-Custom: user-value";
    const env = claude.envVars("http://127.0.0.1:3207", "/tmp/test");
    const headers = env.ANTHROPIC_CUSTOM_HEADERS ?? "";
    expect(headers).toContain("X-Custom: user-value");
    expect(headers).toContain("X-Lore-Project: /tmp/test");
  });

  test("sets ANTHROPIC_BASE_URL", () => {
    const env = claude.envVars(
      "http://127.0.0.1:3207",
      "/home/user/my-project",
    );
    expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:3207");
  });

  test("sets DISABLE_AUTO_COMPACT", () => {
    const env = claude.envVars("http://127.0.0.1:3207", "/tmp/test");
    expect(env.DISABLE_AUTO_COMPACT).toBe("1");
  });

  test("forces first-party assumption so >= 2.1.181 keeps emitting cch", () => {
    // Claude Code 2.1.181 suppresses the `cch` billing field unless it believes
    // it is talking to api.anthropic.com. The gateway is a transparent proxy to
    // that API, so we must force the first-party assumption (see quality/CCH.md).
    const env = claude.envVars("http://127.0.0.1:3207", "/tmp/test");
    expect(env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL).toBe("1");
  });

  test("first-party override is set regardless of gateway URL or cwd", () => {
    const env1 = claude.envVars("http://127.0.0.1:3207", "/tmp/test");
    const env2 = claude.envVars("http://192.168.1.50:5673", "/home/user/proj");
    expect(env1._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL).toBe("1");
    expect(env2._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL).toBe("1");
  });
});

// ---------------------------------------------------------------------------
// OpenCode agent
// ---------------------------------------------------------------------------

describe("OpenCode agent envVars", () => {
  const opencode = AGENTS.find((a) => a.name === "opencode");
  if (!opencode) throw new Error("opencode agent not registered");

  test("injects @loreai/opencode plugin entry via OPENCODE_CONFIG_CONTENT", () => {
    const env = opencode.envVars("http://127.0.0.1:3207", "/tmp/test");
    expect(env.OPENCODE_CONFIG_CONTENT).toBeDefined();
    const parsed = JSON.parse(env.OPENCODE_CONFIG_CONTENT) as {
      plugin: string[];
    };
    expect(parsed.plugin).toEqual(["@loreai/opencode"]);
    // The plugin handles baseURL pinning for all providers at runtime via
    // cfg.provider iteration — no hardcoded provider list in the env var.
    expect(parsed).not.toHaveProperty("provider");
  });

  test("does NOT set OPENAI_BASE_URL or ANTHROPIC_BASE_URL (opencode bypasses them)", () => {
    const env = opencode.envVars("http://127.0.0.1:3207", "/tmp/test");
    expect(env.OPENAI_BASE_URL).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
  });

  test("OPENCODE_CONFIG_CONTENT is the same regardless of gateway URL (plugin resolves gateway at runtime)", () => {
    const env1 = opencode.envVars("http://127.0.0.1:3207", "/tmp/test");
    const env2 = opencode.envVars("http://192.168.1.50:5673", "/tmp/test");
    expect(env1.OPENCODE_CONFIG_CONTENT).toBe(env2.OPENCODE_CONFIG_CONTENT);
  });
});

// ---------------------------------------------------------------------------
// Codex agent
// ---------------------------------------------------------------------------

describe("Codex agent envVars", () => {
  test("sets LORE_PROJECT env var to cwd", () => {
    const codex = AGENTS.find((a) => a.name === "codex");
    if (!codex) throw new Error("codex agent not registered");
    const env = codex.envVars("http://127.0.0.1:3207", "/home/user/my-project");
    expect(env.LORE_PROJECT).toBe("/home/user/my-project");
  });

  test("does NOT set OPENAI_BASE_URL (Codex CLI ignores it)", () => {
    const codex = AGENTS.find((a) => a.name === "codex");
    if (!codex) throw new Error("codex agent not registered");
    const env = codex.envVars("http://127.0.0.1:3207", "/tmp/test");
    expect(env.OPENAI_BASE_URL).toBeUndefined();
  });
});

describe("Codex agent cliArgs", () => {
  test("returns -c openai_base_url override with /v1 suffix", () => {
    const codex = AGENTS.find((a) => a.name === "codex");
    if (!codex) throw new Error("codex agent not registered");
    expect(codex.cliArgs).toBeDefined();
    const args = codex.cliArgs?.("http://127.0.0.1:3207", "/tmp/test");
    expect(args).toEqual([
      "-c",
      'openai_base_url="http://127.0.0.1:3207/v1"',
      "-c",
      "model_auto_compact_token_limit=999999999",
    ]);
  });

  test("includes gateway URL in the override", () => {
    const codex = AGENTS.find((a) => a.name === "codex");
    if (!codex) throw new Error("codex agent not registered");
    const args = codex.cliArgs?.("http://192.168.1.100:5673", "/tmp/test");
    expect(args?.[1]).toContain("http://192.168.1.100:5673/v1");
  });

  test("disables auto-compaction via model_auto_compact_token_limit", () => {
    const codex = AGENTS.find((a) => a.name === "codex");
    if (!codex) throw new Error("codex agent not registered");
    const args = codex.cliArgs?.("http://127.0.0.1:3207", "/tmp/test");
    expect(args).toContain("model_auto_compact_token_limit=999999999");
  });

  describe("with LORE_UPSTREAM_EXTRA_HEADERS set", () => {
    let saved: string | undefined;
    beforeEach(() => {
      saved = process.env.LORE_UPSTREAM_EXTRA_HEADERS;
      delete process.env.LORE_UPSTREAM_EXTRA_HEADERS;
    });
    afterEach(() => {
      if (saved !== undefined) {
        process.env.LORE_UPSTREAM_EXTRA_HEADERS = saved;
      } else {
        delete process.env.LORE_UPSTREAM_EXTRA_HEADERS;
      }
    });

    test("injects openai_provider_headers TOML map when set", () => {
      const codex = AGENTS.find((a) => a.name === "codex");
      if (!codex) throw new Error("codex agent not registered");
      process.env.LORE_UPSTREAM_EXTRA_HEADERS =
        "X-Corp-Token: abc\nX-Tenant: acme";
      const args = codex.cliArgs?.("http://127.0.0.1:3207", "/tmp/test");
      // Find the openai_provider_headers -c pair
      const providerHeadersIdx = args?.findIndex(
        (a) => typeof a === "string" && a.startsWith("openai_provider_headers"),
      );
      expect(providerHeadersIdx).toBeGreaterThan(0);
      const idx = providerHeadersIdx as number;
      const prev = args?.[idx - 1];
      expect(prev).toBe("-c");
      const tomlLine = args?.[idx];
      expect(tomlLine).toContain("X-Corp-Token");
      expect(tomlLine).toContain("abc");
      expect(tomlLine).toContain("X-Tenant");
      expect(tomlLine).toContain("acme");
    });

    test("escapes quotes in header values", () => {
      const codex = AGENTS.find((a) => a.name === "codex");
      if (!codex) throw new Error("codex agent not registered");
      process.env.LORE_UPSTREAM_EXTRA_HEADERS = 'X-Quoted: a"b';
      const args = codex.cliArgs?.("http://127.0.0.1:3207", "/tmp/test");
      const idx = args?.findIndex(
        (a) => typeof a === "string" && a.startsWith("openai_provider_headers"),
      );
      expect(idx).toBeGreaterThan(0);
      // TOML basic string: embedded " is escaped
      expect(args?.[idx as number]).toContain('\\"');
    });

    test("omits openai_provider_headers when env is empty", () => {
      const codex = AGENTS.find((a) => a.name === "codex");
      if (!codex) throw new Error("codex agent not registered");
      process.env.LORE_UPSTREAM_EXTRA_HEADERS = "";
      const args = codex.cliArgs?.("http://127.0.0.1:3207", "/tmp/test");
      const hasProviderHeaders = args?.some(
        (a) => typeof a === "string" && a.startsWith("openai_provider_headers"),
      );
      expect(hasProviderHeaders).toBe(false);
    });

    test("omits openai_provider_headers when env is whitespace-only", () => {
      const codex = AGENTS.find((a) => a.name === "codex");
      if (!codex) throw new Error("codex agent not registered");
      process.env.LORE_UPSTREAM_EXTRA_HEADERS = "   \n\n  ";
      const args = codex.cliArgs?.("http://127.0.0.1:3207", "/tmp/test");
      const hasProviderHeaders = args?.some(
        (a) => typeof a === "string" && a.startsWith("openai_provider_headers"),
      );
      expect(hasProviderHeaders).toBe(false);
    });
  });
});
