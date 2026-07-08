import { describe, expect, test } from "vitest";
import { checkpointWal, db, dbPath, walSizeBytes } from "../src/db";
import { openReaderConnection } from "../src/db/reader";

describe("WAL checkpointing (#1221)", () => {
  test("journal_size_limit is bounded at open (not the -1 default)", () => {
    const row = db().query("PRAGMA journal_size_limit").get() as {
      journal_size_limit: number;
    };
    expect(row.journal_size_limit).toBe(64 * 1024 * 1024);
  });

  test("checkpointWal(TRUNCATE) reclaims the WAL when no reader pins a snapshot", () => {
    // Disable the auto-checkpoint so the probe writes deterministically accumulate
    // in the -wal (otherwise ~500 inserts land right at the 1000-page auto-reset
    // boundary and the pre-checkpoint size is racy). Reset by the next open.
    db().exec("PRAGMA wal_autocheckpoint = 0");
    db().exec(
      "CREATE TABLE IF NOT EXISTS wal_probe (id INTEGER PRIMARY KEY, blob TEXT)",
    );
    for (let i = 0; i < 500; i++)
      db()
        .query("INSERT INTO wal_probe (blob) VALUES (?)")
        .run("x".repeat(2000));
    const before = walSizeBytes();
    expect(before).toBeGreaterThan(0);

    const r = checkpointWal();
    // Single connection in the test — no reader read-mark → TRUNCATE fully wraps.
    expect(r.busy).toBe(false);
    expect(r.reclaimedBytes).toBeGreaterThan(0);
    // TRUNCATE shrinks the -wal file back to zero (well below the pre-size).
    expect(walSizeBytes()).toBeLessThan(before);
    expect(walSizeBytes()).toBe(0);
  });

  test("checkpointWal returns fast (no ~5s busy-wait) when a reader pins the WAL", () => {
    db().exec("PRAGMA wal_autocheckpoint = 0");
    db().exec(
      "CREATE TABLE IF NOT EXISTS wal_probe2 (id INTEGER PRIMARY KEY, b TEXT)",
    );
    for (let i = 0; i < 200; i++)
      db().query("INSERT INTO wal_probe2 (b) VALUES (?)").run("x".repeat(2000));

    // A second connection with an OPEN read transaction pins a WAL snapshot, so
    // the writer's TRUNCATE can't reset the log. Without the busy_timeout=0 guard
    // the checkpoint would busy-wait the whole 5s window on the event loop (#1221).
    const reader = openReaderConnection(dbPath());
    try {
      reader.db.exec("BEGIN");
      reader.db.query("SELECT COUNT(*) FROM wal_probe2").get(); // take the snapshot
      const t0 = Date.now();
      const r = checkpointWal();
      const elapsed = Date.now() - t0;
      expect(r.busy).toBe(true); // reader pinning → couldn't fully reset
      expect(elapsed).toBeLessThan(2000); // returned immediately, NOT ~5s
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
