/**
 * Model-usage export + consented Model Tides upload routes (#2026). Mounted
 * BEFORE the management module's `/api/*` catch-all so these literal routes
 * win. Methods are registered individually — unregistered requests fall
 * through to the management dispatcher untouched.
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
    const wrapReq = (
      fn: (
        api: typeof import("../model-usage-api"),
        req: Request,
        hostedMode: boolean,
      ) => Response | Promise<Response>,
    ) => {
      return async (c: GatewayContext) => {
        const api = await import("../model-usage-api");
        return withManagementCors(
          await fn(api, c.var.request, ctx.config.hostedMode),
          c.var.allowedManagementOrigin,
        );
      };
    };

    // Literal before any dynamic segment so "export"/"upload" are never read
    // as ids.
    app.get(
      "/api/v1/model-usage/export",
      ctx.declaredMethodsOnly(
        ["GET"],
        wrap((api, url) => api.handleExportModelUsage(url)),
      ),
    );
    app.post(
      "/api/v1/model-usage/upload/share",
      ctx.declaredMethodsOnly(
        ["POST"],
        wrapReq((api, req, hosted) =>
          api.handleModelUsageUploadAction("share", req, hosted),
        ),
      ),
    );
    app.post(
      "/api/v1/model-usage/upload/unshare",
      ctx.declaredMethodsOnly(
        ["POST"],
        wrapReq((api, req, hosted) =>
          api.handleModelUsageUploadAction("unshare", req, hosted),
        ),
      ),
    );
    app.post(
      "/api/v1/model-usage/upload/contribute",
      ctx.declaredMethodsOnly(
        ["POST"],
        wrapReq((api, req, hosted) =>
          api.handleModelUsageUploadAction("contribute", req, hosted),
        ),
      ),
    );
    app.post(
      "/api/v1/model-usage/upload/withdraw",
      ctx.declaredMethodsOnly(
        ["POST"],
        wrapReq((api, req, hosted) =>
          api.handleModelUsageUploadAction("withdraw", req, hosted),
        ),
      ),
    );
    app.post(
      "/api/v1/model-usage/upload/rotate",
      ctx.declaredMethodsOnly(
        ["POST"],
        wrapReq((api, req, hosted) =>
          api.handleModelUsageUploadRotate(req, hosted),
        ),
      ),
    );
    app.get(
      "/api/v1/model-usage/upload",
      ctx.declaredMethodsOnly(
        ["GET"],
        wrap((api) => api.handleGetModelUsageUpload()),
      ),
    );
    app.post(
      "/api/v1/model-usage/upload",
      ctx.declaredMethodsOnly(
        ["POST"],
        wrapReq((api, req, hosted) =>
          api.handlePostModelUsageUpload(req, hosted),
        ),
      ),
    );
    app.delete(
      "/api/v1/model-usage/upload",
      ctx.declaredMethodsOnly(
        ["DELETE"],
        wrapReq((api, req, hosted) =>
          api.handleModelUsageUploadDelete(req, hosted),
        ),
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
