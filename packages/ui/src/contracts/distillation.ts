import * as v from "valibot";

import { epochMs, nonEmptyString, nonNegInt } from "./primitives";

/** `GET /api/v1/projects/:id/distillations` row — core `DistillationSummary`. */
export const distillationSummary = v.looseObject({
  id: nonEmptyString,
  session_id: v.string(),
  generation: nonNegInt,
  token_count: nonNegInt,
  r_compression: v.nullable(v.number()),
  c_norm: v.nullable(v.number()),
  archived: v.pipe(v.number(), v.integer()),
  created_at: epochMs,
  call_type: v.nullable(v.string()),
});

export type DistillationSummary = v.InferOutput<typeof distillationSummary>;

export const distillationList = v.array(distillationSummary);

/**
 * `GET /api/v1/distillations/:id` — `data.getDistillation` returns the full
 * row: the summary fields plus `project_id`, `observations` and `source_ids`.
 * CHECK result: `getDistillation`'s SELECT omits `call_type` (only the
 * summary query selects it), so it is optional here.
 */
export const distillationDetail = v.looseObject({
  id: nonEmptyString,
  session_id: v.string(),
  project_id: v.string(),
  generation: nonNegInt,
  token_count: nonNegInt,
  r_compression: v.nullable(v.number()),
  c_norm: v.nullable(v.number()),
  archived: v.pipe(v.number(), v.integer()),
  created_at: epochMs,
  call_type: v.optional(v.nullable(v.string())),
  observations: v.string(),
  source_ids: v.string(),
});

export type DistillationDetail = v.InferOutput<typeof distillationDetail>;
