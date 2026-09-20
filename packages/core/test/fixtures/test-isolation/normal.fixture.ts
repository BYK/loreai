import { existsSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { expect, test } from "vitest";
import { db, dbPath } from "../../../src/db";

test("creates its database lazily", () => {
  const directory = dirname(dbPath());
  expect(existsSync(directory)).toBe(false);

  db();

  const marker = process.env.LORE_TEST_ISOLATION_MARKER;
  if (!marker) throw new Error("LORE_TEST_ISOLATION_MARKER is required");
  expect(existsSync(dbPath())).toBe(true);
  writeFileSync(
    marker,
    JSON.stringify({
      directory,
      database: dbPath(),
      databaseExists: existsSync(dbPath()),
    }),
  );
});
