import { expect, test } from "vitest";

test("does not receive unrelated inherited environment", () => {
  expect(process.env.LORE_TEST_ISOLATION_INHERITED_SECRET).toBeUndefined();
  expect(process.env.NODE_ENV).toBe("test");
  expect(process.env.LORE_TEST_DB_ROOT).toBeTruthy();
});
