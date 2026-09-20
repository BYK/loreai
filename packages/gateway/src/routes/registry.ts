/**
 * Central route registry. `app.ts` mounts every module from `ROUTE_MODULES`
 * in this order; `classifyPath` derives the access-plane classifier from the
 * same declarations, so a path is data-plane or management iff a module here
 * claims it. Classification runs before any Hono route (access middleware) and
 * outside Hono entirely (the raw `upgrade` listener in `server.ts`), which is
 * why it lives on the declarations rather than on the mounted handlers.
 */
import {
  DATA_PLANE,
  MANAGEMENT_PLANE,
  type RouteModule,
  type RoutePlane,
} from "./types";
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

/**
 * Lookup index built once from the declarations: exact paths and prefixes are
 * `Map` hits keyed by the pathname / its first segment, so only the (few)
 * regex modules are probed per request, and only when no exact match won.
 * Preserves `ROUTE_MODULES` precedence: an earlier module's claim wins.
 */
interface RouteIndex {
  readonly exact: ReadonlyMap<string, RouteModule>;
  readonly prefixes: ReadonlyMap<string, RouteModule>;
  readonly patterns: readonly { re: RegExp; module: RouteModule }[];
}

function buildIndex(modules: readonly RouteModule[]): RouteIndex {
  const exact = new Map<string, RouteModule>();
  const prefixes = new Map<string, RouteModule>();
  const patterns: { re: RegExp; module: RouteModule }[] = [];
  for (const module of modules) {
    for (const p of module.paths ?? []) if (!exact.has(p)) exact.set(p, module);
    for (const p of module.prefixes ?? []) {
      if (p.indexOf("/", 1) !== -1) {
        throw new Error(`route prefix must be a single segment: ${p}`);
      }
      if (!prefixes.has(p)) prefixes.set(p, module);
    }
    for (const re of module.patterns ?? []) {
      if (re.global || re.sticky) {
        throw new Error(`route pattern must be stateless: ${re}`);
      }
      patterns.push({ re, module });
    }
  }
  return { exact, prefixes, patterns };
}

const INDEX = buildIndex(ROUTE_MODULES);

function firstSegment(pathname: string): string {
  const end = pathname.indexOf("/", 1);
  return end === -1 ? pathname : pathname.slice(0, end);
}

/** The module whose declared paths claim `pathname`, if any. */
export function routeModuleFor(pathname: string): RouteModule | undefined {
  const exact = INDEX.exact.get(pathname);
  if (exact) return exact;
  const byPrefix = INDEX.prefixes.get(firstSegment(pathname));
  if (byPrefix) return byPrefix;
  for (const { re, module } of INDEX.patterns) {
    if (re.test(pathname)) return module;
  }
  return undefined;
}

/** Access plane for a raw (undecoded, uncollapsed) pathname. */
export function classifyPath(pathname: string): RoutePlane {
  return routeModuleFor(pathname)?.plane ?? null;
}

export function isManagementPath(pathname: string): boolean {
  return classifyPath(pathname) === MANAGEMENT_PLANE;
}

export function isDataPlanePath(pathname: string): boolean {
  return classifyPath(pathname) === DATA_PLANE;
}
