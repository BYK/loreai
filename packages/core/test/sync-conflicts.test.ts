import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db";
import {
  deleteSyncConflict,
  getSyncConflict,
  listSyncConflicts,
} from "../src/sync-data";
import { withTenant } from "../src/tenant";

describe("local sync conflict accessors", () => {
  beforeEach(() => {
    db().exec("DELETE FROM sync_conflicts");
  });

  afterEach(() => {
    db().exec("DELETE FROM sync_conflicts");
  });

  it("lists newest conflicts first and honors the requested limit", () => {
    const insert = db().query(
      `INSERT INTO sync_conflicts (table_name, row_id, detected_at, resolution, local_content)
       VALUES (?, ?, ?, ?, ?)`,
    );
    const older = insert.run(
      "knowledge",
      "entry-old",
      100,
      "remote_upsert_wins",
      "{}",
    ).lastInsertRowid;
    const newer = insert.run(
      "knowledge",
      "entry-new",
      200,
      "remote_upsert_wins",
      "{}",
    ).lastInsertRowid;

    expect(listSyncConflicts(1).map((conflict) => conflict.id)).toEqual([
      Number(newer),
    ]);
    expect(listSyncConflicts(10).map((conflict) => conflict.id)).toEqual([
      Number(newer),
      Number(older),
    ]);
    expect(listSyncConflicts(0)).toEqual([]);
  });

  it("gets one conflict and reports whether deletion removed a row", () => {
    const id = Number(
      db()
        .query(
          `INSERT INTO sync_conflicts (table_name, row_id, detected_at, resolution, local_content)
           VALUES ('knowledge', 'entry', 123, 'remote_upsert_wins', '{"title":"local"}')`,
        )
        .run().lastInsertRowid,
    );

    expect(getSyncConflict(id)).toEqual({
      id,
      table_name: "knowledge",
      row_id: "entry",
      detected_at: 123,
      resolution: "remote_upsert_wins",
      local_content: '{"title":"local"}',
    });
    expect(getSyncConflict(id + 1)).toBeNull();
    expect(deleteSyncConflict(id)).toBe(true);
    expect(deleteSyncConflict(id)).toBe(false);
  });

  it("guards all helpers from request-owned tenant contexts", () => {
    expect(() => withTenant("tenant-a", () => listSyncConflicts(10))).toThrow(
      /listSyncConflicts: cloud sync is unavailable in tenant scope/,
    );
    expect(() => withTenant("tenant-a", () => getSyncConflict(1))).toThrow(
      /getSyncConflict: cloud sync is unavailable in tenant scope/,
    );
    expect(() => withTenant("tenant-a", () => deleteSyncConflict(1))).toThrow(
      /deleteSyncConflict: cloud sync is unavailable in tenant scope/,
    );
  });
});
