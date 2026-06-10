/**
 * Upstream-safe fetch for the gateway.
 *
 * When the gateway runs in-process alongside a plugin (OpenCode, Pi),
 * `globalThis.fetch` may be patched by the fetch interceptor to redirect
 * LLM API calls through the gateway. The gateway's own upstream calls
 * must bypass this interception to avoid an infinite loop.
 *
 * This module uses undici's own `fetch` instead of `globalThis.fetch` so
 * the gateway can configure timeouts independently of Node's built-in
 * fetch (which provides no configuration surface — its internal undici
 * dispatcher is isolated and unaffected by `setGlobalDispatcher` from
 * npm). A shared {@link upstreamDispatcher} disables `bodyTimeout` and
 * `headersTimeout` (both default to 300s in undici) so LLM streaming
 * responses from slow/reasoning models aren't killed mid-generation.
 *
 * This also naturally bypasses the fetch interceptor: the interceptor
 * patches `globalThis.fetch`, but undici's `fetch` is a separate
 * function that is not affected by that patch.
 *
 * When no interceptor is installed (standalone gateway, CLI), this
 * falls back to `globalThis.fetch` for non-upstream calls — but
 * `upstreamFetch` always uses undici's fetch.
 */
import { fetch as undiciFetch, Agent } from "undici";

/**
 * Shared undici dispatcher with disabled body/header timeouts.
 *
 * Node's built-in fetch (undici) defaults to `bodyTimeout`/`headersTimeout`
 * of 300 000 ms (5 minutes). For an LLM proxy this is a hard cap on
 * generation time — heavy/reasoning models that think for >5 min get their
 * upstream connection killed mid-stream. The gateway's own inbound server
 * timeouts are already disabled (server.ts:452–455); this extends the same
 * policy to outbound upstream calls. Genuinely stuck upstreams are still
 * caught by the retry/circuit-breaker logic in llm-adapter.ts.
 */
const upstreamDispatcher = new Agent({ bodyTimeout: 0, headersTimeout: 0 });

/**
 * Fetch function that bypasses the plugin's fetch interceptor and uses
 * undici directly with disabled timeouts for LLM upstream calls.
 */
export function upstreamFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  // undici's fetch types diverge from the global Web API types (Headers,
  // Request, Response) but are runtime-compatible. Cast through unknown
  // to bridge the compile-time gap without losing the return type.
  return undiciFetch(
    input as Parameters<typeof undiciFetch>[0],
    { ...init, dispatcher: upstreamDispatcher } as Parameters<
      typeof undiciFetch
    >[1],
  ) as unknown as Promise<Response>;
}
