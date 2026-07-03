/**
 * Agent registry — known AI coding agents that can be launched through
 * the gateway.
 *
 * Each agent defines:
 *  - How to detect it (binary name on PATH)
 *  - What env vars to set so it talks through the gateway
 */
import { getGitRemote } from "@loreai/core";
import { CLAUDE_CODE_FIRST_PARTY_ENV } from "../cch";
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
 * Partial opencode config injected via `OPENCODE_CONFIG_CONTENT` when
 * launching opencode through `lore run`. Ensures the @loreai/opencode
 * plugin is loaded — its `config` hook (`applyLoreProviderConfig`)
 * iterates `cfg.provider` and pins `options.baseURL = ${gatewayBase}/v1`
 * for every provider. This is the only general mechanism for routing
 * opencode through the gateway: opencode's `resolveSDK()` always passes
 * `options.baseURL` to the @ai-sdk factory (bypassing env vars like
 * `OPENAI_BASE_URL`/`ANTHROPIC_BASE_URL`), and most @ai-sdk providers
 * have no baseURL env var at all.
 *
 * If the plugin isn't installed, opencode handles the failure gracefully
 * (logs a warning, continues without the plugin). If the user's config
 * already registers the plugin, opencode's `deduplicatePluginOrigins`
 * prevents double-loading.
 *
 * `OPENCODE_CONFIG_CONTENT` is deep-merged with the user's existing
 * opencode.json (config.ts:461-468), preserving API keys, model
 * selections, and other settings.
 */
const OPENCODE_PLUGIN_CONFIG = JSON.stringify({
  plugin: ["@loreai/opencode"],
});

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
        // Claude Code >= 2.1.181 only emits the `cch` billing field when it
        // believes it is talking to the first-party API: it suppresses `cch`
        // unless ANTHROPIC_BASE_URL's host is exactly `api.anthropic.com`. We
        // point ANTHROPIC_BASE_URL at the local gateway (a transparent proxy to
        // that first-party API), so without this the client sends NO `cch` and
        // the gateway's resignBody cannot re-sign the billing header it
        // modifies. Forcing the first-party assumption is correct here and safe
        // to apply unconditionally: `cch` is a no-op for non-OAuth sessions,
        // OAuth tokens already flow to the gateway today, and the only other
        // effect (enabling `traceparent` propagation) carries non-secret W3C
        // trace IDs already covered by the gateway's header forwarding. See
        // quality/CCH.md (first-party gate). NEVER remove this for Claude Code.
        [CLAUDE_CODE_FIRST_PARTY_ENV]: "1",
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
    envVars: (_url, _cwd) => ({
      OPENCODE_CONFIG_CONTENT: OPENCODE_PLUGIN_CONFIG,
    }),
  },
  {
    name: "hermes",
    displayName: "Hermes Agent",
    binary: "hermes",
    detect: () => whichSync("hermes"),
    envVars: (url, cwd) => {
      const env: Record<string, string> = {
        // Route Hermes through the gateway. Both keys are undocumented in the
        // official env-vars reference but verified honored against hermes-agent
        // 0.18.0 (see #649):
        //   • OPENAI_BASE_URL — read as the custom OpenAI-compatible base URL
        //     (auxiliary_client.py os.getenv("OPENAI_BASE_URL")).
        //   • HERMES_INFERENCE_PROVIDER — selects the provider; resolution
        //     order is CLI flag > config.yaml `model.provider` > this env var
        //     > "auto" (cli.py). So "custom" makes a stock Hermes pick up
        //     OPENAI_BASE_URL, but a named `model.provider` in
        //     ~/.hermes/config.yaml takes precedence over it.
        // `lore setup hermes` persists this same pair to ~/.hermes/.env for
        // standalone (non-`lore run`) launches.
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
  {
    name: "copilot",
    displayName: "GitHub Copilot CLI",
    binary: "copilot",
    detect: () => whichSync("copilot"),
    envVars: (url, cwd) => {
      // GitHub Copilot CLI talks to the Copilot API (normally
      // api.githubcopilot.com) in OpenAI wire format, performing its own GitHub→
      // Copilot token exchange and setting a `Copilot-Integration-Id` header.
      // `COPILOT_API_URL` overrides that API base — verified in the @github/copilot
      // loader, which returns it verbatim as the Copilot API URL when set — so
      // pointing it at the gateway makes Copilot's model calls flow through Lore.
      // Copilot posts to the ORIGIN's bare `/chat/completions` (its API omits the
      // /v1 segment), which the gateway accepts; the gateway recognizes the
      // integration header and forwards to the github-copilot upstream (see
      // forwardToUpstream). Use the bare origin (no /v1 suffix).
      //
      // This intercepts Copilot's DEFAULT (GitHub-hosted) models. BYOK users
      // point COPILOT_PROVIDER_BASE_URL at the gateway themselves, so we leave
      // the COPILOT_PROVIDER_* vars untouched.
      const env: Record<string, string> = { COPILOT_API_URL: url };
      // Project attribution. Copilot has no env→header mapping for model calls,
      // so the gateway attributes the project from cwd / system-prompt inference;
      // these are exported for consistency with other agents and future use.
      env.LORE_PROJECT = cwd;
      const remote = safeRemote(cwd);
      if (remote) env.LORE_GIT_REMOTE = remote;
      return env;
    },
  },
  {
    name: "gemini",
    displayName: "Gemini CLI",
    binary: "gemini",
    detect: () => whichSync("gemini"),
    envVars: (url, cwd) => {
      // Google's Gemini CLI (GEMINI_API_KEY mode) reads GOOGLE_GEMINI_BASE_URL
      // as the base origin for the native Generative Language API — it appends
      // `/v1beta/models/{model}:generateContent` itself, so pass the bare gateway
      // origin (no /v1). Gemini's security rule allows plain HTTP only for
      // localhost / 127.0.0.1 / [::1], which the local gateway satisfies. The
      // gateway speaks the native generateContent protocol and forwards to
      // generativelanguage.googleapis.com.
      const env: Record<string, string> = { GOOGLE_GEMINI_BASE_URL: url };
      // Project attribution (Gemini has no env→header mapping for model calls;
      // the gateway attributes from cwd / system-prompt inference).
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
