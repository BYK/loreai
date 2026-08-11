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
import {
  DEFAULT_MAX_SSE_FRAMES,
  AnthropicSSEValidator,
  parseSSEStream,
  createStreamAccumulator,
  cancelAndReleaseReader,
} from "./anthropic";
import { safeTokenSum, validateOpenAIUsage } from "../usage-validation";

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
  opts: { strict?: boolean; signal?: AbortSignal } = {},
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
  let activeReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let resumeDemand: (() => void) | undefined;
  let terminalEmitted = false;
  let downstreamSettled = false;

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

      void (async () => {
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
                  const rawId =
                    typeof message.id === "string" ? message.id : "";
                  baseId = rawId.startsWith("chatcmpl-")
                    ? rawId
                    : `chatcmpl-${rawId}`;
                  model =
                    typeof message.model === "string" ? message.model : "";
                  created = Math.floor(Date.now() / 1000);
                }

                // Emit the role chunk
                if (!roleChunkEmitted) {
                  await safeEnqueue(
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
                  await safeEnqueue(
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

                const delta = parsed.delta as
                  | Record<string, unknown>
                  | undefined;
                if (!delta || typeof delta.type !== "string") break;

                if (
                  delta.type === "text_delta" &&
                  typeof delta.text === "string"
                ) {
                  // Emit text content incrementally
                  await safeEnqueue(
                    encoder.encode(formatChunk({ content: delta.text }, null)),
                  );
                } else if (
                  delta.type === "input_json_delta" &&
                  typeof delta.partial_json === "string"
                ) {
                  // Stream tool call arguments incrementally
                  const tc = toolCalls.get(index);
                  if (tc) {
                    await safeEnqueue(
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
                const delta = parsed.delta as
                  | Record<string, unknown>
                  | undefined;
                if (delta && typeof delta.stop_reason === "string") {
                  finishReason = mapStopReason(delta.stop_reason);
                }
                break;
              }

              case "message_stop": {
                // Build usage from accumulator
                const resp = accumulator.getResponse();
                const ru = resp.usage ?? ZERO_USAGE;
                const inclusiveInputTokens = safeTokenSum(
                  [
                    ru.inputTokens,
                    ru.cacheReadInputTokens,
                    ru.cacheCreationInputTokens,
                  ],
                  "Anthropic usage token overflow",
                );
                const usage: Record<string, unknown> = {
                  prompt_tokens: inclusiveInputTokens,
                  completion_tokens: ru.outputTokens,
                  total_tokens: safeTokenSum(
                    [inclusiveInputTokens, ru.outputTokens],
                    "Anthropic usage token overflow",
                  ),
                };
                if (
                  ru.cacheReadInputTokens != null ||
                  ru.cacheCreationInputTokens != null
                ) {
                  usage.prompt_tokens_details = {
                    cached_tokens: ru.cacheReadInputTokens ?? 0,
                    cache_write_tokens: ru.cacheCreationInputTokens ?? 0,
                  };
                }

                // Emit final chunk with finish_reason and usage
                await safeEnqueue(
                  encoder.encode(
                    formatChunk({}, finishReason || "stop", usage),
                  ),
                );

                // Emit [DONE] sentinel
                await safeEnqueue(encoder.encode("data: [DONE]\n\n"));
                terminalEmitted = true;
                break;
              }

              // "ping" and unknown events — skip (already fed to accumulator)
            }
            if (terminalEmitted) break;
          }
          validator?.assertDone();
        } catch (err) {
          if (opts.strict) {
            log.error("openai stream translation validation error:", err);
            try {
              controller.error(err);
            } catch {
              // Already closed/cancelled.
            }
            return;
          }
          // If upstream errors, try to close gracefully with [DONE]
          if (!terminalEmitted) {
            try {
              await safeEnqueue(encoder.encode("data: [DONE]\n\n"));
            } catch {
              // Controller may already be closed
            }
          }
          log.error("openai stream translation error:", err);
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
      })();
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
  opts: {
    signal?: AbortSignal;
    stopAtTerminal?: boolean;
    strict?: boolean;
    inactivityMs?: number;
    maxFrames?: number;
    onSemanticContent?: () => void;
    consumeUntilDone?: boolean;
    onValidatedEvent?: (event: string, data: string) => void | Promise<void>;
  } = {},
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
  let refusalContent = "";
  const toolCalls = new Map<
    number,
    { id: string; name: string; args: string }
  >();
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens: number | undefined;
  let cacheWriteTokens: number | undefined;
  let terminalSeen = false;
  let doneSeen = false;
  let choiceIndex: number | undefined;
  const toolCallIndexById = new Map<string, number>();
  // Every choice is validated even though the gateway projects choices[0].
  const validatedToolCalls = new Map<string, { id: string; name: string }>();
  // Tool call IDs only need to be unique within one independent choice.
  const validatedToolOwnerByChoiceAndId = new Map<string, string>();

  const applyUsage = (parsed: Record<string, unknown>): void => {
    const usage = parsed.usage as Record<string, unknown> | undefined;
    if (!usage) return;
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
  };
  const malformedUsage = (usage: unknown): boolean => {
    try {
      validateOpenAIUsage(usage, "malformed OpenAI stream event");
      return false;
    } catch {
      return true;
    }
  };
  const malformedChoice = (choice: unknown): boolean => {
    if (!choice || typeof choice !== "object" || Array.isArray(choice)) {
      return true;
    }
    const typed = choice as Record<string, unknown>;
    if (
      !typed.delta ||
      typeof typed.delta !== "object" ||
      Array.isArray(typed.delta) ||
      (typed.finish_reason !== undefined &&
        typed.finish_reason !== null &&
        typeof typed.finish_reason !== "string")
    ) {
      return true;
    }
    if (
      typed.index !== undefined &&
      (!Number.isSafeInteger(typed.index) || (typed.index as number) < 0)
    ) {
      return true;
    }
    const delta = typed.delta as Record<string, unknown>;
    if (delta.role !== undefined && typeof delta.role !== "string") {
      return true;
    }
    for (const field of [
      "content",
      "reasoning",
      "reasoning_content",
      "refusal",
    ] as const) {
      if (
        delta[field] !== undefined &&
        delta[field] !== null &&
        typeof delta[field] !== "string"
      ) {
        return true;
      }
    }
    if (delta.tool_calls === undefined) return false;
    if (!Array.isArray(delta.tool_calls)) return true;
    return delta.tool_calls.some((call) => {
      if (!call || typeof call !== "object" || Array.isArray(call)) return true;
      const toolCall = call as Record<string, unknown>;
      if (
        !Number.isSafeInteger(toolCall.index) ||
        (toolCall.index as number) < 0
      ) {
        return true;
      }
      if (toolCall.id !== undefined && typeof toolCall.id !== "string") {
        return true;
      }
      if (toolCall.function === undefined) return false;
      if (
        !toolCall.function ||
        typeof toolCall.function !== "object" ||
        Array.isArray(toolCall.function)
      ) {
        return true;
      }
      const fn = toolCall.function as Record<string, unknown>;
      return (
        (fn.name !== undefined && typeof fn.name !== "string") ||
        (fn.arguments !== undefined && typeof fn.arguments !== "string")
      );
    });
  };

  if (!upstreamResponse.body) {
    throw new Error("Upstream response has no body");
  }
  const reader = upstreamResponse.body.getReader();

  try {
    for await (const { event, data } of parseSSEStream(reader, {
      signal: opts.signal,
      inactivityMs: opts.inactivityMs,
      requireEventTerminator: opts.strict,
      fatalUtf8: opts.strict,
      maxFrames: opts.strict
        ? (opts.maxFrames ?? DEFAULT_MAX_SSE_FRAMES)
        : opts.maxFrames,
      maxTotalBytes: opts.strict ? 4 * 1024 * 1024 : undefined,
    })) {
      if (data === "[DONE]") {
        await opts.onValidatedEvent?.(event, data);
        doneSeen = true;
        break;
      }

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(data) as Record<string, unknown>;
      } catch {
        if (opts.strict) throw new Error("malformed OpenAI stream event");
        continue;
      }

      const choices = parsed.choices;
      if (
        opts.strict &&
        (!Array.isArray(choices) ||
          choices.some(malformedChoice) ||
          malformedUsage(parsed.usage))
      ) {
        throw new Error("malformed OpenAI stream event");
      }

      if (
        opts.strict &&
        ((parsed.id !== undefined && typeof parsed.id !== "string") ||
          (id && typeof parsed.id === "string" && parsed.id !== id) ||
          (parsed.model !== undefined && typeof parsed.model !== "string") ||
          (model && typeof parsed.model === "string" && parsed.model !== model))
      ) {
        throw new Error("malformed OpenAI stream event");
      }
      if (typeof parsed.id === "string") id = parsed.id;
      if (typeof parsed.model === "string") model = parsed.model;

      const normalizedChoices = parsed.choices as
        | Array<Record<string, unknown>>
        | undefined;
      if (opts.strict && normalizedChoices) {
        const frameChoiceIndices = new Set<number>();
        for (
          let position = 0;
          position < normalizedChoices.length;
          position++
        ) {
          const choice = normalizedChoices[position];
          const currentChoiceIndex =
            typeof choice.index === "number" ? choice.index : position;
          if (frameChoiceIndices.has(currentChoiceIndex)) {
            throw new Error("malformed OpenAI stream event");
          }
          frameChoiceIndices.add(currentChoiceIndex);
          const delta = choice.delta as Record<string, unknown>;
          const calls = delta.tool_calls as
            | Array<Record<string, unknown>>
            | undefined;
          for (const call of calls ?? []) {
            const toolIndex = call.index as number;
            const slot = `${currentChoiceIndex}:${toolIndex}`;
            const existing = validatedToolCalls.get(slot);
            const fn = call.function as Record<string, unknown> | undefined;
            const id = typeof call.id === "string" ? call.id : "";
            const name = typeof fn?.name === "string" ? fn.name : "";
            if (
              (existing?.id && id && existing.id !== id) ||
              (existing?.name && name && existing.name !== name)
            ) {
              throw new Error("malformed OpenAI stream event");
            }
            const effectiveId = id || existing?.id || "";
            const effectiveName = name || existing?.name || "";
            if (effectiveId) {
              const identity = `${currentChoiceIndex}:${effectiveId}`;
              const owner = validatedToolOwnerByChoiceAndId.get(identity);
              if (owner !== undefined && owner !== slot) {
                throw new Error("malformed OpenAI stream event");
              }
              validatedToolOwnerByChoiceAndId.set(identity, slot);
            }
            validatedToolCalls.set(slot, {
              id: effectiveId,
              name: effectiveName,
            });
          }
        }
      }
      const firstChoice = normalizedChoices?.[0];
      if (opts.strict && terminalSeen && normalizedChoices?.length) {
        throw new Error("malformed OpenAI stream event");
      }
      if (firstChoice) {
        if (opts.strict) {
          const projectedChoiceIndex =
            typeof firstChoice.index === "number" ? firstChoice.index : 0;
          if (
            choiceIndex !== undefined &&
            choiceIndex !== projectedChoiceIndex
          ) {
            throw new Error("malformed OpenAI stream event");
          }
          choiceIndex = projectedChoiceIndex;
        }
        const delta = firstChoice.delta as Record<string, unknown> | undefined;
        if (delta) {
          if (typeof delta.content === "string") {
            textContent += delta.content;
          }
          if (typeof delta.refusal === "string") {
            refusalContent += delta.refusal;
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
              const fnName = fn?.name;
              const fnArguments = fn?.arguments;
              const existing = toolCalls.get(idx);
              if (opts.strict && typeof tc.id === "string" && tc.id) {
                const existingIndex = toolCallIndexById.get(tc.id);
                if (existingIndex !== undefined && existingIndex !== idx) {
                  throw new Error("malformed OpenAI stream event");
                }
                toolCallIndexById.set(tc.id, idx);
              }
              if (!existing) {
                toolCalls.set(idx, {
                  id: asString(tc.id),
                  name: asString(fn?.name),
                  args: asString(fn?.arguments),
                });
              } else {
                if (
                  opts.strict &&
                  ((typeof tc.id === "string" &&
                    existing.id &&
                    tc.id !== existing.id) ||
                    (typeof fnName === "string" &&
                      existing.name &&
                      fnName !== existing.name))
                ) {
                  throw new Error("malformed OpenAI stream event");
                }
                if (!existing.id && typeof tc.id === "string") {
                  existing.id = tc.id;
                }
                if (!existing.name && typeof fnName === "string") {
                  existing.name = fnName;
                }
                if (fnArguments) existing.args += asString(fnArguments);
              }
            }
          }
          if (
            opts.onSemanticContent &&
            ([
              delta.content,
              delta.reasoning,
              delta.reasoning_content,
              delta.refusal,
            ].some((value) => typeof value === "string" && value.length > 0) ||
              tcs?.some((tc) => {
                const fn = tc.function as Record<string, unknown> | undefined;
                return (
                  (typeof tc.id === "string" && tc.id.length > 0) ||
                  (typeof fn?.name === "string" && fn.name.length > 0) ||
                  (typeof fn?.arguments === "string" && fn.arguments.length > 0)
                );
              }))
          ) {
            opts.onSemanticContent();
          }
        }
        if (typeof firstChoice.finish_reason === "string") {
          const fr = firstChoice.finish_reason;
          if (fr === "stop") stopReason = "end_turn";
          else if (fr === "length") stopReason = "max_tokens";
          else if (fr === "tool_calls" || fr === "function_call")
            stopReason = "tool_use";
          else stopReason = fr;
          if (opts.stopAtTerminal) terminalSeen = true;
        }
      }

      // Usage is typically in the final chunk
      applyUsage(parsed);
      await opts.onValidatedEvent?.(event, data);
      // Worker requests do not ask for stream_options.include_usage, so a
      // non-null finish_reason is the last required chunk. Usage on this same
      // frame is retained; optional later usage-only frames are not awaited.
      if (terminalSeen && !opts.consumeUntilDone) break;
    }
  } finally {
    cancelAndReleaseReader(reader);
  }

  if (opts.stopAtTerminal && !terminalSeen) {
    throw new Error("missing OpenAI finish_reason terminal");
  }
  if (opts.consumeUntilDone && !doneSeen) {
    throw new Error("missing OpenAI [DONE] terminal");
  }
  if (opts.strict && Array.from(toolCalls.values()).some((tc) => !tc.id)) {
    throw new Error("malformed OpenAI stream event");
  }
  if (
    opts.strict &&
    Array.from(validatedToolCalls.values()).some((call) => !call.id)
  ) {
    throw new Error("malformed OpenAI stream event");
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
  } else if (refusalContent) {
    content.push({ type: "text", text: refusalContent });
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
