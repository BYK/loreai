import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { AGENTS } from "../src/cli/agents";
import {
  applyUpstreamAdoption,
  adoptForRemote,
  formatUpstreamForLog,
  injectAdoptionHeaders,
  resolveAgentSelection,
  resolveLaunchTarget,
} from "../src/cli/run";

// ---------------------------------------------------------------------------
// lore run — user-upstream adoption
//
// When a user has already pointed their agent at a provider (e.g. Claude Code
// at OpenRouter via ANTHROPIC_BASE_URL), `lore run` must ADOPT that upstream
// rather than clobber it with the hardcoded api.anthropic.com default — which
// was sending the OpenRouter key to Anthropic and 401-storming.
// ---------------------------------------------------------------------------

const GATEWAY = "http://127.0.0.1:3207";

// Env keys the adoption logic reads/writes — save + restore around each test.
const TOUCHED_ENV = [
  "ANTHROPIC_BASE_URL",
  "OPENAI_BASE_URL",
  "GOOGLE_GEMINI_BASE_URL",
  "COPILOT_API_URL",
  "LORE_UPSTREAM_ANTHROPIC",
  "LORE_UPSTREAM_OPENAI",
  "LORE_UPSTREAM_OPENROUTER",
];

describe("lore run upstream adoption", () => {
  const claude = AGENTS.find((a) => a.name === "claude-code")!;
  const codex = AGENTS.find((a) => a.name === "codex")!;
  const gemini = AGENTS.find((a) => a.name === "gemini")!;
  const opencode = AGENTS.find((a) => a.name === "opencode")!;

  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = {};
    for (const k of TOUCHED_ENV) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of TOUCHED_ENV) {
      if (saved[k] !== undefined) process.env[k] = saved[k];
      else delete process.env[k];
    }
  });

  test("Claude Code + ANTHROPIC_BASE_URL=openrouter sets gateway upstream env and tags the provider", () => {
    process.env.ANTHROPIC_BASE_URL = "https://openrouter.ai/api";
    const adopted = applyUpstreamAdoption(claude, GATEWAY);
    expect(adopted).not.toBeNull();
    expect(adopted!.url).toBe("https://openrouter.ai/api");
    expect(adopted!.providerID).toBe("openrouter");
    // The in-process gateway reads LORE_UPSTREAM_ANTHROPIC at loadConfig().
    expect(process.env.LORE_UPSTREAM_ANTHROPIC).toBe(
      "https://openrouter.ai/api",
    );
    // Provider-specific upstream so the injected X-Lore-Provider resolves.
    expect(process.env.LORE_UPSTREAM_OPENROUTER).toBe(
      "https://openrouter.ai/api",
    );
  });

  test("injects X-Lore-Upstream-URL and X-Lore-Provider into Claude Code headers", () => {
    process.env.ANTHROPIC_BASE_URL = "https://openrouter.ai/api";
    const adopted = applyUpstreamAdoption(claude, GATEWAY)!;
    const env: Record<string, string> = {};
    injectAdoptionHeaders(claude, env, adopted);
    const headers = env.ANTHROPIC_CUSTOM_HEADERS ?? "";
    expect(headers).toContain("X-Lore-Upstream-URL: https://openrouter.ai/api");
    expect(headers).toContain("X-Lore-Provider: openrouter");
  });

  test("does NOT overwrite an explicit user LORE_UPSTREAM_ANTHROPIC", () => {
    process.env.ANTHROPIC_BASE_URL = "https://openrouter.ai/api";
    process.env.LORE_UPSTREAM_ANTHROPIC = "https://my-explicit-proxy.example";
    applyUpstreamAdoption(claude, GATEWAY);
    // The user's explicit override wins.
    expect(process.env.LORE_UPSTREAM_ANTHROPIC).toBe(
      "https://my-explicit-proxy.example",
    );
  });

  test("returns null and touches no env when the user set nothing", () => {
    expect(applyUpstreamAdoption(claude, GATEWAY)).toBeNull();
    expect(process.env.LORE_UPSTREAM_ANTHROPIC).toBeUndefined();
  });

  test("unknown host is adopted as upstream URL but carries no provider tag", () => {
    process.env.ANTHROPIC_BASE_URL = "https://llm.internal.example.com";
    const adopted = applyUpstreamAdoption(claude, GATEWAY)!;
    expect(adopted.url).toBe("https://llm.internal.example.com");
    expect(adopted.providerID).toBeUndefined();
    expect(process.env.LORE_UPSTREAM_ANTHROPIC).toBe(
      "https://llm.internal.example.com",
    );
    // No provider tag → header injection omits X-Lore-Provider.
    const env: Record<string, string> = {};
    injectAdoptionHeaders(claude, env, adopted);
    const headers = env.ANTHROPIC_CUSTOM_HEADERS ?? "";
    expect(headers).toContain("X-Lore-Upstream-URL:");
    expect(headers).not.toContain("X-Lore-Provider:");
  });

  test("Gemini custom upstream fails closed because no routing mechanism exists", () => {
    process.env.GOOGLE_GEMINI_BASE_URL = "https://gemini-proxy.example.com";
    expect(() => applyUpstreamAdoption(gemini, GATEWAY)).toThrow(
      /cannot safely route/i,
    );
  });

  test("opencode (no adoptable base-URL var) returns null even with envs set", () => {
    process.env.ANTHROPIC_BASE_URL = "https://openrouter.ai/api";
    process.env.OPENAI_BASE_URL = "https://openrouter.ai/api";
    expect(applyUpstreamAdoption(opencode, GATEWAY)).toBeNull();
  });

  // --- Security: CRLF header injection via a crafted base-URL env var --------

  test("does NOT smuggle a second header when ANTHROPIC_BASE_URL contains a newline (CRLF injection)", () => {
    // new URL() tolerates a newline after the path, so a naive adopt+inject
    // would split "X-Lore-Upstream-URL: <url>\nX-Api-Key: stolen" into TWO
    // real headers. captureUserUpstream strips control chars AND rejects any
    // value with interior whitespace, so a CRLF-smuggling payload is never
    // adopted at all — no header can be injected from it.
    process.env.ANTHROPIC_BASE_URL =
      "https://good.example.com/\nX-Api-Key: stolen";
    expect(() => applyUpstreamAdoption(claude, GATEWAY)).toThrow(
      /unsafe or invalid upstream URL/,
    );
    expect(process.env.LORE_UPSTREAM_ANTHROPIC).toBeUndefined();
  });

  test("a base URL with an interior space is rejected (not adopted)", () => {
    process.env.ANTHROPIC_BASE_URL = "https://good.example.com/ evil";
    expect(() => applyUpstreamAdoption(claude, GATEWAY)).toThrow(
      /unsafe or invalid upstream URL/,
    );
  });

  test("a base URL containing userinfo credentials is rejected", () => {
    process.env.ANTHROPIC_BASE_URL =
      "https://api-user:secret@proxy.example.com/v1";
    expect(() => applyUpstreamAdoption(claude, GATEWAY)).toThrow(
      /unsafe or invalid upstream URL/,
    );
  });

  test("query-bearing base URLs are rejected because routing drops the query", () => {
    process.env.ANTHROPIC_BASE_URL =
      "https://proxy.example.com/v1?api_key=super-secret";
    expect(() => applyUpstreamAdoption(claude, GATEWAY)).toThrow(
      /unsafe or invalid upstream URL/,
    );
  });

  test("query strings are still redacted by defensive log formatting", () => {
    expect(
      formatUpstreamForLog(
        "https://proxy.example.com/v1?api_key=super-secret#fragment",
      ),
    ).toBe("https://proxy.example.com/v1?<redacted>");
  });

  // --- Remote mode: adopt via header only, never touch gateway env ----------

  test("adoptForRemote returns the upstream + provider tag but sets NO gateway env", () => {
    process.env.ANTHROPIC_BASE_URL = "https://openrouter.ai/api";
    const adopted = adoptForRemote(claude, "https://remote-gw.example.com");
    expect(adopted).not.toBeNull();
    expect(adopted!.url).toBe("https://openrouter.ai/api");
    expect(adopted!.providerID).toBe("openrouter");
    // Remote gateway owns its own config — no local LORE_UPSTREAM_* is set.
    expect(adopted!.gatewayEnvKey).toBe("");
    expect(process.env.LORE_UPSTREAM_ANTHROPIC).toBeUndefined();
  });

  test("adoptForRemote returns null when the user set no upstream", () => {
    expect(adoptForRemote(claude, "https://remote-gw.example.com")).toBeNull();
  });

  test("remote adoption fails closed for agents without request headers", () => {
    process.env.OPENAI_BASE_URL = "https://openai-proxy.example.com/v1";
    expect(() =>
      adoptForRemote(codex, "https://remote-gw.example.com"),
    ).toThrow(/cannot safely route/i);
  });
});

// ---------------------------------------------------------------------------
// resolveAgentSelection — pick the agent before the gateway starts
// ---------------------------------------------------------------------------

describe("resolveAgentSelection", () => {
  test("explicit known binary resolves to its AgentDef", async () => {
    const sel = await resolveAgentSelection(["claude", "--foo"]);
    expect(sel).not.toBeNull();
    expect(sel!.command).toBe("claude");
    expect(sel!.def?.name).toBe("claude-code");
  });

  test("explicit unknown binary resolves with def=null (no adoption, no crash)", async () => {
    const sel = await resolveAgentSelection(["some-other-tool"]);
    expect(sel).not.toBeNull();
    expect(sel!.command).toBe("some-other-tool");
    expect(sel!.def).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resolveLaunchTarget — build launch env/args + inject adoption headers
// ---------------------------------------------------------------------------

describe("resolveLaunchTarget", () => {
  const claude = AGENTS.find((a) => a.name === "claude-code")!;
  const GATEWAY = "http://127.0.0.1:3207";

  test("explicit command: merges env from all agents and prepends matching cliArgs", () => {
    const selection = {
      command: "codex",
      def: AGENTS.find((a) => a.name === "codex")!,
    };
    const target = resolveLaunchTarget(
      selection,
      GATEWAY,
      ["codex", "--resume"],
      ["--extra"],
      null,
    );
    expect(target.command).toBe("codex");
    // Codex cliArgs (-c openai_base_url=...) are prepended; user args + extras follow.
    expect(target.args[0]).toBe("-c");
    expect(target.args).toContain("--resume");
    expect(target.args).toContain("--extra");
    // Env merged from all agents includes Claude Code's base URL too (harmless).
    expect(target.env.ANTHROPIC_BASE_URL).toBe(GATEWAY);
  });

  test("explicit command: injects adoption headers only for the matching agent", () => {
    const selection = { command: "claude", def: claude };
    const adopted = {
      url: "https://openrouter.ai/api",
      gatewayEnvKey: "LORE_UPSTREAM_ANTHROPIC",
      providerID: "openrouter",
      agentDisplayName: "Claude Code",
    };
    const target = resolveLaunchTarget(
      selection,
      GATEWAY,
      ["claude"],
      [],
      adopted,
    );
    const headers = target.env.ANTHROPIC_CUSTOM_HEADERS ?? "";
    expect(headers).toContain("X-Lore-Upstream-URL: https://openrouter.ai/api");
    expect(headers).toContain("X-Lore-Provider: openrouter");
  });

  test("auto-detected agent: builds env from the selected def and injects adoption headers", () => {
    const selection = { command: "claude", def: claude };
    const adopted = {
      url: "https://openrouter.ai/api",
      gatewayEnvKey: "LORE_UPSTREAM_ANTHROPIC",
      providerID: "openrouter",
      agentDisplayName: "Claude Code",
    };
    // Empty cmdArgs → auto-detect branch (uses selection.def directly).
    const target = resolveLaunchTarget(
      selection,
      GATEWAY,
      [],
      ["--flag"],
      adopted,
    );
    expect(target.command).toBe("claude");
    expect(target.args).toContain("--flag");
    expect(target.env.ANTHROPIC_BASE_URL).toBe(GATEWAY);
    expect(target.env.ANTHROPIC_CUSTOM_HEADERS).toContain(
      "X-Lore-Provider: openrouter",
    );
  });

  test("auto-detect with no adoption leaves headers free of upstream routing", () => {
    const selection = { command: "claude", def: claude };
    const target = resolveLaunchTarget(selection, GATEWAY, [], [], null);
    const headers = target.env.ANTHROPIC_CUSTOM_HEADERS ?? "";
    expect(headers).not.toContain("X-Lore-Upstream-URL");
    expect(headers).not.toContain("X-Lore-Provider");
  });
});
