/**
 * Streaming-aware replay interceptor for the gateway test harness.
 *
 * The production `getReplayInterceptor` (src/recorder.ts) always returns a
 * non-streaming JSON response. That works for `stream: false` turns, but the
 * pipeline's streaming path forwards an upstream **SSE byte stream**
 * (buildStreamingResponse parses Anthropic named events). When the client
 * requested streaming, the gateway sends `stream: true` upstream, so a
 * faithful replay must hand back an SSE stream — otherwise the accumulator
 * sees no events and the client receives an empty body.
 *
 * This helper mirrors that: it returns Anthropic SSE for streaming requests
 * whose fixture is an Anthropic message (has a `content` array), and plain
 * JSON otherwise (preserving the existing non-streaming behavior exactly).
 *
 * Lives under test/helpers (excluded from coverage) and is wired only into
 * the gateway harness — src/recorder.ts and the core eval harness are
 * intentionally left unchanged.
 */
import type { FixtureEntry, UpstreamInterceptor } from "../../src/recorder";

interface AnthropicBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

interface AnthropicMessage {
  id?: string;
  model?: string;
  content?: AnthropicBlock[];
  stop_reason?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

function isAnthropicMessage(resp: unknown): resp is AnthropicMessage {
  return (
    typeof resp === "object" &&
    resp !== null &&
    Array.isArray((resp as { content?: unknown }).content)
  );
}

function sseEvent(type: string, data: unknown): string {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Convert an Anthropic message JSON into a well-formed Anthropic SSE event
 * sequence:
 *   message_start → (content_block_start/delta/stop)* → message_delta →
 *   message_stop
 *
 * Handles text and tool_use content blocks.
 */
export function anthropicMessageToSSE(message: AnthropicMessage): string {
  const id = message.id ?? "msg_replay";
  const model = message.model ?? "claude-replay";
  const content = message.content ?? [];
  const usage = message.usage ?? {};
  const stopReason = message.stop_reason ?? "end_turn";

  const events: string[] = [];

  events.push(
    sseEvent("message_start", {
      type: "message_start",
      message: {
        id,
        type: "message",
        role: "assistant",
        content: [],
        model,
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: usage.input_tokens ?? 0,
          output_tokens: 1,
          ...(usage.cache_read_input_tokens != null
            ? { cache_read_input_tokens: usage.cache_read_input_tokens }
            : {}),
          ...(usage.cache_creation_input_tokens != null
            ? { cache_creation_input_tokens: usage.cache_creation_input_tokens }
            : {}),
        },
      },
    }),
  );

  content.forEach((block, index) => {
    if (block.type === "text") {
      events.push(
        sseEvent("content_block_start", {
          type: "content_block_start",
          index,
          content_block: { type: "text", text: "" },
        }),
      );
      events.push(
        sseEvent("content_block_delta", {
          type: "content_block_delta",
          index,
          delta: { type: "text_delta", text: block.text ?? "" },
        }),
      );
      events.push(
        sseEvent("content_block_stop", { type: "content_block_stop", index }),
      );
    } else if (block.type === "tool_use") {
      events.push(
        sseEvent("content_block_start", {
          type: "content_block_start",
          index,
          content_block: {
            type: "tool_use",
            id: block.id ?? `toolu_${index}`,
            name: block.name ?? "tool",
            input: {},
          },
        }),
      );
      events.push(
        sseEvent("content_block_delta", {
          type: "content_block_delta",
          index,
          delta: {
            type: "input_json_delta",
            partial_json: JSON.stringify(block.input ?? {}),
          },
        }),
      );
      events.push(
        sseEvent("content_block_stop", { type: "content_block_stop", index }),
      );
    }
  });

  events.push(
    sseEvent("message_delta", {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: usage.output_tokens ?? 0 },
    }),
  );
  events.push(sseEvent("message_stop", { type: "message_stop" }));

  return events.join("");
}

/**
 * Build a replay interceptor that serves fixtures in sequence. For streaming
 * Anthropic turns it returns reconstructed SSE; otherwise it returns the
 * fixture response as JSON (identical to getReplayInterceptor). Throws when
 * fixtures are exhausted.
 */
export function makeReplayInterceptor(
  fixtures: FixtureEntry[],
): UpstreamInterceptor {
  let replayCounter = 0;

  return async (_requestBody, _model, wasStreaming, _makeRealRequest) => {
    if (replayCounter >= fixtures.length) {
      throw new Error(
        `Replay exhausted: no more fixtures (tried to replay entry ${replayCounter}, ` +
          `but only ${fixtures.length} fixture(s) are available)`,
      );
    }

    const fixture = fixtures[replayCounter++];

    if (wasStreaming && isAnthropicMessage(fixture.response)) {
      return new Response(anthropicMessageToSSE(fixture.response), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }

    return new Response(JSON.stringify(fixture.response), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}
