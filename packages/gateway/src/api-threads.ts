/**
 * Thread-link and anchored-note routes (#1809) on the management plane:
 *
 *   GET    /api/v1/projects/:id/threads[?source_kind&source_id][&state][&limit][&cursor]
 *   GET    /api/v1/projects/:id/threads/:tid
 *   PATCH  /api/v1/projects/:id/threads/:tid      { expected_revision, state: "closed" }
 *   DELETE /api/v1/projects/:id/threads/:tid?expected_revision=N
 *   GET    /api/v1/projects/:id/threads/:tid/permissions[?limit][&cursor]
 *   GET    /api/v1/projects/:id/notes?source_kind&source_id
 *   POST   /api/v1/projects/:id/notes             { source, anchors, quote, category, title, content }
 *
 * A thread is a forked agent session; its transcript is the child session's
 * (read through the session routes with `child_session_id`). Creating and
 * prompting threads belongs to the gateway ACP host. Every route is
 * project-scoped: an id from another project or tenant is a 404.
 */
import { type } from "arktype";
import {
  anchoredNotes,
  projectPath,
  sourceAnchors,
  threadLinks,
} from "@loreai/core";
import {
  BadRequest,
  CURSOR_VERSION,
  assertCursorBinding,
  decodeCursorObject,
  encodeCursor,
  parseLimit,
} from "./cursor";
import { errorResponse, jsonResponse } from "./api-lists";

type SourceAnchor = sourceAnchors.SourceAnchor;
type ThreadLink = threadLinks.ThreadLink;
type AnchoredNote = anchoredNotes.AnchoredNote;

const id = "0 < string <= 256";
const revision = "number.integer >= 1";

const anchorBody = type({
  "+": "reject",
  block_id: id,
  "part_index?": "number.integer >= 0",
  start: "number.integer >= 0",
  end: "number.integer >= 0",
  // contentHash(): cyrb53 in base36, at most 11 characters.
  content_hash: /^[0-9a-z]{1,11}$/,
});

const sourceBody = type({ "+": "reject", kind: "'session' | 'knowledge'", id });

const updateThreadBody = type({
  "+": "reject",
  expected_revision: revision,
  state: "'closed'",
});

const createNoteBody = type({
  "+": "reject",
  source: sourceBody,
  anchors: anchorBody.array().atLeastLength(1),
  quote: "string",
  category: "'decision' | 'pattern' | 'preference' | 'architecture' | 'gotcha'",
  title: "string",
  content: "string",
});

const sourceKind = type("'session' | 'knowledge'");
const threadState = type(
  "'starting' | 'running' | 'idle' | 'failed' | 'closed'",
);

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

function requireProject(projectId: string): string {
  if (!projectPath(projectId)) {
    throw new HttpError(errorResponse(404, "not_found", "Project not found"));
  }
  return projectId;
}

function sourceFilter(url: URL, required: boolean) {
  const sk = url.searchParams.get("source_kind");
  const sid = url.searchParams.get("source_id");
  if ((sk === null) !== (sid === null) || (required && sk === null)) {
    throw new BadRequest(
      "invalid_request",
      required
        ? "source_kind and source_id are required"
        : "source_kind and source_id go together",
    );
  }
  if (sk === null || sid === null) return undefined;
  const kind = sourceKind(sk);
  if (kind instanceof type.errors || sid === "" || sid.length > 256) {
    throw new BadRequest("invalid_request", "Invalid source filter");
  }
  return { kind, id: sid };
}

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

function threadOut(t: ThreadLink) {
  return {
    id: t.id,
    project_id: t.projectId,
    parent_session_id: t.parentSessionId,
    source: t.source,
    anchors: t.anchors.map(anchorOut),
    quote: t.quote,
    source_hash: t.sourceHash,
    anchor_status: t.anchorStatus,
    agent: t.agent,
    prefix_mode: t.prefixMode,
    prefix_reason: t.prefixReason,
    acp_session_id: t.acpSessionId,
    child_session_id: t.childSessionId,
    worktree: t.worktree,
    state: t.state,
    error: t.error,
    revision: t.revision,
    created_by: t.createdBy,
    created_at: t.createdAt,
    updated_at: t.updatedAt,
    last_activity_at: t.lastActivityAt,
  };
}

function noteOut(n: AnchoredNote) {
  return {
    id: n.id,
    project_id: n.projectId,
    category: n.category,
    title: n.title,
    content: n.content,
    source: n.source,
    anchors: n.anchors.map(anchorOut),
    quote: n.quote,
    source_hash: n.sourceHash,
    anchor_status: n.anchorStatus,
    created_by: n.createdBy,
    created_at: n.createdAt,
    updated_at: n.updatedAt,
  };
}

const THREAD_LIST_LIMIT = 50;
const THREAD_LIST_MAX = 200;

function listThreads(url: URL, projectId: string): Response {
  const limit = parseLimit(url, THREAD_LIST_LIMIT, THREAD_LIST_MAX);
  const source = sourceFilter(url, false);
  const rawState = url.searchParams.get("state");
  let state: threadLinks.ThreadState | undefined;
  if (rawState !== null) {
    const s = threadState(rawState);
    if (s instanceof type.errors) {
      throw new BadRequest("invalid_request", "Unknown thread state");
    }
    state = s;
  }
  const scope = [source?.kind ?? "", source?.id ?? "", state ?? ""].join(
    "\u0000",
  );
  const token = url.searchParams.get("cursor");
  let after: threadLinks.ActivityKey | undefined;
  if (token) {
    const c = decodeCursorObject(token);
    if (
      c.kind !== "threads" ||
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
    after = { lastActivityAt: c.at, id: c.id };
  }
  const result = threadLinks.listThreadLinks({
    projectId,
    source,
    state,
    limit,
    after,
  });
  return jsonResponse({
    threads: result.threads.map(threadOut),
    next_cursor: result.next
      ? encodeCursor({
          v: CURSOR_VERSION,
          kind: "threads",
          project: projectId,
          scope,
          at: result.next.lastActivityAt,
          id: result.next.id,
        })
      : null,
  });
}

async function threadRoute(
  req: Request,
  url: URL,
  projectId: string,
  threadId: string,
): Promise<Response | null> {
  if (req.method === "GET") {
    return jsonResponse({
      thread: threadOut(threadLinks.getThreadLink(projectId, threadId)),
    });
  }
  if (req.method === "PATCH") {
    const body = await readBody(req, updateThreadBody);
    const thread = threadLinks.updateThreadLink(projectId, threadId, {
      expectedRevision: body.expected_revision,
      state: body.state,
    });
    return jsonResponse({ thread: threadOut(thread) });
  }
  if (req.method === "DELETE") {
    threadLinks.deleteThreadLink(projectId, threadId, queryRevision(url));
    return new Response(null, { status: 204 });
  }
  return null;
}

const PERMISSION_LIST_LIMIT = 100;
const PERMISSION_LIST_MAX = 500;

function permissionOut(p: threadLinks.ThreadPermission) {
  return {
    id: p.id,
    thread_id: p.threadId,
    tool_call_id: p.toolCallId,
    title: p.title,
    tool_kind: p.toolKind,
    locations: p.locations,
    option_id: p.optionId,
    option_kind: p.optionKind,
    created_at: p.createdAt,
  };
}

/** The thread's log of permission requests the gateway auto-approved. */
function listThreadPermissions(
  url: URL,
  projectId: string,
  threadId: string,
): Response {
  const limit = parseLimit(url, PERMISSION_LIST_LIMIT, PERMISSION_LIST_MAX);
  const token = url.searchParams.get("cursor");
  let after: { createdAt: number; id: string } | undefined;
  if (token) {
    const c = decodeCursorObject(token);
    if (
      c.kind !== "thread_permissions" ||
      typeof c.project !== "string" ||
      typeof c.thread !== "string" ||
      typeof c.id !== "string" ||
      typeof c.at !== "number" ||
      !Number.isFinite(c.at)
    ) {
      throw new BadRequest("invalid_cursor", "Malformed cursor");
    }
    assertCursorBinding(c.project, projectId, "project");
    assertCursorBinding(c.thread, threadId, "thread");
    after = { createdAt: c.at, id: c.id };
  }
  const result = threadLinks.listPermissions({
    projectId,
    threadId,
    limit,
    after,
  });
  return jsonResponse({
    permissions: result.permissions.map(permissionOut),
    next_cursor: result.next
      ? encodeCursor({
          v: CURSOR_VERSION,
          kind: "thread_permissions",
          project: projectId,
          thread: threadId,
          at: result.next.createdAt,
          id: result.next.id,
        })
      : null,
  });
}

async function notesRoute(
  req: Request,
  url: URL,
  projectId: string,
): Promise<Response | null> {
  if (req.method === "GET") {
    const source = sourceFilter(url, true);
    if (!source) {
      throw new BadRequest(
        "invalid_request",
        "source_kind and source_id are required",
      );
    }
    return jsonResponse({
      notes: anchoredNotes
        .listAnchoredNotes({ projectId, source })
        .map(noteOut),
    });
  }
  if (req.method === "POST") {
    const body = await readBody(req, createNoteBody);
    const note = anchoredNotes.createAnchoredNote({
      projectId,
      source: body.source,
      anchors: body.anchors.map(anchorIn),
      quote: body.quote,
      category: body.category,
      title: body.title,
      content: body.content,
      createdBy: "user",
    });
    return jsonResponse({ note: noteOut(note) }, 201);
  }
  return null;
}

const ERROR_STATUS: Record<sourceAnchors.AnchorErrorCode, number> = {
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
  if (err instanceof sourceAnchors.AnchorError) {
    return jsonResponse(
      {
        type: "error",
        error: {
          type: err.code === "invalid" ? "invalid_request" : err.code,
          message: err.message,
          ...(err.currentRevision === undefined
            ? {}
            : { current_revision: err.currentRevision }),
        },
      },
      ERROR_STATUS[err.code],
    );
  }
  throw err;
}

function segments(pathname: string): string[] | null {
  try {
    return pathname
      .split("/")
      .filter(Boolean)
      .map((p) => decodeURIComponent(p));
  } catch {
    return null;
  }
}

/**
 * Dispatch a thread or note route, or return null when the path is not one
 * of ours (so the caller's 404 handling applies).
 */
export async function handleThreadRequest(
  req: Request,
  url: URL,
): Promise<Response | null> {
  const s = segments(url.pathname);
  if (!s || s[0] !== "api" || s[1] !== "v1" || s[2] !== "projects" || !s[3]) {
    return null;
  }
  if (s[4] !== "threads" && s[4] !== "notes") return null;
  try {
    const projectId = requireProject(s[3]);
    if (s[4] === "notes") {
      return s.length === 5 ? await notesRoute(req, url, projectId) : null;
    }
    if (s.length === 5) {
      return req.method === "GET" ? listThreads(url, projectId) : null;
    }
    if (s.length === 6) return await threadRoute(req, url, projectId, s[5]);
    if (s.length === 7 && s[6] === "permissions") {
      return req.method === "GET"
        ? listThreadPermissions(url, projectId, s[5])
        : null;
    }
    return null;
  } catch (err) {
    return toResponse(err);
  }
}
