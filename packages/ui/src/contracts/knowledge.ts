import * as v from "valibot";

import { epochMs, nonEmptyString } from "./primitives";

/** Core's five categories — exported for screens; the entry contract keeps
 *  `category` a plain string so a future category is not a client error. */
export const knowledgeCategory = v.picklist([
  "decision",
  "pattern",
  "preference",
  "architecture",
  "gotcha",
]);

export type KnowledgeCategory = v.InferOutput<typeof knowledgeCategory>;

/**
 * One knowledge entry as every read route emits it. `id` is the stable
 * logical id (the API rewrites it on every read route); it is the only
 * identity the browser may put in a URL.
 */
export const knowledgeEntry = v.looseObject({
  id: nonEmptyString,
  logical_id: v.optional(nonEmptyString),
  project_id: v.optional(v.nullable(v.string())),
  category: v.string(),
  title: v.string(),
  content: v.string(),
  source_session: v.optional(v.nullable(v.string())),
  cross_project: v.optional(v.union([v.boolean(), v.number()])),
  confidence: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
  created_at: v.optional(v.nullable(epochMs)),
  updated_at: v.optional(v.nullable(epochMs)),
  created_by: v.optional(v.nullable(v.string())),
  updated_by: v.optional(v.nullable(v.string())),
  sensitivity: v.optional(v.nullable(v.string())),
  promotion_status: v.optional(v.nullable(v.string())),
  approval_status: v.optional(v.nullable(v.string())),
  last_accessed_at: v.optional(v.nullable(epochMs)),
  last_reinforced_at: v.optional(v.nullable(epochMs)),
});

export type KnowledgeEntry = v.InferOutput<typeof knowledgeEntry>;

export const knowledgeList = v.array(knowledgeEntry);

/**
 * One row of `GET /api/v1/knowledge/:id/versions` — core's
 * `KnowledgeVersionDetail` (`packages/core/src/list-query.ts` on the
 * cursor-pagination branch). Superseded and deleted versions appear here;
 * `superseded_at` is null on the head.
 */
export const knowledgeVersion = v.looseObject({
  version_id: nonEmptyString,
  version: v.pipe(v.number(), v.integer()),
  created_at: epochMs,
  superseded_at: v.nullable(epochMs),
  is_current: v.boolean(),
  is_deleted: v.boolean(),
  title: v.string(),
  content: v.string(),
  category: v.string(),
  confidence: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
  scope: v.picklist(["project", "global"]),
  cross_project: v.boolean(),
  source_refs: v.looseObject({
    session_id: v.nullable(v.string()),
    entry_id: v.nullable(v.string()),
    user_id: v.nullable(v.string()),
    created_by: v.nullable(v.string()),
    updated_by: v.nullable(v.string()),
    worker_provider_id: v.nullable(v.string()),
    worker_model_id: v.nullable(v.string()),
  }),
});

export type KnowledgeVersion = v.InferOutput<typeof knowledgeVersion>;

export const knowledgeVersionList = v.array(knowledgeVersion);

/**
 * The route returns the whole history object, not a bare array:
 * `{ id, current_version_id, versions }` (`handleKnowledgeVersions` returns
 * `listQuery.knowledgeVersionHistory(...)` verbatim).
 */
export const knowledgeVersionHistory = v.looseObject({
  id: nonEmptyString,
  current_version_id: nonEmptyString,
  versions: knowledgeVersionList,
});

export type KnowledgeVersionHistory = v.InferOutput<
  typeof knowledgeVersionHistory
>;
