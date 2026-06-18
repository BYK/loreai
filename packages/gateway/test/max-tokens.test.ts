import { describe, test, expect } from "vitest";
import { computeMaxTokens, requestHasThinking } from "../src/pipeline";
import { isClaudeCodeClient } from "../src/session";
import { hasBillingHeader } from "../src/cch";
import type { GatewayMessage } from "../src/translate/types";

// ---------------------------------------------------------------------------
// computeMaxTokens
// ---------------------------------------------------------------------------

describe("computeMaxTokens", () => {
  const MODEL_OUTPUT = 128_000; // e.g. Opus 4.x
  const MODEL_CONTEXT = 200_000;

  test("returns ceiling (32K) on first turn with no history", () => {
    expect(
      computeMaxTokens(
        MODEL_OUTPUT,
        MODEL_CONTEXT,
        undefined,
        undefined,
        undefined,
      ),
    ).toBe(32_000);
  });

  test("returns ceiling capped by model output limit", () => {
    // Model with only 8192 max output → ceiling = 8192
    expect(
      computeMaxTokens(8192, 200_000, undefined, undefined, undefined),
    ).toBe(8192);
  });

  test("uses 3× EMA when history is available", () => {
    // EMA 3000 → 3 × 3000 = 9000, above floor (8192)
    expect(
      computeMaxTokens(MODEL_OUTPUT, MODEL_CONTEXT, 3000, "end_turn", 50_000),
    ).toBe(9000);
  });

  test("returns floor when 3× EMA is below floor", () => {
    // EMA 1000 → 3 × 1000 = 3000, below floor (8192)
    expect(
      computeMaxTokens(MODEL_OUTPUT, MODEL_CONTEXT, 1000, "end_turn", 50_000),
    ).toBe(8192);
  });

  test("returns floor when EMA is zero", () => {
    // EMA explicitly 0 (not undefined) → 3 × 0 = 0, below floor
    // Note: EMA of 0 is distinct from undefined (no history)
    expect(
      computeMaxTokens(MODEL_OUTPUT, MODEL_CONTEXT, 0, "end_turn", 50_000),
    ).toBe(8192);
  });

  test("jumps to ceiling after truncation (stop_reason=length)", () => {
    // EMA 1000 would normally yield floor (8192), but truncation bumps to ceiling
    expect(
      computeMaxTokens(MODEL_OUTPUT, MODEL_CONTEXT, 1000, "length", 50_000),
    ).toBe(32_000);
  });

  test("caps by headroom when context is nearly full", () => {
    // Input 195_000 → headroom = 200_000 - 195_000 - 1000 = 4000 → clamped to floor 8192
    // EMA 20_000 → 3 × 20_000 = 60_000 but headroom is 8192
    expect(
      computeMaxTokens(
        MODEL_OUTPUT,
        MODEL_CONTEXT,
        20_000,
        "end_turn",
        195_000,
      ),
    ).toBe(8192);
  });

  test("headroom calculation with moderate input", () => {
    // Input 170_000 → headroom = 200_000 - 170_000 - 1000 = 29_000
    // EMA 15_000 → 3 × 15_000 = 45_000, clamped by headroom → 29_000
    expect(
      computeMaxTokens(
        MODEL_OUTPUT,
        MODEL_CONTEXT,
        15_000,
        "end_turn",
        170_000,
      ),
    ).toBe(29_000);
  });

  test("adaptive stays within ceiling for large EMA", () => {
    // EMA 20_000 → 3 × 20_000 = 60_000, but ceiling = 32_000
    expect(
      computeMaxTokens(MODEL_OUTPUT, MODEL_CONTEXT, 20_000, "end_turn", 50_000),
    ).toBe(32_000);
  });

  test("handles missing lastInputTokens gracefully", () => {
    // No last input → estimatedInput = 0 → headroom = context - 0 - buffer
    // EMA 3000 → adaptive = 9000
    expect(
      computeMaxTokens(
        MODEL_OUTPUT,
        MODEL_CONTEXT,
        3000,
        "end_turn",
        undefined,
      ),
    ).toBe(9000);
  });

  test("tool_use stop reason does not trigger ceiling jump", () => {
    // Only "length" triggers the safety bump
    expect(
      computeMaxTokens(MODEL_OUTPUT, MODEL_CONTEXT, 1000, "tool_use", 50_000),
    ).toBe(8192);
  });

  test("end_turn stop reason does not trigger ceiling jump", () => {
    expect(
      computeMaxTokens(MODEL_OUTPUT, MODEL_CONTEXT, 1000, "end_turn", 50_000),
    ).toBe(8192);
  });

  test("small model output limits ceiling accordingly", () => {
    // Sonnet-like model with 16K output limit
    // EMA 3000 → adaptive = 9000, ceiling = 16_000
    expect(computeMaxTokens(16_000, 200_000, 3000, "end_turn", 50_000)).toBe(
      9000,
    );
  });

  test("floor (8192) is too small for comprehensive planning responses", () => {
    // This documents the sub-agent EMA pollution scenario:
    // After many sub-agent tool-call turns with small outputs (e.g. 200 tokens),
    // the EMA drops low → 3 × 200 = 600 → clamped to floor 8192.
    // 8192 is insufficient for comprehensive planning responses that need 15-30K.
    // The fix: skip EMA updates for sub-agent turns entirely.
    const subagentEMA = 200; // typical short tool-call output
    const result = computeMaxTokens(
      128_000,
      200_000,
      subagentEMA,
      "tool_use",
      50_000,
    );
    expect(result).toBe(8192); // floor — too small for parent conversation
  });

  test("thinking budget raises floor above MAX_TOKENS_FLOOR", () => {
    // budget 10_000 + 8192 headroom = 18_192; low EMA would otherwise give 8192
    expect(
      computeMaxTokens(
        MODEL_OUTPUT,
        MODEL_CONTEXT,
        200,
        "tool_use",
        50_000,
        10_000,
      ),
    ).toBe(18_192);
  });

  test("thinking floor may exceed the 32K soft ceiling (budget needs it)", () => {
    // budget 30_000 + 8192 = 38_192. The 32K ceiling is lore's SOFT cap; a 30K
    // thinking budget genuinely needs more, so the floor is allowed to exceed
    // it (still well under the 128K hard model output limit). Capping at 32K
    // would leave the model with too little room and risk the very truncation
    // this fix prevents.
    expect(
      computeMaxTokens(
        MODEL_OUTPUT,
        MODEL_CONTEXT,
        200,
        "tool_use",
        50_000,
        30_000,
      ),
    ).toBe(38_192);
  });

  test("thinking floor applies on turn 1 (no history)", () => {
    // ceiling 32_000 already >= 18_192 floor → 32_000
    expect(
      computeMaxTokens(
        MODEL_OUTPUT,
        MODEL_CONTEXT,
        undefined,
        undefined,
        undefined,
        10_000,
      ),
    ).toBe(32_000);
  });

  test("thinking budget never exceeds model hard output limit", () => {
    // small-output model (16K): budget 12_000 + 8192 = 20_192 → clamped to 16_000
    expect(
      computeMaxTokens(16_000, 200_000, 200, "tool_use", 50_000, 12_000),
    ).toBe(16_000);
  });

  test("thinking floor is honored under tight context headroom", () => {
    // input 195_000 → raw headroom 4_000, but thinking floor 18_192 wins
    expect(
      computeMaxTokens(
        MODEL_OUTPUT,
        MODEL_CONTEXT,
        200,
        "tool_use",
        195_000,
        10_000,
      ),
    ).toBe(18_192);
  });

  test("no thinking budget → identical to legacy behavior (floor 8192)", () => {
    expect(
      computeMaxTokens(MODEL_OUTPUT, MODEL_CONTEXT, 1000, "tool_use", 50_000),
    ).toBe(
      computeMaxTokens(
        MODEL_OUTPUT,
        MODEL_CONTEXT,
        1000,
        "tool_use",
        50_000,
        0,
      ),
    );
  });

  test("length stop with thinking budget keeps thinking floor (floor > ceiling)", () => {
    // budget 30K → floor 38_192 > ceiling 32K; the length-stop jump sets
    // adaptive=ceiling (32K) but the thinking floor must still dominate.
    expect(
      computeMaxTokens(
        MODEL_OUTPUT,
        MODEL_CONTEXT,
        1000,
        "length",
        50_000,
        30_000,
      ),
    ).toBe(38_192);
  });

  test("negative thinking budget is treated as no budget (floor 8192)", () => {
    // thinkingBudget <= 0 falls through to MAX_TOKENS_FLOOR (the call site also
    // guards budget > 0, but computeMaxTokens is defensive on its own).
    expect(
      computeMaxTokens(
        MODEL_OUTPUT,
        MODEL_CONTEXT,
        200,
        "tool_use",
        50_000,
        -5000,
      ),
    ).toBe(
      computeMaxTokens(MODEL_OUTPUT, MODEL_CONTEXT, 200, "tool_use", 50_000),
    );
  });

  test("budget >= modelOutput clamps to modelOutput (unsatisfiable; call site skips rewrite)", () => {
    // Pathological: 128K budget on a 128K-output model. computeMaxTokens clamps
    // the floor to modelOutput (128K), which is NOT > budget — so it would be an
    // invalid Anthropic request. The CALL SITE detects modelOutput <= budget and
    // skips the rewrite entirely (leaving the client's max_tokens untouched);
    // this test documents computeMaxTokens' raw clamp behavior in isolation.
    expect(
      computeMaxTokens(128_000, 200_000, 200, "tool_use", 50_000, 128_000),
    ).toBe(128_000);
  });

  test("regression: low tool-use EMA + thinking does not starve output", () => {
    // The Folk Lore failure: ema=725, lastStop=tool_use collapsed the cap to
    // 8192, truncating a deep-think turn mid-reasoning (finish:"length", no
    // visible output). With a 10K thinking budget the cap is now 18_192,
    // leaving 8192 for visible output.
    const result = computeMaxTokens(
      128_000,
      1_000_000,
      725,
      "tool_use",
      488_000,
      10_000,
    );
    expect(result).toBeGreaterThanOrEqual(10_000 + 8192);
  });

  test("thinking active without explicit budget floors at ceiling", () => {
    // The claude-opus-4-8 regression: thinking-by-default models emit thinking
    // blocks WITHOUT a `thinking` param, so no budget is declared. A low
    // tool-use EMA would collapse the cap to 8192 and truncate mid-thought;
    // the structural `thinkingActive` flag floors at the 32K soft ceiling.
    expect(
      computeMaxTokens(
        MODEL_OUTPUT,
        MODEL_CONTEXT,
        200,
        "tool_use",
        50_000,
        undefined,
        true,
      ),
    ).toBe(32_000);
  });

  test("thinking active (no budget) is clamped by a small model output limit", () => {
    // 16K-output model → ceiling 16K → floor 16K
    expect(
      computeMaxTokens(
        16_000,
        200_000,
        200,
        "tool_use",
        50_000,
        undefined,
        true,
      ),
    ).toBe(16_000);
  });

  test("explicit thinking budget takes precedence over the active flag", () => {
    // budget 10_000 → floor 18_192 (budget + headroom), NOT the 32K ceiling.
    expect(
      computeMaxTokens(
        MODEL_OUTPUT,
        MODEL_CONTEXT,
        200,
        "tool_use",
        50_000,
        10_000,
        true,
      ),
    ).toBe(18_192);
  });

  test("thinking active flag false → legacy floor 8192", () => {
    // Explicit `false` must behave identically to the legacy (undefined) path.
    expect(
      computeMaxTokens(
        MODEL_OUTPUT,
        MODEL_CONTEXT,
        1000,
        "tool_use",
        50_000,
        undefined,
        false,
      ),
    ).toBe(
      computeMaxTokens(MODEL_OUTPUT, MODEL_CONTEXT, 1000, "tool_use", 50_000),
    );
  });

  test("thinking active (no budget) is honored under tight context headroom", () => {
    // input 195_000 → raw headroom 4_000, but the ceiling floor (32K) wins —
    // truncating a thinking turn is worse than over-reserving output.
    expect(
      computeMaxTokens(
        MODEL_OUTPUT,
        MODEL_CONTEXT,
        200,
        "tool_use",
        195_000,
        undefined,
        true,
      ),
    ).toBe(32_000);
  });
});

// ---------------------------------------------------------------------------
// requestHasThinking
// ---------------------------------------------------------------------------

describe("requestHasThinking", () => {
  test("true when an assistant message contains a thinking block", () => {
    const messages: GatewayMessage[] = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "reasoning…" },
          { type: "text", text: "answer" },
        ],
      },
    ];
    expect(requestHasThinking(messages)).toBe(true);
  });

  test("true for an assistant redacted_thinking (opaque) block", () => {
    // Anthropic returns redacted_thinking when reasoning is safety-flagged;
    // toGatewayBlock carries it as an opaque passthrough. It still means the
    // model is reasoning, so a redacted-only turn must be detected.
    const messages: GatewayMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "opaque", raw: { type: "redacted_thinking", data: "…" } },
          { type: "text", text: "answer" },
        ],
      },
    ];
    expect(requestHasThinking(messages)).toBe(true);
  });

  test("false for an unrelated opaque block (e.g. an image)", () => {
    const messages: GatewayMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "opaque",
            raw: { type: "image", source: { type: "base64", data: "…" } },
          },
        ],
      },
    ];
    expect(requestHasThinking(messages)).toBe(false);
  });

  test("false when no assistant message has a thinking block", () => {
    const messages: GatewayMessage[] = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "text", text: "answer" }] },
    ];
    expect(requestHasThinking(messages)).toBe(false);
  });

  test("ignores text content on user messages (only assistant thinking counts)", () => {
    const messages: GatewayMessage[] = [
      { role: "user", content: [{ type: "text", text: "thinking about it" }] },
    ];
    expect(requestHasThinking(messages)).toBe(false);
  });

  test("empty message list → false", () => {
    expect(requestHasThinking([])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isClaudeCodeClient
// ---------------------------------------------------------------------------

describe("isClaudeCodeClient", () => {
  test("returns true when x-claude-code-session-id is present", () => {
    expect(
      isClaudeCodeClient({ "x-claude-code-session-id": "abc-123-uuid" }),
    ).toBe(true);
  });

  test("returns false for other session headers", () => {
    expect(isClaudeCodeClient({ "x-session-affinity": "nano-id-value" })).toBe(
      false,
    );
    expect(isClaudeCodeClient({ "x-session-id": "ses_abc123" })).toBe(false);
  });

  test("returns false when no known headers", () => {
    expect(isClaudeCodeClient({})).toBe(false);
    expect(isClaudeCodeClient({ "x-custom-header": "value" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// hasBillingHeader
// ---------------------------------------------------------------------------

describe("hasBillingHeader", () => {
  test("returns true for system prompt with billing header", () => {
    const system =
      "x-anthropic-billing-header: cc_version=2.1.37.abc; cc_entrypoint=cli; cch=a75d0;\n" +
      "You are a helpful assistant.";
    expect(hasBillingHeader(system)).toBe(true);
  });

  test("returns false for system prompt without billing header", () => {
    expect(hasBillingHeader("You are a helpful assistant.")).toBe(false);
  });

  test("returns false for empty system prompt", () => {
    expect(hasBillingHeader("")).toBe(false);
  });

  test("returns false when billing header is not at start", () => {
    const system =
      "You are a helpful assistant.\n" +
      "x-anthropic-billing-header: cc_version=2.1.37.abc; cc_entrypoint=cli; cch=a75d0;";
    expect(hasBillingHeader(system)).toBe(false);
  });
});
