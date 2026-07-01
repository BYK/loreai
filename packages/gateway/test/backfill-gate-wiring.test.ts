import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  resetBackgroundLimiter,
  tripCircuitBreaker,
} from "../src/background-limiter";
import { buildTemporalBackfillGate } from "../src/pipeline";

// The pure policy is covered in backfill-gate.test.ts; this pins the *wiring*
// (`buildTemporalBackfillGate` → live gateway state), which the production call
// site can't exercise because it's `NODE_ENV !== "test"`-gated.
describe("buildTemporalBackfillGate (wiring)", () => {
  beforeEach(() => resetBackgroundLimiter());
  afterEach(() => resetBackgroundLimiter());

  test("is wired to the background circuit breaker (idle → run, tripped → park)", () => {
    const gate = buildTemporalBackfillGate();

    // No active sessions + breaker clear → the walk runs (doesn't park). Guards
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
});
