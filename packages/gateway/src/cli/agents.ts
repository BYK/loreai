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
  /**
   * Base-URL env var(s) this agent honors to pick an upstream, in priority
   * order (first defined wins). `lore run` rewrites these to point the agent
   * at the gateway — but if the USER already set one (e.g. pointing Claude
   * Code at OpenRouter or a corporate proxy), that is their intended upstream.
   * We capture it BEFORE clobbering and tell the gateway to proxy there, so
   * Lore adopts the user's existing config instead of silently overriding it
   * with the hardcoded api.anthropic.com / api.openai.com default.
   *
   * The captured value's wire protocol is the agent's `wireProtocol` (below):
   * an Anthropic-shape client (Claude Code) pointed at OpenRouter is adopted
   * as an anthropic-ingress request whose upstream host is openrouter.ai; the
   * gateway's `providerFromUpstreamUrl` reverse-map then flips protocol/scheme
   * for known hosts. Omit for agents whose base URL cannot be adopted this way
   * (e.g. opencode, which routes via the plugin, not a base-URL env var).
   */
  upstreamEnvVars?: string[];
  /**
   * The wire protocol the agent speaks to its upstream — used to pick which
   * gateway `LORE_UPSTREAM_<protocol>` default to override when adopting the
   * user's captured upstream (see `upstreamEnvVars`).
   */
  wireProtocol?: "anthropic" | "openai" | "gemini";
  /**
   * Env var(s) the agent reads for its API credential, in priority order
   * (first defined non-empty wins). Paired with `upstreamEnvVars`: a user who
   * points the agent at a provider purely via shell env (e.g. Claude Code at
   * OpenRouter via `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`) has a fully
   * usable credential Lore can reuse for standalone `lore import` — even
   * though nothing is stored in the agent's on-disk auth file. `scheme` is how
   * the value is sent upstream: `bearer` (Authorization: Bearer) vs `api-key`
   * (x-api-key / Anthropic-style). Omit for agents whose credential can't be
   * read from a static env var (e.g. opencode, github-copilot token exchange).
   */
  authTokenEnvVars?: { var: string; scheme: "bearer" | "api-key" }[];
}

/**
 * Whether a hostname is a loopback address. Under `lore run` the local gateway
 * always binds loopback, so ANY loopback host in the user's base-URL env is
 * either the gateway itself or a stale gateway from a previous run — never a
 * real upstream to adopt. Rejecting all loopback hosts (not just the exact
 * origin) keeps re-launches idempotent even when the gateway restarts on a
 * different port (port contention). A genuine upstream (OpenRouter, a corporate
 * proxy) is never loopback.
 */
function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  if (h === "localhost" || h === "::1" || h === "0.0.0.0" || h === "::")
    return true;
  // 127.0.0.0/8
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  // URL canonicalizes IPv4-mapped IPv6, e.g. ::ffff:127.0.0.1 becomes
  // ::ffff:7f00:1. Decode its high IPv4 octet so mapped loopback/wildcard
  // addresses cannot bypass the self-proxy guard.
  const mapped = h.match(
    /^(?:::ffff:|0:0:0:0:0:ffff:)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/,
  );
  if (!mapped) return false;
  const high = Number.parseInt(mapped[1], 16);
  const low = Number.parseInt(mapped[2], 16);
  return high >>> 8 === 127 || (high === 0 && low === 0);
}

/**
 * The upstream the USER already configured for an agent via its base-URL env
 * var, captured from the parent environment before `lore run` overrides it.
 *
 * Returns the first defined `upstreamEnvVars` value that points somewhere
 * OTHER than a loopback host, so we never "adopt" the gateway pointing at
 * itself and re-launches through `lore run` stay idempotent even if the
 * gateway restarts on a different port. Returns null when the agent has
 * no adoptable base-URL var, none is set, or the only value is loopback.
 * Throws when a non-empty configured value cannot be routed safely; callers
 * must not mistake an invalid override for an absent one and launch with the
 * override's credential against Lore's default upstream.
 */
export function captureUserUpstream(
  agent: AgentDef,
  gatewayUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): { url: string; wireProtocol: NonNullable<AgentDef["wireProtocol"]> } | null {
  if (!agent.upstreamEnvVars || !agent.wireProtocol) return null;
  for (const key of agent.upstreamEnvVars) {
    const raw = env[key];
    if (!raw) continue;
    const invalid = () => {
      throw new Error(
        `${agent.displayName} has an unsafe or invalid upstream URL in ${key}`,
      );
    };
    // Strip control chars (CR/LF/etc.) up front — a newline in a base-URL env
    // var would otherwise ride through into an injected header (CRLF header
    // smuggling). `new URL()` tolerates an embedded newline, so we cannot rely
    // on parse-failure to reject it. appendCustomHeader also sanitizes, but we
    // normalize at the source so every consumer sees a clean value.
    // oxlint-disable-next-line no-control-regex -- intentional control-character sanitization
    const trimmed = raw.replace(/[\x00-\x1f\x7f]/g, "").trim();
    if (!trimmed) invalid();
    // A real base URL has no internal whitespace. Reject anything with an
    // interior space/tab — after control-char stripping, a CRLF-smuggling
    // payload like "https://host/\nX-Api-Key: stolen" collapses to a value
    // with an interior space, which must not be adopted.
    if (/\s/.test(trimmed)) invalid();
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      invalid();
      continue;
    }
    // Only adopt a real http(s) URL that isn't the gateway itself. Credentials
    // belong in the agent's auth env, never in a base URL that may be forwarded
    // in a routing header or surfaced in diagnostics.
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") invalid();
    if (parsed.username || parsed.password || parsed.search || parsed.hash)
      invalid();
    // Reject ANY loopback host, not just the exact gateway origin: the gateway
    // may restart on a different port (contention), so a stale
    // ANTHROPIC_BASE_URL=http://127.0.0.1:<old-port> must not be adopted (would
    // proxy the gateway back into itself). gatewayUrl is unused here now but
    // kept in the signature for callers/tests and future host-aware checks.
    void gatewayUrl;
    if (isLoopbackHost(parsed.hostname)) continue;
    return { url: trimmed, wireProtocol: agent.wireProtocol };
  }
  return null;
}

/**
 * Sanitize + validate a base-URL env value. Returns a clean http(s) URL string
 * (control chars stripped, interior whitespace rejected — see the CRLF note in
 * captureUserUpstream) or null if unusable. Userinfo, queries, and fragments
 * are rejected because gateway route normalization cannot preserve them.
 * Loopback is NOT rejected here:
 * unlike `lore run`, `lore import` starts no long-lived gateway to point at, so
 * a loopback base URL (a running gateway the user already has) is a legitimate
 * extraction upstream.
 */
function cleanBaseUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  // oxlint-disable-next-line no-control-regex -- intentional control-character sanitization
  const trimmed = raw.replace(/[\x00-\x1f\x7f]/g, "").trim();
  if (!trimmed || /\s/.test(trimmed)) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      return null;
    if (parsed.username || parsed.password || parsed.search || parsed.hash)
      return null;
  } catch {
    return null;
  }
  return trimmed;
}

/**
 * A credential the user configured for an agent purely through shell env vars:
 * the agent's base-URL (`upstreamEnvVars`) plus its auth-token
 * (`authTokenEnvVars`). This is a fully usable extraction credential even when
 * NOTHING is stored in the agent's on-disk auth file — the common OpenRouter /
 * corporate-proxy setup (e.g. Claude Code with ANTHROPIC_BASE_URL=openrouter.ai
 * + ANTHROPIC_AUTH_TOKEN=<key>). Returns the token + scheme + captured upstream
 * URL, so `lore import` can route extraction to that upstream. Returns null if
 * the agent has no env-credential mechanism, or the token/base URL is missing.
 * A base URL is NOT required (some setups set only the token and rely on the
 * provider default), but a token IS.
 */
export function captureUserEnvCredential(
  agent: AgentDef,
  env: NodeJS.ProcessEnv = process.env,
): {
  token: string;
  scheme: "bearer" | "api-key";
  upstreamUrl: string | null;
  /**
   * Name of the env var that produced the captured token. Lets the caller
   * (e.g. `resolveAgentImportAuth` for opencode) map the credential back
   * to a provider family — env vars are provider-shaped
   * (ANTHROPIC_API_KEY → anthropic, OPENAI_API_KEY → openai, …) but the
   * token alone can't disambiguate.
   */
  envVarName: string;
} | null {
  if (!agent.authTokenEnvVars) return null;
  let picked: { token: string; scheme: "bearer" | "api-key" } | null = null;
  let envVarName: string | null = null;
  for (const { var: key, scheme } of agent.authTokenEnvVars) {
    const raw = env[key];
    if (!raw) continue;
    // oxlint-disable-next-line no-control-regex -- intentional control-character sanitization
    const token = raw.replace(/[\x00-\x1f\x7f]/g, "").trim();
    if (!token) continue;
    picked = { token, scheme };
    envVarName = key;
    break;
  }
  if (!picked || !envVarName) return null;
  // Capture the paired base URL (first defined + valid), if any.
  let upstreamUrl: string | null = null;
  for (const key of agent.upstreamEnvVars ?? []) {
    const raw = env[key];
    if (!raw) continue;
    const clean = cleanBaseUrl(raw);
    if (!clean) return null;
    upstreamUrl = clean;
    break;
  }
  return { ...picked, upstreamUrl, envVarName };
}

/**
 * Sanitize a git remote URL for safe embedding in env vars / headers.
 * Strips control characters to prevent injection attacks.
 */
function safeRemote(cwd: string): string | null {
  const remote = getGitRemote(cwd);
  if (!remote) return null;
  // oxlint-disable-next-line no-control-regex -- intentional control-character sanitization
  return remote.replace(/[\x00-\x1f\x7f]/g, "");
}

/**
 * Quote a string value for safe embedding inside a TOML basic string literal.
 * Escapes backslashes and double quotes, drops control characters. Used for
 * `LORE_UPSTREAM_EXTRA_HEADERS` value-pass-through to Codex via `-c`.
 */
function tomlQuote(value: string): string {
  // oxlint-disable-next-line no-control-regex -- intentional control-character sanitization
  const cleaned = value.replace(/[\x00-\x1f\x7f]/g, "");
  return `"${cleaned.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Append a header to ANTHROPIC_CUSTOM_HEADERS (curl-style format:
 * "Name: Value" newline-separated).
 *
 * Both `name` and `value` are stripped of control characters (CR/LF/etc.)
 * before embedding. This is the single sink for every custom header; a raw
 * newline in `value` would otherwise smuggle a second header into the
 * newline-delimited format (CRLF header injection) — e.g. an adopted
 * upstream URL derived from a user-controlled env var. `new URL()` tolerates
 * an embedded newline, so sanitizing here (in addition to normalizing at the
 * caller) is defense-in-depth, matching `safeRemote`/`tomlQuote`.
 */
export function appendCustomHeader(
  env: Record<string, string>,
  envKey: string,
  name: string,
  value: string,
): void {
  // oxlint-disable-next-line no-control-regex -- intentional control-character sanitization
  const clean = (s: string) => s.replace(/[\x00-\x1f\x7f]/g, "");
  const existing = env[envKey] ?? process.env[envKey] ?? "";
  const header = `${clean(name)}: ${clean(value)}`;
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
    upstreamEnvVars: ["ANTHROPIC_BASE_URL"],
    wireProtocol: "anthropic",
    // Claude Code: ANTHROPIC_AUTH_TOKEN is a Bearer token (used for
    // OpenRouter / proxy setups); ANTHROPIC_API_KEY is the first-party
    // x-api-key. Bearer wins when both are set (matches Claude Code's own
    // precedence: an explicit auth token overrides the api key).
    authTokenEnvVars: [
      { var: "ANTHROPIC_AUTH_TOKEN", scheme: "bearer" },
      { var: "ANTHROPIC_API_KEY", scheme: "api-key" },
    ],
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
    upstreamEnvVars: ["OPENAI_BASE_URL"],
    wireProtocol: "openai",
    authTokenEnvVars: [{ var: "OPENAI_API_KEY", scheme: "bearer" }],
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
    upstreamEnvVars: ["ANTHROPIC_BASE_URL"],
    wireProtocol: "anthropic",
    // Pi reads ANTHROPIC_AUTH_TOKEN (bearer, for proxies like OpenRouter)
    // and ANTHROPIC_API_KEY (api-key, first-party Anthropic). Bearer wins
    // when both are set — matches Claude Code's precedence parity.
    authTokenEnvVars: [
      { var: "ANTHROPIC_AUTH_TOKEN", scheme: "bearer" },
      { var: "ANTHROPIC_API_KEY", scheme: "api-key" },
    ],
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
    // OpenCode reads auth.json FIRST, but the OpenAI/Anthropic/Google
    // @ai-sdk clients it spawns ALSO honor the well-known shell env vars
    // below — and shell env wins over auth.json for those SDKs. When the
    // user has `ANTHROPIC_API_KEY=…` set in their shell, OpenCode's
    // actual model calls use it (NOT the rotated/old key on disk),
    // so `lore import` must surface that env credential too — otherwise
    // we'd silently 401 on a stale key while the live `lore run` works.
    // Order matters: the bearer/token forms win over the API-key form for
    // the same provider family, matching Claude Code's documented
    // precedence (carried as a parity rule).
    //
    // Note: `authTokenEnvVars` does NOT identify the provider itself; the
    // `resolveAgentImportAuth` env-credential branch maps these onto the
    // agent's `wireProtocol` (anthropic/openai) by default. For OpenCode
    // we want provider-mapping driven by `~/.config/opencode/opencode.json`'s
    // `model` field. The new env-credential lookup in `import.ts` does
    // that mapping by consulting the active provider.
    authTokenEnvVars: [
      { var: "ANTHROPIC_AUTH_TOKEN", scheme: "bearer" },
      { var: "ANTHROPIC_API_KEY", scheme: "api-key" },
      { var: "OPENAI_API_KEY", scheme: "bearer" },
      { var: "OPENROUTER_API_KEY", scheme: "bearer" },
      { var: "GEMINI_API_KEY", scheme: "bearer" },
      { var: "GOOGLE_API_KEY", scheme: "bearer" },
    ],
  },
  {
    name: "hermes",
    displayName: "Hermes Agent",
    binary: "hermes",
    detect: () => whichSync("hermes"),
    upstreamEnvVars: ["OPENAI_BASE_URL"],
    wireProtocol: "openai",
    // Hermes reads OPENAI_API_KEY (bearer) for OpenAI-compatible upstreams.
    // OPENAI_BASE_URL is in upstreamEnvVars (above) — captured separately by
    // captureUserEnvCredential when the user points Hermes at a proxy.
    authTokenEnvVars: [{ var: "OPENAI_API_KEY", scheme: "bearer" }],
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
    upstreamEnvVars: ["COPILOT_API_URL"],
    wireProtocol: "openai",
    // NOTE: GitHub Copilot CLI stores credentials in its own config
    // (~/.config/github-copilot/hosts.json), not in shell env vars. The CLI
    // does NOT document a COPILOT_TOKEN env var. We intentionally don't
    // wire authTokenEnvVars here — auto-fallback for Copilot conversations
    // is gated on a prior `lore run` capturing the live token via
    // getLastSeenAuth (tier 4). To import Copilot history, run `lore run`
    // once first; subsequent `lore import` will use the captured credential.
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
    upstreamEnvVars: ["GOOGLE_GEMINI_BASE_URL"],
    wireProtocol: "gemini",
    // Gemini CLI (GEMINI_API_KEY mode) reads GEMINI_API_KEY as a bearer
    // against the Generative Language API. GOOGLE_API_KEY is the older
    // sibling and is also honored by Google's Gemini SDK clients — picked
    // up here so users with either key get auto-fallback coverage.
    authTokenEnvVars: [
      { var: "GEMINI_API_KEY", scheme: "bearer" },
      { var: "GOOGLE_API_KEY", scheme: "bearer" },
    ],
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
