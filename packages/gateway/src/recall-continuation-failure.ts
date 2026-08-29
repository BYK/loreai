export const RECALL_CONTINUATION_FAILURE_CATEGORIES = [
  "recall_execution",
  "follow_up_setup",
  "follow_up_transport",
  "follow_up_protocol",
  "follow_up_failed",
  "follow_up_missing_output",
  "follow_up_incomplete_arguments",
  "parallel_recall",
  "nested_recall_incomplete",
  "nested_recall_execution",
  "depth_exhausted",
  "missing_recall_block",
  "resource_limit",
  "delivery",
  "unexpected",
] as const;

export type RecallContinuationFailureCategory =
  (typeof RECALL_CONTINUATION_FAILURE_CATEGORIES)[number];

type RecallContinuationFailureHook = (
  category: RecallContinuationFailureCategory,
) => void;

let failureHook: RecallContinuationFailureHook | undefined;

export class RecallContinuationFailure extends Error {
  constructor(readonly category: RecallContinuationFailureCategory) {
    super("recall continuation failed");
    this.name = "RecallContinuationFailure";
  }
}

export function setRecallContinuationFailureHook(
  hook: RecallContinuationFailureHook | undefined,
): void {
  failureHook = hook;
}

export function reportRecallContinuationFailure(
  category: RecallContinuationFailureCategory,
): void {
  if (!RECALL_CONTINUATION_FAILURE_CATEGORIES.includes(category)) return;
  try {
    failureHook?.(category);
  } catch {
    // Diagnostics never affect the response path.
  }
}
