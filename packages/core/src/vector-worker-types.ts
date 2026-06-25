// Message protocol for the vector-search read-worker pool.
//
// The pool (vector-pool.ts) on the main thread posts `VectorWorkerInbound`
// messages; the worker (vector-worker.ts) replies with `VectorWorkerOutbound`.
// Kept in a dedicated, dependency-light module so both sides share one
// definition (the worker imports these as types only — erased at compile —
// because it is spawned by the runtime's native resolver).

import type {
  DistillationVectorHit,
  VectorHit,
  VectorQuerySpec,
} from "./vector-query";

/** Passed to the worker via `workerData` at construction time. */
export interface VectorWorkerInitData {
  /** Absolute path to the SQLite database file (same file the main thread
   *  writes; opened read-only here). */
  dbPath: string;
}

/** Main thread → worker. */
export type VectorWorkerInbound =
  | {
      type: "search";
      /** Correlation id, echoed back in the result/error reply. */
      id: number;
      spec: VectorQuerySpec;
      /** Query embedding. Sent by structured clone (≈3 KB for 768 dims). */
      embedding: Float32Array;
    }
  | { type: "shutdown" };

/** Worker → main thread. */
export type VectorWorkerOutbound =
  | { type: "ready"; vecAvailable: boolean }
  | {
      type: "result";
      id: number;
      hits: VectorHit[] | DistillationVectorHit[];
    }
  | { type: "error"; id: number; error: string }
  | { type: "init-error"; error: string };
