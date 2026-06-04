/**
 * Converts raw Anthropic API messages (as they appear in request/response
 * bodies) into `@loreai/core`'s `LoreMessageWithParts` shape for temporal
 * storage and gradient transform.
 *
 * Follows the same tool-pairing pattern used by the Pi adapter
 * (`packages/pi/src/adapter.ts`): tool_use blocks on assistant messages are
 * initially stored as "pending", then `resolveToolResults` walks the
 * conversation to merge matching tool_result blocks from subsequent user
 * messages into "completed" state.
 */
import { createHash, randomUUID } from "crypto";
import { isToolPart } from "@loreai/core";
import type {
  LoreAssistantMessage,
  LoreContentBlock,
  LoreMessageWithParts,
  LorePart,
  LoreReasoningPart,
  LoreTextPart,
  LoreToolPart,
  LoreUserMessage,
} from "@loreai/core";
import type {
  GatewayContentBlock,
  GatewayMessage,
  GatewayUsage,
} from "./translate/types";
import { blocksToText } from "./translate/types";

// ---------------------------------------------------------------------------
// Deterministic ID generation
// ---------------------------------------------------------------------------

/**
 * Generate a deterministic UUID-like ID from message content.
 * Same message at the same position produces the same ID across requests,
 * which is critical for gradient prefix fingerprinting and cache-bust detection.
 */
function deterministicID(
  role: string,
  index: number,
  content: GatewayContentBlock[],
): string {
  const h = createHash("sha256");
  h.update(`${role}:${index}:`);
  hashBlocks(h, content);
  return h.digest("hex").slice(0, 32);
}

/**
 * Feed content blocks into a hash. Recursive for tool_result sub-blocks.
 * Every block type — including opaque — contributes to the hash so messages
 * differing only in image/audio/document content produce distinct IDs
 * (prevents gradient fingerprint collisions and cache-bust misattribution).
 */
function hashBlocks(
  h: ReturnType<typeof createHash>,
  blocks: GatewayContentBlock[],
): void {
  for (const block of blocks) {
    switch (block.type) {
      case "text":
        h.update(`text:${block.text}`);
        break;
      case "thinking":
        h.update(`thinking:${block.thinking}`);
        break;
      case "tool_use":
        h.update(
          `tool_use:${block.id}:${block.name}:${JSON.stringify(block.input)}`,
        );
        break;
      case "tool_result":
        h.update(`tool_result:${block.toolUseId}:`);
        hashBlocks(h, block.content);
        break;
      case "opaque": {
        // Hash includes the text projection (type + media_type + length) plus
        // a prefix of the payload data for collision resistance — two images
        // with identical type, media_type, and size but different content will
        // produce distinct hashes.
        const source = block.raw.source as Record<string, unknown> | undefined;
        const data =
          (source?.data as string | undefined) ??
          (block.raw.data as string | undefined) ??
          "";
        const prefix = typeof data === "string" ? data.slice(0, 128) : "";
        h.update(`opaque:${blocksToText([block])}:${prefix}`);
        break;
      }
    }
  }
}

/**
 * Generate a deterministic ID for a part within a message.
 * Uses the message ID + part index for stability.
 */
function deterministicPartID(messageID: string, partIndex: number): string {
  const h = createHash("sha256");
  h.update(`${messageID}:part:${partIndex}`);
  return h.digest("hex").slice(0, 32);
}

// ---------------------------------------------------------------------------
// Part conversion helpers
// ---------------------------------------------------------------------------

function contentBlockToPart(
  block: GatewayContentBlock,
  sessionID: string,
  messageID: string,
  partIndex: number,
): LorePart {
  const now = Date.now();
  const id = deterministicPartID(messageID, partIndex);
  switch (block.type) {
    case "text":
      return {
        id,
        sessionID,
        messageID,
        type: "text",
        text: block.text,
        time: { start: now, end: now },
      } satisfies LoreTextPart;

    case "thinking":
      return {
        id,
        sessionID,
        messageID,
        type: "reasoning",
        text: block.thinking,
        ...(block.signature != null
          ? { signature: block.signature }
          : undefined),
      } satisfies LoreReasoningPart;

    case "tool_use":
      return {
        id,
        sessionID,
        messageID,
        type: "tool",
        tool: block.name,
        callID: block.id,
        state: { status: "pending", input: block.input },
      } satisfies LoreToolPart;

    case "tool_result": {
      // Text projection for memory/FTS/gradient consumers.
      const textProjection = blocksToText(block.content);
      // Carry structured blocks only when the content has non-text blocks
      // (images, opaque, …) so lossless round-trip is possible.
      const hasNonText = block.content.some((b) => b.type !== "text");
      const blocks: LoreContentBlock[] | undefined = hasNonText
        ? block.content.map((b): LoreContentBlock => ({ ...b }))
        : undefined;

      return {
        id,
        sessionID,
        messageID,
        type: "tool",
        tool: "result",
        callID: block.toolUseId,
        // Propagate the error flag so downstream consumers (structured
        // tool-call trace, gradient) can distinguish failed tool results.
        state: block.isError
          ? {
              status: "error",
              input: null,
              error: textProjection,
              ...(blocks ? { blocks } : undefined),
              time: { start: now, end: now },
            }
          : {
              status: "completed",
              input: null,
              output: textProjection,
              ...(blocks ? { blocks } : undefined),
              time: { start: now, end: now },
            },
      } satisfies LoreToolPart;
    }

    case "opaque":
      // Opaque block (image, audio, document, …) — preserve as a generic
      // part so it flows through gradient untouched and can be reconstructed
      // on egress via loreMessagesToGateway.
      return {
        type: "opaque",
        id,
        sessionID,
        messageID,
        raw: block.raw,
      };
  }
}

// ---------------------------------------------------------------------------
// 1. gatewayMessagesToLore
// ---------------------------------------------------------------------------

/**
 * Convert an array of gateway messages to Lore's message-with-parts format.
 *
 * User messages get minimal metadata (we don't know the model at message
 * level). Assistant messages get zeroed-out token counts — call
 * `updateAssistantMessageTokens` after accumulating the API response to
 * fill them in.
 */
export function gatewayMessagesToLore(
  messages: GatewayMessage[],
  sessionID: string,
): LoreMessageWithParts[] {
  const out: LoreMessageWithParts[] = [];
  const now = Date.now();

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const id = deterministicID(m.role, i, m.content);
    const parts: LorePart[] = m.content.map((block, pi) =>
      contentBlockToPart(block, sessionID, id, pi),
    );

    if (m.role === "user") {
      const info: LoreUserMessage = {
        id,
        sessionID,
        role: "user",
        time: { created: now },
        agent: "gateway",
        model: { providerID: "anthropic", modelID: "unknown" },
      };
      out.push({ info, parts });
    } else {
      const info: LoreAssistantMessage = {
        id,
        sessionID,
        role: "assistant",
        time: { created: now },
        parentID: "",
        modelID: "unknown",
        providerID: "anthropic",
        mode: "gateway",
        path: { cwd: "", root: "" },
        cost: 0,
        tokens: {
          input: 0,
          output: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
      };
      out.push({ info, parts });
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// 2. updateAssistantMessageTokens
// ---------------------------------------------------------------------------

/**
 * Update an assistant message's token counts from the API response usage data.
 * Mutates in place — call after the upstream response is fully accumulated.
 */
export function updateAssistantMessageTokens(
  msg: LoreMessageWithParts,
  usage: GatewayUsage,
  model: string,
): void {
  const info = msg.info;
  if (info.role !== "assistant") return;

  info.tokens.input = usage.inputTokens;
  info.tokens.output = usage.outputTokens;
  info.tokens.cache.read = usage.cacheReadInputTokens ?? 0;
  info.tokens.cache.write = usage.cacheCreationInputTokens ?? 0;
  info.modelID = model;
}

// ---------------------------------------------------------------------------
// 3. resolveToolResults
// ---------------------------------------------------------------------------

/**
 * Walk through the messages and match tool_result blocks (on user messages)
 * with their corresponding tool_use blocks (on preceding assistant messages).
 *
 * When a tool_use was initially stored as "pending", update it to "completed"
 * with the output from the matching tool_result. This mirrors the tool-pairing
 * pattern used in the Pi adapter (`piMessagesToLore`).
 *
 * After resolving, strips all `tool: "result"` parts from user messages.
 * Their data is now redundant (merged into the assistant's completed tool part).
 * This prevents orphaned `tool_result` blocks when gradient evicts the assistant
 * message but keeps the following user message — the Anthropic API requires every
 * `tool_result` to reference a `tool_use` on the immediately preceding assistant.
 *
 * Mutates messages in place.
 */
export function resolveToolResults(messages: LoreMessageWithParts[]): void {
  // --- Pass 1: Index all tool_result parts by callID ---
  const resultsByCallID = new Map<
    string,
    { output: string; blocks?: LoreContentBlock[]; isError: boolean }
  >();

  for (const msg of messages) {
    for (const part of msg.parts) {
      if (isToolPart(part) && part.tool === "result") {
        if (part.state.status === "completed") {
          resultsByCallID.set(part.callID, {
            output: part.state.output,
            blocks: part.state.blocks,
            isError: false,
          });
        } else if (part.state.status === "error") {
          resultsByCallID.set(part.callID, {
            output: part.state.error,
            blocks: part.state.blocks,
            isError: true,
          });
        }
      }
    }
  }

  // --- Pass 2: Resolve pending tool_use → completed where a result exists ---
  const now = Date.now();
  for (const msg of messages) {
    for (const part of msg.parts) {
      if (
        isToolPart(part) &&
        part.tool !== "result" &&
        part.state.status === "pending"
      ) {
        const result = resultsByCallID.get(part.callID);
        if (result) {
          part.state = result.isError
            ? {
                status: "error",
                input: part.state.input,
                error: result.output,
                ...(result.blocks ? { blocks: result.blocks } : undefined),
                time: { start: now, end: now },
              }
            : {
                status: "completed",
                input: part.state.input,
                output: result.output,
                ...(result.blocks ? { blocks: result.blocks } : undefined),
                time: { start: now, end: now },
              };
        }
      }
    }
  }

  // --- Pass 3: Strip redundant tool_result parts from user messages ---
  // After resolving, tool_result data lives on the assistant's completed
  // tool part. Keeping it on user messages creates orphaned tool_result
  // blocks when gradient evicts the assistant but keeps the user.
  // loreMessagesToGateway() reconstructs tool_result blocks from the
  // assistant's completed/error tool parts, so no data is lost.
  for (const msg of messages) {
    if (msg.info.role !== "user") continue;
    const before = msg.parts.length;
    msg.parts = msg.parts.filter(
      (p) => !(isToolPart(p) && p.tool === "result"),
    );
    // If stripping left the user message with no content parts,
    // add a recall-able placeholder so the model can fetch the original
    // tool output via recall using the temporal message ID (t:xxx).
    // The original content is stored in temporal BEFORE resolveToolResults
    // runs, so `t:<messageID>` retrieves the full tool_result text.
    if (msg.parts.length === 0 && before > 0) {
      msg.parts = [
        {
          id: randomUUID(),
          sessionID: "",
          messageID: msg.info.id,
          type: "text" as const,
          text: `[tool results provided] (t:${msg.info.id})`,
          time: { start: 0, end: 0 },
        } satisfies LoreTextPart,
      ];
    }
  }
}
