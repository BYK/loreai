import { build } from "esbuild";
import { gzipSync } from "node:zlib";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const output = new URL("../dist/node-agent.cjs", import.meta.url);
await mkdir(new URL("../dist/", import.meta.url), { recursive: true });
const result = await build({
  entryPoints: [new URL("./node-client.ts", import.meta.url).pathname],
  outfile: output.pathname,
  bundle: true,
  platform: "node",
  target: "node22",
  conditions: ["node"],
  format: "cjs",
  minify: true,
  metafile: true,
  write: true,
  logLevel: "info",
  legalComments: "none",
});
const contents = await readFile(output);
const outputMetadata = Object.values(result.metafile.outputs)[0];
const report = {
  file: output.pathname,
  rawBytes: contents.byteLength,
  gzipBytes: gzipSync(contents, { level: 9 }).byteLength,
  warnings: result.warnings.map((warning) => warning.text),
  externalizedDependencies: [
    ...new Set(
      outputMetadata.imports
        .filter((item) => item.external)
        .map((item) => item.path),
    ),
  ].sort(),
};
const resultDir = resolve(
  process.env.SPIKE_RESULTS_DIR ?? "../../../spike-results",
);
await mkdir(resultDir, { recursive: true });
await writeFile(
  `${resultDir}/fluid-agent-cjs-build.json`,
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(JSON.stringify(report, null, 2));
