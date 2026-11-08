import {
  executeRecallTool,
  RECALL_TOOL_INPUT_SCHEMA,
  RECALL_TOOL_NAME,
  RECALL_TOOL_SCOPES,
  RECALL_TOOL_DESCRIPTION,
  type RecallToolContext,
  type RecallToolExecutor,
} from "@loreai/core";
import type {
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { recallOrigin, type RecallOrigin } from "./recall-origin";

const properties = RECALL_TOOL_INPUT_SCHEMA.properties;

const parameters = Type.Object(
  {
    query: Type.Optional(
      Type.String({
        maxLength: properties.query.maxLength,
        description: properties.query.description,
      }),
    ),
    scope: Type.Optional(
      Type.Union(
        [
          Type.Literal(RECALL_TOOL_SCOPES[0]),
          Type.Literal(RECALL_TOOL_SCOPES[1]),
          Type.Literal(RECALL_TOOL_SCOPES[2]),
          Type.Literal(RECALL_TOOL_SCOPES[3]),
        ],
        { description: properties.scope.description },
      ),
    ),
    id: Type.Optional(
      Type.String({
        minLength: properties.id.minLength,
        maxLength: properties.id.maxLength,
        description: properties.id.description,
      }),
    ),
    ids: Type.Optional(
      Type.Array(
        Type.String({
          minLength: properties.ids.items.minLength,
          maxLength: properties.ids.items.maxLength,
        }),
        {
          minItems: properties.ids.minItems,
          maxItems: properties.ids.maxItems,
          description: properties.ids.description,
        },
      ),
    ),
    detailOffset: Type.Optional(
      Type.Integer({
        minimum: properties.detailOffset.minimum,
        maximum: properties.detailOffset.maximum,
        description: properties.detailOffset.description,
      }),
    ),
    detailLimit: Type.Optional(
      Type.Integer({
        minimum: properties.detailLimit.minimum,
        maximum: properties.detailLimit.maximum,
        description: properties.detailLimit.description,
      }),
    ),
  },
  {
    additionalProperties: false,
    // Keep this provider schema root-object-only. Runtime argument validation
    // still enforces that callers provide query, id, or ids.
  },
);

type RecallToolHostContext = Pick<
  RecallToolContext,
  "projectPath" | "sessionID"
>;

/** Register Lore recall as a native Pi tool using the shared core contract. */
export function createPiRecallTool(
  getHostContext: () => RecallToolHostContext,
  execute: RecallToolExecutor = executeRecallTool,
  resolveTurn?: (
    origin: RecallOrigin,
    context: ExtensionContext,
  ) => RecallToolContext | undefined,
): ToolDefinition {
  return {
    name: RECALL_TOOL_NAME,
    label: "Lore recall",
    description: RECALL_TOOL_DESCRIPTION,
    promptSnippet: "Search Lore memory for project knowledge and earlier work.",
    parameters,
    async execute(
      toolCallID,
      input,
      signal,
      _onUpdate,
      context: ExtensionContext,
    ) {
      const callSignal = signal ?? context.signal;
      if (callSignal?.aborted)
        return {
          content: [{ type: "text", text: "Recall was cancelled." }],
          details: undefined,
        };
      const origin = recallOrigin(context, toolCallID);
      if (!origin)
        return {
          content: [
            {
              type: "text",
              text: "Recall is unavailable for this authenticated session.",
            },
          ],
          details: undefined,
        };
      const hostContext = resolveTurn
        ? resolveTurn(origin, context)
        : getHostContext();
      if (!hostContext)
        return {
          content: [
            {
              type: "text",
              text: "Recall is unavailable for this authenticated session.",
            },
          ],
          details: undefined,
        };
      // Use the same project/session pair as provider attribution for this turn.
      const result = await execute(input, {
        ...hostContext,
        providerID: origin.providerID,
        signal: callSignal,
      });
      return { content: [{ type: "text", text: result }], details: undefined };
    },
  };
}
