/**
 * Management surface (loopback/authorized peers only, see `managementAccess`):
 *   *   /api/*    → REST API, mounted as a single dispatcher (`api.ts`)
 *   *   /ui, /ui/* → Lore UI single-page app (`ui-static.ts`)
 *   GET /         → redirect to /ui
 *
 * Both `api.ts` and `ui-static.ts` are lazy-imported so the proxy hot path
 * never loads the management code or the embedded UI assets.
 */
import { withManagementCors } from "../management-access";
import {
  MANAGEMENT_PLANE,
  type GatewayContext,
  type RouteModule,
} from "./types";

export const managementRoutes: RouteModule = {
  name: "management",
  plane: MANAGEMENT_PLANE,
  paths: ["/"],
  prefixes: ["/api", "/ui"],
  register(app, ctx) {
    app.all("/api/*", async (c) => {
      // Hono's `/api/*` also matches the bare `/api`, which has never been a
      // route (the dispatcher only owns `/api/`-prefixed paths).
      if (c.req.path === "/api") return ctx.notFound(c);
      const { handleAPIRequest } = await import("../api");
      const req = c.var.request;
      return withManagementCors(
        await handleAPIRequest(req, new URL(req.url), ctx.config),
        c.var.allowedManagementOrigin,
      );
    });

    const ui = async (c: GatewayContext): Promise<Response> => {
      const { handleUIRequest } = await import("../ui-static");
      const req = c.var.request;
      return withManagementCors(
        handleUIRequest(req, new URL(req.url)),
        c.var.allowedManagementOrigin,
      );
    };
    app.all("/ui", ui);
    app.all("/ui/*", ui);

    // Build the redirect manually instead of via Response.redirect(), whose
    // headers are immutable: management CORS could not be applied and the
    // root path would 500 instead of redirecting.
    app.get(
      "/",
      ctx.declaredMethodsOnly(["GET"], (c) =>
        withManagementCors(
          new Response(null, {
            status: 302,
            headers: { location: "/ui" },
          }),
          c.var.allowedManagementOrigin,
        ),
      ),
    );
  },
};
