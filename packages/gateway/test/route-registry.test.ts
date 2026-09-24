/**
 * The route registry (INFRA-02) is the single source of truth for both what
 * the Hono app mounts and how the access middleware / raw `upgrade` listener
 * classify a path. These tests pin the derived classifier to the pre-registry
 * hand-written matcher and check that mounted routes and declared paths cannot
 * drift apart.
 */
import { describe, expect, test } from "vitest";
import { createGatewayApp } from "../src/app";
import { loadConfig, type GatewayConfig } from "../src/config";
import {
  classifyPath,
  isDataPlanePath,
  isManagementPath,
  moduleOwnsPath,
  ROUTE_MODULES,
  routeModuleFor,
} from "../src/routes/registry";
import { DATA_PLANE, MANAGEMENT_PLANE } from "../src/routes/types";

function makeConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    ...loadConfig(),
    port: 0,
    debug: false,
    remoteGateway: false,
    hostedMode: false,
    allowRemoteManagement: false,
    ...overrides,
  };
}

const DATA_PLANE_PATHS = [
  "/v1/messages",
  "/v1/chat/completions",
  "/chat/completions",
  "/v1/responses",
  "/v1/codex/responses",
  "/v1/responses/compact",
  "/v1/compact",
  "/v1/models",
  "/v1beta/models/gemini-2.5-pro:generateContent",
  "/v1/models/gemini-2.5-pro:streamGenerateContent",
  "/models/gemini-2.5-flash:generateContent",
  "/v1/model/anthropic.claude-3-5-sonnet-20241022-v2:0/converse",
  "/v1/model/amazon.nova-pro-v1:0/invoke-with-response-stream",
];

const MANAGEMENT_PATHS = [
  "/",
  "/api",
  "/api/",
  "/api/v1/projects",
  "/api/v1/entities",
  "/api/v1/entities/rebuild",
  "/api/v1/entities/019e18ec-e328-76c4-9c3c-09dbe8d51c6c",
  "/ui",
  "/ui/",
  "/ui/index.html",
];

const NEITHER_PATHS = [
  "/health",
  "/_lore/control",
  "/nope",
  "/apix",
  "/api2/v1",
  "/uix",
  "/v1",
  "/v1/",
  "/v1/messages/",
  "/V1/messages",
  "/v1//messages",
  "/v1/%6Dessages",
  "/v1/messages/../messages",
  "/v1beta/models/gemini:countTokens",
  "/v1/model/foo/unknown-verb",
];

describe("classifyPath parity with the hand-written matcher", () => {
  test.each(DATA_PLANE_PATHS)("%s is data plane", (p) => {
    expect(classifyPath(p)).toBe(DATA_PLANE);
    expect(isDataPlanePath(p)).toBe(true);
    expect(isManagementPath(p)).toBe(false);
  });

  test.each(MANAGEMENT_PATHS)("%s is management", (p) => {
    expect(classifyPath(p)).toBe(MANAGEMENT_PLANE);
    expect(isManagementPath(p)).toBe(true);
    expect(isDataPlanePath(p)).toBe(false);
  });

  test.each(NEITHER_PATHS)("%s belongs to neither plane", (p) => {
    expect(classifyPath(p)).toBeNull();
    expect(isDataPlanePath(p)).toBe(false);
    expect(isManagementPath(p)).toBe(false);
  });
});

describe("registry invariants", () => {
  test("indexed lookup agrees with a linear scan of the declarations", () => {
    const probes = [
      ...DATA_PLANE_PATHS,
      ...MANAGEMENT_PATHS,
      ...NEITHER_PATHS,
      "/api//x",
      "/ui/../api",
      "/v1/models/gemini:generateContent",
    ];
    for (const p of probes) {
      expect(routeModuleFor(p)?.name, p).toBe(
        ROUTE_MODULES.find((m) => moduleOwnsPath(m, p))?.name,
      );
    }
  });

  test("module names are unique", () => {
    const names = ROUTE_MODULES.map((m) => m.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("no path is claimed by two modules", () => {
    const declared = ROUTE_MODULES.flatMap((m) => [
      ...(m.paths ?? []),
      ...(m.prefixes ?? []),
      ...(m.prefixes ?? []).map((p) => `${p}/x`),
    ]);
    for (const p of [...declared, ...DATA_PLANE_PATHS, ...MANAGEMENT_PATHS]) {
      const owners = ROUTE_MODULES.filter((m) => moduleOwnsPath(m, p));
      expect(
        owners.map((m) => m.name),
        p,
      ).toHaveLength(1);
    }
  });

  test("every mounted Hono route is claimed by a module (so the middleware classified it)", () => {
    const app = createGatewayApp(makeConfig());
    for (const route of app.routes) {
      if (route.path === "*" || route.path === "/*") continue;
      const probe = route.path.replace(/\/\*$/, "/probe");
      expect(
        routeModuleFor(probe),
        `${route.method} ${route.path}`,
      ).toBeDefined();
    }
  });

  test("every declared exact path and prefix has a mounted route", () => {
    const app = createGatewayApp(makeConfig());
    const mounted = new Set(app.routes.map((r) => r.path));
    for (const m of ROUTE_MODULES) {
      for (const p of m.paths ?? [])
        expect(mounted, `${m.name} ${p}`).toContain(p);
      for (const p of m.prefixes ?? []) {
        expect(mounted.has(p) || mounted.has(`${p}/*`), `${m.name} ${p}`).toBe(
          true,
        );
      }
    }
  });

  test("pattern modules mount a POST catch-all after every exact route", () => {
    const app = createGatewayApp(makeConfig());
    const catchAlls = app.routes
      .map((r, i) => ({ ...r, i }))
      .filter((r) => r.path === "/*" && r.method === "POST");
    const patternModules = ROUTE_MODULES.filter((m) => m.patterns?.length);
    expect(catchAlls).toHaveLength(patternModules.length);
    const firstCatchAll = Math.min(...catchAlls.map((r) => r.i));
    const lastExact = Math.max(
      ...app.routes
        .map((r, i) => ({ ...r, i }))
        .filter((r) => !r.path.includes("*"))
        .map((r) => r.i),
    );
    expect(firstCatchAll).toBeGreaterThan(lastExact);
  });
});

describe("registry-driven access policy", () => {
  const env = { peerAddress: "203.0.113.7" };

  test.each(DATA_PLANE_PATHS)(
    "%s: browser origin is refused with a bodyless 403 before any handler",
    async (p) => {
      const app = createGatewayApp(makeConfig());
      const res = await app.fetch(
        new Request(`http://gateway.local${p}`, {
          method: "POST",
          headers: { origin: "http://evil.example" },
        }),
        env,
      );
      expect(res.status).toBe(403);
      expect(await res.text()).toBe("");
    },
  );

  test.each(DATA_PLANE_PATHS)(
    "%s: hosted mode requires the gateway access token",
    async (p) => {
      const app = createGatewayApp(
        makeConfig({ hostedMode: true, gatewayAuthToken: "tok" }),
      );
      const res = await app.fetch(
        new Request(`http://gateway.local${p}`, { method: "POST" }),
        env,
      );
      expect(res.status).toBe(401);
    },
  );

  test.each(MANAGEMENT_PATHS)(
    "%s: non-loopback peer sees the hidden bodyless 404",
    async (p) => {
      const app = createGatewayApp(makeConfig());
      const res = await app.fetch(new Request(`http://gateway.local${p}`), env);
      expect(res.status).toBe(404);
      expect(await res.text()).toBe("");
      expect(res.headers.get("connection")).toBe("close");
    },
  );

  test("paths outside both planes get the routed 404 (with a body) from a remote peer", async () => {
    const app = createGatewayApp(makeConfig());
    const res = await app.fetch(new Request("http://gateway.local/nope"), env);
    expect(res.status).toBe(404);
    expect(JSON.parse(await res.text())).toMatchObject({
      error: { type: "not_found" },
    });
  });
});
