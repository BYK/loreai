import { describe, expect, test } from "vitest";
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
    expect(createTestDatabasePath("gateway-harness")).toMatch(
      /gateway-harness-[0-9a-f-]{36}[/\\]test\.db$/,
    );
  });
});
