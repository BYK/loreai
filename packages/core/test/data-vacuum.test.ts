import { describe, expect, test } from "vitest";
import {
  checkpointWal,
  db,
  dbFileSizeBytes,
  freelistBytes,
  vacuum,
} from "../src/db";

describe("VACUUM / free-page reclaim (#1221)", () => {
  test("vacuum() clears the freelist and shrinks the file", () => {
    db().exec(
      "CREATE TABLE IF NOT EXISTS vac_probe (id INTEGER PRIMARY KEY, b TEXT)",
    );
    for (let i = 0; i < 1000; i++)
      db().query("INSERT INTO vac_probe (b) VALUES (?)").run("x".repeat(2000));
    checkpointWal(); // flush inserts into the main file so it actually grows
    const grown = dbFileSizeBytes();

    db().exec("DELETE FROM vac_probe");
    checkpointWal(); // flush the deletes → freed pages land on the freelist
    // auto_vacuum=INCREMENTAL keeps freed pages on the freelist until reclaimed.
    expect(freelistBytes()).toBeGreaterThan(0);

    const r = vacuum();
    // VACUUM removes ALL free pages and returns the space to the OS.
    expect(freelistBytes()).toBe(0);
    expect(r.afterBytes).toBeLessThan(r.beforeBytes);
    expect(dbFileSizeBytes()).toBeLessThan(grown);
  });
});
