/**
 * Gemini streaming helpers.
 *
 * Two directions:
 *   1. `accumulateGeminiSSEStream` — read an upstream Gemini
 *      `:streamGenerateContent?alt=sse` response (a sequence of
 *      `data: <partial GenerateContentResponse>\n\n` frames) and accumulate it
 *      into a `GatewayResponse` for recall-aware post-processing + re-emission.
 *   2. `translateAnthropicStreamToGemini` — convert the gateway's internal
 *      Anthropic SSE stream into a Gemini SSE response for a Gemini client
 *      talking to a non-Gemini (Anthropic) upstream. This buffers the full
 *      response (via the shared Anthropic stream accumulator) and emits a single
 *      aggregated Gemini SSE frame — matching how the OpenAI/Responses buffered
 *      paths behave for recall-awareness (true token streaming is preserved only
 *      on the native Anthropic→Anthropic path).
 */
import type {
  GatewayContentBlock,
  GatewayResponse,
  GatewayUsage,
} from "../translate/types";
import { ZERO_USAGE } from "../translate/types";
import { asString } from "@loreai/core";
import {
  buildGeminiResponseBody,
  geminiUsageFromMetadata,
  mapGeminiFinishReason,
} from "../translate/gemini";
import { parseSSEStream, createStreamAccumulator } from "./anthropic";

type GeminiPart = Record<string, unknown>;

/**
 * Accumulate an upstream Gemini SSE (`?alt=sse`) response into a
 * `GatewayResponse`. Text parts arrive as deltas across frames and are
 * concatenated; `functionCall` parts arrive complete; `usageMetadata` and
 * `finishReason` appear on the final frame(s).
 */
export async function accumulateGeminiSSEStream(
  upstreamResponse: Response,
): Promise<GatewayResponse> {
  if (!upstreamResponse.body) {
    throw new Error("Upstream response has no body");
  }

  let textContent = "";
  let thinkingContent = "";
  const toolUses: Array<{ name: string; input: unknown }> = [];
  let finishReason: unknown;
  let model = "";
  let responseId = "";
  let usage: GatewayUsage = { ...ZERO_USAGE };

  const reader = upstreamResponse.body.getReader();
  for await (const { data } of parseSSEStream(reader)) {
    if (!data || data === "[DONE]") continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(data) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (typeof parsed.modelVersion === "string") model = parsed.modelVersion;
    if (typeof parsed.responseId === "string") responseId = parsed.responseId;

    const candidates = Array.isArray(parsed.candidates)
      ? parsed.candidates
      : [];
    const first = (candidates[0] ?? {}) as Record<string, unknown>;
    const content = (first.content ?? {}) as Record<string, unknown>;
    const parts = Array.isArray(content.parts)
      ? (content.parts as GeminiPart[])
      : [];
    for (const p of parts) {
      if (typeof p.text === "string") {
        // Keep reasoning-summary parts (`thought: true`) out of the visible
        // answer text — accumulate them into a separate thinking block.
        if (p.thought === true) thinkingContent += p.text;
        else textContent += p.text;
      } else if (p.functionCall && typeof p.functionCall === "object") {
        const fc = p.functionCall as { name?: unknown; args?: unknown };
        toolUses.push({ name: asString(fc.name), input: fc.args ?? {} });
      }
    }
    if (first.finishReason != null) finishReason = first.finishReason;

    // usageMetadata is cumulative across frames; last non-null wins.
    const um = parsed.usageMetadata as Record<string, unknown> | undefined;
    if (um) usage = geminiUsageFromMetadata(um);
  }

  const blocks: GatewayContentBlock[] = [];
  if (thinkingContent)
    blocks.push({ type: "thinking", thinking: thinkingContent });
  if (textContent) blocks.push({ type: "text", text: textContent });
  for (const tu of toolUses) {
    blocks.push({
      type: "tool_use",
      id: tu.name,
      name: tu.name,
      input: tu.input,
    });
  }

  return {
    id: responseId,
    model,
    content: blocks,
    stopReason: mapGeminiFinishReason(finishReason, toolUses.length > 0),
    usage,
  };
}

/**
 * Translate an internal Anthropic SSE stream into a Gemini SSE `Response`.
 *
 * Buffers via the shared Anthropic stream accumulator, then emits a single
 * aggregated Gemini `data: <json>\n\n` frame. Used for a Gemini client whose
 * request was routed to an Anthropic upstream.
 */
export function translateAnthropicStreamToGemini(
  anthropicResponse: Response,
): Response {
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      const accumulator = createStreamAccumulator();
      try {
        if (anthropicResponse.body) {
          const reader = anthropicResponse.body.getReader();
          for await (const { event, data } of parseSSEStream(reader)) {
            accumulator.processEvent(event, data);
          }
        }
        const resp = accumulator.getResponse();
        const body = buildGeminiResponseBody(resp);
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(body)}\n\n`));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}
