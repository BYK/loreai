import { Database } from "../src/db/driver.node";
import { all, get, run, sql, type SqlFragment } from "../src/sql";
import { afterEach, describe, expect, it } from "vitest";

const databases: Database[] = [];

afterEach(() => {
  for (const database of databases) database.close();
  databases.length = 0;
});

function memoryDatabase(): Database {
  const database = new Database(":memory:");
  database
    .query("CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT)")
    .run();
  databases.push(database);
  return database;
}

describe("sql fragments", () => {
  it("flattens nested fragments and joins in placeholder order", () => {
    const nested = sql`name = ${"nested"}`;
    const joined = sql.join([sql`id = ${1}`, nested], " OR ");
    const query = sql`SELECT * FROM items WHERE ${sql.and([
      sql`value IS NOT NULL`,
      joined,
    ])} LIMIT ${10}`;

    expect(query.text).toBe(
      "SELECT * FROM items WHERE (value IS NOT NULL) AND (id = ? OR name = ?) LIMIT ?",
    );
    expect(query.params).toEqual([1, "nested", 10]);
  });

  it("splices raw SQL without adding parameters", () => {
    const query = sql`SELECT ${sql.raw("id, value")} FROM ${sql.raw("items")}`;

    expect(query.text).toBe("SELECT id, value FROM items");
    expect(query.params).toEqual([]);
  });

  it("skips empty fragments and supplies safe empty boolean expressions", () => {
    const condition = sql.and([
      sql.empty,
      false,
      null,
      undefined,
      sql`value = ${"present"}`,
    ]);

    expect(sql.join([sql.empty, sql`a`, sql.empty, sql`b`], ", ").text).toBe(
      "a, b",
    );
    expect(condition.text).toBe("(value = ?)");
    expect(condition.params).toEqual(["present"]);
    expect(sql.and([]).text).toBe("1");
    expect(sql.or([]).text).toBe("0");
  });

  it("builds nonempty and empty IN lists", () => {
    expect(sql.inList([1, 2]).text).toBe("IN (?, ?)");
    expect(sql.inList([1, 2]).params).toEqual([1, 2]);

    const database = memoryDatabase();
    run(database, sql`INSERT INTO items (id, value) VALUES (1, ${"one"})`);
    expect(
      all(database, sql`SELECT id FROM items WHERE id ${sql.inList([])}`),
    ).toEqual([]);
  });

  it("rejects undefined interpolation at runtime", () => {
    expect(() => sql`value = ${undefined as never}`).toThrow(TypeError);
  });

  it("keeps injection-shaped values bound as parameters", () => {
    const database = memoryDatabase();
    const payload = "'; DROP TABLE items; --";

    run(database, sql`INSERT INTO items (value) VALUES (${payload})`);

    expect(
      get<{ value: string }>(
        database,
        sql`SELECT value FROM items WHERE value = ${payload}`,
      ),
    ).toEqual({ value: payload });
    expect(database.query("SELECT COUNT(*) AS count FROM items").get()).toEqual(
      {
        count: 1,
      },
    );
  });

  it("runs all, get, and run against the database driver", () => {
    const database = memoryDatabase();

    expect(
      run(database, sql`INSERT INTO items (value) VALUES (${"value"})`),
    ).toMatchObject({ changes: 1 });
    expect(
      get<{ id: number; value: string }>(
        database,
        sql`SELECT id, value FROM items WHERE value = ${"value"}`,
      ),
    ).toEqual({ id: 1, value: "value" });
    expect(all<{ id: number }>(database, sql`SELECT id FROM items`)).toEqual([
      { id: 1 },
    ]);
  });

  it("preserves the update SQL text for every mutable field", () => {
    const sets: SqlFragment[] = [
      sql`updated_at = ${1}`,
      sql`updated_by = ${"actor"}`,
      sql`sensitivity = ${"normal"}`,
    ];
    const query = sql`UPDATE knowledge SET ${sql.join(sets, ", ")} WHERE logical_id = ${"logical-id"} AND is_current = 1`;

    expect(query.text).toBe(
      "UPDATE knowledge SET updated_at = ?, updated_by = ?, sensitivity = ? WHERE logical_id = ? AND is_current = 1",
    );
    expect(query.params).toEqual([1, "actor", "normal", "logical-id"]);
  });
});
