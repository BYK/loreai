import { embedding } from "@loreai/core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  resetBackgroundLimiter,
  tripCircuitBreaker,
} from "../src/background-limiter";
import { buildTemporalBackfillGate } from "../src/pipeline";

// The pure policy is covered in backfill-gate.test.ts; this pins the *wiring*
// (`buildTemporalBackfillGate` → live gateway/core state), which the production
// call site can't exercise because it's `NODE_ENV !== "test"`-gated.
describe("buildTemporalBackfillGate (wiring)", () => {
  beforeEach(() => {
    resetBackgroundLimiter();
    embedding._setRecallEmbedsInFlightForTest(0);
  });
  afterEach(() => {
    resetBackgroundLimiter();
    embedding._setRecallEmbedsInFlightForTest(0);
  });

  test("is wired to the background circuit breaker (idle → run, tripped → park)", () => {
    const gate = buildTemporalBackfillGate();

    // No embed load + breaker clear → the walk runs (doesn't park). Guards
    // against a wiring that spuriously pauses when the host is idle.
    expect(gate()).toBe(false);

    // Tripping the global breaker flips the same gate to "park" — proving it
    // reads isBackgroundPaused() live rather than a stale snapshot.
    tripCircuitBreaker(30);
    expect(gate()).toBe(true);

    // Clearing it resumes.
    resetBackgroundLimiter();
    expect(gate()).toBe(false);
  });

  test("is wired to the live recall-embed counter (in flight → park)", () => {
    const gate = buildTemporalBackfillGate();

    // Breaker clear, worker idle → runs.
    expect(gate()).toBe(false);

    // A live recall embed is in flight → park, even though the breaker is clear.
    // Proves the gate reads embedding.recallEmbedsInFlight() live rather than a
    // hardcoded false.
    embedding._setRecallEmbedsInFlightForTest(1);
    expect(gate()).toBe(true);

    // Worker drains → resumes.
    embedding._setRecallEmbedsInFlightForTest(0);
    expect(gate()).toBe(false);
  });
});
