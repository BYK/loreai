/**
 * Model-usage export routes (#2026). Mounted BEFORE the management module's
 * `/api/*` catch-all so these literal routes win. Methods are registered
 * individually — non-GET requests fall through to the management dispatcher
 * untouched.
 *
 * The module declares no `paths`/`prefixes`: every route starts with `/api`,
 * which the management module already claims — declaring them here would make
 * the registry's "no path claimed by two modules" invariant fail. The plane
 * still resolves `management` via management's `/api` prefix, and the
 * mounted-route test confirms each registered path is classified. Same
 * pattern as `dashboard.ts`/`knowledge.ts`.
 */
import { withManagementCors } from "../management-access";
import {
  MANAGEMENT_PLANE,
  type GatewayContext,
  type RouteModule,
} from "./types";

export const modelUsageRoutes: RouteModule = {
  name: "model-usage",
  plane: MANAGEMENT_PLANE,
  register(app, ctx) {
    const wrap = (
      fn: (
        api: typeof import("../model-usage-api"),
        url: URL,
      ) => Response | Promise<Response>,
    ) => {
      return async (c: GatewayContext) => {
        const api = await import("../model-usage-api");
        const req = c.var.request;
        return withManagementCors(
          await fn(api, new URL(req.url)),
          c.var.allowedManagementOrigin,
        );
      };
    };

    // Literal before any future dynamic segment so "export" is never read as
    // an id.
    app.get(
      "/api/v1/model-usage/export",
      ctx.declaredMethodsOnly(
        ["GET"],
        wrap((api, url) => api.handleExportModelUsage(url)),
      ),
    );
    app.get(
      "/api/v1/model-usage",
      ctx.declaredMethodsOnly(
        ["GET"],
        wrap((api, url) => api.handleGetModelUsage(url)),
      ),
    );
  },
};
