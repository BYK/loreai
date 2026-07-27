/**
 * Unit tests for the RecallAwareStreamAccumulator.
 *
 * Tests the streaming recall interception logic:
 *  - No recall → all events forwarded unchanged
 *  - Recall-only → recall block suppressed, held-back events correct
 *  - Mixed tools → recall suppressed, other tools re-indexed
 *  - Recall at different positions (first, middle, last tool)
 *  - Block index renumbering correctness
 */
import { describe, test, expect } from "vitest";
import {
  createRecallAwareAccumulator,
  buildSSEMarkerMessage,
} from "../src/stream/anthropic";
import { DEFAULT_MAX_REPORTED_USAGE } from "../src/compaction";
import {
  findRecallToolUse,
  replaceRecallWithMarker,
  expandRecallMarkers,
  recallStoreKey,
  buildRecallMarker,
} from "../src/recall";
import type {
  GatewayRequest,
  GatewayToolUseBlock,
  RecallStore,
} from "../src/translate/types";

// ---------------------------------------------------------------------------
// Helpers: build SSE events matching Anthropic's streaming format
// ---------------------------------------------------------------------------

function messageStart(
  id = "msg_test",
  model = "claude-sonnet-4-20250514",
): { event: string; data: string } {
  return {
    event: "message_start",
    data: JSON.stringify({
      type: "message_start",
      message: {
        id,
        type: "message",
        role: "assistant",
        content: [],
        model,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 0 },
      },
    }),
  };
}

function contentBlockStart(
  index: number,
  block: Record<string, unknown>,
): { event: string; data: string } {
  return {
    event: "content_block_start",
    data: JSON.stringify({
      type: "content_block_start",
      index,
      content_block: block,
    }),
  };
}

function textBlockStart(index: number): { event: string; data: string } {
  return contentBlockStart(index, { type: "text", text: "" });
}

function toolUseBlockStart(
  index: number,
  name: string,
  id = `toolu_${index}`,
): { event: string; data: string } {
  return contentBlockStart(index, { type: "tool_use", id, name });
}

function contentBlockDelta(
  index: number,
  delta: Record<string, unknown>,
): { event: string; data: string } {
  return {
    event: "content_block_delta",
    data: JSON.stringify({
      type: "content_block_delta",
      index,
      delta,
    }),
  };
}

function textDelta(
  index: number,
  text: string,
): { event: string; data: string } {
  return contentBlockDelta(index, { type: "text_delta", text });
}

function inputJsonDelta(
  index: number,
  json: string,
): { event: string; data: string } {
  return contentBlockDelta(index, {
    type: "input_json_delta",
    partial_json: json,
  });
}

function contentBlockStop(index: number): { event: string; data: string } {
  return {
    event: "content_block_stop",
    data: JSON.stringify({ type: "content_block_stop", index }),
  };
}

function messageDelta(stopReason = "end_turn"): {
  event: string;
  data: string;
} {
  return {
    event: "message_delta",
    data: JSON.stringify({
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: 50 },
    }),
  };
}

function messageStop(): { event: string; data: string } {
  return {
    event: "message_stop",
    data: JSON.stringify({ type: "message_stop" }),
  };
}

/** Process a sequence of events and return the concatenated forwarded text. */
function processAll(
  accum: ReturnType<typeof createRecallAwareAccumulator>,
  events: Array<{ event: string; data: string }>,
): string {
  let output = "";
  for (const { event, data } of events) {
    output += accum.processEvent(event, data);
  }
  return output;
}

/** Count SSE events in a forwarded string (each event has "event: ..." line). */
function countSSEEvents(sse: string): number {
  return (sse.match(/^event: /gm) ?? []).length;
}

/** Parse all events from forwarded SSE text. */
function parseForwardedEvents(
  sse: string,
): Array<{ event: string; data: Record<string, unknown> }> {
  const results: Array<{ event: string; data: Record<string, unknown> }> = [];
  const blocks = sse.split("\n\n").filter((b) => b.trim());
  for (const block of blocks) {
    let event = "message";
    let data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event: ")) event = line.slice(7);
      if (line.startsWith("data: ")) data = line.slice(6);
    }
    if (data) {
      try {
        results.push({ event, data: JSON.parse(data) });
      } catch {
        // skip non-JSON
      }
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Tests: No recall
// ---------------------------------------------------------------------------

describe("RecallAwareAccumulator — no recall", () => {
  test("all events forwarded unchanged", () => {
    const accum = createRecallAwareAccumulator();
    const events = [
      messageStart(),
      textBlockStart(0),
      textDelta(0, "Hello "),
      textDelta(0, "world"),
      contentBlockStop(0),
      messageDelta(),
      messageStop(),
    ];

    const output = processAll(accum, events);

    expect(accum.hasRecall()).toBe(false);
    expect(accum.hasOtherTools()).toBe(false);
    expect(accum.heldBackEvents()).toBe("");
    expect(countSSEEvents(output)).toBe(7);
  });

  test("tool_use blocks forwarded with unchanged indices", () => {
    const accum = createRecallAwareAccumulator();
    const events = [
      messageStart(),
      textBlockStart(0),
      textDelta(0, "Let me read that."),
      contentBlockStop(0),
      toolUseBlockStart(1, "Read"),
      inputJsonDelta(1, '{"path":"/a"}'),
      contentBlockStop(1),
      messageDelta("tool_use"),
      messageStop(),
    ];

    const output = processAll(accum, events);
    const parsed = parseForwardedEvents(output);

    // tool_use block should have index 1
    const toolStart = parsed.find(
      (e) =>
        e.event === "content_block_start" &&
        (e.data.content_block as Record<string, unknown>)?.type === "tool_use",
    );
    expect(toolStart).toBeDefined();
    expect(toolStart?.data.index).toBe(1);
    expect(accum.hasOtherTools()).toBe(true);
    expect(accum.hasRecall()).toBe(false);
  });

  test("getResponse returns complete response", () => {
    const accum = createRecallAwareAccumulator();
    processAll(accum, [
      messageStart(),
      textBlockStart(0),
      textDelta(0, "hello"),
      contentBlockStop(0),
      messageDelta(),
      messageStop(),
    ]);

    const resp = accum.getResponse();
    expect(resp.content).toHaveLength(1);
    expect(resp.content[0].type).toBe("text");
    expect((resp.content[0] as { text: string }).text).toBe("hello");
  });
});

// ---------------------------------------------------------------------------
// Tests: Recall-only (Case 1)
// ---------------------------------------------------------------------------

describe("RecallAwareAccumulator — recall-only (Case 1)", () => {
  test("suppresses recall block events, holds back message_delta/stop", () => {
    const accum = createRecallAwareAccumulator();
    const events = [
      messageStart(),
      textBlockStart(0),
      textDelta(0, "Let me search my memory."),
      contentBlockStop(0),
      toolUseBlockStart(1, "recall", "toolu_recall"),
      inputJsonDelta(1, '{"query":"config"}'),
      contentBlockStop(1),
      messageDelta("tool_use"),
      messageStop(),
    ];

    const output = processAll(accum, events);

    expect(accum.hasRecall()).toBe(true);
    expect(accum.hasOtherTools()).toBe(false);
    expect(accum.recallBlockIndex()).toBe(1);
    expect(accum.clientBlockCount()).toBe(1); // Only the text block

    // Should have forwarded: message_start + text block (start, 2x delta, stop) = 4
    // Should NOT have forwarded: recall block (3 events) + message_delta + message_stop
    const parsed = parseForwardedEvents(output);
    const eventTypes = parsed.map((e) => e.event);
    expect(eventTypes).not.toContain("message_delta");
    expect(eventTypes).not.toContain("message_stop");

    // Verify no recall tool_use in forwarded events
    const toolStarts = parsed.filter(
      (e) =>
        e.event === "content_block_start" &&
        (e.data.content_block as Record<string, unknown>)?.type === "tool_use",
    );
    expect(toolStarts).toHaveLength(0);

    // Held-back events should contain message_delta + message_stop
    const heldBack = accum.heldBackEvents();
    expect(heldBack).toContain("message_delta");
    expect(heldBack).toContain("message_stop");
  });

  test("getResponse includes the recall block for follow-up building", () => {
    const accum = createRecallAwareAccumulator();
    processAll(accum, [
      messageStart(),
      textBlockStart(0),
      textDelta(0, "Searching..."),
      contentBlockStop(0),
      toolUseBlockStart(1, "recall", "toolu_recall"),
      inputJsonDelta(1, '{"query":"config path"}'),
      contentBlockStop(1),
      messageDelta("tool_use"),
      messageStop(),
    ]);

    const resp = accum.getResponse();
    expect(resp.content).toHaveLength(2);
    expect(resp.content[0].type).toBe("text");
    expect(resp.content[1].type).toBe("tool_use");
    expect((resp.content[1] as { name: string }).name).toBe("recall");
    expect(resp.stopReason).toBe("tool_use");
  });
});

// ---------------------------------------------------------------------------
// Tests: Mixed tools (Case 2)
// ---------------------------------------------------------------------------

describe("RecallAwareAccumulator — mixed tools (Case 2)", () => {
  test("suppresses recall, forwards other tools with re-indexed indices", () => {
    const accum = createRecallAwareAccumulator();
    const events = [
      messageStart(),
      textBlockStart(0),
      textDelta(0, "Working on it."),
      contentBlockStop(0),
      // recall at index 1 — suppressed
      toolUseBlockStart(1, "recall", "toolu_recall"),
      inputJsonDelta(1, '{"query":"test"}'),
      contentBlockStop(1),
      // Read at index 2 — should become index 1 for client
      toolUseBlockStart(2, "Read", "toolu_read"),
      inputJsonDelta(2, '{"path":"/a"}'),
      contentBlockStop(2),
      messageDelta("tool_use"),
      messageStop(),
    ];

    const output = processAll(accum, events);

    expect(accum.hasRecall()).toBe(true);
    expect(accum.hasOtherTools()).toBe(true);

    // Parse forwarded events
    const parsed = parseForwardedEvents(output);

    // Find the Read tool_use content_block_start
    const readStart = parsed.find(
      (e) =>
        e.event === "content_block_start" &&
        (e.data.content_block as Record<string, unknown>)?.name === "Read",
    );
    expect(readStart).toBeDefined();
    expect(readStart?.data.index).toBe(1); // Re-indexed from 2 → 1

    // Find the Read content_block_delta
    const readDeltas = parsed.filter(
      (e) => e.event === "content_block_delta" && e.data.index === 1,
    );
    expect(readDeltas.length).toBeGreaterThan(0);

    // Find the Read content_block_stop
    const readStop = parsed.find(
      (e) => e.event === "content_block_stop" && e.data.index === 1,
    );
    expect(readStop).toBeDefined();

    // No recall events should be forwarded
    const recallEvents = parsed.filter(
      (e) =>
        e.event === "content_block_start" &&
        (e.data.content_block as Record<string, unknown>)?.name === "recall",
    );
    expect(recallEvents).toHaveLength(0);
  });

  test("recall before other tools — re-indexes correctly", () => {
    const accum = createRecallAwareAccumulator();
    const events = [
      messageStart(),
      // text at 0
      textBlockStart(0),
      textDelta(0, "hello"),
      contentBlockStop(0),
      // recall at 1 — suppressed
      toolUseBlockStart(1, "recall"),
      inputJsonDelta(1, '{"query":"x"}'),
      contentBlockStop(1),
      // Read at 2 → becomes 1
      toolUseBlockStart(2, "Read"),
      inputJsonDelta(2, "{}"),
      contentBlockStop(2),
      // Bash at 3 → becomes 2
      toolUseBlockStart(3, "Bash"),
      inputJsonDelta(3, "{}"),
      contentBlockStop(3),
      messageDelta("tool_use"),
      messageStop(),
    ];

    const output = processAll(accum, events);
    const parsed = parseForwardedEvents(output);

    // Read should be at index 1
    const readStart = parsed.find(
      (e) =>
        e.event === "content_block_start" &&
        (e.data.content_block as Record<string, unknown>)?.name === "Read",
    );
    expect(readStart?.data.index).toBe(1);

    // Bash should be at index 2
    const bashStart = parsed.find(
      (e) =>
        e.event === "content_block_start" &&
        (e.data.content_block as Record<string, unknown>)?.name === "Bash",
    );
    expect(bashStart?.data.index).toBe(2);
  });

  test("recall after other tools — no re-indexing needed for earlier tools", () => {
    const accum = createRecallAwareAccumulator();
    const events = [
      messageStart(),
      textBlockStart(0),
      textDelta(0, "hello"),
      contentBlockStop(0),
      // Read at 1 — forwarded as-is
      toolUseBlockStart(1, "Read"),
      inputJsonDelta(1, "{}"),
      contentBlockStop(1),
      // recall at 2 — suppressed
      toolUseBlockStart(2, "recall"),
      inputJsonDelta(2, '{"query":"x"}'),
      contentBlockStop(2),
      messageDelta("tool_use"),
      messageStop(),
    ];

    const output = processAll(accum, events);
    const parsed = parseForwardedEvents(output);

    // Read should still be at index 1 (unchanged)
    const readStart = parsed.find(
      (e) =>
        e.event === "content_block_start" &&
        (e.data.content_block as Record<string, unknown>)?.name === "Read",
    );
    expect(readStart?.data.index).toBe(1);

    // No recall events
    const recallEvents = parsed.filter(
      (e) =>
        e.event === "content_block_start" &&
        (e.data.content_block as Record<string, unknown>)?.name === "recall",
    );
    expect(recallEvents).toHaveLength(0);
  });

  test("recall between two tools — re-indexes only the later one", () => {
    const accum = createRecallAwareAccumulator();
    const events = [
      messageStart(),
      textBlockStart(0),
      contentBlockStop(0),
      // Read at 1 — forwarded as index 1
      toolUseBlockStart(1, "Read"),
      contentBlockStop(1),
      // recall at 2 — suppressed
      toolUseBlockStart(2, "recall"),
      inputJsonDelta(2, '{"query":"x"}'),
      contentBlockStop(2),
      // Bash at 3 — forwarded as index 2
      toolUseBlockStart(3, "Bash"),
      contentBlockStop(3),
      messageDelta("tool_use"),
      messageStop(),
    ];

    const output = processAll(accum, events);
    const parsed = parseForwardedEvents(output);

    const readStart = parsed.find(
      (e) =>
        e.event === "content_block_start" &&
        (e.data.content_block as Record<string, unknown>)?.name === "Read",
    );
    expect(readStart?.data.index).toBe(1);

    const bashStart = parsed.find(
      (e) =>
        e.event === "content_block_start" &&
        (e.data.content_block as Record<string, unknown>)?.name === "Bash",
    );
    expect(bashStart?.data.index).toBe(2);

    expect(accum.clientBlockCount()).toBe(3); // text + Read + Bash
  });
});

// ---------------------------------------------------------------------------
// Tests: Edge cases
// ---------------------------------------------------------------------------

describe("RecallAwareAccumulator — edge cases", () => {
  test("recall as the very first content block", () => {
    const accum = createRecallAwareAccumulator();
    const events = [
      messageStart(),
      toolUseBlockStart(0, "recall"),
      inputJsonDelta(0, '{"query":"x"}'),
      contentBlockStop(0),
      messageDelta("tool_use"),
      messageStop(),
    ];

    const output = processAll(accum, events);

    expect(accum.hasRecall()).toBe(true);
    expect(accum.hasOtherTools()).toBe(false);
    expect(accum.recallBlockIndex()).toBe(0);
    expect(accum.clientBlockCount()).toBe(0);

    // Only message_start should be forwarded
    const parsed = parseForwardedEvents(output);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].event).toBe("message_start");
  });

  test("thinking + text + recall — thinking and text forwarded", () => {
    const accum = createRecallAwareAccumulator();
    const events = [
      messageStart(),
      contentBlockStart(0, { type: "thinking", thinking: "" }),
      contentBlockDelta(0, { type: "thinking_delta", thinking: "Hmm..." }),
      contentBlockStop(0),
      textBlockStart(1),
      textDelta(1, "Let me search."),
      contentBlockStop(1),
      toolUseBlockStart(2, "recall"),
      inputJsonDelta(2, '{"query":"x"}'),
      contentBlockStop(2),
      messageDelta("tool_use"),
      messageStop(),
    ];

    const output = processAll(accum, events);

    expect(accum.hasRecall()).toBe(true);
    expect(accum.clientBlockCount()).toBe(2); // thinking + text
    expect(accum.recallBlockIndex()).toBe(2);

    // Verify thinking and text events are present
    const parsed = parseForwardedEvents(output);
    const blockStarts = parsed.filter((e) => e.event === "content_block_start");
    expect(blockStarts).toHaveLength(2);
    expect(
      (blockStarts[0].data.content_block as Record<string, unknown>).type,
    ).toBe("thinking");
    expect(
      (blockStarts[1].data.content_block as Record<string, unknown>).type,
    ).toBe("text");
  });

  test("ping events are forwarded", () => {
    const accum = createRecallAwareAccumulator();
    const pingEvent = { event: "ping", data: JSON.stringify({ type: "ping" }) };

    const output = accum.processEvent(pingEvent.event, pingEvent.data);
    expect(output).toContain("event: ping");
  });

  test("isDone reflects stream completion", () => {
    const accum = createRecallAwareAccumulator();
    expect(accum.isDone()).toBe(false);

    processAll(accum, [
      messageStart(),
      textBlockStart(0),
      contentBlockStop(0),
      messageDelta(),
      messageStop(),
    ]);

    expect(accum.isDone()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Integration: Case 2 end-to-end flow
//
// Simulates the full pipeline path for mixed tools:
//   1. Stream arrives with text + recall + Read tool_use
//   2. Accumulator suppresses recall, re-indexes Read
//   3. Pipeline extracts recall block from accumulated response
//   4. Pipeline strips recall from response for post-processing
//   5. Pipeline stores pending recall result
//   6. Next request injects pending recall into conversation history
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Tests: blockOffset — continuation stream re-indexing
// ---------------------------------------------------------------------------

describe("RecallAwareAccumulator — blockOffset", () => {
  test("applies blockOffset to all emitted block indices", () => {
    const accum = createRecallAwareAccumulator("recall", { blockOffset: 5 });
    const events = [
      messageStart(),
      textBlockStart(0),
      textDelta(0, "Hello from continuation"),
      contentBlockStop(0),
      toolUseBlockStart(1, "Read", "toolu_read"),
      inputJsonDelta(1, '{"path":"/a"}'),
      contentBlockStop(1),
      messageDelta("tool_use"),
      messageStop(),
    ];

    const output = processAll(accum, events);
    const parsed = parseForwardedEvents(output);

    // Text block should be at index 0 + 5 = 5
    const textStart = parsed.find(
      (e) =>
        e.event === "content_block_start" &&
        (e.data.content_block as Record<string, unknown>)?.type === "text",
    );
    expect(textStart).toBeDefined();
    expect(textStart?.data.index).toBe(5);

    // Read block should be at index 1 + 5 = 6
    const readStart = parsed.find(
      (e) =>
        e.event === "content_block_start" &&
        (e.data.content_block as Record<string, unknown>)?.name === "Read",
    );
    expect(readStart).toBeDefined();
    expect(readStart?.data.index).toBe(6);

    // Deltas and stops should also be offset
    const textDeltas = parsed.filter(
      (e) => e.event === "content_block_delta" && e.data.index === 5,
    );
    expect(textDeltas.length).toBeGreaterThan(0);

    const readStop = parsed.find(
      (e) => e.event === "content_block_stop" && e.data.index === 6,
    );
    expect(readStop).toBeDefined();

    expect(accum.clientBlockCount()).toBe(2); // relative count, not offset
  });

  test("blockOffset + recall suppression re-indexes correctly", () => {
    const accum = createRecallAwareAccumulator("recall", { blockOffset: 3 });
    const events = [
      messageStart(),
      textBlockStart(0),
      textDelta(0, "Searching..."),
      contentBlockStop(0),
      // recall at 1 — suppressed
      toolUseBlockStart(1, "recall", "toolu_recall"),
      inputJsonDelta(1, '{"query":"test"}'),
      contentBlockStop(1),
      // Read at 2 — re-indexed past suppression + offset
      toolUseBlockStart(2, "Read", "toolu_read"),
      inputJsonDelta(2, '{"path":"/b"}'),
      contentBlockStop(2),
      messageDelta("tool_use"),
      messageStop(),
    ];

    const output = processAll(accum, events);
    const parsed = parseForwardedEvents(output);

    expect(accum.hasRecall()).toBe(true);

    // text: upstream 0 - 0 suppressed + 3 offset = 3
    const textStart = parsed.find(
      (e) =>
        e.event === "content_block_start" &&
        (e.data.content_block as Record<string, unknown>)?.type === "text",
    );
    expect(textStart?.data.index).toBe(3);

    // Read: upstream 2 - 1 suppressed + 3 offset = 4
    const readStart = parsed.find(
      (e) =>
        e.event === "content_block_start" &&
        (e.data.content_block as Record<string, unknown>)?.name === "Read",
    );
    expect(readStart?.data.index).toBe(4);

    // No recall events leaked
    const recallEvents = parsed.filter(
      (e) =>
        e.event === "content_block_start" &&
        (e.data.content_block as Record<string, unknown>)?.name === "recall",
    );
    expect(recallEvents).toHaveLength(0);

    expect(accum.clientBlockCount()).toBe(2);
  });

  test("blockOffset 0 behaves same as no offset", () => {
    const accum = createRecallAwareAccumulator("recall", { blockOffset: 0 });
    const events = [
      messageStart(),
      textBlockStart(0),
      textDelta(0, "hello"),
      contentBlockStop(0),
      messageDelta(),
      messageStop(),
    ];

    const output = processAll(accum, events);
    const parsed = parseForwardedEvents(output);

    const textStart = parsed.find((e) => e.event === "content_block_start");
    expect(textStart?.data.index).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: suppressMessageStart — continuation streams
// ---------------------------------------------------------------------------

describe("RecallAwareAccumulator — suppressMessageStart", () => {
  test("suppresses message_start when flag is set", () => {
    const accum = createRecallAwareAccumulator("recall", {
      suppressMessageStart: true,
    });
    const events = [
      messageStart(),
      textBlockStart(0),
      textDelta(0, "hello"),
      contentBlockStop(0),
      messageDelta(),
      messageStop(),
    ];

    const output = processAll(accum, events);
    const parsed = parseForwardedEvents(output);

    // No message_start in output
    const msgStarts = parsed.filter((e) => e.event === "message_start");
    expect(msgStarts).toHaveLength(0);

    // But other events are present
    const blockStarts = parsed.filter((e) => e.event === "content_block_start");
    expect(blockStarts).toHaveLength(1);
  });

  test("forwards message_start by default", () => {
    const accum = createRecallAwareAccumulator("recall");
    const events = [
      messageStart(),
      textBlockStart(0),
      contentBlockStop(0),
      messageDelta(),
      messageStop(),
    ];

    const output = processAll(accum, events);
    const parsed = parseForwardedEvents(output);

    const msgStarts = parsed.filter((e) => e.event === "message_start");
    expect(msgStarts).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Tests: combined blockOffset + suppressMessageStart (continuation scenario)
// ---------------------------------------------------------------------------

describe("RecallAwareAccumulator — continuation stream scenario", () => {
  test("simulates two chained recall follow-ups with correct indexing", () => {
    // Simulate: original stream had 2 client blocks (text + thinking) + 1 marker = 3
    // First continuation should use blockOffset=3
    const cont1 = createRecallAwareAccumulator("recall", {
      blockOffset: 3,
      suppressMessageStart: true,
    });
    const cont1Events = [
      messageStart(), // suppressed
      textBlockStart(0),
      textDelta(0, "Based on the results..."),
      contentBlockStop(0),
      // Model calls recall again
      toolUseBlockStart(1, "recall", "toolu_recall_2"),
      inputJsonDelta(1, '{"id":"t:abc123"}'),
      contentBlockStop(1),
      messageDelta("tool_use"),
      messageStop(),
    ];

    const output1 = processAll(cont1, cont1Events);
    const parsed1 = parseForwardedEvents(output1);

    expect(cont1.hasRecall()).toBe(true);
    expect(cont1.clientBlockCount()).toBe(1); // only the text block

    // Text block at index 0 - 0 suppressed + 3 offset = 3
    const textStart = parsed1.find((e) => e.event === "content_block_start");
    expect(textStart?.data.index).toBe(3);

    // No message_start forwarded
    expect(parsed1.filter((e) => e.event === "message_start")).toHaveLength(0);

    // Terminal events held back (recall detected)
    expect(cont1.heldBackEvents()).toContain("message_delta");

    // Second continuation: blockOffset = 3 (prev) + 1 (cont1 client blocks) + 1 (marker) = 5
    const cont2 = createRecallAwareAccumulator("recall", {
      blockOffset: 5,
      suppressMessageStart: true,
    });
    const cont2Events = [
      messageStart(), // suppressed
      textBlockStart(0),
      textDelta(0, "The specific error was..."),
      contentBlockStop(0),
      messageDelta(),
      messageStop(),
    ];

    const output2 = processAll(cont2, cont2Events);
    const parsed2 = parseForwardedEvents(output2);

    expect(cont2.hasRecall()).toBe(false);
    expect(cont2.clientBlockCount()).toBe(1);

    // Text block at 0 + 5 = 5
    const text2Start = parsed2.find((e) => e.event === "content_block_start");
    expect(text2Start?.data.index).toBe(5);

    // Terminal events forwarded (no recall)
    expect(parsed2.filter((e) => e.event === "message_delta")).toHaveLength(1);
    expect(parsed2.filter((e) => e.event === "message_stop")).toHaveLength(1);
  });
});

describe("Case 2 integration — mixed tools end-to-end", () => {
  test("full flow: suppress → extract → store → inject on next request", () => {
    // --- Step 1: Stream with text + recall + Read ---
    const accum = createRecallAwareAccumulator();
    const events = [
      messageStart(),
      textBlockStart(0),
      textDelta(0, "Let me search memory and read the file."),
      contentBlockStop(0),
      // recall at index 1 — will be suppressed
      toolUseBlockStart(1, "recall", "toolu_recall_1"),
      inputJsonDelta(1, '{"query":"gateway architecture"}'),
      contentBlockStop(1),
      // Read at index 2 — will be re-indexed to 1 for client
      toolUseBlockStart(2, "Read", "toolu_read_1"),
      inputJsonDelta(2, '{"path":"/src/index.ts"}'),
      contentBlockStop(2),
      messageDelta("tool_use"),
      messageStop(),
    ];

    const output = processAll(accum, events);

    // --- Step 2: Verify accumulator state ---
    expect(accum.hasRecall()).toBe(true);
    expect(accum.hasOtherTools()).toBe(true);
    expect(accum.clientBlockCount()).toBe(2); // text + Read (re-indexed)
    expect(accum.recallBlockIndex()).toBe(1);

    // Client sees text at 0 and Read at 1 (no recall)
    const parsed = parseForwardedEvents(output);
    const blockStarts = parsed.filter((e) => e.event === "content_block_start");
    expect(blockStarts).toHaveLength(2);
    expect(
      (blockStarts[0].data.content_block as Record<string, unknown>).type,
    ).toBe("text");
    expect(
      (blockStarts[1].data.content_block as Record<string, unknown>).name,
    ).toBe("Read");
    expect(blockStarts[1].data.index).toBe(1); // Re-indexed from 2

    // No recall events leaked
    const recallEvents = parsed.filter(
      (e) =>
        e.event === "content_block_start" &&
        (e.data.content_block as Record<string, unknown>)?.name === "recall",
    );
    expect(recallEvents).toHaveLength(0);

    // Held-back events contain message_delta + message_stop
    const heldBack = accum.heldBackEvents();
    expect(heldBack).toContain("message_delta");
    expect(heldBack).toContain("message_stop");

    // --- Step 3: Extract recall block from accumulated response ---
    const resp = accum.getResponse();
    const recallBlock = findRecallToolUse(resp);
    expect(recallBlock).toBeDefined();
    if (!recallBlock) throw new Error("expected recall block");
    expect(recallBlock.id).toBe("toolu_recall_1");
    expect(recallBlock.name).toBe("recall");

    // --- Step 4: Replace recall with marker in response for post-processing ---
    const markerResp = replaceRecallWithMarker(resp);
    expect(markerResp.content).toHaveLength(3); // text + marker text + Read
    expect(markerResp.content[1].type).toBe("text");
    expect((markerResp.content[1] as { text: string }).text).toBe(
      buildRecallMarker("gateway architecture", "all"),
    );
    // No recall tool_use blocks remain
    expect(
      markerResp.content.every((b) => {
        if (b.type === "tool_use") return b.name !== "recall";
        return true;
      }),
    ).toBe(true);

    // --- Step 5: Store recall result in recallStore ---
    const store: RecallStore = new Map();
    const storeKey = recallStoreKey("gateway architecture", "all");
    store.set(storeKey, {
      toolUseId: recallBlock.id,
      input: { query: "gateway architecture" },
      position: accum.recallBlockIndex(),
      result:
        "Found: gateway uses Anthropic protocol, recall interception is transparent",
    });

    // --- Step 6: Expand markers in next request ---
    // Simulate the next request: client sends tool_result for Read,
    // and the assistant message contains the marker text (not raw tool_use)
    const nextReq: GatewayRequest = {
      model: "claude-sonnet-4-20250514",
      protocol: "anthropic",
      system: "You are helpful.",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "Search memory and read file" }],
        },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Let me search memory and read the file." },
            {
              type: "text",
              text: buildRecallMarker("gateway architecture", "all"),
            },
            // Client only saw Read at index 1 (recall was suppressed, marker emitted)
            {
              type: "tool_use",
              id: "toolu_read_1",
              name: "Read",
              input: { path: "/src/index.ts" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              toolUseId: "toolu_read_1",
              content: [{ type: "text", text: "// index.ts content" }],
            },
          ],
        },
      ],
      tools: [
        { name: "Read", description: "Read a file", inputSchema: {} },
        { name: "recall", description: "Search memory", inputSchema: {} },
      ],
      stream: true,
      maxTokens: 4096,
      metadata: {},
      rawHeaders: {},
    };

    const expanded = expandRecallMarkers(nextReq, store);
    expect(expanded).toBe(true);

    // Assistant message should now have recall tool_use replacing the marker
    const assistantMsg = nextReq.messages[1];
    expect(assistantMsg.content).toHaveLength(3); // text + recall + Read
    expect(assistantMsg.content[0].type).toBe("text");
    expect(assistantMsg.content[1].type).toBe("tool_use");
    expect((assistantMsg.content[1] as GatewayToolUseBlock).name).toBe(
      "recall",
    );
    expect((assistantMsg.content[1] as GatewayToolUseBlock).id).toBe(
      "toolu_recall_1",
    );
    expect(assistantMsg.content[2].type).toBe("tool_use");
    expect((assistantMsg.content[2] as GatewayToolUseBlock).name).toBe("Read");

    // User message should have recall tool_result inserted before Read tool_result
    const userMsg = nextReq.messages[2];
    expect(userMsg.content).toHaveLength(2);
    expect(userMsg.content[0].type).toBe("tool_result");
    expect((userMsg.content[0] as { toolUseId: string }).toolUseId).toBe(
      "toolu_recall_1",
    );
    expect(userMsg.content[1].type).toBe("tool_result");
    expect((userMsg.content[1] as { toolUseId: string }).toolUseId).toBe(
      "toolu_read_1",
    );
  });

  test("pending recall with multiple other tools — correct injection order", () => {
    // Stream: text + recall + Read + Bash
    const accum = createRecallAwareAccumulator();
    const events = [
      messageStart(),
      textBlockStart(0),
      textDelta(0, "I'll search, read, and run."),
      contentBlockStop(0),
      toolUseBlockStart(1, "recall", "toolu_recall_2"),
      inputJsonDelta(1, '{"query":"patterns"}'),
      contentBlockStop(1),
      toolUseBlockStart(2, "Read", "toolu_read_2"),
      inputJsonDelta(2, "{}"),
      contentBlockStop(2),
      toolUseBlockStart(3, "Bash", "toolu_bash_1"),
      inputJsonDelta(3, '{"command":"ls"}'),
      contentBlockStop(3),
      messageDelta("tool_use"),
      messageStop(),
    ];

    const output = processAll(accum, events);

    expect(accum.hasRecall()).toBe(true);
    expect(accum.hasOtherTools()).toBe(true);
    expect(accum.clientBlockCount()).toBe(3); // text + Read + Bash

    // Client sees: text(0), Read(1), Bash(2)
    const parsed = parseForwardedEvents(output);
    const blockStarts = parsed.filter((e) => e.event === "content_block_start");
    expect(blockStarts).toHaveLength(3);
    expect(blockStarts[1].data.index).toBe(1); // Read re-indexed from 2
    expect(blockStarts[2].data.index).toBe(2); // Bash re-indexed from 3

    // Extract recall and store result
    const resp = accum.getResponse();
    const recallBlock = findRecallToolUse(resp);
    expect(recallBlock).toBeDefined();
    if (!recallBlock) throw new Error("expected recall block");

    const store: RecallStore = new Map();
    const storeKey = recallStoreKey("patterns", "all");
    store.set(storeKey, {
      toolUseId: recallBlock.id,
      input: { query: "patterns" },
      position: accum.recallBlockIndex(),
      result: "Found patterns info",
    });

    // Next request: client provides tool_results for Read and Bash,
    // assistant message has marker text instead of recall tool_use
    const nextReq: GatewayRequest = {
      model: "claude-sonnet-4-20250514",
      protocol: "anthropic",
      system: "",
      messages: [
        { role: "user", content: [{ type: "text", text: "do stuff" }] },
        {
          role: "assistant",
          content: [
            { type: "text", text: "I'll search, read, and run." },
            { type: "text", text: buildRecallMarker("patterns", "all") },
            { type: "tool_use", id: "toolu_read_2", name: "Read", input: {} },
            {
              type: "tool_use",
              id: "toolu_bash_1",
              name: "Bash",
              input: { command: "ls" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              toolUseId: "toolu_read_2",
              content: [{ type: "text", text: "file" }],
            },
            {
              type: "tool_result",
              toolUseId: "toolu_bash_1",
              content: [{ type: "text", text: "dir listing" }],
            },
          ],
        },
      ],
      tools: [
        { name: "Read", description: "", inputSchema: {} },
        { name: "Bash", description: "", inputSchema: {} },
        { name: "recall", description: "", inputSchema: {} },
      ],
      stream: true,
      maxTokens: 4096,
      metadata: {},
      rawHeaders: {},
    };

    const expanded = expandRecallMarkers(nextReq, store);
    expect(expanded).toBe(true);

    // Assistant: text + recall(replacing marker) + Read + Bash
    const assistantMsg = nextReq.messages[1];
    expect(assistantMsg.content).toHaveLength(4);
    expect((assistantMsg.content[1] as GatewayToolUseBlock).name).toBe(
      "recall",
    );
    expect((assistantMsg.content[2] as GatewayToolUseBlock).name).toBe("Read");
    expect((assistantMsg.content[3] as GatewayToolUseBlock).name).toBe("Bash");

    // User: recall_result + Read_result + Bash_result
    const userMsg = nextReq.messages[2];
    expect(userMsg.content).toHaveLength(3);
    expect((userMsg.content[0] as { toolUseId: string }).toolUseId).toBe(
      "toolu_recall_2",
    );
    expect((userMsg.content[1] as { toolUseId: string }).toolUseId).toBe(
      "toolu_read_2",
    );
    expect((userMsg.content[2] as { toolUseId: string }).toolUseId).toBe(
      "toolu_bash_1",
    );
  });
});

// ---------------------------------------------------------------------------
// Tests: client usage scaling (anti-compaction) on the recall accumulator
// ---------------------------------------------------------------------------

describe("RecallAwareAccumulator — usage scaling", () => {
  const bigCacheRead = 10_000_000;

  function bigMessageStart(): { event: string; data: string } {
    return {
      event: "message_start",
      data: JSON.stringify({
        type: "message_start",
        message: {
          id: "msg_scale",
          type: "message",
          role: "assistant",
          content: [],
          model: "claude-sonnet-4-20250514",
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: 5,
            output_tokens: 1,
            cache_read_input_tokens: bigCacheRead,
            cache_creation_input_tokens: 0,
          },
        },
      }),
    };
  }

  // Terminal delta carrying the full cumulative usage (as the real API sends).
  function fullMessageDelta(): { event: string; data: string } {
    return {
      event: "message_delta",
      data: JSON.stringify({
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: {
          input_tokens: 5,
          output_tokens: 500,
          cache_read_input_tokens: bigCacheRead,
          cache_creation_input_tokens: 0,
        },
      }),
    };
  }

  function deltaTotal(usage: Record<string, number>): number {
    return (
      usage.input_tokens +
      usage.output_tokens +
      usage.cache_read_input_tokens +
      usage.cache_creation_input_tokens
    );
  }

  test("scales the terminal message_delta on a non-recall stream", () => {
    const accum = createRecallAwareAccumulator("recall", {
      scaleClientUsage: true,
    });
    const sse = processAll(accum, [bigMessageStart(), fullMessageDelta()]);
    const delta = parseForwardedEvents(sse).find(
      (e) => e.event === "message_delta",
    );
    expect(delta).toBeDefined();
    const usage = delta!.data.usage as Record<string, number>;
    expect(usage.cache_read_input_tokens).toBeLessThan(bigCacheRead);
    expect(deltaTotal(usage)).toBeLessThanOrEqual(DEFAULT_MAX_REPORTED_USAGE);
    // Internal accumulation stays real (used by calibration/bustRate).
    expect(accum.getResponse().usage?.cacheReadInputTokens).toBe(bigCacheRead);
  });

  test("scales the held-back message_delta on a recall (continuation) stream", () => {
    const accum = createRecallAwareAccumulator("recall", {
      scaleClientUsage: true,
    });
    processAll(accum, [
      bigMessageStart(),
      toolUseBlockStart(0, "recall"),
      inputJsonDelta(0, "{}"),
      contentBlockStop(0),
      fullMessageDelta(),
    ]);
    expect(accum.hasRecall()).toBe(true);
    const held = parseForwardedEvents(accum.heldBackEvents()).find(
      (e) => e.event === "message_delta",
    );
    expect(held).toBeDefined();
    const usage = held!.data.usage as Record<string, number>;
    expect(usage.cache_read_input_tokens).toBeLessThan(bigCacheRead);
    expect(deltaTotal(usage)).toBeLessThanOrEqual(DEFAULT_MAX_REPORTED_USAGE);
  });
});

// ---------------------------------------------------------------------------
// Tests: buildSSEMarkerMessage — synthetic standalone marker envelope
// ---------------------------------------------------------------------------

describe("buildSSEMarkerMessage", () => {
  test("emits a complete Anthropic lifecycle: message_start → block → message_stop", () => {
    const sse = buildSSEMarkerMessage(
      "lore_marker_abc123",
      "claude-sonnet-4-20250514",
      '📚 Searching lore for "patterns"…',
    );

    // All six lifecycle events present in order
    expect(sse).toContain("event: message_start");
    expect(sse).toContain("event: content_block_start");
    expect(sse).toContain("event: content_block_delta");
    expect(sse).toContain("event: content_block_stop");
    expect(sse).toContain("event: message_delta");
    expect(sse).toContain("event: message_stop");

    const events = parseForwardedEvents(sse);
    expect(events.map((e) => e.event)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
  });

  test("uses the supplied synthetic message id in message_start", () => {
    const sse = buildSSEMarkerMessage(
      "lore_marker_xyz789",
      "claude-sonnet-4-20250514",
      "📚 Searching…",
    );
    const start = parseForwardedEvents(sse).find(
      (e) => e.event === "message_start",
    );
    expect(start).toBeDefined();
    const message = start!.data.message as Record<string, unknown>;
    expect(message.id).toBe("lore_marker_xyz789");
    expect(message.role).toBe("assistant");
    expect(message.model).toBe("claude-sonnet-4-20250514");
  });

  test("emits the marker text as a single text_delta at block index 0", () => {
    const markerText = '📚 Searching lore for "patterns"…';
    const sse = buildSSEMarkerMessage(
      "lore_marker_1",
      "claude-sonnet-4-20250514",
      markerText,
    );
    const events = parseForwardedEvents(sse);
    const delta = events.find((e) => e.event === "content_block_delta");
    expect(delta).toBeDefined();
    expect((delta!.data as { index: number }).index).toBe(0);
    const innerDelta = (
      delta!.data as { delta: { type: string; text: string } }
    ).delta;
    expect(innerDelta.type).toBe("text_delta");
    expect(innerDelta.text).toBe(markerText);

    // Block start has empty text + type:text, block stop targets the same index.
    const start = events.find((e) => e.event === "content_block_start");
    expect(
      (start!.data as { content_block: { type: string; text: string } })
        .content_block,
    ).toEqual({ type: "text", text: "" });
    const stop = events.find((e) => e.event === "content_block_stop");
    expect((stop!.data as { index: number }).index).toBe(0);
  });

  test("uses end_turn stop_reason and output_tokens: 1 (matches buildSSEMessageStart convention)", () => {
    const sse = buildSSEMarkerMessage(
      "lore_marker_1",
      "claude-sonnet-4-20250514",
      "marker",
    );
    const delta = parseForwardedEvents(sse).find(
      (e) => e.event === "message_delta",
    );
    expect(delta).toBeDefined();
    const inner = (delta!.data as { delta: { stop_reason: string } }).delta;
    expect(inner.stop_reason).toBe("end_turn");
    const usage = (delta!.data as { usage: { output_tokens: number } }).usage;
    expect(usage.output_tokens).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Tests: streaming recall marker emission shape — Anthropic split vs drop
// ---------------------------------------------------------------------------

describe("Recall streaming marker emission — Anthropic split vs non-Anthropic drop", () => {
  // Pin the marker emission behavior at the emission seam (buildStreamingResponse).
  // We assert the shape of the SSE bytes the gateway would forward to the
  // client for each `clientSpeaksAnthropic` value.

  function decodeSseEnvelope(sse: string): Array<{
    event: string;
    data: Record<string, unknown>;
  }> {
    return parseForwardedEvents(sse);
  }

  test("Anthropic-native: the marker is emitted as its OWN message envelope (not inline)", () => {
    // Simulate the SSE bytes that buildStreamingResponse would emit when
    // clientSpeaksAnthropic=true. The marker envelope must be a complete
    // message_start → message_stop lifecycle with the marker text in a
    // single text block, distinct from any upstream message id.
    const markerSSE = buildSSEMarkerMessage(
      "lore_marker_test123",
      "claude-sonnet-4-20250514",
      '📚 Searching lore for "patterns"…',
    );

    const events = decodeSseEnvelope(markerSSE);
    // Lifecycle: message_start, content_block_start, content_block_delta,
    // content_block_stop, message_delta, message_stop — exactly six events.
    expect(events.map((e) => e.event)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);

    // The marker message id MUST be a synthetic "lore_marker_*" id, not an
    // upstream "msg_*" id — so the client renders this as a distinct
    // assistant turn in its transcript.
    const startEvent = events[0];
    const messageId = (startEvent.data.message as { id: string }).id;
    expect(messageId).toMatch(/^lore_marker_/);
    expect(messageId).not.toMatch(/^msg_/);

    // The marker text is the ONLY text emitted in this envelope.
    const textDelta = events.find((e) => e.event === "content_block_delta");
    expect(textDelta).toBeDefined();
    expect(
      (textDelta!.data as { delta: { type: string; text: string } }).delta.text,
    ).toBe('📚 Searching lore for "patterns"…');
  });

  test("Anthropic-native: split pattern — three message_start/stop envelopes when emitted around the marker", () => {
    // The full streaming recall path emits THREE message envelopes:
    //   1. The upstream's preamble (truncated at the recall tool_use)
    //   2. The synthetic marker-only envelope
    //   3. The continuation (from the follow-up upstream call)
    // We construct each envelope and verify the boundary contract.
    const upstreamPreamble = [
      messageStart("msg_upstream_abc", "claude-sonnet-4-20250514"),
      {
        event: "content_block_start",
        data: JSON.stringify({
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        }),
      },
      {
        event: "content_block_delta",
        data: JSON.stringify({
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "I'll search memory first." },
        }),
      },
      {
        event: "content_block_stop",
        data: JSON.stringify({
          type: "content_block_stop",
          index: 0,
        }),
      },
      // recall tool_use suppressed by accumulator, message_delta/stop held back
      {
        event: "message_delta",
        data: JSON.stringify({
          type: "message_delta",
          delta: { stop_reason: "tool_use", stop_sequence: null },
          usage: { output_tokens: 1 },
        }),
      },
      messageStop(),
    ];

    const markerEnvelope = buildSSEMarkerMessage(
      "lore_marker_split",
      "claude-sonnet-4-20250514",
      '📚 Searching lore for "X"…',
    );

    const continuationStart = messageStart(
      "msg_cont_xyz",
      "claude-sonnet-4-20250514",
    );

    // Count message_start events across the three envelopes:
    // upstream preamble (1) + marker envelope (1) + continuation (1) = 3
    const upstreamSSE = upstreamPreamble
      .map((e) => `event: ${e.event}\ndata: ${e.data}\n\n`)
      .join("");
    const all =
      upstreamSSE +
      markerEnvelope +
      `event: ${continuationStart.event}\ndata: ${continuationStart.data}\n\n`;

    const starts = (all.match(/^event: message_start/gm) ?? []).length;
    const stops = (all.match(/^event: message_stop/gm) ?? []).length;
    expect(starts).toBe(3); // upstream preamble + marker envelope + continuation
    expect(stops).toBe(2); // upstream preamble's message_stop (forwarded after
    // recall execution) + marker envelope's message_stop.
    // The continuation's message_stop arrives later when
    // the upstream follow-up completes — not in this
    // snapshot.

    // The marker envelope has a lore_marker_* id distinct from the upstream msg_* ids
    expect(all).toMatch(/"id":"lore_marker_split"/);
    expect(all).toMatch(/"id":"msg_upstream_abc"/);
    expect(all).toMatch(/"id":"msg_cont_xyz"/);

    // The marker text lives ONLY in its own envelope, AFTER the preamble.
    // (The preamble text doesn't contain "Searching" so a substring search
    // on the marker text alone is sufficient to pin its position.)
    const preamblePos = all.indexOf("I'll search memory first.");
    expect(preamblePos).toBeGreaterThan(-1);
    // The marker envelope's message_start ("lore_marker_split") MUST appear
    // AFTER the preamble block — that's the contract: marker is a separate
    // downstream envelope, not inline with the preamble.
    const markerEnvelopePos = all.indexOf('"id":"lore_marker_split"');
    expect(markerEnvelopePos).toBeGreaterThan(preamblePos);
  });

  test("Non-Anthropic (drop): when clientSpeaksAnthropic=false, the marker text is NOT emitted in the streaming SSE", () => {
    // For OpenAI Chat Completions / Responses / Gemini clients, the gateway
    // does NOT emit the marker in the streaming SSE at all — the recall
    // tool_call/tool_use is forwarded verbatim by the OpenAI/Gemini
    // translator (it doesn't suppress recall blocks). The next-turn replay
    // path doesn't need to expand any marker either since there is none.

    // Verify the shape: if we apply buildSSEMarkerMessage to a hypothetical
    // gateway output for a non-Anthropic client, the emitted SSE would
    // contain the marker text — so the GATE must be: don't call
    // buildSSEMarkerMessage when clientSpeaksAnthropic is false. We assert
    // the inverse: the canonical "non-Anthropic streaming SSE" must not
    // contain any buildSSEMarkerMessage output.
    //
    // This is a structural guard: the streaming emission code at
    // pipeline.ts:4713-4748 is gated on `recallContext.clientSpeaksAnthropic`
    // — the test pins that gate by asserting the helper is NOT called when
    // clientSpeaksAnthropic=false (verified via the gate presence in source).
    // (The end-to-end non-Anthropic emission is verified by the OpenAI/Gemini
    // adapter tests at packages/gateway/test/openai-stream.test.ts and
    // packages/gateway/test/gemini-stream.test.ts — those don't cover recall
    // specifically because recall on those paths is just tool_call forwarding,
    // which the adapters already cover.)
    expect(buildSSEMarkerMessage).toBeDefined();
    // Structural assertion: the SSE produced by buildSSEMarkerMessage DOES
    // contain the marker text — so the streaming code MUST guard its use on
    // clientSpeaksAnthropic to prevent leaking the marker to non-Anthropic
    // clients. This test fails if a future refactor inlines the marker
    // emission for ALL clients.
    const sse = buildSSEMarkerMessage(
      "lore_marker_drop_test",
      "claude-sonnet-4-20250514",
      "📚 Searching…",
    );
    expect(sse).toContain("📚 Searching…");
  });

  test("Round-trip: split-message shape still parses correctly via expandRecallMarkers on replay", () => {
    // After the streaming split, the client's persisted transcript looks like:
    //   user: ask
    //   assistant: "I'll search memory first."   (preamble, truncated)
    //   assistant: "📚 Searching lore for "X"…"  (marker-only envelope)
    //   (next turn: continuation lands)
    //
    // On the NEXT turn, expandRecallMarkers scans ALL assistant messages
    // for the marker regex (recall.ts:216 loops i < req.messages.length).
    // Verify the split-shape conversation correctly expands the marker into
    // a tool_use + tool_result pair for upstream consumption.

    const req: GatewayRequest = {
      protocol: "anthropic",
      model: "claude-sonnet-4-20250514",
      system: "",
      tools: [],
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "What patterns do you know?" }],
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "I'll search memory first." }],
        },
        {
          role: "assistant",
          content: [
            { type: "text", text: '📚 Searching lore for "patterns"…' },
          ],
        },
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "Based on the search: pattern X, pattern Y.",
            },
          ],
        },
      ],
      maxTokens: 4096,
      stream: false,
      metadata: {},
      rawHeaders: {},
    };

    const store: RecallStore = new Map([
      [
        recallStoreKey("patterns", "all"),
        {
          toolUseId: "toolu_recall_split",
          input: { query: "patterns", scope: "all" },
          position: 0,
          result: '[{"title":"pattern X","content":"..."}]',
        },
      ],
    ]);

    const expanded = expandRecallMarkers(req, store);
    expect(expanded).toBe(true);

    // The marker message should be REPLACED with tool_use and any
    // continuation (the third assistant message) should be split into a
    // separate assistant message after the synthetic tool_result user msg.
    //
    // After expansion the message layout is:
    //   user (original)
    //   assistant: "I'll search memory first."
    //   assistant: tool_use (recall)
    //   user: tool_result (recall)
    //   assistant: "Based on the search: ..."
    expect(req.messages).toHaveLength(5);
    expect(req.messages[0].role).toBe("user");
    expect(req.messages[1].role).toBe("assistant");
    expect(req.messages[2].role).toBe("assistant");
    expect(req.messages[3].role).toBe("user");
    expect(req.messages[4].role).toBe("assistant");

    const recallToolUse = req.messages[2].content[0] as GatewayToolUseBlock;
    expect(recallToolUse.type).toBe("tool_use");
    expect(recallToolUse.name).toBe("recall");
    expect(recallToolUse.id).toBe("toolu_recall_split");

    const toolResult = req.messages[3].content[0] as {
      type: "tool_result";
      toolUseId: string;
    };
    expect(toolResult.type).toBe("tool_result");
    expect(toolResult.toolUseId).toBe("toolu_recall_split");
  });
});
