import { tool } from "@opencode-ai/plugin/tool";
import type { ToolDefinition } from "@opencode-ai/plugin/tool";
import {
  executeRecallTool,
  RECALL_TOOL_INPUT_SCHEMA,
  RECALL_TOOL_SCOPES,
  RECALL_TOOL_DESCRIPTION,
  type RecallToolExecutor,
} from "@loreai/core";

/** Register recall through OpenCode's normal plugin-tool contract. */
export function createRecallTool(
  execute: RecallToolExecutor = executeRecallTool,
): ToolDefinition {
  return tool({
    description: RECALL_TOOL_DESCRIPTION,
    args: {
      query: tool.schema
        .string()
        .max(RECALL_TOOL_INPUT_SCHEMA.properties.query.maxLength)
        .optional()
        .describe(RECALL_TOOL_INPUT_SCHEMA.properties.query.description),
      scope: tool.schema
        .enum(RECALL_TOOL_SCOPES)
        .optional()
        .describe(RECALL_TOOL_INPUT_SCHEMA.properties.scope.description),
      id: tool.schema
        .string()
        .min(RECALL_TOOL_INPUT_SCHEMA.properties.id.minLength)
        .max(RECALL_TOOL_INPUT_SCHEMA.properties.id.maxLength)
        .optional()
        .describe(RECALL_TOOL_INPUT_SCHEMA.properties.id.description),
      ids: tool.schema
        .array(
          tool.schema
            .string()
            .min(RECALL_TOOL_INPUT_SCHEMA.properties.ids.items.minLength)
            .max(RECALL_TOOL_INPUT_SCHEMA.properties.ids.items.maxLength),
        )
        .min(RECALL_TOOL_INPUT_SCHEMA.properties.ids.minItems)
        .max(RECALL_TOOL_INPUT_SCHEMA.properties.ids.maxItems)
        .optional()
        .describe(RECALL_TOOL_INPUT_SCHEMA.properties.ids.description),
      detailOffset: tool.schema
        .number()
        .int()
        .min(RECALL_TOOL_INPUT_SCHEMA.properties.detailOffset.minimum)
        .max(RECALL_TOOL_INPUT_SCHEMA.properties.detailOffset.maximum)
        .optional()
        .describe(RECALL_TOOL_INPUT_SCHEMA.properties.detailOffset.description),
      detailLimit: tool.schema
        .number()
        .int()
        .min(RECALL_TOOL_INPUT_SCHEMA.properties.detailLimit.minimum)
        .max(RECALL_TOOL_INPUT_SCHEMA.properties.detailLimit.maximum)
        .optional()
        .describe(RECALL_TOOL_INPUT_SCHEMA.properties.detailLimit.description),
    },
    async execute(args, context) {
      return execute(args, {
        projectPath: context.worktree || context.directory,
        sessionID: context.sessionID,
        signal: context.abort,
      });
    },
  });
}
