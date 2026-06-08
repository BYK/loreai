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
];

/** True when the URL path matches any known LLM API path pattern. */
function matchesLLMApiPath(pathname: string): boolean {
  for (const pattern of LLM_API_PATH_PATTERNS) {
    if (pattern.test(pathname)) return true;
  }
  return false;
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

    if (!shouldIntercept(url, config.gatewayBase)) {
      // Detect the case where a remote LLM endpoint is NOT being
      // intercepted — that means the X-Lore-* context headers won't be
      // injected, and the gateway will fall back to inference/cwd. Warn
      // once per unique (host, path) so the operator can extend the path
      // patterns if a new provider slips through. Only warn for paths
      // that look like LLM API endpoints (contain keywords like v1,
      // messages, chat, completions, responses, embeddings) to avoid
      // noise from arbitrary HTTPS calls (npm registry, GitHub API, etc.).
      try {
        const parsed = new URL(url);
        const host = parsed.hostname;
        if (
          host &&
          host !== "localhost" &&
          host !== "127.0.0.1" &&
          host !== "0.0.0.0" &&
          host !== "::1" &&
          host !== "[::1]" &&
          !url.startsWith(config.gatewayBase) &&
          // Only warn for paths that look like LLM API endpoints —
          // require the full endpoint suffix, not bare "/v1" (which would
          // false-positive on Stripe, GitHub, npm, etc.).
          /\/(messages|chat\/completions|responses)(\/|$)/.test(parsed.pathname)
        ) {
          const warnKey = `${parsed.host}${parsed.pathname}`;
          if (!warnedPaths.has(warnKey)) {
            warnedPaths.add(warnKey);
            log.warn(
              `fetch-interceptor: ${parsed.host}${parsed.pathname} matched no LLM API pattern — request bypassing Lore gateway. Add a pattern in fetch-interceptor.ts if this is an LLM endpoint.`,
            );
          }
        }
      } catch {
        // ignore URL parse errors — we're already in the non-intercept branch
      }
      return originalFetch(input, init);
    }

    // Rewrite URL to gateway, keeping the canonical /v1/... API path.
    // Provider base paths vary (e.g., openrouter.ai uses /api/v1/...,
    // Anthropic uses /v1/..., some providers use /openai/v1/...). The
    // gateway only routes /v1/... paths, so we extract just that portion.
    // The full original URL (including any prefix) is passed via
    // X-Lore-Upstream-URL so the gateway can forward to the correct host.
    const upstream = new URL(url);
    const gateway = new URL(config.gatewayBase);
    // Find the LAST occurrence of any known canonical path segment
    // (matches "/v1/" in /v1/..., /api/v1/..., /openai/v1/..., etc.).
    // Falls back to the full pathname when the URL doesn't contain /v1/
    // (e.g., a /api/... path) — the gateway may still route it if a
    // provider-specific mapping is in place.
    const v1Idx = upstream.pathname.lastIndexOf("/v1/");
    const apiPath =
      v1Idx >= 0 ? upstream.pathname.slice(v1Idx) : upstream.pathname;
    const gatewayUrl = `${gateway.origin}${apiPath}${upstream.search}`;

    // Merge original headers + X-Lore-* headers.
    // Original headers (including auth) are preserved — the gateway
    // forwards them upstream via forwardClientHeaders().
    // Handle both `fetch(url, {headers})` and `fetch(new Request(url, {headers}))` forms.
    const existingHeaders =
      init?.headers ??
      (typeof input !== "string" && !(input instanceof URL)
        ? input.headers
        : undefined);
    const headers = new Headers(existingHeaders);

    // Pass the original upstream base URL (everything before /v1/...).
    // The gateway uses this as the highest-priority routing signal.
    const upstreamBase =
      v1Idx >= 0
        ? upstream.origin + upstream.pathname.slice(0, v1Idx)
        : upstream.origin;
    headers.set("x-lore-upstream-url", upstreamBase);

    // Inject dynamic context headers (session ID, project, git remote, etc.)
    // Only set if not already present — per-request hooks may have set them.
    try {
      for (const [k, v] of Object.entries(config.getHeaders())) {
        if (!headers.has(k)) headers.set(k, v);
      }
    } catch (e) {
      log.error("fetch-interceptor: getHeaders() failed:", e);
    }

    log.info(
      `fetch-interceptor: ${upstream.host}${upstream.pathname} → gateway`,
    );

    return originalFetch(gatewayUrl, { ...init, headers });
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
