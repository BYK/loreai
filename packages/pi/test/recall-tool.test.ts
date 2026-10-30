import { describe, expect, test, vi } from "vitest";
import {
  RECALL_TOOL_DESCRIPTION,
  RECALL_TOOL_INPUT_SCHEMA,
  RECALL_TOOL_NAME,
  type RecallToolContext,
  type RecallToolExecutor,
} from "@loreai/core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createPiRecallTool } from "../src/recall-tool";

describe("Pi recall tool", () => {
  test("rejects absent or duplicate tool origins even when a live model is available", async () => {
    const execute = vi.fn<RecallToolExecutor>(async () => "private memory");
    const tool = createPiRecallTool(
      () => ({ projectPath: "/project", sessionID: "session" }),
      execute,
    );
    const entry = {
      type: "message",
      id: "entry",
      message: {
        role: "assistant",
        provider: "anthropic",
        model: "model",
        timestamp: 1,
        content: [{ type: "toolCall", id: "call", name: RECALL_TOOL_NAME }],
      },
    };
    for (const branch of [
      [],
      [entry, entry],
      [
        {
          ...entry,
          message: {
            ...entry.message,
            content: [{ type: "toolCall", id: "call", name: "another-tool" }],
          },
        },
      ],
    ]) {
      const result = await tool.execute(
        "call",
        { query: "memory" },
        new AbortController().signal,
        undefined,
        {
          model: { provider: "anthropic" },
          sessionManager: { getBranch: () => branch },
        } as unknown as ExtensionContext,
      );
      expect(JSON.stringify(result)).toContain("unavailable");
    }
    expect(execute).not.toHaveBeenCalled();
  });
  test("registers the shared description and parameter contract", () => {
    const recall = createPiRecallTool(() => ({ projectPath: "/project" }));

    expect(recall.name).toBe(RECALL_TOOL_NAME);
    expect(recall.description).toBe(RECALL_TOOL_DESCRIPTION);
    expect(recall.parameters).not.toHaveProperty("anyOf");
    expect(recall.parameters).toMatchObject({
      type: RECALL_TOOL_INPUT_SCHEMA.type,
      additionalProperties: false,
      properties: {
        query: {
          type: "string",
          maxLength: RECALL_TOOL_INPUT_SCHEMA.properties.query.maxLength,
          description: RECALL_TOOL_INPUT_SCHEMA.properties.query.description,
        },
        id: {
          type: "string",
          minLength: RECALL_TOOL_INPUT_SCHEMA.properties.id.minLength,
          maxLength: RECALL_TOOL_INPUT_SCHEMA.properties.id.maxLength,
          description: RECALL_TOOL_INPUT_SCHEMA.properties.id.description,
        },
      },
    });
  });

  test("passes the current project, session, and abort signal to the shared executor", async () => {
    const signal = new AbortController().signal;
    const execute = vi.fn<RecallToolExecutor>(async (_input, context) => {
      return `${context.projectPath}:${context.sessionID}`;
    });
    const recall = createPiRecallTool(
      () => ({ projectPath: "/project/worktree", sessionID: "pi-session" }),
      execute,
    );
    const context = {
      signal: undefined,
      model: { provider: "different-live-provider" },
      sessionManager: {
        getBranch: () => [
          {
            type: "message",
            id: "entry-1",
            message: {
              role: "assistant",
              provider: "anthropic",
              model: "model",
              timestamp: 1,
              content: [
                { type: "toolCall", id: "call-1", name: RECALL_TOOL_NAME },
              ],
            },
          },
        ],
      },
    } as unknown as ExtensionContext;

    await expect(
      recall.execute("call-1", { query: "cache" }, signal, undefined, context),
    ).resolves.toEqual({
      content: [{ type: "text", text: "/project/worktree:pi-session" }],
      details: undefined,
    });
    expect(execute).toHaveBeenCalledWith({ query: "cache" }, {
      projectPath: "/project/worktree",
      sessionID: "pi-session",
      signal,
      providerID: "anthropic",
    } satisfies RecallToolContext);
  });
});
