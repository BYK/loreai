import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { tool } from "@opencode-ai/plugin/tool";
import type { ToolContext } from "@opencode-ai/plugin/tool";
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
