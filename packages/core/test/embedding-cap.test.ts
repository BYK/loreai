import { describe, it, expect } from "vitest";
import {
  MIN_EMBED_TOKENS,
  MODEL_MAX_TOKENS,
  backoffEmbedCap,
  clampEmbedCap,
  memoryModelEmbedCap,
  reconcileEmbedCap,
  reprobeEmbedCap,
  shouldReprobeEmbedCap,
} from "../src/embedding-cap";

const GB = 1024 * 1024 * 1024;

describe("clampEmbedCap", () => {
  it("clamps below the floor up to MIN_EMBED_TOKENS", () => {
    expect(clampEmbedCap(0)).toBe(MIN_EMBED_TOKENS);
    expect(clampEmbedCap(-100)).toBe(MIN_EMBED_TOKENS);
    expect(clampEmbedCap(MIN_EMBED_TOKENS - 1)).toBe(MIN_EMBED_TOKENS);
  });

  it("clamps above the ceiling down to MODEL_MAX_TOKENS", () => {
    expect(clampEmbedCap(MODEL_MAX_TOKENS + 1)).toBe(MODEL_MAX_TOKENS);
    expect(clampEmbedCap(1_000_000)).toBe(MODEL_MAX_TOKENS);
  });

  it("rounds in-range values", () => {
    expect(clampEmbedCap(1000)).toBe(1000);
    expect(clampEmbedCap(1000.4)).toBe(1000);
    expect(clampEmbedCap(1000.6)).toBe(1001);
  });

  it("treats non-finite input as the floor (never NaN/Infinity)", () => {
    expect(clampEmbedCap(Number.NaN)).toBe(MIN_EMBED_TOKENS);
    expect(clampEmbedCap(Number.POSITIVE_INFINITY)).toBe(MIN_EMBED_TOKENS);
    expect(clampEmbedCap(Number.NEGATIVE_INFINITY)).toBe(MIN_EMBED_TOKENS);
  });
});

describe("backoffEmbedCap", () => {
  it("lowers the cap by ~0.7 each step", () => {
    expect(backoffEmbedCap(MODEL_MAX_TOKENS)).toBe(Math.round(8192 * 0.7)); // 5734
    expect(backoffEmbedCap(1000)).toBe(700);
  });

  it("never drops below the floor", () => {
    expect(backoffEmbedCap(MIN_EMBED_TOKENS)).toBe(MIN_EMBED_TOKENS);
    // 300 * 0.7 = 210 → clamped back up to the floor.
    expect(backoffEmbedCap(300)).toBe(MIN_EMBED_TOKENS);
  });

  it("converges to the floor in a bounded number of steps and stays there", () => {
    let cap = MODEL_MAX_TOKENS;
    let steps = 0;
    while (cap > MIN_EMBED_TOKENS && steps < 100) {
      const next = backoffEmbedCap(cap);
      expect(next).toBeLessThan(cap); // strictly monotonic until the floor
      cap = next;
      steps++;
    }
    expect(cap).toBe(MIN_EMBED_TOKENS);
    expect(steps).toBeLessThan(15); // ~10 steps from 8192 → 256
    // Idempotent at the floor — no infinite loop / event storm.
    expect(backoffEmbedCap(cap)).toBe(MIN_EMBED_TOKENS);
  });
});

describe("memoryModelEmbedCap", () => {
  it("returns the floor when there is no usable memory budget", () => {
    expect(memoryModelEmbedCap(0)).toBe(MIN_EMBED_TOKENS);
    expect(memoryModelEmbedCap(100 * 1024 * 1024)).toBe(MIN_EMBED_TOKENS);
  });

  it("clamps to the model max on a large free pool", () => {
    expect(memoryModelEmbedCap(64 * GB)).toBe(MODEL_MAX_TOKENS);
  });

  it("sizes a constrained host (~2.7 GB free, like Onur's box) well below 4096", () => {
    const cap = memoryModelEmbedCap(2.7 * GB);
    expect(cap).toBeGreaterThan(MIN_EMBED_TOKENS);
    expect(cap).toBeLessThan(3000);
    // Crucially below the 4096-token ceiling that OOMed on his hardware.
    expect(cap).toBeLessThan(4096);
  });

  it("is monotonic in free memory", () => {
    expect(memoryModelEmbedCap(8 * GB)).toBeGreaterThanOrEqual(
      memoryModelEmbedCap(4 * GB),
    );
    expect(memoryModelEmbedCap(4 * GB)).toBeGreaterThanOrEqual(
      memoryModelEmbedCap(2 * GB),
    );
  });

  it("never returns a value outside [MIN, MODEL_MAX]", () => {
    for (const free of [0, 0.5, 1, 2, 4, 8, 16, 32, 128]) {
      const cap = memoryModelEmbedCap(free * GB);
      expect(cap).toBeGreaterThanOrEqual(MIN_EMBED_TOKENS);
      expect(cap).toBeLessThanOrEqual(MODEL_MAX_TOKENS);
    }
  });
});

describe("reconcileEmbedCap", () => {
  it("uses the model cap when there is no persisted value", () => {
    expect(reconcileEmbedCap(1 * GB, null, 2000)).toBe(2000);
  });

  it("trusts the learned cap when free memory is close to learn-time", () => {
    const stored = { cap: 1500, freeMemBytes: 1 * GB };
    expect(reconcileEmbedCap(1 * GB, stored, 2000)).toBe(1500); // ratio 1.0
    expect(reconcileEmbedCap(1.1 * GB, stored, 2000)).toBe(1500); // ratio 1.1
    expect(reconcileEmbedCap(0.8 * GB, stored, 2000)).toBe(1500); // ratio 0.8
  });

  it("re-probes upward via the model when memory has materially grown", () => {
    const stored = { cap: 1500, freeMemBytes: 1 * GB };
    // ratio 2.0 (> 1.25) → use the (larger) model cap, not the stale learned one.
    expect(reconcileEmbedCap(2 * GB, stored, 4000)).toBe(4000);
  });

  it("takes the safer of model vs learned when memory has materially shrunk", () => {
    const stored = { cap: 1500, freeMemBytes: 1 * GB };
    // ratio 0.4 (< 0.75) → min(modelCap, learned).
    expect(reconcileEmbedCap(0.4 * GB, stored, 800)).toBe(800);
    expect(
      reconcileEmbedCap(0.4 * GB, { cap: 600, freeMemBytes: 1 * GB }, 800),
    ).toBe(600);
  });

  it("clamps a learned cap that is out of range", () => {
    // Persisted cap below the floor → clamped up.
    expect(
      reconcileEmbedCap(1 * GB, { cap: 100, freeMemBytes: 1 * GB }, 2000),
    ).toBe(MIN_EMBED_TOKENS);
  });

  it("trusts the learned cap when the stored free-memory is unknown (0)", () => {
    expect(
      reconcileEmbedCap(1 * GB, { cap: 1500, freeMemBytes: 0 }, 2000),
    ).toBe(1500);
  });
});

describe("shouldReprobeEmbedCap", () => {
  it("fires only when free memory recovered ≥ 1.3× the learn-time level", () => {
    expect(shouldReprobeEmbedCap(1.3 * GB, 1 * GB)).toBe(true);
    expect(shouldReprobeEmbedCap(2 * GB, 1 * GB)).toBe(true);
    expect(shouldReprobeEmbedCap(1.29 * GB, 1 * GB)).toBe(false);
    expect(shouldReprobeEmbedCap(1 * GB, 1 * GB)).toBe(false);
  });

  it("never fires when the learn-time baseline is non-positive", () => {
    expect(shouldReprobeEmbedCap(8 * GB, 0)).toBe(false);
    expect(shouldReprobeEmbedCap(8 * GB, -1)).toBe(false);
  });
});

describe("reprobeEmbedCap", () => {
  it("steps the cap up by ~1.43× when memory allows", () => {
    // Huge free pool → model ceiling is MODEL_MAX, so the gentle step wins.
    expect(reprobeEmbedCap(1000, 64 * GB)).toBe(Math.round(1000 / 0.7)); // 1429
  });

  it("is bounded by the memory model for the current free pool", () => {
    // cap 2000, ~2.7 GB free → model ≈ 2200; the ×1.43 step (2857) is capped.
    const out = reprobeEmbedCap(2000, 2.7 * GB);
    expect(out).toBeGreaterThan(2000);
    expect(out).toBe(memoryModelEmbedCap(2.7 * GB));
  });

  it("never steps down (returns the cap unchanged if the model ceiling is lower)", () => {
    // cap already above what 2.7 GB supports → unchanged, never reduced.
    expect(reprobeEmbedCap(3000, 2.7 * GB)).toBe(3000);
  });

  it("stays clamped at the model max", () => {
    expect(reprobeEmbedCap(MODEL_MAX_TOKENS, 64 * GB)).toBe(MODEL_MAX_TOKENS);
  });

  it("never re-probes up to or past a known-bad cap", () => {
    // Huge free pool would step 2000 → 2857, but 2400 OOMed before → ceiling 2399.
    expect(reprobeEmbedCap(2000, 64 * GB, 2400)).toBe(2399);
    // The gentle step lands below the known-bad ceiling → unaffected.
    expect(reprobeEmbedCap(1000, 64 * GB, 5000)).toBe(Math.round(1000 / 0.7));
    // Already at ceiling−1 → no upward movement (never re-OOMs the same cap).
    expect(reprobeEmbedCap(2399, 64 * GB, 2400)).toBe(2399);
  });
});
