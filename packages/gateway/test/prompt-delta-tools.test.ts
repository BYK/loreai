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
  buildKnowledgeDeltaMessage,
  isKnowledgeDeltaCloser,
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

  test("clamps to array bounds (never the true tail — leaves one real message)", () => {
    const messages = [user(text("hi"))];
    // The pair must never end at the tail, so the index is capped at length-1.
    expect(safeDeltaInsertIndex(messages, 99)).toBeLessThanOrEqual(
      messages.length - 1,
    );
    expect(safeDeltaInsertIndex(messages, -5)).toBeGreaterThanOrEqual(0);
  });

  test("never lets the injected pair end at the true tail (the wedge)", () => {
    // Regression for the wedge: when insertAt resolves to messages.length, the
    // pair's trailing assistant became the literal last message — a harness
    // renders it as a stray turn and the model ends the loop early. The index
    // must be capped so a real user/tool_result always follows the pair.
    const convo = [
      user(text("q1")),
      assistant(text("r1")),
      user(text("q2")), // the live final user turn
    ];
    const idx = safeDeltaInsertIndex(convo, convo.length); // desired = tail
    // Splice the [user, assistant] pair at idx; the LAST message must be a real
    // message (the final user turn), never the injected assistant.
    const out = convo.slice();
    out.splice(idx, 0, user(text("delta-u")), assistant(text("delta-a")));
    expect(out[out.length - 1].role).toBe("user");
    expect((out[out.length - 1].content[0] as { text: string }).text).toBe(
      "q2",
    );
    // And the injected assistant must not be at the tail.
    expect(out[out.length - 1]).not.toEqual(
      expect.objectContaining({ role: "assistant" }),
    );
  });
});

describe("persisted delta + backstop never orphans a tool pair on the wire", () => {
  // applySessionPromptDeltas replays a persisted index, nudging it to the
  // nearest tool-pair-safe boundary (#747 byte-position stability is preserved
  // for safe indices; only an index that WOULD split a pair is moved). If a
  // later turn's layout makes the stored index land between a
  // tool_use/tool_result pair, the delta is placed BEFORE the assistant so the
  // pair stays intact — instead of relying on removeOrphanedToolResults to
  // destructively strip the (real) tool call every turn.
  test("stale persisted index splitting a pair is nudged so the tool pair survives", () => {
    const sessionID = `delta-tools-${Date.now()}`;
    const projectID = ensureProject(`/tmp/lore-delta-tools-${Date.now()}`);

    // Persist a delta whose stored insertAt (2) lands between the tool_use and
    // its tool_result for THIS turn's layout (a layout that differs from the
    // delta's creation turn — exactly the cross-turn drift case seen in prod
    // where a frozen insertAt became mid-pair as the conversation grew).
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

    // Production sequence: apply deltas (now tool-pair-safe), then the backstop.
    const out = applySessionPromptDeltas(messages, sessionID);
    const beforeBackstop = JSON.stringify(out);
    removeOrphanedToolResults(out);

    // The wire array must be orphan-free...
    assertNoOrphanedTools(out);
    // ...AND the tool pair must SURVIVE (not be stripped): the backstop is a
    // no-op because applySessionPromptDeltas already placed the delta safely.
    expect(JSON.stringify(out)).toBe(beforeBackstop);
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
    expect(deltaIdx).toBeLessThan(toolUseIdx);
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

// The knowledge delta is injected as a user→assistant PAIR. In a mid-tool-loop
// turn the tool-pair guard seats it before the assistant(tool_use), which would
// otherwise leave the pair's trailing assistant abutting that real assistant
// (two consecutive assistant messages — a strict-alternation 400). The
// assistant-coalesce pass in applySessionPromptDeltas must fold them into one.
describe("knowledge-delta PAIR — no consecutive assistants, tool-pairing intact", () => {
  const CHANGED = [
    {
      id: "019aaaaa-1111-7111-8111-111111111111",
      category: "pattern",
      title: "Card primitive",
      content: "Use the shared Card component.",
    },
  ];

  function assertNoConsecutiveAssistants(messages: GatewayMessage[]): void {
    for (let i = 1; i < messages.length; i++) {
      expect(
        messages[i].role === "assistant" &&
          messages[i - 1].role === "assistant",
        `consecutive assistant messages at ${i - 1},${i}: ${messages
          .map((m) => m.role)
          .join(",")}`,
      ).toBe(false);
    }
  }

  function seedPair(sessionID: string, projectID: string, insertAt: number) {
    const pair = buildKnowledgeDeltaMessage(CHANGED, [], "7a3f9b2c");
    expect(pair).toHaveLength(2);
    expect(pair[0].role).toBe("user");
    expect(pair[1].role).toBe("assistant");
    appendSessionPromptDelta({
      sessionID,
      projectID,
      selector: JSON.stringify({ target: "messages", insertAt }),
      content: JSON.stringify(pair),
    });
  }

  test("mid-tool-loop tail: closer stays separate from the tool_use assistant", () => {
    const sessionID = `pair-toolloop-${Date.now()}`;
    const projectID = ensureProject(`/tmp/lore-pair-toolloop-${Date.now()}`);
    // Realistic agent turn: assistant plans + calls a tool in ONE message, then
    // the tool_result comes back as the final (user) message.
    const layout: GatewayMessage[] = [
      user(text("migrate the card")),
      assistant(text("on it"), toolUse("X")),
      user(toolResult("X")),
    ];
    // insertAt = len-1 = 2 lands between tool_use and tool_result → guard walks
    // it before the assistant, seating the injected assistant next to it.
    seedPair(sessionID, projectID, layout.length - 1);
    const out = applySessionPromptDeltas(layout, sessionID);
    removeOrphanedToolResults(out);
    assertNoOrphanedTools(out);
    // The closer (`*🧠 Refreshed memory*`) stays as a DISTINCT assistant
    // message — never coalesced into the real tool_use assistant. This means
    // consecutive assistants CAN appear in the mid-tool-loop layout, and that's
    // intentional: a harness must render the closer separately so the model
    // never treats it as part of its own turn.
    const roles = out.map((m) => m.role);
    expect(roles).toContain("user");
    expect(roles).toContain("assistant");
    // The closer must appear as its own assistant message (not merged).
    const closerIdx = out.findIndex(isKnowledgeDeltaCloser);
    expect(closerIdx).toBeGreaterThan(-1);
    expect(out[closerIdx].role).toBe("assistant");
    // The framing note (non-ack) survived as its own user turn…
    const joined = out
      .flatMap((m) => m.content.map((b) => (b as { text?: string }).text ?? ""))
      .join("\n");
    expect(joined).toContain("Lore knowledge update");
    // …and the knowledge payload rode along.
    expect(joined).toContain("Card primitive");
    // Stable on replay (frozen position → byte-identical roles).
    const out2 = applySessionPromptDeltas(layout, sessionID);
    removeOrphanedToolResults(out2);
    expect(out2.map((m) => m.role)).toEqual(out.map((m) => m.role));
  });

  test("plain tail (final user turn): pair sits cleanly before it", () => {
    const sessionID = `pair-plain-${Date.now()}`;
    const projectID = ensureProject(`/tmp/lore-pair-plain-${Date.now()}`);
    const layout: GatewayMessage[] = [
      user(text("hi")),
      assistant(text("hello")),
      user(text("do the thing")),
    ];
    seedPair(sessionID, projectID, layout.length - 1);
    const out = applySessionPromptDeltas(layout, sessionID);
    assertNoOrphanedTools(out);
    assertNoConsecutiveAssistants(out);
  });
});

/**
 * The knowledge-delta closer (`*🧠 Refreshed memory*`) must NEVER coalesce
 * into an adjacent real assistant message — a harness would render it inline
 * with the real reply and the model could treat it as part of its own turn.
 * `coalesceAdjacentAssistants` detects the closer via `isKnowledgeDeltaCloser`
 * and skips the merge. Regression for the session "Armin's blog post &
 * folklore solution" where `*🧠 Refreshed memory*` was appearing inline with
 * the model's real response.
 */
describe("coalesceAdjacentAssistants — keeps the knowledge-delta closer as a separate assistant message", () => {
  test("closer followed by a real assistant message stays distinct (not merged)", async () => {
    const { coalesceAdjacentAssistants } = await import("../src/pipeline");
    const closer: GatewayMessage = {
      role: "assistant",
      content: [{ type: "text", text: "*🧠 Refreshed memory*" }],
    };
    const realReply: GatewayMessage = {
      role: "assistant",
      content: [{ type: "text", text: "I'll look into that." }],
    };
    const out = coalesceAdjacentAssistants([closer, realReply]);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual(closer);
    expect(out[1]).toEqual(realReply);
  });

  test("real assistant message followed by a closer stays distinct (not merged)", async () => {
    const { coalesceAdjacentAssistants } = await import("../src/pipeline");
    const realReply: GatewayMessage = {
      role: "assistant",
      content: [{ type: "text", text: "I'll look into that." }],
    };
    const closer: GatewayMessage = {
      role: "assistant",
      content: [{ type: "text", text: "*🧠 Refreshed memory*" }],
    };
    const out = coalesceAdjacentAssistants([realReply, closer]);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual(realReply);
    expect(out[1]).toEqual(closer);
  });

  test("two real assistant messages still coalesce (closer protection doesn't break the normal case)", async () => {
    const { coalesceAdjacentAssistants } = await import("../src/pipeline");
    const a: GatewayMessage = {
      role: "assistant",
      content: [{ type: "text", text: "first part." }],
    };
    const b: GatewayMessage = {
      role: "assistant",
      content: [{ type: "text", text: "second part." }],
    };
    const out = coalesceAdjacentAssistants([a, b]);
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe("assistant");
    // Both texts are present in the merged message (order is preserved per
    // the existing coalesce contract — newer message's content first to keep
    // any leading reasoning blocks at index 0).
    const merged = (out[0].content as Array<{ text?: string }>)
      .map((b) => b.text ?? "")
      .join("|");
    expect(merged).toContain("first part.");
    expect(merged).toContain("second part.");
  });

  test("isKnowledgeDeltaCloser detects the closer and rejects non-closer text", async () => {
    const { isKnowledgeDeltaCloser } = await import("../src/pipeline");
    expect(
      isKnowledgeDeltaCloser({
        role: "assistant",
        content: [{ type: "text", text: "*🧠 Refreshed memory*" }],
      }),
    ).toBe(true);
    // Legacy closer text (persisted by sessions before #1494) is also
    // detected — defense-in-depth against the inline-rendering regression
    // for any block the parseDeltaMessages migration skipped.
    expect(
      isKnowledgeDeltaCloser({
        role: "assistant",
        content: [{ type: "text", text: "[memory refreshed]" }],
      }),
    ).toBe(true);
    expect(
      isKnowledgeDeltaCloser({
        role: "assistant",
        content: [{ type: "text", text: "I'll look into that." }],
      }),
    ).toBe(false);
    expect(isKnowledgeDeltaCloser(undefined)).toBe(false);
    expect(
      isKnowledgeDeltaCloser({
        role: "user",
        content: [{ type: "text", text: "*🧠 Refreshed memory*" }],
      }),
    ).toBe(false);
  });

  test("legacy '[memory refreshed]' closer stays separate from a real assistant message (no inline merge)", async () => {
    const { coalesceAdjacentAssistants } = await import("../src/pipeline");
    const legacyCloser: GatewayMessage = {
      role: "assistant",
      content: [{ type: "text", text: "[memory refreshed]" }],
    };
    const realReply: GatewayMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Sure, I'll do that." }],
    };
    // Same protection as the current closer — the legacy text must not be
    // folded into the real reply.
    const out = coalesceAdjacentAssistants([legacyCloser, realReply]);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual(legacyCloser);
    expect(out[1]).toEqual(realReply);
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
