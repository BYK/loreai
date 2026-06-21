import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { ensureProject } from "../src/db";
import {
  calibrate,
  evaluateCacheStrategy,
  evictSession,
  getCacheSizeSnapshot,
  getCacheStrategy,
  setCacheSizeSnapshot,
  setCachePricing,
  setModelLimits,
  transform,
} from "../src/gradient";
import type { LoreMessage, LoreMessageWithParts } from "../src/types";

const PROJECT = "/tmp/econ-evaluator-test";

function makeMsg(
  id: string,
  role: "user" | "assistant",
  text: string,
  sessionID: string,
): LoreMessageWithParts {
  const info = {
    id,
    sessionID,
    role,
    time: { created: Date.now() },
    ...(role === "user"
      ? { agent: "build" }
      : { parentID: `parent-${id}`, mode: "build", cost: 0 }),
    modelID: "claude-sonnet-4-20250514",
    providerID: "anthropic",
  } as unknown as LoreMessage;
  return {
    info,
    parts: [
      {
        id: `part-${id}`,
        sessionID,
        messageID: id,
        type: "text",
        text,
        time: { start: Date.now(), end: Date.now() },
      },
    ],
  };
}

// Per-token pricing with a 12x miss premium (read=1e-6, write=12e-6).
const PRICING = { readPerToken: 1e-6, writePerToken: 12e-6 };

let counter = 0;
function freshSession(): string {
  return `econ-test-${Date.now()}-${counter++}`;
}

describe("cache-strategy evaluator (single entry point)", () => {
  const created: string[] = [];
  function sid(): string {
    const id = freshSession();
    created.push(id);
    return id;
  }
  afterEach(() => {
    for (const id of created.splice(0)) evictSession(id);
  });

  test("evaluate returns null when the session has no size snapshot", () => {
    expect(
      evaluateCacheStrategy(sid(), {
        pReturn: 0.9,
        expectedCycles: 1,
        expectedFutureTurns: 5,
      }),
    ).toBeNull();
  });

  test("snapshot → evaluate → getCacheStrategy round-trips the same result", () => {
    const id = sid();
    setCacheSizeSnapshot(id, 580_000, 190_000);
    const result = evaluateCacheStrategy(
      id,
      { pReturn: 0.8, expectedCycles: 3, expectedFutureTurns: 20 },
      PRICING,
    );
    expect(result).not.toBeNull();
    // Large body, many future turns, cheap compaction → cool-bust.
    expect(result?.strategy).toBe("cool-bust");
    expect(result?.confident).toBe(true);
    // The stored decision is exactly the one returned (single source of truth).
    const stored = getCacheStrategy(id);
    expect(stored?.result).toEqual(result);
    expect(stored?.decidedAt).toBeGreaterThan(0);
  });

  test("a small, likely-return session evaluates to hold-warm", () => {
    const id = sid();
    setCacheSizeSnapshot(id, 10_000, 10_000); // no compaction available
    const result = evaluateCacheStrategy(
      id,
      { pReturn: 0.95, expectedCycles: 1, expectedFutureTurns: 4 },
      PRICING,
    );
    expect(result?.strategy).toBe("hold-warm");
  });

  test("getCacheSizeSnapshot reflects the snapshot and clamps compressed ≤ full", () => {
    const id = sid();
    setCacheSizeSnapshot(id, 100_000, 250_000); // compressed > full
    expect(getCacheSizeSnapshot(id)).toEqual({
      full: 100_000,
      compressed: 100_000,
    });
  });

  test("getCacheSizeSnapshot is null before any snapshot", () => {
    expect(getCacheSizeSnapshot(sid())).toBeNull();
  });

  test("explicit pricing override is used instead of the module global", () => {
    const id = sid();
    setCacheSizeSnapshot(id, 50_000, 50_000);
    // Set a degenerate global pricing (read>=write) that, if used, would make
    // warming never pay off; the override must take precedence.
    setCachePricing(0, 0);
    const result = evaluateCacheStrategy(
      id,
      { pReturn: 0.95, expectedCycles: 1, expectedFutureTurns: 3 },
      PRICING,
    );
    expect(result?.confident).toBe(true);
    expect(result?.strategy).toBe("hold-warm");
  });

  test("without override, missing global pricing yields low confidence", () => {
    const id = sid();
    setCacheSizeSnapshot(id, 50_000, 50_000);
    setCachePricing(0, 0); // global pricing unavailable
    const result = evaluateCacheStrategy(id, {
      pReturn: 0.9,
      expectedCycles: 1,
      expectedFutureTurns: 3,
    });
    expect(result?.confident).toBe(false);
  });

  test("evaluate on an unknown session creates no state entry (no leak)", () => {
    const id = sid();
    evaluateCacheStrategy(id, {
      pReturn: 0.9,
      expectedCycles: 1,
      expectedFutureTurns: 3,
    });
    // A non-creating read: the warmer must never materialize a core session.
    expect(getCacheSizeSnapshot(id)).toBeNull();
    expect(getCacheStrategy(id)).toBeNull();
  });
});

describe("transform writes the size snapshot end-to-end", () => {
  beforeAll(() => {
    ensureProject(PROJECT);
    setModelLimits({ context: 10_000, output: 2_000 });
    calibrate(0); // no system-prompt overhead in unit tests
  });

  test("a layer-0 transform populates getCacheSizeSnapshot (compressed === full)", () => {
    const session = `econ-e2e-${Date.now()}`;
    // Before any transform there is no snapshot.
    expect(getCacheSizeSnapshot(session)).toBeNull();

    const messages = [
      makeMsg("e2e-1", "user", "Hello, how are you today?", session),
      makeMsg("e2e-2", "assistant", "I'm ready to help.", session),
    ];
    const result = transform({
      messages,
      projectPath: PROJECT,
      sessionID: session,
    });
    expect(result.layer).toBe(0);

    // The transform wrote the gradient's own size estimate; with no compaction
    // evaluated on this small layer-0 turn, compressed === full.
    const snap = getCacheSizeSnapshot(session);
    expect(snap).not.toBeNull();
    expect(snap?.full).toBeGreaterThan(0);
    expect(snap?.compressed).toBe(snap?.full);

    evictSession(session);
  });

  test("a layer >= 1 transform reports compressed < full (issue #881)", () => {
    const session = `econ-e2e-compress-${Date.now()}`;
    // Tiny context + a large UNCALIBRATED (first-turn) conversation triggers the
    // first-sight-large path → effectiveMinLayer >= 1, which BYPASSES the layer-0
    // tier gate. This is exactly one of the layer >= 1 paths that used to leave
    // cacheSizeCompressed == cacheSizeFull (under-reporting compaction savings).
    setModelLimits({ context: 2_000, output: 500 });
    try {
      const messages = Array.from({ length: 30 }, (_, i) =>
        makeMsg(
          `cmp-${i}`,
          i % 2 === 0 ? "user" : "assistant",
          "A".repeat(1_000),
          session,
        ),
      );
      const result = transform({
        messages,
        projectPath: PROJECT,
        sessionID: session,
      });
      expect(result.layer).toBeGreaterThanOrEqual(1);

      const snap = getCacheSizeSnapshot(session);
      expect(snap).not.toBeNull();
      // The fix: compressed reflects the ACTUAL rebuilt window, strictly below
      // full. Mutation guard: sourcing it from the full size (the old layer >= 1
      // behavior) would make these EQUAL — so `<` would fail.
      expect(snap?.compressed).toBeLessThan(snap?.full ?? 0);
      // ...and it is exactly the clamped actual rebuilt-window size.
      expect(snap?.compressed).toBe(
        Math.max(0, Math.min(result.totalTokens, snap?.full ?? 0)),
      );
    } finally {
      setModelLimits({ context: 10_000, output: 2_000 });
      evictSession(session);
    }
  });
});
