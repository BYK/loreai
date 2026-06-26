/**
 * Bundle @loreai/gateway into a self-contained CJS package for npm/npx.
 *
 * Produces:
 *   dist/index.cjs — single CJS bundle (gateway + core + all JS deps)
 *   dist/bin.cjs   — thin CLI wrapper with Node.js version check
 *
 * Everything is bundled except:
 *   - node:* built-ins (resolved at runtime)
 *
 * Source code is pure Node.js — no `Bun.*` polyfill layer is needed.
 * (xxHash64 lives in src/xxhash.ts as a standalone module since there is
 * no Node.js equivalent of `Bun.hash.xxHash64`.)
 *
 * Debug IDs are injected into the JS + sourcemap after bundling for Sentry
 * source map resolution. When SENTRY_AUTH_TOKEN is set, sourcemaps are
 * uploaded to Sentry and then deleted (they shouldn't ship to users).
 */
import * as esbuild from "esbuild";
import {
  copyFileSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PLACEHOLDER_DEBUG_ID, injectDebugId } from "./debug-id";
import { findOrtWebDir, ortWebRedirectPlugin } from "./ort-web-plugin";

const here = dirname(fileURLToPath(import.meta.url));
const packageDir = dirname(here);
const repoRoot = dirname(dirname(packageDir));
const distDir = join(packageDir, "dist");

// Read version from package.json for build-time injection
const pkg = JSON.parse(
  readFileSync(join(packageDir, "package.json"), "utf8"),
) as { version: string };

const jsPath = join(distDir, "index.cjs");
const mapPath = join(distDir, "index.cjs.map");

// ---------------------------------------------------------------------------
// Clean + create dist
// ---------------------------------------------------------------------------

rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

// ---------------------------------------------------------------------------
// esbuild: single CJS bundle with polyfills injected
// ---------------------------------------------------------------------------

// External: Node built-ins + native/unused deps from @huggingface/transformers.
// onnxruntime-node: .node native binaries that esbuild can't handle.
// sharp: image processing for vision models, not needed for text embeddings.
// sqlite-vec: resolves a native loadable extension (vec0.{so,dylib,dll}) at
//   runtime via its platform optionalDependency — must stay external. (The SEA
//   binary stubs it and uses the JS fallback for now; embedding the extension
//   as an asset is deferred — see #956.)
const external = ["node:*", "onnxruntime-node", "sharp", "sqlite-vec"];

// Remap @sentry/bun → @sentry/node so the CJS bundle gets Node-native
// Sentry integrations (http server instrumentation via diagnostics_channel)
// instead of @sentry/bun's BunServer integration which uses Bun-only APIs
// (server.reload, headers.toJSON) that the Node.js polyfill doesn't provide.
// Resolve @sentry/node via @sentry/bun (its direct dependency), since
// @sentry/node is not a direct dependency of this package.
const sentryBunEntry = createRequire(`${packageDir}/`).resolve("@sentry/bun");
const sentryNodeEntry = createRequire(`${sentryBunEntry}/`).resolve(
  "@sentry/node",
);
const sentryNodePlugin: esbuild.Plugin = {
  name: "sentry-bun-to-node",
  setup(build) {
    build.onResolve({ filter: /^@sentry\/bun$/ }, () => ({
      path: sentryNodeEntry,
    }));
  },
};

// ESM/CJS interop shim: see script/import-meta-url.js for rationale.
// Injected into every CJS esbuild call so the static `import.meta.url`
// token in source can be safely rewritten via `define` without triggering
// the `empty-import-meta` warning. ESM builds don't need this — esbuild
// emits a real `import.meta` for them.
const importMetaUrlShim = join(packageDir, "script", "import-meta-url.js");

await esbuild.build({
  entryPoints: [join(packageDir, "src/index.ts")],
  bundle: true,
  format: "cjs",
  target: "node22",
  platform: "node",
  // Resolve #db/driver → driver.node.ts (node:sqlite)
  conditions: ["node"],
  external,
  outfile: jsPath,
  sourcemap: true,
  minify: true,
  logLevel: "info",
  legalComments: "none",
  plugins: [sentryNodePlugin],
  // Inject ESM/CJS interop shim so `import.meta.url` can be rewritten
  // via `define` (the static `import.meta` token would otherwise be
  // dropped to empty in CJS output, triggering esbuild's
  // `empty-import-meta` warning).
  inject: [importMetaUrlShim],
  // Build-time constants
  define: {
    "import.meta.url": "import_meta_url",
    LORE_CLI_VERSION: JSON.stringify(pkg.version),
    __SENTRY_DEBUG_ID__: JSON.stringify(PLACEHOLDER_DEBUG_ID),
  },
});

// ---------------------------------------------------------------------------
// Bun ESM bundle — for @loreai/opencode plugin running under Bun
// ---------------------------------------------------------------------------
// Uses conditions: ["bun"] so #db/driver resolves to driver.bun.ts (bun:sqlite).
// Same @sentry/bun → @sentry/node remap as the CJS build — @sentry/node works
// under Bun (proven by getsentry/cli which uses @sentry/node-core under Bun).
// No Node.js polyfills needed — this runs natively under Bun.

await esbuild.build({
  entryPoints: [join(packageDir, "src/index.ts")],
  bundle: true,
  format: "esm",
  target: "esnext",
  platform: "node",
  conditions: ["bun"],
  // @loreai/core MUST be external in the Bun ESM bundle. When the gateway
  // runs in-process alongside the OpenCode plugin, both must share a single
  // module instance of @loreai/core — specifically the _originalFetch
  // variable in fetch-interceptor.ts. If core is bundled into the gateway,
  // installFetchInterceptor() (called by the plugin) sets _originalFetch
  // on the plugin's copy while getOriginalFetch() (called by the gateway)
  // reads from the bundled copy (always null → returns globalThis.fetch =
  // the interceptor). This creates an infinite request loop: gateway →
  // interceptor → gateway → interceptor → …
  //
  // `undici` is external (and lazily imported only on the Node path in
  // fetch.ts) so it is never bundled or evaluated under Bun — real undici@7
  // hangs on streaming response reads under Bun, so the Bun path uses native
  // fetch instead and never touches undici.
  //
  // NOTE: undici is external here but only a devDependency — the same shape
  // that broke @loreai/core in #998. It stays safe ONLY because the Bun path
  // never imports it (the undici import is Node-only and lazy). If the Bun
  // path ever imports undici, it must become a runtime dependency. By
  // contrast, @loreai/core IS imported under Bun, so it is a runtime
  // dependency (guarded by test/bundle-exports.test.ts).
  external: [
    "bun:*",
    "node:*",
    "undici",
    "onnxruntime-node",
    "sharp",
    "sqlite-vec",
    "@loreai/core",
  ],
  outfile: join(distDir, "index.bun.js"),
  sourcemap: false,
  minify: true,
  logLevel: "info",
  legalComments: "none",
  plugins: [sentryNodePlugin],
  define: {
    LORE_CLI_VERSION: JSON.stringify(pkg.version),
    __SENTRY_DEBUG_ID__: JSON.stringify(PLACEHOLDER_DEBUG_ID),
  },
});

// ---------------------------------------------------------------------------
// Embedding worker — separate CJS file next to index.cjs
// ---------------------------------------------------------------------------
// LocalProvider in core/embedding.ts spawns this via node:worker_threads.
// The binary build has its own vendored path (__LORE_VENDOR_WORKER_URL__),
// but the npm CJS bundle needs an actual file alongside index.cjs.

await esbuild.build({
  entryPoints: [join(packageDir, "..", "core", "src", "embedding-worker.ts")],
  bundle: true,
  format: "cjs",
  target: "node22",
  platform: "node",
  conditions: ["node"],
  // onnxruntime-node is redirected to onnxruntime-web (WASM) by the plugin so
  // the npm bundle has no native-module dependency. The WASM runtime files are
  // copied into dist/ below and located at runtime via __LORE_NPM_WASM_PATHS__
  // (set in embedding-worker.ts). sharp is stubbed by the plugin.
  plugins: [
    ortWebRedirectPlugin({
      repoRoot,
      wasmPathsExpr:
        "globalThis.__LORE_NPM_WASM_PATHS__ || ONNX_ENV.wasm.wasmPaths",
    }),
  ],
  outfile: join(distDir, "embedding-worker.cjs"),
  sourcemap: false,
  minify: true,
  logLevel: "info",
  legalComments: "none",
  inject: [importMetaUrlShim],
  define: {
    "import.meta.url": "import_meta_url",
  },
});

// ---------------------------------------------------------------------------
// Embedding worker (ESM) — for the Bun ESM bundle
// ---------------------------------------------------------------------------
// The Bun ESM bundle resolves the worker via import.meta.url →
// ./embedding-worker.js (see core/src/embedding.ts:300-303).

await esbuild.build({
  entryPoints: [join(packageDir, "..", "core", "src", "embedding-worker.ts")],
  bundle: true,
  format: "esm",
  target: "esnext",
  platform: "node",
  conditions: ["bun"],
  external: ["bun:*", "node:*"],
  // Same onnxruntime-node → onnxruntime-web redirect as the CJS worker, for
  // consistency and defense-in-depth. NOTE: this is NOT the worker the
  // opencode/pi (Bun) path actually loads — under Bun, the gateway bundle
  // keeps @loreai/core external (see the index.bun.js build above), so
  // LocalProvider runs from core's own dist and spawns core's
  // dist/bun/embedding-worker.js (which still uses the native onnxruntime-node
  // that ships as a non-optional dep of @huggingface/transformers in a
  // raw-deps install). This gateway-side ESM worker only matters if the
  // gateway's own Bun bundle is run as a standalone worker host. The bug
  // (#763) is on the dist-only CJS path → embedding-worker.cjs (fixed above).
  plugins: [
    ortWebRedirectPlugin({
      repoRoot,
      wasmPathsExpr:
        "globalThis.__LORE_NPM_WASM_PATHS__ || ONNX_ENV.wasm.wasmPaths",
    }),
  ],
  outfile: join(distDir, "embedding-worker.js"),
  sourcemap: false,
  minify: true,
  logLevel: "info",
  legalComments: "none",
});

// ---------------------------------------------------------------------------
// Vector-search worker — separate CJS file next to index.cjs
// ---------------------------------------------------------------------------
// The vector-search read-worker pool (core/vector-pool.ts) spawns this via
// node:worker_threads. Tiny by design: SQLite driver (node:sqlite via the
// "node" condition) + sqlite-vec (external native extension) + the pure
// runVectorQuery logic. No ONNX/transformers, so no ort-web redirect or WASM.

await esbuild.build({
  entryPoints: [join(packageDir, "..", "core", "src", "vector-worker.ts")],
  bundle: true,
  format: "cjs",
  target: "node22",
  platform: "node",
  // Resolve #db/driver → driver.node.ts (node:sqlite)
  conditions: ["node"],
  external: ["node:*", "sqlite-vec"],
  outfile: join(distDir, "vector-worker.cjs"),
  sourcemap: false,
  minify: true,
  logLevel: "info",
  legalComments: "none",
  inject: [importMetaUrlShim],
  define: {
    "import.meta.url": "import_meta_url",
  },
});

// ---------------------------------------------------------------------------
// Vector-search worker (ESM) — for the Bun ESM bundle
// ---------------------------------------------------------------------------
// Resolved by the pool via import.meta.url → ./vector-worker.js under Bun.
// conditions: ["bun"] so #db/driver resolves to driver.bun.ts (bun:sqlite).

await esbuild.build({
  entryPoints: [join(packageDir, "..", "core", "src", "vector-worker.ts")],
  bundle: true,
  format: "esm",
  target: "esnext",
  platform: "node",
  conditions: ["bun"],
  external: ["bun:*", "node:*", "sqlite-vec"],
  outfile: join(distDir, "vector-worker.js"),
  sourcemap: false,
  minify: true,
  logLevel: "info",
  legalComments: "none",
});

// ---------------------------------------------------------------------------
// Ship onnxruntime-web WASM runtime next to the worker bundles
// ---------------------------------------------------------------------------
// The worker bundles redirect onnxruntime-node → onnxruntime-web (WASM). At
// runtime, embedding-worker.ts sets __LORE_NPM_WASM_PATHS__ to these sibling
// files so transformers.js loads the WASM locally instead of from the jsdelivr
// CDN (wrong variant + requires network). Must stay in sync with the `files`
// array in package.json and the runtime block in embedding-worker.ts.
//
// We ship the UNPATCHED ort-wasm-simd-threaded.mjs (unlike the SEA binary,
// which patches its pthread spawn to a no-op). This is safe ONLY because the
// worker forces numThreads=1 (embedding-worker.ts), so ort-web takes the
// single-thread path and never calls its pthread `new Worker(...)` — which
// would otherwise crash under Node, where the worker has no global `Worker`.
// If numThreads ever changes, patch the copied .mjs the way build-binary-sea
// does, or this becomes a latent crash.

const ortWebDir = findOrtWebDir(repoRoot);
for (const wasmFile of [
  "ort-wasm-simd-threaded.mjs",
  "ort-wasm-simd-threaded.wasm",
]) {
  copyFileSync(join(ortWebDir, "dist", wasmFile), join(distDir, wasmFile));
}

// ---------------------------------------------------------------------------
// Debug ID injection + sourcemap upload
// ---------------------------------------------------------------------------

// Inject debug IDs into the JS and sourcemap.
// skipSnippet: true — the IIFE snippet breaks ESM/CJS mixed output. The
// debug ID is instead registered in instrument.ts via the build-time
// __SENTRY_DEBUG_ID__ constant.
let debugId: string | undefined;

try {
  const result = await injectDebugId(jsPath, mapPath, { skipSnippet: true });
  debugId = result.debugId;
  console.log(`✓ Debug ID injected: ${debugId}`);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.warn(`⚠ Debug ID injection failed: ${msg}`);
}

// Replace the placeholder UUID with the real debug ID in the JS bundle.
// Both are 36-char UUIDs so sourcemap character positions stay valid.
if (debugId) {
  try {
    const content = readFileSync(jsPath, "utf-8");
    writeFileSync(jsPath, content.replaceAll(PLACEHOLDER_DEBUG_ID, debugId));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`⚠ Debug ID placeholder replacement failed: ${msg}`);
  }
}

// Upload sourcemaps to Sentry if auth token is available.
// Gracefully skipped in local dev and fork PRs.
let uploaded = false;

if (process.env.SENTRY_AUTH_TOKEN) {
  console.log(`  Uploading sourcemaps to Sentry (release: ${pkg.version})...`);
  try {
    execSync(
      [
        "npx",
        "sentry",
        "sourcemap",
        "upload",
        "dist/",
        "--release",
        pkg.version,
        "--org",
        "byk",
        "--project",
        "loreai-gateway",
        "--url-prefix",
        "~/",
      ].join(" "),
      { cwd: packageDir, stdio: "inherit" },
    );
    uploaded = true;
    console.log("✓ Sourcemaps uploaded to Sentry");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`⚠ Sourcemap upload failed: ${msg}`);
  }
} else {
  console.log("  No SENTRY_AUTH_TOKEN — skipping sourcemap upload");
}

// Delete .map files after successful upload — they shouldn't ship to users.
// Keep them on upload failure so a retry doesn't require a full rebuild.
if (uploaded) {
  try {
    unlinkSync(mapPath);
    console.log("✓ Sourcemap deleted (uploaded to Sentry)");
  } catch {
    // Ignore — file might already be gone
  }
}

// ---------------------------------------------------------------------------
// bin wrapper — dist/bin.cjs
// ---------------------------------------------------------------------------

const binScript = `#!/usr/bin/env node
// lore CLI — Node.js entry point
// Checks Node version, suppresses experimental warnings, runs CLI.
{
  const v = process.versions.node.split(".").map(Number);
  if (v[0] < 22 || (v[0] === 22 && v[1] < 15)) {
    console.error(
      "Error: lore requires Node.js 22.15 or later (found " +
        process.version +
        ").\\n\\n" +
        "Either upgrade Node.js, or install the standalone binary instead:\\n" +
        "  curl -fsSL https://lore.dev/install | bash\\n"
    );
    process.exit(1);
  }
}
{
  const _emit = process.emit;
  process.emit = function (name, ...args) {
    if (name === "warning") return false;
    return _emit.apply(this, [name, ...args]);
  };
}
require("./index.cjs")._cli().catch((e) => {
  if (e) console.error(e);
  process.exitCode = 1;
});
`;

writeFileSync(join(distDir, "bin.cjs"), binScript, { mode: 0o755 });

// ---------------------------------------------------------------------------
// Type declarations — dist/index.d.cts
// ---------------------------------------------------------------------------

const typeDeclarations = `/** Gateway configuration — loaded from environment variables with sensible defaults. */
export interface GatewayConfig {
  /** Port to listen on. Default: 3207. Env: LORE_LISTEN_PORT */
  port: number;
  /** True when the port was explicitly set via LORE_LISTEN_PORT or --port. */
  portExplicit: boolean;
  /**
   * Hosts to bind to. Default: ["127.0.0.1"].
   * Env: LORE_LISTEN_HOST (comma-separated for multiple addresses).
   */
  hosts: string[];
  /** Upstream Anthropic API URL. Default: "https://api.anthropic.com". Env: LORE_UPSTREAM_ANTHROPIC */
  upstreamAnthropic: string;
  /** Upstream OpenAI API URL. Default: "https://api.openai.com". Env: LORE_UPSTREAM_OPENAI */
  upstreamOpenAI: string;
  /** Idle timeout in seconds before triggering background work. Default: 60 */
  idleTimeoutSeconds: number;
  /** Whether to log requests. Default: false. Env: LORE_DEBUG */
  debug: boolean;
}

export interface StartOptions {
  port?: number;
  hosts?: string[];
  debug?: boolean;
  /** Suppress verbose banner (env vars, export hints). Used in embedded mode. */
  quiet?: boolean;
}

export interface GatewayHandle {
  config: GatewayConfig;
  port: number;
  /** Whether this process owns the server (started it). False when reusing an existing instance. */
  owned: boolean;
  /** Shut down the gateway. No-op when owned is false. */
  shutdown: () => Promise<void>;
}

/** Default port preference order when LORE_LISTEN_PORT is not set. */
export declare const DEFAULT_PORTS: readonly [3207, 5673];

/** The primary default port (first in the fallback chain). */
export declare const DEFAULT_PORT: 3207;

/** Load Lore gateway configuration from the environment. */
export declare function loadConfig(): GatewayConfig;

/**
 * Start the Lore gateway server.
 *
 * Prefer startGateway() for most use cases — it handles port fallback,
 * port file management, and existing-instance reuse automatically.
 */
export declare function startServer(config: GatewayConfig): Promise<{
  stop: () => void;
  port: number;
  hosts: string[];
  /** Resolves when all bound servers are listening. */
  ready: Promise<void>;
}>;

/**
 * Start the gateway with port fallback, port file management, and
 * existing-instance detection. This is the recommended entry point
 * for plugins and programmatic use.
 */
export declare function startGateway(opts?: StartOptions): Promise<GatewayHandle>;

/**
 * Probe a running gateway at the given URL via its /health endpoint.
 * Returns true if the response is 2xx, false on any error or timeout.
 */
export declare function probeGateway(baseURL: string, timeoutMs?: number): Promise<boolean>;

/** Read the port file. Returns the port number or null if not found/invalid. */
export declare function readPortFile(): number | null;

/** Reset internal pipeline state (for testing). */
export declare function resetPipelineState(): Promise<void>;

/** CLI entry point — called by dist/bin.cjs. */
export declare function _cli(): Promise<void>;
`;

writeFileSync(join(distDir, "index.d.cts"), typeDeclarations);

console.log(`\n✓ @loreai/gateway npm bundle complete (v${pkg.version})`);
console.log(`  dist/index.cjs            — CJS bundle (Node.js, node:sqlite)`);
console.log(`  dist/index.bun.js         — ESM bundle (Bun, bun:sqlite)`);
console.log(`  dist/embedding-worker.cjs — embedding worker CJS (Node.js)`);
console.log(`  dist/embedding-worker.js  — embedding worker ESM (Bun)`);
console.log(`  dist/vector-worker.cjs    — vector-search worker CJS (Node.js)`);
console.log(`  dist/vector-worker.js     — vector-search worker ESM (Bun)`);
console.log(`  dist/ort-wasm-simd-threaded.{mjs,wasm} — ONNX WASM runtime`);
console.log(`  dist/bin.cjs              — CLI wrapper`);
console.log(`  dist/index.d.cts          — type declarations`);
