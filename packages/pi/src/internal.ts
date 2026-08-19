/**
 * Internal helpers for the Lore Pi extension.
 *
 * These functions are intentionally kept OUT of the extension entry module
 * (`./index.ts`) so they can be unit-tested directly. The entry module's
 * default export is the extension factory; Pi loads it and only that. Keeping
 * the pure, side-effect-light logic here (provider-registration shaping,
 * gateway discovery, session-id derivation, the compaction request) lets tests
 * exercise the real behavior without driving the whole factory — and without
 * relying on the `NODE_ENV=test` inert path.
 */
import { createHash } from "node:crypto";
import { GATEWAY_AUTH_HEADER } from "@loreai/core";
import { log } from "@loreai/core";
import * as http from "node:http";
import * as https from "node:https";

/**
 * Pi-side shape of a `session_before_compact` result. Pi doesn't re-export
 * these event result types at the top level, so we inline the minimal shape.
 */
export type SessionBeforeCompactResult = {
  cancel?: boolean;
  compaction?: {
    summary: string;
    firstKeptEntryId: string;
    tokensBefore: number;
    details?: unknown;
  };
};

/**
 * Providers whose wire protocol the Lore gateway can proxy, split by SDK
 * protocol so we can set the correct `baseUrl` for each group.
 *
 * - Anthropic SDK appends `/v1/messages` to baseURL → pass gateway root.
 * - OpenAI SDK appends `/chat/completions` or `/responses` to baseURL and
 *   expects it to already include `/v1` → pass `${gateway}/v1`.
 *
 * Providers using other protocols (Google SDK, AWS Bedrock SDK, Mistral
 * conversations) are not redirected.
 *
 * For local/self-hosted providers, set `LORE_UPSTREAM_<PROVIDER>=<url>` (e.g.
 * `LORE_UPSTREAM_VLLM=http://localhost:8000`) so the gateway knows where to
 * forward requests. Cloud providers are routed automatically by model name
 * prefix.
 */

/** Anthropic-messages API → gateway POST /v1/messages */
export const ANTHROPIC_PROVIDERS = [
  "anthropic",
  "fireworks",
  "minimax",
  "minimax-cn",
  "kimi-coding",
] as const;

/** OpenAI-completions / OpenAI-responses API → gateway POST /v1/chat/completions or /v1/responses */
export const OPENAI_PROVIDERS = [
  // openai-completions API
  "github-copilot",
  "deepseek",
  "xai",
  "groq",
  "cerebras",
  "openrouter",
  "huggingface",
  "zai",
  "opencode",
  "opencode-go",
  "vercel-ai-gateway",
  // openai-responses API
  "openai",
  // Codex (ChatGPT) — OpenAI Responses wire format. Registered with the
  // standard `${gatewayBase}/v1` baseUrl; the Codex provider appends
  // `/codex/responses` itself, landing on the gateway's `/v1/codex/responses`
  // route. The Codex WSS attempt targets the same baseUrl and is rejected by
  // the HTTP-only gateway, so Pi falls back to SSE through Lore (no bypass).
  "openai-codex",
  // Local / self-hosted (OpenAI-compatible)
  "vllm",
  "llamacpp",
  "ollama",
  "lmstudio",
  "jan",
  "localai",
  "tgi",
  "tabbyml",
  "litellm",
] as const;

/** All providers that can be routed through the gateway. */
export const GATEWAY_PROVIDERS: readonly string[] = [
  ...ANTHROPIC_PROVIDERS,
  ...OPENAI_PROVIDERS,
];

/** Default ports to probe when looking for a running gateway (must match gateway defaults). */
export const KNOWN_GATEWAY_PORTS = [3207, 5673];

function isLoopbackUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname
      .replace(/^\[/, "")
      .replace(/\]$/, "")
      .toLowerCase();
    return (
      hostname === "localhost" ||
      hostname === "localhost." ||
      hostname === "::1" ||
      /^127(?:\.\d{1,3}){3}$/.test(hostname)
    );
  } catch {
    return false;
  }
}

function probeLoopback(url: string, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const request = (parsed.protocol === "https:" ? https : http).request(
      parsed,
      { method: "GET", signal },
      (response) => {
        response.resume();
        const status = response.statusCode ?? 0;
        resolve(status >= 200 && status < 300);
      },
    );
    request.on("error", reject);
    request.end();
  });
}

/** Strip URL components that may carry credentials before diagnostics. */
function gatewayUrlForLog(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "invalid";
    return url.origin + (url.pathname === "/" ? "" : url.pathname);
  } catch {
    return "invalid";
  }
}

/** A provider registration as passed to `pi.registerProvider`. */
export interface ProviderRegistration {
  provider: string;
  baseUrl: string;
  headers: Record<string, string>;
}

/**
 * Check if the Lore gateway is reachable at the given base URL.
 * Short timeout so this doesn't delay Pi startup noticeably.
 */
export async function probeGateway(
  baseURL: string,
  timeoutMs = 1500,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = `${baseURL}/health`;
    if (isLoopbackUrl(url)) return await probeLoopback(url, controller.signal);
    return (await fetch(url, { signal: controller.signal })).ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve the gateway URL by probing known ports and reading the port file.
 *
 * Order: LORE_REMOTE_URL → LORE_GATEWAY_URL → port file → known default
 * ports (3207, 5673). Returns the URL of a running gateway, or null if none
 * found.
 */
export async function resolveGatewayUrl(): Promise<string | null> {
  // 0. Remote gateway — skip local discovery/startup entirely.
  if (process.env.LORE_REMOTE_URL) {
    const url = gatewayUrlForLog(
      process.env.LORE_REMOTE_URL.replace(/\/$/, ""),
    );
    if (url !== "invalid" && (await probeGateway(url))) return url;
    log.info(
      `pi: remote gateway at ${url} not reachable, falling through to local discovery`,
    );
  }

  // 1. Explicit env var — probe it to verify it's actually reachable.
  if (process.env.LORE_GATEWAY_URL) {
    const url = gatewayUrlForLog(
      process.env.LORE_GATEWAY_URL.replace(/\/$/, ""),
    );
    if (url !== "invalid" && (await probeGateway(url))) return url;
    // env var set but gateway unreachable — fall through to discovery
  }

  // 2. Build probe list: port file first (handles random port), then known defaults.
  const probePorts = new Set<number>();
  try {
    const gw = "@loreai/gateway";
    const { readPortFile } = await import(/* webpackIgnore: true */ gw);
    const portfilePort = readPortFile();
    if (portfilePort) probePorts.add(portfilePort);
  } catch {
    /* gateway package not available — skip port file */
  }
  for (const p of KNOWN_GATEWAY_PORTS) probePorts.add(p);

  // 3. Probe each port.
  for (const port of probePorts) {
    const url = `http://127.0.0.1:${port}`;
    if (await probeGateway(url)) return url;
  }

  return null;
}

/**
 * Start the gateway server in-process by importing @loreai/gateway as a
 * library. The published CJS bundle includes Node.js polyfills that shim
 * Bun.serve() to node:http.createServer(), so this works under both Bun and
 * Node.js.
 *
 * Uses startGateway() which handles the full port fallback chain
 * (3207 → 5673 → random) and port file management automatically.
 * Returns the URL of the started gateway, or null on failure.
 */
export async function startInProcess(): Promise<string | null> {
  try {
    // Dynamic import — the gateway may be resolved from src (workspace) or
    // dist/index.cjs (npm). Use a variable to prevent tsc from resolving the
    // module at compile time (the .d.cts only exists after building).
    const gw = "@loreai/gateway";
    const { startGateway } = await import(/* webpackIgnore: true */ gw);
    const handle = await startGateway({ quiet: true, local: true });
    const url = `http://127.0.0.1:${handle.port}`;

    if (!handle.owned) {
      log.info(`pi: reusing existing gateway at ${gatewayUrlForLog(url)}`);
    }

    return url;
  } catch {
    log.warn("pi: failed to start gateway in-process");
    return null;
  }
}

/**
 * Derive a stable session identifier from Pi's current session file path.
 * Falls back to an ephemeral, per-process id when no session file is known.
 */
export function sessionIDFor(sessionFile: string | undefined): string {
  if (!sessionFile) return `pi-ephemeral-${process.pid}`;
  return `pi-${createHash("sha256").update(sessionFile).digest("hex").slice(0, 24)}`;
}

/** Access headers are injected only for the URL selected by LORE_REMOTE_URL. */
export function gatewayAccessHeadersForRemote(
  gatewayBase: string,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const remoteUrl = env.LORE_REMOTE_URL?.replace(/\/+$/, "");
  const token = env.LORE_GATEWAY_AUTH_TOKEN;
  return remoteUrl === gatewayBase.replace(/\/+$/, "") && token
    ? { [GATEWAY_AUTH_HEADER]: token }
    : {};
}

/**
 * Build the provider registrations for every gateway-routable provider.
 *
 * Pure: given the gateway base, the current session/project, the resolved git
 * remote, and the environment, it returns the `{ provider, baseUrl, headers }`
 * tuples to hand to `pi.registerProvider`. Anthropic-protocol providers get the
 * gateway root; OpenAI-protocol providers get `${gateway}/v1`. Each carries the
 * `x-lore-*` attribution headers and, for local/custom providers, the
 * `x-lore-upstream-url` from `LORE_UPSTREAM_<PROVIDER>`.
 */
export function buildProviderRegistrations(opts: {
  gatewayBase: string;
  sessionID: string;
  projectPath: string;
  gitRemote?: string;
  env?: NodeJS.ProcessEnv;
}): ProviderRegistration[] {
  const {
    gatewayBase,
    sessionID,
    projectPath,
    gitRemote,
    env = process.env,
  } = opts;

  // Anthropic SDK appends `/v1/messages` to baseURL — pass gateway root.
  const anthropicBase = gatewayBase;
  // OpenAI SDK expects baseURL to already include `/v1` — it only appends
  // `/chat/completions` or `/responses`. Matches the pattern in agents.ts.
  const openaiBase = `${gatewayBase}/v1`;
  const anthropicSet: ReadonlySet<string> = new Set(ANTHROPIC_PROVIDERS);

  const registrations: ProviderRegistration[] = [];
  for (const provider of GATEWAY_PROVIDERS) {
    const headers: Record<string, string> = {
      ...gatewayAccessHeadersForRemote(gatewayBase, env),
      "x-lore-session-id": sessionID,
      "x-lore-project": projectPath,
      // Inject provider ID so the gateway uses provider-based routing
      // (correct protocol + upstream URL) instead of model-prefix guessing.
      "x-lore-provider": provider,
    };
    // Inject git remote so the gateway can group worktrees/clones of the
    // same repo without filesystem access (important for remote gateways).
    if (gitRemote) headers["x-lore-git-remote"] = gitRemote;
    // For local/custom providers, inject the original upstream URL so the
    // gateway can forward requests to the correct endpoint. The user sets
    // LORE_UPSTREAM_<PROVIDER>=<url> in their environment.
    const envKey = `LORE_UPSTREAM_${provider.toUpperCase().replace(/-/g, "_")}`;
    const upstream = env[envKey];
    if (upstream) headers["x-lore-upstream-url"] = upstream;

    const baseUrl = anthropicSet.has(provider) ? anthropicBase : openaiBase;
    registrations.push({ provider, baseUrl, headers });
  }
  return registrations;
}

/**
 * Call the gateway's `POST /v1/compact` endpoint and shape the result for Pi's
 * `session_before_compact` hook.
 *
 * The plugin is a dumb relay. The gateway is the single source of truth for
 * "does this session's raw context fit in the layer-0 budget?" — it returns
 * either:
 *
 *   { cancel: true }                       — host should keep the raw context;
 *                                            we relay as `{ cancel: true }` to
 *                                            Pi's `session_before_compact` hook
 *                                            (which Pi honors on both manual
 *                                            and auto paths, per
 *                                            agent-session.js:1275 / :1498).
 *   { summary: string }                    — use this Lore-aware summary
 *                                            instead of Pi's default. We shape
 *                                            it as `{ compaction: {...} }`.
 *
 * Returns `undefined` to fall back to Pi's default compaction on ANY error
 * path:
 *   - 404 `session_not_found` (this session never routed through Lore),
 *   - any other non-2xx response,
 *   - a thrown/network error,
 *   - a 2xx with neither `cancel: true` nor a non-empty `summary`.
 *
 * Never throws and never writes to stdout/stderr — all diagnostics go through
 * the core `log` module (file-based, TUI-safe). `fetchImpl` is injectable for
 * testing.
 */
export async function runCompaction(opts: {
  gatewayBase: string;
  sessionID: string;
  projectPath: string;
  previousSummary: string | undefined;
  firstKeptEntryId: string;
  tokensBefore: number;
  authHeaders?: Readonly<Record<string, string>>;
  fetchImpl?: typeof fetch;
}): Promise<SessionBeforeCompactResult | undefined> {
  const {
    gatewayBase,
    sessionID,
    projectPath,
    previousSummary,
    firstKeptEntryId,
    tokensBefore,
    authHeaders,
    fetchImpl = fetch,
  } = opts;

  try {
    const res = await fetchImpl(`${gatewayBase}/v1/compact`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-lore-session-id": sessionID,
        ...authHeaders,
      },
      body: JSON.stringify({
        project_path: projectPath,
        previous_summary: previousSummary,
        tokens_before: tokensBefore,
      }),
    });

    if (!res.ok) {
      // Gateway returned an error — fall back to Pi's default compaction.
      const sessionNotFound =
        res.status === 404 &&
        (await res
          .text()
          .then((body) => body.includes("session_not_found"))
          .catch(() => false));
      // A 404 `session_not_found` is expected when this session was never
      // routed through Lore (e.g. a provider Lore doesn't proxy, or a
      // websocket-only transport that bypassed the gateway). That's not a
      // failure — log it quietly and let Pi's default compaction run.
      if (sessionNotFound) {
        log.info(
          "pi: lore compaction unavailable — this session was not routed " +
            "through Lore; falling back to Pi compaction.",
        );
        return undefined;
      }
      log.warn(`pi: compaction endpoint returned HTTP ${res.status}`);
      return undefined;
    }

    const body = (await res.json()) as { cancel?: boolean; summary?: string };
    // Gateway's authoritative cancel decision wins. If the gateway says
    // "this session's raw context fits; don't compact", we relay as
    // { cancel: true } and skip the summary branch.
    if (body.cancel === true) {
      log.info(
        "pi: gateway returned cancel=true — keeping raw context " +
          "(Lore manages the window via recall on the next turn).",
      );
      return { cancel: true };
    }
    if (typeof body.summary !== "string" || body.summary === "") {
      return undefined;
    }
    return {
      compaction: {
        summary: body.summary,
        firstKeptEntryId,
        tokensBefore,
      },
    };
  } catch {
    log.warn("pi: custom compaction failed, falling back to default");
    return undefined;
  }
}
