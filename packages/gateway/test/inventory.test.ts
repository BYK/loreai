import { describe, it, expect } from "vitest";
import {
  isLoreUrl,
  classifyRoutingValue,
  formatInventoryRow,
  type RoutingValue,
} from "../src/cli/inventory";

describe("isLoreUrl", () => {
  it("recognizes a default loopback gateway URL", () => {
    expect(isLoreUrl("http://127.0.0.1:3207")).toBe(true);
    expect(isLoreUrl("http://127.0.0.1:3207/v1")).toBe(true);
    expect(isLoreUrl("http://localhost:3207/v1")).toBe(true);
  });

  it("recognizes a non-default port on loopback", () => {
    expect(isLoreUrl("http://127.0.0.1:5673/v1")).toBe(true);
    expect(isLoreUrl("http://localhost:8080")).toBe(true);
  });

  it("recognizes a tailscale / LAN host (still lore if not a known vendor)", () => {
    expect(isLoreUrl("http://100.64.0.1:3207/v1")).toBe(true);
  });

  it("rejects known vendor endpoints", () => {
    expect(isLoreUrl("https://api.anthropic.com")).toBe(false);
    expect(isLoreUrl("https://api.anthropic.com/v1")).toBe(false);
    expect(isLoreUrl("https://api.openai.com/v1")).toBe(false);
    expect(isLoreUrl("https://generativelanguage.googleapis.com/v1")).toBe(
      false,
    );
  });

  it("treats empty / undefined as not-lore", () => {
    expect(isLoreUrl("")).toBe(false);
    expect(isLoreUrl(undefined)).toBe(false);
  });
});

describe("classifyRoutingValue", () => {
  it("returns 'unset' for undefined", () => {
    expect(classifyRoutingValue(undefined)).toEqual({ kind: "unset" });
  });

  it("returns 'lore' for a loopback URL", () => {
    expect(classifyRoutingValue("http://127.0.0.1:3207/v1")).toEqual({
      kind: "lore",
      value: "http://127.0.0.1:3207/v1",
    });
  });

  it("returns 'other' for a vendor URL", () => {
    expect(classifyRoutingValue("https://api.anthropic.com")).toEqual({
      kind: "other",
      value: "https://api.anthropic.com",
    });
  });
});

describe("formatInventoryRow", () => {
  const baseRow = {
    app: "Claude Code",
    file: "/home/u/.claude/settings.json",
    fileExists: true,
    key: "env.ANTHROPIC_BASE_URL",
  };

  it("renders a lore-routed row with OK", () => {
    const line = formatInventoryRow({
      ...baseRow,
      routing: { kind: "lore", value: "http://127.0.0.1:3207" },
    });
    expect(line).toContain("Claude Code");
    expect(line).toContain("http://127.0.0.1:3207");
    expect(line).toContain("lore");
  });

  it("renders an other-routed row with the destination", () => {
    const line = formatInventoryRow({
      ...baseRow,
      routing: { kind: "other", value: "https://api.anthropic.com" },
    });
    expect(line).toContain("https://api.anthropic.com");
    expect(line).toContain("other");
  });

  it("renders an unset row", () => {
    const line = formatInventoryRow({
      ...baseRow,
      routing: { kind: "unset" },
    });
    expect(line.toLowerCase()).toContain("unset");
  });

  it("renders a missing-file row", () => {
    const line = formatInventoryRow({
      ...baseRow,
      fileExists: false,
      routing: { kind: "unset" },
    });
    expect(line.toLowerCase()).toContain("missing");
  });
});

// Help TypeScript narrow the union in tests.
declare module "../src/cli/inventory" {
  interface RoutingValueAssertion {
    _brand?: RoutingValue;
  }
}
