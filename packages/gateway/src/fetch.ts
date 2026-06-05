/**
 * Upstream-safe fetch for the gateway.
 *
 * When the gateway runs in-process alongside a plugin (OpenCode, Pi),
 * `globalThis.fetch` may be patched by the fetch interceptor to redirect
 * LLM API calls through the gateway. The gateway's own upstream calls
 * must bypass this interception to avoid an infinite loop.
 *
 * This module re-exports the original, un-intercepted `fetch` via
 * `getOriginalFetch()` from `@loreai/core`. All gateway code that
 * makes HTTP requests to upstream LLM providers (or any external
 * endpoint) should use `upstreamFetch` instead of bare `fetch`.
 *
 * When no interceptor is installed (standalone gateway, CLI), this
 * falls back to `globalThis.fetch`.
 */
import { getOriginalFetch } from "@loreai/core";

/**
 * Fetch function that bypasses the plugin's fetch interceptor.
 * Use this for all gateway upstream HTTP calls.
 */
export function upstreamFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  return getOriginalFetch()(input, init);
}
