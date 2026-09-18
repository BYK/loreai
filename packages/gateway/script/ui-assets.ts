/**
 * Stage the built Lore UI (packages/ui/dist, produced by Vite) into the
 * gateway's dist/ui/ together with a manifest (dist/ui/ui-manifest.json) and
 * precompressed siblings, so src/ui-static.ts can serve the SPA from files
 * that ship next to the bundle.
 *
 * Every gateway artifact reads the same staged tree through one
 * `readAsset(path)` abstraction: the npm CJS bundle (dist/index.cjs) and the
 * Bun ESM bundle (dist/index.bun.js) read dist/ui/ beside themselves, a plain
 * `tsx src/index.ts` / vitest checkout reads ../dist/ui/, and the Node SEA
 * binaries read the same files as SEA assets keyed `ui/<path>` (the whole
 * tree is embedded as a directory by fossilize, see build-binary-sea.ts). Nothing is generated into
 * src/; dist/ is git-ignored and rebuilt by build.ts, bundle.ts and
 * build-binary-sea.ts.
 *
 * Vite content-hashes everything under dist/assets/, so the gateway can serve
 * that directory with immutable caching; index.html is served no-cache.
 *
 * Compressible text assets additionally get precompressed siblings
 * (`<file>.br`, `<file>.gz`; brotli and gzip at their maximum settings) so the
 * gateway can negotiate `Accept-Encoding` without compressing at request
 * time. A variant is dropped when it is not smaller than the identity bytes.
 * zstd is deliberately not emitted: at its level-22 ceiling it stayed 5–8 %
 * larger than brotli on every asset (brotli's built-in dictionary wins on
 * small text), so it would only grow the artifacts.
 */
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as zlib from "node:zlib";
import {
  UI_MANIFEST_FILE,
  UI_MANIFEST_VERSION,
  UI_VARIANT_SUFFIX,
  type UiContentEncoding,
  type UiManifest,
  type UiManifestFile,
} from "../src/ui-manifest";

const here = dirname(fileURLToPath(import.meta.url));
const packageDir = dirname(here);
const repoRoot = dirname(dirname(packageDir));
const uiDir = join(repoRoot, "packages", "ui");
const uiDistDir = join(uiDir, "dist");

/** Where the staged SPA lives, next to the gateway bundles. */
export const UI_STAGE_DIR = join(packageDir, "dist", "ui");

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

/** Assets worth precompressing; fonts and images are already compressed. */
const COMPRESSIBLE_EXTENSIONS = new Set([
  ".html",
  ".js",
  ".mjs",
  ".css",
  ".json",
  ".webmanifest",
  ".svg",
]);

type Compressor = (buf: Buffer) => Buffer;

function compressors(): Map<UiContentEncoding, Compressor> {
  const out = new Map<UiContentEncoding, Compressor>();
  out.set("br", (buf) =>
    zlib.brotliCompressSync(buf, {
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]:
          zlib.constants.BROTLI_MAX_QUALITY,
        [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.byteLength,
      },
    }),
  );
  out.set("gzip", (buf) => zlib.gzipSync(buf, { level: 9 }));
  return out;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function runViteBuild(): void {
  const require = createRequire(join(uiDir, "package.json"));
  // vite's package exports do not expose its bin; go through package.json.
  const vitePkgPath = require.resolve("vite/package.json");
  const vitePkg = JSON.parse(readFileSync(vitePkgPath, "utf8")) as {
    bin: string | Record<string, string>;
  };
  const binRel =
    typeof vitePkg.bin === "string" ? vitePkg.bin : vitePkg.bin["vite"];
  if (!binRel) throw new Error("vite package.json has no bin entry");
  const viteBin = join(dirname(vitePkgPath), binRel);
  const result = spawnSync(process.execPath, [viteBin, "build"], {
    cwd: uiDir,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`Lore UI build failed (exit ${result.status ?? "signal"})`);
  }
}

export interface UiAssetsResult {
  files: number;
  bytes: number;
  buildId: string | null;
  /** Per-file sizes: identity plus every emitted precompressed variant. */
  sizes: UiAssetSizes[];
}

export interface UiAssetSizes {
  path: string;
  identity: number;
  variants: Partial<Record<UiContentEncoding, number>>;
}

/**
 * (Re)create dist/ui from packages/ui/dist.
 *
 * - `build: "always"`     — run the Vite build first (bundle / binary builds).
 * - `build: "if-missing"` — run it only when packages/ui/dist has no
 *                            index.html (dev shim build / postinstall).
 * - `build: "never"`      — stage whatever is on disk; when nothing was built
 *                            dist/ui is removed and the gateway answers /ui
 *                            with 503.
 */
export function stageUiAssets(
  opts: { build: "always" | "if-missing" | "never" } = { build: "never" },
): UiAssetsResult {
  const hasBuild = existsSync(join(uiDistDir, "index.html"));
  if (opts.build === "always" || (opts.build === "if-missing" && !hasBuild)) {
    runViteBuild();
  }

  // Own the directory outright so a stale file from a previous build can
  // never be served (or embedded) alongside the new set.
  rmSync(UI_STAGE_DIR, { recursive: true, force: true });

  const digest = createHash("sha256");
  const sizes: UiAssetSizes[] = [];
  const manifestFiles: Record<string, UiManifestFile> = Object.create(null);
  let bytes = 0;
  let files = 0;

  if (!existsSync(join(uiDistDir, "index.html"))) {
    return { files, bytes, buildId: null, sizes };
  }

  const compress = compressors();
  const seen = new Set<string>();
  const stage = (rel: string, data: Buffer | null, src?: string): void => {
    if (seen.has(rel)) {
      throw new Error(
        `packages/ui/dist yields ${rel} twice (variant collision)`,
      );
    }
    seen.add(rel);
    const dest = join(UI_STAGE_DIR, rel);
    mkdirSync(dirname(dest), { recursive: true });
    if (src !== undefined) copyFileSync(src, dest);
    else if (data) writeFileSync(dest, data);
  };
  for (const full of walk(uiDistDir)) {
    const rel = relative(uiDistDir, full).split("\\").join("/");
    if (rel === UI_MANIFEST_FILE) {
      throw new Error(
        `packages/ui/dist must not contain ${UI_MANIFEST_FILE} (reserved for the gateway manifest)`,
      );
    }
    const ext = extname(full).toLowerCase();
    const contentType = CONTENT_TYPES[ext] ?? "application/octet-stream";
    const buf = readFileSync(full);
    // The build ID covers identity bytes only, so it does not depend on the
    // compressor set or zlib version of the build host.
    digest.update(rel).update("\0").update(buf);
    bytes += buf.byteLength;
    files++;
    stage(rel, null, full);

    const entry: UiManifestFile = { type: contentType, size: buf.byteLength };
    const variantSizes: UiAssetSizes["variants"] = {};
    if (COMPRESSIBLE_EXTENSIONS.has(ext)) {
      for (const [name, fn] of compress) {
        const compressed = fn(buf);
        if (compressed.byteLength >= buf.byteLength) continue;
        variantSizes[name] = compressed.byteLength;
        stage(`${rel}${UI_VARIANT_SUFFIX[name]}`, compressed);
      }
      if (Object.keys(variantSizes).length > 0) entry.variants = variantSizes;
    }
    sizes.push({ path: rel, identity: buf.byteLength, variants: variantSizes });
    manifestFiles[rel] = entry;
  }

  const buildId = digest.digest("hex").slice(0, 16);
  const manifest: UiManifest = {
    version: UI_MANIFEST_VERSION,
    buildId,
    files: manifestFiles,
  };
  writeFileSync(
    join(UI_STAGE_DIR, UI_MANIFEST_FILE),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return { files, bytes, buildId, sizes };
}

export function describeUiAssets(result: UiAssetsResult): string {
  if (result.files === 0) {
    return "dist/ui: not staged (packages/ui not built)";
  }
  const total = (name: UiContentEncoding) =>
    result.sizes.reduce((sum, s) => sum + (s.variants[name] ?? s.identity), 0);
  const kib = (n: number) => `${(n / 1024).toFixed(1)} KiB`;
  return `dist/ui: ${result.files} files, ${kib(result.bytes)} identity (br ${kib(total("br"))}, gzip ${kib(total("gzip"))}), build ${result.buildId}`;
}

/** Markdown size table (identity / br / gzip per file), for PR bodies. */
export function formatUiAssetSizeTable(result: UiAssetsResult): string {
  const bytes = (n: number) => `${n.toLocaleString("en-US")} B`;
  const cell = (n: number | undefined, identity: number) =>
    n === undefined
      ? "—"
      : `${bytes(n)} (${Math.round((n / identity) * 100)} %)`;
  const rows = result.sizes
    .filter((s) => Object.keys(s.variants).length > 0)
    .map(
      (s) =>
        `| \`${s.path}\` | ${bytes(s.identity)} | ${cell(s.variants.br, s.identity)} | ${cell(s.variants.gzip, s.identity)} |`,
    );
  return [
    "| Asset | identity | br | gzip |",
    "|---|---|---|---|",
    ...rows,
  ].join("\n");
}

/**
 * Stage from an existing packages/ui build only when dist/ui has no manifest
 * yet (vitest global setup): never triggers a Vite build, so an unbuilt UI
 * simply leaves the gateway answering /ui with 503.
 */
export function ensureUiAssetsStaged(): void {
  if (existsSync(join(UI_STAGE_DIR, UI_MANIFEST_FILE))) return;
  stageUiAssets({ build: "never" });
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  const mode = process.argv[2] ?? "--build";
  if (mode === "--build") {
    const result = stageUiAssets({ build: "always" });
    console.log(describeUiAssets(result));
  } else if (mode === "--stage") {
    const result = stageUiAssets({ build: "if-missing" });
    console.log(describeUiAssets(result));
  } else if (mode === "--ensure") {
    ensureUiAssetsStaged();
  } else if (mode === "--sizes") {
    const result = stageUiAssets({ build: "never" });
    console.log(formatUiAssetSizeTable(result));
  } else {
    console.error(
      `usage: tsx script/ui-assets.ts [--build | --stage | --ensure | --sizes]`,
    );
    process.exit(2);
  }
}
