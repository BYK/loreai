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
});
