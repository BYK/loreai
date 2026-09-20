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
 * of the page (sort key + id tiebreaker), the list kind, the sort, and the
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
  type KnowledgeSort,
  type MessageKeyset,
  type SessionKeyset,
} from "@loreai/core";

// ---------------------------------------------------------------------------
// Response helpers (mirrors api.ts; kept local so this module has no cycle)
// ---------------------------------------------------------------------------

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function errorResponse(
  status: number,
  type: string,
  message: string,
): Response {
  return jsonResponse({ type: "error", error: { type, message } }, status);
}

export class BadRequest extends Error {
  constructor(
    readonly errorType: string,
    message: string,
  ) {
    super(message);
  }
}

function toResponse(err: unknown): Response {
  if (err instanceof BadRequest)
    return errorResponse(400, err.errorType, err.message);
  throw err;
}

// ---------------------------------------------------------------------------
// Cursor codec
// ---------------------------------------------------------------------------

const CURSOR_VERSION = 1;

type KnowledgeCursor = {
  v: typeof CURSOR_VERSION;
  kind: "knowledge";
  project: string;
  sort: KnowledgeSort;
  key: number | string;
  id: string;
};

type SessionCursor = {
  v: typeof CURSOR_VERSION;
  kind: "sessions";
  project: string;
  last_message_at: number;
  session_id: string;
};

type MessageCursor = {
  v: typeof CURSOR_VERSION;
  kind: "messages";
  project: string;
  session: string;
  created_at: number;
  id: string;
};

function encodeCursor(
  payload: KnowledgeCursor | SessionCursor | MessageCursor,
): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Decode a token into a plain object, or throw `invalid_cursor`. */
function decodeCursorObject(token: string): Record<string, unknown> {
  // base64url alphabet only — anything else is rejected before decoding so a
  // sloppy token can't decode to something unexpected.
  if (!/^[A-Za-z0-9_-]+$/.test(token) || token.length > 4096) {
    throw new BadRequest("invalid_cursor", "Malformed cursor");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
  } catch {
    throw new BadRequest("invalid_cursor", "Malformed cursor");
  }
  if (!isRecord(parsed) || parsed.v !== CURSOR_VERSION) {
    throw new BadRequest("invalid_cursor", "Malformed cursor");
  }
  return parsed;
}

function decodeKnowledgeCursor(
  token: string,
  projectId: string,
  sort: KnowledgeSort,
): KnowledgeKeyset {
  const c = decodeCursorObject(token);
  if (
    c.kind !== "knowledge" ||
    typeof c.project !== "string" ||
    typeof c.sort !== "string" ||
    typeof c.id !== "string" ||
    !(typeof c.key === "number" || typeof c.key === "string")
  ) {
    throw new BadRequest("invalid_cursor", "Malformed cursor");
  }
  if (c.project !== projectId) {
    throw new BadRequest(
      "invalid_cursor",
      "Cursor was issued for a different project",
    );
  }
  if (c.sort !== sort) {
    throw new BadRequest(
      "invalid_cursor",
      `Cursor was issued for sort=${c.sort}; request uses sort=${sort}`,
    );
  }
  const keyset: KnowledgeKeyset = { key: c.key, id: c.id };
  if (!listQuery.knowledgeKeysetMatchesSort(keyset, sort)) {
    throw new BadRequest("invalid_cursor", "Malformed cursor");
  }
  return keyset;
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

function parseLimit(url: URL, defaultLimit: number, maxLimit: number): number {
  const raw = url.searchParams.get("limit");
  if (raw === null || raw === "") return defaultLimit;
  if (!/^\d+$/.test(raw))
    throw new BadRequest("invalid_request", `Invalid limit: ${raw}`);
  const n = parseInt(raw, 10);
  if (n < 1) throw new BadRequest("invalid_request", `Invalid limit: ${raw}`);
  return Math.min(n, maxLimit);
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
    if (!listQuery.isKnowledgeSort(sort))
      throw new BadRequest(
        "invalid_request",
        `Invalid sort: ${sort} (allowed: ${[...listQuery.KNOWLEDGE_SORTS].join(", ")})`,
      );
    out.sort = sort;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/** Present the stable logical_id as the external id (A2, #823), matching the
 *  legacy list and `GET /knowledge/:id`. */
function externalize<T extends { logical_id: string }>(e: T): T {
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
    const sort = options.sort ?? "updated_desc";
    const limit = parseLimit(url, 50, 1000);
    const token = url.searchParams.get("cursor");
    const after =
      token !== null && token !== ""
        ? decodeKnowledgeCursor(token, project.id, sort)
        : undefined;
    const page = listQuery.listKnowledgePage(project.path, {
      ...options,
      limit,
      after,
    });
    return jsonResponse({
      items: page.items.map(externalize),
      next_cursor: page.next
        ? encodeCursor({
            v: CURSOR_VERSION,
            kind: "knowledge",
            project: project.id,
            sort,
            key: page.next.key,
            id: page.next.id,
          })
        : null,
    });
  } catch (err) {
    return toResponse(err);
  }
}

/**
 * Legacy-shape `GET /api/v1/projects/:id/knowledge` when any of the new
 * `q`/`category`/`scope`/`sort` options is present: same bare array and
 * external-id mapping as before, filtered/sorted server-side. Returns null
 * when none of the options is present so the untouched legacy path runs.
 */
export function handleListKnowledgeFiltered(
  url: URL,
  project: { id: string; path: string },
): Response | null {
  const hasOption = ["q", "category", "scope", "sort"].some((k) =>
    url.searchParams.has(k),
  );
  if (!hasOption) return null;
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
