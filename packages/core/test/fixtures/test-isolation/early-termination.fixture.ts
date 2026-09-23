import { renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { inject, test } from "vitest";
import { db, dbPath } from "../../../src/db";

test("holds an open database until the coordinator is terminated", async () => {
  db();
  const marker = process.env.LORE_TEST_ISOLATION_MARKER;
  if (!marker) throw new Error("LORE_TEST_ISOLATION_MARKER is required");

  const pendingMarker = `${marker}.pending`;
  writeFileSync(
    pendingMarker,
    JSON.stringify({
      root: inject("loreTestRoot"),
      directory: dirname(dbPath()),
      database: dbPath(),
    }),
  );
  renameSync(pendingMarker, marker);
  await new Promise<never>(() => {});
});
