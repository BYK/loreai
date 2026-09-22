/**
 * Unit tests for coalesceAdjacentAssistants (knowledge-delta pair injection,
 * PR #1315). The delta is injected as a user→assistant PAIR; in a mid-tool-loop
 * turn the tool-pair guard lands the injected assistant immediately before the
 * real assistant(thinking, tool_use), producing two adjacent assistants that a
 * strict-alternation upstream (Anthropic, 1:1 mapping) would reject. Coalescing
 * merges them — but must preserve the invariant that leading thinking /
 * redacted_thinking blocks stay FIRST (Anthropic 400s otherwise on every replay
 * turn of an extended-thinking tool loop).
 */
import { describe, test, expect } from "vitest";
import { coalesceAdjacentAssistants } from "../src/pipeline";
import {
  buildAnthropicRequest,
  parseAnthropicRequest,
} from "../src/translate/anthropic";
import type { GatewayMessage } from "../src/translate/types";

const asst = (content: GatewayMessage["content"]): GatewayMessage => ({
  role: "assistant",
  content,
});
const user = (text: string): GatewayMessage => ({
  role: "user",
  content: [{ type: "text", text }],
});

describe("coalesceAdjacentAssistants", () => {
  test("merges the injected pair's assistant into a plain (text-only) assistant", () => {
    const merged = coalesceAdjacentAssistants([
      user("prev"),
      asst([{ type: "text", text: "delta payload" }]),
      asst([
        { type: "text", text: "on it" },
        { type: "tool_use", id: "t1", name: "X", input: {} },
      ]),
    ]);
    expect(merged).toHaveLength(2); // user + one merged assistant
    expect(merged[1].content.map((b) => b.type)).toEqual([
      "text",
      "text",
      "tool_use",
    ]);
  });

  test("keeps a leading thinking block FIRST when merging (Anthropic invariant)", () => {
    const merged = coalesceAdjacentAssistants([
      asst([{ type: "text", text: "delta payload" }]),
      asst([
        { type: "thinking", thinking: "reasoning", signature: "sig" },
        { type: "tool_use", id: "t1", name: "X", input: {} },
      ]),
    ]);
    expect(merged).toHaveLength(1);
    const types = merged[0].content.map((b) => b.type);
    // thinking MUST remain at index 0; payload spliced after the reasoning run.
    expect(types).toEqual(["thinking", "text", "tool_use"]);
  });

  test("keeps a leading redacted_thinking (opaque) block FIRST when merging", () => {
    const merged = coalesceAdjacentAssistants([
      asst([{ type: "text", text: "delta payload" }]),
      asst([
        { type: "opaque", raw: { type: "redacted_thinking", data: "x" } },
        { type: "tool_use", id: "t1", name: "X", input: {} },
      ]),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].content.map((b) => b.type)).toEqual([
      "opaque",
      "text",
      "tool_use",
    ]);
  });

  test("preserves parsed redacted reasoning through Anthropic serialization", () => {
    const parsed = parseAnthropicRequest(
      {
        model: "claude-test",
        max_tokens: 1024,
        messages: [
          {
            role: "assistant",
            content: [
              { type: "redacted_thinking", data: "ciphertext" },
              {
                type: "tool_use",
                id: "tool-1",
                name: "read",
                input: {},
              },
            ],
          },
        ],
      },
      {},
    );
    const merged = coalesceAdjacentAssistants([
      asst([{ type: "text", text: "memory delta" }]),
      parsed.messages[0],
    ]);

    expect(merged[0].provenancePositions).toEqual([1, 2]);
    const built = buildAnthropicRequest(
      {
        protocol: "anthropic",
        model: "claude-test",
        system: "",
        messages: merged,
        tools: [],
        stream: false,
        maxTokens: 1024,
        metadata: {},
        rawHeaders: {},
      },
      {},
    );
    const body = built.body as {
      messages: Array<{ content: Array<Record<string, unknown>> }>;
    };
    expect(body.messages[0]?.content).toEqual([
      { type: "redacted_thinking", data: "ciphertext" },
      { type: "text", text: "memory delta" },
      {
        type: "tool_use",
        id: "tool-1",
        name: "read",
        input: {},
      },
    ]);
  });

  test("preserves multiple leading reasoning blocks in order", () => {
    const merged = coalesceAdjacentAssistants([
      asst([{ type: "text", text: "payload" }]),
      asst([
        { type: "thinking", thinking: "step 1", signature: "s1" },
        { type: "thinking", thinking: "step 2", signature: "s2" },
        { type: "text", text: "answer" },
      ]),
    ]);
    expect(merged[0].content.map((b) => b.type)).toEqual([
      "thinking",
      "thinking",
      "text",
      "text",
    ]);
  });

  test("offsets synthesized earlier positions after later provenance reasoning", () => {
    const laterReasoning: GatewayMessage["content"][number] = {
      type: "opaque",
      raw: { type: "redacted_thinking", data: "ciphertext" },
    };
    const laterTool: GatewayMessage["content"][number] = {
      type: "tool_use",
      id: "t2",
      name: "write",
      input: {},
    };
    const merged = coalesceAdjacentAssistants([
      asst([{ type: "text", text: "injected" }]),
      {
        role: "assistant",
        content: [laterTool],
        provenanceContent: [laterReasoning, laterTool],
        provenancePositions: [1],
      },
    ]);

    expect(merged[0].content).toEqual([
      { type: "text", text: "injected" },
      laterTool,
    ]);
    expect(merged[0].provenanceContent).toEqual([
      laterReasoning,
      { type: "text", text: "injected" },
      laterTool,
    ]);
    expect(merged[0].provenancePositions).toEqual([1, 2]);
  });

  test("keeps positions aligned when content redundantly includes reasoning", () => {
    const reasoning: GatewayMessage["content"][number] = {
      type: "opaque",
      raw: { type: "redacted_thinking", data: "ciphertext" },
    };
    const firstVisible: GatewayMessage["content"][number] = {
      type: "text",
      text: "first",
    };
    const secondVisible: GatewayMessage["content"][number] = {
      type: "tool_use",
      id: "t3",
      name: "write",
      input: {},
    };
    const merged = coalesceAdjacentAssistants([
      asst([{ type: "text", text: "injected" }]),
      {
        role: "assistant",
        content: [reasoning, firstVisible, secondVisible],
        provenanceContent: [reasoning, firstVisible, secondVisible],
        // Positions describe visible blocks only; reasoning has no entry.
        provenancePositions: [1, 2],
      },
    ]);

    expect(merged[0].content).toEqual([
      { type: "text", text: "injected" },
      firstVisible,
      secondVisible,
    ]);
    expect(merged[0].provenanceContent).toEqual([
      reasoning,
      { type: "text", text: "injected" },
      firstVisible,
      secondVisible,
    ]);
    expect(merged[0].provenancePositions).toEqual([1, 2, 3]);
  });

  test("does not merge across a user boundary", () => {
    const merged = coalesceAdjacentAssistants([
      asst([{ type: "text", text: "a" }]),
      user("boundary"),
      asst([{ type: "text", text: "b" }]),
    ]);
    expect(merged.map((m) => m.role)).toEqual([
      "assistant",
      "user",
      "assistant",
    ]);
  });
});
