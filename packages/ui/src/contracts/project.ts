import * as v from "valibot";

import { epochMs, nonEmptyString, nonNegInt } from "./primitives";

/**
 * `GET /api/v1/projects` row — matches core `ProjectSummary` exactly
 * (`packages/core/src/data.ts`): `name` is nullable and the counts are
 * plain non-negative integers.
 */
export const projectSummary = v.looseObject({
  id: nonEmptyString,
  path: v.string(),
  name: v.nullable(v.string()),
  git_remote: v.nullable(v.string()),
  created_at: epochMs,
  knowledge_count: nonNegInt,
  session_count: nonNegInt,
  message_count: nonNegInt,
  distillation_count: nonNegInt,
});

export type ProjectSummary = v.InferOutput<typeof projectSummary>;

export const projectList = v.array(projectSummary);
