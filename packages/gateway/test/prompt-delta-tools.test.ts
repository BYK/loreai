/**
 * Regression tests for the durable prompt-delta channel (#747).
 *
 * Bug: appendKnowledgePromptDelta inserts a synthetic *user* "knowledge
 * update" message at `messages.length - 1`, and applySessionPromptDeltas
 * replays persisted deltas at their stored index. When a turn ends with a
 * tool call, the wire layout is:
 *
 *   assistant(tool_use X)
 *   user(tool_result X)            <- last message
 *
 * Inserting a synthetic user message at length-1 lands it BETWEEN the
 * tool_use and its tool_result:
 *
 *   assistant(tool_use X)
 *   user(knowledge update)         <- inserted, breaks adjacency
 *   user(tool_result X)
 *
 * which Anthropic rejects with "tool_use ids were found without tool_result
 * blocks immediately after". The insert index must be tool-pair-aware, and
 * the orphan safety net must run after deltas are applied.
 */
import { describe, test, expect } from "vitest";
import {
  safeDeltaInsertIndex,
  applySessionPromptDeltas,
  removeOrphanedToolResults,
  captureToolPairing400,
} from "../src/pipeline";
import { appendSessionPromptDelta, ensureProject } from "@loreai/core";
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

describe("safeDeltaInsertIndex — never splits a tool_use/tool_result pair", () => {
  test("moves a tail insert before the assistant(tool_use) when it would split the pair", () => {
    // [user, assistant(tool_use X), user(tool_result X)]
    // desired = length-1 = 2, which is between tool_use and tool_result.
    const messages = [
      user(text("hi")),
      assistant(toolUse("X")),
      user(toolResult("X")),
    ];
    const idx = safeDeltaInsertIndex(messages, messages.length - 1);
    // Must not land at 2 (between use and result). Acceptable: 1 (before the
    // assistant) so the pair stays adjacent.
    expect(idx).not.toBe(2);
    // Verify the resulting array keeps the pair adjacent.
    const out = messages.slice();
    out.splice(idx, 0, user(text("delta")));
    assertNoOrphanedTools(out);
  });

  test("keeps a safe tail insert at the end when the last message is not a tool_result", () => {
    const messages = [
      user(text("hi")),
      assistant(toolUse("X")),
      user(toolResult("X")),
      assistant(text("done")),
    ];
    const idx = safeDeltaInsertIndex(messages, messages.length - 1);
    const out = messages.slice();
    out.splice(idx, 0, user(text("delta")));
    assertNoOrphanedTools(out);
  });

  test("handles parallel tool calls (multi tool_use / multi tool_result)", () => {
    const messages = [
      user(text("hi")),
      assistant(toolUse("A"), toolUse("B")),
      user(toolResult("A"), toolResult("B")),
    ];
    const idx = safeDeltaInsertIndex(messages, messages.length - 1);
    expect(idx).not.toBe(2);
    const out = messages.slice();
    out.splice(idx, 0, user(text("delta")));
    assertNoOrphanedTools(out);
  });

  test("clamps to array bounds", () => {
    const messages = [user(text("hi"))];
    expect(safeDeltaInsertIndex(messages, 99)).toBeLessThanOrEqual(
      messages.length,
    );
    expect(safeDeltaInsertIndex(messages, -5)).toBeGreaterThanOrEqual(0);
  });
});

describe("persisted delta + backstop never orphans a tool pair on the wire", () => {
  // applySessionPromptDeltas replays a persisted index VERBATIM (byte-position
  // stable for the prompt cache — #747). If a later turn's layout makes that
  // index land between a tool_use/tool_result pair, the production pipeline's
  // removeOrphanedToolResults backstop (run right after) is the hard guarantee
  // that no orphan reaches the API. This test mirrors that exact sequence.
  test("stale persisted index splitting a pair is repaired by the backstop", () => {
    const sessionID = `delta-tools-${Date.now()}`;
    const projectID = ensureProject(`/tmp/lore-delta-tools-${Date.now()}`);

    // Persist a delta whose stored insertAt (2) lands between the tool_use and
    // its tool_result for THIS turn's layout (a layout that differs from the
    // delta's creation turn — exactly the cross-turn drift case).
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

    // Production sequence: apply deltas (verbatim index), then the backstop.
    const out = applySessionPromptDeltas(messages, sessionID);
    removeOrphanedToolResults(out);

    // The wire array must be orphan-free regardless of where the delta landed.
    assertNoOrphanedTools(out);
  });

  test("replay is byte-position stable: a non-splitting persisted index is not moved", () => {
    const sessionID = `delta-stable-${Date.now()}`;
    const projectID = ensureProject(`/tmp/lore-delta-stable-${Date.now()}`);

    // insertAt=1 sits before the assistant — does not split the pair.
    appendSessionPromptDelta({
      sessionID,
      projectID,
      selector: JSON.stringify({ target: "messages", insertAt: 1 }),
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
    // Delta replayed at exactly index 1 (byte-position stable), pair intact.
    expect(out[1]?.role).toBe("user");
    expect(
      out[1]?.content.some(
        (b) => b.type === "text" && b.text === "Lore knowledge update",
      ),
    ).toBe(true);
    assertNoOrphanedTools(out);
  });
});

describe("captureToolPairing400 — detection", () => {
  // Sentry is not initialized in tests, so captureToolPairing400 returns true
  // when it *would* capture (detection matched) and false otherwise, without
  // emitting. We assert on the detection decision only.
  const anthropicBody =
    '{"type":"error","error":{"type":"invalid_request_error","message":"messages.560: `tool_use` ids were found without `tool_result` blocks immediately after: toolu_x. Each `tool_use` block must have a corresponding `tool_result` block in the next message."}}';

  test("matches the real Anthropic tool-pairing 400 body", () => {
    expect(
      captureToolPairing400({
        status: 400,
        errorBody: anthropicBody,
        messages: [],
        layer: 0,
        model: "claude-opus-4-8",
        sessionID: "abc",
      }),
    ).toBe(true);
  });

  test("does not match a non-400 status", () => {
    expect(
      captureToolPairing400({
        status: 429,
        errorBody: anthropicBody,
        messages: [],
        layer: 0,
        model: "m",
        sessionID: "abc",
      }),
    ).toBe(false);
  });

  test("does not match a 400 that merely mentions tools (no 'without')", () => {
    expect(
      captureToolPairing400({
        status: 400,
        errorBody:
          '{"error":{"message":"tool_use input does not match tool_result schema"}}',
        messages: [],
        layer: 0,
        model: "m",
        sessionID: "abc",
      }),
    ).toBe(false);
  });
});

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
