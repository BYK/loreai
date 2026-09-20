import { writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { test } from "vitest";
import { db, dbPath } from "../../../src/db";

test("records the second file database directory", () => {
  db();
  const marker = process.env.LORE_TEST_ISOLATION_MARKER;
  if (!marker) throw new Error("LORE_TEST_ISOLATION_MARKER is required");
  writeFileSync(
    `${marker}.b`,
    JSON.stringify({ directory: dirname(dbPath()) }),
  );
});
