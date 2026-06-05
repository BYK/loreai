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
 * These are the standard paths used by Anthropic, OpenAI Chat Completions,
 * and OpenAI Responses API endpoints. Some providers prefix with /api
 * (e.g., OpenRouter uses /api/v1/chat/completions).
 */
const LLM_API_PATH_PATTERN =
  /\/v1\/(messages|chat\/completions|responses)(\/.*)?$/;

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
      host === "::1" // URL.hostname strips brackets from IPv6
    )
      return false;
    // Intercept known LLM API paths only
    return LLM_API_PATH_PATTERN.test(parsed.pathname);
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
      return originalFetch(input, init);
    }

    // Rewrite URL to gateway, keeping only the /v1/... API path.
    // Provider base paths vary (e.g., openrouter.ai uses /api/v1/...,
    // Anthropic uses /v1/...). The gateway only routes /v1/... paths,
    // so we extract just that portion. The full original URL (including
    // any prefix) is passed via X-Lore-Upstream-URL.
    const upstream = new URL(url);
    const gateway = new URL(config.gatewayBase);
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
