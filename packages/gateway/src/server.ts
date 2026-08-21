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
 * Uses `node:http` `createServer` with Web `Request`/`Response` — the same
 * code runs under both Bun and the Node.js npm distribution.
 */
import { createServer as createHttpServer } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import type { Server } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { BlockList, isIP, type Socket } from "node:net";
import { Readable } from "node:stream";
import { embedding, GATEWAY_AUTH_HEADER, log } from "@loreai/core";
import {
  assertGatewayAccessConfigured,
  DEFAULT_PORT,
  extraHeadersForUpstream,
  type GatewayConfig,
} from "./config";
import { bootstrapDailySpend, getDailyBudget } from "./cost-tracker";
import { workerHealthSummary } from "./worker-health";
import {
  setupEmbeddingFailureCapture,
  setupBustSpiralCapture,
  setupReadPathTimingCapture,
  setupVecReadLatencyCapture,
} from "./sentry";
import type { GatewayRequest } from "./translate/types";
import { applyUpstreamExtraHeaders } from "./translate/types";
import {
  copyProviderAuthHeaders,
  hasConflictingAuthHeaders,
  PROVIDER_AUTH_HEADER_NAMES,
} from "./auth";
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
  createForegroundAbortScope,
  wrapBodyWithCleanup,
} from "./pipeline";
import { upstreamFetch } from "./fetch";
import { responseAgainstAbort } from "./abort-race";
import { cancelAndReleaseReader, readStreamChunk } from "./stream/anthropic";
import { decodeRequestBody } from "./http-body";
import { SHUTDOWN_DEADLINE_MS } from "./shutdown-deadline";
import {
  BEDROCK_RUNTIME_PATH_RE,
  proxyBedrockRuntimeRequest,
} from "./translate/bedrock-runtime";

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
// Browser-origin policy
// ---------------------------------------------------------------------------

const CORS_METHODS = "GET, POST, DELETE, OPTIONS";

/**
 * Data-plane responses are intentionally not CORS-enabled. Clone the response
 * while removing upstream-supplied CORS headers too, so a cached no-Origin
 * response cannot make model output readable to a later browser request.
 */
function withoutCors(response: Response): Response {
  const headers = new Headers(response.headers);
  // Snapshot before deleting so iterator invalidation cannot skip a header.
  for (const name of Array.from(headers.keys())) {
    if (name.startsWith("access-control-")) headers.delete(name);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function withManagementCors(
  response: Response,
  origin: string | null,
): Response {
  // The dashboard contains destructive forms. Prevent an untrusted site from
  // embedding it and clickjacking a loopback browser into submitting them.
  response.headers.set("content-security-policy", "frame-ancestors 'none'");
  response.headers.set("x-frame-options", "DENY");

  // Same-origin browser requests and non-browser clients do not need CORS.
  // For an explicitly cross-origin request, reflect only the already-validated
  // loopback origin; a wildcard would let an arbitrary website drive localhost.
  if (!origin) return response;
  response.headers.set("access-control-allow-origin", origin);
  response.headers.set("access-control-allow-methods", CORS_METHODS);
  response.headers.set("access-control-allow-headers", "content-type");
  response.headers.set("access-control-max-age", "600");
  response.headers.append("vary", "Origin");
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

function jsonResponseWithoutCors(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return withoutCors(jsonResponseWithoutCors(body, status));
}

function errorResponseWithoutCors(
  status: number,
  type: string,
  message: string,
): Response {
  return jsonResponseWithoutCors(
    {
      type: "error",
      error: { type, message },
    },
    status,
  );
}

function errorResponse(
  status: number,
  type: string,
  message: string,
): Response {
  return withoutCors(errorResponseWithoutCors(status, type, message));
}

// ---------------------------------------------------------------------------
// Management access policy
// ---------------------------------------------------------------------------

const LOOPBACK_ADDRESSES = new BlockList();
LOOPBACK_ADDRESSES.addSubnet("127.0.0.0", 8, "ipv4");
LOOPBACK_ADDRESSES.addAddress("::1", "ipv6");

/** True only for a numeric loopback socket address. Hostnames are not trusted. */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const family = isIP(address);
  if (family === 4) return LOOPBACK_ADDRESSES.check(address, "ipv4");
  if (family === 6) return LOOPBACK_ADDRESSES.check(address, "ipv6");
  return false;
}

function isManagementPath(pathname: string): boolean {
  return (
    pathname === "/" ||
    pathname === "/api" ||
    pathname.startsWith("/api/") ||
    pathname === "/ui" ||
    pathname.startsWith("/ui/")
  );
}

function isDataPlanePath(pathname: string): boolean {
  return (
    pathname === "/v1/messages" ||
    pathname === "/v1/chat/completions" ||
    pathname === "/chat/completions" ||
    pathname === "/v1/responses" ||
    pathname === "/v1/codex/responses" ||
    pathname === "/v1/responses/compact" ||
    pathname === "/v1/compact" ||
    pathname === "/v1/models" ||
    GEMINI_PATH_RE.test(pathname) ||
    BEDROCK_RUNTIME_PATH_RE.test(pathname)
  );
}

/** Deliberately carries no route details or CORS headers. */
function browserOriginDeniedResponse(): Response {
  // Do not wait for or drain an attacker-controlled body after rejecting it.
  return new Response(null, {
    status: 403,
    headers: { "cache-control": "no-store", connection: "close" },
  });
}

/** Uniform remote data-plane denial: no body, challenge, or config detail. */
function gatewayAccessDeniedResponse(): Response {
  return new Response(null, {
    status: 401,
    headers: { "cache-control": "no-store", connection: "close" },
  });
}

function conflictingProviderAuthResponse(): Response {
  const response = errorResponseWithoutCors(
    400,
    "invalid_request_error",
    "Conflicting provider authentication headers",
  );
  response.headers.set("cache-control", "no-store");
  response.headers.set("connection", "close");
  return response;
}

function rawHeaderCount(
  rawHeaders: readonly string[] | undefined,
  target: string,
): number {
  if (!rawHeaders) return 1;
  let count = 0;
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index]?.toLowerCase() === target) count++;
  }
  return count;
}

function singleRawHeaderValue(
  rawHeaders: readonly string[],
  target: string,
): string | null {
  let value: string | null = null;
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index]?.toLowerCase() !== target) continue;
    if (value !== null) return null;
    value = rawHeaders[index + 1] ?? "";
  }
  return value;
}

function constantTimeTokenMatches(actual: string, expected: string): boolean {
  const digest = (value: string): Buffer =>
    createHash("sha256")
      .update("lore.gateway-access.v1\0")
      .update(value)
      .digest();
  return timingSafeEqual(digest(actual), digest(expected));
}

function gatewayAccessMatches(
  headers: Headers,
  expected: string,
  rawHeaders?: readonly string[],
): boolean {
  if (rawHeaderCount(rawHeaders, GATEWAY_AUTH_HEADER) !== 1) return false;
  const actual = rawHeaders
    ? singleRawHeaderValue(rawHeaders, GATEWAY_AUTH_HEADER)
    : headers.get(GATEWAY_AUTH_HEADER);
  return actual !== null && constantTimeTokenMatches(actual, expected);
}

function hasRawConflictingProviderAuth(rawHeaders: readonly string[]): boolean {
  const present = new Set<string>();
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index]?.toLowerCase();
    if (!PROVIDER_AUTH_HEADER_NAMES.some((candidate) => candidate === name)) {
      continue;
    }
    if (present.has(name)) return true;
    present.add(name);
    if (present.size > 1) return true;
  }
  return false;
}

/** Remove the access credential before any downstream request processing. */
function withoutGatewayAccessHeader(req: Request): Request {
  if (!req.headers.has(GATEWAY_AUTH_HEADER)) return req;
  const headers = new Headers(req.headers);
  headers.delete(GATEWAY_AUTH_HEADER);
  return new Request(req.url, {
    method: req.method,
    headers,
    body: req.body,
    signal: req.signal,
    ...(req.body ? { duplex: "half" } : {}),
  });
}

/**
 * Return an allowed CORS origin, null when Origin is absent, or false when an
 * untrusted web origin supplied the header. Loopback peers may use numeric
 * loopback hosts or the special-use `localhost` name. Non-loopback peers must
 * supply an origin that exactly matches Host.
 */
function managementCorsOrigin(
  req: Request,
  allowRemoteManagement: boolean,
  peerAddress: string | undefined,
): string | null | false {
  const origin = req.headers.get("origin");
  if (!origin) return null;
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }
    if (
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash
    ) {
      return false;
    }
    const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
    const loopbackOrigin =
      hostname === "localhost" || isLoopbackAddress(hostname);
    if (!isLoopbackAddress(peerAddress)) {
      if (!allowRemoteManagement) return false;
      if (loopbackOrigin) return false;
      const requestHost = req.headers.get("host");
      if (!requestHost) return false;
      // Use the origin scheme only to normalize default ports. The scheme is
      // not trusted for authorization; remote access is still gated by the
      // socket peer and the origin/Host host-port match below.
      const requestOrigin = new URL(`${parsed.protocol}//${requestHost}`);
      if (
        requestOrigin.username ||
        requestOrigin.password ||
        requestOrigin.pathname !== "/" ||
        requestOrigin.search ||
        requestOrigin.hash ||
        parsed.host !== requestOrigin.host
      ) {
        return false;
      }
    } else if (!loopbackOrigin) {
      return false;
    }
    return origin;
  } catch {
    return false;
  }
}

/** Deliberately carries no route details or CORS headers. */
function hiddenManagementResponse(): Response {
  // Close rather than leave a keep-alive socket waiting on an unauthorized,
  // deliberately unread request body (request timeouts are disabled for LLM
  // streaming routes).
  return new Response(null, {
    status: 404,
    headers: { connection: "close" },
  });
}

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
  const resp = errorResponseWithoutCors(
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
    version,
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
    gatewayReq.signal = req.signal;
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to parse request";
    return errorResponse(400, "invalid_request_error", msg);
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
    gatewayReq.signal = req.signal;
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to parse request";
    return errorResponse(400, "invalid_request_error", msg);
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
// Server
// ---------------------------------------------------------------------------

const responseCompletionCallbacks = new WeakMap<Response, () => void>();

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
  stop: () => Promise<void>;
  port: number;
  hosts: string[];
  /** Resolves when all bound servers are listening. */
  ready: Promise<void>;
}> {
  const closeBoundServer =
    options.closeServer ??
    ((server: Server) =>
      closeServer(server, options.shutdownDeadlineMs ?? SHUTDOWN_DEADLINE_MS));
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

  // Wire vector KNN read-latency to Sentry (#1065 — confirm the vec0 win). Same
  // idempotency guarantee — the hook is assigned, not stacked.
  setupVecReadLatencyCapture();

  // Shared fetch handler for all server instances.
  const fetch = async (
    req: Request,
    peerAddress: string | undefined,
    rawHeaders?: readonly string[],
  ): Promise<Response> => {
    const url = new URL(req.url);
    const { pathname } = url;
    const method = req.method;
    const managementPath = isManagementPath(pathname);
    const dataPlanePath = isDataPlanePath(pathname);
    let allowedManagementOrigin: string | null = null;

    if (managementPath) {
      // Authorize from node:http's socket metadata, never from Forwarded,
      // X-Forwarded-For, Host, or another client-controlled header. Keep this
      // before preflight handling, lazy imports, and request body consumption.
      if (!config.allowRemoteManagement && !isLoopbackAddress(peerAddress)) {
        return hiddenManagementResponse();
      }

      const origin = managementCorsOrigin(
        req,
        config.allowRemoteManagement,
        peerAddress,
      );
      if (origin === false) return hiddenManagementResponse();
      allowedManagementOrigin = origin;

      if (method === "OPTIONS") {
        return withManagementCors(
          new Response(null, { status: 204 }),
          allowedManagementOrigin,
        );
      }
    }

    // Provider credentials authorize an upstream, not this gateway. Browser
    // origins therefore cannot invoke any model/data-plane route, even from a
    // loopback origin. Keep this ahead of preflight handling, body reads,
    // authentication, session/storage setup, and upstream/interceptor work.
    if (dataPlanePath && req.headers.has("origin")) {
      return browserOriginDeniedResponse();
    }

    // Provider keys authorize model providers, never this gateway. Enforce the
    // separate access credential and all mixed-provider-auth pairs centrally,
    // before OPTIONS handling, body reads, session/storage/cost state, auth
    // learning, configured credential overlays, or upstream/interceptor calls.
    if (dataPlanePath) {
      if (
        (config.remoteGateway || config.hostedMode) &&
        (!config.gatewayAuthToken ||
          !gatewayAccessMatches(
            req.headers,
            config.gatewayAuthToken,
            rawHeaders,
          ))
      ) {
        return gatewayAccessDeniedResponse();
      }
      if (
        hasConflictingAuthHeaders(headersToRecord(req.headers)) ||
        (rawHeaders !== undefined && hasRawConflictingProviderAuth(rawHeaders))
      ) {
        return conflictingProviderAuthResponse();
      }
      req = withoutGatewayAccessHeader(req);
    }

    // Preserve no-Origin OPTIONS behavior without enabling browser CORS.
    if (method === "OPTIONS") {
      return withoutCors(new Response(null, { status: 204 }));
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
      const response = rejectWebSocketUpgrade(pathname);
      return managementPath
        ? withManagementCors(response, allowedManagementOrigin)
        : withoutCors(response);
    }

    try {
      // POST /v1/messages — Anthropic protocol
      if (method === "POST" && pathname === "/v1/messages") {
        return await handleForegroundBodyRoute(req, (scoped) =>
          handleAnthropicMessages(scoped, config),
        );
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
        return await handleForegroundBodyRoute(req, (scoped) =>
          handleOpenAIChatCompletions(scoped, config),
        );
      }

      // POST /v1beta/models/{model}:generateContent (or :streamGenerateContent)
      // — native Google Gemini protocol. Version-prefix-agnostic (see
      // GEMINI_PATH_RE) so the Gemini CLI and @ai-sdk/google both match.
      if (method === "POST") {
        const gm = pathname.match(GEMINI_PATH_RE);
        if (gm) {
          return await handleForegroundBodyRoute(req, (scoped) =>
            handleGeminiGenerateContent(
              scoped,
              config,
              gm[1],
              gm[2] === "streamGenerateContent",
            ),
          );
        }
      }

      // POST /v1/responses/compact — Codex compaction (Responses API)
      if (method === "POST" && pathname === "/v1/responses/compact") {
        return withoutCors(
          await handleForegroundBodyRoute(req, (scoped) =>
            handleResponsesCompactEndpoint(scoped, config),
          ),
        );
      }

      // POST /v1/codex/responses — Codex (ChatGPT) ingress (Responses format)
      if (method === "POST" && pathname === "/v1/codex/responses") {
        return await handleForegroundBodyRoute(req, (scoped) =>
          handleOpenAICodexResponses(scoped, config),
        );
      }

      // POST /v1/responses — OpenAI Responses API protocol.
      // NOTE: the bare `/responses` (no /v1) form used by GitHub Copilot CLI's
      // Responses wire API (GPT-5 series) is intentionally NOT accepted yet — the
      // responses upstream builder emits `${base}/v1/responses`, which would 404
      // against api.githubcopilot.com (its endpoints omit /v1). Wiring that needs
      // a host-aware responses path (like buildOpenAIChatCompletionsUrl) first.
      if (method === "POST" && pathname === "/v1/responses") {
        return await handleForegroundBodyRoute(req, (scoped) =>
          handleOpenAIResponses(scoped, config),
        );
      }

      // POST /v1/compact — explicit compaction summary (Pi plugin, etc.)
      if (method === "POST" && pathname === "/v1/compact") {
        return withoutCors(
          await handleForegroundBodyRoute(req, (scoped) =>
            handleCompactEndpoint(scoped, config),
          ),
        );
      }

      // POST /v1/model/{modelId}/{verb} — Bedrock Runtime API passthrough.
      // Routes the four Bedrock Runtime verbs (converse, converse-stream,
      // invoke, invoke-with-response-stream) to bedrock-runtime.<region>.amazonaws.com
      // verbatim — no translation, no pipeline processing (the AWS SDK
      // already owns retries, streaming, and credential rotation). Region
      // comes from LORE_BEDROCK_REGION / AWS_REGION (loaded into config).
      if (method === "POST" && BEDROCK_RUNTIME_PATH_RE.test(pathname)) {
        return withoutCors(
          await proxyBedrockRuntimeRequest(req, config.bedrockRegion),
        );
      }

      // GET /v1/models — passthrough
      if (method === "GET" && pathname === "/v1/models") {
        return await handleModelsPassthrough(req, config);
      }

      // GET /health — health check
      if (method === "GET" && pathname === "/health") {
        return handleHealth();
      }

      // Owner-only process control used by `lore stop`. Public health omits the
      // PID because a public response cannot prove process ownership. Every
      // unauthorized method is the same 404 as an absent route.
      if (
        (method === "GET" || method === "POST") &&
        pathname === "/_lore/control"
      ) {
        if (
          !options.controlToken ||
          !controlTokenMatches(req, options.controlToken) ||
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
      }

      // GET/POST/DELETE /api/* — REST API (lazy-imported to keep proxy hot path fast)
      if (pathname.startsWith("/api/")) {
        const { handleAPIRequest } = await import("./api");
        return withManagementCors(
          await handleAPIRequest(req, url, config),
          allowedManagementOrigin,
        );
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
        return withManagementCors(
          await Promise.race([uiPromise, timeoutPromise]),
          allowedManagementOrigin,
        );
      }

      // GET / — redirect to dashboard. Build the redirect manually instead of
      // via Response.redirect(), whose headers are immutable: management CORS
      // could not be applied and the root path would 500 instead of redirecting.
      if (method === "GET" && pathname === "/") {
        return withManagementCors(
          new Response(null, {
            status: 302,
            headers: { location: "/ui" },
          }),
          allowedManagementOrigin,
        );
      }

      // 404 for everything else
      const notFound = errorResponseWithoutCors(
        404,
        "not_found",
        `No route for ${method} ${pathname}`,
      );
      return managementPath
        ? withManagementCors(notFound, allowedManagementOrigin)
        : withoutCors(notFound);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Internal server error";
      log.error(`uncaught error: ${msg}`);
      if (managementPath) {
        return withManagementCors(
          errorResponseWithoutCors(500, "api_error", msg),
          allowedManagementOrigin,
        );
      }
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
    await Promise.all(servers.map(closeBoundServer));
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
    stop: (): Promise<void> => {
      stopPromise ??= Promise.all(servers.map(closeBoundServer)).then(() => {});
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
    abort(new DOMException("client request aborted", "AbortError"));
  const onRequestClose = (): void => {
    if (!nodeReq.complete) onRequestAborted();
  };
  const onRequestError = (error: Error): void => abort(error);
  const onResponseClose = (): void => {
    if (!nodeRes.writableEnded) {
      abort(new DOMException("client response closed", "AbortError"));
    }
  };
  const onResponseError = (error: Error): void => abort(error);
  const onSocketClose = (): void => {
    if (!nodeRes.writableEnded) {
      abort(new DOMException("client socket closed", "AbortError"));
    }
  };
  const onSocketError = (error: Error): void => abort(error);
  nodeReq.on("aborted", onRequestAborted);
  nodeReq.on("close", onRequestClose);
  nodeReq.on("error", onRequestError);
  nodeRes.on("close", onResponseClose);
  nodeRes.on("error", onResponseError);
  nodeReq.socket.on("close", onSocketClose);
  nodeReq.socket.on("error", onSocketError);
  return {
    signal: controller.signal,
    cleanup: () => {
      nodeReq.removeListener("aborted", onRequestAborted);
      nodeReq.removeListener("close", onRequestClose);
      nodeReq.removeListener("error", onRequestError);
      nodeRes.removeListener("close", onResponseClose);
      nodeRes.removeListener("error", onResponseError);
      nodeReq.socket.removeListener("close", onSocketClose);
      nodeReq.socket.removeListener("error", onSocketError);
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
