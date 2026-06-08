// ESM/CJS interop shim: provides `import_meta_url` for the CJS esbuild output.
//
// In ESM source we use the natural `import.meta.url` to resolve sibling files
// (e.g. the embedding worker URL). When esbuild bundles that source to CJS
// for the gateway npm package, it would otherwise emit an empty
// `import.meta` (CJS has no such concept) and a static
// `empty-import-meta` warning fires — even when the `import.meta.url` is
// unreachable at runtime in CJS (e.g. `if (typeof __filename === "string")`
// guard short-circuits).
//
// The shim is injected into every CJS esbuild call (see script/bundle.ts)
// and the `import.meta.url` symbol is rewritten to `import_meta_url` via
// `define`. At runtime in CJS this resolves to the file URL of the bundle
// itself, which is what `pathToFileURL(__filename).href` would have
// produced — semantically identical.
//
// The shim itself is a one-line CJS module that uses `require('url')` to
// avoid adding a static `import` that esbuild might try to optimize.
//
// See: https://github.com/BYK/fossilize/blob/main/import-meta-url.js
export var import_meta_url = require("node:url").pathToFileURL(__filename).href;
