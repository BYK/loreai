import { describe, expect, test } from "vitest";
import { isAbsolute, relative } from "node:path";
import {
  createTestDatabaseDirectory,
  createTestDatabasePath,
} from "./test-db-path";

describe("test database path labels", () => {
  test.each([
    "../escape",
    "nested/escape",
    "nested\\escape",
    "/absolute",
    "C:\\absolute",
  ])("rejects an escaping label: %s", (label) => {
    expect(() => createTestDatabaseDirectory(label)).toThrow(
      "test database label",
    );
    expect(() => createTestDatabasePath(label)).toThrow("test database label");
  });

  test("accepts a plain diagnostic label", () => {
    const path = createTestDatabasePath("gateway-harness");
    expect(path).toMatch(/gateway-harness-[0-9a-f-]{36}[/\\]test\.db$/);
    const root = process.env.LORE_TEST_DB_ROOT;
    if (!root) throw new Error("LORE_TEST_DB_ROOT is not set");
    const relativePath = relative(root, path);
    expect(isAbsolute(relativePath)).toBe(false);
    expect(/^\.\.(?:[/\\]|$)/u.test(relativePath)).toBe(false);
  });
});
