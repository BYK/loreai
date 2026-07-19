/**
 * Anthropic SSE → OpenAI Chat Completions SSE streaming translator.
 *
 * Reads Anthropic-format SSE events from an upstream Response and emits
 * OpenAI Chat Completions streaming chunks incrementally, so the client
 * receives tokens as they arrive rather than waiting for the full response.
 *
 * Anthropic lifecycle:
 *   message_start → content_block_start → content_block_delta (repeated)
 *   → content_block_stop → message_delta → message_stop
 *
 * OpenAI Chat Completions streaming lifecycle:
 *   chunk with delta.role → chunk with delta.content (repeated)
 *   → chunk with finish_reason → data: [DONE]
 *
 * Uses `parseSSEStream` from the Anthropic stream module to parse upstream
 * events, and `createStreamAccumulator` to build the internal GatewayResponse
 * (for pipeline post-processing that may read it).
 */
import { asString, log } from "@loreai/core";
import {
  ZERO_USAGE,
  type GatewayContentBlock,
  type GatewayResponse,
} from "../translate/types";
import { parseSSEStream, createStreamAccumulator } from "./anthropic";

// ---------------------------------------------------------------------------
// Types for in-flight tool call tracking
// ---------------------------------------------------------------------------

/** Tracks a tool_use content block being streamed. */
type InflightToolCall = {
  /** Anthropic block index. */
  blockIndex: number;
  /** Tool call index in the OpenAI `tool_calls` array. */
  toolCallIndex: number;
  /** Tool use ID from Anthropic. */
  id: string;
  /** Function name. */
  name: string;
  /** Whether the initial chunk (with id+name) has been emitted. */
  headerEmitted: boolean;
};

// ---------------------------------------------------------------------------
// Stop reason mapping
// ---------------------------------------------------------------------------

function mapStopReason(reason: string): string {
  switch (reason) {
    case "end_turn":
    case "stop":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
    case "length":
      return "length";
    case "tool_use":
      return "tool_calls";
    default:
      return "stop";
  }
}

// ---------------------------------------------------------------------------
// Streaming translator
// ---------------------------------------------------------------------------

/**
 * Translate an Anthropic SSE streaming Response into an OpenAI Chat
 * Completions SSE streaming Response.
 *
 * The returned Response streams OpenAI-format `data: {...}\n\n` lines
 * incrementally as upstream Anthropic events arrive.
 */
export function translateAnthropicStreamToOpenAI(
  anthropicResponse: Response,
): Response {
  const encoder = new TextEncoder();
  const accumulator = createStreamAccumulator();

  // State extracted from message_start
  let baseId = "";
  let model = "";
  let created = Math.floor(Date.now() / 1000);
  let roleChunkEmitted = false;
  let finishReason = "";

  // Tool call tracking: blockIndex → InflightToolCall
  const toolCalls = new Map<number, InflightToolCall>();
  let nextToolCallIndex = 0;
  let cancelled = false;

  function formatChunk(
    delta: Record<string, unknown>,
    finish: string | null,
    usage?: Record<string, unknown>,
  ): string {
    const chunk: Record<string, unknown> = {
      id: baseId,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [
        {
          index: 0,
          delta,
          finish_reason: finish,
        },
      ],
    };
    if (usage) {
      chunk.usage = usage;
    }
    return `data: ${JSON.stringify(chunk)}\n\n`;
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

          // Always feed the accumulator so we get a complete GatewayResponse
          accumulator.processEvent(event, data);

          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(data) as Record<string, unknown>;
          } catch {
            // Non-JSON event (ping, etc.) — skip
            continue;
          }

          switch (event) {
            case "message_start": {
              const message = parsed.message as
                | Record<string, unknown>
                | undefined;
              if (message) {
                const rawId = typeof message.id === "string" ? message.id : "";
                baseId = rawId.startsWith("chatcmpl-")
                  ? rawId
                  : `chatcmpl-${rawId}`;
                model = typeof message.model === "string" ? message.model : "";
                created = Math.floor(Date.now() / 1000);
              }

              // Emit the role chunk
              if (!roleChunkEmitted) {
                safeEnqueue(
                  encoder.encode(formatChunk({ role: "assistant" }, null)),
                );
                roleChunkEmitted = true;
              }
              break;
            }

            case "content_block_start": {
              const index = parsed.index as number;
              if (typeof index !== "number") break;

              const block = parsed.content_block as
                | Record<string, unknown>
                | undefined;
              if (!block || typeof block.type !== "string") break;

              if (block.type === "tool_use") {
                // Register the tool call — emit the initial chunk with id+name
                const toolCallIndex = nextToolCallIndex++;
                const tc: InflightToolCall = {
                  blockIndex: index,
                  toolCallIndex,
                  id: typeof block.id === "string" ? block.id : "",
                  name: typeof block.name === "string" ? block.name : "",
                  headerEmitted: false,
                };
                toolCalls.set(index, tc);

                // Emit the tool call header chunk (id, type, function name)
                safeEnqueue(
                  encoder.encode(
                    formatChunk(
                      {
                        tool_calls: [
                          {
                            index: tc.toolCallIndex,
                            id: tc.id,
                            type: "function",
                            function: {
                              name: tc.name,
                              arguments: "",
                            },
                          },
                        ],
                      },
                      null,
                    ),
                  ),
                );
                tc.headerEmitted = true;
              }
              // text blocks: nothing to emit yet — wait for deltas
              // thinking blocks: not represented in OpenAI format — skip
              break;
            }

            case "content_block_delta": {
              const index = parsed.index as number;
              if (typeof index !== "number") break;

              const delta = parsed.delta as Record<string, unknown> | undefined;
              if (!delta || typeof delta.type !== "string") break;

              if (
                delta.type === "text_delta" &&
                typeof delta.text === "string"
              ) {
                // Emit text content incrementally
                safeEnqueue(
                  encoder.encode(formatChunk({ content: delta.text }, null)),
                );
              } else if (
                delta.type === "input_json_delta" &&
                typeof delta.partial_json === "string"
              ) {
                // Stream tool call arguments incrementally
                const tc = toolCalls.get(index);
                if (tc) {
                  safeEnqueue(
                    encoder.encode(
                      formatChunk(
                        {
                          tool_calls: [
                            {
                              index: tc.toolCallIndex,
                              function: {
                                arguments: delta.partial_json,
                              },
                            },
                          ],
                        },
                        null,
                      ),
                    ),
                  );
                }
              }
              // thinking_delta, signature_delta: not in OpenAI format — skip
              break;
            }

            case "content_block_stop": {
              // No explicit emission needed for content_block_stop in OpenAI format.
              // Text blocks are already fully streamed via deltas.
              // Tool call arguments are already fully streamed via deltas.
              break;
            }

            case "message_delta": {
              const delta = parsed.delta as Record<string, unknown> | undefined;
              if (delta && typeof delta.stop_reason === "string") {
                finishReason = mapStopReason(delta.stop_reason);
              }
              break;
            }

            case "message_stop": {
              // Build usage from accumulator
              const resp = accumulator.getResponse();
              const ru = resp.usage ?? ZERO_USAGE;
              const usage: Record<string, unknown> = {
                prompt_tokens: ru.inputTokens,
                completion_tokens: ru.outputTokens,
                total_tokens: ru.inputTokens + ru.outputTokens,
              };
              if (ru.cacheReadInputTokens != null) {
                usage.prompt_tokens_details = {
                  cached_tokens: ru.cacheReadInputTokens,
                };
              }

              // Emit final chunk with finish_reason and usage
              safeEnqueue(
                encoder.encode(formatChunk({}, finishReason || "stop", usage)),
              );

              // Emit [DONE] sentinel
              safeEnqueue(encoder.encode("data: [DONE]\n\n"));
              break;
            }

            // "ping" and unknown events — skip (already fed to accumulator)
          }
        }
      } catch (err) {
        // If upstream errors, try to close gracefully with [DONE]
        try {
          safeEnqueue(encoder.encode("data: [DONE]\n\n"));
        } catch {
          // Controller may already be closed
        }
        log.error("openai stream translation error:", err);
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

/**
 * Accumulate a streaming OpenAI Chat Completions SSE response into a
 * GatewayResponse.
 *
 * Reads EVERY `data:` chunk and merges the incremental `choices[0].delta`
 * fields (text + tool-call fragments) into a single response — so a
 * multi-chunk stream is reconstructed faithfully. This is the correct reader
 * for a non-streaming request whose provider replied with SSE anyway (the
 * ChatGPT/Copilot backend, DeepSeek): taking only the last `data:` line would
 * drop all but the final delta.
 *
 * OpenAI SSE chunk shape:
 *   data: {"id":"...","choices":[{"delta":{"content":"..."},"finish_reason":null}]}
 */
export async function accumulateOpenAISSEStream(
  upstreamResponse: Response,
): Promise<GatewayResponse> {
  let id = "";
  let model = "";
  let stopReason = "end_turn";
  let textContent = "";
  // Some reasoning models (e.g. MiniMax-M3 via OpenRouter) stream their entire
  // answer as reasoning deltas and leave `content` empty. Capture it so a
  // reasoning-only response is not mistaken for an empty completion (#1334) —
  // mirrors the non-streaming parseOpenAIResponse content→reasoning fallback.
  let reasoningContent = "";
  const toolCalls = new Map<
    number,
    { id: string; name: string; args: string }
  >();
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens: number | undefined;
  let cacheWriteTokens: number | undefined;

  if (!upstreamResponse.body) {
    throw new Error("Upstream response has no body");
  }
  const reader = upstreamResponse.body.getReader();

  for await (const { data } of parseSSEStream(reader)) {
    if (data === "[DONE]") break;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(data) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (typeof parsed.id === "string") id = parsed.id;
    if (typeof parsed.model === "string") model = parsed.model;

    const choices = parsed.choices as
      | Array<Record<string, unknown>>
      | undefined;
    const firstChoice = choices?.[0];
    if (firstChoice) {
      const delta = firstChoice.delta as Record<string, unknown> | undefined;
      if (delta) {
        if (typeof delta.content === "string") {
          textContent += delta.content;
        }
        // Reasoning deltas: `reasoning` (OpenRouter/others) or `reasoning_content`
        // (DeepSeek/Qwen). Accumulated separately and surfaced as a thinking block
        // only when there is no visible text (#1334). No provider emits BOTH fields
        // in one delta, so the else-if precedence here (reasoning first) is
        // per-provider identical to parseOpenAIResponse (which prefers
        // reasoning_content) — the order only diverges in the impossible both-set case.
        if (typeof delta.reasoning === "string") {
          reasoningContent += delta.reasoning;
        } else if (typeof delta.reasoning_content === "string") {
          reasoningContent += delta.reasoning_content;
        }
        const tcs = delta.tool_calls as
          | Array<Record<string, unknown>>
          | undefined;
        if (tcs) {
          for (const tc of tcs) {
            const idx = tc.index as number;
            const fn = tc.function as Record<string, unknown> | undefined;
            const existing = toolCalls.get(idx);
            if (!existing) {
              toolCalls.set(idx, {
                id: asString(tc.id),
                name: asString(fn?.name),
                args: asString(fn?.arguments),
              });
            } else {
              if (fn?.arguments) existing.args += asString(fn.arguments);
            }
          }
        }
      }
      if (typeof firstChoice.finish_reason === "string") {
        const fr = firstChoice.finish_reason;
        if (fr === "stop") stopReason = "end_turn";
        else if (fr === "length") stopReason = "max_tokens";
        else if (fr === "tool_calls") stopReason = "tool_use";
      }
    }

    // Usage is typically in the final chunk
    const usage = parsed.usage as Record<string, unknown> | undefined;
    if (usage) {
      if (typeof usage.prompt_tokens === "number")
        inputTokens = usage.prompt_tokens;
      if (typeof usage.completion_tokens === "number")
        outputTokens = usage.completion_tokens;
      const details = usage.prompt_tokens_details as
        | Record<string, number>
        | undefined;
      if (details?.cached_tokens !== undefined)
        cachedTokens = details.cached_tokens;
      if (details?.cache_write_tokens !== undefined)
        cacheWriteTokens = details.cache_write_tokens;
    }
  }

  const content: GatewayContentBlock[] = [];
  // Thinking precedes text (Anthropic ordering). Previously reasoning deltas were
  // dropped entirely on this path; surfacing them lets a reasoning-only response
  // (empty content) still yield usable text downstream (#1334).
  if (reasoningContent) {
    content.push({ type: "thinking", thinking: reasoningContent });
  }
  if (textContent) {
    content.push({ type: "text", text: textContent });
  }
  for (const [, tc] of Array.from(toolCalls.entries()).sort(
    ([a], [b]) => a - b,
  )) {
    let input: unknown = {};
    if (tc.args) {
      try {
        input = JSON.parse(tc.args);
      } catch {
        input = tc.args;
      }
    }
    content.push({ type: "tool_use", id: tc.id, name: tc.name, input });
  }

  return {
    id,
    model,
    content,
    stopReason,
    usage: {
      // prompt_tokens is inclusive of cache reads/writes; subtract them to
      // match the gateway's disjoint token convention (see
      // disjointOpenAIInputTokens in llm-adapter.ts). Inlined here to keep this
      // leaf stream module free of a cross-module import.
      inputTokens: Math.max(
        0,
        inputTokens - (cachedTokens ?? 0) - (cacheWriteTokens ?? 0),
      ),
      outputTokens,
      cacheReadInputTokens: cachedTokens,
      cacheCreationInputTokens: cacheWriteTokens,
    },
  };
}
