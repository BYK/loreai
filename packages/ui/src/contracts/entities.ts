/**
 * Contracts for the UI-08 entity routes (`/api/v1/entities*`), served by the
 * gateway's dashboard route module. Timestamps are epoch ms as stored.
 */
import "./config";
import { type } from "arktype";

import { epochMs, nonEmptyString, nonNegInt } from "./primitives";

/**
 * One entity row as `GET /api/v1/entities` and the detail route emit it.
 * `aliases` excludes the auto-generated canonical-name alias; `entity_type`
 * is a plain string so a future type is not a client error.
 */
export const entityListItem = type({
  id: nonEmptyString,
  entity_type: "string",
  canonical_name: "string",
  project_id: "string | null",
  cross_project: "boolean",
  aliases: "string[]",
  created_at: epochMs,
  updated_at: epochMs,
});

export type EntityListItem = typeof entityListItem.infer;

/** Keyset-paged list envelope: `{ entities, next_cursor, total }`. */
export const entityListPage = type({
  entities: entityListItem.array(),
  next_cursor: "string | null",
  total: nonNegInt,
});

export type EntityListPage = typeof entityListPage.infer;

export const entityRelation = type({
  id: nonEmptyString,
  relation: "string",
  direction: "'outgoing' | 'incoming'",
  other_id: "string",
  other_name: "string",
  other_type: "string",
  created_at: epochMs,
});

export type EntityRelation = typeof entityRelation.infer;

/**
 * A knowledge entry referencing the entity. `id` is the stable logical id —
 * the only identity the browser may put in a URL.
 */
export const entityKnowledgeRef = type({
  id: nonEmptyString,
  title: "string",
  category: "string",
  project_id: "string | null",
});

export type EntityKnowledgeRef = typeof entityKnowledgeRef.infer;

/** `GET /api/v1/entities/:id` — detail adds freeform metadata. */
export const entityDetail = type({
  entity: entityListItem.and({
    metadata: "Record<string, unknown> | null",
  }),
  relations: entityRelation.array(),
  knowledge: entityKnowledgeRef.array(),
});

export type EntityDetail = typeof entityDetail.infer;

/** `GET /api/v1/entities/rebuild` — in-flight probe for the POST route. */
export const entityRebuildStatus = type({
  active: "boolean",
});

export type EntityRebuildStatus = typeof entityRebuildStatus.infer;

/** One project's rebuild outcome (`EntityRebuildResult` in core). */
export const entityRebuildProjectResult = type({
  projectPath: "string",
  dryRun: "boolean",
  scannedDistillations: nonNegInt,
  batches: nonNegInt,
  detected: nonNegInt,
  personsCreated: nonNegInt,
  orgsCreated: nonNegInt,
  otherCreated: nonNegInt,
  relationsCreated: nonNegInt,
  mergedIntoSelf: nonNegInt,
  dedupMerged: nonNegInt,
  "cancelled?": "boolean",
  "candidates?": type({ type: "string", name: "string" }).array(),
});

/** `POST /api/v1/entities/rebuild` response (the POST lives in api.ts). */
export const entityRebuildResult = type({
  dryRun: "boolean",
  cancelled: "boolean",
  results: entityRebuildProjectResult.array(),
});

export type EntityRebuildResult = typeof entityRebuildResult.infer;

/** `POST /api/v1/entities/rebuild/cancel` response. */
export const entityRebuildCancelResult = type({
  cancelled: "boolean",
});

/** `DELETE /api/v1/entities/:id` response. */
export const entityDeleted = type({
  deleted: "boolean",
});
