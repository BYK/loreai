import { describe, test, expect } from "vitest";
import { supportsAllowExtension } from "../src/db/driver.node";

describe("supportsAllowExtension", () => {
  test("returns true on Node 22.13.0 (LTS backport of allowExtension)", () => {
    expect(supportsAllowExtension("22.13.0")).toBe(true);
  });

  test("returns true on Node 22.13+ patch releases", () => {
    expect(supportsAllowExtension("22.13.1")).toBe(true);
    expect(supportsAllowExtension("22.20.0")).toBe(true);
  });

  test("returns false on Node 22.12.x (below the backport)", () => {
    expect(supportsAllowExtension("22.12.0")).toBe(false);
    expect(supportsAllowExtension("22.12.99")).toBe(false);
  });

  test("returns true on Node 23.5+", () => {
    expect(supportsAllowExtension("23.5.0")).toBe(true);
    expect(supportsAllowExtension("23.10.0")).toBe(true);
  });

  test("returns false on Node 23.0–23.4", () => {
    expect(supportsAllowExtension("23.0.0")).toBe(false);
    expect(supportsAllowExtension("23.4.99")).toBe(false);
  });

  test("returns true on Node 24+", () => {
    expect(supportsAllowExtension("24.0.0")).toBe(true);
    expect(supportsAllowExtension("26.3.1")).toBe(true);
  });

  test("returns false on Node 22.5 (node:sqlite present, allowExtension absent)", () => {
    expect(supportsAllowExtension("22.5.0")).toBe(false);
  });
});
