/**
 * buildRows marker placement (#1924): a marker sits ABOVE the first message
 * whose createdAt is at-or-after the marker's stamp; markers older than the
 * loaded window lead it (beside the untimed distillations); markers newer
 * than every loaded message trail the document. An empty marker array
 * leaves the legacy row order untouched.
 */
import { describe, expect, it } from "vitest";

import type { DistillationSummary, TemporalMessage } from "~/contracts";
import { buildBlocks } from "~/reader/blocks";
import type { MarkerBlock } from "~/reader/markers";
import { buildRows } from "~/reader/rows";

const T0 = 1_700_000_000_000;

function msg(over: Partial<TemporalMessage> = {}): TemporalMessage {
  return {
    id: "m-1",
    source_id: null,
    project_id: "p",
    session_id: "s",
    role: "assistant",
    content: "text",
    tokens: 3,
    distilled: 0,
    created_at: T0,
    metadata: "{}",
    ...over,
  };
}

function distillation(
  over: Partial<DistillationSummary> = {},
): DistillationSummary {
  return {
    id: "d-1",
    session_id: "s",
    generation: 0,
    token_count: 10,
    r_compression: 2,
    c_norm: 0.5,
    archived: 0,
    created_at: T0,
    call_type: null,
    ...over,
  };
}

function marker(over: Partial<MarkerBlock> = {}): MarkerBlock {
  return {
    kind: "marker",
    id: "k.compaction.x",
    marker: "compaction",
    createdAt: T0,
    title: "Context compacted",
    detail: "",
    items: [],
    ...over,
  };
}

function keys(blocks: Parameters<typeof buildRows>[0], markers: MarkerBlock[]) {
  return buildRows(blocks, markers).map((r) => r.key);
}

describe("buildRows with markers", () => {
  it("places a marker above the first message at-or-after its stamp", () => {
    const blocks = buildBlocks({
      messages: [
        msg({ id: "a", created_at: T0 }),
        msg({ id: "b", created_at: T0 + 10 }),
        msg({ id: "c", created_at: T0 + 20 }),
      ],
      distillations: [],
    });
    expect(keys(blocks, [marker({ id: "k.mid", createdAt: T0 + 10 })])).toEqual(
      ["m.a", "k.mid", "m.b", "m.c"],
    );
    // A marker between messages goes between them.
    expect(keys(blocks, [marker({ id: "k.gap", createdAt: T0 + 15 })])).toEqual(
      ["m.a", "m.b", "k.gap", "m.c"],
    );
    // Later than everything → at the end.
    expect(
      keys(blocks, [marker({ id: "k.tail", createdAt: T0 + 99 })]),
    ).toEqual(["m.a", "m.b", "m.c", "k.tail"]);
    // Earlier than everything → at the top.
    expect(keys(blocks, [marker({ id: "k.head", createdAt: T0 - 5 })])).toEqual(
      ["k.head", "m.a", "m.b", "m.c"],
    );
  });

  it("keeps multiple markers sorted and keeps untimed distillations leading", () => {
    const blocks = buildBlocks({
      messages: [
        msg({ id: "a", created_at: T0 }),
        msg({ id: "b", created_at: T0 + 10 }),
      ],
      distillations: [distillation({ id: "d", created_at: 0 })],
    });
    const markers = [
      marker({ id: "k.later", createdAt: T0 + 10 }),
      marker({ id: "k.early", createdAt: T0 - 1 }),
    ];
    expect(keys(blocks, markers)).toEqual([
      "d.d",
      "k.early",
      "m.a",
      "k.later",
      "m.b",
    ]);
  });

  it("places markers around an untimed message by its successor's stamp", () => {
    const blocks = buildBlocks({
      messages: [
        msg({ id: "a", created_at: 1_000 }),
        msg({ id: "u", created_at: 0 }), // time unknown
        msg({ id: "b", created_at: 10_000 }),
      ],
      distillations: [],
    });
    // u inherits b's stamp (10_000), so both markers flush above it instead of
    // being trapped behind the untimed message.
    expect(
      keys(blocks, [
        marker({ id: "k.m1", createdAt: 2_000 }),
        marker({ id: "k.m2", createdAt: 8_000 }),
      ]),
    ).toEqual(["m.a", "k.m1", "k.m2", "m.u", "m.b"]);
  });

  it("places a marker before a trailing untimed message, not after it", () => {
    const blocks = buildBlocks({
      messages: [
        msg({ id: "a", created_at: 1_000 }),
        msg({ id: "u", created_at: 0 }), // time unknown, last in order
      ],
      distillations: [],
    });
    // No timed successor: the untimed message inherits +Infinity, so a marker
    // newer than every timed message still lands above it.
    expect(keys(blocks, [marker({ id: "k.tail", createdAt: 5_000 })])).toEqual([
      "m.a",
      "k.tail",
      "m.u",
    ]);
  });

  it("returns only markers when there are no messages", () => {
    const blocks = buildBlocks({ messages: [], distillations: [] });
    expect(
      keys(blocks, [
        marker({ id: "k.b", createdAt: T0 + 2 }),
        marker({ id: "k.a", createdAt: T0 }),
      ]),
    ).toEqual(["k.a", "k.b"]);
  });

  it("is byte-for-byte the legacy order when no markers are given", () => {
    const blocks = buildBlocks({
      messages: [
        msg({ id: "a", created_at: T0 }),
        msg({ id: "b", created_at: T0 + 10 }),
      ],
      distillations: [distillation({ id: "d", created_at: T0 + 5 })],
    });
    const without = buildRows(blocks).map((r) => r.key);
    expect(keys(blocks, [])).toEqual(without);
  });
});
