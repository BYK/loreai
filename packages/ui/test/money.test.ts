import { describe, expect, it } from "vitest";

import { formatMoney } from "~/lib/money";

describe("formatMoney", () => {
  it.each([
    [0, "$0.00"],
    [0.004, "<$0.01"],
    [0.005, "$0.01"],
    [0.01, "$0.01"],
    [12.345, "$12.35"],
    [99.99, "$99.99"],
    [99.995, "$100"],
    [100, "$100"],
    [100.49, "$100"],
    [1e6, "$1,000,000"],
    [-0.004, "-<$0.01"],
    [-3, "-$3.00"],
    [-250.7, "-$251"],
    [NaN, "—"],
    [Infinity, "—"],
    [-Infinity, "—"],
  ])("formatMoney(%s) → %s", (input, expected) => {
    expect(formatMoney(input)).toBe(expected);
  });
});
