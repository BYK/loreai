"use strict";
// Worker wrapper for the embedding-cap measurement (eval/measure-embed-cap.mjs).
//
// The bundled gateway worker (dist/embedding-worker.cjs) loads its WASM ONNX
// runtime from `globalThis.__LORE_NPM_WASM_PATHS__`. It only auto-registers
// that global when NOT given a vendorModel — but we DO pass a vendorModel (to
// load the local model with no download), which skips auto-registration. So we
// set the global here (before requiring the worker) to point at the sibling
// ort-wasm files in dist/, then hand off to the real worker entry.
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { workerData } = require("node:worker_threads");

const distDir = workerData._distDir;
globalThis.__LORE_NPM_WASM_PATHS__ = {
  mjs: pathToFileURL(path.join(distDir, "ort-wasm-simd-threaded.mjs")).href,
  wasm: path.join(distDir, "ort-wasm-simd-threaded.wasm"),
};

require(path.join(distDir, "embedding-worker.cjs"));
