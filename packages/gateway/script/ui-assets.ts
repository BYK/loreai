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
 * binaries read the same files as SEA assets keyed `ui/<path>` (staged by
 * build-binary-sea.ts, embedded by fossilize). Nothing is generated into
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
import { existsSync } from "node:fs";
import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
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

const CONTENT_TYPES = new Map<string, string>([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".webmanifest", "application/manifest+json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".txt", "text/plain; charset=utf-8"],
  [".png", "image/png"],
  [".ico", "image/x-icon"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

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

type Compressor = (buf: Buffer) => Promise<Buffer>;

const brotliCompress = promisify(zlib.brotliCompress);
const gzip = promisify(zlib.gzip);

function compressors(): Map<UiContentEncoding, Compressor> {
  const out = new Map<UiContentEncoding, Compressor>();
  out.set("br", (buf) =>
    brotliCompress(buf, {
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]:
          zlib.constants.BROTLI_MAX_QUALITY,
        [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.byteLength,
      },
    }),
  );
  out.set("gzip", (buf) => gzip(buf, { level: 9 }));
  return out;
}

/**
 * Every regular file under `dir` as `[absolute, relative-posix]`, sorted by
 * relative path so the build ID digest is independent of directory order.
 * One recursive `readdir` with dirents replaces a stat per entry.
 */
async function walk(dir: string): Promise<Array<[string, string]>> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry): [string, string] => {
      const full = join(entry.parentPath, entry.name);
      return [full, relative(dir, full).split("\\").join("/")];
    })
    .sort(([, a], [, b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** The slice of vite's programmatic API this script relies on. */
interface ViteModule {
  build(config: {
    root: string;
    configFile?: string;
    logLevel?: "info" | "warn" | "error" | "silent";
  }): Promise<unknown>;
}

async function runViteBuild(): Promise<void> {
  // vite is a dependency of packages/ui, not of the gateway: resolve it from
  // there and drive its programmatic API in-process (same config file the
  // `vite build` CLI would load) instead of spawning the CLI.
  const require = createRequire(join(uiDir, "package.json"));
  const vite = (await import(
    pathToFileURL(require.resolve("vite")).href
  )) as ViteModule;
  await vite.build({ root: uiDir, logLevel: "warn" });
}

export interface UiAssetsResult {
  files: number;
  bytes: number;
  buildId: string | null;
  /** Per-file sizes: identity plus every emitted precompressed variant. */
  sizes: UiAssetSizes[];
  /**
   * Every file written under UI_STAGE_DIR, relative with POSIX separators:
   * the SPA files, their precompressed siblings and the manifest. Empty when
   * the UI was not built.
   */
  staged: string[];
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
export async function stageUiAssets(
  opts: { build: "always" | "if-missing" | "never" } = { build: "never" },
): Promise<UiAssetsResult> {
  const hasBuild = existsSync(join(uiDistDir, "index.html"));
  if (opts.build === "always" || (opts.build === "if-missing" && !hasBuild)) {
    await runViteBuild();
  }

  // Own the directory outright so a stale file from a previous build can
  // never be served (or embedded) alongside the new set.
  await rm(UI_STAGE_DIR, { recursive: true, force: true });

  const digest = createHash("sha256");
  const sizes: UiAssetSizes[] = [];
  const staged: string[] = [];
  const manifestFiles: Record<string, UiManifestFile> = Object.create(null);
  let bytes = 0;
  let files = 0;

  if (!existsSync(join(uiDistDir, "index.html"))) {
    return { files, bytes, buildId: null, sizes, staged };
  }

  const compress = compressors();
  const seen = new Set<string>();
  const stage = async (rel: string, data: Buffer | string): Promise<void> => {
    if (seen.has(rel)) {
      throw new Error(
        `packages/ui/dist yields ${rel} twice (variant collision)`,
      );
    }
    seen.add(rel);
    const dest = join(UI_STAGE_DIR, rel);
    await mkdir(dirname(dest), { recursive: true });
    if (typeof data === "string") await copyFile(data, dest);
    else await writeFile(dest, data);
    staged.push(rel);
  };
  const tree = await walk(uiDistDir);
  for (const [, rel] of tree) {
    if (rel === UI_MANIFEST_FILE) {
      throw new Error(
        `packages/ui/dist must not contain ${UI_MANIFEST_FILE} (reserved for the gateway manifest)`,
      );
    }
  }

  // Reads and compressions run concurrently (zlib works off the libuv
  // threadpool); the loop below then folds the results back in tree order so
  // the digest, manifest and `staged` list stay deterministic.
  const prepared = await Promise.all(
    tree.map(async ([full, rel]) => {
      const ext = extname(rel).toLowerCase();
      const buf = await readFile(full);
      const variants: Array<[UiContentEncoding, Buffer]> = [];
      if (COMPRESSIBLE_EXTENSIONS.has(ext)) {
        for (const [name, fn] of compress) {
          const compressed = await fn(buf);
          if (compressed.byteLength < buf.byteLength) {
            variants.push([name, compressed]);
          }
        }
      }
      return { full, rel, ext, buf, variants };
    }),
  );

  for (const { full, rel, ext, buf, variants } of prepared) {
    // The build ID covers identity bytes only, so it does not depend on the
    // compressor set or zlib version of the build host.
    digest.update(rel).update("\0").update(buf);
    bytes += buf.byteLength;
    files++;
    await stage(rel, full);

    const entry: UiManifestFile = {
      type: CONTENT_TYPES.get(ext) ?? "application/octet-stream",
      size: buf.byteLength,
    };
    const variantSizes: UiAssetSizes["variants"] = {};
    for (const [name, compressed] of variants) {
      variantSizes[name] = compressed.byteLength;
      await stage(`${rel}${UI_VARIANT_SUFFIX[name]}`, compressed);
    }
    if (variants.length > 0) entry.variants = variantSizes;
    sizes.push({ path: rel, identity: buf.byteLength, variants: variantSizes });
    manifestFiles[rel] = entry;
  }

  const buildId = digest.digest("hex").slice(0, 16);
  const manifest: UiManifest = {
    version: UI_MANIFEST_VERSION,
    buildId,
    files: manifestFiles,
  };
  await writeFile(
    join(UI_STAGE_DIR, UI_MANIFEST_FILE),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  staged.push(UI_MANIFEST_FILE);
  return { files, bytes, buildId, sizes, staged };
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
export async function ensureUiAssetsStaged(): Promise<void> {
  if (existsSync(join(UI_STAGE_DIR, UI_MANIFEST_FILE))) return;
  await stageUiAssets({ build: "never" });
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  const mode = process.argv[2] ?? "--build";
  if (mode === "--build") {
    const result = await stageUiAssets({ build: "always" });
    console.log(describeUiAssets(result));
  } else if (mode === "--stage") {
    const result = await stageUiAssets({ build: "if-missing" });
    console.log(describeUiAssets(result));
  } else if (mode === "--ensure") {
    await ensureUiAssetsStaged();
  } else if (mode === "--sizes") {
    const result = await stageUiAssets({ build: "never" });
    console.log(formatUiAssetSizeTable(result));
  } else {
    console.error(
      `usage: tsx script/ui-assets.ts [--build | --stage | --ensure | --sizes]`,
    );
    process.exit(2);
  }
}
