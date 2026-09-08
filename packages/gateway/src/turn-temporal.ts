import {
  ensureProject,
  temporal,
  withSavepoint,
  type LoreMessageWithParts,
} from "@loreai/core";
import { isRecallMarker } from "./recall";
import {
  gatewayMessagesToLore,
  updateAssistantMessageTokens,
} from "./temporal-adapter";
import type { GatewayContentBlock, GatewayUsage } from "./translate/types";

/** Owned snapshot, captured before tool resolution or gradient mutates history. */
export interface TurnTemporalInput {
  readonly latestUser?: LoreMessageWithParts;
  /** Absolute request length, even when only one message is retained. */
  readonly assistantIndex: number;
  readonly checkpoint?: { claim(): boolean; publish(): void };
}

export function captureTurnTemporalInput(
  messages: LoreMessageWithParts[],
  assistantIndex = messages.length,
  checkpoint?: TurnTemporalInput["checkpoint"],
): TurnTemporalInput {
  const latestUser = messages.findLast((m) => m.info.role === "user");
  return Object.freeze({
    ...(latestUser ? { latestUser: structuredClone(latestUser) } : {}),
    assistantIndex,
    ...(checkpoint ? { checkpoint } : {}),
  });
}

/** Persist original user results and new assistant traces in one retryable savepoint. */
export function storeTurnTemporal(input: {
  temporalInput: TurnTemporalInput;
  assistantContentBlocks: GatewayContentBlock[];
  usage: GatewayUsage;
  model: string;
  projectPath: string;
  sessionID: string;
  noStore: boolean;
}): void {
  if (input.noStore) return;
  const { projectPath, sessionID, temporalInput } = input;
  ensureProject(projectPath);
  withSavepoint("post_response_temporal", () => {
    const checkpointClaimed = temporalInput.checkpoint?.claim() ?? false;
    const user = temporalInput.latestUser;
    if (user) {
      const message = {
        projectPath,
        // The previous post-response conversion assigned this timestamp here.
        // Preserve persistence-time ordering without changing the owned snapshot.
        info: {
          ...user.info,
          time: { ...user.info.time, created: Date.now() },
        },
        parts: user.parts,
        legacySourceID: user.legacySourceID,
      };
      temporal.store(message);
      // Outcomes carry call IDs: recordToolCalls updates the preceding call
      // directly in SQLite, without retaining/re-resolving its historical graph.
      temporal.recordToolCalls(message);
    }
    const assistantContent = input.assistantContentBlocks.filter(
      (b) => !(b.type === "text" && isRecallMarker(b.text)),
    );
    const assistant = gatewayMessagesToLore(
      [{ role: "assistant", content: assistantContent }],
      sessionID,
      temporalInput.assistantIndex,
    )[0];
    updateAssistantMessageTokens(assistant, input.usage, input.model);
    const message = {
      projectPath,
      info: assistant.info,
      parts: assistant.parts,
      legacySourceID: assistant.legacySourceID,
    };
    if (assistantContent.length > 0) temporal.store(message);
    // Tool-only/error turns still need traces even when no text was stored.
    temporal.recordToolCalls(message);
    if (checkpointClaimed) temporalInput.checkpoint?.publish();
  });
}
