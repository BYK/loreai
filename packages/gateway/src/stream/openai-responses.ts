/**
 * OpenAI Responses API SSE stream accumulator.
 *
 * Parses upstream Responses API streaming events and accumulates the full
 * response into a `GatewayResponse`. The Responses API uses a different
 * SSE event lifecycle than Anthropic:
 *
 *   response.created → response.in_progress →
 *   response.output_item.added → response.output_text.delta (repeated) →
 *   response.output_item.done → response.function_call_arguments.delta →
 *   response.function_call_arguments.done →
 *   response.completed
 *
 * Reuses `parseSSEStream` from the Anthropic stream module since the
 * underlying SSE wire format is the same.
 */
import { asString, log } from "@loreai/core";
import {
  ZERO_USAGE,
  type GatewayContentBlock,
  type GatewayResponse,
  type GatewayUsage,
} from "../translate/types";
import {
  DEFAULT_MAX_SSE_FRAMES,
  AnthropicSSEValidator,
  parseSSEStream,
  createStreamAccumulator,
  cancelAndReleaseReader,
} from "./anthropic";
import {
  isRecord as isUsageRecord,
  safeTokenSum,
  validateResponsesUsage,
} from "../usage-validation";

// ---------------------------------------------------------------------------
// Stream accumulator — shared per-event core
// ---------------------------------------------------------------------------

/**
 * Mutable accumulation state for an OpenAI Responses API SSE stream. Shared by
 * the buffered accumulator (`accumulateResponsesSSEStream`) and the live
 * pass-through streamer (`streamResponsesPassthrough`) so both derive an
 * identical `GatewayResponse` from the same event-handling logic.
 */
export interface ResponsesAccState {
  id: string;
  model: string;
  stopReason: string;
  usage: GatewayUsage;
  terminalEvent?:
    | "response.completed"
    | "response.incomplete"
    | "response.failed";
  /** Final upstream response snapshot, used when rebuilding transformed SSE. */
  terminalResponse?: Record<string, unknown>;
  /** Original upstream output items, retained for terminal rebuilds. */
  rawItems: Map<number, Record<string, unknown>>;
  /** Strict-mode identity indexes. Each identity belongs to one output item. */
  itemIndexById: Map<string, number>;
  callIndexById: Map<string, number>;
  effectiveToolIndexById: Map<string, number>;
  nextOutputIndex: number;
  activeTextItems: Set<number>;
  activeToolItems: Set<number>;
  unboundTextItems: Set<number>;
  unboundToolItems: Set<number>;
  textDoneItems: Set<number>;
  refusalDoneItems: Set<number>;
  argumentDoneItems: Set<number>;
  /** Accumulating output items indexed by output_index. */
  items: Map<
    number,
    | {
        type: "text";
        id: string;
        text: string;
        refusal?: string;
        content?: Array<Record<string, unknown>>;
      }
    | {
        type: "tool_use";
        id: string;
        callId: string;
        name: string;
        args: string;
      }
  >;
}

export function makeResponsesAccState(): ResponsesAccState {
  return {
    id: "",
    model: "",
    stopReason: "end_turn",
    usage: { inputTokens: 0, outputTokens: 0 },
    items: new Map(),
    rawItems: new Map(),
    itemIndexById: new Map(),
    callIndexById: new Map(),
    effectiveToolIndexById: new Map(),
    nextOutputIndex: 0,
    activeTextItems: new Set(),
    activeToolItems: new Set(),
    unboundTextItems: new Set(),
    unboundToolItems: new Set(),
    textDoneItems: new Set(),
    refusalDoneItems: new Set(),
    argumentDoneItems: new Set(),
  };
}

/**
 * Apply one parsed Responses SSE event to the accumulation state. Never touches
 * I/O — safe to call while forwarding the same event verbatim to the client.
 */
export function applyResponsesEvent(
  state: ResponsesAccState,
  event: string,
  parsed: Record<string, unknown>,
): void {
  switch (event) {
    case "response.created":
    case "response.in_progress": {
      const resp = parsed.response as Record<string, unknown> | undefined;
      if (resp) {
        if (typeof resp.id === "string") state.id = resp.id;
        if (typeof resp.model === "string") state.model = resp.model;
      }
      break;
    }

    case "response.output_item.added": {
      const outputIndex = parsed.output_index as number;
      const item = parsed.item as Record<string, unknown> | undefined;
      if (typeof outputIndex !== "number" || !item) break;
      state.rawItems.set(outputIndex, { ...item });
      state.nextOutputIndex = Math.max(state.nextOutputIndex, outputIndex + 1);

      if (item.type === "message") {
        state.activeTextItems.add(outputIndex);
        if (!asString(item.id)) state.unboundTextItems.add(outputIndex);
        state.items.set(outputIndex, {
          type: "text",
          id: asString(item.id),
          text: "",
        });
      } else if (item.type === "function_call") {
        state.activeToolItems.add(outputIndex);
        if (!asString(item.id)) state.unboundToolItems.add(outputIndex);
        state.items.set(outputIndex, {
          type: "tool_use",
          id: asString(item.id),
          callId: asString(item.call_id),
          name: asString(item.name),
          args: asString(item.arguments),
        });
      }
      break;
    }

    case "response.output_item.done": {
      const outputIndex = parsed.output_index as number;
      const item = parsed.item as Record<string, unknown> | undefined;
      if (typeof outputIndex === "number" && item) {
        state.rawItems.set(outputIndex, { ...item });
        if (item.type === "message" && Array.isArray(item.content)) {
          const normalized = state.items.get(outputIndex);
          if (normalized?.type === "text") {
            normalized.content = item.content as Array<Record<string, unknown>>;
          }
        }
      }
      break;
    }

    case "response.output_text.delta": {
      const outputIndex = parsed.output_index as number;
      const delta = parsed.delta as string | undefined;
      if (typeof outputIndex !== "number" || typeof delta !== "string") break;

      const item = state.items.get(outputIndex);
      if (item?.type === "text") {
        item.text += delta;
      }
      break;
    }

    case "response.output_text.done": {
      const outputIndex = parsed.output_index as number;
      const text = parsed.text as string | undefined;
      if (typeof outputIndex !== "number") break;

      const item = state.items.get(outputIndex);
      if (item?.type === "text" && typeof text === "string") {
        // Replace accumulated text with the final version (more reliable)
        item.text = text;
      }
      break;
    }

    case "response.refusal.delta": {
      const outputIndex = parsed.output_index as number;
      const delta = parsed.delta as string | undefined;
      const item = state.items.get(outputIndex);
      if (item?.type === "text" && typeof delta === "string") {
        item.refusal = (item.refusal ?? "") + delta;
      }
      break;
    }

    case "response.refusal.done": {
      const outputIndex = parsed.output_index as number;
      const refusal = parsed.refusal as string | undefined;
      const item = state.items.get(outputIndex);
      if (item?.type === "text" && typeof refusal === "string") {
        item.refusal = refusal;
      }
      break;
    }

    case "response.function_call_arguments.delta": {
      const outputIndex = parsed.output_index as number;
      const delta = parsed.delta as string | undefined;
      if (typeof outputIndex !== "number" || typeof delta !== "string") break;

      const item = state.items.get(outputIndex);
      if (item?.type === "tool_use") {
        item.args += delta;
      }
      break;
    }

    case "response.function_call_arguments.done": {
      const outputIndex = parsed.output_index as number;
      const args = parsed.arguments as string | undefined;
      if (typeof outputIndex !== "number") break;

      const item = state.items.get(outputIndex);
      if (item?.type === "tool_use" && typeof args === "string") {
        item.args = args;
      }
      break;
    }

    // `response.done` / `response.incomplete` are Codex (ChatGPT) terminal
    // variants. Pi's client normalizes them to `response.completed`, but the
    // gateway sees the RAW upstream stream, so finalize on them here too.
    // `resp.status` ("incomplete"/"completed"/…) drives the stop reason via
    // `mapStatusToStopReason`.
    case "response.failed":
    case "response.done":
    case "response.incomplete":
    case "response.completed": {
      const resp = parsed.response as Record<string, unknown> | undefined;
      const status = typeof resp?.status === "string" ? resp.status : "";
      state.terminalEvent =
        event === "response.failed" ||
        status === "failed" ||
        status === "cancelled"
          ? "response.failed"
          : event === "response.incomplete" || status === "incomplete"
            ? "response.incomplete"
            : "response.completed";
      if (resp) {
        state.terminalResponse = { ...resp };
        if (typeof resp.id === "string") state.id = resp.id;
        if (typeof resp.model === "string") state.model = resp.model;
        if (typeof resp.status === "string") {
          state.stopReason = mapStatusToStopReason(resp.status);
          if (resp.status === "incomplete") {
            const details = resp.incomplete_details as
              | Record<string, unknown>
              | undefined;
            if (details?.reason === "content_filter") {
              state.stopReason = "content_filter";
            }
          }
        }

        const respUsage = validateResponsesUsage(
          resp.usage,
          "malformed Responses usage",
        );
        if (respUsage) {
          if (typeof respUsage.output_tokens === "number") {
            state.usage.outputTokens = respUsage.output_tokens;
          }
          // Responses API reports cache details under `input_tokens_details`;
          // fall back to `prompt_tokens_details` for OpenAI-compatible providers.
          const rawPromptDetails =
            respUsage.input_tokens_details ?? respUsage.prompt_tokens_details;
          const promptDetails = isUsageRecord(rawPromptDetails)
            ? rawPromptDetails
            : undefined;
          const cachedTokens =
            typeof promptDetails?.cached_tokens === "number"
              ? promptDetails.cached_tokens
              : 0;
          const cacheWriteTokens =
            typeof promptDetails?.cache_write_tokens === "number"
              ? promptDetails.cache_write_tokens
              : 0;
          const cacheTokens = safeTokenSum(
            [cachedTokens, cacheWriteTokens],
            "malformed Responses usage",
          );
          if (typeof promptDetails?.cached_tokens === "number") {
            state.usage.cacheReadInputTokens = cachedTokens;
          }
          if (typeof promptDetails?.cache_write_tokens === "number") {
            state.usage.cacheCreationInputTokens = cacheWriteTokens;
          }
          if (typeof respUsage.input_tokens === "number") {
            // input_tokens is inclusive of cache reads/writes; subtract them
            // to match the gateway's disjoint token convention.
            state.usage.inputTokens = Math.max(
              0,
              respUsage.input_tokens - cacheTokens,
            );
          }
        }
      }
      break;
    }

    // Other events (response.content_part.*,
    // response.reasoning_summary_*, etc.) — ignored for accumulation
  }
}

/** Build the final GatewayResponse from accumulated state. */
export function finalizeResponsesAcc(
  state: ResponsesAccState,
): GatewayResponse {
  const content: GatewayContentBlock[] = [];
  const sortedIndices = Array.from(state.items.keys()).sort((a, b) => a - b);

  for (const index of sortedIndices) {
    const item = state.items.get(index);
    if (!item) continue;
    if (item.type === "text") {
      if (item.content) {
        for (const part of item.content) {
          if (part.type === "output_text" && typeof part.text === "string") {
            content.push({ type: "text", text: part.text });
          } else {
            content.push({
              type: "opaque",
              responsesItem: true,
              raw: {
                ...(state.rawItems.get(index) ?? {
                  type: "message",
                  id: item.id,
                  role: "assistant",
                  status: "completed",
                }),
                content: [part],
              },
            });
          }
        }
        continue;
      }
      if (item.refusal !== undefined) {
        content.push({
          type: "opaque",
          responsesItem: true,
          raw: {
            type: "message",
            id: item.id,
            role: "assistant",
            status: "completed",
            content: [{ type: "refusal", refusal: item.refusal }],
          },
        });
      }
      if (item.text) {
        content.push({ type: "text", text: item.text });
      }
    } else if (item.type === "tool_use") {
      let input: unknown = {};
      if (item.args) {
        try {
          input = JSON.parse(item.args);
        } catch {
          input = item.args;
        }
      }
      content.push({
        type: "tool_use",
        id: item.callId || item.id,
        name: item.name,
        input,
      });
    }
  }

  let stopReason = state.stopReason;
  // If we saw tool_use, map stop reason accordingly
  if (content.some((b) => b.type === "tool_use") && stopReason === "end_turn") {
    stopReason = "tool_use";
  }

  return {
    id: state.id,
    model: state.model,
    content,
    rawOutputItems: Array.from(state.rawItems.entries())
      .sort(([a], [b]) => a - b)
      .map(([, item]) => item)
      .filter((item) => item.type !== "item_reference"),
    stopReason,
    usage: state.usage,
  };
}

// ---------------------------------------------------------------------------
// Stream accumulator (buffered)
// ---------------------------------------------------------------------------

function validatePublicResponsesEvent(
  state: ResponsesAccState,
  event: string,
  parsed: Record<string, unknown>,
  maxSparseIndex: number,
): void {
  const outputIndex = parsed.output_index;
  const validOutputIndex =
    Number.isSafeInteger(outputIndex) &&
    (outputIndex as number) >= 0 &&
    (outputIndex as number) < maxSparseIndex;
  const item = validOutputIndex
    ? state.items.get(outputIndex as number)
    : undefined;
  const malformed = (): never => {
    throw new Error("malformed Responses stream event");
  };

  if (parsed.type !== undefined && parsed.type !== event) malformed();
  if (
    parsed.sequence_number !== undefined &&
    (!Number.isSafeInteger(parsed.sequence_number) ||
      (parsed.sequence_number as number) < 0)
  ) {
    malformed();
  }
  if (
    event === "response.created" ||
    event === "response.in_progress" ||
    event === "response.failed" ||
    event === "response.completed" ||
    event === "response.incomplete" ||
    event === "response.done"
  ) {
    const response = parsed.response as Record<string, unknown> | undefined;
    if (!response || typeof response !== "object" || Array.isArray(response)) {
      throw new Error("malformed Responses terminal event");
    }
    if (state.id && response.id !== undefined && response.id !== state.id) {
      throw new Error("malformed Responses terminal event");
    }
    if (
      state.model &&
      response.model !== undefined &&
      response.model !== state.model
    ) {
      throw new Error("malformed Responses terminal event");
    }
    if (
      event === "response.created" &&
      response.status !== undefined &&
      response.status !== "in_progress" &&
      response.status !== "queued"
    ) {
      malformed();
    }
    if (
      event === "response.in_progress" &&
      response.status !== undefined &&
      response.status !== "in_progress"
    ) {
      malformed();
    }
  }
  if (
    validOutputIndex &&
    (event === "response.output_text.delta" ||
      event === "response.output_text.done" ||
      event === "response.refusal.delta" ||
      event === "response.refusal.done" ||
      event === "response.function_call_arguments.delta" ||
      event === "response.function_call_arguments.done")
  ) {
    const addedItem = state.rawItems.get(outputIndex as number);
    if (parsed.item_id !== undefined && parsed.item_id !== addedItem?.id) {
      malformed();
    }
    if (
      parsed.content_index !== undefined &&
      (!Number.isSafeInteger(parsed.content_index) ||
        (parsed.content_index as number) < 0 ||
        (parsed.content_index as number) >= maxSparseIndex)
    ) {
      malformed();
    }
  }

  switch (event) {
    case "response.output_item.added": {
      const addedItem = parsed.item as Record<string, unknown> | undefined;
      const addedCallID =
        addedItem?.type === "function_call" ? addedItem.call_id : undefined;
      if (
        !validOutputIndex ||
        !addedItem ||
        typeof addedItem !== "object" ||
        Array.isArray(addedItem) ||
        typeof addedItem.type !== "string" ||
        (addedItem.type === "message" && typeof addedItem.id !== "string") ||
        (addedItem.type === "message" &&
          addedItem.status !== undefined &&
          addedItem.status !== "in_progress") ||
        (addedItem.type === "function_call" &&
          (typeof addedItem.id !== "string" ||
            addedItem.id.length === 0 ||
            typeof addedCallID !== "string" ||
            addedCallID.length === 0 ||
            typeof addedItem.name !== "string" ||
            addedItem.name.length === 0 ||
            typeof addedItem.arguments !== "string")) ||
        state.rawItems.has(outputIndex as number) ||
        (typeof addedItem.id === "string" &&
          state.itemIndexById.has(addedItem.id)) ||
        (typeof addedCallID === "string" &&
          state.callIndexById.has(addedCallID))
      ) {
        malformed();
      }
      if (typeof addedItem?.id === "string") {
        state.itemIndexById.set(addedItem.id, outputIndex as number);
      }
      if (typeof addedCallID === "string") {
        state.callIndexById.set(addedCallID, outputIndex as number);
      }
      break;
    }
    case "response.output_item.done": {
      const doneItem = parsed.item as Record<string, unknown> | undefined;
      const addedItem = validOutputIndex
        ? state.rawItems.get(outputIndex as number)
        : undefined;
      if (
        !validOutputIndex ||
        !doneItem ||
        typeof doneItem !== "object" ||
        Array.isArray(doneItem) ||
        typeof doneItem.type !== "string" ||
        (doneItem.type === "message" && typeof doneItem.id !== "string") ||
        (doneItem.type === "message" &&
          doneItem.status !== undefined &&
          doneItem.status !== "completed" &&
          doneItem.status !== "incomplete") ||
        (doneItem.type === "function_call" &&
          (typeof doneItem.id !== "string" ||
            doneItem.id.length === 0 ||
            typeof doneItem.call_id !== "string" ||
            doneItem.call_id.length === 0 ||
            typeof doneItem.name !== "string" ||
            doneItem.name.length === 0 ||
            typeof doneItem.arguments !== "string")) ||
        !addedItem ||
        doneItem.type !== addedItem.type ||
        (typeof addedItem.id === "string" && doneItem.id !== addedItem.id) ||
        (addedItem.type === "function_call" &&
          (doneItem.call_id !== addedItem.call_id ||
            doneItem.name !== addedItem.name)) ||
        (typeof doneItem.id === "string" &&
          state.itemIndexById.get(doneItem.id) !== outputIndex) ||
        (typeof doneItem.call_id === "string" &&
          state.callIndexById.get(doneItem.call_id) !== outputIndex)
      ) {
        malformed();
      }
      break;
    }
    case "response.content_part.added":
    case "response.content_part.done":
      if (
        !validOutputIndex ||
        !state.rawItems.has(outputIndex as number) ||
        !Number.isSafeInteger(parsed.content_index) ||
        (parsed.content_index as number) < 0 ||
        (parsed.content_index as number) >= maxSparseIndex ||
        (parsed.item_id !== undefined &&
          parsed.item_id !== state.rawItems.get(outputIndex as number)?.id) ||
        !parsed.part ||
        typeof parsed.part !== "object" ||
        Array.isArray(parsed.part)
      ) {
        malformed();
      }
      break;
    case "response.output_text.delta":
      if (!validOutputIndex || typeof parsed.delta !== "string") malformed();
      if (item?.type !== "text") malformed();
      break;
    case "response.output_text.done":
      if (!validOutputIndex || typeof parsed.text !== "string") malformed();
      if (item?.type !== "text") malformed();
      break;
    case "response.refusal.delta":
      if (!validOutputIndex || typeof parsed.delta !== "string") malformed();
      if (item?.type !== "text") malformed();
      break;
    case "response.refusal.done":
      if (!validOutputIndex || typeof parsed.refusal !== "string") malformed();
      if (item?.type !== "text") malformed();
      break;
    case "response.function_call_arguments.delta":
      if (!validOutputIndex || typeof parsed.delta !== "string") malformed();
      if (item?.type !== "tool_use") malformed();
      break;
    case "response.function_call_arguments.done":
      if (!validOutputIndex || typeof parsed.arguments !== "string")
        malformed();
      if (item?.type !== "tool_use") malformed();
      break;
  }
}

/** `public` enforces OpenAI's lifecycle; `codex` validates ChatGPT's sparse variant. */
export type ResponsesValidationMode = "public" | "codex";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function malformedResponsesEvent(): never {
  throw new Error("malformed Responses stream event");
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function reconcileCodexIdentity(earlier: unknown, final: unknown): string {
  const earlierValue = isNonEmptyString(earlier) ? earlier : "";
  const finalValue = isNonEmptyString(final) ? final : "";
  if (earlierValue && finalValue && earlierValue !== finalValue) {
    malformedResponsesEvent();
  }
  return finalValue || earlierValue;
}

function codexItemKind(
  item: Record<string, unknown>,
): "text" | "tool_use" | null {
  if (item.type === "message") return "text";
  if (item.type === "function_call") return "tool_use";
  return null;
}

function codexEventItemKind(event: string): "text" | "tool_use" | null {
  if (
    event === "response.output_text.delta" ||
    event === "response.output_text.done" ||
    event === "response.refusal.delta" ||
    event === "response.refusal.done" ||
    event === "response.content_part.added" ||
    event === "response.content_part.done"
  ) {
    return "text";
  }
  if (
    event === "response.function_call_arguments.delta" ||
    event === "response.function_call_arguments.done"
  ) {
    return "tool_use";
  }
  return null;
}

function responsesEventHasSemanticContent(
  event: string,
  parsed: Record<string, unknown>,
): boolean {
  if (
    event === "response.output_item.added" ||
    event === "response.output_item.done"
  ) {
    const item = isRecord(parsed.item) ? parsed.item : undefined;
    if (item?.type === "function_call") return true;
    if (item?.type === "message" && Array.isArray(item.content)) {
      return item.content.some(
        (part) =>
          isRecord(part) &&
          ((typeof part.text === "string" && part.text.length > 0) ||
            (typeof part.refusal === "string" && part.refusal.length > 0)),
      );
    }
  }
  if (
    event === "response.output_text.delta" ||
    event === "response.output_text.done" ||
    event === "response.refusal.delta" ||
    event === "response.refusal.done" ||
    event === "response.function_call_arguments.delta" ||
    event === "response.function_call_arguments.done"
  ) {
    return [parsed.delta, parsed.text, parsed.refusal, parsed.arguments].some(
      (value) => typeof value === "string" && value.length > 0,
    );
  }
  if (event.startsWith("response.reasoning")) {
    const part = isRecord(parsed.part) ? parsed.part : undefined;
    return [parsed.delta, parsed.text, parsed.summary_text, part?.text].some(
      (value) => typeof value === "string" && value.length > 0,
    );
  }
  return false;
}

function nextResponsesOutputIndex(
  state: ResponsesAccState,
  maxSparseIndex: number,
): number {
  let index = state.nextOutputIndex;
  while (index < maxSparseIndex && state.rawItems.has(index)) index += 1;
  if (index >= maxSparseIndex) malformedResponsesEvent();
  state.nextOutputIndex = index + 1;
  return index;
}

function findResponsesItemById(
  state: ResponsesAccState,
  itemId: string,
): number | undefined {
  return state.itemIndexById.get(itemId);
}

function bindResponsesIdentity(
  index: Map<string, number>,
  identity: string,
  outputIndex: number,
): void {
  const existingIndex = index.get(identity);
  if (existingIndex !== undefined && existingIndex !== outputIndex) {
    malformedResponsesEvent();
  }
  index.set(identity, outputIndex);
}

function codexItemSet(
  state: ResponsesAccState,
  kind: "text" | "tool_use",
  unbound = false,
): Set<number> {
  if (kind === "text") {
    return unbound ? state.unboundTextItems : state.activeTextItems;
  }
  return unbound ? state.unboundToolItems : state.activeToolItems;
}

function soleCodexItem(items: Set<number>): number | undefined {
  return items.size === 1 ? items.values().next().value : undefined;
}

function bindCodexEffectiveToolIdentity(
  state: ResponsesAccState,
  outputIndex: number,
  identity: string,
  previousIdentity?: string,
): void {
  const normalized = state.items.get(outputIndex);
  if (normalized?.type !== "tool_use" || !identity) {
    malformedResponsesEvent();
  }
  const previous = previousIdentity ?? (normalized.callId || normalized.id);
  if (
    previous &&
    previous !== identity &&
    state.effectiveToolIndexById.get(previous) === outputIndex
  ) {
    state.effectiveToolIndexById.delete(previous);
  }
  bindResponsesIdentity(state.effectiveToolIndexById, identity, outputIndex);
}

function validateCodexOutputItem(
  event: "response.output_item.added" | "response.output_item.done",
  item: unknown,
): asserts item is Record<string, unknown> {
  if (!isRecord(item) || typeof item.type !== "string") {
    malformedResponsesEvent();
  }
  for (const field of ["id", "status"] as const) {
    if (item[field] !== undefined && typeof item[field] !== "string") {
      malformedResponsesEvent();
    }
  }
  if (
    event === "response.output_item.added" &&
    item.status !== undefined &&
    item.status !== "in_progress"
  ) {
    malformedResponsesEvent();
  }
  if (
    event === "response.output_item.done" &&
    item.status !== undefined &&
    item.status !== "completed" &&
    item.status !== "incomplete"
  ) {
    malformedResponsesEvent();
  }
  if (item.type === "message" && item.content !== undefined) {
    if (!Array.isArray(item.content)) malformedResponsesEvent();
    for (const part of item.content) {
      if (!isRecord(part)) malformedResponsesEvent();
      if (part.type !== undefined && typeof part.type !== "string") {
        malformedResponsesEvent();
      }
      if (
        part.type === "output_text" &&
        part.text !== undefined &&
        typeof part.text !== "string"
      ) {
        malformedResponsesEvent();
      }
      if (
        part.type === "refusal" &&
        part.refusal !== undefined &&
        typeof part.refusal !== "string"
      ) {
        malformedResponsesEvent();
      }
    }
  }
  if (item.type === "function_call") {
    for (const field of ["call_id", "name", "arguments"] as const) {
      if (item[field] !== undefined && typeof item[field] !== "string") {
        malformedResponsesEvent();
      }
    }
  }
}

function createImplicitCodexItem(
  state: ResponsesAccState,
  outputIndex: number,
  itemId: string,
  kind: "text" | "tool_use",
): void {
  const item =
    kind === "text"
      ? { type: "message", id: itemId, role: "assistant" }
      : {
          type: "function_call",
          id: itemId,
          call_id: "",
          name: "",
          arguments: "",
        };
  applyResponsesEvent(state, "response.output_item.added", {
    output_index: outputIndex,
    item,
  });
  bindResponsesIdentity(state.itemIndexById, itemId, outputIndex);
}

function bindCodexItemId(
  state: ResponsesAccState,
  outputIndex: number,
  itemId: string,
): void {
  bindResponsesIdentity(state.itemIndexById, itemId, outputIndex);
  state.unboundTextItems.delete(outputIndex);
  state.unboundToolItems.delete(outputIndex);
  const rawItem = state.rawItems.get(outputIndex);
  if (!rawItem) malformedResponsesEvent();
  if (isNonEmptyString(rawItem.id) && rawItem.id !== itemId) {
    malformedResponsesEvent();
  }
  rawItem.id = itemId;
  const normalized = state.items.get(outputIndex);
  if (normalized) {
    if (isNonEmptyString(normalized.id) && normalized.id !== itemId) {
      malformedResponsesEvent();
    }
    normalized.id = itemId;
    if (normalized.type === "tool_use" && !normalized.callId) {
      bindCodexEffectiveToolIdentity(state, outputIndex, itemId);
    }
  }
}

function reconcileCodexDoneItem(
  state: ResponsesAccState,
  outputIndex: number,
  item: Record<string, unknown>,
): void {
  const existing = state.rawItems.get(outputIndex);
  if (!existing) malformedResponsesEvent();

  const itemId = reconcileCodexIdentity(existing.id, item.id);
  if (itemId) bindCodexItemId(state, outputIndex, itemId);
  if (itemId || existing.id !== undefined || item.id !== undefined) {
    item.id = itemId;
  }

  if (item.type !== "function_call") return;
  const normalized = state.items.get(outputIndex);
  if (normalized?.type !== "tool_use") malformedResponsesEvent();

  const previousEffectiveIdentity = normalized.callId || normalized.id;
  normalized.callId = reconcileCodexIdentity(normalized.callId, item.call_id);
  if (normalized.callId) {
    bindResponsesIdentity(state.callIndexById, normalized.callId, outputIndex);
    bindCodexEffectiveToolIdentity(
      state,
      outputIndex,
      normalized.callId,
      previousEffectiveIdentity,
    );
  }
  normalized.name = reconcileCodexIdentity(normalized.name, item.name);
  if (
    state.argumentDoneItems.has(outputIndex) &&
    item.arguments !== undefined &&
    item.arguments !== normalized.args
  ) {
    malformedResponsesEvent();
  }
  if (item.arguments !== undefined) {
    normalized.args = item.arguments as string;
  }

  // Keep the final raw item complete when ChatGPT omits fields that were
  // already established by sparse added/delta events.
  item.call_id = normalized.callId;
  item.name = normalized.name;
  item.arguments = normalized.args;
}

function normalizeCodexDataEvent(
  state: ResponsesAccState,
  event: string,
  parsed: Record<string, unknown>,
  maxSparseIndex: number,
): void {
  const kind = codexEventItemKind(event);
  if (!kind) return;

  const providedIndex = parsed.output_index as number | undefined;
  const itemId = parsed.item_id as string | undefined;
  const itemIndex =
    itemId !== undefined ? findResponsesItemById(state, itemId) : undefined;
  if (
    providedIndex !== undefined &&
    itemIndex !== undefined &&
    providedIndex !== itemIndex
  ) {
    malformedResponsesEvent();
  }

  let outputIndex = providedIndex ?? itemIndex;
  if (outputIndex === undefined && itemId !== undefined) {
    const unbound = soleCodexItem(codexItemSet(state, kind, true));
    if (unbound !== undefined) {
      outputIndex = unbound;
      bindCodexItemId(state, outputIndex, itemId);
    } else {
      outputIndex = nextResponsesOutputIndex(state, maxSparseIndex);
      createImplicitCodexItem(state, outputIndex, itemId, kind);
    }
  } else if (outputIndex === undefined) {
    outputIndex = soleCodexItem(codexItemSet(state, kind));
    if (outputIndex === undefined) malformedResponsesEvent();
  }

  const normalized = state.items.get(outputIndex);
  if (!normalized) {
    if (itemId === undefined || state.rawItems.has(outputIndex)) {
      malformedResponsesEvent();
    }
    createImplicitCodexItem(state, outputIndex, itemId, kind);
  } else if (normalized.type !== kind) {
    malformedResponsesEvent();
  } else if (itemId !== undefined) {
    bindCodexItemId(state, outputIndex, itemId);
  }
  parsed.output_index = outputIndex;
}

function normalizeCodexItemEvent(
  state: ResponsesAccState,
  event: "response.output_item.added" | "response.output_item.done",
  parsed: Record<string, unknown>,
  maxSparseIndex: number,
): void {
  validateCodexOutputItem(event, parsed.item);
  const item = parsed.item;
  if (
    isNonEmptyString(parsed.item_id) &&
    isNonEmptyString(item.id) &&
    parsed.item_id !== item.id
  ) {
    malformedResponsesEvent();
  }
  if (!isNonEmptyString(item.id) && isNonEmptyString(parsed.item_id)) {
    item.id = parsed.item_id;
  }

  const itemId = isNonEmptyString(item.id) ? item.id : undefined;
  const itemIndex =
    itemId !== undefined ? findResponsesItemById(state, itemId) : undefined;
  const providedIndex = parsed.output_index as number | undefined;
  if (
    providedIndex !== undefined &&
    itemIndex !== undefined &&
    providedIndex !== itemIndex
  ) {
    malformedResponsesEvent();
  }

  let outputIndex = providedIndex ?? itemIndex;
  const kind = codexItemKind(item);
  if (
    outputIndex === undefined &&
    event === "response.output_item.done" &&
    kind
  ) {
    if (itemId === undefined) {
      outputIndex = soleCodexItem(codexItemSet(state, kind));
    } else {
      const unbound = soleCodexItem(codexItemSet(state, kind, true));
      if (unbound !== undefined) {
        outputIndex = unbound;
        bindCodexItemId(state, outputIndex, itemId);
      } else if (codexItemSet(state, kind).size > 0) {
        malformedResponsesEvent();
      }
    }
  }
  outputIndex ??= nextResponsesOutputIndex(state, maxSparseIndex);

  const existing = state.rawItems.get(outputIndex);
  if (event === "response.output_item.added" && existing) {
    malformedResponsesEvent();
  }
  if (event === "response.output_item.done" && existing) {
    if (
      existing.type !== item.type ||
      (isNonEmptyString(existing.id) &&
        isNonEmptyString(item.id) &&
        existing.id !== item.id)
    ) {
      malformedResponsesEvent();
    }
  } else if (event === "response.output_item.done") {
    const seedItem = { ...item };
    delete seedItem.content;
    applyResponsesEvent(state, "response.output_item.added", {
      output_index: outputIndex,
      item: seedItem,
    });
  }
  if (event === "response.output_item.done") {
    reconcileCodexDoneItem(state, outputIndex, item);
  } else {
    if (itemId) {
      bindResponsesIdentity(state.itemIndexById, itemId, outputIndex);
      state.unboundTextItems.delete(outputIndex);
      state.unboundToolItems.delete(outputIndex);
    }
    if (item.type === "function_call" && isNonEmptyString(item.call_id)) {
      bindResponsesIdentity(state.callIndexById, item.call_id, outputIndex);
    }
  }
  parsed.output_index = outputIndex;
}

function validateCodexResponsesEvent(
  state: ResponsesAccState,
  event: string,
  parsed: Record<string, unknown>,
  maxSparseIndex: number,
): void {
  if (parsed.type !== undefined && parsed.type !== event) {
    malformedResponsesEvent();
  }
  if (
    parsed.output_index !== undefined &&
    (!Number.isSafeInteger(parsed.output_index) ||
      (parsed.output_index as number) < 0 ||
      (parsed.output_index as number) >= maxSparseIndex)
  ) {
    malformedResponsesEvent();
  }
  if (
    parsed.content_index !== undefined &&
    (!Number.isSafeInteger(parsed.content_index) ||
      (parsed.content_index as number) < 0 ||
      (parsed.content_index as number) >= maxSparseIndex)
  ) {
    malformedResponsesEvent();
  }
  if (
    parsed.sequence_number !== undefined &&
    (!Number.isSafeInteger(parsed.sequence_number) ||
      (parsed.sequence_number as number) < 0)
  ) {
    malformedResponsesEvent();
  }
  if (parsed.item_id !== undefined && typeof parsed.item_id !== "string") {
    malformedResponsesEvent();
  }

  if (
    event === "response.created" ||
    event === "response.in_progress" ||
    event === "response.failed" ||
    event === "response.completed" ||
    event === "response.incomplete" ||
    event === "response.done"
  ) {
    if (!isRecord(parsed.response)) {
      throw new Error("malformed Responses terminal event");
    }
    const response = parsed.response;
    for (const field of ["id", "model", "status"] as const) {
      if (
        response[field] !== undefined &&
        typeof response[field] !== "string"
      ) {
        throw new Error("malformed Responses terminal event");
      }
    }
    if (state.id && response.id !== undefined && response.id !== state.id) {
      throw new Error("malformed Responses terminal event");
    }
    if (
      state.model &&
      response.model !== undefined &&
      response.model !== state.model
    ) {
      throw new Error("malformed Responses terminal event");
    }
    if (
      event === "response.created" &&
      response.status !== undefined &&
      response.status !== "in_progress" &&
      response.status !== "queued"
    ) {
      malformedResponsesEvent();
    }
    if (
      event === "response.in_progress" &&
      response.status !== undefined &&
      response.status !== "in_progress"
    ) {
      malformedResponsesEvent();
    }
  }

  switch (event) {
    case "response.output_item.added":
    case "response.output_item.done":
      normalizeCodexItemEvent(state, event, parsed, maxSparseIndex);
      break;
    case "response.content_part.added":
    case "response.content_part.done":
      if (!isRecord(parsed.part)) malformedResponsesEvent();
      normalizeCodexDataEvent(state, event, parsed, maxSparseIndex);
      break;
    case "response.output_text.delta":
      if (typeof parsed.delta !== "string") malformedResponsesEvent();
      normalizeCodexDataEvent(state, event, parsed, maxSparseIndex);
      break;
    case "response.output_text.done":
      if (typeof parsed.text !== "string") malformedResponsesEvent();
      normalizeCodexDataEvent(state, event, parsed, maxSparseIndex);
      break;
    case "response.refusal.delta":
      if (typeof parsed.delta !== "string") malformedResponsesEvent();
      normalizeCodexDataEvent(state, event, parsed, maxSparseIndex);
      break;
    case "response.refusal.done":
      if (typeof parsed.refusal !== "string") malformedResponsesEvent();
      normalizeCodexDataEvent(state, event, parsed, maxSparseIndex);
      break;
    case "response.function_call_arguments.delta":
      if (typeof parsed.delta !== "string") malformedResponsesEvent();
      normalizeCodexDataEvent(state, event, parsed, maxSparseIndex);
      break;
    case "response.function_call_arguments.done":
      if (typeof parsed.arguments !== "string") malformedResponsesEvent();
      normalizeCodexDataEvent(state, event, parsed, maxSparseIndex);
      break;
  }
}

function validatedTerminalStatus(
  event: "response.completed" | "response.done" | "response.incomplete",
  parsed: Record<string, unknown>,
  validation: ResponsesValidationMode,
): string {
  const terminal = parsed.response as Record<string, unknown> | undefined;
  if (!terminal || typeof terminal !== "object" || Array.isArray(terminal)) {
    throw new Error("malformed Responses terminal event");
  }
  if (terminal.status !== undefined && typeof terminal.status !== "string") {
    throw new Error("malformed Responses terminal event");
  }
  const rawDetails = terminal.incomplete_details;
  if (
    rawDetails !== undefined &&
    rawDetails !== null &&
    !isRecord(rawDetails)
  ) {
    throw new Error("malformed Responses terminal event");
  }
  const details = isRecord(rawDetails) ? rawDetails : null;
  if (details?.reason !== undefined && typeof details.reason !== "string") {
    throw new Error("malformed Responses terminal event");
  }
  let status = typeof terminal.status === "string" ? terminal.status : null;
  if (validation === "public" && (status === null || status === "")) {
    throw new Error("missing Responses compatibility terminal status");
  }
  if (status === null) {
    status = event === "response.incomplete" ? "incomplete" : "completed";
  }
  if (status === "failed" || status === "cancelled") {
    throw new Error("Responses terminal reported failure");
  }
  const valid =
    validation === "public"
      ? event === "response.completed"
        ? status === "completed"
        : event === "response.incomplete"
          ? status === "incomplete"
          : status === "completed" || status === "incomplete"
      : event === "response.completed"
        ? status === "completed" || status === "incomplete"
        : event === "response.incomplete"
          ? status === "incomplete"
          : status === "completed" || status === "incomplete";
  if (!valid) throw new Error("Responses terminal event/status mismatch");
  if (status === "incomplete") {
    if (validation === "public") {
      if (
        details?.reason !== undefined &&
        details.reason !== "max_output_tokens" &&
        details.reason !== "content_filter"
      ) {
        throw new Error("malformed Responses terminal event");
      }
    }
  }
  return status;
}

function validateFailureTerminal(parsed: Record<string, unknown>): void {
  if (!isRecord(parsed.response) || parsed.response.status !== "failed") {
    throw new Error("malformed Responses terminal event");
  }
  const error = parsed.response.error;
  if (error !== undefined && error !== null) {
    if (!isRecord(error)) throw new Error("malformed Responses terminal event");
    for (const field of ["type", "code", "message"] as const) {
      if (error[field] !== undefined && typeof error[field] !== "string") {
        throw new Error("malformed Responses terminal event");
      }
    }
  }
}

/**
 * Accumulate an OpenAI Responses API SSE stream into a GatewayResponse.
 *
 * Consumes the upstream Response body and returns the accumulated result.
 */
export async function accumulateResponsesSSEStream(
  response: Response,
  opts: {
    /** Omit to preserve the legacy tolerant accumulator behavior. */
    validation?: ResponsesValidationMode;
    stopAtTerminal?: boolean;
    signal?: AbortSignal;
    inactivityMs?: number;
    maxFrames?: number;
    onSemanticContent?: () => void;
    /** Called only after the event has passed strict validation and mutation. */
    onValidatedEvent?: (event: string, data: string) => void | Promise<void>;
    /** Passthrough clients must receive a provider's valid failure terminal. */
    allowFailureTerminal?: boolean;
    /** Internal state injection used by validated true passthrough. */
    state?: ResponsesAccState;
    onReader?: (reader: ReadableStreamDefaultReader<Uint8Array>) => void;
  } = {},
): Promise<GatewayResponse> {
  const state = opts.state ?? makeResponsesAccState();
  let terminalStatus: string | null = null;
  const doneItems = new Set<number>();
  const activeContentParts = new Set<string>();
  const doneContentParts = new Set<string>();
  const activeContentIndexByItem = new Map<number, number>();
  const implicitContentIndexByItem = new Map<number, number>();
  const terminalContentIndexByItem = new Map<number, number>();
  const terminalContentParts = new Map<string, "text" | "refusal">();
  let lastSequenceNumber = -1;
  // Sparse numeric identities can never need more address space than the
  // number of frames we are willing to process. Cap even a caller-supplied
  // frame override at the production ceiling so arithmetic remains practical
  // and `index + 1` always changes the value.
  const maxSparseIndex = Math.min(
    opts.maxFrames ?? DEFAULT_MAX_SSE_FRAMES,
    DEFAULT_MAX_SSE_FRAMES,
  );

  if (!response.body) {
    throw new Error("Response has no body");
  }
  const reader = response.body.getReader();
  opts.onReader?.(reader);

  try {
    for await (const { event, data } of parseSSEStream(reader, {
      signal: opts.signal,
      inactivityMs: opts.inactivityMs,
      requireEventTerminator: opts.validation !== undefined,
      maxFrames: opts.validation
        ? (opts.maxFrames ?? DEFAULT_MAX_SSE_FRAMES)
        : opts.maxFrames,
      maxTotalBytes: opts.validation ? 4 * 1024 * 1024 : undefined,
      fatalUtf8: opts.validation !== undefined,
    })) {
      // Some Responses API implementations send untyped `data:` lines
      // without `event:` — skip those.
      if (!data || data === "[DONE]") continue;

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(data) as Record<string, unknown>;
      } catch {
        if (opts.validation) {
          throw new Error("malformed Responses stream event");
        }
        continue;
      }

      if (opts.validation && !isRecord(parsed)) {
        throw new Error("malformed Responses stream event");
      }
      if (
        opts.onSemanticContent &&
        responsesEventHasSemanticContent(event, parsed)
      ) {
        opts.onSemanticContent();
      }
      if (
        opts.validation &&
        event === "response.failed" &&
        !opts.allowFailureTerminal
      ) {
        throw new Error("response.failed terminal");
      }
      if (opts.validation === "public") {
        validatePublicResponsesEvent(state, event, parsed, maxSparseIndex);
      } else if (opts.validation === "codex") {
        validateCodexResponsesEvent(state, event, parsed, maxSparseIndex);
      }
      if (opts.validation && event === "response.failed") {
        validateFailureTerminal(parsed);
      }
      if (opts.validation && event === "response.output_item.done") {
        const outputIndex = parsed.output_index as number;
        const normalized = state.items.get(outputIndex);
        const doneItem = parsed.item as Record<string, unknown>;
        if (
          normalized?.type === "tool_use" &&
          state.argumentDoneItems.has(outputIndex) &&
          doneItem.arguments !== normalized.args
        ) {
          throw new Error("malformed Responses stream event");
        }
        if (normalized?.type === "text" && Array.isArray(doneItem.content)) {
          for (const part of doneItem.content) {
            if (!isRecord(part)) continue;
            if (
              part.type === "output_text" &&
              state.textDoneItems.has(outputIndex) &&
              part.text !== normalized.text
            ) {
              throw new Error("malformed Responses stream event");
            }
            if (
              part.type === "refusal" &&
              state.refusalDoneItems.has(outputIndex) &&
              part.refusal !== normalized.refusal
            ) {
              throw new Error("malformed Responses stream event");
            }
          }
        }
      }
      if (opts.validation && parsed.sequence_number !== undefined) {
        const sequenceNumber = parsed.sequence_number as number;
        if (sequenceNumber <= lastSequenceNumber) {
          throw new Error("malformed Responses stream event");
        }
        lastSequenceNumber = sequenceNumber;
      }
      if (
        opts.validation &&
        event === "response.output_item.done" &&
        doneItems.has(parsed.output_index as number)
      ) {
        throw new Error("malformed Responses stream event");
      }
      if (
        opts.validation &&
        doneItems.has(parsed.output_index as number) &&
        (event === "response.output_text.delta" ||
          event === "response.output_text.done" ||
          event === "response.refusal.delta" ||
          event === "response.refusal.done" ||
          event === "response.function_call_arguments.delta" ||
          event === "response.function_call_arguments.done" ||
          event === "response.content_part.added" ||
          event === "response.content_part.done")
      ) {
        throw new Error("malformed Responses stream event");
      }
      if (
        opts.validation &&
        parsed.content_index === undefined &&
        (event === "response.content_part.added" ||
          event === "response.content_part.done" ||
          event === "response.output_text.delta" ||
          event === "response.output_text.done" ||
          event === "response.refusal.delta" ||
          event === "response.refusal.done")
      ) {
        const outputIndex = parsed.output_index as number;
        parsed.content_index =
          activeContentIndexByItem.get(outputIndex) ??
          implicitContentIndexByItem.get(outputIndex) ??
          terminalContentIndexByItem.get(outputIndex) ??
          0;
      }
      if (
        opts.validation &&
        (event === "response.content_part.added" ||
          event === "response.content_part.done")
      ) {
        const outputIndex = parsed.output_index as number;
        const contentIndex = parsed.content_index as number;
        const key = `${outputIndex}:${contentIndex}`;
        if (event === "response.content_part.added") {
          if (
            activeContentParts.has(key) ||
            doneContentParts.has(key) ||
            activeContentIndexByItem.has(outputIndex)
          ) {
            throw new Error("malformed Responses stream event");
          }
          activeContentParts.add(key);
          activeContentIndexByItem.set(outputIndex, contentIndex);
        } else {
          if (
            !activeContentParts.delete(key) ||
            activeContentIndexByItem.get(outputIndex) !== contentIndex
          ) {
            throw new Error("malformed Responses stream event");
          }
          activeContentIndexByItem.delete(outputIndex);
          doneContentParts.add(key);
          const part = parsed.part as Record<string, unknown>;
          const terminalKind =
            part.type === "output_text"
              ? "text"
              : part.type === "refusal"
                ? "refusal"
                : undefined;
          if (terminalKind) {
            const normalized = state.items.get(outputIndex);
            const terminalValue =
              terminalKind === "text" ? part.text : part.refusal;
            const accumulatedValue =
              normalized?.type === "text"
                ? terminalKind === "text"
                  ? normalized.text
                  : normalized.refusal
                : undefined;
            const alreadyDone =
              terminalKind === "text"
                ? state.textDoneItems.has(outputIndex)
                : state.refusalDoneItems.has(outputIndex);
            if (alreadyDone && terminalValue !== accumulatedValue) {
              throw new Error("malformed Responses stream event");
            }
            const existingKind = terminalContentParts.get(key);
            if (existingKind && existingKind !== terminalKind) {
              throw new Error("malformed Responses stream event");
            }
            terminalContentParts.set(key, terminalKind);
            terminalContentIndexByItem.set(outputIndex, contentIndex);
          }
        }
      }
      if (
        opts.validation &&
        Number.isSafeInteger(parsed.content_index) &&
        (event === "response.output_text.delta" ||
          event === "response.output_text.done" ||
          event === "response.refusal.delta" ||
          event === "response.refusal.done")
      ) {
        const outputIndex = parsed.output_index as number;
        const contentIndex = parsed.content_index as number;
        const expected =
          activeContentIndexByItem.get(outputIndex) ??
          implicitContentIndexByItem.get(outputIndex);
        if (expected !== undefined && expected !== contentIndex) {
          throw new Error("malformed Responses stream event");
        }
        implicitContentIndexByItem.set(outputIndex, contentIndex);
        const key = `${outputIndex}:${contentIndex}`;
        if (terminalContentParts.has(key)) {
          throw new Error("malformed Responses stream event");
        }
        if (
          event === "response.output_text.done" ||
          event === "response.refusal.done"
        ) {
          terminalContentParts.set(
            key,
            event === "response.output_text.done" ? "text" : "refusal",
          );
          terminalContentIndexByItem.set(outputIndex, contentIndex);
          implicitContentIndexByItem.delete(outputIndex);
        }
      }
      if (
        opts.validation &&
        (event === "response.function_call_arguments.delta" ||
          event === "response.function_call_arguments.done")
      ) {
        const outputIndex = parsed.output_index as number;
        if (state.argumentDoneItems.has(outputIndex)) {
          throw new Error("malformed Responses stream event");
        }
        if (event === "response.function_call_arguments.done") {
          state.argumentDoneItems.add(outputIndex);
        }
      }
      if (
        opts.validation &&
        event === "response.output_item.done" &&
        activeContentIndexByItem.has(parsed.output_index as number)
      ) {
        throw new Error("malformed Responses stream event");
      }
      applyResponsesEvent(state, event, parsed);
      if (event === "response.output_text.done") {
        state.textDoneItems.add(parsed.output_index as number);
      } else if (event === "response.refusal.done") {
        state.refusalDoneItems.add(parsed.output_index as number);
      }
      if (
        opts.validation === "codex" &&
        event === "response.output_item.added"
      ) {
        const outputIndex = parsed.output_index as number;
        const item = state.items.get(outputIndex);
        if (item?.type === "tool_use" && (item.callId || item.id)) {
          bindCodexEffectiveToolIdentity(
            state,
            outputIndex,
            item.callId || item.id,
          );
        }
      }
      if (event === "response.output_item.done") {
        const outputIndex = parsed.output_index as number;
        doneItems.add(outputIndex);
        state.activeTextItems.delete(outputIndex);
        state.activeToolItems.delete(outputIndex);
        state.unboundTextItems.delete(outputIndex);
        state.unboundToolItems.delete(outputIndex);
      }
      if (
        event === "response.completed" ||
        event === "response.done" ||
        event === "response.incomplete" ||
        (opts.allowFailureTerminal && event === "response.failed")
      ) {
        const terminal = parsed.response as Record<string, unknown> | undefined;
        if (opts.validation && terminal?.output !== undefined) {
          if (!Array.isArray(terminal.output)) {
            throw new Error("malformed Responses terminal event");
          }
          const snapshotIndices = new Set<number>();
          for (const snapshot of terminal.output) {
            if (!isRecord(snapshot) || !isNonEmptyString(snapshot.id)) {
              throw new Error("malformed Responses terminal event");
            }
            const outputIndex = state.itemIndexById.get(snapshot.id);
            const accumulated =
              outputIndex === undefined
                ? undefined
                : state.rawItems.get(outputIndex);
            if (
              outputIndex === undefined ||
              !doneItems.has(outputIndex) ||
              snapshotIndices.has(outputIndex) ||
              !accumulated ||
              (snapshot.type !== "item_reference" &&
                snapshot.type !== accumulated.type)
            ) {
              throw new Error("malformed Responses terminal event");
            }
            snapshotIndices.add(outputIndex);
            for (const field of [
              "call_id",
              "name",
              "arguments",
              "content",
            ] as const) {
              if (
                snapshot[field] !== undefined &&
                JSON.stringify(snapshot[field]) !==
                  JSON.stringify(accumulated[field])
              ) {
                throw new Error("malformed Responses terminal event");
              }
            }
          }
          if (
            snapshotIndices.size !== doneItems.size ||
            Array.from(doneItems).some((index) => !snapshotIndices.has(index))
          ) {
            throw new Error("malformed Responses terminal event");
          }
        }
        terminalStatus = opts.validation
          ? event === "response.failed"
            ? "failed"
            : validatedTerminalStatus(event, parsed, opts.validation)
          : typeof terminal?.status === "string"
            ? terminal.status
            : null;
        if (
          opts.validation === "public" &&
          terminalStatus === "completed" &&
          terminal?.output === undefined
        ) {
          throw new Error("malformed Responses terminal event");
        }
        if (
          opts.validation &&
          terminalStatus === "incomplete" &&
          state.stopReason === "end_turn"
        ) {
          state.stopReason = mapStatusToStopReason(terminalStatus);
        }
        if (
          opts.validation === "public" &&
          doneItems.size !== state.rawItems.size
        ) {
          throw new Error("incomplete Responses output lifecycle");
        }
        if (opts.validation && activeContentParts.size > 0) {
          throw new Error("incomplete Responses output lifecycle");
        }
        if (opts.validation === "codex") {
          for (const item of state.items.values()) {
            if (item.type === "tool_use" && !(item.callId || item.id)) {
              throw new Error("malformed Responses stream event");
            }
          }
        }
        // The first semantic terminal is authoritative. Any bytes already
        // delivered after it are transport tail and are discarded on cancel.
        await opts.onValidatedEvent?.(event, data);
        if (opts.stopAtTerminal) break;
        continue;
      }
      if (event !== "message") await opts.onValidatedEvent?.(event, data);
    }
  } finally {
    cancelAndReleaseReader(reader);
  }

  if (opts.validation && !terminalStatus) {
    throw new Error("missing terminal response status");
  }

  return finalizeResponsesAcc(state);
}

// ---------------------------------------------------------------------------
// True pass-through streamer (Responses upstream → Responses client)
// ---------------------------------------------------------------------------

/**
 * Serialize a parsed SSE event back to wire form, preserving the original data
 * payload (multi-line `data:` payloads are re-prefixed per line so nothing is
 * dropped or re-serialized — `reasoning_summary`, content_part annotations,
 * etc. survive intact because we forward the original `data` string).
 */
export function formatResponsesEvent(event: string, data: string): string {
  const dataLines = data
    .split("\n")
    .map((line) => `data: ${line}`)
    .join("\n");
  return `event: ${event}\n${dataLines}\n\n`;
}

/**
 * Stream an OpenAI Responses API upstream straight through to a Responses-API
 * client, forwarding each SSE event as it arrives while accumulating a complete
 * `GatewayResponse` in parallel.
 *
 * True-streaming counterpart to `accumulateResponsesSSEStream` (which buffers
 * the ENTIRE upstream before the client sees a byte — the cause of the
 * codex/ChatGPT "waiting for response headers" hang, since ChatGPT's
 * `/backend-api/codex/responses` reasoning turns are slow-to-first-token).
 *
 * Safe ONLY when no `recall` tool_use can appear in the stream (the caller
 * gates on recall-tool absence): recall interception requires buffering so the
 * injected tool_use never leaks to the client. When the recall tool is present
 * the caller keeps the buffered `accumulateResponsesSSEStream` path.
 *
 * `onComplete` is invoked exactly once with the accumulated response when the
 * upstream stream ends, mirroring the Anthropic `buildStreamingResponse`
 * contract so `postResponse` (cost/calibration/temporal) runs identically.
 */
export function streamResponsesPassthrough(
  upstreamResponse: Response,
  onComplete: (response: GatewayResponse) => void,
  sessionID?: string,
  validation: ResponsesValidationMode = "public",
  signal?: AbortSignal,
): Response {
  const state = makeResponsesAccState();
  const encoder = new TextEncoder();

  let downstreamCancelled = false;
  let externalAborted = false;
  const cancelController = new AbortController();
  let activeReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let resumeDemand: (() => void) | undefined;
  let pumpStarted = false;
  const onAbort = () => {
    externalAborted = true;
    resumeDemand?.();
    resumeDemand = undefined;
    cancelController.abort(signal?.reason);
    if (activeReader) cancelAndReleaseReader(activeReader, signal?.reason);
    else if (!pumpStarted)
      void upstreamResponse.body?.cancel(signal?.reason).catch(() => {});
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  const MAX_PASSTHROUGH_RETAINED_BYTES = 4 * 1024 * 1024;
  let retainedBytes = 0;

  // --- Keepalive ---
  // The Responses API has no first-class `ping` event (unlike Anthropic), so we
  // emit an SSE comment line (`: keepalive`), which is spec-compliant and MUST
  // be ignored by any conformant SSE client. Keeps the client↔gateway
  // connection alive during long reasoning pauses (Bun's ~5-min fetch timeout,
  // oven-sh/bun#16682). True streaming emits real bytes frequently, so this
  // only fires during genuine upstream silence.
  const KEEPALIVE_INACTIVITY_MS = 30_000;
  const keepaliveComment = encoder.encode(`: keepalive\n\n`);
  let keepaliveTimer: ReturnType<typeof setTimeout> | null = null;
  let completed = false;
  let terminalForwarded = false;
  const cleanup = (): void => {
    if (keepaliveTimer) clearTimeout(keepaliveTimer);
    keepaliveTimer = null;
    signal?.removeEventListener("abort", onAbort);
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let settled = false;
      const safeEnqueue = (chunk: Uint8Array): boolean => {
        if (downstreamCancelled || settled) return false;
        if (externalAborted) throw signal?.reason;
        try {
          controller.enqueue(chunk);
          return true;
        } catch {
          downstreamCancelled = true;
          return false;
        }
      };
      const waitForDemand = async (): Promise<void> => {
        while (
          !downstreamCancelled &&
          !externalAborted &&
          (controller.desiredSize ?? 1) <= 0
        ) {
          await new Promise<void>((resolve) => {
            resumeDemand = resolve;
          });
        }
        if (externalAborted) throw signal?.reason;
      };
      const safeClose = (): void => {
        if (downstreamCancelled || settled) return;
        settled = true;
        cleanup();
        try {
          controller.close();
        } catch {
          // Already closed/cancelled
        }
      };
      const safeError = (error: unknown): void => {
        if (downstreamCancelled || settled) return;
        settled = true;
        cleanup();
        try {
          controller.error(error);
        } catch {
          // Already closed/cancelled.
        }
      };

      const resetKeepalive = (): void => {
        if (keepaliveTimer) clearTimeout(keepaliveTimer);
        keepaliveTimer = setTimeout(function tick() {
          if (downstreamCancelled || externalAborted || settled) return;
          if ((controller.desiredSize ?? 1) > 0) {
            try {
              safeEnqueue(keepaliveComment);
            } catch (error) {
              safeError(error);
              return;
            }
          }
          keepaliveTimer = setTimeout(tick, KEEPALIVE_INACTIVITY_MS);
        }, KEEPALIVE_INACTIVITY_MS);
      };
      const clearKeepalive = (): void => {
        if (keepaliveTimer) clearTimeout(keepaliveTimer);
        keepaliveTimer = null;
      };

      const finish = (): void => {
        if (completed) return;
        completed = true;
        try {
          onComplete(finalizeResponsesAcc(state));
        } catch (err) {
          log.error("openai-responses passthrough onComplete error:", err);
        }
      };

      const pump = async (): Promise<void> => {
        pumpStarted = true;
        if (downstreamCancelled) return;
        try {
          resetKeepalive();
          const accumulated = await accumulateResponsesSSEStream(
            upstreamResponse,
            {
              validation,
              stopAtTerminal: true,
              signal: cancelController.signal,
              allowFailureTerminal: true,
              state,
              onReader: (reader) => {
                activeReader = reader;
              },
              onValidatedEvent: async (event, data) => {
                resetKeepalive();
                retainedBytes += Buffer.byteLength(data);
                if (retainedBytes > MAX_PASSTHROUGH_RETAINED_BYTES) {
                  throw new Error(
                    "Responses passthrough exceeded retained byte limit",
                  );
                }
                await waitForDemand();
                if (
                  downstreamCancelled ||
                  !safeEnqueue(
                    encoder.encode(formatResponsesEvent(event, data)),
                  )
                ) {
                  throw new DOMException("client disconnected", "AbortError");
                }
                if (
                  event === "response.completed" ||
                  event === "response.done" ||
                  event === "response.incomplete" ||
                  event === "response.failed"
                ) {
                  terminalForwarded = true;
                }
              },
            },
          );
          clearKeepalive();
          if (!completed) {
            completed = true;
            onComplete(accumulated);
          }
          safeClose();
        } catch (err) {
          clearKeepalive();
          if (downstreamCancelled) {
            cleanup();
            return;
          }
          if (externalAborted) {
            safeError(signal?.reason ?? err);
            return;
          }
          log.error(
            `openai-responses passthrough stream error${
              sessionID ? ` (session=${sessionID.slice(0, 16)})` : ""
            }:`,
            err,
          );
          if (terminalForwarded) {
            // The client already received an authoritative terminal. Never emit
            // a contradictory second response.failed because local accounting
            // failed after delivery.
            safeClose();
            return;
          }
          // Emit response.failed so the client doesn't hang waiting for a
          // terminal event, then still run onComplete with what we accumulated.
          await waitForDemand();
          if (downstreamCancelled) {
            cleanup();
            return;
          }
          safeEnqueue(
            encoder.encode(
              formatResponsesEvent(
                "response.failed",
                JSON.stringify({
                  type: "response.failed",
                  response: {
                    id: state.id || "resp_error",
                    object: "response",
                    created_at: Math.floor(Date.now() / 1000),
                    model: state.model,
                    status: "failed",
                    output: [],
                    usage: null,
                    error: {
                      type: "server_error",
                      message:
                        err instanceof Error
                          ? err.message
                          : "upstream stream error",
                    },
                  },
                }),
              ),
            ),
          );
          finish();
          safeClose();
        }
      };
      queueMicrotask(() => void pump().catch((error) => safeError(error)));
    },

    pull() {
      resumeDemand?.();
      resumeDemand = undefined;
    },

    cancel(reason) {
      resumeDemand?.();
      resumeDemand = undefined;
      // Client disconnected — cancel the upstream reader to stop wasting bandwidth
      downstreamCancelled = true;
      cancelController.abort(
        new DOMException("client disconnected", "AbortError"),
      );
      if (keepaliveTimer) clearTimeout(keepaliveTimer);
      cleanup();
      if (activeReader) cancelAndReleaseReader(activeReader, reason);
      else if (!pumpStarted)
        void upstreamResponse.body?.cancel(reason).catch(() => {});
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mapStatusToStopReason(status: string): string {
  switch (status) {
    case "completed":
      return "end_turn";
    case "incomplete":
      return "max_tokens";
    case "cancelled":
      return "stop";
    case "failed":
      return "stop";
    default:
      return "end_turn";
  }
}

// ---------------------------------------------------------------------------
// Anthropic SSE → OpenAI Responses API SSE streaming translator
// ---------------------------------------------------------------------------

/**
 * Translate an Anthropic SSE streaming Response into an OpenAI Responses API
 * SSE streaming Response.
 *
 * Anthropic lifecycle:
 *   message_start → content_block_start → content_block_delta (repeated)
 *   → content_block_stop → message_delta → message_stop
 *
 * Responses API lifecycle:
 *   response.created → response.in_progress →
 *   response.output_item.added → response.content_part.added →
 *   response.output_text.delta (repeated) → response.output_text.done →
 *   response.content_part.done → response.output_item.done →
 *   response.completed
 *
 * The returned Response streams Responses API named SSE events incrementally
 * as upstream Anthropic events arrive.
 */
export function translateAnthropicStreamToResponses(
  anthropicResponse: Response,
  opts: { strict?: boolean; signal?: AbortSignal } = {},
): Response {
  const encoder = new TextEncoder();
  // Reuse the Anthropic accumulator internally so we get a complete
  // GatewayResponse for the final `response.completed` event.
  const accumulator = createStreamAccumulator();

  // State extracted from message_start
  let respId = "";
  let model = "";
  let created = Math.floor(Date.now() / 1000);

  // Output item tracking
  let outputIndex = 0;

  /** Maps Anthropic block index → output-level tracking info. */
  type OutputItem =
    | { kind: "text"; itemId: string; outputIndex: number; text: string }
    | {
        kind: "tool_use";
        itemId: string;
        outputIndex: number;
        callId: string;
        name: string;
        args: string;
      };

  const outputItems = new Map<number, OutputItem>();
  let cancelled = false;
  let activeReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let resumeDemand: (() => void) | undefined;
  let terminalEmitted = false;
  let downstreamSettled = false;

  function emit(eventType: string, data: Record<string, unknown>): string {
    return `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const onAbort = (): void => {
        cancelled = true;
        resumeDemand?.();
        resumeDemand = undefined;
        const reason = opts.signal?.reason;
        if (activeReader) cancelAndReleaseReader(activeReader, reason);
        else void anthropicResponse.body?.cancel(reason).catch(() => {});
        if (!downstreamSettled) {
          downstreamSettled = true;
          try {
            controller.error(reason);
          } catch {
            // Already closed/cancelled.
          }
        }
      };
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      if (opts.signal?.aborted) onAbort();
      const waitForDemand = async (): Promise<void> => {
        while (
          !cancelled &&
          !opts.signal?.aborted &&
          (controller.desiredSize ?? 1) <= 0
        ) {
          await new Promise<void>((resolve) => {
            resumeDemand = resolve;
          });
        }
        opts.signal?.throwIfAborted();
      };
      async function safeEnqueue(chunk: Uint8Array): Promise<boolean> {
        if (cancelled) return false;
        await waitForDemand();
        if (cancelled) return false;
        try {
          controller.enqueue(chunk);
          return true;
        } catch {
          cancelled = true;
          return false;
        }
      }

      const pump = async (): Promise<void> => {
        try {
          if (!anthropicResponse.body) {
            throw new Error("Anthropic response has no body");
          }
          const reader = anthropicResponse.body.getReader();
          activeReader = reader;
          const validator = opts.strict ? new AnthropicSSEValidator() : null;

          for await (const { event, data } of parseSSEStream(reader, {
            signal: opts.signal,
            requireEventTerminator: opts.strict,
            fatalUtf8: opts.strict,
            maxFrames: opts.strict ? DEFAULT_MAX_SSE_FRAMES : undefined,
            maxEventBytes: opts.strict ? 4 * 1024 * 1024 : undefined,
            maxTotalBytes: opts.strict ? 4 * 1024 * 1024 : undefined,
          })) {
            if (cancelled) break;
            validator?.process(event, data);

            // Always feed the accumulator
            accumulator.processEvent(event, data);

            let parsed: Record<string, unknown>;
            try {
              parsed = JSON.parse(data) as Record<string, unknown>;
            } catch {
              continue;
            }

            switch (event) {
              case "message_start": {
                const message = parsed.message as
                  | Record<string, unknown>
                  | undefined;
                if (message) {
                  const rawId =
                    typeof message.id === "string" ? message.id : "";
                  respId = rawId.startsWith("resp_") ? rawId : `resp_${rawId}`;
                  model =
                    typeof message.model === "string" ? message.model : "";
                  created = Math.floor(Date.now() / 1000);
                }

                // response.created
                await safeEnqueue(
                  encoder.encode(
                    emit("response.created", {
                      type: "response.created",
                      response: {
                        id: respId,
                        object: "response",
                        created_at: created,
                        model,
                        status: "in_progress",
                        output: [],
                        usage: null,
                      },
                    }),
                  ),
                );

                // response.in_progress
                await safeEnqueue(
                  encoder.encode(
                    emit("response.in_progress", {
                      type: "response.in_progress",
                      response: {
                        id: respId,
                        object: "response",
                        created_at: created,
                        model,
                        status: "in_progress",
                        output: [],
                        usage: null,
                      },
                    }),
                  ),
                );
                break;
              }

              case "content_block_start": {
                const index = parsed.index as number;
                if (typeof index !== "number") break;

                const block = parsed.content_block as
                  | Record<string, unknown>
                  | undefined;
                if (!block || typeof block.type !== "string") break;

                const currentOutputIndex = outputIndex++;

                if (block.type === "text") {
                  const itemId = `msg_${respId}_${currentOutputIndex}`;
                  outputItems.set(index, {
                    kind: "text",
                    itemId,
                    outputIndex: currentOutputIndex,
                    text: "",
                  });

                  // response.output_item.added
                  await safeEnqueue(
                    encoder.encode(
                      emit("response.output_item.added", {
                        type: "response.output_item.added",
                        output_index: currentOutputIndex,
                        item: {
                          type: "message",
                          id: itemId,
                          role: "assistant",
                          status: "in_progress",
                          content: [],
                        },
                      }),
                    ),
                  );

                  // response.content_part.added
                  await safeEnqueue(
                    encoder.encode(
                      emit("response.content_part.added", {
                        type: "response.content_part.added",
                        item_id: itemId,
                        output_index: currentOutputIndex,
                        content_index: 0,
                        part: {
                          type: "output_text",
                          text: "",
                          annotations: [],
                        },
                      }),
                    ),
                  );
                } else if (block.type === "tool_use") {
                  const callId = typeof block.id === "string" ? block.id : "";
                  const name = typeof block.name === "string" ? block.name : "";
                  const itemId = `fc_${callId}`;
                  outputItems.set(index, {
                    kind: "tool_use",
                    itemId,
                    outputIndex: currentOutputIndex,
                    callId,
                    name,
                    args: "",
                  });

                  // response.output_item.added
                  await safeEnqueue(
                    encoder.encode(
                      emit("response.output_item.added", {
                        type: "response.output_item.added",
                        output_index: currentOutputIndex,
                        item: {
                          type: "function_call",
                          id: itemId,
                          call_id: callId,
                          name,
                          arguments: "",
                          status: "in_progress",
                        },
                      }),
                    ),
                  );
                }
                // thinking blocks: not represented in Responses API — skip
                break;
              }

              case "content_block_delta": {
                const index = parsed.index as number;
                if (typeof index !== "number") break;

                const delta = parsed.delta as
                  | Record<string, unknown>
                  | undefined;
                if (!delta || typeof delta.type !== "string") break;

                const item = outputItems.get(index);
                if (!item) break;

                if (
                  delta.type === "text_delta" &&
                  typeof delta.text === "string" &&
                  item.kind === "text"
                ) {
                  item.text += delta.text;

                  // response.output_text.delta
                  await safeEnqueue(
                    encoder.encode(
                      emit("response.output_text.delta", {
                        type: "response.output_text.delta",
                        item_id: item.itemId,
                        output_index: item.outputIndex,
                        content_index: 0,
                        delta: delta.text,
                      }),
                    ),
                  );
                } else if (
                  delta.type === "input_json_delta" &&
                  typeof delta.partial_json === "string" &&
                  item.kind === "tool_use"
                ) {
                  item.args += delta.partial_json;

                  // response.function_call_arguments.delta
                  await safeEnqueue(
                    encoder.encode(
                      emit("response.function_call_arguments.delta", {
                        type: "response.function_call_arguments.delta",
                        item_id: item.itemId,
                        output_index: item.outputIndex,
                        delta: delta.partial_json,
                      }),
                    ),
                  );
                }
                break;
              }

              case "content_block_stop": {
                const index = parsed.index as number;
                if (typeof index !== "number") break;

                const item = outputItems.get(index);
                if (!item) break;

                if (item.kind === "text") {
                  // response.output_text.done
                  await safeEnqueue(
                    encoder.encode(
                      emit("response.output_text.done", {
                        type: "response.output_text.done",
                        item_id: item.itemId,
                        output_index: item.outputIndex,
                        content_index: 0,
                        text: item.text,
                      }),
                    ),
                  );

                  // response.content_part.done
                  await safeEnqueue(
                    encoder.encode(
                      emit("response.content_part.done", {
                        type: "response.content_part.done",
                        item_id: item.itemId,
                        output_index: item.outputIndex,
                        content_index: 0,
                        part: {
                          type: "output_text",
                          text: item.text,
                          annotations: [],
                        },
                      }),
                    ),
                  );

                  // response.output_item.done
                  await safeEnqueue(
                    encoder.encode(
                      emit("response.output_item.done", {
                        type: "response.output_item.done",
                        output_index: item.outputIndex,
                        item: {
                          type: "message",
                          id: item.itemId,
                          role: "assistant",
                          status: "completed",
                          content: [
                            {
                              type: "output_text",
                              text: item.text,
                              annotations: [],
                            },
                          ],
                        },
                      }),
                    ),
                  );
                } else if (item.kind === "tool_use") {
                  // response.function_call_arguments.done
                  await safeEnqueue(
                    encoder.encode(
                      emit("response.function_call_arguments.done", {
                        type: "response.function_call_arguments.done",
                        item_id: item.itemId,
                        output_index: item.outputIndex,
                        arguments: item.args,
                      }),
                    ),
                  );

                  // response.output_item.done
                  await safeEnqueue(
                    encoder.encode(
                      emit("response.output_item.done", {
                        type: "response.output_item.done",
                        output_index: item.outputIndex,
                        item: {
                          type: "function_call",
                          id: item.itemId,
                          call_id: item.callId,
                          name: item.name,
                          arguments: item.args,
                          status: "completed",
                        },
                      }),
                    ),
                  );
                }
                break;
              }

              case "message_delta": {
                // Stop reason is captured by the accumulator — we use it
                // in message_stop to build the final response.completed event.
                break;
              }

              case "message_stop": {
                // Build the final response.completed from the accumulator
                const resp = accumulator.getResponse();

                const finalOutput: Array<Record<string, unknown>> = [];
                for (const block of resp.content) {
                  if (block.type === "text") {
                    finalOutput.push({
                      type: "message",
                      id: `msg_${respId}_${finalOutput.length}`,
                      role: "assistant",
                      status: "completed",
                      content: [
                        {
                          type: "output_text",
                          text: block.text,
                          annotations: [],
                        },
                      ],
                    });
                  } else if (block.type === "tool_use") {
                    finalOutput.push({
                      type: "function_call",
                      id: `fc_${block.id}`,
                      call_id: block.id,
                      name: block.name,
                      arguments: JSON.stringify(block.input),
                      status: "completed",
                    });
                  }
                }

                const finalStatus = mapStatusFromStopReason(resp.stopReason);

                const ru = resp.usage ?? ZERO_USAGE;
                const inclusiveInputTokens = safeTokenSum(
                  [
                    ru.inputTokens,
                    ru.cacheReadInputTokens,
                    ru.cacheCreationInputTokens,
                  ],
                  "Anthropic usage token overflow",
                );
                const usageData: Record<string, unknown> = {
                  input_tokens: inclusiveInputTokens,
                  output_tokens: ru.outputTokens,
                  total_tokens: safeTokenSum(
                    [inclusiveInputTokens, ru.outputTokens],
                    "Anthropic usage token overflow",
                  ),
                };
                if (
                  ru.cacheReadInputTokens != null ||
                  ru.cacheCreationInputTokens != null
                ) {
                  usageData.input_tokens_details = {
                    cached_tokens: ru.cacheReadInputTokens ?? 0,
                    cache_write_tokens: ru.cacheCreationInputTokens ?? 0,
                  };
                }

                await safeEnqueue(
                  encoder.encode(
                    emit("response.completed", {
                      type: "response.completed",
                      response: {
                        id: respId,
                        object: "response",
                        created_at: created,
                        model: resp.model,
                        status: finalStatus,
                        output: finalOutput,
                        usage: usageData,
                      },
                    }),
                  ),
                );
                terminalEmitted = true;
                break;
              }

              // "ping" and unknown events — skip
            }
            if (terminalEmitted) break;
          }
          validator?.assertDone();
        } catch (err) {
          log.error("openai-responses stream translation error:", err);
          if (opts.strict) {
            try {
              controller.error(err);
            } catch {
              // Already closed/cancelled.
            }
            return;
          }
          // Emit a response.failed event so clients don't hang waiting
          try {
            await safeEnqueue(
              encoder.encode(
                emit("response.failed", {
                  type: "response.failed",
                  response: {
                    id: respId || "resp_error",
                    object: "response",
                    created_at: created,
                    model,
                    status: "failed",
                    output: [],
                    usage: null,
                    error: {
                      type: "server_error",
                      message:
                        err instanceof Error
                          ? err.message
                          : "upstream stream error",
                    },
                  },
                }),
              ),
            );
          } catch {
            // Controller may already be closed
          }
        } finally {
          opts.signal?.removeEventListener("abort", onAbort);
          const reader = activeReader;
          activeReader = undefined;
          if (reader) cancelAndReleaseReader(reader);
          if (!downstreamSettled) {
            downstreamSettled = true;
            try {
              controller.close();
            } catch {
              // Already closed
            }
          }
        }
      };
      queueMicrotask(
        () =>
          void pump().catch((error) => {
            if (downstreamSettled) return;
            downstreamSettled = true;
            try {
              controller.error(error);
            } catch {
              // Already closed/cancelled.
            }
          }),
      );
    },

    pull() {
      resumeDemand?.();
      resumeDemand = undefined;
    },

    cancel() {
      // Client disconnected — cancel the upstream reader to stop wasting bandwidth
      cancelled = true;
      downstreamSettled = true;
      resumeDemand?.();
      resumeDemand = undefined;
      const reader = activeReader;
      activeReader = undefined;
      if (reader) cancelAndReleaseReader(reader);
      else void anthropicResponse.body?.cancel().catch(() => {});
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

// ---------------------------------------------------------------------------
// Internal helpers for the streaming translator
// ---------------------------------------------------------------------------

export function mapStatusFromStopReason(reason: string): string {
  switch (reason) {
    case "end_turn":
    case "stop":
    case "stop_sequence":
    case "tool_use":
      return "completed";
    case "max_tokens":
    case "length":
      return "incomplete";
    default:
      return "completed";
  }
}
