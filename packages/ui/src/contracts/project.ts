import "./config";
import { type } from "arktype";

import { epochMs, nonEmptyString, nonNegInt } from "./primitives";

/**
 * `GET /api/v1/projects` row — matches core `ProjectSummary` exactly
 * (`packages/core/src/data.ts`): `name` is nullable and the counts are
 * plain non-negative integers.
 */
export const projectSummary = type({
  id: nonEmptyString,
  path: "string",
  name: "string | null",
  git_remote: "string | null",
  created_at: epochMs,
  knowledge_count: nonNegInt,
  session_count: nonNegInt,
  message_count: nonNegInt,
  distillation_count: nonNegInt,
});

export type ProjectSummary = typeof projectSummary.infer;

export const projectList = projectSummary.array();
