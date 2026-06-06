/**
 * Agent registry — known AI coding agents that can be launched through
 * the gateway.
 *
 * Each agent defines:
 *  - How to detect it (binary name on PATH)
 *  - What env vars to set so it talks through the gateway
 */
import { getGitRemote } from "@loreai/core";
import { whichSync } from "./lib/which";

// ---------------------------------------------------------------------------
// Agent definitions
// ---------------------------------------------------------------------------

export interface AgentDef {
  /** Internal identifier, e.g. "claude-code" */
  name: string;
  /** Human-readable name, e.g. "Claude Code" */
  displayName: string;
  /** Binary to search for on PATH */
  binary: string;
  /** Returns the binary path if found, or null */
  detect: () => string | null;
  /** Env vars to inject given the gateway URL (e.g. "http://127.0.0.1:3207") and project cwd */
  envVars: (gatewayUrl: string, cwd: string) => Record<string, string>;
  /**
   * Extra CLI arguments to prepend when launching the agent.
   * Used by agents like Codex that read config from their own config file
   * rather than environment variables — we inject `-c key=value` overrides.
   */
  cliArgs?: (gatewayUrl: string, cwd: string) => string[];
}

/**
 * Sanitize a git remote URL for safe embedding in env vars / headers.
 * Strips control characters to prevent injection attacks.
 */
function safeRemote(cwd: string): string | null {
  const remote = getGitRemote(cwd);
  if (!remote) return null;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional control-character sanitization
  return remote.replace(/[\x00-\x1f\x7f]/g, "");
}

/**
 * Append a header to ANTHROPIC_CUSTOM_HEADERS (curl-style format:
 * "Name: Value" newline-separated).
 */
function appendCustomHeader(
  env: Record<string, string>,
  envKey: string,
  name: string,
  value: string,
): void {
  const existing = env[envKey] ?? process.env[envKey] ?? "";
  const header = `${name}: ${value}`;
  env[envKey] = existing ? `${existing}\n${header}` : header;
}

export const AGENTS: AgentDef[] = [
  {
    name: "claude-code",
    displayName: "Claude Code",
    binary: "claude",
    detect: () => whichSync("claude"),
    envVars: (url, cwd) => {
      const env: Record<string, string> = {
        ANTHROPIC_BASE_URL: url,
        DISABLE_AUTO_COMPACT: "1",
      };
      // Inject project path so the gateway knows which project this session
      // belongs to, regardless of system prompt format.
      appendCustomHeader(
        env,
        "ANTHROPIC_CUSTOM_HEADERS",
        "X-Lore-Project",
        cwd,
      );
      // Inject git remote via ANTHROPIC_CUSTOM_HEADERS so the remote gateway
      // can identify the project by git remote without filesystem access.
      const remote = safeRemote(cwd);
      if (remote) {
        appendCustomHeader(
          env,
          "ANTHROPIC_CUSTOM_HEADERS",
          "X-Lore-Git-Remote",
          remote,
        );
      }
      return env;
    },
  },
  {
    name: "codex",
    displayName: "Codex",
    binary: "codex",
    detect: () => whichSync("codex"),
    envVars: (_url, cwd) => {
      // Codex CLI is a Rust binary that does NOT read OPENAI_BASE_URL from the
      // environment. Provider routing is done exclusively via config.toml or
      // `-c` CLI overrides (see cliArgs below). We still expose LORE_PROJECT /
      // LORE_GIT_REMOTE for env_http_headers mapping if the user configures a
      // custom provider with env_http_headers in their config.toml.
      const env: Record<string, string> = { LORE_PROJECT: cwd };
      const remote = safeRemote(cwd);
      if (remote) env.LORE_GIT_REMOTE = remote;
      return env;
    },
    cliArgs: (url) => [
      // Override the built-in OpenAI provider's base URL to route through the
      // Lore gateway. Uses `-c` so the change is per-invocation only — it does
      // not affect Codex's persisted config or session scoping.
      "-c",
      `openai_base_url="${url}/v1"`,
      // Disable Codex auto-compaction — Lore manages context via its own
      // gradient context manager and distillation pipeline.
      "-c",
      "model_auto_compact_token_limit=999999999",
    ],
  },
  {
    name: "pi",
    displayName: "Pi",
    binary: "pi",
    detect: () => whichSync("pi"),
    envVars: (url, _cwd) => ({
      ANTHROPIC_BASE_URL: url,
      LORE_GATEWAY_URL: url,
      // Pi's @loreai/pi extension handles git remote header injection
      // via registerProviders() when LORE_GATEWAY_URL is set.
    }),
  },
  {
    name: "opencode",
    displayName: "OpenCode",
    binary: "opencode",
    detect: () => whichSync("opencode"),
    envVars: (url, _cwd) => ({
      OPENAI_BASE_URL: `${url}/v1`,
      // OpenCode's @loreai/opencode plugin handles git remote header
      // injection via chat.headers hook.
    }),
  },
  {
    name: "hermes",
    displayName: "Hermes Agent",
    binary: "hermes",
    detect: () => whichSync("hermes"),
    envVars: (url, cwd) => {
      const env: Record<string, string> = {
        // Hermes uses OPENAI_BASE_URL for custom OpenAI-compatible endpoints.
        // Force provider to "custom" so Hermes picks up the base URL.
        OPENAI_BASE_URL: `${url}/v1`,
        HERMES_INFERENCE_PROVIDER: "custom",
      };
      // Expose project path & git remote as env vars so Hermes can map
      // them to custom headers if supported in the future.  The gateway
      // resolves the project from system-prompt inference and cwd for now.
      env.LORE_PROJECT = cwd;
      const remote = safeRemote(cwd);
      if (remote) env.LORE_GIT_REMOTE = remote;
      return env;
    },
  },
];

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

export interface DetectedAgent {
  def: AgentDef;
  path: string;
}

/**
 * Scan PATH for all known agents. Returns the ones found with their
 * binary paths.
 */
export function detectAgents(): DetectedAgent[] {
  const found: DetectedAgent[] = [];
  for (const def of AGENTS) {
    const path = def.detect();
    if (path) found.push({ def, path });
  }
  return found;
}
