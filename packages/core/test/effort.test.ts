import { describe, expect, it } from "vitest";
import {
  anthropicThinkingBudget,
  openAIReasoningEffort,
  parseReasoningEffort,
  REASONING_EFFORTS,
  type ReasoningEffort,
} from "../src/effort";

describe("parseReasoningEffort", () => {
  it("accepts every canonical value", () => {
    for (const e of REASONING_EFFORTS) {
      expect(parseReasoningEffort(e)).toBe(e);
    }
  });
  it("is case- and whitespace-insensitive", () => {
    expect(parseReasoningEffort("  HIGH ")).toBe("high");
    expect(parseReasoningEffort("Medium")).toBe("medium");
  });
  it("returns null for unknown / empty / nullish", () => {
    expect(parseReasoningEffort("ultra")).toBeNull();
    expect(parseReasoningEffort("")).toBeNull();
    expect(parseReasoningEffort(undefined)).toBeNull();
    expect(parseReasoningEffort(null)).toBeNull();
  });
});

describe("openAIReasoningEffort", () => {
  it("passes low/medium/high through", () => {
    expect(openAIReasoningEffort("low")).toBe("low");
    expect(openAIReasoningEffort("medium")).toBe("medium");
    expect(openAIReasoningEffort("high")).toBe("high");
  });
  it("clamps xhigh to high (not a standard OpenAI value)", () => {
    expect(openAIReasoningEffort("xhigh")).toBe("high");
  });
  it("returns null for off / undefined (omit the param)", () => {
    expect(openAIReasoningEffort("off")).toBeNull();
    expect(openAIReasoningEffort(undefined)).toBeNull();
  });
});

describe("anthropicThinkingBudget", () => {
  it("returns an ascending budget for low→xhigh", () => {
    const low = anthropicThinkingBudget("low")!;
    const medium = anthropicThinkingBudget("medium")!;
    const high = anthropicThinkingBudget("high")!;
    const xhigh = anthropicThinkingBudget("xhigh")!;
    expect(low).toBeGreaterThanOrEqual(1024); // Anthropic minimum
    expect(medium).toBeGreaterThan(low);
    expect(high).toBeGreaterThan(medium);
    expect(xhigh).toBeGreaterThan(high);
  });
  it("returns null for off / undefined (do not enable thinking)", () => {
    expect(anthropicThinkingBudget("off")).toBeNull();
    expect(anthropicThinkingBudget(undefined)).toBeNull();
  });
  it("every enabled budget is at least Anthropic's 1024 floor", () => {
    for (const e of ["low", "medium", "high", "xhigh"] as ReasoningEffort[]) {
      expect(anthropicThinkingBudget(e)!).toBeGreaterThanOrEqual(1024);
    }
  });
});
