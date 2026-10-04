/**
 * Cursor-paginated list handlers and the knowledge version-history route for
 * the `/api/v1` management API (#1799, #1800).
 *
 * Pagination opt-in
 * -----------------
 * Legacy callers of `GET /projects/:id/knowledge` and `GET /projects/:id/sessions`
 * keep receiving a bare JSON array with unchanged defaults. A caller opts into
 * cursor mode by sending `?page=cursor` (first page) or `?cursor=<token>` (any
 * later page — a cursor implies cursor mode). In cursor mode the response is
 *
 *     { items: [...], next_cursor: string | null }
 *
 * `limit` applies in both modes (default 50, max 1000 for sessions; knowledge
 * defaults to 50 / max 1000 in cursor mode and stays unbounded for legacy
 * callers, as before).
 *
 * Cursor tokens
 * -------------
 * A cursor is opaque to clients: base64url(JSON) of the keyset of the last row
 * of the page (ordered sort keys + id tiebreaker), the list kind, the sort, and the
 * project id it was minted for. It is NOT an offset. Decoding validates every
 * field; a token that fails to decode, was minted for another list/sort, or
 * for another project is rejected with 400 (`invalid_cursor`). Filters (`q`,
 * `category`, `scope`) are not embedded — the caller re-sends them with each
 * page, so a cursor never leaks the query it was minted under.
 *
 * Session messages
 * ----------------
 * `GET /sessions/:id` keeps returning `{ messages, distillations }` with every
 * message. With `?page=cursor` (or `?cursor=`) it returns the newest `limit`
 * messages (default 100, max 1000) instead, plus the fields a history reader
 * needs to walk backwards honestly:
 *
 *     { messages: [...], distillations: [...], next_cursor, message_count }
 *
 * `messages` stay in chronological order within a page; `next_cursor` fetches
 * the page *older* than this one and is null at the session's first message;
 * `message_count` is the session's total at query time. The cursor keyset is
 * `(created_at, id)` of the page's oldest message and is bound to the project
 * and session it was minted for.
 *
 * Session search
 * --------------
 * `GET /sessions/:id/search?q=` (new route, #1857) is the in-session finder
 * over `temporal_fts`: it answers with the ids of the messages that match,
 * newest first, paged with the same `(created_at, id)` keyset and limits as
 * the message pages:
 *
 *     { hits: [{ message_id, created_at, role, snippet, rank }], terms, mode,
 *       total, next_cursor }
 *
 * `q` is tokenised the way the index is and matched as one phrase (`mode:
 * "phrase"`), falling back to "every term anywhere" (`mode: "terms"`) when
 * no message contains the phrase — the response says which, and the cursor
 * pins the mode so later pages cannot switch semantics. `terms` echoes what
 * was matched; an empty list means nothing in `q` was searchable. A missing
 * `q` is 400. The cursor does not embed the query: the caller re-sends it.
 *
 * Version history
 * ---------------
 * `GET /knowledge/:id/versions` follows the visibility of `GET /knowledge/:id`:
 * a tombstoned head is a 404. `?include_deleted=true` opts into returning the
 * history anyway (the tombstone is the current version, `is_deleted: true`) so
 * reviewed dedup merges can be inspected and restored. Any other value → 400.
 */
import {
  listQuery,
  type KnowledgeKeyset,
  type KnowledgeListOptions,
  type MessageKeyset,
  type SessionKeyset,
  type SessionSearchMode,
} from "@loreai/core";
import {
  BadRequest,
  CURSOR_VERSION,
  decodeCursorObject,
  decodeKnowledgeCursor,
  encodeCursor,
  encodeKnowledgeCursor,
  parseLimit,
} from "./cursor";

// ---------------------------------------------------------------------------
// Response helpers (mirrors api.ts; kept local so this module has no cycle)
// ---------------------------------------------------------------------------

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function errorResponse(
  status: number,
  type: string,
  message: string,
): Response {
  return jsonResponse({ type: "error", error: { type, message } }, status);
}

export {
  BadRequest,
  CURSOR_VERSION,
  decodeCursorObject,
  parseLimit,
} from "./cursor";

export function toResponse(err: unknown): Response {
  if (err instanceof BadRequest)
    return errorResponse(400, err.errorType, err.message);
  throw err;
}

function decodeSessionCursor(token: string, projectId: string): SessionKeyset {
  const c = decodeCursorObject(token);
  if (
    c.kind !== "sessions" ||
    typeof c.project !== "string" ||
    typeof c.session_id !== "string" ||
    typeof c.last_message_at !== "number" ||
    !Number.isFinite(c.last_message_at)
  ) {
    throw new BadRequest("invalid_cursor", "Malformed cursor");
  }
  if (c.project !== projectId) {
    throw new BadRequest(
      "invalid_cursor",
      "Cursor was issued for a different project",
    );
  }
  return { last_message_at: c.last_message_at, session_id: c.session_id };
}

function decodeMessageCursor(
  token: string,
  projectId: string,
  sessionId: string,
): MessageKeyset {
  const c = decodeCursorObject(token);
  if (
    c.kind !== "messages" ||
    typeof c.project !== "string" ||
    typeof c.session !== "string" ||
    typeof c.id !== "string" ||
    typeof c.created_at !== "number" ||
    !Number.isFinite(c.created_at)
  ) {
    throw new BadRequest("invalid_cursor", "Malformed cursor");
  }
  if (c.project !== projectId) {
    throw new BadRequest(
      "invalid_cursor",
      "Cursor was issued for a different project",
    );
  }
  if (c.session !== sessionId) {
    throw new BadRequest(
      "invalid_cursor",
      "Cursor was issued for a different session",
    );
  }
  return { created_at: c.created_at, id: c.id };
}

function decodeSearchCursor(
  token: string,
  projectId: string,
  sessionId: string,
): { before: MessageKeyset; mode: SessionSearchMode } {
  const c = decodeCursorObject(token);
  if (
    c.kind !== "search" ||
    typeof c.project !== "string" ||
    typeof c.session !== "string" ||
    typeof c.id !== "string" ||
    typeof c.created_at !== "number" ||
    !Number.isFinite(c.created_at) ||
    (c.mode !== "phrase" && c.mode !== "terms")
  ) {
    throw new BadRequest("invalid_cursor", "Malformed cursor");
  }
  if (c.project !== projectId) {
    throw new BadRequest(
      "invalid_cursor",
      "Cursor was issued for a different project",
    );
  }
  if (c.session !== sessionId) {
    throw new BadRequest(
      "invalid_cursor",
      "Cursor was issued for a different session",
    );
  }
  return { before: { created_at: c.created_at, id: c.id }, mode: c.mode };
}

// ---------------------------------------------------------------------------
// Query-option parsing
// ---------------------------------------------------------------------------

/** True when the request opted into cursor mode (`?page=cursor` or `?cursor=`).
 *  Any other `page` value is not an opt-in and leaves the legacy path untouched. */
export function wantsCursorMode(url: URL): boolean {
  return (
    url.searchParams.get("page") === "cursor" || url.searchParams.has("cursor")
  );
}

/** Parse and validate `q` / `category` / `scope` / `sort`. Throws 400 on an
 *  unknown value. Absent params are left undefined so core applies defaults. */
export function parseKnowledgeListOptions(url: URL): KnowledgeListOptions {
  const out: KnowledgeListOptions = {};
  const q = url.searchParams.get("q");
  if (q !== null) {
    if (q.length > 500)
      throw new BadRequest("invalid_request", "q exceeds 500 characters");
    out.q = q;
  }
  const category = url.searchParams.get("category");
  if (category !== null) {
    if (!listQuery.isKnowledgeCategory(category))
      throw new BadRequest(
        "invalid_request",
        `Invalid category: ${category} (allowed: ${[...listQuery.KNOWLEDGE_CATEGORIES].join(", ")})`,
      );
    out.category = category;
  }
  const scope = url.searchParams.get("scope");
  if (scope !== null) {
    if (!listQuery.isKnowledgeScope(scope))
      throw new BadRequest(
        "invalid_request",
        `Invalid scope: ${scope} (allowed: ${[...listQuery.KNOWLEDGE_SCOPES].join(", ")})`,
      );
    out.scope = scope;
  }
  const sort = url.searchParams.get("sort");
  if (sort !== null) {
    const parsed = listQuery.parseKnowledgeSort(sort);
    if (!parsed)
      throw new BadRequest("invalid_request", `Invalid sort: ${sort}`);
    out.sort = parsed;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/** Present the stable logical_id as the external id (A2, #823), matching the
 *  legacy list and `GET /knowledge/:id`. */
export function externalize<T extends { logical_id: string }>(e: T): T {
  return { ...e, id: e.logical_id };
}

/**
 * Cursor-mode `GET /api/v1/projects/:id/knowledge`. Returns null when the
 * request did not opt in, so the caller falls through to the legacy handler
 * (which still honours the validated filter/sort options via
 * `listKnowledgeLegacy`).
 */
export function handleListKnowledgeCursor(
  url: URL,
  project: { id: string; path: string },
): Response | null {
  try {
    if (!wantsCursorMode(url)) return null;
    const options = parseKnowledgeListOptions(url);
    const sort = options.sort ?? listQuery.DEFAULT_KNOWLEDGE_SORT;
    const limit = parseLimit(url, 50, 1000);
    const token = url.searchParams.get("cursor");
    const after =
      token !== null && token !== ""
        ? decodeKnowledgeCursor(token, "knowledge", project.id, sort)
        : undefined;
    const page = listQuery.listKnowledgePage(project.path, {
      ...options,
      limit,
      after,
    });
    return jsonResponse({
      items: page.items.map(externalize),
      next_cursor: page.next
        ? encodeKnowledgeCursor("knowledge", project.id, sort, page.next)
        : null,
    });
  } catch (err) {
    return toResponse(err);
  }
}

/**
 * Legacy-shape `GET /api/v1/projects/:id/knowledge`: same bare array and
 * external-id mapping, filtered and sorted server-side. The default scope and
 * sort are applied when their query parameters are omitted.
 */
export function handleListKnowledgeFiltered(
  url: URL,
  project: { id: string; path: string },
): Response | null {
  try {
    const options = parseKnowledgeListOptions(url);
    // No limit in legacy mode (the legacy list is unbounded); page through
    // core in bounded chunks so one request never asks SQLite for LIMIT ∞.
    const items = [];
    let after: KnowledgeKeyset | undefined;
    for (;;) {
      const page = listQuery.listKnowledgePage(project.path, {
        ...options,
        limit: 1000,
        after,
      });
      items.push(...page.items.map(externalize));
      if (!page.next) break;
      after = page.next;
    }
    return jsonResponse(items);
  } catch (err) {
    return toResponse(err);
  }
}

/** Cursor-mode `GET /api/v1/projects/:id/sessions`; null when not opted in. */
export function handleListSessionsCursor(
  url: URL,
  project: { id: string; path: string },
): Response | null {
  try {
    if (!wantsCursorMode(url)) return null;
    const limit = parseLimit(url, 50, 1000);
    const token = url.searchParams.get("cursor");
    const after =
      token !== null && token !== ""
        ? decodeSessionCursor(token, project.id)
        : undefined;
    const page = listQuery.listSessionsPage(project.path, { limit, after });
    return jsonResponse({
      items: page.items,
      next_cursor: page.next
        ? encodeCursor({
            v: CURSOR_VERSION,
            kind: "sessions",
            project: project.id,
            last_message_at: page.next.last_message_at,
            session_id: page.next.session_id,
          })
        : null,
    });
  } catch (err) {
    return toResponse(err);
  }
}

/**
 * Cursor-mode `GET /api/v1/sessions/:id`; null when not opted in so the
 * legacy all-messages handler runs unchanged. `distillations` is the same
 * complete list the legacy response carries (they are few and the reader
 * needs all of them to place compressed context).
 */
export function handleShowSessionCursor(
  url: URL,
  project: { id: string; path: string },
  sessionId: string,
  distillations: unknown[],
): Response | null {
  try {
    if (!wantsCursorMode(url)) return null;
    const limit = parseLimit(url, 100, 1000);
    const token = url.searchParams.get("cursor");
    const before =
      token !== null && token !== ""
        ? decodeMessageCursor(token, project.id, sessionId)
        : undefined;
    const page = listQuery.listSessionMessagesPage(project.path, sessionId, {
      limit,
      before,
    });
    return jsonResponse({
      messages: page.items,
      distillations,
      next_cursor: page.next
        ? encodeCursor({
            v: CURSOR_VERSION,
            kind: "messages",
            project: project.id,
            session: sessionId,
            created_at: page.next.created_at,
            id: page.next.id,
          })
        : null,
      message_count: page.total,
    });
  } catch (err) {
    return toResponse(err);
  }
}

/** Longest `q` the finder accepts; longer inputs are a 400, not a truncation. */
const SEARCH_QUERY_MAX = 512;

/**
 * `GET /api/v1/sessions/:id/search?q=&limit=&cursor=`: paged hits of the
 * in-session finder (see the module comment). The project is resolved by the
 * dispatcher exactly like `GET /sessions/:id`.
 */
export function handleSearchSession(
  url: URL,
  project: { id: string; path: string },
  sessionId: string,
): Response {
  try {
    const q = url.searchParams.get("q");
    if (q === null || q.trim() === "") {
      throw new BadRequest(
        "invalid_request",
        "Session search requires ?q=<text>",
      );
    }
    if (q.length > SEARCH_QUERY_MAX) {
      throw new BadRequest(
        "invalid_request",
        `Search query longer than ${SEARCH_QUERY_MAX} characters`,
      );
    }
    const limit = parseLimit(url, 100, 1000);
    const token = url.searchParams.get("cursor");
    const resume =
      token !== null && token !== ""
        ? decodeSearchCursor(token, project.id, sessionId)
        : undefined;
    const page = listQuery.searchSessionMessagesPage(project.path, sessionId, {
      query: q,
      limit,
      before: resume?.before,
      mode: resume?.mode,
    });
    return jsonResponse({
      hits: page.items.map((hit) => ({
        message_id: hit.id,
        created_at: hit.created_at,
        role: hit.role,
        snippet: hit.snippet,
        rank: hit.rank,
      })),
      terms: page.terms,
      mode: page.mode,
      total: page.total,
      next_cursor: page.next
        ? encodeCursor({
            v: CURSOR_VERSION,
            kind: "search",
            project: project.id,
            session: sessionId,
            mode: page.mode,
            created_at: page.next.created_at,
            id: page.next.id,
          })
        : null,
    });
  } catch (err) {
    return toResponse(err);
  }
}

/**
 * `GET /api/v1/knowledge/:id/versions`. `resolvedId` is the id after the same
 * prefix resolution `GET /knowledge/:id` applies (current, superseded or
 * logical id). 404 when unknown or when the head is deleted.
 */
function parseIncludeDeleted(url: URL): boolean {
  const raw = url.searchParams.get("include_deleted");
  if (raw === null || raw === "false") return false;
  if (raw === "true") return true;
  throw new BadRequest(
    "invalid_request",
    `Invalid include_deleted: ${raw} (expected true or false)`,
  );
}

export function handleKnowledgeVersions(
  url: URL,
  requestedId: string,
  resolvedId: string,
): Response {
  let includeDeleted: boolean;
  try {
    includeDeleted = parseIncludeDeleted(url);
  } catch (err) {
    return toResponse(err);
  }
  const history = listQuery.knowledgeVersionHistory(resolvedId, {
    includeDeleted,
  });
  if (!history)
    return errorResponse(
      404,
      "not_found",
      `Knowledge entry not found: ${requestedId}`,
    );
  return jsonResponse(history);
}
