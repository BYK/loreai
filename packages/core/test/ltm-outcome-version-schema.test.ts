import { beforeEach, describe, expect, test } from "vitest";
import { close, db, ensureProject, MIGRATIONS } from "../src/db";

function hasVersionColumn(): boolean {
  const columns = db()
    .query("PRAGMA table_info(knowledge_session_injections)")
    .all() as { name: string }[];
  return columns.some((column) => column.name === "version_id");
}

function seedReceipt(versionID?: string): void {
  const project = ensureProject("/test/outcome-version-migration");
  db()
    .query(`INSERT INTO knowledge_session_injections
    (session_id, logical_id, project_id, created_at, credited, verdict)
    VALUES ('version-migration-session', 'version-migration-memory', ?, 1000, 1, 'pass')`)
    .run(project);
  if (versionID)
    db()
      .query(`UPDATE knowledge_session_injections SET version_id = ?
    WHERE session_id = 'version-migration-session'`)
      .run(versionID);
}

function expectReceipt(versionID: string | null): void {
  expect(
    db()
      .query(`SELECT created_at, credited, verdict, version_id FROM knowledge_session_injections
    WHERE session_id = 'version-migration-session'`)
      .get(),
  ).toEqual({
    created_at: 1000,
    credited: 1,
    verdict: "pass",
    version_id: versionID,
  });
  expect(db().query("SELECT version FROM schema_version").get()).toEqual({
    version: MIGRATIONS.length,
  });
}

describe("knowledge injection version schema", () => {
  beforeEach(() => {
    db()
      .query(
        "DELETE FROM knowledge_session_injections WHERE session_id = 'version-migration-session'",
      )
      .run();
  });
  test("fresh databases contain a nullable version ID", () => {
    expect(hasVersionColumn()).toBe(true);
    seedReceipt();
    expectReceipt(null);
  });

  test("upgrades v103 receipts without guessing a version backfill", () => {
    if (hasVersionColumn())
      db().exec(
        "ALTER TABLE knowledge_session_injections DROP COLUMN version_id",
      );
    seedReceipt();
    db().exec("UPDATE schema_version SET version = 103");
    close();
    expect(hasVersionColumn()).toBe(true);
    expectReceipt(null);
  });

  test("partial migration preserves an already recorded version", () => {
    if (!hasVersionColumn())
      db().exec(
        "ALTER TABLE knowledge_session_injections ADD COLUMN version_id TEXT",
      );
    seedReceipt("recorded-version");
    db().exec("UPDATE schema_version SET version = 103");
    close();
    expect(hasVersionColumn()).toBe(true);
    expectReceipt("recorded-version");
  });

  test("latest-schema recovery restores a missing column as unknown provenance", () => {
    seedReceipt();
    if (hasVersionColumn())
      db().exec(
        "ALTER TABLE knowledge_session_injections DROP COLUMN version_id",
      );
    close();
    expect(hasVersionColumn()).toBe(true);
    expectReceipt(null);
  });

  test.each([103, MIGRATIONS.length])(
    "schema %i restores a missing receipt table",
    (version) => {
      db().query("UPDATE schema_version SET version = ?").run(version);
      db().exec("DROP TABLE knowledge_session_injections");
      close();
      expect(hasVersionColumn()).toBe(true);
      seedReceipt();
      expectReceipt(null);
    },
  );
});
