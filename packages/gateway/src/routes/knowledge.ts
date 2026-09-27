/**
 * Cross-project knowledge list and search reads (#1917). Mounted before the
 * management `/api/*` dispatcher so the literal `/api/v1/knowledge/search`
 * route is handled here rather than being interpreted by another route's
 * dynamic `:id` segment.
 *
 * Methods are registered individually; non-GET requests fall through to the
 * existing management dispatcher unchanged. This module declares no
 * `paths`/`prefixes`: `/api` is already claimed by management, and declaring
 * it here would violate the registry's single-owner invariant.
 */
import { withManagementCors } from "../management-access";
import {
  MANAGEMENT_PLANE,
  type GatewayContext,
  type RouteModule,
} from "./types";

export const knowledgeRoutes: RouteModule = {
  name: "knowledge",
  plane: MANAGEMENT_PLANE,
  register(app, ctx) {
    const wrap = (
      fn: (
        knowledge: typeof import("../knowledge-api"),
        url: URL,
      ) => Response | Promise<Response>,
    ) => {
      return async (c: GatewayContext) => {
        const knowledge = await import("../knowledge-api");
        const req = c.var.request;
        return withManagementCors(
          await fn(knowledge, new URL(req.url)),
          c.var.allowedManagementOrigin,
        );
      };
    };

    app.get(
      "/api/v1/knowledge/search",
      ctx.declaredMethodsOnly(
        ["GET"],
        wrap((knowledge, url) => knowledge.handleSearchKnowledge(url)),
      ),
    );
    app.get(
      "/api/v1/knowledge",
      ctx.declaredMethodsOnly(
        ["GET"],
        wrap((knowledge, url) => knowledge.handleListAllKnowledge(url)),
      ),
    );
  },
};
