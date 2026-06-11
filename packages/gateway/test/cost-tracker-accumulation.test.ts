/**
 * Tests for the in-memory cost accumulation + query helpers in
 * `src/cost-tracker.ts`. The existing `cost-tracker.test.ts` only covers the
 * pure `computeCallCost` pricing math; this file covers the accumulators
 * (recordConversationCost / recordWorkerCost / recordWarmupCost /
 * recordWarmupHit / recordTTLSavings), the totals (totalActualCost /
 * totalWorkerCost / totalSavings / costWithoutLore), and the session
 * lifecycle queries.
 *
 * Uses the same `__test_fake_model__` pricing fixture as cost-tracker.test.ts:
 *   input 3 / output 15 / cache_read 0.3 / cache_write 3.75 ($/MTok).
 */
import { describe, test, expect, beforeEach } from "vitest";
import {
  clearAllCosts,
  resetDailyBudgetState,
  getSessionCosts,
  getAllSessionCosts,
  deleteSessionCosts,
  recordConversationCost,
  recordWorkerCost,
  recordWarmupCost,
  recordWarmupHit,
  recordTTLSavings,
  totalActualCost,
  totalWorkerCost,
  totalSavings,
  costWithoutLore,
  computeCallCost,
  type SessionCosts,
} from "../src/cost-tracker";

const MODEL = "__test_fake_model__";

/** 1M tokens per category — makes expected costs equal the $/MTok rates. */
const USAGE = {
  input_tokens: 1_000_000,
  output_tokens: 1_000_000,
  cache_read_input_tokens: 1_000_000,
  cache_creation_input_tokens: 1_000_000,
};

/** Fetch a session's costs, asserting it exists (avoids non-null assertions). */
function costsFor(sessionID: string): SessionCosts {
  const c = getSessionCosts(sessionID);
  expect(c).not.toBeNull();
  return c as SessionCosts;
}

beforeEach(() => {
  clearAllCosts();
  resetDailyBudgetState();
});

describe("recordConversationCost", () => {
  test("accumulates cost, token counters, and turn count", () => {
    recordConversationCost("s1", MODEL, USAGE);
    const expected = computeCallCost(MODEL, USAGE, "conversation");
    const c = costsFor("s1");
    expect(c.conversation.turns).toBe(1);
    expect(c.conversation.cost).toBeCloseTo(expected.total);
    expect(c.conversation.inputTokens).toBe(1_000_000);
    expect(c.conversation.outputTokens).toBe(1_000_000);
    expect(c.conversation.cacheReadTokens).toBe(1_000_000);
    expect(c.conversation.cacheWriteTokens).toBe(1_000_000);

    recordConversationCost("s1", MODEL, USAGE);
    expect(costsFor("s1").conversation.turns).toBe(2);
    expect(costsFor("s1").conversation.cost).toBeCloseTo(expected.total * 2);
  });

  test("honors 1h TTL (cache_write doubled)", () => {
    recordConversationCost("s1", MODEL, USAGE, "1h");
    const base = computeCallCost(MODEL, USAGE, "conversation");
    const ttl = computeCallCost(MODEL, USAGE, "conversation", "1h");
    expect(ttl.total).toBeGreaterThan(base.total);
    expect(costsFor("s1").conversation.cost).toBeCloseTo(ttl.total);
  });
});

describe("recordWorkerCost", () => {
  test("is a no-op when sessionID is undefined", () => {
    recordWorkerCost(undefined, MODEL, USAGE, "direct", "lore-distill");
    expect(getAllSessionCosts().size).toBe(0);
  });

  test("maps each workerID to its cost bucket", () => {
    recordWorkerCost("s1", MODEL, USAGE, "direct", "lore-distill");
    recordWorkerCost("s1", MODEL, USAGE, "direct", "lore-curator");
    recordWorkerCost("s1", MODEL, USAGE, "direct", "lore-query-expand");
    recordWorkerCost("s1", MODEL, USAGE, "direct", "lore-compact");

    const c = costsFor("s1");
    expect(c.workers.distillation.calls).toBe(1);
    expect(c.workers.curation.calls).toBe(1);
    expect(c.workers.recall.calls).toBe(1);
    expect(c.workers.compaction.calls).toBe(1);

    const expected = computeCallCost(MODEL, USAGE, "direct");
    expect(c.workers.distillation.cost).toBeCloseTo(expected.total);
  });

  test("defaults unknown/absent workerID to the distillation bucket", () => {
    recordWorkerCost("s1", MODEL, USAGE, "direct");
    recordWorkerCost("s1", MODEL, USAGE, "direct", "mystery-worker");
    expect(costsFor("s1").workers.distillation.calls).toBe(2);
  });

  test("batch calls record batchSavings (direct minus batch cost)", () => {
    recordWorkerCost("s1", MODEL, USAGE, "batch", "lore-distill");
    const direct = computeCallCost(MODEL, USAGE, "direct");
    const batch = computeCallCost(MODEL, USAGE, "batch");
    expect(costsFor("s1").batchSavings).toBeCloseTo(direct.total - batch.total);
  });
});

describe("recordWarmupCost", () => {
  test("accumulates warmup worker cost (read + write)", () => {
    recordWarmupCost("s1", MODEL, 1_000_000, 1_000_000);
    const c = costsFor("s1");
    // read: 1M × 0.3/M = 0.3; write: 1M × 3.75/M = 3.75
    expect(c.workers.warmup.calls).toBe(1);
    expect(c.workers.warmup.cost).toBeCloseTo(0.3 + 3.75);
  });

  test("doubles cache_write at 1h TTL", () => {
    recordWarmupCost("s1", MODEL, 0, 1_000_000, "1h");
    expect(costsFor("s1").workers.warmup.cost).toBeCloseTo(3.75 * 2);
  });
});

describe("counterfactual savings", () => {
  test("recordWarmupHit accumulates warmup savings + hits", () => {
    recordWarmupHit("s1", MODEL, 1_000_000);
    const c = costsFor("s1");
    // savings = 1M × (cache_write − cache_read) = 3.75 − 0.3
    expect(c.counterfactual.warmupHits).toBe(1);
    expect(c.counterfactual.warmupSavings).toBeCloseTo(3.75 - 0.3);
  });

  test("recordTTLSavings accumulates TTL savings + hits", () => {
    recordTTLSavings("s1", MODEL, 1_000_000);
    const c = costsFor("s1");
    expect(c.counterfactual.ttlHits).toBe(1);
    expect(c.counterfactual.ttlSavings).toBeCloseTo(3.75 - 0.3);
  });
});

describe("totals", () => {
  test("aggregate conversation, worker, and savings figures consistently", () => {
    recordConversationCost("s1", MODEL, USAGE);
    recordWorkerCost("s1", MODEL, USAGE, "direct", "lore-distill");
    recordWorkerCost("s1", MODEL, USAGE, "batch", "lore-curator");
    recordWarmupCost("s1", MODEL, 1_000_000, 1_000_000);
    recordWarmupHit("s1", MODEL, 1_000_000);
    recordTTLSavings("s1", MODEL, 1_000_000);

    const c = costsFor("s1");
    const actual = totalActualCost(c);
    const worker = totalWorkerCost(c);

    expect(actual).toBeCloseTo(
      c.conversation.cost +
        c.workers.distillation.cost +
        c.workers.curation.cost +
        c.workers.compaction.cost +
        c.workers.recall.cost +
        c.workers.warmup.cost,
    );
    expect(worker).toBeCloseTo(actual - c.conversation.cost);
    expect(totalSavings(c)).toBeCloseTo(
      c.counterfactual.warmupSavings +
        c.counterfactual.ttlSavings +
        c.batchSavings +
        c.counterfactual.avoidedCompactionCost -
        worker,
    );
    expect(costWithoutLore(c)).toBeCloseTo(actual + totalSavings(c));
  });
});

describe("queries + lifecycle", () => {
  test("getSessionCosts returns null for an unknown session", () => {
    expect(getSessionCosts("nope")).toBeNull();
  });

  test("getAllSessionCosts exposes tracked sessions; delete + clear remove them", () => {
    recordConversationCost("s1", MODEL, USAGE);
    recordConversationCost("s2", MODEL, USAGE);
    expect(getAllSessionCosts().size).toBe(2);
    expect(getAllSessionCosts().has("s1")).toBe(true);

    deleteSessionCosts("s1");
    expect(getSessionCosts("s1")).toBeNull();
    expect(getAllSessionCosts().size).toBe(1);

    clearAllCosts();
    expect(getAllSessionCosts().size).toBe(0);
  });
});
