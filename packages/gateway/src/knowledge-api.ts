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
  errorResponse,
  externalize,
  jsonResponse,
  parseKnowledgeListOptions,
  parseLimit,
  toResponse,
} from "./api-lists";
import { decodeKnowledgeCursor, encodeKnowledgeCursor } from "./cursor";

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
    const sort = options.sort ?? listQuery.DEFAULT_KNOWLEDGE_SORT;
    const limit = parseLimit(url, 50, 1000);
    const token = url.searchParams.get("cursor");
    const after = url.searchParams.has("cursor")
      ? decodeKnowledgeCursor(
          token ?? "",
          "knowledge_all",
          projectId ?? null,
          sort,
        )
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
        ? encodeKnowledgeCursor(
            "knowledge_all",
            projectId ?? null,
            sort,
            page.next,
          )
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
