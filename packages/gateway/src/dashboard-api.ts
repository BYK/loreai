/**
 * Handlers for the UI-08 dashboard routes (`routes/dashboard.ts`).
 *
 * Entities: list/detail/metadata-update/delete plus the rebuild-status probe.
 * All endpoints live under `/api/v1/entities`; writes are refused in hosted
 * mode (same trust rule as the mutation handlers in api.ts). Every response
 * is JSON through the management-access helpers; no handler calls an LLM.
 */
import { entities, isHostedMode, ltm } from "@loreai/core";

import { dismissContradiction, resolveContradiction } from "./review-actions";
import { decodeRequestBody, HttpRequestBodyTooLargeError } from "./http-body";
import { errorResponse, jsonResponse } from "./management-access";

type EntityWithAliases = NonNullable<
  ReturnType<typeof entities.getWithAliases>
>;

// ---------------------------------------------------------------------------
// List item shaping
// ---------------------------------------------------------------------------

/**
 * The alias list exposed to the UI excludes the auto-generated "name" alias
 * that duplicates the canonical name (mirrors the legacy dashboard's
 * `displayAliases` filter).
 */
function toListItem(e: EntityWithAliases) {
  return {
    id: e.id,
    entity_type: e.entity_type,
    canonical_name: e.canonical_name,
    project_id: e.project_id,
    cross_project: e.cross_project === 1,
    aliases: e.aliases
      .map((a: { alias_value: string }) => a.alias_value)
      .filter((v: string) => v !== e.canonical_name),
    created_at: e.created_at,
    updated_at: e.updated_at,
  };
}

type EntityListItem = ReturnType<typeof toListItem>;

const MAX_OPEN_CONTRADICTIONS = 25;
const MAX_CONTRADICTION_DECISION_BODY_BYTES = 2 * 1024;
const CONTRADICTION_DECISIONS = new Set(["keep-a", "keep-b", "keep-both"]);

/** Metadata is stored as JSON text; malformed rows report null, never 500. */
function parseMetadata(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function detailBody(e: EntityWithAliases) {
  const relations = entities.relationsFor(e.id).map((r) => ({
    id: r.id,
    relation: r.relation,
    direction:
      r.entity_a === e.id ? ("outgoing" as const) : ("incoming" as const),
    other_id: r.other_id,
    other_name: r.other_name,
    other_type: r.other_type,
    created_at: r.created_at,
  }));
  // knowledgeForEntity returns logical ids (A2, #823); resolve to the current
  // version for title/category and present the stable logical id as `id`
  // (same externalisation as the other /api/v1 knowledge routes).
  const knowledge = entities
    .knowledgeForEntity(e.id)
    .map((kid) => ltm.getByLogical(kid))
    .filter((k) => k !== null)
    .map((k) => ({
      id: k.logical_id,
      title: k.title,
      category: k.category,
      project_id: k.project_id,
    }));
  return {
    entity: { ...toListItem(e), metadata: parseMetadata(e.metadata) },
    relations,
    knowledge,
  };
}

// ---------------------------------------------------------------------------
// Cursor paging (keyset over (entity_type, canonical_name, id))
// ---------------------------------------------------------------------------

const ENTITY_CURSOR_VERSION = 1;

type EntityCursor = { v: number; t: string; n: string; i: string };

function encodeEntityCursor(item: EntityListItem): string {
  const payload: EntityCursor = {
    v: ENTITY_CURSOR_VERSION,
    t: item.entity_type,
    n: item.canonical_name,
    i: item.id,
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeEntityCursor(token: string): EntityCursor | null {
  if (!/^[A-Za-z0-9_-]+$/.test(token) || token.length > 4096) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    (parsed as EntityCursor).v !== ENTITY_CURSOR_VERSION ||
    typeof (parsed as EntityCursor).t !== "string" ||
    typeof (parsed as EntityCursor).n !== "string" ||
    typeof (parsed as EntityCursor).i !== "string"
  ) {
    return null;
  }
  return parsed as EntityCursor;
}

/** Strict `(type, name, id)` tuple comparison — the sort keyset order. */
function afterCursor(a: EntityListItem, c: EntityCursor): boolean {
  if (a.entity_type !== c.t) return a.entity_type > c.t;
  if (a.canonical_name !== c.n) return a.canonical_name > c.n;
  return a.id > c.i;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * `GET /api/v1/entities?type=&page=<cursor>&limit=`.
 *
 * `type` filters by entity_type; an unrecognised type is a valid filter that
 * matches nothing (empty page), not an error. `page` is the opaque keyset
 * cursor from the previous response's `next_cursor`. `limit` defaults to 50,
 * max 200. Malformed cursor or limit → 400 `invalid_request`.
 */
export function handleListEntities(url: URL): Response {
  const rawLimit = url.searchParams.get("limit");
  let limit = 50;
  if (rawLimit !== null && rawLimit !== "") {
    if (!/^\d+$/.test(rawLimit)) {
      return errorResponse(
        400,
        "invalid_request",
        `Invalid limit: ${rawLimit}`,
      );
    }
    const n = parseInt(rawLimit, 10);
    if (n < 1) {
      return errorResponse(
        400,
        "invalid_request",
        `Invalid limit: ${rawLimit}`,
      );
    }
    limit = Math.min(n, 200);
  }

  const token = url.searchParams.get("page");
  let cursor: EntityCursor | null = null;
  if (token !== null && token !== "") {
    cursor = decodeEntityCursor(token);
    if (!cursor) {
      return errorResponse(400, "invalid_request", "Malformed page cursor");
    }
  }

  const typeParam = url.searchParams.get("type");
  const typeFilter = typeParam !== null && typeParam !== "" ? typeParam : null;

  const all = entities
    .listAll()
    // JS re-sort adds the id tiebreak listAll's SQL ORDER BY lacks.
    .sort((a, b) => {
      if (a.entity_type !== b.entity_type)
        return a.entity_type < b.entity_type ? -1 : 1;
      if (a.canonical_name !== b.canonical_name)
        return a.canonical_name < b.canonical_name ? -1 : 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    })
    .map(toListItem)
    .filter((e) => typeFilter === null || e.entity_type === typeFilter);

  const paged = cursor ? all.filter((e) => afterCursor(e, cursor)) : all;
  const items = paged.slice(0, limit);
  const last = items[items.length - 1];
  const next_cursor =
    last !== undefined && paged.length > limit
      ? encodeEntityCursor(last)
      : null;

  return jsonResponse({ entities: items, next_cursor, total: all.length });
}

/**
 * `GET /api/v1/contradictions` — the newest open pairs, capped at the same 25
 * rows the legacy dashboard rendered. Resolving or dismissing a row exposes
 * the next older pair on the next read.
 */
export function handleListContradictions(): Response {
  const all = ltm.listOpenContradictions();
  return jsonResponse({
    contradictions: all.slice(0, MAX_OPEN_CONTRADICTIONS).map((pair) => ({
      id_a: pair.logicalIdA,
      id_b: pair.logicalIdB,
      title_a: pair.titleA,
      title_b: pair.titleB,
      similarity: pair.similarity,
      rationale: pair.rationale,
      detected_at: pair.detectedAt,
    })),
    total: all.length,
  });
}

function decodeContradictionId(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/** `PATCH /api/v1/contradictions/:idA/:idB` — keep one side or both. */
export async function handleContradictionRequest(
  req: Request,
  url: URL,
): Promise<Response> {
  if (req.method !== "PATCH") {
    return errorResponse(
      404,
      "not_found",
      `No API route for ${req.method} ${url.pathname}`,
    );
  }
  if (isHostedMode()) {
    return errorResponse(
      403,
      "forbidden",
      "Contradiction review is not available in hosted mode.",
    );
  }

  const match = /^\/api\/v1\/contradictions\/([^/]+)\/([^/]+)$/.exec(
    url.pathname,
  );
  const idA = match ? decodeContradictionId(match[1]) : null;
  const idB = match ? decodeContradictionId(match[2]) : null;
  if (idA === null || idB === null || idA === "" || idB === "") {
    return errorResponse(
      400,
      "invalid_request",
      "Contradiction ids must be valid URL path segments",
    );
  }

  let body: unknown;
  try {
    body = JSON.parse(
      await decodeRequestBody(req, req.signal, {
        compressedBytes: MAX_CONTRADICTION_DECISION_BODY_BYTES,
        decompressedBytes: MAX_CONTRADICTION_DECISION_BODY_BYTES,
      }),
    );
  } catch (error) {
    if (error instanceof HttpRequestBodyTooLargeError) {
      return errorResponse(
        413,
        "invalid_request",
        `Decision body exceeds ${MAX_CONTRADICTION_DECISION_BODY_BYTES} bytes`,
      );
    }
    return errorResponse(400, "invalid_request", "Invalid JSON body");
  }
  if (
    typeof body !== "object" ||
    body === null ||
    Array.isArray(body) ||
    Object.keys(body).length !== 1 ||
    !("decision" in body) ||
    typeof body.decision !== "string" ||
    !CONTRADICTION_DECISIONS.has(body.decision)
  ) {
    return errorResponse(
      400,
      "invalid_request",
      "Body must contain one decision: keep-a, keep-b, or keep-both",
    );
  }

  const logicalA = ltm.logicalIdOf(idA);
  const logicalB = ltm.logicalIdOf(idB);
  const [canonicalA, canonicalB] = ltm.contradictionPairKey(logicalA, logicalB);
  const isOpen = ltm
    .listOpenContradictions()
    .some(
      (pair) =>
        pair.logicalIdA === canonicalA && pair.logicalIdB === canonicalB,
    );
  if (!isOpen) {
    return errorResponse(404, "not_found", "Open contradiction not found");
  }

  const decision = body.decision;
  if (decision === "keep-both") {
    if (!dismissContradiction(idA, idB)) {
      return errorResponse(
        409,
        "conflict",
        "The contradiction changed before the decision was applied",
      );
    }
    return jsonResponse({ status: "dismissed", kept_id: null });
  }

  const keepId = decision === "keep-a" ? idA : idB;
  const removeId = decision === "keep-a" ? idB : idA;
  if (!resolveContradiction(keepId, removeId)) {
    return errorResponse(
      409,
      "conflict",
      "The contradiction changed before the decision was applied",
    );
  }
  return jsonResponse({
    status: "resolved",
    kept_id: ltm.logicalIdOf(keepId),
  });
}

/** `GET /api/v1/entities/:id`. */
export function handleGetEntity(id: string): Response {
  const entity = entities.getWithAliases(id);
  if (!entity) {
    return errorResponse(404, "not_found", `Entity not found: ${id}`);
  }
  return jsonResponse(detailBody(entity));
}

// ---------------------------------------------------------------------------
// PATCH (metadata edit)
// ---------------------------------------------------------------------------

const METADATA_KEYS = new Set(["role", "description", "notes"]);
const METADATA_VALUE_MAX = 2000;
const MAX_ENTITY_PATCH_BODY_BYTES = 16 * 1024;

type MetadataPatch = { role?: string; description?: string; notes?: string };

/**
 * Parse a PATCH body: `{ role?, description?, notes? }`, each a string
 * (trimmed, ≤ 2000 chars, empty → key removed) or explicit null (removed).
 * Returns the patch or a 400 Response.
 */
function parseMetadataPatch(body: unknown): MetadataPatch | Response {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return errorResponse(
      400,
      "invalid_request",
      "Body must be a JSON object with role/description/notes",
    );
  }
  const patch: MetadataPatch = {};
  for (const [key, value] of Object.entries(body)) {
    if (!METADATA_KEYS.has(key)) {
      return errorResponse(
        400,
        "invalid_request",
        `Unknown metadata field: ${key}`,
      );
    }
    if (value !== null && typeof value !== "string") {
      return errorResponse(
        400,
        "invalid_request",
        `Metadata field ${key} must be a string or null`,
      );
    }
    const trimmed = typeof value === "string" ? value.trim() : "";
    if (trimmed.length > METADATA_VALUE_MAX) {
      return errorResponse(
        400,
        "invalid_request",
        `Metadata field ${key} exceeds ${METADATA_VALUE_MAX} characters`,
      );
    }
    if (trimmed !== "") {
      (patch as Record<string, string>)[key] = trimmed;
    } else {
      (patch as Record<string, null>)[key] = null;
    }
  }
  return patch;
}

/**
 * `PATCH /api/v1/entities/:id` — edit the role/description/notes metadata
 * fields, preserving any other keys the record carries (the LLM curator
 * writes extra fields). Hosted mode → 403.
 */
export async function handlePatchEntity(
  req: Request,
  id: string,
): Promise<Response> {
  if (isHostedMode()) {
    return errorResponse(
      403,
      "forbidden",
      "Entity editing is not available in hosted mode.",
    );
  }
  const entity = entities.getWithAliases(id);
  if (!entity) {
    return errorResponse(404, "not_found", `Entity not found: ${id}`);
  }

  let body: unknown;
  try {
    body = JSON.parse(
      await decodeRequestBody(req, req.signal, {
        compressedBytes: MAX_ENTITY_PATCH_BODY_BYTES,
        decompressedBytes: MAX_ENTITY_PATCH_BODY_BYTES,
      }),
    );
  } catch (error) {
    if (error instanceof HttpRequestBodyTooLargeError) {
      return errorResponse(
        413,
        "invalid_request",
        `Metadata request body exceeds ${MAX_ENTITY_PATCH_BODY_BYTES} bytes`,
      );
    }
    return errorResponse(400, "invalid_request", "Invalid JSON body");
  }
  const patch = parseMetadataPatch(body);
  if (patch instanceof Response) return patch;

  const metadata = parseMetadata(entity.metadata) ?? {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete metadata[key];
    else metadata[key] = value;
  }
  const updatedMetadata = Object.keys(metadata).length > 0 ? metadata : null;
  entities.update(id, { metadata: updatedMetadata });
  const updated = entities.getWithAliases(id);
  if (!updated) {
    return errorResponse(404, "not_found", `Entity not found: ${id}`);
  }
  return jsonResponse(detailBody(updated));
}

/** `DELETE /api/v1/entities/:id`. Hosted mode → 403. */
export function handleDeleteEntity(id: string): Response {
  if (isHostedMode()) {
    return errorResponse(
      403,
      "forbidden",
      "Entity deletion is not available in hosted mode.",
    );
  }
  if (!entities.get(id)) {
    return errorResponse(404, "not_found", `Entity not found: ${id}`);
  }
  entities.remove(id);
  return jsonResponse({ deleted: true });
}

/**
 * `GET /api/v1/entities/rebuild` — whether a rebuild POST is in flight.
 * (The POST itself lives in api.ts; this is the read-only status probe.)
 */
export async function handleEntityRebuildStatus(): Promise<Response> {
  const { isEntityRebuildActive } = await import("./api");
  return jsonResponse({ active: isEntityRebuildActive() });
}

/** Method dispatcher for `/api/v1/entities/:id`. */
export async function handleEntityRequest(
  req: Request,
  url: URL,
): Promise<Response> {
  const { pathname } = url;
  const match = /^\/api\/v1\/entities\/([^/]+)$/.exec(pathname);
  let id: string | null = null;
  if (match) {
    try {
      id = decodeURIComponent(match[1]);
    } catch {
      return errorResponse(
        400,
        "invalid_request",
        "Entity id has malformed URL encoding",
      );
    }
  }
  if (!id) {
    return errorResponse(404, "not_found", `No API route for ${pathname}`);
  }
  switch (req.method) {
    case "GET":
      return handleGetEntity(id);
    case "PATCH":
      return handlePatchEntity(req, id);
    case "DELETE":
      return handleDeleteEntity(id);
    default:
      return errorResponse(
        404,
        "not_found",
        `No API route for ${req.method} ${pathname}`,
      );
  }
}

export type { EntityListItem };
