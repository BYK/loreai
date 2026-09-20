import { existsSync, renameSync, watch, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { inject, test } from "vitest";
import { db, dbPath } from "../../../src/db";

function waitForFile(path: string): Promise<void> {
  if (existsSync(path)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const watcher = watch(dirname(path));
    const timeout = setTimeout(() => {
      watcher.close();
      reject(new Error("timed out waiting for concurrent-run release"));
    }, 20_000);
    const resolveIfPresent = () => {
      if (!existsSync(path)) return;
      clearTimeout(timeout);
      watcher.close();
      resolve();
    };
    watcher.on("change", resolveIfPresent);
    watcher.once("error", (error) => {
      clearTimeout(timeout);
      watcher.close();
      reject(error);
    });
    resolveIfPresent();
  });
}

test("keeps its run root while active", async () => {
  db();
  const marker = process.env.LORE_TEST_ISOLATION_MARKER;
  if (!marker) throw new Error("LORE_TEST_ISOLATION_MARKER is required");
  const providedRoot = inject("loreTestRoot");
  const root = providedRoot || dirname(dbPath());
  const pendingMarker = `${marker}.pending`;
  writeFileSync(pendingMarker, JSON.stringify({ root, database: dbPath() }));
  renameSync(pendingMarker, marker);

  const release = process.env.LORE_TEST_ISOLATION_RELEASE;
  if (release) await waitForFile(release);
});
