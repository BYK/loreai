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
 *   GET  /v1/models              → Passthrough to upstream
 *   GET  /health                 → Health check
 *
 * Uses `node:http` `createServer` with Web `Request`/`Response` — the same
 * code runs under both Bun and the Node.js npm distribution.
 */
import { createServer as createHttpServer } from "node:http";
import type { Server } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { log } from "@loreai/core";
import { DEFAULT_PORT, type GatewayConfig } from "./config";
import { bootstrapDailySpend, getDailyBudget } from "./cost-tracker";
import {
  setupEmbeddingFailureCapture,
  setupBustSpiralCapture,
  setupReadPathTimingCapture,
  setupVecReadLatencyCapture,
} from "./sentry";
import type { GatewayRequest } from "./translate/types";
import { parseAnthropicRequest } from "./translate/anthropic";
import { parseOpenAIRequest } from "./translate/openai";
import { parseGeminiRequest } from "./translate/gemini";
import {
  parseOpenAICodexRequest,
  parseOpenAIResponsesRequest,
} from "./translate/openai-responses";
import {
  handleRequest,
  handleCompactEndpoint,
  handleResponsesCompactEndpoint,
} from "./pipeline";
import { upstreamFetch } from "./fetch";
import { decodeRequestBody } from "./http-body";

// ---------------------------------------------------------------------------
// Version — best-effort from package.json, falls back gracefully
// ---------------------------------------------------------------------------

let version = "unknown";
try {
  // Bare require() is statically resolved by esbuild at CJS bundle time and
  // provided by tsx/bun in the ESM source — same pattern as cli/version.ts.
  const pkg = require("../package.json") as { version?: string };
  if (pkg.version) version = pkg.version;
} catch {
  // Not critical — health endpoint will report "unknown"
}

// ---------------------------------------------------------------------------
// CORS headers — permissive for localhost development
// ---------------------------------------------------------------------------

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-allow-headers": "*",
  "access-control-max-age": "86400",
};

function withCors(response: Response): Response {
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    response.headers.set(key, value);
  }
  return response;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert a Web Headers object to a plain Record<string, string>. */
function headersToRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    record[key] = value;
  });
  return record;
}

function jsonResponse(body: unknown, status = 200): Response {
  return withCors(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

function errorResponse(
  status: number,
  type: string,
  message: string,
): Response {
  return jsonResponse(
    {
      type: "error",
      error: { type, message },
    },
    status,
  );
}

/**
 * Detect a WebSocket upgrade request.
 *
 * Clients like Codex (OpenAI Responses API) optimistically try to open a
 * WebSocket to the endpoint (e.g. `ws://host/v1/responses`) before falling
 * back to HTTP. The lore gateway is a translating HTTP proxy — it buffers and
 * transforms full request/response bodies and forwards them over HTTP to the
 * upstream — so it does not (and cannot meaningfully) speak WebSocket here.
 *
 * A WS upgrade arrives as a GET with `Upgrade: websocket` + `Connection`
 * containing `upgrade` (per RFC 6455). We detect it explicitly so we can
 * return a definitive "not supported" response instead of a misleading
 * `404 No route for GET /v1/responses`, which made it look like the endpoint
 * was missing and produced repeated upgrade attempts in the client logs.
 */
function isWebSocketUpgrade(req: Request): boolean {
  const upgrade = req.headers.get("upgrade");
  if (upgrade?.toLowerCase() !== "websocket") return false;
  const connection = req.headers.get("connection");
  // Connection may be a comma-separated list (e.g. "keep-alive, Upgrade").
  return !!connection && connection.toLowerCase().includes("upgrade");
}

/**
 * Reject a WebSocket upgrade cleanly so the client falls back to HTTP on the
 * first attempt. `426 Upgrade Required` is the closest semantic fit ("this
 * resource is served over a different protocol"); `Connection: close` tells the
 * client not to keep retrying on the same socket.
 */
function rejectWebSocketUpgrade(pathname: string): Response {
  const resp = errorResponse(
    426,
    "websocket_not_supported",
    `WebSocket transport is not supported for ${pathname}; use HTTP.`,
  );
  resp.headers.set("Connection", "close");
  return resp;
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

async function handleAnthropicMessages(
  req: Request,
  config: GatewayConfig,
): Promise<Response> {
  let body: unknown;
  try {
    // Transparently decode any Content-Encoding (Codex sends zstd by default)
    // before JSON-parsing — raw compressed bytes would otherwise fail to parse.
    body = JSON.parse(await decodeRequestBody(req));
  } catch {
    return errorResponse(400, "invalid_request_error", "Invalid JSON body");
  }

  let gatewayReq: GatewayRequest;
  try {
    gatewayReq = parseAnthropicRequest(body, headersToRecord(req.headers));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to parse request";
    return errorResponse(400, "invalid_request_error", msg);
  }

  try {
    const result = await handleRequest(gatewayReq, config);
    // Pipeline returns a Response directly (streaming or non-streaming)
    return withCors(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Pipeline error";
    log.error(`pipeline error: ${msg}`);
    return errorResponse(502, "api_error", `Gateway pipeline error: ${msg}`);
  }
}

// NOTE: This endpoint only supports the Anthropic upstream. OpenAI clients
// calling GET /v1/models will have their request forwarded to Anthropic,
// which will likely reject the OpenAI API key. A proper fix would route
// based on auth header type, but that's a separate enhancement.
async function handleModelsPassthrough(
  req: Request,
  config: GatewayConfig,
): Promise<Response> {
  try {
    // Forward auth headers from the original request so upstream
    // providers that require authentication don't reject with 401.
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    const apiKey = req.headers.get("x-api-key");
    const auth = req.headers.get("authorization");
    if (apiKey) headers["x-api-key"] = apiKey;
    if (auth) headers.authorization = auth;
    // Anthropic requires the version header
    const anthropicVersion = req.headers.get("anthropic-version");
    if (anthropicVersion) headers["anthropic-version"] = anthropicVersion;
    // Apply user-supplied LORE_UPSTREAM_EXTRA_HEADERS (corporate proxies,
    // Cloudflare AI Gateway auth, etc.) as a final overlay.
    for (const [key, value] of Object.entries(config.upstreamExtraHeaders)) {
      headers[key] = value;
    }

    const upstream = await upstreamFetch(
      `${config.upstreamAnthropic}/v1/models`,
      {
        headers,
      },
    );
    // Clone to a new Response so we can append CORS headers
    const response = new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: new Headers(upstream.headers),
    });
    return withCors(response);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Upstream unreachable";
    return errorResponse(502, "api_error", `Failed to fetch models: ${msg}`);
  }
}

function handleHealth(): Response {
  return jsonResponse({ status: "ok", version });
}

async function handleOpenAIChatCompletions(
  req: Request,
  config: GatewayConfig,
): Promise<Response> {
  let body: unknown;
  try {
    // Transparently decode any Content-Encoding (Codex sends zstd by default)
    // before JSON-parsing — raw compressed bytes would otherwise fail to parse.
    body = JSON.parse(await decodeRequestBody(req));
  } catch {
    return errorResponse(400, "invalid_request_error", "Invalid JSON body");
  }

  let gatewayReq: GatewayRequest;
  try {
    gatewayReq = parseOpenAIRequest(body, headersToRecord(req.headers));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to parse request";
    return errorResponse(400, "invalid_request_error", msg);
  }

  try {
    // Pipeline returns the response in the client's native wire format
    // (OpenAI Chat Completions JSON or SSE), so no server-side translation
    // is needed. This prevents the class of bugs where the stream flag is
    // forgotten during format conversion.
    return withCors(await handleRequest(gatewayReq, config));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Pipeline error";
    log.error(`pipeline error: ${msg}`);
    return errorResponse(502, "api_error", `Gateway pipeline error: ${msg}`);
  }
}

/**
 * Matches a native Gemini `generateContent` endpoint path, capturing the model
 * id and the verb. Version-prefix-agnostic (`/v1beta/models/...`,
 * `/v1/models/...`, or bare `/models/...`) so both the Gemini CLI
 * (`GOOGLE_GEMINI_BASE_URL` → `/v1beta/...`) and `@ai-sdk/google` (baseURL
 * pinned to `${gateway}/v1` → `/v1/...`) are matched.
 */
const GEMINI_PATH_RE =
  /\/models\/([^/:]+):(generateContent|streamGenerateContent)$/;

async function handleGeminiGenerateContent(
  req: Request,
  config: GatewayConfig,
  model: string,
  stream: boolean,
): Promise<Response> {
  let body: unknown;
  try {
    body = JSON.parse(await decodeRequestBody(req));
  } catch {
    return errorResponse(400, "invalid_request_error", "Invalid JSON body");
  }

  // headersToRecord lowercases every key (Web Headers API), so `x-goog-api-key`
  // is the only case that can be present here.
  const headers = headersToRecord(req.headers);
  // Normalize `?key=` query-form auth (REST / google-generativeai clients) to
  // the `x-goog-api-key` header — the upstream URL is rebuilt, so a query param
  // would otherwise be dropped and the call would 401. Header form wins.
  if (!headers["x-goog-api-key"]) {
    const key = new URL(req.url).searchParams.get("key");
    if (key) headers["x-goog-api-key"] = key;
  }

  let gatewayReq: GatewayRequest;
  try {
    gatewayReq = parseGeminiRequest(body, headers, model, stream);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to parse request";
    return errorResponse(400, "invalid_request_error", msg);
  }

  try {
    // Pipeline returns the response in the client's native Gemini wire format
    // (generateContent JSON or streamGenerateContent SSE).
    return withCors(await handleRequest(gatewayReq, config));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Pipeline error";
    log.error(`pipeline error: ${msg}`);
    return errorResponse(502, "api_error", `Gateway pipeline error: ${msg}`);
  }
}

async function handleOpenAIResponses(
  req: Request,
  config: GatewayConfig,
): Promise<Response> {
  let body: unknown;
  try {
    // Transparently decode any Content-Encoding (Codex sends zstd by default)
    // before JSON-parsing — raw compressed bytes would otherwise fail to parse.
    body = JSON.parse(await decodeRequestBody(req));
  } catch {
    return errorResponse(400, "invalid_request_error", "Invalid JSON body");
  }

  let gatewayReq: GatewayRequest;
  try {
    gatewayReq = parseOpenAIResponsesRequest(
      body,
      headersToRecord(req.headers),
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to parse request";
    return errorResponse(400, "invalid_request_error", msg);
  }

  try {
    // Pipeline returns the response in the client's native wire format
    // (OpenAI Responses API JSON or SSE), so no server-side translation
    // is needed.
    return withCors(await handleRequest(gatewayReq, config));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Pipeline error";
    log.error(`pipeline error: ${msg}`);
    return errorResponse(502, "api_error", `Gateway pipeline error: ${msg}`);
  }
}

/**
 * Codex (ChatGPT) ingress — `POST /v1/codex/responses`. Pi's `openai-codex`
 * provider appends `/codex/responses` to the registered gateway baseUrl. The
 * wire format is the OpenAI Responses API; we flag the request as Codex so the
 * upstream is routed to `/backend-api/codex/responses` and Codex control fields
 * (`store: false`, `include`, …) are preserved.
 */
async function handleOpenAICodexResponses(
  req: Request,
  config: GatewayConfig,
): Promise<Response> {
  let body: unknown;
  try {
    // Transparently decode any Content-Encoding (Codex sends zstd by default)
    // before JSON-parsing — raw compressed bytes would otherwise fail to parse.
    body = JSON.parse(await decodeRequestBody(req));
  } catch {
    return errorResponse(400, "invalid_request_error", "Invalid JSON body");
  }

  let gatewayReq: GatewayRequest;
  try {
    gatewayReq = parseOpenAICodexRequest(body, headersToRecord(req.headers));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to parse request";
    return errorResponse(400, "invalid_request_error", msg);
  }

  try {
    return withCors(await handleRequest(gatewayReq, config));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Pipeline error";
    log.error(`pipeline error: ${msg}`);
    return errorResponse(502, "api_error", `Gateway pipeline error: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export async function startServer(config: GatewayConfig): Promise<{
  stop: () => void;
  port: number;
  hosts: string[];
  /** Resolves when all bound servers are listening. */
  ready: Promise<void>;
}> {
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

  // Wire vector KNN read-latency to Sentry (#1065 — confirm the vec0 win). Same
  // idempotency guarantee — the hook is assigned, not stacked.
  setupVecReadLatencyCapture();

  // Shared fetch handler for all server instances.
  const fetch = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const { pathname } = url;
    const method = req.method;

    // CORS preflight
    if (method === "OPTIONS") {
      return withCors(new Response(null, { status: 204 }));
    }

    if (config.debug && !log.isStderrSilenced()) {
      console.error(`[lore] ${method} ${pathname}`);
    }

    // Clients (e.g. Codex) optimistically try a WebSocket upgrade before
    // falling back to HTTP. The gateway is HTTP-only, so reject the upgrade
    // definitively rather than returning a misleading 404 (which caused
    // repeated upgrade attempts and noisy logs).
    if (isWebSocketUpgrade(req)) {
      if (config.debug && !log.isStderrSilenced()) {
        console.error(
          `[lore] rejecting WebSocket upgrade for ${pathname} (HTTP-only gateway)`,
        );
      }
      return withCors(rejectWebSocketUpgrade(pathname));
    }

    try {
      // POST /v1/messages — Anthropic protocol
      if (method === "POST" && pathname === "/v1/messages") {
        return await handleAnthropicMessages(req, config);
      }

      // POST /v1/chat/completions — OpenAI protocol.
      // The bare `/chat/completions` (no /v1) form is accepted too: GitHub
      // Copilot CLI redirected via COPILOT_API_URL posts to the origin's bare
      // path (its API omits the /v1 segment, like api.githubcopilot.com).
      if (
        method === "POST" &&
        (pathname === "/v1/chat/completions" ||
          pathname === "/chat/completions")
      ) {
        return await handleOpenAIChatCompletions(req, config);
      }

      // POST /v1beta/models/{model}:generateContent (or :streamGenerateContent)
      // — native Google Gemini protocol. Version-prefix-agnostic (see
      // GEMINI_PATH_RE) so the Gemini CLI and @ai-sdk/google both match.
      if (method === "POST") {
        const gm = pathname.match(GEMINI_PATH_RE);
        if (gm) {
          return await handleGeminiGenerateContent(
            req,
            config,
            gm[1],
            gm[2] === "streamGenerateContent",
          );
        }
      }

      // POST /v1/responses/compact — Codex compaction (Responses API)
      if (method === "POST" && pathname === "/v1/responses/compact") {
        return withCors(await handleResponsesCompactEndpoint(req, config));
      }

      // POST /v1/codex/responses — Codex (ChatGPT) ingress (Responses format)
      if (method === "POST" && pathname === "/v1/codex/responses") {
        return await handleOpenAICodexResponses(req, config);
      }

      // POST /v1/responses — OpenAI Responses API protocol.
      // NOTE: the bare `/responses` (no /v1) form used by GitHub Copilot CLI's
      // Responses wire API (GPT-5 series) is intentionally NOT accepted yet — the
      // responses upstream builder emits `${base}/v1/responses`, which would 404
      // against api.githubcopilot.com (its endpoints omit /v1). Wiring that needs
      // a host-aware responses path (like buildOpenAIChatCompletionsUrl) first.
      if (method === "POST" && pathname === "/v1/responses") {
        return await handleOpenAIResponses(req, config);
      }

      // POST /v1/compact — explicit compaction summary (Pi plugin, etc.)
      if (method === "POST" && pathname === "/v1/compact") {
        return withCors(await handleCompactEndpoint(req, config));
      }

      // GET /v1/models — passthrough
      if (method === "GET" && pathname === "/v1/models") {
        return await handleModelsPassthrough(req, config);
      }

      // GET /health — health check
      if (method === "GET" && pathname === "/health") {
        return handleHealth();
      }

      // GET/POST/DELETE /api/* — REST API (lazy-imported to keep proxy hot path fast)
      if (pathname.startsWith("/api/")) {
        const { handleAPIRequest } = await import("./api");
        return withCors(await handleAPIRequest(req, url, config));
      }

      // GET/POST /ui/* — Web dashboard (lazy-imported to keep proxy hot path fast)
      // Wrapped in a 30-second timeout as a safety net for async hangs (e.g.,
      // slow module import, embedding dedup on entities page). Note: this does
      // NOT protect against synchronous SQLite blocking — the timer callback
      // can't fire while sync queries hold the event loop. The real fix for
      // query performance is the bulk-query optimization in data.ts / cost-tracker.ts.
      if (pathname === "/ui" || pathname.startsWith("/ui/")) {
        const { handleUIRequest } = await import("./ui");
        const uiPromise = handleUIRequest(req, url);
        const timeoutPromise = new Promise<Response>((resolve) =>
          setTimeout(
            () =>
              resolve(
                new Response(
                  "<h1>Page render timed out</h1><p>The page took too long to generate. Try again — results may be cached now.</p><p><a href='/ui'>Back to dashboard</a></p>",
                  {
                    status: 504,
                    headers: { "content-type": "text/html; charset=utf-8" },
                  },
                ),
              ),
            30_000,
          ),
        );
        return withCors(await Promise.race([uiPromise, timeoutPromise]));
      }

      // GET / — redirect to dashboard. Build the redirect manually instead of
      // via Response.redirect(), whose headers are immutable: withCors() would
      // throw "immutable" while adding CORS headers and the root path would 500
      // instead of redirecting.
      if (method === "GET" && pathname === "/") {
        return withCors(
          new Response(null, {
            status: 302,
            headers: { location: new URL("/ui", url).toString() },
          }),
        );
      }

      // 404 for everything else
      return errorResponse(
        404,
        "not_found",
        `No route for ${method} ${pathname}`,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Internal server error";
      log.error(`uncaught error: ${msg}`);
      return errorResponse(500, "api_error", msg);
    }
  };

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
      const s = createHttpServer(async (nodeReq, nodeRes) => {
        await handleNodeRequest(nodeReq, nodeRes, fetch, host, resolvedPort);
      });
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
            "Access-Control-Allow-Origin: *\r\n" +
            "Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS\r\n" +
            "Access-Control-Allow-Headers: *\r\n" +
            "Access-Control-Max-Age: 86400\r\n" +
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
          s.close();
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
    for (const s of servers) s.close();
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

  const result = {
    stop: () => {
      for (const s of servers) s.close();
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
    Object.defineProperty(promise, prop, {
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

/**
 * Convert a node:http `IncomingMessage` to a Web `Request`, run the shared
 * `fetch` handler, and stream the resulting Web `Response` back over the
 * node:http `ServerResponse`.
 *
 * Mirrors what `Bun.serve()` gave us under Bun: handler returns a Web
 * `Response` (streaming or buffered), we write the status + headers, then
 * pipe the body chunk-by-chunk to keep long-lived SSE streams alive.
 */
async function handleNodeRequest(
  nodeReq: IncomingMessage,
  nodeRes: ServerResponse,
  fetch: (req: Request) => Response | Promise<Response>,
  host: string,
  port: number,
): Promise<void> {
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
      // @ts-expect-error — required for Node.js request body streaming
      duplex: "half",
    });

    const response = await fetch(req);

    const headerEntries: [string, string][] = [];
    response.headers.forEach((value, key) => {
      headerEntries.push([key, value]);
    });
    nodeRes.writeHead(response.status, Object.fromEntries(headerEntries));

    if (response.body) {
      const reader = response.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          // Coerce SharedArrayBuffer-typed Uint8Array views to a regular
          // Buffer — Node's write() expects a string, Buffer, or
          // Uint8Array<ArrayBuffer>, not ArrayBufferLike.
          nodeRes.write(
            Buffer.from(value.buffer, value.byteOffset, value.byteLength),
          );
        }
      } finally {
        reader.releaseLock();
      }
    }
    nodeRes.end();
  } catch (err) {
    log.error("request handler error:", err);
    if (!nodeRes.headersSent) {
      nodeRes.writeHead(500, { "content-type": "application/json" });
    }
    nodeRes.end(JSON.stringify({ error: "Internal server error" }));
  }
}
