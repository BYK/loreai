import { randomUUID } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

export type LintStatus = "complete" | "partial" | "failed";
export type LintPhaseStatus = "healthy" | "degraded" | "failed" | "not-run";

export interface LintFailure {
  code: string;
  message: string;
  scope?: "candidate" | "run";
  retryable?: boolean;
}

export interface LintPhaseHealth {
  status: LintPhaseStatus;
  failure?: LintFailure;
  expected?: number;
  available?: number;
  missing?: number;
  selected?: number;
  resolved?: number;
  unresolved?: number;
  notAttempted?: number;
}

export interface LintCandidateOutcome {
  id: string;
  file: string;
  invariantId: string;
  invariantTitle: string;
  state: "resolved" | "unresolved" | "not-attempted";
  verdict?: "violates" | "fixes" | "satisfies" | "unrelated";
  reason?: string;
  failure?: LintFailure;
  stats: { semanticCalls: number; transportAttempts: number };
}

export interface LintFinding {
  id: string;
  invariantId: string;
  invariantTitle: string;
  invariantContent: string;
  file: string;
  similarity: number;
  refHit: boolean;
  reason: string | null;
  hunk: string;
  severity: "advisory" | "soft" | "strict";
}

export interface SerializedLintGate {
  mode: "advisory" | "gate";
  blockingFindingIds: string[];
  overridden: Array<{ findingId: string; reason: string }>;
  advisoryFindingIds: string[];
  /** Findings which would block if advisory mode were changed to gate mode. */
  wouldBlockFindingIds: string[];
}

export interface SemanticLintReport {
  schemaVersion: 1;
  status: LintStatus;
  model: string;
  effort: "off" | "low" | "medium" | "high" | "xhigh";
  elapsedMs: number;
  range: { base: string; head: string; source: string } | null;
  health: {
    range: LintPhaseHealth;
    diff: LintPhaseHealth;
    invariantSource: LintPhaseHealth;
    invariantVectors: LintPhaseHealth;
    hunkVectors: LintPhaseHealth;
    judge: LintPhaseHealth;
  };
  counters: {
    hunks: number;
    invariants: number;
    candidates: number;
    attempted: number;
    resolved: number;
    unresolved: number;
    notAttempted: number;
    semanticCalls: number;
    transportAttempts: number;
  };
  candidates: LintCandidateOutcome[];
  findings: LintFinding[];
  gate: SerializedLintGate;
}

export interface CoreLintResultLike {
  status: LintStatus;
  range: NonNullable<SemanticLintReport["range"]>;
  health: {
    diff: LintPhaseHealth;
    invariantVectors: LintPhaseHealth;
    hunkVectors: LintPhaseHealth;
    judge: LintPhaseHealth;
  };
  hunks: number;
  invariants: number;
  candidates: number;
  attempted: number;
  resolved: number;
  unresolved: number;
  notAttempted: number;
  semanticCalls: number;
  transportAttempts: number;
  candidateOutcomes: Array<
    Omit<LintCandidateOutcome, "state"> & {
      state: LintCandidateOutcome["state"];
    }
  >;
  findings: Array<Omit<LintFinding, "id">>;
}

export interface CoreGateLike {
  mode: "advisory" | "gate";
  blocking: Array<{ invariantId: string; file: string }>;
  overridden: Array<{
    finding: { invariantId: string; file: string };
    override: { reason: string };
  }>;
  advisory: Array<{ invariantId: string; file: string }>;
}

const PHASE_ORDER = [
  "range",
  "diff",
  "invariantSource",
  "invariantVectors",
  "hunkVectors",
  "judge",
] as const;

const VERDICTS = new Set(["violates", "fixes", "satisfies", "unrelated"]);
export const MAX_LINT_REPORT_CANDIDATES = 20;
export const MAX_LINT_REPORT_FAILURE_MESSAGE_LENGTH = 400;
export const MAX_LINT_REPORT_RESOLVED_REASON_LENGTH = 400;
const CANDIDATE_FAILURE_CODES = new Set([
  "no-auth",
  "auth-rejected",
  "route-unavailable",
  "protocol-mismatch",
  "model-unsupported",
  "api-unsupported",
  "rate-limit",
  "timeout",
  "network",
  "invalid-body",
  "response-too-large",
  "incomplete-response",
  "empty-response",
  "abort",
  "transport-error",
  "invalid-verdict",
  "judge-contract-error",
  "semantic-budget-exhausted",
]);
const PHASE_FAILURE_CODES = new Set([
  "range-resolution-failed",
  "diff-command-failed",
  "invariant-source-read-failed",
  "invariant-source-import-failed",
  "invariant-vector-load-failed",
  "hunk-vectors-all-missing",
  "hunk-vector-embedding-failed",
  "deadline-exceeded",
  "runtime-error",
]);

function findingKey(finding: { invariantId: string; file: string }): string {
  return `${finding.invariantId}\x1f${finding.file}`;
}

function clonePhase(phase: LintPhaseHealth): LintPhaseHealth {
  return {
    ...phase,
    ...(phase.failure ? { failure: { ...phase.failure } } : {}),
  };
}

function deriveStatus(report: Pick<SemanticLintReport, "health">): LintStatus {
  const statuses = PHASE_ORDER.map((phase) => report.health[phase].status);
  if (statuses.includes("failed")) return "failed";
  if (statuses.includes("degraded")) return "partial";
  return "complete";
}

export function buildSemanticLintReport(input: {
  result: CoreLintResultLike;
  gate: CoreGateLike;
  model: string;
  effort: SemanticLintReport["effort"];
  elapsedMs: number;
  invariantSource: LintPhaseHealth;
}): SemanticLintReport {
  const findings: LintFinding[] = input.result.findings.map(
    (finding, index) => ({
      id: `finding-${String(index + 1).padStart(2, "0")}`,
      ...finding,
    }),
  );
  const findingIdsByKey = new Map(
    findings.map((finding) => [findingKey(finding), finding.id]),
  );
  const ids = (
    values: Array<{ invariantId: string; file: string }>,
  ): string[] =>
    values
      .map((value) => findingIdsByKey.get(findingKey(value)))
      .filter((id): id is string => id !== undefined);
  const blocking = ids(input.gate.blocking);
  const overridden = input.gate.overridden
    .map(({ finding, override }) => {
      const findingId = findingIdsByKey.get(findingKey(finding));
      return findingId ? { findingId, reason: override.reason } : null;
    })
    .filter(
      (value): value is { findingId: string; reason: string } => value !== null,
    );
  const overriddenIds = new Set(overridden.map((value) => value.findingId));
  const advisoryFromCore = ids(input.gate.advisory);
  const blockingFindingIds = input.gate.mode === "gate" ? blocking : [];
  const advisoryFindingIds = findings
    .map((finding) => finding.id)
    .filter((id) => !blockingFindingIds.includes(id) && !overriddenIds.has(id));
  for (const id of advisoryFromCore) {
    if (!advisoryFindingIds.includes(id) && !overriddenIds.has(id)) {
      advisoryFindingIds.push(id);
    }
  }

  const invariantVectors = clonePhase(input.result.health.invariantVectors);
  let invariantSource = clonePhase(input.invariantSource);
  if (invariantVectors.failure?.code === "invariant-source-read-failed") {
    invariantSource = {
      status: "failed",
      failure: invariantVectors.failure,
    };
    Object.assign(invariantVectors, {
      status: "not-run",
      expected: 0,
      available: 0,
      missing: 0,
      failure: undefined,
    });
  }

  const report: SemanticLintReport = {
    schemaVersion: 1,
    status: input.result.status,
    model: input.model,
    effort: input.effort,
    elapsedMs: input.elapsedMs,
    range: { ...input.result.range },
    health: {
      range: { status: "healthy" },
      diff: clonePhase(input.result.health.diff),
      invariantSource,
      invariantVectors,
      hunkVectors: clonePhase(input.result.health.hunkVectors),
      judge: clonePhase(input.result.health.judge),
    },
    counters: {
      hunks: input.result.hunks,
      invariants: input.result.invariants,
      candidates: input.result.candidates,
      attempted: input.result.attempted,
      resolved: input.result.resolved,
      unresolved: input.result.unresolved,
      notAttempted: input.result.notAttempted,
      semanticCalls: input.result.semanticCalls,
      transportAttempts: input.result.transportAttempts,
    },
    candidates: input.result.candidateOutcomes.map((candidate) => ({
      id: candidate.id,
      file: candidate.file,
      invariantId: candidate.invariantId,
      invariantTitle: candidate.invariantTitle,
      state: candidate.state,
      ...(candidate.verdict !== undefined
        ? { verdict: candidate.verdict }
        : {}),
      ...(candidate.reason !== undefined ? { reason: candidate.reason } : {}),
      stats: { ...candidate.stats },
      ...(candidate.failure ? { failure: { ...candidate.failure } } : {}),
    })),
    findings,
    gate: {
      mode: input.gate.mode,
      blockingFindingIds,
      overridden,
      advisoryFindingIds,
      wouldBlockFindingIds: blocking,
    },
  };
  report.status = deriveStatus(report);
  return validateSemanticLintReport(report);
}

function notRunHealth(): LintPhaseHealth {
  return { status: "not-run" };
}

export function failedSemanticLintReport(input: {
  model: string;
  effort: SemanticLintReport["effort"];
  elapsedMs: number;
  range?: SemanticLintReport["range"];
  failedPhase: (typeof PHASE_ORDER)[number];
  failure: LintFailure;
  gateMode: "advisory" | "gate";
}): SemanticLintReport {
  const health = Object.fromEntries(
    PHASE_ORDER.map((phase) => [phase, notRunHealth()]),
  ) as SemanticLintReport["health"];
  health.judge = {
    status: "not-run",
    selected: 0,
    resolved: 0,
    unresolved: 0,
    notAttempted: 0,
  };
  const failedIndex = PHASE_ORDER.indexOf(input.failedPhase);
  for (let index = 0; index < failedIndex; index++) {
    health[PHASE_ORDER[index]] = { status: "healthy" };
  }
  health[input.failedPhase] = {
    status: "failed",
    failure: input.failure,
    ...(input.failedPhase === "judge"
      ? { selected: 0, resolved: 0, unresolved: 0, notAttempted: 0 }
      : {}),
  };
  return validateSemanticLintReport({
    schemaVersion: 1,
    status: "failed",
    model: input.model,
    effort: input.effort,
    elapsedMs: input.elapsedMs,
    range: input.range ?? null,
    health,
    counters: {
      hunks: 0,
      invariants: 0,
      candidates: 0,
      attempted: 0,
      resolved: 0,
      unresolved: 0,
      notAttempted: 0,
      semanticCalls: 0,
      transportAttempts: 0,
    },
    candidates: [],
    findings: [],
    gate: {
      mode: input.gateMode,
      blockingFindingIds: [],
      overridden: [],
      advisoryFindingIds: [],
      wouldBlockFindingIds: [],
    },
  });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition)
    throw new TypeError(`Invalid semantic lint report: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertCount(value: unknown, name: string): asserts value is number {
  assert(
    Number.isSafeInteger(value) && Number(value) >= 0,
    `${name} must be a non-negative integer`,
  );
}

function validateFailure(value: unknown, candidate: boolean): void {
  assert(isRecord(value), "failure must be an object");
  assert(typeof value.code === "string", "failure.code must be a string");
  assert(
    (candidate ? CANDIDATE_FAILURE_CODES : PHASE_FAILURE_CODES).has(value.code),
    `unknown failure code ${value.code}`,
  );
  assert(
    typeof value.message === "string" &&
      value.message.trim().length > 0 &&
      value.message.length <= MAX_LINT_REPORT_FAILURE_MESSAGE_LENGTH,
    `failure.message must contain 1-${MAX_LINT_REPORT_FAILURE_MESSAGE_LENGTH} characters`,
  );
  if (candidate) {
    assert(
      value.scope === "candidate" || value.scope === "run",
      "candidate failure scope is invalid",
    );
  }
}

export function validateSemanticLintReport(value: unknown): SemanticLintReport {
  assert(isRecord(value), "root must be an object");
  assert(value.schemaVersion === 1, "schemaVersion must be 1");
  assert(
    value.status === "complete" ||
      value.status === "partial" ||
      value.status === "failed",
    "status is invalid",
  );
  assert(
    typeof value.model === "string" && value.model.length > 0,
    "model is required",
  );
  assert(
    ["off", "low", "medium", "high", "xhigh"].includes(String(value.effort)),
    "effort is invalid",
  );
  assertCount(value.elapsedMs, "elapsedMs");
  assert(
    value.range === null || isRecord(value.range),
    "range must be an object or null",
  );
  if (isRecord(value.range)) {
    for (const key of ["base", "head", "source"]) {
      assert(
        typeof value.range[key] === "string" && value.range[key].length > 0,
        `range.${key} is required`,
      );
    }
  }

  assert(isRecord(value.health), "health is required");
  let failedSeen = false;
  for (const phase of PHASE_ORDER) {
    const health = value.health[phase];
    assert(isRecord(health), `health.${phase} is required`);
    assert(
      ["healthy", "degraded", "failed", "not-run"].includes(
        String(health.status),
      ),
      `health.${phase}.status is invalid`,
    );
    if (failedSeen)
      assert(
        health.status === "not-run",
        `${phase} must be not-run after a failed phase`,
      );
    if (health.status === "failed") {
      if (phase === "judge" && health.failure === undefined) {
        // Judge causes are carried by candidate records, not duplicated here.
      } else {
        validateFailure(health.failure, false);
      }
      failedSeen = true;
    } else {
      assert(
        health.failure === undefined,
        `health.${phase}.failure is only valid when failed`,
      );
    }
    for (const field of [
      "expected",
      "available",
      "missing",
      "selected",
      "resolved",
      "unresolved",
      "notAttempted",
    ]) {
      if (health[field] !== undefined)
        assertCount(health[field], `health.${phase}.${field}`);
    }
    if (phase === "judge") {
      for (const field of [
        "selected",
        "resolved",
        "unresolved",
        "notAttempted",
      ] as const) {
        assertCount(health[field], `health.judge.${field}`);
      }
    }
    if (health.expected !== undefined) {
      assert(
        Number(health.expected) ===
          Number(health.available ?? 0) + Number(health.missing ?? 0),
        `health.${phase} vector counts do not add up`,
      );
    }
  }
  assert(
    (value.health.range as Record<string, unknown>).status ===
      (value.range ? "healthy" : "failed"),
    "range and range health disagree",
  );

  assert(isRecord(value.counters), "counters is required");
  const counterNames = [
    "hunks",
    "invariants",
    "candidates",
    "attempted",
    "resolved",
    "unresolved",
    "notAttempted",
    "semanticCalls",
    "transportAttempts",
  ] as const;
  for (const name of counterNames)
    assertCount(value.counters[name], `counters.${name}`);
  assert(
    value.counters.candidates ===
      Number(value.counters.attempted) + Number(value.counters.notAttempted),
    "candidates must equal attempted + notAttempted",
  );
  assert(
    value.counters.attempted ===
      Number(value.counters.resolved) + Number(value.counters.unresolved),
    "attempted must equal resolved + unresolved",
  );
  const invariantVectorHealth = value.health.invariantVectors as Record<
    string,
    unknown
  >;
  const hunkVectorHealth = value.health.hunkVectors as Record<string, unknown>;
  const judgeHealth = value.health.judge as Record<string, unknown>;
  if (invariantVectorHealth.expected !== undefined) {
    assert(
      invariantVectorHealth.expected === value.counters.invariants,
      "invariant vector health disagrees with invariant counter",
    );
  }
  if (hunkVectorHealth.expected !== undefined) {
    assert(
      hunkVectorHealth.expected === value.counters.hunks,
      "hunk vector health disagrees with hunk counter",
    );
  }
  assert(
    judgeHealth.selected === value.counters.candidates &&
      judgeHealth.resolved === value.counters.resolved &&
      judgeHealth.unresolved === value.counters.unresolved &&
      judgeHealth.notAttempted === value.counters.notAttempted,
    "judge health disagrees with funnel counters",
  );
  if (judgeHealth.status === "not-run") {
    assert(
      value.counters.candidates === 0,
      "not-run judge cannot have candidate outcomes",
    );
  } else if (
    !(
      judgeHealth.status === "failed" &&
      value.counters.candidates === 0 &&
      judgeHealth.failure !== undefined
    )
  ) {
    const expectedJudgeStatus =
      value.counters.candidates === 0 ||
      value.counters.resolved === value.counters.candidates
        ? "healthy"
        : value.counters.resolved === 0
          ? "failed"
          : "degraded";
    assert(
      judgeHealth.status === expectedJudgeStatus,
      "judge status disagrees with candidate outcomes",
    );
  }

  assert(
    Array.isArray(value.candidates) &&
      value.candidates.length <= MAX_LINT_REPORT_CANDIDATES,
    `candidates must be an array of at most ${MAX_LINT_REPORT_CANDIDATES} records`,
  );
  assert(
    value.candidates.length === value.counters.candidates,
    "candidate record count disagrees with counters",
  );
  const candidateIds = new Set<string>();
  const stateCounts = { resolved: 0, unresolved: 0, "not-attempted": 0 };
  let semanticCalls = 0;
  let transportAttempts = 0;
  for (const candidate of value.candidates) {
    assert(isRecord(candidate), "candidate must be an object");
    assert(
      typeof candidate.id === "string" &&
        candidate.id.length > 0 &&
        !candidateIds.has(candidate.id),
      "candidate IDs must be unique non-empty strings",
    );
    candidateIds.add(candidate.id);
    assert(
      typeof candidate.file === "string" && candidate.file.length > 0,
      "candidate.file is required",
    );
    assert(
      typeof candidate.invariantId === "string" &&
        candidate.invariantId.length > 0,
      "candidate.invariantId is required",
    );
    assert(
      typeof candidate.invariantTitle === "string",
      "candidate.invariantTitle is required",
    );
    assert(
      candidate.state === "resolved" ||
        candidate.state === "unresolved" ||
        candidate.state === "not-attempted",
      "candidate.state is invalid",
    );
    stateCounts[candidate.state]++;
    assert(isRecord(candidate.stats), "candidate.stats is required");
    assertCount(candidate.stats.semanticCalls, "candidate.stats.semanticCalls");
    assertCount(
      candidate.stats.transportAttempts,
      "candidate.stats.transportAttempts",
    );
    semanticCalls += candidate.stats.semanticCalls;
    transportAttempts += candidate.stats.transportAttempts;
    if (candidate.state === "resolved") {
      assert(
        VERDICTS.has(String(candidate.verdict)),
        "resolved candidate verdict is invalid",
      );
      assert(
        typeof candidate.reason === "string" &&
          candidate.reason.trim().length > 0 &&
          candidate.reason.length <= MAX_LINT_REPORT_RESOLVED_REASON_LENGTH,
        `resolved candidate reason must contain 1-${MAX_LINT_REPORT_RESOLVED_REASON_LENGTH} characters`,
      );
      assert(
        candidate.failure === undefined,
        "resolved candidate cannot have a failure",
      );
    } else {
      validateFailure(candidate.failure, true);
      assert(
        candidate.verdict === undefined && candidate.reason === undefined,
        "unresolved candidate cannot have a verdict",
      );
    }
    if (candidate.state === "not-attempted") {
      assert(
        candidate.stats.semanticCalls === 0 &&
          candidate.stats.transportAttempts === 0,
        "not-attempted candidate stats must be zero",
      );
    }
  }
  assert(
    stateCounts.resolved === value.counters.resolved,
    "resolved candidate count disagrees with counters",
  );
  assert(
    stateCounts.unresolved === value.counters.unresolved,
    "unresolved candidate count disagrees with counters",
  );
  assert(
    stateCounts["not-attempted"] === value.counters.notAttempted,
    "not-attempted candidate count disagrees with counters",
  );
  assert(
    semanticCalls === value.counters.semanticCalls,
    "candidate semantic calls do not sum to report total",
  );
  assert(
    transportAttempts === value.counters.transportAttempts,
    "candidate transport attempts do not sum to report total",
  );

  assert(Array.isArray(value.findings), "findings must be an array");
  const findingIds = new Set<string>();
  for (const finding of value.findings) {
    assert(isRecord(finding), "finding must be an object");
    assert(
      typeof finding.id === "string" &&
        finding.id.length > 0 &&
        !findingIds.has(finding.id),
      "finding IDs must be unique non-empty strings",
    );
    findingIds.add(finding.id);
    for (const field of [
      "invariantId",
      "invariantTitle",
      "invariantContent",
      "file",
      "hunk",
    ]) {
      assert(
        typeof finding[field] === "string",
        `finding.${field} must be a string`,
      );
    }
    assert(
      ["advisory", "soft", "strict"].includes(String(finding.severity)),
      "finding.severity is invalid",
    );
  }

  assert(isRecord(value.gate), "gate is required");
  assert(
    value.gate.mode === "advisory" || value.gate.mode === "gate",
    "gate.mode is invalid",
  );
  for (const field of [
    "blockingFindingIds",
    "advisoryFindingIds",
    "wouldBlockFindingIds",
  ]) {
    assert(Array.isArray(value.gate[field]), `gate.${field} must be an array`);
    for (const id of value.gate[field])
      assert(
        typeof id === "string" && findingIds.has(id),
        `gate.${field} has an unknown finding ID`,
      );
  }
  assert(
    Array.isArray(value.gate.overridden),
    "gate.overridden must be an array",
  );
  const blockingFindingIds = value.gate.blockingFindingIds as string[];
  const advisoryFindingIds = value.gate.advisoryFindingIds as string[];
  const wouldBlockFindingIds = value.gate.wouldBlockFindingIds as string[];
  const overridden = value.gate.overridden as unknown[];
  const classified = new Set<string>();
  for (const id of [...blockingFindingIds, ...advisoryFindingIds]) {
    assert(!classified.has(id), "gate finding classifications overlap");
    classified.add(id);
  }
  for (const item of overridden) {
    assert(
      isRecord(item) &&
        typeof item.findingId === "string" &&
        findingIds.has(item.findingId),
      "gate override refers to an unknown finding",
    );
    assert(
      typeof item.reason === "string" && item.reason.trim().length > 0,
      "gate override reason is required",
    );
    assert(
      !classified.has(item.findingId),
      "gate finding classifications overlap",
    );
    const finding = (value.findings as Array<Record<string, unknown>>).find(
      (candidate) => candidate.id === item.findingId,
    );
    assert(
      finding?.severity === "soft",
      "only soft findings can be overridden",
    );
    classified.add(item.findingId);
  }
  assert(
    classified.size === findingIds.size,
    "gate must classify every finding exactly once",
  );
  const overriddenIds = new Set(
    overridden.map((item) => (item as Record<string, unknown>).findingId),
  );
  const expectedWouldBlock = (value.findings as Array<Record<string, unknown>>)
    .filter(
      (finding) =>
        finding.severity !== "advisory" && !overriddenIds.has(finding.id),
    )
    .map((finding) => finding.id as string);
  const sameIds = (actual: string[], expected: string[]): boolean =>
    actual.length === expected.length &&
    new Set(actual).size === actual.length &&
    expected.every((id) => actual.includes(id));
  assert(
    sameIds(wouldBlockFindingIds, expectedWouldBlock),
    "gate would-block findings disagree with finding severities",
  );
  if (value.gate.mode === "advisory") {
    assert(
      blockingFindingIds.length === 0,
      "advisory reports cannot contain blocking findings",
    );
    assert(
      sameIds(
        advisoryFindingIds,
        (value.findings as Array<Record<string, unknown>>)
          .filter((finding) => !overriddenIds.has(finding.id))
          .map((finding) => finding.id as string),
      ),
      "advisory report classifications disagree with findings",
    );
  } else {
    assert(
      sameIds(blockingFindingIds, expectedWouldBlock),
      "gate blocking findings disagree with finding severities",
    );
    assert(
      sameIds(
        advisoryFindingIds,
        (value.findings as Array<Record<string, unknown>>)
          .filter((finding) => finding.severity === "advisory")
          .map((finding) => finding.id as string),
      ),
      "gate advisory findings disagree with finding severities",
    );
  }

  const report = value as unknown as SemanticLintReport;
  assert(
    report.status === deriveStatus(report),
    "overall status disagrees with phase health",
  );
  if (report.status === "complete") {
    assert(
      PHASE_ORDER.every((phase) => report.health[phase].status === "healthy"),
      "complete report contains an unhealthy phase",
    );
    assert(
      report.counters.unresolved === 0 && report.counters.notAttempted === 0,
      "complete report contains unresolved or not-attempted candidates",
    );
  }
  return report;
}

export async function writeSemanticLintReport(
  path: string,
  report: SemanticLintReport,
): Promise<void> {
  const valid = validateSemanticLintReport(report);
  const target = resolve(path);
  const parent = dirname(target);
  await mkdir(parent, { recursive: true });
  const temporary = resolve(
    parent,
    `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, `${JSON.stringify(valid, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

export function semanticLintExitCode(report: SemanticLintReport): 0 | 2 | 3 {
  if (report.status !== "complete") return 3;
  return report.gate.mode === "gate" &&
    report.gate.blockingFindingIds.length > 0
    ? 2
    : 0;
}

export function renderSemanticLintReport(report: SemanticLintReport): string {
  const { counters } = report;
  const lines = [
    "",
    "─".repeat(64),
    `Status: ${report.status.toUpperCase()}   Model: ${report.model}   Effort: ${report.effort}`,
    `Funnel: ${counters.hunks} hunks × ${counters.invariants} invariants → ${counters.candidates} candidates`,
    `Checks: ${counters.resolved} resolved, ${counters.unresolved} unresolved, ${counters.notAttempted} not attempted · ${(report.elapsedMs / 1000).toFixed(1)}s`,
    "─".repeat(64),
  ];
  if (report.status === "complete" && report.findings.length === 0) {
    lines.push("", "✓ No suspected invariant violations.");
  } else if (report.findings.length === 0) {
    lines.push(
      "",
      "⚠ Semantic lint is inconclusive; no clean result was produced.",
    );
  } else {
    lines.push(
      "",
      `⚠ ${report.findings.length} suspected invariant violation${report.findings.length === 1 ? "" : "s"}:`,
    );
    for (const finding of report.findings) {
      lines.push(
        `  • [${finding.severity}] ${finding.invariantTitle} [${finding.file}]`,
        `    ${finding.reason ?? "possible contradiction"}`,
      );
    }
  }
  if (report.status !== "complete") {
    const causes = new Map<string, number>();
    for (const candidate of report.candidates) {
      if (candidate.failure)
        causes.set(
          candidate.failure.code,
          (causes.get(candidate.failure.code) ?? 0) + 1,
        );
    }
    for (const phase of PHASE_ORDER) {
      const failure = report.health[phase].failure;
      if (failure)
        causes.set(failure.code, (causes.get(failure.code) ?? 0) + 1);
    }
    for (const [code, count] of causes) lines.push(`  • ${code}: ${count}`);
  }
  return lines.join("\n");
}
