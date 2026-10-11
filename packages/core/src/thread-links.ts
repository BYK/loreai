/**
 * Thread links (#1809): a thread started from a selection is a new agent
 * session the gateway runs on the harness through ACP, seeded with the parent
 * transcript up to the anchor. Core only stores the link — parent source and
 * anchor, the harness, the child session ids, the lifecycle state and the log
 * of auto-approved permission requests — and never the child's turns, which
 * reach `temporal_messages` through the gateway like any other session.
 *
 * Mutations take `expectedRevision`; a mismatch is a `revision_conflict`
 * AnchorError carrying the current revision.
 */
import { uuidv7 } from "uuidv7";
import { databaseInTransaction, db, withTransaction } from "./db";
import {
  AnchorError,
  anchorStatusOf,
  checkSelection,
  fail,
  loadSource,
  sourceHashOf,
  type AnchorSource,
  type AnchorStatus,
  type SourceAnchor,
  type SourceBlocks,
  type SourceKind,
} from "./source-anchors";
import { sql, type SqlFragment } from "./sql";
import { currentTenantId } from "./tenant";

export type ThreadState = "starting" | "running" | "idle" | "failed" | "closed";

/**
 * How the child's prompt prefix was built. `inherited`: the parent's as-sent
 * body cut at the anchor, replayed byte-identically so the child reuses the
 * parent's prompt cache. `rebuilt`: a seed rebuilt from temporal storage.
 */
export type PrefixMode = "inherited" | "rebuilt";

export const PREFIX_REASONS = [
  /** The parent has no as-sent body (gateway restart or cache reset). */
  "no_parent_body",
  /** The anchored message was compressed into the distilled prefix. */
  "anchor_not_in_body",
  "model_mismatch",
  "account_mismatch",
  /** Knowledge sources have no parent conversation to inherit. */
  "knowledge_source",
] as const;
export type PrefixReason = (typeof PREFIX_REASONS)[number];

export type ThreadPrefixInput =
  | {
      mode: "inherited";
      /** Upstream model id the parent body was sent with. */
      model: string;
      /** Credential fingerprint of the parent's upstream account. */
      account: string;
      /** Wire protocol of the body (`anthropic`, `openai`, …). */
      wire: string;
      /** zstd-compressed as-sent body, cut at the anchor. */
      body: Uint8Array;
      /** Uncompressed length in bytes. */
      bodyBytes: number;
    }
  | { mode: "rebuilt"; reason: PrefixReason };

export interface ThreadPrefix {
  model: string;
  account: string;
  wire: string;
  body: Uint8Array;
  bodyBytes: number;
  createdAt: number;
}

export interface ThreadWorktree {
  path: string;
  branch: string;
}

export interface ThreadLink {
  id: string;
  projectId: string;
  /** Lore session the selection lives in; null for knowledge sources. */
  parentSessionId: string | null;
  source: AnchorSource;
  anchors: SourceAnchor[];
  quote: string;
  sourceHash: string;
  anchorStatus: AnchorStatus;
  /** Harness name from the gateway's agent registry (e.g. `claude-code`). */
  agent: string;
  prefixMode: PrefixMode;
  /** Why the prefix was rebuilt; null when inherited. */
  prefixReason: PrefixReason | null;
  /** The harness's own ACP session id. */
  acpSessionId: string | null;
  /** Lore session id of the child, bound on its first gateway request. */
  childSessionId: string | null;
  /** Isolated git worktree the child runs in; null when it shares the parent cwd. */
  worktree: ThreadWorktree | null;
  state: ThreadState;
  error: string | null;
  revision: number;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  lastActivityAt: number;
}

export interface ActivityKey {
  lastActivityAt: number;
  id: string;
}

export const ERROR_MAX = 2000;
const AGENT_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const PARTICIPANT_RE = /^(user|lore|agent:[A-Za-z0-9._:@/-]{1,128})$/;
const ID_MAX = 256;

/** Allowed lifecycle moves; `closed` is terminal. */
const TRANSITIONS: Record<ThreadState, readonly ThreadState[]> = {
  starting: ["running", "idle", "failed", "closed"],
  running: ["idle", "failed", "closed"],
  idle: ["running", "failed", "closed"],
  failed: ["closed"],
  closed: [],
};

interface ThreadLinkRow {
  id: string;
  project_id: string;
  parent_session_id: string | null;
  source_kind: SourceKind;
  source_id: string;
  anchors: string;
  quote: string;
  source_hash: string;
  anchor_status: AnchorStatus;
  agent: string;
  prefix_mode: PrefixMode;
  prefix_reason: PrefixReason | null;
  acp_session_id: string | null;
  child_session_id: string | null;
  worktree_path: string | null;
  worktree_branch: string | null;
  state: ThreadState;
  error: string | null;
  revision: number;
  created_by: string;
  created_at: number;
  updated_at: number;
  last_activity_at: number;
}

const COLS = sql.raw(
  `t.id, t.project_id, t.parent_session_id, t.source_kind, t.source_id,
   t.anchors, t.quote, t.source_hash, t.anchor_status, t.agent,
   t.prefix_mode, t.prefix_reason, t.acp_session_id, t.child_session_id, t.worktree_path,
   t.worktree_branch, t.state, t.error, t.revision, t.created_by,
   t.created_at, t.updated_at, t.last_activity_at`,
);

/** Monotonic per-process clock: equal-millisecond writes still order. */
let lastNow = 0;
function now(): number {
  const t = Date.now();
  lastNow = t > lastNow ? t : lastNow + 1;
  return lastNow;
}

/**
 * Read rows and hydrate them in one transaction; `hydrate` may persist an
 * anchor transition, so this takes the write lock up front.
 */
function snapshot<T>(fn: () => T): T {
  return databaseInTransaction(db()) ? fn() : withTransaction(fn);
}

/** Re-check anchors against the live source, persisting a one-way transition. */
function hydrate(rows: ThreadLinkRow[]): ThreadLink[] {
  const sources = new Map<string, SourceBlocks>();
  const statuses = new Map<string, AnchorStatus>();
  for (const row of rows) {
    if (row.anchor_status === "source_missing") continue;
    const key = `${row.project_id}\0${row.source_kind}\0${row.source_id}`;
    let source = sources.get(key);
    if (!source) {
      const all = rows
        .filter(
          (r) =>
            r.project_id === row.project_id &&
            r.source_kind === row.source_kind &&
            r.source_id === row.source_id,
        )
        .flatMap((r) => JSON.parse(r.anchors) as SourceAnchor[]);
      source = loadSource(
        row.project_id,
        { kind: row.source_kind, id: row.source_id },
        all,
      );
      sources.set(key, source);
    }
    const status = anchorStatusOf(
      JSON.parse(row.anchors) as SourceAnchor[],
      source,
    );
    if (status !== row.anchor_status && status !== "current") {
      statuses.set(row.id, status);
    }
  }
  for (const [id, status] of statuses) {
    sql.run(
      db(),
      sql`UPDATE thread_links SET anchor_status = ${status}
           WHERE id = ${id} AND anchor_status <> 'source_missing'`,
    );
  }
  return rows.map((row) => ({
    id: row.id,
    projectId: row.project_id,
    parentSessionId: row.parent_session_id,
    source: { kind: row.source_kind, id: row.source_id },
    anchors: JSON.parse(row.anchors) as SourceAnchor[],
    quote: row.quote,
    sourceHash: row.source_hash,
    anchorStatus: statuses.get(row.id) ?? row.anchor_status,
    agent: row.agent,
    prefixMode: row.prefix_mode,
    prefixReason: row.prefix_reason,
    acpSessionId: row.acp_session_id,
    childSessionId: row.child_session_id,
    worktree:
      row.worktree_path !== null && row.worktree_branch !== null
        ? { path: row.worktree_path, branch: row.worktree_branch }
        : null,
    state: row.state,
    error: row.error,
    revision: row.revision,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastActivityAt: row.last_activity_at,
  }));
}

function linkRow(projectId: string, id: string): ThreadLinkRow {
  const row = sql.get<ThreadLinkRow>(
    db(),
    sql`SELECT ${COLS} FROM thread_links t
         WHERE t.id = ${id} AND t.project_id = ${projectId}`,
  );
  if (!row) fail("not_found", "thread not found");
  return row;
}

function checkRevision(current: number, expected: number): void {
  if (current !== expected) {
    throw new AnchorError(
      "revision_conflict",
      `revision is ${current}, expected ${expected}`,
      current,
    );
  }
}

function optionalId(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !value || value.length > ID_MAX) {
    fail("invalid", `${field} must be a non-empty string`);
  }
  return value;
}

function validateWorktree(value: unknown): ThreadWorktree | null {
  if (value === null || value === undefined) return null;
  const w = value as Partial<ThreadWorktree>;
  if (
    typeof w.path !== "string" ||
    !w.path.startsWith("/") ||
    w.path.length > 4096 ||
    typeof w.branch !== "string" ||
    !w.branch ||
    w.branch.length > 256
  ) {
    fail("invalid", "worktree needs an absolute path and a branch");
  }
  return { path: w.path, branch: w.branch };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export interface CreateThreadLinkInput {
  projectId: string;
  source: AnchorSource;
  anchors: unknown;
  quote: unknown;
  agent: unknown;
  prefix: ThreadPrefixInput;
  createdBy?: unknown;
}

/**
 * Record a new thread in `starting` state. A session source is its own
 * parent; the child is seeded with that session up to the last anchored
 * message.
 */
export function createThreadLink(input: CreateThreadLinkInput): ThreadLink {
  if (typeof input.agent !== "string" || !AGENT_RE.test(input.agent)) {
    fail("invalid", "agent must be a registered harness name");
  }
  const agent = input.agent;
  const createdBy = input.createdBy ?? "user";
  if (typeof createdBy !== "string" || !PARTICIPANT_RE.test(createdBy)) {
    fail("invalid", "createdBy must be user, lore or agent:<id>");
  }
  const prefix = validatePrefix(input.prefix, input.source.kind);
  const id = uuidv7();
  return snapshot(() => {
    const { anchors, quote } = checkSelection(
      input.projectId,
      input.source,
      input.anchors,
      input.quote,
    );
    const session = input.source.kind === "session";
    const t = now();
    sql.run(
      db(),
      sql`INSERT INTO thread_links (id, project_id, parent_session_id,
            source_kind, source_id, anchors, quote, source_hash, anchor_status,
            agent, prefix_mode, prefix_reason, state, revision, created_by,
            created_at, updated_at, last_activity_at)
          VALUES (${id}, ${input.projectId},
            ${session ? input.source.id : null}, ${input.source.kind},
            ${input.source.id}, ${JSON.stringify(anchors)}, ${quote},
            ${sourceHashOf(anchors)}, 'current', ${agent}, ${prefix.mode},
            ${prefix.mode === "rebuilt" ? prefix.reason : null}, 'starting', 1, ${createdBy}, ${t}, ${t}, ${t})`,
    );
    if (prefix.mode === "inherited") {
      sql.run(
        db(),
        sql`INSERT INTO thread_prefixes (thread_id, model, account, wire, body,
              body_bytes, created_at)
            VALUES (${id}, ${prefix.model}, ${prefix.account}, ${prefix.wire},
              ${prefix.body}, ${prefix.bodyBytes}, ${t})`,
      );
    }
    return hydrate([linkRow(input.projectId, id)])[0];
  });
}

function validatePrefix(
  prefix: ThreadPrefixInput,
  kind: SourceKind,
): ThreadPrefixInput {
  if (prefix.mode === "rebuilt") {
    if (!PREFIX_REASONS.includes(prefix.reason)) {
      fail("invalid", "unknown prefix reason");
    }
    if ((prefix.reason === "knowledge_source") !== (kind === "knowledge")) {
      fail(
        "invalid",
        "knowledge_source is the reason for knowledge sources only",
      );
    }
    return prefix;
  }
  if (kind === "knowledge") {
    fail("invalid", "a knowledge source has no parent prefix to inherit");
  }
  if (
    !prefix.model ||
    prefix.model.length > ID_MAX ||
    !prefix.account ||
    prefix.account.length > ID_MAX ||
    !AGENT_RE.test(prefix.wire) ||
    !(prefix.body instanceof Uint8Array) ||
    prefix.body.length === 0 ||
    !Number.isSafeInteger(prefix.bodyBytes) ||
    prefix.bodyBytes <= 0
  ) {
    fail(
      "invalid",
      "an inherited prefix needs a model, account, wire and body",
    );
  }
  return prefix;
}

/** The inherited prefix of a thread; null when its prefix was rebuilt. */
export function getThreadPrefix(
  projectId: string,
  threadId: string,
): ThreadPrefix | null {
  return snapshot(() => {
    linkRow(projectId, threadId);
    const row = sql.get<{
      model: string;
      account: string;
      wire: string;
      body: Uint8Array;
      body_bytes: number;
      created_at: number;
    }>(
      db(),
      sql`SELECT model, account, wire, body, body_bytes, created_at
            FROM thread_prefixes WHERE thread_id = ${threadId}`,
    );
    return row
      ? {
          model: row.model,
          account: row.account,
          wire: row.wire,
          body: new Uint8Array(row.body),
          bodyBytes: row.body_bytes,
          createdAt: row.created_at,
        }
      : null;
  });
}

export interface UpdateThreadLinkInput {
  expectedRevision: number;
  state?: ThreadState;
  /** Required when moving to `failed`; cleared by any other state. */
  error?: string;
  acpSessionId?: string;
  worktree?: ThreadWorktree | null;
}

/** Lifecycle update from the gateway's ACP host, or a user closing the thread. */
export function updateThreadLink(
  projectId: string,
  id: string,
  input: UpdateThreadLinkInput,
): ThreadLink {
  const acpSessionId = optionalId(input.acpSessionId, "acpSessionId");
  const worktree =
    input.worktree === undefined ? undefined : validateWorktree(input.worktree);
  if (input.state !== undefined && !(input.state in TRANSITIONS)) {
    fail("invalid", "unknown thread state");
  }
  if (input.state === "failed") {
    if (typeof input.error !== "string" || !input.error.trim()) {
      fail("invalid", "a failed thread needs an error");
    }
  } else if (input.error !== undefined) {
    fail("invalid", "error is only set together with state = failed");
  }
  return snapshot(() => {
    const row = linkRow(projectId, id);
    checkRevision(row.revision, input.expectedRevision);
    if (
      (row.state === "closed" || row.state === "failed") &&
      (acpSessionId !== null || (worktree !== undefined && worktree !== null))
    ) {
      // An ended thread may only drop a worktree it kept for uncommitted work.
      fail("invalid", `a ${row.state} thread's session and worktree are final`);
    }
    const sets: SqlFragment[] = [];
    if (input.state !== undefined && input.state !== row.state) {
      if (!TRANSITIONS[row.state].includes(input.state)) {
        fail("invalid", `cannot move a ${row.state} thread to ${input.state}`);
      }
      sets.push(sql`state = ${input.state}`);
      sets.push(
        sql`error = ${input.state === "failed" ? (input.error?.trim().slice(0, ERROR_MAX) ?? null) : null}`,
      );
    }
    if (acpSessionId !== null) {
      if (row.acp_session_id !== null && row.acp_session_id !== acpSessionId) {
        fail("invalid", "the thread is already bound to an ACP session");
      }
      sets.push(sql`acp_session_id = ${acpSessionId}`);
    }
    if (worktree !== undefined) {
      sets.push(sql`worktree_path = ${worktree?.path ?? null}`);
      sets.push(sql`worktree_branch = ${worktree?.branch ?? null}`);
    }
    if (sets.length === 0) return hydrate([row])[0];
    const t = now();
    sql.run(
      db(),
      sql`UPDATE thread_links SET ${sql.join(sets, ", ")},
            revision = revision + 1, updated_at = ${t},
            last_activity_at = MAX(${t}, last_activity_at + 1)
          WHERE id = ${id} AND project_id = ${projectId}`,
    );
    return hydrate([linkRow(projectId, id)])[0];
  });
}

/**
 * Bind the Lore session the child's first gateway request resolved to.
 * Idempotent for the same session; returns false (and changes nothing) when
 * the link is unknown, closed or failed, or already bound to another session.
 */
export function bindChildSession(linkId: string, sessionId: string): boolean {
  return withTransaction(() => {
    const row = sql.get<{
      child_session_id: string | null;
      state: ThreadState;
    }>(
      db(),
      sql`SELECT t.child_session_id, t.state FROM thread_links t
            JOIN projects p ON p.id = t.project_id
           WHERE t.id = ${linkId} AND p.tenant_id = ${currentTenantId()}`,
    );
    if (!row || row.state === "closed" || row.state === "failed") return false;
    if (row.child_session_id !== null) {
      return row.child_session_id === sessionId;
    }
    const taken = sql.get(
      db(),
      sql`SELECT 1 AS ok FROM thread_links WHERE child_session_id = ${sessionId}`,
    );
    if (taken) return false;
    const t = now();
    sql.run(
      db(),
      sql`UPDATE thread_links SET child_session_id = ${sessionId},
            revision = revision + 1, updated_at = ${t},
            last_activity_at = MAX(${t}, last_activity_at + 1)
          WHERE id = ${linkId}`,
    );
    return true;
  });
}

/** A child turn was stored: move its thread up the activity order. */
export function touchThreadActivity(childSessionId: string): void {
  sql.run(
    db(),
    sql`UPDATE thread_links SET last_activity_at = MAX(${now()}, last_activity_at + 1)
         WHERE child_session_id = ${childSessionId}`,
  );
}

export function deleteThreadLink(
  projectId: string,
  id: string,
  expectedRevision: number,
): void {
  withTransaction(() => {
    checkRevision(linkRow(projectId, id).revision, expectedRevision);
    sql.run(db(), sql`DELETE FROM thread_permissions WHERE thread_id = ${id}`);
    sql.run(db(), sql`DELETE FROM thread_prefixes WHERE thread_id = ${id}`);
    sql.run(
      db(),
      sql`DELETE FROM thread_links WHERE id = ${id} AND project_id = ${projectId}`,
    );
  });
}

// ---------------------------------------------------------------------------
// Permission log
// ---------------------------------------------------------------------------

export type PermissionOptionKind = "allow_once" | "allow_always";

/** One `session/request_permission` the gateway answered on the thread's behalf. */
export interface ThreadPermission {
  id: string;
  threadId: string;
  /** ACP tool call the request was about. */
  toolCallId: string;
  title: string | null;
  /** ACP tool kind (`edit`, `execute`, `fetch`, …). */
  toolKind: string | null;
  /** Paths the tool call said it touches. */
  locations: string[];
  optionId: string;
  optionKind: PermissionOptionKind;
  createdAt: number;
}

export interface RecordPermissionInput {
  toolCallId: unknown;
  title?: unknown;
  toolKind?: unknown;
  locations?: unknown;
  optionId: unknown;
  optionKind: unknown;
}

const TITLE_MAX = 500;
const LOCATIONS_MAX = 64;

interface ThreadPermissionRow {
  id: string;
  thread_id: string;
  tool_call_id: string;
  title: string | null;
  tool_kind: string | null;
  locations: string;
  option_id: string;
  option_kind: PermissionOptionKind;
  created_at: number;
}

function permissionOut(row: ThreadPermissionRow): ThreadPermission {
  return {
    id: row.id,
    threadId: row.thread_id,
    toolCallId: row.tool_call_id,
    title: row.title,
    toolKind: row.tool_kind,
    locations: JSON.parse(row.locations) as string[],
    optionId: row.option_id,
    optionKind: row.option_kind,
    createdAt: row.created_at,
  };
}

function requiredId(value: unknown, field: string): string {
  const id = optionalId(value, field);
  if (id === null) fail("invalid", `${field} is required`);
  return id;
}

/**
 * Log an auto-approved permission request and move the thread up the
 * activity order. Only open threads take new entries.
 */
export function recordPermission(
  projectId: string,
  threadId: string,
  input: RecordPermissionInput,
): ThreadPermission {
  const toolCallId = requiredId(input.toolCallId, "toolCallId");
  const optionId = requiredId(input.optionId, "optionId");
  if (
    input.optionKind !== "allow_once" &&
    input.optionKind !== "allow_always"
  ) {
    fail("invalid", "optionKind must be allow_once or allow_always");
  }
  const optionKind: PermissionOptionKind = input.optionKind;
  const title =
    typeof input.title === "string" && input.title.trim()
      ? input.title.trim().slice(0, TITLE_MAX)
      : null;
  const toolKind = optionalId(input.toolKind, "toolKind");
  const locations = input.locations ?? [];
  if (
    !Array.isArray(locations) ||
    locations.length > LOCATIONS_MAX ||
    !locations.every(
      (l): l is string =>
        typeof l === "string" && l.length > 0 && l.length <= 4096,
    )
  ) {
    fail("invalid", "locations must be a list of paths");
  }
  const id = uuidv7();
  return withTransaction(() => {
    const row = linkRow(projectId, threadId);
    if (row.state === "closed" || row.state === "failed") {
      fail("invalid", `cannot log a permission on a ${row.state} thread`);
    }
    const t = now();
    sql.run(
      db(),
      sql`INSERT INTO thread_permissions (id, thread_id, tool_call_id, title,
            tool_kind, locations, option_id, option_kind, created_at)
          VALUES (${id}, ${threadId}, ${toolCallId}, ${title}, ${toolKind},
            ${JSON.stringify(locations)}, ${optionId}, ${optionKind}, ${t})`,
    );
    sql.run(
      db(),
      sql`UPDATE thread_links SET last_activity_at = MAX(${t}, last_activity_at + 1)
           WHERE id = ${threadId}`,
    );
    const stored = sql.get<ThreadPermissionRow>(
      db(),
      sql`SELECT * FROM thread_permissions WHERE id = ${id}`,
    );
    if (!stored) fail("not_found", "permission not found");
    return permissionOut(stored);
  });
}

/** A thread's permission log, oldest first; keyset on `(created_at, id)`. */
export function listPermissions(input: {
  projectId: string;
  threadId: string;
  limit: number;
  after?: { createdAt: number; id: string };
}): {
  permissions: ThreadPermission[];
  next: { createdAt: number; id: string } | null;
} {
  return snapshot(() => {
    linkRow(input.projectId, input.threadId);
    const after = input.after
      ? sql`AND (created_at > ${input.after.createdAt}
             OR (created_at = ${input.after.createdAt} AND id > ${input.after.id}))`
      : sql``;
    const rows = sql.all<ThreadPermissionRow>(
      db(),
      sql`SELECT * FROM thread_permissions
           WHERE thread_id = ${input.threadId} ${after}
           ORDER BY created_at, id
           LIMIT ${input.limit + 1}`,
    );
    const more = rows.length > input.limit;
    const kept = more ? rows.slice(0, input.limit) : rows;
    const last = kept.at(-1);
    return {
      permissions: kept.map(permissionOut),
      next: more && last ? { createdAt: last.created_at, id: last.id } : null,
    };
  });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export function getThreadLink(projectId: string, id: string): ThreadLink {
  return snapshot(() => hydrate([linkRow(projectId, id)])[0]);
}

/** The link a gateway request's `X-Lore-Thread` names, within this tenant. */
export function findThreadLink(id: string): ThreadLink | null {
  return snapshot(() => {
    const row = sql.get<ThreadLinkRow>(
      db(),
      sql`SELECT ${COLS} FROM thread_links t
            JOIN projects p ON p.id = t.project_id
           WHERE t.id = ${id} AND p.tenant_id = ${currentTenantId()}`,
    );
    return row ? hydrate([row])[0] : null;
  });
}

/** The link whose child is this Lore session, if any. */
export function findThreadLinkByChild(sessionId: string): ThreadLink | null {
  return snapshot(() => {
    const row = sql.get<ThreadLinkRow>(
      db(),
      sql`SELECT ${COLS} FROM thread_links t
            JOIN projects p ON p.id = t.project_id
           WHERE t.child_session_id = ${sessionId}
             AND p.tenant_id = ${currentTenantId()}`,
    );
    return row ? hydrate([row])[0] : null;
  });
}

function afterKey(after: ActivityKey | undefined): SqlFragment {
  return after
    ? sql`AND (t.last_activity_at < ${after.lastActivityAt}
           OR (t.last_activity_at = ${after.lastActivityAt} AND t.id < ${after.id}))`
    : sql``;
}

function page(
  rows: ThreadLinkRow[],
  limit: number,
): { threads: ThreadLink[]; next: ActivityKey | null } {
  const more = rows.length > limit;
  const kept = more ? rows.slice(0, limit) : rows;
  const last = kept.at(-1);
  return {
    threads: hydrate(kept),
    next:
      more && last
        ? { lastActivityAt: last.last_activity_at, id: last.id }
        : null,
  };
}

export interface ListThreadLinksInput {
  projectId: string;
  source?: AnchorSource;
  state?: ThreadState;
  limit: number;
  /** Keyset: rows strictly after this `(last_activity_at DESC, id DESC)`. */
  after?: ActivityKey;
}

/** A project's threads, most recent activity first. */
export function listThreadLinks(input: ListThreadLinksInput): {
  threads: ThreadLink[];
  next: ActivityKey | null;
} {
  const sourceFilter = input.source
    ? sql`AND t.source_kind = ${input.source.kind} AND t.source_id = ${input.source.id}`
    : sql``;
  const stateFilter = input.state ? sql`AND t.state = ${input.state}` : sql``;
  return snapshot(() =>
    page(
      sql.all<ThreadLinkRow>(
        db(),
        sql`SELECT ${COLS} FROM thread_links t
             WHERE t.project_id = ${input.projectId}
               ${sourceFilter} ${stateFilter} ${afterKey(input.after)}
             ORDER BY t.last_activity_at DESC, t.id DESC
             LIMIT ${input.limit + 1}`,
      ),
      input.limit,
    ),
  );
}

/**
 * Internal activity feed query: the tenant's threads ordered by
 * `(last_activity_at DESC, id DESC)`, optionally narrowed to one project.
 * The activity API (#2028) unions this in as `kind: "discussion"`.
 */
export function listThreadLinksByActivity(input: {
  projectId?: string;
  limit: number;
  after?: ActivityKey;
}): { threads: ThreadLink[]; next: ActivityKey | null } {
  const projectFilter = input.projectId
    ? sql`AND t.project_id = ${input.projectId}`
    : sql``;
  return snapshot(() =>
    page(
      sql.all<ThreadLinkRow>(
        db(),
        sql`SELECT ${COLS} FROM thread_links t
              JOIN projects p ON p.id = t.project_id
             WHERE p.tenant_id = ${currentTenantId()}
               ${projectFilter} ${afterKey(input.after)}
             ORDER BY t.last_activity_at DESC, t.id DESC
             LIMIT ${input.limit + 1}`,
      ),
      input.limit,
    ),
  );
}
