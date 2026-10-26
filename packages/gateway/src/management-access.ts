/**
 * Gateway access policy: browser-origin rules, management (`/`, `/api`, `/ui`)
 * authorization, data-plane access credentials, and the uniform denial
 * responses. Pure functions over Web `Request`/`Response` plus the socket
 * metadata the node:http bridge supplies — no routing, no I/O.
 *
 * Shared by the Hono middleware in `app.ts` and the raw `upgrade` listener in
 * `server.ts` so both paths enforce exactly the same policy.
 */
import { BlockList, isIP } from "node:net";
import { GATEWAY_AUTH_HEADER } from "@loreai/core";
import { PROVIDER_AUTH_HEADER_NAMES } from "./auth";
import { transferResponseCompletionCallback } from "./response-completion";
import type { GatewayConfig } from "./config";

// ---------------------------------------------------------------------------
// Browser-origin policy
// ---------------------------------------------------------------------------

const CORS_METHODS = "GET, POST, PATCH, DELETE, OPTIONS";

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
  const result = new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
  transferResponseCompletionCallback(response, result);
  return result;
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
  response.headers.set(
    "access-control-allow-headers",
    "authorization, content-type",
  );
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

/** Shared, body-independent policy for normal HTTP and raw HTTP upgrades. */
export function managementAccessDecision(
  req: Request,
  peerAddress: string | undefined,
  config: Pick<
    GatewayConfig,
    "allowRemoteManagement" | "hosts" | "managementOrigins"
  >,
): { allowed: boolean; origin: string | null } {
  const remotePeer = !isLoopbackAddress(peerAddress);
  if (remotePeer && !config.allowRemoteManagement)
    return { allowed: false, origin: null };
  const origin = managementCorsOrigin(
    req,
    config.allowRemoteManagement,
    peerAddress,
    config.hosts,
    config.managementOrigins,
  );
  if (origin === false) return { allowed: false, origin: null };
  return {
    allowed: !(
      remotePeer &&
      isGatewayOperatorMutation(req.method, new URL(req.url).pathname)
    ),
    origin,
  };
}

function isGatewayOperatorMutation(method: string, path: string): boolean {
  if (method === "GET" || method === "HEAD" || method === "OPTIONS")
    return false;
  // These mutations consume the installation operator's credentials/filesystem;
  // remote management access never grants that separate operator authority.
  return (
    path === "/api/v1/teams" ||
    path.startsWith("/api/v1/teams/") ||
    /^\/api\/v1\/orgs\/[^/]+\/domains(?:\/|$)/.test(path) ||
    /^\/api\/v1\/projects\/[^/]+\/sharing\/link$/.test(path) ||
    (method === "POST" &&
      (path === "/api/v1/sync/run" ||
        /^\/api\/v1\/knowledge\/[^/]+\/promote$/.test(path) ||
        /^\/api\/v1\/promotions\/[^/]+\/(?:approve|reject|withdraw)$/.test(
          path,
        )))
  );
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
  listenerHosts: readonly string[] = [],
  managementOrigins: readonly string[] = [],
): string | null | false {
  const origin = req.headers.get("origin");
  try {
    const host = req.headers.get("host") ?? new URL(req.url).host;
    // Host and Origin are caller-controlled. Matching each other never makes
    // either trusted, even on a remote socket with management opted in.
    if (!host || /[\\/?#@\s]/.test(host) || host.endsWith(":")) return false;
    const authority = new URL(`http://${host}`);
    const hostname = authority.hostname.replace(/^\[|\]$/g, "");
    const listenerAuthority = listenerHosts.some((listener) => {
      const name = listener.toLowerCase().replace(/^\[|\]$/g, "");
      return (
        name !== "0.0.0.0" && name !== "::" && name !== "*" && name === hostname
      );
    });
    const publicOrigins = allowRemoteManagement
      ? managementOrigins.map((value) => new URL(value))
      : [];
    const publicAuthority = publicOrigins.some(
      (configured) =>
        configured.host === new URL(`${configured.protocol}//${host}`).host,
    );
    if (
      !(
        hostname === "localhost" ||
        isLoopbackAddress(hostname) ||
        listenerAuthority ||
        publicAuthority
      )
    )
      return false;
    if (!origin) return null;
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
    const originHostname = parsed.hostname.replace(/^\[|\]$/g, "");
    const loopbackOrigin =
      originHostname === "localhost" || isLoopbackAddress(originHostname);
    if (!isLoopbackAddress(peerAddress)) {
      if (!allowRemoteManagement) return false;
      if (loopbackOrigin) return false;
    }
    if (loopbackOrigin && isLoopbackAddress(peerAddress)) return origin;
    if (parsed.host !== new URL(`${parsed.protocol}//${host}`).host)
      return false;
    // A loopback reverse proxy may preserve a public HTTPS Host and Origin.
    // It needs explicit administrator configuration, never forwarded peer claims.
    if (
      !listenerAuthority &&
      !publicOrigins.some((configured) => configured.origin === parsed.origin)
    )
      return false;
    return origin;
  } catch {
    return false;
  }
}
