import "./config";
import { type } from "arktype";

import { nonEmptyString, nonNegInt } from "./primitives";

export const dedupPreviewCandidate = type({
  id: nonEmptyString,
  logical_id: nonEmptyString,
  revision: nonNegInt,
  title: "string",
  content_excerpt: "string",
  scope: "'project' | 'shared'",
  project_id: "string | null",
  category: "string",
  confidence: "0 <= number <= 1",
  source_session: "string | null",
  updated_at: "number | null",
  score: "number",
  reasons: "string[]",
});

export type DedupPreviewCandidate = typeof dedupPreviewCandidate.infer;

export const dedupPreviewGroup = type({
  group_id: nonEmptyString,
  scope: "'project' | 'global'",
  pool: "'project' | 'shared' | 'project_shared'",
  project_id: "string | null",
  candidates: dedupPreviewCandidate.array(),
  suggested_keep_id: nonEmptyString,
});

export type DedupPreviewGroup = typeof dedupPreviewGroup.infer;

const dedupResult = type({
  clusters: "unknown[]",
  totalRemoved: nonNegInt,
});

export const dedupPreviewResponse = type({
  dry_run: "true",
  groups: dedupPreviewGroup.array(),
  project: dedupResult,
  global: dedupResult,
  project_shared: dedupResult,
});

export type DedupPreviewResponse = typeof dedupPreviewResponse.infer;
