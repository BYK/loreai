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
 * Management authorization (socket peer + Origin/Host checks) happens in
 * server.ts BEFORE this module is imported; this module only decides what to
 * serve once a request has been admitted.
 */
import { UI_ASSET_FILES, UI_BUILD_ID } from "./ui-assets.generated";

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

interface UiAsset {
  body: Uint8Array<ArrayBuffer>;
  contentType: string;
  etag: string;
  cacheControl: string;
}

let assetsByPath: Map<string, UiAsset> | null = null;

function loadAssets(): Map<string, UiAsset> {
  if (assetsByPath) return assetsByPath;
  const map = new Map<string, UiAsset>();
  for (const [path, contentType, encoding, data] of UI_ASSET_FILES) {
    // Copy into a standalone ArrayBuffer (Buffer.from may use the shared pool).
    const body = new Uint8Array(Buffer.from(data, encoding));
    map.set(path, {
      body,
      contentType,
      etag: `"${UI_BUILD_ID ?? "dev"}-${path}"`,
      cacheControl: path.startsWith(HASHED_ASSET_PREFIX)
        ? IMMUTABLE_CACHE
        : NO_CACHE,
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

function serveAsset(req: Request, asset: UiAsset): Response {
  const headers = new Headers({
    "content-type": asset.contentType,
    "cache-control": asset.cacheControl,
    etag: asset.etag,
    vary: "Accept-Encoding",
  });
  securityHeaders(headers);

  if (etagMatches(req.headers.get("if-none-match"), asset.etag)) {
    return new Response(null, { status: 304, headers });
  }

  headers.set("content-length", String(asset.body.byteLength));
  return new Response(req.method === "HEAD" ? null : asset.body, {
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
