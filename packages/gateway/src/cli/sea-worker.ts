/**
 * Fossilize worker entry — runs inside a worker thread spawned by the
 * main binary process.
 *
 * The main process spawns this via:
 *   new Worker(process.execPath, { workerData, argv: ["--worker"] })
 *
 * The binary's sea-entry.ts detects `--worker` at startup, extracts
 * this CJS from a SEA asset, writes it to a tmp file, and `require()`s
 * it. The native loader shim has already run (esbuild inject:), so
 * `require("onnxruntime-node")` (redirected to onnxruntime-web's
 * Node entry) works correctly.
 *
 * This file is just a thin wrapper that re-exports the existing
 * `packages/core/src/embedding-worker.ts` so the existing worker
 * code (with its message handler, OOM retry, etc.) is the single
 * source of truth.
 */
import "../../../core/src/embedding-worker";
