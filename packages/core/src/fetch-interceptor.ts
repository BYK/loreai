/**
 * Fetch-level interception for transparent LLM API proxy routing.
 *
 * Instead of overwriting provider baseURLs early (which loses original auth
 * and URL context), this interceptor wraps `globalThis.fetch` to redirect
 * outgoing LLM API calls through the Lore gateway at the HTTP level.
 *
 * The SDK builds requests normally (correct auth, correct URL for each
 * provider), and the interceptor transparently reroutes them through the
 * gateway while preserving all original headers.
 */
import * as log from "./log";

/** Configuration for the fetch interceptor. */
export type FetchInterceptorConfig = {
  /** Base URL of the Lore gateway (e.g., "http://127.0.0.1:3207"). */
  gatewayBase: string;
  /**
   * Dynamic headers to inject on every intercepted request.
   * Called per-request so values can change (e.g., session ID).
   */
  getHeaders: () => Record<string, string>;
};

/**
 * LLM API path patterns that should be intercepted.
 *
 * These are the standard paths used by Anthropic, OpenAI Chat Completions,
 * and OpenAI Responses API endpoints, plus common aggregator variants:
 *  - `/v1/...` — Anthropic, OpenAI, most direct providers
 *  - `/api/v1/...` — OpenRouter, some self-hosted gateways
 *  - `/api/...` — older / non-standard providers
 *  - `/openai/v1/...`, `/anthropic/v1/...` — proxy providers
 *
 * Each pattern matches the path suffix `/messages`, `/chat/completions`,
 * or `/responses` (the canonical LLM API endpoints). The leading prefix
 * is intentionally permissive — the URL's hostname already restricts which
 * providers we can see, and an over-narrow pattern here is what caused
 * the Onur "lore-config" bug to recur for some users whose providers
 * used a non-standard path prefix.
 */
const LLM_API_PATH_PATTERNS: RegExp[] = [
  // Standard: /v1/{messages,chat/completions,responses}[/...]
  /\/v1\/(messages|chat\/completions|responses)(\/.*)?$/,
  // Aggregator: /api/v1/... (OpenRouter, some self-hosted)
  /\/api\/v1\/(messages|chat\/completions|responses)(\/.*)?$/,
  // Generic: /api/... for providers that don't follow v1 convention
  /\/api\/(messages|chat\/completions|responses)(\/.*)?$/,
  // Proxy paths: /openai/v1/..., /anthropic/v1/...
  /\/(?:openai|anthropic)\/v1\/(messages|chat\/completions|responses)(\/.*)?$/,
  // Codex (ChatGPT) — uses /backend-api/codex/responses, no /v1/ prefix
  /\/codex\/responses(\/.*)?$/,
];

/**
 * Known non-standard LLM API path suffixes that don't follow the /v1/...
 * convention. Maps each suffix to the canonical gateway path.
 */
const NON_STANDARD_PATH_REWRITES: Record<string, string> = {
  // ChatGPT's Responses API endpoint uses /codex/responses (not /v1/responses)
  "/codex/responses": "/v1/codex/responses",
};

/** Internal protocol identifiers the gateway routes on. */
type BodyProtocol = "anthropic" | "openai" | "openai-responses";

/**
 * Canonical gateway endpoint for each protocol. When a request is intercepted
 * via body-shape detection (the URL path is non-standard), we route it to the
 * gateway endpoint that matches the detected protocol. The gateway parses the
 * body according to the path it receives.
 */
const PROTOCOL_GATEWAY_PATHS: Record<BodyProtocol, string> = {
  anthropic: "/v1/messages",
  openai: "/v1/chat/completions",
  "openai-responses": "/v1/responses",
};

/**
 * Endpoint suffixes shared by all LLM protocols. Used to split a non-standard
 * path (e.g. `/foo/v2/chat/completions`) into the upstream base prefix and the
 * endpoint, so body-detected requests carry the correct `X-Lore-Upstream-URL`.
 * Ordered longest-first so the most specific suffix wins.
 */
const LLM_ENDPOINT_SUFFIXES = [
  "/chat/completions",
  "/codex/responses",
  "/responses",
  "/messages",
];

/** True when the URL path matches any known LLM API path pattern. */
function matchesLLMApiPath(pathname: string): boolean {
  for (const pattern of LLM_API_PATH_PATTERNS) {
    if (pattern.test(pathname)) return true;
  }
  return false;
}

/** True when the pathname looks like an LLM API endpoint (for warning/fallback). */
function pathLooksLLMLike(pathname: string): boolean {
  return /\/(messages|chat\/completions|responses)(\/|$)/.test(pathname);
}

/**
 * Best-effort extraction of a request body as a JSON string for body-shape
 * detection. Only handles bodies we can read *synchronously without
 * consuming* them — strings, and ArrayBuffer/typed-array views (decoded as
 * UTF-8). Streaming bodies (ReadableStream) and bodies that live only on a
 * `Request` object can't be read here without consuming them (which would
 * break the forwarded request), so we return undefined and let the request
 * fall through to the warn-once path. Returns undefined on any failure.
 */
function extractBodyString(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
): string | undefined {
  const body = init?.body;
  if (typeof body === "string") return body;
  if (body instanceof ArrayBuffer) {
    try {
      return new TextDecoder().decode(body);
    } catch {
      return undefined;
    }
  }
  if (ArrayBuffer.isView(body)) {
    try {
      return new TextDecoder().decode(body as ArrayBufferView);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Detect LLM protocol from request body shape using unique per-protocol
 * identifiers. Only called when URL didn't match patterns but path looks
 * LLM-like — a fast body-parse to decide whether to intercept anyway.
 *
 * Markers are chosen to be genuinely distinctive per protocol; ambiguous
 * fields (e.g. `store`, `instructions`, which some Chat Completions
 * extensions also use) are intentionally NOT used.
 */
export function detectProtocolFromBody(bodyStr: string): BodyProtocol | null {
  try {
    const body = JSON.parse(bodyStr) as Record<string, unknown>;
    if (typeof body !== "object" || body === null || !body.model) return null;

    // OpenAI Responses API distinctive markers (check first): the Responses
    // API uses `input` (array of items) instead of `messages`, and these
    // top-level fields do not appear in Chat Completions or Anthropic bodies.
    if (
      Array.isArray(body.input) ||
      body.max_output_tokens !== undefined ||
      body.previous_response_id !== undefined
    ) {
      return "openai-responses";
    }

    // Anthropic distinctive marker: top-level `system` field alongside
    // `messages`. OpenAI Chat never has a top-level `system` — it embeds
    // system messages inside the `messages` array.
    if (body.system !== undefined && Array.isArray(body.messages)) {
      return "anthropic";
    }

    // OpenAI Chat: `model` + `messages` (fallback after excluding others).
    if (Array.isArray(body.messages)) {
      return "openai";
    }

    return null;
  } catch {
    return null;
  }
}

type Rewrite = { gatewayUrl: string; upstreamBase: string };

/**
 * Rewrite an intercepted URL to the gateway, handling both standard /v1/...
 * paths and non-standard paths (e.g. /codex/responses). Used by the
 * URL-pattern-matched path (Path 1). Returns null when the path can't be
 * mapped to a canonical gateway endpoint from the URL alone.
 */
function interceptUrl(upstream: URL, gateway: URL): Rewrite | null {
  // Try /v1/ extraction first (most common)
  const v1Idx = upstream.pathname.lastIndexOf("/v1/");
  if (v1Idx >= 0) {
    return {
      gatewayUrl: `${gateway.origin}${upstream.pathname.slice(v1Idx)}${upstream.search}`,
      upstreamBase: upstream.origin + upstream.pathname.slice(0, v1Idx),
    };
  }
  // Try non-standard path rewrites (e.g. /codex/responses → /v1/codex/responses)
  for (const [suffix, canonical] of Object.entries(
    NON_STANDARD_PATH_REWRITES,
  )) {
    if (upstream.pathname.endsWith(suffix)) {
      return {
        gatewayUrl: `${gateway.origin}${canonical}${upstream.search}`,
        upstreamBase:
          upstream.origin + upstream.pathname.slice(0, -suffix.length),
      };
    }
  }
  return null;
}

/**
 * Rewrite an intercepted URL to the gateway using a body-detected protocol
 * (Path 2). The detected protocol picks the canonical gateway endpoint; the
 * upstream base is derived by stripping the recognized endpoint suffix from
 * the original path so the gateway can forward to the real provider.
 *
 * Used only when `interceptUrl` could not map the path from the URL alone —
 * i.e. genuinely non-standard endpoints like `/v2/chat/completions` or
 * `/llm/messages` that nonetheless carry a recognizable body shape.
 */
export function interceptUrlForProtocol(
  upstream: URL,
  gateway: URL,
  protocol: BodyProtocol,
): Rewrite {
  const gatewayPath = PROTOCOL_GATEWAY_PATHS[protocol];
  // Strip the recognized endpoint suffix from the path so X-Lore-Upstream-URL
  // points at the provider base (everything before the endpoint). If no known
  // suffix is present, fall back to the origin.
  let upstreamBase = upstream.origin;
  for (const suffix of LLM_ENDPOINT_SUFFIXES) {
    if (upstream.pathname.endsWith(suffix)) {
      upstreamBase =
        upstream.origin + upstream.pathname.slice(0, -suffix.length);
      break;
    }
  }
  return {
    gatewayUrl: `${gateway.origin}${gatewayPath}${upstream.search}`,
    upstreamBase,
  };
}

/**
 * Set of `${host}${pathname}` strings we've already warned about (avoids
 * log spam on every request to a non-intercepted LLM endpoint).
 */
const warnedPaths = new Set<string>();

/**
 * Determine whether a fetch request should be intercepted and rerouted
 * through the Lore gateway.
 *
 * Only intercepts requests to known LLM API paths on remote hosts.
 * Never intercepts:
 * - Requests already going to the gateway
 * - Local requests (localhost, 127.0.0.1, etc.) — these may be local LLM
 *   servers or the gateway itself (infinite loop risk)
 * - Non-LLM API paths (arbitrary HTTP calls from plugins, health checks, etc.)
 */
export function shouldIntercept(url: string, gatewayBase: string): boolean {
  try {
    const parsed = new URL(url);
    // Never intercept requests already going to the gateway
    if (url.startsWith(gatewayBase)) return false;
    // Never intercept local requests (could be local LLM or gateway itself)
    const host = parsed.hostname;
    if (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "0.0.0.0" ||
      // URL.hostname KEEPS brackets on IPv6 addresses (unlike the WHATWG
      // URL spec we expected). Treat "[::1]" the same as "::1".
      host === "::1" ||
      host === "[::1]"
    )
      return false;
    // Intercept known LLM API paths only
    return matchesLLMApiPath(parsed.pathname);
  } catch {
    return false;
  }
}

/**
 * Install a fetch interceptor that transparently reroutes LLM API calls
 * through the Lore gateway.
 *
 * The interceptor:
 * 1. Checks if the outgoing URL matches a known LLM API path
 * 2. Rewrites the URL to the gateway, preserving the path
 * 3. Adds `X-Lore-Upstream-URL` with the original upstream base
 * 4. Injects dynamic `X-Lore-*` context headers from `getHeaders()`
 * 5. Preserves ALL original headers (auth, content-type, etc.)
 *
 * Returns a cleanup function that restores the original `globalThis.fetch`.
 */
/**
 * The original `globalThis.fetch` captured before any interceptor was
 * installed. The gateway (which may run in the same process) must use
 * this for its own upstream calls to avoid being intercepted in a loop.
 *
 * Null until `installFetchInterceptor()` is called.
 */
let _originalFetch: typeof globalThis.fetch | null = null;

/**
 * Return the original, un-intercepted `fetch` function.
 *
 * When the gateway runs in-process alongside the plugin, it shares
 * `globalThis.fetch` — which the interceptor patches. The gateway must
 * use this function for its own upstream calls to avoid being caught by
 * the interceptor in an infinite loop.
 *
 * Returns `globalThis.fetch` if no interceptor has been installed.
 */
export function getOriginalFetch(): typeof globalThis.fetch {
  return _originalFetch ?? globalThis.fetch;
}

/**
 * Build the gateway-bound headers for an intercepted request: preserve all
 * original headers (auth, content-type, etc.), set `X-Lore-Upstream-URL` to
 * the resolved upstream base, and inject dynamic `X-Lore-*` context headers.
 *
 * Shared by both the URL-matched path (Path 1) and the body-detected path
 * (Path 2) so header handling can never drift between them.
 */
function buildGatewayHeaders(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  upstreamBase: string,
  config: FetchInterceptorConfig,
): Headers {
  // Handle both `fetch(url, {headers})` and `fetch(new Request(url, {headers}))`.
  const existingHeaders =
    init?.headers ??
    (typeof input !== "string" && !(input instanceof URL)
      ? input.headers
      : undefined);
  const headers = new Headers(existingHeaders);

  // Pass the original upstream base URL (everything before the API path).
  // The gateway uses this as the highest-priority routing signal.
  headers.set("x-lore-upstream-url", upstreamBase);

  // Inject dynamic context headers (session ID, project, git remote, etc.).
  // Only set if not already present — per-request hooks may have set them.
  try {
    for (const [k, v] of Object.entries(config.getHeaders())) {
      if (!headers.has(k)) headers.set(k, v);
    }
  } catch (e) {
    log.error("fetch-interceptor: getHeaders() failed:", e);
  }

  return headers;
}

export function installFetchInterceptor(
  config: FetchInterceptorConfig,
): () => void {
  // Guard against double-install: if already installed, the second call
  // would capture the *first* interceptor as _originalFetch, corrupting
  // the chain. Return a no-op cleanup instead.
  if (_originalFetch !== null) {
    return () => {};
  }

  _originalFetch = globalThis.fetch;
  const originalFetch = _originalFetch;

  const interceptor = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

    const gateway = new URL(config.gatewayBase);

    // ---- Path 1: URL matched a known LLM API pattern ----
    if (shouldIntercept(url, config.gatewayBase)) {
      const upstream = new URL(url);
      const rewrite = interceptUrl(upstream, gateway);
      if (!rewrite) {
        // Should not happen — shouldIntercept() being true means the path
        // matched a pattern, and interceptUrl handles all patterns. Pass
        // through as a safety fallback.
        return originalFetch(input, init);
      }
      const headers = buildGatewayHeaders(
        input,
        init,
        rewrite.upstreamBase,
        config,
      );
      log.info(
        `fetch-interceptor: ${upstream.host}${upstream.pathname} → gateway`,
      );
      return originalFetch(rewrite.gatewayUrl, { ...init, headers });
    }

    // ---- Path 2: URL didn't match, but the body shape may reveal an LLM call ----
    try {
      const upstream = new URL(url);
      const host = upstream.hostname;
      const isLocal =
        host === "localhost" ||
        host === "127.0.0.1" ||
        host === "0.0.0.0" ||
        host === "::1" ||
        host === "[::1]";
      const isGateway = url.startsWith(config.gatewayBase);

      if (
        host &&
        !isLocal &&
        !isGateway &&
        pathLooksLLMLike(upstream.pathname)
      ) {
        const bodyRaw = extractBodyString(input, init);
        const detected = bodyRaw ? detectProtocolFromBody(bodyRaw) : null;

        if (detected) {
          // Body shape identified the protocol — route to the canonical
          // gateway endpoint for that protocol so the request goes through
          // Lore even though the URL path was non-standard.
          const rewrite = interceptUrlForProtocol(upstream, gateway, detected);
          const headers = buildGatewayHeaders(
            input,
            init,
            rewrite.upstreamBase,
            config,
          );
          log.info(
            `fetch-interceptor: ${upstream.host}${upstream.pathname} → gateway (body-detected ${detected})`,
          );
          return originalFetch(rewrite.gatewayUrl, { ...init, headers });
        }

        // LLM-looking path we couldn't intercept (no body, or unrecognized
        // shape) — warn once so the operator can extend the patterns.
        const warnKey = `${upstream.host}${upstream.pathname}`;
        if (!warnedPaths.has(warnKey)) {
          warnedPaths.add(warnKey);
          log.warn(
            `fetch-interceptor: ${upstream.host}${upstream.pathname} matched no LLM API pattern — request bypassing Lore gateway. Add a pattern in fetch-interceptor.ts if this is an LLM endpoint.`,
          );
        }
      }
    } catch {
      // ignore URL parse errors — we're already in the non-intercept branch
    }
    return originalFetch(input, init);
  };

  // Preserve any extra properties on the original fetch (e.g. `preconnect`
  // on newer Node.js) so the patched function satisfies `typeof fetch`.
  globalThis.fetch = Object.assign(interceptor, originalFetch);

  // Return cleanup function that restores the original fetch
  return () => {
    globalThis.fetch = originalFetch;
    _originalFetch = null;
  };
}
