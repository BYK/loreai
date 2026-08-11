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
  validateGeminiFunctionCallIdentity,
} from "../translate/gemini";
import {
  DEFAULT_MAX_SSE_FRAMES,
  parseSSEStream,
  accumulateSSEResponse,
  cancelAndReleaseReader,
} from "./anthropic";
import { isRecord, validateGeminiUsageMetadata } from "../usage-validation";

type GeminiPart = Record<string, unknown>;

/**
 * Accumulate an upstream Gemini SSE (`?alt=sse`) response into a
 * `GatewayResponse`. Text parts arrive as deltas across frames and are
 * concatenated; `functionCall` parts arrive complete; `usageMetadata` and
 * `finishReason` appear on the final frame(s).
 */
export async function accumulateGeminiSSEStream(
  upstreamResponse: Response,
  opts: {
    signal?: AbortSignal;
    stopAtTerminal?: boolean;
    strict?: boolean;
    inactivityMs?: number;
    maxFrames?: number;
    onSemanticContent?: () => void;
    onValidatedEvent?: (event: string, data: string) => void | Promise<void>;
  } = {},
): Promise<GatewayResponse> {
  if (!upstreamResponse.body) {
    throw new Error("Upstream response has no body");
  }

  let textContent = "";
  let thinkingContent = "";
  const toolUses: Array<{ id: string; name: string; input: unknown }> = [];
  let finishReason: unknown;
  let model = "";
  let responseId = "";
  let usage: GatewayUsage = { ...ZERO_USAGE };
  let terminalSeen = false;
  const toolIdentitiesByCandidate = new Map<number, Set<string>>();

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
      if (!data || data === "[DONE]") continue;
      let parsed: Record<string, unknown>;
      try {
        const decoded: unknown = JSON.parse(data);
        if (!isRecord(decoded)) {
          if (opts.strict) throw new Error("malformed Gemini stream event");
          continue;
        }
        parsed = decoded;
      } catch {
        if (opts.strict) throw new Error("malformed Gemini stream event");
        continue;
      }

      if (opts.strict) {
        const malformed = (): never => {
          throw new Error("malformed Gemini stream event");
        };
        if (
          parsed.candidates !== undefined &&
          !Array.isArray(parsed.candidates)
        ) {
          malformed();
        }
        if (Array.isArray(parsed.candidates)) {
          for (const [
            candidatePosition,
            candidate,
          ] of parsed.candidates.entries()) {
            if (!isRecord(candidate)) malformed();
            if (
              candidate.index !== undefined &&
              (!Number.isSafeInteger(candidate.index) ||
                (candidate.index as number) < 0)
            ) {
              malformed();
            }
            if (
              candidate.finishReason !== undefined &&
              candidate.finishReason !== null &&
              typeof candidate.finishReason !== "string"
            ) {
              malformed();
            }
            if (
              candidate.tokenCount !== undefined &&
              (!Number.isSafeInteger(candidate.tokenCount) ||
                (candidate.tokenCount as number) < 0)
            ) {
              malformed();
            }
            const candidateIndex =
              typeof candidate.index === "number"
                ? candidate.index
                : candidatePosition;
            let toolIdentities = toolIdentitiesByCandidate.get(candidateIndex);
            if (!toolIdentities) {
              toolIdentities = new Set<string>();
              toolIdentitiesByCandidate.set(candidateIndex, toolIdentities);
            }
            if (candidate.content === undefined) continue;
            if (!isRecord(candidate.content)) malformed();
            if (
              candidate.content.role !== undefined &&
              typeof candidate.content.role !== "string"
            ) {
              malformed();
            }
            const candidateParts = candidate.content.parts;
            if (candidateParts === undefined) continue;
            if (!Array.isArray(candidateParts)) malformed();
            for (const part of candidateParts) {
              if (!isRecord(part)) malformed();
              if (part.text !== undefined && part.functionCall !== undefined) {
                malformed();
              }
              if (part.text !== undefined && typeof part.text !== "string") {
                malformed();
              }
              if (
                part.thought !== undefined &&
                typeof part.thought !== "boolean"
              ) {
                malformed();
              }
              if (part.functionCall === undefined) continue;
              validateGeminiFunctionCallIdentity(
                part.functionCall,
                toolIdentities,
                "malformed Gemini stream event",
              );
            }
          }
        }
        validateGeminiUsageMetadata(
          parsed.usageMetadata,
          "malformed Gemini stream event",
        );
        if (parsed.promptFeedback !== undefined) {
          if (!isRecord(parsed.promptFeedback)) malformed();
          const promptFeedback = parsed.promptFeedback as Record<
            string,
            unknown
          >;
          if (
            promptFeedback.blockReason !== undefined &&
            typeof promptFeedback.blockReason !== "string"
          ) {
            malformed();
          }
        }
      }

      if (
        opts.strict &&
        ((parsed.modelVersion !== undefined &&
          typeof parsed.modelVersion !== "string") ||
          (model &&
            typeof parsed.modelVersion === "string" &&
            parsed.modelVersion !== model) ||
          (parsed.responseId !== undefined &&
            typeof parsed.responseId !== "string") ||
          (responseId &&
            typeof parsed.responseId === "string" &&
            parsed.responseId !== responseId))
      ) {
        throw new Error("malformed Gemini stream event");
      }
      if (typeof parsed.modelVersion === "string") model = parsed.modelVersion;
      if (typeof parsed.responseId === "string") responseId = parsed.responseId;

      const candidates = Array.isArray(parsed.candidates)
        ? parsed.candidates
        : [];
      const promptFeedback = isRecord(parsed.promptFeedback)
        ? parsed.promptFeedback
        : undefined;
      if (
        candidates.length === 0 &&
        typeof promptFeedback?.blockReason === "string" &&
        promptFeedback.blockReason
      ) {
        finishReason = promptFeedback.blockReason;
      }
      const first = isRecord(candidates[0]) ? candidates[0] : {};
      const content = isRecord(first.content) ? first.content : {};
      const parts = Array.isArray(content.parts)
        ? (content.parts as GeminiPart[])
        : [];
      for (const p of parts) {
        if (typeof p.text === "string") {
          if (p.text) opts.onSemanticContent?.();
          // Keep reasoning-summary parts (`thought: true`) out of the visible
          // answer text — accumulate them into a separate thinking block.
          if (p.thought === true) thinkingContent += p.text;
          else textContent += p.text;
        } else if (p.functionCall && typeof p.functionCall === "object") {
          opts.onSemanticContent?.();
          const fc = p.functionCall as {
            id?: unknown;
            name?: unknown;
            args?: unknown;
          };
          const name = asString(fc.name);
          toolUses.push({
            id: asString(fc.id) || name,
            name,
            input: fc.args ?? {},
          });
        }
      }
      if (first.finishReason != null) finishReason = first.finishReason;

      // streamGenerateContent reports cumulative usageMetadata on the same
      // candidate frame that carries finishReason. The API has no OpenAI-style
      // legal usage-only frame after that terminal, so stopAtTerminal
      // intentionally cancels transport tail instead of waiting indefinitely.
      // Last non-null usage before/on that frame wins.
      const um = validateGeminiUsageMetadata(
        parsed.usageMetadata,
        "malformed Gemini stream event",
      );
      if (um) usage = geminiUsageFromMetadata(um);
      await opts.onValidatedEvent?.(event, data);
      if (
        opts.stopAtTerminal &&
        typeof finishReason === "string" &&
        finishReason !== "" &&
        finishReason !== "FINISH_REASON_UNSPECIFIED"
      ) {
        terminalSeen = true;
        break;
      }
    }
  } finally {
    cancelAndReleaseReader(reader);
  }

  if (opts.stopAtTerminal && !terminalSeen) {
    throw new Error("missing Gemini finishReason terminal");
  }

  const blocks: GatewayContentBlock[] = [];
  if (thinkingContent)
    blocks.push({ type: "thinking", thinking: thinkingContent });
  if (textContent) blocks.push({ type: "text", text: textContent });
  for (const tu of toolUses) {
    blocks.push({
      type: "tool_use",
      id: tu.id,
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
  opts: { strict?: boolean; signal?: AbortSignal } = {},
): Response {
  const downstreamAbort = new AbortController();
  const signal = opts.signal
    ? AbortSignal.any([opts.signal, downstreamAbort.signal])
    : downstreamAbort.signal;
  let pumpStarted = false;
  let settled = false;
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const cleanup = (): void =>
    opts.signal?.removeEventListener("abort", onAbort);
  const onAbort = (): void => {
    if (settled) return;
    settled = true;
    const reason = opts.signal?.reason;
    downstreamAbort.abort(reason);
    if (!pumpStarted) {
      try {
        void anthropicResponse.body?.cancel(reason).catch(() => {});
      } catch {
        // Best-effort cancellation before reader acquisition.
      }
    }
    cleanup();
    try {
      streamController?.error(reason);
    } catch {
      // Already closed/cancelled.
    }
  };
  const stream = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        streamController = controller;
        opts.signal?.addEventListener("abort", onAbort, { once: true });
        if (opts.signal?.aborted) onAbort();
      },
      pull(controller) {
        if (pumpStarted) return;
        pumpStarted = true;
        const encoder = new TextEncoder();
        const pump = async (): Promise<void> => {
          try {
            const resp = await accumulateSSEResponse(anthropicResponse, {
              signal,
              strict: opts.strict,
              stopAtTerminal: opts.strict,
            });
            if (settled) return;
            const body = buildGeminiResponseBody(resp);
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(body)}\n\n`),
            );
            settled = true;
            cleanup();
            controller.close();
          } catch (error) {
            if (settled) return;
            settled = true;
            cleanup();
            controller.error(error);
          }
        };
        queueMicrotask(() => void pump().catch(() => {}));
      },
      cancel(reason) {
        if (settled) return;
        settled = true;
        cleanup();
        downstreamAbort.abort(reason);
        if (!pumpStarted) {
          try {
            void anthropicResponse.body?.cancel(reason).catch(() => {});
          } catch {
            // Best-effort cancellation before reader acquisition.
          }
        }
      },
    },
    {
      // Do not consume/buffer the Anthropic source until a downstream read asks
      // for the single aggregated Gemini frame.
      highWaterMark: 0,
    },
  );

  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}
