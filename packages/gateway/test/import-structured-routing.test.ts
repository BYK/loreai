import { describe, test, expect } from "vitest";
import { resolveStructuredSourceName } from "../src/cli/import";

describe("resolveStructuredSourceName", () => {
  test("routes on explicit --source engram", () => {
    expect(
      resolveStructuredSourceName({
        sourceFlag: "engram",
        agentFilter: null,
        fileFlag: null,
      }),
    ).toBe("engram");
  });

  test("routes on --source mem0", () => {
    expect(
      resolveStructuredSourceName({
        sourceFlag: "mem0",
        agentFilter: null,
        fileFlag: null,
      }),
    ).toBe("mem0");
  });

  test("routes on --agent naming a structured source", () => {
    expect(
      resolveStructuredSourceName({
        sourceFlag: null,
        agentFilter: "engram",
        fileFlag: null,
      }),
    ).toBe("engram");
  });

  test("falls through for a conversation agent name", () => {
    expect(
      resolveStructuredSourceName({
        sourceFlag: null,
        agentFilter: "claude-code",
        fileFlag: null,
      }),
    ).toBeNull();
  });

  test("falls through for an unknown --source", () => {
    expect(
      resolveStructuredSourceName({
        sourceFlag: "notasource",
        agentFilter: null,
        fileFlag: null,
      }),
    ).toBeNull();
  });

  test("bare import (no flags) does NOT auto-route to a structured source", () => {
    expect(
      resolveStructuredSourceName({
        sourceFlag: null,
        agentFilter: null,
        fileFlag: null,
      }),
    ).toBeNull();
  });
});
