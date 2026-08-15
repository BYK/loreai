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
 *    1.3.14, OpenCode's embedded runtime). Bun's native `fetch` streams
 *    correctly but hardcodes a ~5-minute inactivity timeout (oven-sh/bun#16682)
 *    that cannot be disabled. So under Bun we use **`node:https.request()`**
 *    via Bun's Node compat layer, which has no such timeout cap (verified:
 *    survives 310s of total silence where native fetch dies at 300s). The
 *    response is wrapped in a standard Web API `Response` with a streaming
 *    `ReadableStream` body.
 *
 * `undici` is imported lazily (and only on the Node path) so it is never
 * evaluated under Bun and can be marked `external` in the Bun esbuild bundle.
 */
import * as https from "node:https";
import * as http from "node:http";
// Type-only import: erased at compile time, so it never pulls undici into the
// Bun bundle (where undici is marked external and the Bun path is used instead).
import type { Dispatcher } from "undici";

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
 * Test-only override for the upstream undici dispatcher (Node path).
 *
 * `upstreamFetch` passes an *explicit* `dispatcher` to undici's `fetch`, which
 * overrides `setGlobalDispatcher` — so a `MockAgent` cannot intercept upstream
 * calls via the global. This seam lets a test inject a `MockAgent` (or any
 * dispatcher) so it can capture/assert the exact bytes and headers the gateway
 * writes to the wire — fully in-process, with no real network, DNS, or TLS.
 * Mirrors the `setUpstreamInterceptor` test seam in pipeline.ts. Pass `null` to
 * restore the default timeout-disabled Agent. No effect under Bun.
 */
let dispatcherOverride: Dispatcher | null = null;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

async function rejectRedirect(response: Response): Promise<Response> {
  if (!REDIRECT_STATUSES.has(response.status)) return response;

  let cancellationError: unknown;
  try {
    await response.body?.cancel();
  } catch (error) {
    cancellationError = error;
  }
  throw new Error(
    `Upstream redirect blocked (status ${response.status})`,
    cancellationError === undefined ? undefined : { cause: cancellationError },
  );
}

/**
 * Byte-based queue for the Bun Node-HTTP bridge. Once this queue is full the
 * IncomingMessage is paused, which in turn bounds Node/socket buffering by its
 * own readable high-water mark. The bridge can transiently hold this amount
 * plus the single source chunk that crossed the threshold.
 */
const NODE_HTTP_BODY_QUEUE_BYTES = 64 * 1024;

/** Inject (or clear, with `null`) the upstream dispatcher. Tests only. */
export function setUpstreamDispatcherForTest(
  dispatcher: Dispatcher | null,
): void {
  dispatcherOverride = dispatcher;
}

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
 * Adapt a Node IncomingMessage to a backpressure-aware Web ReadableStream.
 * Exported so the Bun bridge lifecycle can be regression-tested without a live
 * socket; production callers should use {@link upstreamFetch}.
 */
export function nodeReadableToWebStream(
  res: http.IncomingMessage,
): ReadableStream<Uint8Array> {
  let active = true;
  let paused = false;
  let controller: ReadableStreamDefaultController<Uint8Array>;

  const cleanup = (): void => {
    res.removeListener("data", onData);
    res.removeListener("end", onEnd);
    res.removeListener("error", onError);
    res.removeListener("aborted", onAborted);
    res.removeListener("close", onClose);
  };

  const close = (): void => {
    if (!active) return;
    active = false;
    cleanup();
    try {
      controller.close();
    } catch {
      // The consumer may already have cancelled the Web stream.
    }
  };

  const fail = (error: Error, destroy = false): void => {
    if (!active) return;
    active = false;
    cleanup();
    if (destroy && !res.destroyed) res.destroy();
    try {
      controller.error(error);
    } catch {
      // The consumer may already have cancelled the Web stream.
    }
  };

  function onData(chunk: Buffer): void {
    if (!active) return;
    try {
      controller.enqueue(new Uint8Array(chunk));
      if ((controller.desiredSize ?? 0) <= 0 && !paused) {
        paused = true;
        res.pause();
      }
    } catch (error) {
      fail(
        error instanceof Error
          ? error
          : new Error("failed to enqueue upstream response body"),
        true,
      );
    }
  }

  function onEnd(): void {
    close();
  }

  function onError(error: Error): void {
    fail(error, true);
  }

  function onAborted(): void {
    fail(new Error("upstream response body aborted"), true);
  }

  function onClose(): void {
    if (res.complete || res.readableEnded) {
      close();
    } else {
      fail(new Error("upstream response closed before end"));
    }
  }

  return new ReadableStream<Uint8Array>(
    {
      start(streamController) {
        controller = streamController;
        res.on("data", onData);
        res.once("end", onEnd);
        res.once("error", onError);
        res.once("aborted", onAborted);
        res.once("close", onClose);
      },
      pull() {
        if (active && paused) {
          paused = false;
          res.resume();
        }
      },
      cancel() {
        if (!active) return;
        active = false;
        cleanup();
        if (!res.destroyed) {
          res.destroy();
        }
      },
    },
    new ByteLengthQueuingStrategy({
      highWaterMark: NODE_HTTP_BODY_QUEUE_BYTES,
    }),
  );
}

/**
 * Make an HTTP(S) request using Node's `node:https`/`node:http` modules and
 * return a standard Web API `Response` with a streaming `ReadableStream` body.
 *
 * Used under Bun where native `fetch` has a hardcoded ~5-min inactivity timeout
 * and by internal loopback probes, where WHATWG Fetch rejects valid listeners
 * on its browser-defined forbidden-port list. Bun's Node compat layer for
 * `node:https` does NOT have this timeout cap (verified on Bun 1.3.14: survives
 * 310s of total silence; native fetch TimeoutErrors at 300s). Also bypasses the
 * fetch interceptor (no `globalThis.fetch` involved).
 */
export function nodeHttpFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    if (init?.signal?.aborted) {
      reject(init.signal.reason);
      return;
    }
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    const isHttps = url.protocol === "https:";
    const mod = isHttps ? https : http;

    const headers: Record<string, string> = {};
    if (init?.headers) {
      // RequestInit headers can be HeadersInit (Headers, string[][], Record)
      if (init.headers instanceof Headers) {
        init.headers.forEach((v, k) => {
          headers[k] = v;
        });
      } else if (Array.isArray(init.headers)) {
        for (const [k, v] of init.headers) {
          headers[k] = v;
        }
      } else {
        Object.assign(headers, init.headers);
      }
    }

    const req = mod.request(
      url,
      {
        method: init?.method ?? "GET",
        headers,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(res.headers)) {
          if (value === undefined) continue;
          if (Array.isArray(value)) {
            for (const v of value) responseHeaders.append(key, v);
          } else {
            responseHeaders.set(key, value);
          }
        }

        // Pause the IncomingMessage whenever the Web stream's byte queue is
        // full; resume only from pull(). This prevents a slow worker parser from
        // turning the bridge into an unbounded second response buffer.
        const body = nodeReadableToWebStream(res);

        resolve(
          new Response(body, {
            status,
            statusText: res.statusMessage ?? "",
            headers: responseHeaders,
          }),
        );
      },
    );

    const onAbort = (): void => {
      const reason =
        init?.signal?.reason ?? new DOMException("Aborted", "AbortError");
      req.destroy(reason);
    };
    init?.signal?.addEventListener("abort", onAbort, { once: true });

    req.on("error", reject);
    req.on("close", () => {
      init?.signal?.removeEventListener("abort", onAbort);
    });

    if (init?.body) {
      req.write(init.body);
    }
    req.end();
  });
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
  const safeInit = { ...init, redirect: "manual" as const };

  if (isBun) {
    // Bun: use node:https which has no hardcoded timeout cap under Bun's Node
    // compat layer (verified: survives 310s silence; native fetch dies at 300s).
    // Also bypasses the fetch interceptor (no globalThis.fetch involved).
    const response = await nodeHttpFetch(input, safeInit);
    return rejectRedirect(response);
  }

  // Node: undici with disabled body/header timeouts. undici's fetch types
  // diverge from the global Web API types but are runtime-compatible — cast
  // through unknown to bridge the compile-time gap.
  const { fetch: undiciFetch, dispatcher } = await getUndici();
  const response = (await undiciFetch(
    input as Parameters<UndiciModule["fetch"]>[0],
    {
      ...safeInit,
      dispatcher: dispatcherOverride ?? dispatcher,
    } as Parameters<UndiciModule["fetch"]>[1],
  )) as unknown as Response;
  return rejectRedirect(response);
}
