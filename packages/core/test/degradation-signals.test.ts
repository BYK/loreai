import { describe, expect, test } from "vitest";
import {
  type AgentTurn,
  type StepSignals,
  type TraceStep,
  analyzeTurns,
  buildRotCurve,
  extractSignals,
  signalTotals,
  toolTarget,
  traceFromTurns,
  wilsonInterval,
} from "../src/degradation-signals";

// Pure, no-LLM, no-DB engine — these tests exercise the exact heuristics and
// are written to fail if the underlying logic is reverted (non-vacuous).

// Convenience builder for a step with a single tool call.
const step = (
  name: string,
  opts: { target?: string | null; isError?: boolean; text?: string } = {},
): TraceStep => ({
  role: "assistant",
  assistantText: opts.text,
  toolCalls: [
    { name, target: opts.target ?? null, isError: opts.isError ?? false },
  ],
});

const flags = (s: StepSignals) => ({
  tool_error: s.tool_error,
  edit_failure: s.edit_failure,
  retry: s.retry,
  reread: s.reread,
  self_correction: s.self_correction,
  degraded: s.degraded,
});

describe("extractSignals — per-step signals", () => {
  test("tool_error fires on any errored tool call; not on success", () => {
    const [ok, err] = extractSignals([
      step("bash", { target: "ls", isError: false }),
      step("bash", { target: "cat x", isError: true }),
    ]);
    expect(ok.tool_error).toBe(false);
    expect(err.tool_error).toBe(true);
    expect(err.degraded).toBe(true);
  });

  test("edit_failure fires only for editing tools, and implies tool_error", () => {
    const [editErr, readErr] = extractSignals([
      step("edit", { target: "/a.ts", isError: true }),
      step("read", { target: "/b.ts", isError: true }),
    ]);
    expect(editErr.edit_failure).toBe(true);
    expect(editErr.tool_error).toBe(true);
    // read errors are tool errors but NOT edit failures
    expect(readErr.edit_failure).toBe(false);
    expect(readErr.tool_error).toBe(true);
  });

  test("edit tool name matching is case-insensitive", () => {
    const [s] = extractSignals([
      step("Edit", { target: "/a.ts", isError: true }),
    ]);
    expect(s.edit_failure).toBe(true);
  });

  test("retry fires when a recently-errored (tool,target) recurs — even if it now succeeds", () => {
    const sig = extractSignals([
      step("edit", { target: "/a.ts", isError: true }), // step 0 error
      step("read", { target: "/other.ts", isError: false }), // step 1 filler
      step("edit", { target: "/a.ts", isError: false }), // step 2 retry (success)
    ]);
    expect(sig[0].retry).toBe(false);
    expect(sig[2].retry).toBe(true);
  });

  test("retry does NOT fire outside the retry window", () => {
    // error at step 0, recurrence at step 7 (> RETRY_WINDOW = 6)
    const steps: TraceStep[] = [
      step("edit", { target: "/a.ts", isError: true }),
    ];
    for (let i = 0; i < 6; i++) steps.push(step("bash", { target: `f${i}` }));
    steps.push(step("edit", { target: "/a.ts", isError: false })); // step 7
    const sig = extractSignals(steps);
    expect(sig[7].retry).toBe(false);
  });

  test("retry requires a concrete target (no target → no retry)", () => {
    const sig = extractSignals([
      step("bash", { target: null, isError: true }),
      step("bash", { target: null, isError: true }),
    ]);
    expect(sig[1].retry).toBe(false);
  });

  test("retry keys on BOTH tool and target — different target does not retry", () => {
    const sig = extractSignals([
      step("edit", { target: "/a.ts", isError: true }),
      step("edit", { target: "/b.ts", isError: false }),
    ]);
    expect(sig[1].retry).toBe(false);
  });

  test("reread fires on a second read of the same file, not the first", () => {
    const sig = extractSignals([
      step("read", { target: "/a.ts" }),
      step("read", { target: "/b.ts" }),
      step("read", { target: "/a.ts" }),
    ]);
    expect(sig[0].reread).toBe(false);
    expect(sig[1].reread).toBe(false);
    expect(sig[2].reread).toBe(true);
  });

  test("self_correction matches apology/correction phrases only", () => {
    const [apology, plain, letMeFix] = extractSignals([
      { toolCalls: [], assistantText: "I apologize, that was a mistake." },
      {
        toolCalls: [],
        assistantText: "Here is the implementation you asked for.",
      },
      { toolCalls: [], assistantText: "Let me fix that now." },
    ]);
    expect(apology.self_correction).toBe(true);
    expect(plain.self_correction).toBe(false);
    expect(letMeFix.self_correction).toBe(true);
  });

  test("degraded is the OR of all five signals; a clean step is not degraded", () => {
    const [clean] = extractSignals([
      step("read", { target: "/a.ts", isError: false, text: "done" }),
    ]);
    expect(flags(clean)).toEqual({
      tool_error: false,
      edit_failure: false,
      retry: false,
      reread: false,
      self_correction: false,
      degraded: false,
    });
  });

  test("multiple tool calls in one step aggregate signals", () => {
    const s: TraceStep = {
      toolCalls: [
        { name: "read", target: "/a.ts", isError: false },
        { name: "edit", target: "/a.ts", isError: true },
      ],
    };
    const [sig] = extractSignals([s]);
    expect(sig.tool_error).toBe(true);
    expect(sig.edit_failure).toBe(true);
  });
});

describe("signalTotals", () => {
  test("counts each signal across steps", () => {
    const sig = extractSignals([
      step("edit", { target: "/a.ts", isError: true }),
      step("edit", { target: "/a.ts", isError: false }), // retry
      step("read", { target: "/a.ts" }), // first read of /a.ts here → not reread
    ]);
    const totals = signalTotals(sig);
    expect(totals.tool_error).toBe(1);
    expect(totals.edit_failure).toBe(1);
    expect(totals.retry).toBe(1);
  });
});

describe("wilsonInterval", () => {
  test("empty sample returns the full [0,1] range", () => {
    expect(wilsonInterval(0, 0)).toEqual([0, 1]);
  });

  test("interval brackets the point estimate and stays within [0,1]", () => {
    const [lo, hi] = wilsonInterval(5, 10);
    expect(lo).toBeGreaterThan(0);
    expect(lo).toBeLessThan(0.5);
    expect(hi).toBeGreaterThan(0.5);
    expect(hi).toBeLessThan(1);
  });

  test("extremes are clamped: 0/n floor at 0, n/n ceil at 1", () => {
    const [lo0] = wilsonInterval(0, 20);
    const [, hi1] = wilsonInterval(20, 20);
    expect(lo0).toBe(0);
    expect(hi1).toBe(1);
  });

  test("larger n tightens the interval for the same rate", () => {
    const wide = wilsonInterval(5, 10);
    const narrow = wilsonInterval(50, 100);
    expect(narrow[1] - narrow[0]).toBeLessThan(wide[1] - wide[0]);
  });
});

// Build StepSignals directly (bypassing the trace) so the curve math is tested
// in isolation from the signal heuristics.
const degradedStep = (
  promptTokens: number,
  degraded: boolean,
): StepSignals => ({
  stepIndex: 0,
  promptTokens,
  tool_error: degraded,
  edit_failure: false,
  retry: false,
  reread: false,
  self_correction: false,
  degraded,
});

describe("buildRotCurve — fill axis (default)", () => {
  test("buckets by prompt-token fill percentage of the window", () => {
    const steps = [
      degradedStep(5_000, false), // 2.5% → bucket 0
      degradedStep(130_000, true), // 65% → bucket 6 (deep)
    ];
    const curve = buildRotCurve(steps, { contextWindow: 200_000 });
    expect(curve.axis).toBe("fill");
    expect(curve.buckets[0].n).toBe(1);
    expect(curve.buckets[6].n).toBe(1);
    expect(curve.buckets[6].lo).toBe(60);
  });
});

describe("buildRotCurve — tokens axis (absolute)", () => {
  const opts = {
    axis: "tokens" as const,
    bucketWidth: 10_000,
    freshMax: 20_000,
    deepMin: 40_000,
    minBucketN: 4,
    kneeRatio: 1.5,
  };

  test("detects a degradation knee where the deep-zone rate climbs", () => {
    const steps: StepSignals[] = [];
    // Fresh zone: 20 steps at 5k tokens, 1 degraded → freshRate 0.05
    for (let i = 0; i < 20; i++) steps.push(degradedStep(5_000, i === 0));
    // Deep bucket [40k,50k): 20 steps, 12 degraded → rate 0.6
    for (let i = 0; i < 20; i++) steps.push(degradedStep(45_000, i < 12));

    const curve = buildRotCurve(steps, opts);
    expect(curve.freshRate).toBeCloseTo(0.05, 5);
    expect(curve.knee).toBe(40_000);
    expect(curve.degradationRatio).toBeGreaterThan(1.5);
    expect(curve.ratioSignificant).toBe(true);
  });

  test("a flat curve yields no knee and no significant ratio", () => {
    const steps: StepSignals[] = [];
    for (let i = 0; i < 20; i++) steps.push(degradedStep(5_000, i === 0)); // fresh 0.05
    for (let i = 0; i < 20; i++) steps.push(degradedStep(45_000, i === 0)); // deep 0.05
    const curve = buildRotCurve(steps, opts);
    expect(curve.knee).toBeNull();
    expect(curve.ratioSignificant).toBe(false);
  });

  test("an elevated point estimate with a wide CI (floor below fresh rate) is NOT a knee", () => {
    // Guards the CI-floor requirement specifically: the deep bucket's rate
    // exceeds kneeRatio × fresh, but its Wilson floor does not clear the fresh
    // rate, so a single noisy-but-small bucket must not declare a threshold.
    const steps: StepSignals[] = [];
    for (let i = 0; i < 20; i++) steps.push(degradedStep(5_000, i < 9)); // fresh 0.45
    for (let i = 0; i < 5; i++) steps.push(degradedStep(45_000, i < 4)); // deep 0.8, n=5
    const curve = buildRotCurve(steps, opts);
    const deep = curve.buckets.find((b) => b.lo === 40_000);
    expect(deep?.rate).toBeGreaterThanOrEqual(1.5 * (curve.freshRate ?? 0));
    expect(deep?.ci[0]).toBeLessThan(curve.freshRate ?? 0);
    expect(curve.knee).toBeNull();
  });

  test("low-confidence buckets are flagged and never declare a knee", () => {
    const steps: StepSignals[] = [];
    for (let i = 0; i < 20; i++) steps.push(degradedStep(5_000, i === 0)); // fresh, high n
    // Deep bucket with only 3 steps (< minBucketN=4) all degraded — must be
    // flagged low-confidence and must NOT be chosen as the knee.
    for (let i = 0; i < 3; i++) steps.push(degradedStep(45_000, true));
    const curve = buildRotCurve(steps, opts);
    const deep = curve.buckets.find((b) => b.lo === 40_000);
    expect(deep?.lowConfidence).toBe(true);
    expect(curve.knee).toBeNull();
  });

  test("infinite ratio when fresh zone is clean but deep zone degrades", () => {
    const steps: StepSignals[] = [];
    for (let i = 0; i < 20; i++) steps.push(degradedStep(5_000, false)); // fresh 0
    for (let i = 0; i < 20; i++) steps.push(degradedStep(45_000, i < 10)); // deep 0.5
    const curve = buildRotCurve(steps, opts);
    expect(curve.freshRate).toBe(0);
    expect(curve.degradationRatio).toBe(Infinity);
  });
});

describe("buildRotCurve — edge cases", () => {
  test("empty input yields a well-formed, empty curve", () => {
    const curve = buildRotCurve([]);
    expect(curve.totalSteps).toBe(0);
    expect(curve.overallRate).toBe(0);
    expect(curve.freshRate).toBeNull();
    expect(curve.deepRate).toBeNull();
    expect(curve.knee).toBeNull();
  });
});

describe("toolTarget", () => {
  test("file tools resolve to their path across key aliases", () => {
    expect(toolTarget("edit", { filePath: "/a.ts" })).toBe("/a.ts");
    expect(toolTarget("read", { file_path: "/b.ts" })).toBe("/b.ts");
    expect(toolTarget("write", { path: "/c.ts" })).toBe("/c.ts");
  });

  test("shell tools resolve to their command", () => {
    expect(toolTarget("bash", { command: "pnpm test" })).toBe("pnpm test");
    expect(toolTarget("bash", { cmd: "ls" })).toBe("ls");
  });

  test("returns null when nothing recoverable is present", () => {
    expect(toolTarget("edit", {})).toBeNull();
    expect(toolTarget("bash", null)).toBeNull();
    expect(toolTarget("read", 42)).toBeNull();
  });
});

describe("traceFromTurns + analyzeTurns", () => {
  const turns: AgentTurn[] = [
    {
      role: "assistant",
      content: [
        { type: "text", text: "Editing the file." },
        {
          type: "tool_use",
          id: "t1",
          name: "edit",
          input: { filePath: "/a.ts" },
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "t1",
          content: "oldString not found",
          is_error: true,
        },
      ],
    },
    {
      role: "assistant",
      content: [
        { type: "text", text: "I apologize, let me fix that." },
        {
          type: "tool_use",
          id: "t2",
          name: "edit",
          input: { filePath: "/a.ts" },
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "t2",
          content: "ok",
          is_error: false,
        },
      ],
    },
  ];

  test("builds one step per assistant turn and resolves tool errors from later results", () => {
    const steps = traceFromTurns(turns);
    expect(steps).toHaveLength(2);
    expect(steps[0].toolCalls?.[0]).toMatchObject({
      name: "edit",
      target: "/a.ts",
      isError: true,
    });
    expect(steps[1].toolCalls?.[0]).toMatchObject({
      name: "edit",
      target: "/a.ts",
      isError: false,
    });
  });

  test("end-to-end: an edit failure followed by a self-corrected retry lights up all expected signals", () => {
    const { steps, totals } = analyzeTurns(turns);
    // step 0: the failing edit
    expect(steps[0].edit_failure).toBe(true);
    expect(steps[0].tool_error).toBe(true);
    // step 1: retry of same (edit,/a.ts) + apology text
    expect(steps[1].retry).toBe(true);
    expect(steps[1].self_correction).toBe(true);
    expect(totals.edit_failure).toBe(1);
    expect(totals.retry).toBe(1);
    expect(totals.self_correction).toBe(1);
  });
});
