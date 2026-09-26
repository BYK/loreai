/**
 * HTTP server for the Lore gateway proxy.
 *
 * Routes:
 *   POST /v1/messages            → Anthropic protocol
 *   POST /v1/chat/completions    → OpenAI Chat Completions protocol
 *   POST /v1/responses           → OpenAI Responses API protocol
 *   POST /v1/codex/responses     → Codex (ChatGPT) ingress (Responses format)
 *   POST /v1/responses/compact   → Codex compaction (Responses API)
 *   POST /v1/compact             → Explicit compaction summary (Pi plugin, etc.)
 *   POST /v1/model/{modelId}/{verb} → Bedrock Runtime API passthrough (Converse/InvokeModel)
 *   GET  /v1/models              → Passthrough to upstream
 *   GET  /health                 → Health check
 *
 * Routing and access policy live in the Hono app (`app.ts`); this module owns
 * process lifecycle and the `node:http` bridge: converting `IncomingMessage`
 * to a Web `Request`, streaming the Web `Response` back with backpressure and
 * abort propagation, socket tracking and bounded drain on shutdown. The same
 * Web-standard handlers run under both Bun and the Node.js npm distribution.
 */
import { createServer as createHttpServer } from "node:http";
import type { Server } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { Readable } from "node:stream";
import { GATEWAY_AUTH_HEADER, log } from "@loreai/core";
import {
  assertGatewayAccessConfigured,
  DEFAULT_PORT,
  type GatewayConfig,
} from "./config";
import { bootstrapDailySpend, getDailyBudget } from "./cost-tracker";
import {
  setupEmbeddingFailureCapture,
  setupBustSpiralCapture,
  setupReadPathTimingCapture,
  setupReadPoolTelemetryCapture,
  setupRecallContinuationFailureCapture,
  setupPrincipalTransportFailureCapture,
  setupPrincipalProtocolFailureCapture,
  setupVecReadLatencyCapture,
} from "./sentry";
import { cancelAndReleaseReader, readStreamChunk } from "./stream/anthropic";
import { SHUTDOWN_DEADLINE_MS } from "./shutdown-deadline";
import { createGatewayApp, responseCompletionCallbacks } from "./app";
import { responseAgainstAbort } from "./abort-race";
import {
  constantTimeTokenMatches,
  hasRawConflictingProviderAuth,
  singleRawHeaderValue,
} from "./management-access";
import { isDataPlanePath } from "./routes/registry";

export { handleForegroundBodyRoute, handleModelsPassthrough } from "./app";
export { isLoopbackAddress } from "./management-access";

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

// Socket drain is an inner stage of the process-wide shutdown. It must expire
// before the outer deadline so destroying a stalled/partial connection still
// leaves time to terminate workers and close SQLite cleanly.
const SERVER_DRAIN_DEADLINE_MS = Math.max(
  1,
  Math.floor(SHUTDOWN_DEADLINE_MS / 2),
);

export async function startServer(
  config: GatewayConfig,
  options: {
    controlToken?: string;
    /** Invoked asynchronously after an authenticated shutdown response flushes. */
    onShutdown?: () => void | Promise<void>;
    /** Focused lifecycle seam for exercising listener-close failures. */
    closeServer?: (server: Server) => Promise<void>;
    /** Focused lifecycle seam for bounded-drain regression tests. */
    shutdownDeadlineMs?: number;
    /** Focused access-control seam for simulating a socket peer in tests. */
    peerAddressForRequest?: (request: IncomingMessage) => string | undefined;
  } = {},
): Promise<{
  stop: (deadlineMs?: number) => Promise<void>;
  port: number;
  hosts: string[];
  /** Resolves when all bound servers are listening. */
  ready: Promise<void>;
}> {
  const closeBoundServer = (server: Server, deadlineMs?: number) =>
    options.closeServer?.(server) ??
    closeServer(
      server,
      options.shutdownDeadlineMs ?? deadlineMs ?? SERVER_DRAIN_DEADLINE_MS,
    );
  // Defensive defaults for public API consumers who may pass incomplete config.
  // loadConfig() always provides these, but startServer is a public export.
  config = config ?? ({} as GatewayConfig);
  if (!config.hosts?.length) {
    log.notice(
      `warning: config.hosts is empty or missing, defaulting to ["127.0.0.1"]. ` +
        `Use loadConfig() or startGateway() for a fully-populated config.`,
    );
    config = { ...config, hosts: ["127.0.0.1"] };
  }
  if (!Number.isFinite(config.port) || config.port < 0) {
    config = { ...config, port: DEFAULT_PORT };
  }
  assertGatewayAccessConfigured(config);
  if (config.allowRemoteManagement) {
    log.notice(
      "warning: remote management access is enabled; every client accepted by the listener can access /ui and /api",
    );
  }

  // Bootstrap the daily spend counter from DB (recovers today's spend after restart)
  if (getDailyBudget() > 0) {
    bootstrapDailySpend();
  }

  // Wire embedding-worker OOM backoff/latch events to Sentry. Idempotent: the
  // hook is assigned (not stacked), so a repeat startServer() is harmless.
  setupEmbeddingFailureCapture();

  // Wire cache-bust-spiral detection to Sentry (#797). Same idempotency
  // guarantee as the embedding hook above.
  setupBustSpiralCapture();

  // Wire read-path timing (forSession/recall) to Sentry (#966 B). Same
  // idempotency guarantee — the hook is assigned, not stacked.
  setupReadPathTimingCapture();
  setupReadPoolTelemetryCapture();

  // Wire vector KNN read-latency to Sentry (#1065 — confirm the vec0 win). Same
  // idempotency guarantee — the hook is assigned, not stacked.
  setupVecReadLatencyCapture();

  // Report only the allowlisted recall-continuation failure category. The
  // hook is assignment-based and never captures request or provider content.
  setupRecallContinuationFailureCapture();

  // Classify principal Responses body failures using fixed transport, stage,
  // and recovery outcomes only. No provider or request content is captured.
  setupPrincipalTransportFailureCapture();
  setupPrincipalProtocolFailureCapture();

  // Shared fetch handler for all server instances. Access policy and routing
  // live in the Hono app (`app.ts`); the bridge only supplies socket metadata.
  const app = createGatewayApp(config, options);
  const fetch = (
    req: Request,
    peerAddress: string | undefined,
    rawHeaders?: readonly string[],
  ): Promise<Response> =>
    Promise.resolve(app.fetch(req, { peerAddress, rawHeaders }));

  // Spawn one node:http server per host address. This allows binding to
  // specific interfaces (e.g. 127.0.0.1 + a Tailscale IP) without
  // opening to 0.0.0.0.
  //
  // Bind sequentially so the OS-assigned port (when config.port is 0)
  // is known before the second host binds — that way all hosts share
  // the same actual port. node:http's listen() is async, so we must
  // await each bind; Array#map can't await, hence the for-of loop.
  const servers: Server[] = [];
  const boundHosts: string[] = [];
  let resolvedPort = config.port;
  try {
    for (const host of config.hosts) {
      const s = createHttpServer((nodeReq, nodeRes) => {
        void handleNodeRequest(
          nodeReq,
          nodeRes,
          fetch,
          host,
          resolvedPort,
          options.peerAddressForRequest,
        );
      });
      trackServerSockets(s);
      // LLM streaming responses can be very long-lived — disable Node's
      // default timeouts (request/headers/keep-alive/socket) that would
      // otherwise kill idle streaming connections. 0 means "no timeout".
      s.requestTimeout = 0;
      s.headersTimeout = 0;
      s.keepAliveTimeout = 0;
      s.timeout = 0;
      // HTTP/1.1 Upgrade requests bypass the request handler entirely in
      // node:http — they're dispatched as a separate 'upgrade' event on the
      // server. The fetch handler's WS check never runs for these, so we
      // install a dedicated listener that writes a 426 + closes the socket.
      // Mirrors the `isWebSocketUpgrade` rejection in the fetch handler.
      s.on("upgrade", (req, socket) => {
        const pathname = new URL(req.url ?? "/", "http://gateway.local")
          .pathname;
        if (isDataPlanePath(pathname) && req.headers.origin !== undefined) {
          socket.end(
            "HTTP/1.1 403 Forbidden\r\n" +
              "Content-Length: 0\r\n" +
              "Connection: close\r\n" +
              "\r\n",
          );
          return;
        }
        if (isDataPlanePath(pathname)) {
          const accessHeader = singleRawHeaderValue(
            req.rawHeaders,
            GATEWAY_AUTH_HEADER,
          );
          const accessAllowed =
            !(config.remoteGateway || config.hostedMode) ||
            (typeof config.gatewayAuthToken === "string" &&
              accessHeader !== null &&
              constantTimeTokenMatches(accessHeader, config.gatewayAuthToken));
          if (!accessAllowed) {
            socket.end(
              "HTTP/1.1 401 Unauthorized\r\n" +
                "Content-Length: 0\r\n" +
                "Cache-Control: no-store\r\n" +
                "Connection: close\r\n" +
                "\r\n",
            );
            return;
          }
          if (hasRawConflictingProviderAuth(req.rawHeaders)) {
            const body = JSON.stringify({
              type: "error",
              error: {
                type: "invalid_request_error",
                message: "Conflicting provider authentication headers",
              },
            });
            socket.end(
              "HTTP/1.1 400 Bad Request\r\n" +
                "Content-Type: application/json\r\n" +
                `Content-Length: ${Buffer.byteLength(body)}\r\n` +
                "Cache-Control: no-store\r\n" +
                "Connection: close\r\n" +
                "\r\n" +
                body,
            );
            return;
          }
        }
        if (config.debug && !log.isStderrSilenced()) {
          console.error(
            `[lore] rejecting WebSocket upgrade for ${req.url ?? "/"} (HTTP-only gateway)`,
          );
        }
        const url = req.url ?? "/";
        const body = JSON.stringify({
          type: "error",
          error: {
            type: "websocket_not_supported",
            message: `WebSocket transport is not supported for ${url}; use HTTP.`,
          },
        });
        // `socket.end(data)` flushes the response, then signals EOF — the
        // client receives the 426 cleanly. Using `socket.destroy()` races
        // the response: undici/Bun fetch sees ECONNRESET before parsing the
        // body and the caller gets a network error instead of a 426.
        socket.end(
          "HTTP/1.1 426 Upgrade Required\r\n" +
            "Content-Type: application/json\r\n" +
            `Content-Length: ${Buffer.byteLength(body)}\r\n` +
            "Connection: close\r\n" +
            "\r\n" +
            body,
        );
      });

      const { ready } = bindServer(s, host, resolvedPort);
      // Wait for the first bind so we learn the OS-assigned port (when
      // resolvedPort started as 0). Subsequent hosts then bind to the
      // same port to share it.
      try {
        await ready;
      } catch (e) {
        // A configured host may not be assigned to any local interface right
        // now — e.g. a Tailscale/LAN IP from a tailnet you've left, or an
        // interface that hasn't come up yet at boot. Binding it fails with
        // EADDRNOTAVAIL (or EADDRNOTFOUND on some platforms). Such hosts are
        // OPTIONAL: skip them and keep binding the rest, so the gateway still
        // comes up on loopback. Real conflicts (EADDRINUSE) and any other
        // error still propagate to startGateway()'s port-fallback/reuse logic.
        if (isUnavailableAddressError(e)) {
          // Close this never-listening server to avoid leaking the handle.
          await closeBoundServer(s);
          // Always warn (not just in debug): silently degrading to loopback-only
          // when an explicitly-configured host is dropped is surprising, and the
          // event is low-frequency and actionable.
          log.notice(
            `configured host ${host} is unavailable (${addressErrorCode(e)}); skipping it and serving on the remaining hosts`,
          );
          continue;
        }
        throw e;
      }
      if (resolvedPort === 0) {
        const addr = s.address();
        if (addr && typeof addr === "object") {
          resolvedPort = addr.port;
        }
      }
      servers.push(s);
      boundHosts.push(host);
    }
  } catch (e) {
    // A later host failed to bind (e.g. EADDRINUSE) after earlier hosts
    // already bound — close the successfully-bound servers so we don't leak
    // file descriptors, then re-throw for startGateway() to handle.
    await Promise.all(servers.map((server) => closeBoundServer(server)));
    throw e;
  }

  // Every configured host was unavailable (nothing bound). That's a genuine
  // failure — surface it rather than returning a gateway that listens nowhere.
  if (servers.length === 0) {
    throw new Error(
      `Failed to bind: none of the configured hosts are available (${config.hosts.join(", ")}).`,
    );
  }

  // Collect all ready promises so startGateway() can await them.
  const readyPromises = servers
    .map((s) => serverReadyPromises.get(s))
    .filter((p): p is Promise<void> => p !== undefined);

  let stopPromise: Promise<void> | undefined;
  const result = {
    stop: (deadlineMs?: number): Promise<void> => {
      if (!stopPromise) {
        stopPromise = Promise.all(
          servers.map((server) => closeBoundServer(server, deadlineMs)),
        )
          .then(() => {})
          .catch((error: unknown) => {
            stopPromise = undefined;
            throw error;
          });
      }
      return stopPromise;
    },
    port: resolvedPort,
    // Report the hosts we actually bound (unavailable ones were skipped), so
    // callers and /health probes don't reference an interface that's down.
    hosts: boundHosts,
    ready: Promise.all(readyPromises).then(() => {}),
  };

  // Defensive: startServer() is async, so callers must use `await`.
  // If someone writes `const server = startServer(config)` (missing await),
  // `server` is a Promise — accessing .port/.hosts returns undefined,
  // producing cryptic errors like "Failed to parse URL from
  // http://127.0.0.1:undefined/health" (LOREAI-GATEWAY-1Z).
  // These property traps turn the silent undefined into a loud, actionable
  // error message. They're defined on the specific Promise instance, not
  // on Promise.prototype, so they only affect this call site.
  const promise = Promise.resolve(result);
  for (const prop of ["port", "hosts", "ready", "stop"] as const) {
    void Object.defineProperty(promise, prop, {
      get() {
        throw new TypeError(
          `startServer() is async — use \`const server = await startServer(config)\` ` +
            `before accessing .${prop}`,
        );
      },
      configurable: true,
    });
  }

  return promise;
}

const serverSockets = new WeakMap<Server, Set<Socket>>();

function trackServerSockets(server: Server): void {
  const sockets = new Set<Socket>();
  serverSockets.set(server, sockets);
  server.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
}

/**
 * Stop accepting work, drain established requests, then destroy any sockets
 * that still prevent `server.close()` from settling (including partial HTTP
 * headers that never become an IncomingMessage).
 */
function closeServer(server: Server, deadlineMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      // Node's helpers cover parsed HTTP connections; explicit tracking also
      // covers sockets still stalled in the HTTP parser and upgraded sockets.
      server.closeIdleConnections();
      server.closeAllConnections();
      for (const socket of serverSockets.get(server) ?? []) socket.destroy();
    }, deadlineMs);
    server.close((error) => {
      clearTimeout(timer);
      if (
        !error ||
        (error as NodeJS.ErrnoException).code === "ERR_SERVER_NOT_RUNNING"
      ) {
        resolve();
      } else {
        reject(error);
      }
    });
  });
}

/**
 * Extract the errno code (e.g. "EADDRINUSE", "EADDRNOTAVAIL") from a Node
 * socket error, if present.
 */
function addressErrorCode(err: unknown): string | undefined {
  if (err && typeof err === "object" && "code" in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

/**
 * True when a bind failed because the address isn't assigned to any local
 * interface (so the host is absent/optional), as opposed to a real conflict
 * (EADDRINUSE) or permission error. EADDRNOTAVAIL is the common case;
 * EADDRNOTFOUND appears on some platforms for unresolvable hosts.
 */
function isUnavailableAddressError(err: unknown): boolean {
  const code = addressErrorCode(err);
  return code === "EADDRNOTAVAIL" || code === "EADDRNOTFOUND";
}

// ---------------------------------------------------------------------------
// node:http ↔ Web Request/Response bridge
// ---------------------------------------------------------------------------

/**
 * Per-server `ready` promise map. Each entry resolves when its server has
 * successfully called `listen()` (or rejects on bind errors like EADDRINUSE).
 * Used by startServer() to surface the async bind to callers.
 */
const serverReadyPromises = new WeakMap<Server, Promise<void>>();

/**
 * Bind a server to `host:port` and stash a `ready` promise on it.
 *
 * Node's `server.listen()` is async: `EADDRINUSE` is emitted as an `'error'`
 * event, not thrown synchronously. The returned `ready` promise resolves on
 * the `'listening'` event and rejects on the first `'error'` event.
 *
 * We eagerly attach the listener before calling `listen()` so a synchronous
 * error (e.g. invalid host) doesn't slip through.
 */
function bindServer(
  server: Server,
  host: string,
  port: number,
): { ready: Promise<void> } {
  const ready = new Promise<void>((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", (err) => reject(err));
  });
  // Suppress UnhandledPromiseRejection if no one awaits `ready` — the real
  // error surfaces when startGateway() awaits it.
  ready.catch(() => {});
  serverReadyPromises.set(server, ready);
  server.listen(port, host);
  return { ready };
}

/**
 * Bracket an IPv6 host literal so it can be safely interpolated into a URL
 * (e.g. `[::1]`, not `::1`). A bare `:` marks an IPv6 address (hostnames and
 * IPv4 never contain one); an already-bracketed value is left untouched.
 *
 * Shared by the request path (`handleNodeRequest` below) and the probe path
 * (`probeUrlFor` in cli/start.ts) so the two never diverge — see issue #907.
 */
export function bracketHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

export function bindNodeIngressAbort(
  nodeReq: IncomingMessage,
  nodeRes: ServerResponse,
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const abort = (reason: unknown): void => {
    if (!controller.signal.aborted) controller.abort(reason);
  };
  const onRequestAborted = (): void =>
    abort(
      new DOMException(
        "client disconnected before the request body was completely received",
        "AbortError",
      ),
    );
  const onRequestClose = (): void => {
    if (!nodeReq.complete) onRequestAborted();
  };
  const onRequestError = (error: Error): void => {
    const detail =
      error.message === "Parse Error"
        ? "HTTP parser rejected an incomplete or malformed request body (Parse Error)"
        : `request transport failed while reading the body (${error.message})`;
    abort(
      new DOMException(
        `client request could not be read: ${detail}`,
        "AbortError",
      ),
    );
  };
  const onResponseClose = (): void => {
    if (!nodeRes.writableEnded) {
      abort(new DOMException("client response closed", "AbortError"));
    }
  };
  const onResponseError = (error: Error): void =>
    abort(
      new DOMException(
        `client response could not be written: ${error.message}`,
        "AbortError",
      ),
    );
  const onSocketClose = (): void => {
    if (!nodeRes.writableEnded) {
      abort(new DOMException("client socket closed", "AbortError"));
    }
  };
  const onSocketError = (error: Error): void =>
    abort(
      new DOMException(
        `client socket transport failed: ${error.message}`,
        "AbortError",
      ),
    );
  const socket = nodeReq.socket;
  nodeReq.on("aborted", onRequestAborted);
  nodeReq.on("close", onRequestClose);
  nodeReq.on("error", onRequestError);
  nodeRes.on("close", onResponseClose);
  nodeRes.on("error", onResponseError);
  socket.on("close", onSocketClose);
  socket.on("error", onSocketError);
  return {
    signal: controller.signal,
    cleanup: () => {
      nodeReq.removeListener("aborted", onRequestAborted);
      nodeReq.removeListener("close", onRequestClose);
      nodeReq.removeListener("error", onRequestError);
      nodeRes.removeListener("close", onResponseClose);
      nodeRes.removeListener("error", onResponseError);
      socket.removeListener("close", onSocketClose);
      socket.removeListener("error", onSocketError);
    },
  };
}

export function waitForNodeResponseDrain(
  nodeRes: ServerResponse,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      nodeRes.removeListener("drain", onDrain);
      signal.removeEventListener("abort", onAbort);
    };
    const finish = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      operation();
    };
    const onDrain = (): void => finish(resolve);
    const onAbort = (): void => finish(() => reject(signal.reason));
    nodeRes.on("drain", onDrain);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

export function waitForNodeResponseCompletion(
  nodeRes: ServerResponse,
  signal: AbortSignal,
): Promise<void> {
  if (nodeRes.writableFinished || nodeRes.destroyed) return Promise.resolve();
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      nodeRes.removeListener("finish", onFinish);
      nodeRes.removeListener("close", onClose);
      signal.removeEventListener("abort", onAbort);
    };
    const finish = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      operation();
    };
    const onFinish = (): void => finish(resolve);
    const onClose = (): void => finish(resolve);
    const onAbort = (): void => finish(() => reject(signal.reason));
    nodeRes.on("finish", onFinish);
    nodeRes.on("close", onClose);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

/**
 * Convert a node:http `IncomingMessage` to a Web `Request`, run the shared
 * `fetch` handler, and stream the resulting Web `Response` back over the
 * node:http `ServerResponse`.
 *
 * Mirrors what `Bun.serve()` gave us under Bun: handler returns a Web
 * `Response` (streaming or buffered), we write the status + headers, then
 * pipe the body chunk-by-chunk to keep long-lived SSE streams alive.
 */
export async function handleNodeRequest(
  nodeReq: IncomingMessage,
  nodeRes: ServerResponse,
  fetch: (
    req: Request,
    peerAddress: string | undefined,
    rawHeaders?: readonly string[],
  ) => Response | Promise<Response>,
  host: string,
  port: number,
  peerAddressForRequest?: (request: IncomingMessage) => string | undefined,
): Promise<void> {
  const ingressAbort = bindNodeIngressAbort(nodeReq, nodeRes);
  let responseStarted = false;
  let responseCompleted = false;
  try {
    const url = `http://${bracketHost(host)}:${port}${nodeReq.url ?? "/"}`;

    const body =
      nodeReq.method === "GET" || nodeReq.method === "HEAD"
        ? null
        : (Readable.toWeb(nodeReq) as unknown as ReadableStream);

    const req = new Request(url, {
      method: nodeReq.method,
      headers: nodeReq.headers as Record<string, string>,
      body,
      signal: ingressAbort.signal,
      // @ts-expect-error — required for Node.js request body streaming
      duplex: "half",
    });

    const response = await responseAgainstAbort(
      () =>
        Promise.resolve(
          fetch(
            req,
            peerAddressForRequest
              ? peerAddressForRequest(nodeReq)
              : nodeReq.socket.remoteAddress,
            nodeReq.rawHeaders,
          ),
        ),
      ingressAbort.signal,
    );

    const headerEntries: [string, string][] = [];
    response.headers.forEach((value, key) => {
      headerEntries.push([key, value]);
    });
    nodeRes.writeHead(response.status, Object.fromEntries(headerEntries));
    responseStarted = true;

    if (response.body) {
      const reader = response.body.getReader();
      try {
        while (true) {
          const { done, value } = await readStreamChunk(reader, {
            signal: ingressAbort.signal,
          });
          if (done) break;
          // Coerce SharedArrayBuffer-typed Uint8Array views to a regular
          // Buffer — Node's write() expects a string, Buffer, or
          // Uint8Array<ArrayBuffer>, not ArrayBufferLike.
          const canContinue = nodeRes.write(
            Buffer.from(value.buffer, value.byteOffset, value.byteLength),
          );
          if (!canContinue) {
            await waitForNodeResponseDrain(nodeRes, ingressAbort.signal);
          }
        }
      } finally {
        cancelAndReleaseReader(reader, ingressAbort.signal.reason);
      }
    }
    if (!nodeRes.destroyed) {
      const completed = waitForNodeResponseCompletion(
        nodeRes,
        ingressAbort.signal,
      );
      nodeRes.end();
      await completed;
      responseCompleted = true;
    }
    if (responseCompleted) {
      const onResponseComplete = responseCompletionCallbacks.get(response);
      if (onResponseComplete) setImmediate(onResponseComplete);
    }
  } catch (err) {
    if (!ingressAbort.signal.aborted) log.error("request handler error:", err);
    if (
      !responseStarted &&
      !nodeRes.headersSent &&
      !nodeRes.destroyed &&
      !ingressAbort.signal.aborted
    ) {
      try {
        const completed = waitForNodeResponseCompletion(
          nodeRes,
          ingressAbort.signal,
        );
        nodeRes.writeHead(500, { "content-type": "application/json" });
        nodeRes.end(JSON.stringify({ error: "Internal server error" }));
        await completed;
      } catch {
        if (!nodeRes.destroyed) nodeRes.destroy();
      }
    } else if (!nodeRes.destroyed) {
      nodeRes.destroy();
    }
  } finally {
    ingressAbort.cleanup();
  }
}
