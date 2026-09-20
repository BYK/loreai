/**
 * Gateway access policy: browser-origin rules, management (`/`, `/api`, `/ui`)
 * authorization, data-plane access credentials, and the uniform denial
 * responses. Pure functions over Web `Request`/`Response` plus the socket
 * metadata the node:http bridge supplies — no routing, no I/O.
 *
 * Shared by the Hono middleware in `app.ts` and the raw `upgrade` listener in
 * `server.ts` so both paths enforce exactly the same policy.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { BlockList, isIP } from "node:net";
import { GATEWAY_AUTH_HEADER } from "@loreai/core";
import { PROVIDER_AUTH_HEADER_NAMES } from "./auth";

// ---------------------------------------------------------------------------
// Browser-origin policy
// ---------------------------------------------------------------------------

const CORS_METHODS = "GET, POST, DELETE, OPTIONS";

/**
 * Data-plane responses are intentionally not CORS-enabled. Clone the response
 * while removing upstream-supplied CORS headers too, so a cached no-Origin
 * response cannot make model output readable to a later browser request.
 */
export function withoutCors(response: Response): Response {
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

export function withManagementCors(
  response: Response,
  origin: string | null,
): Response {
  // Prevent an untrusted site from embedding the management surface and
  // clickjacking a loopback browser. The UI handler sets its own, stricter
  // policy (which also contains frame-ancestors 'none'); keep it intact.
  if (!response.headers.has("content-security-policy")) {
    response.headers.set("content-security-policy", "frame-ancestors 'none'");
  }
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
// Response helpers
// ---------------------------------------------------------------------------

/** Convert a Web Headers object to a plain Record<string, string>. */
export function headersToRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    record[key] = value;
  });
  return record;
}

export function jsonResponseWithoutCors(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function jsonResponse(body: unknown, status = 200): Response {
  return withoutCors(jsonResponseWithoutCors(body, status));
}

export function errorResponseWithoutCors(
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

export function errorResponse(
  status: number,
  type: string,
  message: string,
): Response {
  return withoutCors(errorResponseWithoutCors(status, type, message));
}

export function closingErrorResponse(
  status: number,
  type: string,
  message: string,
): Response {
  const response = errorResponse(status, type, message);
  response.headers.set("connection", "close");
  return response;
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

/** Deliberately carries no route details or CORS headers. */
export function browserOriginDeniedResponse(): Response {
  // Do not wait for or drain an attacker-controlled body after rejecting it.
  return new Response(null, {
    status: 403,
    headers: { "cache-control": "no-store", connection: "close" },
  });
}

/** Uniform remote data-plane denial: no body, challenge, or config detail. */
export function gatewayAccessDeniedResponse(): Response {
  return new Response(null, {
    status: 401,
    headers: { "cache-control": "no-store", connection: "close" },
  });
}

export function conflictingProviderAuthResponse(): Response {
  const response = errorResponseWithoutCors(
    400,
    "invalid_request_error",
    "Conflicting provider authentication headers",
  );
  response.headers.set("cache-control", "no-store");
  response.headers.set("connection", "close");
  return response;
}

/** Deliberately carries no route details or CORS headers. */
export function hiddenManagementResponse(): Response {
  // Close rather than leave a keep-alive socket waiting on an unauthorized,
  // deliberately unread request body (request timeouts are disabled for LLM
  // streaming routes).
  return new Response(null, {
    status: 404,
    headers: { connection: "close" },
  });
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

export function singleRawHeaderValue(
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

export function constantTimeTokenMatches(
  actual: string,
  expected: string,
): boolean {
  const digest = (value: string): Buffer =>
    createHash("sha256")
      .update("lore.gateway-access.v1\0")
      .update(value)
      .digest();
  return timingSafeEqual(digest(actual), digest(expected));
}

export function gatewayAccessMatches(
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

export function hasRawConflictingProviderAuth(
  rawHeaders: readonly string[],
): boolean {
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
export function withoutGatewayAccessHeader(req: Request): Request {
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
export function managementCorsOrigin(
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
