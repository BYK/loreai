// Spike #2030: minimal Vite client bundles per option; raw / gzip(9) / brotli(11) bytes.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import {
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import { build } from "vite";

const sizeDir = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(sizeDir, "..");
const resultDir = resolve(
  process.env.SPIKE_RESULTS_DIR ??
    resolve(packageDir, "../../../spike-results"),
);
const workDir = resolve(sizeDir, ".work");
const require = createRequire(import.meta.url);
// lib0 is a transitive dep of yjs/y-protocols; resolve it from y-protocols so the custom provider uses the same copy.
const lib0Dir = dirname(
  createRequire(require.resolve("y-protocols/sync")).resolve(
    "lib0/package.json",
  ),
);

const entries = [
  "baseline",
  "fluid",
  "fluid-tinylicious",
  "yjs-custom",
  "yjs-websocket",
  "automerge-core",
  "automerge-core-base64",
  "automerge-repo",
  "nocrdt",
];

async function files(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await files(path)));
    else if (extname(entry.name) !== ".html") out.push(path);
  }
  return out;
}

function measure(buffer) {
  return {
    raw: buffer.length,
    gzip: gzipSync(buffer, { level: 9 }).length,
    brotli: brotliCompressSync(buffer, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: 11,
        [constants.BROTLI_PARAM_SIZE_HINT]: buffer.length,
      },
    }).length,
  };
}

function sum(list) {
  return list.reduce(
    (a, f) => ({
      raw: a.raw + f.raw,
      gzip: a.gzip + f.gzip,
      brotli: a.brotli + f.brotli,
    }),
    {
      raw: 0,
      gzip: 0,
      brotli: 0,
    },
  );
}

async function measureDir(dir) {
  const perFile = [];
  for (const path of await files(dir)) {
    perFile.push({
      file: relative(dir, path),
      ...measure(await readFile(path)),
    });
  }
  perFile.sort((a, b) => b.raw - a.raw);
  const js = perFile.filter((f) => f.file.endsWith(".js"));
  const wasm = perFile.filter((f) => f.file.endsWith(".wasm"));
  return { total: sum(perFile), js: sum(js), wasm: sum(wasm), perFile };
}

await rm(workDir, { recursive: true, force: true });
const results = {};
for (const name of entries) {
  const root = join(workDir, name);
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, "index.html"),
    `<!doctype html><html><body><script type="module" src="${resolve(sizeDir, "entries", `${name}.ts`)}"></script></body></html>\n`,
  );
  const outDir = join(root, "dist");
  await build({
    root,
    configFile: false,
    logLevel: "warn",
    resolve: {
      alias: [{ find: /^lib0\/(.*)$/, replacement: `${lib0Dir}/$1.js` }],
    },
    build: { outDir, emptyOutDir: true, reportCompressedSize: false },
  });
  results[name] = await measureDir(outDir);
  console.log(name, JSON.stringify(results[name].total));
}

const base = results.baseline.total;
const deltas = Object.fromEntries(
  entries.map((name) => {
    const t = results[name].total;
    return [
      name,
      {
        raw: t.raw - base.raw,
        gzip: t.gzip - base.gzip,
        brotli: t.brotli - base.brotli,
      },
    ];
  }),
);

const uiAssets = resolve(packageDir, "../ui/dist/assets");
let loreUi = null;
try {
  await stat(uiAssets);
  const all = await measureDir(uiAssets);
  const code = all.perFile.filter(
    (f) => f.file.endsWith(".js") || f.file.endsWith(".css"),
  );
  loreUi = { jsAndCss: sum(code), files: code.length };
} catch {
  loreUi = { error: `missing ${uiAssets}; run pnpm --filter @loreai/ui build` };
}

const vitePkg = require("vite/package.json");
const versions = Object.fromEntries(
  [
    "fluid-framework",
    "@fluidframework/tinylicious-client",
    "yjs",
    "y-protocols",
    "y-websocket",
    "@automerge/automerge",
    "@automerge/automerge-repo",
    "@automerge/automerge-repo-network-websocket",
  ].map((p) => [
    p,
    JSON.parse(
      readFileSync(
        resolve(packageDir, "node_modules", p, "package.json"),
        "utf8",
      ),
    ).version,
  ]),
);
versions.lib0 = JSON.parse(
  await readFile(join(lib0Dir, "package.json"), "utf8"),
).version;
const report = {
  node: process.version,
  vite: vitePkg.version,
  versions,
  results,
  deltasVsBaseline: deltas,
  loreUi,
};
await mkdir(resultDir, { recursive: true });
await writeFile(
  join(resultDir, "client-size.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
console.table(
  Object.fromEntries(
    entries.map((n) => [n, { ...deltas[n], wasmGzip: results[n].wasm.gzip }]),
  ),
);
console.log("loreUi", JSON.stringify(loreUi));
