/**
 * Gateway configuration — loaded from environment variables with sensible
 * defaults. No Zod, no file-based config — minimal @loreai/core dependency
 * (only `normalizeRemoteUrl` for git URL canonicalization).
 */

import {
  normalizeRemoteUrl,
  discoverWorkspaceRoot,
  UNATTRIBUTED_PROJECT_PREFIX,
  isUnattributedProjectPath,
} from "@loreai/core";

// ---------------------------------------------------------------------------
// Port defaults
// ---------------------------------------------------------------------------

/**
 * Default port preference order when LORE_LISTEN_PORT is not set.
 *
 * - 3207: flip upside-down → 7=L, 0=O, 2=R, 3=E → LORE (calculator-word)
 * - 5673: T9 phone keypad → 5=L, 6=O, 7=R, 3=E → LORE
 */
export const DEFAULT_PORTS = [3207, 5673] as const;

/** The primary default port (first in the fallback chain). */
export const DEFAULT_PORT = DEFAULT_PORTS[0];

// ---------------------------------------------------------------------------
// Config shape
// ---------------------------------------------------------------------------

export interface GatewayConfig {
  /** Port to listen on. Default: 3207. Env: LORE_LISTEN_PORT */
  port: number;
  /** True when the port was explicitly set via LORE_LISTEN_PORT or --port. */
  portExplicit: boolean;
  /**
   * Hosts to bind to. Default: ["127.0.0.1"].
   * Env: LORE_LISTEN_HOST (comma-separated for multiple addresses).
   * CLI: --host (can be specified multiple times, or comma-separated).
   */
  hosts: string[];
  /** Upstream Anthropic API URL. Default: "https://api.anthropic.com". Env: LORE_UPSTREAM_ANTHROPIC */
  upstreamAnthropic: string;
  /** Upstream OpenAI API URL. Default: "https://api.openai.com". Env: LORE_UPSTREAM_OPENAI */
  upstreamOpenAI: string;
  /** Idle timeout in seconds before triggering background work. Default: 60 */
  idleTimeoutSeconds: number;
  /** Session eviction timeout in seconds. Sessions idle beyond this are evicted
   *  from memory (state is preserved in DB). Default: 1800 (30 min).
   *  Set to 0 to disable eviction. Env: LORE_SESSION_EVICTION_TIMEOUT */
  sessionEvictionTimeoutSeconds: number;
  /** Whether to log requests. Default: false. Env: LORE_DEBUG */
  debug: boolean;
  /** Remote gateway URL. When set, `lore run` delegates to this gateway instead of starting a local one. Env: LORE_REMOTE_URL */
  remoteUrl?: string;
  /**
   * Hosted/remote mode — disables all filesystem operations that use
   * client-controlled paths (git subprocess, .lore.json/.lore.md read/write,
   * lat.md/ directory scan, file watchers). Env: LORE_HOSTED_MODE.
   */
  hostedMode: boolean;
  /**
   * Standalone API key for background worker calls (distillation, curation,
   * consolidation, etc.). When set, workers authenticate with this key
   * instead of the session's client credential — enabling workers to use
   * a different provider (e.g. MiniMax) than the session's Anthropic key.
   * Env: LORE_WORKER_API_KEY
   */
  workerApiKey?: string;
  /**
   * Custom upstream URL for background worker calls. When set, all worker
   * HTTP calls route to this URL instead of the default upstream URLs.
   * Enables routing workers to a different provider (e.g. MiniMax's
   * Anthropic-compatible endpoint) while sessions continue using Anthropic.
   * Env: LORE_WORKER_UPSTREAM
   */
  workerUpstream?: string;
  /**
   * Remote/central gateway mode. When true, the gateway is serving agents
   * running on OTHER machines, so its own `process.cwd()` has no relationship
   * to any client's project. In this mode the gateway MUST NOT attribute
   * path-less requests to its own cwd (doing so merges unrelated projects).
   * Instead, requests that cannot resolve a confident project path are routed
   * to a per-session synthetic "unattributed" bucket
   * (`/__lore_unattributed__/<sessionID>`) that can later self-heal or be
   * consolidated. Env: LORE_REMOTE_GATEWAY.
   *
   * Note: hosted mode (`LORE_HOSTED_MODE`) implies remote-gateway behavior —
   * a hosted gateway never shares a filesystem with its clients.
   *
   * Auto-detection: when neither `LORE_REMOTE_GATEWAY` nor `LORE_HOSTED_MODE`
   * is set, the gateway auto-enables remote-gateway mode if its bind
   * address(es) include any non-loopback host. This catches the common
   * case of running a long-lived gateway on a server (Tailscale, LAN IP,
   * `0.0.0.0`, etc.) without requiring an explicit env var.
   */
  remoteGateway: boolean;
  /**
   * `true` when `remoteGateway` was inferred from the bind address rather
   * than set explicitly via env var. Surfaced in the gateway boot log so
   * users can verify the auto-detection. Internal — not part of the public
   * config surface.
   */
  remoteGatewayAutoDetected?: boolean;
  /**
   * `true` when `remoteGateway` was set by the CLI command's default (e.g.
   * `lore start` defaults to remote mode) rather than by env var or bind
   * address. Surfaced in the gateway boot log. Internal.
   */
  remoteGatewayCommandDefault?: boolean;
  /**
   * Extra HTTP headers to inject on every upstream call (corporate proxies,
   * Cloudflare AI Gateway's `cf-aig-authorization`, LiteLLM team-routing
   * tokens, audit/logging tracing headers, etc.).
   *
   * Parsed from the curl-style env var `LORE_UPSTREAM_EXTRA_HEADERS` — newline-
   * separated `Name: Value` pairs, the same convention Anthropic's SDK uses
   * for `ANTHROPIC_CUSTOM_HEADERS`. Keys are lowercased; values are
   * whitespace-trimmed. Empty / malformed lines are skipped with a warning.
   *
   * Precedence (highest wins): gateway-managed headers (`x-api-key`,
   * `Authorization`, `x-lore-*`) > these user-supplied extras > client
   * forwarded headers. This means a user-supplied `Authorization: Bearer
   * svc-token` overrides the session's credential — useful for routing
   * worker calls or routing sessions to a service account.
   */
  upstreamExtraHeaders: Record<string, string>;
}

// ---------------------------------------------------------------------------
// loadConfig
// ---------------------------------------------------------------------------

/** Load gateway configuration from environment variables with defaults. */
export function loadConfig(): GatewayConfig {
  const env = process.env;
  const hosts = parseHosts(env.LORE_LISTEN_HOST);
  /**
   * Explicitly marks this gateway as a remote / multi-tenant one.
   * When set to `1`, the gateway assumes a per-user bucketing model
   * — sessions are isolated by API key + project path instead of
   * merging onto the gateway's cwd. This is the highest-priority
   * signal in the 4-layer remote-gateway auto-detection: it
   * overrides `LORE_HOSTED_MODE`, non-loopback bind detection, and
   * the `lore start` default. Env: `LORE_REMOTE_GATEWAY=1`.
   */
  const remoteGatewayEnv = isTruthy(env.LORE_REMOTE_GATEWAY);
  /**
   * Hosted / remote mode. When set to `1`, the gateway disables all
   * filesystem operations that use client-controlled paths (`.lore.json`
   * loading, `.lore.md` import/export, `getGitRemote()`) to prevent
   * untrusted clients from influencing gateway behavior via crafted
   * paths. Implies remote-gateway mode (per-session bucketing). Use
   * this for multi-tenant hosted deployments where the gateway
   * serves agents on other machines. CLI: `--local` / `-l` forces
   * hosted mode OFF. Env: `LORE_HOSTED_MODE=1`.
   */
  const hostedModeEnv = isTruthy(env.LORE_HOSTED_MODE);
  // Auto-detect when neither env var is DEFINED (not just truthy): a
  // non-loopback bind address strongly implies the gateway is serving remote
  // clients (Tailscale, LAN, `0.0.0.0`, public IP). This prevents the
  // "lore-config" bug from re-emerging on long-running server deployments
  // that forgot to set `LORE_REMOTE_GATEWAY=1`.
  // IMPORTANT: check for `in` (defined), not truthiness. `LORE_REMOTE_GATEWAY=0`
  // is an explicit disable — auto-detection must NOT override it.
  const remoteGatewayDefined = "LORE_REMOTE_GATEWAY" in env;
  const hostedModeDefined = "LORE_HOSTED_MODE" in env;
  const autoDetected =
    !remoteGatewayDefined && !hostedModeDefined && hasNonLoopbackHost(hosts);
  return {
    port: parsePort(env.LORE_LISTEN_PORT, DEFAULT_PORT),
    portExplicit: !!env.LORE_LISTEN_PORT,
    hosts,
    upstreamAnthropic: trimTrailingSlash(
      env.LORE_UPSTREAM_ANTHROPIC || "https://api.anthropic.com",
    ),
    upstreamOpenAI: trimTrailingSlash(
      env.LORE_UPSTREAM_OPENAI || "https://api.openai.com",
    ),
    /**
     * Idle timeout in seconds. After this many seconds with no active
     * request, the gateway stops the per-session in-memory cache
     * warmer and distillation loop to free resources. State is
     * preserved in the DB so a new request resumes from where the
     * session left off. Default: 60. Env: `LORE_IDLE_TIMEOUT`.
     */
    idleTimeoutSeconds: parsePositiveInt(env.LORE_IDLE_TIMEOUT, 60),
    sessionEvictionTimeoutSeconds: parseNonNegativeInt(
      env.LORE_SESSION_EVICTION_TIMEOUT,
      1800,
    ),
    debug: isTruthy(env.LORE_DEBUG),
    remoteUrl: env.LORE_REMOTE_URL
      ? trimTrailingSlash(env.LORE_REMOTE_URL)
      : undefined,
    hostedMode: hostedModeEnv,
    workerApiKey: env.LORE_WORKER_API_KEY || undefined,
    workerUpstream: env.LORE_WORKER_UPSTREAM
      ? trimTrailingSlash(env.LORE_WORKER_UPSTREAM)
      : undefined,
    upstreamExtraHeaders: parseCurlHeaders(env.LORE_UPSTREAM_EXTRA_HEADERS),
    // Hosted mode is always a remote gateway (no shared filesystem with clients).
    // Auto-detect from bind address when neither flag is explicitly set.
    remoteGateway: remoteGatewayEnv || hostedModeEnv || autoDetected,
    remoteGatewayAutoDetected: autoDetected,
  };
}

// ---------------------------------------------------------------------------
// Upstream routing — model name → provider URL + protocol
// ---------------------------------------------------------------------------

export type UpstreamRoute = {
  url: string;
  protocol: "anthropic" | "openai" | "openai-responses";
};

/**
 * Model prefix → upstream provider routing table.
 *
 * Ordered from most-specific to most-general so that e.g. `claude-3-5-haiku`
 * matches `claude-` before any catch-all. Unknown models fall back to the
 * env-var-configured defaults.
 */
const UPSTREAM_ROUTES: Array<{
  prefix: string;
  url: string;
  protocol: "anthropic" | "openai" | "openai-responses";
}> = [
  // Anthropic
  {
    prefix: "claude-",
    url: "https://api.anthropic.com",
    protocol: "anthropic",
  },
  // Nvidia NIM
  {
    prefix: "nvidia/",
    url: "https://integrate.api.nvidia.com",
    protocol: "openai",
  },
  {
    prefix: "meta/",
    url: "https://integrate.api.nvidia.com",
    protocol: "openai",
  },
  {
    prefix: "mistralai/",
    url: "https://integrate.api.nvidia.com",
    protocol: "openai",
  },
  {
    prefix: "google/",
    url: "https://integrate.api.nvidia.com",
    protocol: "openai",
  },
  {
    prefix: "qwen/",
    url: "https://integrate.api.nvidia.com",
    protocol: "openai",
  },
  {
    prefix: "deepseek/",
    url: "https://integrate.api.nvidia.com",
    protocol: "openai",
  },
  // DeepSeek (direct API, dash-prefix)
  { prefix: "deepseek-", url: "https://api.deepseek.com", protocol: "openai" },
  // OpenAI
  { prefix: "gpt-", url: "https://api.openai.com", protocol: "openai" },
  { prefix: "o1-", url: "https://api.openai.com", protocol: "openai" },
  { prefix: "o3-", url: "https://api.openai.com", protocol: "openai" },
  { prefix: "o4-", url: "https://api.openai.com", protocol: "openai" },
  // xAI
  { prefix: "grok-", url: "https://api.x.ai", protocol: "openai" },
  // Mistral (direct)
  { prefix: "mistral-", url: "https://api.mistral.ai", protocol: "openai" },
  { prefix: "codestral-", url: "https://api.mistral.ai", protocol: "openai" },
  // Google (direct)
  {
    prefix: "gemini-",
    url: "https://generativelanguage.googleapis.com",
    protocol: "openai",
  },
];

/**
 * Resolve which upstream to use for a given model name.
 *
 * Returns the inferred route, or null if the model doesn't match any known
 * prefix (caller should fall back to env-var-configured defaults).
 */
export function resolveUpstreamRoute(model: string): UpstreamRoute | null {
  for (const route of UPSTREAM_ROUTES) {
    if (model.startsWith(route.prefix)) {
      return { url: route.url, protocol: route.protocol };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Upstream URL header — local/custom provider support
// ---------------------------------------------------------------------------

/** Maximum allowed length for an upstream URL header value. */
const MAX_UPSTREAM_URL_LENGTH = 2048;

/**
 * Extract and validate the `X-Lore-Upstream-URL` header from a request.
 *
 * Used by local/custom providers (vllm, llama.cpp, ollama, etc.) to tell the
 * gateway where to forward the request when `resolveUpstreamRoute()` returns
 * null. The Pi and OpenCode plugins inject this header when the user sets
 * `LORE_UPSTREAM_<PROVIDER>=<url>` in their environment.
 *
 * Returns `undefined` when the header is absent or invalid.
 */
export function extractUpstreamUrlHeader(
  headers: Record<string, string>,
): string | undefined {
  const raw = headers["x-lore-upstream-url"];
  if (!raw) return undefined;

  // Sanitize: strip control characters, trim.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional control-character sanitization
  const sanitized = raw.replace(/[\x00-\x1f\x7f]/g, "").trim();
  if (!sanitized || sanitized.length > MAX_UPSTREAM_URL_LENGTH)
    return undefined;

  // Must be a valid URL (http or https only, no embedded credentials).
  try {
    const url = new URL(sanitized);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    if (url.username || url.password) return undefined;
    // Strip trailing /v1 — users often copy the full endpoint URL from
    // local LLM docs (e.g. http://localhost:8000/v1) but the gateway
    // appends /v1/... itself when building the upstream request.
    const pathname = url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "");
    return url.origin + pathname;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Provider-ID-based routing
// ---------------------------------------------------------------------------

/**
 * Route resolved from a provider ID header.
 *
 * `url` is null for providers that require user configuration via
 * `LORE_UPSTREAM_<PROVIDER>` (local/self-hosted inference servers).
 */
export type ProviderRoute = {
  url: string | null;
  /** Wire protocol for this upstream. When `null`, the ingress protocol is
   *  preserved — use this for proxy/aggregator providers (OpenCode Zen,
   *  Vercel AI Gateway, etc.) that accept whichever protocol the client sends. */
  protocol: "anthropic" | "openai" | "openai-responses" | null;
};

/**
 * Provider ID → upstream routing table.
 *
 * Provider IDs match the keys used by the OpenCode and Pi plugins in their
 * GATEWAY_PROVIDERS lists. When a request arrives with an `X-Lore-Provider`
 * header, this table is consulted BEFORE the model-prefix UPSTREAM_ROUTES.
 *
 * URLs must NOT include `/v1` — the gateway appends `/v1/messages`,
 * `/v1/chat/completions`, or `/v1/responses` itself.
 *
 * Data sourced from models.dev provider database (https://models.dev/providers).
 * Protocol derived from the provider's SDK package: `@ai-sdk/anthropic` →
 * "anthropic", `@ai-sdk/openai` / `@ai-sdk/openai-compatible` → "openai".
 */
const PROVIDER_ROUTES: Record<string, ProviderRoute> = {
  // --- Anthropic protocol ---
  anthropic: {
    url: "https://api.anthropic.com",
    protocol: "anthropic",
  },
  fireworks: {
    url: "https://api.fireworks.ai/inference",
    protocol: "anthropic",
  },
  "github-copilot": {
    url: "https://api.githubcopilot.com",
    protocol: "openai",
  },
  minimax: {
    url: "https://api.minimax.io/anthropic",
    protocol: "anthropic",
  },
  "minimax-cn": {
    url: "https://api.minimaxi.com/anthropic",
    protocol: "anthropic",
  },
  "kimi-coding": {
    url: "https://api.kimi.com/coding",
    protocol: "anthropic",
  },
  // --- OpenAI protocol ---
  deepseek: { url: "https://api.deepseek.com", protocol: "openai" },
  xai: { url: "https://api.x.ai", protocol: "openai" },
  groq: { url: "https://api.groq.com/openai", protocol: "openai" },
  cerebras: { url: "https://api.cerebras.ai", protocol: "openai" },
  openrouter: { url: "https://openrouter.ai/api", protocol: "openai" },
  huggingface: {
    url: "https://router.huggingface.co",
    protocol: "openai",
  },
  zai: { url: null, protocol: "openai" }, // uses /v4 path — user sets LORE_UPSTREAM_ZAI
  "vercel-ai-gateway": { url: null, protocol: null },
  // --- OpenAI Responses protocol ---
  openai: {
    url: "https://api.openai.com",
    protocol: "openai-responses",
  },
  // --- Aggregator / gateway providers (protocol: null = preserve ingress) ---
  opencode: { url: "https://opencode.ai/zen", protocol: null },
  "opencode-go": { url: "https://opencode.ai/zen/go", protocol: null },
  // --- SDK-routed providers (model-prefix fallback also works) ---
  nvidia: {
    url: "https://integrate.api.nvidia.com",
    protocol: "openai",
  },
  mistral: { url: "https://api.mistral.ai", protocol: "openai" },
  google: {
    url: "https://generativelanguage.googleapis.com",
    protocol: "openai",
  },
  // --- Local / self-hosted (url: null → user MUST set LORE_UPSTREAM_<PROVIDER>) ---
  vllm: { url: null, protocol: "openai" },
  llamacpp: { url: null, protocol: "openai" },
  ollama: { url: null, protocol: "openai" },
  lmstudio: { url: null, protocol: "openai" },
  jan: { url: null, protocol: "openai" },
  localai: { url: null, protocol: "openai" },
  tgi: { url: null, protocol: "openai" },
  tabbyml: { url: null, protocol: "openai" },
  litellm: { url: null, protocol: "openai" },
};

/**
 * Resolve upstream route by provider ID from the `X-Lore-Provider` header.
 *
 * Returns the provider route if found (url may be null for local providers),
 * or null if the provider ID is not in the table.
 */
export function resolveProviderRoute(providerID: string): ProviderRoute | null {
  return PROVIDER_ROUTES[providerID] ?? null;
}

/** Maximum allowed length for a provider ID header value. */
const MAX_PROVIDER_ID_LENGTH = 64;

/**
 * Extract and validate the `X-Lore-Provider` header from a request.
 *
 * Returns the sanitized provider ID (lowercase, alphanumeric + hyphens only)
 * or `undefined` when the header is absent or invalid.
 */
export function extractProviderHeader(
  headers: Record<string, string>,
): string | undefined {
  const raw = headers["x-lore-provider"];
  if (!raw) return undefined;

  // Sanitize: strip control characters, trim, lowercase.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional control-character sanitization
  const cleaned = raw.replace(/[\x00-\x1f\x7f]/g, "");
  const sanitized = cleaned.trim().toLowerCase();
  if (!sanitized || sanitized.length > MAX_PROVIDER_ID_LENGTH) return undefined;

  // Provider IDs are alphanumeric + hyphens only (e.g. "minimax-cn").
  if (!/^[a-z0-9-]+$/.test(sanitized)) return undefined;

  return sanitized;
}

// ---------------------------------------------------------------------------
// Project path inference
// ---------------------------------------------------------------------------

/**
 * Regex patterns to extract an absolute project path from a system prompt.
 *
 * Claude Code embeds absolute paths in several places:
 *  - CLAUDE.md content references (`/home/user/project/CLAUDE.md`)
 *  - Tool definitions mention cwd (`"cwd": "/home/user/project"`)
 *  - Working directory lines (`Working directory: /Users/…/project`)
 *
 * Each pattern captures the directory portion (no trailing filename when
 * possible). Ordered from most-specific to most-general.
 */
const PROJECT_PATH_PATTERNS: RegExp[] = [
  // "cwd": "/path/to/project" (JSON-style in tool definitions).
  // Accepts any absolute path — the surrounding structure (key + quotes)
  // provides enough specificity to avoid false positives.
  /["']?cwd["']?\s*[:=]\s*["']?(\/[^\s"',}]+)/,
  // Working directory: /path/to/project
  // Accepts any absolute path — the "Working directory" prefix is unambiguous.
  /[Ww]orking\s+directory[:=]\s*(\/[^\s"',]+)/,
  // CLAUDE.md / AGENTS.md / .lore.md file path → take the directory.
  // Accepts any absolute path — the known filename suffix is unambiguous.
  /(\/[^\s"',]+)\/(?:CLAUDE|AGENTS|\.lore)\.md/,
  // Generic absolute path starting with /home/ or /Users/ — first occurrence.
  // Kept narrow intentionally to avoid matching system paths (/usr/lib, /etc, …).
  /(\/(?:home|Users)\/[\w./-]+)/,
];

/**
 * Try to extract a project path from the system prompt content.
 *
 * Claude Code includes absolute paths in its system prompt (CLAUDE.md
 * content, tool definitions, working directory references). Returns the
 * extracted path or `null` if nothing looks like a project directory.
 */
export function inferProjectPath(systemPrompt: string): string | null {
  for (const pattern of PROJECT_PATH_PATTERNS) {
    const match = pattern.exec(systemPrompt);
    if (match?.[1]) {
      // Strip trailing slashes for consistency
      return match[1].replace(/\/+$/, "") || null;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// getProjectPath
// ---------------------------------------------------------------------------

export type ProjectPathSource = "header" | "inferred" | "cwd";

export type ProjectPathResult = {
  path: string;
  source: ProjectPathSource;
  /** Normalized git remote URL from `X-Lore-Git-Remote` header, if provided. */
  gitRemote?: string;
};

/**
 * Path prefix for synthetic "unattributed" project buckets created when a
 * remote/central gateway cannot determine a confident project path for a
 * request. Each such session gets its own bucket
 * (`/__lore_unattributed__/<sessionID>`) so unrelated sessions are never
 * merged. Buckets are clearly marked (this prefix + a provisional project
 * name) so they can later self-heal (when a confident path arrives) or be
 * consolidated into real projects.
 *
 * Canonical prefix is defined in `@loreai/core` so the gateway and the DB
 * naming layer agree. Re-exported here for gateway-local convenience.
 */
export const UNATTRIBUTED_PREFIX = UNATTRIBUTED_PROJECT_PREFIX;

/** Build the synthetic unattributed-bucket path for a given session. */
export function unattributedBucketPath(sessionID: string): string {
  return `${UNATTRIBUTED_PREFIX}/${sessionID}`;
}

/** True when a project path is a synthetic unattributed bucket. */
export const isUnattributedPath = isUnattributedProjectPath;

/**
 * Resolve the project path for a request. Checks in order:
 *  1. `X-Lore-Project` header (explicit override)
 *  2. `inferProjectPath(systemPrompt)` (zero-config extraction)
 *  3. `process.cwd()` (last resort fallback)
 *
 * Returns a `{ path, source }` tuple so callers can distinguish a
 * successful resolution from a cwd fallback and take corrective action
 * (e.g. upgrading from session-cached state).
 *
 * NOTE: The cwd fallback does NOT log a warning — callers are responsible
 * for logging after any post-hoc upgrades (e.g. from session state) so
 * the warning only fires when the fallback truly sticks.
 */
export function getProjectPath(
  systemPrompt: string,
  headers: Record<string, string>,
): ProjectPathResult {
  // Extract git remote from header (independent of path resolution).
  const gitRemote = extractGitRemoteHeader(headers);

  // 1. Explicit header override (sanitized)
  const headerPath = extractProjectHeader(headers);
  if (headerPath) return { path: headerPath, source: "header", gitRemote };

  // 2. Infer from system prompt content
  const inferred = inferProjectPath(systemPrompt);
  if (inferred) return { path: inferred, source: "inferred", gitRemote };

  // 3. Fall back to gateway's own cwd (with workspace root discovery)
  return {
    path: discoverWorkspaceRoot(process.cwd()),
    source: "cwd",
    gitRemote,
  };
}

// ---------------------------------------------------------------------------
// Git remote header extraction
// ---------------------------------------------------------------------------

/** Maximum allowed length for a git remote header value. */
const MAX_GIT_REMOTE_LENGTH = 512;

/**
 * Extract and validate the `X-Lore-Git-Remote` header from a request.
 * Normalizes SSH/HTTPS/git:// variants to a canonical form and strips
 * any control characters (prevents header injection via crafted remote URLs).
 * Returns `undefined` when the header is absent or invalid.
 */
export function extractGitRemoteHeader(
  headers: Record<string, string>,
): string | undefined {
  const raw = headers["x-lore-git-remote"];
  if (!raw) return undefined;

  // Strip control characters (newlines, carriage returns, null bytes) to
  // prevent header injection and DB corruption.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional control-character sanitization
  const sanitized = raw.replace(/[\x00-\x1f\x7f]/g, "").trim();
  if (!sanitized || sanitized.length > MAX_GIT_REMOTE_LENGTH) return undefined;

  return normalizeRemoteUrl(sanitized);
}

// ---------------------------------------------------------------------------
// Project path header extraction
// ---------------------------------------------------------------------------

/** Maximum allowed length for a project path header value. */
const MAX_PROJECT_PATH_LENGTH = 1024;

/**
 * Extract and validate the `X-Lore-Project` header from a request.
 * Strips control characters, trims whitespace, and rejects non-absolute paths.
 * Returns `undefined` when the header is absent or invalid.
 */
export function extractProjectHeader(
  headers: Record<string, string>,
): string | undefined {
  const raw = headers["x-lore-project"];
  if (!raw) return undefined;

  // Strip control characters (newlines, carriage returns, null bytes) to
  // prevent header injection and DB corruption.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional control-character sanitization
  const sanitized = raw.replace(/[\x00-\x1f\x7f]/g, "").trim();
  if (!sanitized || sanitized.length > MAX_PROJECT_PATH_LENGTH)
    return undefined;

  // Must be an absolute path
  if (!sanitized.startsWith("/")) return undefined;

  // Strip trailing slashes for consistency
  return sanitized.replace(/\/+$/, "") || undefined;
}

// ---------------------------------------------------------------------------
// Helpers (not exported — internal only)
// ---------------------------------------------------------------------------

function parsePort(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n) || n < 0 || n > 65535) {
    console.error(
      `[lore] warning: invalid port "${value}", using default ${fallback}`,
    );
    return fallback;
  }
  return n;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n) || n <= 0) {
    console.error(
      `[lore] warning: invalid value "${value}", using default ${fallback}`,
    );
    return fallback;
  }
  return n;
}

/** Like parsePositiveInt but allows 0 (for "disabled" semantics). */
function parseNonNegativeInt(
  value: string | undefined,
  fallback: number,
): number {
  if (!value) return fallback;
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n) || n < 0) {
    console.error(
      `[lore] warning: invalid value "${value}", using default ${fallback}`,
    );
    return fallback;
  }
  return n;
}

function isTruthy(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

function parseHosts(value: string | undefined): string[] {
  if (!value) return ["127.0.0.1"];
  const hosts = value
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  return hosts.length ? hosts : ["127.0.0.1"];
}

/**
 * Return true if any host in the bind list is a non-loopback address — the
 * strongest signal we have (without DNS lookups) that the gateway is
 * serving clients on other machines. Used to auto-enable `remoteGateway`
 * mode when neither `LORE_REMOTE_GATEWAY` nor `LORE_HOSTED_MODE` is set.
 *
 * Loopback variants covered: `127.0.0.0/8`, `::1`, `localhost`. `0.0.0.0`
 * and `::` (unspecified) are treated as non-loopback because they bind
 * on all interfaces and are the canonical "long-running server" bind.
 */
export function hasNonLoopbackHost(hosts: string[]): boolean {
  for (const raw of hosts) {
    const h = raw.toLowerCase().trim();
    if (!h) continue;
    if (h === "localhost") continue;
    if (h === "::1" || h === "[::1]") continue;
    if (h.startsWith("127.")) continue;
    // 0.0.0.0 / :: — bind on all interfaces, treat as non-loopback.
    return true;
  }
  return false;
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * Parse curl-style multi-line header blocks into a `Record<string, string>`.
 *
 * Accepts the same format Anthropic's SDK uses for `ANTHROPIC_CUSTOM_HEADERS`
 * and `OpenAI-Organization`-style env-var header lists: one `Name: Value`
 * per line, separated by `\n`. Keys are lowercased and trimmed; values are
 * trimmed. Empty lines and malformed lines (no colon) are skipped with a
 * warning logged to stderr. Returns `{}` when the input is empty/undefined.
 *
 * Header names are validated to contain only printable ASCII (RFC 7230
 * token chars) and a leading non-whitespace colon is required. Values may
 * contain any printable ASCII excluding CR/LF (already split by the line
 * separator). Sanitization strips control characters defensively to
 * prevent header injection if a value happens to contain stray bytes.
 */
export function parseCurlHeaders(
  input: string | undefined,
): Record<string, string> {
  if (!input) return {};
  const out: Record<string, string> = {};
  for (const rawLine of input.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const colonIdx = line.indexOf(":");
    if (colonIdx <= 0) {
      console.error(
        `[lore] warning: ignoring malformed LORE_UPSTREAM_EXTRA_HEADERS line: ${JSON.stringify(line)}`,
      );
      continue;
    }
    const rawName = line.slice(0, colonIdx).trim();
    const rawValue = line.slice(colonIdx + 1).trim();
    // Header name: RFC 7230 token = visible ASCII + a few separators.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional control-character sanitization
    const name = rawName.replace(/[\x00-\x1f\x7f]/g, "");
    // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional control-character sanitization
    const value = rawValue.replace(/[\x00-\x1f\x7f]/g, "").trim();
    if (!name || !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) {
      console.error(
        `[lore] warning: ignoring invalid header name in LORE_UPSTREAM_EXTRA_HEADERS: ${JSON.stringify(rawName)}`,
      );
      continue;
    }
    out[name.toLowerCase()] = value;
  }
  return out;
}
