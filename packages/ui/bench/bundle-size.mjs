// Tree-shaken, minified browser bundle contribution of each library for the
// ~15 UI contract schemas (schemas/<lib>.mjs). Reports raw and gzip bytes.
import { gzipSync } from "node:zlib";
import { build } from "esbuild";

const LIBS = ["zod", "zod-mini", "valibot", "typebox", "arktype"];

const rows = [];
for (const name of LIBS) {
  const result = await build({
    entryPoints: [new URL(`./schemas/${name}.mjs`, import.meta.url).pathname],
    bundle: true,
    minify: true,
    treeShaking: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    write: false,
    logLevel: "silent",
    // The bench module reads process.env; the shipped contracts would not.
    define: { "process.env.BENCH_ARKTYPE_JIT": '"0"' },
  });
  const code = result.outputFiles[0].contents;
  rows.push({
    library: name,
    minifiedKb: +(code.byteLength / 1024).toFixed(1),
    gzipKb: +(gzipSync(code, { level: 9 }).byteLength / 1024).toFixed(1),
  });
}

console.table(rows);
