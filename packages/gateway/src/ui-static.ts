/**
 * ui-static.ts — serves the Lore UI single-page app at /ui and /ui/*.
 *
 * The SPA is a Vite build staged by script/ui-assets.ts as a file tree plus a
 * manifest (ui-manifest.json, see ui-manifest.ts). At runtime the tree is
 * read through one `UiAssetSource`:
 *
 *   - Node SEA binary → `sea.getRawAsset("ui/<path>")` (files embedded by
 *     fossilize from build-binary-sea.ts's asset manifest);
 *   - otherwise      → dist/ui/ next to the bundle (dist/index.cjs,
 *     dist/index.bun.js) or ../dist/ui/ from a source checkout.
 *
 * Request paths are only ever matched against the manifest's key set — the
 * source is asked for manifest keys (and their fixed variant suffixes), never
 * for anything derived from a URL — so there is no path-traversal surface.
 * The manifest is parsed once per generation and bodies are read lazily on
 * first use, then kept in memory (the whole SPA is ~1 MB).
 *
 *   /ui, /ui/                  → index.html (no-cache)
 *   /ui/assets/<hashed file>   → immutable, one-year cache (Vite content-hashes
 *                                everything under assets/)
 *   /ui/<other staged file>    → no-cache (e.g. favicon)
 *   /ui/<client route>         → index.html (history-API fallback)
 *   /ui/assets/<unknown>       → 404 (never fall back to HTML for an asset URL)
 *
 * Compressible assets (js/css/html/svg/json/webmanifest) are staged with
 * precompressed brotli/gzip siblings; `Accept-Encoding` is negotiated per
 * request (server preference br > gzip > identity, client q-values
 * honoured) and such responses always carry `Vary: Accept-Encoding` plus an
 * ETag that differs per encoding. Nothing is compressed at request time.
 *
 * Management authorization (socket peer + Origin/Host checks) happens in
 * server.ts BEFORE this module is imported; this module only decides what to
 * serve once a request has been admitted.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseUiManifest,
  UI_MANIFEST_FILE,
  UI_SEA_ASSET_PREFIX,
  UI_VARIANT_SUFFIX,
  type UiContentEncoding,
  type UiManifest,
} from "./ui-manifest";

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

/** Where staged UI files come from; see the module comment. */
export interface UiAssetSource {
  /** Human-readable origin for diagnostics (a directory, or "SEA assets"). */
  readonly description: string;
  /** True when a source can publish a newer manifest during this process. */
  readonly mutable?: boolean;
  /**
   * Bytes of a staged file by its manifest-relative path (POSIX separators),
   * or null when the file does not exist there.
   */
  read(path: string): Uint8Array<ArrayBuffer> | null;
}

function seaSource(): UiAssetSource | null {
  let sea: typeof import("node:sea");
  try {
    // Not a static import: Bun (the @loreai/opencode in-process gateway) has
    // no node:sea, and a missing builtin must simply mean "not a SEA".
    const builtin = process.getBuiltinModule("node:sea");
    if (typeof builtin?.isSea !== "function" || !builtin.isSea()) return null;
    sea = builtin;
  } catch {
    return null;
  }
  const read = (path: string): Uint8Array<ArrayBuffer> | null => {
    try {
      return new Uint8Array(sea.getRawAsset(`${UI_SEA_ASSET_PREFIX}${path}`));
    } catch {
      return null;
    }
  };

  // The gateway can be loaded inside another Node SEA executable (notably
  // OpenCode's server binary). `node:sea` then reports isSea() === true even
  // though the host binary does not contain Lore's UI assets. Only claim the
  // SEA source when its manifest is actually embedded; otherwise diskSource()
  // must get a chance to find a source-checkout dist/ui tree.
  if (!read(UI_MANIFEST_FILE)) return null;

  return {
    description: "SEA assets",
    read,
  };
}

function directorySource(dir: string): UiAssetSource {
  return {
    description: dir,
    mutable: true,
    read(path) {
      try {
        // Copy into a standalone ArrayBuffer (readFileSync may hand out a
        // slice of Buffer's shared pool for small files).
        return new Uint8Array(readFileSync(join(dir, path)));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
      }
    },
  };
}

function diskSource(): UiAssetSource | null {
  // In the CJS bundle `import.meta.url` is rewritten to the bundle's own file
  // URL (script/import-meta-url.js); in the SEA bundle it is empty, but that
  // path never gets here because seaSource() wins.
  const here: unknown = import.meta.url;
  if (typeof here !== "string" || here === "") return null;
  const candidates = [
    // dist/index.cjs, dist/index.bun.js → dist/ui/
    new URL("./ui/", here),
    // src/ui-static.ts (tsx, vitest, the dev shim) → dist/ui/
    new URL("../dist/ui/", here),
  ];
  for (const url of candidates) {
    if (url.protocol !== "file:") continue;
    const dir = fileURLToPath(url);
    if (existsSync(join(dir, UI_MANIFEST_FILE))) return directorySource(dir);
  }
  return null;
}

interface LoadedUi {
  manifest: UiManifest;
  source: UiAssetSource;
  /** `${encoding}:${path}` → bytes, filled on first use. */
  bodies: Map<string, Uint8Array<ArrayBuffer>>;
  /** Keys of `bodies` the source turned out not to have (logged once). */
  missing: Set<string>;
}

/** undefined = not resolved yet; null = no usable UI. */
let loaded: LoadedUi | null | undefined;
let sourceOverride: UiAssetSource | null = null;
/**
 * A source checkout may be staged after the gateway has already answered its
 * first /ui request (for example, while the OpenCode plugin is starting).
 * Do not permanently cache that transient absence. SEA assets are immutable,
 * but disk and embedding sources can become available after initialization.
 */
let retryUnavailableSource = false;

/**
 * Point the handler at an explicit source (tests, embedding hosts), or pass
 * null to go back to auto-detection. Drops the parsed manifest and every
 * cached body either way.
 */
export function setUiAssetSource(source: UiAssetSource | null): void {
  sourceOverride = source;
  loaded = undefined;
  retryUnavailableSource = false;
}

function load(): LoadedUi | null {
  if (loaded !== undefined) {
    if (loaded !== null && loaded.source.mutable) {
      // Source-checkout staging publishes a new directory beneath the same
      // path. Re-read its manifest so a running gateway switches generations
      // instead of retaining old hashed asset names and body caches.
      const currentSource = sourceOverride ?? diskSource();
      if (currentSource) {
        const raw = currentSource.read(UI_MANIFEST_FILE);
        if (raw) {
          try {
            const manifest = parseUiManifest(Buffer.from(raw).toString("utf8"));
            if (manifest.buildId !== loaded.manifest.buildId) {
              loaded = {
                manifest,
                source: currentSource,
                bodies: new Map(),
                missing: new Set(),
              };
            }
          } catch {
            // Keep serving the last complete generation while a replacement
            // is being published or if its manifest is temporarily invalid.
          }
        }
      }
      return loaded;
    }
    if (loaded !== null || !retryUnavailableSource) return loaded;
    loaded = undefined;
  }

  let source: UiAssetSource | null;
  if (sourceOverride) {
    retryUnavailableSource = true;
    source = sourceOverride;
  } else {
    const sea = seaSource();
    if (sea) {
      retryUnavailableSource = false;
      source = sea;
    } else {
      // A source checkout can stage dist/ui after this module has already
      // been loaded, so retry automatic disk discovery when it is unavailable.
      retryUnavailableSource = true;
      source = diskSource();
    }
  }
  if (!source) {
    loaded = null;
    return loaded;
  }
  const raw = source.read(UI_MANIFEST_FILE);
  if (!raw) {
    loaded = null;
    return loaded;
  }
  try {
    loaded = {
      manifest: parseUiManifest(Buffer.from(raw).toString("utf8")),
      source,
      bodies: new Map(),
      missing: new Set(),
    };
  } catch (err) {
    console.error(
      `[lore] ignoring invalid Lore UI manifest from ${source.description}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    loaded = null;
  }
  return loaded;
}

/** The manifest in use, or null when the UI is unavailable. For tests/tools. */
export function uiAssetManifest(): UiManifest | null {
  return load()?.manifest ?? null;
}

export function uiAssetsAvailable(): boolean {
  return load() !== null;
}

function readBody(
  ui: LoadedUi,
  path: string,
  encoding: UiEncoding,
): Uint8Array<ArrayBuffer> | null {
  const key = `${encoding}:${path}`;
  const cached = ui.bodies.get(key);
  if (cached) return cached;
  if (ui.missing.has(key)) return null;
  const file =
    encoding === "identity" ? path : `${path}${UI_VARIANT_SUFFIX[encoding]}`;
  const body = ui.source.read(file);
  if (body) ui.bodies.set(key, body);
  else {
    ui.missing.add(key);
    console.error(
      `[lore] Lore UI asset ${file} is missing from ${ui.source.description}`,
    );
  }
  return body;
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

function serveAsset(
  req: Request,
  ui: LoadedUi,
  path: string,
  file: UiManifest["files"][string],
): Response {
  const variants = file.variants ?? {};
  const negotiable = Object.keys(variants).length > 0;
  const available = new Set<UiEncoding>(["identity"]);
  for (const encoding of Object.keys(variants) as UiContentEncoding[]) {
    available.add(encoding);
  }
  let encoding: UiEncoding = negotiable
    ? negotiateEncoding(req.headers.get("accept-encoding"), available)
    : "identity";

  let body = readBody(ui, path, encoding);
  if (!body && encoding !== "identity") {
    // A variant the manifest promised is missing from the source: serve
    // identity (with its own ETag) rather than fail the page.
    encoding = "identity";
    body = readBody(ui, path, encoding);
  }
  if (!body) {
    return jsonError(
      500,
      "ui_asset_unreadable",
      `Lore UI asset ${path} is missing from ${ui.source.description}`,
    );
  }

  const baseTag = `${ui.manifest.buildId}-${path}`;
  const etag =
    encoding === "identity" ? `"${baseTag}"` : `"${baseTag}-${encoding}"`;
  const headers = new Headers({
    "content-type": file.type,
    "cache-control": path.startsWith(HASHED_ASSET_PREFIX)
      ? IMMUTABLE_CACHE
      : NO_CACHE,
    etag,
  });
  if (negotiable) headers.set("vary", "Accept-Encoding");
  securityHeaders(headers);

  if (etagMatches(req.headers.get("if-none-match"), etag)) {
    return new Response(null, { status: 304, headers });
  }

  if (encoding !== "identity") headers.set("content-encoding", encoding);
  headers.set("content-length", String(body.byteLength));
  return new Response(req.method === "HEAD" ? null : body, {
    status: 200,
    headers,
  });
}

/**
 * Map a request path under /ui to the staged file it should serve, or null
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

  const files = load()?.manifest.files;
  if (files && Object.hasOwn(files, rel)) return rel;
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

  const ui = load();
  if (!ui) {
    return jsonError(
      503,
      "ui_unavailable",
      "The Lore UI assets are unavailable in this gateway. A source-loaded OpenCode/Pi plugin normally stages them automatically; restart the plugin after pulling UI changes, or run `pnpm --filter @loreai/ui build && pnpm --filter @loreai/gateway build` from the Lore repository root.",
    );
  }

  const path = resolveUiAssetPath(url.pathname);
  const file =
    path && Object.hasOwn(ui.manifest.files, path)
      ? ui.manifest.files[path]
      : undefined;
  if (!path || !file) {
    return jsonError(404, "not_found", `No UI asset at ${url.pathname}`);
  }
  return serveAsset(req, ui, path, file);
}
