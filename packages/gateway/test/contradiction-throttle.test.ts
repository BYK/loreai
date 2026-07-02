import { describe, expect, it } from "vitest";
import {
  CONTRADICTION_COOLDOWN_MS,
  contradictionCooldownActive,
} from "../src/idle";

// Pure decision guard for the idle contradiction-detection step (#1123).
// Mirrors the consolidationCooldownActive unit tests: the cooldown is armed
// unconditionally when a pass starts, so a "nothing found" pass still throttles
// the next attempt (the pattern-echo throttle gotcha).
describe("contradictionCooldownActive", () => {
  it("allows the first pass when there is no prior attempt", () => {
    expect(contradictionCooldownActive(undefined, Date.now())).toBe(false);
  });

  it("throttles a repeat pass inside the cooldown window", () => {
    const now = 5_000_000;
    expect(
      contradictionCooldownActive(now - (CONTRADICTION_COOLDOWN_MS - 1), now),
    ).toBe(true);
  });

  it("allows a new pass once the cooldown window has elapsed", () => {
    const now = 5_000_000;
    expect(
      contradictionCooldownActive(now - CONTRADICTION_COOLDOWN_MS, now),
    ).toBe(false);
    expect(
      contradictionCooldownActive(now - (CONTRADICTION_COOLDOWN_MS + 1), now),
    ).toBe(false);
  });
});
