import { describe, expect, it } from "vitest";
import { type ReadJobConn, type ReadParam, runReadJob } from "../src/read-job";

// A deterministic stand-in for a SQLite connection that records how it was
// called, so we can assert mode + params routing without a real DB.
function fakeConn(allRows: unknown[], getRow: unknown) {
  const calls: Array<{ sql: string; mode: "all" | "get"; params: unknown[] }> =
    [];
  const conn: ReadJobConn = {
    query(sql: string) {
      return {
        all: (...params: unknown[]) => {
          calls.push({ sql, mode: "all", params });
          return allRows;
        },
        get: (...params: unknown[]) => {
          calls.push({ sql, mode: "get", params });
          return getRow;
        },
      };
    },
  };
  return { conn, calls };
}

describe("runReadJob", () => {
  it("runs an 'all' job and returns every row", () => {
    const rows = [{ id: "a" }, { id: "b" }];
    const { conn, calls } = fakeConn(rows, { id: "single" });
    const out = runReadJob(conn, {
      sql: "SELECT id FROM t WHERE x = ?",
      params: ["v"],
      mode: "all",
    });
    expect(out).toBe(rows);
    expect(calls).toEqual([
      { sql: "SELECT id FROM t WHERE x = ?", mode: "all", params: ["v"] },
    ]);
  });

  it("runs a 'get' job and returns the single row", () => {
    const { conn, calls } = fakeConn([{ id: "a" }], { id: "single" });
    const out = runReadJob(conn, {
      sql: "SELECT id FROM t WHERE id = ?",
      params: ["k"],
      mode: "get",
    });
    // Must dispatch to .get (not .all) — guards the mode ternary.
    expect(out).toEqual({ id: "single" });
    expect(calls).toEqual([
      { sql: "SELECT id FROM t WHERE id = ?", mode: "get", params: ["k"] },
    ]);
  });

  it("returns null verbatim from a 'get' job that matched no row", () => {
    const { conn } = fakeConn([], null);
    const out = runReadJob(conn, {
      sql: "SELECT 1 WHERE 0",
      params: [],
      mode: "get",
    });
    expect(out).toBeNull();
  });

  it("forwards all bind params, in order, untouched", () => {
    const { conn, calls } = fakeConn([], undefined);
    const params: ReadParam[] = ["s", 7, 9007199254740993n, true, null];
    runReadJob(conn, { sql: "SELECT 1", params, mode: "all" });
    expect(calls[0].params).toEqual(params);
  });
});
