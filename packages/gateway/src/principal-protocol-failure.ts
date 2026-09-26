export const PRINCIPAL_PROTOCOL_PHASES = [
  "setup",
  "read",
  "decode",
  "normalize",
  "validate_response",
  "seed_implicit",
  "reference",
  "validate_output",
  "accumulate",
  "terminal",
] as const;

export const PRINCIPAL_PROTOCOL_EVENT_KINDS = [
  "none",
  "created",
  "in_progress",
  "output_item",
  "arguments",
  "reasoning",
  "output_text",
  "content_part",
  "refusal",
  "terminal",
  "quota",
  "other",
] as const;

export const PRINCIPAL_PROTOCOL_REASONS = [
  "payload_type_mismatch",
  "malformed_json",
  "upstream_failed",
  "upstream_incomplete",
  "reasoning_item_mismatch",
  "provisional_reasoning",
  "response_lifecycle",
  "output_lifecycle",
  "terminal_output",
  "terminal_output_changed",
  "terminal_reasoning_changed",
  "invalid_recall_arguments",
  "recall_call_incomplete",
  "identity_collision",
  "reasoning_lifecycle",
  "reference_incomplete",
  "other",
] as const;

export type PrincipalProtocolFailureSample = {
  phase: (typeof PRINCIPAL_PROTOCOL_PHASES)[number];
  event: (typeof PRINCIPAL_PROTOCOL_EVENT_KINDS)[number];
  reason: (typeof PRINCIPAL_PROTOCOL_REASONS)[number];
};

let failureHook: ((sample: PrincipalProtocolFailureSample) => void) | undefined;

export function setPrincipalProtocolFailureHook(
  hook: typeof failureHook,
): void {
  failureHook = hook;
}

export function reportPrincipalProtocolFailure(
  sample: PrincipalProtocolFailureSample,
): void {
  try {
    const phase = sample.phase;
    const event = sample.event;
    const reason = sample.reason;
    if (
      !PRINCIPAL_PROTOCOL_PHASES.includes(phase) ||
      !PRINCIPAL_PROTOCOL_EVENT_KINDS.includes(event) ||
      !PRINCIPAL_PROTOCOL_REASONS.includes(reason)
    ) {
      return;
    }
    failureHook?.({ phase, event, reason });
  } catch {
    // Telemetry never affects the response path.
  }
}
