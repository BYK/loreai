import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { tool } from "@opencode-ai/plugin/tool";
import type { ToolContext } from "@opencode-ai/plugin/tool";
import type { PluginInput } from "@opencode-ai/plugin";
import {
  RECALL_TOOL_DESCRIPTION,
  RECALL_TOOL_INPUT_SCHEMA,
  discoverWorkspaceRoot,
  type RecallToolExecutor,
} from "@loreai/core";
import { createRecallTool } from "../src/recall-tool";

function makeToolContext(): ToolContext {
  return {
    sessionID: "session-1",
    messageID: "message-1",
    agent: "build",
    directory: "/project",
    worktree: "/project/worktree",
    abort: new AbortController().signal,
    metadata: vi.fn(),
    ask: vi.fn(async () => undefined),
  };
}

describe("OpenCode recall tool", () => {
  test("accepts provider identity only from the invoking assistant message in the same session", async () => {
    const context = makeToolContext();
    const execute = vi.fn<RecallToolExecutor>(async () => "memory");
    const message = vi.fn(async (_options: unknown) => ({
      data: {
        info: {
          id: context.messageID,
          sessionID: context.sessionID,
          role: "assistant",
          providerID: "minimax",
          parentID: "parent-1",
        },
      },
    }));
    const client = { session: { message } } as unknown as PluginInput["client"];
    const recall = createRecallTool(execute, client);
    await recall.execute({ query: "memory" }, context);
    expect(execute.mock.calls.at(-1)?.[1].providerID).toBe("minimax");
    for (const invalid of [
      { id: "other-message" },
      { sessionID: "other-session" },
      { role: "user" },
    ]) {
      execute.mockClear();
      message.mockResolvedValueOnce({
        data: {
          info: {
            id: context.messageID,
            sessionID: context.sessionID,
            role: "assistant",
            providerID: "minimax",
            parentID: "parent-1",
            ...invalid,
          },
        },
      });
      await recall.execute({ query: "memory" }, context);
      expect(execute).not.toHaveBeenCalled();
    }
    expect(message.mock.calls[0]?.[0]).toMatchObject({
      path: { id: context.sessionID, messageID: context.messageID },
      query: { directory: context.directory },
    });
    execute.mockClear();
    message.mockRejectedValueOnce(new Error("private lookup failure"));
    expect(await recall.execute({ query: "memory" }, context)).toContain(
      "unavailable",
    );
    expect(execute).not.toHaveBeenCalled();
  });
  test("registers the shared schema and forwards host context", async () => {
    const execute = vi.fn<RecallToolExecutor>(async () => "memory results");
    const recall = createRecallTool(execute);
    const context = makeToolContext();

    expect(recall.description).toBe(RECALL_TOOL_DESCRIPTION);
    expect(
      tool.schema.object(recall.args).safeParse({
        query: "x".repeat(
          RECALL_TOOL_INPUT_SCHEMA.properties.query.maxLength + 1,
        ),
      }).success,
    ).toBe(false);

    await expect(
      recall.execute({ query: "cache behavior", scope: "session" }, context),
    ).resolves.toBe("memory results");
    expect(execute).toHaveBeenCalledWith(
      { query: "cache behavior", scope: "session" },
      {
        projectPath: "/project/worktree",
        sessionID: "session-1",
        signal: context.abort,
      },
    );
  });

  test("passes invalid arguments to the shared validator unchanged", async () => {
    const execute = vi.fn<RecallToolExecutor>(async () => "invalid");
    const recall = createRecallTool(execute);
    await expect(recall.execute({}, makeToolContext())).resolves.toBe(
      "invalid",
    );
    expect(execute).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ projectPath: "/project/worktree" }),
    );
  });

  test("resolves nested workspace paths and preserves the gateway session ID", async () => {
    const root = mkdtempSync(join(tmpdir(), "lore-opencode-recall-"));
    try {
      const nested = join(root, "packages", "app");
      mkdirSync(nested, { recursive: true });
      writeFileSync(
        join(root, ".lore.json"),
        JSON.stringify({ workspaces: ["packages/*"] }),
      );
      const execute = vi.fn<RecallToolExecutor>(async () => "memory results");
      const recall = createRecallTool(execute);
      const context = {
        ...makeToolContext(),
        directory: root,
        worktree: nested,
      };

      await recall.execute(
        { query: "session memory", scope: "session" },
        context,
      );

      expect(execute).toHaveBeenCalledWith(
        { query: "session memory", scope: "session" },
        {
          projectPath: root,
          sessionID: context.sessionID,
          signal: context.abort,
        },
      );
      expect(discoverWorkspaceRoot(nested)).toBe(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
