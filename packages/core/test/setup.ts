import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, inject, vi } from "vitest";
import { close, invalidateProjectIdCache } from "../src/db";
import { silenceStderr } from "../src/log";
import { removeOwnedPath, type OwnedPath } from "./helpers/owned-path";

vi.mock("../../gateway/src/fetch", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../../gateway/src/fetch")>();
  const { offlineModelsDevResponse } =
    await import("../../gateway/test/helpers/models-dev-dispatcher");

  return {
    ...original,
    async upstreamFetch(input: RequestInfo | URL, init?: RequestInit) {
      return (
        offlineModelsDevResponse(input, init) ??
        original.upstreamFetch(input, init)
      );
    },
  };
});

// Reserve a unique path beneath the run-owned root. Capture its identity at
// the first lifecycle boundary that observes it, never after a pathname has
// already been registered as owned.
const runRoot = inject("loreTestRoot");
const runRootStats = lstatSync(runRoot, { bigint: true });
const runRootOwner: OwnedPath = {
  path: runRoot,
  identity: { dev: runRootStats.dev, ino: runRootStats.ino },
  markerName: ".lore-owned-root",
  markerValue: readFileSync(join(runRoot, ".lore-owned-root"), "utf8"),
  cleaned: false,
};
const tmp = join(runRoot, randomUUID());
const testDatabaseRoot = join(tmp, "database");
const testDatabasePath = join(testDatabaseRoot, "test.db");
const testDataHome = join(tmp, "xdg");
process.env.LORE_TEST_DB_ROOT = testDatabaseRoot;
process.env.LORE_DB_PATH = testDatabasePath;
process.env.XDG_DATA_HOME = testDataHome;
let ownedFileRoot: OwnedPath | undefined;

function createFileRoot(): void {
  try {
    mkdirSync(tmp);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  captureFileRoot();
}

function captureFileRoot(): void {
  if (ownedFileRoot) return;
  try {
    const current = lstatSync(tmp, { bigint: true });
    if (!current.isDirectory()) return;
    ownedFileRoot = {
      path: tmp,
      identity: { dev: current.dev, ino: current.ino },
      parent: runRootOwner,
      cleaned: false,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

// The Pi/OpenCode plugins flip `log.silenceStderr()` when they activate inside
// their TUI host. A force-active plugin test (LORE_*_FORCE_ACTIVE=1) would
// otherwise leave stderr silenced for the rest of the fork — hiding logs from,
// or vacuating "no output" assertions in, unrelated test files that share it.
// Reset on both sides of every test. The entry reset repairs state changed by a
// file-local teardown that runs after this setup hook under list ordering; the
// exit reset protects the ordinary stack-ordered path.
const resetIsolationState = () => {
  if (!ownedFileRoot) createFileRoot();
  process.env.NODE_ENV = "test";
  process.env.LORE_TEST_DB_ROOT = testDatabaseRoot;
  process.env.LORE_DB_PATH = testDatabasePath;
  process.env.XDG_DATA_HOME = testDataHome;
  silenceStderr(false);
  // The whole file shares one temp DB (single db() instance), so the per-
  // connection project path→id memo persists across tests. Clear it after each
  // test to make isolation explicit — a settled/alias mapping cached by one
  // test must never be served to another test that reuses the same path.
  invalidateProjectIdCache();
};
beforeAll(createFileRoot);
beforeEach(resetIsolationState);
afterEach(() => {
  captureFileRoot();
  resetIsolationState();
});

afterAll(async () => {
  const failures: unknown[] = [];
  let databaseClosed = false;
  try {
    close();
    databaseClosed = true;
  } catch (error) {
    failures.push(error);
  }
  if (databaseClosed && ownedFileRoot) {
    try {
      await removeOwnedPath(ownedFileRoot);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "test database cleanup failed");
  }
});
