/**
 * Shared bounded semantic-lint data structures for semantic lint.
 *
 * This module deliberately contains no repository I/O or model calls. It only
 * decides whether the complete available diff can be presented to one holistic
 * judge call without lossy truncation.
 */

export type LintStrategy = "none" | "isolated-hunk" | "holistic";

export interface LintCoverage {
  strategy: LintStrategy;
  contextComplete: boolean;
  inputTokens: number;
  inputTokenBudget: number;
  availableHunks: number;
  includedHunks: number;
  omittedHunks: number;
  availableInvariants: number;
  includedInvariants: number;
  omittedInvariants: number;
}

export interface HolisticHunk {
  id: string;
  file: string;
  text: string;
}

export interface HolisticInvariant {
  id: string;
  title: string;
  content: string;
}

export interface HolisticLintInput {
  invariants: HolisticInvariant[];
  hunks: HolisticHunk[];
  prContext?: {
    title: string;
    description: string;
    base?: string;
    head?: string;
    titleTruncated?: boolean;
    descriptionTruncated?: boolean;
  };
  inputTokenBudget: number;
  semanticCallBudget: number;
}

export interface HolisticLintEvidence {
  hunkId: string;
  reason: string;
}

export interface HolisticLintResult {
  invariantId: string;
  verdict:
    | "violates"
    | "fixes"
    | "satisfies"
    | "unrelated"
    | "insufficient-context";
  reason: string;
  evidence: HolisticLintEvidence[];
}

export const DEFAULT_HOLISTIC_INPUT_TOKEN_BUDGET = 16_000;
export const MAX_HOLISTIC_INVARIANTS = 20;
export const HOLISTIC_SYSTEM_TOKEN_RESERVE = 2_000;
export const APPROX_BYTES_PER_TOKEN = 4;
/** Reserve for the malformed-response repair prompt within the same budget. */
export const HOLISTIC_REPAIR_INPUT_TOKEN_RESERVE = 4_500;

export function emptyLintCoverage(
  availableHunks = 0,
  availableInvariants = 0,
  inputTokenBudget = DEFAULT_HOLISTIC_INPUT_TOKEN_BUDGET,
): LintCoverage {
  return {
    strategy: "none",
    contextComplete: false,
    inputTokens: 0,
    inputTokenBudget,
    availableHunks,
    includedHunks: 0,
    omittedHunks: availableHunks,
    availableInvariants,
    includedInvariants: 0,
    omittedInvariants: availableInvariants,
  };
}

export function estimateHolisticLintInputTokens(input: {
  invariants: HolisticInvariant[];
  hunks: HolisticHunk[];
  prContext?: HolisticLintInput["prContext"];
}): number {
  const serialized = JSON.stringify(
    {
      pullRequestContext: input.prContext ?? null,
      invariants: input.invariants,
      changedHunks: input.hunks,
    },
    null,
    2,
  );
  return (
    Math.ceil(Buffer.byteLength(serialized, "utf8") / APPROX_BYTES_PER_TOKEN) +
    HOLISTIC_SYSTEM_TOKEN_RESERVE +
    HOLISTIC_REPAIR_INPUT_TOKEN_RESERVE
  );
}

export function estimateIsolatedLintInputTokens(input: {
  invariant: HolisticInvariant;
  hunk: HolisticHunk;
  prContext?: HolisticLintInput["prContext"];
}): number {
  return estimateHolisticLintInputTokens({
    invariants: [input.invariant],
    hunks: [input.hunk],
    prContext: input.prContext,
  });
}

export function buildHolisticLintInput(input: {
  invariants: HolisticInvariant[];
  hunks: HolisticHunk[];
  prContext?: HolisticLintInput["prContext"];
  /**
   * Total retrieved invariants before candidate selection. The lint input
   * may intentionally contain only the bounded selected subset.
   */
  availableInvariantCount?: number;
  inputTokenBudget?: number;
}):
  | { kind: "fit"; input: HolisticLintInput; coverage: LintCoverage }
  | { kind: "too-large"; coverage: LintCoverage } {
  const inputTokenBudget =
    input.inputTokenBudget ?? DEFAULT_HOLISTIC_INPUT_TOKEN_BUDGET;
  const availableInvariantCount = Math.max(
    input.invariants.length,
    input.availableInvariantCount ?? input.invariants.length,
  );
  const inputTokens = estimateHolisticLintInputTokens(input);
  const contextTruncated =
    input.prContext?.titleTruncated === true ||
    input.prContext?.descriptionTruncated === true;
  // A bounded title/body is incomplete author context; never label it a
  // complete holistic PR lint.
  const fits = inputTokens <= inputTokenBudget && !contextTruncated;
  const coverage: LintCoverage = {
    strategy: fits ? "holistic" : "isolated-hunk",
    contextComplete: fits,
    inputTokens,
    inputTokenBudget,
    availableHunks: input.hunks.length,
    includedHunks: fits ? input.hunks.length : 0,
    omittedHunks: fits ? 0 : input.hunks.length,
    availableInvariants: availableInvariantCount,
    includedInvariants: fits ? input.invariants.length : 0,
    omittedInvariants: fits
      ? availableInvariantCount - input.invariants.length
      : availableInvariantCount,
  };
  if (!fits) return { kind: "too-large", coverage };
  return {
    kind: "fit",
    input: {
      invariants: input.invariants,
      hunks: input.hunks,
      ...(input.prContext ? { prContext: input.prContext } : {}),
      inputTokenBudget,
      semanticCallBudget: 0,
    },
    coverage,
  };
}
