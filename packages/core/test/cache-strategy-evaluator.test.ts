import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { ensureProject } from "../src/db";
import {
  calibrate,
  computeCompressedCacheSize,
  evaluateCacheStrategy,
  evictSession,
  getCacheSizeSnapshot,
  getCacheStrategy,
  getOverhead,
  setCacheSizeSnapshot,
  setCachePricing,
  setLtmTokens,
  setModelLimits,
  transform,
  UNCALIBRATED_SAFETY,
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

describe("computeCompressedCacheSize (input-scale normalization, issue #886)", () => {
  test("layer 0 → no compaction → compressed == full", () => {
    expect(computeCompressedCacheSize(0, 5_000, 2_000, 1.5, 100_000)).toBe(
      100_000,
    );
  });

  test("layer >= 1 keeps the non-message floor (overhead + LTM)", () => {
    // calibrated (safety 1): compressed = floor + body, NOT body-only.
    // body=8_000, floor=12_000 → 20_000 (vs the old body-only 8_000).
    expect(computeCompressedCacheSize(1, 8_000, 12_000, 1, 200_000)).toBe(
      20_000,
    );
  });

  test("layer >= 1 applies the uncalibrated safety factor to floor AND body", () => {
    // uncalibrated (safety 1.5): (floor 4_000 + body 8_000) * 1.5 = 18_000.
    expect(computeCompressedCacheSize(2, 8_000, 4_000, 1.5, 200_000)).toBe(
      18_000,
    );
  });

  test("clamps to full (never fabricates savings) and floors at 0", () => {
    expect(computeCompressedCacheSize(1, 9_999, 9_999, 1.5, 5_000)).toBe(5_000);
    expect(computeCompressedCacheSize(1, 0, 0, 1.5, 10_000)).toBe(0);
  });

  test("treats a safety factor below 1 as 1 (never deflates below the estimate)", () => {
    expect(computeCompressedCacheSize(1, 1_000, 500, 0.4, 100_000)).toBe(1_500);
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
      // #881: compressed reflects the rebuilt window, strictly below full.
      // Mutation guard: sourcing it from the full size (the old layer >= 1
      // behavior) would make these EQUAL — so `<` would fail.
      expect(snap?.compressed).toBeLessThan(snap?.full ?? 0);
      // #886: it is lifted onto cacheSizeFull's INPUT scale (floor + body, ×the
      // uncalibrated safety factor), so it is STRICTLY GREATER than the raw
      // body-only rebuilt-window size. Guards against the #881 body-only value.
      expect(snap?.compressed).toBeGreaterThan(result.totalTokens);
    } finally {
      setModelLimits({ context: 10_000, output: 2_000 });
      evictSession(session);
    }
  });

  test("layer >= 1 carries the non-message floor (overhead + LTM) end-to-end — uncalibrated (#886)", () => {
    const session = `econ-e2e-floor-${Date.now()}`;
    // A NON-ZERO floor: inject LTM so transform() must add it back to compressed.
    // (The test above has overhead=0 and no LTM, so its floor is 0 — it could not
    // catch a regression that drops the floor capture.)
    const ltm = 6_000;
    setModelLimits({ context: 20_000, output: 2_000 });
    setLtmTokens(ltm, session);
    try {
      const messages = Array.from({ length: 30 }, (_, i) =>
        makeMsg(
          `flr-${i}`,
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
      // Exact: transform() must feed the captured floor (overhead + LTM) and the
      // uncalibrated safety factor into the helper. Dropping the floor capture or
      // flipping the safety selection changes this value.
      const expected = computeCompressedCacheSize(
        result.layer,
        result.totalTokens,
        getOverhead(session) + ltm,
        UNCALIBRATED_SAFETY,
        snap?.full ?? 0,
      );
      expect(snap?.compressed).toBe(expected);
      // The floor (≥ ltm) lifts compressed well above the body-only ×safety value.
      expect(snap?.compressed).toBeGreaterThan(
        Math.round(result.totalTokens * UNCALIBRATED_SAFETY),
      );
      expect(snap?.compressed).toBeLessThan(snap?.full ?? 0);
    } finally {
      setModelLimits({ context: 10_000, output: 2_000 });
      setLtmTokens(0, session);
      evictSession(session);
    }
  });

  test("layer >= 1 uses safety=1 once calibrated — floor without inflation (#886)", () => {
    const session = `econ-e2e-cal-${Date.now()}`;
    const ltm = 4_000;
    setModelLimits({ context: 20_000, output: 2_000 });
    setLtmTokens(ltm, session);
    try {
      const messages = Array.from({ length: 30 }, (_, i) =>
        makeMsg(
          `cal-${i}`,
          i % 2 === 0 ? "user" : "assistant",
          "A".repeat(1_000),
          session,
        ),
      );
      // Turn 1 (uncalibrated) establishes a transform estimate, then calibrate
      // with a real API input count flips the session to calibrated (safety = 1).
      transform({ messages, projectPath: PROJECT, sessionID: session });
      calibrate(40_000, session);

      const result = transform({
        messages,
        projectPath: PROJECT,
        sessionID: session,
      });
      expect(result.layer).toBeGreaterThanOrEqual(1);

      const snap = getCacheSizeSnapshot(session);
      expect(snap).not.toBeNull();
      // Calibrated → bodySafety === 1: compressed is floor + body with NO ×1.5.
      const expected = computeCompressedCacheSize(
        result.layer,
        result.totalTokens,
        getOverhead(session) + ltm,
        1,
        snap?.full ?? 0,
      );
      expect(snap?.compressed).toBe(expected);
      expect(snap?.compressed).toBeLessThan(snap?.full ?? 0);
    } finally {
      setModelLimits({ context: 10_000, output: 2_000 });
      setLtmTokens(0, session);
      evictSession(session);
    }
  });

  // #886: the evaluator must be unbiased — it treats cacheSizeFull and
  // cacheSizeCompressed as the same INPUT scale (both carry the non-message
  // floor and the same UNCALIBRATED_SAFETY factor). A body-only compressed
  // (old behavior) would understate coolBustCost, biasing toward compaction.
  describe("evaluateCacheStrategy — scale consistency (issue #886)", () => {
    beforeAll(() => {
      ensureProject(PROJECT);
      setModelLimits({ context: 20_000, output: 2_000 });
      // Overhead at 0 keeps the arithmetic focused on LTM (the controlled
      // floor); the existing end-to-end floor tests (above) already cover
      // overhead + LTM mixed.
      calibrate(0);
    });

    test("a layer >= 1 uncalibrated session sets compressed on the input scale (floor + LTM × safety)", () => {
      const session = `econ-scale-uc-${Date.now()}`;
      const ltm = 5_000;
      setLtmTokens(ltm, session);
      try {
        setModelLimits({ context: 2_000, output: 500 });
        const messages = Array.from({ length: 30 }, (_, i) =>
          makeMsg(
            `us-${i}`,
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

        // The compressed size must match the input-scale formula exactly
        // (body + non-message floor) × uncalibrated safety, clamped to full.
        // Reducing it to body-only (result.totalTokens) would pass every
        // inequality (< full, > 0) but fail this exact equality — the existing
        // floor tests prove this discriminator works against the body-only
        // regression. The guard is the equality itself.
        expect(snap?.compressed).toBe(
          computeCompressedCacheSize(
            result.layer,
            result.totalTokens,
            getOverhead(session) + ltm,
            UNCALIBRATED_SAFETY,
            snap?.full ?? 0,
          ),
        );
        // confirm the floor is material (non-zero LTM), not vacuously body-only.
        expect(snap?.compressed).toBeGreaterThan(
          Math.round(result.totalTokens * UNCALIBRATED_SAFETY),
        );
        expect(snap?.compressed).toBeLessThan(snap?.full ?? 0);
      } finally {
        setModelLimits({ context: 20_000, output: 2_000 });
        setLtmTokens(0, session);
        evictSession(session);
      }
    });

    test("a layer >= 1 calibrated session sets compressed on the input scale (floor + LTM, no safety inflation)", () => {
      const session = `econ-scale-c-${Date.now()}`;
      const ltm = 4_000;
      setLtmTokens(ltm, session);
      try {
        setModelLimits({ context: 2_000, output: 500 });
        const messages = Array.from({ length: 30 }, (_, i) =>
          makeMsg(
            `cs-${i}`,
            i % 2 === 0 ? "user" : "assistant",
            "A".repeat(1_000),
            session,
          ),
        );
        transform({ messages, projectPath: PROJECT, sessionID: session });
        calibrate(40_000, session);
        const result = transform({
          messages,
          projectPath: PROJECT,
          sessionID: session,
        });
        expect(result.layer).toBeGreaterThanOrEqual(1);

        const snap = getCacheSizeSnapshot(session);
        expect(snap).not.toBeNull();
        // Calibrated → safety=1, so compressed = floor + body with NO ×1.5.
        expect(snap?.compressed).toBe(
          computeCompressedCacheSize(
            result.layer,
            result.totalTokens,
            getOverhead(session) + ltm,
            1,
            snap?.full ?? 0,
          ),
        );
        expect(snap?.compressed).toBeGreaterThan(result.totalTokens);
        expect(snap?.compressed).toBeLessThan(snap?.full ?? 0);
      } finally {
        setModelLimits({ context: 20_000, output: 2_000 });
        setLtmTokens(0, session);
        evictSession(session);
      }
    });
  });
});
