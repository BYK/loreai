// Generic read-RPC job — the non-vector counterpart to vector-query.ts.
//
// A read job is a parameterized, read-ONLY SQL statement that the read-worker
// pool (vector-pool.ts) runs off the main thread against its own query-only
// connection (db/reader.ts), or that a caller runs in-process as the fallback.
// Where vector-query.ts carries a typed `VectorQuerySpec` + a Float32Array,
// a read job carries a plain SQL string + scalar bind params + a mode
// ("all" | "get"). This is what lets the heavy, staleness-TOLERANT FTS scans /
// table scans / hydration reads on the recall + forSession paths move off the
// event loop without each one needing a bespoke worker message type.
//
// Safety: the worker connection is opened `query_only = TRUE` (a hard
// SQLite-level guarantee — see db/reader.ts), so even a malformed statement that
// somehow reached a worker can never write. The SQL is always built by our own
// code (never user input); params are already SQL-parameterized.
//
// This module MUST stay leaf-level: no `db()` singleton, no config, no provider
// chain. The caller supplies the connection — the main-thread `db()` for the
// in-process fallback, or a worker's reader connection off-thread — exactly like
// vector-query.ts. Keeping it self-contained is what keeps the worker bundle
// tiny (see packages/gateway/script build plumbing).

/** Minimal structural view of a SQLite connection — just what a read job needs.
 *  Satisfied by both node:sqlite and bun:sqlite connections (and the `db()`
 *  singleton) via the `#db/driver` `query()` wrapper. */
export interface ReadJobConn {
  query(sql: string): {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
  };
}

/** `.all()` returns every matching row; `.get()` returns the first row or null. */
export type ReadMode = "all" | "get";

/**
 * A structured-cloneable scalar bind parameter. Read jobs cross the worker
 * boundary by structured clone, so params must be clone-safe scalars. Vector /
 * BLOB query params (Float32Array) belong on the dedicated vector-query path and
 * must NEVER be sent as a read-job param — they'd bloat the message and there is
 * no reason to brute-force a vector scan through the generic path.
 */
export type ReadParam = string | number | bigint | boolean | null | Uint8Array;

/** A self-contained description of one read-only query. */
export interface ReadJobSpec {
  sql: string;
  params: ReadParam[];
  mode: ReadMode;
}

/**
 * Run one read job against `conn`. Pure: no globals — the caller owns the
 * connection. Returns the row array for `mode: "all"` and the single row (or
 * the driver's no-row value) for `mode: "get"`. Both shapes are
 * structured-cloneable plain rows when the SQL selects lean columns; do NOT
 * route a query that returns BLOB/embedding columns through here.
 */
export function runReadJob(conn: ReadJobConn, spec: ReadJobSpec): unknown {
  const stmt = conn.query(spec.sql);
  return spec.mode === "get"
    ? stmt.get(...spec.params)
    : stmt.all(...spec.params);
}
