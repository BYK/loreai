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
 *   - the asset source abstraction: an explicit (SEA-style) source, missing
 *     or invalid manifests → 503, variants missing from the source → identity
 *
 * Requires the UI to have been staged (`pnpm --filter @loreai/gateway build`
 * or the root `pnpm test`, whose pretest bundles the gateway).
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { brotliDecompressSync, gunzipSync, gzipSync } from "node:zlib";
import { loadConfig, type GatewayConfig } from "../src/config";
import { startServer } from "../src/server";
import {
  handleUIRequest,
  negotiateEncoding,
  parseAcceptEncoding,
  resolveUiAssetPath,
  setUiAssetSource,
  UI_CONTENT_SECURITY_POLICY,
  uiAssetManifest,
  uiAssetsAvailable,
  type UiAssetSource,
  type UiEncoding,
} from "../src/ui-static";
import {
  UI_MANIFEST_FILE,
  UI_MANIFEST_VERSION,
  UI_VARIANT_SUFFIX,
  type UiContentEncoding,
  type UiManifest,
} from "../src/ui-manifest";
import { UI_STAGE_DIR } from "../script/ui-assets";
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

function manifest(): UiManifest {
  const m = uiAssetManifest();
  if (!m) {
    throw new Error(
      "UI assets are not staged — run `pnpm --filter @loreai/gateway build`",
    );
  }
  return m;
}

function assetPath(ext: string): string {
  const rel = Object.keys(manifest().files).find(
    (path) => path.startsWith("assets/") && path.endsWith(ext),
  );
  if (!rel) {
    throw new Error(
      `no hashed ${ext} asset staged — run \`pnpm --filter @loreai/gateway build\``,
    );
  }
  return `/ui/${rel}`;
}

function stagedVariants(path: string): Set<UiEncoding> {
  const rel = path.slice("/ui/".length);
  const entry = manifest().files[rel];
  if (!entry) throw new Error(`no staged asset at ${path}`);
  return new Set<UiEncoding>([
    "identity",
    ...(Object.keys(entry.variants ?? {}) as UiContentEncoding[]),
  ]);
}

/** Read a staged file straight from dist/ui (the ground truth for bodies). */
function stagedBytes(rel: string): Buffer {
  return readFileSync(join(UI_STAGE_DIR, rel));
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
      "UI assets are not staged — run `pnpm --filter @loreai/gateway build` first",
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

  test("the staged bundle carries no dev/test-only screens or specimen data", () => {
    // Route paths, test ids and specimen ids that exist only in
    // packages/ui/src/routes/Fixture.tsx, routes/BusyFixture.tsx,
    // reader/specimen.ts and compat/.
    const devOnlyMarkers = [
      '"/fixture"',
      '"/_compat"',
      "fixture-banner",
      "spec-sys",
      "link-index",
      "busy-fixture",
    ];
    const { files } = manifest();
    const textAssets = Object.keys(files).filter((path) =>
      /\.(?:js|css|html)$/.test(path),
    );
    expect(textAssets.length).toBeGreaterThan(0);
    for (const path of textAssets) {
      const text = stagedBytes(path).toString("utf8");
      for (const marker of devOnlyMarkers) {
        expect(text, `${path} ships dev-only marker ${marker}`).not.toContain(
          marker,
        );
      }
    }
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

  test("the build stages exactly br and gzip for the app script (no zstd)", () => {
    const variants = stagedVariants(js());
    expect(variants).toEqual(new Set(["identity", "br", "gzip"]));
    expect(stagedVariants(css()).has("gzip")).toBe(true);
  });

  test("does not stage variants for fonts", () => {
    expect(stagedVariants(assetPath(".woff2"))).toEqual(new Set(["identity"]));
  });

  test("cached bodies are standalone copies: repeated serves equal the staged bytes", async () => {
    const path = js();
    const rel = path.slice("/ui/".length);
    const source = stagedBytes(rel);
    const brSource = stagedBytes(`${rel}${UI_VARIANT_SUFFIX.br}`);
    for (let i = 0; i < 3; i++) {
      const identity = Buffer.from(await direct(path).arrayBuffer());
      expect(identity.equals(source)).toBe(true);
      const br = Buffer.from(
        await direct(path, {
          headers: { "accept-encoding": "br" },
        }).arrayBuffer(),
      );
      expect(br.equals(brSource)).toBe(true);
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

  test("every staged variant of every asset decodes to its identity bytes and matches the manifest sizes", () => {
    const { files } = manifest();
    expect(Object.keys(files).length).toBeGreaterThan(0);
    for (const [path, entry] of Object.entries(files)) {
      const identity = stagedBytes(path);
      expect(identity.byteLength, `${path} size`).toBe(entry.size);
      for (const [contentEncoding, size] of Object.entries(
        entry.variants ?? {},
      ) as [UiContentEncoding, number][]) {
        const encoded = stagedBytes(
          `${path}${UI_VARIANT_SUFFIX[contentEncoding]}`,
        );
        expect(encoded.byteLength, `${path} ${contentEncoding} size`).toBe(
          size,
        );
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

  test("the manifest itself and variant siblings are not served as assets", async () => {
    // Not manifest keys → history fallback (HTML), never the raw file.
    for (const path of [
      `/ui/${UI_MANIFEST_FILE}`,
      `/ui/index.html${UI_VARIANT_SUFFIX.br}`,
    ]) {
      const res = direct(path);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    }
    // Under assets/ they are plain 404s.
    const res = direct(`${js()}${UI_VARIANT_SUFFIX.gzip}`);
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({
      error: { type: "not_found" },
    });
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

describe("asset sources (SEA-style in-memory source vs. disk)", () => {
  afterEach(() => setUiAssetSource(null));

  /** In-memory source keyed like sea.getRawAsset("ui/<path>") minus prefix. */
  function memorySource(
    files: Record<string, Uint8Array | string>,
    description = "memory",
  ): UiAssetSource & { reads: string[] } {
    const reads: string[] = [];
    return {
      description,
      reads,
      read(path) {
        reads.push(path);
        if (!Object.hasOwn(files, path)) return null;
        const value = files[path];
        const bytes =
          typeof value === "string" ? Buffer.from(value, "utf8") : value;
        return new Uint8Array(bytes);
      },
    };
  }

  const html = '<!doctype html><div id="root"></div>';
  const script = "console.log('lore')";
  const gz = gzipSync(Buffer.from(script, "utf8"));
  const validManifest: UiManifest = {
    version: UI_MANIFEST_VERSION,
    buildId: "feedfacecafebeef",
    files: {
      "index.html": { type: "text/html; charset=utf-8", size: html.length },
      "assets/app-abc123.js": {
        type: "text/javascript; charset=utf-8",
        size: script.length,
        variants: { gzip: gz.byteLength },
      },
    },
  };

  test("serves from an explicit source, reading the manifest once and bodies lazily", async () => {
    const source = memorySource({
      [UI_MANIFEST_FILE]: JSON.stringify(validManifest),
      "index.html": html,
      "assets/app-abc123.js": script,
      [`assets/app-abc123.js${UI_VARIANT_SUFFIX.gzip}`]: gz,
    });
    setUiAssetSource(source);
    expect(uiAssetsAvailable()).toBe(true);
    expect(source.reads).toEqual([UI_MANIFEST_FILE]);

    const page = direct("/ui/anything");
    expect(page.status).toBe(200);
    expect(await page.text()).toBe(html);
    expect(page.headers.get("etag")).toBe('"feedfacecafebeef-index.html"');
    expect(page.headers.get("vary")).toBeNull();
    expectSecurityHeaders(page);

    const gzipped = direct("/ui/assets/app-abc123.js", {
      headers: { "accept-encoding": "gzip, br" },
    });
    expect(gzipped.status).toBe(200);
    // br is not staged for this file → gzip is the best available encoding.
    expect(gzipped.headers.get("content-encoding")).toBe("gzip");
    expect(gzipped.headers.get("vary")).toBe("Accept-Encoding");
    expect(gzipped.headers.get("etag")).toBe(
      '"feedfacecafebeef-assets/app-abc123.js-gzip"',
    );
    expect(gzipped.headers.get("cache-control")).toContain("immutable");
    expect(
      gunzipSync(Buffer.from(await gzipped.arrayBuffer())).toString("utf8"),
    ).toBe(script);

    // Bodies are cached after the first read.
    direct("/ui/assets/app-abc123.js", {
      headers: { "accept-encoding": "gzip" },
    });
    expect(
      source.reads.filter((p) => p.endsWith(UI_VARIANT_SUFFIX.gzip)),
    ).toHaveLength(1);

    // Unknown hashed assets 404 even though the fallback page exists.
    expect(direct("/ui/assets/other-000.js").status).toBe(404);
  });

  test("a variant the manifest promises but the source lacks falls back to identity with the identity ETag", async () => {
    setUiAssetSource(
      memorySource({
        [UI_MANIFEST_FILE]: JSON.stringify(validManifest),
        "index.html": html,
        "assets/app-abc123.js": script,
        // no .gz sibling
      }),
    );
    const res = direct("/ui/assets/app-abc123.js", {
      headers: { "accept-encoding": "gzip" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(res.headers.get("etag")).toBe(
      '"feedfacecafebeef-assets/app-abc123.js"',
    );
    expect(res.headers.get("content-length")).toBe(String(script.length));
    expect(await res.text()).toBe(script);
  });

  test("an identity file missing from the source is a 500, not a crash or HTML", async () => {
    setUiAssetSource(
      memorySource({
        [UI_MANIFEST_FILE]: JSON.stringify(validManifest),
        "index.html": html,
      }),
    );
    const res = direct("/ui/assets/app-abc123.js");
    expect(res.status).toBe(500);
    expectSecurityHeaders(res);
    await expect(res.json()).resolves.toMatchObject({
      error: { type: "ui_asset_unreadable" },
    });
  });

  test("a source without a manifest means the UI is unavailable (503)", async () => {
    setUiAssetSource(memorySource({ "index.html": html }));
    expect(uiAssetsAvailable()).toBe(false);
    const res = direct("/ui");
    expect(res.status).toBe(503);
    expectSecurityHeaders(res);
    await expect(res.json()).resolves.toMatchObject({
      error: { type: "ui_unavailable" },
    });
  });

  test("retries a source that becomes available after an initial 503", async () => {
    const files: Record<string, Uint8Array | string> = {
      "index.html": html,
    };
    setUiAssetSource(memorySource(files));

    expect(direct("/ui").status).toBe(503);

    // This is the source-checkout startup race: the gateway can answer its
    // first request before the build/staging step has finished.
    files[UI_MANIFEST_FILE] = JSON.stringify(validManifest);
    expect(direct("/ui").status).toBe(200);
    await expect(direct("/ui").text()).resolves.toBe(html);
  });

  test.each<[string, string]>([
    ["truncated JSON", '{"version":1,"buildId":"x","files":{'],
    ["wrong version", JSON.stringify({ ...validManifest, version: 2 })],
    ["empty buildId", JSON.stringify({ ...validManifest, buildId: "" })],
    [
      "path traversal key",
      JSON.stringify({
        ...validManifest,
        files: { "../secret": { type: "text/plain", size: 1 } },
      }),
    ],
    [
      "absolute key",
      JSON.stringify({
        ...validManifest,
        files: { "/etc/passwd": { type: "text/plain", size: 1 } },
      }),
    ],
    [
      "unknown encoding",
      JSON.stringify({
        ...validManifest,
        files: {
          "index.html": {
            type: "text/html",
            size: 1,
            variants: { zstd: 1 },
          },
        },
      }),
    ],
  ])(
    "an invalid manifest (%s) disables the UI instead of serving it",
    (_, text) => {
      setUiAssetSource(
        memorySource({ [UI_MANIFEST_FILE]: text, "index.html": html }),
      );
      expect(uiAssetsAvailable()).toBe(false);
      expect(direct("/ui").status).toBe(503);
      expect(direct("/ui/index.html").status).toBe(503);
    },
  );

  test("manifest keys named like Object.prototype members are plain files", async () => {
    setUiAssetSource(
      memorySource({
        // Object.fromEntries creates own "__proto__" data properties (an
        // object literal would set the prototype instead).
        [UI_MANIFEST_FILE]: JSON.stringify({
          ...validManifest,
          files: Object.fromEntries([
            ...Object.entries(validManifest.files),
            ["__proto__", { type: "text/plain; charset=utf-8", size: 2 }],
            ["constructor", { type: "text/plain; charset=utf-8", size: 2 }],
          ]),
        }),
        ...Object.fromEntries([
          ["index.html", html],
          ["__proto__", "pp"],
          ["constructor", "cc"],
        ]),
      }),
    );
    expect(uiAssetsAvailable()).toBe(true);
    expect(await direct("/ui/__proto__").text()).toBe("pp");
    expect(await direct("/ui/constructor").text()).toBe("cc");
    // Inherited names that are NOT in the manifest fall back to the page.
    expect(direct("/ui/toString").headers.get("content-type")).toBe(
      "text/html; charset=utf-8",
    );
    expect(direct("/ui/assets/hasOwnProperty").status).toBe(404);
  });

  test("resetting to auto-detection serves the staged build again", () => {
    setUiAssetSource(memorySource({}));
    expect(uiAssetsAvailable()).toBe(false);
    setUiAssetSource(null);
    expect(uiAssetsAvailable()).toBe(true);
    expect(direct(assetPath(".js")).status).toBe(200);
  });
});
