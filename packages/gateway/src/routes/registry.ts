/**
 * Central route registry. `app.ts` mounts every module from `ROUTE_MODULES`
 * in this order; `classifyPath` derives the access-plane classifier from the
 * same declarations, so a path is data-plane or management iff a module here
 * claims it. Classification runs before any Hono route (access middleware) and
 * outside Hono entirely (the raw `upgrade` listener in `server.ts`), which is
 * why it lives on the declarations rather than on the mounted handlers.
 */
import type { RouteModule, RoutePlane } from "./types";
import { anthropicRoutes } from "./anthropic";
import { openaiRoutes } from "./openai";
import { compactRoutes } from "./compact";
import { modelsRoutes } from "./models";
import { controlRoutes } from "./control";
import { managementRoutes } from "./management";
import { geminiRoutes } from "./gemini";
import { bedrockRoutes } from "./bedrock";

/**
 * Mount order. Exact-path modules first; the regex-pattern modules register
 * `POST *` catch-alls and must come after every exact route.
 */
export const ROUTE_MODULES: readonly RouteModule[] = [
  anthropicRoutes,
  openaiRoutes,
  compactRoutes,
  modelsRoutes,
  controlRoutes,
  managementRoutes,
  geminiRoutes,
  bedrockRoutes,
];

export function moduleOwnsPath(module: RouteModule, pathname: string): boolean {
  if (module.paths?.includes(pathname)) return true;
  if (
    module.prefixes?.some((p) => pathname === p || pathname.startsWith(`${p}/`))
  )
    return true;
  return module.patterns?.some((re) => re.test(pathname)) ?? false;
}

/** The module whose declared paths claim `pathname`, if any. */
export function routeModuleFor(pathname: string): RouteModule | undefined {
  return ROUTE_MODULES.find((m) => moduleOwnsPath(m, pathname));
}

/** Access plane for a raw (undecoded, uncollapsed) pathname. */
export function classifyPath(pathname: string): RoutePlane {
  return routeModuleFor(pathname)?.plane ?? null;
}

export function isManagementPath(pathname: string): boolean {
  return classifyPath(pathname) === "management";
}

export function isDataPlanePath(pathname: string): boolean {
  return classifyPath(pathname) === "data";
}
