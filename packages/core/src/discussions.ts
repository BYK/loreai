/**
 * Durable discussions (APP-01, #1809): project-scoped threads, discussions
 * anchored to a source selection, and their replies.
 *
 * A discussion points at its source through logical `SourceAnchor`s (block
 * id, optional part index, offsets into the displayed text, part content
 * hash) — the same shape the UI reader mints — and keeps only the short
 * quote the UI shows. It never copies the transcript.
 *
 * Every read re-derives the current part hashes of the anchored source. When
 * any hash moved the discussion is marked `stale_anchor` (or
 * `source_missing` when the block is gone). The transition is persisted,
 * one-way, and the anchors themselves are never rewritten: re-anchoring is a
 * user decision, not something the server guesses at.
 *
 * Mutations take the caller's `expectedRevision`; a mismatch throws a
 * `revision_conflict` DiscussionError carrying the current revision.
 */
import { uuidv7 } from "uuidv7";
import { contentHash } from "./content-hash";
import { db, withTransaction } from "./db";
import { sql, type SqlFragment } from "./sql";
import { CHUNK_TERMINATOR } from "./temporal";
import { currentTenantId } from "./tenant";

export type Participant = "user" | "lore" | `agent:${string}`;
export type SourceKind = "session" | "knowledge";
export type DiscussionKind = "discussion" | "note";
export type DiscussionState = "open" | "resolved";
export type AnchorStatus = "current" | "stale_anchor" | "source_missing";

export interface SourceAnchor {
  blockId: string;
  partIndex?: number;
  start: number;
  end: number;
  contentHash: string;
}

export interface DiscussionSource {
  kind: SourceKind;
  id: string;
}

export interface Discussion {
  id: string;
  projectId: string;
  threadId: string | null;
  kind: DiscussionKind;
  source: DiscussionSource;
  anchors: SourceAnchor[];
  quote: string;
  sourceHash: string;
  state: DiscussionState;
  anchorStatus: AnchorStatus;
  revision: number;
  createdBy: Participant;
  createdAt: number;
  updatedAt: number;
  lastActivityAt: number;
  replyCount: number;
  /** Creator first, then reply authors in order of first appearance. */
  participants: Participant[];
}

export interface ResponseBinding {
  id: string;
  sessionId: string;
  messageId: string;
  agent: string;
  verifiedAt: number;
}

export type ReplyContent =
  | { kind: "text"; body: string }
  | { kind: "response"; binding: ResponseBinding };

export interface DiscussionReply {
  id: string;
  discussionId: string;
  seq: number;
  parentReplyId: string | null;
  author: Participant;
  content: ReplyContent;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface Thread {
  id: string;
  projectId: string;
  title: string;
  revision: number;
  createdBy: Participant;
  createdAt: number;
  updatedAt: number;
  discussionCount: number;
}

export type DiscussionErrorCode =
  | "not_found"
  | "invalid"
  | "revision_conflict"
  | "source_changed";

export class DiscussionError extends Error {
  constructor(
    readonly code: DiscussionErrorCode,
    message: string,
    readonly currentRevision?: number,
  ) {
    super(message);
    this.name = "DiscussionError";
  }
}

export const QUOTE_MAX = 600;
export const BODY_MAX = 20_000;
export const TITLE_MAX = 200;
export const ANCHORS_MAX = 64;
const OFFSET_MAX = 10_000_000;
const PARTICIPANT_RE = /^(user|lore|agent:[A-Za-z0-9._:@/-]{1,128})$/;
const HASH_RE = /^[0-9a-z]{1,11}$/;
const CHUNK_SEPARATOR = `\n${CHUNK_TERMINATOR}`;
const REASONING_PREFIX = "[reasoning] ";
const TOOL_ENVELOPE = /^\[tool:([^\]\s]{1,200})\] ?/;

export function isParticipant(value: unknown): value is Participant {
  return typeof value === "string" && PARTICIPANT_RE.test(value);
}

function fail(code: DiscussionErrorCode, message: string): never {
  throw new DiscussionError(code, message);
}

// ---------------------------------------------------------------------------
// Source revisions
// ---------------------------------------------------------------------------

/** Part hashes of a stored message, mirroring the UI reader's `parseParts`. */
export function messagePartHashes(content: string): string[] {
  return content.split(CHUNK_SEPARATOR).map((chunk) => {
    if (chunk.startsWith(REASONING_PREFIX)) {
      return contentHash(chunk.slice(REASONING_PREFIX.length));
    }
    const tool = TOOL_ENVELOPE.exec(chunk);
    return contentHash(tool ? chunk.slice(tool[0].length) : chunk);
  });
}

/** Paragraph hashes of a knowledge entry, mirroring `KnowledgeDocument`. */
export function knowledgePartHashes(content: string): string[] {
  return content
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map(contentHash);
}

/** Whole-block hash: a single-part block hashes like its part. */
export function blockHashOf(partHashes: readonly string[]): string {
  return partHashes.length === 1
    ? partHashes[0]
    : contentHash(partHashes.join("|"));
}

export function knowledgeBlockId(logicalId: string): string {
  return `k.${logicalId}`;
}

/** Revision of the selection: the ordered anchor hashes, hashed. */
export function sourceHashOf(anchors: readonly SourceAnchor[]): string {
  return contentHash(anchors.map((a) => a.contentHash).join("|"));
}

interface SourceBlocks {
  /** blockId → part hashes, in source order. */
  blocks: Map<string, string[]>;
}

function sessionBlocks(
  projectId: string,
  sessionId: string,
  blockIds: readonly string[],
): SourceBlocks {
  const ids = [
    ...new Set(
      blockIds.filter((b) => b.startsWith("m.")).map((b) => b.slice(2)),
    ),
  ];
  const blocks = new Map<string, string[]>();
  if (ids.length === 0) return { blocks };
  const rows = sql.all<{ id: string; content: string }>(
    db(),
    sql`SELECT id, content FROM temporal_messages
         WHERE project_id = ${projectId} AND session_id = ${sessionId}
           AND id ${sql.inList(ids)}
         ORDER BY created_at, id`,
  );
  for (const row of rows) {
    blocks.set(`m.${row.id}`, messagePartHashes(row.content));
  }
  return { blocks };
}

function knowledgeRow(
  projectId: string,
  logicalId: string,
): { content: string } | null {
  return sql.get<{ content: string }>(
    db(),
    sql`SELECT content FROM knowledge_current
         WHERE tenant_id = ${currentTenantId()} AND logical_id = ${logicalId}
           AND (project_id = ${projectId} OR project_id IS NULL OR cross_project = 1)
         LIMIT 1`,
  );
}

function knowledgeBlocks(projectId: string, logicalId: string): SourceBlocks {
  const blocks = new Map<string, string[]>();
  const row = knowledgeRow(projectId, logicalId);
  if (row) {
    blocks.set(knowledgeBlockId(logicalId), knowledgePartHashes(row.content));
  }
  return { blocks };
}

function loadSource(
  projectId: string,
  source: DiscussionSource,
  anchors: readonly SourceAnchor[],
): SourceBlocks {
  return source.kind === "session"
    ? sessionBlocks(
        projectId,
        source.id,
        anchors.map((a) => a.blockId),
      )
    : knowledgeBlocks(projectId, source.id);
}

/** Current hash of the anchored span, or null when its block/part is gone. */
function currentAnchorHash(
  anchor: SourceAnchor,
  source: SourceBlocks,
): string | null {
  const parts = source.blocks.get(anchor.blockId);
  // A block with no parts left (a cleared entry) has nothing to anchor to.
  if (!parts || parts.length === 0) return null;
  if (anchor.partIndex === undefined) return blockHashOf(parts);
  return parts[anchor.partIndex] ?? null;
}

/** `current` iff every anchored part still carries the anchor's hash. */
export function anchorStatusOf(
  anchors: readonly SourceAnchor[],
  source: SourceBlocks,
): AnchorStatus {
  let status: AnchorStatus = "current";
  for (const anchor of anchors) {
    const hash = currentAnchorHash(anchor, source);
    if (hash === null) return "source_missing";
    if (hash !== anchor.contentHash) status = "stale_anchor";
  }
  return status;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function int(value: unknown, min: number, max: number): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= min &&
    value <= max
  );
}

/** Validate one contiguous, ordered selection within a single source. */
export function validateAnchors(
  source: DiscussionSource,
  anchors: unknown,
): SourceAnchor[] {
  if (!Array.isArray(anchors) || anchors.length === 0) {
    fail("invalid", "anchors must be a non-empty array");
  }
  if (anchors.length > ANCHORS_MAX) {
    fail("invalid", `at most ${ANCHORS_MAX} anchors per discussion`);
  }
  const out: SourceAnchor[] = [];
  for (const raw of anchors as unknown[]) {
    if (typeof raw !== "object" || raw === null) {
      fail("invalid", "anchor must be an object");
    }
    const a = raw as Record<string, unknown>;
    const blockId = a.blockId;
    if (typeof blockId !== "string" || blockId.length > 256) {
      fail("invalid", "anchor.blockId must be a string");
    }
    if (source.kind === "session" && !/^m\.[^\s]{1,200}$/.test(blockId)) {
      fail("invalid", "session anchors must reference message blocks (m.<id>)");
    }
    if (
      source.kind === "knowledge" &&
      blockId !== knowledgeBlockId(source.id)
    ) {
      fail("invalid", "knowledge anchors must reference the entry block");
    }
    if (typeof a.contentHash !== "string" || !HASH_RE.test(a.contentHash)) {
      fail("invalid", "anchor.contentHash is malformed");
    }
    if (!int(a.start, 0, OFFSET_MAX) || !int(a.end, 0, OFFSET_MAX)) {
      fail("invalid", "anchor offsets must be non-negative integers");
    }
    const anchor: SourceAnchor = {
      blockId,
      start: a.start,
      end: a.end,
      contentHash: a.contentHash,
    };
    if (a.partIndex === undefined || a.partIndex === null) {
      if (a.start !== 0 || a.end !== 0) {
        fail("invalid", "a whole-block anchor has start = end = 0");
      }
    } else {
      if (!int(a.partIndex, 0, 100_000)) {
        fail("invalid", "anchor.partIndex must be a non-negative integer");
      }
      if (a.end <= a.start) fail("invalid", "anchor range must be non-empty");
      anchor.partIndex = a.partIndex;
    }
    out.push(anchor);
  }
  for (let i = 1; i < out.length; i++) {
    const prev = out[i - 1];
    const cur = out[i];
    if (prev.blockId !== cur.blockId) continue;
    if (prev.partIndex === undefined || cur.partIndex === undefined) {
      fail("invalid", "a whole-block anchor cannot share its block");
    }
    if (
      cur.partIndex < prev.partIndex ||
      (cur.partIndex === prev.partIndex && cur.start < prev.end)
    ) {
      fail("invalid", "anchors must be ordered and non-overlapping");
    }
  }
  const blockOrder: string[] = [];
  for (const a of out) {
    if (blockOrder.at(-1) === a.blockId) continue;
    if (blockOrder.includes(a.blockId)) {
      fail("invalid", "anchors of one block must be adjacent");
    }
    blockOrder.push(a.blockId);
  }
  return out;
}

function validateQuote(quote: unknown): string {
  if (typeof quote !== "string") fail("invalid", "quote must be a string");
  const q = quote.trim();
  if (q.length === 0) fail("invalid", "quote must not be empty");
  if (q.length > QUOTE_MAX) {
    fail("invalid", `quote must be at most ${QUOTE_MAX} characters`);
  }
  return q;
}

function validateBody(body: unknown): string {
  if (typeof body !== "string") fail("invalid", "body must be a string");
  const b = body.trim();
  if (b.length === 0) fail("invalid", "body must not be empty");
  if (b.length > BODY_MAX) {
    fail("invalid", `body must be at most ${BODY_MAX} characters`);
  }
  return b;
}

function validateTitle(title: unknown): string {
  if (typeof title !== "string") fail("invalid", "title must be a string");
  const t = title.trim();
  if (t.length === 0 || t.length > TITLE_MAX) {
    fail("invalid", `title must be 1-${TITLE_MAX} characters`);
  }
  return t;
}

function participant(value: unknown, fallback: Participant): Participant {
  if (value === undefined) return fallback;
  if (!isParticipant(value)) {
    fail("invalid", "participant must be user, lore or agent:<id>");
  }
  return value;
}

function checkRevision(current: number, expected: number): void {
  if (current !== expected) {
    throw new DiscussionError(
      "revision_conflict",
      `revision is ${current}, expected ${expected}`,
      current,
    );
  }
}

function assertProject(projectId: string): void {
  const row = sql.get(
    db(),
    sql`SELECT 1 AS ok FROM projects WHERE id = ${projectId} AND tenant_id = ${currentTenantId()}`,
  );
  if (!row) fail("not_found", "project not found");
}

/** Ordered by position in the session; rejects anchors out of source order. */
function assertSourceOrder(
  anchors: readonly SourceAnchor[],
  source: SourceBlocks,
): void {
  const order = [...source.blocks.keys()];
  let last = -1;
  for (const a of anchors) {
    const at = order.indexOf(a.blockId);
    if (at < last) fail("invalid", "anchors must follow source order");
    last = at;
  }
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

interface DiscussionRow {
  id: string;
  project_id: string;
  thread_id: string | null;
  kind: DiscussionKind;
  source_kind: SourceKind;
  source_id: string;
  anchors: string;
  quote: string;
  source_hash: string;
  state: DiscussionState;
  anchor_status: AnchorStatus;
  revision: number;
  created_by: Participant;
  created_at: number;
  updated_at: number;
  last_activity_at: number;
}

interface ReplyRow {
  id: string;
  discussion_id: string;
  seq: number;
  parent_reply_id: string | null;
  author: Participant;
  body: string | null;
  response_binding_id: string | null;
  revision: number;
  created_at: number;
  updated_at: number;
  b_session_id: string | null;
  b_message_id: string | null;
  b_agent: string | null;
  b_verified_at: number | null;
}

const DISCUSSION_COLS = sql.raw(
  "d.id, d.project_id, d.thread_id, d.kind, d.source_kind, d.source_id, d.anchors, d.quote, d.source_hash, d.state, d.anchor_status, d.revision, d.created_by, d.created_at, d.updated_at, d.last_activity_at",
);

const REPLY_SELECT = sql.raw(
  `SELECT r.id, r.discussion_id, r.seq, r.parent_reply_id, r.author, r.body,
          r.response_binding_id, r.revision, r.created_at, r.updated_at,
          b.session_id AS b_session_id, b.message_id AS b_message_id,
          b.agent AS b_agent, b.verified_at AS b_verified_at
     FROM discussion_replies r
     LEFT JOIN response_bindings b ON b.id = r.response_binding_id`,
);

function toReply(row: ReplyRow): DiscussionReply {
  const content: ReplyContent =
    row.body !== null
      ? { kind: "text", body: row.body }
      : {
          kind: "response",
          binding: {
            id: row.response_binding_id!,
            sessionId: row.b_session_id!,
            messageId: row.b_message_id!,
            agent: row.b_agent!,
            verifiedAt: row.b_verified_at!,
          },
        };
  return {
    id: row.id,
    discussionId: row.discussion_id,
    seq: row.seq,
    parentReplyId: row.parent_reply_id,
    author: row.author,
    content,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Hydrate rows: re-check anchors against the live source (persisting a
 * one-way `current → stale_anchor | source_missing` transition) and attach
 * reply counts and participants.
 */
function hydrate(rows: DiscussionRow[]): Discussion[] {
  if (rows.length === 0) return [];
  const sources = new Map<string, SourceBlocks>();
  const statuses = new Map<string, AnchorStatus>();
  for (const row of rows) {
    const anchors = JSON.parse(row.anchors) as SourceAnchor[];
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
    const status = anchorStatusOf(anchors, source);
    if (status !== row.anchor_status && status !== "current") {
      statuses.set(row.id, status);
    }
  }
  for (const [id, status] of statuses) {
    sql.run(
      db(),
      sql`UPDATE discussions SET anchor_status = ${status}
           WHERE id = ${id} AND anchor_status <> 'source_missing'`,
    );
  }
  const ids = rows.map((r) => r.id);
  const counts = new Map<string, number>();
  for (const c of sql.all<{ discussion_id: string; n: number }>(
    db(),
    sql`SELECT discussion_id, COUNT(*) AS n FROM discussion_replies
         WHERE discussion_id ${sql.inList(ids)} GROUP BY discussion_id`,
  )) {
    counts.set(c.discussion_id, c.n);
  }
  const authors = new Map<string, Participant[]>();
  for (const a of sql.all<{ discussion_id: string; author: Participant }>(
    db(),
    sql`SELECT discussion_id, author, MIN(seq) AS first_seq
          FROM discussion_replies
         WHERE discussion_id ${sql.inList(ids)}
         GROUP BY discussion_id, author
         ORDER BY discussion_id, first_seq`,
  )) {
    const list = authors.get(a.discussion_id) ?? [];
    list.push(a.author);
    authors.set(a.discussion_id, list);
  }
  return rows.map((row) => {
    const participants = [row.created_by];
    for (const p of authors.get(row.id) ?? []) {
      if (!participants.includes(p)) participants.push(p);
    }
    return {
      id: row.id,
      projectId: row.project_id,
      threadId: row.thread_id,
      kind: row.kind,
      source: { kind: row.source_kind, id: row.source_id },
      anchors: JSON.parse(row.anchors) as SourceAnchor[],
      quote: row.quote,
      sourceHash: row.source_hash,
      state: row.state,
      anchorStatus: statuses.get(row.id) ?? row.anchor_status,
      revision: row.revision,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastActivityAt: row.last_activity_at,
      replyCount: counts.get(row.id) ?? 0,
      participants,
    };
  });
}

function discussionRow(projectId: string, id: string): DiscussionRow {
  const row = sql.get<DiscussionRow>(
    db(),
    sql`SELECT ${DISCUSSION_COLS} FROM discussions d
         WHERE d.id = ${id} AND d.project_id = ${projectId}`,
  );
  if (!row) fail("not_found", "discussion not found");
  return row;
}

function threadRow(
  projectId: string,
  id: string,
): { id: string; revision: number } {
  const row = sql.get<{ id: string; revision: number }>(
    db(),
    sql`SELECT id, revision FROM threads WHERE id = ${id} AND project_id = ${projectId}`,
  );
  if (!row) fail("not_found", "thread not found");
  return row;
}

/** Monotonic per-process clock: equal-millisecond writes still order. */
let lastNow = 0;
function now(): number {
  const t = Date.now();
  lastNow = t > lastNow ? t : lastNow + 1;
  return lastNow;
}

// ---------------------------------------------------------------------------
// Discussions
// ---------------------------------------------------------------------------

export interface CreateDiscussionInput {
  projectId: string;
  kind?: DiscussionKind;
  source: DiscussionSource;
  anchors: unknown;
  quote: unknown;
  createdBy?: unknown;
  threadId?: string | null;
  /** Optional opening reply, authored by `createdBy`. */
  body?: unknown;
}

export function createDiscussion(input: CreateDiscussionInput): {
  discussion: Discussion;
  reply: DiscussionReply | null;
} {
  const kind = input.kind ?? "discussion";
  if (kind !== "discussion" && kind !== "note") {
    fail("invalid", "kind must be discussion or note");
  }
  const { source } = input;
  if (source.kind !== "session" && source.kind !== "knowledge") {
    fail("invalid", "source.kind must be session or knowledge");
  }
  if (typeof source.id !== "string" || !source.id || source.id.length > 256) {
    fail("invalid", "source.id is required");
  }
  const anchors = validateAnchors(source, input.anchors);
  const quote = validateQuote(input.quote);
  const createdBy = participant(input.createdBy, "user");
  const body = input.body === undefined ? null : validateBody(input.body);
  const id = uuidv7();
  withTransaction(() => {
    assertProject(input.projectId);
    if (input.threadId) threadRow(input.projectId, input.threadId);
    const live = loadSource(input.projectId, source, anchors);
    if (live.blocks.size === 0) fail("not_found", "source not found");
    for (const a of anchors) {
      const parts = live.blocks.get(a.blockId);
      if (parts && a.partIndex !== undefined && a.partIndex >= parts.length) {
        fail("invalid", "anchor.partIndex is past the end of its block");
      }
    }
    const status = anchorStatusOf(anchors, live);
    if (status === "source_missing")
      fail("not_found", "anchored block not found");
    if (status !== "current") {
      fail("source_changed", "the source changed since it was selected");
    }
    if (source.kind === "session") assertSourceOrder(anchors, live);
    const t = now();
    sql.run(
      db(),
      sql`INSERT INTO discussions (id, project_id, thread_id, kind, source_kind,
            source_id, anchors, quote, source_hash, state, anchor_status,
            revision, created_by, created_at, updated_at, last_activity_at)
          VALUES (${id}, ${input.projectId}, ${input.threadId ?? null}, ${kind},
            ${source.kind}, ${source.id}, ${JSON.stringify(anchors)}, ${quote},
            ${sourceHashOf(anchors)}, 'open', 'current', 1, ${createdBy},
            ${t}, ${t}, ${t})`,
    );
    if (input.threadId) touchThread(input.threadId, t);
    if (body !== null) {
      insertReply({
        projectId: input.projectId,
        discussionId: id,
        author: createdBy,
        parentReplyId: null,
        body,
        bindingId: null,
        at: t,
      });
    }
  });
  const discussion = getDiscussion(input.projectId, id);
  const reply =
    body === null
      ? null
      : (listReplies(input.projectId, id).replies[0] ?? null);
  return { discussion, reply };
}

export function getDiscussion(projectId: string, id: string): Discussion {
  return hydrate([discussionRow(projectId, id)])[0];
}

export interface ActivityKey {
  lastActivityAt: number;
  id: string;
}

export interface ListDiscussionsInput {
  projectId: string;
  source?: DiscussionSource;
  state?: DiscussionState;
  threadId?: string;
  limit: number;
  /** Keyset: rows strictly after this `(last_activity_at DESC, id DESC)`. */
  after?: ActivityKey;
}

function afterKey(after: ActivityKey | undefined): SqlFragment {
  return after
    ? sql`AND (d.last_activity_at < ${after.lastActivityAt}
           OR (d.last_activity_at = ${after.lastActivityAt} AND d.id < ${after.id}))`
    : sql``;
}

function page(
  rows: DiscussionRow[],
  limit: number,
): { discussions: Discussion[]; next: ActivityKey | null } {
  const more = rows.length > limit;
  const kept = more ? rows.slice(0, limit) : rows;
  const last = kept.at(-1);
  return {
    discussions: hydrate(kept),
    next:
      more && last
        ? { lastActivityAt: last.last_activity_at, id: last.id }
        : null,
  };
}

/** A project's discussions, most recent activity first. */
export function listDiscussions(input: ListDiscussionsInput): {
  discussions: Discussion[];
  next: ActivityKey | null;
} {
  const sourceFilter = input.source
    ? sql`AND d.source_kind = ${input.source.kind} AND d.source_id = ${input.source.id}`
    : sql``;
  const stateFilter = input.state ? sql`AND d.state = ${input.state}` : sql``;
  const threadFilter = input.threadId
    ? sql`AND d.thread_id = ${input.threadId}`
    : sql``;
  const rows = sql.all<DiscussionRow>(
    db(),
    sql`SELECT ${DISCUSSION_COLS} FROM discussions d
         WHERE d.project_id = ${input.projectId}
           ${sourceFilter} ${stateFilter} ${threadFilter} ${afterKey(input.after)}
         ORDER BY d.last_activity_at DESC, d.id DESC
         LIMIT ${input.limit + 1}`,
  );
  return page(rows, input.limit);
}

/**
 * Internal activity feed query: the tenant's discussions ordered by
 * `(last_activity_at DESC, id DESC)`, optionally narrowed to one project.
 * The activity API (#2028) unions this in as `kind: "discussion"`.
 */
export function listDiscussionsByActivity(input: {
  projectId?: string;
  limit: number;
  after?: ActivityKey;
}): { discussions: Discussion[]; next: ActivityKey | null } {
  const projectFilter = input.projectId
    ? sql`AND d.project_id = ${input.projectId}`
    : sql``;
  const rows = sql.all<DiscussionRow>(
    db(),
    sql`SELECT ${DISCUSSION_COLS} FROM discussions d
          JOIN projects p ON p.id = d.project_id
         WHERE p.tenant_id = ${currentTenantId()}
           ${projectFilter} ${afterKey(input.after)}
         ORDER BY d.last_activity_at DESC, d.id DESC
         LIMIT ${input.limit + 1}`,
  );
  return page(rows, input.limit);
}

export interface UpdateDiscussionInput {
  expectedRevision: number;
  state?: DiscussionState;
  threadId?: string | null;
}

export function updateDiscussion(
  projectId: string,
  id: string,
  input: UpdateDiscussionInput,
): Discussion {
  if (input.state === undefined && input.threadId === undefined) {
    fail("invalid", "nothing to update");
  }
  if (
    input.state !== undefined &&
    input.state !== "open" &&
    input.state !== "resolved"
  ) {
    fail("invalid", "state must be open or resolved");
  }
  withTransaction(() => {
    const row = discussionRow(projectId, id);
    checkRevision(row.revision, input.expectedRevision);
    if (input.threadId) threadRow(projectId, input.threadId);
    const t = now();
    const state = input.state ?? row.state;
    const threadId =
      input.threadId === undefined ? row.thread_id : input.threadId;
    sql.run(
      db(),
      sql`UPDATE discussions
             SET state = ${state}, thread_id = ${threadId},
                 revision = revision + 1, updated_at = ${t}, last_activity_at = ${t}
           WHERE id = ${id} AND project_id = ${projectId}`,
    );
    for (const tid of new Set([row.thread_id, threadId])) {
      if (tid) touchThread(tid, t);
    }
  });
  return getDiscussion(projectId, id);
}

export function deleteDiscussion(
  projectId: string,
  id: string,
  expectedRevision: number,
): void {
  withTransaction(() => {
    const row = discussionRow(projectId, id);
    checkRevision(row.revision, expectedRevision);
    const bindings = sql
      .all<{ id: string }>(
        db(),
        sql`SELECT DISTINCT response_binding_id AS id FROM discussion_replies
             WHERE discussion_id = ${id} AND response_binding_id IS NOT NULL`,
      )
      .map((b) => b.id);
    sql.run(
      db(),
      sql`DELETE FROM discussion_replies WHERE discussion_id = ${id} AND project_id = ${projectId}`,
    );
    pruneBindings(bindings);
    sql.run(
      db(),
      sql`DELETE FROM discussions WHERE id = ${id} AND project_id = ${projectId}`,
    );
    if (row.thread_id) touchThread(row.thread_id, now());
  });
}

// ---------------------------------------------------------------------------
// Replies
// ---------------------------------------------------------------------------

/** Bindings are shared per response message; drop the ones no reply uses. */
function pruneBindings(ids: readonly string[]): void {
  if (ids.length === 0) return;
  sql.run(
    db(),
    sql`DELETE FROM response_bindings
         WHERE id ${sql.inList(ids)}
           AND id NOT IN (SELECT response_binding_id FROM discussion_replies
                           WHERE response_binding_id IS NOT NULL)`,
  );
}

function insertReply(input: {
  projectId: string;
  discussionId: string;
  author: Participant;
  parentReplyId: string | null;
  body: string | null;
  bindingId: string | null;
  at: number;
}): string {
  const id = uuidv7();
  const next = sql.get<{ seq: number }>(
    db(),
    sql`SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM discussion_replies
         WHERE discussion_id = ${input.discussionId}`,
  )!.seq;
  sql.run(
    db(),
    sql`INSERT INTO discussion_replies (id, discussion_id, project_id, seq,
          parent_reply_id, author, body, response_binding_id, revision,
          created_at, updated_at)
        VALUES (${id}, ${input.discussionId}, ${input.projectId}, ${next},
          ${input.parentReplyId}, ${input.author}, ${input.body},
          ${input.bindingId}, 1, ${input.at}, ${input.at})`,
  );
  return id;
}

/**
 * Verify a native response: an assistant message stored in this project
 * and, for a session-anchored discussion, in that same session (so the
 * reply, its binding and the response always move between projects
 * together). Returns the (idempotent) binding id and the authoring
 * participant.
 */
function bindResponse(
  projectId: string,
  messageId: string,
  sessionId: string | null,
  at: number,
): { bindingId: string; author: Participant } {
  const msg = sql.get<{
    session_id: string;
    role: string;
    metadata: string | null;
  }>(
    db(),
    sql`SELECT session_id, role, metadata FROM temporal_messages
         WHERE id = ${messageId} AND project_id = ${projectId}`,
  );
  if (!msg) fail("not_found", "response message not found in this project");
  if (msg.role !== "assistant") {
    fail("invalid", "only assistant responses can be bound");
  }
  if (sessionId !== null && msg.session_id !== sessionId) {
    fail(
      "invalid",
      "a session discussion can only bind responses from its own session",
    );
  }
  let agent = "unknown";
  let synthetic = false;
  try {
    const meta = JSON.parse(msg.metadata ?? "null") as Record<
      string,
      unknown
    > | null;
    if (meta && typeof meta.agent === "string" && meta.agent.trim()) {
      agent = meta.agent.trim();
    }
    synthetic = meta?.synthetic === true || meta?.lore === true;
  } catch {
    /* malformed metadata: agent stays unknown */
  }
  const existing = sql.get<{ id: string; agent: string }>(
    db(),
    sql`SELECT id, agent FROM response_bindings
         WHERE project_id = ${projectId} AND message_id = ${messageId}`,
  );
  const bindingId = existing?.id ?? uuidv7();
  if (!existing) {
    sql.run(
      db(),
      sql`INSERT INTO response_bindings (id, project_id, session_id, message_id, agent, verified_at)
          VALUES (${bindingId}, ${projectId}, ${msg.session_id}, ${messageId}, ${agent}, ${at})`,
    );
  }
  const boundAgent = existing?.agent ?? agent;
  const author: Participant =
    synthetic || boundAgent === "lore"
      ? "lore"
      : `agent:${boundAgent.replace(/[^A-Za-z0-9._:@/-]/g, "-").slice(0, 128)}`;
  return { bindingId, author };
}

export interface AddReplyInput {
  /** The discussion's revision the reply was written against. */
  expectedRevision: number;
  author?: unknown;
  parentReplyId?: string | null;
  body?: unknown;
  /** `temporal_messages.id` of a native assistant response to bind. */
  responseMessageId?: unknown;
}

export function addReply(
  projectId: string,
  discussionId: string,
  input: AddReplyInput,
): { reply: DiscussionReply; discussion: Discussion } {
  const hasBody = input.body !== undefined && input.body !== null;
  const hasResponse =
    input.responseMessageId !== undefined && input.responseMessageId !== null;
  if (hasBody === hasResponse) {
    fail(
      "invalid",
      "a reply is either authored text or a bound response, exactly one",
    );
  }
  const body = hasBody ? validateBody(input.body) : null;
  if (
    hasResponse &&
    (typeof input.responseMessageId !== "string" ||
      !input.responseMessageId ||
      input.responseMessageId.length > 256)
  ) {
    fail("invalid", "responseMessageId must be a message id");
  }
  const requestedAuthor =
    input.author === undefined ? undefined : participant(input.author, "user");
  const replyId = withTransaction(() => {
    const row = discussionRow(projectId, discussionId);
    checkRevision(row.revision, input.expectedRevision);
    if (input.parentReplyId) {
      const parent = sql.get(
        db(),
        sql`SELECT 1 AS ok FROM discussion_replies
             WHERE id = ${input.parentReplyId} AND discussion_id = ${discussionId}`,
      );
      if (!parent) fail("not_found", "parent reply not found");
    }
    const t = now();
    let author: Participant = requestedAuthor ?? "user";
    let bindingId: string | null = null;
    if (hasResponse) {
      const bound = bindResponse(
        projectId,
        input.responseMessageId as string,
        row.source_kind === "session" ? row.source_id : null,
        t,
      );
      if (requestedAuthor !== undefined && requestedAuthor !== bound.author) {
        fail("invalid", "author does not match the bound response");
      }
      author = bound.author;
      bindingId = bound.bindingId;
    }
    const id = insertReply({
      projectId,
      discussionId,
      author,
      parentReplyId: input.parentReplyId ?? null,
      body,
      bindingId,
      at: t,
    });
    sql.run(
      db(),
      sql`UPDATE discussions
             SET revision = revision + 1, updated_at = ${t}, last_activity_at = ${t}
           WHERE id = ${discussionId}`,
    );
    if (row.thread_id) touchThread(row.thread_id, t);
    return id;
  });
  return {
    reply: getReply(projectId, discussionId, replyId),
    discussion: getDiscussion(projectId, discussionId),
  };
}

export function getReply(
  projectId: string,
  discussionId: string,
  replyId: string,
): DiscussionReply {
  const row = sql.get<ReplyRow>(
    db(),
    sql`${REPLY_SELECT}
         WHERE r.id = ${replyId} AND r.discussion_id = ${discussionId}
           AND r.project_id = ${projectId}`,
  );
  if (!row) fail("not_found", "reply not found");
  return toReply(row);
}

/** Replies in conversation order (`seq` ascending), keyset on `seq`. */
export function listReplies(
  projectId: string,
  discussionId: string,
  opts: { limit?: number; afterSeq?: number } = {},
): { replies: DiscussionReply[]; nextSeq: number | null } {
  discussionRow(projectId, discussionId);
  const limit = opts.limit ?? 500;
  const rows = sql.all<ReplyRow>(
    db(),
    sql`${REPLY_SELECT}
         WHERE r.discussion_id = ${discussionId} AND r.project_id = ${projectId}
           AND r.seq > ${opts.afterSeq ?? 0}
         ORDER BY r.seq
         LIMIT ${limit + 1}`,
  );
  const more = rows.length > limit;
  const kept = more ? rows.slice(0, limit) : rows;
  return {
    replies: kept.map(toReply),
    nextSeq: more ? (kept.at(-1)?.seq ?? null) : null,
  };
}

export function updateReply(
  projectId: string,
  discussionId: string,
  replyId: string,
  input: { expectedRevision: number; body: unknown },
): { reply: DiscussionReply; discussion: Discussion } {
  const body = validateBody(input.body);
  withTransaction(() => {
    const reply = getReply(projectId, discussionId, replyId);
    checkRevision(reply.revision, input.expectedRevision);
    if (reply.content.kind !== "text") {
      fail("invalid", "a bound response cannot be edited");
    }
    const t = now();
    sql.run(
      db(),
      sql`UPDATE discussion_replies
             SET body = ${body}, revision = revision + 1, updated_at = ${t}
           WHERE id = ${replyId}`,
    );
    sql.run(
      db(),
      sql`UPDATE discussions
             SET revision = revision + 1, updated_at = ${t}, last_activity_at = ${t}
           WHERE id = ${discussionId}`,
    );
    touchDiscussionThread(discussionId, t);
  });
  return {
    reply: getReply(projectId, discussionId, replyId),
    discussion: getDiscussion(projectId, discussionId),
  };
}

export function deleteReply(
  projectId: string,
  discussionId: string,
  replyId: string,
  expectedRevision: number,
): void {
  withTransaction(() => {
    const reply = getReply(projectId, discussionId, replyId);
    checkRevision(reply.revision, expectedRevision);
    sql.run(
      db(),
      sql`UPDATE discussion_replies SET parent_reply_id = NULL
           WHERE parent_reply_id = ${replyId}`,
    );
    sql.run(db(), sql`DELETE FROM discussion_replies WHERE id = ${replyId}`);
    if (reply.content.kind === "response")
      pruneBindings([reply.content.binding.id]);
    const t = now();
    sql.run(
      db(),
      sql`UPDATE discussions
             SET revision = revision + 1, updated_at = ${t}, last_activity_at = ${t}
           WHERE id = ${discussionId}`,
    );
    touchDiscussionThread(discussionId, t);
  });
}

// ---------------------------------------------------------------------------
// Threads
// ---------------------------------------------------------------------------

interface ThreadRow {
  id: string;
  project_id: string;
  title: string;
  revision: number;
  created_by: Participant;
  created_at: number;
  updated_at: number;
  discussion_count: number;
}

const THREAD_SELECT = sql.raw(
  `SELECT t.id, t.project_id, t.title, t.revision, t.created_by, t.created_at,
          t.updated_at,
          (SELECT COUNT(*) FROM discussions d WHERE d.thread_id = t.id) AS discussion_count
     FROM threads t`,
);

function toThread(row: ThreadRow): Thread {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    revision: row.revision,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    discussionCount: row.discussion_count,
  };
}

function touchThread(threadId: string, at: number): void {
  sql.run(
    db(),
    sql`UPDATE threads SET updated_at = ${at} WHERE id = ${threadId}`,
  );
}

function touchDiscussionThread(discussionId: string, at: number): void {
  sql.run(
    db(),
    sql`UPDATE threads SET updated_at = ${at}
         WHERE id = (SELECT thread_id FROM discussions WHERE id = ${discussionId})`,
  );
}

export function createThread(input: {
  projectId: string;
  title: unknown;
  createdBy?: unknown;
}): Thread {
  const title = validateTitle(input.title);
  const createdBy = participant(input.createdBy, "user");
  const id = uuidv7();
  withTransaction(() => {
    assertProject(input.projectId);
    const t = now();
    sql.run(
      db(),
      sql`INSERT INTO threads (id, project_id, title, revision, created_by, created_at, updated_at)
          VALUES (${id}, ${input.projectId}, ${title}, 1, ${createdBy}, ${t}, ${t})`,
    );
  });
  return getThread(input.projectId, id);
}

export function getThread(projectId: string, id: string): Thread {
  const row = sql.get<ThreadRow>(
    db(),
    sql`${THREAD_SELECT} WHERE t.id = ${id} AND t.project_id = ${projectId}`,
  );
  if (!row) fail("not_found", "thread not found");
  return toThread(row);
}

export interface ThreadKey {
  updatedAt: number;
  id: string;
}

/** A project's threads, most recently updated first. */
export function listThreads(input: {
  projectId: string;
  limit: number;
  after?: ThreadKey;
}): { threads: Thread[]; next: ThreadKey | null } {
  const after = input.after
    ? sql`AND (t.updated_at < ${input.after.updatedAt}
           OR (t.updated_at = ${input.after.updatedAt} AND t.id < ${input.after.id}))`
    : sql``;
  const rows = sql.all<ThreadRow>(
    db(),
    sql`${THREAD_SELECT}
         WHERE t.project_id = ${input.projectId} ${after}
         ORDER BY t.updated_at DESC, t.id DESC
         LIMIT ${input.limit + 1}`,
  );
  const more = rows.length > input.limit;
  const kept = more ? rows.slice(0, input.limit) : rows;
  const last = kept.at(-1);
  return {
    threads: kept.map(toThread),
    next: more && last ? { updatedAt: last.updated_at, id: last.id } : null,
  };
}

export function updateThread(
  projectId: string,
  id: string,
  input: { expectedRevision: number; title: unknown },
): Thread {
  const title = validateTitle(input.title);
  withTransaction(() => {
    const row = threadRow(projectId, id);
    checkRevision(row.revision, input.expectedRevision);
    sql.run(
      db(),
      sql`UPDATE threads SET title = ${title}, revision = revision + 1, updated_at = ${now()}
           WHERE id = ${id}`,
    );
  });
  return getThread(projectId, id);
}

/** Delete a thread; its discussions stay, unlinked (and revision-bumped). */
export function deleteThread(
  projectId: string,
  id: string,
  expectedRevision: number,
): void {
  withTransaction(() => {
    const row = threadRow(projectId, id);
    checkRevision(row.revision, expectedRevision);
    const t = now();
    sql.run(
      db(),
      sql`UPDATE discussions SET thread_id = NULL, revision = revision + 1, updated_at = ${t}, last_activity_at = ${t}
           WHERE thread_id = ${id} AND project_id = ${projectId}`,
    );
    sql.run(db(), sql`DELETE FROM threads WHERE id = ${id}`);
  });
}
