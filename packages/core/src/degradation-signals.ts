/**
 * Coding-agent degradation signals — a pure, no-LLM analysis engine.
 *
 * A faithful TypeScript port of the contextrot methodology
 * (github.com/Priyanshu-byte-coder/contextrot, MIT), adapted for Lore's
 * eval + benchmark suite (issue #961). It turns a normalized agent trace into
 * per-step behavioral failure signals and a bucketed "rot curve", using only
 * inspectable heuristics — no LLM judge, no "justifier" synthesis — so it can
 * score an agent's *actual behavior* rather than a lenient re-narration of it.
 *
 * Five independent per-step signals (each reported separately AND combined, so
 * one noisy signal can never silently dominate):
 *   - tool_error:      any tool call in the step returned an error
 *   - edit_failure:    an editing tool (edit/write/multiedit/…) errored — the
 *                      clearest "agent lost track of file state" event
 *   - retry:           the step repeats a (tool, target) pair that errored
 *                      within the previous `RETRY_WINDOW` steps
 *   - reread:          the step re-reads a file already read earlier in the
 *                      session (a proxy for context scrolling out of attention)
 *   - self_correction: assistant text contains apology/correction language
 *
 * Deliberate deviation from upstream contextrot: the rot curve supports an
 * **absolute prompt-token** x-axis in addition to the fill-% axis. Lore keeps
 * the context window deliberately low (compaction/distillation), so a fill-%
 * axis is confounded when comparing Lore-on vs Lore-off; the absolute-token
 * axis places both on the same scale and lets us locate the empirical
 * degradation "knee" in token units — the input to Lore's context sweet-spot.
 *
 * Statistics are kept honest exactly as upstream: Wilson 95% score intervals,
 * visible n-counts, low-confidence flags, and a conservative knee test.
 * This module is intentionally free of DB and LLM dependencies so it can run
 * over any source (eval transcripts, opencode.db, tool_calls) and under Bun.
 */

// ---------------------------------------------------------------------------
// Signal definitions
// ---------------------------------------------------------------------------

export const SIGNAL_NAMES = [
  "tool_error",
  "edit_failure",
  "retry",
  "reread",
  "self_correction",
] as const;

export type SignalName = (typeof SIGNAL_NAMES)[number];

/**
 * Editing tools whose failure is an `edit_failure`. Matched case-insensitively
 * so both Claude Code (`Edit`, `Write`) and opencode/lore (`edit`, `write`)
 * tool names resolve identically.
 */
export const EDIT_TOOLS: ReadonlySet<string> = new Set([
  "edit",
  "write",
  "multiedit",
  "notebookedit",
  "str_replace_editor",
  "apply_patch",
  "patch",
]);

/** Reading tools tracked for the `reread` signal (case-insensitive). */
export const READ_TOOLS: ReadonlySet<string> = new Set([
  "read",
  "notebookread",
]);

/**
 * Apology / correction phrases marking a self-recognized error. Mirrors
 * upstream contextrot's pattern; `\b` word boundaries keep it from matching
 * inside larger words.
 */
const SELF_CORRECTION_RE =
  /\b(i apologize|apologies|my mistake|my error|i made a mistake|i made an error|let me (?:fix|correct) (?:that|this|my)|that was (?:wrong|incorrect)|that's (?:wrong|incorrect)|i was wrong|oops|correcting my)\b/i;

/** How many steps back an error stays "recent" for retry matching. */
export const RETRY_WINDOW = 6;

// ---------------------------------------------------------------------------
// Normalized trace input contract
// ---------------------------------------------------------------------------

/**
 * A single tool invocation within a step. `target` is the salient identity of
 * the call used by the retry/reread heuristics — a file path for edit/read, a
 * command string for bash, etc. When `target` is absent, retry/reread can not
 * fire for that call (the safe, no-false-positive direction).
 */
export interface TraceToolCall {
  name: string;
  target?: string | null;
  isError: boolean;
}

/**
 * One model step (an assistant API call and the tool results it triggered).
 * `promptTokens` is the prompt-side context size at that moment
 * (`input + cache_read + cache_creation`); it drives the rot-curve x-axis and
 * may be 0/absent for sources that don't carry real token accounting.
 */
export interface TraceStep {
  role?: "user" | "assistant";
  assistantText?: string;
  toolCalls?: TraceToolCall[];
  promptTokens?: number;
  model?: string;
}

/** Per-step signal flags plus the `degraded` composite. */
export interface StepSignals {
  stepIndex: number;
  promptTokens: number;
  tool_error: boolean;
  edit_failure: boolean;
  retry: boolean;
  reread: boolean;
  self_correction: boolean;
  /** True when ANY of the five signals fired. */
  degraded: boolean;
}

const SEP = "\x1f";

/**
 * Extract per-step signals from an ordered list of trace steps.
 *
 * State carried across steps: `recentErrors` maps a `(tool, target)` pair to
 * the index of the step where it last errored (for retry detection), and
 * `filesRead` accumulates every file target seen (for reread detection).
 * A repeat of a recently-errored `(tool, target)` counts as a retry whether or
 * not the repeated attempt itself succeeds.
 */
export function extractSignals(steps: readonly TraceStep[]): StepSignals[] {
  const out: StepSignals[] = [];
  const recentErrors = new Map<string, number>();
  const filesRead = new Set<string>();

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    let toolError = false;
    let editFailure = false;
    let retry = false;
    let reread = false;

    for (const call of step.toolCalls ?? []) {
      const name = call.name.toLowerCase();
      const target = call.target ?? "";
      const key = `${name}${SEP}${target}`;

      if (READ_TOOLS.has(name) && target) {
        if (filesRead.has(target)) reread = true;
        filesRead.add(target);
      }

      // A repeat of a recently errored (tool, target) is a retry, whether or
      // not this attempt succeeds. Requires a concrete target.
      const errorStep = recentErrors.get(key);
      if (errorStep !== undefined && target && i - errorStep <= RETRY_WINDOW) {
        retry = true;
      }

      if (call.isError) {
        toolError = true;
        if (EDIT_TOOLS.has(name)) editFailure = true;
        if (target) recentErrors.set(key, i);
      }
    }

    const selfCorrection =
      !!step.assistantText && SELF_CORRECTION_RE.test(step.assistantText);

    out.push({
      stepIndex: i,
      promptTokens: step.promptTokens ?? 0,
      tool_error: toolError,
      edit_failure: editFailure,
      retry,
      reread,
      self_correction: selfCorrection,
      degraded: toolError || editFailure || retry || reread || selfCorrection,
    });
  }

  return out;
}

/** Sum the per-signal totals across a set of step signals. */
export function signalTotals(
  steps: readonly StepSignals[],
): Record<SignalName, number> {
  const totals = Object.fromEntries(SIGNAL_NAMES.map((n) => [n, 0])) as Record<
    SignalName,
    number
  >;
  for (const s of steps) {
    for (const name of SIGNAL_NAMES) {
      if (s[name]) totals[name] += 1;
    }
  }
  return totals;
}

// ---------------------------------------------------------------------------
// Wilson score interval
// ---------------------------------------------------------------------------

/**
 * Wilson 95% score interval for a binomial rate. Chosen over the normal
 * approximation because bucket counts are often small and rates sit near 0.
 * Returns `[0, 1]` for an empty sample.
 */
export function wilsonInterval(
  successes: number,
  n: number,
  z = 1.96,
): [number, number] {
  if (n === 0) return [0, 1];
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const margin =
    (z / denom) * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, center - margin), Math.min(1, center + margin)];
}

// ---------------------------------------------------------------------------
// Rot curve
// ---------------------------------------------------------------------------

export type RotAxis = "fill" | "tokens";

export interface RotBucket {
  /** Inclusive lower bound of the bucket, in axis units (% or tokens). */
  lo: number;
  /** Exclusive upper bound of the bucket, in axis units. */
  hi: number;
  n: number;
  degraded: number;
  bySignal: Record<SignalName, number>;
  rate: number;
  ci: [number, number];
  lowConfidence: boolean;
}

export interface RotCurveOptions {
  /** `"fill"` (prompt tokens ÷ window, default) or `"tokens"` (absolute). */
  axis?: RotAxis;
  /** Context window for the fill axis. Default 200_000. */
  contextWindow?: number;
  /** Bucket width in axis units. Default 10 (fill %) or 25_000 (tokens). */
  bucketWidth?: number;
  /** Upper edge of the "fresh" zone. Default 40 (fill) or 40_000 (tokens). */
  freshMax?: number;
  /** Lower edge of the "deep" zone. Default 60 (fill) or 100_000 (tokens). */
  deepMin?: number;
  /** Buckets below this many steps are flagged low-confidence. Default 15. */
  minBucketN?: number;
  /** Bucket-rate ÷ fresh-rate that marks the degradation knee. Default 1.5. */
  kneeRatio?: number;
}

export interface RotCurve {
  axis: RotAxis;
  bucketWidth: number;
  buckets: RotBucket[];
  totalSteps: number;
  totalDegraded: number;
  overallRate: number;
  /** Degraded rate below `freshMax`. Null when the fresh zone is empty. */
  freshRate: number | null;
  /** Degraded rate at/above `deepMin`. Null when the deep zone is empty. */
  deepRate: number | null;
  freshN: number;
  deepN: number;
  /** deepRate ÷ freshRate. `Infinity` when fresh is 0 but deep > 0. */
  degradationRatio: number | null;
  /** True only when the two zones' Wilson intervals do not overlap. */
  ratioSignificant: boolean;
  /** Lower bound (axis units) of the first bucket clearing the knee test. */
  knee: number | null;
  signalTotals: Record<SignalName, number>;
}

const AXIS_DEFAULTS: Record<
  RotAxis,
  { bucketWidth: number; freshMax: number; deepMin: number }
> = {
  fill: { bucketWidth: 10, freshMax: 40, deepMin: 60 },
  tokens: { bucketWidth: 25_000, freshMax: 40_000, deepMin: 100_000 },
};

function emptySignalCounts(): Record<SignalName, number> {
  return Object.fromEntries(SIGNAL_NAMES.map((n) => [n, 0])) as Record<
    SignalName,
    number
  >;
}

/**
 * Build a bucketed rot curve from per-step signals. Steps are bucketed by the
 * chosen x-axis, and per bucket we report the degraded rate with a Wilson 95%
 * interval. The "knee" is the lower bound of the first non-low-confidence
 * bucket at/above `freshMax` whose point estimate is ≥ `kneeRatio` × the
 * fresh-zone rate AND whose CI floor clears the fresh-zone rate — so a single
 * noisy bucket can never declare a threshold.
 *
 * All statistics are observational: this is a diagnostic, not a controlled
 * experiment. Association between context size and failure signals may partly
 * reflect task difficulty rather than degradation.
 */
export function buildRotCurve(
  steps: readonly StepSignals[],
  options: RotCurveOptions = {},
): RotCurve {
  const axis = options.axis ?? "fill";
  const defaults = AXIS_DEFAULTS[axis];
  const bucketWidth = Math.max(1, options.bucketWidth ?? defaults.bucketWidth);
  const freshMax = options.freshMax ?? defaults.freshMax;
  const deepMin = options.deepMin ?? defaults.deepMin;
  const minBucketN = options.minBucketN ?? 15;
  const kneeRatio = options.kneeRatio ?? 1.5;
  const contextWindow = Math.max(1, options.contextWindow ?? 200_000);

  const axisValue = (s: StepSignals): number =>
    axis === "fill"
      ? Math.min(100, (100 * s.promptTokens) / contextWindow)
      : Math.max(0, s.promptTokens);

  // Fill has a fixed 0..100 domain; tokens grows to the observed maximum.
  let maxAxis = 0;
  for (const s of steps) maxAxis = Math.max(maxAxis, axisValue(s));
  const domainTop = axis === "fill" ? 100 : maxAxis;
  const bucketCount = Math.max(
    1,
    axis === "fill"
      ? Math.ceil(100 / bucketWidth)
      : Math.floor(domainTop / bucketWidth) + 1,
  );

  const buckets: RotBucket[] = Array.from({ length: bucketCount }, (_, i) => ({
    lo: i * bucketWidth,
    hi: (i + 1) * bucketWidth,
    n: 0,
    degraded: 0,
    bySignal: emptySignalCounts(),
    rate: 0,
    ci: [0, 1] as [number, number],
    lowConfidence: true,
  }));

  const totals = emptySignalCounts();
  let totalDegraded = 0;
  let freshN = 0;
  let freshD = 0;
  let deepN = 0;
  let deepD = 0;

  for (const s of steps) {
    const value = axisValue(s);
    const idx = Math.min(Math.floor(value / bucketWidth), buckets.length - 1);
    const b = buckets[idx];
    b.n += 1;
    if (s.degraded) {
      b.degraded += 1;
      totalDegraded += 1;
    }
    for (const name of SIGNAL_NAMES) {
      if (s[name]) {
        b.bySignal[name] += 1;
        totals[name] += 1;
      }
    }

    if (value < freshMax) {
      freshN += 1;
      if (s.degraded) freshD += 1;
    } else if (value >= deepMin) {
      deepN += 1;
      if (s.degraded) deepD += 1;
    }
  }

  for (const b of buckets) {
    b.rate = b.n ? b.degraded / b.n : 0;
    b.ci = wilsonInterval(b.degraded, b.n);
    b.lowConfidence = b.n < minBucketN;
  }

  const freshRate = freshN ? freshD / freshN : null;
  const deepRate = deepN ? deepD / deepN : null;

  let degradationRatio: number | null = null;
  let ratioSignificant = false;
  if (freshRate !== null && deepRate !== null) {
    degradationRatio =
      freshRate > 0 ? deepRate / freshRate : deepRate > 0 ? Infinity : 1;
    const freshCi = wilsonInterval(freshD, freshN);
    const deepCi = wilsonInterval(deepD, deepN);
    ratioSignificant = deepCi[0] > freshCi[1];
  }

  let knee: number | null = null;
  if (freshRate !== null && freshRate > 0) {
    for (const b of buckets) {
      if (b.lo < freshMax || b.lowConfidence) continue;
      if (b.rate >= kneeRatio * freshRate && b.ci[0] > freshRate) {
        knee = b.lo;
        break;
      }
    }
  }

  return {
    axis,
    bucketWidth,
    buckets,
    totalSteps: steps.length,
    totalDegraded,
    overallRate: steps.length ? totalDegraded / steps.length : 0,
    freshRate,
    deepRate,
    freshN,
    deepN,
    degradationRatio,
    ratioSignificant,
    knee,
    signalTotals: totals,
  };
}

// ---------------------------------------------------------------------------
// Trace adapter: agent conversation turns → trace steps
// ---------------------------------------------------------------------------

/**
 * Structural shape of an agent conversation content part. Deliberately matches
 * the eval suite's `ContentPart` (and the Anthropic message shape) so callers
 * can pass their turns directly without an import dependency on this module.
 */
export type AgentContentPart =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | {
      type: "tool_result";
      tool_use_id: string;
      content?: string;
      is_error?: boolean;
    };

export interface AgentTurn {
  role: "user" | "assistant";
  content: AgentContentPart[];
  /** Optional per-turn token estimate; used as the step's promptTokens. */
  tokens?: number;
}

/**
 * Best-effort extraction of the salient target string for a tool call, used by
 * the retry/reread heuristics. File-oriented tools resolve to their path; other
 * tools (bash/shell) resolve to their command. Returns null when nothing
 * recoverable is present — which safely disables retry/reread for that call.
 */
export function toolTarget(name: string, input: unknown): string | null {
  if (input == null) return null;
  if (typeof input === "string") return input || null;
  if (typeof input !== "object") return null;
  const o = input as Record<string, unknown>;
  const str = (v: unknown): string | null =>
    typeof v === "string" && v.length > 0 ? v : null;
  const n = name.toLowerCase();
  if (EDIT_TOOLS.has(n) || READ_TOOLS.has(n)) {
    return (
      str(o.filePath) ??
      str(o.file_path) ??
      str(o.path) ??
      str(o.notebookPath) ??
      str(o.notebook_path)
    );
  }
  return str(o.command) ?? str(o.cmd) ?? null;
}

/**
 * Convert an ordered list of agent conversation turns into trace steps — one
 * step per assistant turn. A tool call's error status is resolved from the
 * `tool_result` (matched by `tool_use_id`) that appears in a later user turn,
 * so callers may pass the full interleaved transcript.
 */
export function traceFromTurns(turns: readonly AgentTurn[]): TraceStep[] {
  // First pass: map every tool_use_id to its error status.
  const errorById = new Map<string, boolean>();
  for (const turn of turns) {
    for (const part of turn.content) {
      if (part.type === "tool_result") {
        errorById.set(part.tool_use_id, part.is_error === true);
      }
    }
  }

  const steps: TraceStep[] = [];
  for (const turn of turns) {
    if (turn.role !== "assistant") continue;
    const textParts: string[] = [];
    const toolCalls: TraceToolCall[] = [];
    for (const part of turn.content) {
      if (part.type === "text") {
        textParts.push(part.text);
      } else if (part.type === "tool_use") {
        toolCalls.push({
          name: part.name,
          target: toolTarget(part.name, part.input),
          isError: errorById.get(part.id) === true,
        });
      }
    }
    steps.push({
      role: "assistant",
      assistantText: textParts.join("\n"),
      toolCalls,
      promptTokens: turn.tokens ?? 0,
    });
  }

  return steps;
}

/**
 * Convenience: run the full pipeline (turns → steps → per-step signals) in one
 * call. Returns both the raw step signals and the per-signal totals.
 */
export function analyzeTurns(turns: readonly AgentTurn[]): {
  steps: StepSignals[];
  totals: Record<SignalName, number>;
} {
  const steps = extractSignals(traceFromTurns(turns));
  return { steps, totals: signalTotals(steps) };
}
