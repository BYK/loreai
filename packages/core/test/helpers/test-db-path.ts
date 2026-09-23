import { mkdirSync } from "node:fs";
import { isAbsolute, join, win32 } from "node:path";
import { randomUUID } from "node:crypto";

const testDatabaseRoot = (() => {
  const root = process.env.LORE_TEST_DB_ROOT;
  if (!root) throw new Error("LORE_TEST_DB_ROOT is not set");
  return root;
})();

/** Create a uniquely owned directory beneath this test file's database root. */
export function createTestDatabaseDirectory(label = "database"): string {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(label) ||
    isAbsolute(label) ||
    win32.isAbsolute(label)
  ) {
    throw new Error("invalid test database label");
  }
  const directory = join(testDatabaseRoot, `${label}-${randomUUID()}`);
  mkdirSync(directory, { recursive: true });
  return directory;
}

/** Reserve a unique database pathname beneath this test file's owned root. */
export function createTestDatabasePath(label = "database"): string {
  return join(createTestDatabaseDirectory(label), "test.db");
}
