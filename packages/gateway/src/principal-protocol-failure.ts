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
  "recall_arguments_not_string",
  "malformed_recall_json",
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

/** Fixed validation codes; no function-call arguments or property names. */
export const INVALID_RECALL_ARGUMENT_ISSUES = [
  "expected_object",
  "unknown_property",
  "query_type",
  "id_type",
  "ids_type",
  "id_conflict",
  "detail_offset",
  "detail_limit",
  "scope_type",
  "missing_selector",
  "detail_without_id",
  "unsupported_scope",
] as const;

export type InvalidRecallArgumentsIssue =
  (typeof INVALID_RECALL_ARGUMENT_ISSUES)[number];

let invalidRecallHook:
  | ((issue: InvalidRecallArgumentsIssue) => void)
  | undefined;

export function setInvalidRecallArgumentsHook(
  hook: typeof invalidRecallHook,
): void {
  invalidRecallHook = hook;
}

export function reportInvalidRecallArguments(
  issue: InvalidRecallArgumentsIssue,
): void {
  try {
    if (INVALID_RECALL_ARGUMENT_ISSUES.includes(issue)) {
      invalidRecallHook?.(issue);
    }
  } catch {
    // Telemetry never affects the response path.
  }
}

/** Reset diagnostics when a completed frame is handed back to its parser. */
export async function* trackResponsesReadBoundary<T>(
  events: AsyncIterable<T>,
  onRead: () => void,
): AsyncGenerator<T> {
  for await (const event of events) {
    yield event;
    // This runs before the next parser read, but not when processing this
    // event throws. Thus failures still identify the current event.
    onRead();
  }
}

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
