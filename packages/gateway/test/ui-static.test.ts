/**
 * Regression coverage for the Lore UI static handler (src/ui-static.ts) and
 * its integration with the management boundary in server.ts:
 *   - history-API fallback for /ui, /ui/ and client routes
 *   - hashed assets: correct MIME, immutable caching, ETag/304, 404 (never
 *     HTML) for unknown asset URLs
 *   - index.html: no-cache
 *   - strict CSP + X-Frame-Options on every UI response (kept intact by the
 *     management CORS wrapper)
 *   - method restrictions
 *   - non-loopback peers are refused exactly like /api unless remote
 *     management is enabled
 *
 * Requires the UI to have been embedded (`pnpm --filter @loreai/gateway build`
 * or the root `pnpm test`, whose pretest bundles the gateway).
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { loadConfig, type GatewayConfig } from "../src/config";
import { startServer } from "../src/server";
import {
  handleUIRequest,
  resolveUiAssetPath,
  UI_CONTENT_SECURITY_POLICY,
  uiAssetsAvailable,
} from "../src/ui-static";
import { UI_ASSET_FILES } from "../src/ui-assets.generated";
import { loopbackRequest } from "./helpers/loopback-request";

type ServerHandle = Awaited<ReturnType<typeof startServer>>;

function makeConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    ...loadConfig(),
    port: 0,
    hosts: ["127.0.0.1"],
    debug: false,
    remoteGateway: false,
    hostedMode: false,
    allowRemoteManagement: false,
    ...overrides,
  };
}

function assetPath(ext: string): string {
  const record = UI_ASSET_FILES.find(
    ([path]) => path.startsWith("assets/") && path.endsWith(ext),
  );
  if (!record) {
    throw new Error(
      `no hashed ${ext} asset embedded — run \`pnpm --filter @loreai/gateway build\``,
    );
  }
  return `/ui/${record[0]}`;
}

function direct(path: string, init?: RequestInit): Response {
  const url = new URL(`http://127.0.0.1${path}`);
  return handleUIRequest(new Request(url, init), url);
}

function expectSecurityHeaders(res: Response): void {
  expect(res.headers.get("content-security-policy")).toBe(
    UI_CONTENT_SECURITY_POLICY,
  );
  expect(res.headers.get("content-security-policy")).toContain(
    "frame-ancestors 'none'",
  );
  expect(res.headers.get("x-frame-options")).toBe("DENY");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
}

beforeAll(() => {
  if (!uiAssetsAvailable()) {
    throw new Error(
      "UI assets are not embedded — run `pnpm --filter @loreai/gateway build` first",
    );
  }
});

describe("resolveUiAssetPath", () => {
  test.each(["/ui", "/ui/"])("%s → index.html", (path) => {
    expect(resolveUiAssetPath(path)).toBe("index.html");
  });

  test.each([
    "/ui/fixture",
    "/ui/projects/abc",
    "/ui/projects/abc/knowledge/019e18ec-e328-76c4-9c3c-09dbe8d51c6c",
    "/ui/deep/er/route",
    "/ui/index.html.bak",
  ])("client route %s falls back to index.html", (path) => {
    expect(resolveUiAssetPath(path)).toBe("index.html");
  });

  test("hashed asset paths resolve to the embedded file", () => {
    const js = assetPath(".js");
    expect(resolveUiAssetPath(js)).toBe(js.slice("/ui/".length));
  });

  test.each([
    "/ui/assets/missing-abc123.js",
    "/ui/assets/",
    "/ui/assets/../index.html",
    "/ui/assets/%2e%2e/index.html",
  ])("unknown asset URL %s never falls back to HTML", (path) => {
    expect(resolveUiAssetPath(path)).toBeNull();
  });

  test("malformed percent-encoding is not found rather than thrown", () => {
    expect(resolveUiAssetPath("/ui/assets/%E0%A4%A")).toBeNull();
    expect(resolveUiAssetPath("/ui/%E0%A4%A")).toBeNull();
  });

  test.each(["/uix", "/ui-old", "/api/v1/projects", "/"])(
    "%s is outside the UI",
    (path) => {
      expect(resolveUiAssetPath(path)).toBeNull();
    },
  );
});

describe("handleUIRequest", () => {
  test("serves index.html for the app root with no-cache", async () => {
    for (const path of ["/ui", "/ui/", "/ui/projects/x"]) {
      const res = direct(path);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(res.headers.get("cache-control")).toBe("no-cache");
      expectSecurityHeaders(res);
      const html = await res.text();
      expect(html).toContain('<div id="root">');
      expect(html).toContain('src="/ui/assets/');
    }
  });

  test("serves a hashed script with the JS MIME type and immutable caching", async () => {
    const res = direct(assetPath(".js"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(
      "text/javascript; charset=utf-8",
    );
    expect(res.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(res.headers.get("etag")).toMatch(/^".+"$/);
    expect(res.headers.get("content-length")).toBe(
      String((await res.arrayBuffer()).byteLength),
    );
    expectSecurityHeaders(res);
  });

  test("serves the hashed stylesheet as text/css", () => {
    const res = direct(assetPath(".css"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(res.headers.get("cache-control")).toContain("immutable");
  });

  test("answers 304 for a matching If-None-Match (strong or weak)", () => {
    const path = assetPath(".js");
    const etag = direct(path).headers.get("etag")!;
    for (const header of [etag, `W/${etag}`, `"other", ${etag}`]) {
      const res = direct(path, { headers: { "if-none-match": header } });
      expect(res.status).toBe(304);
      expect(res.headers.get("etag")).toBe(etag);
      expect(res.headers.get("cache-control")).toContain("immutable");
    }
    expect(
      direct(path, { headers: { "if-none-match": '"stale"' } }).status,
    ).toBe(200);
  });

  test("HEAD returns headers without a body", async () => {
    const res = direct(assetPath(".js"), { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(
      "text/javascript; charset=utf-8",
    );
    expect(Number(res.headers.get("content-length"))).toBeGreaterThan(0);
    expect(await res.text()).toBe("");
  });

  test("unknown hashed asset is a JSON 404, never index.html", async () => {
    const res = direct("/ui/assets/index-deadbeef.js");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expectSecurityHeaders(res);
    await expect(res.json()).resolves.toMatchObject({
      type: "error",
      error: { type: "not_found" },
    });
  });

  test.each(["POST", "PUT", "DELETE", "PATCH"])(
    "%s is refused with 405 and no legacy dashboard action runs",
    async (method) => {
      const res = direct("/ui/api/delete/project/anything", { method });
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("GET, HEAD");
      expectSecurityHeaders(res);
      await expect(res.json()).resolves.toMatchObject({
        type: "error",
        error: { type: "method_not_allowed" },
      });
    },
  );

  test("the CSP forbids inline scripts, plugins and framing", () => {
    expect(UI_CONTENT_SECURITY_POLICY).toContain("default-src 'none'");
    expect(UI_CONTENT_SECURITY_POLICY).toContain("script-src 'self'");
    expect(UI_CONTENT_SECURITY_POLICY).not.toContain("unsafe-inline");
    expect(UI_CONTENT_SECURITY_POLICY).not.toContain("unsafe-eval");
    expect(UI_CONTENT_SECURITY_POLICY).toContain("object-src 'none'");
    expect(UI_CONTENT_SECURITY_POLICY).toContain("frame-ancestors 'none'");
    expect(UI_CONTENT_SECURITY_POLICY).toContain("base-uri 'none'");
  });

  test("the built index.html carries no inline script or style", async () => {
    const html = await direct("/ui").text();
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>[^<]/);
    expect(html).not.toContain("<style");
    expect(html).not.toMatch(/\son[a-z]+=/i);
  });
});

describe("UI serving through the gateway", () => {
  let loopback: ServerHandle;
  let remotePeer: ServerHandle;
  let remoteManagementPeer: ServerHandle;

  beforeAll(async () => {
    loopback = await startServer(makeConfig());
    remotePeer = await startServer(makeConfig(), {
      peerAddressForRequest: () => "192.0.2.10",
    });
    remoteManagementPeer = await startServer(
      makeConfig({ allowRemoteManagement: true }),
      { peerAddressForRequest: () => "192.0.2.10" },
    );
  });

  afterAll(async () => {
    await Promise.all([
      loopback.stop(),
      remotePeer.stop(),
      remoteManagementPeer.stop(),
    ]);
  });

  const urlFor = (server: ServerHandle, path: string): string =>
    `http://127.0.0.1:${server.port}${path}`;

  test("deep links reload to index.html with the strict CSP intact", async () => {
    const res = await loopbackRequest(
      urlFor(loopback, "/ui/projects/p1/knowledge/k1"),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    // withManagementCors must not downgrade the UI policy to the bare
    // frame-ancestors directive used for /api.
    expectSecurityHeaders(res);
    expect(await res.text()).toContain('<div id="root">');
  });

  test("hashed assets are served through the server with immutable caching", async () => {
    const res = await loopbackRequest(urlFor(loopback, assetPath(".js")));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(
      "text/javascript; charset=utf-8",
    );
    expect(res.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
    expectSecurityHeaders(res);
  });

  test("/api responses keep their own frame-ancestors policy", async () => {
    const res = await loopbackRequest(urlFor(loopback, "/api/v1/projects"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toBe(
      "frame-ancestors 'none'",
    );
  });

  test("reflects only the validated loopback origin on UI assets", async () => {
    const origin = `http://localhost:${loopback.port}`;
    const res = await loopbackRequest(urlFor(loopback, assetPath(".css")), {
      headers: { origin },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(origin);
    expect(res.headers.get("vary")).toContain("Origin");
  });

  test("GET / still redirects to /ui", async () => {
    const res = await loopbackRequest(urlFor(loopback, "/"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/ui");
  });

  test.each(["/ui", "/ui/", "/ui/fixture", "/ui/projects/p1"])(
    "hides %s from non-loopback peers like the API",
    async (path) => {
      const res = await loopbackRequest(urlFor(remotePeer, path));
      expect(res.status).toBe(404);
      expect(await res.text()).toBe("");
    },
  );

  test("hides hashed assets from non-loopback peers", async () => {
    const res = await loopbackRequest(urlFor(remotePeer, assetPath(".js")));
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("");
  });

  test("serves the SPA and its assets to remote peers only with the override", async () => {
    const page = await loopbackRequest(
      urlFor(remoteManagementPeer, "/ui/fixture"),
    );
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expectSecurityHeaders(page);

    const asset = await loopbackRequest(
      urlFor(remoteManagementPeer, assetPath(".js")),
    );
    expect(asset.status).toBe(200);
    expect(asset.headers.get("cache-control")).toContain("immutable");
  });

  test("legacy dashboard POST actions no longer exist", async () => {
    const res = await loopbackRequest(
      urlFor(loopback, "/ui/api/contradiction/resolve/a/b"),
      { method: "POST" },
    );
    expect(res.status).toBe(405);
  });
});
