import "./config";
import { type } from "arktype";

import { epochMs, nonEmptyString, nonNegInt } from "./primitives";

export const contradictionListItem = type({
  id_a: nonEmptyString,
  id_b: nonEmptyString,
  title_a: "string",
  title_b: "string",
  similarity: "number",
  rationale: "string | null",
  detected_at: epochMs,
});

export type ContradictionListItem = typeof contradictionListItem.infer;

export const contradictionListResponse = type({
  contradictions: contradictionListItem.array(),
  total: nonNegInt,
});

export type ContradictionListResponse = typeof contradictionListResponse.infer;

export const contradictionDecision = type("'keep-a' | 'keep-b' | 'keep-both'");

export type ContradictionDecision = typeof contradictionDecision.infer;

export const contradictionDecisionResult = type({
  status: "'resolved' | 'dismissed'",
  kept_id: "string | null",
});

export type ContradictionDecisionResult =
  typeof contradictionDecisionResult.infer;
