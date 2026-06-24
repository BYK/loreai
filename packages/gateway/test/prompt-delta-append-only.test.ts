/**
 * Append-only durable knowledge deltas (cache-stable by construction).
 *
 * The #954 trigger narrowing stopped ranking churn from firing the delta, but
 * the delta was still written with `upsertSessionPromptDelta` (one coalesced
 * seq=0 row) at a FROZEN deep `insertAt`, and the surfaced baseline never
 * advanced. So a session whose pinned set has a PERSISTENT mutation — e.g. 66
 * pinned entries genuinely gone from the DB (session 1LYkXZ7jkiHHnqPl) —
 * re-detected the same removals every turn and re-rewrote the same deep message
 * every turn → ~250k cache-write tokens/turn forever.
 *
 * The redesign makes the delta machinery cache-stable by construction:
 *   - APPEND a fresh immutable block at the current tail (seq = MAX+1) instead
 *     of rewriting one row in place. Extending the tail never invalidates the
 *     cached prefix.
 *   - ADVANCE the surfaced set per appended block (each block records the
 *     `id:hash` mutations it surfaced, in its selector). Once a removal/change
 *     has been surfaced, the next turn reconstructs the advanced surfaced set
 *     and sees no outstanding mutation → no new block → no bust.
 *
 * These tests guard those two properties (append, and cross-turn no-re-fire),
 * plus block immutability.
 */
import { describe, it, expect } from "vitest";
import { ltm, listSessionPromptDeltas } from "@loreai/core";
import { appendKnowledgePromptDelta, fnv1a } from "../src/pipeline";

const PROJECT = "/tmp/lore-delta-append-only";

function keyOf(id: string, title: string, content: string): string {
  return `${id}:${fnv1a(`${title}\x1f${content}`)}`;
}

function deltaContents(sessionID: string): string[] {
  return listSessionPromptDeltas(sessionID).map((r) => {
    try {
      const msg = JSON.parse(r.content) as {
        content: Array<{ text?: string }>;
      };
      return msg.content.map((b) => b.text ?? "").join("");
    } catch {
      return "";
    }
  });
}

describe("append-only durable knowledge deltas", () => {
  it("two DISTINCT genuine mutations across turns → TWO appended blocks, not one upserted row", () => {
    const a = ltm.create({
      projectPath: PROJECT,
      scope: "project",
      category: "gotcha",
      title: "Entry A",
      content: "A before.",
    });
    const b = ltm.create({
      projectPath: PROJECT,
      scope: "project",
      category: "gotcha",
      title: "Entry B",
      content: "B before.",
    });
    const sessionID = `append-two-${Date.now()}`;
    const pin = [
      keyOf(a, "Entry A", "A before."),
      keyOf(b, "Entry B", "B before."),
    ];

    // Turn 1: A is genuinely edited.
    ltm.update(a, { content: "A AFTER — changed." });
    const wrote1 = appendKnowledgePromptDelta({
      sessionID,
      projectPath: PROJECT,
      insertAt: 10,
      previousKeys: pin,
      nextKeys: pin,
      entries: [],
    });

    // Turn 2 (later, larger conversation): B is genuinely edited.
    ltm.update(b, { content: "B AFTER — changed." });
    const wrote2 = appendKnowledgePromptDelta({
      sessionID,
      projectPath: PROJECT,
      insertAt: 25,
      previousKeys: pin,
      nextKeys: pin,
      entries: [],
    });

    expect(wrote1).toBe(true);
    expect(wrote2).toBe(true);
    const rows = listSessionPromptDeltas(sessionID);
    expect(rows).toHaveLength(2);
    // Distinct, monotonically increasing seqs (append, not in-place upsert).
    expect(rows.map((r) => r.seq)).toEqual([0, 1]);
    // Each block lives at its own tail position (no frozen single insertAt).
    const insertAts = rows.map(
      (r) => (JSON.parse(r.selector) as { insertAt: number }).insertAt,
    );
    expect(insertAts).toEqual([10, 25]);
    // Block 0 surfaced A's change; block 1 surfaced B's change.
    const contents = deltaContents(sessionID);
    expect(contents[0]).toContain("A AFTER — changed.");
    expect(contents[1]).toContain("B AFTER — changed.");
  });

  it("a persistent removal, once surfaced, does NOT re-fire on later turns (the 1LYkXZ fix)", () => {
    const doomed = ltm.create({
      projectPath: PROJECT,
      scope: "project",
      category: "gotcha",
      title: "Persistently gone",
      content: "Deleted and stays deleted.",
    });
    const sessionID = `append-norefire-${Date.now()}`;
    const pin = [
      keyOf(doomed, "Persistently gone", "Deleted and stays deleted."),
    ];

    ltm.remove(doomed); // genuine, permanent deletion

    // Turn 1: the removal is surfaced.
    const wrote1 = appendKnowledgePromptDelta({
      sessionID,
      projectPath: PROJECT,
      insertAt: 10,
      previousKeys: pin,
      nextKeys: [],
      entries: [],
    });
    // Turn 2..N: the pin baseline still lists the (gone) entry, but it was
    // already surfaced — the advanced surfaced set drops it, so no new block.
    const laterWrites: boolean[] = [];
    for (let turn = 0; turn < 5; turn++) {
      laterWrites.push(
        appendKnowledgePromptDelta({
          sessionID,
          projectPath: PROJECT,
          insertAt: 20 + turn,
          previousKeys: pin, // frozen pin — same every turn (the bug condition)
          nextKeys: [],
          entries: [],
        }),
      );
    }

    expect(wrote1).toBe(true);
    expect(laterWrites).toEqual([false, false, false, false, false]);
    // Exactly ONE block total, ever — not one per turn.
    expect(listSessionPromptDeltas(sessionID)).toHaveLength(1);
  });

  it("an appended block is immutable — a later append never rewrites earlier blocks", () => {
    const a = ltm.create({
      projectPath: PROJECT,
      scope: "project",
      category: "gotcha",
      title: "Immutable A",
      content: "A v1.",
    });
    const b = ltm.create({
      projectPath: PROJECT,
      scope: "project",
      category: "gotcha",
      title: "Immutable B",
      content: "B v1.",
    });
    const sessionID = `append-immutable-${Date.now()}`;
    const pin = [
      keyOf(a, "Immutable A", "A v1."),
      keyOf(b, "Immutable B", "B v1."),
    ];

    ltm.update(a, { content: "A v2." });
    appendKnowledgePromptDelta({
      sessionID,
      projectPath: PROJECT,
      insertAt: 10,
      previousKeys: pin,
      nextKeys: pin,
      entries: [],
    });
    const block0Before = listSessionPromptDeltas(sessionID)[0];

    ltm.update(b, { content: "B v2." });
    appendKnowledgePromptDelta({
      sessionID,
      projectPath: PROJECT,
      insertAt: 22,
      previousKeys: pin,
      nextKeys: pin,
      entries: [],
    });
    const block0After = listSessionPromptDeltas(sessionID)[0];

    // Byte-identical: same selector AND same content after the later append.
    expect(block0After.selector).toBe(block0Before.selector);
    expect(block0After.content).toBe(block0Before.content);
  });

  it("re-editing the SAME entry to a new value DOES append a second block", () => {
    const a = ltm.create({
      projectPath: PROJECT,
      scope: "project",
      category: "gotcha",
      title: "Twice edited",
      content: "v1.",
    });
    const sessionID = `append-twice-${Date.now()}`;
    const pin = [keyOf(a, "Twice edited", "v1.")];

    ltm.update(a, { content: "v2." });
    const w1 = appendKnowledgePromptDelta({
      sessionID,
      projectPath: PROJECT,
      insertAt: 10,
      previousKeys: pin,
      nextKeys: pin,
      entries: [],
    });
    // Surfaced is now at v2; another call with no further change → no block.
    const wNoop = appendKnowledgePromptDelta({
      sessionID,
      projectPath: PROJECT,
      insertAt: 15,
      previousKeys: pin,
      nextKeys: pin,
      entries: [],
    });
    // A genuine second edit → a new block surfaces v3.
    ltm.update(a, { content: "v3." });
    const w2 = appendKnowledgePromptDelta({
      sessionID,
      projectPath: PROJECT,
      insertAt: 30,
      previousKeys: pin,
      nextKeys: pin,
      entries: [],
    });

    expect(w1).toBe(true);
    expect(wNoop).toBe(false);
    expect(w2).toBe(true);
    const contents = deltaContents(sessionID);
    expect(contents).toHaveLength(2);
    expect(contents[0]).toContain("v2.");
    expect(contents[1]).toContain("v3.");
  });
});
