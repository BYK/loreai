/**
 * ui-static.ts — serves the Lore UI single-page app at /ui and /ui/*.
 *
 * The SPA is a Vite build embedded at gateway build time (see
 * script/ui-assets.ts → src/ui-assets.generated.ts), so serving never touches
 * the filesystem: every lookup is a Map hit on the embedded manifest and there
 * is no path-traversal surface.
 *
 *   /ui, /ui/                  → index.html (no-cache)
 *   /ui/assets/<hashed file>   → immutable, one-year cache (Vite content-hashes
 *                                everything under assets/)
 *   /ui/<other embedded file>  → no-cache (e.g. favicon)
 *   /ui/<client route>         → index.html (history-API fallback)
 *   /ui/assets/<unknown>       → 404 (never fall back to HTML for an asset URL)
 *
 * Compressible assets (js/css/html/svg/json/webmanifest) are embedded with
 * precompressed brotli/gzip variants; `Accept-Encoding` is negotiated per
 * request (server preference br > gzip > identity, client q-values
 * honoured) and such responses always carry `Vary: Accept-Encoding` plus an
 * ETag that differs per encoding. Nothing is compressed at request time.
 *
 * Management authorization (socket peer + Origin/Host checks) happens in
 * server.ts BEFORE this module is imported; this module only decides what to
 * serve once a request has been admitted.
 */
import {
  UI_ASSET_FILES,
  UI_BUILD_ID,
  type UiContentEncoding,
} from "./ui-assets.generated";

export const UI_BASE_PATH = "/ui";
const HASHED_ASSET_PREFIX = "assets/";

/**
 * Strict CSP for the SPA. Solid sets styles via the CSSOM (element.style),
 * which `style-src 'self'` permits; there are no inline scripts or styles in
 * the Vite output (module preload polyfill disabled). `connect-src 'self'`
 * covers the same-origin /api calls; `frame-ancestors 'none'` keeps the
 * anti-framing guarantee the management surface already had.
 */
export const UI_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join("; ");

const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";
const NO_CACHE = "no-cache";

export type UiEncoding = UiContentEncoding | "identity";

/** Server preference when the client rates several encodings equally. */
export const UI_ENCODING_PREFERENCE: readonly UiEncoding[] = [
  "br",
  "gzip",
  "identity",
];

interface UiAssetVariant {
  body: Uint8Array<ArrayBuffer>;
  etag: string;
}

interface UiAsset {
  contentType: string;
  cacheControl: string;
  /** Always has an `identity` entry; encoded variants only when embedded. */
  variants: ReadonlyMap<UiEncoding, UiAssetVariant>;
  /** True when the asset type is negotiable (has or could have variants). */
  negotiable: boolean;
}

let assetsByPath: Map<string, UiAsset> | null = null;

function toStandalone(buf: Buffer): Uint8Array<ArrayBuffer> {
  // Copy into a standalone ArrayBuffer (Buffer.from may use the shared pool).
  return new Uint8Array(buf);
}

function loadAssets(): Map<string, UiAsset> {
  if (assetsByPath) return assetsByPath;
  const map = new Map<string, UiAsset>();
  for (const [path, contentType, encoding, data, embedded] of UI_ASSET_FILES) {
    const baseTag = `${UI_BUILD_ID ?? "dev"}-${path}`;
    const variants = new Map<UiEncoding, UiAssetVariant>();
    variants.set("identity", {
      body: toStandalone(Buffer.from(data, encoding)),
      etag: `"${baseTag}"`,
    });
    for (const [contentEncoding, base64] of embedded) {
      variants.set(contentEncoding, {
        body: toStandalone(Buffer.from(base64, "base64")),
        etag: `"${baseTag}-${contentEncoding}"`,
      });
    }
    map.set(path, {
      contentType,
      cacheControl: path.startsWith(HASHED_ASSET_PREFIX)
        ? IMMUTABLE_CACHE
        : NO_CACHE,
      variants,
      negotiable: embedded.length > 0,
    });
  }
  assetsByPath = map;
  return map;
}

export function uiAssetsAvailable(): boolean {
  return UI_ASSET_FILES.length > 0;
}

function securityHeaders(headers: Headers): void {
  headers.set("content-security-policy", UI_CONTENT_SECURITY_POLICY);
  headers.set("x-frame-options", "DENY");
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
}

function jsonError(status: number, type: string, message: string): Response {
  const headers = new Headers({
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  securityHeaders(headers);
  return new Response(
    JSON.stringify({ type: "error", error: { type, message } }),
    { status, headers },
  );
}

function etagMatches(ifNoneMatch: string | null, etag: string): boolean {
  if (!ifNoneMatch) return false;
  if (ifNoneMatch.trim() === "*") return true;
  return ifNoneMatch
    .split(",")
    .map((tag) => tag.trim().replace(/^W\//, ""))
    .includes(etag);
}

const CODING_TOKEN = /^(?:\*|[a-z0-9-]+)$/;
const QVALUE = /^(?:0(?:\.\d{1,3})?|1(?:\.0{1,3})?)$/;

/**
 * Parse an Accept-Encoding header into coding → q. Returns null for a
 * malformed header (caller falls back to identity). An absent or empty header
 * yields an empty map, which negotiates to identity: RFC 9110 §12.5.3 lets a
 * server pick any coding when the header is absent, but identity is the only
 * choice every client can consume.
 */
export function parseAcceptEncoding(
  header: string | null,
): Map<string, number> | null {
  const weights = new Map<string, number>();
  if (header === null || header.trim() === "") return weights;
  for (const part of header.split(",")) {
    const [rawCoding, ...params] = part.trim().split(";");
    const coding = (rawCoding ?? "").trim().toLowerCase();
    if (!CODING_TOKEN.test(coding)) return null;
    let q = 1;
    let sawQ = false;
    for (const param of params) {
      const eq = param.indexOf("=");
      if (eq === -1) return null;
      const name = param.slice(0, eq).trim().toLowerCase();
      const value = param.slice(eq + 1).trim();
      if (name !== "q" || sawQ) return null;
      if (!QVALUE.test(value)) return null;
      sawQ = true;
      q = Number(value);
    }
    // x-gzip is a historical alias for gzip.
    weights.set(coding === "x-gzip" ? "gzip" : coding, q);
  }
  return weights;
}

/**
 * Choose the encoding to serve: the acceptable variant with the highest
 * client q, ties broken by UI_ENCODING_PREFERENCE. `identity` is acceptable
 * unless explicitly excluded (`identity;q=0` or a `*;q=0` catch-all); when the
 * client excludes everything we have, identity is served anyway rather than
 * answering 406 for a static page.
 */
export function negotiateEncoding(
  header: string | null,
  available: ReadonlySet<UiEncoding>,
): UiEncoding {
  const weights = parseAcceptEncoding(header);
  if (weights === null) return "identity";
  const wildcard = weights.get("*");
  const weightOf = (coding: UiEncoding): number => {
    const explicit = weights.get(coding);
    if (explicit !== undefined) return explicit;
    if (wildcard !== undefined) return wildcard;
    return coding === "identity" ? 1 : 0;
  };
  let best: UiEncoding = "identity";
  let bestQ = 0;
  for (const coding of UI_ENCODING_PREFERENCE) {
    if (!available.has(coding)) continue;
    const q = weightOf(coding);
    if (q > bestQ) {
      best = coding;
      bestQ = q;
    }
  }
  return best;
}

function serveAsset(req: Request, asset: UiAsset): Response {
  const encoding = asset.negotiable
    ? negotiateEncoding(
        req.headers.get("accept-encoding"),
        new Set(asset.variants.keys()),
      )
    : "identity";
  const variant =
    asset.variants.get(encoding) ?? asset.variants.get("identity");
  if (!variant) throw new Error("UI asset has no identity variant");

  const headers = new Headers({
    "content-type": asset.contentType,
    "cache-control": asset.cacheControl,
    etag: variant.etag,
  });
  if (asset.negotiable) headers.set("vary", "Accept-Encoding");
  securityHeaders(headers);

  if (etagMatches(req.headers.get("if-none-match"), variant.etag)) {
    return new Response(null, { status: 304, headers });
  }

  if (encoding !== "identity") headers.set("content-encoding", encoding);
  headers.set("content-length", String(variant.body.byteLength));
  return new Response(req.method === "HEAD" ? null : variant.body, {
    status: 200,
    headers,
  });
}

/**
 * Map a request path under /ui to the embedded file it should serve, or null
 * for "not found". Exported for tests.
 */
export function resolveUiAssetPath(pathname: string): string | null {
  if (pathname === UI_BASE_PATH || pathname === `${UI_BASE_PATH}/`) {
    return "index.html";
  }
  if (!pathname.startsWith(`${UI_BASE_PATH}/`)) return null;

  let rel: string;
  try {
    rel = decodeURIComponent(pathname.slice(UI_BASE_PATH.length + 1));
  } catch {
    return null;
  }

  const assets = loadAssets();
  if (assets.has(rel)) return rel;
  // Asset URLs never fall back to HTML: a stale hashed filename must 404 so a
  // browser does not execute index.html as a script or style sheet.
  if (rel.startsWith(HASHED_ASSET_PREFIX)) return null;
  return "index.html";
}

export function handleUIRequest(req: Request, url: URL): Response {
  if (req.method !== "GET" && req.method !== "HEAD") {
    const res = jsonError(
      405,
      "method_not_allowed",
      "The Lore UI only serves GET and HEAD requests",
    );
    res.headers.set("allow", "GET, HEAD");
    return res;
  }

  if (!uiAssetsAvailable()) {
    return jsonError(
      503,
      "ui_unavailable",
      "The Lore UI was not built into this gateway (run `pnpm --filter @loreai/gateway build`)",
    );
  }

  const path = resolveUiAssetPath(url.pathname);
  const asset = path ? loadAssets().get(path) : undefined;
  if (!asset) {
    return jsonError(404, "not_found", `No UI asset at ${url.pathname}`);
  }
  return serveAsset(req, asset);
}
