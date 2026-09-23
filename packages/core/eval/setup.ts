import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { inject } from "vitest";

// Evals share gateway state across tests, so establish the same file-owned
// database boundary as the unit suite without resetting it before each test.
const testRoot = inject("loreTestRoot");
const testDatabaseRoot = join(testRoot, randomUUID());
process.env.LORE_TEST_DB_ROOT = testDatabaseRoot;
process.env.LORE_DB_PATH = join(testDatabaseRoot, "test.db");
process.env.XDG_DATA_HOME = join(testDatabaseRoot, "xdg");
