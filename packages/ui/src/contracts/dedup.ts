import "./config";
import { type } from "arktype";

import { epochMs, nonEmptyString, nonNegInt } from "./primitives";

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
  project_id: "string | null",
  candidates: dedupPreviewCandidate.array(),
  suggested_keep_id: nonEmptyString,
});

export type DedupPreviewGroup = typeof dedupPreviewGroup.infer;

const dedupResult = type({
  clusters: "unknown[]",
  totalRemoved: nonNegInt,
});

const sharedTitleConflictGroup = type({
  title_key: nonEmptyString,
  entries: type({
    id: nonEmptyString,
    title: "string",
    project_id: "string | null",
    scope: "'project' | 'shared'",
  }).array(),
});

export const dedupPreviewResponse = type({
  dry_run: "true",
  groups: dedupPreviewGroup.array(),
  project: dedupResult,
  global: dedupResult,
  "shared_title_conflicts?": sharedTitleConflictGroup.array(),
});

export type DedupPreviewResponse = typeof dedupPreviewResponse.infer;

export interface DedupApplyDecision {
  keepId: string;
  mergeIds: string[];
  expectedRevisions: Record<string, number>;
}

export interface DedupApplyBody {
  operationId: string;
  projectId?: string | null;
  reviewedAt: number;
  decisions: DedupApplyDecision[];
  actor: string;
}

const dedupApplyDetail = type({
  id: nonEmptyString,
  reason:
    "'not_found' | 'scope_mismatch' | 'stale_revision' | 'conflicting_groups'",
  "expectedRevision?": nonNegInt,
  "actualRevision?": nonNegInt,
});

const dedupGroupRefused = type({
  groupIndex: nonNegInt,
  keepId: nonEmptyString,
  mergeIds: nonEmptyString.array(),
  error: {
    code: "'not_found' | 'scope_mismatch' | 'stale_revision' | 'conflicting_groups'",
    message: "string",
    details: dedupApplyDetail.array(),
  },
});

const dedupMergedEntry = type({
  id: nonEmptyString,
  revision: nonNegInt,
  tombstoneVersionId: nonEmptyString,
});

const dedupGroupApplied = type({
  groupIndex: nonNegInt,
  keepId: nonEmptyString,
  keepRevision: nonNegInt,
  merged: dedupMergedEntry.array(),
  appliedAt: epochMs,
});

export const dedupApplyReceipt = type({
  operationId: nonEmptyString,
  projectId: "string | null",
  applied: dedupGroupApplied.array(),
  refused: dedupGroupRefused.array(),
  startedAt: epochMs,
  finishedAt: epochMs,
  replayed: "boolean",
});

export type DedupApplyReceipt = typeof dedupApplyReceipt.infer;
