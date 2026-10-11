import { tmpdir } from "node:os";
import { join } from "node:path";
import { db } from "@loreai/core";
import { describe, expect, it } from "vitest";
import { sqliteFs } from "../src/fluid/sqlite-fs";
import { initializeFluidTables, SQLiteDbFactory } from "../src/fluid/sqlite";

describe("Fluid SQLite adapters", () => {
  it("uses indexed sequence ranges with Tinylicious exclusive bounds", async () => {
    initializeFluidTables();
    db().exec("DELETE FROM fluid_spike_records WHERE collection = 'deltas'");
    const database = await new SQLiteDbFactory().connect();
    const deltas = database.collection<Record<string, unknown>>("deltas");
    await deltas.insertMany(
      [1, 2, 3, 4, 5].map((sequenceNumber) => ({
        tenantId: "tenant",
        documentId: "document",
        operation: { sequenceNumber },
      })),
      true,
    );

    const found = await deltas.find(
      {
        tenantId: "tenant",
        documentId: "document",
        "operation.sequenceNumber": { $gt: 1, $lt: 5 },
      },
      undefined,
    );
    expect(
      found.map(
        (value) =>
          (value.operation as { sequenceNumber: number }).sequenceNumber,
      ),
    ).toEqual([2, 3, 4]);

    const plan = db()
      .query(
        `EXPLAIN QUERY PLAN SELECT document FROM fluid_spike_records
         WHERE collection = 'deltas' AND tenant_id = 'tenant'
           AND document_id = 'document' AND seq >= 2 AND seq <= 4
         ORDER BY seq LIMIT 2000`,
      )
      .all() as Array<{ detail: string }>;
    expect(
      plan.some(({ detail }) =>
        detail.includes("idx_fluid_spike_records_lookup"),
      ),
    ).toBe(true);
  });

  it("rolls back insertMany when an item has a missing indexed field", async () => {
    initializeFluidTables();
    db().exec("DELETE FROM fluid_spike_records WHERE collection = 'deltas'");
    const database = await new SQLiteDbFactory().connect();
    const deltas = database.collection<Record<string, unknown>>("deltas");

    await expect(
      deltas.insertMany(
        [
          {
            tenantId: "tenant",
            documentId: "document",
            operation: { sequenceNumber: 1 },
          },
          {
            tenantId: "tenant",
            operation: { sequenceNumber: 2 },
          },
        ],
        true,
      ),
    ).rejects.toThrow("Missing primary key");
    expect(await deltas.findAll()).toEqual([]);
  });

  it("lists only direct filesystem children using the parent index", async () => {
    initializeFluidTables();
    const root = join(tmpdir(), `fluid-sqlite-${process.pid}-${Date.now()}`);
    await sqliteFs.promises.mkdir(root, { recursive: true });
    await sqliteFs.promises.writeFile(join(root, "one"), "one");
    await sqliteFs.promises.mkdir(join(root, "nested"));
    await sqliteFs.promises.writeFile(join(root, "nested", "two"), "two");

    expect(
      (await sqliteFs.promises.readdir(root)).sort((left, right) =>
        left.localeCompare(right),
      ),
    ).toEqual(["nested", "one"]);
    await sqliteFs.promises.rmdir(root, { recursive: true });
    await expect(sqliteFs.promises.stat(root)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
