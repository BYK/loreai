/**
 * Tests for OpenAI `/v1/chat/completions` request parsing — specifically the
 * coalescing of consecutive `role:"tool"` messages.
 *
 * OpenAI sends each tool response as its own `role:"tool"` message. The
 * gateway's downstream tool-pairing (loreMessagesToGateway +
 * removeOrphanedToolResults) assumes the Anthropic shape, where the single user
 * message immediately following an assistant carries ALL matching tool_result
 * blocks. If consecutive tool messages aren't coalesced, an assistant emitting
 * N tool_calls ends up with orphaned tool_use blocks that get stripped (logging
 * "removed orphaned tool_use block(s)" and inserting "[assistant response]"
 * placeholders).
 */
import { describe, test, expect } from "bun:test";
import { parseOpenAIRequest } from "../src/translate/openai";
import {
  loreMessagesToGateway,
  removeOrphanedToolResults,
} from "../src/pipeline";
import {
  gatewayMessagesToLore,
  resolveToolResults,
} from "../src/temporal-adapter";
import type {
  GatewayContentBlock,
  GatewayToolResultBlock,
  GatewayToolUseBlock,
} from "../src/translate/types";

const headers = { authorization: "Bearer sk-test123" };

function toolUseIds(content: GatewayContentBlock[]): string[] {
  return content
    .filter((b): b is GatewayToolUseBlock => b.type === "tool_use")
    .map((b) => b.id);
}

function toolResultIds(content: GatewayContentBlock[]): string[] {
  return content
    .filter((b): b is GatewayToolResultBlock => b.type === "tool_result")
    .map((b) => b.toolUseId);
}

describe("parseOpenAIRequest — tool message coalescing", () => {
  test("coalesces multiple tool responses into one user message", () => {
    const req = parseOpenAIRequest(
      {
        model: "gpt-4o",
        stream: false,
        messages: [
          { role: "user", content: "do two things" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_A",
                type: "function",
                function: { name: "read", arguments: "{}" },
              },
              {
                id: "call_B",
                type: "function",
                function: { name: "grep", arguments: "{}" },
              },
            ],
          },
          { role: "tool", tool_call_id: "call_A", content: "result A" },
          { role: "tool", tool_call_id: "call_B", content: "result B" },
        ],
      },
      headers,
    );

    // user, assistant, user — the two tool responses collapse into ONE user msg
    expect(req.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
    ]);

    const assistant = req.messages[1];
    if (!assistant) throw new Error("expected assistant message");
    expect(toolUseIds(assistant.content)).toEqual(["call_A", "call_B"]);

    const toolResultMsg = req.messages[2];
    if (!toolResultMsg) throw new Error("expected tool result message");
    expect(toolResultIds(toolResultMsg.content)).toEqual(["call_A", "call_B"]);
  });

  test("coalesces 3+ consecutive tool responses into one user message", () => {
    const req = parseOpenAIRequest(
      {
        model: "gpt-4o",
        stream: false,
        messages: [
          { role: "user", content: "do three things" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_A",
                type: "function",
                function: { name: "read", arguments: "{}" },
              },
              {
                id: "call_B",
                type: "function",
                function: { name: "grep", arguments: "{}" },
              },
              {
                id: "call_C",
                type: "function",
                function: { name: "glob", arguments: "{}" },
              },
            ],
          },
          { role: "tool", tool_call_id: "call_A", content: "result A" },
          { role: "tool", tool_call_id: "call_B", content: "result B" },
          { role: "tool", tool_call_id: "call_C", content: "result C" },
        ],
      },
      headers,
    );

    expect(req.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
    ]);
    expect(toolUseIds(req.messages[1]?.content)).toEqual([
      "call_A",
      "call_B",
      "call_C",
    ]);
    expect(toolResultIds(req.messages[2]?.content)).toEqual([
      "call_A",
      "call_B",
      "call_C",
    ]);
  });

  test("interleaved assistant/tool groups produce separate user messages", () => {
    const req = parseOpenAIRequest(
      {
        model: "gpt-4o",
        stream: false,
        messages: [
          { role: "user", content: "go" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_A",
                type: "function",
                function: { name: "read", arguments: "{}" },
              },
              {
                id: "call_B",
                type: "function",
                function: { name: "grep", arguments: "{}" },
              },
            ],
          },
          { role: "tool", tool_call_id: "call_A", content: "result A" },
          { role: "tool", tool_call_id: "call_B", content: "result B" },
          // Second assistant turn with its own tool call
          {
            role: "assistant",
            content: "Let me also check...",
            tool_calls: [
              {
                id: "call_C",
                type: "function",
                function: { name: "glob", arguments: "{}" },
              },
            ],
          },
          { role: "tool", tool_call_id: "call_C", content: "result C" },
        ],
      },
      headers,
    );

    // Two assistant/user pairs — each tool group is its own coalesced user msg.
    expect(req.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
    ]);
    expect(toolResultIds(req.messages[2]?.content)).toEqual([
      "call_A",
      "call_B",
    ]);
    expect(toolResultIds(req.messages[4]?.content)).toEqual(["call_C"]);
  });

  test("single tool response is unchanged (regression guard)", () => {
    const req = parseOpenAIRequest(
      {
        model: "gpt-4o",
        stream: false,
        messages: [
          { role: "user", content: "do one thing" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_A",
                type: "function",
                function: { name: "read", arguments: "{}" },
              },
            ],
          },
          { role: "tool", tool_call_id: "call_A", content: "result A" },
        ],
      },
      headers,
    );

    expect(req.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
    ]);
    expect(toolResultIds(req.messages[2]?.content)).toEqual(["call_A"]);
  });

  test("does NOT merge a genuine user text turn into tool results", () => {
    const req = parseOpenAIRequest(
      {
        model: "gpt-4o",
        stream: false,
        messages: [
          { role: "user", content: "go" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_A",
                type: "function",
                function: { name: "read", arguments: "{}" },
              },
            ],
          },
          { role: "tool", tool_call_id: "call_A", content: "result A" },
          { role: "user", content: "thanks" },
        ],
      },
      headers,
    );

    // The real user "thanks" stays a separate message — not merged into the
    // tool-result user message.
    expect(req.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "user",
    ]);
    const toolResultMsg = req.messages[2];
    if (!toolResultMsg) throw new Error("expected tool result message");
    expect(toolResultIds(toolResultMsg.content)).toEqual(["call_A"]);
    const userText = req.messages[3];
    if (!userText) throw new Error("expected user message");
    expect(userText.content).toEqual([{ type: "text", text: "thanks" }]);
  });

  test("end-to-end: parsed multi-tool messages survive reconstruction with no orphans", () => {
    const req = parseOpenAIRequest(
      {
        model: "gpt-4o",
        stream: false,
        messages: [
          { role: "user", content: "do two things" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_A",
                type: "function",
                function: { name: "read", arguments: "{}" },
              },
              {
                id: "call_B",
                type: "function",
                function: { name: "grep", arguments: "{}" },
              },
            ],
          },
          { role: "tool", tool_call_id: "call_A", content: "result A" },
          { role: "tool", tool_call_id: "call_B", content: "result B" },
          { role: "user", content: "now summarize" },
        ],
      },
      headers,
    );

    // Mirror the real pipeline flow: gateway → lore → resolve → back to gateway.
    const lore = gatewayMessagesToLore(req.messages, "test-session");
    resolveToolResults(lore);
    const reconstructed = loreMessagesToGateway(lore);

    // Capture warnings emitted by removeOrphanedToolResults.
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    try {
      removeOrphanedToolResults(reconstructed);
    } finally {
      console.warn = origWarn;
    }

    // No orphaned tool_use warnings, no placeholder substitution.
    const orphanWarnings = warnings.filter((w) =>
      w.includes("orphaned tool_use"),
    );
    expect(orphanWarnings).toEqual([]);

    const allText = reconstructed
      .flatMap((m) => m.content)
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text);
    expect(allText).not.toContain("[assistant response]");

    // The assistant's two tool_use blocks must both still be present.
    const assistant = reconstructed.find(
      (m) => m.role === "assistant" && toolUseIds(m.content).length > 0,
    );
    if (!assistant) throw new Error("expected assistant message");
    expect(toolUseIds(assistant.content).sort()).toEqual(["call_A", "call_B"]);
  });
});
