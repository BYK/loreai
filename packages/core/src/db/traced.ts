// DB query-tracing seam.
//
// Wraps the SQLite connection returned by `db()` in a transparent Proxy so
// every `query(sql).{get,run,all}` execution is routed through the registered
// tracer (`log.traceDbQuery` → the host's `LogSink.withDbSpan`). This gives
// automatic per-query observability (Sentry `db` spans, when the gateway wires
// `withDbSpan`) without any call-site changes and without importing `@sentry/*`
// into `@loreai/core`.
//
// Adapted from the Sentry CLI pattern (`src/lib/telemetry.ts` createTraced*):
// lore's statement surface is `get`/`run`/`all` only (no `values`), defined by
// the `#db/driver` shim used by both the node and bun runtimes.
//
// 🔴 INVARIANTS:
//   - The Proxy NEVER alters arguments or return values — it only wraps
//     execution. With no tracer registered, `traceDbQuery` is a pass-through,
//     so behavior is byte-identical to the unwrapped connection.
//   - Only `.query()` is intercepted, and only the returned statement's
//     `get`/`run`/`all` are traced. Every other member (`.exec()`, `.close()`,
//     `.prepare()`, transaction control via `.exec("BEGIN IMMEDIATE")`, etc.)
//     passes through bound to the real connection, untouched.
//   - `migrate()` runs on the RAW connection before wrapping, so migration
//     queries are never traced and there is no re-entrancy.
//
// NOTE: statements created via `db().prepare(...)` (a few hot paths in
// distillation.ts / embedding.ts) are intentionally NOT traced — `prepare`
// passes through bound to the raw connection. This is an observability gap, not
// a correctness issue; route through `db().query(...)` if a span is desired.

import { traceDbQuery } from "../log";

/** Statement methods that execute a query and should be traced. */
const TRACED_METHODS = ["get", "run", "all"] as const;

function isTracedMethod(prop: string | symbol): boolean {
  return (
    typeof prop === "string" &&
    (TRACED_METHODS as readonly string[]).includes(prop)
  );
}

/** Wrap a prepared statement so its executing methods are traced. */
function tracedStatement<S extends object>(stmt: S, sql: string): S {
  return new Proxy(stmt, {
    get(target, prop) {
      const value = Reflect.get(target, prop);
      if (typeof value !== "function") return value;
      // Non-executing methods (and any future additions) are bound to the
      // target so `this` and native private fields keep working.
      if (!isTracedMethod(prop)) return value.bind(target);
      return (...args: unknown[]) =>
        traceDbQuery(sql, () =>
          (value as (...a: unknown[]) => unknown).apply(target, args),
        );
    },
  });
}

/** Minimal shape of the SQLite connection the Proxy needs to wrap. */
type QueryableDatabase = { query(sql: string): unknown };

/**
 * Wrap a SQLite connection so every prepared statement it returns is traced.
 * Intercepts only `query()`; all other members pass through bound to `db`.
 */
export function tracedDatabase<T extends QueryableDatabase>(db: T): T {
  const originalQuery = db.query.bind(db);
  return new Proxy(db, {
    get(target, prop) {
      if (prop === "query") {
        return (sql: string) =>
          tracedStatement(originalQuery(sql) as object, sql);
      }
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
