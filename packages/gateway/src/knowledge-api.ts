/**
 * Cross-project knowledge management reads for `/api/v1/knowledge`.
 *
 * `GET /api/v1/knowledge` returns current, live tenant knowledge in a
 * deterministic keyset page: filters and sorting match the project knowledge
 * list, with `project_id` and the project display name added to each row.
 * Its cursor is bound to the optional exact project-ID filter and sort.
 *
 * `GET /api/v1/knowledge/search?q=` is a separate, unpaginated top-N search.
 * It ranks FTS matches by BM25, falls back to the project-list LIKE semantics
 * when no FTS terms are indexable, and reports the exact matching total.
 */
import { listQuery, projectPath } from "@loreai/core";
import {
  BadRequest,
  CURSOR_VERSION,
  decodeCursorObject,
  errorResponse,
  externalize,
  jsonResponse,
  parseKnowledgeListOptions,
  parseLimit,
  toResponse,
} from "./api-lists";
import type { KnowledgeKeyset, KnowledgeSort } from "@loreai/core";

type KnowledgeAllCursor = {
  v: typeof CURSOR_VERSION;
  kind: "knowledge_all";
  project: string | null;
  sort: KnowledgeSort;
  key: number | string;
  id: string;
};

function encodeCursor(payload: KnowledgeAllCursor): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeKnowledgeAllCursor(
  token: string,
  projectId: string | null,
  sort: KnowledgeSort,
): KnowledgeKeyset {
  const cursor = decodeCursorObject(token);
  if (
    cursor.kind !== "knowledge_all" ||
    !(cursor.project === null || typeof cursor.project === "string") ||
    typeof cursor.sort !== "string" ||
    !listQuery.isKnowledgeSort(cursor.sort) ||
    typeof cursor.id !== "string" ||
    cursor.id.length === 0 ||
    !(typeof cursor.key === "number" || typeof cursor.key === "string")
  ) {
    throw new BadRequest("invalid_cursor", "Malformed cursor");
  }
  if (cursor.project !== projectId) {
    throw new BadRequest(
      "invalid_cursor",
      "Cursor was issued for a different project",
    );
  }
  if (cursor.sort !== sort) {
    throw new BadRequest(
      "invalid_cursor",
      `Cursor was issued for sort=${cursor.sort}; request uses sort=${sort}`,
    );
  }
  const keyset: KnowledgeKeyset = { key: cursor.key, id: cursor.id };
  if (!listQuery.knowledgeKeysetMatchesSort(keyset, sort)) {
    throw new BadRequest("invalid_cursor", "Malformed cursor");
  }
  return keyset;
}

function requestedProjectId(url: URL): string | undefined {
  if (!url.searchParams.has("project")) return undefined;
  const id = url.searchParams.get("project") ?? "";
  if (!id) throw new BadRequest("invalid_request", "project must not be empty");
  if (!projectPath(id)) {
    throw new ProjectNotFound(id);
  }
  return id;
}

class ProjectNotFound extends Error {
  constructor(readonly projectId: string) {
    super(`Project not found: ${projectId}`);
  }
}

export function handleListAllKnowledge(url: URL): Response {
  try {
    const options = parseKnowledgeListOptions(url);
    const projectId = requestedProjectId(url);
    const sort = options.sort ?? "updated_desc";
    const limit = parseLimit(url, 50, 1000);
    const token = url.searchParams.get("cursor");
    const after = url.searchParams.has("cursor")
      ? decodeKnowledgeAllCursor(token ?? "", projectId ?? null, sort)
      : undefined;
    const page = listQuery.listAllKnowledgePage({
      ...options,
      limit,
      after,
      projectId,
    });
    return jsonResponse({
      items: page.items.map(externalize),
      next_cursor: page.next
        ? encodeCursor({
            v: CURSOR_VERSION,
            kind: "knowledge_all",
            project: projectId ?? null,
            sort,
            key: page.next.key,
            id: page.next.id,
          })
        : null,
    });
  } catch (err) {
    if (err instanceof ProjectNotFound)
      return errorResponse(404, "not_found", err.message);
    return toResponse(err);
  }
}

export function handleSearchKnowledge(url: URL): Response {
  try {
    if (url.searchParams.has("cursor") || url.searchParams.has("sort")) {
      throw new BadRequest(
        "invalid_request",
        "search is ranked and not paginated; use GET /api/v1/knowledge?q= to page",
      );
    }
    const options = parseKnowledgeListOptions(url);
    const q = options.q;
    if (q === undefined || !q.trim()) {
      throw new BadRequest(
        "invalid_request",
        "q is required and must not be blank",
      );
    }
    const projectId = requestedProjectId(url);
    const result = listQuery.searchKnowledgeRanked({
      q,
      limit: parseLimit(url, 20, 100),
      projectId,
      category: options.category,
      scope: options.scope,
    });
    return jsonResponse({
      query: q,
      mode: result.mode,
      total: result.total,
      items: result.items.map(externalize),
    });
  } catch (err) {
    if (err instanceof ProjectNotFound)
      return errorResponse(404, "not_found", err.message);
    return toResponse(err);
  }
}
