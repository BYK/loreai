import { existsSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { afterAll, expect, test } from "vitest";
import { db, dbPath } from "../../../src/db";

test("opens the initial database", () => {
  db();
  expect(existsSync(dbPath())).toBe(true);
});

afterAll(async () => {
  await new Promise<void>((resolve) => setImmediate(resolve));
  const directory = dirname(dbPath());
  const directoryWasRemoved = !existsSync(directory);
  db();

  const marker = process.env.LORE_TEST_ISOLATION_MARKER;
  if (!marker) throw new Error("LORE_TEST_ISOLATION_MARKER is required");
  writeFileSync(
    marker,
    JSON.stringify({
      directory,
      directoryWasRemoved,
      databaseExists: existsSync(dbPath()),
    }),
  );
});
