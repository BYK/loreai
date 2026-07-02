import { describe, it, expect } from "vitest";
import {
  DEFAULT_MAX_EMBED_POOL,
  EMBED_POOL_ABS_MAX,
  MIN_EMBED_TOKENS,
  MODEL_MAX_TOKENS,
  PER_WORKER_MEM_BUDGET_BYTES,
  EMBED_TOKEN_CEILING,
  backoffEmbedCap,
  clampEmbedCap,
  desiredEmbedPoolSize,
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

  it("bounds a large free pool to the WASM heap ceiling, not the model max", () => {
    // Host RAM says 8192 is affordable, but the fixed 4 GiB WASM heap can't hold
    // the O(L²) attention at that length — so a memory-rich box is capped at the
    // WASM-sustainable ceiling (~4948) rather than MODEL_MAX_TOKENS (8192). This
    // is what prevents the OOM-on-every-boot on machines with lots of free RAM.
    expect(memoryModelEmbedCap(64 * GB)).toBe(EMBED_TOKEN_CEILING);
    expect(EMBED_TOKEN_CEILING).toBeLessThan(MODEL_MAX_TOKENS);
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

describe("EMBED_TOKEN_CEILING", () => {
  it("is a fixed ceiling below the model max, in the measured ~4900 range", () => {
    // Derived from the 4 GiB WASM MAXIMUM_MEMORY (measured on the built worker)
    // × 0.85 headroom, minus baseline, over K. Must sit below MODEL_MAX_TOKENS
    // (that's the whole point) and near the observed safe convergence (≤4962).
    expect(EMBED_TOKEN_CEILING).toBeLessThan(MODEL_MAX_TOKENS);
    expect(EMBED_TOKEN_CEILING).toBeGreaterThan(4000);
    expect(EMBED_TOKEN_CEILING).toBeLessThanOrEqual(5200);
  });

  it("is the binding ceiling once free RAM is large enough to hit it", () => {
    // Below the crossover the freemem term binds; above it, the WASM ceiling
    // does — and the result never exceeds the WASM ceiling regardless of RAM.
    for (const free of [16, 32, 64, 256]) {
      expect(memoryModelEmbedCap(free * GB)).toBe(EMBED_TOKEN_CEILING);
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

  it("never re-probes up to or past a persisted known-bad cap on a memory-rich reboot", () => {
    // The every-boot-OOM: memory grew since learn time, so the freemem branch
    // would jump back to the (larger) model cap — but 3000 already OOMed, so the
    // result is hard-capped at knownBad − 1. Without persisting knownBad across
    // restarts, this would climb to 4000 and OOM again on the very next boot.
    const stored = { cap: 1500, freeMemBytes: 1 * GB };
    expect(reconcileEmbedCap(4 * GB, stored, 4000, 3000)).toBe(2999);
  });

  it("still lowers below a known-bad cap when the reconciled value is already safe", () => {
    // knownBad only *caps* — it never raises. A trusted learned cap below
    // knownBad − 1 is returned unchanged.
    const stored = { cap: 1500, freeMemBytes: 1 * GB };
    expect(reconcileEmbedCap(1 * GB, stored, 2000, 3000)).toBe(1500);
  });

  it("ignores knownBad when it is 0 (none learned yet)", () => {
    const stored = { cap: 1500, freeMemBytes: 1 * GB };
    expect(reconcileEmbedCap(4 * GB, stored, 4000, 0)).toBe(4000);
  });

  it("bounds a stale trusted cap above the WASM ceiling (post-upgrade safety)", () => {
    // A cap of 7000 learned BEFORE the WASM bound existed, trusted because
    // free memory is stable — must be pulled down to the ceiling, not run at
    // 7000 (which would OOM the 4 GiB heap once before the backoff re-converges).
    const stale = { cap: 7000, freeMemBytes: 1 * GB };
    expect(reconcileEmbedCap(1 * GB, stale, 8192)).toBe(EMBED_TOKEN_CEILING);
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
    // The ×1.43 step (2000 → 2857) is capped at the model's value for this free
    // pool — computed dynamically below, so robust to re-calibration of K/baseline.
    const out = reprobeEmbedCap(2000, 2.7 * GB);
    expect(out).toBeGreaterThan(2000);
    expect(out).toBe(memoryModelEmbedCap(2.7 * GB));
  });

  it("never steps down (returns the cap unchanged if the model ceiling is lower)", () => {
    // A constrained pool floors the model ceiling far below the current cap, so
    // the cap is returned unchanged. The guard keeps this robust to a future
    // re-calibration that might raise the 2.7 GB model value above 3000.
    expect(memoryModelEmbedCap(1 * GB)).toBe(MIN_EMBED_TOKENS);
    expect(reprobeEmbedCap(3000, 1 * GB)).toBe(3000);
  });

  it("never re-probes above the WASM ceiling, even from an above-ceiling cap", () => {
    // Defense-in-depth: the "never step down" Math.max(cap, …) clause must not
    // propagate a stale above-ceiling cap. Handed 8192, reprobe self-bounds to
    // the WASM ceiling rather than returning 8192 (which would OOM the 4 GiB heap).
    expect(reprobeEmbedCap(MODEL_MAX_TOKENS, 64 * GB)).toBe(
      EMBED_TOKEN_CEILING,
    );
    // A normal in-range cap still steps up as before (bound is a no-op here).
    expect(reprobeEmbedCap(2000, 64 * GB)).toBe(Math.round(2000 / 0.7)); // 2857
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

describe("desiredEmbedPoolSize", () => {
  it("returns 1 when free memory can't fit a second worker budget", () => {
    // A single per-worker budget (~1.13GB) or less → only the primary worker.
    expect(desiredEmbedPoolSize(0)).toBe(1);
    expect(desiredEmbedPoolSize(PER_WORKER_MEM_BUDGET_BYTES)).toBe(1);
    // Just under two budgets is still 1 (need a full budget of *headroom*).
    expect(desiredEmbedPoolSize(2 * PER_WORKER_MEM_BUDGET_BYTES - 1)).toBe(1);
  });

  it("grows to the default cap (2) when memory is ample", () => {
    expect(desiredEmbedPoolSize(2 * PER_WORKER_MEM_BUDGET_BYTES)).toBe(
      DEFAULT_MAX_EMBED_POOL,
    );
    expect(desiredEmbedPoolSize(64 * GB)).toBe(DEFAULT_MAX_EMBED_POOL);
  });

  it("honors an explicit configured ceiling above the default when memory allows", () => {
    expect(desiredEmbedPoolSize(64 * GB, 4)).toBe(4);
    // Fractional/loose configured values are floored.
    expect(desiredEmbedPoolSize(64 * GB, 3.9)).toBe(3);
  });

  it("caps configured at the absolute max", () => {
    expect(desiredEmbedPoolSize(1024 * GB, 100)).toBe(EMBED_POOL_ABS_MAX);
  });

  it("memory-gates a high configured ceiling down to what fits", () => {
    // Config asks for 4 but only ~3 budgets of RAM are free → 3.
    expect(desiredEmbedPoolSize(3 * PER_WORKER_MEM_BUDGET_BYTES, 4)).toBe(3);
    // Config asks for 4 but memory only fits the primary → 1.
    expect(desiredEmbedPoolSize(PER_WORKER_MEM_BUDGET_BYTES, 4)).toBe(1);
  });

  it("configured=1 forces a single worker regardless of memory", () => {
    expect(desiredEmbedPoolSize(1024 * GB, 1)).toBe(1);
  });

  it("never returns below 1, even for absurd/invalid inputs", () => {
    expect(desiredEmbedPoolSize(Number.NaN)).toBe(1);
    expect(desiredEmbedPoolSize(-100)).toBe(1);
    expect(desiredEmbedPoolSize(0, 8)).toBe(1);
  });
});
