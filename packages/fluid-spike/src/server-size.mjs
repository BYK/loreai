import { gzipSync } from "node:zlib";
import { readFile, mkdir, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageDir, "../..");
const gatewayDir = resolve(repoRoot, "packages/gateway");
const resultDir = resolve(
  process.env.SPIKE_RESULTS_DIR ?? resolve(repoRoot, "../spike-results"),
);
const gatewayPackage = JSON.parse(
  await readFile(resolve(gatewayDir, "package.json"), "utf8"),
);
const entryPoints = {
  yjs: "src/spike-yjs/index.ts",
  automerge: "src/spike-automerge/index.ts",
  nocrdt: "src/spike-nocrdt/routes.ts",
  fluid: "src/fluid/index.ts",
};
const variantIndex = process.argv.indexOf("--variant");
const variants =
  variantIndex >= 0
    ? [process.argv[variantIndex + 1]]
    : ["fluid", "yjs", "automerge", "nocrdt"];
const external = ["node:*", "onnxruntime-node", "sharp", "sqlite-vec"];
const importMetaUrlShim = resolve(gatewayDir, "script/import-meta-url.js");
const sentryBunEntry = createRequire(`${gatewayDir}/`).resolve("@sentry/bun");
const sentryNodeEntry = createRequire(`${sentryBunEntry}/`).resolve(
  "@sentry/node",
);
const sentryNodePlugin = {
  name: "sentry-bun-to-node",
  setup(buildApi) {
    buildApi.onResolve({ filter: /^@sentry\/bun$/ }, () => ({
      path: sentryNodeEntry,
    }));
  },
};
const outputPath = resolve(resultDir, "server-size.json");
await mkdir(resultDir, { recursive: true });
let report = {};
try {
  report = JSON.parse(await readFile(outputPath, "utf8"));
} catch {}

for (const variant of variants) {
  const warnings = [];
  try {
    if (!Object.hasOwn(entryPoints, variant)) {
      throw new Error(`Unknown variant: ${variant}`);
    }
    const result = await build({
      entryPoints: [resolve(gatewayDir, entryPoints[variant])],
      bundle: true,
      format: "cjs",
      target: "node22",
      platform: "node",
      conditions: ["node"],
      external,
      write: false,
      minify: true,
      legalComments: "none",
      logLevel: "silent",
      inject: [importMetaUrlShim],
      define: {
        "import.meta.url": "import_meta_url",
        LORE_CLI_VERSION: JSON.stringify(gatewayPackage.version),
        __SENTRY_DEBUG_ID__: JSON.stringify(
          "00000000-0000-4000-8000-000000000000",
        ),
      },
      metafile: true,
      plugins: [
        sentryNodePlugin,
        {
          name: "capture-warning",
          setup(buildApi) {
            buildApi.onEnd((result) => {
              warnings.push(
                ...(result.warnings ?? []).map((warning) => warning.text),
              );
            });
          },
        },
      ],
    });
    const output = result.outputFiles[0].contents;
    let wasmBytes;
    if (variant === "automerge") {
      const entry = createRequire(`${gatewayDir}/`).resolve(
        "@automerge/automerge",
      );
      const wasmPath = resolve(dirname(entry), "automerge_wasm_bg.wasm");
      const { size } = await stat(wasmPath);
      wasmBytes = size;
    }
    report[variant] = {
      entry: entryPoints[variant],
      bytes: output.byteLength,
      gzipBytes: gzipSync(output, { level: 9 }).byteLength,
      warnings,
      external,
      wasmRuntimeBytes: wasmBytes,
      inputs: Object.keys(result.metafile.inputs),
    };
  } catch (error) {
    report[variant] = {
      entry: entryPoints[variant],
      warnings,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ path: outputPath, report }, null, 2));
