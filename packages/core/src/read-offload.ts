// Read-offload helpers: route a heavy, staleness-TOLERANT read-only SQL query
// to the read-worker pool. Production never reruns a failed heavy read on the
// gateway thread; only unit tests without a worker factory run in-process.
//
// This is the single place that pairs `tryPoolRead()` (off-thread) with the
// IDENTICAL test-only in-process query. Callers map/hydrate the returned rows
// on the main thread (the worker only runs the raw query — see read-job.ts).
//
// Only use this for reads that tolerate a (currently non-existent, but
// forward-compatible) replica lag: knowledge / lat / cross-project FTS + scans.
// Reads that must observe THIS request's just-written rows (e.g. the current
// session's freshly-stored messages) must stay on the writer connection. The
// `ensureProject()` resolution and any write must also stay on the main thread;
// pass the resolved `pid` in as a param.

import { db } from "./db";
import type { ReadParam } from "./read-job";
import {
  inProcessReadFallbackForTest,
  READ_JOB_TIMED_OUT,
  tryPoolRead,
} from "./vector-pool";

// Re-exported so callers that coordinate several reads (e.g. forSession's two
// candidate scans) can detect a per-read timeout and degrade them together.
export { READ_JOB_TIMED_OUT } from "./vector-pool";

/** Worker unavailable/disabled/broken is different from a query timeout.
 * Neither is a trustworthy empty result for required prompt preparation. */
export const READ_JOB_UNAVAILABLE = Symbol("read-job-unavailable");
export type ReadJobFailure =
  | typeof READ_JOB_TIMED_OUT
  | typeof READ_JOB_UNAVAILABLE;

export function isReadJobFailure(value: unknown): value is ReadJobFailure {
  return value === READ_JOB_TIMED_OUT || value === READ_JOB_UNAVAILABLE;
}

/** Fixed diagnostic; callers must not put SQL, row data or tenant IDs here. */
export class ReadPreparationUnavailableError extends Error {
  constructor(
    readonly phase:
      | "knowledge"
      | "entities"
      | "distillations"
      | "references"
      | "context"
      | "lat",
    readonly reason: "timeout" | "unavailable",
  ) {
    super(`Read preparation unavailable (${phase}: ${reason})`);
    this.name = "ReadPreparationUnavailableError";
  }
}

export function requireReadRows(
  result: unknown[] | ReadJobFailure,
  phase: ReadPreparationUnavailableError["phase"],
): unknown[] {
  if (isReadJobFailure(result)) {
    throw new ReadPreparationUnavailableError(
      phase,
      result === READ_JOB_TIMED_OUT ? "timeout" : "unavailable",
    );
  }
  return result;
}

/**
 * Run a multi-row read off-thread; optional reads degrade to [] on failure.
 * Returns the raw rows (caller maps/hydrates on the main thread). The pool path
 * and the fallback run byte-identical SQL + params, so results match exactly.
 *
 * On a worker TIMEOUT we degrade to an empty array rather than re-running the
 * query in-process: the worker was wedged on this scan, so re-running it on the
 * main thread would re-block the event loop the offload exists to keep free
 * (#1006). The READ_JOB_TIMED_OUT sentinel is truthy, so it MUST be checked
 * before the `if (res)` success branch.
 */
export async function offloadAll(
  sql: string,
  params: ReadParam[],
): Promise<unknown[]> {
  const res = await tryPoolRead({ sql, params, mode: "all" });
  if (res === READ_JOB_TIMED_OUT) return [];
  if (res) return res.rows as unknown[];
  if (!inProcessReadFallbackForTest()) return [];
  return db()
    .query(sql)
    .all(...params);
}

/**
 * Like {@link offloadAll}, but surfaces a worker TIMEOUT or UNAVAILABLE to the
 * caller instead of silently degrading to `[]`. Use when
 * several reads must share fate: e.g. forSession runs two `knowledge_current`
 * candidate scans in parallel and must degrade BOTH together on a timeout
 * rather than inject a lopsided partial set (one pool succeeding while the other
 * wedges). Required readers use {@link requireReadRows} so worker failure
 * cannot freeze a partial or spuriously empty prompt.
 */
export async function offloadAllOrTimeout(
  sql: string,
  params: ReadParam[],
): Promise<unknown[] | ReadJobFailure> {
  const res = await tryPoolRead({ sql, params, mode: "all" });
  if (res === READ_JOB_TIMED_OUT) return READ_JOB_TIMED_OUT;
  if (res) return res.rows as unknown[];
  if (!inProcessReadFallbackForTest()) return READ_JOB_UNAVAILABLE;
  return db()
    .query(sql)
    .all(...params);
}

/**
 * Run a single-row read off-thread; optional reads degrade to null on failure.
 * Returns the row (or the driver's no-row value). The `tryPoolRead` `{ rows }`
 * wrapper means a pool-served no-row null is correctly returned as null here,
 * not mistaken for "pool unavailable" (which would re-run in-process). A worker
 * TIMEOUT degrades to null (don't re-block the main thread — see offloadAll).
 */
export async function offloadGet(
  sql: string,
  params: ReadParam[],
): Promise<unknown> {
  const res = await tryPoolRead({ sql, params, mode: "get" });
  if (res === READ_JOB_TIMED_OUT) return null;
  if (res) return res.rows;
  if (!inProcessReadFallbackForTest()) return null;
  return db()
    .query(sql)
    .get(...params);
}
