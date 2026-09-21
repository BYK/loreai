/**
 * Dashboard read/edit routes (UI-08, #1823). Mounted BEFORE the management
 * module's `/api/*` catch-all so these routes win. Methods are registered
 * individually — an `all` on `/api/v1/entities/:id` would also match
 * `POST /api/v1/entities/rebuild` (`:id` = "rebuild") and shadow the rebuild
 * POST handlers that stay in api.ts. Non-registered methods fall through to
 * the management catch-all untouched.
 *
 * The module declares no `paths`/`prefixes`: every route starts with `/api`,
 * which the management module already claims — declaring them here would make
 * the registry's "no path claimed by two modules" invariant fail. The plane
 * still resolves `management` via management's `/api` prefix, and the
 * mounted-route test confirms each registered path is classified.
 */
import { withManagementCors } from "../management-access";
import {
  MANAGEMENT_PLANE,
  type GatewayContext,
  type RouteModule,
} from "./types";

export const dashboardRoutes: RouteModule = {
  name: "dashboard",
  plane: MANAGEMENT_PLANE,
  register(app, ctx) {
    const wrap = (
      fn: (
        dash: typeof import("../dashboard-api"),
        req: Request,
        url: URL,
      ) => Response | Promise<Response>,
    ) => {
      return async (c: GatewayContext) => {
        const dash = await import("../dashboard-api");
        const req = c.var.request;
        return withManagementCors(
          await fn(dash, req, new URL(req.url)),
          c.var.allowedManagementOrigin,
        );
      };
    };

    app.get(
      "/api/v1/entities",
      ctx.declaredMethodsOnly(
        ["GET"],
        wrap((dash, _req, url) => dash.handleListEntities(url)),
      ),
    );
    // Literal before `:id` so "rebuild" is never read as an entity id.
    app.get(
      "/api/v1/entities/rebuild",
      ctx.declaredMethodsOnly(
        ["GET"],
        wrap((dash) => dash.handleEntityRebuildStatus()),
      ),
    );
    for (const method of ["get", "patch", "delete"] as const) {
      app[method](
        "/api/v1/entities/:id",
        ctx.declaredMethodsOnly(
          ["GET", "PATCH", "DELETE"],
          wrap((dash, req, url) => dash.handleEntityRequest(req, url)),
        ),
      );
    }
  },
};
