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
import { parseSSEStream, createStreamAccumulator } from "./anthropic";

// ---------------------------------------------------------------------------
// Stream accumulator — shared per-event core
// ---------------------------------------------------------------------------

/**
 * Mutable accumulation state for an OpenAI Responses API SSE stream. Shared by
 * the buffered accumulator (`accumulateResponsesSSEStream`) and the live
 * pass-through streamer (`streamResponsesPassthrough`) so both derive an
 * identical `GatewayResponse` from the same event-handling logic.
 */
interface ResponsesAccState {
  id: string;
  model: string;
  stopReason: string;
  usage: GatewayUsage;
  /** Accumulating output items indexed by output_index. */
  items: Map<
    number,
    | { type: "text"; text: string }
    | {
        type: "tool_use";
        id: string;
        callId: string;
        name: string;
        args: string;
      }
  >;
}

function makeResponsesAccState(): ResponsesAccState {
  return {
    id: "",
    model: "",
    stopReason: "end_turn",
    usage: { inputTokens: 0, outputTokens: 0 },
    items: new Map(),
  };
}

/**
 * Apply one parsed Responses SSE event to the accumulation state. Never touches
 * I/O — safe to call while forwarding the same event verbatim to the client.
 */
function applyResponsesEvent(
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

      if (item.type === "message") {
        state.items.set(outputIndex, { type: "text", text: "" });
      } else if (item.type === "function_call") {
        state.items.set(outputIndex, {
          type: "tool_use",
          id: asString(item.id),
          callId: asString(item.call_id),
          name: asString(item.name),
          args: "",
        });
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
    case "response.done":
    case "response.incomplete":
    case "response.completed": {
      const resp = parsed.response as Record<string, unknown> | undefined;
      if (resp) {
        if (typeof resp.id === "string") state.id = resp.id;
        if (typeof resp.model === "string") state.model = resp.model;
        if (typeof resp.status === "string") {
          state.stopReason = mapStatusToStopReason(resp.status);
        }

        const respUsage = resp.usage as Record<string, unknown> | undefined;
        if (respUsage) {
          if (typeof respUsage.output_tokens === "number") {
            state.usage.outputTokens = respUsage.output_tokens;
          }
          // Responses API reports cache details under `input_tokens_details`;
          // fall back to `prompt_tokens_details` for OpenAI-compatible providers.
          const promptDetails = (respUsage.input_tokens_details ??
            respUsage.prompt_tokens_details) as
            | Record<string, number>
            | undefined;
          if (promptDetails?.cached_tokens !== undefined) {
            state.usage.cacheReadInputTokens = promptDetails.cached_tokens;
          }
          if (promptDetails?.cache_write_tokens !== undefined) {
            state.usage.cacheCreationInputTokens =
              promptDetails.cache_write_tokens;
          }
          if (typeof respUsage.input_tokens === "number") {
            // input_tokens is inclusive of cache reads/writes; subtract them
            // to match the gateway's disjoint token convention.
            state.usage.inputTokens = Math.max(
              0,
              respUsage.input_tokens -
                (promptDetails?.cached_tokens ?? 0) -
                (promptDetails?.cache_write_tokens ?? 0),
            );
          }
        }
      }
      break;
    }

    // Other events (response.output_item.done, response.content_part.*,
    // response.reasoning_summary_*, etc.) — ignored for accumulation
  }
}

/** Build the final GatewayResponse from accumulated state. */
function finalizeResponsesAcc(state: ResponsesAccState): GatewayResponse {
  const content: GatewayContentBlock[] = [];
  const sortedIndices = Array.from(state.items.keys()).sort((a, b) => a - b);

  for (const index of sortedIndices) {
    const item = state.items.get(index);
    if (!item) continue;
    if (item.type === "text") {
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
    stopReason,
    usage: state.usage,
  };
}

// ---------------------------------------------------------------------------
// Stream accumulator (buffered)
// ---------------------------------------------------------------------------

/**
 * Accumulate an OpenAI Responses API SSE stream into a GatewayResponse.
 *
 * Consumes the upstream Response body and returns the accumulated result.
 */
export async function accumulateResponsesSSEStream(
  response: Response,
): Promise<GatewayResponse> {
  const state = makeResponsesAccState();

  if (!response.body) {
    throw new Error("Response has no body");
  }
  const reader = response.body.getReader();

  for await (const { event, data } of parseSSEStream(reader)) {
    // Some Responses API implementations send untyped `data:` lines
    // without `event:` — skip those.
    if (!data || data === "[DONE]") continue;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(data) as Record<string, unknown>;
    } catch {
      continue;
    }

    applyResponsesEvent(state, event, parsed);
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
function reserializeSSE(event: string, data: string): string {
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
): Response {
  const state = makeResponsesAccState();
  const encoder = new TextEncoder();

  let cancelled = false;
  let activeReader: ReadableStreamDefaultReader<Uint8Array> | null = null;

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

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const safeEnqueue = (chunk: Uint8Array): boolean => {
        if (cancelled) return false;
        try {
          controller.enqueue(chunk);
          return true;
        } catch {
          cancelled = true;
          return false;
        }
      };
      const safeClose = (): void => {
        if (cancelled) return;
        try {
          controller.close();
        } catch {
          // Already closed/cancelled
        }
      };

      const resetKeepalive = (): void => {
        if (keepaliveTimer) clearTimeout(keepaliveTimer);
        keepaliveTimer = setTimeout(function tick() {
          if (cancelled) return;
          safeEnqueue(keepaliveComment);
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

      try {
        if (!upstreamResponse.body) {
          throw new Error("Upstream response has no body");
        }
        const reader = upstreamResponse.body.getReader();
        activeReader = reader;

        resetKeepalive();
        for await (const { event, data } of parseSSEStream(reader)) {
          resetKeepalive(); // upstream alive — reset inactivity timer

          // Forward real Responses events to the client as they arrive,
          // preserving the original data payload (no re-parse/re-serialize →
          // no field loss). `parseSSEStream` synthesizes `event: "message"` for
          // untyped `data:` lines and yields the `[DONE]` sentinel — neither
          // carries Responses semantics, and the buffered path never re-emitted
          // them, so skip both from client forwarding to keep the wire truly
          // faithful to a genuine Responses stream.
          const forwardable =
            event !== "message" && !!data && data !== "[DONE]";
          if (
            forwardable &&
            !safeEnqueue(encoder.encode(reserializeSSE(event, data)))
          ) {
            break;
          }

          // Accumulate in parallel for postResponse / calibration.
          if (!data || data === "[DONE]") continue;
          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(data) as Record<string, unknown>;
          } catch {
            continue;
          }
          applyResponsesEvent(state, event, parsed);
        }
        clearKeepalive();
        finish();
        safeClose();
      } catch (err) {
        clearKeepalive();
        log.error(
          `openai-responses passthrough stream error${
            sessionID ? ` (session=${sessionID.slice(0, 16)})` : ""
          }:`,
          err,
        );
        // Emit response.failed so the client doesn't hang waiting for a
        // terminal event, then still run onComplete with what we accumulated.
        safeEnqueue(
          encoder.encode(
            reserializeSSE(
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
    },

    cancel() {
      // Client disconnected — cancel the upstream reader to stop wasting bandwidth
      cancelled = true;
      if (keepaliveTimer) clearTimeout(keepaliveTimer);
      try {
        // Cancel via the active reader (it holds the body lock); fall back to
        // the body if the loop hasn't acquired a reader yet.
        if (activeReader) {
          void activeReader.cancel();
        } else {
          void upstreamResponse.body?.cancel();
        }
      } catch {
        // Best-effort cancellation
      }
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

  function emit(eventType: string, data: Record<string, unknown>): string {
    return `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      function safeEnqueue(chunk: Uint8Array): boolean {
        if (cancelled) return false;
        try {
          controller.enqueue(chunk);
          return true;
        } catch {
          cancelled = true;
          return false;
        }
      }

      try {
        if (!anthropicResponse.body) {
          throw new Error("Anthropic response has no body");
        }
        const reader = anthropicResponse.body.getReader();

        for await (const { event, data } of parseSSEStream(reader)) {
          if (cancelled) break;

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
                const rawId = typeof message.id === "string" ? message.id : "";
                respId = rawId.startsWith("resp_") ? rawId : `resp_${rawId}`;
                model = typeof message.model === "string" ? message.model : "";
                created = Math.floor(Date.now() / 1000);
              }

              // response.created
              safeEnqueue(
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
              safeEnqueue(
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
                safeEnqueue(
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
                safeEnqueue(
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
                safeEnqueue(
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

              const delta = parsed.delta as Record<string, unknown> | undefined;
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
                safeEnqueue(
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
                safeEnqueue(
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
                safeEnqueue(
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
                safeEnqueue(
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
                safeEnqueue(
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
                safeEnqueue(
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
                safeEnqueue(
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
              const usageData: Record<string, unknown> = {
                input_tokens: ru.inputTokens,
                output_tokens: ru.outputTokens,
                total_tokens: ru.inputTokens + ru.outputTokens,
              };
              if (ru.cacheReadInputTokens != null) {
                usageData.prompt_tokens_details = {
                  cached_tokens: ru.cacheReadInputTokens,
                };
              }

              safeEnqueue(
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
              break;
            }

            // "ping" and unknown events — skip
          }
        }
      } catch (err) {
        log.error("openai-responses stream translation error:", err);
        // Emit a response.failed event so clients don't hang waiting
        try {
          controller.enqueue(
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
        try {
          controller.close();
        } catch {
          // Already closed
        }
      }
    },

    cancel() {
      // Client disconnected — cancel the upstream reader to stop wasting bandwidth
      cancelled = true;
      try {
        void anthropicResponse.body?.cancel();
      } catch {
        // Best-effort cancellation
      }
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

function mapStatusFromStopReason(reason: string): string {
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
