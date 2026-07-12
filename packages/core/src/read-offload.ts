// Read-offload helpers: route a heavy, staleness-TOLERANT read-only SQL query
// to the read-worker pool when it is available, falling back to the in-process
// `db()` connection otherwise.
//
// This is the single place that pairs `tryPoolRead()` (off-thread) with the
// IDENTICAL in-process query, so every caller gets the same fallback semantics
// and the same SQL/params on both paths. Callers map/hydrate the returned rows
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
import { READ_JOB_TIMED_OUT, tryPoolRead } from "./vector-pool";

// Re-exported so callers that coordinate several reads (e.g. forSession's two
// candidate scans) can detect a per-read timeout and degrade them together.
export { READ_JOB_TIMED_OUT } from "./vector-pool";

/**
 * Run a multi-row read off-thread when the pool is available, else in-process.
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
  return db()
    .query(sql)
    .all(...params);
}

/**
 * Like {@link offloadAll}, but surfaces a worker TIMEOUT to the caller as
 * {@link READ_JOB_TIMED_OUT} instead of silently degrading to `[]`. Use when
 * several reads must share fate: e.g. forSession runs two `knowledge_current`
 * candidate scans in parallel and must degrade BOTH together on a timeout
 * rather than inject a lopsided partial set (one pool succeeding while the other
 * wedges). Pool-unavailable still falls back to the identical in-process query.
 */
export async function offloadAllOrTimeout(
  sql: string,
  params: ReadParam[],
): Promise<unknown[] | typeof READ_JOB_TIMED_OUT> {
  const res = await tryPoolRead({ sql, params, mode: "all" });
  if (res === READ_JOB_TIMED_OUT) return READ_JOB_TIMED_OUT;
  if (res) return res.rows as unknown[];
  return db()
    .query(sql)
    .all(...params);
}

/**
 * Run a single-row read off-thread when the pool is available, else in-process.
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
  return db()
    .query(sql)
    .get(...params);
}
