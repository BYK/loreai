import { isAbsolute, relative } from "node:path";
import { afterEach, expect, inject, test } from "vitest";

let completedTests = 0;

afterEach(() => {
  completedTests += 1;
  if (completedTests !== 1) return;
  process.env.NODE_ENV = "production";
  process.env.LORE_TEST_DB_ROOT = "/tmp/not-the-file-owned-test-root";
  process.env.LORE_DB_PATH = "/tmp/not-the-file-owned-test-database";
  process.env.XDG_DATA_HOME = "/tmp/not-the-file-owned-data-home";
});

test("mutates isolation environment state", () => {
  process.env.NODE_ENV = "production";
  process.env.LORE_TEST_DB_ROOT = "/tmp/not-the-file-owned-test-root";
  process.env.LORE_DB_PATH = "/tmp/not-the-file-owned-test-database";
  process.env.XDG_DATA_HOME = "/tmp/not-the-file-owned-data-home";
});

test("receives the file-owned isolation environment", () => {
  const root = inject("loreTestRoot");
  const nodeEnvironment = process.env.NODE_ENV;
  const databaseRoot = process.env.LORE_TEST_DB_ROOT;
  const database = process.env.LORE_DB_PATH;
  const dataHome = process.env.XDG_DATA_HOME;
  expect(nodeEnvironment).toBe("test");
  if (!databaseRoot) throw new Error("LORE_TEST_DB_ROOT is not set");
  const relativeDatabaseRoot = relative(root, databaseRoot);
  expect(relativeDatabaseRoot).not.toBe("");
  expect(relativeDatabaseRoot.startsWith("..")).toBe(false);
  expect(isAbsolute(relativeDatabaseRoot)).toBe(false);
  if (!database) throw new Error("LORE_DB_PATH is not set");
  if (!dataHome) throw new Error("XDG_DATA_HOME is not set");

  const relativeDatabase = relative(root, database);
  const relativeDataHome = relative(root, dataHome);
  expect(relativeDatabase).not.toBe("");
  expect(relativeDatabase.startsWith("..")).toBe(false);
  expect(isAbsolute(relativeDatabase)).toBe(false);
  expect(relativeDataHome).not.toBe("");
  expect(relativeDataHome.startsWith("..")).toBe(false);
  expect(isAbsolute(relativeDataHome)).toBe(false);
});
