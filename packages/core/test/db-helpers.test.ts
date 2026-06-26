import { describe, test, expect, beforeEach } from "vitest";
import { db, runUpsert, withTransaction, withSavepoint } from "../src/db";

describe("runUpsert", () => {
  beforeEach(() => {
    db().exec(
      "CREATE TABLE IF NOT EXISTS _t_upsert (k TEXT PRIMARY KEY, v TEXT, n INTEGER, created_at INTEGER)",
    );
    db().query("DELETE FROM _t_upsert").run();
  });

  test("inserts a new row", () => {
    runUpsert("_t_upsert", { k: "a", v: "first", n: 1 }, ["k"]);
    const row = db()
      .query("SELECT v, n FROM _t_upsert WHERE k = ?")
      .get("a") as { v: string; n: number };
    expect(row).toEqual({ v: "first", n: 1 });
  });

  test("throws when no columns are provided (never builds malformed SQL)", () => {
    expect(() => runUpsert("_t_upsert", {}, ["k"])).toThrow(/no columns/);
  });

  test("updates non-key columns on conflict (single row, no duplicate)", () => {
    runUpsert("_t_upsert", { k: "a", v: "first", n: 1 }, ["k"]);
    runUpsert("_t_upsert", { k: "a", v: "second", n: 2 }, ["k"]);
    const row = db()
      .query("SELECT v, n FROM _t_upsert WHERE k = ?")
      .get("a") as { v: string; n: number };
    expect(row).toEqual({ v: "second", n: 2 });
    const count = db().query("SELECT COUNT(*) c FROM _t_upsert").get() as {
      c: number;
    };
    expect(count.c).toBe(1);
  });

  test("excludeFromUpdate keeps insert-only columns unchanged on conflict", () => {
    runUpsert("_t_upsert", { k: "a", v: "first", created_at: 100 }, ["k"], {
      excludeFromUpdate: ["created_at"],
    });
    runUpsert("_t_upsert", { k: "a", v: "second", created_at: 999 }, ["k"], {
      excludeFromUpdate: ["created_at"],
    });
    const row = db()
      .query("SELECT v, created_at FROM _t_upsert WHERE k = ?")
      .get("a") as { v: string; created_at: number };
    expect(row).toEqual({ v: "second", created_at: 100 });
  });

  test("DO NOTHING when all columns are conflict keys (idempotent, no throw)", () => {
    db().exec(
      "CREATE TABLE IF NOT EXISTS _t_upsert_pk (a TEXT, b TEXT, PRIMARY KEY (a, b))",
    );
    db().query("DELETE FROM _t_upsert_pk").run();
    runUpsert("_t_upsert_pk", { a: "x", b: "y" }, ["a", "b"]);
    expect(() =>
      runUpsert("_t_upsert_pk", { a: "x", b: "y" }, ["a", "b"]),
    ).not.toThrow();
    const count = db().query("SELECT COUNT(*) c FROM _t_upsert_pk").get() as {
      c: number;
    };
    expect(count.c).toBe(1);
  });
});

describe("withTransaction", () => {
  beforeEach(() => {
    db().exec("CREATE TABLE IF NOT EXISTS _t_tx (k TEXT PRIMARY KEY)");
    db().query("DELETE FROM _t_tx").run();
  });

  test("commits on success and returns the callback value", () => {
    const result = withTransaction(() => {
      db().query("INSERT INTO _t_tx (k) VALUES (?)").run("a");
      return 42;
    });
    expect(result).toBe(42);
    const count = db().query("SELECT COUNT(*) c FROM _t_tx").get() as {
      c: number;
    };
    expect(count.c).toBe(1);
  });

  test("rolls back on throw (row absent) and re-throws the error", () => {
    expect(() =>
      withTransaction(() => {
        db().query("INSERT INTO _t_tx (k) VALUES (?)").run("a");
        throw new Error("boom");
      }),
    ).toThrow("boom");
    const count = db().query("SELECT COUNT(*) c FROM _t_tx").get() as {
      c: number;
    };
    expect(count.c).toBe(0);
  });
});

describe("withSavepoint", () => {
  beforeEach(() => {
    db().exec("CREATE TABLE IF NOT EXISTS _t_sp (k TEXT PRIMARY KEY)");
    db().query("DELETE FROM _t_sp").run();
  });

  const count = () =>
    (db().query("SELECT COUNT(*) c FROM _t_sp").get() as { c: number }).c;

  test("commits on success and returns the callback value (top level)", () => {
    const result = withSavepoint("sp_ok", () => {
      db().query("INSERT INTO _t_sp (k) VALUES (?)").run("a");
      return 42;
    });
    expect(result).toBe(42);
    expect(count()).toBe(1);
  });

  test("rolls back on throw (row absent) and re-throws", () => {
    expect(() =>
      withSavepoint("sp_boom", () => {
        db().query("INSERT INTO _t_sp (k) VALUES (?)").run("a");
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(count()).toBe(0);
  });

  test("is safe nested INSIDE an open transaction (the BEGIN-nesting trap)", () => {
    // This is the property withTransaction lacks: a nested BEGIN throws
    // "cannot start a transaction within a transaction". A SAVEPOINT does not.
    const result = withTransaction(() => {
      db().query("INSERT INTO _t_sp (k) VALUES (?)").run("outer");
      return withSavepoint("sp_nested", () => {
        db().query("INSERT INTO _t_sp (k) VALUES (?)").run("inner");
        return "ok";
      });
    });
    expect(result).toBe("ok");
    expect(count()).toBe(2);
  });

  test("inner savepoint rollback does not abort the outer transaction", () => {
    withTransaction(() => {
      db().query("INSERT INTO _t_sp (k) VALUES (?)").run("outer");
      // Inner unit fails and is rolled back to its savepoint; the outer txn
      // (and its "outer" row) must survive and commit.
      expect(() =>
        withSavepoint("sp_inner_fail", () => {
          db().query("INSERT INTO _t_sp (k) VALUES (?)").run("inner");
          throw new Error("inner boom");
        }),
      ).toThrow("inner boom");
    });
    const rows = db().query("SELECT k FROM _t_sp ORDER BY k").all() as Array<{
      k: string;
    }>;
    expect(rows.map((r) => r.k)).toEqual(["outer"]);
  });

  test("rejects a non-identifier savepoint name (injection guard)", () => {
    expect(() => withSavepoint("bad; DROP TABLE _t_sp", () => 1)).toThrow(
      /invalid savepoint name/,
    );
    // The guard fires before any SQL runs, so the table is untouched.
    expect(count()).toBe(0);
  });
});
