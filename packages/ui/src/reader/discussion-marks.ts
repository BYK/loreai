/**
 * Discussion anchors → reader marks (APP-02). Pure mapping from the stored
 * logical anchors to the spans a `RichText` part wraps, the blocks that carry
 * a collapsed indicator, and the discussions a new selection overlaps.
 *
 * Only `current` anchors are highlighted: a `stale_anchor` or
 * `source_missing` discussion keeps its indicator (with the reason) but
 * never claims text it no longer matches.
 */
import type { Discussion, DiscussionAnchor } from "~/contracts";
import { cyrb53 } from "~/lib/hash";

import type { SourceAnchor } from "./anchors";

export const DISCUSSION_TONES = 4;

/** Stable pastel tone per discussion so overlapping marks stay distinct. */
export function discussionTone(id: string): number {
  return cyrb53(id) % DISCUSSION_TONES;
}

export interface DiscussionSpan {
  discussionId: string;
  start: number;
  end: number;
  className: string;
}

export function toSourceAnchor(a: DiscussionAnchor): SourceAnchor {
  const anchor: SourceAnchor = {
    blockId: a.block_id,
    start: a.start,
    end: a.end,
    contentHash: a.content_hash,
  };
  if (a.part_index !== undefined) anchor.partIndex = a.part_index;
  return anchor;
}

export function toWireAnchor(a: SourceAnchor): DiscussionAnchor {
  return {
    block_id: a.blockId,
    ...(a.partIndex === undefined ? {} : { part_index: a.partIndex }),
    start: a.start,
    end: a.end,
    content_hash: a.contentHash,
  };
}

/**
 * Spans to mark in one part, ordered by start (then longer first) so nested
 * marks wrap outer-to-inner. Resolved discussions get a quieter class.
 */
export function discussionSpans(
  discussions: readonly Discussion[],
  blockId: string,
  partIndex: number,
): DiscussionSpan[] {
  const spans: DiscussionSpan[] = [];
  for (const d of discussions) {
    if (d.anchor_status !== "current") continue;
    for (const a of d.anchors) {
      if (a.block_id !== blockId || a.part_index !== partIndex) continue;
      if (a.end <= a.start) continue;
      spans.push({
        discussionId: d.id,
        start: a.start,
        end: a.end,
        className: `passage-discussion tone-${discussionTone(d.id)}${
          d.state === "resolved" ? " passage-discussion-resolved" : ""
        }`,
      });
    }
  }
  return spans.sort((x, y) => x.start - y.start || y.end - x.end);
}

/** The block that carries a discussion's indicator: its last anchor's. */
export function indicatorBlock(d: Discussion): string | null {
  return d.anchors[d.anchors.length - 1]?.block_id ?? null;
}

/** Discussions whose indicator sits under `blockId`, oldest first. */
export function discussionsAtBlock(
  discussions: readonly Discussion[],
  blockId: string,
): Discussion[] {
  return discussions
    .filter((d) => indicatorBlock(d) === blockId)
    .sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : 1));
}

function intersects(a: DiscussionAnchor, s: SourceAnchor): boolean {
  if (a.block_id !== s.blockId) return false;
  // Empty part anchors draw no highlight (see discussionSpans), so nothing to
  // reply in, not even from a whole-block selection.
  if (a.part_index !== undefined && a.end <= a.start) return false;
  // Whole-block on either side covers every part of the block.
  if (a.part_index === undefined || s.partIndex === undefined) return true;
  if (a.part_index !== s.partIndex) return false;
  return a.start < s.end && s.start < a.end;
}

/**
 * Current discussions a new selection touches — offered as "reply in this
 * discussion" next to "start an independent one".
 */
export function overlappingDiscussions(
  discussions: readonly Discussion[],
  selection: SourceAnchor,
): Discussion[] {
  return discussions.filter(
    (d) =>
      d.anchor_status === "current" &&
      d.anchors.some((a) => intersects(a, selection)),
  );
}

/** Participant → short avatar label and kind. */
export function participantAvatar(p: string): {
  name: string;
  label: string;
  kind: "person" | "agent";
} {
  if (p === "user") return { name: "You", label: "U", kind: "person" };
  if (p === "lore") return { name: "Lore", label: "L", kind: "agent" };
  const agent = p.startsWith("agent:") ? p.slice(6) : p;
  return {
    name: agent,
    label: agent.slice(0, 2).toUpperCase() || "AI",
    kind: "agent",
  };
}
