import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { RECALL_TOOL_NAME } from "@loreai/core";

export type RecallOrigin = {
  providerID: string;
  modelID: string;
  timestamp: number;
};

export function recallOriginKey(origin: RecallOrigin): string {
  return JSON.stringify([origin.timestamp, origin.providerID, origin.modelID]);
}

/** The completed assistant is persisted before Pi executes its tool calls. */
export function recallOrigin(
  context: ExtensionContext,
  toolCallID: string,
): RecallOrigin | null {
  try {
    const matches: RecallOrigin[] = [];
    for (const entry of context.sessionManager.getBranch()) {
      if (entry.type !== "message" || entry.message.role !== "assistant")
        continue;
      const message = entry.message;
      for (const part of message.content) {
        if (
          part.type === "toolCall" &&
          part.id === toolCallID &&
          part.name === RECALL_TOOL_NAME
        ) {
          if (
            !message.provider ||
            !message.model ||
            !Number.isFinite(message.timestamp)
          )
            return null;
          matches.push({
            providerID: message.provider,
            modelID: message.model,
            timestamp: message.timestamp,
          });
        }
      }
    }
    return matches.length === 1 ? matches[0]! : null;
  } catch {
    return null;
  }
}
