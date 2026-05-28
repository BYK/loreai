import { describe, test, expect } from "bun:test";
import { computeCallCost } from "../src/cost-tracker";

// Use a fake model name to guarantee we hit getPricingSync defaults:
//   input: 3 $/MTok, output: 15 $/MTok,
//   cache_read: 0.3 $/MTok (input × 0.1),
//   cache_write: 3.75 $/MTok (input × 1.25)
const MODEL = "__test_fake_model__";

// 1M tokens per category — makes expected costs equal to the $/MTok rates.
const USAGE = {
  input_tokens: 1_000_000,
  output_tokens: 1_000_000,
  cache_read_input_tokens: 1_000_000,
  cache_creation_input_tokens: 1_000_000,
};

describe("computeCallCost", () => {
  test("conversation call uses full pricing", () => {
    const cost = computeCallCost(MODEL, USAGE, "conversation");
    expect(cost.inputCost).toBeCloseTo(3.0);
    expect(cost.outputCost).toBeCloseTo(15.0);
    expect(cost.cacheReadCost).toBeCloseTo(0.3);
    expect(cost.cacheWriteCost).toBeCloseTo(3.75);
    expect(cost.total).toBeCloseTo(3.0 + 15.0 + 0.3 + 3.75);
  });

  test("batch call applies 0.5× to ALL token categories", () => {
    const cost = computeCallCost(MODEL, USAGE, "batch");
    expect(cost.inputCost).toBeCloseTo(1.5); // 3.0 × 0.5
    expect(cost.outputCost).toBeCloseTo(7.5); // 15.0 × 0.5
    expect(cost.cacheReadCost).toBeCloseTo(0.15); // 0.3 × 0.5
    expect(cost.cacheWriteCost).toBeCloseTo(1.875); // 3.75 × 0.5
    expect(cost.total).toBeCloseTo(1.5 + 7.5 + 0.15 + 1.875);
  });

  test("batch cost is exactly half of conversation cost", () => {
    const conv = computeCallCost(MODEL, USAGE, "conversation");
    const batch = computeCallCost(MODEL, USAGE, "batch");
    expect(batch.total).toBeCloseTo(conv.total * 0.5);
    expect(batch.inputCost).toBeCloseTo(conv.inputCost * 0.5);
    expect(batch.cacheReadCost).toBeCloseTo(conv.cacheReadCost * 0.5);
    expect(batch.cacheWriteCost).toBeCloseTo(conv.cacheWriteCost * 0.5);
    expect(batch.outputCost).toBeCloseTo(conv.outputCost * 0.5);
  });

  test("1h TTL doubles cache_write rate", () => {
    const base = computeCallCost(MODEL, USAGE, "conversation");
    const with1h = computeCallCost(MODEL, USAGE, "conversation", "1h");
    expect(with1h.cacheWriteCost).toBeCloseTo(base.cacheWriteCost * 2);
    // Other costs unchanged
    expect(with1h.inputCost).toBeCloseTo(base.inputCost);
    expect(with1h.cacheReadCost).toBeCloseTo(base.cacheReadCost);
    expect(with1h.outputCost).toBeCloseTo(base.outputCost);
  });

  test("batch + 1h TTL: both multipliers stack", () => {
    const cost = computeCallCost(MODEL, USAGE, "batch", "1h");
    // cache_write: 3.75 (base) × 2 (1h TTL) × 0.5 (batch) = 3.75
    expect(cost.cacheWriteCost).toBeCloseTo(3.75);
    // Other costs: just 0.5× batch
    expect(cost.inputCost).toBeCloseTo(1.5);
    expect(cost.cacheReadCost).toBeCloseTo(0.15);
    expect(cost.outputCost).toBeCloseTo(7.5);
    expect(cost.total).toBeCloseTo(1.5 + 7.5 + 0.15 + 3.75);
  });

  test("5m TTL uses base cache_write rate (no doubling)", () => {
    const base = computeCallCost(MODEL, USAGE, "conversation");
    const with5m = computeCallCost(MODEL, USAGE, "conversation", "5m");
    expect(with5m.cacheWriteCost).toBeCloseTo(base.cacheWriteCost);
  });

  test("zero usage returns zero costs", () => {
    const cost = computeCallCost(MODEL, {}, "batch");
    expect(cost.total).toBe(0);
    expect(cost.inputCost).toBe(0);
    expect(cost.cacheReadCost).toBe(0);
    expect(cost.cacheWriteCost).toBe(0);
    expect(cost.outputCost).toBe(0);
  });
});
