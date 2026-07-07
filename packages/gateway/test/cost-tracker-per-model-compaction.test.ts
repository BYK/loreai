import { beforeEach, describe, expect, test } from "vitest";
import { AUTOCOMPACT_THRESHOLD } from "../src/compaction";
import {
  autocompactThresholdForModelID,
  clearAllCosts,
  estimateAvoidedCompactions,
  getSessionCosts,
  recordConversationCost,
  resetDailyBudgetState,
  updateShadowContext,
} from "../src/cost-tracker";

const WORKER = "__test_worker_model__";
const PRICING_MODEL = "__test_fake_model__";
const USAGE = {
  input_tokens: 1,
  output_tokens: 1,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};
const POST_COMPACTION_CONTEXT = 30_000;

beforeEach(() => {
  clearAllCosts();
  resetDailyBudgetState();
});

describe("estimateAvoidedCompactions (#983)", () => {
  test("counts one compaction at the threshold, then one per stride", () => {
    // 200K host: threshold 167K, stride 167K − 30K = 137K.
    expect(
      estimateAvoidedCompactions(167_000, 167_000, POST_COMPACTION_CONTEXT),
    ).toBe(0);
    expect(
      estimateAvoidedCompactions(167_001, 167_000, POST_COMPACTION_CONTEXT),
    ).toBe(1);
    // 600K → 1 + floor((600K−167K)/137K) = 1 + 3 = 4.
    expect(
      estimateAvoidedCompactions(600_000, 167_000, POST_COMPACTION_CONTEXT),
    ).toBe(4);
  });

  test("a 1M host at 600K tokens has not compacted yet", () => {
    expect(
      estimateAvoidedCompactions(600_000, 967_000, POST_COMPACTION_CONTEXT),
    ).toBe(0);
  });

  test("windows too small to compact are guarded to 0 (no runaway)", () => {
    // threshold ≤ post-compaction size ⇒ non-positive stride ⇒ 0, even for a
    // huge token count. Without the guard the old formula would emit an absurd
    // count here.
    expect(
      estimateAvoidedCompactions(5_000_000, 30_000, POST_COMPACTION_CONTEXT),
    ).toBe(0);
    expect(
      estimateAvoidedCompactions(5_000_000, 7_000, POST_COMPACTION_CONTEXT),
    ).toBe(0);
  });
});

describe("autocompactThresholdForModelID (#983, #1214)", () => {
  test("empty / missing model falls back to the historical 200K value", () => {
    expect(autocompactThresholdForModelID(undefined)).toBe(
      AUTOCOMPACT_THRESHOLD,
    );
    expect(autocompactThresholdForModelID("")).toBe(AUTOCOMPACT_THRESHOLD);
    expect(AUTOCOMPACT_THRESHOLD).toBe(167_000);
  });

  test("a 1M-context model WITH the context-1m beta uses its real 967K trigger", () => {
    // claude-opus-4* fallback: context 1M, output 128K (capped at 20K reserve).
    // longContext=true ⇒ client meters against the real 1M window.
    expect(autocompactThresholdForModelID("claude-opus-4-6", true)).toBe(
      967_000,
    );
  });

  test("a 1M-context model WITHOUT the beta is clamped to the 200K trigger (#1214)", () => {
    // The MiniMax-M3-via-Claude-Code case: the client meters a 1M-capable model
    // it doesn't recognise against 200K, so it compacts at ~167K, not ~967K.
    expect(autocompactThresholdForModelID("claude-opus-4-6")).toBe(167_000);
    expect(autocompactThresholdForModelID("claude-opus-4-6", false)).toBe(
      167_000,
    );
  });

  test("an unknown named model uses the 200K/8K fallback limits (clamp is a no-op)", () => {
    // fallback entry: context 200K, output 8_192 → 200K − 8_192 − 13K.
    // Already a 200K window, so the client-metered clamp changes nothing.
    expect(autocompactThresholdForModelID("totally-unknown-xyz")).toBe(178_808);
    expect(autocompactThresholdForModelID("totally-unknown-xyz", true)).toBe(
      178_808,
    );
  });
});

describe("updateShadowContext uses the client-metered threshold (#983, #1214)", () => {
  // Drive a session to ~600K uncompressed shadow tokens over two turns, then
  // read the counterfactual compaction count. 600K sits between the 200K-model
  // trigger (167K) and the 1M-model trigger (967K), so the client-metered window
  // flips the outcome — proving the threshold tracks the window the client
  // actually meters, not just the model's real window.
  function driveTo600K(
    sessionID: string,
    conversationModel?: string,
    longContext = false,
  ): void {
    recordConversationCost(sessionID, PRICING_MODEL, USAGE); // turns → 1
    updateShadowContext(
      sessionID,
      100_000,
      500_000,
      WORKER,
      conversationModel,
      undefined,
      longContext,
    );
    recordConversationCost(sessionID, PRICING_MODEL, USAGE); // turns → 2
    updateShadowContext(
      sessionID,
      120_000,
      10_000,
      WORKER,
      conversationModel,
      undefined,
      longContext,
    );
  }

  test("a 200K-class (default) model counts a shadow compaction at 600K", () => {
    driveTo600K("s-default", undefined);
    expect(
      getSessionCosts("s-default")?.counterfactual.avoidedCompactions,
    ).toBe(1);
  });

  test("a 1M-context model in long-context mode (beta) has NOT compacted at 600K", () => {
    driveTo600K("s-opus", "claude-opus-4-6", true);
    // With the context-1m beta the client meters against the real 1M window
    // (967K trigger), so 600K has not compacted. The old hardcoded 167K constant
    // would have wrongly counted 1 here.
    expect(getSessionCosts("s-opus")?.counterfactual.avoidedCompactions).toBe(
      0,
    );
  });

  test("a 1M-context model metered against 200K (no beta) DOES compact at 600K (#1214)", () => {
    // MiniMax-M3-via-Claude-Code: the 1M model is metered against 200K, so it
    // compacts at ~167K and 600K counts a shadow compaction. This is the case
    // #983's real-window assumption silently under-counted to 0.
    driveTo600K("s-minimax", "claude-opus-4-6", false);
    expect(
      getSessionCosts("s-minimax")?.counterfactual.avoidedCompactions,
    ).toBe(1);
  });
});
