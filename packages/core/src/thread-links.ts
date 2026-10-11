/**
 * Thread links (#1809): a thread started from a selection is a forked agent
 * session, run on the harness through ACP by the gateway. Core only stores
 * the link — parent source and anchor, the harness, the child session ids and
 * the lifecycle state — and never the child's turns, which reach
 * `temporal_messages` through the gateway like any other session.
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
/** `native`: ACP `session/fork` of the parent; `seeded`: `session/new` seeded with the parent up to the anchor. */
export type ForkMode = "native" | "seeded";

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
  forkMode: ForkMode;
  /** Parent temporal message the child forks after; null for knowledge. */
  forkPoint: string | null;
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
  fork_mode: ForkMode;
  fork_point: string | null;
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
   t.anchors, t.quote, t.source_hash, t.anchor_status, t.agent, t.fork_mode,
   t.fork_point, t.acp_session_id, t.child_session_id, t.worktree_path,
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
    forkMode: row.fork_mode,
    forkPoint: row.fork_point,
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
  forkMode: unknown;
  createdBy?: unknown;
}

/**
 * Record a new thread in `starting` state. The parent session and fork point
 * derive from the selection: a session source is its own parent, and the
 * child forks after the last anchored message.
 */
export function createThreadLink(input: CreateThreadLinkInput): ThreadLink {
  if (typeof input.agent !== "string" || !AGENT_RE.test(input.agent)) {
    fail("invalid", "agent must be a registered harness name");
  }
  const agent = input.agent;
  if (input.forkMode !== "native" && input.forkMode !== "seeded") {
    fail("invalid", "forkMode must be native or seeded");
  }
  const forkMode: ForkMode = input.forkMode;
  const createdBy = input.createdBy ?? "user";
  if (typeof createdBy !== "string" || !PARTICIPANT_RE.test(createdBy)) {
    fail("invalid", "createdBy must be user, lore or agent:<id>");
  }
  const id = uuidv7();
  return snapshot(() => {
    const { anchors, quote } = checkSelection(
      input.projectId,
      input.source,
      input.anchors,
      input.quote,
    );
    const session = input.source.kind === "session";
    const forkPoint = session ? anchors.at(-1)!.blockId.slice(2) : null;
    const t = now();
    sql.run(
      db(),
      sql`INSERT INTO thread_links (id, project_id, parent_session_id,
            source_kind, source_id, anchors, quote, source_hash, anchor_status,
            agent, fork_mode, fork_point, state, revision, created_by,
            created_at, updated_at, last_activity_at)
          VALUES (${id}, ${input.projectId},
            ${session ? input.source.id : null}, ${input.source.kind},
            ${input.source.id}, ${JSON.stringify(anchors)}, ${quote},
            ${sourceHashOf(anchors)}, 'current', ${agent}, ${forkMode},
            ${forkPoint}, 'starting', 1, ${createdBy}, ${t}, ${t}, ${t})`,
    );
    return hydrate([linkRow(input.projectId, id)])[0];
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
    const sets: SqlFragment[] = [];
    if (input.state !== undefined && input.state !== row.state) {
      if (!TRANSITIONS[row.state].includes(input.state)) {
        fail("invalid", `cannot move a ${row.state} thread to ${input.state}`);
      }
      sets.push(sql`state = ${input.state}`);
      sets.push(
        sql`error = ${input.state === "failed" ? input.error!.trim().slice(0, ERROR_MAX) : null}`,
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
    sql.run(
      db(),
      sql`DELETE FROM thread_links WHERE id = ${id} AND project_id = ${projectId}`,
    );
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
