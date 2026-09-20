/**
 * Hono application for the Lore gateway.
 *
 * Routes:
 *   POST /v1/messages            → Anthropic protocol
 *   POST /v1/chat/completions    → OpenAI Chat Completions protocol
 *   POST /v1/responses           → OpenAI Responses API protocol
 *   POST /v1/codex/responses     → Codex (ChatGPT) ingress (Responses format)
 *   POST /v1/responses/compact   → Codex compaction (Responses API)
 *   POST /v1/compact             → Explicit compaction summary (Pi plugin, etc.)
 *   POST /v1/model/{modelId}/{verb} → Bedrock Runtime API passthrough (Converse/InvokeModel)
 *   POST .../models/{model}:generateContent → Google Gemini protocol
 *   GET  /v1/models              → Passthrough to upstream
 *   GET  /health                 → Health check
 *   *    /api/*                  → Management REST API (`api.ts`)
 *   *    /ui, /ui/*              → Lore UI single-page app (`ui-static.ts`)
 *   GET  /                       → Redirect to /ui
 *
 * Every handler works on Web `Request`/`Response`; the node:http bridge in
 * `server.ts` supplies the socket peer address and raw header list as Hono
 * bindings (`app.fetch(request, env)`). Access policy runs as middleware
 * before any route — including `/ui` static, `/health` and unknown paths.
 */
import { timingSafeEqual } from "node:crypto";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { embedding, log } from "@loreai/core";
import { extraHeadersForUpstream, type GatewayConfig } from "./config";
import { workerHealthSummary } from "./worker-health";
import { VERSION } from "./cli/version";
import type { GatewayRequest } from "./translate/types";
import { applyUpstreamExtraHeaders } from "./translate/types";
import { copyProviderAuthHeaders, hasConflictingAuthHeaders } from "./auth";
import { parseAnthropicRequest } from "./translate/anthropic";
import { parseOpenAIRequest } from "./translate/openai";
import { parseGeminiRequest } from "./translate/gemini";
import {
  parseOpenAICodexRequestChunks,
  parseOpenAIResponsesRequestChunks,
} from "./translate/openai-responses";
import {
  handleRequest,
  handleCompactEndpoint,
  handleResponsesCompactEndpoint,
  createForegroundAbortScope,
  wrapBodyWithCleanup,
} from "./pipeline";
import { upstreamFetch } from "./fetch";
import { responseAgainstAbort } from "./abort-race";
import { decodeRequestBody, decodedRequestChunks } from "./http-body";
import {
  BEDROCK_RUNTIME_PATH_RE,
  proxyBedrockRuntimeRequest,
} from "./translate/bedrock-runtime";
import {
  browserOriginDeniedResponse,
  closingErrorResponse,
  conflictingProviderAuthResponse,
  errorResponse,
  errorResponseWithoutCors,
  gatewayAccessDeniedResponse,
  gatewayAccessMatches,
  GEMINI_PATH_RE,
  hasRawConflictingProviderAuth,
  headersToRecord,
  hiddenManagementResponse,
  isDataPlanePath,
  isLoopbackAddress,
  isManagementPath,
  jsonResponse,
  managementCorsOrigin,
  withManagementCors,
  withoutCors,
  withoutGatewayAccessHeader,
} from "./management-access";

// ---------------------------------------------------------------------------
// Hono environment
// ---------------------------------------------------------------------------

/** Socket metadata the node:http bridge passes as Hono bindings. */
export interface GatewayRequestEnv {
  /** Numeric socket peer address; never derived from client headers. */
  peerAddress: string | undefined;
  /** node:http `rawHeaders` — needed to detect duplicate credential headers. */
  rawHeaders?: readonly string[];
}

interface GatewayVariables {
  /** The request handlers must use (access credential already stripped). */
  request: Request;
  managementPath: boolean;
  allowedManagementOrigin: string | null;
}

export type GatewayEnv = {
  Bindings: GatewayRequestEnv;
  Variables: GatewayVariables;
};

type GatewayContext = Context<GatewayEnv>;
type GatewayMiddleware = MiddlewareHandler<GatewayEnv>;

export interface GatewayAppOptions {
  controlToken?: string;
  /** Invoked asynchronously after an authenticated shutdown response flushes. */
  onShutdown?: () => void | Promise<void>;
}

/**
 * Callbacks the node:http bridge runs once a response has fully flushed to
 * the client. Keyed by Response identity, so handlers must return the exact
 * object they registered (Hono passes handler responses through untouched).
 */
export const responseCompletionCallbacks = new WeakMap<Response, () => void>();

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

function requestWithSignal(req: Request, signal: AbortSignal): Request {
  return new Request(req.url, {
    method: req.method,
    headers: req.headers,
    body: req.body,
    signal,
    ...(req.body ? { duplex: "half" } : {}),
  });
}

export async function handleForegroundBodyRoute(
  req: Request,
  handle: (scopedRequest: Request) => Promise<Response>,
): Promise<Response> {
  const abortScope = createForegroundAbortScope(req.signal);
  try {
    const scopedRequest = requestWithSignal(req, abortScope.signal);
    const response = await responseAgainstAbort(
      () => handle(scopedRequest),
      abortScope.signal,
    );
    return wrapBodyWithCleanup(response, abortScope.dispose, abortScope.signal);
  } catch (error) {
    abortScope.dispose();
    throw error;
  }
}

/**
 * Detect a WebSocket upgrade request.
 *
 * Clients like Codex (OpenAI Responses API) optimistically try to open a
 * WebSocket to the endpoint (e.g. `ws://host/v1/responses`) before falling
 * back to HTTP. The gateway currently speaks HTTP only: the translating
 * pipeline works on HTTP request/response bodies and forwards them over HTTP
 * to the upstream. WebSocket transport for Codex-style clients is tracked in
 * https://github.com/BYK/loreai/issues/1770.
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
  const resp = errorResponseWithoutCors(
    426,
    "websocket_not_supported",
    `WebSocket transport is not supported for ${pathname}; use HTTP.`,
  );
  resp.headers.set("Connection", "close");
  return resp;
}

function controlTokenMatches(req: Request, token: string): boolean {
  const authorization = req.headers.get("authorization") ?? "";
  const expected = `Bearer ${token}`;
  const actualBytes = Buffer.from(authorization);
  const expectedBytes = Buffer.from(expected);
  return (
    actualBytes.length === expectedBytes.length &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
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
    gatewayReq.signal = req.signal;
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to parse request";
    return errorResponse(400, "invalid_request_error", msg);
  }

  try {
    const result = await handleRequest(gatewayReq, config);
    // Pipeline returns a Response directly (streaming or non-streaming)
    return withoutCors(result);
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
export async function handleModelsPassthrough(
  req: Request,
  config: GatewayConfig,
): Promise<Response> {
  const abortScope = createForegroundAbortScope(req.signal);
  try {
    // Forward auth headers from the original request so upstream
    // providers that require authentication don't reject with 401.
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    Object.assign(
      headers,
      copyProviderAuthHeaders(headersToRecord(req.headers)),
    );
    // Anthropic requires the version header
    const anthropicVersion = req.headers.get("anthropic-version");
    if (anthropicVersion) headers["anthropic-version"] = anthropicVersion;
    // Apply administrator credentials as one auth overlay: if configured auth
    // is present it replaces every client auth variant rather than competing.
    const upstreamUrl = `${config.upstreamAnthropic}/v1/models`;
    applyUpstreamExtraHeaders(
      headers,
      extraHeadersForUpstream(config, upstreamUrl),
    );

    const upstream = await responseAgainstAbort(
      () =>
        upstreamFetch(upstreamUrl, {
          headers,
          signal: abortScope.signal,
        }),
      abortScope.signal,
    );
    // Clone to attach foreground cleanup and strip any upstream CORS headers.
    const response = wrapBodyWithCleanup(
      upstream,
      abortScope.dispose,
      abortScope.signal,
    );
    return withoutCors(response);
  } catch (e) {
    abortScope.dispose();
    const msg = e instanceof Error ? e.message : "Upstream unreachable";
    return errorResponse(502, "api_error", `Failed to fetch models: ${msg}`);
  }
}

function handleHealth(): Response {
  // Subsystem health so silent degradation (embeddings dropping to FTS-only,
  // background workers stalling) is observable via `lore doctor` / monitoring
  // instead of only a one-time gateway log line.
  const embeddings = embedding.embeddingStatus();
  const worker = workerHealthSummary();
  return jsonResponse({
    status: "ok",
    version: VERSION,
    embeddings: {
      available: embeddings.available,
      state: embeddings.state,
      provider: embeddings.provider,
      detail: embeddings.detail,
    },
    worker: {
      ok: worker.ok,
      degradedSessions: worker.degradedSessions,
      detail: worker.detail,
    },
  });
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
    gatewayReq.signal = req.signal;
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to parse request";
    return errorResponse(400, "invalid_request_error", msg);
  }

  try {
    // Pipeline returns the response in the client's native wire format
    // (OpenAI Chat Completions JSON or SSE), so no server-side translation
    // is needed. This prevents the class of bugs where the stream flag is
    // forgotten during format conversion.
    return withoutCors(await handleRequest(gatewayReq, config));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Pipeline error";
    log.error(`pipeline error: ${msg}`);
    return errorResponse(502, "api_error", `Gateway pipeline error: ${msg}`);
  }
}

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
    gatewayReq.signal = req.signal;
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to parse request";
    return errorResponse(400, "invalid_request_error", msg);
  }

  try {
    // Pipeline returns the response in the client's native Gemini wire format
    // (generateContent JSON or streamGenerateContent SSE).
    return withoutCors(await handleRequest(gatewayReq, config));
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
  let gatewayReq: GatewayRequest;
  try {
    gatewayReq = await parseOpenAIResponsesRequestChunks(
      decodedRequestChunks(req, req.signal),
      headersToRecord(req.headers),
    );
    gatewayReq.signal = req.signal;
  } catch {
    // A malformed stream can remain unfinished after parsing fails. Closing the
    // connection cancels Node's request body once the fixed 400 is delivered.
    return closingErrorResponse(
      400,
      "invalid_request_error",
      "Invalid JSON body",
    );
  }

  try {
    // Pipeline returns the response in the client's native wire format
    // (OpenAI Responses API JSON or SSE), so no server-side translation
    // is needed.
    return withoutCors(await handleRequest(gatewayReq, config));
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
  let gatewayReq: GatewayRequest;
  try {
    gatewayReq = await parseOpenAICodexRequestChunks(
      decodedRequestChunks(req, req.signal),
      headersToRecord(req.headers),
    );
    gatewayReq.signal = req.signal;
  } catch {
    return closingErrorResponse(
      400,
      "invalid_request_error",
      "Invalid JSON body",
    );
  }

  try {
    return withoutCors(await handleRequest(gatewayReq, config));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Pipeline error";
    log.error(`pipeline error: ${msg}`);
    return errorResponse(502, "api_error", `Gateway pipeline error: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

function debugLog(config: GatewayConfig, message: string): void {
  if (config.debug && !log.isStderrSilenced()) console.error(message);
}

/**
 * Management authorization (`/`, `/api*`, `/ui*`). Authorizes from node:http's
 * socket metadata, never from Forwarded, X-Forwarded-For, Host, or another
 * client-controlled header. Runs before preflight handling, lazy imports, and
 * request body consumption. An unauthorized peer receives the same bodyless
 * 404 as an absent route (the UI classifies that signal as "unauthorized").
 */
function managementAccess(config: GatewayConfig): GatewayMiddleware {
  return async (c, next) => {
    const pathname = c.req.path;
    const managementPath = isManagementPath(pathname);
    c.set("request", c.req.raw);
    c.set("managementPath", managementPath);
    c.set("allowedManagementOrigin", null);
    if (!managementPath) return next();

    if (
      !config.allowRemoteManagement &&
      !isLoopbackAddress(c.env.peerAddress)
    ) {
      return hiddenManagementResponse();
    }

    const origin = managementCorsOrigin(
      c.req.raw,
      config.allowRemoteManagement,
      c.env.peerAddress,
    );
    if (origin === false) return hiddenManagementResponse();
    c.set("allowedManagementOrigin", origin);

    if (c.req.method === "OPTIONS") {
      return withManagementCors(new Response(null, { status: 204 }), origin);
    }
    return next();
  };
}

/**
 * Data-plane access. Provider credentials authorize an upstream, not this
 * gateway: browser origins cannot invoke any model route (even from loopback),
 * the separate gateway access credential is enforced centrally, and mixed
 * provider-auth pairs are rejected — all before OPTIONS handling, body reads,
 * session/storage/cost state, auth learning, configured credential overlays,
 * or upstream/interceptor calls. The access credential is stripped from the
 * request every later handler sees.
 */
function dataPlaneAccess(config: GatewayConfig): GatewayMiddleware {
  return async (c, next) => {
    if (!isDataPlanePath(c.req.path)) return next();
    const req = c.req.raw;
    if (req.headers.has("origin")) return browserOriginDeniedResponse();

    const { rawHeaders } = c.env;
    if (
      (config.remoteGateway || config.hostedMode) &&
      (!config.gatewayAuthToken ||
        !gatewayAccessMatches(req.headers, config.gatewayAuthToken, rawHeaders))
    ) {
      return gatewayAccessDeniedResponse();
    }
    if (
      hasConflictingAuthHeaders(headersToRecord(req.headers)) ||
      (rawHeaders !== undefined && hasRawConflictingProviderAuth(rawHeaders))
    ) {
      return conflictingProviderAuthResponse();
    }
    c.set("request", withoutGatewayAccessHeader(req));
    return next();
  };
}

/** No-Origin OPTIONS stays a 204 without enabling browser CORS. */
const genericPreflight: GatewayMiddleware = async (c, next) => {
  if (c.req.method === "OPTIONS") {
    return withoutCors(new Response(null, { status: 204 }));
  }
  return next();
};

/**
 * Clients (e.g. Codex) optimistically try a WebSocket upgrade before falling
 * back to HTTP. The gateway is HTTP-only, so reject the upgrade definitively
 * rather than returning a misleading 404 (which caused repeated upgrade
 * attempts and noisy logs).
 */
function requestLogAndUpgradeGuard(config: GatewayConfig): GatewayMiddleware {
  return async (c, next) => {
    const pathname = c.req.path;
    debugLog(config, `[lore] ${c.req.method} ${pathname}`);
    if (isWebSocketUpgrade(c.var.request)) {
      debugLog(
        config,
        `[lore] rejecting WebSocket upgrade for ${pathname} (HTTP-only gateway)`,
      );
      const response = rejectWebSocketUpgrade(pathname);
      return c.var.managementPath
        ? withManagementCors(response, c.var.allowedManagementOrigin)
        : withoutCors(response);
    }
    return next();
  };
}

// ---------------------------------------------------------------------------
// Application
// ---------------------------------------------------------------------------

/** Route the exact request path: no decoding, slash collapsing or case folding. */
function rawPathname(request: Request): string {
  return new URL(request.url).pathname;
}

function notFoundResponse(c: GatewayContext): Response {
  const notFound = errorResponseWithoutCors(
    404,
    "not_found",
    `No route for ${c.req.method} ${c.req.path}`,
  );
  return c.var.managementPath
    ? withManagementCors(notFound, c.var.allowedManagementOrigin)
    : withoutCors(notFound);
}

type RouteHandler = (c: GatewayContext) => Response | Promise<Response>;

/**
 * Hono serves a HEAD request from the matching GET route. The gateway's
 * method-specific routes only ever answered their declared methods (HEAD is
 * accepted by the any-method `/ui` and `/api` handlers alone), so keep the
 * router's fallback from widening them.
 */
function declaredMethodsOnly(
  methods: readonly string[],
  handler: RouteHandler,
): RouteHandler {
  return (c) =>
    methods.includes(c.req.method) ? handler(c) : notFoundResponse(c);
}

export function createGatewayApp(
  config: GatewayConfig,
  options: GatewayAppOptions = {},
): Hono<GatewayEnv> {
  const app = new Hono<GatewayEnv>({ getPath: rawPathname });

  // Access policy first — ahead of every route, including static UI, health
  // and unknown paths. Order matters: management → data plane → preflight →
  // upgrade rejection.
  app.use(managementAccess(config));
  app.use(dataPlaneAccess(config));
  app.use(genericPreflight);
  app.use(requestLogAndUpgradeGuard(config));

  const foreground =
    (handle: (scoped: Request, config: GatewayConfig) => Promise<Response>) =>
    (c: GatewayContext) =>
      handleForegroundBodyRoute(c.var.request, (scoped) =>
        handle(scoped, config),
      );

  // POST /v1/messages — Anthropic protocol
  app.post("/v1/messages", foreground(handleAnthropicMessages));

  // POST /v1/chat/completions — OpenAI protocol.
  // The bare `/chat/completions` (no /v1) form is accepted too: GitHub
  // Copilot CLI redirected via COPILOT_API_URL posts to the origin's bare
  // path (its API omits the /v1 segment, like api.githubcopilot.com).
  app.post("/v1/chat/completions", foreground(handleOpenAIChatCompletions));
  app.post("/chat/completions", foreground(handleOpenAIChatCompletions));

  // POST /v1/responses/compact — Codex compaction (Responses API)
  app.post("/v1/responses/compact", async (c) =>
    withoutCors(await foreground(handleResponsesCompactEndpoint)(c)),
  );

  // POST /v1/codex/responses — Codex (ChatGPT) ingress (Responses format)
  app.post("/v1/codex/responses", foreground(handleOpenAICodexResponses));

  // POST /v1/responses — OpenAI Responses API protocol.
  // NOTE: the bare `/responses` (no /v1) form used by GitHub Copilot CLI's
  // Responses wire API (GPT-5 series) is intentionally NOT accepted yet — the
  // responses upstream builder emits `${base}/v1/responses`, which would 404
  // against api.githubcopilot.com (its endpoints omit /v1). Wiring that needs
  // a host-aware responses path (like buildOpenAIChatCompletionsUrl) first.
  app.post("/v1/responses", foreground(handleOpenAIResponses));

  // POST /v1/compact — explicit compaction summary (Pi plugin, etc.)
  app.post("/v1/compact", async (c) =>
    withoutCors(await foreground(handleCompactEndpoint)(c)),
  );

  // GET /v1/models — passthrough
  app.get(
    "/v1/models",
    declaredMethodsOnly(["GET"], (c) =>
      handleModelsPassthrough(c.var.request, config),
    ),
  );

  // GET /health — health check
  app.get(
    "/health",
    declaredMethodsOnly(["GET"], () => handleHealth()),
  );

  // Owner-only process control used by `lore stop`. Public health omits the
  // PID because a public response cannot prove process ownership. Every
  // unauthorized method is the same 404 as an absent route.
  app.on(
    ["GET", "POST"],
    "/_lore/control",
    declaredMethodsOnly(["GET", "POST"], (c) => {
      const method = c.req.method;
      if (
        !options.controlToken ||
        !controlTokenMatches(c.var.request, options.controlToken) ||
        (method === "POST" && !options.onShutdown)
      ) {
        return errorResponse(
          404,
          "not_found",
          `No route for ${method} /_lore/control`,
        );
      }
      const response = jsonResponse({
        status: "ok",
        service: "lore",
        pid: process.pid,
        ...(method === "POST" ? { shutdown: "requested" } : {}),
      });
      if (method === "POST") {
        responseCompletionCallbacks.set(response, () => {
          try {
            void Promise.resolve(options.onShutdown?.()).catch((error) => {
              log.error("remote shutdown callback failed:", error);
            });
          } catch (error) {
            log.error("remote shutdown callback failed:", error);
          }
        });
      }
      return response;
    }),
  );

  // GET/POST/DELETE /api/* — REST API, mounted as a single dispatcher
  // (lazy-imported to keep proxy hot path fast)
  app.all("/api/*", async (c) => {
    // Hono's `/api/*` also matches the bare `/api`, which has never been a
    // route (the dispatcher only owns `/api/`-prefixed paths).
    if (c.req.path === "/api") return notFoundResponse(c);
    const { handleAPIRequest } = await import("./api");
    const req = c.var.request;
    return withManagementCors(
      await handleAPIRequest(req, new URL(req.url), config),
      c.var.allowedManagementOrigin,
    );
  });

  // GET/HEAD /ui, /ui/* — Lore UI single-page app (static, embedded at
  // build time; lazy-imported so the proxy hot path never loads the assets)
  const ui = async (c: GatewayContext): Promise<Response> => {
    const { handleUIRequest } = await import("./ui-static");
    const req = c.var.request;
    return withManagementCors(
      handleUIRequest(req, new URL(req.url)),
      c.var.allowedManagementOrigin,
    );
  };
  app.all("/ui", ui);
  app.all("/ui/*", ui);

  // GET / — redirect to dashboard. Build the redirect manually instead of
  // via Response.redirect(), whose headers are immutable: management CORS
  // could not be applied and the root path would 500 instead of redirecting.
  app.get(
    "/",
    declaredMethodsOnly(["GET"], (c) =>
      withManagementCors(
        new Response(null, {
          status: 302,
          headers: { location: "/ui" },
        }),
        c.var.allowedManagementOrigin,
      ),
    ),
  );

  // Pattern routes share their regexes with `isDataPlanePath` and the raw
  // `upgrade` listener, so they are matched here rather than re-spelled as
  // Hono path patterns.
  app.post("*", async (c) => {
    const pathname = c.req.path;

    // POST /v1beta/models/{model}:generateContent (or :streamGenerateContent)
    // — native Google Gemini protocol. Version-prefix-agnostic (see
    // GEMINI_PATH_RE) so the Gemini CLI and @ai-sdk/google both match.
    const gm = pathname.match(GEMINI_PATH_RE);
    if (gm) {
      return handleForegroundBodyRoute(c.var.request, (scoped) =>
        handleGeminiGenerateContent(
          scoped,
          config,
          gm[1],
          gm[2] === "streamGenerateContent",
        ),
      );
    }

    // POST /v1/model/{modelId}/{verb} — Bedrock Runtime API passthrough.
    // Routes the four Bedrock Runtime verbs (converse, converse-stream,
    // invoke, invoke-with-response-stream) to bedrock-runtime.<region>.amazonaws.com
    // verbatim — no translation, no pipeline processing (the AWS SDK
    // already owns retries, streaming, and credential rotation). Region
    // comes from LORE_BEDROCK_REGION / AWS_REGION (loaded into config).
    if (BEDROCK_RUNTIME_PATH_RE.test(pathname)) {
      return withoutCors(
        await proxyBedrockRuntimeRequest(c.var.request, config.bedrockRegion),
      );
    }

    return notFoundResponse(c);
  });

  // 404 for everything else
  app.notFound(notFoundResponse);

  app.onError((e, c) => {
    const msg = e instanceof Error ? e.message : "Internal server error";
    log.error(`uncaught error: ${msg}`);
    if (c.var.managementPath) {
      return withManagementCors(
        errorResponseWithoutCors(500, "api_error", msg),
        c.var.allowedManagementOrigin,
      );
    }
    return errorResponse(500, "api_error", msg);
  });

  return app;
}
