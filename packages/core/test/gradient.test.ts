import {
  describe,
  test,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
} from "vitest";
import { db, ensureProject, loadForceMinLayer } from "../src/db";
import {
  transform,
  setModelLimits,
  calibrate,
  resetCalibration,
  setLtmTokens,
  getLtmTokens,
  getLtmBudget,
  resetPrefixCache,
  resetRawWindowCache,
  resetDistillationSnapshot,
  setForceMinLayer,
  getLastLayer,
  estimateMessages,
  deduplicateToolOutputs,
  laterReadCovers,
  onIdleResume,
  consumeCameOutOfIdle,
  inspectSessionState,
  setLastTurnAtForTest,
  prefixPresentFloorApplies,
  recordCacheUsage,
  setCachePricing,
  setMaxLayer0Tokens,
  getCachePricing,
  shouldCompress,
  isFreeWriteSession,
  getTier,
  selectDistillations,
  exportDedupDecisions,
  importDedupDecisions,
  isLargeColdStart,
  saveGradientState,
  evictSession,
  type ModelBudget,
} from "../src/gradient";
import type { LoreMessage, LorePart, LoreMessageWithParts } from "../src/types";
import { isToolPart, isTextPart } from "../src/types";

const PROJECT = "/test/gradient/project";

// Test-local view of a tool part's state covering all status variants. Tests
// assert across statuses (pending/running/completed/error) so we widen to a
// single shape rather than narrowing per-status everywhere.
type TestToolState = {
  status: string;
  input?: unknown;
  output?: string;
  error?: string;
  metadata?: unknown;
  time?: { start: number; end?: number };
};

/** Narrow a LorePart to a tool part and expose its state for assertions. */
function toolStateOf(part: LorePart | undefined): TestToolState {
  if (!part || !isToolPart(part)) {
    throw new Error("expected tool part");
  }
  return part.state as unknown as TestToolState;
}

function makeMsg(
  id: string,
  role: "user" | "assistant",
  text: string,
  sessionID = "grad-sess",
): LoreMessageWithParts {
  const info: LoreMessage =
    role === "user"
      ? {
          id,
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: "build",
          model: {
            providerID: "anthropic",
            modelID: "claude-sonnet-4-20250514",
          },
        }
      : {
          id,
          sessionID,
          role: "assistant",
          time: { created: Date.now() },
          parentID: `parent-${id}`,
          modelID: "claude-sonnet-4-20250514",
          providerID: "anthropic",
          mode: "build",
          path: { cwd: "/test", root: "/test" },
          cost: 0,
          tokens: {
            input: 100,
            output: 50,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
        };
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

beforeAll(() => {
  ensureProject(PROJECT);
  // Set a small context for testing with zero overhead (no system prompt in tests)
  setModelLimits({ context: 10_000, output: 2_000 });
  calibrate(0); // zero overhead: no system prompt overhead in unit tests
});

describe("gradient", () => {
  test("passes through small message sets unchanged (Layer 0)", () => {
    const messages = [
      makeMsg("g-1", "user", "Hello, how are you?"),
      makeMsg("g-2", "assistant", "I'm ready to help."),
    ];
    const result = transform({
      messages,
      projectPath: PROJECT,
      sessionID: "grad-sess",
    });
    // Small messages fit within the context budget — layer 0 passthrough
    expect(result.layer).toBe(0);
    expect(result.messages).toBe(messages); // same reference — untouched
    expect(result.distilledTokens).toBe(0);
    expect(result.rawTokens).toBeGreaterThan(0);
  });

  test("handles many messages without crashing (Layer 0-2)", () => {
    const messages = Array.from({ length: 20 }, (_, i) => {
      const role = i % 2 === 0 ? "user" : "assistant";
      return makeMsg(
        `bulk-${i}`,
        role as "user" | "assistant",
        `Message content number ${i} with some padding text to take up token space.`,
      );
    });
    const result = transform({
      messages,
      projectPath: PROJECT,
      sessionID: "grad-sess",
    });
    expect(result.layer).toBeGreaterThanOrEqual(0);
    expect(result.layer).toBeLessThanOrEqual(4);
    expect(result.messages.length).toBeGreaterThan(0);
    expect(result.totalTokens).toBeGreaterThan(0);
  });

  test("Layer 4 nuclear always fits (token-budget tail)", () => {
    // Each message ~1100 tokens. With 1500 usable and rawBudget = 600,
    // even a single message exceeds the budget, forcing escalation to Layer 4.
    // Post-F7: layer 4 uses a token-budget tail (clamp(usable*0.25, 2K, 8K))
    // instead of a fixed slice(-3). With usable=1500, tailBudget = max(2000,
    // min(8000, 375)) = 2000. The current turn (last user + subsequent
    // assistants) is always included even when it alone exceeds the budget.
    const messages = Array.from({ length: 10 }, (_, i) => {
      const role = i % 2 === 0 ? "user" : "assistant";
      const text = `Message ${i}: ${"detailed content about various topics and implementation details that span across multiple concerns ".repeat(40)}`;
      return makeMsg(`nuclear-${i}`, role as "user" | "assistant", text);
    });
    setModelLimits({ context: 2_000, output: 500 }); // 1500 usable, rawBudget ~600
    calibrate(0); // keep overhead at zero for this test
    const result = transform({
      messages,
      projectPath: PROJECT,
      sessionID: "grad-sess",
    });
    expect(result.layer).toBeGreaterThanOrEqual(3);
    // Current turn is always included; budget is tight so not many extras.
    expect(result.messages.length).toBeGreaterThanOrEqual(1);
    // Reset
    setModelLimits({ context: 10_000, output: 2_000 });
    calibrate(0);
  });

  test("Layer 4 includes more than 3 messages when budget allows (tiny messages)", () => {
    // With tiny messages (~15 tokens each) and usable = 10_000,
    // tailBudget = max(2000, min(8000, 2500)) = 2500 → can fit ~160 tiny messages.
    // Verify that more than the old fixed 3 are included.
    const messages = Array.from({ length: 20 }, (_, i) => {
      const role = i % 2 === 0 ? "user" : "assistant";
      return makeMsg(
        `tiny-${i}`,
        role as "user" | "assistant",
        `Msg ${i}: short`,
      );
    });
    setModelLimits({ context: 12_000, output: 2_000 }); // usable ~10000
    calibrate(0);
    const result = transform({
      messages,
      projectPath: PROJECT,
      sessionID: "grad-tiny-sess",
    });
    // Should hit layer 4 because there are no distillations and the total
    // raw exceeds rawBudget. The key assertion: more than 3 raw messages
    // are kept (the old fixed limit).
    if (result.layer === 4) {
      expect(result.messages.length).toBeGreaterThan(3);
    }
    // Reset
    setModelLimits({ context: 10_000, output: 2_000 });
    calibrate(0);
  });

  test("refreshLtm is true on Layer 4 and false on lower layers", () => {
    // Layer 0: small messages fit easily
    setModelLimits({ context: 10_000, output: 2_000 });
    calibrate(0);
    const smallMessages = [
      makeMsg("ltm-flag-1", "user", "Hello"),
      makeMsg("ltm-flag-2", "assistant", "Hi there"),
    ];
    const layer0Result = transform({
      messages: smallMessages,
      projectPath: PROJECT,
      sessionID: "ltm-flag-sess",
    });
    expect(layer0Result.layer).toBe(0);
    expect(layer0Result.refreshLtm).toBe(false);

    // Layers 1-3: moderate pressure triggers compression stages
    // context=3000, output=500 → usable=2500, rawBudget~1000
    // 14 messages × ~250 tokens each ≈ 3500 > 1000 raw budget → forces layer 1+
    // but messages are small enough that compression stages 1-3 can fit them
    setModelLimits({ context: 3_000, output: 500 });
    calibrate(0);
    const medMessages = Array.from({ length: 14 }, (_, i) => {
      const role = i % 2 === 0 ? "user" : "assistant";
      const text = `Message ${i}: ${"some content that fills the budget moderately well ".repeat(8)}`;
      return makeMsg(
        `ltm-flag-med-${i}`,
        role as "user" | "assistant",
        text,
        "ltm-flag-med-sess",
      );
    });
    const layerMidResult = transform({
      messages: medMessages,
      projectPath: PROJECT,
      sessionID: "ltm-flag-med-sess",
    });
    expect(layerMidResult.layer).toBeGreaterThanOrEqual(1);
    expect(layerMidResult.layer).toBeLessThanOrEqual(3);
    expect(layerMidResult.refreshLtm).toBe(false);

    // Layer 4: force emergency with tight context
    setModelLimits({ context: 2_000, output: 500 });
    calibrate(0);
    const bigMessages = Array.from({ length: 10 }, (_, i) => {
      const role = i % 2 === 0 ? "user" : "assistant";
      const text = `Message ${i}: ${"detailed content about various topics and implementation details that span across multiple concerns ".repeat(40)}`;
      return makeMsg(
        `ltm-flag-big-${i}`,
        role as "user" | "assistant",
        text,
        "ltm-flag-big-sess",
      );
    });
    const layer4Result = transform({
      messages: bigMessages,
      projectPath: PROJECT,
      sessionID: "ltm-flag-big-sess",
    });
    expect(layer4Result.layer).toBe(4);
    expect(layer4Result.refreshLtm).toBe(true);

    // Reset
    setModelLimits({ context: 10_000, output: 2_000 });
    calibrate(0);
  });

  test("returns valid token estimates", () => {
    const messages = [
      makeMsg("tok-1", "user", "Test message"),
      makeMsg("tok-2", "assistant", "Response message"),
    ];
    const result = transform({
      messages,
      projectPath: PROJECT,
      sessionID: "grad-sess",
    });
    expect(result.rawTokens).toBeGreaterThan(0);
    expect(result.totalTokens).toBe(result.distilledTokens + result.rawTokens);
  });

  test("activates gradient mode when context is exhausted", () => {
    // Force context exhaustion: context=2000, output=500 → usable=1500
    // Each message ~550 tokens, 6 messages ~3300 tokens > 1500 usable
    setModelLimits({ context: 2_000, output: 500 });
    calibrate(0);
    const messages = Array.from({ length: 6 }, (_, i) => {
      const role = i % 2 === 0 ? "user" : "assistant";
      return makeMsg(
        `exhaust-${i}`,
        role as "user" | "assistant",
        "X".repeat(2_000),
      );
    });
    const result = transform({
      messages,
      projectPath: PROJECT,
      sessionID: "exhaust-sess",
    });
    expect(result.layer).toBeGreaterThanOrEqual(1);
    // Reset
    setModelLimits({ context: 10_000, output: 2_000 });
    calibrate(0);
  });
});

describe("gradient — lazy raw window eviction (Approach B)", () => {
  // context=5000, output=1000 → usable=4000, rawBudget=floor(4000*0.4)=1600
  // Each ~1000-char message ≈ 354 tokens (1000 chars/3 + 20 overhead).
  // 16 messages ≈ 5664 > 4000 → gradient fires.
  const SESSION = "lazy-evict-sess";

  beforeAll(() => {
    setModelLimits({ context: 5_000, output: 1_000 });
    calibrate(0);
    resetPrefixCache();
    resetRawWindowCache();
  });

  afterAll(() => {
    // Restore default limits so subsequent test suites aren't affected
    setModelLimits({ context: 10_000, output: 2_000 });
    calibrate(0);
    resetPrefixCache();
    resetRawWindowCache();
  });

  test("raw window is stable when the new turn fits", () => {
    // Build a conversation that exhausts the context so gradient mode fires.
    // usable=4000; each message ≈ 354 tokens (1000 chars/3 + 20 overhead).
    // 16 messages ≈ 5664 > 4000 → gradient fires.
    // rawBudget=1600 → fits ~4 messages (4 × 354 = 1416 ≤ 1600).
    const base = Array.from({ length: 16 }, (_, i) =>
      makeMsg(
        `le-${i}`,
        i % 2 === 0 ? "user" : "assistant",
        "A".repeat(1_000),
        SESSION,
      ),
    );

    const result1 = transform({
      messages: base,
      projectPath: PROJECT,
      sessionID: SESSION,
    });
    expect(result1.layer).toBe(1);

    // Identify the first raw message from turn 1
    const firstRawId1 = result1.messages.find(
      (m) => m.info.sessionID === SESSION,
    )?.info.id;
    expect(firstRawId1).toBeDefined();

    // Turn 2: append one small new message — should NOT evict anything
    const withNewSmall = [
      ...base,
      makeMsg(`le-new-small`, "user", "short", SESSION),
    ];
    const result2 = transform({
      messages: withNewSmall,
      projectPath: PROJECT,
      sessionID: SESSION,
    });
    expect(result2.layer).toBe(1);

    const firstRawId2 = result2.messages.find(
      (m) => m.info.sessionID === SESSION,
    )?.info.id;

    // The raw window should start at the same message — no eviction
    expect(firstRawId2).toBe(firstRawId1);
  });

  test("raw window advances only when the new message forces eviction", () => {
    resetRawWindowCache();

    // context=3000, output=500 → usable=2500, rawBudget=floor(2500*0.4)=1000
    // Each 400-char message ≈ 154 tokens (400 chars/3 + 20 overhead).
    // 22 messages ≈ 3388 > 2500 → gradient fires.
    setModelLimits({ context: 3_000, output: 500 });
    calibrate(0);

    const SESS2 = "lazy-evict-tight";
    const base = Array.from({ length: 22 }, (_, i) =>
      makeMsg(
        `tight-${i}`,
        i % 2 === 0 ? "user" : "assistant",
        "B".repeat(400),
        SESS2,
      ),
    );

    // First call: fills window, records cutoff
    const r1 = transform({
      messages: base,
      projectPath: PROJECT,
      sessionID: SESS2,
    });
    expect(r1.layer).toBe(1);
    const firstId1 = r1.messages.find((m) => m.info.sessionID === SESS2)?.info
      .id;

    // Second call: append a large message that pushes the pinned window past
    // rawBudget (1000), forcing eviction. C(2000) = 687 tokens — fits within
    // rawBudget alone, but combined with pinned base messages forces re-scan.
    const withHuge = [
      ...base,
      makeMsg(`tight-huge`, "user", "C".repeat(2_000), SESS2),
    ];
    const r2 = transform({
      messages: withHuge,
      projectPath: PROJECT,
      sessionID: SESS2,
    });
    expect(r2.layer).toBe(1);
    const firstId2 = r2.messages.find((m) => m.info.sessionID === SESS2)?.info
      .id;

    // The window must have advanced (old pinned cutoff no longer fits)
    expect(firstId2).not.toBe(firstId1);

    // Reset back
    setModelLimits({ context: 5_000, output: 1_000 });
    calibrate(0);
  });

  test("raw window cache resets on session change", () => {
    resetRawWindowCache();

    // context=3000, output=500 → usable=2500
    // 22 × 400-char messages ≈ 3388 > 2500 → gradient fires
    setModelLimits({ context: 3_000, output: 500 });
    calibrate(0);

    const SESS_A = "lazy-sess-a";
    const SESS_B = "lazy-sess-b";

    const msgsA = Array.from({ length: 22 }, (_, i) =>
      makeMsg(
        `sa-${i}`,
        i % 2 === 0 ? "user" : "assistant",
        "D".repeat(400),
        SESS_A,
      ),
    );
    const msgsB = Array.from({ length: 22 }, (_, i) =>
      makeMsg(
        `sb-${i}`,
        i % 2 === 0 ? "user" : "assistant",
        "E".repeat(400),
        SESS_B,
      ),
    );

    const rA = transform({
      messages: msgsA,
      projectPath: PROJECT,
      sessionID: SESS_A,
    });
    expect(rA.layer).toBe(1);
    const firstIdA = rA.messages.find((m) => m.info.sessionID === SESS_A)?.info
      .id;

    // Switch to a different session — cache must not bleed over
    const rB = transform({
      messages: msgsB,
      projectPath: PROJECT,
      sessionID: SESS_B,
    });
    expect(rB.layer).toBe(1);
    const firstIdB = rB.messages.find((m) => m.info.sessionID === SESS_B)?.info
      .id;

    expect(firstIdB).not.toBe(firstIdA);
    expect(firstIdB?.startsWith("sb-")).toBe(true);

    // Reset
    setModelLimits({ context: 5_000, output: 1_000 });
    calibrate(0);
    resetRawWindowCache();
  });

  test("raw window boundary stays pinned across many growing turns at the budget ceiling", () => {
    // Regression for the layer-1 per-turn cache-bust march (session
    // 0AVWKugtmhBKqLOX9): when the raw window sits AT the rawBudget ceiling,
    // each turn's ~2 new messages overflow the 15% pin hysteresis. Before the
    // chunked-eviction fix, tryFitStable re-pinned right back at the ceiling
    // with the boundary advanced ~2 messages — so the start boundary marched
    // forward EVERY turn, busting the prompt cache each time. With the fix, an
    // overflow evicts a chunk (down to RAW_WINDOW_EVICT_TARGET of budget),
    // leaving headroom so the boundary holds for many turns between steps.
    resetRawWindowCache();
    // context=20000, output=4000 → usable=16000, rawBudget=floor(16000*0.4)=6400.
    // Each 1000-char message ≈ 354 tokens (1000/3 + 20). ~18 raw msgs saturate
    // the budget (18×354=6372 ≤ 6400), so the window sits at the ceiling.
    setModelLimits({ context: 20_000, output: 4_000 });
    calibrate(0);

    const SESS = "pin-ceiling-march";
    // Start with a saturated conversation so gradient fires at layer 1 and the
    // raw window is pinned right at the ceiling.
    const msgs = Array.from({ length: 40 }, (_, i) =>
      makeMsg(
        `march-${i}`,
        i % 2 === 0 ? "user" : "assistant",
        "A".repeat(1_000),
        SESS,
      ),
    );

    const r0 = transform({
      messages: msgs,
      projectPath: PROJECT,
      sessionID: SESS,
    });
    expect(r0.layer).toBe(1);

    const firstRawId = (r: { messages: typeof msgs }) =>
      r.messages.find((m) => m.info.sessionID === SESS)?.info.id;

    // Simulate 12 consecutive turns, each appending a user+assistant pair sized
    // so a single turn's growth (~1374 tokens ≈ 21% of the 6400 budget) exceeds
    // the 15% pin hysteresis on its own. Pre-fix, that means the pin overflows
    // and re-pins at the ceiling EVERY turn → boundary advances every turn.
    const boundaries: (string | undefined)[] = [firstRawId(r0)];
    for (let turn = 0; turn < 12; turn++) {
      msgs.push(
        makeMsg(`march-u-${turn}`, "user", "A".repeat(2_000), SESS),
        makeMsg(`march-a-${turn}`, "assistant", "A".repeat(2_000), SESS),
      );
      const r = transform({
        messages: msgs,
        projectPath: PROJECT,
        sessionID: SESS,
      });
      expect(r.layer).toBe(1);
      boundaries.push(firstRawId(r));
    }

    // Count how many turns advanced the boundary. A marching boundary (the bug)
    // advances on every one of the 12 turns. With chunked eviction the boundary
    // holds for several turns between steps (~25% headroom / ~21% growth).
    let advances = 0;
    for (let i = 1; i < boundaries.length; i++) {
      if (boundaries[i] !== boundaries[i - 1]) advances++;
    }
    // Strong guard: pre-fix advances ≈ 12 (every turn); post-fix ≤ 6 (chunked
    // steps with headroom). The bound cleanly separates the two regimes.
    expect(advances).toBeLessThanOrEqual(6);
    // Sanity: the pin must actually hold for some turns (not a sliding window).
    expect(advances).toBeLessThan(10);

    // Reset
    setModelLimits({ context: 5_000, output: 1_000 });
    calibrate(0);
    resetRawWindowCache();
  });
});

describe("gradient — LTM budget coordination", () => {
  beforeAll(() => {
    setModelLimits({ context: 10_000, output: 2_000 });
    calibrate(0); // zero overhead for these tests
  });

  test("getLtmBudget returns fraction of usable context, quantized to LTM_BUDGET_STEP", () => {
    // usable = 10_000 - 2_000 - 0 (overhead) = 8_000
    // ltm fraction 0.10 → raw 800 → quantized to nearest 8_000 step, floored at
    // one step so LTM is never disabled on small-context models → 8_000.
    const budget = getLtmBudget(0.1);
    expect(budget).toBe(8_000);
  });

  test("getLtmBudget respects different fractions (quantized, never below one step)", () => {
    // raw 2_000 → rounds to 0 step but floored to one step (8_000).
    expect(getLtmBudget(0.25)).toBe(8_000);
    // raw 400 → floored to one step (8_000).
    expect(getLtmBudget(0.05)).toBe(8_000);
  });

  test("getLtmBudget returns 0 only when there is no usable budget", () => {
    setModelLimits({ context: 1_000, output: 1_000 }); // usable = 0
    calibrate(0);
    expect(getLtmBudget(0.1)).toBe(0);
    setModelLimits({ context: 10_000, output: 2_000 });
    calibrate(0);
  });

  test("getLtmBudget is STABLE across per-turn overhead wobble (no LTM set churn)", () => {
    // Regression for the LTM-delta-churn cache bust: `usable` is derived from
    // the per-turn calibrated-overhead EMA, which wobbles every turn. If
    // getLtmBudget passes that wobble straight through, the ltm.forSession
    // packing boundary moves every turn → the selected LTM set changes → a new
    // durable prompt-delta is appended into the cached message prefix → the
    // prompt cache busts every turn. The budget must be QUANTIZED so normal
    // overhead wobble does not move it.
    //
    // Large context (1M) so the absolute overhead swing is production-scale.
    setModelLimits({ context: 1_000_000, output: 32_000 });
    resetCalibration();

    const SID = "ltm-budget-wobble-sess";
    // Seed lastTransformEstimate via a real transform so calibrate() has a
    // baseline to compare actualInput against.
    const msgs = Array.from({ length: 4 }, (_, i) =>
      makeMsg(`wobble-${i}`, i % 2 === 0 ? "user" : "assistant", "hello", SID),
    );
    transform({ messages: msgs, projectPath: PROJECT, sessionID: SID });

    // Drive several turns whose real input swings by tens of thousands of
    // tokens (exactly what production showed: usable swinging 940K↔797K). Each
    // calibrate() call moves calibratedOverhead, hence `usable`, hence the raw
    // (un-quantized) LTM budget.
    const wobblingInputs = [
      120_000, 260_000, 130_000, 280_000, 140_000, 250_000, 135_000,
    ];
    const budgets = new Set<number>();
    for (const input of wobblingInputs) {
      // Re-seed the transform estimate each turn so calibrate has a baseline
      // and the overhead (actualInput - estimate) genuinely varies.
      transform({ messages: msgs, projectPath: PROJECT, sessionID: SID });
      calibrate(input, SID, msgs.length);
      budgets.add(getLtmBudget(0.05));
    }

    // The fix quantizes the budget so all these wobbling turns collapse to a
    // tiny number of distinct values. Pre-fix, every turn yields a different
    // budget (one per distinct overhead) → set churn. We require the budget to
    // take at most 2 distinct values across 7 wildly-varying-overhead turns.
    expect(
      budgets.size,
      `LTM budget changed ${budgets.size} times across overhead wobble ` +
        `(values=${[...budgets].join(",")}). A wobbling budget moves the ` +
        `forSession packing boundary and churns the pinned LTM set every turn ` +
        `(regression: LTM-delta-churn cache bust). The budget must be quantized.`,
    ).toBeLessThanOrEqual(2);

    // Restore the shared test baseline: resetCalibration() alone leaves
    // calibratedOverhead null → getLtmBudget falls back to FIRST_TURN_OVERHEAD
    // (15K), which would zero out usable for the small-context tests that
    // follow. calibrate(0) pins overhead to 0 like the other tests expect.
    resetCalibration();
    setModelLimits({ context: 10_000, output: 2_000 });
    calibrate(0);
  });

  test("setLtmTokens / getLtmTokens round-trip", () => {
    setLtmTokens(1_500, "ltm-rt-sess");
    expect(getLtmTokens("ltm-rt-sess")).toBe(1_500);
    setLtmTokens(0, "ltm-rt-sess");
    expect(getLtmTokens("ltm-rt-sess")).toBe(0);
    // Fallback (no session ID) still works
    setLtmTokens(1_500);
    expect(getLtmTokens()).toBe(1_500);
    setLtmTokens(0);
    expect(getLtmTokens()).toBe(0);
  });

  test("LTM tokens are deducted from usable context in transform()", () => {
    setLtmTokens(2_000, "ltm-sess"); // inject 2K LTM tokens (per-session)
    // usable before LTM = 8_000; after = 6_000
    // rawBudget = floor(6_000 * 0.4) = 2_400
    const messages = [
      makeMsg("ltm-1", "user", "A".repeat(100)),
      makeMsg("ltm-2", "assistant", "B".repeat(100)),
    ];
    const result = transform({
      messages,
      projectPath: PROJECT,
      sessionID: "ltm-sess",
    });
    expect(result.usable).toBe(6_000);
    setLtmTokens(0, "ltm-sess"); // reset
  });

  test("LTM token deduction triggers lower layers when budget is tight", () => {
    // Inject enough LTM tokens to leave almost no room for messages
    setLtmTokens(7_500, "tight-sess"); // usable after LTM = 500 tokens — very tight
    const messages = Array.from({ length: 6 }, (_, i) =>
      makeMsg(
        `tight-${i}`,
        i % 2 === 0 ? "user" : "assistant",
        "X".repeat(300),
      ),
    );
    const result = transform({
      messages,
      projectPath: PROJECT,
      sessionID: "tight-sess",
    });
    // Should escalate beyond layer 0 due to budget pressure
    expect(result.layer).toBeGreaterThanOrEqual(1);
    expect(result.messages.length).toBeGreaterThan(0);
    setLtmTokens(0, "tight-sess"); // reset
  });
});

describe("gradient — force escalation (reactive error recovery)", () => {
  beforeAll(() => {
    setModelLimits({ context: 10_000, output: 2_000 });
    calibrate(0);
    resetPrefixCache();
    resetRawWindowCache();
  });

  test("setForceMinLayer(2) skips layers 0 and 1", () => {
    // Messages that would normally fit in layer 0 (tiny)
    const messages = [
      makeMsg("fe-1", "user", "hello", "force-sess"),
      makeMsg("fe-2", "assistant", "hi", "force-sess"),
    ];
    setForceMinLayer(2, "force-sess");
    const result = transform({
      messages,
      projectPath: PROJECT,
      sessionID: "force-sess",
    });
    // Despite tiny messages, force min layer should push to at least layer 2
    expect(result.layer).toBeGreaterThanOrEqual(2);
    // After one use, the forceMinLayer flag is consumed (proven directly below).
    // The resulting layer drops from the forced 2 to 1 — NOT back to 0 — because
    // the prefix-present floor holds a once-compressed session at Layer >= 1
    // (prefixPresentFloorApplies). The 2→1 drop proves the flag was consumed.
    expect(loadForceMinLayer("force-sess")).toBe(0);
    const result2 = transform({
      messages,
      projectPath: PROJECT,
      sessionID: "force-sess",
    });
    expect(result2.layer).toBe(1);
  });

  test("forceMinLayer is one-shot — cleared after single use", () => {
    const messages = [
      makeMsg("os-1", "user", "test", "oneshot-sess"),
      makeMsg("os-2", "assistant", "ok", "oneshot-sess"),
    ];
    setForceMinLayer(2, "oneshot-sess");
    // First call consumes the flag (forces layer >= 2).
    const r1 = transform({
      messages,
      projectPath: PROJECT,
      sessionID: "oneshot-sess",
    });
    expect(r1.layer).toBeGreaterThanOrEqual(2);
    // Flag is consumed (one-shot) — proven directly.
    expect(loadForceMinLayer("oneshot-sess")).toBe(0);
    // Second call — no flag. The layer drops from 2, but the prefix-present
    // floor holds it at 1 (a once-compressed session never re-enters Layer 0
    // absent a genuine compaction). The 2→1 drop confirms the flag was consumed.
    const r2 = transform({
      messages,
      projectPath: PROJECT,
      sessionID: "oneshot-sess",
    });
    expect(r2.layer).toBe(1);
  });

  test("resetCalibration clears forceMinLayer", () => {
    setForceMinLayer(3, "rc-sess");
    resetCalibration();
    calibrate(0); // re-establish zero overhead after reset
    const messages = [
      makeMsg("rc-1", "user", "hello", "rc-sess"),
      makeMsg("rc-2", "assistant", "world", "rc-sess"),
    ];
    // After reset+recalibrate, flag is gone — tiny messages → layer 0
    const result = transform({
      messages,
      projectPath: PROJECT,
      sessionID: "rc-sess",
    });
    expect(result.layer).toBe(0);
  });
});

describe("gradient — forceMinLayer persistence (restart survival)", () => {
  beforeAll(() => {
    setModelLimits({ context: 10_000, output: 2_000 });
    calibrate(0);
    resetPrefixCache();
    resetRawWindowCache();
  });

  test("persisted forceMinLayer is loaded by getSessionState on cold start", () => {
    const SID = "persist-cold-sess";
    const messages = [
      makeMsg("pc-1", "user", "hello", SID),
      makeMsg("pc-2", "assistant", "hi", SID),
    ];

    // Ensure no in-memory state exists for this session
    resetCalibration(SID);
    calibrate(0);

    // Manually write forceMinLayer to DB (simulating a prior process's setForceMinLayer)
    db()
      .query(
        "INSERT OR REPLACE INTO session_state (session_id, force_min_layer, updated_at) VALUES (?, ?, ?)",
      )
      .run(SID, 2, Date.now());

    // transform() should pick up forceMinLayer=2 from DB
    const result = transform({
      messages,
      projectPath: PROJECT,
      sessionID: SID,
    });
    expect(result.layer).toBeGreaterThanOrEqual(2);

    // One-shot: consumed — DB should be cleared
    expect(loadForceMinLayer(SID)).toBe(0);

    // Next call: the forced flag is gone, but the prefix-present floor holds a
    // once-compressed session at Layer 1 (no re-entry to Layer 0 absent a
    // genuine compaction). The 2→1 drop confirms the flag was consumed.
    const result2 = transform({
      messages,
      projectPath: PROJECT,
      sessionID: SID,
    });
    expect(result2.layer).toBe(1);
  });

  test("setForceMinLayer writes to DB and transform consumes it", () => {
    const SID = "persist-consume-sess";
    const messages = [
      makeMsg("pco-1", "user", "hello", SID),
      makeMsg("pco-2", "assistant", "hi", SID),
    ];

    resetCalibration(SID);
    calibrate(0);

    setForceMinLayer(3, SID);
    expect(loadForceMinLayer(SID)).toBe(3);

    // Transform consumes the escalation
    const result = transform({
      messages,
      projectPath: PROJECT,
      sessionID: SID,
    });
    expect(result.layer).toBeGreaterThanOrEqual(3);

    // DB row should be deleted after consumption
    expect(loadForceMinLayer(SID)).toBe(0);
  });
});

describe("gradient — exact token tracking (proactive layer 0)", () => {
  const SESSION = "exact-tok-sess";

  beforeEach(() => {
    setModelLimits({ context: 10_000, output: 2_000 });
    resetCalibration();
    resetPrefixCache();
    resetRawWindowCache();
  });

  test("uses exact lastKnownInput for layer 0 check when session matches", () => {
    const messages = [
      makeMsg("et-1", "user", "A".repeat(500), SESSION),
      makeMsg("et-2", "assistant", "B".repeat(500), SESSION),
    ];
    // Simulate a prior API response: 3000 tokens in, 2 messages
    // (overhead 0 so actual = message estimate)
    calibrate(3_000, SESSION, 2);

    // Now add one new message
    const withNew = [
      ...messages,
      makeMsg("et-3", "user", "C".repeat(500), SESSION),
    ];
    // expectedInput = 3000 + ~130 = ~3130 << maxInput (8000) → layer 0
    const result = transform({
      messages: withNew,
      projectPath: PROJECT,
      sessionID: SESSION,
    });
    expect(result.layer).toBe(0);
    expect(result.messages).toBe(withNew); // same reference
  });

  test("falls back to chars/3 estimate when session changes", () => {
    // calibrate was for SESSION, but we transform a different session.
    // First zero the overhead (beforeEach resets to null → FIRST_TURN_OVERHEAD=15K).
    calibrate(0);
    calibrate(3_000, SESSION, 2);
    const messages = [
      makeMsg("diff-1", "user", "A".repeat(200), "other-sess"),
      makeMsg("diff-2", "assistant", "B".repeat(200), "other-sess"),
    ];
    // Fallback: messageTokens + overhead(0) + ltm(0) = ~174 << 8000 → still layer 0
    const result = transform({
      messages,
      projectPath: PROJECT,
      sessionID: "other-sess",
    });
    expect(result.layer).toBe(0);
  });

  test("exact tracking prevents overflow: near-limit session stays layer 0", () => {
    // maxInput = 10000 - 2000 = 8000, hard ceiling = 8000 * 0.95 = 7600
    // Set lastKnownInput close to limit but within the hard ceiling margin
    calibrate(7_400, SESSION, 10);
    // New message: very short (~25 tokens × 1.3 safety = ~33 tokens)
    const messages = Array.from({ length: 10 }, (_, i) =>
      makeMsg(
        `near-${i}`,
        i % 2 === 0 ? "user" : "assistant",
        "X".repeat(50),
        SESSION,
      ),
    );
    const withNew = [...messages, makeMsg("near-new", "user", "hi", SESSION)];
    // expectedInput ≈ 7400 + 33 = 7433 ≤ 7600 → layer 0
    const result = transform({
      messages: withNew,
      projectPath: PROJECT,
      sessionID: SESSION,
    });
    expect(result.layer).toBe(0);
  });

  test("exact tracking escalates when new messages push over limit", () => {
    // lastKnownInput = 7900, maxInput = 8000, new message ~600 tokens
    calibrate(7_900, SESSION, 10);
    const messages = Array.from({ length: 10 }, (_, i) =>
      makeMsg(
        `over-${i}`,
        i % 2 === 0 ? "user" : "assistant",
        "X".repeat(100),
        SESSION,
      ),
    );
    const withHuge = [
      ...messages,
      makeMsg("over-huge", "user", "Y".repeat(2_200), SESSION),
    ];
    // expectedInput ≈ 7900 + 570 = 8470 > 8000 → escalate
    const result = transform({
      messages: withHuge,
      projectPath: PROJECT,
      sessionID: SESSION,
    });
    expect(result.layer).toBeGreaterThanOrEqual(1);
  });
});

// Helper: make an assistant message that is a "sibling step" in an agentic
// tool-call loop — same parentID as the last user message.
function makeStep(
  id: string,
  parentUserID: string,
  text: string,
  sessionID = "grad-sess",
): LoreMessageWithParts {
  const info: LoreMessage = {
    id,
    sessionID,
    role: "assistant",
    time: { created: Date.now() },
    parentID: parentUserID,
    modelID: "claude-sonnet-4-20250514",
    providerID: "anthropic",
    mode: "build",
    path: { cwd: "/test", root: "/test" },
    cost: 0,
    tokens: {
      input: 100,
      output: 50,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
  };
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

describe("gradient — current turn protection (agentic tool-call loop)", () => {
  const SESSION = "turn-protect-sess";

  beforeEach(() => {
    resetCalibration();
    resetPrefixCache();
    resetRawWindowCache();
    // Small context to make overflow happen with fewer messages
    setModelLimits({ context: 5_000, output: 1_000 });
    calibrate(0); // zero overhead
    ensureProject(PROJECT);
  });

  test("all current-turn agentic steps are included in the compressed window", () => {
    // context=10000, output=2000, maxInput=8000, rawBudget ≈ 5600
    // Old messages: 40 × 600 chars ≈ 6000 tokens — exceeds rawBudget alone
    const oldMsgs = Array.from({ length: 40 }, (_, i) =>
      makeMsg(
        `old-${i}`,
        i % 2 === 0 ? "user" : "assistant",
        "X".repeat(600),
        SESSION,
      ),
    );
    // Current turn: user + 4 agentic steps × 400 chars ≈ 450 tokens — must all be kept
    const currentUser = makeMsg("cur-user", "user", "do the thing", SESSION);
    const steps = Array.from({ length: 4 }, (_, i) =>
      makeStep(
        `step-${i}`,
        "cur-user",
        `tool result ${"Y".repeat(380)}`,
        SESSION,
      ),
    );
    const messages = [...oldMsgs, currentUser, ...steps];

    const result = transform({
      messages,
      projectPath: PROJECT,
      sessionID: SESSION,
    });

    // Should be in gradient mode (too many messages to fit raw)
    expect(result.layer).toBeGreaterThanOrEqual(1);

    // The current user message must be in the window
    const ids = result.messages.map((m) => m.info.id);
    expect(ids).toContain("cur-user");

    // All 4 steps must be in the window — none dropped
    for (let i = 0; i < 4; i++) {
      expect(ids).toContain(`step-${i}`);
    }
  });

  test("current turn steps are not evicted even when budget is tight", () => {
    // context=10000, output=2000, maxInput=8000, rawBudget ≈ 5600
    // Old messages: 50 × 600 chars ≈ 7500 tokens — way over budget alone
    // Current turn: user + 8 steps × 400 chars ≈ 850 tokens — must all be kept
    const oldMsgs = Array.from({ length: 50 }, (_, i) =>
      makeMsg(
        `tight-old-${i}`,
        i % 2 === 0 ? "user" : "assistant",
        "Z".repeat(600),
        SESSION,
      ),
    );
    const currentUser = makeMsg("tight-user", "user", "go", SESSION);
    const steps = Array.from({ length: 8 }, (_, i) =>
      makeStep(`tight-step-${i}`, "tight-user", "R".repeat(400), SESSION),
    );
    const messages = [...oldMsgs, currentUser, ...steps];

    const result = transform({
      messages,
      projectPath: PROJECT,
      sessionID: SESSION,
    });
    expect(result.layer).toBeGreaterThanOrEqual(1);

    const ids = result.messages.map((m) => m.info.id);
    // All 8 steps must be present
    for (let i = 0; i < 8; i++) {
      expect(ids).toContain(`tight-step-${i}`);
    }
    // Old messages should be partially evicted (some dropped to make room)
    const oldCount = ids.filter((id) => id.startsWith("tight-old-")).length;
    const totalOld = 50;
    expect(oldCount).toBeLessThan(totalOld);
  });

  test("current turn steps survive compression — never evicted", () => {
    // Verify that even when gradient fires and evicts old messages, all steps
    // in the current agentic turn are preserved as an atomic unit.
    // context=3000, output=500 → usable=2500, rawBudget=floor(2500*0.4)=1000
    setModelLimits({ context: 3_000, output: 500 });
    calibrate(0);

    const currentUser = makeMsg("huge-user", "user", "massive task", SESSION);
    // 8 steps × ~87 tokens (200 chars/3 + 20) = 696, + user 24 = 720 ≤ rawBudget(1000)
    const steps = Array.from({ length: 8 }, (_, i) =>
      makeStep(`huge-step-${i}`, "huge-user", "W".repeat(200), SESSION),
    );
    // 22 old messages to force gradient mode: 22 × 87 = 1914
    // Total = 1914 + 720 = 2634 > maxInput(2500) → gradient fires
    const oldMsgs = Array.from({ length: 22 }, (_, i) =>
      makeMsg(
        `huge-old-${i}`,
        i % 2 === 0 ? "user" : "assistant",
        "V".repeat(200),
        SESSION,
      ),
    );
    const messages = [...oldMsgs, currentUser, ...steps];

    const result = transform({
      messages,
      projectPath: PROJECT,
      sessionID: SESSION,
    });

    // Must be in gradient mode
    expect(result.layer).toBeGreaterThanOrEqual(1);

    // Current turn steps must always be present regardless of layer
    const ids = result.messages.map((m) => m.info.id);
    for (let i = 0; i < 8; i++) {
      expect(ids).toContain(`huge-step-${i}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Trailing-message-drop safety: tool-bearing steps must survive compression
// (index.ts fix: only drop pure-text trailing assistant messages, not tool ones)
// ---------------------------------------------------------------------------

// Helper: make an assistant step that has a completed tool call.
// These steps MUST NOT be dropped by index.ts's trailing-message-drop loop
// because their tool parts produce user-role tool_result messages at the
// Anthropic API level — so the conversation already ends with a user message.
function makeStepWithTool(
  id: string,
  parentUserID: string,
  toolName: string,
  toolOutput: string,
  sessionID = "grad-sess",
): LoreMessageWithParts {
  const info: LoreMessage = {
    id,
    sessionID,
    role: "assistant",
    time: { created: Date.now() },
    parentID: parentUserID,
    modelID: "claude-sonnet-4-20250514",
    providerID: "anthropic",
    mode: "build",
    path: { cwd: "/test", root: "/test" },
    cost: 0,
    tokens: {
      input: 100,
      output: 50,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
  };
  return {
    info,
    parts: [
      {
        id: `step-start-${id}`,
        sessionID,
        messageID: id,
        type: "step-start",
      } as LorePart,
      {
        id: `tool-${id}`,
        sessionID,
        messageID: id,
        type: "tool",
        callID: `call-${id}`,
        tool: toolName,
        state: {
          status: "completed",
          title: toolName,
          input: { command: "ls" },
          output: toolOutput,
          metadata: {},
          time: { start: Date.now(), end: Date.now() },
        },
      } as unknown as LorePart,
      {
        id: `step-finish-${id}`,
        sessionID,
        messageID: id,
        type: "step-finish",
        reason: "tool_use",
        cost: 0,
        tokens: {
          input: 50,
          output: 10,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
      } as unknown as LorePart,
    ],
  };
}

// ---------------------------------------------------------------------------
// sanitizeToolParts: pending/running tool parts → error state
// Prevents orphaned tool_use blocks (no matching tool_result) from reaching the
// Anthropic API. When a session errors mid-tool-execution, the tool part stays in
// pending/running state. sanitizeToolParts() converts these to error state so the
// SDK generates both tool_use + tool_result(is_error=true).
// ---------------------------------------------------------------------------

function makeStepWithPendingTool(
  id: string,
  parentUserID: string,
  toolName: string,
  sessionID = "grad-sess",
): LoreMessageWithParts {
  const info: LoreMessage = {
    id,
    sessionID,
    role: "assistant",
    time: { created: Date.now() },
    parentID: parentUserID,
    modelID: "claude-sonnet-4-20250514",
    providerID: "anthropic",
    mode: "build",
    path: { cwd: "/test", root: "/test" },
    cost: 0,
    tokens: {
      input: 100,
      output: 50,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
  };
  return {
    info,
    parts: [
      {
        id: `step-start-${id}`,
        sessionID,
        messageID: id,
        type: "step-start",
      } as LorePart,
      {
        id: `tool-${id}`,
        sessionID,
        messageID: id,
        type: "tool",
        callID: `call-${id}`,
        tool: toolName,
        state: {
          status: "pending",
          input: { command: "ls" },
          raw: '{"command": "ls"}',
        },
      } as unknown as LorePart,
    ],
  };
}

function makeStepWithRunningTool(
  id: string,
  parentUserID: string,
  toolName: string,
  sessionID = "grad-sess",
): LoreMessageWithParts {
  const info: LoreMessage = {
    id,
    sessionID,
    role: "assistant",
    time: { created: Date.now() },
    parentID: parentUserID,
    modelID: "claude-sonnet-4-20250514",
    providerID: "anthropic",
    mode: "build",
    path: { cwd: "/test", root: "/test" },
    cost: 0,
    tokens: {
      input: 100,
      output: 50,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
  };
  const startTime = Date.now() - 5000;
  return {
    info,
    parts: [
      {
        id: `step-start-${id}`,
        sessionID,
        messageID: id,
        type: "step-start",
      } as LorePart,
      {
        id: `tool-${id}`,
        sessionID,
        messageID: id,
        type: "tool",
        callID: `call-${id}`,
        tool: toolName,
        state: {
          status: "running",
          input: { command: "build" },
          title: toolName,
          metadata: { cwd: "/test" },
          time: { start: startTime },
        },
      } as unknown as LorePart,
    ],
  };
}

describe("gradient — sanitizeToolParts (orphaned tool_use fix)", () => {
  const SESSION = "sanitize-sess";

  beforeEach(() => {
    resetCalibration();
    resetPrefixCache();
    resetRawWindowCache();
    setModelLimits({ context: 10_000, output: 2_000 });
    calibrate(0);
    ensureProject(PROJECT);
  });

  test("no-op when all tool parts are completed — returns same array reference", () => {
    const msgs = [
      makeMsg("san-u1", "user", "build it", SESSION),
      makeStepWithTool("san-a1", "san-u1", "bash", "done", SESSION),
    ];

    const result = transform({
      messages: msgs,
      projectPath: PROJECT,
      sessionID: SESSION,
    });

    // Layer 0 for small session — messages should be the same reference
    expect(result.layer).toBe(0);
    // The tool part should still be completed
    const toolState = toolStateOf(
      result.messages[1]?.parts.find((p) => p.type === "tool"),
    );
    expect(toolState.status).toBe("completed");
  });

  test("pending tool part is converted to error state", () => {
    const msgs = [
      makeMsg("san-u2", "user", "run something", SESSION),
      makeStepWithPendingTool("san-a2", "san-u2", "bash", SESSION),
    ];

    const result = transform({
      messages: msgs,
      projectPath: PROJECT,
      sessionID: SESSION,
    });

    const toolState = toolStateOf(
      result.messages[1]?.parts.find((p) => p.type === "tool"),
    );
    expect(toolState.status).toBe("error");
    expect(toolState.error).toBe(
      "[tool execution interrupted — session recovered]",
    );
    expect(toolState.input).toEqual({ command: "ls" });
    // Pending has no time field — both start and end should be fabricated
    expect(typeof toolState.time?.start).toBe("number");
    expect(typeof toolState.time?.end).toBe("number");
  });

  test("running tool part is converted to error state, preserving time.start", () => {
    const msgs = [
      makeMsg("san-u3", "user", "build the project", SESSION),
      makeStepWithRunningTool("san-a3", "san-u3", "bash", SESSION),
    ];

    const result = transform({
      messages: msgs,
      projectPath: PROJECT,
      sessionID: SESSION,
    });

    const toolState = toolStateOf(
      result.messages[1]?.parts.find((p) => p.type === "tool"),
    );
    expect(toolState.status).toBe("error");
    expect(toolState.error).toBe(
      "[tool execution interrupted — session recovered]",
    );
    expect(toolState.input).toEqual({ command: "build" });
    // Running has time.start — should be preserved
    const startTime = toolState.time?.start ?? Number.NaN;
    expect(startTime).toBeLessThan(Date.now());
    expect(toolState.time?.end).toBeGreaterThanOrEqual(startTime);
    // Metadata from running state should be carried over
    expect(toolState.metadata).toEqual({ cwd: "/test" });
  });

  test("mixed parts: text + completed tool + pending tool — only pending converted", () => {
    const msgs = [
      makeMsg("san-u4", "user", "do stuff", SESSION),
      {
        ...makeStepWithTool(
          "san-a4",
          "san-u4",
          "bash",
          "first output",
          SESSION,
        ),
        parts: [
          // text part
          {
            id: "text-san-a4",
            sessionID: SESSION,
            messageID: "san-a4",
            type: "text",
            text: "Let me run two commands",
            time: { start: Date.now(), end: Date.now() },
          } as LorePart,
          // completed tool part
          {
            id: "tool-completed-san-a4",
            sessionID: SESSION,
            messageID: "san-a4",
            type: "tool",
            callID: "call-completed",
            tool: "bash",
            state: {
              status: "completed",
              title: "bash",
              input: { command: "ls" },
              output: "file1.ts file2.ts",
              metadata: {},
              time: { start: Date.now(), end: Date.now() },
            },
          } as unknown as LorePart,
          // pending tool part
          {
            id: "tool-pending-san-a4",
            sessionID: SESSION,
            messageID: "san-a4",
            type: "tool",
            callID: "call-pending",
            tool: "bash",
            state: {
              status: "pending",
              input: { command: "cat file1.ts" },
              raw: '{"command": "cat file1.ts"}',
            },
          } as unknown as LorePart,
        ],
      },
    ];

    const result = transform({
      messages: msgs,
      projectPath: PROJECT,
      sessionID: SESSION,
    });

    const parts = result.messages[1]?.parts ?? [];
    // Text part unchanged
    const textPart = parts.find(isTextPart);
    expect(textPart?.text).toBe("Let me run two commands");
    // Completed tool part unchanged
    const completedState = toolStateOf(
      parts.find((p) => isToolPart(p) && p.callID === "call-completed"),
    );
    expect(completedState.status).toBe("completed");
    expect(completedState.output).toBe("file1.ts file2.ts");
    // Pending tool part → error
    const pendingState = toolStateOf(
      parts.find((p) => isToolPart(p) && p.callID === "call-pending"),
    );
    expect(pendingState.status).toBe("error");
    expect(pendingState.error).toBe(
      "[tool execution interrupted — session recovered]",
    );
  });

  test("user messages are untouched", () => {
    const userMsg = makeMsg("san-u5", "user", "hello", SESSION);
    const msgs = [
      userMsg,
      makeStepWithPendingTool("san-a5", "san-u5", "bash", SESSION),
    ];

    const result = transform({
      messages: msgs,
      projectPath: PROJECT,
      sessionID: SESSION,
    });

    // User message should be the same object reference (not cloned)
    expect(result.messages[0]?.info.id).toBe("san-u5");
    expect(result.messages[0]?.parts[0]?.type).toBe("text");
  });

  test("multiple messages: only affected messages are cloned", () => {
    const msgs = [
      makeMsg("san-u6", "user", "first task", SESSION),
      makeStepWithTool("san-a6", "san-u6", "bash", "done", SESSION), // completed — untouched
      makeMsg("san-u7", "user", "second task", SESSION),
      makeStepWithPendingTool("san-a7", "san-u7", "edit", SESSION), // pending — converted
    ];

    const result = transform({
      messages: msgs,
      projectPath: PROJECT,
      sessionID: SESSION,
    });

    // Completed tool message untouched
    const completedMsg = result.messages.find((m) => m.info.id === "san-a6");
    const completedState = toolStateOf(
      completedMsg?.parts.find((p) => p.type === "tool"),
    );
    expect(completedState.status).toBe("completed");

    // Pending tool message converted
    const pendingMsg = result.messages.find((m) => m.info.id === "san-a7");
    const pendingState = toolStateOf(
      pendingMsg?.parts.find((p) => p.type === "tool"),
    );
    expect(pendingState.status).toBe("error");
  });
});

// ---------------------------------------------------------------------------
// Layer 0 trailing-drop: pure-text trailing assistant messages must be dropped
// even when gradient is not active (layer 0 passthrough). This is the fix for
// the "does not support assistant message prefill" error that recurred on small
// sessions. The hook in index.ts now runs the drop loop unconditionally, before
// the layer > 0 guard. At layer 0, result.messages === output.messages (same
// reference), so mutating it in place trims output.messages too.
// ---------------------------------------------------------------------------

describe("gradient — layer 0 trailing assistant message drop (index.ts prefill fix)", () => {
  const SESSION = "layer0-drop-sess";

  beforeEach(() => {
    resetCalibration();
    resetPrefixCache();
    resetRawWindowCache();
    setModelLimits({ context: 200_000, output: 32_000 });
    calibrate(0);
    ensureProject(PROJECT);
  });

  test("transform returns layer 0 for a small session ending with trailing assistant message", () => {
    // Tiny session — well within context budget, must be layer 0.
    const msgs = [
      makeMsg("l0-u1", "user", "hello", SESSION),
      makeMsg("l0-a1", "assistant", "hi there", SESSION),
      makeMsg("l0-u2", "user", "thanks", SESSION),
      makeMsg("l0-a2", "assistant", "no problem", SESSION), // trailing pure-text — prefill error
    ];

    const result = transform({
      messages: msgs,
      projectPath: PROJECT,
      sessionID: SESSION,
    });

    // Must be layer 0 — tiny messages easily fit
    expect(result.layer).toBe(0);

    // result.messages is the same reference as the input array at layer 0.
    // The hook's drop loop mutates this in place. Simulate what the hook does:
    while (result.messages.length > 0) {
      const last = result.messages[result.messages.length - 1];
      if (!last || last.info.role === "user") break;
      const hasToolParts = last.parts.some((p) => p.type === "tool");
      if (hasToolParts) break;
      result.messages.pop();
    }

    // After drop: last message must be user-role
    const afterLast = result.messages[result.messages.length - 1];
    expect(afterLast?.info.role).toBe("user");
    expect(afterLast?.info.id).toBe("l0-u2");
    // And since result.messages === msgs at layer 0, msgs is also trimmed
    expect(msgs[msgs.length - 1]?.info.id).toBe("l0-u2");
  });

  test("tool-bearing trailing assistant message at layer 0 is preserved (no infinite tool loop)", () => {
    // Same tiny session, but last message has a tool part.
    // Must NOT be dropped — tool parts produce user-role tool_result at the API level.
    const msgs = [
      makeMsg("l0t-u1", "user", "run the build", SESSION),
      makeStepWithTool("l0t-a1", "l0t-u1", "bash", "ok", SESSION), // trailing tool-bearing
    ];

    const result = transform({
      messages: msgs,
      projectPath: PROJECT,
      sessionID: SESSION,
    });

    // Must be layer 0 — tiny messages
    expect(result.layer).toBe(0);

    // Simulate the hook's drop loop — must stop immediately at tool-bearing message
    const beforeLen = result.messages.length;
    while (result.messages.length > 0) {
      const last = result.messages[result.messages.length - 1];
      if (!last || last.info.role === "user") break;
      const hasToolParts = last.parts.some((p) => p.type === "tool");
      if (hasToolParts) break;
      result.messages.pop();
    }

    // Nothing dropped — length unchanged
    expect(result.messages.length).toBe(beforeLen);
    expect(result.messages[result.messages.length - 1]?.info.id).toBe("l0t-a1");
  });
});

describe("gradient — tool-bearing steps survive compression (index.ts trailing-drop fix)", () => {
  const SESSION = "tool-drop-sess";

  beforeEach(() => {
    resetCalibration();
    resetPrefixCache();
    resetRawWindowCache();
    setModelLimits({ context: 5_000, output: 1_000 });
    calibrate(0);
    ensureProject(PROJECT);
  });

  test("gradient output includes tool-bearing agentic steps (not dropped by tryFit)", () => {
    // Old messages: 40 × 400 chars — forces gradient mode
    const oldMsgs = Array.from({ length: 40 }, (_, i) =>
      makeMsg(
        `td-old-${i}`,
        i % 2 === 0 ? "user" : "assistant",
        "X".repeat(400),
        SESSION,
      ),
    );
    // Current turn: user + 5 tool-bearing steps
    const currentUser = makeMsg("td-user", "user", "run the build", SESSION);
    const steps = Array.from({ length: 5 }, (_, i) =>
      makeStepWithTool(
        `td-step-${i}`,
        "td-user",
        "bash",
        "output ".repeat(30) + i,
        SESSION,
      ),
    );
    const messages = [...oldMsgs, currentUser, ...steps];

    const result = transform({
      messages,
      projectPath: PROJECT,
      sessionID: SESSION,
    });

    // Must be in gradient mode
    expect(result.layer).toBeGreaterThanOrEqual(1);

    // All 5 tool-bearing steps must appear in gradient output.
    // If they're present here, index.ts's new 'hasToolParts' check preserves
    // them (tool parts → tool_result at API level → no prefill error).
    const ids = result.messages.map((m) => m.info.id);
    for (let i = 0; i < 5; i++) {
      expect(ids).toContain(`td-step-${i}`);
    }
  });

  test("tool-bearing trailing steps have tool parts in the gradient output", () => {
    // Verify the step messages in gradient output actually carry their tool parts
    // (not stripped), so index.ts can inspect them for the hasToolParts check.
    const oldMsgs = Array.from({ length: 40 }, (_, i) =>
      makeMsg(
        `tp-old-${i}`,
        i % 2 === 0 ? "user" : "assistant",
        "Y".repeat(400),
        SESSION,
      ),
    );
    const currentUser = makeMsg("tp-user", "user", "do work", SESSION);
    const lastStep = makeStepWithTool(
      "tp-step-last",
      "tp-user",
      "bash",
      "final output",
      SESSION,
    );
    const messages = [...oldMsgs, currentUser, lastStep];

    const result = transform({
      messages,
      projectPath: PROJECT,
      sessionID: SESSION,
    });
    expect(result.layer).toBeGreaterThanOrEqual(1);

    // The last step in the gradient output should retain its tool part
    const lastInResult = result.messages[result.messages.length - 1];
    expect(lastInResult?.info.id).toBe("tp-step-last");
    const toolParts =
      lastInResult?.parts.filter((p) => p.type === "tool") ?? [];
    expect(toolParts.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Calibration oscillation fix (Options C + B)
// ---------------------------------------------------------------------------

describe("gradient — calibration oscillation fix", () => {
  const SESSION = "osc-sess";

  beforeEach(() => {
    resetCalibration();
    resetPrefixCache();
    resetRawWindowCache();
    // Context: 10K, output: 2K → usable 8K, rawBudget ~3200, maxInput 8000
    setModelLimits({ context: 10_000, output: 2_000 });
    calibrate(0);
  });

  test("sticky layer: does not oscillate between layer 0 and layer 1 on consecutive steps", () => {
    // Build a session that is too large for layer 0.
    // 60 messages × 600 chars ≈ 60 × 150 tokens = 9000 tokens > maxInput (8000).
    // maxInput = 10000 - 2000 = 8000. The full session exceeds maxInput,
    // so gradient must activate.
    const msgs = Array.from({ length: 60 }, (_, i) =>
      makeMsg(
        `osc-${i}`,
        i % 2 === 0 ? "user" : "assistant",
        "A".repeat(600),
        SESSION,
      ),
    );
    // Add final user message to make it a proper conversation end
    msgs.push(makeMsg("osc-user-final", "user", "next step", SESSION));

    // First transform: should compress (layer >= 1)
    const r1 = transform({
      messages: msgs,
      projectPath: PROJECT,
      sessionID: SESSION,
    });
    expect(r1.layer).toBeGreaterThanOrEqual(1);

    // Simulate calibration: model saw the compressed window.
    // transform() already stored lastTransformEstimate, so calibrate() uses it.
    const compressedCount = r1.messages.length;
    const actualInput = estimateMessages(r1.messages); // approximate actual tokens
    calibrate(actualInput, SESSION, compressedCount);

    // Add one more message (one agentic step)
    const msgs2 = [
      ...msgs,
      makeMsg("osc-step-1", "assistant", "working on it", SESSION),
    ];

    // Second transform: sticky layer guard must prevent layer 0
    const r2 = transform({
      messages: msgs2,
      projectPath: PROJECT,
      sessionID: SESSION,
    });
    expect(r2.layer).toBeGreaterThanOrEqual(1);
    expect(getLastLayer(SESSION)).toBeGreaterThanOrEqual(1);
  });

  test("sticky layer: allows layer 0 re-entry after compaction shrinks message count", () => {
    // Same setup: force gradient mode (60 × 600 chars ≈ 9000 tokens > maxInput 8000)
    const msgs = Array.from({ length: 60 }, (_, i) =>
      makeMsg(
        `comp-${i}`,
        i % 2 === 0 ? "user" : "assistant",
        "B".repeat(600),
        SESSION,
      ),
    );
    msgs.push(makeMsg("comp-user-final", "user", "compact", SESSION));

    const r1 = transform({
      messages: msgs,
      projectPath: PROJECT,
      sessionID: SESSION,
    });
    expect(r1.layer).toBeGreaterThanOrEqual(1);

    // Calibrate from the compressed result
    const compressedCount = r1.messages.length;
    calibrate(estimateMessages(r1.messages), SESSION, compressedCount);

    // Simulate compaction: session now has only 3 messages (much smaller than lastKnownMessageCount)
    const postCompaction = [
      makeMsg("post-1", "user", "fresh start", SESSION),
      makeMsg("post-2", "assistant", "ready", SESSION),
      makeMsg("post-3", "user", "go", SESSION),
    ];

    // With fewer messages than lastKnownMessageCount, sticky guard is bypassed
    const r2 = transform({
      messages: postCompaction,
      projectPath: PROJECT,
      sessionID: SESSION,
    });
    // Should be layer 0 — 3 tiny messages easily fit
    expect(r2.layer).toBe(0);
  });

  test("ID-based delta: accurately counts new messages after compression", () => {
    // Build a large session (60 × 600 chars ≈ 9000 tokens > maxInput 8000)
    const msgs = Array.from({ length: 60 }, (_, i) =>
      makeMsg(
        `id-${i}`,
        i % 2 === 0 ? "user" : "assistant",
        "C".repeat(600),
        SESSION,
      ),
    );
    msgs.push(makeMsg("id-user-end", "user", "step", SESSION));

    const r1 = transform({
      messages: msgs,
      projectPath: PROJECT,
      sessionID: SESSION,
    });
    expect(r1.layer).toBeGreaterThanOrEqual(1);

    // Calibrate with the compressed window count.
    // transform() already stored lastTransformEstimate.
    const compressedCount = r1.messages.length;
    const actualInput = estimateMessages(r1.messages);
    calibrate(actualInput, SESSION, compressedCount);

    // Add one truly new message
    const newMsg = makeMsg(
      "id-new-step",
      "assistant",
      `new work: ${"D".repeat(100)}`,
      SESSION,
    );
    const msgs2 = [...msgs, newMsg];

    // The delta should only include the one new message (id-new-step),
    // not the ~50 evicted messages. Sticky guard keeps us at layer >= 1,
    // so we don't oscillate to a passthrough that would send 300K tokens.
    const r2 = transform({
      messages: msgs2,
      projectPath: PROJECT,
      sessionID: SESSION,
    });
    expect(r2.layer).toBeGreaterThanOrEqual(1);

    // The new message must be in the output
    const ids2 = r2.messages.map((m) => m.info.id);
    expect(ids2).toContain("id-new-step");
  });

  test("layer 0 still works for genuinely small sessions", () => {
    // A fresh small session should always use layer 0 with no interference
    const msgs = [
      makeMsg("small-1", "user", "hello", SESSION),
      makeMsg("small-2", "assistant", "hi", SESSION),
      makeMsg("small-3", "user", "how are you", SESSION),
    ];
    const r = transform({
      messages: msgs,
      projectPath: PROJECT,
      sessionID: SESSION,
    });
    expect(r.layer).toBe(0);
    expect(r.messages).toBe(msgs); // same reference — truly untouched
  });

  test("worker session transform does NOT reset main session sticky layer guard", () => {
    // Reproduces the root cause of calibration oscillation:
    // Before per-session state, a worker session (lore-distill/curator) calling
    // transform() would set module-level lastLayer=0, which reset the main session's
    // sticky layer guard. The main session then passed through at layer 0 (175K),
    // followed by compression at layer 1 (62K), oscillating indefinitely.
    //
    // With per-session state, worker transforms are isolated and cannot affect
    // the main session's state.
    const MAIN = "osc-sess"; // reuse the SESSION constant
    const WORKER = "worker-distill-sess";

    // Set up the main session in gradient mode: 60 large messages
    const mainMsgs = Array.from({ length: 60 }, (_, i) =>
      makeMsg(
        `main-${i}`,
        i % 2 === 0 ? "user" : "assistant",
        "A".repeat(600),
        MAIN,
      ),
    );
    mainMsgs.push(makeMsg("main-user-final", "user", "step 1", MAIN));

    // First main transform: gradient activates (layer >= 1)
    const r1 = transform({
      messages: mainMsgs,
      projectPath: PROJECT,
      sessionID: MAIN,
    });
    expect(r1.layer).toBeGreaterThanOrEqual(1);

    // Calibrate main session as compressed
    const actualInput = estimateMessages(r1.messages);
    calibrate(actualInput, MAIN, r1.messages.length);

    // WORKER SESSION: tiny messages → transform returns layer 0
    const workerMsgs = [
      makeMsg("w-1", "user", "distill this", WORKER),
      makeMsg("w-2", "assistant", "done", WORKER),
      makeMsg("w-3", "user", "ok", WORKER),
    ];
    const workerResult = transform({
      messages: workerMsgs,
      projectPath: PROJECT,
      sessionID: WORKER,
    });
    expect(workerResult.layer).toBe(0); // worker is small → layer 0

    // After worker transform, main session state must be unaffected.
    // The sticky layer guard must still fire for the main session.
    mainMsgs.push(makeMsg("main-step-2", "assistant", "doing work", MAIN));
    const r2 = transform({
      messages: mainMsgs,
      projectPath: PROJECT,
      sessionID: MAIN,
    });

    // Before the fix: worker's layer 0 reset module-level lastLayer=0,
    // so r2 would be layer 0 passthrough (sending all 175K tokens).
    // After the fix: per-session state — r2 must stay at layer >= 1.
    expect(r2.layer).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Distilled-prefix front-bust: spurious Layer 4 + 0<->4 thrash
// ---------------------------------------------------------------------------
// When a meta-distillation rewrite forces a full prefix re-render, the rendered
// distilled prefix can exceed a compression stage's distilled budget. The
// compression loop only trims distillations when stage.distLimit is finite
// (stages 1 & 2 have distLimit=Infinity), so an over-budget prefix makes tryFit
// return null at every stage → fallthrough to emergency Layer 4 — even though
// the session has huge headroom (tokens << usable). The NEXT turn then drops to
// Layer 0 (the sticky guard excludes lastLayer===4), the prefix VANISHES from
// messages[0], and the prompt cache front-busts. Two fixes:
//   (i)  budget-aware prefix trim: land at Layer <= 3 instead of 4
//   (ii) sticky guard covers a prior Layer-4 turn (pinned to <= 3, never 4)
describe("gradient — distilled-prefix front-bust (spurious Layer 4 + thrash)", () => {
  const SID = "prefix-frontbust-sess";
  const PID_KEY = "prefix-frontbust-project";
  let projectId: string;
  let createdCounter = 0;

  function insertDistillation(observations: string, generation = 0): string {
    const id = crypto.randomUUID();
    db()
      .query(
        `INSERT INTO distillations (id, project_id, session_id, narrative, facts, observations, source_ids, generation, token_count, archived, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        projectId,
        SID,
        "",
        "[]",
        observations,
        "[]",
        generation,
        Math.ceil(observations.length / 3),
        0,
        Date.now() + createdCounter++,
      );
    return id;
  }

  beforeAll(() => {
    projectId = ensureProject(`/test/${PID_KEY}`);
  });

  beforeEach(() => {
    resetCalibration(SID);
    resetPrefixCache(SID);
    resetRawWindowCache(SID);
    resetDistillationSnapshot(SID);
    createdCounter = 0;
    db().query("DELETE FROM distillations WHERE project_id = ?").run(projectId);
    // usable ≈ 96K (context 100K - output 4K). distilledBudget = usable*0.25 ≈ 24K.
    // We'll seed a distillation set whose rendered prefix exceeds 24K so stages
    // 1 & 2 (distLimit=Infinity, no trim) overflow.
    setModelLimits({ context: 100_000, output: 4_000 });
    calibrate(0);
  });

  afterAll(() => {
    setModelLimits({ context: 10_000, output: 2_000 });
    calibrate(0);
    db().query("DELETE FROM distillations WHERE project_id = ?").run(projectId);
  });

  /** Seed N gen-0 distillations, each ~big tokens, so the full prefix is large. */
  function seedLargeDistillations(count: number, charsEach: number) {
    for (let i = 0; i < count; i++) {
      insertDistillation(`Distillation ${i}: ${"o".repeat(charsEach)}`);
    }
  }

  /**
   * A conversation large enough to FORCE compression (Layer >= 1) but whose raw
   * window comfortably fits a compressed stage's raw budget. This mirrors the
   * production case: the session is in gradient mode (raw too big for Layer 0),
   * and the distilled PREFIX size — not the raw — is what determines the layer.
   * ~140 msgs × ~900 chars ≈ 140 × 225 tokens ≈ 31K raw > usable*0.55 stage cap?
   * No — sized so raw fits stage budgets, leaving the prefix as the deciding factor.
   */
  function largeRawConversation(): LoreMessageWithParts[] {
    const msgs = Array.from({ length: 80 }, (_, i) =>
      makeMsg(
        `fb-${i}`,
        i % 2 === 0 ? "user" : "assistant",
        "r".repeat(900),
        SID,
      ),
    );
    msgs.push(makeMsg("fb-final", "user", "next step", SID));
    return msgs;
  }

  /**
   * Drive the production trigger: a post-idle-compact turn (onIdleResume sets
   * postIdleCompact → effectiveMinLayer>=1 AND a tight rawBudget=usable*0.2),
   * combined with a freshly re-rendered, over-budget distilled prefix. On the
   * current code the over-budget prefix fails tryFit at every stage (stages 1&2
   * never trim — distLimit=Infinity) → fallthrough to emergency Layer 4.
   */
  function transformPostIdle(
    messages: LoreMessageWithParts[],
  ): ReturnType<typeof transform> {
    setLastTurnAtForTest(SID, Date.now() - 10 * 60_000);
    onIdleResume(SID, 5 * 60_000);
    return transform({
      messages,
      projectPath: `/test/${PID_KEY}`,
      sessionID: SID,
    });
  }

  test("over-budget re-rendered prefix on a post-idle turn lands at Layer <= 3, NOT emergency Layer 4", () => {
    // ~30 distillations × ~3000 chars ≈ 30 × 1000 tokens ≈ 30K rendered prefix,
    // exceeding distilledBudget (usable*0.25 ≈ 24K) and the post-idle tight budget.
    seedLargeDistillations(40, 12000);

    const r = transformPostIdle(largeRawConversation());

    // Current (buggy) code: stages 1 & 2 don't trim (distLimit=Infinity), stage 3
    // trims to 5 but usable*0.15 may still overflow → fallthrough to Layer 4.
    // Fixed: budget-aware trim keeps it compressed at Layer <= 3, prefix present.
    expect(r.layer).toBeGreaterThanOrEqual(1);
    expect(r.layer).toBeLessThanOrEqual(3);
  });

  test("an oversized distilled prefix never escalates to emergency Layer 4 (root cause of the thrash)", () => {
    // A prefix far larger than any stage budget. Before the fix this fell
    // through every stage (stages 1&2 never trim) → emergency Layer 4. With the
    // budget-aware trim it must compress at Layer 1-3 instead — eliminating the
    // spurious Layer 4 that (production: 23 of 24 L4 turns over 6 days) drove the
    // 0<->4 front-bust oscillation. The single genuine context overflow is a
    // separate, isolated path and is not exercised here.
    seedLargeDistillations(40, 12000); // ~160K rendered — exceeds everything
    const r1 = transformPostIdle(largeRawConversation());
    expect(r1.layer).toBeGreaterThanOrEqual(1);
    expect(r1.layer).toBeLessThanOrEqual(3);
  });

  test("keeps the distilled prefix PRESENT across consecutive compressed turns (no 0-drop thrash)", () => {
    // The oscillation was: compressed turn (prefix present) -> next turn drops
    // to Layer 0 (prefix vanishes) -> bust. With spurious Layer 4 gone, the
    // session stays at Layer 1-3 where the existing sticky guard holds the floor.
    seedLargeDistillations(40, 12000);
    const r1 = transformPostIdle(largeRawConversation());
    expect(r1.layer).toBeGreaterThanOrEqual(1);
    calibrate(estimateMessages(r1.messages), SID, r1.messages.length);

    // A subsequent steady-state turn (still large) must remain compressed —
    // the prefix stays present at messages[0]/[1], so the front does not bust.
    const r2 = transform({
      messages: [
        ...largeRawConversation(),
        makeMsg("fb-step", "assistant", "more work", SID),
      ],
      projectPath: `/test/${PID_KEY}`,
      sessionID: SID,
    });
    expect(r2.layer).toBeGreaterThanOrEqual(1);
  });

  test("steady warm turn (unchanged budget) keeps the distilled prefix byte-identical (no trim-induced bust)", () => {
    // A prefix that COMFORTABLY fits the budget. On a steady warm turn the
    // budget-aware trim must NOT fire (the cached prefix already fits), so
    // messages[0]/[1] stay byte-identical and the prompt cache is preserved.
    seedLargeDistillations(2, 600); // small prefix, well under distilledBudget
    const conv = largeRawConversation();
    // Post-idle forces compression (Layer >= 1) so the prefix is injected.
    const r1 = transformPostIdle(conv);
    expect(r1.layer).toBeGreaterThanOrEqual(1);
    calibrate(estimateMessages(r1.messages), SID, r1.messages.length);

    const prefix1 = JSON.stringify([r1.messages[0], r1.messages[1]]);

    // Next steady-state turn, same budget — the prefix must be byte-identical.
    const r2 = transform({
      messages: [...conv, makeMsg("warm-step", "assistant", "ok", SID)],
      projectPath: `/test/${PID_KEY}`,
      sessionID: SID,
    });
    expect(r2.layer).toBeGreaterThanOrEqual(1);
    const prefix2 = JSON.stringify([r2.messages[0], r2.messages[1]]);
    expect(prefix2).toBe(prefix1);
  });

  test("RELEASES to Layer 0 after a genuine compaction (prefix-floor must not trap a small session)", () => {
    seedLargeDistillations(40, 12000);
    const r1 = transformPostIdle(largeRawConversation());
    expect(r1.layer).toBeGreaterThanOrEqual(1);
    calibrate(estimateMessages(r1.messages), SID, r1.messages.length);

    // Genuine compaction: tiny conversation + tiny prefix → must sit at Layer 0.
    db().query("DELETE FROM distillations WHERE project_id = ?").run(projectId);
    seedLargeDistillations(1, 200);
    const r2 = transform({
      messages: [
        makeMsg("c-1", "user", "fresh", SID),
        makeMsg("c-2", "assistant", "ok", SID),
        makeMsg("c-3", "user", "go", SID),
      ],
      projectPath: `/test/${PID_KEY}`,
      sessionID: SID,
    });
    expect(r2.layer).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// No Layer-0 re-entry once compressed (prefix-present floor)
// ---------------------------------------------------------------------------
// Once a session has compressed (reached Layer >= 1, injecting the distilled
// prefix at messages[0]/[1]), it must NOT drop back to Layer 0 on a later turn —
// that vanishes the prefix and front-busts the cache. The existing sticky guard
// only covers lastLayer 1-3 while calibrated; this floor also covers a prior
// Layer-4 turn and survives a process restart (calibrated=false). It still
// RELEASES on a genuine compaction (the host shrank the conversation).
//
// The floor decision is `prefixPresentFloorApplies`, a pure predicate. We test
// it directly (a full truth table — discriminating: any revert of the predicate
// flips at least one case). The predicate's WIRING into transform() (pinning the
// layer UP to >= 1) is proven by the repurposed `forceMinLayer` tests below,
// which now assert a once-compressed session holds at Layer 1 (2->1) instead of
// returning to Layer 0. The two transform-level guards here cover the other
// direction — that the floor does NOT over-apply: a genuine compaction still
// releases to Layer 0, and a never-compressed small session stays at Layer 0.
describe("gradient — prefixPresentFloorApplies (no Layer-0 re-entry predicate)", () => {
  test("never compressed (lastLayer 0) → floor does NOT apply", () => {
    expect(prefixPresentFloorApplies(0, 100, 0)).toBe(false);
    expect(prefixPresentFloorApplies(0, 5, 100)).toBe(false);
    expect(prefixPresentFloorApplies(0, 100, 50)).toBe(false);
  });

  test("compressed (lastLayer 1-4) + growing/steady conversation → floor applies", () => {
    for (const layer of [1, 2, 3, 4]) {
      // count unknown yet (fresh process)
      expect(prefixPresentFloorApplies(layer, 500, 0)).toBe(true);
      // conversation grew
      expect(prefixPresentFloorApplies(layer, 600, 500)).toBe(true);
      // conversation steady (equal — NOT a shrink)
      expect(prefixPresentFloorApplies(layer, 500, 500)).toBe(true);
    }
  });

  test("covers lastLayer === 4 (the strong sticky guard's `<= 3` excludes it)", () => {
    expect(prefixPresentFloorApplies(4, 500, 400)).toBe(true);
  });

  test("genuine compaction (messages shrank below the known window) → floor RELEASES", () => {
    expect(prefixPresentFloorApplies(1, 3, 500)).toBe(false);
    expect(prefixPresentFloorApplies(4, 10, 760)).toBe(false);
  });

  test("shrink is ignored when the window size is not yet known (count 0)", () => {
    // Fresh process: lastKnownMessageCount=0 must NOT be read as a compaction —
    // rely on the DB-restored lastLayer to hold the floor until the live count is set.
    expect(prefixPresentFloorApplies(1, 1, 0)).toBe(true);
  });
});

describe("gradient — prefix-present floor: transform-level guards", () => {
  const SID = "prefix-floor-guard-sess";
  const PID_KEY = "prefix-floor-guard-project";
  let projectId: string;
  let createdCounter = 0;

  function seedDistillations(count: number, charsEach: number) {
    for (let i = 0; i < count; i++) {
      const id = crypto.randomUUID();
      db()
        .query(
          `INSERT INTO distillations (id, project_id, session_id, narrative, facts, observations, source_ids, generation, token_count, archived, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          projectId,
          SID,
          "",
          "[]",
          `Distillation ${i}: ${"o".repeat(charsEach)}`,
          "[]",
          0,
          Math.ceil(charsEach / 3),
          0,
          Date.now() + createdCounter++,
        );
    }
  }

  function largeRawConversation(): LoreMessageWithParts[] {
    const msgs = Array.from({ length: 80 }, (_, i) =>
      makeMsg(
        `g-${i}`,
        i % 2 === 0 ? "user" : "assistant",
        "r".repeat(900),
        SID,
      ),
    );
    msgs.push(makeMsg("g-final", "user", "step", SID));
    return msgs;
  }

  beforeAll(() => {
    projectId = ensureProject(`/test/${PID_KEY}`);
  });

  beforeEach(() => {
    resetCalibration(SID);
    resetPrefixCache(SID);
    resetRawWindowCache(SID);
    resetDistillationSnapshot(SID);
    createdCounter = 0;
    db().query("DELETE FROM distillations WHERE project_id = ?").run(projectId);
    db().query("DELETE FROM session_state WHERE session_id = ?").run(SID);
    setModelLimits({ context: 100_000, output: 4_000 });
    calibrate(0);
  });

  afterAll(() => {
    setModelLimits({ context: 10_000, output: 2_000 });
    calibrate(0);
    db().query("DELETE FROM distillations WHERE project_id = ?").run(projectId);
    db().query("DELETE FROM session_state WHERE session_id = ?").run(SID);
  });

  test("the floor does NOT trap a genuinely compacted session (releases to Layer 0)", () => {
    // Compress once (post-idle forces Layer >= 1, setting lastKnownMessageCount).
    seedDistillations(3, 1500);
    const conv = largeRawConversation();
    setLastTurnAtForTest(SID, Date.now() - 10 * 60_000);
    onIdleResume(SID, 5 * 60_000);
    const r1 = transform({
      messages: conv,
      projectPath: `/test/${PID_KEY}`,
      sessionID: SID,
    });
    expect(r1.layer).toBeGreaterThanOrEqual(1);
    calibrate(estimateMessages(r1.messages), SID, r1.messages.length);

    // Genuine compaction: 3 tiny messages, far below the known window.
    db().query("DELETE FROM distillations WHERE project_id = ?").run(projectId);
    seedDistillations(1, 150);
    const r2 = transform({
      messages: [
        makeMsg("g-c1", "user", "fresh", SID),
        makeMsg("g-c2", "assistant", "ok", SID),
        makeMsg("g-c3", "user", "go", SID),
      ],
      projectPath: `/test/${PID_KEY}`,
      sessionID: SID,
    });
    expect(r2.layer).toBe(0);
  });

  test("a never-compressed small session sits at Layer 0 (floor does not over-apply)", () => {
    const r = transform({
      messages: [
        makeMsg("g-s1", "user", "hello", SID),
        makeMsg("g-s2", "assistant", "hi", SID),
        makeMsg("g-s3", "user", "go", SID),
      ],
      projectPath: `/test/${PID_KEY}`,
      sessionID: SID,
    });
    expect(r.layer).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Content-aware deduplication tests
// ---------------------------------------------------------------------------

function makeMsgWithTool(
  id: string,
  role: "user" | "assistant",
  toolName: string,
  input: string,
  output: string,
  sessionID = "dedup-sess",
): LoreMessageWithParts {
  const base = makeMsg(id, role, "", sessionID);
  return {
    info: base.info,
    parts: [
      {
        id: `tool-${id}`,
        sessionID,
        messageID: id,
        type: "tool",
        tool: toolName,
        callID: `call-${id}`,
        title: toolName,
        state: {
          status: "completed" as const,
          input: JSON.parse(input) as { [key: string]: unknown },
          output,
          title: toolName,
          metadata: {},
          time: { start: Date.now(), end: Date.now() },
        },
        time: { start: Date.now(), end: Date.now() },
      } as LorePart,
    ],
  };
}

/** Helper to extract output from a completed tool part. */
function getToolOutput(part: LorePart): string | undefined {
  if (isToolPart(part) && part.state.status === "completed") {
    return part.state.output;
  }
  return undefined;
}

describe("deduplicateToolOutputs", () => {
  const LARGE_CONTENT = "x".repeat(800); // above DEDUP_MIN_CHARS (600)

  test("cross-turn stability: an already-shown earlier output is NOT retroactively collapsed by a newly-appended duplicate", () => {
    // Reproduces the messages[N] cache-bust: on turn N an early read has no
    // later duplicate so it is sent FULL. On turn N+1 the user triggers the
    // same read again (appended at the tail). dedup must NOT now collapse the
    // early read — doing so changes the content of an already-cached message
    // position and busts the prompt cache every time a file is re-read.
    const readA = (id: string) =>
      makeMsgWithTool(
        id,
        "assistant",
        "read_file",
        '{"path":"src/foo.ts"}',
        LARGE_CONTENT,
      );

    // Shared per-session decision memo (as transform threads sessState.dedupDecisions).
    const memo = new Map<string, boolean>();

    // Turn N window: the early read at index 1 has no later duplicate.
    const turnN = [
      makeMsg("u1", "user", "read file A"),
      readA("a1"),
      makeMsg("u2", "user", "thanks"), // current turn
    ];
    const outN = deduplicateToolOutputs(turnN, 2, memo);
    // Index 1 is sent in full on turn N.
    expect(getToolOutput(outN[1].parts[0])).toBe(LARGE_CONTENT);

    // Turn N+1: same conversation plus a NEW later duplicate read appended.
    const turnN1 = [
      makeMsg("u1", "user", "read file A"),
      readA("a1"), // SAME early message — already cached on turn N
      makeMsg("u2", "user", "thanks"),
      makeMsg("u3", "user", "read file A again"),
      readA("a3"), // new duplicate appended this turn
      makeMsg("u4", "user", "ok"), // current turn
    ];
    const outN1 = deduplicateToolOutputs(turnN1, 5, memo);

    // The early read at index 1 was already shown FULL on turn N; it must stay
    // full so its cached bytes don't change. (Regression guard for the
    // messages[N] window-content cache bust.)
    expect(getToolOutput(outN1[1].parts[0])).toBe(LARGE_CONTENT);
  });

  test("stateless (no memo) preserves legacy behavior: later duplicate collapses the earlier read", () => {
    const readA = (id: string) =>
      makeMsgWithTool(
        id,
        "assistant",
        "read_file",
        '{"path":"src/foo.ts"}',
        LARGE_CONTENT,
      );
    const msgs = [
      makeMsg("u1", "user", "read file A"),
      readA("a1"),
      makeMsg("u3", "user", "read again"),
      readA("a3"),
      makeMsg("u4", "user", "ok"), // current turn
    ];
    // No memo passed → stateless: earlier read collapses (latest kept).
    const out = deduplicateToolOutputs(msgs, 4);
    expect(getToolOutput(out[1].parts[0])).toContain(
      "earlier read of src/foo.ts",
    );
    expect(getToolOutput(out[3].parts[0])).toBe(LARGE_CONTENT);
  });

  test("deduplicates identical tool outputs, keeps latest", () => {
    const msgs = [
      makeMsg("u1", "user", "read file A"),
      makeMsgWithTool(
        "a1",
        "assistant",
        "read_file",
        '{"path":"src/foo.ts"}',
        LARGE_CONTENT,
      ),
      makeMsg("u2", "user", "now edit"),
      makeMsg("a2", "assistant", "done editing"),
      makeMsg("u3", "user", "read file A again"),
      makeMsgWithTool(
        "a3",
        "assistant",
        "read_file",
        '{"path":"src/foo.ts"}',
        LARGE_CONTENT,
      ),
      makeMsg("u4", "user", "looks good"), // current turn
    ];

    const result = deduplicateToolOutputs(msgs, 6);

    // First read (index 1) should be deduplicated
    expect(getToolOutput(result[1].parts[0])).toContain(
      "earlier read of src/foo.ts",
    );

    // Latest read (index 5) should be intact
    expect(getToolOutput(result[5].parts[0])).toBe(LARGE_CONTENT);
  });

  test("deduplicates same-file reads with different content", () => {
    const oldContent = `old version ${"y".repeat(800)}`;
    const newContent = `new version ${"z".repeat(800)}`;
    const msgs = [
      makeMsg("u1", "user", "read file"),
      makeMsgWithTool(
        "a1",
        "assistant",
        "read_file",
        '{"path":"src/bar.ts"}',
        oldContent,
      ),
      makeMsg("u2", "user", "edit it"),
      makeMsg("a2", "assistant", "edited"),
      makeMsg("u3", "user", "read it again"),
      makeMsgWithTool(
        "a3",
        "assistant",
        "read_file",
        '{"path":"src/bar.ts"}',
        newContent,
      ),
      makeMsg("u4", "user", "verify"), // current turn
    ];

    const result = deduplicateToolOutputs(msgs, 6);

    // First read (old content) should be replaced — same file, not latest
    expect(getToolOutput(result[1].parts[0])).toContain(
      "earlier read of src/bar.ts",
    );

    // Latest read (new content) should be intact
    expect(getToolOutput(result[5].parts[0])).toBe(newContent);
  });

  test("does not touch current turn messages", () => {
    const msgs = [
      makeMsg("u1", "user", "first"),
      makeMsgWithTool(
        "a1",
        "assistant",
        "read_file",
        '{"path":"src/foo.ts"}',
        LARGE_CONTENT,
      ),
      makeMsg("u2", "user", "read again"), // current turn starts here (index 2)
      makeMsgWithTool(
        "a2",
        "assistant",
        "read_file",
        '{"path":"src/foo.ts"}',
        LARGE_CONTENT,
      ),
    ];

    const result = deduplicateToolOutputs(msgs, 2);

    // Earlier read (index 1) should be deduped since latest is in current turn
    expect(getToolOutput(result[1].parts[0])).toContain("earlier read");

    // Current-turn read (index 3) should NOT be touched
    expect(getToolOutput(result[3].parts[0])).toBe(LARGE_CONTENT);
  });

  test("skips small outputs (below threshold)", () => {
    const smallContent = "short"; // well below DEDUP_MIN_CHARS
    const msgs = [
      makeMsg("u1", "user", "read"),
      makeMsgWithTool(
        "a1",
        "assistant",
        "read_file",
        '{"path":"small.txt"}',
        smallContent,
      ),
      makeMsg("u2", "user", "read again"),
      makeMsgWithTool(
        "a2",
        "assistant",
        "read_file",
        '{"path":"small.txt"}',
        smallContent,
      ),
      makeMsg("u3", "user", "done"), // current turn
    ];

    const result = deduplicateToolOutputs(msgs, 4);

    // Both small outputs should be untouched
    expect(getToolOutput(result[1].parts[0])).toBe(smallContent);
    expect(getToolOutput(result[3].parts[0])).toBe(smallContent);
  });

  test("returns same array reference when no duplicates", () => {
    const msgs = [
      makeMsg("u1", "user", "hello"),
      makeMsgWithTool(
        "a1",
        "assistant",
        "read_file",
        '{"path":"a.ts"}',
        LARGE_CONTENT,
      ),
      makeMsg("u2", "user", "read different"),
      makeMsgWithTool(
        "a2",
        "assistant",
        "read_file",
        '{"path":"b.ts"}',
        `different ${LARGE_CONTENT}`,
      ),
      makeMsg("u3", "user", "done"), // current turn
    ];

    const result = deduplicateToolOutputs(msgs, 4);
    expect(result).toBe(msgs); // same reference — no copy
  });

  test("deduplicates non-read tools by exact content hash", () => {
    const bashOutput = `npm test\n${"PASS ".repeat(200)}`; // large enough
    const msgs = [
      makeMsg("u1", "user", "run tests"),
      makeMsgWithTool(
        "a1",
        "assistant",
        "bash",
        '{"command":"npm test"}',
        bashOutput,
      ),
      makeMsg("u2", "user", "run tests again"),
      makeMsgWithTool(
        "a2",
        "assistant",
        "bash",
        '{"command":"npm test"}',
        bashOutput,
      ),
      makeMsg("u3", "user", "ok"), // current turn
    ];

    const result = deduplicateToolOutputs(msgs, 4);

    // First bash (index 1) should be deduped — exact same output
    const firstPart = result[1]?.parts[0];
    if (!firstPart) throw new Error("expected first tool part");
    const firstOut = getToolOutput(firstPart);
    expect(firstOut).toContain("duplicate output");
    expect(firstOut).toContain("bash");

    // Latest bash (index 3) should be intact
    expect(getToolOutput(result[3].parts[0])).toBe(bashOutput);
  });

  test("handles three reads of the same file — only latest survives", () => {
    const msgs = [
      makeMsg("u1", "user", "read"),
      makeMsgWithTool(
        "a1",
        "assistant",
        "read_file",
        '{"path":"src/x.ts"}',
        LARGE_CONTENT,
      ),
      makeMsg("u2", "user", "read again"),
      makeMsgWithTool(
        "a2",
        "assistant",
        "read_file",
        '{"path":"src/x.ts"}',
        LARGE_CONTENT,
      ),
      makeMsg("u3", "user", "read third time"),
      makeMsgWithTool(
        "a3",
        "assistant",
        "read_file",
        '{"path":"src/x.ts"}',
        LARGE_CONTENT,
      ),
      makeMsg("u4", "user", "done"), // current turn
    ];

    const result = deduplicateToolOutputs(msgs, 6);

    // First two reads should be deduped
    expect(getToolOutput(result[1].parts[0])).toContain("earlier read");
    expect(getToolOutput(result[3].parts[0])).toContain("earlier read");

    // Third (latest) should be intact
    expect(getToolOutput(result[5].parts[0])).toBe(LARGE_CONTENT);
  });
});

describe("dedup decision persistence (export/import round-trip)", () => {
  const SID = "dedup-persist-session";

  beforeEach(() => {
    resetCalibration(SID);
  });

  test("export returns null when no decisions recorded", () => {
    expect(exportDedupDecisions(SID)).toBeNull();
  });

  test("import then export round-trips the memo", () => {
    const blob = JSON.stringify([
      ["m1:p1", true],
      ["m2:p2", false],
    ]);
    importDedupDecisions(SID, blob);
    const out = exportDedupDecisions(SID);
    expect(out).not.toBeNull();
    // Order-independent comparison.
    expect(new Map(JSON.parse(out as string))).toEqual(
      new Map([
        ["m1:p1", true],
        ["m2:p2", false],
      ]),
    );
  });

  test("import ignores a corrupt blob (memo stays empty)", () => {
    importDedupDecisions(SID, "{not json");
    expect(exportDedupDecisions(SID)).toBeNull();
  });

  test("import does not overwrite an already-populated memo", () => {
    importDedupDecisions(SID, JSON.stringify([["m1:p1", true]]));
    // Second import (e.g. a stale restore) must not clobber live decisions.
    importDedupDecisions(SID, JSON.stringify([["m9:p9", false]]));
    const out = new Map(JSON.parse(exportDedupDecisions(SID) as string));
    expect(out.has("m1:p1")).toBe(true);
    expect(out.has("m9:p9")).toBe(false);
  });
});

describe("laterReadCovers", () => {
  test("full-file covers full-file same path", () => {
    expect(
      laterReadCovers(
        { path: "src/foo.ts", offset: undefined, limit: undefined },
        { path: "src/foo.ts", offset: undefined, limit: undefined },
      ),
    ).toBe(true);
  });

  test("full-file covers ranged read", () => {
    expect(
      laterReadCovers(
        { path: "src/foo.ts", offset: undefined, limit: undefined },
        { path: "src/foo.ts", offset: 10, limit: 40 },
      ),
    ).toBe(true);
  });

  test("ranged read does NOT cover full-file", () => {
    expect(
      laterReadCovers(
        { path: "src/foo.ts", offset: 10, limit: 40 },
        { path: "src/foo.ts", offset: undefined, limit: undefined },
      ),
    ).toBe(false);
  });

  test("exact same range covers", () => {
    expect(
      laterReadCovers(
        { path: "src/foo.ts", offset: 10, limit: 50 },
        { path: "src/foo.ts", offset: 10, limit: 50 },
      ),
    ).toBe(true);
  });

  test("wider range covers narrower range", () => {
    expect(
      laterReadCovers(
        { path: "src/foo.ts", offset: 5, limit: 60 },
        { path: "src/foo.ts", offset: 10, limit: 40 },
      ),
    ).toBe(true);
  });

  test("narrower range does NOT cover wider range", () => {
    expect(
      laterReadCovers(
        { path: "src/foo.ts", offset: 10, limit: 40 },
        { path: "src/foo.ts", offset: 5, limit: 60 },
      ),
    ).toBe(false);
  });

  test("non-overlapping ranges do not cover", () => {
    expect(
      laterReadCovers(
        { path: "src/foo.ts", offset: 100, limit: 50 },
        { path: "src/foo.ts", offset: 1, limit: 50 },
      ),
    ).toBe(false);
  });

  test("different paths never cover", () => {
    expect(
      laterReadCovers(
        { path: "src/foo.ts", offset: undefined, limit: undefined },
        { path: "src/bar.ts", offset: undefined, limit: undefined },
      ),
    ).toBe(false);
  });

  test("open-ended later covers bounded earlier with lower start", () => {
    expect(
      laterReadCovers(
        { path: "src/foo.ts", offset: 10, limit: undefined },
        { path: "src/foo.ts", offset: 20, limit: 30 },
      ),
    ).toBe(true);
  });

  test("bounded later does NOT cover open-ended earlier", () => {
    expect(
      laterReadCovers(
        { path: "src/foo.ts", offset: 10, limit: 50 },
        { path: "src/foo.ts", offset: 10, limit: undefined },
      ),
    ).toBe(false);
  });

  test("offset-only later covers offset-only earlier with lower start", () => {
    expect(
      laterReadCovers(
        { path: "src/foo.ts", offset: 5, limit: undefined },
        { path: "src/foo.ts", offset: 10, limit: undefined },
      ),
    ).toBe(true);
  });

  test("offset-only later does NOT cover earlier with lower start", () => {
    expect(
      laterReadCovers(
        { path: "src/foo.ts", offset: 20, limit: undefined },
        { path: "src/foo.ts", offset: 10, limit: undefined },
      ),
    ).toBe(false);
  });
});

describe("deduplicateToolOutputs — range-aware", () => {
  const LARGE_CONTENT = "x".repeat(800);

  test("full-file read covers earlier full-file read (baseline)", () => {
    const msgs = [
      makeMsg("u1", "user", "read file"),
      makeMsgWithTool(
        "a1",
        "assistant",
        "read",
        '{"path":"src/foo.ts"}',
        LARGE_CONTENT,
      ),
      makeMsg("u2", "user", "read again"),
      makeMsgWithTool(
        "a2",
        "assistant",
        "read",
        '{"path":"src/foo.ts"}',
        LARGE_CONTENT,
      ),
      makeMsg("u3", "user", "done"),
    ];
    const result = deduplicateToolOutputs(msgs, 4);
    expect(getToolOutput(result[1].parts[0])).toContain(
      "earlier read of src/foo.ts",
    );
    expect(getToolOutput(result[3].parts[0])).toBe(LARGE_CONTENT);
  });

  test("full-file read covers earlier ranged read", () => {
    const rangedContent = `lines 10-50 content ${"y".repeat(800)}`;
    const fullContent = `full file content ${"z".repeat(800)}`;
    const msgs = [
      makeMsg("u1", "user", "read part of file"),
      makeMsgWithTool(
        "a1",
        "assistant",
        "read",
        '{"path":"src/foo.ts","offset":10,"limit":40}',
        rangedContent,
      ),
      makeMsg("u2", "user", "read full file"),
      makeMsgWithTool(
        "a2",
        "assistant",
        "read",
        '{"path":"src/foo.ts"}',
        fullContent,
      ),
      makeMsg("u3", "user", "done"),
    ];
    const result = deduplicateToolOutputs(msgs, 4);
    // Earlier ranged read should be deduped — full-file covers it
    expect(getToolOutput(result[1].parts[0])).toContain(
      "earlier read of src/foo.ts",
    );
    expect(getToolOutput(result[1].parts[0])).toContain("lines 10-49");
    // Full-file read should be intact
    expect(getToolOutput(result[3].parts[0])).toBe(fullContent);
  });

  test("ranged read does NOT cover earlier full-file read", () => {
    const fullContent = `full file content ${"y".repeat(800)}`;
    const rangedContent = `lines 10-50 content ${"z".repeat(800)}`;
    const msgs = [
      makeMsg("u1", "user", "read full file"),
      makeMsgWithTool(
        "a1",
        "assistant",
        "read",
        '{"path":"src/foo.ts"}',
        fullContent,
      ),
      makeMsg("u2", "user", "read part"),
      makeMsgWithTool(
        "a2",
        "assistant",
        "read",
        '{"path":"src/foo.ts","offset":10,"limit":40}',
        rangedContent,
      ),
      makeMsg("u3", "user", "done"),
    ];
    const result = deduplicateToolOutputs(msgs, 4);
    // Full-file read should NOT be deduped — narrow later read can't cover it
    expect(getToolOutput(result[1].parts[0])).toBe(fullContent);
    // Ranged read is latest for its range — kept
    expect(getToolOutput(result[3].parts[0])).toBe(rangedContent);
  });

  test("wider range covers narrower range", () => {
    const narrowContent = `narrow range ${"a".repeat(800)}`;
    const wideContent = `wide range ${"b".repeat(800)}`;
    const msgs = [
      makeMsg("u1", "user", "read narrow"),
      makeMsgWithTool(
        "a1",
        "assistant",
        "read",
        '{"path":"src/foo.ts","offset":20,"limit":30}',
        narrowContent,
      ),
      makeMsg("u2", "user", "read wider"),
      makeMsgWithTool(
        "a2",
        "assistant",
        "read",
        '{"path":"src/foo.ts","offset":10,"limit":60}',
        wideContent,
      ),
      makeMsg("u3", "user", "done"),
    ];
    const result = deduplicateToolOutputs(msgs, 4);
    // Narrow earlier read should be deduped — wider later covers it
    expect(getToolOutput(result[1].parts[0])).toContain(
      "earlier read of src/foo.ts",
    );
    // Wider read is latest — kept
    expect(getToolOutput(result[3].parts[0])).toBe(wideContent);
  });

  test("narrower range does NOT cover wider range", () => {
    const wideContent = `wide range ${"a".repeat(800)}`;
    const narrowContent = `narrow range ${"b".repeat(800)}`;
    const msgs = [
      makeMsg("u1", "user", "read wide"),
      makeMsgWithTool(
        "a1",
        "assistant",
        "read",
        '{"path":"src/foo.ts","offset":10,"limit":60}',
        wideContent,
      ),
      makeMsg("u2", "user", "read narrow"),
      makeMsgWithTool(
        "a2",
        "assistant",
        "read",
        '{"path":"src/foo.ts","offset":20,"limit":30}',
        narrowContent,
      ),
      makeMsg("u3", "user", "done"),
    ];
    const result = deduplicateToolOutputs(msgs, 4);
    // Wide earlier read should NOT be deduped — narrow later can't cover it
    expect(getToolOutput(result[1].parts[0])).toBe(wideContent);
    // Narrow read is kept
    expect(getToolOutput(result[3].parts[0])).toBe(narrowContent);
  });

  test("non-overlapping ranges both kept", () => {
    const contentA = `range A ${"a".repeat(800)}`;
    const contentB = `range B ${"b".repeat(800)}`;
    const msgs = [
      makeMsg("u1", "user", "read top"),
      makeMsgWithTool(
        "a1",
        "assistant",
        "read",
        '{"path":"src/foo.ts","offset":1,"limit":50}',
        contentA,
      ),
      makeMsg("u2", "user", "read bottom"),
      makeMsgWithTool(
        "a2",
        "assistant",
        "read",
        '{"path":"src/foo.ts","offset":100,"limit":50}',
        contentB,
      ),
      makeMsg("u3", "user", "done"),
    ];
    const result = deduplicateToolOutputs(msgs, 4);
    // Neither covers the other — both kept
    expect(getToolOutput(result[1].parts[0])).toBe(contentA);
    expect(getToolOutput(result[3].parts[0])).toBe(contentB);
  });

  test("annotation includes range info for ranged reads", () => {
    const content = `ranged ${"x".repeat(800)}`;
    const msgs = [
      makeMsg("u1", "user", "read part"),
      makeMsgWithTool(
        "a1",
        "assistant",
        "read",
        '{"path":"src/foo.ts","offset":10,"limit":40}',
        content,
      ),
      makeMsg("u2", "user", "read full"),
      makeMsgWithTool(
        "a2",
        "assistant",
        "read",
        '{"path":"src/foo.ts"}',
        `full ${"y".repeat(800)}`,
      ),
      makeMsg("u3", "user", "done"),
    ];
    const result = deduplicateToolOutputs(msgs, 4);
    const annotationPart = result[1]?.parts[0];
    if (!annotationPart) throw new Error("expected annotation tool part");
    const annotation = getToolOutput(annotationPart);
    expect(annotation).toContain("lines 10-49");
    expect(annotation).toContain("src/foo.ts");
  });

  test("content-hash dedup still works for non-read tools", () => {
    const bashOutput = `npm test\n${"PASS ".repeat(200)}`;
    const msgs = [
      makeMsg("u1", "user", "run tests"),
      makeMsgWithTool(
        "a1",
        "assistant",
        "bash",
        '{"command":"npm test"}',
        bashOutput,
      ),
      makeMsg("u2", "user", "run again"),
      makeMsgWithTool(
        "a2",
        "assistant",
        "bash",
        '{"command":"npm test"}',
        bashOutput,
      ),
      makeMsg("u3", "user", "ok"),
    ];
    const result = deduplicateToolOutputs(msgs, 4);
    expect(getToolOutput(result[1].parts[0])).toContain("duplicate output");
    expect(getToolOutput(result[3].parts[0])).toBe(bashOutput);
  });

  test("same exact ranged reads deduplicates", () => {
    const content = `exact range ${"x".repeat(800)}`;
    const msgs = [
      makeMsg("u1", "user", "read"),
      makeMsgWithTool(
        "a1",
        "assistant",
        "read",
        '{"path":"src/foo.ts","offset":10,"limit":50}',
        content,
      ),
      makeMsg("u2", "user", "read same range"),
      makeMsgWithTool(
        "a2",
        "assistant",
        "read",
        '{"path":"src/foo.ts","offset":10,"limit":50}',
        content,
      ),
      makeMsg("u3", "user", "done"),
    ];
    const result = deduplicateToolOutputs(msgs, 4);
    // Earlier read deduped (both content hash and range match)
    expect(getToolOutput(result[1].parts[0])).toContain("earlier read");
    // Latest kept
    expect(getToolOutput(result[3].parts[0])).toBe(content);
  });

  test("read_file tool name works with ranges", () => {
    const content = `read_file content ${"x".repeat(800)}`;
    const msgs = [
      makeMsg("u1", "user", "read"),
      makeMsgWithTool(
        "a1",
        "assistant",
        "read_file",
        '{"filePath":"src/bar.ts","offset":5,"limit":20}',
        content,
      ),
      makeMsg("u2", "user", "read full"),
      makeMsgWithTool(
        "a2",
        "assistant",
        "read_file",
        '{"filePath":"src/bar.ts"}',
        `full ${"y".repeat(800)}`,
      ),
      makeMsg("u3", "user", "done"),
    ];
    const result = deduplicateToolOutputs(msgs, 4);
    expect(getToolOutput(result[1].parts[0])).toContain(
      "earlier read of src/bar.ts",
    );
    expect(getToolOutput(result[1].parts[0])).toContain("lines 5-24");
  });
});

describe("onIdleResume", () => {
  const SID = "idle-resume-sess";
  const ONE_HOUR_MS = 60 * 60_000;

  beforeEach(() => {
    resetCalibration(SID);
    setModelLimits({ context: 10_000, output: 2_000 });
    calibrate(0);
  });

  test("first turn — no lastTurnAt yet, never triggers", () => {
    const result = onIdleResume(SID, ONE_HOUR_MS);
    expect(result.triggered).toBe(false);
    const state = inspectSessionState(SID);
    expect(state).not.toBeNull();
    expect(state?.cameOutOfIdle).toBe(false);
  });

  test("under threshold — does not trigger or reset caches", () => {
    // Seed a recent last-turn timestamp.
    const now = 1_000_000_000_000; // arbitrary epoch ms
    setLastTurnAtForTest(SID, now - 30 * 60_000); // 30 min ago
    // Run a transform first to populate prefix/raw caches (best effort).
    transform({
      messages: [
        {
          info: {
            id: "u1",
            sessionID: SID,
            role: "user",
            time: { created: now },
            agent: "build",
            model: { providerID: "anthropic", modelID: "x" },
          },
          parts: [
            {
              id: "p1",
              sessionID: SID,
              messageID: "u1",
              type: "text",
              text: "hi",
              time: { start: now, end: now },
            },
          ],
        },
      ],
      projectPath: PROJECT,
      sessionID: SID,
    });
    // Re-seed lastTurnAt (transform overwrote it to Date.now()).
    setLastTurnAtForTest(SID, now - 30 * 60_000);

    const result = onIdleResume(SID, ONE_HOUR_MS, now);
    expect(result.triggered).toBe(false);
    const state = inspectSessionState(SID);
    expect(state?.cameOutOfIdle).toBe(false);
  });

  test("over threshold — triggers, resets caches, sets cameOutOfIdle", () => {
    const now = 1_000_000_000_000;
    setLastTurnAtForTest(SID, now - 2 * ONE_HOUR_MS); // 2 hours ago

    // Force at least one cache to be populated so we can observe the reset.
    // We use the testing inspector path: directly induce state by calling
    // transform() so the prefix cache might populate. But for a deterministic
    // assertion we just check the post-call state — onIdleResume itself sets
    // them to null regardless of whether they were populated.
    const result = onIdleResume(SID, ONE_HOUR_MS, now);
    expect(result.triggered).toBe(true);
    if (result.triggered) {
      expect(result.idleMs).toBe(2 * ONE_HOUR_MS);
    }
    const state = inspectSessionState(SID);
    expect(state?.hasPrefixCache).toBe(false);
    expect(state?.hasRawWindowCache).toBe(false);
    expect(state?.cameOutOfIdle).toBe(true);
  });

  test("threshold of 0 disables the feature entirely", () => {
    const now = 1_000_000_000_000;
    setLastTurnAtForTest(SID, now - 30 * 24 * 60 * 60_000); // 30 days ago
    const result = onIdleResume(SID, 0, now);
    expect(result.triggered).toBe(false);
    const state = inspectSessionState(SID);
    expect(state?.cameOutOfIdle).toBe(false);
  });

  test("consumeCameOutOfIdle is one-shot", () => {
    const now = 1_000_000_000_000;
    setLastTurnAtForTest(SID, now - 2 * ONE_HOUR_MS);
    onIdleResume(SID, ONE_HOUR_MS, now);
    expect(inspectSessionState(SID)?.cameOutOfIdle).toBe(true);

    expect(consumeCameOutOfIdle(SID)).toBe(true);
    expect(inspectSessionState(SID)?.cameOutOfIdle).toBe(false);

    // Second call returns false — flag was cleared.
    expect(consumeCameOutOfIdle(SID)).toBe(false);
  });

  test("consumeCameOutOfIdle on unknown session returns false", () => {
    expect(consumeCameOutOfIdle("never-existed-session")).toBe(false);
  });

  test("transform() updates lastTurnAt — subsequent calls see no idle gap", () => {
    const before = Date.now();
    transform({
      messages: [
        {
          info: {
            id: "u1",
            sessionID: SID,
            role: "user",
            time: { created: before },
            agent: "build",
            model: { providerID: "anthropic", modelID: "x" },
          },
          parts: [
            {
              id: "p1",
              sessionID: SID,
              messageID: "u1",
              type: "text",
              text: "hello world",
              time: { start: before, end: before },
            },
          ],
        },
      ],
      projectPath: PROJECT,
      sessionID: SID,
    });
    const state = inspectSessionState(SID);
    expect(state?.lastTurnAt).toBeGreaterThanOrEqual(before);
    // Without a real idle gap, onIdleResume should not trigger.
    const result = onIdleResume(SID, ONE_HOUR_MS);
    expect(result.triggered).toBe(false);
  });

  test("skipCompact=true skips postIdleCompact but still does housekeeping", () => {
    const now = 1_000_000_000_000;
    setLastTurnAtForTest(SID, now - 2 * ONE_HOUR_MS);

    const result = onIdleResume(SID, ONE_HOUR_MS, now, /* skipCompact */ true);
    expect(result.triggered).toBe(true);
    if (result.triggered) {
      expect(result.idleMs).toBe(2 * ONE_HOUR_MS);
    }

    const state = inspectSessionState(SID);
    // Housekeeping still happens:
    expect(state?.hasPrefixCache).toBe(false);
    expect(state?.hasRawWindowCache).toBe(false);
    expect(state?.cameOutOfIdle).toBe(true);
    expect(state?.distillationSnapshot).toBeNull();
    // But compaction is skipped:
    expect(state?.postIdleCompact).toBe(false);
  });

  test("skipCompact=false (default) sets postIdleCompact when idle", () => {
    const now = 1_000_000_000_000;
    setLastTurnAtForTest(SID, now - 2 * ONE_HOUR_MS);

    const result = onIdleResume(SID, ONE_HOUR_MS, now, /* skipCompact */ false);
    expect(result.triggered).toBe(true);
    const state = inspectSessionState(SID);
    expect(state?.postIdleCompact).toBe(true);
    expect(state?.cameOutOfIdle).toBe(true);
  });
});

describe("reasoning preservation (F-REASONING-AUDIT mini-pin)", () => {
  // Fast structural check — full coverage lives in gradient-reasoning.test.ts.
  // This guards against an accidental change to estimateParts/cleanParts that
  // would silently drop reasoning blocks across all gradient layers.
  test("layer 0 preserves reasoning parts unchanged", () => {
    const SID = "reasoning-mini-sess";
    resetCalibration(SID);
    setModelLimits({ context: 100_000, output: 4_000 });
    calibrate(0);

    const messages: LoreMessageWithParts[] = [
      makeMsg("rm-u1", "user", "Plan something."),
      {
        info: {
          id: "rm-a1",
          sessionID: SID,
          role: "assistant",
          time: { created: Date.now() },
          parentID: "parent-rm-a1",
          modelID: "claude-opus-4-7",
          providerID: "anthropic",
          mode: "build",
          path: { cwd: "/test", root: "/test" },
          cost: 0,
          tokens: {
            input: 100,
            output: 50,
            reasoning: 200,
            cache: { read: 0, write: 0 },
          },
        },
        parts: [
          {
            id: "rm-r1",
            sessionID: SID,
            messageID: "rm-a1",
            type: "reasoning",
            text: "I should consider the trade-offs carefully here.",
            time: { start: Date.now(), end: Date.now() },
          } as LorePart,
          {
            id: "rm-t1",
            sessionID: SID,
            messageID: "rm-a1",
            type: "text",
            text: "Here is my plan.",
            time: { start: Date.now(), end: Date.now() },
          },
        ],
      },
    ];

    const result = transform({
      messages,
      projectPath: PROJECT,
      sessionID: SID,
    });
    expect(result.layer).toBe(0);
    // Layer 0 returns the input array by reference
    expect(result.messages).toBe(messages);
    // Reasoning part still present, byte-identical
    const assistantParts = result.messages[1].parts;
    const reasoningPart = assistantParts.find((p) => p.type === "reasoning") as
      | { type: "reasoning"; text: string }
      | undefined;
    expect(reasoningPart).toBeDefined();
    expect(reasoningPart?.text).toBe(
      "I should consider the trade-offs carefully here.",
    );
  });
});

describe("gradient — distillation snapshot caching", () => {
  const SID = "distill-snapshot-sess";
  const PID_KEY = "distill-snapshot-project";
  let projectId: string;
  let createdCounter = 0;

  function insertDistillation(opts: {
    sessionID: string;
    observations: string;
    archived?: number;
  }): string {
    const id = crypto.randomUUID();
    db()
      .query(
        `INSERT INTO distillations (id, project_id, session_id, narrative, facts, observations, source_ids, generation, token_count, archived, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        projectId,
        opts.sessionID,
        "",
        "[]",
        opts.observations,
        "[]",
        0,
        Math.ceil(opts.observations.length / 3),
        opts.archived ?? 0,
        Date.now() + createdCounter++,
      );
    return id;
  }

  beforeAll(() => {
    projectId = ensureProject(`/test/${PID_KEY}`);
    // Wide enough to avoid emergency Layer 4; tests explicitly force Layer 1
    // where the warm distilled-prefix cache is used.
    setModelLimits({ context: 50_000, output: 1_000 });
    calibrate(0);
  });

  beforeEach(() => {
    resetCalibration(SID);
    resetPrefixCache(SID);
    resetRawWindowCache(SID);
    resetDistillationSnapshot(SID);
    createdCounter = 0;
    db().query("DELETE FROM distillations WHERE project_id = ?").run(projectId);
  });

  afterAll(() => {
    setModelLimits({ context: 10_000, output: 2_000 });
    calibrate(0);
    db().query("DELETE FROM distillations WHERE project_id = ?").run(projectId);
  });

  test("consecutive transforms with same user message reuse cached distillation rows", () => {
    // Insert a distillation row so the prefix has content
    insertDistillation({
      sessionID: SID,
      observations:
        "- Initial observation about the task\n- Second observation",
    });

    // Build a conversation big enough to trigger gradient mode (layer 1+)
    const messages = Array.from({ length: 16 }, (_, i) =>
      makeMsg(
        `snap-${i}`,
        i % 2 === 0 ? "user" : "assistant",
        "X".repeat(1_000),
        SID,
      ),
    );

    const projectPath = `/test/${PID_KEY}`;
    setForceMinLayer(1, SID);
    const result1 = transform({ messages, projectPath, sessionID: SID });
    expect(result1.layer).toBeGreaterThanOrEqual(1);

    // Insert a NEW distillation row between calls — simulates background distill arriving mid-chain
    insertDistillation({
      sessionID: SID,
      observations: "- New observation that should NOT be consumed mid-chain",
    });

    // Same messages (same last user message) — should get cached snapshot
    setForceMinLayer(1, SID);
    const result2 = transform({ messages, projectPath, sessionID: SID });
    expect(result2.layer).toBeGreaterThanOrEqual(1);

    // The distilled prefix should be identical (snapshot frozen)
    // Find prefix messages (those without session ID = distilled)
    const prefix1 = result1.messages.filter(
      (m) => !m.info.sessionID || m.info.sessionID !== SID,
    );
    const prefix2 = result2.messages.filter(
      (m) => !m.info.sessionID || m.info.sessionID !== SID,
    );

    // Prefix text should be byte-identical — the new row was NOT consumed
    const text1 = prefix1
      .map((m) => m.parts.map((p) => ("text" in p ? p.text : "")).join())
      .join();
    const text2 = prefix2
      .map((m) => m.parts.map((p) => ("text" in p ? p.text : "")).join())
      .join();
    expect(text2).toBe(text1);
    expect(text1).not.toContain("should NOT be consumed");
  });

  test("new gen-0 rows do not rewrite the warm distilled prefix at a turn boundary", () => {
    insertDistillation({
      sessionID: SID,
      observations: "- First observation",
    });

    const projectPath = `/test/${PID_KEY}`;

    // First call with user msg u-0
    setForceMinLayer(1, SID);
    const messages1 = Array.from({ length: 16 }, (_, i) =>
      makeMsg(
        `ref-${i}`,
        i % 2 === 0 ? "user" : "assistant",
        "X".repeat(1_000),
        SID,
      ),
    );
    const result1 = transform({
      messages: messages1,
      projectPath,
      sessionID: SID,
    });
    expect(result1.layer).toBeGreaterThanOrEqual(1);
    expect(inspectSessionState(SID)?.hasPrefixCache).toBe(true);

    // Insert a new distillation row
    insertDistillation({
      sessionID: SID,
      observations: "- Second observation after turn boundary",
    });

    // Append a NEW user message — this is a turn boundary, so the DB snapshot
    // refreshes, but the rendered prefix remains frozen while the session is
    // warm. Rendering the appended gen-0 row here would rewrite messages[1]
    // near the prompt front and bust the Anthropic cache.
    const messages2 = [
      ...messages1,
      makeMsg("ref-new-user", "user", "New question from the user", SID),
    ];
    setForceMinLayer(1, SID);
    const result2 = transform({
      messages: messages2,
      projectPath,
      sessionID: SID,
    });
    expect(result2.layer).toBeGreaterThanOrEqual(1);

    // The new row is visible in the DB but must NOT be rendered into the warm
    // prefix. It will be folded in after onIdleResume clears prefixCache.
    const allText = result2.messages
      .map((m) => m.parts.map((p) => ("text" in p ? p.text : "")).join())
      .join();
    expect(allText).toContain("First observation");
    expect(allText).not.toContain("Second observation");
  });

  test("first gen-0 row is also deferred when the warm session had no prefix", () => {
    const projectPath = `/test/${PID_KEY}`;
    const messages1 = Array.from({ length: 16 }, (_, i) =>
      makeMsg(
        `first-row-${i}`,
        i % 2 === 0 ? "user" : "assistant",
        "X".repeat(1_000),
        SID,
      ),
    );

    setForceMinLayer(1, SID);
    const result1 = transform({
      messages: messages1,
      projectPath,
      sessionID: SID,
    });
    expect(result1.layer).toBeGreaterThanOrEqual(1);
    expect(inspectSessionState(SID)?.hasPrefixCache).toBe(true);
    expect(
      result1.messages.some((m) => m.info.id === "lore-distilled-assistant"),
    ).toBe(false);

    insertDistillation({
      sessionID: SID,
      observations: "- First warm-row observation that must wait for idle",
    });

    const messages2 = [
      ...messages1,
      makeMsg("first-row-new-user", "user", "Next warm turn", SID),
    ];
    setForceMinLayer(1, SID);
    const warm = transform({
      messages: messages2,
      projectPath,
      sessionID: SID,
    });
    const warmText = warm.messages
      .map((m) => m.parts.map((p) => ("text" in p ? p.text : "")).join())
      .join();
    expect(warmText).not.toContain("First warm-row observation");

    setLastTurnAtForTest(SID, Date.now() - 600_000);
    expect(onIdleResume(SID, 60_000).triggered).toBe(true);

    setForceMinLayer(1, SID);
    const cold = transform({
      messages: messages2,
      projectPath,
      sessionID: SID,
    });
    const coldText = cold.messages
      .map((m) => m.parts.map((p) => ("text" in p ? p.text : "")).join())
      .join();
    expect(coldText).toContain("First warm-row observation");
  });

  test("onIdleResume clears distillation snapshot", () => {
    insertDistillation({
      sessionID: SID,
      observations: "- Pre-idle observation",
    });

    const projectPath = `/test/${PID_KEY}`;

    // Build up state with a transform
    const messages = Array.from({ length: 16 }, (_, i) =>
      makeMsg(
        `idle-${i}`,
        i % 2 === 0 ? "user" : "assistant",
        "X".repeat(1_000),
        SID,
      ),
    );
    setForceMinLayer(1, SID);
    transform({ messages, projectPath, sessionID: SID });

    // Verify snapshot exists via inspectSessionState
    const state1 = inspectSessionState(SID);
    expect(state1?.distillationSnapshot).not.toBeNull();

    // Insert new distillation
    insertDistillation({
      sessionID: SID,
      observations: "- Post-idle observation that should appear after resume",
    });

    // Simulate idle resume — sets lastTurnAt first so onIdleResume triggers
    setLastTurnAtForTest(SID, Date.now() - 600_000); // 10 minutes ago
    const idle = onIdleResume(SID, 60_000);
    expect(idle.triggered).toBe(true);

    // Verify snapshot was cleared
    const state2 = inspectSessionState(SID);
    expect(state2?.distillationSnapshot).toBeNull();

    // Next transform should pick up the new distillation (same user messages — but snapshot was cleared)
    setForceMinLayer(1, SID);
    const result = transform({ messages, projectPath, sessionID: SID });
    const allText = result.messages
      .map((m) => m.parts.map((p) => ("text" in p ? p.text : "")).join())
      .join();
    expect(allText).toContain("Post-idle observation");
  });

  // Regression: loadDistillations orders by (created_at, id). Two rows written
  // in the same millisecond must render in a stable, deterministic order across
  // repeated DB reads — otherwise the rendered prefix bytes flip between turns
  // and bust the Anthropic prompt cache. See the id tie-break in
  // loadDistillations (gradient.ts).
  test("same-millisecond distillation rows render in stable id order", () => {
    const projectPath = `/test/${PID_KEY}`;

    // Insert two rows with the SAME created_at but ids whose ascending order is
    // the OPPOSITE of insertion order. Without the id tie-break, SQLite's order
    // among equal created_at values is undefined and can differ per query.
    const sameTs = Date.now();
    function insertAt(id: string, observations: string): void {
      db()
        .query(
          `INSERT INTO distillations (id, project_id, session_id, narrative, facts, observations, source_ids, generation, token_count, archived, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          projectId,
          SID,
          "",
          "[]",
          observations,
          "[]",
          0,
          Math.ceil(observations.length / 3),
          0,
          sameTs,
        );
    }
    // id "aaaa…" sorts before "bbbb…"; insert bbbb first so insertion order
    // and id order disagree.
    insertAt(
      "bbbbbbbb-0000-0000-0000-000000000002",
      "- ZZZ second-by-id observation",
    );
    insertAt(
      "aaaaaaaa-0000-0000-0000-000000000001",
      "- AAA first-by-id observation",
    );

    const messages = Array.from({ length: 16 }, (_, i) =>
      makeMsg(
        `tiebreak-${i}`,
        i % 2 === 0 ? "user" : "assistant",
        "X".repeat(1_000),
        SID,
      ),
    );

    function renderPrefix(): string {
      // Clear the in-memory snapshot + prefix cache so each call performs a
      // fresh DB read through loadDistillations (the ordering under test).
      resetDistillationSnapshot(SID);
      resetPrefixCache(SID);
      setForceMinLayer(1, SID);
      const result = transform({ messages, projectPath, sessionID: SID });
      return result.messages
        .map((m) => m.parts.map((p) => ("text" in p ? p.text : "")).join())
        .join();
    }

    const first = renderPrefix();
    const second = renderPrefix();
    const third = renderPrefix();

    // Deterministic across repeated reads.
    expect(second).toBe(first);
    expect(third).toBe(first);

    // Both observations present, ordered by id ascending (AAA before ZZZ).
    expect(first).toContain("AAA first-by-id observation");
    expect(first).toContain("ZZZ second-by-id observation");
    expect(first.indexOf("AAA first-by-id observation")).toBeLessThan(
      first.indexOf("ZZZ second-by-id observation"),
    );
  });
});

describe("gradient — sanitizeToolParts determinism", () => {
  // sanitizeToolParts converts pending/running tool parts to error state.
  // It must use deterministic timestamps so repeated transform() calls on the
  // same stale pending part produce identical bytes (prompt cache stability).
  const SID = "sanitize-determ-sess";

  beforeAll(() => {
    setModelLimits({ context: 10_000, output: 2_000 });
    calibrate(0);
  });

  afterAll(() => {
    setModelLimits({ context: 10_000, output: 2_000 });
    calibrate(0);
  });

  function makeAssistantWithPendingTool(
    id: string,
    toolName: string,
  ): LoreMessageWithParts {
    return {
      info: {
        id,
        sessionID: SID,
        role: "assistant" as const,
        time: { created: 1000 },
        parentID: `parent-${id}`,
        modelID: "claude-sonnet-4-20250514",
        providerID: "anthropic",
        mode: "build",
        path: { cwd: "/test", root: "/test" },
        cost: 0,
        tokens: {
          input: 100,
          output: 50,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
      },
      parts: [
        {
          id: `part-text-${id}`,
          sessionID: SID,
          messageID: id,
          type: "text" as const,
          text: "Let me run this tool.",
          time: { start: 1000, end: 1000 },
        },
        {
          id: `part-tool-${id}`,
          sessionID: SID,
          messageID: id,
          type: "tool" as const,
          tool: toolName,
          callID: `call-${id}`,
          state: {
            status: "pending" as const,
            input: { command: "ls -la" },
          },
        },
      ],
    };
  }

  test("consecutive transforms produce identical bytes for stale pending tool parts", () => {
    const messages: LoreMessageWithParts[] = [
      makeMsg("san-1", "user", "Hello", SID),
      makeAssistantWithPendingTool("san-2", "bash"),
    ];

    const result1 = transform({
      messages,
      projectPath: PROJECT,
      sessionID: SID,
    });
    // The pending tool part should have been converted to error
    const toolPart1 = result1.messages
      .flatMap((m) => m.parts)
      .find((p) => isToolPart(p));
    expect(toolPart1).toBeDefined();
    expect(toolPart1?.state.status).toBe("error");

    // Second call with the exact same messages (simulating OpenCode's cached array)
    const result2 = transform({
      messages,
      projectPath: PROJECT,
      sessionID: SID,
    });
    const toolPart2 = result2.messages
      .flatMap((m) => m.parts)
      .find((p) => isToolPart(p));
    expect(toolPart2).toBeDefined();
    expect(toolPart2?.state.status).toBe("error");

    // The serialized bytes must be identical — this is what Anthropic's cache sees
    const json1 = JSON.stringify(toolPart1?.state);
    const json2 = JSON.stringify(toolPart2?.state);
    expect(json2).toBe(json1);
  });
});

describe("tier-based context management", () => {
  describe("getTier", () => {
    test("returns tier 0 for tokens under 200K", () => {
      expect(getTier(0)).toBe(0);
      expect(getTier(100_000)).toBe(0);
      expect(getTier(200_000)).toBe(0);
    });

    test("returns tier 1 for tokens between 200K and 500K", () => {
      expect(getTier(200_001)).toBe(1);
      expect(getTier(350_000)).toBe(1);
      expect(getTier(500_000)).toBe(1);
    });

    test("returns tier 2 for tokens above 500K", () => {
      expect(getTier(500_001)).toBe(2);
      expect(getTier(1_000_000)).toBe(2);
    });
  });

  describe("shouldCompress", () => {
    beforeEach(() => {
      // Opus 4.6 pricing: write=$6.25/M, read=$0.50/M
      setCachePricing(6.25 / 1_000_000, 0.5 / 1_000_000);
    });

    test("compresses when bust cost is much less than continue cost", () => {
      // 250K current → 150K compressed
      // bustCost = 150K × $6.25/M = $0.9375
      // continueCost = 250K × $0.50/M = $0.125
      // bustCost > continueCost — but shouldCompress returns false because
      // bust is MORE expensive, not less
      expect(shouldCompress(250_000, 150_000, 0)).toBe(false);
    });

    test("does not compress when bust cost exceeds threshold of continue cost", () => {
      // 250K current → 150K compressed
      // bustCost = 150K × $6.25/M = $0.9375
      // continueCost = 250K × $0.50/M = $0.125
      // bustCost (0.9375) >> threshold * continueCost (0.85 × 0.125 = 0.106)
      expect(shouldCompress(250_000, 150_000, 0)).toBe(false);
    });

    test("compresses when large context makes reads more expensive than bust", () => {
      // Very large context: 2M current → 100K compressed
      // bustCost = 100K × $6.25/M = $0.625
      // continueCost = 2M × $0.50/M = $1.00
      // bustCost (0.625) < threshold * continueCost (0.85 × 1.00 = 0.85) → compress
      expect(shouldCompress(2_000_000, 100_000, 0)).toBe(true);
    });

    test("sustained bust prices continue at WRITE cost (compresses to stop growth)", () => {
      // In a sustained-bust regime (>=SUSTAINED_BUST_THRESHOLD=2 busts) the
      // "continue" path is paying cache WRITE cost on the whole context every
      // turn, not the cheap read cost. So continueCost is priced with write:
      //   continueCost = 2M × $6.25/M = $12.50
      //   bustCost     = 100K × $6.25/M = $0.625
      //   0.625 < 0.85 × 12.50 = 10.6 → compress (break the growth loop)
      expect(shouldCompress(2_000_000, 100_000, 2)).toBe(true);
      expect(shouldCompress(2_000_000, 100_000, 10)).toBe(true);
    });

    test("sustained bust still refuses when compression isn't cheaper than rewriting", () => {
      // When compressed size is close to current size, writing the compressed
      // context is NOT cheaper than continuing — even at the write rate.
      //   continueCost = 250K × $6.25/M = $1.5625
      //   bustCost     = 240K × $6.25/M = $1.50
      //   1.50 < 0.85 × 1.5625 = 1.328 → false (don't compress)
      expect(shouldCompress(250_000, 240_000, 2)).toBe(false);
    });

    test("below the sustained-bust threshold uses the cheap read cost", () => {
      // 1 bust → below threshold (2) → not sustained → continue priced at READ.
      //   continueCost = 2M × $0.50/M = $1.00
      //   bustCost     = 100K × $6.25/M = $0.625
      //   0.625 < 0.85 × 1.00 = 0.85 → compress
      expect(shouldCompress(2_000_000, 100_000, 1)).toBe(true);
      // A modestly-grown context at 0 busts: continue is cheap → don't compress.
      expect(shouldCompress(250_000, 150_000, 0)).toBe(false);
    });

    test("falls back to conservative (do NOT compress) when no pricing", () => {
      setCachePricing(0, 0);
      // Without pricing data, we can't prove compression is worthwhile,
      // so err on the side of keeping the cache (don't bust).
      expect(shouldCompress(250_000, 150_000, 0)).toBe(false);
    });

    test("realistic compressed target compresses where inflated estimate would not", () => {
      // Regression for the "growing unsustainably" runaway (session
      // 0AVWKugtmhBKqLOX9 / ses_14b9bf3d4ffe…): on a high-context model the
      // tier gate fed shouldCompress() a compressedEstimate scaled off `usable`
      // (~0.65*usable). For a 1M-token model usable≈957K, so the estimate was
      // ~620K — but compression actually targets l0cap (~200K). With the
      // INFLATED estimate, even sustained-bust write-rate repricing refuses to
      // compress; with the REAL target it correctly compresses.
      const current = 635_000; // observed grown context
      const inflated = 620_000; // distilledBudget+rawBudget ≈ 0.65 * 957K usable
      const realTarget = 200_000; // layer0Ceiling (what compression yields)

      // Sustained-bust regime (>=5): continue is priced at the WRITE rate.
      //   continueCost = 635K × $6.25/M = $3.969
      //   inflated  bustCost = 620K × $6.25/M = $3.875  → 3.875 < 0.85*3.969=3.374? NO → don't compress
      //   real      bustCost = 200K × $6.25/M = $1.25   → 1.25  < 3.374           ? YES → compress
      expect(shouldCompress(current, inflated, 5)).toBe(false);
      expect(shouldCompress(current, realTarget, 5)).toBe(true);
    });
  });

  describe("tier gate — clamps compressedEstimate to the real compression target", () => {
    const SESSION = "tier-gate-clamp-sess";

    beforeEach(() => {
      resetCalibration(SESSION);
      resetPrefixCache();
      resetRawWindowCache();
      // High-context model (e.g. a 1M-token opus): usable ≈ 968K, so the naive
      // distilled+raw budget (~0.65*usable ≈ 629K) is far larger than what
      // compression actually produces.
      setModelLimits({ context: 1_000_000, output: 32_000 });
      // Cost-aware layer-0 cap (the real compression target). min(maxInput, this)
      // → layer0Ceiling = 200K, the value the runaway session logged as l0cap.
      setMaxLayer0Tokens(200_000);
      // Anthropic opus pricing: write=$6.25/M, read=$0.50/M (write ~12.5× read).
      setCachePricing(6.25 / 1_000_000, 0.5 / 1_000_000);
    });

    afterAll(() => {
      // Restore the suite-wide defaults so later describe blocks are unaffected.
      setModelLimits({ context: 10_000, output: 2_000 });
      setMaxLayer0Tokens(0);
      setCachePricing(0, 0);
      resetCalibration(SESSION);
      // resetCalibration sets calibratedOverhead = null (→ FIRST_TURN_OVERHEAD
      // fallback). The suite baseline (top-level beforeAll) is calibrate(0) =
      // zero overhead, so restore that to avoid leaking a 15K overhead default
      // into any later test that relies on the baseline.
      calibrate(0);
    });

    test("compresses a sustained-bust runaway instead of layer-0 passthrough", () => {
      // A handful of small messages — their token count is irrelevant because we
      // drive the SIZE via calibration below (mirrors a real long session whose
      // exact input is known from the API).
      const msgs = Array.from({ length: 8 }, (_, i) =>
        makeMsg(
          `clamp-${i}`,
          i % 2 === 0 ? "user" : "assistant",
          "x".repeat(200),
          SESSION,
        ),
      );

      // Calibrate the session directly to a large grown input, WITHOUT a prior
      // transform. This is critical: calibrate() only updates the (shared)
      // overhead EMA when a previous transform estimate exists (lastTransform-
      // Estimate > 0). With no prior transform that branch is skipped, so
      // `usable` stays at the model's true ~968K instead of collapsing — which
      // is exactly the high-context condition that triggers the bug. Passing
      // messageCount = msgs.length means the calibrated path sees zero "new"
      // messages, so expectedInput == lastKnownInput == 635K.
      calibrate(635_000, SESSION, msgs.length);

      // Drive the cache into a sustained-bust regime (well past
      // SUSTAINED_BUST_THRESHOLD): every turn is ~93% cache write, exactly like
      // the runaway logs.
      for (let i = 0; i < 6; i++) {
        recordCacheUsage(440_000, 34_813, 2, SESSION);
      }
      expect(
        inspectSessionState(SESSION)?.consecutiveBusts,
      ).toBeGreaterThanOrEqual(5);

      const result = transform({
        messages: msgs,
        projectPath: PROJECT,
        sessionID: SESSION,
      });

      // Guard the scenario actually exercises the tier gate (not the overhead-
      // collapsed path that masked the bug originally). At the decision turn
      // `usable` must be near the full model context (~968K), so the UN-clamped
      // distilled+raw budget (~0.65*usable ≈ 620K) genuinely exceeds the clamp
      // target (layer0Ceiling = 200K). If usable here collapses (e.g. overhead
      // pollution), the test would pass for the wrong reason — so assert it.
      // (The base distilled/raw budgets returned here are intentionally NOT
      // clamped — they feed the layer-1 stable window; only the ESCALATED-stage
      // builders and the tier gate's compressedEstimate clamp to the ceiling.)
      expect(result.usable).toBeGreaterThan(900_000);
      expect(result.distilledBudget + result.rawBudget).toBeGreaterThan(
        300_000,
      );

      // Before the fix: the gate fed shouldCompress() the un-clamped ~620K
      // estimate; bustCost (620K×write) dwarfed continueCost even under
      // sustained-bust write-rate repricing, so it STAYED at layer 0 and grew
      // unbounded. After clamping compressedEstimate to layer0Ceiling (200K),
      // the economics flip and the gate compresses (layer >= 1). This assertion
      // FAILS on revert of the one-line fix (verified).
      expect(result.layer).toBeGreaterThanOrEqual(1);
    });

    test("small session still passes through layer 0 (no over-compression)", () => {
      // A genuinely small session (well under layer0Ceiling) must not be
      // compressed — the clamp only affects the gate's economic estimate, not
      // the passthrough decision for sessions that comfortably fit.
      const msgs = Array.from({ length: 6 }, (_, i) =>
        makeMsg(
          `small-${i}`,
          i % 2 === 0 ? "user" : "assistant",
          "y".repeat(100),
          SESSION,
        ),
      );

      transform({ messages: msgs, projectPath: PROJECT, sessionID: SESSION });
      // Tiny calibrated input — well below layer0Ceiling (200K).
      calibrate(5_000, SESSION, msgs.length);

      const result = transform({
        messages: msgs,
        projectPath: PROJECT,
        sessionID: SESSION,
      });
      expect(result.layer).toBe(0);
    });

    test("over-cap session that bypasses compression STILL reports unsustainable", () => {
      // The tier-gate bypass returns at layer 0 but for a genuinely over-cap
      // conversation (it merely declined to compress because the bust cost
      // wasn't justified). That path MUST keep surfacing the warning — it is a
      // real exhaustion signal, distinct from the cap-fitting passthrough which
      // hardcodes unsustainable:false. This locks the intentional distinction
      // so a future refactor can't silently collapse the two layer-0 returns.
      const msgs = Array.from({ length: 8 }, (_, i) =>
        makeMsg(
          `bypass-${i}`,
          i % 2 === 0 ? "user" : "assistant",
          "z".repeat(200),
          SESSION,
        ),
      );

      // Large grown input, over the 200K layer-0 cap (see beforeEach).
      calibrate(635_000, SESSION, msgs.length);

      // No pricing data → shouldCompress() conservatively returns false, so the
      // tier gate bypasses compression and returns at layer 0 while over-cap.
      setCachePricing(0, 0);

      // Sustained-bust regime.
      for (let i = 0; i < 4; i++) {
        recordCacheUsage(440_000, 34_813, 2, SESSION);
      }
      expect((inspectSessionState(SESSION)?.consecutiveBusts ?? 0) >= 2).toBe(
        true,
      );

      const result = transform({
        messages: msgs,
        projectPath: PROJECT,
        sessionID: SESSION,
      });

      // Bypassed compression → layer 0, but genuinely over the cap (tier >= 1)…
      expect(result.layer).toBe(0);
      expect(getTier(result.totalTokens)).toBeGreaterThanOrEqual(1);
      // …so the warning MUST still fire (unlike the cap-fitting passthrough).
      expect(result.unsustainable).toBe(true);
      // Restore pricing for sibling tests.
      setCachePricing(6.25 / 1_000_000, 0.5 / 1_000_000);
    });
  });

  // Regression for the high-context overflow that wedged opencode session
  // ses_14b9bf3d4ffeEaA95V1pK9b6Nj (lore 0AVWKugtmhBKqLOX9): on a 1M-token model
  // the ESCALATED compression-stage budgets were scaled off the full `usable`
  // (~800K), so `usable * rawFrac` (0.5) produced a ~400K raw window — LARGER
  // than the ~200K cost cap whose breach triggered compression, AND larger than
  // the layer-1 window. Escalating to a higher layer GREW the window (logs:
  // layer-1 200K → layer-2 356K → 461K) until the real request overflowed the
  // model. Two fixes:
  //   1. clamp the ESCALATED-stage budgets (layers 2-3) to the layer-0 cost
  //      ceiling — the layer-1 stable-window budget is deliberately left at the
  //      full `usable * raw` so its cache-stable pin keeps eviction headroom, and
  //   2. validate every rebuilt window against the hard ceiling (no free pass
  //      for calibrated sessions, whose rebuilt windows are still chars/3
  //      estimates that undercount the real tokenizer).
  describe("gradient — high-context compression budget clamp (overflow fix)", () => {
    const SID = "overflow-fix-sess";
    const PID_KEY = "overflow-fix-project";
    let projectId: string;
    let createdCounter = 0;

    function seedDistillations(count: number, charsEach: number) {
      for (let i = 0; i < count; i++) {
        db()
          .query(
            `INSERT INTO distillations (id, project_id, session_id, narrative, facts, observations, source_ids, generation, token_count, archived, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            crypto.randomUUID(),
            projectId,
            SID,
            "",
            "[]",
            `Distillation ${i}: ${"o".repeat(charsEach)}`,
            "[]",
            0,
            Math.ceil(charsEach / 3),
            0,
            Date.now() + createdCounter++,
          );
      }
    }

    beforeAll(() => {
      projectId = ensureProject(`/test/${PID_KEY}`);
    });

    beforeEach(() => {
      resetCalibration(SID);
      resetPrefixCache(SID);
      resetRawWindowCache(SID);
      resetDistillationSnapshot(SID);
      createdCounter = 0;
      db()
        .query("DELETE FROM distillations WHERE project_id = ?")
        .run(projectId);
      db().query("DELETE FROM session_state WHERE session_id = ?").run(SID);
    });

    afterAll(() => {
      setModelLimits({ context: 10_000, output: 2_000 });
      setMaxLayer0Tokens(0);
      resetCalibration(SID);
      calibrate(0);
      db()
        .query("DELETE FROM distillations WHERE project_id = ?")
        .run(projectId);
      db().query("DELETE FROM session_state WHERE session_id = ?").run(SID);
    });

    test("layer-1 base budgets are NOT clamped to the cost cap (cache-stable window keeps headroom)", () => {
      // The narrow fix must clamp ONLY the escalated stages (layers 2-3). The
      // layer-1 stable-window budget (returned as result.rawBudget/distilledBudget)
      // MUST stay at the full `usable * fraction`. Clamping it to the cost cap
      // (an earlier over-broad fix) shrank the raw-window pin so it marched every
      // turn and busted the cache (regression caught by cache-stability.e2e).
      // 1M context + a deliberately LOW 40K cost cap (mirrors that e2e test).
      setModelLimits({ context: 1_000_000, output: 32_000 });
      setMaxLayer0Tokens(40_000);
      calibrate(0);

      const result = transform({
        messages: [
          makeMsg("l1-1", "user", "hi", SID),
          makeMsg("l1-2", "assistant", "ok", SID),
        ],
        projectPath: `/test/${PID_KEY}`,
        sessionID: SID,
      });

      // usable stays the full ~968K (LTM / economics read this).
      expect(result.usable).toBeGreaterThan(900_000);
      // Base budgets scale off the full usable — NOT the 40K cap (which would
      // give rawBudget = 40K*0.4 = 16K, starving the layer-1 pin).
      expect(result.rawBudget).toBe(Math.floor(result.usable * 0.4));
      expect(result.distilledBudget).toBe(Math.floor(result.usable * 0.25));
      expect(result.rawBudget).toBeGreaterThan(40_000);
    });

    test("escalating to layer 2 on a 1M model stays bounded near the cap (does NOT grow)", () => {
      setModelLimits({ context: 1_000_000, output: 32_000 });
      setMaxLayer0Tokens(200_000);
      calibrate(0);

      // ~500K tokens of raw conversation — far more than any single stage
      // budget, so the window size is determined by the BUDGET, not message
      // scarcity. Pre-fix the layer-2 raw budget was usable*0.5 ≈ 476K, so the
      // window grew to ~476K (and the real token count overflowed the model).
      const msgs = Array.from({ length: 300 }, (_, i) =>
        makeMsg(
          `big-${i}`,
          i % 2 === 0 ? "user" : "assistant",
          "w".repeat(5_000),
          SID,
        ),
      );

      setForceMinLayer(2, SID); // jump straight to the layer that overflowed
      const result = transform({
        messages: msgs,
        projectPath: `/test/${PID_KEY}`,
        sessionID: SID,
      });

      expect(result.layer).toBeGreaterThanOrEqual(2);
      // Post-fix the layer-2 raw budget = stageBudgetUsable*0.5 = 200K*0.5 =
      // 100K, so the rebuilt window is ~100K — bounded by the cap, not a
      // fraction of the 1M usable (pre-fix ~476K).
      expect(result.totalTokens).toBeLessThan(200_000);
      // `usable` itself is untouched (only the compression budgets are clamped).
      expect(result.usable).toBeGreaterThan(900_000);
    });

    test("escalated-stage DISTILLED prefix is clamped too (layer 2 distFrac fallthrough)", () => {
      // Layer 2 has distFrac=null, so before the fix its distilled budget fell
      // through to the UNCLAMPED base distilledBudget = usable*0.25 (~242K on a
      // 1M model) — letting the prefix balloon above the cap even though the raw
      // window was clamped. The escalated stages must clamp BOTH dimensions:
      // layer-2 distilled budget = stageBudgetUsable*0.25 = 200K*0.25 = 50K.
      setModelLimits({ context: 1_000_000, output: 32_000 });
      setMaxLayer0Tokens(200_000);
      calibrate(0);

      // ~150K tokens of distillate — far above the clamped 50K layer-2 distilled
      // budget, but below the unclamped base (~242K) so a missing clamp would
      // NOT trim it. Keep raw tiny so the window is dominated by the prefix.
      seedDistillations(25, 18_000); // 25 × 6K tokens = 150K tokens
      const msgs = Array.from({ length: 6 }, (_, i) =>
        makeMsg(
          `dist-${i}`,
          i % 2 === 0 ? "user" : "assistant",
          "d".repeat(500),
          SID,
        ),
      );

      setForceMinLayer(2, SID);
      const result = transform({
        messages: msgs,
        projectPath: `/test/${PID_KEY}`,
        sessionID: SID,
      });

      expect(result.layer).toBeGreaterThanOrEqual(2);
      // Clamped: distilled prefix trimmed to ~50K. Pre-fix (unclamped base) it
      // would stay ~150K (no trim, since 150K < usable*0.25 ≈ 242K).
      expect(result.distilledTokens).toBeLessThan(100_000);
      expect(result.usable).toBeGreaterThan(900_000);
    });

    test("hard-ceiling guard: a rebuilt over-ceiling window escalates instead of shipping (calibrated)", () => {
      // Cost cap disabled on a 200K model so budgetUsable === usable === maxInput
      // (168K). A forced layer-2 window fills prefix (0.25) + raw (0.5) ≈ 0.75 ×
      // 168K ≈ 126K; its chars/3 estimate undercounts the real tokenizer ~1.5×,
      // so 126K*1.5 = 189K > 168K maxInput. Pre-fix, a CALIBRATED session got a
      // free pass (`fitsWithSafetyMargin` returned true unconditionally) and
      // shipped that over-ceiling window → "prompt is too long". Post-fix the
      // guard rejects it and the loop escalates to a tighter layer.
      setModelLimits({ context: 200_000, output: 32_000 }); // maxInput = 168K
      setMaxLayer0Tokens(0); // disabled → budgetUsable === usable === 168K
      calibrate(0);

      // Prefix budget at layer 2 = 0.25*168K = 42K tokens; seed well past it so
      // the prefix fills its budget after the binary-search trim.
      seedDistillations(10, 18_000); // 10 × 6K tokens = 60K tokens of distillate
      // Raw budget at layer 2 = 0.5*168K = 84K tokens; provide far more.
      const msgs = Array.from({ length: 150 }, (_, i) =>
        makeMsg(
          `hc-${i}`,
          i % 2 === 0 ? "user" : "assistant",
          "h".repeat(3_000),
          SID,
        ),
      );

      // Mark the session calibrated WITHOUT a prior transform (so the shared
      // overhead EMA is not perturbed and usable stays at the true 168K). This
      // is the exact condition the pre-fix free pass applied to.
      calibrate(120_000, SID, msgs.length);
      setForceMinLayer(2, SID);

      const result = transform({
        messages: msgs,
        projectPath: `/test/${PID_KEY}`,
        sessionID: SID,
      });

      const maxInput = 200_000 - 32_000; // 168K
      // The guard rejected the over-ceiling layer-2 window and escalated past
      // the forced layer (pre-fix this stayed at layer 2 and overflowed).
      expect(result.layer).toBeGreaterThanOrEqual(3);
      // Whatever layer it lands on, the SHIPPED window must fit the hard ceiling.
      expect(result.totalTokens).toBeLessThanOrEqual(maxInput);
    });
  });

  describe("recordCacheUsage — consecutive bust tracking", () => {
    const SID = "bust-rate-tracking-sess";

    beforeEach(() => {
      resetCalibration(SID);
    });

    test("tracks consecutive busts (>50% writes of total input)", () => {
      // 100K write, 0 read, 3 uncached → total=100_003, ratio≈100% → bust
      // (inputTokens is the uncached portion from Anthropic API, typically small)
      recordCacheUsage(100_000, 0, 3, SID);
      expect(inspectSessionState(SID)?.consecutiveBusts).toBe(1);

      // 80K write, 20K read, 5 uncached → total=100_005, ratio=80% → bust
      recordCacheUsage(80_000, 20_000, 5, SID);
      expect(inspectSessionState(SID)?.consecutiveBusts).toBe(2);
    });

    test("uses sum of write + read + uncached for bust ratio", () => {
      // 60K write, 100K read, 3 uncached → total=160_003, ratio=37.5% → NOT a bust
      recordCacheUsage(60_000, 100_000, 3, SID);
      expect(inspectSessionState(SID)?.consecutiveBusts).toBe(0);
    });

    test("resets consecutive busts on cache-hit turn (<50% writes)", () => {
      recordCacheUsage(100_000, 0, 3, SID);
      recordCacheUsage(100_000, 0, 3, SID);
      expect(inspectSessionState(SID)?.consecutiveBusts).toBe(2);

      // Good cache hit — resets counter
      recordCacheUsage(1_000, 90_000, 3, SID);
      expect(inspectSessionState(SID)?.consecutiveBusts).toBe(0);
    });

    test("zero-usage turn does not change consecutive bust count", () => {
      recordCacheUsage(100_000, 0, 3, SID);
      expect(inspectSessionState(SID)?.consecutiveBusts).toBe(1);

      // Zero usage — no change
      recordCacheUsage(0, 0, 0, SID);
      expect(inspectSessionState(SID)?.consecutiveBusts).toBe(1);
    });

    // Regression for the ses_14b9bf3d… false "unsustainable" warning: a bursty
    // session whose turns are spaced beyond the conversation cache TTL re-warms a
    // legitimately-cold cache on every resume (a write-heavy "bust"). Those
    // idle-resume re-warms are EXPECTED, not sustained growth, and must not push
    // the counter toward SUSTAINED_BUST_THRESHOLD.
    test("idle-resume re-warm does NOT increment consecutive busts", () => {
      recordCacheUsage(100_000, 0, 3, SID, true);
      expect(inspectSessionState(SID)?.consecutiveBusts).toBe(0);
    });

    test("two idle-resume re-warms stay below the unsustainable threshold", () => {
      recordCacheUsage(100_000, 0, 3, SID, true);
      recordCacheUsage(100_000, 0, 3, SID, true);
      // Without the idle guard these two cold re-warms would read as "2
      // consecutive busts" and trip the unsustainable warning.
      expect(inspectSessionState(SID)?.consecutiveBusts).toBe(0);
    });

    test("idle-resume holds (does not erase) a genuine prior bust run", () => {
      // A real warm-cache bust happened first.
      recordCacheUsage(100_000, 0, 3, SID);
      expect(inspectSessionState(SID)?.consecutiveBusts).toBe(1);
      // Then an idle resume re-warms: hold the counter — neither advance toward
      // the threshold nor wipe the genuine prior bust.
      recordCacheUsage(100_000, 0, 3, SID, true);
      expect(inspectSessionState(SID)?.consecutiveBusts).toBe(1);
    });

    test("a genuine (non-idle) bust after an idle re-warm still increments", () => {
      recordCacheUsage(100_000, 0, 3, SID, true); // idle — held at 0
      recordCacheUsage(100_000, 0, 3, SID); // genuine warm-window bust
      recordCacheUsage(100_000, 0, 3, SID); // genuine warm-window bust
      expect(inspectSessionState(SID)?.consecutiveBusts).toBe(2);
    });

    test("idle-resume cache HIT still resets the counter", () => {
      recordCacheUsage(100_000, 0, 3, SID);
      recordCacheUsage(100_000, 0, 3, SID);
      expect(inspectSessionState(SID)?.consecutiveBusts).toBe(2);
      // A genuine cache hit on an idle resume is still a hit — reset.
      recordCacheUsage(1_000, 90_000, 3, SID, true);
      expect(inspectSessionState(SID)?.consecutiveBusts).toBe(0);
    });
  });

  describe("unsustainable gating — only fires when genuinely over the layer-0 cap", () => {
    // Regression for false "unsustainable conversation" warnings on a small
    // (tier-0) session that fits layer 0 with headroom. The bug surfaced when a
    // sub-cap session accumulated consecutive cache busts from a structural
    // cause (stale prompt-delta position post-idle) — consecutiveBusts climbed
    // unbounded and the warning fired every turn even though the conversation
    // was trivially sustainable. unsustainable must be gated on real context
    // exhaustion (tier >= 1 / over the layer-0 cap), not on the bust count alone.
    const SID = "unsustainable-gate-sess";

    beforeEach(() => {
      resetCalibration(SID);
      setModelLimits({ context: 10_000, output: 2_000 });
      calibrate(0);
    });

    afterAll(() => {
      setModelLimits({ context: 10_000, output: 2_000 });
      calibrate(0);
    });

    test("tier-0 layer-0 passthrough never reports unsustainable, even after sustained busts", () => {
      const messages = [
        makeMsg("u-1", "user", "Hello", SID),
        makeMsg("u-2", "assistant", "Hi", SID),
      ];

      // Force a sustained-bust regime (>= SUSTAINED_BUST_THRESHOLD = 2).
      recordCacheUsage(100_000, 0, 3, SID);
      recordCacheUsage(100_000, 0, 3, SID);
      recordCacheUsage(100_000, 0, 3, SID);
      expect((inspectSessionState(SID)?.consecutiveBusts ?? 0) >= 2).toBe(true);

      const result = transform({
        messages,
        projectPath: PROJECT,
        sessionID: SID,
      });

      // Small conversation: layer 0, tier 0 — genuinely sustainable.
      expect(result.layer).toBe(0);
      expect(getTier(result.totalTokens)).toBe(0);
      // The signal must NOT fire for a sub-cap conversation.
      expect(result.unsustainable).toBe(false);
    });
  });

  describe("free-write detection — zeroCacheWriteTurns tracking", () => {
    const SID = "free-write-detect-sess";

    beforeEach(() => {
      resetCalibration(SID);
    });

    test("tracks consecutive turns with zero cache writes", () => {
      // MiniMax-like: cacheWrite=0, cacheRead varies, inputTokens non-zero
      recordCacheUsage(0, 5_000, 50_000, SID);
      expect(inspectSessionState(SID)?.zeroCacheWriteTurns).toBe(1);

      recordCacheUsage(0, 8_000, 45_000, SID);
      expect(inspectSessionState(SID)?.zeroCacheWriteTurns).toBe(2);

      recordCacheUsage(0, 10_000, 40_000, SID);
      expect(inspectSessionState(SID)?.zeroCacheWriteTurns).toBe(3);
    });

    test("resets counter on non-zero cache write", () => {
      // Build up to threshold
      recordCacheUsage(0, 5_000, 50_000, SID);
      recordCacheUsage(0, 5_000, 50_000, SID);
      recordCacheUsage(0, 5_000, 50_000, SID);
      expect(inspectSessionState(SID)?.zeroCacheWriteTurns).toBe(3);

      // Non-zero cache write resets
      recordCacheUsage(1_000, 40_000, 5_000, SID);
      expect(inspectSessionState(SID)?.zeroCacheWriteTurns).toBe(0);
    });

    test("resets consecutiveBusts when crossing threshold", () => {
      // Accumulate busts under false pricing assumptions
      recordCacheUsage(100_000, 0, 3, SID);
      recordCacheUsage(100_000, 0, 3, SID);
      expect(inspectSessionState(SID)?.consecutiveBusts).toBe(2);

      // Now simulate MiniMax: 3 turns with zero cache writes
      // Turn 1: bustRatio=0 → resets consecutiveBusts to 0
      recordCacheUsage(0, 0, 50_000, SID);
      expect(inspectSessionState(SID)?.consecutiveBusts).toBe(0);
      expect(inspectSessionState(SID)?.zeroCacheWriteTurns).toBe(1);

      // Accumulate busts again
      recordCacheUsage(100_000, 0, 3, SID);
      expect(inspectSessionState(SID)?.consecutiveBusts).toBe(1);
      // zeroCacheWriteTurns resets because cacheWrite > 0
      expect(inspectSessionState(SID)?.zeroCacheWriteTurns).toBe(0);

      // Now 3 consecutive zero-write turns
      recordCacheUsage(0, 0, 50_000, SID);
      recordCacheUsage(0, 0, 50_000, SID);
      recordCacheUsage(0, 0, 50_000, SID);
      // Threshold crossed at turn 3 → busts reset to 0
      expect(inspectSessionState(SID)?.zeroCacheWriteTurns).toBe(3);
      expect(inspectSessionState(SID)?.consecutiveBusts).toBe(0);
    });

    test("zero-usage turn does not affect zeroCacheWriteTurns", () => {
      recordCacheUsage(0, 5_000, 50_000, SID);
      expect(inspectSessionState(SID)?.zeroCacheWriteTurns).toBe(1);

      // total=0 → entire block skipped
      recordCacheUsage(0, 0, 0, SID);
      expect(inspectSessionState(SID)?.zeroCacheWriteTurns).toBe(1);
    });
  });

  describe("isFreeWriteSession", () => {
    const SID = "free-write-session-check";

    beforeEach(() => {
      resetCalibration(SID);
    });

    test("returns false before threshold is reached", () => {
      expect(isFreeWriteSession(SID)).toBe(false);
      recordCacheUsage(0, 5_000, 50_000, SID);
      expect(isFreeWriteSession(SID)).toBe(false);
      recordCacheUsage(0, 5_000, 50_000, SID);
      expect(isFreeWriteSession(SID)).toBe(false);
    });

    test("returns true at threshold", () => {
      recordCacheUsage(0, 5_000, 50_000, SID);
      recordCacheUsage(0, 5_000, 50_000, SID);
      recordCacheUsage(0, 5_000, 50_000, SID);
      expect(isFreeWriteSession(SID)).toBe(true);
    });

    test("returns false after reset", () => {
      // Reach threshold
      recordCacheUsage(0, 5_000, 50_000, SID);
      recordCacheUsage(0, 5_000, 50_000, SID);
      recordCacheUsage(0, 5_000, 50_000, SID);
      expect(isFreeWriteSession(SID)).toBe(true);

      // Non-zero cache write resets
      recordCacheUsage(1_000, 40_000, 5_000, SID);
      expect(isFreeWriteSession(SID)).toBe(false);
    });

    test("returns false for unknown session (no phantom state)", () => {
      expect(isFreeWriteSession("nonexistent-session-id")).toBe(false);
    });
  });

  describe("shouldCompress — freeWrite option", () => {
    beforeEach(() => {
      // Opus 4.6 pricing where bust is expensive
      setCachePricing(6.25 / 1_000_000, 0.5 / 1_000_000);
    });

    test("returns true with freeWrite even when bust cost exceeds continue cost", () => {
      // Without freeWrite: bustCost ($0.9375) >> continueCost ($0.125) → false
      expect(shouldCompress(250_000, 150_000, 0)).toBe(false);
      // With freeWrite: compression is free → true
      expect(shouldCompress(250_000, 150_000, 0, { freeWrite: true })).toBe(
        true,
      );
    });

    test("returns false with freeWrite at/above the sustained-bust threshold", () => {
      // Even free compression shouldn't run if it's not helping (>= threshold=2)
      expect(shouldCompress(250_000, 150_000, 2, { freeWrite: true })).toBe(
        false,
      );
      expect(shouldCompress(250_000, 150_000, 10, { freeWrite: true })).toBe(
        false,
      );
    });

    test("returns true with freeWrite below the sustained-bust threshold", () => {
      // 1 bust < threshold (2) → free compression still runs
      expect(shouldCompress(250_000, 150_000, 1, { freeWrite: true })).toBe(
        true,
      );
    });

    test("backward compatible — no opts uses defaults", () => {
      // Same behavior as before: Opus pricing, large context
      expect(shouldCompress(2_000_000, 100_000, 0)).toBe(true);
      expect(shouldCompress(250_000, 150_000, 0)).toBe(false);
    });

    test("threshold option still works", () => {
      // With very low threshold, even economical compression is rejected
      expect(shouldCompress(2_000_000, 100_000, 0, { threshold: 0.01 })).toBe(
        false,
      );
    });
  });
});

// ─── free-write layer0 ceiling integration test ────────────────────────────

describe("gradient — free-write session compresses earlier than normal", () => {
  // Use totally unique session IDs to avoid any DB/state leaks
  const NORMAL_SID = `fw-normal-${Date.now()}`;
  const FREE_SID = `fw-free-${Date.now()}`;

  beforeEach(() => {
    resetCalibration(); // clear ALL sessions + calibratedOverhead
    setCachePricing(0, 0); // no pricing → shouldCompress returns false
    // 200k context, 32k output → maxInput = 168,000
    setModelLimits({ context: 200_000, output: 32_000 });
    ensureProject(PROJECT);
  });

  test("free-write session enters compression earlier due to reduced layer0Ceiling", () => {
    // maxInput = 168,000
    // HARD_CEILING_MARGIN = 0.95 → normal ceiling = 159,600
    // FREE_WRITE_LAYER0_FRACTION = 0.65 → free-write ceiling = 109,200
    //
    // Build a conversation at ~120k tokens (above 109k, below 159.6k).
    // Each message: 9,000 chars → ceil(9000/3)=3000 + 20 overhead = 3,020 tokens.
    // 40 messages × 3,020 = 120,800 + final msg ≈ 120,830 tokens.
    //
    // On FIRST turn (calibratedOverhead=null), UNCALIBRATED_SAFETY=1.5 applies:
    // layer0Input = (120,830 + FIRST_TURN_OVERHEAD=15,000) × 1.5 = ~203k → exceeds maxInput.
    // So we must not use uncalibrated mode. Instead, fake a prior calibrated turn.
    const bigText = "x".repeat(9_000);

    function buildMsgs(sid: string) {
      const msgs: ReturnType<typeof makeMsg>[] = [];
      for (let i = 0; i < 40; i++) {
        const role = i % 2 === 0 ? "user" : "assistant";
        msgs.push(
          makeMsg(`fw-${i}`, role as "user" | "assistant", bigText, sid),
        );
      }
      msgs.push(makeMsg("fw-final", "user", "do the fix", sid));
      return msgs;
    }

    // Set calibratedOverhead to 0 (module-level), then set per-session state.
    // calibrate(0) zeros overhead; calibrate(100, sid, 1) sets lastKnownInput=100
    // so the calibrated delta path kicks in for all messages.
    calibrate(0);
    calibrate(100, NORMAL_SID, 1);

    // Normal session: ~120k tokens (via delta path: lastKnownInput=100 + newMsgs*1.3)
    // delta = 120,830 * 1.3 ≈ 157k. Add lastKnownInput=100 → ~157k.
    // 157k < 159,600 ceiling → should be layer 0.
    const normalMsgs = buildMsgs(NORMAL_SID);
    const normalResult = transform({
      messages: normalMsgs,
      projectPath: PROJECT,
      sessionID: NORMAL_SID,
    });
    expect(normalResult.layer).toBe(0);

    // Set up free-write session: calibrate it, then add zero-cache-write turns
    calibrate(0);
    calibrate(100, FREE_SID, 1);
    recordCacheUsage(0, 0, 50_000, FREE_SID);
    recordCacheUsage(0, 0, 50_000, FREE_SID);
    recordCacheUsage(0, 0, 50_000, FREE_SID);
    expect(isFreeWriteSession(FREE_SID)).toBe(true);

    // Free-write session: ceiling drops to 109,200.
    // Same ~157k estimate → exceeds 109k → should compress.
    const fwMsgs = buildMsgs(FREE_SID);
    const fwResult = transform({
      messages: fwMsgs,
      projectPath: PROJECT,
      sessionID: FREE_SID,
    });
    expect(fwResult.layer).toBeGreaterThanOrEqual(1);
  });
});

// ─── selectDistillations — meta preservation guarantee (#417) ───────────────

describe("selectDistillations", () => {
  /** Create a distillation stub with the fields selectDistillations uses. */
  function dist(
    id: string,
    generation: number,
    createdAt: number,
    observations = "",
  ): {
    id: string;
    observations: string;
    generation: number;
    token_count: number;
    created_at: number;
    session_id: string;
    r_compression: number | null;
    c_norm: number | null;
    source_ids: string[];
  } {
    return {
      id,
      observations,
      generation,
      token_count: 100,
      created_at: createdAt,
      session_id: "sel-sess",
      r_compression: null,
      c_norm: null,
      source_ids: [],
    };
  }

  test("returns all when count <= limit", () => {
    const all = [dist("a", 0, 1), dist("b", 0, 2), dist("c", 0, 3)];
    expect(selectDistillations(all, 5)).toEqual(all);
    expect(selectDistillations(all, 3)).toEqual(all);
  });

  test("always includes meta (gen>=1) even when it has lowest recency", () => {
    // 1 meta (oldest) + 5 gen-0 (newer) → limit=5 should keep the meta + 4 gen-0
    const meta = dist("meta", 1, 100, "decided to use flock");
    const gen0 = Array.from({ length: 5 }, (_, i) =>
      dist(`g0-${i}`, 0, 200 + i * 10),
    );
    const all = [meta, ...gen0]; // chronological order

    const selected = selectDistillations(all, 5);
    expect(selected).toHaveLength(5);
    // Meta must be present.
    expect(selected.some((d) => d.id === "meta")).toBe(true);
    // The oldest gen-0 should be dropped (lowest recency among gen-0).
    expect(selected.some((d) => d.id === "g0-0")).toBe(false);
    // Result should be chronologically sorted.
    for (let i = 1; i < selected.length; i++) {
      expect(selected[i]?.created_at).toBeGreaterThanOrEqual(
        selected[i - 1]?.created_at,
      );
    }
  });

  test("preserves multiple meta entries when they exist", () => {
    const meta1 = dist("meta1", 1, 100);
    const meta2 = dist("meta2", 2, 150);
    const gen0 = Array.from({ length: 5 }, (_, i) =>
      dist(`g0-${i}`, 0, 200 + i * 10),
    );
    const all = [meta1, meta2, ...gen0];

    const selected = selectDistillations(all, 5);
    expect(selected).toHaveLength(5);
    expect(selected.some((d) => d.id === "meta1")).toBe(true);
    expect(selected.some((d) => d.id === "meta2")).toBe(true);
    // 3 gen-0 slots remaining, filled by most recent.
    expect(selected.some((d) => d.id === "g0-4")).toBe(true);
    expect(selected.some((d) => d.id === "g0-3")).toBe(true);
    expect(selected.some((d) => d.id === "g0-2")).toBe(true);
  });

  test("selects by recency when all entries are gen-0 (no meta)", () => {
    const all = Array.from({ length: 8 }, (_, i) =>
      dist(`g0-${i}`, 0, 100 + i * 10),
    );
    const selected = selectDistillations(all, 3);
    expect(selected).toHaveLength(3);
    // Most recent 3 gen-0 should win.
    expect(selected.map((d) => d.id)).toEqual(["g0-5", "g0-6", "g0-7"]);
  });

  test("emergency limit=2 keeps meta + most recent gen-0", () => {
    const meta = dist("meta", 1, 100, "architecture decision");
    const gen0 = Array.from({ length: 5 }, (_, i) =>
      dist(`g0-${i}`, 0, 200 + i * 10),
    );
    const all = [meta, ...gen0];

    const selected = selectDistillations(all, 2);
    expect(selected).toHaveLength(2);
    expect(selected[0]?.id).toBe("meta");
    expect(selected[1]?.id).toBe("g0-4"); // most recent gen-0
  });
});

// ---------------------------------------------------------------------------
// #424: prefix/raw boundary role alternation (tool_use/tool_result mismatch)
// ---------------------------------------------------------------------------

describe("gradient — prefix/raw boundary role alternation (#424)", () => {
  const SESSION_424 = "sess-424";
  const PID_424 = "/test/gradient/project-424";
  let projectId424: string;

  // Helper: make an assistant message with a completed tool part.
  function makeToolAssistant(
    id: string,
    toolName: string,
    callID: string,
    output: string,
  ): LoreMessageWithParts {
    const info: LoreMessage = {
      id,
      sessionID: SESSION_424,
      role: "assistant",
      time: { created: Date.now() },
      parentID: `parent-${id}`,
      modelID: "claude-sonnet-4-20250514",
      providerID: "anthropic",
      mode: "build",
      path: { cwd: "/test", root: "/test" },
      cost: 0,
      tokens: {
        input: 100,
        output: 50,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    };
    return {
      info,
      parts: [
        {
          id: `tool-${id}`,
          sessionID: SESSION_424,
          messageID: id,
          type: "tool",
          callID,
          tool: toolName,
          state: {
            status: "completed",
            input: { path: "test.ts" },
            output,
            time: { start: Date.now(), end: Date.now() },
          },
        } as unknown as LorePart,
      ],
    };
  }

  beforeAll(() => {
    projectId424 = ensureProject(PID_424);
  });

  beforeEach(() => {
    resetCalibration(SESSION_424);
    resetPrefixCache(SESSION_424);
    resetRawWindowCache(SESSION_424);
    resetDistillationSnapshot(SESSION_424);
    setModelLimits({ context: 10_000, output: 2_000 });
    calibrate(0);
    db()
      .query("DELETE FROM distillations WHERE project_id = ?")
      .run(projectId424);
  });

  afterAll(() => {
    setModelLimits({ context: 10_000, output: 2_000 });
    calibrate(0);
    db()
      .query("DELETE FROM distillations WHERE project_id = ?")
      .run(projectId424);
  });

  test("raw window after cutoff does not start with assistant when prefix is present", () => {
    // Build a conversation that triggers gradient compression (layers 1+).
    // The message array is designed so the budget cutoff naturally falls
    // before an assistant message with tool parts.
    //
    // Structure: [u1, a1(tool), u2, a2(tool), u3, a3(tool), ..., uN(current)]
    // When the budget-based cutoff evicts early messages, the raw window
    // could start with an assistant. With the prefix (ending in assistant),
    // this would create back-to-back assistants → tool_use without tool_result.

    // Store a distillation so gradient mode uses a prefix
    db()
      .query(
        `INSERT INTO distillations (id, project_id, session_id, narrative, facts, observations, source_ids, generation, token_count, archived, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "dist-424",
        projectId424,
        SESSION_424,
        "",
        "[]",
        "x".repeat(500), // small distillation
        "[]",
        0,
        170, // ~500 chars / 3
        0,
        Date.now(),
      );

    // Build enough messages to overflow the 10K context window.
    // Each tool output is ~1500 chars = ~500 tokens. With 15 tool turns
    // (30 messages), we get ~7500 tokens of tool content + overhead.
    const messages: LoreMessageWithParts[] = [];
    for (let i = 0; i < 15; i++) {
      messages.push(makeMsg(`u${i}`, "user", `Do step ${i}`, SESSION_424));
      messages.push(
        makeToolAssistant(`a${i}`, "read", `call-${i}`, "x".repeat(1500)),
      );
    }
    // Final user message (current turn)
    messages.push(
      makeMsg("u-final", "user", "Now do the final step", SESSION_424),
    );

    const result = transform({
      messages,
      projectPath: PID_424,
      sessionID: SESSION_424,
    });

    // The result must be at layer >= 1 (gradient mode with prefix)
    expect(result.layer).toBeGreaterThanOrEqual(1);

    // Core assertion: no two consecutive messages should have the same role.
    // This catches the back-to-back assistant bug that causes
    // "tool_use ids found without tool_result" (#424).
    for (let i = 1; i < result.messages.length; i++) {
      const prev = result.messages[i - 1];
      const curr = result.messages[i];
      expect(curr.info.role).not.toBe(prev.info.role);
    }

    // Additional: if the first message after the prefix is in the result,
    // and a prefix exists (layer >= 1), then the 3rd message (idx 2, after
    // [user_distilled, assistant_distilled]) must be user role.
    if (result.messages.length > 2) {
      const firstRaw = result.messages[2]; // after [user, assistant] prefix
      expect(firstRaw.info.role).toBe("user");
    }
  });
});

describe("gradient — calibrated delta safety multiplier", () => {
  const SESSION = "delta-safety-sess";
  beforeAll(() => {
    setModelLimits({ context: 10_000, output: 2_000 });
    calibrate(0);
    resetPrefixCache();
    resetRawWindowCache();
  });

  beforeEach(() => {
    resetCalibration(SESSION);
    calibrate(0);
    resetPrefixCache();
    resetRawWindowCache();
    resetDistillationSnapshot(SESSION);
  });

  test("calibrated delta applies 1.3x safety to new messages", () => {
    // maxInput = 8000, hard ceiling = 8000 * 0.95 = 7600
    // Isolate the multiplier: find base + rawEstimate <= 7600 but base + ceil(rawEstimate * 1.3) > 7600
    //
    // New message: 150 chars → estimateMessage = ceil(150/3) + 20 = 70 (rawEstimate)
    // With 1.3x: ceil(70 * 1.3) = 91
    // Need: base + 91 > 7600 AND base + 70 <= 7600
    //       base > 7509 AND base <= 7530
    // Use base = 7520
    calibrate(7_520, SESSION, 10);
    const messages = Array.from({ length: 10 }, (_, i) =>
      makeMsg(
        `ds-${i}`,
        i % 2 === 0 ? "user" : "assistant",
        "X".repeat(50),
        SESSION,
      ),
    );
    const withNew = [
      ...messages,
      makeMsg("ds-new", "user", "Z".repeat(150), SESSION),
    ];
    // Without 1.3x multiplier: 7520 + 70 = 7590 ≤ 7600 → would be layer 0
    // With 1.3x multiplier:    7520 + 91 = 7611 > 7600 → must escalate
    const result = transform({
      messages: withNew,
      projectPath: PROJECT,
      sessionID: SESSION,
    });
    expect(result.layer).toBeGreaterThanOrEqual(1);
  });

  test("hard ceiling rejects layer-0 passthrough near maxInput", () => {
    // maxInput = 8000, hard ceiling = 8000 * 0.95 = 7600
    // Set lastKnownInput = 7650 — above the hard ceiling
    calibrate(7_650, SESSION, 10);
    const messages = Array.from({ length: 10 }, (_, i) =>
      makeMsg(
        `hc-${i}`,
        i % 2 === 0 ? "user" : "assistant",
        "X".repeat(50),
        SESSION,
      ),
    );
    // Even with a tiny new message, expectedInput ≈ 7650 + 33 = 7683 > 7600 → must escalate
    const withNew = [...messages, makeMsg("hc-new", "user", "hi", SESSION)];
    const result = transform({
      messages: withNew,
      projectPath: PROJECT,
      sessionID: SESSION,
    });
    expect(result.layer).toBeGreaterThanOrEqual(1);
  });

  test("hard ceiling also blocks bust-vs-continue gate", () => {
    // Verify the tier gate (shouldCompress path) also respects the hard ceiling.
    // We need layer0Input > layer0Ceiling but <= maxInput * HARD_CEILING_MARGIN
    // to be false, i.e. layer0Input > maxInput * 0.95.
    // With no cost cap (layer0Ceiling = maxInput * 0.95 = 7600), the tier gate
    // fires when layer0Input > 7600. Set lastKnownInput = 7700 (above ceiling).
    setCachePricing(0, 0); // no pricing → shouldCompress returns false
    calibrate(7_700, SESSION, 10);
    const messages = Array.from({ length: 10 }, (_, i) =>
      makeMsg(
        `bg-${i}`,
        i % 2 === 0 ? "user" : "assistant",
        "X".repeat(50),
        SESSION,
      ),
    );
    const withNew = [...messages, makeMsg("bg-new", "user", "hi", SESSION)];
    const result = transform({
      messages: withNew,
      projectPath: PROJECT,
      sessionID: SESSION,
    });
    // Without hard ceiling margin, the tier gate would pass through at layer 0
    // because shouldCompress returns false (no pricing). With the margin,
    // 7700 > 7600 so the tier gate condition fails → compression is forced.
    expect(result.layer).toBeGreaterThanOrEqual(1);
  });
});

describe("gradient — error-state tool outputs are estimated (not flat 20)", () => {
  // Regression guard: error tool_result parts are now stored as error-state
  // (status:"error", carrying `error` text). estimateParts must size them by
  // their error payload — not the flat 20-token fallback — or the gradient's
  // token calibration silently undercounts failure-heavy turns and overflows.
  test("a large error output is estimated by its size", () => {
    const SID = "err-estimate-sess";
    const bigError = "STACK TRACE\n".repeat(2000); // ~24K chars
    const errorMsg: LoreMessageWithParts = {
      info: {
        id: "err-a1",
        sessionID: SID,
        role: "assistant",
        time: { created: Date.now() },
        parentID: "p",
        modelID: "claude-sonnet-4-20250514",
        providerID: "anthropic",
        mode: "build",
        path: { cwd: "/test", root: "/test" },
        cost: 0,
        tokens: {
          input: 100,
          output: 50,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
      },
      parts: [
        {
          id: "err-t1",
          sessionID: SID,
          messageID: "err-a1",
          type: "tool",
          callID: "call-err",
          tool: "bash",
          state: {
            status: "error",
            input: { command: "x" },
            error: bigError,
            time: { start: Date.now(), end: Date.now() },
          },
        } as unknown as LorePart,
      ],
    };
    const estimate = estimateMessages([errorMsg]);
    // ~24K chars / 3 ≈ 8000 tokens — must be far above the flat-20 fallback.
    expect(estimate).toBeGreaterThan(1000);
  });
});

// ---------------------------------------------------------------------------
// Atomic tool_use/tool_result pair — eviction must not split the pair
// ---------------------------------------------------------------------------
//
// Regression: the role-alternation guard at tryFit() handled the case where
// the prefix/raw boundary landed on an assistant (back-to-back assistants).
// The symmetric case — boundary landing on a user with a `tool: "result"`
// residual whose issuing assistant was evicted — was unhandled and produced
// an orphan tool_result that the wire format rejects. Fix moves cutoff
// backward to keep the assistant.

describe("gradient — atomic tool_use/tool_result pair (no orphan on eviction)", () => {
  const SID = "sess-orphan-pair";
  const PID = "/test/gradient/project-orphan";
  let projectId: string;

  // Helper: assistant message with a completed tool part (tool_use).
  function makeToolAssistant(
    id: string,
    toolName: string,
    callID: string,
    output: string,
    sessionID = SID,
  ): LoreMessageWithParts {
    const base = makeMsg(id, "assistant", "", sessionID);
    return {
      info: base.info,
      parts: [
        {
          id: `tool-${id}`,
          sessionID,
          messageID: id,
          type: "tool",
          tool: toolName,
          callID,
          state: {
            status: "completed",
            input: { path: "test.ts" },
            output,
            title: toolName,
            metadata: {},
            time: { start: Date.now(), end: Date.now() },
          },
          time: { start: Date.now(), end: Date.now() },
        } as LorePart,
      ],
    };
  }

  // Helper: user message with a residual `tool: "result"` part (the kind that
  // `resolveToolResults` was supposed to strip but didn't, in practice).
  function makeToolResultUser(
    id: string,
    callID: string,
    output: string,
    sessionID = SID,
  ): LoreMessageWithParts {
    const base = makeMsg(id, "user", "", sessionID);
    return {
      info: base.info,
      parts: [
        {
          id: `tool-${id}`,
          sessionID,
          messageID: id,
          type: "tool",
          tool: "result",
          callID,
          state: {
            status: "completed",
            input: {},
            output,
            title: "result",
            metadata: {},
            time: { start: Date.now(), end: Date.now() },
          },
          time: { start: Date.now(), end: Date.now() },
        } as LorePart,
      ],
    };
  }

  beforeAll(() => {
    projectId = ensureProject(PID);
  });

  beforeEach(() => {
    resetCalibration(SID);
    resetPrefixCache(SID);
    resetRawWindowCache(SID);
    resetDistillationSnapshot(SID);
    setModelLimits({ context: 10_000, output: 2_000 });
    calibrate(0);
    db().query("DELETE FROM distillations WHERE project_id = ?").run(projectId);
  });

  test("raw window after eviction has no orphan tool_result user message", () => {
    // Seed a distillation so the gradient runs in prefix mode (layer >= 1).
    db()
      .query(
        `INSERT INTO distillations (id, project_id, session_id, narrative, facts, observations, source_ids, generation, token_count, archived, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "dist-orphan-pair",
        projectId,
        SID,
        "",
        "[]",
        "x".repeat(500),
        "[]",
        0,
        170,
        0,
        Date.now(),
      );

    // Conversation pattern with the tool_use/tool_result pair split across
    // the assistant→user boundary. Two turns of (a-X, u-r-X) pairs.
    //
    //   [u-0, a-0(tool_use_0), u-r-0(tool_result_0), u-1, a-1(tool_use_1), u-r-1(tool_result_1), u-final]
    //
    // Context/output are sized so the layer-1 raw budget (~700 tokens) is
    // just large enough to keep u-r-1 alone but not a-1+u-r-1 together.
    // The backward scan sets cutoff = 5, leaving u-r-1 at the boundary
    // with a-1 evicted. The symmetric orphan guard must move cutoff
    // backward to keep a-1 — otherwise u-r-1 is an orphan tool_result.
    setModelLimits({ context: 4_300, output: 2_000 });
    const messages: LoreMessageWithParts[] = [
      makeMsg("u-0", "user", "preamble", SID),
      makeToolAssistant("a-0", "read", "call-0", "x".repeat(1500), SID),
      makeToolResultUser("u-r-0", "call-0", "x".repeat(1500), SID),
      makeMsg("u-1", "user", "step 1 done", SID),
      makeToolAssistant("a-1", "read", "call-1", "x".repeat(1500), SID),
      makeToolResultUser("u-r-1", "call-1", "x".repeat(1500), SID),
      makeMsg("u-final", "user", "final turn", SID),
    ];

    const result = transform({
      messages,
      projectPath: PID,
      sessionID: SID,
    });

    // Gradient must be active (the conversation overflows the 3.5K context).
    expect(result.layer).toBeGreaterThanOrEqual(1);

    // Collect callIDs that appear in assistant messages in the result.
    const assistantCallIDs = new Set<string>();
    for (const m of result.messages) {
      if (m.info.role !== "assistant") continue;
      for (const part of m.parts) {
        if (isToolPart(part) && part.callID) {
          assistantCallIDs.add(part.callID);
        }
      }
    }

    // Core assertion: every user tool_result in the result must reference
    // an assistant tool_use with the same callID. A user `tool: "result"`
    // part without a matching assistant tool_use is an orphan that the
    // wire format rejects.
    for (const m of result.messages) {
      if (m.info.role !== "user") continue;
      for (const part of m.parts) {
        if (isToolPart(part) && part.callID) {
          expect(assistantCallIDs.has(part.callID)).toBe(true);
        }
      }
    }
  });
});

describe("gradient — per-session model budget (RC2: cross-model contamination)", () => {
  const SID_A = "budget-sess-anthropic";
  const SID_B = "budget-sess-free";
  const PROJECT_B = "/test/gradient/budget";

  beforeEach(() => {
    resetCalibration(SID_A);
    resetCalibration(SID_B);
    resetPrefixCache(SID_A);
    resetPrefixCache(SID_B);
    resetRawWindowCache(SID_A);
    resetRawWindowCache(SID_B);
    resetDistillationSnapshot(SID_A);
    resetDistillationSnapshot(SID_B);
  });

  // Anthropic-like budget: 200K context, real cache pricing.
  const anthropicBudget: ModelBudget = {
    contextLimit: 200_000,
    outputReserved: 32_000,
    maxLayer0Tokens: 200_000,
    cacheWriteCostPerToken: 0.00000375,
    cacheReadCostPerToken: 0.0000003,
  };
  // Free-zen-like budget: huge context, near-zero cache pricing → huge l0cap.
  const freeBudget: ModelBudget = {
    contextLimit: 1_000_000,
    outputReserved: 32_000,
    maxLayer0Tokens: 3_571_428,
    cacheWriteCostPerToken: 0.000000028,
    cacheReadCostPerToken: 0.000000028,
  };

  function smallMessages(sid: string) {
    return [
      makeMsg("bm-u1", "user", "hello", sid),
      makeMsg("bm-a1", "assistant", "hi there", sid),
    ];
  }

  test("budget passed to transform wins over clobbered globals", () => {
    // Simulate a concurrent request for the FREE model clobbering the globals
    // (this is what happens during the intervening ltm awaits in the host).
    setModelLimits({
      context: freeBudget.contextLimit,
      output: freeBudget.outputReserved,
    });
    setMaxLayer0Tokens(freeBudget.maxLayer0Tokens);
    setCachePricing(
      freeBudget.cacheWriteCostPerToken,
      freeBudget.cacheReadCostPerToken,
    );

    // Now run a transform for the ANTHROPIC session, passing its own budget.
    // The result must reflect the 200K context (usable ≈ 200K − reserved − …),
    // NOT the free model's 1M context the globals were left holding.
    const result = transform({
      messages: smallMessages(SID_A),
      projectPath: PROJECT_B,
      sessionID: SID_A,
      budget: anthropicBudget,
    });

    // usable = contextLimit − outputReserved − overhead − ltm. With a 200K
    // context it must be far below the 1M-context value the clobbered globals
    // would have produced.
    expect(result.usable).toBeLessThan(200_000);
    expect(result.usable).toBeGreaterThan(100_000);

    // And the pricing the transform used is the anthropic one (applied atomically).
    expect(getCachePricing().read).toBeCloseTo(
      anthropicBudget.cacheReadCostPerToken,
      12,
    );
  });

  test("interleaved transforms keep each session's own budget", () => {
    const a = transform({
      messages: smallMessages(SID_A),
      projectPath: PROJECT_B,
      sessionID: SID_A,
      budget: anthropicBudget,
    });
    const b = transform({
      messages: smallMessages(SID_B),
      projectPath: PROJECT_B,
      sessionID: SID_B,
      budget: freeBudget,
    });

    // The free session sees a far larger usable budget than the anthropic one.
    expect(b.usable).toBeGreaterThan(a.usable);
    // Re-running A after B must still yield A's (smaller) budget, not B's.
    const a2 = transform({
      messages: smallMessages(SID_A),
      projectPath: PROJECT_B,
      sessionID: SID_A,
      budget: anthropicBudget,
    });
    expect(a2.usable).toBe(a.usable);
  });

  test("a model with no cache pricing resolves to 0/0 (no stale inheritance)", () => {
    // Prime globals with real pricing from a previous (anthropic) request.
    setCachePricing(
      anthropicBudget.cacheWriteCostPerToken,
      anthropicBudget.cacheReadCostPerToken,
    );

    // A model with no pricing data must NOT inherit the previous price.
    const noPriceBudget: ModelBudget = {
      contextLimit: 128_000,
      outputReserved: 32_000,
      maxLayer0Tokens: 0, // disabled — never inherit another model's cap
      cacheWriteCostPerToken: 0,
      cacheReadCostPerToken: 0,
    };
    transform({
      messages: smallMessages(SID_B),
      projectPath: PROJECT_B,
      sessionID: SID_B,
      budget: noPriceBudget,
    });
    expect(getCachePricing()).toEqual({ write: 0, read: 0 });
  });
});

// ===========================================================================
// Issue #796: restart-proof calibration + cold-start large-session handling
// ===========================================================================

describe("issue #796: lastKnownMessageCount persistence", () => {
  test("persists to DB via saveGradientState and restores after eviction", () => {
    const sid = `lkmc-${crypto.randomUUID()}`;
    resetCalibration(sid);
    setModelLimits({ context: 10_000, output: 2_000 });
    // calibrate() records lastKnownInput + lastKnownMessageCount in memory.
    calibrate(50_000, sid, 250);
    // lastTurnAt > 0 is the proxy that gates the atomic restore in getSessionState.
    setLastTurnAtForTest(sid, Date.now());
    saveGradientState(sid);

    // Simulate restart: drop the in-memory state.
    evictSession(sid);
    expect(inspectSessionState(sid)).toBeNull();

    // Any getSessionState-driven call restores from DB; setLtmTokens is benign.
    setLtmTokens(0, sid);
    expect(inspectSessionState(sid)?.lastKnownMessageCount).toBe(250);

    // Reset shared baseline.
    setModelLimits({ context: 10_000, output: 2_000 });
    calibrate(0);
  });
});

describe("issue #796: isLargeColdStart + cold-start force-compress", () => {
  // Build N messages with enough text to exceed a low Layer-0 ceiling.
  function bulk(sessionID: string, n: number, pad: string) {
    return Array.from({ length: n }, (_, i) =>
      makeMsg(
        `${sessionID}-${i}`,
        i % 2 === 0 ? "user" : "assistant",
        `Message ${i}: ${pad}`,
        sessionID,
      ),
    );
  }

  function configureLowCeiling() {
    // maxInput = 5000, usable = 5000, rawBudget = 2000.
    setModelLimits({ context: 6_000, output: 1_000 });
    calibrate(0); // zero overhead
    setMaxLayer0Tokens(500); // ceiling base 500, uncalibrated ×0.7 = 350
    setCachePricing(0, 0); // no pricing → shouldCompress() = false (tier gate keeps Layer 0)
  }

  function resetBaseline() {
    setModelLimits({ context: 10_000, output: 2_000 });
    setMaxLayer0Tokens(0);
    calibrate(0);
  }

  test("isLargeColdStart is true for a large uncalibrated session", () => {
    configureLowCeiling();
    const sid = `cold-large-${crypto.randomUUID()}`;
    const messages = bulk(sid, 30, "padding text to take up token space here");
    // Precondition: clearly over the ~350 ceiling after the ×1.5 uncalibrated factor.
    expect(estimateMessages(messages)).toBeGreaterThan(500);
    expect(isLargeColdStart({ messages, sessionID: sid })).toBe(true);
    resetBaseline();
  });

  test("isLargeColdStart is false for a small uncalibrated session", () => {
    configureLowCeiling();
    const sid = `cold-small-${crypto.randomUUID()}`;
    const messages = [
      makeMsg(`${sid}-1`, "user", "hi", sid),
      makeMsg(`${sid}-2`, "assistant", "hello", sid),
    ];
    expect(isLargeColdStart({ messages, sessionID: sid })).toBe(false);
    resetBaseline();
  });

  test("isLargeColdStart is false once the session is calibrated, even when large", () => {
    configureLowCeiling();
    const sid = `cold-calibrated-${crypto.randomUUID()}`;
    const messages = bulk(sid, 30, "padding text to take up token space here");
    // Calibrate the session (lastKnownInput > 0) — no longer a cold start.
    calibrate(50_000, sid, 30);
    expect(isLargeColdStart({ messages, sessionID: sid })).toBe(false);
    resetBaseline();
  });

  test("isLargeColdStart honors the ltmTokens hint (Part A/B alignment)", () => {
    // A small session that is NOT a cold start on its own becomes one once the
    // about-to-be-injected LTM tokens push it over the ceiling. The pipeline
    // passes the stable-LTM token count as this hint so the turn-1 LTM decision
    // matches what the gradient transform will see. (#796)
    configureLowCeiling();
    const sid = `cold-ltm-hint-${crypto.randomUUID()}`;
    const messages = [
      makeMsg(`${sid}-1`, "user", "hi", sid),
      makeMsg(`${sid}-2`, "assistant", "hello", sid),
    ];
    // Without the hint: tiny → not a cold start.
    expect(isLargeColdStart({ messages, sessionID: sid })).toBe(false);
    // With a large LTM hint: now over the ceiling → cold start. If the param
    // were ignored, this would still be false.
    expect(
      isLargeColdStart({ messages, sessionID: sid, ltmTokens: 1000 }),
    ).toBe(true);
    resetBaseline();
  });

  test("transform forces layer >= 1 for a large uncalibrated session (would be Layer 0 without the fix)", () => {
    configureLowCeiling();
    const sid = `cold-force-${crypto.randomUUID()}`;
    const messages = bulk(sid, 30, "padding text to take up token space here");
    // Sanity: the tier gate would otherwise pass this through at Layer 0 (no
    // pricing → shouldCompress() = false). The cold-start force-compress flips it.
    const result = transform({
      messages,
      projectPath: PROJECT,
      sessionID: sid,
    });
    expect(result.layer).toBeGreaterThanOrEqual(1);
    resetBaseline();
  });

  test("transform stays at Layer 0 for a small uncalibrated session (no over-fire)", () => {
    configureLowCeiling();
    const sid = `cold-small-pass-${crypto.randomUUID()}`;
    const messages = [
      makeMsg(`${sid}-1`, "user", "hi", sid),
      makeMsg(`${sid}-2`, "assistant", "hello", sid),
    ];
    const result = transform({
      messages,
      projectPath: PROJECT,
      sessionID: sid,
    });
    expect(result.layer).toBe(0);
    resetBaseline();
  });

  // Scope: this validates gradient-level agreement at EQUAL ltm tokens (neither
  // call injects LTM between them). The pipeline closes the remaining
  // decision-vs-compression band by passing setLtmTokens's stable count as the
  // isLargeColdStart `ltmTokens` hint — exercised by the "honors the ltmTokens
  // hint" test above. (#796)
  test("isLargeColdStart agrees with transform's layer decision (drift guard)", () => {
    configureLowCeiling();
    for (const [n, pad] of [
      [30, "padding text to take up token space here"],
      [2, ""],
    ] as const) {
      const sid = `cold-agree-${n}-${crypto.randomUUID()}`;
      const messages =
        n === 2
          ? [
              makeMsg(`${sid}-1`, "user", "hi", sid),
              makeMsg(`${sid}-2`, "assistant", "ok", sid),
            ]
          : bulk(sid, n, pad);
      const predicted = isLargeColdStart({ messages, sessionID: sid });
      const result = transform({
        messages,
        projectPath: PROJECT,
        sessionID: sid,
      });
      expect(predicted).toBe(result.layer >= 1);
    }
    resetBaseline();
  });
});
