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
import {
  data,
  db,
  ensureProject,
  log,
  ltm,
  listSessionPromptDeltas,
  updateSessionPromptDeltaSelector,
} from "@loreai/core";
import {
  appendKnowledgePromptDelta,
  applySessionPromptDeltas,
  fnv1a,
  reanchorExistingDelta,
} from "../src/pipeline";
import type { GatewayMessage } from "../src/translate/types";

const PROJECT = "/tmp/lore-delta-append-only";

function keyOf(id: string, title: string, content: string): string {
  return `${id}:${fnv1a(`${title}\x1f${content}`)}`;
}

// A delta block's content is a user→assistant PAIR (JSON array); older blocks
// stored a single message object. Join the text across whichever shape.
function deltaText(raw: string): string {
  const parsed = JSON.parse(raw) as unknown;
  const msgs = Array.isArray(parsed) ? parsed : [parsed];
  return msgs
    .flatMap((m) => (m as { content?: Array<{ text?: string }> }).content ?? [])
    .map((b) => b.text ?? "")
    .join("");
}

function deltaContents(sessionID: string): string[] {
  return listSessionPromptDeltas(sessionID).map((r) => {
    try {
      return deltaText(r.content);
    } catch {
      return "";
    }
  });
}

function seedDistillation(id: string, observations: string): void {
  db()
    .query(
      `INSERT INTO distillations
       (id, project_id, session_id, narrative, facts, observations,
        source_ids, generation, token_count, archived, created_at)
       VALUES (?, ?, 'synthetic-source', '', '', ?, '[]', 0, 0, 0, ?)`,
    )
    .run(id, ensureProject(PROJECT), observations, Date.now());
}

describe("append-only durable knowledge deltas", () => {
  it("retires older task additions across repeated compactions", () => {
    const sessionID = `bounded-task-switch-${Date.now()}`;
    const entries = Array.from({ length: 40 }, (_, index) => {
      const title = `Distinct task ${index} knowledge`;
      const content = `Guidance for task ${index} with a separate current action.`;
      const id = ltm.create({
        projectPath: PROJECT,
        scope: "project",
        category: "gotcha",
        title,
        content,
      });
      return { id, category: "gotcha", title, content };
    });
    for (const [index, entry] of entries.entries()) {
      expect(
        appendKnowledgePromptDelta({
          sessionID,
          projectPath: PROJECT,
          insertAt: 10 + index,
          previousKeys: [],
          nextKeys: [keyOf(entry.id, entry.title, entry.content)],
          entries: [entry],
          taskShift: true,
          now: index * 100_000,
        }),
      ).toBe(true);
    }
    const blocks = listSessionPromptDeltas(sessionID);
    expect(blocks.length).toBeLessThanOrEqual(8);
    expect(
      Math.max(...blocks.map((block) => block.content.length)),
    ).toBeLessThan(8_000);
    const replay = blocks.map((block) => deltaText(block.content)).join("\n");
    expect(replay).not.toContain(entries[0].content);
    expect(replay).toContain(entries[39].content);

    const batchSessionID = `${sessionID}-batch`;
    const batchEntries = [
      ...entries,
      ...Array.from({ length: 20 }, (_, offset) => {
        const index = offset + entries.length;
        const title = `Distinct task ${index} knowledge`;
        const content = `Guidance for task ${index} with a separate current action.`;
        const id = ltm.create({
          projectPath: PROJECT,
          scope: "project",
          category: "gotcha",
          title,
          content,
        });
        return { id, category: "gotcha", title, content };
      }),
    ];
    const batchKeys = batchEntries.map((entry) =>
      keyOf(entry.id, entry.title, entry.content),
    );
    expect(
      appendKnowledgePromptDelta({
        sessionID: batchSessionID,
        projectPath: PROJECT,
        insertAt: 10,
        previousKeys: [],
        nextKeys: batchKeys,
        entries: batchEntries,
        taskShift: true,
        now: 0,
      }),
    ).toBe(true);
    const batch = listSessionPromptDeltas(batchSessionID);
    expect(batch).toHaveLength(1);
    expect(batch[0].content.length).toBeLessThan(8_000);
    const batchText = deltaText(batch[0].content);
    for (const entry of batchEntries) {
      // Every selected entry is either rendered or has a complete recall ID.
      expect(
        batchText.includes(entry.content) ||
          batchText.includes(`k:${entry.id}`),
      ).toBe(true);
    }
    expect(ltm.get(batchEntries[0].id)?.content).toBe(batchEntries[0].content);
    expect(
      appendKnowledgePromptDelta({
        sessionID: batchSessionID,
        projectPath: PROJECT,
        insertAt: 11,
        previousKeys: [],
        nextKeys: batchKeys,
        entries: batchEntries,
        taskShift: true,
        now: 100_000,
      }),
    ).toBe(false);
    expect(listSessionPromptDeltas(batchSessionID)).toHaveLength(1);
  });

  it("surfaces a newly selected entry on a task switch without rewriting the old block", () => {
    const a = ltm.create({
      projectPath: PROJECT,
      scope: "project",
      category: "gotcha",
      title: "Chart colors",
      content: "Keep chart labels legible.",
    });
    const b = ltm.create({
      projectPath: PROJECT,
      scope: "project",
      category: "gotcha",
      title: "Tenant credentials",
      content: "Scope credentials to the tenant.",
    });
    const sessionID = `append-task-switch-${Date.now()}`;
    const aKey = keyOf(a, "Chart colors", "Keep chart labels legible.");
    const bKey = keyOf(
      b,
      "Tenant credentials",
      "Scope credentials to the tenant.",
    );
    const aEntry = {
      id: a,
      category: "gotcha",
      title: "Chart colors",
      content: "Keep chart labels legible.",
    };
    const bEntry = {
      id: b,
      category: "gotcha",
      title: "Tenant credentials",
      content: "Scope credentials to the tenant.",
    };

    expect(
      appendKnowledgePromptDelta({
        sessionID,
        projectPath: PROJECT,
        insertAt: 2,
        previousKeys: [`${a}:`],
        nextKeys: [aKey],
        entries: [aEntry],
        now: 1_000,
      }),
    ).toBe(true);
    const original = listSessionPromptDeltas(sessionID)[0];

    // A source revision or incidental score change alone must not surface B.
    expect(
      appendKnowledgePromptDelta({
        sessionID,
        projectPath: PROJECT,
        insertAt: 4,
        previousKeys: [aKey],
        nextKeys: [bKey],
        entries: [bEntry],
        now: 1_001,
      }),
    ).toBe(false);
    expect(listSessionPromptDeltas(sessionID)).toEqual([original]);

    expect(
      appendKnowledgePromptDelta({
        sessionID,
        projectPath: PROJECT,
        insertAt: 4,
        previousKeys: [aKey],
        nextKeys: [bKey],
        entries: [bEntry],
        taskShift: true,
        now: 1_002, // still in the mutation debounce window
      }),
    ).toBe(true);
    const rows = listSessionPromptDeltas(sessionID);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual(original);
    expect(deltaText(rows[1].content)).toContain("Tenant credentials");
    expect(
      appendKnowledgePromptDelta({
        sessionID,
        projectPath: PROJECT,
        insertAt: 6,
        previousKeys: [aKey],
        nextKeys: [bKey],
        entries: [bEntry],
        taskShift: true,
        now: 1_003,
      }),
    ).toBe(false);
    expect(listSessionPromptDeltas(sessionID)).toEqual(rows);
  });

  it("does not surface an edited entry twice when its new version is selected on a task switch", () => {
    const id = ltm.create({
      projectPath: PROJECT,
      scope: "project",
      category: "gotcha",
      title: "Versioned task guidance",
      content: "Initial guidance.",
    });
    const sessionID = `task-version-${Date.now()}`;
    const oldKey = keyOf(id, "Versioned task guidance", "Initial guidance.");
    expect(
      appendKnowledgePromptDelta({
        sessionID,
        projectPath: PROJECT,
        insertAt: 2,
        previousKeys: [`${id}:`],
        nextKeys: [oldKey],
        entries: [
          {
            id,
            category: "gotcha",
            title: "Versioned task guidance",
            content: "Initial guidance.",
          },
        ],
        now: 1_000,
      }),
    ).toBe(true);
    ltm.update(id, { content: "Revised guidance." });
    const current = ltm.getByLogical(id);
    if (!current) throw new Error("Missing updated knowledge version");
    const newKey = keyOf(
      current.id,
      "Versioned task guidance",
      "Revised guidance.",
    );
    expect(
      appendKnowledgePromptDelta({
        sessionID,
        projectPath: PROJECT,
        insertAt: 4,
        previousKeys: [`${id}:`],
        nextKeys: [newKey],
        entries: [
          {
            id: current.id,
            category: "gotcha",
            title: "Versioned task guidance",
            content: "Revised guidance.",
          },
        ],
        taskShift: true,
        now: 1_002,
      }),
    ).toBe(true);
    const rows = listSessionPromptDeltas(sessionID);
    expect(rows).toHaveLength(1);
    const delta = deltaText(rows[0].content);
    expect(delta.match(/Revised guidance\./g)).toHaveLength(1);
    expect(delta).not.toContain(`[k:${current.id}]`);
  });

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
      now: 1000,
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
      now: 121_000, // > 60s past block 1 → outside debounce window
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

  it("a persistent removal-only surfaces NO block, ever (removals are not injected mid-session; supersedes the 1LYkXZ fix)", () => {
    // Trim (quality + cost): a removals-only diff no longer injects a mid-session
    // delta at all. The old "Superseded — ignore these ids" list was content the
    // model could not reliably act on, and even surfacing it ONCE per genuine
    // removal added cache churn. The 1LYkXZ bust (re-detecting + re-writing the
    // same removal every turn) is now trivially impossible: the removal produces
    // zero writes on turn 1 AND every later turn.
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

    // Turn 1: a removal alone surfaces nothing.
    const wrote1 = appendKnowledgePromptDelta({
      sessionID,
      projectPath: PROJECT,
      insertAt: 10,
      previousKeys: pin,
      nextKeys: [],
      entries: [],
      now: 1000,
    });
    // Turn 2..N: the pin baseline still lists the (gone) entry every turn (the
    // original bug condition), but it must never produce a block.
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
          now: 121_000 + turn * 1000, // outside debounce window — each call a fresh attempt
        }),
      );
    }

    expect(wrote1).toBe(false);
    expect(laterWrites).toEqual([false, false, false, false, false]);
    // Zero blocks, ever — a removal-only never busts the cache.
    expect(listSessionPromptDeltas(sessionID)).toHaveLength(0);
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
      now: 1000,
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
      now: 121_000, // > 60s past block 0 → outside debounce window
    });
    const block0After = listSessionPromptDeltas(sessionID)[0];

    // Byte-identical: same selector AND same content after the later append.
    expect(block0After.selector).toBe(block0Before.selector);
    expect(block0After.content).toBe(block0Before.content);
  });

  it("reanchorExistingDelta moves ALL blocks to one tail index, preserving order + mut (no re-fire after)", () => {
    const a = ltm.create({
      projectPath: PROJECT,
      scope: "project",
      category: "gotcha",
      title: "Reanchor A",
      content: "A r1.",
    });
    const b = ltm.create({
      projectPath: PROJECT,
      scope: "project",
      category: "gotcha",
      title: "Reanchor B",
      content: "B r1.",
    });
    const sessionID = `reanchor-multi-${Date.now()}`;
    const pin = [
      keyOf(a, "Reanchor A", "A r1."),
      keyOf(b, "Reanchor B", "B r1."),
    ];

    ltm.update(a, { content: "A r2." });
    appendKnowledgePromptDelta({
      sessionID,
      projectPath: PROJECT,
      insertAt: 10,
      previousKeys: pin,
      nextKeys: pin,
      entries: [],
      now: 1000,
    });
    ltm.update(b, { content: "B r2." });
    appendKnowledgePromptDelta({
      sessionID,
      projectPath: PROJECT,
      insertAt: 40,
      previousKeys: pin,
      nextKeys: pin,
      entries: [],
      now: 121_000, // > 60s past block 0 → outside debounce window
    });
    expect(listSessionPromptDeltas(sessionID)).toHaveLength(2);

    // Simulate a reshuffle: re-anchor against a short message array.
    const messages: GatewayMessage[] = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "text", text: "yo" }] },
    ];
    const reInsertAt = reanchorExistingDelta(sessionID, PROJECT, messages);
    expect(reInsertAt).not.toBeNull();

    const rows = listSessionPromptDeltas(sessionID);
    expect(rows).toHaveLength(2);
    // Both blocks now share the one fresh tail index.
    const insertAts = rows.map(
      (r) => (JSON.parse(r.selector) as { insertAt: number }).insertAt,
    );
    expect(insertAts).toEqual([reInsertAt, reInsertAt]);

    // Replay preserves chronological order: A's block (older) before B's block.
    const replayed = applySessionPromptDeltas(messages, sessionID);
    const replayedText = JSON.stringify(replayed);
    expect(replayedText.indexOf("A r2.")).toBeGreaterThanOrEqual(0);
    expect(replayedText.indexOf("A r2.")).toBeLessThan(
      replayedText.indexOf("B r2."),
    );

    // mut survived the reanchor: a follow-up append with the same DB state
    // finds nothing outstanding → no new block (advance still suppresses).
    const wrote = appendKnowledgePromptDelta({
      sessionID,
      projectPath: PROJECT,
      insertAt: 99,
      previousKeys: pin,
      nextKeys: pin,
      entries: [],
      now: 200_000, // outside debounce window — fresh attempt that finds nothing to surface
    });
    expect(wrote).toBe(false);
    expect(listSessionPromptDeltas(sessionID)).toHaveLength(2);
  });

  it("caps appended blocks — coalesces to ONE cumulative block at the limit", () => {
    const N = 9; // > MAX_DELTA_BLOCKS (8)
    const ids: string[] = [];
    const pin: string[] = [];
    for (let i = 0; i < N; i++) {
      const id = ltm.create({
        projectPath: PROJECT,
        scope: "project",
        category: "gotcha",
        title: `Cap entry ${i}`,
        content: `cap v1 ${i}.`,
      });
      ids.push(id);
      pin.push(keyOf(id, `Cap entry ${i}`, `cap v1 ${i}.`));
    }
    const sessionID = `cap-${Date.now()}`;

    let lastLen = 0;
    for (let i = 0; i < N; i++) {
      ltm.update(ids[i], { content: `cap v2 ${i}.` });
      appendKnowledgePromptDelta({
        sessionID,
        projectPath: PROJECT,
        insertAt: 10 + i,
        previousKeys: pin,
        nextKeys: pin,
        entries: [],
      });
      lastLen = listSessionPromptDeltas(sessionID).length;
      // The block count never exceeds the cap.
      expect(lastLen).toBeLessThanOrEqual(8);
    }
    // After crossing the cap, the blocks coalesced to a single cumulative block.
    expect(lastLen).toBe(1);
    // That one block describes the full pin→DB delta (all 9 entries changed).
    const body = deltaText(listSessionPromptDeltas(sessionID)[0].content);
    expect(body).toContain("cap v2 0.");
  });

  it("compacts repeated edits to the latest revision rather than replaying every stale revision", () => {
    const id = ltm.create({
      projectPath: PROJECT,
      scope: "project",
      category: "gotcha",
      title: "Revision history",
      content: "original guidance.",
    });
    const sessionID = `revision-cap-${Date.now()}`;
    const pin = [keyOf(id, "Revision history", "original guidance.")];

    for (const revision of Array.from({ length: 9 }, (_, index) => index + 1)) {
      ltm.update(id, { content: `guidance revision ${revision}.` });
      expect(
        appendKnowledgePromptDelta({
          sessionID,
          projectPath: PROJECT,
          insertAt: 10 + revision,
          previousKeys: pin,
          nextKeys: pin,
          entries: [],
          now: revision * 100_000,
        }),
      ).toBe(true);
    }

    const compacted = listSessionPromptDeltas(sessionID);
    expect(compacted).toHaveLength(1);
    const body = deltaText(compacted[0].content);
    expect(body).toContain("guidance revision 9.");
    for (const revision of Array.from({ length: 8 }, (_, index) => index + 1)) {
      expect(body).not.toContain(`guidance revision ${revision}.`);
    }
    expect(
      appendKnowledgePromptDelta({
        sessionID,
        projectPath: PROJECT,
        insertAt: 20,
        previousKeys: pin,
        nextKeys: pin,
        entries: [],
        now: 1_000_000,
      }),
    ).toBe(false);
  });

  it("drops deleted guidance when compacting earlier task-switch additions", () => {
    const entries = Array.from({ length: 9 }, (_, index) => {
      const title = `Switch ${index}`;
      const content = `Guidance for switch ${index}.`;
      const id = ltm.create({
        projectPath: PROJECT,
        scope: "project",
        category: "gotcha",
        title,
        content,
      });
      return { id, category: "gotcha", title, content };
    });
    const sessionID = `deleted-cap-${Date.now()}`;
    for (const [index, entry] of entries.entries()) {
      if (index === 8) ltm.remove(entries[0].id);
      expect(
        appendKnowledgePromptDelta({
          sessionID,
          projectPath: PROJECT,
          insertAt: 10 + index,
          previousKeys: [],
          nextKeys: [keyOf(entry.id, entry.title, entry.content)],
          entries: [entry],
          taskShift: true,
          now: index * 100_000,
        }),
      ).toBe(true);
    }
    const compacted = listSessionPromptDeltas(sessionID);
    expect(compacted).toHaveLength(1);
    const body = deltaText(compacted[0].content);
    expect(body).not.toContain(entries[0].content);
    expect(body).not.toContain(entries[0].id);
    for (const entry of entries.slice(1)) {
      expect(body).toContain(entry.content);
    }
  });

  it("does not rehydrate a foreign entry after sharing is revoked", () => {
    const foreign = ltm.create({
      projectPath: "/tmp/lore-delta-foreign-project",
      scope: "project",
      crossProject: true,
      category: "gotcha",
      title: "Shared foreign guidance",
      content: "Foreign private guidance must not reappear.",
    });
    const sessionID = `revoked-cap-${Date.now()}`;
    const entries = Array.from({ length: 9 }, (_, index) => {
      if (index === 0) {
        return {
          id: foreign,
          category: "gotcha",
          title: "Shared foreign guidance",
          content: "Foreign private guidance must not reappear.",
        };
      }
      const title = `Local revocation guidance ${index}`;
      const content = `Local guidance after revocation ${index}.`;
      const id = ltm.create({
        projectPath: PROJECT,
        scope: "project",
        category: "gotcha",
        title,
        content,
      });
      return { id, category: "gotcha", title, content };
    });
    for (const [index, entry] of entries.entries()) {
      if (index === 8) {
        db()
          .query("UPDATE knowledge SET cross_project = 0 WHERE logical_id = ?")
          .run(foreign);
        expect(ltm.get(foreign)?.cross_project).toBe(0);
      }
      expect(
        appendKnowledgePromptDelta({
          sessionID,
          projectPath: PROJECT,
          insertAt: 10 + index,
          previousKeys: [],
          nextKeys: [keyOf(entry.id, entry.title, entry.content)],
          entries: [entry],
          taskShift: true,
          now: index * 100_000,
        }),
      ).toBe(true);
    }
    const compacted = listSessionPromptDeltas(sessionID);
    expect(compacted).toHaveLength(1);
    const body = deltaText(compacted[0].content);
    expect(body).not.toContain(entries[0].content);
    expect(body).not.toContain(foreign);
    expect(body).toContain(entries[8].content);
  });

  it("does not render revoked overflow titles in a new or coalesced block", () => {
    const foreign = ltm.create({
      projectPath: "/tmp/lore-delta-revoked-overflow",
      scope: "project",
      crossProject: true,
      category: "gotcha",
      title: "Private overflow title",
      content: "Private overflow content.",
    });
    const local = ltm.create({
      projectPath: PROJECT,
      scope: "project",
      category: "gotcha",
      title: "Local overflow anchor",
      content: "Visible local guidance.",
    });
    const entry = {
      id: local,
      category: "gotcha",
      title: "Local overflow anchor",
      content: "Visible local guidance.",
    };
    const staleOverflow = [
      { id: foreign, category: "gotcha", title: "Private overflow title" },
    ];
    db()
      .query("UPDATE knowledge SET cross_project = 0 WHERE logical_id = ?")
      .run(foreign);
    expect(ltm.get(foreign)?.cross_project).toBe(0);

    const sessionID = `revoked-overflow-${crypto.randomUUID()}`;
    expect(
      appendKnowledgePromptDelta({
        sessionID,
        projectPath: PROJECT,
        insertAt: 10,
        previousKeys: [`${local}:`],
        nextKeys: [keyOf(entry.id, entry.title, entry.content)],
        entries: [entry],
        overflow: staleOverflow,
        taskShift: true,
        now: 100_000,
      }),
    ).toBe(true);
    const initial = deltaText(listSessionPromptDeltas(sessionID)[0].content);
    expect(initial).toContain(entry.content);
    expect(initial).not.toContain("Private overflow title");
    expect(initial).not.toContain(foreign);

    ltm.update(local, { content: "Updated visible local rule." });
    const second = ltm.getByLogical(local);
    if (!second) throw new Error("Missing updated local anchor");
    expect(
      appendKnowledgePromptDelta({
        sessionID,
        projectPath: PROJECT,
        insertAt: 11,
        previousKeys: [`${local}:`],
        nextKeys: [keyOf(second.id, second.title, second.content)],
        entries: [
          {
            id: second.id,
            category: "gotcha",
            title: second.title,
            content: second.content,
          },
        ],
        overflow: staleOverflow,
        now: 100_001,
      }),
    ).toBe(true);
    const coalesced = listSessionPromptDeltas(sessionID);
    expect(coalesced).toHaveLength(1);
    const body = deltaText(coalesced[0].content);
    expect(body).toContain("Updated visible local rule.");
    expect(body).not.toContain("Private overflow title");
    expect(body).not.toContain(foreign);
  });

  it("bounds overflow reads while finding a valid suggestion after revoked ones", () => {
    const revoked = ltm.create({
      projectPath: "/tmp/lore-delta-overflow-load-foreign",
      scope: "project",
      crossProject: true,
      category: "gotcha",
      title: "Revoked overflow candidate",
      content: "Not visible here.",
    });
    const visible = ltm.create({
      projectPath: PROJECT,
      scope: "project",
      category: "gotcha",
      title: "Eligible later candidate",
      content: "Recallable guidance.",
    });
    const anchor = ltm.create({
      projectPath: PROJECT,
      scope: "project",
      category: "gotcha",
      title: "Overflow load anchor",
      content: "Visible selected guidance.",
    });
    db()
      .query("UPDATE knowledge SET cross_project = 0 WHERE logical_id = ?")
      .run(revoked);
    const missing = Array.from({ length: 500 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      category: "gotcha",
      title: "Unavailable candidate",
    }));
    const overflow = [
      { id: revoked, category: "gotcha", title: "Revoked overflow candidate" },
      ...missing.slice(0, 14),
      { id: visible, category: "gotcha", title: "Stale eligible title" },
      ...missing.slice(14),
    ];
    const sink = { info() {}, warn() {}, error() {}, captureException() {} };
    const reads = { count: 0 };
    log.registerSink({
      ...sink,
      withDbSpan(sql, fn) {
        if (
          sql.includes("knowledge_current") ||
          sql.includes("FROM knowledge")
        ) {
          reads.count++;
        }
        return fn();
      },
    });
    try {
      const sessionID = `overflow-load-${crypto.randomUUID()}`;
      expect(
        appendKnowledgePromptDelta({
          sessionID,
          projectPath: PROJECT,
          insertAt: 10,
          previousKeys: [],
          nextKeys: [
            keyOf(anchor, "Overflow load anchor", "Visible selected guidance."),
          ],
          entries: [
            {
              id: anchor,
              category: "gotcha",
              title: "Overflow load anchor",
              content: "Visible selected guidance.",
            },
          ],
          overflow,
          taskShift: true,
          now: 100_000,
        }),
      ).toBe(true);
      const body = deltaText(listSessionPromptDeltas(sessionID)[0].content);
      expect(body).toContain("Eligible later candidate");
      expect(body).toContain(`k:${visible}`);
      expect(body).not.toContain("Stale eligible title");
      expect(body).not.toContain("Revoked overflow candidate");
      expect(body).not.toContain(revoked);
      expect(reads.count).toBeLessThanOrEqual(120);
    } finally {
      log.registerSink(sink);
    }
  });

  it("truncates overflow titles without persisting half of a surrogate pair", () => {
    const title = `😀😀${"x".repeat(117)}😀`;
    const overflowID = ltm.create({
      projectPath: PROJECT,
      scope: "project",
      category: "gotcha",
      title,
      content: "Available through recall.",
    });
    const anchor = ltm.create({
      projectPath: PROJECT,
      scope: "project",
      category: "gotcha",
      title: "Unicode overflow anchor",
      content: "Selected content.",
    });
    const sessionID = `overflow-unicode-${crypto.randomUUID()}`;
    expect(
      appendKnowledgePromptDelta({
        sessionID,
        projectPath: PROJECT,
        insertAt: 10,
        previousKeys: [],
        nextKeys: [
          keyOf(anchor, "Unicode overflow anchor", "Selected content."),
        ],
        entries: [
          {
            id: anchor,
            category: "gotcha",
            title: "Unicode overflow anchor",
            content: "Selected content.",
          },
        ],
        overflow: [{ id: overflowID, category: "gotcha", title }],
        taskShift: true,
        now: 100_000,
      }),
    ).toBe(true);
    const body = deltaText(listSessionPromptDeltas(sessionID)[0].content);
    expect(body).toContain(title);
    expect(
      Array.from(body).some((char) => {
        const code = char.charCodeAt(0);
        return char.length === 1 && code >= 0xd800 && code <= 0xdfff;
      }),
    ).toBe(false);
  });

  it("restores re-shared guidance during a debounced edit after revocation", () => {
    const foreign = ltm.create({
      projectPath: "/tmp/lore-delta-reshare-source",
      scope: "project",
      crossProject: true,
      category: "gotcha",
      title: "Re-shared guidance",
      content: "Visible again after sharing resumes.",
    });
    const entries = Array.from({ length: 9 }, (_, index) => {
      if (index === 0)
        return {
          id: foreign,
          category: "gotcha",
          title: "Re-shared guidance",
          content: "Visible again after sharing resumes.",
        };
      const topic = [
        "parser checksum",
        "gateway routing",
        "index recovery",
        "cache expiration",
        "session ownership",
        "artifact upload",
        "schema upgrade",
        "worker timeout",
      ][index - 1];
      const title = `Local ${topic}`;
      const content = `Apply the ${topic} rule to this task.`;
      const id = ltm.create({
        projectPath: PROJECT,
        scope: "project",
        category: "gotcha",
        title,
        content,
      });
      return { id, category: "gotcha", title, content };
    });
    const sessionID = `reshared-cap-${Date.now()}`;
    expect(new Set(entries.map((entry) => entry.id)).size).toBe(entries.length);
    for (const [index, entry] of entries.entries()) {
      if (index === 8)
        db()
          .query("UPDATE knowledge SET cross_project = 0 WHERE logical_id = ?")
          .run(foreign);
      expect(
        appendKnowledgePromptDelta({
          sessionID,
          projectPath: PROJECT,
          insertAt: 10 + index,
          previousKeys: [],
          nextKeys: [keyOf(entry.id, entry.title, entry.content)],
          entries: [entry],
          taskShift: true,
          now: index * 100_000,
        }),
        `re-share setup index ${index}`,
      ).toBe(true);
    }
    expect(
      deltaText(listSessionPromptDeltas(sessionID)[0].content),
    ).not.toContain(entries[0].content);
    db()
      .query("UPDATE knowledge SET cross_project = 1 WHERE logical_id = ?")
      .run(foreign);
    const editedContent = "Updated local guidance after sharing resumes.";
    ltm.update(entries[8].id, { content: editedContent });
    const edited = { ...entries[8], content: editedContent };
    expect(
      appendKnowledgePromptDelta({
        sessionID,
        projectPath: PROJECT,
        insertAt: 20,
        previousKeys: [],
        nextKeys: [
          keyOf(foreign, entries[0].title, entries[0].content),
          keyOf(edited.id, edited.title, edited.content),
        ],
        entries: [entries[0], edited],
        taskShift: true,
        now: 800_001,
      }),
    ).toBe(true);
    const body = deltaText(listSessionPromptDeltas(sessionID)[0].content);
    expect(body).toContain(entries[0].content);
    expect(body).toContain(editedContent);
  });

  it.each(["revoked sharing", "deleted distillation"] as const)(
    "drops unverified legacy content after %s when later changes compact the block",
    (source) => {
      const legacyContent = "Legacy guidance lost before compaction.";
      const legacyID =
        source === "revoked sharing"
          ? ltm.create({
              projectPath: "/tmp/lore-delta-legacy-source",
              scope: "project",
              crossProject: true,
              category: "gotcha",
              title: "Legacy shared guidance",
              content: legacyContent,
            })
          : `d:legacy-source-${Date.now()}`;
      if (source === "deleted distillation")
        seedDistillation(legacyID.slice(2), legacyContent);
      const sessionID = `legacy-cap-${source}-${Date.now()}`;
      const entries = Array.from({ length: 9 }, (_, index) => {
        if (index === 0)
          return {
            id: legacyID,
            category:
              source === "revoked sharing"
                ? "gotcha"
                : ltm.RECALLED_CONTEXT_CATEGORY,
            title:
              source === "revoked sharing"
                ? "Legacy shared guidance"
                : "Relevant earlier context",
            content: legacyContent,
          };
        const title = `Legacy follow-up ${index}`;
        const content = `Follow-up content ${index}.`;
        const id = ltm.create({
          projectPath: PROJECT,
          scope: "project",
          category: "gotcha",
          title,
          content,
        });
        return { id, category: "gotcha", title, content };
      });
      for (const [index, entry] of entries.entries()) {
        if (index === 1) {
          updateSessionPromptDeltaSelector(
            sessionID,
            0,
            JSON.stringify({ target: "messages", insertAt: 10 }),
          );
          if (source === "revoked sharing")
            db()
              .query(
                "UPDATE knowledge SET cross_project = 0 WHERE logical_id = ?",
              )
              .run(legacyID);
          else expect(data.deleteDistillation(legacyID.slice(2))).toBe(true);
        }
        expect(
          appendKnowledgePromptDelta({
            sessionID,
            projectPath: PROJECT,
            insertAt: 10 + index,
            previousKeys: [],
            nextKeys: [keyOf(entry.id, entry.title, entry.content)],
            entries: [entry],
            taskShift: true,
            now: index * 100_000,
          }),
        ).toBe(true);
      }
      const compacted = listSessionPromptDeltas(sessionID);
      expect(compacted).toHaveLength(1);
      expect(deltaText(compacted[0].content)).not.toContain(entries[0].content);
      expect(deltaText(compacted[0].content)).toContain(entries[8].content);
      const replayed = applySessionPromptDeltas(
        [{ role: "user", content: [{ type: "text", text: "New request" }] }],
        sessionID,
      );
      expect(JSON.stringify(replayed)).not.toContain(entries[0].content);
    },
  );

  it("keeps earlier distillation snapshots when a later block triggers compaction", () => {
    const sessionID = `synthetic-cap-${Date.now()}`;
    const entries = Array.from({ length: 9 }, (_, index) => ({
      id: `d:synthetic-${index}`,
      category: ltm.RECALLED_CONTEXT_CATEGORY,
      title: "Relevant earlier context",
      content: `Distinct guidance from task ${index}.`,
    }));
    for (const [index, entry] of entries.entries()) {
      seedDistillation(entry.id.slice(2), entry.content);
      expect(
        appendKnowledgePromptDelta({
          sessionID,
          projectPath: PROJECT,
          insertAt: 10 + index,
          previousKeys: [],
          nextKeys: [keyOf(entry.id, entry.title, entry.content)],
          entries: [entry],
          now: index * 100_000,
        }),
      ).toBe(true);
    }
    const compacted = listSessionPromptDeltas(sessionID);
    expect(compacted).toHaveLength(1);
    const body = deltaText(compacted[0].content);
    for (const entry of entries) {
      expect(body).toContain(entry.content);
    }
  });

  it("does not restore a deleted distillation snapshot during compaction", () => {
    const sessionID = `deleted-synthetic-cap-${Date.now()}`;
    const entries = Array.from({ length: 9 }, (_, index) => ({
      id: `d:deleted-synthetic-${index}`,
      category: ltm.RECALLED_CONTEXT_CATEGORY,
      title: "Relevant earlier context",
      content: `Distillation guidance ${index}.`,
    }));
    for (const [index, entry] of entries.entries()) {
      seedDistillation(entry.id.slice(2), entry.content);
      if (index === 8)
        expect(data.deleteDistillation(entries[0].id.slice(2))).toBe(true);
      expect(
        appendKnowledgePromptDelta({
          sessionID,
          projectPath: PROJECT,
          insertAt: 10 + index,
          previousKeys: [],
          nextKeys: [keyOf(entry.id, entry.title, entry.content)],
          entries: [entry],
          now: index * 100_000,
        }),
      ).toBe(true);
    }
    const compacted = listSessionPromptDeltas(sessionID);
    expect(compacted).toHaveLength(1);
    const body = deltaText(compacted[0].content);
    expect(body).not.toContain(entries[0].content);
    expect(body).not.toContain(entries[0].id);
    expect(body).toContain(entries[8].content);
  });

  it("keeps task-switch additions when compacting the eighth block and ignores a no-op at the cap", () => {
    const sessionID = `task-cap-${Date.now()}`;
    const ids = Array.from({ length: 9 }, (_, index) =>
      ltm.create({
        projectPath: PROJECT,
        scope: "project",
        category: "gotcha",
        title: `Task switch ${index}`,
        content: `Task-specific guidance ${index}.`,
      }),
    );
    const entries = ids.map((id, index) => ({
      id,
      category: "gotcha",
      title: `Task switch ${index}`,
      content: `Task-specific guidance ${index}.`,
    }));
    const keys = entries.map((entry) =>
      keyOf(entry.id, entry.title, entry.content),
    );
    for (const [index, entry] of entries.entries()) {
      expect(
        appendKnowledgePromptDelta({
          sessionID,
          projectPath: PROJECT,
          insertAt: 10 + index,
          previousKeys: [],
          nextKeys: [keys[index]],
          entries: [entry],
          taskShift: true,
          now: 1_000 + index,
        }),
      ).toBe(true);
      if (index === 7) {
        const atCap = listSessionPromptDeltas(sessionID);
        expect(atCap).toHaveLength(8);
        expect(
          appendKnowledgePromptDelta({
            sessionID,
            projectPath: PROJECT,
            insertAt: 19,
            previousKeys: [],
            nextKeys: [keys[index]],
            entries: [entry],
            taskShift: true,
            now: 1_009,
          }),
        ).toBe(false);
        expect(listSessionPromptDeltas(sessionID)).toEqual(atCap);
      }
    }
    const compacted = listSessionPromptDeltas(sessionID);
    expect(compacted).toHaveLength(1);
    for (const entry of entries) {
      expect(deltaText(compacted[0].content)).toContain(entry.content);
    }
    expect(
      appendKnowledgePromptDelta({
        sessionID,
        projectPath: PROJECT,
        insertAt: 20,
        previousKeys: [],
        nextKeys: [keys[8]],
        entries: [entries[8]],
        taskShift: true,
        now: 1_010,
      }),
    ).toBe(false);
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
      now: 1000,
    });
    // Surfaced is now at v2; another call with no further change → no block.
    const wNoop = appendKnowledgePromptDelta({
      sessionID,
      projectPath: PROJECT,
      insertAt: 15,
      previousKeys: pin,
      nextKeys: pin,
      entries: [],
      now: 1001, // inside debounce window — coalesces into block 0 (no-op)
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
      now: 121_000, // > 60s past block 0 → outside debounce window
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
