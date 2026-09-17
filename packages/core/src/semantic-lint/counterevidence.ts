import type { JudgeFailure, JudgeStats, SemanticLintContext } from "./check";

export type CounterevidenceVerdict =
  | "confirmed"
  | "resolved"
  | "insufficient-context";

export interface CounterevidenceHunk {
  id: string;
  file: string;
  relationship:
    | "seed"
    | "same-file"
    | "shared-symbol"
    | "import-relationship"
    | "test-pair";
  text: string;
}

export interface CounterevidenceInput {
  invariant: { id: string; title: string; content: string };
  seed: CounterevidenceHunk;
  connectedContext: CounterevidenceHunk[];
  contextComplete: boolean;
  omittedCompanions: number;
  firstPassReason: string;
  prContext?: SemanticLintContext;
  /** Remaining shared semantic-call budget for this verifier invocation. */
  semanticCallBudget: number;
}

export interface CounterevidenceEvidence {
  hunkId: string;
  reason: string;
}

export interface CounterevidenceResult {
  verdict: CounterevidenceVerdict;
  reason: string;
  evidence: CounterevidenceEvidence[];
}

export type CounterevidenceOutcome =
  | ({
      kind: "verdict";
    } & CounterevidenceResult & { stats: JudgeStats })
  | {
      kind: "unresolved";
      failure: JudgeFailure;
      stats: JudgeStats;
    };

export interface CounterevidenceVerifier {
  verify(input: CounterevidenceInput): Promise<CounterevidenceOutcome>;
}

export type CounterevidenceRecord =
  | {
      state: "confirmed" | "cleared";
      reason: string;
      evidence: CounterevidenceEvidence[];
      stats: JudgeStats;
      inputTokens: number;
      contextComplete: boolean;
    }
  | {
      state: "unresolved" | "not-attempted";
      failure: JudgeFailure;
      stats: JudgeStats;
      inputTokens: number;
      contextComplete: boolean;
    };

export interface CounterevidenceSummary {
  strategy: "none" | "counterevidence";
  contextComplete: boolean;
  selected: number;
  attempted: number;
  confirmed: number;
  cleared: number;
  unresolved: number;
  notAttempted: number;
  semanticCalls: number;
  transportAttempts: number;
  inputTokens: number;
  inputTokenBudget: number;
}

export const MAX_COUNTEREVIDENCE_EVIDENCE = 4;
export const MAX_COUNTEREVIDENCE_REASON_LENGTH = 400;
/** Maximum untrusted invalid output echoed into a repair prompt. */
export const MAX_COUNTEREVIDENCE_REPAIR_RESPONSE_CHARS = 1_000;
/** Hard bound before trimming or parsing an untrusted verifier response. */
export const MAX_COUNTEREVIDENCE_RESPONSE_BYTES = 64 * 1024;
export const COUNTEREVIDENCE_INPUT_TOKEN_BUDGET = 16_000;
const APPROX_BYTES_PER_TOKEN = 4;
const SYSTEM_TOKEN_RESERVE = 2_000;
const MAX_UTF8_BYTES_PER_CHAR = 4;
const REPAIR_RESPONSE_TOKEN_RESERVE = Math.ceil(
  (MAX_COUNTEREVIDENCE_REPAIR_RESPONSE_CHARS * MAX_UTF8_BYTES_PER_CHAR) /
    APPROX_BYTES_PER_TOKEN,
);

export function emptyCounterevidenceSummary(): CounterevidenceSummary {
  return {
    strategy: "none",
    contextComplete: false,
    selected: 0,
    attempted: 0,
    confirmed: 0,
    cleared: 0,
    unresolved: 0,
    notAttempted: 0,
    semanticCalls: 0,
    transportAttempts: 0,
    inputTokens: 0,
    inputTokenBudget: 0,
  };
}

export function estimateCounterevidenceInputTokens(
  input: Pick<
    CounterevidenceInput,
    | "invariant"
    | "seed"
    | "connectedContext"
    | "contextComplete"
    | "omittedCompanions"
    | "firstPassReason"
    | "prContext"
  >,
): number {
  const serialized = JSON.stringify(
    {
      pullRequestContext: input.prContext ?? null,
      invariant: input.invariant,
      firstPass: { reason: input.firstPassReason },
      context: {
        complete: input.contextComplete,
        omittedCompanions: input.omittedCompanions,
        seed: input.seed,
        connectedHunks: input.connectedContext,
      },
    },
    null,
    2,
  );
  return (
    Math.ceil(Buffer.byteLength(serialized, "utf8") / APPROX_BYTES_PER_TOKEN) +
    SYSTEM_TOKEN_RESERVE +
    REPAIR_RESPONSE_TOKEN_RESERVE
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseCounterevidenceVerdict(
  text: string | null,
  expectedHunkIds: ReadonlySet<string>,
): CounterevidenceResult | null {
  if (
    typeof text !== "string" ||
    text.length === 0 ||
    Buffer.byteLength(text, "utf8") > MAX_COUNTEREVIDENCE_RESPONSE_BYTES
  ) {
    return null;
  }
  let payload = text.trim();
  const fenced = /^```json[ \t]*\r?\n([\s\S]*)\r?\n```$/.exec(payload);
  if (fenced) payload = fenced[1];
  else if (payload.startsWith("```") || payload.endsWith("```")) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(payload);
    if (!isRecord(parsed)) return null;
    const keys = Object.keys(parsed).sort();
    if (
      keys.length !== 3 ||
      keys[0] !== "evidence" ||
      keys[1] !== "reason" ||
      keys[2] !== "verdict"
    ) {
      return null;
    }
    if (
      parsed.verdict !== "confirmed" &&
      parsed.verdict !== "resolved" &&
      parsed.verdict !== "insufficient-context"
    ) {
      return null;
    }
    if (
      typeof parsed.reason !== "string" ||
      parsed.reason.trim().length === 0 ||
      parsed.reason.length > MAX_COUNTEREVIDENCE_REASON_LENGTH ||
      !Array.isArray(parsed.evidence) ||
      parsed.evidence.length > MAX_COUNTEREVIDENCE_EVIDENCE
    ) {
      return null;
    }

    const evidence: CounterevidenceEvidence[] = [];
    const seen = new Set<string>();
    for (const value of parsed.evidence) {
      if (!isRecord(value)) return null;
      const evidenceKeys = Object.keys(value).sort();
      if (
        evidenceKeys.length !== 2 ||
        evidenceKeys[0] !== "hunkId" ||
        evidenceKeys[1] !== "reason" ||
        typeof value.hunkId !== "string" ||
        !expectedHunkIds.has(value.hunkId) ||
        seen.has(value.hunkId) ||
        typeof value.reason !== "string" ||
        value.reason.trim().length === 0 ||
        value.reason.length > MAX_COUNTEREVIDENCE_REASON_LENGTH
      ) {
        return null;
      }
      seen.add(value.hunkId);
      evidence.push({ hunkId: value.hunkId, reason: value.reason });
    }

    if (
      (parsed.verdict === "confirmed" || parsed.verdict === "resolved") &&
      evidence.length === 0
    ) {
      return null;
    }

    return {
      verdict: parsed.verdict,
      reason: parsed.reason,
      evidence,
    };
  } catch {
    return null;
  }
}
