import { tool } from "@opencode-ai/plugin/tool";
import type { ToolDefinition } from "@opencode-ai/plugin/tool";
import type { PluginInput } from "@opencode-ai/plugin";
import {
  executeRecallTool,
  discoverWorkspaceRoot,
  RECALL_TOOL_INPUT_SCHEMA,
  RECALL_TOOL_SCOPES,
  RECALL_TOOL_DESCRIPTION,
  type RecallToolExecutor,
} from "@loreai/core";

/** Register recall through OpenCode's normal plugin-tool contract. */
export function createRecallTool(
  execute: RecallToolExecutor = executeRecallTool,
  client?: PluginInput["client"],
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
      if (context.abort.aborted) return "Recall was cancelled.";
      let providerID: string | undefined;
      let turnID: string | undefined;
      if (client) {
        try {
          const response = await client.session.message({
            path: { id: context.sessionID, messageID: context.messageID },
            query: { directory: context.directory },
            signal: AbortSignal.any([
              context.abort,
              AbortSignal.timeout(5_000),
            ]),
          });
          const info = response.data?.info;
          if (
            info?.role === "assistant" &&
            info.id === context.messageID &&
            info.sessionID === context.sessionID &&
            typeof info.providerID === "string" &&
            info.providerID.length > 0 &&
            typeof info.parentID === "string" &&
            info.parentID.length > 0
          ) {
            providerID = info.providerID;
            turnID = info.parentID;
          }
        } catch {
          // The invoking assistant must be verified; cached credentials alone
          // cannot prove which account produced an unobserved request.
        }
        if (!providerID || !turnID)
          return context.abort.aborted
            ? "Recall was cancelled."
            : "Recall is unavailable for this authenticated session.";
      }
      return execute(args, {
        projectPath: discoverWorkspaceRoot(
          context.worktree || context.directory,
        ),
        sessionID: context.sessionID,
        ...(providerID ? { providerID } : {}),
        ...(turnID ? { turnID } : {}),
        signal: context.abort,
      });
    },
  });
}
