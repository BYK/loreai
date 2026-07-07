/**
 * Shared types for the Lore eval suite.
 *
 * All scenarios, the harness, judge, baselines, and the CLI entry point
 * import from this file so there is a single source of truth.
 */

// ---------------------------------------------------------------------------
// Dimensions & Scenarios
// ---------------------------------------------------------------------------

export type Dimension =
  | "context"
  | "recall"
  | "preferences"
  | "cross-project"
  | "cost";

export const ALL_DIMENSIONS: Dimension[] = [
  "context",
  "recall",
  "preferences",
  "cross-project",
  "cost",
];

// ---------------------------------------------------------------------------
// Baselines
// ---------------------------------------------------------------------------

export type BaselineMode =
  | "lore"
  | "lore-context-only"
  | "lore-memory-only"
  | "tail-window"
  | "compaction"
  | "raw"
  // A fresh agent with NO memory of prior sessions — the realistic vanilla
  // experience Lore's automatic cross-session injection replaces. Used as the
  // negative-control arm in multi-session recall tests: it answers with no
  // prior-session context, so any correct prior-session fact is guessing.
  | "no-memory";

export const ALL_BASELINES: BaselineMode[] = [
  "lore",
  "lore-context-only",
  "lore-memory-only",
  "tail-window",
  "compaction",
  "raw",
  // Negative-control arm for multi-session recall (a fresh agent with no prior
  // memory). Selectable via `--baselines no-memory`; not in the default set,
  // which stays lore-vs-compaction.
  "no-memory",
];

// ---------------------------------------------------------------------------
// Conversation transcripts
// ---------------------------------------------------------------------------

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | {
      type: "tool_result";
      tool_use_id: string;
      content: string;
      is_error?: boolean;
    };

export interface ConversationTurn {
  role: "user" | "assistant";
  content: ContentPart[];
  /** Pre-computed token estimate for this turn. */
  tokens?: number;
  /** Unix ms timestamp for temporal realism. */
  timestamp?: number;
  /** If true, this is inflator-generated filler — stored directly in the
   *  temporal DB without an upstream API call. */
  isFiller?: boolean;
}

export interface SessionTranscript {
  id: string;
  label: string;
  projectPath: string;
  turns: ConversationTurn[];
  metadata: {
    totalTokens: number;
    description: string;
  };
}

// ---------------------------------------------------------------------------
// Planted facts & questions
// ---------------------------------------------------------------------------

export interface PlantedFact {
  turnIndex: number;
  cumulativeTokens: number;
  fact: string;
  questionDifficulty: "easy" | "medium" | "hard";
  category: string;
}

export interface ScoringCriterion {
  name: string;
  description: string;
  scale: {
    1: string;
    3: string;
    5: string;
  };
}

export interface ScoringRubric {
  criteria: ScoringCriterion[];
  weights: Record<string, number>;
}

export interface EvalQuestion {
  id: string;
  dimension: Dimension;
  scenario: string;
  sessionRef: string;
  question: string;
  referenceAnswer: string;
  rubric: ScoringRubric;
  /**
   * Ground-truth anchors for justifier-free retrieval scoring (see
   * `recall-score.ts`). When present, the harness scores retrieval quality
   * deterministically, separately from the LLM judge's end-task score.
   */
  expectedFacts?: string[];
  /** Stale/superseded facts that must NOT appear (negative controls). */
  forbiddenFacts?: string[];
  metadata: {
    turnIndex?: number;
    cumulativeTokens?: number;
    difficulty: "easy" | "medium" | "hard";
    tags: string[];
  };
}

// ---------------------------------------------------------------------------
// Eval results
// ---------------------------------------------------------------------------

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalCost: number;
}

export interface JudgeResult {
  scores: Record<string, number>;
  compositeScore: number;
  reasoning: string;
  tokensUsed: number;
}

/**
 * Objective, LLM-free retrieval-quality score for a single question, kept
 * separate from the judge's end-task composite. Produced by
 * `recall-score.ts::scoreRetrieval` and present only when the question
 * declares ground-truth anchors.
 */
export interface RetrievalScore {
  /** matchedFacts / expectedCount; null when the question has no expectedFacts. */
  factRecall: number | null;
  expectedCount: number;
  matchedFacts: string[];
  missedFacts: string[];
  /** forbiddenFacts that leaked into the answer (negative-control failures). */
  leakedStaleFacts: string[];
  /** All expected present AND nothing forbidden leaked. */
  pass: boolean;
}

export interface EvalResult {
  timestamp: string;
  dimension: Dimension;
  scenario: string;
  questionId: string;
  mode: BaselineMode;
  question: string;
  referenceAnswer: string;
  hypothesis: string;
  /** LLM judge (end-task quality) per-criterion scores. */
  scores: Record<string, number>;
  /** LLM judge (end-task quality) weighted composite. */
  compositeScore: number;
  judgeReasoning: string;
  /**
   * Objective retrieval-quality score, independent of the judge. Present only
   * when the question declares ground-truth anchors (`expectedFacts` /
   * `forbiddenFacts`); omitted otherwise.
   */
  retrieval?: RetrievalScore;
  tokens: TokenUsage;
  metadata: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Cost-specific metrics
// ---------------------------------------------------------------------------

export interface CostMetrics {
  totalCostWithLore: number;
  totalCostBaseline: number;
  loreOverheadPct: number;
  savingsPct: number;
  breakdown: {
    conversation: number;
    distillation: number;
    curation: number;
    recall: number;
    warmup: number;
  };
  counterfactual: {
    avoidedCompactions: number;
    avoidedCompactionCost: number;
    cacheHitRate: number;
    batchSavings: number;
  };
}

// ---------------------------------------------------------------------------
// Replay results
// ---------------------------------------------------------------------------

export interface ReplayResult {
  sessionID: string;
  turnsReplayed: number;
  totalTokens: number;
  /** Gateway-reported layer at end of session. */
  finalLayer?: number;
  /** Per-turn token snapshots for cost analysis. */
  turnSnapshots: TurnSnapshot[];
}

export interface TurnSnapshot {
  turnIndex: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  layer?: number;
}

// ---------------------------------------------------------------------------
// Eval config
// ---------------------------------------------------------------------------

export type EvalMode = "fixture" | "live";

export interface EvalConfig {
  mode: EvalMode;
  gateway?: { host: string; port: number };
  model: string;
  judgeModel: string;
  concurrency: number;
  outputPath: string;
  dimensions: Dimension[];
  baselines: BaselineMode[];
  /** Directory to write session recordings (first run). */
  recordDir?: string;
  /** Directory to read session recordings (subsequent runs). */
  replayDir?: string;
  /** Filter to specific scenario IDs. */
  scenarios?: string[];
  /** Inflate scenarios to this token count with filler content. */
  inflateTokens?: number;
}

// ---------------------------------------------------------------------------
// Scenario interface
// ---------------------------------------------------------------------------

/**
 * Every scenario module exports an array of `ScenarioDefinition`.
 * The harness iterates over them, replays sessions, asks questions,
 * and scores results.
 */
export interface ScenarioDefinition {
  id: string;
  name: string;
  dimension: Dimension;
  /** Which baselines are applicable to this scenario. */
  applicableBaselines: BaselineMode[];
  /** Session transcripts to replay before asking questions. */
  sessions: SessionTranscript[];
  /** Questions to ask after replaying all sessions. */
  questions: EvalQuestion[];
  /**
   * Optional setup hook (e.g., seeding knowledge entries for cross-project).
   * Receives the gateway base URL and returns a cleanup function.
   */
  setup?: (gatewayUrl: string) => Promise<() => Promise<void>>;
}
