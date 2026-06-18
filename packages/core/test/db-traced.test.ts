import { describe, test, expect, afterEach, vi } from "vitest";
import { tracedDatabase } from "../src/db/traced";
import { registerSink, type LogSink } from "../src/log";
import { db, close, ensureProject } from "../src/db";

// A valid LogSink with NO `withDbSpan` — simulates "no tracer registered"
// while still being a well-formed sink. Used to reset between tests.
const passthroughSink: LogSink = {
  info() {},
  warn() {},
  error() {},
  captureException() {},
};

function makeFakeStmt() {
  return {
    get: vi.fn((..._a: unknown[]) => ({ value: "row" })),
    all: vi.fn((..._a: unknown[]) => [{ value: "row" }]),
    run: vi.fn((..._a: unknown[]) => ({ changes: 1, lastInsertRowid: 7n })),
    // A non-function property to verify pass-through.
    columnName: "not-a-function",
  };
}

function makeFakeDb(stmt: ReturnType<typeof makeFakeStmt>) {
  return {
    query: vi.fn((_sql: string) => stmt),
    exec: vi.fn((_sql: string) => undefined),
    close: vi.fn(() => undefined),
  };
}

/** Build a tracer sink that records the SQL passed to each span. */
function tracerSink(calls: string[]): LogSink {
  return {
    ...passthroughSink,
    withDbSpan<T>(sql: string, fn: () => T): T {
      calls.push(sql);
      return fn();
    },
  };
}

describe("tracedDatabase", () => {
  afterEach(() => {
    // Reset to a tracer-less sink so other tests see pass-through behavior.
    registerSink(passthroughSink);
  });

  describe("Proxy contract (fake db)", () => {
    test("get/run/all return the underlying statement's values unchanged", () => {
      registerSink(passthroughSink); // no withDbSpan → pass-through
      const stmt = makeFakeStmt();
      const traced = tracedDatabase(makeFakeDb(stmt));

      expect(traced.query("SELECT 1").get(5)).toEqual({ value: "row" });
      expect(traced.query("SELECT 1").all(5)).toEqual([{ value: "row" }]);
      expect(traced.query("INSERT ...").run("a", "b")).toEqual({
        changes: 1,
        lastInsertRowid: 7n,
      });
      // Arguments forwarded verbatim to the underlying statement.
      expect(stmt.get).toHaveBeenCalledWith(5);
      expect(stmt.run).toHaveBeenCalledWith("a", "b");
    });

    test("with no tracer registered, the call is a pure pass-through (fn invoked exactly once)", () => {
      registerSink(passthroughSink);
      const stmt = makeFakeStmt();
      const traced = tracedDatabase(makeFakeDb(stmt));
      traced.query("SELECT 1").get();
      expect(stmt.get).toHaveBeenCalledTimes(1);
    });

    test("a registered withDbSpan tracer wraps each get/run/all exactly once with the exact SQL", () => {
      const calls: string[] = [];
      registerSink(tracerSink(calls));
      const stmt = makeFakeStmt();
      const traced = tracedDatabase(makeFakeDb(stmt));

      traced.query("SELECT * FROM t WHERE id = ?").get(1);
      traced.query("UPDATE t SET x = ?").run(2);
      traced.query("SELECT * FROM t").all();

      expect(calls).toEqual([
        "SELECT * FROM t WHERE id = ?",
        "UPDATE t SET x = ?",
        "SELECT * FROM t",
      ]);
    });

    test("the tracer is NOT invoked for .exec()", () => {
      const calls: string[] = [];
      registerSink(tracerSink(calls));
      const fakeDb = makeFakeDb(makeFakeStmt());
      const traced = tracedDatabase(fakeDb);

      traced.exec("BEGIN IMMEDIATE");
      expect(fakeDb.exec).toHaveBeenCalledWith("BEGIN IMMEDIATE");
      expect(calls).toEqual([]);
    });

    test("non-function statement properties pass through untouched", () => {
      registerSink(passthroughSink);
      const stmt = makeFakeStmt();
      const traced = tracedDatabase(makeFakeDb(stmt));
      const wrapped = traced.query("SELECT 1") as unknown as {
        columnName: string;
      };
      expect(wrapped.columnName).toBe("not-a-function");
    });

    test("the tracer's return value is the statement result (no re-wrapping)", () => {
      const calls: string[] = [];
      registerSink(tracerSink(calls));
      const stmt = makeFakeStmt();
      const traced = tracedDatabase(makeFakeDb(stmt));
      expect(traced.query("SELECT 1").get()).toEqual({ value: "row" });
      expect(calls).toHaveLength(1);
    });
  });

  describe("integration via real db()", () => {
    test("real queries return correct rows whether or not a tracer is registered", () => {
      const pid = ensureProject("/test/traced/integration");

      registerSink(passthroughSink);
      const a = db().query("SELECT id FROM projects WHERE id = ?").get(pid) as {
        id: string;
      };
      expect(a.id).toBe(pid);

      const calls: string[] = [];
      registerSink(tracerSink(calls));
      const b = db().query("SELECT id FROM projects WHERE id = ?").get(pid) as {
        id: string;
      };
      expect(b.id).toBe(pid);
      expect(calls.length).toBeGreaterThan(0);
    });

    test("BEGIN IMMEDIATE / COMMIT through the wrapped connection commits", () => {
      registerSink(passthroughSink);
      const key = `traced-tx-${crypto.randomUUID()}`;
      const d = db();
      d.exec("BEGIN IMMEDIATE");
      d.query(
        "INSERT INTO kv_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?",
      ).run(key, "v", "v");
      d.exec("COMMIT");
      const row = d
        .query("SELECT value FROM kv_meta WHERE key = ?")
        .get(key) as { value: string } | null;
      expect(row?.value).toBe("v");
    });
  });

  // Kept LAST in the file: it resets the db() singleton (close + reopen) to
  // exercise the connection-creation gate, then restores it in `finally`.
  describe("LORE_NO_DB_TRACING gate", () => {
    test("when set to '1', db() returns an un-traced handle (queries bypass the tracer)", () => {
      const saved = process.env.LORE_NO_DB_TRACING;
      const calls: string[] = [];
      try {
        // Drop the cached (traced) singleton so the next db() re-evaluates the
        // gate with the env var set.
        close();
        process.env.LORE_NO_DB_TRACING = "1";
        registerSink(tracerSink(calls));
        const pid = ensureProject("/test/traced/no-tracing-gate");
        db().query("SELECT id FROM projects WHERE id = ?").get(pid);
        // The handle is the raw connection — the tracer must never be invoked.
        expect(calls).toEqual([]);
      } finally {
        if (saved === undefined) delete process.env.LORE_NO_DB_TRACING;
        else process.env.LORE_NO_DB_TRACING = saved;
        registerSink(passthroughSink);
        // Reset so any later db() consumer gets a freshly-wrapped (traced)
        // singleton again.
        close();
      }
    });
  });
});
