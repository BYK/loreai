/**
 * Regression coverage for the Lore UI static handler (src/ui-static.ts) and
 * its integration with the management boundary in server.ts:
 *   - history-API fallback for /ui, /ui/ and client routes
 *   - hashed assets: correct MIME, immutable caching, ETag/304, 404 (never
 *     HTML) for unknown asset URLs
 *   - index.html: no-cache
 *   - Accept-Encoding negotiation over the precompressed variants (br > gzip >
 *     identity, q-values, malformed headers, per-encoding ETags, Vary; codings
 *     we do not embed, such as zstd, are never sent even when advertised)
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
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { loadConfig, type GatewayConfig } from "../src/config";
import { startServer } from "../src/server";
import {
  handleUIRequest,
  negotiateEncoding,
  parseAcceptEncoding,
  resolveUiAssetPath,
  UI_CONTENT_SECURITY_POLICY,
  uiAssetsAvailable,
  type UiEncoding,
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

function embeddedVariants(path: string): Set<UiEncoding> {
  const rel = path.slice("/ui/".length);
  const record = UI_ASSET_FILES.find(([p]) => p === rel);
  if (!record) throw new Error(`no embedded asset at ${path}`);
  return new Set<UiEncoding>(["identity", ...record[4].map(([enc]) => enc)]);
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
    // No Accept-Encoding → identity, but the representation still varies.
    expect(res.headers.get("vary")).toBe("Accept-Encoding");
    expect(res.headers.get("content-encoding")).toBeNull();
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

describe("parseAcceptEncoding", () => {
  test("absent or empty header accepts anything", () => {
    expect(parseAcceptEncoding(null)).toEqual(new Map());
    expect(parseAcceptEncoding("")).toEqual(new Map());
    expect(parseAcceptEncoding("   ")).toEqual(new Map());
  });

  test("parses codings with q-values, case-insensitively, aliasing x-gzip", () => {
    expect(
      parseAcceptEncoding(
        "GZIP, Br;q=0.9, zstd ; q=1.0, identity;q=0, *;q=0.1",
      ),
    ).toEqual(
      new Map([
        ["gzip", 1],
        ["br", 0.9],
        ["zstd", 1],
        ["identity", 0],
        ["*", 0.1],
      ]),
    );
    expect(parseAcceptEncoding("x-gzip")).toEqual(new Map([["gzip", 1]]));
  });

  test.each([
    "gzip;q=abc",
    "gzip;q=1.5",
    "gzip;q=-1",
    "gzip;q=.5",
    "gzip;q=0.1234",
    "gzip;level=9",
    "gzip;q",
    "gz ip",
    "br, ,gzip",
    'gzip"',
    "gzip;q=1;q=0",
  ])("rejects malformed header %j", (header) => {
    expect(parseAcceptEncoding(header)).toBeNull();
  });
});

describe("negotiateEncoding", () => {
  const all = new Set<UiEncoding>(["identity", "br", "gzip"]);
  const gzipOnly = new Set<UiEncoding>(["identity", "gzip"]);
  const identityOnly = new Set<UiEncoding>(["identity"]);

  test.each<[string | null, UiEncoding]>([
    [null, "identity"],
    ["", "identity"],
    ["gzip, deflate, br, zstd", "br"],
    ["gzip, deflate, br", "br"],
    ["gzip, deflate", "gzip"],
    ["deflate", "identity"],
    ["zstd", "identity"],
    ["br", "br"],
    ["gzip", "gzip"],
    ["identity", "identity"],
    ["*", "br"],
    ["gzip, *;q=0.5", "gzip"],
    ["*;q=0.5, gzip;q=0.4", "br"],
    ["gzip;q=1, br;q=0.5", "gzip"],
    ["gzip;q=0.5, br;q=0.5", "identity"],
    ["gzip;q=0.5, br;q=0.5, identity;q=0.4", "br"],
    ["zstd, br;q=0, gzip", "gzip"],
    ["gzip;q=0.5", "identity"],
    ["gzip;q=0.5, identity;q=0.4", "gzip"],
    ["identity;q=0, gzip", "gzip"],
    ["identity;q=0, *", "br"],
    ["identity;q=0", "identity"],
    ["*;q=0", "identity"],
    ["*;q=0, br", "br"],
    ["gzip;q=abc", "identity"],
    ["gz ip, br", "identity"],
  ])("Accept-Encoding %j → %s", (header, expected) => {
    expect(negotiateEncoding(header, all)).toBe(expected);
  });

  test("falls back to the next preferred encoding when a variant is missing", () => {
    expect(negotiateEncoding("gzip, br, zstd", gzipOnly)).toBe("gzip");
    expect(negotiateEncoding("br", gzipOnly)).toBe("identity");
    expect(negotiateEncoding("br, gzip;q=0.1", gzipOnly)).toBe("identity");
    expect(negotiateEncoding("br, gzip;q=0.1, identity;q=0", gzipOnly)).toBe(
      "gzip",
    );
    expect(negotiateEncoding("gzip, br, zstd", identityOnly)).toBe("identity");
  });
});

describe("precompressed asset serving", () => {
  const js = () => assetPath(".js");
  const css = () => assetPath(".css");

  const decoders: Record<
    Exclude<UiEncoding, "identity">,
    (b: Buffer) => Buffer
  > = {
    br: (b) => brotliDecompressSync(b),
    gzip: (b) => gunzipSync(b),
  };

  test("the build embeds exactly br and gzip for the app script (no zstd)", () => {
    const variants = embeddedVariants(js());
    expect(variants).toEqual(new Set(["identity", "br", "gzip"]));
    expect(embeddedVariants(css()).has("gzip")).toBe(true);
  });

  test("does not embed variants for fonts", () => {
    expect(embeddedVariants(assetPath(".woff2"))).toEqual(
      new Set(["identity"]),
    );
  });

  test("cached bodies are standalone copies: repeated serves equal the embedded bytes", async () => {
    const path = js();
    const record = UI_ASSET_FILES.find(
      ([p]) => p === path.slice("/ui/".length),
    );
    if (!record) throw new Error(`no embedded asset at ${path}`);
    const source = Buffer.from(record[3], record[2]);
    const brSource = record[4].find(([enc]) => enc === "br")?.[1];
    if (!brSource) throw new Error("no br variant embedded");
    for (let i = 0; i < 3; i++) {
      const identity = Buffer.from(await direct(path).arrayBuffer());
      expect(identity.equals(source)).toBe(true);
      const br = Buffer.from(
        await direct(path, {
          headers: { "accept-encoding": "br" },
        }).arrayBuffer(),
      );
      expect(br.equals(Buffer.from(brSource, "base64"))).toBe(true);
    }
  });

  test.each<[string, UiEncoding]>([
    ["gzip, deflate, br, zstd", "br"],
    ["gzip, deflate, br", "br"],
    ["gzip", "gzip"],
    ["zstd", "identity"],
    ["deflate", "identity"],
  ])(
    "Accept-Encoding %j serves the %s variant whose bytes round-trip to identity",
    async (accept, expected) => {
      const path = js();
      const identity = Buffer.from(await direct(path).arrayBuffer());
      const res = direct(path, { headers: { "accept-encoding": accept } });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-encoding")).toBe(
        expected === "identity" ? null : expected,
      );
      expect(res.headers.get("vary")).toBe("Accept-Encoding");
      expect(res.headers.get("content-type")).toBe(
        "text/javascript; charset=utf-8",
      );
      expect(res.headers.get("cache-control")).toContain("immutable");
      expectSecurityHeaders(res);
      const body = Buffer.from(await res.arrayBuffer());
      expect(res.headers.get("content-length")).toBe(String(body.byteLength));
      if (expected === "identity") {
        expect(body.equals(identity)).toBe(true);
      } else {
        expect(body.byteLength).toBeLessThan(identity.byteLength);
        expect(decoders[expected](body).equals(identity)).toBe(true);
      }
    },
  );

  test("every embedded variant of every asset decodes to its identity bytes", () => {
    for (const [path, , encoding, data, variants] of UI_ASSET_FILES) {
      const identity = Buffer.from(data, encoding);
      for (const [contentEncoding, base64] of variants) {
        const encoded = Buffer.from(base64, "base64");
        expect(encoded.byteLength, `${path} ${contentEncoding}`).toBeLessThan(
          identity.byteLength,
        );
        expect(
          decoders[contentEncoding](encoded).equals(identity),
          `${path} ${contentEncoding} round-trip`,
        ).toBe(true);
      }
    }
  });

  test("index.html is negotiated too and keeps no-cache", () => {
    const res = direct("/ui/projects/deep/link", {
      headers: { "accept-encoding": "br" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBe("br");
    expect(res.headers.get("vary")).toBe("Accept-Encoding");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expectSecurityHeaders(res);
  });

  test("uncompressible assets carry neither Vary nor Content-Encoding", () => {
    const res = direct(assetPath(".woff2"), {
      headers: { "accept-encoding": "gzip, br, zstd" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("font/woff2");
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(res.headers.get("vary")).toBeNull();
    expect(res.headers.get("etag")).not.toMatch(/-(zstd|br|gzip)"$/);
  });

  test("never sends an encoding the client did not list", () => {
    for (const accept of ["deflate", "identity", "compress, deflate;q=0.5"]) {
      const res = direct(js(), { headers: { "accept-encoding": accept } });
      expect(res.headers.get("content-encoding")).toBeNull();
    }
  });

  test("malformed Accept-Encoding degrades to identity", async () => {
    const identity = Buffer.from(await direct(js()).arrayBuffer());
    const res = direct(js(), { headers: { "accept-encoding": "gzip;q=lots" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(res.headers.get("vary")).toBe("Accept-Encoding");
    expect(Buffer.from(await res.arrayBuffer()).equals(identity)).toBe(true);
  });

  test("ETags differ per encoding and revalidate only against their own encoding", () => {
    const path = js();
    const etagFor = (accept?: string): string => {
      const res = direct(path, {
        headers: accept === undefined ? {} : { "accept-encoding": accept },
      });
      const etag = res.headers.get("etag");
      if (!etag) throw new Error(`no ETag for Accept-Encoding ${accept}`);
      return etag;
    };
    const identityTag = etagFor();
    const gzipTag = etagFor("gzip");
    const brTag = etagFor("br");
    expect(gzipTag).toBe(identityTag.replace(/"$/, '-gzip"'));
    expect(brTag).toBe(identityTag.replace(/"$/, '-br"'));
    expect(new Set([identityTag, gzipTag, brTag]).size).toBe(3);

    const fresh = direct(path, {
      headers: { "accept-encoding": "gzip", "if-none-match": gzipTag },
    });
    expect(fresh.status).toBe(304);
    expect(fresh.headers.get("etag")).toBe(gzipTag);
    expect(fresh.headers.get("vary")).toBe("Accept-Encoding");
    expect(fresh.headers.get("cache-control")).toContain("immutable");
    expectSecurityHeaders(fresh);

    // A cached identity/br response is not fresh for a gzip negotiation.
    for (const stale of [identityTag, brTag]) {
      const res = direct(path, {
        headers: { "accept-encoding": "gzip", "if-none-match": stale },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-encoding")).toBe("gzip");
    }
    // And a gzip validator does not satisfy an identity request.
    expect(direct(path, { headers: { "if-none-match": gzipTag } }).status).toBe(
      200,
    );
  });

  test("HEAD reports the encoded Content-Length without a body", async () => {
    const path = js();
    for (const accept of ["gzip", "br", "zstd", ""]) {
      const full = direct(path, { headers: { "accept-encoding": accept } });
      const head = direct(path, {
        method: "HEAD",
        headers: { "accept-encoding": accept },
      });
      expect(head.status).toBe(200);
      expect(head.headers.get("content-encoding")).toBe(
        full.headers.get("content-encoding"),
      );
      expect(head.headers.get("etag")).toBe(full.headers.get("etag"));
      expect(head.headers.get("content-length")).toBe(
        String((await full.arrayBuffer()).byteLength),
      );
      expect(await head.text()).toBe("");
    }
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

  test("the server negotiates br for a browser-style Accept-Encoding and keeps CORS Vary", async () => {
    const origin = `http://localhost:${loopback.port}`;
    const res = await loopbackRequest(urlFor(loopback, assetPath(".js")), {
      headers: { "accept-encoding": "gzip, deflate, br, zstd", origin },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBe("br");
    expect(res.headers.get("vary")).toBe("Accept-Encoding, Origin");
    expectSecurityHeaders(res);
    const body = Buffer.from(await res.arrayBuffer());
    expect(res.headers.get("content-length")).toBe(String(body.byteLength));
    const identity = Buffer.from(await direct(assetPath(".js")).arrayBuffer());
    expect(brotliDecompressSync(body).equals(identity)).toBe(true);
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
