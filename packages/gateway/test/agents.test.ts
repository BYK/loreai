import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AGENTS } from "../src/cli/agents";

// 🔴 ESM module namespaces are not configurable, so we mock node:fs with a
// hoisted factory that overrides only `existsSync`. Everything else passes
// through via importActual so unrelated fs callers are unaffected. Used by the
// "Claude Code Desktop agent detect" block to make detection deterministic.
const { existsSyncMock } = vi.hoisted(() => ({
  existsSyncMock: vi.fn<(p: unknown) => boolean>(() => false),
}));
vi.mock("node:fs", async (importActual) => {
  const actual = await importActual<typeof import("node:fs")>();
  return { ...actual, existsSync: existsSyncMock };
});

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

// ---------------------------------------------------------------------------
// Claude Code Desktop agent
// ---------------------------------------------------------------------------

describe("Claude Code Desktop agent envVars", () => {
  const desktop = AGENTS.find((a) => a.name === "claude-code-desktop");
  if (!desktop) throw new Error("claude-code-desktop agent not registered");

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
    const env = desktop.envVars(
      "http://127.0.0.1:3207",
      "/home/user/my-project",
    );
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toContain(
      "X-Lore-Project: /home/user/my-project",
    );
  });

  test("does NOT set ANTHROPIC_BASE_URL (Desktop reads it from settings.json)", () => {
    // 🔴 The Desktop's spawned `claude` child reads ANTHROPIC_BASE_URL from
    // ~/.claude/settings.json, not from this process's env. Setting it here
    // would be useless — see setup.ts guidance and upstream bug
    // anthropics/claude-code#67619.
    const env = desktop.envVars("http://127.0.0.1:3207", "/tmp/test");
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
  });

  test("does NOT set DISABLE_AUTO_COMPACT (written to settings.json instead)", () => {
    // 🔴 The Desktop's spawned child does not inherit our env vars, so setting
    // DISABLE_AUTO_COMPACT here is useless. `lore setup claude-code-desktop`
    // writes it to settings.json.
    const env = desktop.envVars("http://127.0.0.1:3207", "/tmp/test");
    expect(env.DISABLE_AUTO_COMPACT).toBeUndefined();
  });

  test("preserves user-set ANTHROPIC_CUSTOM_HEADERS", () => {
    process.env.ANTHROPIC_CUSTOM_HEADERS = "X-Custom: user-value";
    const env = desktop.envVars("http://127.0.0.1:3207", "/tmp/test");
    const headers = env.ANTHROPIC_CUSTOM_HEADERS ?? "";
    expect(headers).toContain("X-Custom: user-value");
    expect(headers).toContain("X-Lore-Project: /tmp/test");
  });
});

describe("Claude Code Desktop agent detect + binary", () => {
  // 🔴 Mock node:fs `existsSync` so detection is deterministic on every runner
  // (CI has no Claude.app, so an unmocked test would never exercise the
  // "installed" branch). We pass through the rest of node:fs via importActual
  // so unrelated callers (e.g. git remote lookups) are unaffected.
  let savedPlatform: NodeJS.Platform;
  let savedLocalAppData: string | undefined;

  beforeEach(() => {
    savedPlatform = process.platform;
    savedLocalAppData = process.env.LOCALAPPDATA;
    existsSyncMock.mockReset();
  });
  afterEach(() => {
    Object.defineProperty(process, "platform", {
      value: savedPlatform,
      configurable: true,
    });
    if (savedLocalAppData !== undefined) {
      process.env.LOCALAPPDATA = savedLocalAppData;
    } else {
      delete process.env.LOCALAPPDATA;
    }
  });

  test("returns null on linux regardless of filesystem", async () => {
    Object.defineProperty(process, "platform", {
      value: "linux",
      configurable: true,
    });
    existsSyncMock.mockReturnValue(true); // even if something exists
    const { isClaudeDesktopInstalled } = await import(
      "../src/cli/lib/desktop-detect"
    );
    expect(isClaudeDesktopInstalled()).toBeNull();
    expect(existsSyncMock).not.toHaveBeenCalled();
  });

  test("returns the macOS launcher path when /Applications/Claude.app exists", async () => {
    Object.defineProperty(process, "platform", {
      value: "darwin",
      configurable: true,
    });
    const expected = "/Applications/Claude.app/Contents/MacOS/Claude";
    existsSyncMock.mockImplementation((p: unknown) => p === expected);
    const { isClaudeDesktopInstalled } = await import(
      "../src/cli/lib/desktop-detect"
    );
    expect(isClaudeDesktopInstalled()).toBe(expected);
  });

  test("returns null on macOS when the app is absent", async () => {
    Object.defineProperty(process, "platform", {
      value: "darwin",
      configurable: true,
    });
    existsSyncMock.mockReturnValue(false);
    const { isClaudeDesktopInstalled } = await import(
      "../src/cli/lib/desktop-detect"
    );
    expect(isClaudeDesktopInstalled()).toBeNull();
  });

  test("returns the Windows launcher path under %LOCALAPPDATA%", async () => {
    Object.defineProperty(process, "platform", {
      value: "win32",
      configurable: true,
    });
    process.env.LOCALAPPDATA = "C:\\Users\\me\\AppData\\Local";
    // desktop-detect.ts builds candidates via node:path `join`, whose
    // separator depends on the host running the test — so compute the expected
    // path the same way instead of hardcoding backslashes.
    const expected = join(
      "C:\\Users\\me\\AppData\\Local",
      "Programs",
      "Claude",
      "Claude.exe",
    );
    existsSyncMock.mockImplementation((p: unknown) => p === expected);
    const { isClaudeDesktopInstalled } = await import(
      "../src/cli/lib/desktop-detect"
    );
    expect(isClaudeDesktopInstalled()).toBe(expected);
  });

  test("returns null on Windows when LOCALAPPDATA is unset", async () => {
    Object.defineProperty(process, "platform", {
      value: "win32",
      configurable: true,
    });
    delete process.env.LOCALAPPDATA;
    existsSyncMock.mockReturnValue(true);
    const { isClaudeDesktopInstalled } = await import(
      "../src/cli/lib/desktop-detect"
    );
    expect(isClaudeDesktopInstalled()).toBeNull();
  });

  test("agent.binary is the stable placeholder (never the launcher path)", () => {
    // 🔴 binary is a constant placeholder; the real path comes from detect().
    // This guards against regressing back to a module-load-resolved binary.
    const desktop = AGENTS.find((a) => a.name === "claude-code-desktop");
    if (!desktop) throw new Error("claude-code-desktop agent not registered");
    expect(desktop.binary).toBe("claude-code-desktop");
  });
});
