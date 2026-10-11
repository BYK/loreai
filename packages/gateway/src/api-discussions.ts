/**
 * Discussion routes (APP-01, #1809) on the management plane:
 *
 *   GET    /api/v1/discussions?project=…[&source_kind&source_id][&state][&thread_id][&limit][&cursor]
 *   POST   /api/v1/discussions
 *   GET    /api/v1/discussions/:id?project=…
 *   PATCH  /api/v1/discussions/:id?project=…           { expected_revision, state?, thread_id? }
 *   DELETE /api/v1/discussions/:id?project=…&expected_revision=N
 *   GET    /api/v1/discussions/:id/replies?project=…[&after][&limit]
 *   POST   /api/v1/discussions/:id/replies?project=…   { expected_revision, body | response_message_id, … }
 *   PATCH  /api/v1/discussions/:id/replies/:rid?project=…
 *   DELETE /api/v1/discussions/:id/replies/:rid?project=…&expected_revision=N
 *   GET    /api/v1/projects/:id/threads[?limit][&cursor]
 *   POST   /api/v1/projects/:id/threads
 *   GET    /api/v1/projects/:id/threads/:tid
 *   PATCH  /api/v1/projects/:id/threads/:tid
 *   DELETE /api/v1/projects/:id/threads/:tid?expected_revision=N
 *   POST   /api/v1/projects/:id/threads/:tid/discussions        { discussion_id, expected_revision }
 *   DELETE /api/v1/projects/:id/threads/:tid/discussions/:did?expected_revision=N
 *
 * Every route is project-scoped: an id from another project (or tenant) is a
 * 404, never a leak. Mutations carry `expected_revision`; a stale one is a 409
 * with the current revision so the client can refetch and retry deliberately.
 */
import { type } from "arktype";
import { discussions, projectPath } from "@loreai/core";
import {
  BadRequest,
  CURSOR_VERSION,
  assertCursorBinding,
  decodeCursorObject,
  encodeCursor,
  parseLimit,
} from "./cursor";
import { errorResponse, jsonResponse } from "./api-lists";

type Discussion = discussions.Discussion;
type DiscussionReply = discussions.DiscussionReply;
type Thread = discussions.Thread;
type SourceAnchor = discussions.SourceAnchor;

// ---------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------

const id = "0 < string <= 256";
const revision = "number.integer >= 1";

const anchorBody = type({
  "+": "reject",
  block_id: id,
  "part_index?": "number.integer >= 0",
  start: "number.integer >= 0",
  end: "number.integer >= 0",
  content_hash: "0 < string <= 16",
});

const createDiscussionBody = type({
  "+": "reject",
  project_id: id,
  "kind?": "'discussion' | 'note'",
  source: { "+": "reject", kind: "'session' | 'knowledge'", id },
  anchors: anchorBody.array().atLeastLength(1),
  quote: "string",
  "created_by?": "string",
  "thread_id?": type(id).or("null"),
  "body?": "string",
});

const updateDiscussionBody = type({
  "+": "reject",
  expected_revision: revision,
  "state?": "'open' | 'resolved'",
  "thread_id?": type(id).or("null"),
});

const createReplyBody = type({
  "+": "reject",
  expected_revision: revision,
  "author?": "string",
  "parent_reply_id?": type(id).or("null"),
  "body?": "string",
  "response_message_id?": id,
});

const updateReplyBody = type({
  "+": "reject",
  expected_revision: revision,
  body: "string",
});

const createThreadBody = type({
  "+": "reject",
  title: "string",
  "created_by?": "string",
});

const updateThreadBody = type({
  "+": "reject",
  expected_revision: revision,
  title: "string",
});

const linkBody = type({
  "+": "reject",
  discussion_id: id,
  expected_revision: revision,
});

class HttpError extends Error {
  constructor(readonly response: Response) {
    super("http error");
  }
}

async function readBody<T>(
  req: Request,
  schema: { (data: unknown): T | type.errors },
): Promise<T> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new BadRequest("invalid_request", "Invalid JSON body");
  }
  const out = schema(raw);
  if (out instanceof type.errors) {
    throw new BadRequest("invalid_request", out.summary);
  }
  return out;
}

function queryRevision(url: URL): number {
  const raw = url.searchParams.get("expected_revision");
  if (raw === null || !/^[1-9]\d{0,15}$/.test(raw)) {
    throw new BadRequest(
      "invalid_request",
      "expected_revision (a positive integer) is required",
    );
  }
  return Number(raw);
}

/** The project the caller names; unknown or foreign-tenant ids are a 404. */
function requireProject(projectId: string | null): string {
  if (!projectId) {
    throw new BadRequest("invalid_request", "?project=<id> is required");
  }
  if (!projectPath(projectId)) {
    throw new HttpError(errorResponse(404, "not_found", "Project not found"));
  }
  return projectId;
}

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

function anchorOut(a: SourceAnchor) {
  return {
    block_id: a.blockId,
    ...(a.partIndex === undefined ? {} : { part_index: a.partIndex }),
    start: a.start,
    end: a.end,
    content_hash: a.contentHash,
  };
}

function anchorIn(a: typeof anchorBody.infer): SourceAnchor {
  return {
    blockId: a.block_id,
    ...(a.part_index === undefined ? {} : { partIndex: a.part_index }),
    start: a.start,
    end: a.end,
    contentHash: a.content_hash,
  };
}

function discussionOut(d: Discussion) {
  return {
    id: d.id,
    project_id: d.projectId,
    thread_id: d.threadId,
    kind: d.kind,
    source: d.source,
    anchors: d.anchors.map(anchorOut),
    quote: d.quote,
    source_hash: d.sourceHash,
    state: d.state,
    anchor_status: d.anchorStatus,
    revision: d.revision,
    created_by: d.createdBy,
    created_at: d.createdAt,
    updated_at: d.updatedAt,
    last_activity_at: d.lastActivityAt,
    reply_count: d.replyCount,
    participants: d.participants,
  };
}

function replyOut(r: DiscussionReply) {
  return {
    id: r.id,
    discussion_id: r.discussionId,
    seq: r.seq,
    parent_reply_id: r.parentReplyId,
    author: r.author,
    content:
      r.content.kind === "text"
        ? { kind: "text" as const, body: r.content.body }
        : {
            kind: "response" as const,
            binding: {
              id: r.content.binding.id,
              session_id: r.content.binding.sessionId,
              message_id: r.content.binding.messageId,
              agent: r.content.binding.agent,
              verified_at: r.content.binding.verifiedAt,
            },
          },
    revision: r.revision,
    created_at: r.createdAt,
    updated_at: r.updatedAt,
  };
}

function threadOut(t: Thread) {
  return {
    id: t.id,
    project_id: t.projectId,
    title: t.title,
    revision: t.revision,
    created_by: t.createdBy,
    created_at: t.createdAt,
    updated_at: t.updatedAt,
    discussion_count: t.discussionCount,
  };
}

// ---------------------------------------------------------------------------
// Cursors
// ---------------------------------------------------------------------------

function discussionCursorScope(url: URL): string {
  return [
    url.searchParams.get("source_kind") ?? "",
    url.searchParams.get("source_id") ?? "",
    url.searchParams.get("state") ?? "",
    url.searchParams.get("thread_id") ?? "",
  ].join("\u0000");
}

function decodeActivityCursor(
  token: string,
  kind: string,
  projectId: string,
  scope: string,
): { at: number; id: string } {
  const c = decodeCursorObject(token);
  if (
    c.kind !== kind ||
    typeof c.project !== "string" ||
    typeof c.scope !== "string" ||
    typeof c.id !== "string" ||
    typeof c.at !== "number" ||
    !Number.isFinite(c.at)
  ) {
    throw new BadRequest("invalid_cursor", "Malformed cursor");
  }
  assertCursorBinding(c.project, projectId, "project");
  if (c.scope !== scope) {
    throw new BadRequest(
      "invalid_cursor",
      "Cursor was issued for different filters",
    );
  }
  return { at: c.at, id: c.id };
}

function encodeActivityCursor(
  kind: string,
  projectId: string,
  scope: string,
  at: number,
  rowId: string,
): string {
  return encodeCursor({
    v: CURSOR_VERSION,
    kind,
    project: projectId,
    scope,
    at,
    id: rowId,
  });
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

const DISCUSSION_LIST_LIMIT = 50;
const DISCUSSION_LIST_MAX = 200;

const sourceKind = type("'session' | 'knowledge'");
const stateParam = type("'open' | 'resolved'");

function listDiscussions(url: URL): Response {
  const projectId = requireProject(url.searchParams.get("project"));
  const limit = parseLimit(url, DISCUSSION_LIST_LIMIT, DISCUSSION_LIST_MAX);
  const sk = url.searchParams.get("source_kind");
  const sid = url.searchParams.get("source_id");
  if ((sk === null) !== (sid === null)) {
    throw new BadRequest(
      "invalid_request",
      "source_kind and source_id go together",
    );
  }
  let source: discussions.DiscussionSource | undefined;
  if (sk !== null && sid !== null) {
    const kind = sourceKind(sk);
    if (kind instanceof type.errors || sid === "") {
      throw new BadRequest("invalid_request", "Invalid source filter");
    }
    source = { kind, id: sid };
  }
  const rawState = url.searchParams.get("state");
  let state: discussions.DiscussionState | undefined;
  if (rawState !== null) {
    const s = stateParam(rawState);
    if (s instanceof type.errors) {
      throw new BadRequest("invalid_request", "state must be open or resolved");
    }
    state = s;
  }
  const threadId = url.searchParams.get("thread_id") || undefined;
  const scope = discussionCursorScope(url);
  const token = url.searchParams.get("cursor");
  const after = token
    ? decodeActivityCursor(token, "discussions", projectId, scope)
    : undefined;
  const result = discussions.listDiscussions({
    projectId,
    source,
    state,
    threadId,
    limit,
    after: after ? { lastActivityAt: after.at, id: after.id } : undefined,
  });
  return jsonResponse({
    discussions: result.discussions.map(discussionOut),
    next_cursor: result.next
      ? encodeActivityCursor(
          "discussions",
          projectId,
          scope,
          result.next.lastActivityAt,
          result.next.id,
        )
      : null,
  });
}

async function createDiscussion(req: Request): Promise<Response> {
  const body = await readBody(req, createDiscussionBody);
  const projectId = requireProject(body.project_id);
  const { discussion, reply } = discussions.createDiscussion({
    projectId,
    kind: body.kind,
    source: body.source,
    anchors: body.anchors.map(anchorIn),
    quote: body.quote,
    createdBy: body.created_by,
    threadId: body.thread_id ?? null,
    body: body.body,
  });
  return jsonResponse(
    {
      discussion: discussionOut(discussion),
      reply: reply ? replyOut(reply) : null,
    },
    201,
  );
}

async function discussionRoute(
  req: Request,
  url: URL,
  discussionId: string,
): Promise<Response | null> {
  const projectId = () => requireProject(url.searchParams.get("project"));
  switch (req.method) {
    case "GET":
      return jsonResponse({
        discussion: discussionOut(
          discussions.getDiscussion(projectId(), discussionId),
        ),
      });
    case "PATCH": {
      const pid = projectId();
      const body = await readBody(req, updateDiscussionBody);
      const updated = discussions.updateDiscussion(pid, discussionId, {
        expectedRevision: body.expected_revision,
        state: body.state,
        threadId: body.thread_id,
      });
      return jsonResponse({ discussion: discussionOut(updated) });
    }
    case "DELETE": {
      const pid = projectId();
      discussions.deleteDiscussion(pid, discussionId, queryRevision(url));
      return jsonResponse({ deleted: true, id: discussionId });
    }
    default:
      return null;
  }
}

async function repliesRoute(
  req: Request,
  url: URL,
  discussionId: string,
): Promise<Response | null> {
  const pid = requireProject(url.searchParams.get("project"));
  if (req.method === "GET") {
    const limit = parseLimit(url, 200, 500);
    const rawAfter = url.searchParams.get("after");
    if (rawAfter !== null && !/^\d{1,15}$/.test(rawAfter)) {
      throw new BadRequest("invalid_request", "after must be a reply seq");
    }
    const result = discussions.listReplies(pid, discussionId, {
      limit,
      afterSeq: rawAfter === null ? undefined : Number(rawAfter),
    });
    return jsonResponse({
      replies: result.replies.map(replyOut),
      next_after: result.nextSeq,
    });
  }
  if (req.method === "POST") {
    const body = await readBody(req, createReplyBody);
    const { reply, discussion } = discussions.addReply(pid, discussionId, {
      expectedRevision: body.expected_revision,
      author: body.author,
      parentReplyId: body.parent_reply_id ?? null,
      body: body.body,
      responseMessageId: body.response_message_id,
    });
    return jsonResponse(
      { reply: replyOut(reply), discussion: discussionOut(discussion) },
      201,
    );
  }
  return null;
}

async function replyRoute(
  req: Request,
  url: URL,
  discussionId: string,
  replyId: string,
): Promise<Response | null> {
  const pid = requireProject(url.searchParams.get("project"));
  if (req.method === "PATCH") {
    const body = await readBody(req, updateReplyBody);
    const reply = discussions.updateReply(pid, discussionId, replyId, {
      expectedRevision: body.expected_revision,
      body: body.body,
    });
    return jsonResponse({ reply: replyOut(reply) });
  }
  if (req.method === "DELETE") {
    discussions.deleteReply(pid, discussionId, replyId, queryRevision(url));
    return jsonResponse({ deleted: true, id: replyId });
  }
  return null;
}

async function threadsRoute(
  req: Request,
  url: URL,
  routeProjectId: string,
): Promise<Response | null> {
  const pid = requireProject(routeProjectId);
  if (req.method === "GET") {
    const limit = parseLimit(url, 50, 200);
    const token = url.searchParams.get("cursor");
    const after = token
      ? decodeActivityCursor(token, "threads", pid, "")
      : undefined;
    const result = discussions.listThreads({
      projectId: pid,
      limit,
      after: after ? { updatedAt: after.at, id: after.id } : undefined,
    });
    return jsonResponse({
      threads: result.threads.map(threadOut),
      next_cursor: result.next
        ? encodeActivityCursor(
            "threads",
            pid,
            "",
            result.next.updatedAt,
            result.next.id,
          )
        : null,
    });
  }
  if (req.method === "POST") {
    const body = await readBody(req, createThreadBody);
    const thread = discussions.createThread({
      projectId: pid,
      title: body.title,
      createdBy: body.created_by,
    });
    return jsonResponse({ thread: threadOut(thread) }, 201);
  }
  return null;
}

async function threadRoute(
  req: Request,
  url: URL,
  routeProjectId: string,
  threadId: string,
): Promise<Response | null> {
  const pid = requireProject(routeProjectId);
  switch (req.method) {
    case "GET": {
      const thread = discussions.getThread(pid, threadId);
      const linked = discussions.listDiscussions({
        projectId: pid,
        threadId,
        limit: DISCUSSION_LIST_MAX,
      });
      return jsonResponse({
        thread: threadOut(thread),
        discussions: linked.discussions.map(discussionOut),
      });
    }
    case "PATCH": {
      const body = await readBody(req, updateThreadBody);
      const thread = discussions.updateThread(pid, threadId, {
        expectedRevision: body.expected_revision,
        title: body.title,
      });
      return jsonResponse({ thread: threadOut(thread) });
    }
    case "DELETE":
      discussions.deleteThread(pid, threadId, queryRevision(url));
      return jsonResponse({ deleted: true, id: threadId });
    default:
      return null;
  }
}

async function threadLinkRoute(
  req: Request,
  url: URL,
  routeProjectId: string,
  threadId: string,
  discussionId: string | null,
): Promise<Response | null> {
  const pid = requireProject(routeProjectId);
  if (req.method === "POST" && discussionId === null) {
    const body = await readBody(req, linkBody);
    discussions.getThread(pid, threadId);
    const linked = discussions.updateDiscussion(pid, body.discussion_id, {
      expectedRevision: body.expected_revision,
      threadId,
    });
    return jsonResponse({ discussion: discussionOut(linked) });
  }
  if (req.method === "DELETE" && discussionId !== null) {
    const current = discussions.getDiscussion(pid, discussionId);
    if (current.threadId !== threadId) {
      return errorResponse(
        404,
        "not_found",
        "Discussion is not linked to this thread",
      );
    }
    const unlinked = discussions.updateDiscussion(pid, discussionId, {
      expectedRevision: queryRevision(url),
      threadId: null,
    });
    return jsonResponse({ discussion: discussionOut(unlinked) });
  }
  return null;
}

const DISCUSSION_ERROR_STATUS: Record<discussions.DiscussionErrorCode, number> =
  {
    not_found: 404,
    invalid: 400,
    revision_conflict: 409,
    source_changed: 409,
  };

function toResponse(err: unknown): Response {
  if (err instanceof HttpError) return err.response;
  if (err instanceof BadRequest) {
    return errorResponse(400, err.errorType, err.message);
  }
  if (err instanceof discussions.DiscussionError) {
    const status = DISCUSSION_ERROR_STATUS[err.code];
    const type = err.code === "invalid" ? "invalid_request" : err.code;
    return jsonResponse(
      {
        type: "error",
        error: {
          type,
          message: err.message,
          ...(err.currentRevision === undefined
            ? {}
            : { current_revision: err.currentRevision }),
        },
      },
      status,
    );
  }
  throw err;
}

function segments(pathname: string): string[] | null {
  const parts = pathname.split("/").filter(Boolean);
  try {
    return parts.map((p) => decodeURIComponent(p));
  } catch {
    return null;
  }
}

/**
 * Dispatch a discussion/thread route, or return null when the path is not
 * one of ours (so the caller's 404 handling applies).
 */
export async function handleDiscussionRequest(
  req: Request,
  url: URL,
): Promise<Response | null> {
  const s = segments(url.pathname);
  if (!s || s[0] !== "api" || s[1] !== "v1") return null;
  try {
    if (s[2] === "discussions") {
      if (s.length === 3) {
        if (req.method === "GET") return listDiscussions(url);
        if (req.method === "POST") return await createDiscussion(req);
        return null;
      }
      const discussionId = s[3];
      if (s.length === 4) return await discussionRoute(req, url, discussionId);
      if (s[4] !== "replies") return null;
      if (s.length === 5) return await repliesRoute(req, url, discussionId);
      if (s.length === 6) return await replyRoute(req, url, discussionId, s[5]);
      return null;
    }
    if (s[2] === "projects" && s[4] === "threads" && s[3]) {
      const projectId = s[3];
      if (s.length === 5) return await threadsRoute(req, url, projectId);
      const threadId = s[5];
      if (s.length === 6)
        return await threadRoute(req, url, projectId, threadId);
      if (s[6] !== "discussions") return null;
      if (s.length === 7) {
        return await threadLinkRoute(req, url, projectId, threadId, null);
      }
      if (s.length === 8) {
        return await threadLinkRoute(req, url, projectId, threadId, s[7]);
      }
    }
    return null;
  } catch (err) {
    return toResponse(err);
  }
}
