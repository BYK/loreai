import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

import { clearAuthProviders, readUsableAuth } from "../../src/import/auth";
import { registerAuthProvider } from "../../src/import/auth";
import { getOpenCodeActiveProvider } from "../../src/import/auth/opencode";
import { opencodeAuth } from "../../src/import/auth/opencode";
import { claudeCodeAuth } from "../../src/import/auth/claude-code";
import { codexAuth } from "../../src/import/auth/codex";
import { piAuth } from "../../src/import/auth/pi";

// ---------------------------------------------------------------------------
// Env sandbox: point HOME / XDG_DATA_HOME at a temp dir so readers see only
// our fixtures, never the real machine's credentials.
// ---------------------------------------------------------------------------

let tmp: string;
const saved: Record<string, string | undefined> = {};

function setEnv(key: string, value: string | undefined): void {
  if (!(key in saved)) saved[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "lore-authtest-"));
  setEnv("HOME", tmp);
  setEnv("XDG_DATA_HOME", join(tmp, ".local", "share"));
  setEnv("XDG_CONFIG_HOME", join(tmp, ".config"));
  // Registry is module-global; reset and repopulate deterministically.
  clearAuthProviders();
  registerAuthProvider(opencodeAuth);
  registerAuthProvider(claudeCodeAuth);
  registerAuthProvider(codexAuth);
  registerAuthProvider(piAuth);
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) setEnv(k, v);
  for (const k of Object.keys(saved)) delete saved[k];
  rmSync(tmp, { recursive: true, force: true });
});

function writeJson(path: string, data: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(data), "utf8");
}

// ---------------------------------------------------------------------------

describe("OpenCode auth reader", () => {
  const authFile = () =>
    join(process.env.XDG_DATA_HOME as string, "opencode", "auth.json");

  test("returns [] when no auth file", () => {
    expect(readUsableAuth("opencode")).toEqual([]);
  });

  test("reads api-key entries and maps provider verbatim", () => {
    writeJson(authFile(), {
      openrouter: { type: "api", key: "sk-or-123" },
      nvidia: { type: "api", key: "nvapi-456" },
    });
    const creds = readUsableAuth("opencode");
    expect(creds).toContainEqual({
      scheme: "api-key",
      value: "sk-or-123",
      providerID: "openrouter",
    });
    expect(creds).toContainEqual({
      scheme: "api-key",
      value: "nvapi-456",
      providerID: "nvidia",
    });
  });

  test("maps minimax-coding-plan alias to minimax", () => {
    writeJson(authFile(), {
      "minimax-coding-plan": { type: "api", key: "mm-789" },
    });
    const creds = readUsableAuth("opencode");
    expect(creds).toContainEqual({
      scheme: "api-key",
      value: "mm-789",
      providerID: "minimax",
    });
  });

  test("reads unexpired oauth as bearer", () => {
    const future = Date.now() + 60 * 60 * 1000;
    writeJson(authFile(), {
      openai: { type: "oauth", access: "tok-abc", expires: future },
    });
    const creds = readUsableAuth("opencode");
    expect(creds).toEqual([
      {
        scheme: "bearer",
        value: "tok-abc",
        providerID: "openai",
        expiresAt: future,
      },
    ]);
  });

  test("skips expired oauth token", () => {
    const past = Date.now() - 60 * 60 * 1000;
    writeJson(authFile(), {
      openai: { type: "oauth", access: "tok-stale", expires: past },
    });
    expect(readUsableAuth("opencode")).toEqual([]);
  });

  test("github-copilot oauth uses refresh token as bearer", () => {
    // OpenCode uses the long-lived GitHub OAuth `refresh` token directly as a
    // Bearer against api.githubcopilot.com (no copilot_internal/v2/token
    // exchange). Prefer refresh over access for this provider specifically.
    writeJson(authFile(), {
      "github-copilot": {
        type: "oauth",
        access: "gho_access_should_not_win",
        refresh: "gho_refresh_wins",
        expires: 0,
      },
    });
    const creds = readUsableAuth("opencode");
    expect(creds).toEqual([
      {
        scheme: "bearer",
        value: "gho_refresh_wins",
        providerID: "github-copilot",
        // expires:0 is a "no known expiry" sentinel → expiresAt undefined, so
        // the credential is NOT filtered out as epoch-0-expired.
        expiresAt: undefined,
      },
    ]);
  });

  test("github-copilot falls back to access when refresh is absent", () => {
    // Older OpenCode auth.json may lack `refresh`; `access` still works.
    writeJson(authFile(), {
      "github-copilot": {
        type: "oauth",
        access: "gho_access_only",
        expires: 0,
      },
    });
    const creds = readUsableAuth("opencode");
    expect(creds).toEqual([
      {
        scheme: "bearer",
        value: "gho_access_only",
        providerID: "github-copilot",
        expiresAt: undefined,
      },
    ]);
  });

  test("github-copilot with neither refresh nor access is omitted (no throw)", () => {
    writeJson(authFile(), {
      "github-copilot": { type: "oauth", expires: 0 },
    });
    expect(readUsableAuth("opencode")).toEqual([]);
  });

  test("expires:0 sentinel is treated as unexpired (not epoch-0-expired)", () => {
    writeJson(authFile(), {
      openai: { type: "oauth", access: "tok-live", expires: 0 },
    });
    const creds = readUsableAuth("opencode");
    expect(creds).toEqual([
      {
        scheme: "bearer",
        value: "tok-live",
        providerID: "openai",
        expiresAt: undefined,
      },
    ]);
  });

  test("garbage file yields [] (no throw)", () => {
    mkdirSync(join(authFile(), ".."), { recursive: true });
    writeFileSync(authFile(), "not json{{{", "utf8");
    expect(readUsableAuth("opencode")).toEqual([]);
  });

  test("when auth.json has multiple providers and opencode.json names one as `model`, that credential wins (active-provider reorder)", () => {
    // The motivating bug: Aditya's auth.json had stale `anthropic` (from
    // before they switched) + current `openrouter`. The previous behavior
    // picked whichever entry was first in JSON-iteration order (essentially
    // oldest config) — typically the stale one. With `model = "openrouter/…"`
    // set in opencode.json, the active-provider reorder pins openrouter first
    // and the importer routes to the credential OpenCode is actually using.
    writeJson(authFile(), {
      anthropic: { type: "api", key: "sk-ant-stale" },
      openrouter: { type: "api", key: "sk-or-current" },
    });
    const configFile = join(
      process.env.XDG_CONFIG_HOME as string,
      "opencode",
      "opencode.json",
    );
    writeJson(configFile, { model: "openrouter/anthropic/claude-sonnet-5" });
    const creds = readUsableAuth("opencode");
    expect(creds[0]).toMatchObject({
      scheme: "api-key",
      value: "sk-or-current",
      providerID: "openrouter",
    });
    expect(creds).toContainEqual({
      scheme: "api-key",
      value: "sk-ant-stale",
      providerID: "anthropic",
    });
  });

  test("active-provider reorder is a no-op when only one provider is on disk", () => {
    writeJson(authFile(), { anthropic: { type: "api", key: "sk-ant-only" } });
    const configFile = join(
      process.env.XDG_CONFIG_HOME as string,
      "opencode",
      "opencode.json",
    );
    writeJson(configFile, { model: "anthropic/claude-sonnet-5" });
    const creds = readUsableAuth("opencode");
    expect(creds).toEqual([
      { scheme: "api-key", value: "sk-ant-only", providerID: "anthropic" },
    ]);
  });

  test("active-provider reorder leaves existing order intact when opencode.json is missing", () => {
    // No opencode.json → no active provider → fall through to insertion
    // order. The previous behavior is preserved for users who haven't
    // customized their config (or who store it elsewhere).
    writeJson(authFile(), {
      anthropic: { type: "api", key: "sk-ant-a" },
      openrouter: { type: "api", key: "sk-or-b" },
    });
    const creds = readUsableAuth("opencode");
    expect(creds.map((c) => c.providerID)).toEqual(["anthropic", "openrouter"]);
  });

  test("active-provider reorder is a no-op when opencode.json names a provider NOT in auth.json", () => {
    // User config says "use openai" but their auth.json only has openrouter.
    // The reorder must NOT fabricate a credential — it can only pin an
    // existing one. The user sees the openrouter credential via tier-2's
    // routability filter (or the "no usable credential" guidance).
    writeJson(authFile(), { openrouter: { type: "api", key: "sk-or-only" } });
    const configFile = join(
      process.env.XDG_CONFIG_HOME as string,
      "opencode",
      "opencode.json",
    );
    writeJson(configFile, { model: "openai/gpt-5-mini" });
    const creds = readUsableAuth("opencode");
    expect(creds).toEqual([
      { scheme: "api-key", value: "sk-or-only", providerID: "openrouter" },
    ]);
  });
});

describe("getOpenCodeActiveProvider", () => {
  // The provider-prefix lookup that powers the active-provider reorder.
  // Without this, the importer blindly picks the first routable entry from
  // auth.json — usually the wrong provider when the user has rotated their
  // config but left an old credential in auth.json.
  const configFile = () =>
    join(process.env.XDG_CONFIG_HOME as string, "opencode", "opencode.json");

  test("returns null when no opencode.json is present", () => {
    // XDG_CONFIG_HOME points at an empty tmp dir → no config file exists.
    expect(getOpenCodeActiveProvider()).toBeNull();
  });

  test("extracts the provider prefix from `model` (anthropic/claude-sonnet-5 → anthropic)", () => {
    writeJson(configFile(), { model: "anthropic/claude-sonnet-5" });
    expect(getOpenCodeActiveProvider()).toBe("anthropic");
  });

  test("extracts provider for `openrouter/anthropic/claude-…` (slash in model id is preserved)", () => {
    writeJson(configFile(), {
      model: "openrouter/anthropic/claude-sonnet-5",
    });
    expect(getOpenCodeActiveProvider()).toBe("openrouter");
  });

  test("falls back to `small_model` when `model` is unset", () => {
    writeJson(configFile(), { small_model: "anthropic/claude-haiku-4-5" });
    expect(getOpenCodeActiveProvider()).toBe("anthropic");
  });

  test("resolves {env:VAR} substitution in `model`", () => {
    // OpenCode supports `{env:OPENCODE_MODEL}` substitution in config strings;
    // we follow the same rule so an env-driven model still resolves its
    // provider prefix correctly.
    setEnv("OPENCODE_MODEL", "openrouter/some/model");
    writeJson(configFile(), { model: "{env:OPENCODE_MODEL}" });
    expect(getOpenCodeActiveProvider()).toBe("openrouter");
  });

  test("ignores config with non-string or empty `model`", () => {
    writeJson(configFile(), { model: 123 });
    expect(getOpenCodeActiveProvider()).toBeNull();
    writeJson(configFile(), { model: "" });
    expect(getOpenCodeActiveProvider()).toBeNull();
  });

  test("ignores config with `model` lacking a `/` (no provider prefix)", () => {
    // "claude-sonnet-5" alone is ambiguous (could be any provider) — must
    // not be mis-classified. Caller falls back to the first routable
    // auth.json entry in that case.
    writeJson(configFile(), { model: "claude-sonnet-5" });
    expect(getOpenCodeActiveProvider()).toBeNull();
  });

  test("maps the minimax-coding-plan alias to minimax", () => {
    // The same normalization as on-disk auth.json keys — keeps the active-
    // provider detection consistent with how auth.json entries are read.
    writeJson(configFile(), {
      model: "minimax-coding-plan/anthropic/claude-sonnet-5",
    });
    expect(getOpenCodeActiveProvider()).toBe("minimax");
  });
});

describe("Claude Code auth reader", () => {
  const credFile = () => join(homedir(), ".claude", ".credentials.json");

  test("returns [] when no credentials file", () => {
    expect(readUsableAuth("claude-code")).toEqual([]);
  });

  test("reads claudeAiOauth access token as anthropic bearer", () => {
    const future = Date.now() + 3600_000;
    writeJson(credFile(), {
      claudeAiOauth: { accessToken: "cc-tok", expiresAt: future },
    });
    expect(readUsableAuth("claude-code")).toEqual([
      {
        scheme: "bearer",
        value: "cc-tok",
        providerID: "anthropic",
        expiresAt: future,
      },
    ]);
  });

  test("skips expired claude token", () => {
    writeJson(credFile(), {
      claudeAiOauth: { accessToken: "cc-old", expiresAt: Date.now() - 1000 },
    });
    expect(readUsableAuth("claude-code")).toEqual([]);
  });
});

describe("Codex auth reader", () => {
  const authFile = () => join(homedir(), ".codex", "auth.json");

  test("reads raw OPENAI_API_KEY as openai api-key", () => {
    writeJson(authFile(), { OPENAI_API_KEY: "sk-openai-1" });
    expect(readUsableAuth("codex")).toEqual([
      { scheme: "api-key", value: "sk-openai-1", providerID: "openai" },
    ]);
  });

  test("ChatGPT-plan oauth-only (no raw key) yields []", () => {
    writeJson(authFile(), { tokens: { access_token: "chatgpt-tok" } });
    expect(readUsableAuth("codex")).toEqual([]);
  });
});

describe("Pi auth reader", () => {
  const authFile = () => join(homedir(), ".pi", "agent", "auth.json");

  test("empty object yields []", () => {
    writeJson(authFile(), {});
    expect(readUsableAuth("pi")).toEqual([]);
  });

  test("reads string and object-shaped provider keys", () => {
    writeJson(authFile(), {
      openai: "sk-pi-openai",
      anthropic: { apiKey: "sk-pi-anthropic" },
    });
    const creds = readUsableAuth("pi");
    expect(creds).toContainEqual({
      scheme: "api-key",
      value: "sk-pi-openai",
      providerID: "openai",
    });
    expect(creds).toContainEqual({
      scheme: "api-key",
      value: "sk-pi-anthropic",
      providerID: "anthropic",
    });
  });
});

describe("readUsableAuth", () => {
  test("returns [] for an unregistered agent name", () => {
    expect(readUsableAuth("nonexistent-agent")).toEqual([]);
  });

  test("expiry filter honors injected clock", () => {
    const authFile = join(
      process.env.XDG_DATA_HOME as string,
      "opencode",
      "auth.json",
    );
    const expires = 1_000_000;
    writeJson(authFile, {
      openai: { type: "oauth", access: "t", expires },
    });
    // now well before expiry (minus skew) → kept
    expect(readUsableAuth("opencode", expires - 120_000).length).toBe(1);
    // now past expiry → dropped
    expect(readUsableAuth("opencode", expires + 1).length).toBe(0);
  });
});
