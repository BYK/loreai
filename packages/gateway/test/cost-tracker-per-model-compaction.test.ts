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

describe("autocompactThresholdForModelID (#983)", () => {
  test("empty / missing model falls back to the historical 200K value", () => {
    expect(autocompactThresholdForModelID(undefined)).toBe(
      AUTOCOMPACT_THRESHOLD,
    );
    expect(autocompactThresholdForModelID("")).toBe(AUTOCOMPACT_THRESHOLD);
    expect(AUTOCOMPACT_THRESHOLD).toBe(167_000);
  });

  test("a 1M-context model resolves to its own (much higher) trigger point", () => {
    // claude-opus-4* fallback: context 1M, output 128K (capped at 20K reserve).
    expect(autocompactThresholdForModelID("claude-opus-4-6")).toBe(967_000);
  });

  test("an unknown named model uses the 200K/8K fallback limits", () => {
    // fallback entry: context 200K, output 8_192 → 200K − 8_192 − 13K.
    expect(autocompactThresholdForModelID("totally-unknown-xyz")).toBe(178_808);
  });
});

describe("updateShadowContext uses the per-model threshold (#983)", () => {
  // Drive a session to ~600K uncompressed shadow tokens over two turns, then
  // read the counterfactual compaction count. 600K sits between the 200K-model
  // trigger (167K) and the 1M-model trigger (967K), so the model identity flips
  // the outcome — proving the threshold is actually per-model, not hardcoded.
  function driveTo600K(sessionID: string, conversationModel?: string): void {
    recordConversationCost(sessionID, PRICING_MODEL, USAGE); // turns → 1
    updateShadowContext(sessionID, 100_000, 500_000, WORKER, conversationModel);
    recordConversationCost(sessionID, PRICING_MODEL, USAGE); // turns → 2
    updateShadowContext(sessionID, 120_000, 10_000, WORKER, conversationModel);
  }

  test("a 200K-class (default) model counts a shadow compaction at 600K", () => {
    driveTo600K("s-default", undefined);
    expect(
      getSessionCosts("s-default")?.counterfactual.avoidedCompactions,
    ).toBe(1);
  });

  test("a 1M-context model has NOT compacted at 600K", () => {
    driveTo600K("s-opus", "claude-opus-4-6");
    // The old hardcoded 167K constant would have wrongly counted 1 here.
    expect(getSessionCosts("s-opus")?.counterfactual.avoidedCompactions).toBe(
      0,
    );
  });
});
