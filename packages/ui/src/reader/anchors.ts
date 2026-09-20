/**
 * Source anchors (plan §0.3 / §9 "Block anchoring"): a logical reference to
 * a span of one block part that survives virtualisation, re-rendering and
 * reloads because it is made of *identity*, not DOM nodes.
 *
 *   { blockId, partIndex?, start, end, contentHash }
 *
 * `start`/`end` are UTF-16 offsets into the part's **displayed text** — the
 * `textContent` of the sanitised render (`RenderedHtml.text`) — under
 * mapping version {@link ANCHOR_MAPPING_VERSION}. `contentHash` is the hash
 * of the part's *source* text at the time the anchor was minted.
 *
 * Resolution is honest by construction: a hash mismatch, a different mapping
 * version or an out-of-range span is reported as `changed`, an unknown block
 * or part as `missing`. Nothing here ever re-anchors by text similarity.
 *
 * Wire format (URL `?a=` value; every field is URL-safe by construction):
 *
 *   `<mapping>~<blockId>~<partIndex|''>~<start>~<end>~<contentHash>`
 *
 * Block ids may contain `~` only if a server id does; they never contain
 * whitespace. The decoder therefore reads the four trailing fields and the
 * leading version and treats whatever is between as the id.
 */
import { contentHash } from "~/lib/hash";

import type { BlockPart, MessageBlock, ReaderBlock } from "./blocks";

/** Bumped whenever the displayed-text mapping of a part changes. */
export const ANCHOR_MAPPING_VERSION = 1;

export interface SourceAnchor {
  blockId: string;
  /** Part within a message block; omitted for whole-block references. */
  partIndex?: number;
  start: number;
  end: number;
  contentHash: string;
}

/** Upper bound on `end` — protects the reader from hostile query strings. */
export const MAX_ANCHOR_OFFSET = 50_000_000;

const FIELD_SEP = "~";
const UINT = /^(?:0|[1-9]\d{0,9})$/;
const HASH = /^[0-9a-z]{1,16}$/;

export function encodeAnchor(anchor: SourceAnchor): string {
  const part = anchor.partIndex === undefined ? "" : String(anchor.partIndex);
  return [
    ANCHOR_MAPPING_VERSION,
    anchor.blockId,
    part,
    anchor.start,
    anchor.end,
    anchor.contentHash,
  ].join(FIELD_SEP);
}

export interface DecodedAnchor {
  anchor: SourceAnchor;
  /** Mapping version the anchor was minted under. */
  mapping: number;
}

/**
 * Parse a wire anchor. Returns null for anything malformed; the caller shows
 * a "link not understood" state rather than guessing.
 */
export function decodeAnchor(
  raw: string | null | undefined,
): DecodedAnchor | null {
  if (!raw || raw.length > 4096) return null;
  const fields = raw.split(FIELD_SEP);
  if (fields.length < 6) return null;
  const hash = fields.pop() ?? "";
  const endRaw = fields.pop() ?? "";
  const startRaw = fields.pop() ?? "";
  const partRaw = fields.pop() ?? "";
  const mappingRaw = fields.shift() ?? "";
  const blockId = fields.join(FIELD_SEP);
  if (!UINT.test(mappingRaw) || !HASH.test(hash)) return null;
  if (!UINT.test(startRaw) || !UINT.test(endRaw)) return null;
  if (partRaw !== "" && !UINT.test(partRaw)) return null;
  if (!blockId || /\s/.test(blockId) || !/^[md]\./.test(blockId)) return null;
  const start = Number(startRaw);
  const end = Number(endRaw);
  if (start > end || end > MAX_ANCHOR_OFFSET) return null;
  const anchor: SourceAnchor = { blockId, start, end, contentHash: hash };
  if (partRaw !== "") anchor.partIndex = Number(partRaw);
  return { anchor, mapping: Number(mappingRaw) };
}

/** Mint an anchor for `[start, end)` of a part's displayed text. */
export function anchorFor(
  block: MessageBlock,
  part: BlockPart,
  start: number,
  end: number,
): SourceAnchor {
  return {
    blockId: block.id,
    partIndex: part.index,
    start: Math.min(start, end),
    end: Math.max(start, end),
    contentHash: part.hash,
  };
}

/** Anchor for a whole block (no part, no span) — used for block-level links. */
export function blockAnchor(block: ReaderBlock): SourceAnchor {
  return {
    blockId: block.id,
    start: 0,
    end: 0,
    contentHash: blockHash(block),
  };
}

/** Revision hash of a whole block (a single-part message hashes like its part). */
export function blockHash(block: ReaderBlock): string {
  if (block.kind === "distillation") {
    const s = block.summary;
    return contentHash(`${s.id}:${s.generation}:${s.token_count}`);
  }
  const single = block.parts.length === 1 ? block.parts[0] : undefined;
  return single
    ? single.hash
    : contentHash(block.parts.map((p) => p.hash).join("|"));
}

export type AnchorResolution =
  /** Same source, span in range: the caller may highlight `[start, end)`. */
  | { status: "ok"; part: BlockPart | null; quote: string }
  /** Block or part exists but its text (or the mapping) differs. */
  | { status: "changed"; reason: "hash" | "mapping" | "range" }
  /** Block or part is not among the blocks the caller has. */
  | { status: "missing"; reason: "block" | "part" };

/**
 * Resolve an anchor against a block the caller already has. `displayedText`
 * must be the current render's `text` for the referenced part (null when
 * the caller has not rendered it yet — the hash is still verified, only the
 * range check is skipped).
 */
export function resolveAnchor(
  decoded: DecodedAnchor,
  block: ReaderBlock | undefined,
  displayedText: string | null,
): AnchorResolution {
  if (!block) return { status: "missing", reason: "block" };
  const { anchor } = decoded;
  if (decoded.mapping !== ANCHOR_MAPPING_VERSION) {
    return { status: "changed", reason: "mapping" };
  }
  if (anchor.partIndex === undefined) {
    if (blockHash(block) !== anchor.contentHash) {
      return { status: "changed", reason: "hash" };
    }
    return { status: "ok", part: null, quote: "" };
  }
  if (block.kind !== "message") return { status: "missing", reason: "part" };
  const part = block.parts[anchor.partIndex];
  if (!part) return { status: "missing", reason: "part" };
  if (part.hash !== anchor.contentHash) {
    return { status: "changed", reason: "hash" };
  }
  if (displayedText === null) return { status: "ok", part, quote: "" };
  if (anchor.end > displayedText.length) {
    return { status: "changed", reason: "range" };
  }
  return {
    status: "ok",
    part,
    quote: displayedText.slice(anchor.start, anchor.end),
  };
}

/** Human-readable label for a non-ok resolution. */
export function resolutionLabel(res: AnchorResolution): string {
  switch (res.status) {
    case "ok":
      return "";
    case "changed":
      return res.reason === "range"
        ? "Source changed — the linked span no longer exists"
        : "Source changed since this link was made";
    case "missing":
      return res.reason === "block"
        ? "Linked source is not in this session's captured history"
        : "Linked passage is no longer part of this message";
  }
}
