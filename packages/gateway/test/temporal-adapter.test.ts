import { describe, test, expect } from "bun:test";
import {
  gatewayMessagesToLore,
  resolveToolResults,
} from "../src/temporal-adapter";
import type { GatewayMessage } from "../src/translate/types";
import type { LorePart } from "@loreai/core";
import { isToolPart } from "@loreai/core";

// Test-local view of a tool part's state covering all status variants.
type TestToolState = {
  status: string;
  input?: unknown;
  output?: string;
  error?: string;
};

/** Narrow a LorePart to a tool part and expose its state for assertions. */
function toolStateOf(part: LorePart | undefined): TestToolState {
  if (!part || !isToolPart(part)) {
    throw new Error("expected tool part");
  }
  return part.state as unknown as TestToolState;
}

/** Read the text of a text part, asserting it is one. */
function textOf(part: LorePart | undefined): string {
  if (part?.type !== "text") {
    throw new Error("expected text part");
  }
  return (part as { text: string }).text;
}

// ---------------------------------------------------------------------------
// Helper: build a typical tool-call conversation in gateway message format
// ---------------------------------------------------------------------------

function makeToolConversation(): GatewayMessage[] {
  return [
    {
      role: "user",
      content: [{ type: "text", text: "List the files" }],
    },
    {
      role: "assistant",
      content: [
        { type: "text", text: "I'll list the files for you." },
        {
          type: "tool_use",
          id: "toolu_abc",
          name: "bash",
          input: { command: "ls" },
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          toolUseId: "toolu_abc",
          content: [{ type: "text", text: "file1.ts\nfile2.ts" }],
        },
      ],
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "Here are the files." }],
    },
  ];
}

// ---------------------------------------------------------------------------
// resolveToolResults: pairing + stripping
// ---------------------------------------------------------------------------

describe("resolveToolResults", () => {
  test("resolves pending tool_use → completed and strips tool_result parts from user messages", () => {
    const messages = gatewayMessagesToLore(makeToolConversation(), "sess-1");
    resolveToolResults(messages);

    // Assistant's tool part should now be completed with the output
    const assistantMsg = messages[1];
    if (!assistantMsg) throw new Error("expected assistant message");
    const toolPart = assistantMsg.parts.find(
      (p) => isToolPart(p) && p.tool === "bash",
    );
    expect(toolPart).toBeDefined();
    const toolState = toolStateOf(toolPart);
    expect(toolState.status).toBe("completed");
    expect(toolState.output).toBe("file1.ts\nfile2.ts");

    // User message should have NO tool_result parts (stripped)
    const toolResultUser = messages[2];
    if (!toolResultUser) throw new Error("expected tool result user message");
    const resultParts = toolResultUser.parts.filter(
      (p) => isToolPart(p) && p.tool === "result",
    );
    expect(resultParts).toHaveLength(0);
  });

  test("user message with only tool_result parts gets placeholder text with recall ID after stripping", () => {
    const messages = gatewayMessagesToLore(makeToolConversation(), "sess-2");
    resolveToolResults(messages);

    // The user message that was tool_result-only should now have a placeholder
    // with a recall-able reference to the original message: (t:<messageID>)
    const toolResultUser = messages[2];
    if (!toolResultUser) throw new Error("expected tool result user message");
    expect(toolResultUser.parts).toHaveLength(1);
    expect(toolResultUser.parts[0]?.type).toBe("text");
    const text = textOf(toolResultUser.parts[0]);
    expect(text).toStartWith("[tool results provided] (t:");
    expect(text).toEndWith(")");
  });

  test("user message with text + tool_result preserves text, strips tool_result", () => {
    const gwMessages: GatewayMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "Run these commands" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_xyz",
            name: "bash",
            input: { command: "echo hi" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: "toolu_xyz",
            content: [{ type: "text", text: "hi" }],
          },
          { type: "text", text: "Now do the next thing" },
        ],
      },
    ];

    const messages = gatewayMessagesToLore(gwMessages, "sess-3");
    resolveToolResults(messages);

    // User message should keep the text part but not the tool_result part
    const userMsg = messages[2];
    if (!userMsg) throw new Error("expected user message");
    expect(userMsg.parts).toHaveLength(1);
    expect(userMsg.parts[0]?.type).toBe("text");
    expect(textOf(userMsg.parts[0])).toBe("Now do the next thing");
  });

  test("unresolved tool_result parts (no matching tool_use) are also stripped", () => {
    // tool_result references a callID that doesn't match any tool_use
    const gwMessages: GatewayMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "Start" }],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: "toolu_orphan",
            content: [{ type: "text", text: "orphaned result" }],
          },
        ],
      },
    ];

    const messages = gatewayMessagesToLore(gwMessages, "sess-4");
    resolveToolResults(messages);

    // Orphaned tool_result should be stripped, replaced with placeholder + recall ID
    const userMsg = messages[1];
    if (!userMsg) throw new Error("expected user message");
    expect(userMsg.parts).toHaveLength(1);
    expect(userMsg.parts[0]?.type).toBe("text");
    const text = textOf(userMsg.parts[0]);
    expect(text).toStartWith("[tool results provided] (t:");
    expect(text).toEndWith(")");
  });

  test("multiple tool calls in one assistant message: all tool_result parts stripped", () => {
    const gwMessages: GatewayMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "Do multiple things" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "bash",
            input: { command: "ls" },
          },
          {
            type: "tool_use",
            id: "toolu_2",
            name: "read",
            input: { path: "file.ts" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: "toolu_1",
            content: [{ type: "text", text: "file1.ts" }],
          },
          {
            type: "tool_result",
            toolUseId: "toolu_2",
            content: [{ type: "text", text: "const x = 1;" }],
          },
        ],
      },
    ];

    const messages = gatewayMessagesToLore(gwMessages, "sess-5");
    resolveToolResults(messages);

    // Both assistant tool parts should be resolved
    const assistantMsg = messages[1];
    if (!assistantMsg) throw new Error("expected assistant message");
    const toolParts = assistantMsg.parts.filter(
      (p) => isToolPart(p) && p.tool !== "result",
    );
    expect(toolParts).toHaveLength(2);
    expect(toolStateOf(toolParts[0]).status).toBe("completed");
    expect(toolStateOf(toolParts[0]).output).toBe("file1.ts");
    expect(toolStateOf(toolParts[1]).status).toBe("completed");
    expect(toolStateOf(toolParts[1]).output).toBe("const x = 1;");

    // User message should have NO tool_result parts — replaced with placeholder
    const userMsg = messages[2];
    if (!userMsg) throw new Error("expected user message");
    const resultParts = userMsg.parts.filter(
      (p) => isToolPart(p) && p.tool === "result",
    );
    expect(resultParts).toHaveLength(0);
    expect(userMsg.parts).toHaveLength(1);
    expect(userMsg.parts[0]?.type).toBe("text");
  });

  test("assistant messages are never modified by stripping pass", () => {
    const messages = gatewayMessagesToLore(makeToolConversation(), "sess-6");
    resolveToolResults(messages);

    // All assistant messages should still have their original parts (text + tool)
    const assistant1 = messages[1];
    if (!assistant1) throw new Error("expected assistant message");
    expect(assistant1.info.role).toBe("assistant");
    const textParts = assistant1.parts.filter((p) => p.type === "text");
    const toolParts = assistant1.parts.filter((p) => p.type === "tool");
    expect(textParts).toHaveLength(1);
    expect(toolParts).toHaveLength(1);
  });

  test("error tool_result resolves the tool_use to error state", () => {
    const gwMessages: GatewayMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_err",
            name: "bash",
            input: { command: "false" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: "toolu_err",
            content: [
              { type: "text", text: "command failed with exit code 1" },
            ],
            isError: true,
          },
        ],
      },
    ];

    const messages = gatewayMessagesToLore(gwMessages, "sess-err");
    // contentBlockToPart maps an error tool_result to an error-state part.
    const resultPart = messages[1]?.parts.find(
      (p) => isToolPart(p) && p.tool === "result",
    );
    const resultState = toolStateOf(resultPart);
    expect(resultState.status).toBe("error");
    expect(resultState.error).toBe("command failed with exit code 1");

    resolveToolResults(messages);

    // The assistant's tool_use is now resolved to error with the message.
    const toolPart = messages[0]?.parts.find(
      (p) => isToolPart(p) && p.tool === "bash",
    );
    const toolState = toolStateOf(toolPart);
    expect(toolState.status).toBe("error");
    expect(toolState.error).toBe("command failed with exit code 1");
  });
});
