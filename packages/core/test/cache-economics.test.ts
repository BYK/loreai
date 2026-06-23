import { describe, expect, test } from "vitest";
import {
  type CacheEconomicsInput,
  decideCacheStrategy,
  estimateMetaDistillCostPerCall,
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

describe("decideCacheStrategy — meta-aware cost model (#947)", () => {
  // The meta-aware adjustment accounts for the cost of intra-session meta-busts:
  // a mid-flight meta-distillation destroys the compressed-prefix advantage, so
  // the remaining `futureTurns` pay `full · read` instead of `compressed · read`.
  // Probability-weighted, additive to cool-bust only (not hold-warm / cool-full-write,
  // which already pay full-body on every return or have no advantage to lose).
  //
  //   expectedBusts    = clamp01(expectedFutureTurns / metaThreshold)
  //   bustCostPerBust  = (expectedFutureTurns / 2) × (full - compressed) × read
  //                    + metaDistillCostPerCall
  //   coolBust_actual  = coolBust_baseline + expectedBusts × bustCostPerBust
  //
  // The adjustment is gated on (a) compressed < full (no point adjusting if no
  // compaction was possible in the first place) and (b) meta fields are
  // meaningful (default 0 → no-op, byte-identical to current behavior).

  test("back-compat: missing meta fields → byte-identical to current behavior", () => {
    // Production session 0AVWKugtmhBKqLOX parameters; the call site doesn't
    // have a meta threshold configured yet, so the result is byte-identical
    // to the pre-#947 output.
    const r = decide({
      fullBodyTokens: 120_000,
      compressedTokens: 80_000,
      pReturn: 0.75,
      expectedCycles: 5.5,
      expectedFutureTurns: 15,
    });
    // holdWarm = 5.5·120k + 0.75·16·120k = 660k + 1440k = 2100k
    expect(r.holdWarmCost).toBe(5.5 * 120_000 + 0.75 * 16 * 120_000);
    // coolBust = 0.75·(80k·12 + 15·80k) = 0.75·(960k + 1200k) = 1620k
    expect(r.coolBustCost).toBe(0.75 * (80_000 * 12 + 15 * 80_000));
    // coolFullWrite = 0.75·(120k·12 + 15·120k) = 0.75·(1440k + 1800k) = 2430k
    expect(r.coolFullWriteCost).toBe(0.75 * (120_000 * 12 + 15 * 120_000));
    // No meta fields passed → expectedMetaBusts and metaBustCost are 0
    // (the new fields are observability only, not part of the decision).
    expect(r.expectedMetaBusts).toBe(0);
    expect(r.metaBustCost).toBe(0);
  });

  test("adjustment applies: with meta fields, coolBustCost is strictly greater than baseline", () => {
    // Same production session but with meta configured.
    const baseline = decide({
      fullBodyTokens: 120_000,
      compressedTokens: 80_000,
      pReturn: 0.75,
      expectedCycles: 5.5,
      expectedFutureTurns: 15,
    });
    const adjusted = decide({
      fullBodyTokens: 120_000,
      compressedTokens: 80_000,
      pReturn: 0.75,
      expectedCycles: 5.5,
      expectedFutureTurns: 15,
      metaThreshold: 20,
      metaDistillCostPerCall: 0.01,
    });
    expect(adjusted.coolBustCost).toBeGreaterThan(baseline.coolBustCost);
    // holdWarm and coolFullWrite are NOT adjusted (intentional — see plan).
    expect(adjusted.holdWarmCost).toBe(baseline.holdWarmCost);
    expect(adjusted.coolFullWriteCost).toBe(baseline.coolFullWriteCost);
  });

  test("adjustment is 0 when compressed == full (no compaction advantage to lose)", () => {
    // With no real compaction, meta-busts don't pay any 'lost advantage' — the
    // session is already paying full · read on every turn. The adjustment
    // must gate on compressed < full, so coolBustCost is unchanged.
    const baseline = decide({
      fullBodyTokens: 100_000,
      compressedTokens: 100_000, // no compaction available
      pReturn: 0.5,
      expectedCycles: 1,
      expectedFutureTurns: 10,
    });
    const adjusted = decide({
      fullBodyTokens: 100_000,
      compressedTokens: 100_000,
      pReturn: 0.5,
      expectedCycles: 1,
      expectedFutureTurns: 10,
      metaThreshold: 5,
      metaDistillCostPerCall: 0.5, // large — must NOT contribute
    });
    expect(adjusted.coolBustCost).toBe(baseline.coolBustCost);
    // And the no-compaction invariant still holds.
    expect(adjusted.coolBustCost).toBe(adjusted.coolFullWriteCost);
    // The adjustment term itself is gated to 0 in this case.
    expect(adjusted.metaBustCost).toBe(0);
    expect(adjusted.expectedMetaBusts).toBe(0);
  });

  test("decision flip: high expectedFutureTurns / low metaThreshold flips cool-bust → hold-warm", () => {
    // F=100k, C=50k, p=0.95, k=1, f=10, metaThreshold=2
    // Baseline: holdWarm = 1·100k + 0.95·11·100k = 100k + 1,045k = 1,145k
    //           coolBust = 0.95·(50k·12 + 10·50k) = 0.95·1,100k = 1,045k
    //           → cool-bust wins (1,045k < 1,145k)
    // Adjusted:  expectedBusts = clamp01(10/2) = 1.0
    //            bustCostPerBust = (10/2)·(100k-50k)·1 + 0.01 = 250,000.01
    //            metaBustCost = pReturn × expectedBusts × bustCostPerBust
    //                         = 0.95 × 1.0 × 250,000 = 237,500
    //            coolBust adjusted = 1,045,000 + 237,500 = 1,282,500
    //           → 1,282.5k > 1,145k → hold-warm wins
    const baseline = decide({
      fullBodyTokens: 100_000,
      compressedTokens: 50_000,
      pReturn: 0.95,
      expectedCycles: 1,
      expectedFutureTurns: 10,
    });
    expect(baseline.strategy).toBe("cool-bust");
    const adjusted = decide({
      fullBodyTokens: 100_000,
      compressedTokens: 50_000,
      pReturn: 0.95,
      expectedCycles: 1,
      expectedFutureTurns: 10,
      metaThreshold: 2,
      metaDistillCostPerCall: 0.01,
    });
    expect(adjusted.strategy).toBe("hold-warm");
  });

  test("tie-break preserved: strict <; adjustment does not flip a genuine tie", () => {
    // At the exact break-even (p=0.5 with k=1, r=1, w=3, F=C=100k, f=3),
    // holdWarm === coolFullWrite exactly. Adding a meta adjustment that
    // doesn't actually shift cool-bust past hold-warm must NOT flip the
    // strategy. (The adjustment targets cool-bust specifically; a large
    // metaThreshold pushes expectedBusts toward 0, so the adjustment is
    // small enough to leave the tie intact.)
    const tie = {
      fullBodyTokens: 100_000,
      compressedTokens: 100_000,
      readPerToken: 1,
      writePerToken: 3,
      pReturn: 0.5,
      expectedCycles: 1,
      expectedFutureTurns: 3,
      metaThreshold: 1000, // expectedBusts = 3/1000 = 0.003, tiny
      metaDistillCostPerCall: 0.01,
    };
    const r = decide(tie);
    expect(r.holdWarmCost).toBe(r.coolFullWriteCost);
    expect(r.strategy).toBe("cool-full-write"); // tie → never pay to warm
  });

  test("confidence invariant: missing meta fields but valid other inputs → still confident", () => {
    const r = decide({
      fullBodyTokens: 10_000,
      compressedTokens: 10_000,
      pReturn: 0.9,
      expectedCycles: 1,
      expectedFutureTurns: 2,
      // No meta fields passed.
    });
    expect(r.confident).toBe(true);
  });

  test("non-finite meta fields → treated as 0 (no adjustment, still confident)", () => {
    // Defensive: a model missing from the pricing table arrives here with
    // undefined/NaN pricing — the meta fields must follow the same convention
    // (treated as 0, no adjustment, confidence depends on the OTHER fields).
    const r = decide({
      fullBodyTokens: 10_000,
      compressedTokens: 5_000,
      pReturn: 0.8,
      expectedCycles: 1,
      expectedFutureTurns: 5,
      metaThreshold: undefined as unknown as number,
      metaDistillCostPerCall: undefined as unknown as number,
    });
    expect(r.confident).toBe(true);
    // No meta adjustment → coolBustCost matches the no-meta formula.
    const noMeta = decide({
      fullBodyTokens: 10_000,
      compressedTokens: 5_000,
      pReturn: 0.8,
      expectedCycles: 1,
      expectedFutureTurns: 5,
    });
    expect(r.coolBustCost).toBe(noMeta.coolBustCost);
  });

  test("pReturn scaling: metaBustCost is scaled by pReturn (Seer finding)", () => {
    // The meta-bust cost is conditional on the session returning. The expected
    // cost over the idle→return horizon is `pReturn × (expectedBusts ×
    // bustCostPerBust)`. Without this scaling, the adjustment would inflate
    // the cost for sessions unlikely to return (pReturn≈0), biasing the
    // strategy toward hold-warm when warming is the wrong call.
    const base = {
      fullBodyTokens: 100_000,
      compressedTokens: 50_000,
      expectedCycles: 1,
      expectedFutureTurns: 10,
      metaThreshold: 2,
      metaDistillCostPerCall: 0,
    };
    // expectedBusts=1.0, bustCostPerBust=250,000 (the LLM term is 0).
    const high = decide({ ...base, pReturn: 1.0 });
    const low = decide({ ...base, pReturn: 0.5 });
    // At pReturn=1.0: metaBustCost = 1.0 × 1.0 × 250,000 = 250,000
    // At pReturn=0.5: metaBustCost = 0.5 × 1.0 × 250,000 = 125,000
    expect(high.metaBustCost).toBe(250_000);
    expect(low.metaBustCost).toBe(125_000);
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

describe("estimateMetaDistillCostPerCall — pure LLM cost helper", () => {
  // The helper converts per-MTok worker model rates × estimated input/output
  // token counts into a per-call $/token figure. Direct unit tests are
  // load-bearing: the cache-economics tests pass metaDistillCostPerCall as a
  // pre-computed number, so a wrong formula in the helper would not be caught
  // by those tests (mutation E confirmed). The helpers's contract:

  test("null workerModel → 0 (caller had no pricing)", () => {
    expect(estimateMetaDistillCostPerCall(null, 20)).toBe(0);
  });

  test("undefined workerModel → 0", () => {
    expect(estimateMetaDistillCostPerCall(undefined, 20)).toBe(0);
  });

  test("workerModel with no cost → 0", () => {
    expect(estimateMetaDistillCostPerCall({ cost: {} }, 20)).toBe(0);
  });

  test("free model (cost.input=0) → 0 (falsy check)", () => {
    // A free model has no input cost; the helper's truthy check on
    // workerModel.cost.input suppresses the calculation. Conservative: a
    // partially-free model (cost.input=0, cost.output=5) is treated as
    // "unknown pricing" and returns 0 (falsy short-circuits the ||).
    expect(
      estimateMetaDistillCostPerCall({ cost: { input: 0, output: 0 } }, 20),
    ).toBe(0);
  });

  test("metaThreshold = 0 → 0 (no meta configured)", () => {
    expect(
      estimateMetaDistillCostPerCall({ cost: { input: 3, output: 15 } }, 0),
    ).toBe(0);
  });

  test("metaThreshold = -1 → 0 (defensive)", () => {
    expect(
      estimateMetaDistillCostPerCall({ cost: { input: 3, output: 15 } }, -1),
    ).toBe(0);
  });

  test("non-finite metaThreshold → 0", () => {
    expect(
      estimateMetaDistillCostPerCall(
        { cost: { input: 3, output: 15 } },
        Number.NaN,
      ),
    ).toBe(0);
    expect(
      estimateMetaDistillCostPerCall(
        { cost: { input: 3, output: 15 } },
        Number.POSITIVE_INFINITY,
      ),
    ).toBe(0);
  });

  test("Anthropic Sonnet-4 rates at metaThreshold=20, defaults: 3,000 / 2,048", () => {
    // Per-MTok → per-token: divide by 1_000_000.
    // input cost = 3/1M = 3e-6 $/token
    // output cost = 15/1M = 1.5e-5 $/token
    // metaInput = 20 × 3,000 = 60,000 tokens
    // metaOutput = 2,048 tokens
    // cost = 60,000 × 3e-6 + 2,048 × 1.5e-5 = 0.18 + 0.03072 = 0.21072
    expect(
      estimateMetaDistillCostPerCall({ cost: { input: 3, output: 15 } }, 20),
    ).toBeCloseTo(0.21072, 6);
  });

  test("Anthropic Opus-4 rates at metaThreshold=20: input=15, output=75", () => {
    // input = 15/1M, output = 75/1M
    // cost = 60,000 × 15/1M + 2,048 × 75/1M = 0.9 + 0.1536 = 1.0536
    expect(
      estimateMetaDistillCostPerCall({ cost: { input: 15, output: 75 } }, 20),
    ).toBeCloseTo(1.0536, 6);
  });

  test("custom avgSegmentTokens / metaOutputTokens overrides propagate", () => {
    // Smaller segments: metaInput = 5 × 1,000 = 5,000 tokens
    // Smaller output: 1,024 tokens
    // cost = 5,000 × 3e-6 + 1,024 × 1.5e-5 = 0.015 + 0.01536 = 0.03036
    expect(
      estimateMetaDistillCostPerCall(
        { cost: { input: 3, output: 15 } },
        5,
        1_000, // avgSegmentTokens
        1_024, // metaOutputTokens
      ),
    ).toBeCloseTo(0.03036, 6);
  });

  test("per-token scale: smaller values produce smaller costs (monotonicity)", () => {
    const small = estimateMetaDistillCostPerCall(
      { cost: { input: 3, output: 15 } },
      5,
    );
    const large = estimateMetaDistillCostPerCall(
      { cost: { input: 3, output: 15 } },
      20,
    );
    // Sanity: higher metaThreshold → more input tokens → higher cost.
    expect(large).toBeGreaterThan(small);
    // The output-cost component is constant, so the ratio is bounded by
    // `largeMetaThreshold / smallMetaThreshold = 4` (purely on the input
    // component). Real ratio is lower (2.78× at default token counts).
    expect(large).toBeLessThan(small * 4);
  });
});
