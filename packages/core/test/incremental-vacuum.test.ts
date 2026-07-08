import { describe, expect, test } from "vitest";
import {
  autoVacuumMode,
  checkpointWal,
  db,
  dbPath,
  freelistBytes,
  incrementalVacuum,
  vacuum,
} from "../src/db";
import { openReaderConnection } from "../src/db/reader";

describe("incremental vacuum (#1221)", () => {
  test("a fresh DB uses INCREMENTAL auto_vacuum", () => {
    expect(autoVacuumMode()).toBe(2);
  });

  test("incrementalVacuum reclaims freelist pages without a full VACUUM", () => {
    db().exec(
      "CREATE TABLE IF NOT EXISTS iv_probe (id INTEGER PRIMARY KEY, b TEXT)",
    );
    for (let i = 0; i < 1000; i++)
      db().query("INSERT INTO iv_probe (b) VALUES (?)").run("x".repeat(2000));
    checkpointWal();
    db().exec("DELETE FROM iv_probe");
    checkpointWal(); // freed pages land on the freelist (INCREMENTAL keeps them)
    const before = freelistBytes();
    expect(before).toBeGreaterThan(0);

    const r = incrementalVacuum(1_000_000); // reclaim everything
    expect(r.reclaimedBytes).toBeGreaterThan(0);
    expect(freelistBytes()).toBe(0); // all free pages removed from the freelist
  });

  test("vacuum({noWait}) returns fast (no ~5s busy-wait) when a reader pins the DB", () => {
    db().exec(
      "CREATE TABLE IF NOT EXISTS nw_probe (id INTEGER PRIMARY KEY, b TEXT)",
    );
    for (let i = 0; i < 200; i++)
      db().query("INSERT INTO nw_probe (b) VALUES (?)").run("x".repeat(2000));
    checkpointWal();

    // A second connection holding an open read transaction pins the DB, so the
    // mode-converting VACUUM can't get its exclusive moment. Without noWait's
    // busy_timeout=0 it would busy-wait the full ~5s on the caller (#1225 class).
    const reader = openReaderConnection(dbPath());
    try {
      reader.db.exec("BEGIN");
      reader.db.query("SELECT COUNT(*) FROM nw_probe").get();
      const t0 = Date.now();
      // May succeed or throw SQLITE_BUSY — either way it must be FAST, not ~5s.
      try {
        vacuum({ noWait: true });
      } catch {
        // SQLITE_BUSY under contention is expected; the idle caller retries later.
      }
      expect(Date.now() - t0).toBeLessThan(2000);
    } finally {
      try {
        reader.db.exec("ROLLBACK");
      } catch {
        // no open txn to roll back
      }
      reader.db.close();
    }
  });
});
