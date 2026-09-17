import {
  buildHolisticLintInput,
  estimateIsolatedLintInputTokens,
} from "../../src/semantic-lint/context";
import {
  buildConnectedContextDetails,
  renderConnectedContextDetails,
} from "../../src/semantic-lint/connected-context";
import {
  parseHolisticLintResults,
  parseInvariantVerdict,
} from "../../src/semantic-lint/check";
import { parseCounterevidenceVerdict } from "../../src/semantic-lint/counterevidence";
import {
  SEMANTIC_LINT_EVAL_SCHEMA_VERSION,
  type ConfusionMetrics,
  type DistributionMetrics,
  type RecordedJudgeTrace,
  type RecordedVerifierTrace,
  type ReplayObservation,
  type SemanticLintReplayBudgets,
  type SemanticLintReplayCase,
  type SemanticLintReplayConfig,
  type SemanticLintReplayGuardrails,
  type SemanticLintReplayReport,
  type SemanticLintStrategy,
  type StrategyMetrics,
} from "./types";
import {
  SEMANTIC_LINT_REPLAY_FIXTURES,
  SEMANTIC_LINT_REPLAY_FIXTURE_DIGESTS,
  getSemanticLintReplayFixtures,
} from "./fixtures";
import {
  computeReplayFixtureDigests,
  replayHunkDigests,
  replayInvariantContentDigest,
} from "./integrity";

export const DEFAULT_SEMANTIC_LINT_REPLAY_CONFIG: SemanticLintReplayConfig = {
  model: "test/semantic-lint-replay",
  effort: "off",
  promptVersion: "semantic-lint-eval-v1",
  cacheCondition: "warm",
  repetitions: 3,
  inputCostPerMillion: 0.25,
  outputCostPerMillion: 1.25,
  cacheReadCostPerMillion: 0.025,
  cacheWriteCostPerMillion: 0.3125,
  budgets: {
    holisticInputTokenBudget: 16_000,
    maxSemanticCalls: 20,
    maxVerifierCalls: 8,
    counterevidenceInputTokenBudget: 16_000,
  },
};

export interface SemanticLintReplayOptions extends Partial<
  Omit<SemanticLintReplayConfig, "budgets">
> {
  budgets?: Partial<SemanticLintReplayBudgets>;
}

function mergedConfig(
  options: SemanticLintReplayOptions = {},
): SemanticLintReplayConfig {
  const repetitions =
    options.repetitions ?? DEFAULT_SEMANTIC_LINT_REPLAY_CONFIG.repetitions;
  if (
    !Number.isSafeInteger(repetitions) ||
    repetitions < 1 ||
    repetitions > 100
  ) {
    throw new RangeError("repetitions must be an integer from 1 through 100");
  }
  return {
    ...DEFAULT_SEMANTIC_LINT_REPLAY_CONFIG,
    ...options,
    repetitions,
    budgets: {
      ...DEFAULT_SEMANTIC_LINT_REPLAY_CONFIG.budgets,
      ...options.budgets,
    },
  };
}

function finiteNonNegative(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`${label} must be a finite non-negative number`);
  }
  return value;
}

export function validateTraceAccounting(
  trace: RecordedJudgeTrace | RecordedVerifierTrace,
  label: string,
): void {
  const tokenKeys = new Set([
    "inputTokens",
    "outputTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
  ]);
  for (const [key, value] of Object.entries(trace)) {
    if (
      key === "response" ||
      key === "verdict" ||
      key === "outcome" ||
      key === "reason"
    )
      continue;
    finiteNonNegative(value, `${label}.${key}`);
    if (tokenKeys.has(key) && !Number.isSafeInteger(value)) {
      throw new TypeError(`${label}.${key} must be a non-negative integer`);
    }
  }
  if (!Number.isSafeInteger(trace.semanticCalls)) {
    throw new TypeError(`${label}.semanticCalls must be an integer`);
  }
  if (!Number.isSafeInteger(trace.transportAttempts)) {
    throw new TypeError(`${label}.transportAttempts must be an integer`);
  }
  if (trace.transportAttempts < trace.semanticCalls) {
    throw new TypeError(
      `${label}.transportAttempts cannot be below semanticCalls`,
    );
  }
  if (trace.response.trim().length === 0) {
    throw new TypeError(`${label}.response must be non-empty`);
  }
}

/**
 * Validate one semantic call against its own input budget. Adaptive replay can
 * record a first-pass call and a verifier call, each with a separate budget;
 * their aggregate is intentionally reported for cost accounting only.
 */
export function validateTraceInputBudget(
  trace: RecordedJudgeTrace | RecordedVerifierTrace,
  budget: number,
  label: string,
): void {
  finiteNonNegative(budget, `${label} budget`);
  if (trace.inputTokens > budget) {
    throw new Error(`${label}.inputTokens exceeded input-token budget`);
  }
}

function validateJudgeTrace(trace: RecordedJudgeTrace, label: string): void {
  validateTraceAccounting(trace, label);
  const parsed = parseInvariantVerdict(trace.response);
  if (
    !parsed ||
    parsed.verdict !== trace.verdict ||
    parsed.reason !== trace.reason
  ) {
    throw new TypeError(
      `${label} does not satisfy the production judge parser`,
    );
  }
}

function validateHolisticTrace(
  trace: RecordedJudgeTrace,
  caseData: SemanticLintReplayCase,
  label: string,
): void {
  validateTraceAccounting(trace, label);
  const hunkIds = new Set(
    caseData.hunks.map(
      (_, index) => `hunk-${String(index + 1).padStart(4, "0")}`,
    ),
  );
  const parsed = parseHolisticLintResults(
    trace.response,
    new Set([caseData.invariant.id]),
    hunkIds,
  );
  if (
    !parsed ||
    parsed[0]?.invariantId !== caseData.invariant.id ||
    parsed[0]?.verdict !== trace.verdict ||
    parsed[0]?.reason !== trace.reason
  ) {
    throw new TypeError(
      `${label} does not satisfy the production holistic parser`,
    );
  }
}

export function validateVerifierTrace(
  trace: RecordedVerifierTrace,
  label: string,
  expectedHunkIds: ReadonlySet<string>,
): void {
  validateTraceAccounting(trace, label);
  if (
    trace.outcome !== "confirmed" &&
    trace.outcome !== "cleared" &&
    trace.outcome !== "unresolved"
  ) {
    throw new TypeError(
      `${label}.outcome must be confirmed, cleared, or unresolved`,
    );
  }
  const verdict =
    trace.outcome === "confirmed"
      ? "confirmed"
      : trace.outcome === "cleared"
        ? "resolved"
        : "insufficient-context";
  const parsed = parseCounterevidenceVerdict(trace.response, expectedHunkIds);
  if (!parsed || parsed.verdict !== verdict || parsed.reason !== trace.reason) {
    throw new TypeError(
      `${label} does not satisfy the production counterevidence parser`,
    );
  }
}

export function costFor(
  trace: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  },
  config: SemanticLintReplayConfig,
): number {
  return (
    (trace.inputTokens * config.inputCostPerMillion +
      trace.outputTokens * config.outputCostPerMillion +
      trace.cacheReadTokens * config.cacheReadCostPerMillion +
      trace.cacheWriteTokens * config.cacheWriteCostPerMillion) /
    1_000_000
  );
}

function traceValues(
  traces: Array<RecordedJudgeTrace | RecordedVerifierTrace>,
  cost: (trace: RecordedJudgeTrace | RecordedVerifierTrace) => number,
): {
  semanticCalls: number;
  transportAttempts: number;
  verifierCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  latencyMs: number;
  estimatedCostUsd: number;
} {
  return traces.reduce(
    (total, trace) => ({
      semanticCalls: total.semanticCalls + trace.semanticCalls,
      transportAttempts: total.transportAttempts + trace.transportAttempts,
      verifierCalls:
        total.verifierCalls + ("outcome" in trace ? trace.semanticCalls : 0),
      inputTokens: total.inputTokens + trace.inputTokens,
      outputTokens: total.outputTokens + trace.outputTokens,
      cacheReadTokens: total.cacheReadTokens + trace.cacheReadTokens,
      cacheWriteTokens: total.cacheWriteTokens + trace.cacheWriteTokens,
      latencyMs: total.latencyMs + trace.latencyMs,
      estimatedCostUsd: total.estimatedCostUsd + cost(trace),
    }),
    {
      semanticCalls: 0,
      transportAttempts: 0,
      verifierCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      latencyMs: 0,
      estimatedCostUsd: 0,
    },
  );
}

function coverageFor(
  caseData: SemanticLintReplayCase,
  includedHunks: number,
  complete: boolean,
) {
  return {
    contextComplete: complete,
    availableHunks: caseData.hunks.length,
    includedHunks: Math.min(caseData.hunks.length, Math.max(0, includedHunks)),
    omittedHunks: Math.max(0, caseData.hunks.length - includedHunks),
  };
}

function observationFromTraces(
  caseData: SemanticLintReplayCase,
  strategy: SemanticLintStrategy,
  repetition: number,
  config: SemanticLintReplayConfig,
  traces: Array<RecordedJudgeTrace | RecordedVerifierTrace>,
  verdict: RecordedJudgeTrace["verdict"] | undefined,
  reason: string,
  status: ReplayObservation["status"],
  outcome: ReplayObservation["outcome"],
  coverage: ReturnType<typeof coverageFor>,
  plannedInputTokens: number,
  inputTokenBudget: number,
  abstentionReason?: string,
): ReplayObservation {
  const values = traceValues(traces, (trace) => costFor(trace, config));
  return {
    caseId: caseData.id,
    name: caseData.name,
    split: caseData.split,
    label: caseData.label,
    ...(caseData.mutation ? { mutationId: caseData.mutation.id } : {}),
    repetition,
    strategy,
    outcome,
    ...(verdict ? { verdict } : {}),
    reason,
    status,
    ...(abstentionReason ? { abstentionReason } : {}),
    ...coverage,
    semanticCalls: values.semanticCalls,
    transportAttempts: values.transportAttempts,
    verifierCalls: values.verifierCalls,
    inputTokens: values.inputTokens,
    plannedInputTokens,
    inputTokenBudget,
    outputTokens: values.outputTokens,
    cacheReadTokens: values.cacheReadTokens,
    cacheWriteTokens: values.cacheWriteTokens,
    estimatedCostUsd: values.estimatedCostUsd,
    latencyMs: values.latencyMs,
  };
}

function finalOutcome(verdict: RecordedJudgeTrace["verdict"]): {
  outcome: ReplayObservation["outcome"];
  status: ReplayObservation["status"];
} {
  return verdict === "violates"
    ? { outcome: "finding", status: "resolved" }
    : { outcome: "clear", status: "resolved" };
}

export function runStrategy(
  caseData: SemanticLintReplayCase,
  strategy: SemanticLintStrategy,
  repetition: number,
  config: SemanticLintReplayConfig,
): ReplayObservation {
  const seed = caseData.hunks[caseData.seedHunkIndex];
  if (!seed) throw new Error(`${caseData.id} has no seed hunk`);

  if (strategy === "isolated-baseline") {
    const rendered = renderConnectedContextDetails(seed, [], caseData.hunks);
    const trace = caseData.recorded.isolated;
    const coverage = coverageFor(
      caseData,
      rendered.truncated ? 0 : 1,
      caseData.hunks.length === 1 &&
        seed.truncated !== true &&
        !rendered.truncated,
    );
    if (rendered.truncated) {
      return observationFromTraces(
        caseData,
        strategy,
        repetition,
        config,
        [],
        undefined,
        "The isolated seed exceeded the bounded rendered-context limit.",
        "not-attempted",
        "abstained",
        coverage,
        estimateIsolatedLintInputTokens({
          invariant: caseData.invariant,
          hunk: { id: "hunk-0001", file: seed.file, text: seed.text },
        }),
        config.budgets.counterevidenceInputTokenBudget,
        "seed-context-truncated",
      );
    }
    validateJudgeTrace(trace, `${caseData.id}.isolated`);
    validateTraceInputBudget(
      trace,
      config.budgets.counterevidenceInputTokenBudget,
      `${caseData.id}.isolated`,
    );
    const final = finalOutcome(trace.verdict);
    return observationFromTraces(
      caseData,
      strategy,
      repetition,
      config,
      [trace],
      trace.verdict,
      trace.reason,
      final.status,
      final.outcome,
      coverage,
      trace.inputTokens,
      config.budgets.counterevidenceInputTokenBudget,
    );
  }

  if (strategy === "holistic-fit") {
    const plan = buildHolisticLintInput({
      invariants: [caseData.invariant],
      hunks: caseData.hunks.map((item, index) => ({
        id: `hunk-${String(index + 1).padStart(4, "0")}`,
        file: item.file,
        text: item.text,
      })),
      availableInvariantCount: 1,
      inputTokenBudget: config.budgets.holisticInputTokenBudget,
    });
    const trace = caseData.recorded.holistic;
    if (caseData.hunks.some((item) => item.truncated === true)) {
      return observationFromTraces(
        caseData,
        strategy,
        repetition,
        config,
        [],
        undefined,
        "The holistic diff contains parser-truncated hunk content.",
        "not-attempted",
        "abstained",
        {
          contextComplete: false,
          availableHunks: caseData.hunks.length,
          includedHunks: 0,
          omittedHunks: caseData.hunks.length,
        },
        plan.coverage.inputTokens,
        plan.coverage.inputTokenBudget,
        "hunk-content-truncated",
      );
    }
    if (plan.kind !== "fit") {
      return observationFromTraces(
        caseData,
        strategy,
        repetition,
        config,
        [],
        undefined,
        "The complete diff did not fit the holistic input-token budget.",
        "not-attempted",
        "abstained",
        {
          contextComplete: false,
          availableHunks: plan.coverage.availableHunks,
          includedHunks: plan.coverage.includedHunks,
          omittedHunks: plan.coverage.omittedHunks,
        },
        plan.coverage.inputTokens,
        plan.coverage.inputTokenBudget,
        "holistic-budget-exhausted",
      );
    }
    validateHolisticTrace(trace, caseData, `${caseData.id}.holistic`);
    validateTraceInputBudget(
      trace,
      config.budgets.holisticInputTokenBudget,
      `${caseData.id}.holistic`,
    );
    const final = finalOutcome(trace.verdict);
    return observationFromTraces(
      caseData,
      strategy,
      repetition,
      config,
      [trace],
      trace.verdict,
      trace.reason,
      final.status,
      final.outcome,
      {
        contextComplete: plan.coverage.contextComplete,
        availableHunks: plan.coverage.availableHunks,
        includedHunks: plan.coverage.includedHunks,
        omittedHunks: plan.coverage.omittedHunks,
      },
      plan.coverage.inputTokens,
      plan.coverage.inputTokenBudget,
    );
  }

  const connected = buildConnectedContextDetails(caseData.hunks);
  const companions = connected.contexts.get(caseData.seedHunkIndex) ?? [];
  const rendered = renderConnectedContextDetails(
    seed,
    companions,
    caseData.hunks,
  );
  const contextComplete =
    !rendered.truncated &&
    rendered.omittedCompanions === 0 &&
    !connected.omittedBySeed.has(caseData.seedHunkIndex) &&
    !caseData.hunks.some((item) => item.truncated === true);
  const connectedContextTruncated =
    rendered.truncated ||
    caseData.hunks.some((item) => item.truncated === true);
  const firstPass = caseData.recorded.adaptive.firstPass;
  const adaptive = caseData.recorded.adaptive;
  const renderedCompanions = Math.max(
    0,
    companions.length - rendered.omittedCompanions,
  );
  const included = connectedContextTruncated ? 0 : 1 + renderedCompanions;
  const coverage = coverageFor(caseData, included, contextComplete);

  if (connectedContextTruncated) {
    return observationFromTraces(
      caseData,
      strategy,
      repetition,
      config,
      [],
      undefined,
      "The connected seed context exceeded the bounded input limit.",
      "not-attempted",
      "abstained",
      coverage,
      estimateIsolatedLintInputTokens({
        invariant: caseData.invariant,
        hunk: {
          id: "hunk-0001",
          file: seed.file,
          text: seed.text,
        },
      }),
      config.budgets.counterevidenceInputTokenBudget,
      "connected-context-truncated",
    );
  }

  validateJudgeTrace(firstPass, `${caseData.id}.adaptive.firstPass`);
  validateTraceInputBudget(
    firstPass,
    config.budgets.counterevidenceInputTokenBudget,
    `${caseData.id}.adaptive.firstPass`,
  );

  if (firstPass.verdict !== "violates") {
    const final = finalOutcome(firstPass.verdict);
    return observationFromTraces(
      caseData,
      strategy,
      repetition,
      config,
      [firstPass],
      firstPass.verdict,
      firstPass.reason,
      final.status,
      final.outcome,
      coverage,
      firstPass.inputTokens,
      config.budgets.counterevidenceInputTokenBudget,
    );
  }

  if (!contextComplete) {
    return observationFromTraces(
      caseData,
      strategy,
      repetition,
      config,
      [firstPass],
      firstPass.verdict,
      firstPass.reason,
      "not-attempted",
      "abstained",
      coverage,
      firstPass.inputTokens,
      config.budgets.counterevidenceInputTokenBudget,
      "connected-context-incomplete",
    );
  }

  const verifierTrace = adaptive.verifier;
  if (!verifierTrace) {
    return observationFromTraces(
      caseData,
      strategy,
      repetition,
      config,
      [firstPass],
      firstPass.verdict,
      "No verifier trace was recorded for a tentative violation.",
      "unresolved",
      "abstained",
      coverage,
      firstPass.inputTokens,
      config.budgets.counterevidenceInputTokenBudget,
      "verifier-not-attempted",
    );
  }
  validateVerifierTrace(
    verifierTrace,
    `${caseData.id}.adaptive.verifier`,
    new Set(
      [caseData.seedHunkIndex, ...companions.map((item) => item.hunkIndex)].map(
        (index) => `hunk-${String(index + 1).padStart(4, "0")}`,
      ),
    ),
  );
  validateTraceInputBudget(
    verifierTrace,
    config.budgets.counterevidenceInputTokenBudget,
    `${caseData.id}.adaptive.verifier`,
  );
  const traces = [firstPass, verifierTrace];
  if (verifierTrace.outcome === "unresolved") {
    return observationFromTraces(
      caseData,
      strategy,
      repetition,
      config,
      traces,
      firstPass.verdict,
      verifierTrace.reason,
      "unresolved",
      "abstained",
      coverage,
      firstPass.inputTokens + verifierTrace.inputTokens,
      config.budgets.counterevidenceInputTokenBudget,
      "verifier-unresolved",
    );
  }
  const final =
    verifierTrace.outcome === "confirmed" ? "violates" : "satisfies";
  return observationFromTraces(
    caseData,
    strategy,
    repetition,
    config,
    traces,
    final,
    verifierTrace.reason,
    "resolved",
    final === "violates" ? "finding" : "clear",
    coverage,
    firstPass.inputTokens + verifierTrace.inputTokens,
    config.budgets.counterevidenceInputTokenBudget,
  );
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * fraction) - 1),
  );
  return sorted[index] ?? 0;
}

function distribution(observations: ReplayObservation[]): DistributionMetrics {
  const total = observations.length;
  const latency = observations.map((item) => item.latencyMs);
  const availableHunks = observations.reduce(
    (sum, item) => sum + item.availableHunks,
    0,
  );
  const includedHunks = observations.reduce(
    (sum, item) => sum + item.includedHunks,
    0,
  );
  return {
    total,
    mean:
      total === 0 ? 0 : latency.reduce((sum, value) => sum + value, 0) / total,
    p50: percentile(latency, 0.5),
    p95: percentile(latency, 0.95),
    totalInputTokens: observations.reduce(
      (sum, item) => sum + item.inputTokens,
      0,
    ),
    totalOutputTokens: observations.reduce(
      (sum, item) => sum + item.outputTokens,
      0,
    ),
    totalCacheReadTokens: observations.reduce(
      (sum, item) => sum + item.cacheReadTokens,
      0,
    ),
    totalCacheWriteTokens: observations.reduce(
      (sum, item) => sum + item.cacheWriteTokens,
      0,
    ),
    totalEstimatedCostUsd: observations.reduce(
      (sum, item) => sum + item.estimatedCostUsd,
      0,
    ),
    totalSemanticCalls: observations.reduce(
      (sum, item) => sum + item.semanticCalls,
      0,
    ),
    totalTransportAttempts: observations.reduce(
      (sum, item) => sum + item.transportAttempts,
      0,
    ),
    totalVerifierCalls: observations.reduce(
      (sum, item) => sum + item.verifierCalls,
      0,
    ),
    abstentions: observations.filter((item) => item.outcome === "abstained")
      .length,
    unresolved: observations.filter((item) => item.status === "unresolved")
      .length,
    notAttempted: observations.filter((item) => item.status === "not-attempted")
      .length,
    completeContext: observations.filter((item) => item.contextComplete).length,
    coverageRatio: availableHunks === 0 ? 0 : includedHunks / availableHunks,
  };
}

export function confusionMetrics(
  observations: ReplayObservation[],
): ConfusionMetrics {
  const finding = (item: ReplayObservation) => item.outcome === "finding";
  const trueViolation = (item: ReplayObservation) =>
    item.label === "true-violation";
  const primary = observations.filter((item) => item.mutationId === undefined);
  const mutants = observations.filter((item) => item.mutationId !== undefined);
  const truePositives = primary.filter(
    (item) => trueViolation(item) && finding(item),
  ).length;
  const falsePositives = primary.filter(
    (item) => !trueViolation(item) && finding(item),
  ).length;
  const falseNegatives = primary.filter(
    (item) => trueViolation(item) && item.outcome === "clear",
  ).length;
  const abstainedTrueViolations = primary.filter(
    (item) => trueViolation(item) && item.outcome === "abstained",
  ).length;
  const decidedTrue = truePositives + falseNegatives;
  const allTrue = decidedTrue + abstainedTrueViolations;
  const negativeSamples = primary.filter((item) => !trueViolation(item)).length;
  return {
    truePositives,
    falsePositives,
    falseNegatives,
    abstainedTrueViolations,
    precision:
      truePositives + falsePositives === 0
        ? null
        : truePositives / (truePositives + falsePositives),
    falsePositiveRate:
      negativeSamples === 0 ? null : falsePositives / negativeSamples,
    recall: allTrue === 0 ? null : truePositives / allTrue,
    decidedRecall: decidedTrue === 0 ? null : truePositives / decidedTrue,
    contextFalsePositives: primary.filter(
      (item) => item.label === "context-fp" && finding(item),
    ).length,
    contextFalsePositiveClears: primary.filter(
      (item) => item.label === "context-fp" && item.outcome === "clear",
    ).length,
    controlledMutantTruePositives: mutants.filter(
      (item) => item.label === "true-violation" && finding(item),
    ).length,
    controlledMutantSamples: mutants.length,
  };
}

function metricsFor(
  observations: ReplayObservation[],
  strategy: SemanticLintStrategy,
  split: "all" | "labeled" | "held-out",
): StrategyMetrics {
  const filtered = observations.filter(
    (item) =>
      item.strategy === strategy && (split === "all" || item.split === split),
  );
  const uniqueCases = new Set(filtered.map((item) => item.caseId));
  const repetitions = new Set(filtered.map((item) => item.repetition));
  return {
    strategy,
    split,
    sampleCases: uniqueCases.size,
    repetitions: repetitions.size,
    ...confusionMetrics(filtered),
    ...distribution(filtered),
  };
}

export function contextFalsePositiveReductionForReplay(
  observations: readonly ReplayObservation[],
): number {
  const pairs = new Map<
    string,
    { isolated?: ReplayObservation; adaptive?: ReplayObservation }
  >();
  for (const observation of observations) {
    if (
      observation.mutationId !== undefined ||
      observation.label !== "context-fp" ||
      (observation.strategy !== "isolated-baseline" &&
        observation.strategy !== "adaptive-connected")
    ) {
      continue;
    }
    const key = `${observation.caseId}\u0000${observation.split}\u0000${observation.repetition}`;
    const pair = pairs.get(key) ?? {};
    pair[
      observation.strategy === "isolated-baseline" ? "isolated" : "adaptive"
    ] = observation;
    pairs.set(key, pair);
  }
  return [...pairs.values()].filter(
    (pair) =>
      pair.isolated?.outcome === "finding" &&
      pair.adaptive?.outcome === "clear",
  ).length;
}

export function guardrails(
  metrics: StrategyMetrics[],
  observations: readonly ReplayObservation[],
  cases: readonly SemanticLintReplayCase[],
  config: SemanticLintReplayConfig,
): SemanticLintReplayGuardrails {
  const all = (strategy: SemanticLintStrategy) =>
    metrics.find((item) => item.strategy === strategy && item.split === "all");
  const isolated = all("isolated-baseline");
  const adaptive = all("adaptive-connected");
  const sampleSizeMet =
    cases.filter((item) => item.split === "labeled").length >= 3 &&
    cases.filter((item) => item.split === "held-out").length >= 2;
  const contextFalsePositiveReduction =
    contextFalsePositiveReductionForReplay(observations);
  const falsePositiveRateDelta =
    isolated?.falsePositiveRate === null || adaptive?.falsePositiveRate === null
      ? null
      : (adaptive?.falsePositiveRate ?? 0) - (isolated?.falsePositiveRate ?? 0);
  const precisionDelta =
    isolated?.precision === null || adaptive?.precision === null
      ? null
      : (adaptive?.precision ?? 0) - (isolated?.precision ?? 0);
  const recallDelta =
    isolated?.recall === null || adaptive?.recall === null
      ? null
      : (adaptive?.recall ?? 0) - (isolated?.recall ?? 0);
  const decidedRecallDelta =
    isolated?.decidedRecall === null || adaptive?.decidedRecall === null
      ? null
      : (adaptive?.decidedRecall ?? 0) - (isolated?.decidedRecall ?? 0);
  const controlledMutantRecall =
    adaptive && adaptive.controlledMutantSamples > 0
      ? adaptive.controlledMutantTruePositives /
        adaptive.controlledMutantSamples
      : null;
  const abstentionRate = (item: StrategyMetrics | undefined) =>
    !item || item.total === 0 ? null : item.abstentions / item.total;
  const isolatedAbstention = abstentionRate(isolated);
  const adaptiveAbstention = abstentionRate(adaptive);
  const abstentionRateDelta =
    isolatedAbstention === null || adaptiveAbstention === null
      ? null
      : adaptiveAbstention - isolatedAbstention;
  const notes: string[] = [];
  if (!sampleSizeMet)
    notes.push("minimum labeled/held-out sample sizes are not met");
  if (contextFalsePositiveReduction <= 0) {
    notes.push(
      "adaptive-connected did not reduce context-related false positives",
    );
  }
  if (falsePositiveRateDelta !== null && falsePositiveRateDelta > 0) {
    notes.push(
      "adaptive-connected false-positive rate is above isolated-baseline",
    );
  }
  if (precisionDelta !== null && precisionDelta < 0) {
    notes.push("adaptive-connected precision is below isolated-baseline");
  }
  if (controlledMutantRecall !== null && controlledMutantRecall !== 1) {
    notes.push(
      "adaptive-connected did not preserve every controlled mutant finding",
    );
  }
  if (decidedRecallDelta !== null && decidedRecallDelta < 0) {
    notes.push("adaptive-connected decided recall is below isolated-baseline");
  }
  if (recallDelta !== null && recallDelta < 0) {
    notes.push("adaptive-connected recall is below isolated-baseline");
  }
  if (abstentionRateDelta !== null && abstentionRateDelta > 0) {
    notes.push("adaptive-connected abstention rate is above isolated-baseline");
  }
  const status = !sampleSizeMet
    ? "insufficient-sample"
    : notes.length > 0
      ? "fail"
      : "pass";
  return {
    status,
    contextFalsePositiveReduction,
    falsePositiveRateDelta,
    precisionDelta,
    recallDelta,
    decidedRecallDelta,
    controlledMutantRecall,
    abstentionRateDelta,
    notes:
      notes.length > 0
        ? notes
        : [`repeated ${config.repetitions} time(s) with locked fixture traces`],
  };
}

function validateReplayCorpus(cases: readonly SemanticLintReplayCase[]): void {
  const expectedIds = new Set(
    Object.keys(SEMANTIC_LINT_REPLAY_FIXTURE_DIGESTS),
  );
  const caseIds = new Set<string>();
  const labeledInputDigests = new Set<string>();
  const labeledInvariantContentDigests = new Set<string>();
  const labeledHunkDigests = new Set<string>();

  for (const caseData of cases) {
    if (caseIds.has(caseData.id)) {
      throw new Error(`duplicate semantic-lint replay case: ${caseData.id}`);
    }
    caseIds.add(caseData.id);
    const expected =
      SEMANTIC_LINT_REPLAY_FIXTURE_DIGESTS[
        caseData.id as keyof typeof SEMANTIC_LINT_REPLAY_FIXTURE_DIGESTS
      ];
    if (!expected) {
      throw new Error(`unmanifested semantic-lint replay case: ${caseData.id}`);
    }
    const actual = computeReplayFixtureDigests(caseData);
    if (
      caseData.integrity.inputSha256 !== expected.inputSha256 ||
      caseData.integrity.traceSha256 !== expected.traceSha256 ||
      actual.inputSha256 !== expected.inputSha256 ||
      actual.traceSha256 !== expected.traceSha256
    ) {
      throw new Error(
        `semantic-lint replay integrity mismatch: ${caseData.id}`,
      );
    }
    if (caseData.revision.kind === "exact-diff") {
      if (!caseData.revision.evidence?.length) {
        throw new Error(
          `exact-diff replay case has no revision evidence: ${caseData.id}`,
        );
      }
      for (const item of caseData.hunks) {
        const evidence = caseData.revision.evidence.find(
          (candidate) =>
            candidate.file === item.file && candidate.text.includes(item.text),
        );
        if (!evidence) {
          throw new Error(
            `replay hunk is not present in locked revision evidence: ${caseData.id}`,
          );
        }
      }
    } else if (caseData.revision.evidence !== undefined) {
      throw new Error(
        `synthetic replay case cannot carry revision evidence: ${caseData.id}`,
      );
    }
    if (caseData.split === "labeled") {
      labeledInputDigests.add(actual.inputSha256);
      labeledInvariantContentDigests.add(
        replayInvariantContentDigest(caseData),
      );
      for (const digest of replayHunkDigests(caseData)) {
        labeledHunkDigests.add(digest);
      }
    }
  }

  if (caseIds.size !== expectedIds.size) {
    throw new Error("semantic-lint replay manifest and corpus differ");
  }
  for (const caseData of cases) {
    if (caseData.split !== "held-out") continue;
    const actual = computeReplayFixtureDigests(caseData);
    if (labeledInputDigests.has(actual.inputSha256)) {
      throw new Error(`held-out case reuses labeled input: ${caseData.id}`);
    }
    if (
      labeledInvariantContentDigests.has(replayInvariantContentDigest(caseData))
    ) {
      throw new Error(
        `held-out case reuses labeled invariant content: ${caseData.id}`,
      );
    }
    if (
      replayHunkDigests(caseData).some((digest) =>
        labeledHunkDigests.has(digest),
      )
    ) {
      throw new Error(
        `held-out case reuses labeled hunk content: ${caseData.id}`,
      );
    }
    if (caseData.mutation) {
      if (caseData.mutation.ancestry !== "independent") {
        throw new Error(`held-out mutant is not independent: ${caseData.id}`);
      }
      if (caseIds.has(caseData.mutation.parentCaseId)) {
        throw new Error(
          `held-out mutant names an in-corpus parent: ${caseData.id}`,
        );
      }
    }
  }
}

export function runSemanticLintReplay(
  options: SemanticLintReplayOptions = {},
  cases: readonly SemanticLintReplayCase[] = getSemanticLintReplayFixtures(),
): SemanticLintReplayReport {
  const config = mergedConfig(options);
  if (cases.length === 0)
    throw new Error("semantic-lint replay corpus is empty");
  validateReplayCorpus(cases);
  const observations: ReplayObservation[] = [];
  for (let repetition = 1; repetition <= config.repetitions; repetition++) {
    for (const caseData of cases) {
      for (const strategy of [
        "isolated-baseline",
        "holistic-fit",
        "adaptive-connected",
      ] as const) {
        const observation = runStrategy(caseData, strategy, repetition, config);
        if (observation.semanticCalls > config.budgets.maxSemanticCalls) {
          throw new Error(
            `${caseData.id}/${strategy} exceeded semantic-call budget`,
          );
        }
        if (observation.verifierCalls > config.budgets.maxVerifierCalls) {
          throw new Error(
            `${caseData.id}/${strategy} exceeded verifier-call budget`,
          );
        }
        observations.push(observation);
      }
    }
  }
  const metrics = (
    ["isolated-baseline", "holistic-fit", "adaptive-connected"] as const
  ).flatMap((strategy) => [
    metricsFor(observations, strategy, "all"),
    metricsFor(observations, strategy, "labeled"),
    metricsFor(observations, strategy, "held-out"),
  ]);
  return {
    schemaVersion: SEMANTIC_LINT_EVAL_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    corpus: {
      labeledCases: cases.filter((item) => item.split === "labeled").length,
      heldOutCases: cases.filter((item) => item.split === "held-out").length,
      controlledMutantCases: cases.filter((item) => item.mutation !== undefined)
        .length,
      totalCases: cases.length,
      repetitions: config.repetitions,
      observations: observations.length,
    },
    configuration: config,
    metrics,
    guardrails: guardrails(metrics, observations, cases, config),
    observations,
  };
}

function formatPct(value: number | null): string {
  return value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

export function renderSemanticLintReplayMarkdown(
  report: SemanticLintReplayReport,
): string {
  const all = report.metrics.filter((item) => item.split === "all");
  const lines = [
    "# Semantic-lint replay evaluation",
    "",
    `Schema ${report.schemaVersion}; generated ${report.generatedAt}.`,
    "",
    `Corpus: ${report.corpus.labeledCases} labeled, ${report.corpus.heldOutCases} held-out, ${report.corpus.controlledMutantCases} controlled mutants; ${report.corpus.repetitions} repetition(s).`,
    "",
    `Configuration: model \`${report.configuration.model}\`, effort \`${report.configuration.effort}\`, prompt \`${report.configuration.promptVersion}\`, cache \`${report.configuration.cacheCondition}\`.`,
    "",
    "| Strategy | n | Precision | Recall | Decided recall | Abstentions | Coverage | Calls | Input tok | Output tok | Cost | p50/p95 ms |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const item of all) {
    lines.push(
      `| ${item.strategy} | ${item.total} | ${formatPct(item.precision)} | ${formatPct(item.recall)} | ${formatPct(item.decidedRecall)} | ${item.abstentions} | ${formatPct(item.coverageRatio)} | ${item.totalSemanticCalls} / ${item.totalTransportAttempts} | ${item.totalInputTokens} | ${item.totalOutputTokens} | $${item.totalEstimatedCostUsd.toFixed(4)} | ${item.p50.toFixed(0)} / ${item.p95.toFixed(0)} |`,
    );
  }
  lines.push(
    "",
    `Guardrails: **${report.guardrails.status}** — context-related FP clears ${report.guardrails.contextFalsePositiveReduction}; FP-rate delta ${formatPct(report.guardrails.falsePositiveRateDelta)}; precision delta ${formatPct(report.guardrails.precisionDelta)}; recall delta ${formatPct(report.guardrails.recallDelta)}; decided-recall delta ${formatPct(report.guardrails.decidedRecallDelta)}; controlled-mutant recall ${formatPct(report.guardrails.controlledMutantRecall)}.`,
  );
  for (const note of report.guardrails.notes) lines.push(`- ${note}`);
  lines.push(
    "",
    "The fixture runner replays integrity-checked judge/verifier traces; it does not fetch or execute the fixed revisions. Primary precision/recall exclude controlled mutants, and abstention remains separate from false negatives.",
    "",
  );
  return lines.join("\n");
}

export { SEMANTIC_LINT_REPLAY_FIXTURES };
