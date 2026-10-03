import { estimateTokens } from "@loreai/core";
import type {
  GatewayContentBlock,
  GatewayMessage,
  GatewayRequest,
} from "./translate/types";

/** Only text-only native user items have a bounded serialized context cost. */
function nativeUserTextParts(block: GatewayContentBlock): string[] | null {
  if (
    block.type !== "opaque" ||
    !block.responsesItem ||
    !block.requestOnly ||
    (block.raw.type !== undefined && block.raw.type !== "message") ||
    block.raw.role !== "user" ||
    Object.keys(block.raw).some(
      (key) => !["type", "role", "content", "id", "status"].includes(key),
    ) ||
    (block.raw.status !== undefined && block.raw.status !== "completed") ||
    (block.raw.id !== undefined &&
      (typeof block.raw.id !== "string" || block.raw.id.length === 0))
  )
    return null;
  if (typeof block.raw.content === "string") return [block.raw.content];
  if (!Array.isArray(block.raw.content) || block.raw.content.length === 0)
    return null;
  const parts: string[] = [];
  for (const part of block.raw.content) {
    if (
      part === null ||
      typeof part !== "object" ||
      Array.isArray(part) ||
      !["input_text", "output_text"].includes(part.type) ||
      typeof part.text !== "string" ||
      Object.keys(part).some(
        (key) => !["type", "text", "annotations"].includes(key),
      ) ||
      (part.annotations !== undefined &&
        (part.type !== "output_text" || !Array.isArray(part.annotations)))
    )
      return null;
    parts.push(part.text);
  }
  return parts;
}

/** A native media item may consume far more model context than its short URL
 * or serialized payload suggests. Never guess its cost on the timeout path. */
function countable(block: GatewayContentBlock): boolean {
  if (block.type === "tool_result") return block.content.every(countable);
  if (block.type !== "opaque") return true;
  if (nativeUserTextParts(block) !== null) return true;
  return (
    block.raw.type === "reasoning" &&
    typeof block.raw.encrypted_content === "string"
  );
}

function alignedProvenance(message: GatewayMessage): boolean {
  const { provenanceContent, provenancePositions } = message;
  if (!provenanceContent && !provenancePositions) return true;
  if (
    !provenanceContent ||
    !provenancePositions ||
    provenancePositions.length !== message.content.length
  )
    return false;
  if (provenanceContent.length === 1) {
    const nativeParts = nativeUserTextParts(provenanceContent[0]);
    const rawContent =
      provenanceContent[0].type === "opaque"
        ? provenanceContent[0].raw.content
        : undefined;
    const visibleParts = nativeParts?.filter(
      (text, index) =>
        text !== "" ||
        (Array.isArray(rawContent) &&
          rawContent[index]?.type === "output_text" &&
          Array.isArray(rawContent[index]?.annotations) &&
          rawContent[index].annotations.length > 0),
    );
    if (
      visibleParts !== undefined &&
      visibleParts.length === message.content.length &&
      provenancePositions.every((position) => position === 0) &&
      message.content.every(
        (block, index) =>
          block.type === "text" && block.text === visibleParts[index],
      )
    )
      return true;
  }
  let previous = -1;
  for (const position of provenancePositions) {
    if (
      !Number.isSafeInteger(position) ||
      position <= previous ||
      position >= provenanceContent.length
    )
      return false;
    previous = position;
  }
  return true;
}

function validToolPairs(messages: GatewayMessage[], native: boolean): boolean {
  const blocks = (message: GatewayMessage | undefined) =>
    message
      ? native
        ? (message.provenanceContent ?? message.content)
        : message.content
      : [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    const previous = messages[i - 1];
    const next = messages[i + 1];
    for (const block of blocks(message)) {
      if (
        block.type === "tool_result" &&
        !(
          previous?.role === "assistant" &&
          blocks(previous).some(
            (part) => part.type === "tool_use" && part.id === block.toolUseId,
          )
        )
      )
        return false;
      if (
        block.type === "tool_use" &&
        !(
          next?.role === "user" &&
          blocks(next).some(
            (part) =>
              part.type === "tool_result" && part.toolUseId === block.id,
          )
        )
      )
        return false;
    }
  }
  return true;
}

/** Choose a complete, tool-safe recent suffix. Returning null means the
 * gateway must issue the retryable preparation error instead of guessing. */
export function boundFallbackHistory(
  req: GatewayRequest,
  contextLimit: number,
  outputReserved: number,
  providerID?: string,
): { removed: number; estimatedTokens: number; budget: number } | null {
  if (
    !Number.isSafeInteger(contextLimit) ||
    contextLimit <= 0 ||
    !Number.isSafeInteger(outputReserved) ||
    outputReserved < 0 ||
    !Number.isSafeInteger(req.maxTokens) ||
    req.maxTokens < 0
  )
    return null;
  const budget = Math.floor(
    (contextLimit - Math.max(outputReserved, req.maxTokens)) * 0.7,
  );
  if (!Number.isSafeInteger(budget) || budget <= 0) return null;
  const tokenCost = (value: unknown) =>
    estimateTokens(JSON.stringify(value), { providerID, modelID: req.model }) *
    2;
  let used: number;
  try {
    used =
      tokenCost({
        model: req.model,
        system: req.system,
        tools: req.tools,
        metadata: req.metadata,
        extras: req.extras,
      }) + 128;
  } catch {
    return null;
  }
  if (!Number.isSafeInteger(used) || used >= budget) return null;

  let start = req.messages.length;
  for (let index = req.messages.length - 1; index >= 0; index--) {
    const message = req.messages[index];
    const blocks = message.provenanceContent ?? message.content;
    if (
      !alignedProvenance(message) ||
      !blocks.every(countable) ||
      !message.content.every(countable)
    )
      break;
    let cost: number;
    try {
      cost = tokenCost([message.role, blocks]) + 8;
    } catch {
      break;
    }
    if (
      !Number.isSafeInteger(cost) ||
      cost < 0 ||
      !Number.isSafeInteger(used + cost) ||
      used + cost > budget
    )
      break;
    used += cost;
    start = index;
  }
  if (start === req.messages.length) return null;
  if (start > 0) {
    // A user tool_result depends on the prior assistant tool_use. Start at a
    // normal user boundary, then validate all remaining pairs without editing
    // the provider-native provenance on any retained message.
    while (
      start < req.messages.length &&
      !(
        req.messages[start].role === "user" &&
        !req.messages[start].content.some(
          (block) => block.type === "tool_result",
        )
      )
    )
      start++;
    if (start === req.messages.length) return null;
  }
  const messages = req.messages.slice(start);
  if (
    !messages.some((message) => message.role === "user") ||
    !validToolPairs(messages, false) ||
    !validToolPairs(messages, true)
  )
    return null;
  req.messages = messages;
  return { removed: start, estimatedTokens: used, budget };
}
