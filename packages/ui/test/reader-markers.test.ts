/**
 * buildMarkers (#1924): session-context → transcript marker rules —
 * injection grouping by stamped batch, deltas only when their application
 * time is recorded, compactions only where the accepted layer increased.
 */
import { describe, expect, it } from "vitest";

import type { SessionContext } from "~/contracts";
import { buildMarkers } from "~/reader/markers";

const T0 = 1_700_000_000_000;

function context(over: Partial<SessionContext> = {}): SessionContext {
  return {
    session_id: "s",
    layer: null,
    history: { message_count: 0, token_estimate: 0 },
    distilled_prefix: { token_count: 0, distillations: [] },
    knowledge: {
      cache_text: null,
      cache_tokens: null,
      pin_tokens: null,
      stable_tokens: null,
      injections: [],
    },
    prompt_deltas: [],
    turns: [],
    ...over,
  };
}

function injection(
  over: Partial<SessionContext["knowledge"]["injections"][number]> = {},
): SessionContext["knowledge"]["injections"][number] {
  return {
    logical_id: "k-1",
    title: "Entry one",
    category: "decision",
    confidence: 0.9,
    created_at: T0,
    credited: false,
    verdict: null,
    ...over,
  };
}

function turn(
  over: Partial<SessionContext["turns"][number]> = {},
): SessionContext["turns"][number] {
  return {
    message_id: "m-1",
    created_at: T0,
    layer: 0,
    raw_tokens: 1000,
    total_tokens: 1000,
    distilled_tokens: 0,
    usage: null,
    ...over,
  };
}

describe("buildMarkers", () => {
  it("groups injections sharing one created_at stamp into a single marker", () => {
    const markers = buildMarkers(
      context({
        knowledge: {
          cache_text: null,
          cache_tokens: null,
          pin_tokens: null,
          stable_tokens: null,
          injections: [
            injection({ logical_id: "k-1", title: "One" }),
            injection({ logical_id: "k-2", title: "Two" }),
            injection({ logical_id: "k-3", title: null }),
            injection({ logical_id: "k-4", created_at: T0 + 10 }),
          ],
        },
      }),
    );
    const injections = markers.filter((m) => m.marker === "injection");
    expect(injections).toHaveLength(2);
    const batch = injections[0]!;
    expect(batch.id).toBe(`k.injection.${T0}`);
    expect(batch.title).toBe("Lore injected 3 knowledge entries");
    // The items carry the titles; the detail line stays empty rather than
    // repeating them.
    expect(batch.detail).toBe("");
    expect(batch.items).toEqual([
      { id: "k-1", label: "One" },
      { id: "k-2", label: "Two" },
      { id: null, label: "k-3 (entry removed)" },
    ]);
    expect(injections[1]!.title).toBe("Lore injected 1 knowledge entry");
  });

  it("emits a delta marker only when applied_at is recorded", () => {
    const markers = buildMarkers(
      context({
        prompt_deltas: [
          {
            seq: 0,
            insert_at: 3,
            applied_at: null,
            changed: [{ id: "k-1", title: "One" }],
            removed: [],
            text: ["unrecorded"],
          },
          {
            seq: 1,
            insert_at: 4,
            applied_at: T0 + 5,
            changed: [
              { id: "k-1", title: "One" },
              { id: "k-9", title: null },
            ],
            removed: ["k-7", "k-8"],
            text: ["applied"],
          },
        ],
      }),
    );
    expect(markers).toHaveLength(1);
    const delta = markers[0]!;
    expect(delta.id).toBe("k.delta.1");
    expect(delta.createdAt).toBe(T0 + 5);
    expect(delta.detail).toContain("2 changed");
    expect(delta.detail).toContain("2 removed");
    expect(delta.items).toEqual([
      { id: "k-1", label: "One" },
      { id: "k-9", label: "k-9" },
    ]);
  });

  it("emits a compaction where the layer increases, and for a first turn at layer >= 1", () => {
    const markers = buildMarkers(
      context({
        turns: [
          turn({ message_id: "m-1", created_at: T0, layer: 0 }),
          turn({ message_id: "m-2", created_at: T0 + 1, layer: 1 }),
          turn({ message_id: "m-3", created_at: T0 + 2, layer: 1 }),
          turn({
            message_id: "m-4",
            created_at: T0 + 3,
            layer: 2,
            raw_tokens: 18_400,
            total_tokens: 6_100,
          }),
        ],
      }),
    );
    expect(markers.map((m) => m.id)).toEqual([
      "k.compaction.m-2",
      "k.compaction.m-4",
    ]);
    expect(markers[1]!.detail).toBe("Layer 2 · 18,400 raw → 6,100 sent");

    const firstTurn = buildMarkers(
      context({ turns: [turn({ message_id: "m-1", layer: 1 })] }),
    );
    expect(firstTurn).toHaveLength(1);
    expect(firstTurn[0]!.marker).toBe("compaction");

    const flat = buildMarkers(
      context({
        turns: [
          turn({ message_id: "m-1", layer: 0 }),
          turn({ message_id: "m-2", created_at: T0 + 1, layer: 0 }),
        ],
      }),
    );
    expect(flat).toHaveLength(0);
  });

  it("sorts markers by createdAt then id", () => {
    const markers = buildMarkers(
      context({
        knowledge: {
          cache_text: null,
          cache_tokens: null,
          pin_tokens: null,
          stable_tokens: null,
          injections: [injection({ created_at: T0 + 20 })],
        },
        prompt_deltas: [
          {
            seq: 0,
            insert_at: null,
            applied_at: T0 + 5,
            changed: [],
            removed: [],
            text: [],
          },
        ],
        turns: [turn({ message_id: "m-1", created_at: T0 + 10, layer: 1 })],
      }),
    );
    expect(markers.map((m) => m.marker)).toEqual([
      "delta",
      "compaction",
      "injection",
    ]);
  });

  it("emits nothing for an empty context", () => {
    expect(buildMarkers(context())).toEqual([]);
  });
});
