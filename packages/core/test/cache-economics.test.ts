import { describe, expect, test } from "vitest";
import {
  type CacheEconomicsInput,
  decideCacheStrategy,
  strategyWantsCompaction,
  strategyWantsWarming,
} from "../src/cache-economics";

// Unit-agnostic pricing: the module only cares about the read/write ratio.
// Use read=1, write=12 (a ~12× miss premium, close to Anthropic 1h-cache Opus).
const READ = 1;
const WRITE = 12;

function decide(overrides: Partial<CacheEconomicsInput>) {
  return decideCacheStrategy({
    fullBodyTokens: 100_000,
    compressedTokens: 100_000,
    readPerToken: READ,
    writePerToken: WRITE,
    pReturn: 0.8,
    expectedCycles: 1,
    expectedFutureTurns: 5,
    ...overrides,
  });
}

describe("decideCacheStrategy — guards & fallback", () => {
  test("missing read pricing → low confidence, callers fall back", () => {
    const r = decide({ readPerToken: 0 });
    expect(r.confident).toBe(false);
    expect(r.strategy).toBe("cool-full-write");
  });

  test("missing write pricing → low confidence", () => {
    expect(decide({ writePerToken: 0 }).confident).toBe(false);
  });

  test("empty body → low confidence", () => {
    expect(decide({ fullBodyTokens: 0 }).confident).toBe(false);
  });

  test("valid pricing → confident", () => {
    expect(decide({}).confident).toBe(true);
  });
});

describe("decideCacheStrategy — core decisions", () => {
  test("small body, likely return → hold-warm (warming pays off)", () => {
    const r = decide({
      fullBodyTokens: 10_000,
      compressedTokens: 10_000, // small session: no compaction available
      pReturn: 0.9,
      expectedCycles: 1,
      expectedFutureTurns: 5,
    });
    expect(r.strategy).toBe("hold-warm");
    expect(strategyWantsWarming(r.strategy)).toBe(true);
    expect(r.holdWarmCost).toBeLessThan(r.coolFullWriteCost);
  });

  test("large body, many future turns, cheap compaction → cool-bust", () => {
    const r = decide({
      fullBodyTokens: 580_000,
      compressedTokens: 190_000,
      pReturn: 0.8,
      expectedCycles: 3,
      expectedFutureTurns: 20,
    });
    expect(r.strategy).toBe("cool-bust");
    expect(strategyWantsCompaction(r.strategy)).toBe(true);
    expect(strategyWantsWarming(r.strategy)).toBe(false);
    // cool-bust is strictly cheaper than both alternatives here.
    expect(r.coolBustCost).toBeLessThan(r.holdWarmCost);
    expect(r.coolBustCost).toBeLessThan(r.coolFullWriteCost);
  });

  test("session almost certainly finished (pReturn≈0) → never hold-warm", () => {
    const r = decide({ pReturn: 0 });
    expect(strategyWantsWarming(r.strategy)).toBe(false);
    // Keepalive is the only nonzero cost and it buys nothing.
    expect(r.holdWarmCost).toBeGreaterThan(0);
    expect(r.coolBustCost).toBe(0);
    expect(r.coolFullWriteCost).toBe(0);
  });
});

describe("decideCacheStrategy — reduces to classic warm-vs-cold when no compaction", () => {
  test("compressed == full + cheap warming → hold-warm", () => {
    const r = decide({
      fullBodyTokens: 20_000,
      compressedTokens: 20_000,
      pReturn: 0.8,
      expectedCycles: 1,
      expectedFutureTurns: 3,
    });
    expect(r.strategy).toBe("hold-warm");
  });

  test("compressed == full + warming not worth it → cool-full-write (not a phantom bust)", () => {
    // Many sunk-free cycles + modest return prob make keepalive dominate.
    const r = decide({
      fullBodyTokens: 100_000,
      compressedTokens: 100_000,
      pReturn: 0.3,
      expectedCycles: 10,
      expectedFutureTurns: 2,
    });
    expect(r.strategy).toBe("cool-full-write");
    expect(strategyWantsCompaction(r.strategy)).toBe(false);
    // With no real compaction, a bust must never be reported as cheaper.
    expect(r.coolBustCost).toBe(r.coolFullWriteCost);
  });
});

describe("decideCacheStrategy — monotonicity (the crux: ongoing cost of staying large)", () => {
  test("more future turns shifts a large session toward cool-bust", () => {
    const base = {
      fullBodyTokens: 400_000,
      compressedTokens: 150_000,
      pReturn: 0.7,
      expectedCycles: 2,
    };
    // Few remaining turns: ongoing cost barely matters → keep large.
    const few = decide({ ...base, expectedFutureTurns: 0 });
    // Many remaining turns: paying full-body read every turn dominates → compact.
    const many = decide({ ...base, expectedFutureTurns: 50 });
    expect(few.strategy).not.toBe("cool-bust");
    expect(many.strategy).toBe("cool-bust");
  });

  test("more expected warmup cycles shifts away from hold-warm", () => {
    const base = {
      fullBodyTokens: 30_000,
      compressedTokens: 30_000,
      pReturn: 0.85,
      expectedFutureTurns: 4,
    };
    expect(decide({ ...base, expectedCycles: 1 }).strategy).toBe("hold-warm");
    // Enough keepalive cycles eventually outweighs the avoided write.
    expect(
      strategyWantsWarming(decide({ ...base, expectedCycles: 50 }).strategy),
    ).toBe(false);
  });

  test("higher return probability shifts a small session toward hold-warm", () => {
    const base = {
      fullBodyTokens: 25_000,
      compressedTokens: 25_000,
      expectedCycles: 3,
      expectedFutureTurns: 4,
    };
    expect(
      strategyWantsWarming(decide({ ...base, pReturn: 0.1 }).strategy),
    ).toBe(false);
    expect(decide({ ...base, pReturn: 0.95 }).strategy).toBe("hold-warm");
  });
});

describe("decideCacheStrategy — exact cost arithmetic", () => {
  test("each cost term matches the formula exactly", () => {
    // F=200k, C=80k, r=1, w=12, p=0.5, k=2, f=4
    const r = decide({
      fullBodyTokens: 200_000,
      compressedTokens: 80_000,
      readPerToken: 1,
      writePerToken: 12,
      pReturn: 0.5,
      expectedCycles: 2,
      expectedFutureTurns: 4,
    });
    // holdWarm = k·F·r + p·(1+f)·F·r = 2·200000 + 0.5·5·200000
    expect(r.holdWarmCost).toBe(2 * 200_000 + 0.5 * 5 * 200_000);
    // coolBust = p·(C·w + f·C·r) = 0.5·(80000·12 + 4·80000)
    expect(r.coolBustCost).toBe(0.5 * (80_000 * 12 + 4 * 80_000));
    // coolFullWrite = p·(F·w + f·F·r) = 0.5·(200000·12 + 4·200000)
    expect(r.coolFullWriteCost).toBe(0.5 * (200_000 * 12 + 4 * 200_000));
  });
});

describe("decideCacheStrategy — strict-tie boundary (never pay to warm on a tie)", () => {
  // With compressed==full, holdWarm == coolFullWrite exactly when
  // p = k·r/(w−r). Pick r=1, w=3, k=1 ⇒ break-even p=0.5 (exact in float).
  const tie = {
    fullBodyTokens: 100_000,
    compressedTokens: 100_000,
    readPerToken: 1,
    writePerToken: 3,
    expectedCycles: 1,
    expectedFutureTurns: 3,
  };
  test("exactly at break-even → cool-full-write (not hold-warm)", () => {
    const r = decide({ ...tie, pReturn: 0.5 });
    expect(r.holdWarmCost).toBe(r.coolFullWriteCost); // genuine tie
    expect(r.strategy).toBe("cool-full-write");
  });
  test("just above break-even → hold-warm", () => {
    expect(decide({ ...tie, pReturn: 0.51 }).strategy).toBe("hold-warm");
  });
  test("just below break-even → cool-full-write", () => {
    expect(decide({ ...tie, pReturn: 0.49 }).strategy).toBe("cool-full-write");
  });
});

describe("decideCacheStrategy — non-finite inputs break confidence, not the contract", () => {
  test("undefined pricing (missing model) → confident:false, no NaN", () => {
    const r = decide({ readPerToken: undefined as unknown as number });
    expect(r.confident).toBe(false);
    expect(Number.isNaN(r.holdWarmCost)).toBe(false);
  });
  test("NaN write pricing → confident:false", () => {
    expect(decide({ writePerToken: Number.NaN }).confident).toBe(false);
  });
  test("Infinite body → confident:false", () => {
    expect(decide({ fullBodyTokens: Number.POSITIVE_INFINITY }).confident).toBe(
      false,
    );
  });
  test("NaN compressedTokens with valid pricing → treated as no-compaction, still confident", () => {
    // The reviewer's case: a NaN compaction figure must NOT silently suppress a
    // genuinely-cheapest hold-warm. Treated as compressed==full ⇒ hold-warm.
    const r = decide({
      fullBodyTokens: 10_000,
      compressedTokens: Number.NaN,
      pReturn: 0.95,
      expectedCycles: 1,
      expectedFutureTurns: 2,
    });
    expect(r.confident).toBe(true);
    expect(r.coolBustCost).toBe(r.coolFullWriteCost); // no phantom bust
    expect(r.strategy).toBe("hold-warm");
  });
  test("NaN expectedCycles/futureTurns are floored to 0 (no NaN leak)", () => {
    const r = decide({
      expectedCycles: Number.NaN,
      expectedFutureTurns: Number.NaN,
    });
    expect(r.confident).toBe(true);
    expect(Number.isFinite(r.holdWarmCost)).toBe(true);
    expect(Number.isFinite(r.coolBustCost)).toBe(true);
  });
});

describe("decideCacheStrategy — input hardening", () => {
  test("compressedTokens larger than full is clamped (no phantom benefit/crash)", () => {
    const r = decide({
      fullBodyTokens: 1_000,
      compressedTokens: 999_999,
      pReturn: 0.5,
    });
    expect(r.confident).toBe(true);
    // Clamped to full → bust offers nothing → never cheaper than full write.
    expect(r.coolBustCost).toBe(r.coolFullWriteCost);
    expect(strategyWantsCompaction(r.strategy)).toBe(false);
  });

  test("out-of-range pReturn is clamped to [0,1]", () => {
    const hi = decide({ pReturn: 2 });
    const at1 = decide({ pReturn: 1 });
    expect(hi.holdWarmCost).toBe(at1.holdWarmCost);
    expect(hi.coolBustCost).toBe(at1.coolBustCost);

    const lo = decide({ pReturn: -5 });
    const at0 = decide({ pReturn: 0 });
    expect(lo.coolBustCost).toBe(at0.coolBustCost);
  });

  test("negative cycles / future turns are floored at 0", () => {
    const neg = decide({ expectedCycles: -3, expectedFutureTurns: -10 });
    const zero = decide({ expectedCycles: 0, expectedFutureTurns: 0 });
    expect(neg.holdWarmCost).toBe(zero.holdWarmCost);
    expect(neg.coolBustCost).toBe(zero.coolBustCost);
  });
});

describe("strategy helpers", () => {
  test("strategyWantsWarming only for hold-warm", () => {
    expect(strategyWantsWarming("hold-warm")).toBe(true);
    expect(strategyWantsWarming("cool-bust")).toBe(false);
    expect(strategyWantsWarming("cool-full-write")).toBe(false);
  });

  test("strategyWantsCompaction only for cool-bust", () => {
    expect(strategyWantsCompaction("cool-bust")).toBe(true);
    expect(strategyWantsCompaction("hold-warm")).toBe(false);
    expect(strategyWantsCompaction("cool-full-write")).toBe(false);
  });
});
