import * as v from "valibot";

import { distillationSummary } from "./distillation";
import { epochMs, nonEmptyString, nonNegInt } from "./primitives";

/** `GET /api/v1/projects/:id/sessions` row — core `SessionSummary`. */
export const sessionSummary = v.looseObject({
  session_id: nonEmptyString,
  message_count: nonNegInt,
  first_message_at: epochMs,
  last_message_at: epochMs,
  distilled_count: nonNegInt,
  undistilled_count: nonNegInt,
  distillation_count: nonNegInt,
});

export type SessionSummary = v.InferOutput<typeof sessionSummary>;

export const sessionList = v.array(sessionSummary);

/**
 * One `temporal_messages` row as `temporal.bySession` returns it (`SELECT *`
 * — `metadata` is the stored JSON string, not a parsed object).
 */
export const temporalMessage = v.looseObject({
  id: nonEmptyString,
  source_id: v.optional(v.nullable(v.string())),
  project_id: v.string(),
  session_id: v.string(),
  role: v.string(),
  content: v.string(),
  tokens: nonNegInt,
  distilled: v.pipe(v.number(), v.integer()),
  created_at: epochMs,
  metadata: v.string(),
});

export type TemporalMessage = v.InferOutput<typeof temporalMessage>;

/** `GET /api/v1/sessions/:id?path=…` — `{ messages, distillations }`. */
export const sessionDetail = v.looseObject({
  messages: v.array(temporalMessage),
  distillations: v.array(distillationSummary),
});

export type SessionDetail = v.InferOutput<typeof sessionDetail>;
