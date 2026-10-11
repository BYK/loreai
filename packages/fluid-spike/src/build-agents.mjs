import { gzipSync } from "node:zlib";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const resultDir = resolve(
  process.env.SPIKE_RESULTS_DIR ??
    resolve(packageDir, "../../../spike-results"),
);
const entries = {
  yjs: "src/yjs-client.ts",
  automerge: "src/automerge-client.ts",
  nocrdt: "src/nocrdt-client.ts",
};
await mkdir(resolve(packageDir, "dist"), { recursive: true });
await mkdir(resultDir, { recursive: true });
const results = {};
for (const [variant, entry] of Object.entries(entries)) {
  const warnings = [];
  const outfile = resolve(packageDir, `dist/${variant}-agent.cjs`);
  try {
    const result = await build({
      entryPoints: [resolve(packageDir, entry)],
      outfile,
      bundle: true,
      format: "cjs",
      platform: "node",
      target: "node22",
      minify: true,
      metafile: true,
      external: ["node:*"],
      logLevel: "silent",
      plugins: [
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
    const bytes = (await stat(outfile)).size;
    const runtimeAssets = [];
    if (variant === "automerge") {
      const automergeEntry = fileURLToPath(
        import.meta.resolve("@automerge/automerge"),
      );
      const wasmPath = resolve(
        dirname(automergeEntry),
        "../wasm_bindgen_output/nodejs/automerge_wasm_bg.wasm",
      );
      const outputWasm = resolve(packageDir, "dist/automerge_wasm_bg.wasm");
      await copyFile(wasmPath, outputWasm);
      runtimeAssets.push({
        path: outputWasm,
        bytes: (await stat(outputWasm)).size,
      });
    }
    let runs = false;
    let runError;
    try {
      const module = await import(
        `${new URL(`../dist/${variant}-agent.cjs`, import.meta.url).href}?load=${Date.now()}`
      );
      runs = typeof module.joinDiscussion === "function";
    } catch (error) {
      runError = error instanceof Error ? error.message : String(error);
    }
    results[variant] = {
      path: outfile,
      bytes,
      gzipBytes: gzipSync(await readFile(outfile)).length,
      runtimeAssets,
      warnings,
      loads: runs,
      runError,
      inputs: Object.keys(result.metafile.inputs),
    };
  } catch (error) {
    results[variant] = {
      path: outfile,
      warnings,
      loads: false,
      runError: error instanceof Error ? error.message : String(error),
    };
  }
}
const outputPath = resolve(resultDir, "agent-cjs.json");
await writeFile(outputPath, `${JSON.stringify(results, null, 2)}\n`);
console.log(JSON.stringify({ outputPath, results }, null, 2));
