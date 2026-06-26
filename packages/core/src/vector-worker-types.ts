// Message protocol for the read-worker pool.
//
// The pool (vector-pool.ts) on the main thread posts `VectorWorkerInbound`
// messages; the worker (vector-worker.ts) replies with `VectorWorkerOutbound`.
// Kept in a dedicated, dependency-light module so both sides share one
// definition (the worker imports these as types only — erased at compile —
// because it is spawned by the runtime's native resolver).
//
// The pool serves two job families over the same worker + connection:
//   - "search": typed vector-similarity queries (vector-query.ts), and
//   - "read":   generic parameterized read-only SQL jobs (read-job.ts).
// Both run off the main event loop against each worker's query-only connection.

import type { ReadJobSpec } from "./read-job";
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
  | {
      type: "read";
      /** Correlation id, echoed back in the read-result/error reply. */
      id: number;
      /** Parameterized read-only SQL job (see read-job.ts). */
      spec: ReadJobSpec;
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
  | {
      type: "read-result";
      id: number;
      /** `unknown[]` for `mode: "all"`, the single row (or null) for "get". */
      rows: unknown;
    }
  | { type: "error"; id: number; error: string }
  | { type: "init-error"; error: string };
