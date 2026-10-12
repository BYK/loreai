/**
 * Logical source anchors (#1809): a selection in a session message or a
 * knowledge entry, addressed by block id, optional part index, offsets into
 * the displayed text and the part's content hash — the same shape the UI
 * reader mints. Shared by thread links and anchored knowledge notes.
 *
 * Reads re-derive the live part hashes: a moved hash makes the anchor
 * `stale_anchor`, a vanished block `source_missing`. Anchors are never
 * rewritten; re-anchoring is a user decision.
 */
import { contentHash } from "./content-hash";
import { db } from "./db";
import { sql } from "./sql";
import { CHUNK_TERMINATOR } from "./temporal";
import { currentTenantId } from "./tenant";

export type SourceKind = "session" | "knowledge";
export type AnchorStatus = "current" | "stale_anchor" | "source_missing";

export interface SourceAnchor {
  blockId: string;
  partIndex?: number;
  start: number;
  end: number;
  contentHash: string;
}

export interface AnchorSource {
  kind: SourceKind;
  id: string;
}

export type AnchorErrorCode =
  | "not_found"
  | "invalid"
  | "revision_conflict"
  | "source_changed";

export class AnchorError extends Error {
  constructor(
    readonly code: AnchorErrorCode,
    message: string,
    readonly currentRevision?: number,
  ) {
    super(message);
    this.name = "AnchorError";
  }
}

export const QUOTE_MAX = 600;
export const ANCHORS_MAX = 64;
const OFFSET_MAX = 10_000_000;
const HASH_RE = /^[0-9a-z]{1,11}$/;
const CHUNK_SEPARATOR = `\n${CHUNK_TERMINATOR}`;
const REASONING_PREFIX = "[reasoning] ";
const TOOL_ENVELOPE = /^\[tool:([^\]\s]{1,200})\] ?/;

export function fail(code: AnchorErrorCode, message: string): never {
  throw new AnchorError(code, message);
}

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

export interface SourceBlocks {
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

export function loadSource(
  projectId: string,
  source: AnchorSource,
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
  source: AnchorSource,
  anchors: unknown,
): SourceAnchor[] {
  if (!Array.isArray(anchors) || anchors.length === 0) {
    fail("invalid", "anchors must be a non-empty array");
  }
  if (anchors.length > ANCHORS_MAX) {
    fail("invalid", `at most ${ANCHORS_MAX} anchors per selection`);
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

export function assertProject(projectId: string): void {
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

/**
 * Create-time check of a fresh selection against the live source: it must
 * exist, every part must still carry its hash, and session anchors must follow
 * message order. Returns the validated anchors and quote.
 */
export function checkSelection(
  projectId: string,
  source: AnchorSource,
  rawAnchors: unknown,
  rawQuote: unknown,
): { anchors: SourceAnchor[]; quote: string } {
  if (source.kind !== "session" && source.kind !== "knowledge") {
    fail("invalid", "source.kind must be session or knowledge");
  }
  if (typeof source.id !== "string" || !source.id || source.id.length > 256) {
    fail("invalid", "source.id is required");
  }
  const anchors = validateAnchors(source, rawAnchors);
  const quote = validateQuote(rawQuote);
  assertProject(projectId);
  const live = loadSource(projectId, source, anchors);
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
  return { anchors, quote };
}
