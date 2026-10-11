import { describe, expect, it } from "vitest";

import type { Discussion } from "~/contracts";
import { decodeAnchor, encodeAnchor } from "~/reader/anchors";
import {
  discussionSpans,
  discussionsAtBlock,
  discussionTone,
  overlappingDiscussions,
  toSourceAnchor,
  toWireAnchor,
} from "~/reader/discussion-marks";

function disc(
  id: string,
  anchors: Discussion["anchors"],
  extra: Partial<Discussion> = {},
): Discussion {
  return {
    id,
    project_id: "p1",
    thread_id: null,
    kind: "discussion",
    source: { kind: "session", id: "s1" },
    anchors,
    quote: "q",
    source_hash: "h",
    state: "open",
    anchor_status: "current",
    revision: 1,
    created_by: "user",
    created_at: 1,
    updated_at: 1,
    last_activity_at: 1,
    reply_count: 0,
    participants: ["user"],
    ...extra,
  };
}

const a = (
  block_id: string,
  part_index: number | undefined,
  start: number,
  end: number,
) => ({
  block_id,
  ...(part_index === undefined ? {} : { part_index }),
  start,
  end,
  content_hash: "abc123",
});

describe("discussion anchors → highlights", () => {
  it("maps current anchors in a part to tone-classed spans, outer first", () => {
    const outer = disc("d-outer", [a("m.1", 0, 2, 20)]);
    const inner = disc("d-inner", [a("m.1", 0, 5, 9)]);
    const otherPart = disc("d-p1", [a("m.1", 1, 0, 4)]);
    const otherBlock = disc("d-b2", [a("m.2", 0, 0, 4)]);
    const spans = discussionSpans(
      [inner, outer, otherPart, otherBlock],
      "m.1",
      0,
    );
    expect(spans.map((s) => [s.discussionId, s.start, s.end])).toEqual([
      ["d-outer", 2, 20],
      ["d-inner", 5, 9],
    ]);
    expect(spans[0]?.className).toBe(
      `passage-discussion tone-${discussionTone("d-outer")}`,
    );
  });

  it("never highlights stale or missing anchors, and quiets resolved ones", () => {
    const stale = disc("d1", [a("m.1", 0, 0, 3)], {
      anchor_status: "stale_anchor",
    });
    const missing = disc("d2", [a("m.1", 0, 0, 3)], {
      anchor_status: "source_missing",
    });
    const resolved = disc("d3", [a("m.1", 0, 0, 3)], { state: "resolved" });
    const spans = discussionSpans([stale, missing, resolved], "m.1", 0);
    expect(spans).toHaveLength(1);
    expect(spans[0]?.className).toContain("passage-discussion-resolved");
  });

  it("skips whole-block and empty anchors for span marks", () => {
    expect(
      discussionSpans([disc("d", [a("m.1", undefined, 0, 0)])], "m.1", 0),
    ).toEqual([]);
    expect(discussionSpans([disc("d", [a("m.1", 0, 4, 4)])], "m.1", 0)).toEqual(
      [],
    );
  });

  it("places indicators at the last anchor's block, oldest first", () => {
    const later = disc("b", [a("m.1", 0, 0, 2), a("m.2", 0, 0, 2)], {
      created_at: 5,
    });
    const first = disc("a", [a("m.2", 0, 3, 6)], { created_at: 2 });
    expect(discussionsAtBlock([later, first], "m.2").map((d) => d.id)).toEqual([
      "a",
      "b",
    ]);
    expect(discussionsAtBlock([later, first], "m.1")).toEqual([]);
  });

  it("finds discussions a new selection overlaps, keeping disjoint ones out", () => {
    const d1 = disc("d1", [a("m.1", 0, 0, 10)]);
    const d2 = disc("d2", [a("m.1", 0, 20, 30)]);
    const whole = disc("d3", [a("m.1", undefined, 0, 0)]);
    const stale = disc("d4", [a("m.1", 0, 0, 30)], {
      anchor_status: "stale_anchor",
    });
    // An empty part anchor draws no highlight, so it offers no reply either.
    const empty = disc("d5", [a("m.1", 0, 8, 8)]);
    expect(discussionSpans([empty], "m.1", 0)).toEqual([]);
    const sel = {
      blockId: "m.1",
      partIndex: 0,
      start: 5,
      end: 15,
      contentHash: "x",
    };
    expect(
      overlappingDiscussions([d1, d2, whole, stale, empty], sel).map(
        (d) => d.id,
      ),
    ).toEqual(["d1", "d3"]);
    // Touching ends do not overlap.
    expect(
      overlappingDiscussions([d1], { ...sel, start: 10, end: 12 }),
    ).toEqual([]);
    // A whole-block selection covers every non-empty anchor in the block, but
    // still not the empty one.
    expect(
      overlappingDiscussions([d1, d2, whole, empty], {
        ...sel,
        partIndex: undefined,
      }).map((d) => d.id),
    ).toEqual(["d1", "d2", "d3"]);
  });

  it("round-trips wire anchors and encodes knowledge anchors for ?a=", () => {
    const wire = a("k.01J", 2, 3, 9);
    const anchor = toSourceAnchor(wire);
    expect(toWireAnchor(anchor)).toEqual(wire);
    expect(decodeAnchor(encodeAnchor(anchor))?.anchor).toEqual(anchor);
    const whole = toSourceAnchor(a("m.1", undefined, 0, 0));
    expect(whole.partIndex).toBeUndefined();
    expect(toWireAnchor(whole)).not.toHaveProperty("part_index");
  });
});
