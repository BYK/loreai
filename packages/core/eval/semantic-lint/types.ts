import type { DiffHunk } from "../../src/semantic-lint/check";

export const SEMANTIC_LINT_EVAL_SCHEMA_VERSION = 1;

export type SemanticLintStrategy =
  | "isolated-baseline"
  | "holistic-fit"
  | "adaptive-connected";

export const SEMANTIC_LINT_STRATEGIES: SemanticLintStrategy[] = [
  "isolated-baseline",
  "holistic-fit",
  "adaptive-connected",
];

export type ReplaySplit = "labeled" | "held-out";

/** Human-reviewed ground truth, independent of any strategy's prediction. */
export type TruthLabel = "context-fp" | "true-violation" | "clean-change";

export type RecordedVerdict = "violates" | "satisfies" | "fixes" | "unrelated";

export type ReplayOutcome = "finding" | "clear" | "abstained";

export interface ReplayRevision {
  source: string;
  base: string;
  head: string;
}

export interface ReplayFixtureDigests {
  inputSha256: string;
  traceSha256: string;
}

export interface ReplayInvariant {
  id: string;
  title: string;
  content: string;
  severity: "advisory" | "soft" | "strict";
}

export interface RecordedJudgeTrace {
  verdict: RecordedVerdict;
  reason: string;
  semanticCalls: number;
  transportAttempts: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  latencyMs: number;
}

export interface RecordedVerifierTrace {
  outcome: "confirmed" | "cleared" | "unresolved";
  reason: string;
  semanticCalls: number;
  transportAttempts: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  latencyMs: number;
}

export interface ReplayAdaptiveTrace {
  firstPass: RecordedJudgeTrace;
  verifier?: RecordedVerifierTrace;
}

export interface SemanticLintReplayCase {
  id: string;
  name: string;
  split: ReplaySplit;
  label: TruthLabel;
  revision: ReplayRevision;
  invariant: ReplayInvariant;
  hunks: DiffHunk[];
  seedHunkIndex: number;
  tags: string[];
  /** A controlled mutant must remain visible as a true violation. */
  mutation?: {
    id: string;
    parentCaseId: string;
    ancestry: "derived" | "independent";
    description: string;
  };
  /** Checked against a separately reviewed manifest before replay. */
  integrity: ReplayFixtureDigests;
  recorded: {
    isolated: RecordedJudgeTrace;
    holistic: RecordedJudgeTrace;
    adaptive: ReplayAdaptiveTrace;
  };
}

export interface SemanticLintReplayBudgets {
  holisticInputTokenBudget: number;
  maxSemanticCalls: number;
  maxVerifierCalls: number;
  counterevidenceInputTokenBudget: number;
}

export interface SemanticLintReplayConfig {
  model: string;
  effort: "off" | "low" | "medium" | "high" | "xhigh";
  promptVersion: string;
  cacheCondition: "cold" | "warm" | "mixed";
  repetitions: number;
  inputCostPerMillion: number;
  outputCostPerMillion: number;
  cacheReadCostPerMillion: number;
  cacheWriteCostPerMillion: number;
  budgets: SemanticLintReplayBudgets;
}

export interface ReplayObservation {
  caseId: string;
  name: string;
  split: ReplaySplit;
  label: TruthLabel;
  mutationId?: string;
  repetition: number;
  strategy: SemanticLintStrategy;
  outcome: ReplayOutcome;
  verdict?: RecordedVerdict;
  reason: string;
  status: "resolved" | "unresolved" | "not-attempted";
  abstentionReason?: string;
  contextComplete: boolean;
  availableHunks: number;
  includedHunks: number;
  omittedHunks: number;
  semanticCalls: number;
  transportAttempts: number;
  verifierCalls: number;
  inputTokens: number;
  plannedInputTokens: number;
  inputTokenBudget: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedCostUsd: number;
  latencyMs: number;
}

export interface ConfusionMetrics {
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  precision: number | null;
  recall: number | null;
  decidedRecall: number | null;
  contextFalsePositives: number;
  controlledMutantTruePositives: number;
  controlledMutantSamples: number;
}

export interface DistributionMetrics {
  total: number;
  mean: number;
  p50: number;
  p95: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  totalEstimatedCostUsd: number;
  totalSemanticCalls: number;
  totalTransportAttempts: number;
  totalVerifierCalls: number;
  abstentions: number;
  unresolved: number;
  notAttempted: number;
  completeContext: number;
  coverageRatio: number;
}

export interface StrategyMetrics extends ConfusionMetrics, DistributionMetrics {
  strategy: SemanticLintStrategy;
  split: "all" | ReplaySplit;
  sampleCases: number;
  repetitions: number;
}

export interface SemanticLintReplayGuardrails {
  status: "pass" | "insufficient-sample" | "fail";
  contextFalsePositiveReduction: number;
  decidedRecallDelta: number | null;
  controlledMutantRecall: number | null;
  abstentionRateDelta: number | null;
  notes: string[];
}

export interface SemanticLintReplayReport {
  schemaVersion: typeof SEMANTIC_LINT_EVAL_SCHEMA_VERSION;
  generatedAt: string;
  corpus: {
    labeledCases: number;
    heldOutCases: number;
    controlledMutantCases: number;
    totalCases: number;
    repetitions: number;
    observations: number;
  };
  configuration: SemanticLintReplayConfig;
  metrics: StrategyMetrics[];
  guardrails: SemanticLintReplayGuardrails;
  observations: ReplayObservation[];
}
