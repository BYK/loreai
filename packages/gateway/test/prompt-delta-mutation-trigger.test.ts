/**
 * Trigger narrowing for the durable knowledge-delta (append-only redesign).
 *
 * The production bug (session 1LYkXZ7jkiHHnqPl): the delta fired on per-turn
 * relevance-ranking churn (forSession picks a different subset each turn:
 * 8→7→6→12 entries), rewriting a deep-prefix message every turn and busting
 * ~250k tokens of cache per turn — even though NO knowledge changed in the DB.
 *
 * `detectSurfacedMutations` decouples the delta trigger from ranking: it
 * compares the already-surfaced set (what the model has been shown, as
 * `id:hash` keys) against the CURRENT DB state, and fires only on a genuine
 * content change or deletion. Pure ranking churn (an entry that simply wasn't
 * top-K this turn) is invisible to it — that is the churn-immunity property.
 */
import { describe, it, expect } from "vitest";
import { ltm, listSessionPromptDeltas } from "@loreai/core";
import {
  appendKnowledgePromptDelta,
  detectSurfacedMutations,
  fnv1a,
  ltmEntryKeys,
} from "../src/pipeline";

const PROJECT = "/tmp/lore-delta-mutation-trigger";

function keyOf(id: string, title: string, content: string): string {
  return `${id}:${fnv1a(`${title}\x1f${content}`)}`;
}

/** Parse the persisted delta row's rendered text (the GatewayMessage content). */
function deltaText(sessionID: string): string {
  return listSessionPromptDeltas(sessionID)
    .map((r) => {
      try {
        // A delta block stores a user→assistant PAIR (JSON array); legacy blocks
        // stored a single message object. Join text across whichever shape.
        const parsed = JSON.parse(r.content) as unknown;
        const msgs = Array.isArray(parsed) ? parsed : [parsed];
        return msgs
          .flatMap(
            (m) => (m as { content?: Array<{ text?: string }> }).content ?? [],
          )
          .map((b) => b.text ?? "")
          .join("");
      } catch {
        return "";
      }
    })
    .join("\n---\n");
}

describe("detectSurfacedMutations — genuine DB mutation, not ranking churn", () => {
  it("no DB change → no changed, no removed (churn-immunity)", () => {
    const id = ltm.create({
      projectPath: PROJECT,
      scope: "project",
      category: "gotcha",
      title: "Stable entry",
      content: "Original content that never changes.",
    });
    const surfaced = [
      keyOf(id, "Stable entry", "Original content that never changes."),
    ];

    const result = detectSurfacedMutations(surfaced);
    expect(result.changed).toEqual([]);
    expect(result.removedIds).toEqual([]);
  });

  it("content edit (curator update) → entry reported as changed", () => {
    const id = ltm.create({
      projectPath: PROJECT,
      scope: "project",
      category: "gotcha",
      title: "Edited entry",
      content: "Before edit.",
    });
    const surfaced = [keyOf(id, "Edited entry", "Before edit.")];

    ltm.update(id, { content: "After edit — materially different." });

    const result = detectSurfacedMutations(surfaced);
    expect(result.removedIds).toEqual([]);
    expect(result.changed).toHaveLength(1);
    expect(result.changed[0].id).toBe(id);
    expect(result.changed[0].content).toBe(
      "After edit — materially different.",
    );
  });

  it("deletion (consolidation) → entry reported as removed", () => {
    const id = ltm.create({
      projectPath: PROJECT,
      scope: "project",
      category: "gotcha",
      title: "Doomed entry",
      content: "Will be removed.",
    });
    const surfaced = [keyOf(id, "Doomed entry", "Will be removed.")];

    ltm.remove(id);

    const result = detectSurfacedMutations(surfaced);
    expect(result.changed).toEqual([]);
    expect(result.removedIds).toEqual([id]);
  });

  it("an unchanged surfaced entry is NEVER flagged regardless of selection (the bug)", () => {
    // The whole point: even if relevance ranking would drop this entry from
    // the current top-K selection, it remains surfaced and unchanged in the DB,
    // so it must produce zero delta signal. detectSurfacedMutations doesn't even
    // take the selection as input — ranking cannot trigger a delta.
    const id = ltm.create({
      projectPath: PROJECT,
      scope: "project",
      category: "architecture",
      title: "Not selected this turn",
      content: "Unchanged content.",
    });
    const surfaced = [
      keyOf(id, "Not selected this turn", "Unchanged content."),
    ];

    // Simulate many turns: the DB never changes, so every call is empty.
    for (let turn = 0; turn < 10; turn++) {
      const result = detectSurfacedMutations(surfaced);
      expect(result.changed).toEqual([]);
      expect(result.removedIds).toEqual([]);
    }
  });

  it("mixed: one changed, one removed, one stable", () => {
    const stable = ltm.create({
      projectPath: PROJECT,
      scope: "project",
      category: "gotcha",
      title: "Stable",
      content: "Stays.",
    });
    const edited = ltm.create({
      projectPath: PROJECT,
      scope: "project",
      category: "gotcha",
      title: "Edited",
      content: "Old.",
    });
    const removed = ltm.create({
      projectPath: PROJECT,
      scope: "project",
      category: "gotcha",
      title: "Removed",
      content: "Gone soon.",
    });
    const surfaced = [
      keyOf(stable, "Stable", "Stays."),
      keyOf(edited, "Edited", "Old."),
      keyOf(removed, "Removed", "Gone soon."),
    ];

    ltm.update(edited, { content: "New." });
    ltm.remove(removed);

    const result = detectSurfacedMutations(surfaced);
    expect(result.removedIds).toEqual([removed]);
    expect(result.changed).toHaveLength(1);
    expect(result.changed[0].id).toBe(edited);
    // The stable entry contributes nothing.
    expect(result.changed.map((e) => e.id)).not.toContain(stable);
  });

  it("a surfaced id that was NEVER a knowledge entry is NOT 'removed' (lat.md synthetics)", () => {
    // forSession injects lat.md sections as synthetic KnowledgeEntry-shaped rows
    // (category "lat.md", id like `file#Heading`) that live in lat_sections, not
    // `knowledge`. They land in the frozen pin baseline, but they never resolve
    // via ltm.get/getByLogical. They must NOT be reported as superseded — doing
    // so tells the model to ignore still-valid pinned lat.md knowledge, and (in
    // the append-only model) bakes that false removal into an immutable block.
    // Only a genuinely tombstoned KNOWLEDGE entry counts as removed.
    const latLikeKey = "lat.md/notes#Deploy ship release:deadbeef";
    const result = detectSurfacedMutations([latLikeKey]);
    expect(result.removedIds).toEqual([]);
    expect(result.changed).toEqual([]);
  });

  it("empty / undefined surfaced set → empty result", () => {
    expect(detectSurfacedMutations([])).toEqual({
      changed: [],
      removedIds: [],
    });
    expect(detectSurfacedMutations(undefined)).toEqual({
      changed: [],
      removedIds: [],
    });
  });

  it("WIRING: pinned entry dropped from selection but still in DB → NO delta row (the churn)", () => {
    // This is the regression guard for the production bug. The OLD wiring
    // computed the delta from `removedLtmEntryIds(previousKeys, nextKeys)` —
    // i.e. pin MINUS current selection — so a pinned entry that simply wasn't
    // selected this turn (nextKeys=[]) was reported as "removed" and a
    // "Superseded" delta was written and rewritten every turn → cache bust.
    // The DB-sourced wiring writes NOTHING here because the entry still exists.
    const id = ltm.create({
      projectPath: PROJECT,
      scope: "project",
      category: "gotcha",
      title: "Pinned but unselected",
      content: "Still exists; just not top-K this turn.",
    });
    const sessionID = `wiring-churn-${Date.now()}`;
    const pinKey = keyOf(
      id,
      "Pinned but unselected",
      "Still exists; just not top-K this turn.",
    );

    const wrote = appendKnowledgePromptDelta({
      sessionID,
      projectPath: PROJECT,
      insertAt: 5,
      previousKeys: [pinKey], // frozen pin baseline
      nextKeys: [], // selection dropped it (pure ranking churn)
      entries: [],
    });

    expect(wrote).toBe(false);
    expect(listSessionPromptDeltas(sessionID)).toHaveLength(0);
  });

  it("WIRING: genuine deletion of a pinned entry ALONE → NO delta (removals-only not surfaced)", () => {
    // Trim (quality + cost): a removals-only diff no longer injects a mid-session
    // message. A "## Superseded — ignore these ids" list is content the model
    // cannot reliably act on, and the per-turn churn of that list was the
    // dominant cache-bust driver on long sessions. The deletion is left for the
    // next session's pin refresh; if a genuine CHANGE later rides through, the
    // removal is folded into that block's `mut` signature (next test).
    const id = ltm.create({
      projectPath: PROJECT,
      scope: "project",
      category: "gotcha",
      title: "Pinned then deleted",
      content: "Will be genuinely removed.",
    });
    const sessionID = `wiring-delete-${Date.now()}`;
    const pinKey = keyOf(
      id,
      "Pinned then deleted",
      "Will be genuinely removed.",
    );

    ltm.remove(id); // genuine deletion

    const wrote = appendKnowledgePromptDelta({
      sessionID,
      projectPath: PROJECT,
      insertAt: 5,
      previousKeys: [pinKey],
      nextKeys: [], // selection also empty, but the DELETION is what matters
      entries: [],
    });

    expect(wrote).toBe(false);
    expect(listSessionPromptDeltas(sessionID)).toHaveLength(0);
  });

  it("WIRING: deletion that rides a genuine change → delta written, removal in mut (advances surfaced set), no 'Superseded' text", () => {
    // The removal still has to ADVANCE the surfaced set so it isn't re-detected
    // forever. When it rides a real content change, the appended block records
    // it in `mut.removed` (consumed by advanceSurfacedKeys) even though the
    // rendered text no longer carries a "Superseded" section.
    const changedId = ltm.create({
      projectPath: PROJECT,
      scope: "project",
      category: "gotcha",
      title: "Pinned then edited (rides)",
      content: "Before.",
    });
    const deletedId = ltm.create({
      projectPath: PROJECT,
      scope: "project",
      category: "gotcha",
      title: "Pinned then deleted (rides)",
      content: "Will be removed alongside a change.",
    });
    const sessionID = `wiring-ride-${Date.now()}`;
    const changedKey = keyOf(
      changedId,
      "Pinned then edited (rides)",
      "Before.",
    );
    const deletedKey = keyOf(
      deletedId,
      "Pinned then deleted (rides)",
      "Will be removed alongside a change.",
    );

    ltm.update(changedId, { content: "After — materially changed." });
    ltm.remove(deletedId);

    const wrote = appendKnowledgePromptDelta({
      sessionID,
      projectPath: PROJECT,
      insertAt: 5,
      previousKeys: [changedKey, deletedKey],
      nextKeys: [changedKey],
      entries: [],
    });

    expect(wrote).toBe(true);
    const text = deltaText(sessionID);
    expect(text).toContain("After — materially changed.");
    expect(text).not.toContain("Superseded");
    // The removal must be recorded in the block's mutation signature.
    const [row] = listSessionPromptDeltas(sessionID);
    const selector = JSON.parse(row.selector) as {
      mut?: { removed?: string[] };
    };
    expect(selector.mut?.removed ?? []).toContain(deletedId);
  });

  it("WIRING: genuine content change of a pinned entry → changed delta IS written", () => {
    const id = ltm.create({
      projectPath: PROJECT,
      scope: "project",
      category: "gotcha",
      title: "Pinned then edited",
      content: "Before.",
    });
    const sessionID = `wiring-change-${Date.now()}`;
    const pinKey = keyOf(id, "Pinned then edited", "Before.");

    ltm.update(id, { content: "After — materially changed body." });

    const wrote = appendKnowledgePromptDelta({
      sessionID,
      projectPath: PROJECT,
      insertAt: 5,
      previousKeys: [pinKey],
      nextKeys: [pinKey], // still selected; the CONTENT change is what matters
      entries: [],
    });

    expect(wrote).toBe(true);
    expect(deltaText(sessionID)).toContain("After — materially changed body.");
  });

  it("key format matches ltmEntryKeys (the surfaced baseline producer)", () => {
    // The surfaced keys are produced by ltmEntryKeys elsewhere in the pipeline;
    // detectSurfacedMutations must parse that exact `id:fnv1a(title\x1f content)`
    // format. Guard the contract so the two never drift.
    const id = ltm.create({
      projectPath: PROJECT,
      scope: "project",
      category: "gotcha",
      title: "Format check",
      content: "Body.",
    });
    const produced = ltmEntryKeys([
      { id, title: "Format check", content: "Body." },
    ]);
    expect(produced[0]).toBe(keyOf(id, "Format check", "Body."));
    // Unchanged in DB → no signal.
    expect(detectSurfacedMutations(produced)).toEqual({
      changed: [],
      removedIds: [],
    });
  });
});
