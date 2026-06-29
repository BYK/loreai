/**
 * Vector-search worker thread — runs the cosine-similarity SQL (native
 * sqlite-vec when available, JS brute-force otherwise) off the main thread.
 *
 * This is the entry point for a `node:worker_threads` Worker spawned by the
 * pool in `vector-pool.ts`. Each worker opens its OWN read-only connection to
 * the same WAL database (see db/reader.ts) and answers `search` requests by
 * running the shared `runVectorQuery()` against that connection. Moving the
 * O(n) scan + BLOB marshalling here keeps the main thread's event loop free so
 * one session's recall/LTM vector work never stalls other sessions' streams.
 *
 * Communication uses `parentPort` structured-clone message passing. The query
 * embedding (~3 KB) is cloned per request; results are plain arrays.
 *
 * @see vector-worker-types.ts for the message protocol.
 */

import { parentPort, workerData } from "node:worker_threads";
import { openReaderConnection, type ReaderConnection } from "./db/reader";
import { resolveReadMode, readStorageMode } from "./db/vec-store";
import { type ReadJobConn, runReadJob } from "./read-job";
import { runVectorQuery } from "./vector-query";
import type {
  VectorWorkerInbound,
  VectorWorkerInitData,
  VectorWorkerOutbound,
} from "./vector-worker-types";

// Only ever loaded as a worker entry point, so `parentPort` is always present.
if (!parentPort) {
  throw new Error("vector-worker must be run as a worker thread");
}
const port = parentPort;

const init = workerData as VectorWorkerInitData;

function post(msg: VectorWorkerOutbound): void {
  port.postMessage(msg);
}

// Open the reader connection eagerly. A failure here (corrupt path, missing
// driver, locked file) is reported as `init-error` so the pool latches this
// worker dead and the main thread falls back to the in-process path — never a
// crash. `reader` stays null on failure and every search replies with an error.
let reader: ReaderConnection | null = null;
try {
  reader = openReaderConnection(init.dbPath);
  post({ type: "ready", vecAvailable: reader.vecAvailable });
} catch (err) {
  post({
    type: "init-error",
    error: err instanceof Error ? err.message : String(err),
  });
  // A failed reader open is persistent — don't linger as an idle thread waiting
  // for searches we can't serve. Exit so the pool reclaims us (its exit handler
  // is idempotent with the init-error above). Deferred so the message flushes.
  setTimeout(() => process.exit(1), 0);
}

let shutdownRequested = false;

port.on("message", (msg: VectorWorkerInbound) => {
  switch (msg.type) {
    case "search": {
      if (shutdownRequested) return;
      const conn = reader;
      if (!conn) {
        post({
          type: "error",
          id: msg.id,
          error: "reader connection unavailable",
        });
        return;
      }
      try {
        // Resolve the read mode per request from this worker's OWN connection
        // (its sqlite-vec availability is fixed at open; the DB's storage mode
        // is read fresh each time so a mid-process blob→vec0 flip on the main
        // thread is picked up via WAL without respawning the worker).
        const readMode = resolveReadMode(
          readStorageMode(conn.db),
          conn.vecAvailable,
        );
        const hits = runVectorQuery(conn.db, readMode, msg.embedding, msg.spec);
        post({ type: "result", id: msg.id, hits });
      } catch (err) {
        // Per-request failure — reject just this request, keep serving. The
        // pool resolves it via the in-process fallback.
        post({
          type: "error",
          id: msg.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      break;
    }
    case "read": {
      if (shutdownRequested) return;
      const conn = reader;
      if (!conn) {
        post({
          type: "error",
          id: msg.id,
          error: "reader connection unavailable",
        });
        return;
      }
      try {
        // The connection is query_only=TRUE, so a read job can only SELECT.
        const rows = runReadJob(conn.db as unknown as ReadJobConn, msg.spec);
        post({ type: "read-result", id: msg.id, rows });
      } catch (err) {
        // Per-request failure — reject just this request, keep serving. The
        // pool resolves it via the in-process fallback.
        post({
          type: "error",
          id: msg.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      break;
    }
    case "shutdown": {
      shutdownRequested = true;
      try {
        (reader?.db as unknown as { close?: () => void })?.close?.();
      } catch {
        // best-effort
      }
      reader = null;
      // Defer exit so the in-flight reply postMessage flushes first.
      setTimeout(() => process.exit(0), 0);
      break;
    }
  }
});
