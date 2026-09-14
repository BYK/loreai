export const PRINCIPAL_TRANSPORT_FAILURE_KINDS = [
  "read",
  "inactivity",
] as const;

export type PrincipalTransportFailureKind =
  (typeof PRINCIPAL_TRANSPORT_FAILURE_KINDS)[number];

export const PRINCIPAL_TRANSPORT_FAILURE_STAGES = [
  "pre_output",
  "post_output",
  "post_tool",
] as const;

export type PrincipalTransportFailureStage =
  (typeof PRINCIPAL_TRANSPORT_FAILURE_STAGES)[number];

export const PRINCIPAL_TRANSPORT_FAILURE_OUTCOMES = [
  "retry",
  "retry_succeeded",
  "retry_exhausted",
  "continue",
  "failed",
] as const;

export type PrincipalTransportFailureOutcome =
  (typeof PRINCIPAL_TRANSPORT_FAILURE_OUTCOMES)[number];

export type PrincipalTransportFailureSample = {
  kind: PrincipalTransportFailureKind;
  stage: PrincipalTransportFailureStage;
  outcome: PrincipalTransportFailureOutcome;
};

type PrincipalTransportFailureHook = (
  sample: PrincipalTransportFailureSample,
) => void;

let failureHook: PrincipalTransportFailureHook | undefined;

export function setPrincipalTransportFailureHook(
  hook: PrincipalTransportFailureHook | undefined,
): void {
  failureHook = hook;
}

export function reportPrincipalTransportFailure(
  sample: PrincipalTransportFailureSample,
): void {
  try {
    const kind = sample.kind;
    const stage = sample.stage;
    const outcome = sample.outcome;
    if (
      !PRINCIPAL_TRANSPORT_FAILURE_KINDS.includes(kind) ||
      !PRINCIPAL_TRANSPORT_FAILURE_STAGES.includes(stage) ||
      !PRINCIPAL_TRANSPORT_FAILURE_OUTCOMES.includes(outcome)
    ) {
      return;
    }
    failureHook?.({ kind, stage, outcome });
  } catch {
    // Diagnostics never affect the response path.
  }
}
