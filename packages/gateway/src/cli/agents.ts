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
 * Quote a string value for safe embedding inside a TOML basic string literal.
 * Escapes backslashes and double quotes, drops control characters. Used for
 * `LORE_UPSTREAM_EXTRA_HEADERS` value-pass-through to Codex via `-c`.
 */
function tomlQuote(value: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional control-character sanitization
  const cleaned = value.replace(/[\x00-\x1f\x7f]/g, "");
  return `"${cleaned.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
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

/**
 * All OpenCode provider IDs that accept a `baseURL` in their options.
 *
 * Sourced from opencode's `BUNDLED_PROVIDERS` (provider.ts:108-135) plus the
 * `custom()` dispatch table (provider.ts:169-953). Every one of these
 * providers' factories accepts a `baseURL` option, and opencode's
 * `resolveSDK()` always passes that option through — so setting
 * `options.baseURL` here routes every chat call through the Lore gateway.
 *
 * Order matches the provider.ts declaration for readability.
 */
export const OPENCODE_PROVIDER_IDS = [
  // Bundled @ai-sdk providers
  "amazon-bedrock",
  "anthropic",
  "azure",
  "google",
  "google-vertex",
  "google-vertex-anthropic",
  "openai",
  "openai-compatible",
  "openrouter",
  "xai",
  "mistral",
  "groq",
  "deepinfra",
  "cerebras",
  "cohere",
  "gateway",
  "togetherai",
  "perplexity",
  "vercel",
  "alibaba",
  // Custom providers
  "opencode",
  "azure-cognitive-services",
  "github-copilot",
  "sap-ai-core",
  "gitlab",
  "cloudflare-workers-ai",
  "cloudflare-ai-gateway",
  "snowflake-cortex",
  "llmgateway",
  "nvidia",
  "kilo",
  "zenmux",
  "venice",
] as const;

/**
 * Build a partial opencode config that pins `options.baseURL` for every
 * known provider to `${gatewayUrl}/v1`. Serialized to JSON for
 * `OPENCODE_CONFIG_CONTENT`, which opencode deep-merges with the user's
 * existing config (config.ts:461-468) — so API keys, model selections,
 * headers, and other provider options are preserved.
 */
export function buildOpencodeProviderConfig(
  gatewayUrl: string,
): Record<string, unknown> {
  const baseUrl = `${gatewayUrl}/v1`;
  const providerConfig: Record<string, { options: { baseURL: string } }> = {};
  for (const id of OPENCODE_PROVIDER_IDS) {
    providerConfig[id] = { options: { baseURL: baseUrl } };
  }
  return { provider: providerConfig };
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
      /**
       * Project path the gateway exports to the spawned Codex CLI. Set
       * on the child process so a user-defined `env_http_headers` in
       * `~/.codex/config.toml` can map it to a custom header. The
       * gateway itself does not read this env var; it only sets it
       * for downstream consumption.
       */
      const env: Record<string, string> = { LORE_PROJECT: cwd };
      const remote = safeRemote(cwd);
      /**
       * Git remote URL (e.g. `git@github.com:org/repo.git`) of the
       * project the spawned Codex CLI is operating in. Exported by
       * the gateway so a user-defined `env_http_headers` in
       * `~/.codex/config.toml` can map it to a custom header for
       * upstream telemetry. Set only when `git remote get-url origin`
       * returns a value; the gateway does not read this env var
       * itself.
       */
      if (remote) env.LORE_GIT_REMOTE = remote;
      return env;
    },
    cliArgs: (url) => {
      const args = [
        // Override the built-in OpenAI provider's base URL to route through the
        // Lore gateway. Uses `-c` so the change is per-invocation only — it does
        // not affect Codex's persisted config or session scoping.
        "-c",
        `openai_base_url="${url}/v1"`,
        // Disable Codex auto-compaction — Lore manages context via its own
        // gradient context manager and distillation pipeline.
        "-c",
        "model_auto_compact_token_limit=999999999",
      ];
      // Forward LORE_UPSTREAM_EXTRA_HEADERS to Codex via the
      // `openai_provider_headers` config key (TOML map of header name → value).
      // Codex appends these to every outbound request to the OpenAI-compatible
      // upstream, which now points at the Lore gateway. The gateway reads the
      // same env var and re-injects them on the actual upstream call — this
      // is a belt-and-suspenders pass-through so a user with a custom
      // corporate proxy gets headers on both hops.
      const extraRaw = process.env.LORE_UPSTREAM_EXTRA_HEADERS;
      if (extraRaw) {
        const pairs: string[] = [];
        for (const rawLine of extraRaw.split(/\r?\n/)) {
          const line = rawLine.trim();
          if (!line) continue;
          const colonIdx = line.indexOf(":");
          if (colonIdx <= 0) continue;
          const name = line.slice(0, colonIdx).trim();
          const value = line.slice(colonIdx + 1).trim();
          if (name) pairs.push(`${name} = ${tomlQuote(value)}`);
        }
        if (pairs.length) {
          args.push("-c", `openai_provider_headers = { ${pairs.join(", ")} }`);
        }
      }
      return args;
    },
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
    envVars: (url, _cwd) => {
      // OpenCode's `resolveSDK()` (packages/opencode/src/provider/provider.ts)
      // computes `baseURL` from `provider.options.baseURL ?? model.api.url`
      // and ALWAYS passes it to the @ai-sdk factory — which means the
      // `OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL` env vars are bypassed
      // (the @ai-sdk providers' loadOptionalSetting() only consults the
      // env var when the factory receives an undefined `baseURL`, and
      // opencode never sends undefined). Every other @ai-sdk provider
      // (google, mistral, groq, cohere, xai, perplexity, togetherai,
      // vercel, alibaba, deepinfra, gateway, openrouter, cerebras, etc.)
      // has NO baseURL env var at all.
      //
      // The only way to route ALL provider calls through the gateway when
      // launching opencode is to inject config via `OPENCODE_CONFIG_CONTENT`,
      // which opencode deep-merges with the user's existing config
      // (config.ts:461-468) — so API keys, model selections, and other
      // provider settings are preserved. We pin `options.baseURL` for every
      // bundled + custom provider so every chat call hits the gateway.
      const opencodeConfigContent = JSON.stringify(
        buildOpencodeProviderConfig(url),
      );
      return {
        OPENCODE_CONFIG_CONTENT: opencodeConfigContent,
        // OpenCode's @loreai/opencode plugin handles git remote header
        // injection via chat.headers hook.
      };
    },
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
      // Expose project path & git remote as env vars so downstream
      // agents can map them to custom headers if supported in the future.
      // The gateway resolves the project from system-prompt inference and
      // cwd for now.
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
