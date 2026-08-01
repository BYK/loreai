import { describe, expect, test } from "vitest";
import { canInjectMemory, suppressesMemoryInjection } from "../src/pipeline";

describe("x-lore-no-memory", () => {
  test("suppresses LTM reads only when explicitly requested", () => {
    expect(suppressesMemoryInjection({ "x-lore-no-memory": "true" })).toBe(
      true,
    );
    expect(suppressesMemoryInjection({ "x-lore-no-store": "true" })).toBe(
      false,
    );
    expect(suppressesMemoryInjection({})).toBe(false);
  });

  test("blocks both LTM injection paths for a no-memory request", () => {
    expect(canInjectMemory(true, { "x-lore-no-memory": "true" })).toBe(false);
    expect(canInjectMemory(true, {})).toBe(true);
    expect(canInjectMemory(false, {})).toBe(false);
  });
});
