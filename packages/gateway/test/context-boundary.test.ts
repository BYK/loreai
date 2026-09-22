import { describe, expect, test } from "vitest";
import {
  CONTEXT_BOUNDARY_CAPABILITY_HEADER,
  CONTEXT_BOUNDARY_CAPABILITY_VALUE,
  CONTEXT_BOUNDARY_HEADER,
} from "@loreai/core";
import { supportsContextBoundary } from "../src/context-boundary";

describe("context-boundary capability handshake", () => {
  test.each([
    ["absent", {}, false],
    [
      "supported version",
      {
        [CONTEXT_BOUNDARY_CAPABILITY_HEADER]: CONTEXT_BOUNDARY_CAPABILITY_VALUE,
      },
      true,
    ],
    [
      "case-insensitive supported version",
      { "X-Lore-Context-Boundary-Capability": "v1" },
      true,
    ],
    ["unknown version", { [CONTEXT_BOUNDARY_CAPABILITY_HEADER]: "v2" }, false],
    ["legacy boundary only", { [CONTEXT_BOUNDARY_HEADER]: "opaque" }, true],
  ])("treats %s as supported=%s", (_name, headers, supported) => {
    expect(supportsContextBoundary(headers)).toBe(supported);
  });
});
