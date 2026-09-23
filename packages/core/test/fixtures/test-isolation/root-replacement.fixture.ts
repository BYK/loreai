import { basename, join } from "node:path";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { inject, test } from "vitest";
import { db } from "../../../src/db";

test("replaces the run-root pathname with a different directory", () => {
  db();
  const root = inject("loreTestRoot");
  const ownedRoot = `${root}-owned`;
  const originalFileRoot = process.env.LORE_TEST_DB_ROOT;
  if (!originalFileRoot) throw new Error("LORE_TEST_DB_ROOT is required");
  renameSync(root, ownedRoot);
  mkdirSync(root);
  const replacementFileRoot = join(root, basename(originalFileRoot));
  mkdirSync(replacementFileRoot);
  const sentinel = join(replacementFileRoot, "do-not-delete");
  writeFileSync(sentinel, "replacement");

  const marker = process.env.LORE_TEST_ISOLATION_MARKER;
  if (!marker) throw new Error("LORE_TEST_ISOLATION_MARKER is required");
  writeFileSync(
    marker,
    JSON.stringify({ root, ownedRoot, replacementFileRoot, sentinel }),
  );
});
