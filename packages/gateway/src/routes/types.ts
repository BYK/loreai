/**
 * Shared types for the gateway's Hono route modules.
 *
 * Each provider (and the gateway's own management/control surface) lives in
 * its own module under `routes/` and exports a `RouteModule`: the paths it
 * owns plus a `register` function that mounts its handlers. The registry in
 * `./registry.ts` derives the access-plane classifier from those declared
 * paths, so the pre-route access middleware and the raw `upgrade` listener in
 * `server.ts` never need a hand-maintained path list.
 */
import type { Context, Hono, MiddlewareHandler } from "hono";
import type { GatewayConfig } from "../config";

/** Socket metadata the node:http bridge passes as Hono bindings. */
export interface GatewayRequestEnv {
  /** Numeric socket peer address; never derived from client headers. */
  peerAddress: string | undefined;
  /** node:http `rawHeaders` — needed to detect duplicate credential headers. */
  rawHeaders?: readonly string[];
}

export interface GatewayVariables {
  /** The request handlers must use (access credential already stripped). */
  request: Request;
  managementPath: boolean;
  allowedManagementOrigin: string | null;
}

export type GatewayEnv = {
  Bindings: GatewayRequestEnv;
  Variables: GatewayVariables;
};

export type GatewayContext = Context<GatewayEnv>;
export type GatewayMiddleware = MiddlewareHandler<GatewayEnv>;
export type GatewayApp = Hono<GatewayEnv>;
export type RouteHandler = (c: GatewayContext) => Response | Promise<Response>;

export interface GatewayAppOptions {
  controlToken?: string;
  /** Invoked asynchronously after an authenticated shutdown response flushes. */
  onShutdown?: () => void | Promise<void>;
}

/**
 * Which access policy a path is subject to, decided before any route runs:
 *
 * - `management`: `/`, `/api*`, `/ui*` — socket-peer + Origin/Host checks,
 *   management CORS, hidden 404 for unauthorized peers.
 * - `data`: model/proxy endpoints — browser origins refused, gateway access
 *   token enforced in remote/hosted mode, conflicting provider auth rejected.
 * - `null`: neither (health, process control) — no plane-specific policy.
 */
export const MANAGEMENT_PLANE = "management";
export const DATA_PLANE = "data";
export type RoutePlane = typeof MANAGEMENT_PLANE | typeof DATA_PLANE | null;

export interface RouteModule {
  /** Stable identifier, used in registry tests and diagnostics. */
  readonly name: string;
  readonly plane: RoutePlane;
  /** Exact pathnames this module answers. */
  readonly paths?: readonly string[];
  /** Prefixes: `p` itself and anything under `p/`. */
  readonly prefixes?: readonly string[];
  /** Regex-shaped paths (Gemini `models/{m}:verb`, Bedrock `/v1/model/…`). */
  readonly patterns?: readonly RegExp[];
  register(app: GatewayApp, ctx: RouteContext): void;
}

/** Everything a route module needs from the app builder. */
export interface RouteContext {
  readonly config: GatewayConfig;
  readonly options: GatewayAppOptions;
  /**
   * Run a body-consuming handler inside a foreground abort scope on the
   * access-stripped request (`c.var.request`).
   */
  foreground(
    handle: (scoped: Request, config: GatewayConfig) => Promise<Response>,
  ): RouteHandler;
  /** The uniform 404, CORS-decorated per the request's plane. */
  notFound(c: GatewayContext): Response;
  /**
   * Hono answers HEAD from the matching GET route; wrap method-specific routes
   * so they only ever serve their declared methods.
   */
  declaredMethodsOnly(
    methods: readonly string[],
    handler: RouteHandler,
  ): RouteHandler;
}
