/**
 * TDD spec for the delta-compress re-anchor fix (tool-pair-safe knowledge
 * delta placement + layer-transition-driven delta reset).
 *
 * Background: a single sentinel seq-0 knowledge-delta row is persisted per
 * session in `session_prompt_deltas` (via core's upsert/append/list helpers).
 * Its stored `insertAt` is FROZEN to keep the cached message prefix byte-stable
 * across STABLE turns. But on a COMPRESSING turn the message array reshuffles
 * (raw-window slides, layers escalate), so a frozen insertAt can land between a
 * tool_use and its tool_result — orphaning the pair on the wire. The fix:
 *
 *   1. `safeDeltaInsertIndex` must NEVER return an index immediately after an
 *      assistant containing a tool_use (it walks back before the assistant).
 *   2. On a compressing/layer-changing turn the caller deletes the stored
 *      delta (`deleteSessionPromptDelta`) and recomputes a fresh index; on a
 *      stable turn the stored index is left frozen.
 *   3. `shouldResetDeltaOnCompression(prevLayer, curLayer)` is the pure
 *      predicate gating that delete/recompute decision.
 *
 * Some of these APIs are not implemented yet — tests that exercise an
 * unimplemented symbol fail cleanly (typeof check) rather than crashing
 * collection.
 *
 * EXPECTED API signatures (implementation pending):
 *   - core: deleteSessionPromptDelta(sessionID: string): void
 *   - pipeline: shouldResetDeltaOnCompression(prevLayer: number, curLayer: number): boolean
 *   - pipeline: safeDeltaInsertIndex(messages, desired): number   (already exists)
 *   - core: appendSessionPromptDelta({sessionID, projectID, selector, content}): void
 *   - core: listSessionPromptDeltas(sessionID): Array<{seq, selector, content, projectID}>
 *   - core: ensureProject(path): string
 */
import { describe, test, expect } from "vitest";
import {
  safeDeltaInsertIndex,
  applySessionPromptDeltas,
  removeOrphanedToolResults,
  shouldResetDeltaOnCompression,
} from "../src/pipeline";
import {
  appendSessionPromptDelta,
  deleteSessionPromptDelta,
  listSessionPromptDeltas,
  ensureProject,
} from "@loreai/core";
import type {
  GatewayContentBlock,
  GatewayMessage,
} from "../src/translate/types";

function user(...content: GatewayContentBlock[]): GatewayMessage {
  return { role: "user", content };
}
function assistant(...content: GatewayContentBlock[]): GatewayMessage {
  return { role: "assistant", content };
}
function toolUse(id: string): GatewayContentBlock {
  return { type: "tool_use", id, name: "read", input: {} };
}
function toolResult(id: string): GatewayContentBlock {
  return {
    type: "tool_result",
    toolUseId: id,
    content: [{ type: "text", text: "ok" }],
  };
}
function text(t: string): GatewayContentBlock {
  return { type: "text", text: t };
}

/**
 * Asserts every tool_use has an adjacent matching tool_result on the next
 * message, and every tool_result has an adjacent matching tool_use on the
 * preceding message — the exact invariant Anthropic enforces.
 */
function assertNoOrphanedTools(messages: GatewayMessage[]): void {
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      const useIds = msg.content
        .filter((b) => b.type === "tool_use")
        .map((b) => (b as { id: string }).id);
      if (useIds.length === 0) continue;
      const next = messages[i + 1];
      const resultIds = new Set(
        next?.role === "user"
          ? next.content
              .filter((b) => b.type === "tool_result")
              .map((b) => (b as { toolUseId: string }).toolUseId)
          : [],
      );
      for (const id of useIds) expect(resultIds.has(id)).toBe(true);
    } else {
      const resultIds = msg.content
        .filter((b) => b.type === "tool_result")
        .map((b) => (b as { toolUseId: string }).toolUseId);
      if (resultIds.length === 0) continue;
      const prev = messages[i - 1];
      const useIds = new Set(
        prev?.role === "assistant"
          ? prev.content
              .filter((b) => b.type === "tool_use")
              .map((b) => (b as { id: string }).id)
          : [],
      );
      for (const id of resultIds) expect(useIds.has(id)).toBe(true);
    }
  }
}

// ---------------------------------------------------------------------------
// 2. shouldResetDeltaOnCompression — pure layer-transition predicate
// ---------------------------------------------------------------------------
describe("shouldResetDeltaOnCompression — layer-transition predicate", () => {
  // EXPECTED API — implementation pending
  test("is exported as a function", () => {
    expect(typeof shouldResetDeltaOnCompression).toBe("function");
  });

  test("FALSE at passthrough (0,0): no compression this turn", () => {
    expect(typeof shouldResetDeltaOnCompression).toBe("function");
    expect(shouldResetDeltaOnCompression(0, 0)).toBe(false);
  });

  test("TRUE entering compression (0,1)", () => {
    expect(typeof shouldResetDeltaOnCompression).toBe("function");
    expect(shouldResetDeltaOnCompression(0, 1)).toBe(true);
  });

  test("FALSE stable within layer 1 (1,1): caller handles raw-window repin separately", () => {
    expect(typeof shouldResetDeltaOnCompression).toBe("function");
    expect(shouldResetDeltaOnCompression(1, 1)).toBe(false);
  });

  test("TRUE escalated (1,2)", () => {
    expect(typeof shouldResetDeltaOnCompression).toBe("function");
    expect(shouldResetDeltaOnCompression(1, 2)).toBe(true);
  });

  test("TRUE de-escalated but layer changed (2,1): array reshuffled", () => {
    expect(typeof shouldResetDeltaOnCompression).toBe("function");
    expect(shouldResetDeltaOnCompression(2, 1)).toBe(true);
  });

  test("FALSE dropped back to passthrough (1,0): no compression this turn", () => {
    expect(typeof shouldResetDeltaOnCompression).toBe("function");
    expect(shouldResetDeltaOnCompression(1, 0)).toBe(false);
  });

  test("TRUE layer-4 refresh from passthrough (0,4)", () => {
    expect(typeof shouldResetDeltaOnCompression).toBe("function");
    expect(shouldResetDeltaOnCompression(0, 4)).toBe(true);
  });

  test("TRUE layer-4 refresh from layer 3 (3,4)", () => {
    expect(typeof shouldResetDeltaOnCompression).toBe("function");
    expect(shouldResetDeltaOnCompression(3, 4)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. safeDeltaInsertIndex — never lands immediately after an assistant tool_use
// ---------------------------------------------------------------------------
describe("safeDeltaInsertIndex — never splits a tool_use/tool_result pair", () => {
  test("(a) completed pair: desired=2 returns <=1 (before the assistant)", () => {
    const messages = [
      user(text("hi")),
      assistant(toolUse("X")),
      user(toolResult("X")),
    ];
    const idx = safeDeltaInsertIndex(messages, 2);
    // index 2 is immediately after assistant(tool_use) => would split the pair.
    expect(idx).toBeLessThanOrEqual(1);
    expect(idx).not.toBe(2);
    const out = messages.slice();
    out.splice(idx, 0, user(text("delta")));
    assertNoOrphanedTools(out);
  });

  test("(b) PENDING tool call: tail desired=length returns 1 (before the assistant), NOT 2", () => {
    // No tool_result yet — assistant(tool_use) is the LAST message. The delta
    // must NOT split the pending tool_use from its (future) tool_result, so it
    // must land BEFORE the assistant. (The pair is inherently pending here, so
    // assertNoOrphanedTools does not apply; the index is the discriminator.)
    const messages = [user(text("hi")), assistant(toolUse("X"))];
    const idx = safeDeltaInsertIndex(messages, messages.length); // desired = 2
    expect(idx).toBe(1);
    expect(idx).not.toBe(2);
    // The inserted delta must sit BEFORE the assistant(tool_use), never after.
    const out = messages.slice();
    out.splice(idx, 0, user(text("delta")));
    const deltaIdx = out.findIndex((m) =>
      m.content.some((b) => b.type === "text" && b.text === "delta"),
    );
    const useIdx = out.findIndex((m) =>
      m.content.some((b) => b.type === "tool_use"),
    );
    expect(deltaIdx).toBeLessThan(useIdx);
  });

  test("(c) parallel tool_use (X and Y): desired right after walks back before it", () => {
    const messages = [
      user(text("hi")),
      assistant(toolUse("X"), toolUse("Y")),
      user(toolResult("X"), toolResult("Y")),
    ];
    const idx = safeDeltaInsertIndex(messages, 2);
    expect(idx).toBeLessThanOrEqual(1);
    expect(idx).not.toBe(2);
    const out = messages.slice();
    out.splice(idx, 0, user(text("delta")));
    assertNoOrphanedTools(out);
  });

  test("(d) safe: text-only assistant, desired=2 returns 2 unchanged", () => {
    const messages = [
      user(text("hi")),
      assistant(text("hi back")),
      user(text("more")),
    ];
    const idx = safeDeltaInsertIndex(messages, 2);
    // prev is a text-only assistant (no tool_use) => safe, leave at 2.
    expect(idx).toBe(2);
    const out = messages.slice();
    out.splice(idx, 0, user(text("delta")));
    assertNoOrphanedTools(out);
  });

  test("(e) consecutive tool turns: desired=3 (pending B) walks back to 2, stops (prev is tool_result)", () => {
    const messages = [
      assistant(toolUse("A")),
      user(toolResult("A")),
      assistant(toolUse("B")),
    ];
    const idx = safeDeltaInsertIndex(messages, 3); // tail, B is pending
    // Walk back before assistant(toolUse B) => index 2. Index 2's prev is
    // user(toolResult A), which is NOT a tool_use, so it stops at 2 — does NOT
    // walk all the way back. (B is inherently pending, so the completed A pair
    // must remain intact; assert the delta sits between the A pair and B.)
    expect(idx).toBe(2);
    const out = messages.slice();
    out.splice(idx, 0, user(text("delta")));
    // The completed A pair (indices 0,1) is untouched and adjacent.
    expect(out[0]?.content.some((b) => b.type === "tool_use")).toBe(true);
    expect(out[1]?.content.some((b) => b.type === "tool_result")).toBe(true);
    // The delta lands AT index 2 (between the A pair and the pending B).
    expect(
      out[2]?.content.some((b) => b.type === "text" && b.text === "delta"),
    ).toBe(true);
    // And BEFORE the pending assistant(toolUse B).
    const deltaIdx = 2;
    const bUseIdx = out.findIndex((m, i) =>
      i > 2 ? m.content.some((b) => b.type === "tool_use") : false,
    );
    expect(deltaIdx).toBeLessThan(bUseIdx);
  });
});

// ---------------------------------------------------------------------------
// 4. Delete-and-recompute keeps the tool pair intact (production scenario)
// ---------------------------------------------------------------------------
describe("persisted delta + backstop keeps the tool pair intact", () => {
  test("stale insertAt splitting a completed pair is placed safely; pair survives", () => {
    const sessionID = `delta-reanchor-${Date.now()}-${Math.random()}`;
    const projectID = ensureProject(
      `/tmp/lore-delta-reanchor-${Date.now()}-${Math.random()}`,
    );

    // Persist a delta whose stored insertAt (2) lands between tool_use and
    // tool_result for THIS turn's layout.
    appendSessionPromptDelta({
      sessionID,
      projectID,
      selector: JSON.stringify({ target: "messages", insertAt: 2 }),
      content: JSON.stringify({
        role: "user",
        content: [{ type: "text", text: "Lore knowledge update" }],
      }),
    });

    const messages: GatewayMessage[] = [
      user(text("hi")),
      assistant(toolUse("X")),
      user(toolResult("X")),
    ];

    const out = applySessionPromptDeltas(messages, sessionID);
    removeOrphanedToolResults(out);

    // No orphaned tool blocks on the wire.
    assertNoOrphanedTools(out);

    // The tool_use AND tool_result BOTH still exist (not destructively stripped).
    expect(out.some((m) => m.content.some((b) => b.type === "tool_use"))).toBe(
      true,
    );
    expect(
      out.some((m) => m.content.some((b) => b.type === "tool_result")),
    ).toBe(true);

    // The delta landed BEFORE the assistant(tool_use), not between the pair.
    const deltaIdx = out.findIndex((m) =>
      m.content.some(
        (b) => b.type === "text" && b.text === "Lore knowledge update",
      ),
    );
    const toolUseIdx = out.findIndex((m) =>
      m.content.some((b) => b.type === "tool_use"),
    );
    expect(deltaIdx).toBeGreaterThanOrEqual(0);
    expect(deltaIdx).toBeLessThan(toolUseIdx);
  });
});

// ---------------------------------------------------------------------------
// 5. Stable turn keeps insertAt frozen; compressing turn re-anchors
// ---------------------------------------------------------------------------
describe("layer-transition gates the delete/recompute of the persisted delta", () => {
  test("STABLE turn (1,1): predicate false => row left frozen at insertAt=5", () => {
    expect(typeof shouldResetDeltaOnCompression).toBe("function");
    expect(typeof listSessionPromptDeltas).toBe("function");

    const sessionID = `delta-stable-${Date.now()}-${Math.random()}`;
    const projectID = ensureProject(
      `/tmp/lore-delta-stable-${Date.now()}-${Math.random()}`,
    );

    appendSessionPromptDelta({
      sessionID,
      projectID,
      selector: JSON.stringify({ target: "messages", insertAt: 5 }),
      content: JSON.stringify({
        role: "user",
        content: [{ type: "text", text: "Lore knowledge update" }],
      }),
    });

    // Stable turn within layer 1 => caller must NOT delete.
    const wouldReset = shouldResetDeltaOnCompression(1, 1);
    expect(wouldReset).toBe(false);
    if (wouldReset) deleteSessionPromptDelta(sessionID);

    const rows = listSessionPromptDeltas(sessionID);
    expect(rows.length).toBe(1);
    expect(JSON.parse(rows[0].selector)).toEqual({
      target: "messages",
      insertAt: 5,
    });
  });

  test("COMPRESSING turn (1,2): predicate true => delete clears the row", () => {
    expect(typeof shouldResetDeltaOnCompression).toBe("function");
    expect(typeof deleteSessionPromptDelta).toBe("function");
    expect(typeof listSessionPromptDeltas).toBe("function");

    const sessionID = `delta-compress-${Date.now()}-${Math.random()}`;
    const projectID = ensureProject(
      `/tmp/lore-delta-compress-${Date.now()}-${Math.random()}`,
    );

    appendSessionPromptDelta({
      sessionID,
      projectID,
      selector: JSON.stringify({ target: "messages", insertAt: 5 }),
      content: JSON.stringify({
        role: "user",
        content: [{ type: "text", text: "Lore knowledge update" }],
      }),
    });
    expect(listSessionPromptDeltas(sessionID).length).toBe(1);

    // Compressing turn (escalation 1 -> 2) => caller deletes & recomputes.
    const wouldReset = shouldResetDeltaOnCompression(1, 2);
    expect(wouldReset).toBe(true);
    if (wouldReset) deleteSessionPromptDelta(sessionID);

    // Precondition for recompute: the row is gone, so the next append computes
    // a fresh index (recompute is the pipeline's job, out of unit scope).
    expect(listSessionPromptDeltas(sessionID).length).toBe(0);
  });

  test("deleteSessionPromptDelta on a session with no rows is a no-op", () => {
    expect(typeof deleteSessionPromptDelta).toBe("function");
    expect(typeof listSessionPromptDeltas).toBe("function");

    const sessionID = `delta-empty-${Date.now()}-${Math.random()}`;
    expect(listSessionPromptDeltas(sessionID).length).toBe(0);
    expect(() => deleteSessionPromptDelta(sessionID)).not.toThrow();
    expect(listSessionPromptDeltas(sessionID).length).toBe(0);
  });
});
