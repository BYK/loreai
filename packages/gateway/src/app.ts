/**
 * Hono application for the Lore gateway.
 *
 * Routes live in per-provider modules under `routes/` and are mounted from
 * `routes/registry.ts` (`ROUTE_MODULES`):
 *   POST /v1/messages            → Anthropic protocol (`routes/anthropic`)
 *   POST /v1/chat/completions    → OpenAI Chat Completions (`routes/openai`)
 *   POST /v1/responses           → OpenAI Responses API (`routes/openai`)
 *   POST /v1/codex/responses     → Codex (ChatGPT) ingress (`routes/openai`)
 *   POST /v1/responses/compact   → Codex compaction (`routes/openai`)
 *   POST /v1/compact             → Explicit compaction summary (`routes/compact`)
 *   POST /v1/model/{modelId}/{verb} → Bedrock Runtime passthrough (`routes/bedrock`)
 *   POST .../models/{model}:generateContent → Google Gemini (`routes/gemini`)
 *   GET  /v1/models              → Passthrough to upstream (`routes/models`)
 *   GET  /health, /_lore/control → Health / process control (`routes/control`)
 *   *    /api/*, /ui, /ui/*, /   → Management API, UI, redirect (`routes/management`)
 *
 * Every handler works on Web `Request`/`Response`; the node:http bridge in
 * `server.ts` supplies the socket peer address and raw header list as Hono
 * bindings (`app.fetch(request, env)`). Access policy runs as middleware
 * before any route — including `/ui` static, `/health` and unknown paths —
 * classifying the path via the same registry the routes are mounted from.
 */
import { Hono } from "hono";
import { log } from "@loreai/core";
import type { GatewayConfig } from "./config";
import { hasConflictingAuthHeaders } from "./auth";
import { responseAgainstAbort } from "./abort-race";
import { createForegroundAbortScope, wrapBodyWithCleanup } from "./pipeline";
import {
  browserOriginDeniedResponse,
  conflictingProviderAuthResponse,
  errorResponse,
  errorResponseWithoutCors,
  gatewayAccessDeniedResponse,
  gatewayAccessMatches,
  hasRawConflictingProviderAuth,
  headersToRecord,
  hiddenManagementResponse,
  isLoopbackAddress,
  managementCorsOrigin,
  withManagementCors,
  withoutCors,
  withoutGatewayAccessHeader,
} from "./management-access";
import { classifyPath, ROUTE_MODULES } from "./routes/registry";
import {
  DATA_PLANE,
  MANAGEMENT_PLANE,
  type GatewayAppOptions,
  type GatewayContext,
  type GatewayEnv,
  type GatewayMiddleware,
  type RouteContext,
  type RouteHandler,
} from "./routes/types";

export type {
  GatewayAppOptions,
  GatewayEnv,
  GatewayRequestEnv,
} from "./routes/types";
export { responseCompletionCallbacks } from "./routes/control";
export { handleModelsPassthrough } from "./routes/models";

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
    const managementPath = classifyPath(c.req.path) === MANAGEMENT_PLANE;
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
    if (classifyPath(c.req.path) !== DATA_PLANE) return next();
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

  const ctx: RouteContext = {
    config,
    options,
    foreground: (handle) => (c) =>
      handleForegroundBodyRoute(c.var.request, (scoped) =>
        handle(scoped, config),
      ),
    notFound: notFoundResponse,
    declaredMethodsOnly,
  };
  for (const module of ROUTE_MODULES) module.register(app, ctx);

  // 404 for everything else
  app.notFound(notFoundResponse);

  app.onError((e, c) => {
    const msg = e instanceof Error ? e.message : "Internal server error";
    const clientAborted =
      e instanceof DOMException &&
      e.name === "AbortError" &&
      c.var.request.signal.aborted;
    if (clientAborted) {
      log.info(`client request ended before completion: ${msg}`);
    } else {
      log.error(`uncaught error: ${msg}`);
    }
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
