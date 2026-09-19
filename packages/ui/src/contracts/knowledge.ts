import "./config";
import { type } from "arktype";

import { epochMs, nonEmptyString } from "./primitives";

/** Core's five categories — exported for screens; the entry contract keeps
 *  `category` a plain string so a future category is not a client error. */
export const knowledgeCategory = type(
  "'decision' | 'pattern' | 'preference' | 'architecture' | 'gotcha'",
);

export type KnowledgeCategory = typeof knowledgeCategory.infer;

/**
 * One knowledge entry as every read route emits it. `id` is the stable
 * logical id (the API rewrites it on every read route); it is the only
 * identity the browser may put in a URL.
 */
export const knowledgeEntry = type({
  id: nonEmptyString,
  "logical_id?": nonEmptyString,
  "project_id?": "string | null",
  category: "string",
  title: "string",
  content: "string",
  "source_session?": "string | null",
  "cross_project?": "boolean | number",
  confidence: "0 <= number <= 1",
  "created_at?": epochMs.or("null"),
  "updated_at?": epochMs.or("null"),
  "created_by?": "string | null",
  "updated_by?": "string | null",
  "sensitivity?": "string | null",
  "promotion_status?": "string | null",
  "approval_status?": "string | null",
  "last_accessed_at?": epochMs.or("null"),
  "last_reinforced_at?": epochMs.or("null"),
});

export type KnowledgeEntry = typeof knowledgeEntry.infer;

export const knowledgeList = knowledgeEntry.array();

/**
 * One row of `GET /api/v1/knowledge/:id/versions` — core's
 * `KnowledgeVersionDetail` (`packages/core/src/list-query.ts`). Superseded
 * and deleted versions appear here;
 * `superseded_at` is null on the head.
 */
export const knowledgeVersion = type({
  version_id: nonEmptyString,
  version: "number.integer",
  created_at: epochMs,
  superseded_at: epochMs.or("null"),
  is_current: "boolean",
  is_deleted: "boolean",
  title: "string",
  content: "string",
  category: "string",
  confidence: "0 <= number <= 1",
  scope: "'project' | 'global'",
  cross_project: "boolean",
  source_refs: {
    session_id: "string | null",
    entry_id: "string | null",
    user_id: "string | null",
    created_by: "string | null",
    updated_by: "string | null",
    worker_provider_id: "string | null",
    worker_model_id: "string | null",
  },
});

export type KnowledgeVersion = typeof knowledgeVersion.infer;

export const knowledgeVersionList = knowledgeVersion.array();

/**
 * The route returns the whole history object, not a bare array:
 * `{ id, current_version_id, versions }` (`handleKnowledgeVersions` returns
 * `listQuery.knowledgeVersionHistory(...)` verbatim).
 */
export const knowledgeVersionHistory = type({
  id: nonEmptyString,
  current_version_id: nonEmptyString,
  versions: knowledgeVersionList,
});

export type KnowledgeVersionHistory = typeof knowledgeVersionHistory.infer;
