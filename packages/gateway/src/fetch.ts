/**
 * Upstream-safe fetch for the gateway.
 *
 * When the gateway runs in-process alongside a plugin (OpenCode, Pi),
 * `globalThis.fetch` may be patched by the fetch interceptor to redirect
 * LLM API calls through the gateway. The gateway's own upstream calls
 * must bypass this interception to avoid an infinite loop.
 *
 * Both Node and Bun default `fetch` to a ~5-minute (300s) timeout that severs
 * long LLM generations mid-stream. They need different fixes, because the two
 * runtimes' fetch implementations are very different:
 *
 *  - **Node**: the built-in fetch (undici) caps `bodyTimeout`/`headersTimeout`
 *    at 300s and exposes no configuration surface. We use undici's own `fetch`
 *    with a dispatcher that disables both timeouts. This also bypasses the
 *    interceptor (undici's fetch is a separate function from `globalThis.fetch`).
 *
 *  - **Bun**: real undici@7 does NOT work under Bun for *streaming* responses —
 *    reading the response body incrementally hangs forever (verified on Bun
 *    1.3.14, OpenCode's embedded runtime). So under Bun we must use the native
 *    fetch (`getOriginalFetch()` — captured before the interceptor patched it),
 *    which streams correctly. To remove Bun's own 300s cap we pass Bun's
 *    `timeout: false` option (undocumented in Bun's typings but verified
 *    empirically on Bun 1.3.14; if silently ignored, the pre-existing 300s
 *    default remains — not a regression).
 *
 * `undici` is imported lazily (and only on the Node path) so it is never
 * evaluated under Bun and can be marked `external` in the Bun esbuild bundle.
 */
import { getOriginalFetch } from "@loreai/core";

type UndiciModule = typeof import("undici");
type UndiciHandles = {
  fetch: UndiciModule["fetch"];
  dispatcher: InstanceType<UndiciModule["Agent"]>;
};

/** True when running under the Bun runtime (OpenCode in-process plugin). */
const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

/** Memoized undici fetch + shared timeout-disabled dispatcher (Node path only). */
let undiciHandles: UndiciHandles | null = null;

/**
 * Lazily load undici and build a dispatcher with body/header timeouts disabled.
 * Referencing `import("undici")` only here keeps undici out of the Bun bundle
 * (it is marked external there and the Bun path never calls this).
 */
async function getUndici(): Promise<UndiciHandles> {
  if (undiciHandles) return undiciHandles;
  const undici = await import("undici");
  const dispatcher = new undici.Agent({ bodyTimeout: 0, headersTimeout: 0 });
  undiciHandles = { fetch: undici.fetch, dispatcher };
  return undiciHandles;
}

/**
 * Fetch function for the gateway's upstream LLM calls.
 *
 * Bypasses the plugin's fetch interceptor and disables the runtime's default
 * 300s fetch timeout so slow/reasoning models aren't killed mid-generation.
 */
export async function upstreamFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  if (isBun) {
    // Bun: native fetch streams correctly (real undici hangs on Bun's
    // incremental stream reads). `timeout: false` aims to disable Bun's default
    // 300s fetch timeout (undocumented but empirically verified on Bun 1.3.14).
    return getOriginalFetch()(input, {
      ...init,
      timeout: false,
    } as RequestInit);
  }

  // Node: undici with disabled body/header timeouts. undici's fetch types
  // diverge from the global Web API types but are runtime-compatible — cast
  // through unknown to bridge the compile-time gap.
  const { fetch: undiciFetch, dispatcher } = await getUndici();
  return undiciFetch(
    input as Parameters<UndiciModule["fetch"]>[0],
    { ...init, dispatcher } as Parameters<UndiciModule["fetch"]>[1],
  ) as unknown as Promise<Response>;
}
