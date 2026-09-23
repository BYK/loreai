import { describe, expect, test } from "vitest";

describe.skip("wholly skipped file", () => {
  test("never executes", () => {
    expect.unreachable();
  });
});
