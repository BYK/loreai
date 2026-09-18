import "./config";
import { type } from "arktype";

import { epochMs, nonEmptyString, nonNegInt } from "./primitives";

/** `GET /api/v1/projects/:id/distillations` row — core `DistillationSummary`. */
export const distillationSummary = type({
  id: nonEmptyString,
  session_id: "string",
  generation: nonNegInt,
  token_count: nonNegInt,
  r_compression: "number | null",
  c_norm: "number | null",
  archived: "number.integer",
  created_at: epochMs,
  call_type: "string | null",
});

export type DistillationSummary = typeof distillationSummary.infer;

export const distillationList = distillationSummary.array();

/**
 * `GET /api/v1/distillations/:id` — `data.getDistillation` returns the full
 * row: the summary fields plus `project_id`, `observations` and `source_ids`.
 * CHECK result: `getDistillation`'s SELECT omits `call_type` (only the
 * summary query selects it), so it is optional here.
 */
export const distillationDetail = type({
  id: nonEmptyString,
  session_id: "string",
  project_id: "string",
  generation: nonNegInt,
  token_count: nonNegInt,
  r_compression: "number | null",
  c_norm: "number | null",
  archived: "number.integer",
  created_at: epochMs,
  "call_type?": "string | null",
  observations: "string",
  source_ids: "string",
});

export type DistillationDetail = typeof distillationDetail.infer;
