#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";

const [path, gateRaw = "false", exitRaw = "1"] = process.argv.slice(2);
const gateMode = gateRaw === "true";
const cliExit = Number(exitRaw);
const summaryFile = process.env.GITHUB_STEP_SUMMARY;
const summaryCellMaxChars = 300;
const MAX_LINT_REPORT_FINDINGS = 200;
const MAX_LINT_REPORT_CANDIDATES = 20;
const MAX_LINT_REPORT_FAILURE_MESSAGE_LENGTH = 400;
const MAX_LINT_REPORT_RESOLVED_REASON_LENGTH = 400;
const MAX_REPORT_JUDGE_CALLS = 20;
const MAX_REPORT_VERIFIER_CALLS = 8;
const MAX_REPORT_COUNTEREVIDENCE_INPUT_TOKENS = 16_000;
const candidateFailureCodes = new Set([
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
  "verification-budget-exhausted",
  "insufficient-context",
]);
const phaseFailureCodes = new Set([
  "range-resolution-failed",
  "diff-command-failed",
  "diff-too-large",
  "untrusted-context-gate-disabled",
  "invariant-source-read-failed",
  "invariant-source-import-failed",
  "embedding-provider-readiness-failed",
  "invariant-vector-load-failed",
  "hunk-vectors-all-missing",
  "hunk-vector-embedding-failed",
  "deadline-exceeded",
  "runtime-error",
]);

function esc(value) {
  return String(value ?? "")
    .replace(/%/g, "%25")
    .replace(/\r/g, "%0D")
    .replace(/\n/g, "%0A");
}

function escProp(value) {
  return esc(value).replace(/,/g, "%2C").replace(/:/g, "%3A");
}

function cell(value) {
  const raw = String(value ?? "")
    .replace(/\r?\n/g, " ")
    .trim();
  const bounded =
    raw.length > summaryCellMaxChars
      ? `${raw.slice(0, summaryCellMaxChars - 1)}…`
      : raw;
  return bounded
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/:/g, "&#58;")
    .replace(/@/g, "&#64;")
    .replace(/([\\`*_[\]{}()#+.!|~])/g, "\\$1")
    .trim();
}

function annotation(level, title, message, properties = "") {
  const prefix = properties ? ` ${properties},` : " ";
  console.log(`::${level}${prefix}title=${escProp(title)}::${esc(message)}`);
}

function count(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative integer`);
  }
}

function tupleKey(...values) {
  return JSON.stringify(values);
}

function validateCoverage(coverage, counters) {
  if (!coverage || typeof coverage !== "object" || Array.isArray(coverage)) {
    throw new TypeError("coverage must be an object");
  }
  if (!["none", "isolated-hunk", "holistic"].includes(coverage.strategy)) {
    throw new TypeError("invalid coverage strategy");
  }
  if (typeof coverage.contextComplete !== "boolean") {
    throw new TypeError("invalid coverage contextComplete");
  }
  for (const name of [
    "inputTokens",
    "inputTokenBudget",
    "availableHunks",
    "includedHunks",
    "omittedHunks",
    "availableInvariants",
    "includedInvariants",
    "omittedInvariants",
  ]) {
    count(coverage[name], `coverage.${name}`);
  }
  if (coverage.inputTokenBudget <= 0) {
    throw new TypeError("coverage input-token budget must be positive");
  }
  if (
    coverage.availableHunks !== counters.hunks ||
    coverage.includedHunks > coverage.availableHunks ||
    coverage.omittedHunks !== coverage.availableHunks - coverage.includedHunks
  ) {
    throw new TypeError("coverage hunk coverage disagrees with counters");
  }
  if (
    coverage.includedInvariants > coverage.availableInvariants ||
    coverage.omittedInvariants !==
      coverage.availableInvariants - coverage.includedInvariants
  ) {
    throw new TypeError("coverage invariant coverage does not add up");
  }
  if (coverage.strategy === "holistic") {
    if (
      !coverage.contextComplete ||
      coverage.includedHunks !== coverage.availableHunks ||
      coverage.inputTokens > coverage.inputTokenBudget
    ) {
      throw new TypeError("holistic semantic lint coverage is incomplete");
    }
  } else if (coverage.contextComplete) {
    throw new TypeError("non-holistic lint cannot claim complete context");
  }
}

function validateVerification(summary) {
  if (
    !summary ||
    typeof summary !== "object" ||
    Array.isArray(summary) ||
    !["none", "counterevidence"].includes(summary.strategy) ||
    typeof summary.contextComplete !== "boolean"
  ) {
    throw new TypeError("invalid verification summary");
  }
  for (const name of [
    "selected",
    "attempted",
    "confirmed",
    "cleared",
    "unresolved",
    "notAttempted",
    "semanticCalls",
    "transportAttempts",
    "inputTokens",
    "inputTokenBudget",
  ]) {
    count(summary[name], `verification.${name}`);
  }
  if (summary.selected !== summary.attempted + summary.notAttempted) {
    throw new TypeError("verification selected count does not add up");
  }
  if (
    summary.attempted !==
    summary.confirmed + summary.cleared + summary.unresolved
  ) {
    throw new TypeError("verification attempted count does not add up");
  }
  if (summary.strategy === "none") {
    if (
      summary.contextComplete ||
      summary.selected !== 0 ||
      summary.semanticCalls !== 0 ||
      summary.transportAttempts !== 0 ||
      summary.inputTokens !== 0 ||
      summary.inputTokenBudget !== 0
    ) {
      throw new TypeError("empty verification summary contains work");
    }
  } else if (
    summary.inputTokenBudget <= 0 ||
    summary.inputTokenBudget !==
      summary.selected * MAX_REPORT_COUNTEREVIDENCE_INPUT_TOKENS ||
    summary.semanticCalls > MAX_REPORT_VERIFIER_CALLS ||
    summary.inputTokens > summary.inputTokenBudget
  ) {
    throw new TypeError("verification input accounting exceeds its budget");
  }
}

function validateCandidateVerification(verification, candidate) {
  if (
    !verification ||
    typeof verification !== "object" ||
    Array.isArray(verification) ||
    !["confirmed", "cleared", "unresolved", "not-attempted"].includes(
      verification.state,
    ) ||
    typeof verification.contextComplete !== "boolean"
  ) {
    throw new TypeError("invalid candidate verification");
  }
  count(verification.inputTokens, "candidate verification inputTokens");
  count(
    verification.stats?.semanticCalls,
    "candidate verification semanticCalls",
  );
  count(
    verification.stats?.transportAttempts,
    "candidate verification transportAttempts",
  );
  if (verification.inputTokens > MAX_REPORT_COUNTEREVIDENCE_INPUT_TOKENS) {
    throw new TypeError(
      "candidate verification inputTokens exceeds its budget",
    );
  }
  if (verification.stats.semanticCalls > 2) {
    throw new TypeError(
      "candidate verification semantic calls exceed its per-candidate budget",
    );
  }
  if (
    !candidate.stats ||
    candidate.stats.semanticCalls < verification.stats.semanticCalls ||
    candidate.stats.transportAttempts < verification.stats.transportAttempts
  ) {
    throw new TypeError("candidate stats must include verification stats");
  }
  if (verification.state === "confirmed" || verification.state === "cleared") {
    if (!verification.contextComplete) {
      throw new TypeError(
        "confirmed or cleared verification requires complete context",
      );
    }
    if (verification.stats.semanticCalls < 1) {
      throw new TypeError(
        "confirmed or cleared verification requires a semantic call",
      );
    }
    if (candidate.state !== "resolved" || candidate.verdict !== "violates") {
      throw new TypeError("verification requires a violated candidate");
    }
    if (
      typeof verification.reason !== "string" ||
      verification.reason.trim().length === 0 ||
      verification.reason.length > MAX_LINT_REPORT_RESOLVED_REASON_LENGTH
    ) {
      throw new TypeError("candidate verification reason is invalid");
    }
    if (
      !Array.isArray(verification.evidence) ||
      verification.evidence.length === 0 ||
      verification.evidence.length > 4
    ) {
      throw new TypeError("candidate verification evidence is invalid");
    }
    for (const evidence of verification.evidence) {
      if (
        !evidence ||
        typeof evidence !== "object" ||
        typeof evidence.hunkId !== "string" ||
        evidence.hunkId.length === 0 ||
        typeof evidence.reason !== "string" ||
        evidence.reason.trim().length === 0 ||
        evidence.reason.length > MAX_LINT_REPORT_RESOLVED_REASON_LENGTH
      ) {
        throw new TypeError("candidate verification evidence is invalid");
      }
    }
    if (verification.failure !== undefined) {
      throw new TypeError("confirmed or cleared verification cannot fail");
    }
  } else {
    if (candidate.state !== "unresolved") {
      throw new TypeError(
        "unresolved verification requires an unresolved candidate",
      );
    }
    if (
      verification.reason !== undefined ||
      verification.evidence !== undefined ||
      !candidateFailureCodes.has(verification.failure?.code) ||
      typeof verification.failure?.message !== "string" ||
      verification.failure.message.trim().length === 0 ||
      verification.failure.message.length >
        MAX_LINT_REPORT_FAILURE_MESSAGE_LENGTH ||
      !["candidate", "run"].includes(verification.failure.scope)
    ) {
      throw new TypeError("unresolved verification requires a scoped failure");
    }
    if (
      verification.failure.retryable !== undefined &&
      typeof verification.failure.retryable !== "boolean"
    ) {
      throw new TypeError("candidate failure retryable must be a boolean");
    }
    if (
      verification.state === "not-attempted" &&
      (verification.stats.semanticCalls !== 0 ||
        verification.stats.transportAttempts !== 0)
    ) {
      throw new TypeError("not-attempted verification stats must be zero");
    }
  }
}

function validateReport(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("report root must be an object");
  }
  if (value.schemaVersion !== 4)
    throw new TypeError("unsupported schemaVersion");
  if (!["complete", "partial", "failed"].includes(value.status)) {
    throw new TypeError("invalid status");
  }
  if (!value.health || !value.counters || !value.gate || !value.verification) {
    throw new TypeError(
      "health, counters, gate, and verification are required",
    );
  }
  if (typeof value.model !== "string" || !value.model)
    throw new TypeError("model is required");
  if (!["off", "low", "medium", "high", "xhigh"].includes(value.effort))
    throw new TypeError("invalid effort");
  count(value.elapsedMs, "elapsedMs");
  if (
    value.range !== null &&
    (!value.range ||
      typeof value.range.base !== "string" ||
      value.range.base.length === 0 ||
      typeof value.range.head !== "string" ||
      value.range.head.length === 0 ||
      typeof value.range.source !== "string" ||
      value.range.source.length === 0)
  ) {
    throw new TypeError("invalid range");
  }
  const phases = [
    "range",
    "diff",
    "invariantSource",
    "invariantVectors",
    "hunkVectors",
    "judge",
  ];
  let failedSeen = false;
  let degraded = false;
  for (const phase of phases) {
    const status = value.health[phase]?.status;
    if (!["healthy", "degraded", "failed", "not-run"].includes(status)) {
      throw new TypeError(`invalid ${phase} health`);
    }
    if (failedSeen && status !== "not-run") {
      throw new TypeError(`${phase} must be not-run after failure`);
    }
    if (status === "failed") failedSeen = true;
    if (status === "degraded") degraded = true;
    const health = value.health[phase];
    if (health.failure !== undefined) {
      if (status !== "failed") {
        throw new TypeError(`${phase} failure is only valid for failed health`);
      }
      if (
        !phaseFailureCodes.has(health.failure?.code) ||
        typeof health.failure?.message !== "string" ||
        health.failure.message.trim().length === 0 ||
        health.failure.message.length > MAX_LINT_REPORT_FAILURE_MESSAGE_LENGTH
      ) {
        throw new TypeError(`invalid ${phase} failure`);
      }
      if (
        health.failure.retryable !== undefined &&
        typeof health.failure.retryable !== "boolean"
      ) {
        throw new TypeError(`${phase} failure retryable must be a boolean`);
      }
    } else if (status === "failed" && phase !== "judge") {
      throw new TypeError(`${phase} failure details are required`);
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
        count(health[field], `${phase}.${field}`);
    }
    if (
      health.expected !== undefined &&
      health.expected !== (health.available ?? 0) + (health.missing ?? 0)
    ) {
      throw new TypeError(`${phase} vector counts disagree`);
    }
  }
  const coveragePartial =
    value.coverage?.strategy === "isolated-hunk" ||
    (value.coverage?.omittedInvariants ?? 0) > 0;
  const derivedStatus = failedSeen
    ? "failed"
    : degraded || coveragePartial
      ? "partial"
      : "complete";
  if (value.status !== derivedStatus)
    throw new TypeError("status disagrees with phase health");
  if ((value.range !== null) !== (value.health.range.status === "healthy")) {
    throw new TypeError("range and range health disagree");
  }

  const counters = value.counters;
  validateCoverage(value.coverage, counters);
  validateVerification(value.verification);
  for (const name of [
    "hunks",
    "invariants",
    "candidates",
    "attempted",
    "resolved",
    "unresolved",
    "notAttempted",
    "semanticCalls",
    "transportAttempts",
  ]) {
    count(counters[name], `counters.${name}`);
  }
  if (counters.semanticCalls > MAX_REPORT_JUDGE_CALLS) {
    throw new TypeError(
      "counters.semanticCalls exceeds the shared semantic-call budget",
    );
  }
  if (counters.candidates !== counters.attempted + counters.notAttempted) {
    throw new TypeError("candidates != attempted + notAttempted");
  }
  if (counters.attempted !== counters.resolved + counters.unresolved) {
    throw new TypeError("attempted != resolved + unresolved");
  }
  const invariantVectorHealth = value.health.invariantVectors;
  const hunkVectorHealth = value.health.hunkVectors;
  const judgeHealth = value.health.judge;
  for (const field of ["selected", "resolved", "unresolved", "notAttempted"]) {
    if (judgeHealth[field] === undefined) {
      throw new TypeError(`judge.${field} is required`);
    }
  }
  if (
    invariantVectorHealth.expected !== undefined &&
    invariantVectorHealth.expected !== counters.invariants
  ) {
    throw new TypeError("invariant vector health disagrees with counters");
  }
  if (
    hunkVectorHealth.expected !== undefined &&
    counters.invariants > 0 &&
    hunkVectorHealth.expected !== counters.hunks
  ) {
    throw new TypeError("hunk vector health disagrees with counters");
  }
  if (
    judgeHealth.selected !== counters.candidates ||
    judgeHealth.resolved !== counters.resolved ||
    judgeHealth.unresolved !== counters.unresolved ||
    judgeHealth.notAttempted !== counters.notAttempted
  ) {
    throw new TypeError("judge health disagrees with counters");
  }
  if (judgeHealth.status === "not-run") {
    if (counters.candidates !== 0)
      throw new TypeError("not-run judge cannot have candidate outcomes");
  } else if (
    !(
      judgeHealth.status === "failed" &&
      counters.candidates === 0 &&
      judgeHealth.failure !== undefined
    )
  ) {
    const expectedJudgeStatus =
      counters.candidates === 0 || counters.resolved === counters.candidates
        ? "healthy"
        : counters.resolved === 0
          ? "failed"
          : "degraded";
    if (judgeHealth.status !== expectedJudgeStatus)
      throw new TypeError("judge status disagrees with candidate outcomes");
  }

  if (
    !Array.isArray(value.candidates) ||
    value.candidates.length > MAX_LINT_REPORT_CANDIDATES ||
    value.candidates.length !== counters.candidates
  ) {
    throw new TypeError("candidate records disagree with counters");
  }
  const ids = new Set();
  const states = { resolved: 0, unresolved: 0, "not-attempted": 0 };
  let semanticCalls = 0;
  let transportAttempts = 0;
  let verificationSelected = 0;
  let verificationAttempted = 0;
  let verificationConfirmed = 0;
  let verificationCleared = 0;
  let verificationUnresolved = 0;
  let verificationNotAttempted = 0;
  let verificationSemanticCalls = 0;
  let verificationTransportAttempts = 0;
  let verificationInputTokens = 0;
  for (const candidate of value.candidates) {
    if (
      typeof candidate?.id !== "string" ||
      candidate.id.length === 0 ||
      ids.has(candidate.id)
    )
      throw new TypeError("candidate IDs must be unique");
    ids.add(candidate.id);
    if (!(candidate.state in states))
      throw new TypeError("invalid candidate state");
    if (
      typeof candidate.file !== "string" ||
      candidate.file.length === 0 ||
      typeof candidate.invariantId !== "string" ||
      candidate.invariantId.length === 0 ||
      typeof candidate.invariantTitle !== "string"
    ) {
      throw new TypeError("candidate identity fields are required");
    }
    if (!["advisory", "soft", "strict"].includes(candidate.severity)) {
      throw new TypeError("invalid candidate severity");
    }
    states[candidate.state]++;
    count(candidate.stats?.semanticCalls, "candidate semanticCalls");
    count(candidate.stats?.transportAttempts, "candidate transportAttempts");
    if (
      candidate.stats.semanticCalls >
      (candidate.verification === undefined ? 2 : 4)
    ) {
      throw new TypeError(
        "candidate semantic calls exceed the per-candidate budget",
      );
    }
    semanticCalls += candidate.stats.semanticCalls;
    transportAttempts += candidate.stats.transportAttempts;
    if (candidate.state === "resolved") {
      if (
        !["violates", "fixes", "satisfies", "unrelated"].includes(
          candidate.verdict,
        )
      ) {
        throw new TypeError("invalid candidate verdict");
      }
      if (
        typeof candidate.reason !== "string" ||
        candidate.reason.trim().length === 0 ||
        candidate.reason.length > MAX_LINT_REPORT_RESOLVED_REASON_LENGTH
      ) {
        throw new TypeError("resolved candidate reason is invalid");
      }
      if (candidate.failure !== undefined) {
        throw new TypeError("resolved candidate cannot have a failure");
      }
    } else {
      if (
        !candidateFailureCodes.has(candidate.failure?.code) ||
        typeof candidate.failure?.message !== "string" ||
        candidate.failure.message.trim().length === 0 ||
        candidate.failure.message.length >
          MAX_LINT_REPORT_FAILURE_MESSAGE_LENGTH ||
        !["candidate", "run"].includes(candidate.failure.scope)
      ) {
        throw new TypeError("unresolved candidate requires a scoped failure");
      }
      if (
        candidate.failure.retryable !== undefined &&
        typeof candidate.failure.retryable !== "boolean"
      ) {
        throw new TypeError("candidate failure retryable must be a boolean");
      }
      if (candidate.verdict !== undefined || candidate.reason !== undefined) {
        throw new TypeError("unresolved candidate cannot have a verdict");
      }
      if (
        candidate.state === "not-attempted" &&
        (candidate.stats.semanticCalls !== 0 ||
          candidate.stats.transportAttempts !== 0)
      ) {
        throw new TypeError("not-attempted candidate stats must be zero");
      }
    }
    if (
      candidate.state === "resolved" &&
      candidate.verdict === "violates" &&
      !(
        candidate.verification !== undefined ||
        value.verification.strategy !== "counterevidence"
      )
    ) {
      throw new TypeError(
        "violations require counterevidence outside holistic lint",
      );
    }
    if (candidate.verification !== undefined) {
      const verification = candidate.verification;
      validateCandidateVerification(verification, candidate);
      verificationSelected++;
      verificationSemanticCalls += verification.stats.semanticCalls;
      verificationTransportAttempts += verification.stats.transportAttempts;
      verificationInputTokens += verification.inputTokens;
      if (verification.state === "confirmed") {
        verificationAttempted++;
        verificationConfirmed++;
      } else if (verification.state === "cleared") {
        verificationAttempted++;
        verificationCleared++;
      } else if (verification.state === "unresolved") {
        verificationAttempted++;
        verificationUnresolved++;
      } else {
        verificationNotAttempted++;
      }
    }
  }
  if (
    states.resolved !== counters.resolved ||
    states.unresolved !== counters.unresolved ||
    states["not-attempted"] !== counters.notAttempted ||
    semanticCalls !== counters.semanticCalls ||
    transportAttempts !== counters.transportAttempts
  ) {
    throw new TypeError(
      "candidate state or attempt totals disagree with counters",
    );
  }
  if (
    value.verification.selected !== verificationSelected ||
    value.verification.attempted !== verificationAttempted ||
    value.verification.confirmed !== verificationConfirmed ||
    value.verification.cleared !== verificationCleared ||
    value.verification.unresolved !== verificationUnresolved ||
    value.verification.notAttempted !== verificationNotAttempted ||
    value.verification.semanticCalls !== verificationSemanticCalls ||
    value.verification.transportAttempts !== verificationTransportAttempts ||
    value.verification.inputTokens !== verificationInputTokens
  ) {
    throw new TypeError(
      "candidate verification totals disagree with verification summary",
    );
  }

  if (
    !Array.isArray(value.findings) ||
    value.findings.length > MAX_LINT_REPORT_FINDINGS
  )
    throw new TypeError(
      `findings must be an array of at most ${MAX_LINT_REPORT_FINDINGS} records`,
    );
  const findingIds = new Set();
  for (const finding of value.findings) {
    if (
      typeof finding?.id !== "string" ||
      finding.id.length === 0 ||
      findingIds.has(finding.id)
    )
      throw new TypeError("finding IDs must be unique");
    findingIds.add(finding.id);
    for (const field of [
      "invariantId",
      "invariantTitle",
      "invariantContent",
      "file",
      "hunk",
    ]) {
      if (typeof finding[field] !== "string")
        throw new TypeError(`finding.${field} must be a string`);
    }
    if (!["advisory", "soft", "strict"].includes(finding.severity))
      throw new TypeError("invalid finding severity");
  }
  if (value.gate.mode !== "advisory" && value.gate.mode !== "gate") {
    throw new TypeError("invalid gate mode");
  }
  for (const field of [
    "blockingFindingIds",
    "advisoryFindingIds",
    "wouldBlockFindingIds",
    "overridden",
  ]) {
    if (!Array.isArray(value.gate[field]))
      throw new TypeError(`gate.${field} must be an array`);
  }
  const classified = [
    ...value.gate.blockingFindingIds,
    ...value.gate.advisoryFindingIds,
    ...value.gate.overridden.map((item) => item.findingId),
  ];
  if (
    classified.length !== findingIds.size ||
    new Set(classified).size !== classified.length
  ) {
    throw new TypeError("gate must classify every finding exactly once");
  }
  for (const id of classified) {
    if (!findingIds.has(id))
      throw new TypeError("gate refers to an unknown finding");
  }
  for (const id of value.gate.wouldBlockFindingIds) {
    if (!findingIds.has(id))
      throw new TypeError("gate would-block list refers to an unknown finding");
  }
  const findingsById = new Map(
    value.findings.map((finding) => [finding.id, finding]),
  );
  for (const item of value.gate.overridden) {
    if (
      typeof item?.reason !== "string" ||
      item.reason.trim().length === 0 ||
      findingsById.get(item.findingId)?.severity !== "soft"
    ) {
      throw new TypeError("only soft findings can be explicitly overridden");
    }
  }
  const overriddenIds = new Set(
    value.gate.overridden.map((item) => item.findingId),
  );
  const expectedWouldBlock = value.findings
    .filter(
      (finding) =>
        finding.severity !== "advisory" && !overriddenIds.has(finding.id),
    )
    .map((finding) => finding.id);
  const sameIds = (actual, expected) =>
    actual.length === expected.length &&
    new Set(actual).size === actual.length &&
    expected.every((id) => actual.includes(id));
  if (!sameIds(value.gate.wouldBlockFindingIds, expectedWouldBlock)) {
    throw new TypeError("gate would-block findings disagree with severities");
  }
  if (value.gate.mode === "advisory") {
    if (value.gate.blockingFindingIds.length > 0)
      throw new TypeError("advisory reports cannot contain blocking findings");
    const expectedAdvisory = value.findings
      .filter((finding) => !overriddenIds.has(finding.id))
      .map((finding) => finding.id);
    if (!sameIds(value.gate.advisoryFindingIds, expectedAdvisory))
      throw new TypeError("advisory classifications disagree with findings");
  } else {
    const expectedAdvisory = value.findings
      .filter((finding) => finding.severity === "advisory")
      .map((finding) => finding.id);
    if (!sameIds(value.gate.blockingFindingIds, expectedWouldBlock))
      throw new TypeError("gate blocking findings disagree with severities");
    if (!sameIds(value.gate.advisoryFindingIds, expectedAdvisory))
      throw new TypeError("gate advisory findings disagree with severities");
  }
  const candidatesByKey = new Map();
  const candidatesByInvariant = new Map();
  for (const candidate of value.candidates) {
    const key = tupleKey(candidate.invariantId, candidate.file);
    const byKey = candidatesByKey.get(key) ?? [];
    byKey.push(candidate);
    candidatesByKey.set(key, byKey);
    const byInvariant = candidatesByInvariant.get(candidate.invariantId) ?? [];
    byInvariant.push(candidate);
    candidatesByInvariant.set(candidate.invariantId, byInvariant);
  }
  const findingsByKey = new Map();
  for (const finding of value.findings) {
    const key = tupleKey(finding.invariantId, finding.file);
    const byKey = findingsByKey.get(key) ?? [];
    byKey.push(finding);
    findingsByKey.set(key, byKey);
  }
  for (const candidate of value.candidates) {
    if (candidate.verification === undefined) continue;
    const key = tupleKey(candidate.invariantId, candidate.file);
    const sameKeyCandidates = candidatesByKey.get(key) ?? [];
    const hasConfirmedCandidate = sameKeyCandidates.some(
      (sameKeyCandidate) =>
        sameKeyCandidate.state === "resolved" &&
        sameKeyCandidate.verdict === "violates" &&
        sameKeyCandidate.verification?.state === "confirmed",
    );
    const matchingFindings = findingsByKey.get(key) ?? [];
    if (candidate.verification.state === "confirmed") {
      if (matchingFindings.length === 0)
        throw new TypeError("confirmed violations require a matching finding");
      if (
        matchingFindings.some(
          (finding) => finding.severity !== candidate.severity,
        )
      )
        throw new TypeError(
          "finding severity disagrees with trusted candidate severity",
        );
    } else if (matchingFindings.length > 0) {
      if (!hasConfirmedCandidate)
        throw new TypeError("only confirmed verification may back a finding");
    }
  }
  for (const finding of value.findings) {
    const key = tupleKey(finding.invariantId, finding.file);
    const matchingCandidates = candidatesByKey.get(key) ?? [];
    if (value.verification.strategy === "counterevidence") {
      if (
        !matchingCandidates.some(
          (candidate) =>
            candidate.state === "resolved" &&
            candidate.verdict === "violates" &&
            candidate.verification?.state === "confirmed" &&
            candidate.severity === finding.severity,
        )
      ) {
        throw new TypeError(
          "isolated findings require confirmed matching candidates",
        );
      }
    } else if (value.coverage.strategy !== "holistic") {
      if (
        !matchingCandidates.some(
          (candidate) =>
            candidate.state === "resolved" &&
            candidate.verdict === "violates" &&
            candidate.severity === finding.severity,
        )
      ) {
        throw new TypeError(
          "isolated findings require matching violated candidates",
        );
      }
    } else {
      const invariantCandidates =
        candidatesByInvariant.get(finding.invariantId) ?? [];
      if (
        !invariantCandidates.some(
          (candidate) =>
            candidate.state === "resolved" &&
            candidate.verdict === "violates" &&
            candidate.severity === finding.severity,
        )
      ) {
        throw new TypeError(
          "holistic findings require matching violated candidates",
        );
      }
    }
  }
  if (
    value.status === "complete" &&
    (!phases.every((phase) => value.health[phase].status === "healthy") ||
      counters.unresolved > 0 ||
      counters.notAttempted > 0)
  ) {
    throw new TypeError(
      "complete report contains unresolved or not-attempted candidates",
    );
  }
  return value;
}

function hunkRange(hunk) {
  const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(hunk ?? "");
  if (!match) return null;
  const line = Number(match[1]);
  const count = match[2] === undefined ? 1 : Number(match[2]);
  if (!Number.isFinite(line) || line < 1) return null;
  return { line, endLine: count > 0 ? line + count - 1 : line };
}

let report;
let validationError;
try {
  if (!path) throw new TypeError("no report file path");
  report = validateReport(JSON.parse(readFileSync(path, "utf8")));
} catch (error) {
  validationError = error;
}

const exitDescriptions = {
  0: "complete, non-blocking",
  1: "CLI usage or argument failure",
  2: "complete with blocking findings",
  3: "runtime health failure",
};
const knownExit = Object.hasOwn(exitDescriptions, cliExit);
annotation(
  knownExit && (cliExit === 0 || cliExit === 2) ? "notice" : "warning",
  "Lore semantic lint CLI",
  `exit ${exitRaw}: ${exitDescriptions[cliExit] ?? "unknown exit code"}`,
);

let healthFailure = !knownExit || Boolean(validationError);
let healthMessage = validationError
  ? `unreadable or invalid report: ${validationError instanceof Error ? validationError.message : JSON.stringify(validationError)}`
  : "";
let blocking = false;

if (report) {
  const expectedExit =
    report.status !== "complete"
      ? 3
      : report.gate.mode === "gate" && report.gate.blockingFindingIds.length > 0
        ? 2
        : 0;
  if (cliExit !== expectedExit) {
    healthFailure = true;
    healthMessage = `CLI exit ${cliExit} disagrees with report outcome ${expectedExit}`;
  }
  if (report.gate.mode !== (gateMode ? "gate" : "advisory")) {
    healthFailure = true;
    healthMessage = "action gate input disagrees with report gate mode";
  }
  if (report.status !== "complete") {
    healthFailure = true;
    healthMessage = `semantic lint status is ${report.status}`;
  }
  blocking = report.gate.blockingFindingIds.length > 0;

  const blockingIds = new Set(report.gate.blockingFindingIds);
  const overriddenIds = new Set(
    report.gate.overridden.map((item) => item.findingId),
  );
  for (const finding of report.findings) {
    const level = blockingIds.has(finding.id)
      ? "error"
      : overriddenIds.has(finding.id)
        ? "notice"
        : "warning";
    const range = hunkRange(finding.hunk);
    const location = range
      ? `file=${escProp(finding.file)},line=${range.line},endLine=${range.endLine}`
      : `file=${escProp(finding.file)}`;
    annotation(
      level,
      `Lore invariant [${finding.severity}]: ${finding.invariantTitle}`,
      `${finding.reason ?? "possible contradiction"}\n\nInvariant: ${finding.invariantContent}`,
      location,
    );
  }

  const counters = report.counters;
  const failureCounts = new Map();
  for (const candidate of report.candidates) {
    if (candidate.failure?.code) {
      failureCounts.set(
        candidate.failure.code,
        (failureCounts.get(candidate.failure.code) ?? 0) + 1,
      );
    }
  }
  for (const phase of Object.values(report.health)) {
    if (phase.failure?.code) {
      failureCounts.set(
        phase.failure.code,
        (failureCounts.get(phase.failure.code) ?? 0) + 1,
      );
    }
  }
  const failureSummary = [...failureCounts.entries()]
    .map(([code, count]) => `${code}: ${count}`)
    .join(", ");
  const funnel = `${counters.hunks} hunks × ${counters.invariants} invariants → ${counters.candidates} candidates · ${counters.resolved} resolved, ${counters.unresolved} unresolved, ${counters.notAttempted} not attempted`;
  const verificationSummary =
    report.verification.strategy === "counterevidence"
      ? `counterevidence: ${report.verification.confirmed} confirmed, ${report.verification.cleared} cleared, ${report.verification.unresolved} unresolved, ${report.verification.notAttempted} not attempted`
      : "counterevidence: not run";
  if (report.status === "complete" && report.findings.length === 0) {
    annotation(
      "notice",
      "Lore semantic lint",
      `✓ no suspected invariant violations among selected candidates (${funnel} · ${verificationSummary})`,
    );
  } else if (report.status !== "complete") {
    annotation(
      "warning",
      "Lore semantic lint inconclusive",
      `${report.status}: ${funnel} · ${verificationSummary}${failureSummary ? ` · causes: ${failureSummary}` : ""}`,
    );
  }
  if (summaryFile) {
    const rows = report.findings
      .map((finding) => {
        const state = blockingIds.has(finding.id)
          ? "🚫 blocking"
          : overriddenIds.has(finding.id)
            ? "↪ overridden"
            : "advisory";
        return `| ${cell(finding.severity)} | ${state} | ${cell(finding.invariantTitle)} | ${cell(finding.file)} | ${cell(finding.reason)} |`;
      })
      .join("\n");
    const headline =
      report.status !== "complete"
        ? `⚠ **Inconclusive (${report.status})** — this is not a clean result.`
        : blocking
          ? `🚫 **${report.gate.blockingFindingIds.length} blocking finding(s)**.`
          : report.findings.length === 0
            ? "✓ No suspected invariant violations among selected candidates."
            : `⚠ **${report.findings.length} advisory finding(s)**.`;
    appendFileSync(
      summaryFile,
      `## 🧭 Lore semantic linter\n\n${headline}\n\n${funnel}\n\n${verificationSummary}\n` +
        (failureSummary ? `\n**Unresolved causes:** ${failureSummary}\n` : "") +
        (rows
          ? `\n| severity | state | invariant | file | why |\n|---|---|---|---|---|\n${rows}\n`
          : ""),
    );
  }
}

if (healthFailure) {
  annotation(
    gateMode ? "error" : "warning",
    "Lore semantic lint health failure",
    `${healthMessage || "semantic lint did not produce a complete valid report"}. ${gateMode ? "Gate mode fails closed." : "Advisory mode remains non-blocking."}`,
  );
}

process.exitCode = gateMode && (healthFailure || blocking) ? 1 : 0;
