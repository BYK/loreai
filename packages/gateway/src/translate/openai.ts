/**
 * OpenAI ↔ Gateway translation layer.
 *
 * Converts between OpenAI's `/v1/chat/completions` API format and the gateway's
 * internal `GatewayRequest`/`GatewayResponse` types.
 */
import type {
  GatewayContentBlock,
  GatewayMessage,
  GatewayRequest,
  GatewayResponse,
  GatewayTool,
} from "./types";
import { blocksToText, forwardClientHeaders, ZERO_USAGE } from "./types";
import { asString } from "@loreai/core";
import { extractAuth } from "../auth";

// ---------------------------------------------------------------------------
// OpenAI → GatewayRequest
// ---------------------------------------------------------------------------

export function parseOpenAIRequest(
  body: unknown,
  headers: Record<string, string>,
): GatewayRequest {
  const raw = (body ?? {}) as Record<string, unknown>;

  // Extract known fields
  const model = asString(raw.model);
  const stream = raw.stream === true;

  // max_tokens defaults to 4096 if not specified
  const maxTokens = typeof raw.max_tokens === "number" ? raw.max_tokens : 4096;

  // Extract extras (temperature, top_p, etc.) for later forwarding
  const extras: GatewayRequest["extras"] = {};
  if (typeof raw.temperature === "number") {
    extras.temperature = raw.temperature;
  }
  if (typeof raw.top_p === "number") {
    extras.top_p = raw.top_p;
  }
  if (typeof raw.frequency_penalty === "number") {
    extras.frequency_penalty = raw.frequency_penalty;
  }
  if (typeof raw.presence_penalty === "number") {
    extras.presence_penalty = raw.presence_penalty;
  }
  if (typeof raw.user === "string") {
    extras.user = raw.user;
  }
  if (raw.logprobs === true || raw.logprobs === false) {
    extras.logprobs = raw.logprobs;
  }
  if (typeof raw.top_logprobs === "number") {
    extras.top_logprobs = raw.top_logprobs;
  }

  // Parse messages and extract system prompt
  const rawMessages = Array.isArray(raw.messages) ? raw.messages : [];
  let system = "";
  const messages: GatewayMessage[] = [];

  for (const msg of rawMessages as Array<Record<string, unknown>>) {
    const role = msg.role as string;
    const content = msg.content;

    if (role === "system" || role === "developer") {
      // Concatenate multiple system/developer messages with double newline.
      // Content can be a string or an array of content parts — extract text
      // from both forms instead of coercing arrays to "".
      let text = "";
      if (typeof content === "string") {
        text = content;
      } else if (Array.isArray(content)) {
        text = (content as Array<Record<string, unknown>>)
          .filter((b) => b.type === "text")
          .map((b) => asString(b.text))
          .join("\n");
      }
      if (system) {
        system += `\n\n${text}`;
      } else {
        system = text;
      }
      continue;
    }

    if (role === "user") {
      const blocks = parseUserContent(
        content,
        msg.tool_calls as Array<Record<string, unknown>> | undefined,
      );
      messages.push({ role: "user", content: blocks });
      continue;
    }

    if (role === "assistant") {
      const blocks = parseAssistantContent(
        content,
        msg.tool_calls as Array<Record<string, unknown>> | undefined,
      );
      messages.push({ role: "assistant", content: blocks });
      continue;
    }

    if (role === "tool") {
      // OpenAI sends each tool response as its own `role:"tool"` message, but
      // the gateway's downstream tool-pairing (loreMessagesToGateway +
      // removeOrphanedToolResults) assumes the Anthropic shape: the single
      // user message immediately after an assistant carries ALL matching
      // tool_result blocks. Coalesce consecutive tool messages into one user
      // message so an assistant emitting N tool_calls keeps its N tool_use
      // blocks paired with N tool_result blocks in that one following message.
      const toolResultBlocks = parseToolResult(msg);
      if (toolResultBlocks.length > 0) {
        const last = messages[messages.length - 1];
        // Only merge into a user message that was itself produced from tool
        // messages — never a genuine user text turn.
        const lastIsToolResultMessage =
          last !== undefined &&
          last.role === "user" &&
          last.content.length > 0 &&
          last.content.every((b) => b.type === "tool_result");
        if (lastIsToolResultMessage) {
          last.content.push(...toolResultBlocks);
        } else {
          messages.push({ role: "user", content: toolResultBlocks });
        }
      }
    }
  }

  // Parse tools
  const rawTools = Array.isArray(raw.tools) ? raw.tools : [];
  const tools: GatewayTool[] = rawTools.map((t: Record<string, unknown>) => {
    const func = t.function as Record<string, unknown> | undefined;
    return {
      name: asString(func?.name ?? t.name),
      description: asString(func?.description),
      inputSchema: (func?.parameters as Record<string, unknown>) ?? {},
    };
  });

  return {
    protocol: "openai",
    model,
    system,
    messages,
    tools,
    stream,
    maxTokens,
    metadata: {},
    rawHeaders: {
      ...headers,
      "x-api-key": headers["x-api-key"] ?? "",
    },
    extras,
  };
}

function parseUserContent(
  content: unknown,
  toolCalls?: Array<Record<string, unknown>>,
): GatewayContentBlock[] {
  const blocks: GatewayContentBlock[] = [];

  if (typeof content === "string" && content) {
    blocks.push({ type: "text", text: content });
  } else if (Array.isArray(content)) {
    for (const item of content as Array<Record<string, unknown>>) {
      if (item.type === "text") {
        blocks.push({ type: "text", text: asString(item.text) });
      } else if (item.type === "tool_use") {
        blocks.push({
          type: "tool_use",
          id: asString(item.id),
          name: asString(item.name),
          input: item.input ?? {},
        });
      } else {
        // Unknown content part (image_url, input_audio, file, …) — preserve
        // verbatim as opaque so it round-trips losslessly.
        blocks.push({ type: "opaque", raw: item });
      }
    }
  }

  // Add tool_use blocks from tool_calls field
  if (toolCalls) {
    for (const tc of toolCalls) {
      const fn = tc.function as Record<string, unknown> | undefined;
      let input: unknown = {};
      if (fn?.arguments) {
        try {
          input = JSON.parse(fn.arguments as string);
        } catch {
          input = fn.arguments;
        }
      }
      blocks.push({
        type: "tool_use",
        id: asString(tc.id),
        name: asString(fn?.name),
        input,
      });
    }
  }

  return blocks;
}

function parseAssistantContent(
  content: unknown,
  toolCalls?: Array<Record<string, unknown>>,
): GatewayContentBlock[] {
  const blocks: GatewayContentBlock[] = [];

  if (typeof content === "string" && content) {
    blocks.push({ type: "text", text: content });
  } else if (Array.isArray(content)) {
    for (const item of content as Array<Record<string, unknown>>) {
      if (item.type === "text") {
        blocks.push({ type: "text", text: asString(item.text) });
      } else if (item.type === "tool_use") {
        blocks.push({
          type: "tool_use",
          id: asString(item.id),
          name: asString(item.name),
          input: item.input ?? {},
        });
      } else {
        // Unknown content part — preserve verbatim as opaque.
        blocks.push({ type: "opaque", raw: item });
      }
    }
  }

  // Add tool_use blocks from tool_calls field
  if (toolCalls) {
    for (const tc of toolCalls) {
      const fn = tc.function as Record<string, unknown> | undefined;
      let input: unknown = {};
      if (fn?.arguments) {
        try {
          input = JSON.parse(fn.arguments as string);
        } catch {
          input = fn.arguments;
        }
      }
      blocks.push({
        type: "tool_use",
        id: asString(tc.id),
        name: asString(fn?.name),
        input,
      });
    }
  }

  return blocks;
}

function parseToolResult(msg: Record<string, unknown>): GatewayContentBlock[] {
  const toolCallId = asString(msg.tool_call_id);
  const content = msg.content;

  // Normalize tool-result content to a block array so non-text sub-blocks
  // (images, files, …) survive the round-trip.
  let innerBlocks: GatewayContentBlock[];
  if (typeof content === "string") {
    innerBlocks = content ? [{ type: "text", text: content }] : [];
  } else if (Array.isArray(content)) {
    innerBlocks = (content as Array<Record<string, unknown>>).map((item) => {
      if (item.type === "text") {
        return { type: "text" as const, text: asString(item.text) };
      }
      // Unknown sub-block (image_url, …) — preserve as opaque.
      return { type: "opaque" as const, raw: item };
    });
  } else {
    innerBlocks = [];
  }

  return [
    {
      type: "tool_result",
      toolUseId: toolCallId,
      content: innerBlocks,
    },
  ];
}

// ---------------------------------------------------------------------------
// GatewayResponse → OpenAI response
// ---------------------------------------------------------------------------

export function buildOpenAIResponse(
  resp: GatewayResponse,
  wasStreaming: boolean,
): Response {
  if (wasStreaming) {
    return buildOpenAIStreamResponse(resp);
  }
  return buildOpenAINonStreamResponse(resp);
}

function buildOpenAINonStreamResponse(resp: GatewayResponse): Response {
  const usage = resp.usage ?? ZERO_USAGE;
  const _chunks: unknown[] = [];
  let content = "";
  const toolCalls: Array<Record<string, unknown>> = [];

  for (const block of resp.content) {
    if (block.type === "text") {
      content += block.text;
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        type: "function",
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input),
        },
      });
    }
  }

  const message: Record<string, unknown> = {
    role: "assistant",
    content: content || null,
  };

  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls;
  }

  const response = {
    id: resp.id.startsWith("chatcmpl-") ? resp.id : `chatcmpl-${resp.id}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: resp.model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: mapStopReason(resp.stopReason),
        logprobs: null,
      },
    ],
    usage: {
      prompt_tokens: usage.inputTokens,
      completion_tokens: usage.outputTokens,
      total_tokens: usage.inputTokens + usage.outputTokens,
      ...(usage.cacheReadInputTokens != null
        ? {
            prompt_tokens_details: {
              cached_tokens: usage.cacheReadInputTokens,
            },
          }
        : {}),
    },
  };

  return new Response(JSON.stringify(response), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

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

function buildOpenAIStreamResponse(resp: GatewayResponse): Response {
  const encoder = new TextEncoder();
  let offset = 0;

  const stream = new ReadableStream({
    start(controller) {
      const baseId = resp.id.startsWith("chatcmpl-")
        ? resp.id
        : `chatcmpl-${resp.id}`;
      const created = Math.floor(Date.now() / 1000);

      function emitChunk(
        delta: Record<string, unknown>,
        finishReason: string | null,
      ) {
        const chunk = {
          id: baseId,
          object: "chat.completion.chunk",
          created,
          model: resp.model,
          choices: [
            {
              index: 0,
              delta,
              finish_reason: finishReason,
            },
          ],
        };
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`),
        );
      }

      // Emit role in first chunk
      emitChunk({ role: "assistant" }, null);

      // Process content blocks
      for (const block of resp.content) {
        if (block.type === "text") {
          // Split text into small chunks to simulate streaming
          const text = block.text;
          let pos = 0;
          while (pos < text.length) {
            const chunk = text.slice(pos, pos + 10);
            emitChunk({ content: chunk }, null);
            pos += 10;
          }
        } else if (block.type === "tool_use") {
          emitChunk(
            {
              tool_calls: [
                {
                  index: offset,
                  id: block.id,
                  type: "function",
                  function: {
                    name: block.name,
                    arguments: JSON.stringify(block.input),
                  },
                },
              ],
            },
            null,
          );
          offset++;
        }
      }

      // Emit final chunk with finish reason
      emitChunk({}, mapStopReason(resp.stopReason));

      // Send [DONE] marker
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
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
// GatewayRequest → OpenAI upstream request
// ---------------------------------------------------------------------------

/**
 * Default Chat Completions path appended to a bare provider origin. Most
 * OpenAI-compatible providers serve at `<base>/v1/chat/completions`.
 */
const DEFAULT_OPENAI_CHAT_COMPLETIONS_PATH = "/v1/chat/completions";

/**
 * Hosts whose OpenAI-compatible Chat Completions endpoint is NOT served at the
 * conventional `<base>/v1/chat/completions`. Maps hostname → the exact path the
 * gateway must append to the provider origin instead:
 *
 *  - GitHub Copilot omits the `/v1` segment entirely (`/chat/completions`);
 *    prepending `/v1` yields `404 page not found` (issue #1052).
 *  - Google's Gemini OpenAI-compatibility layer serves under
 *    `/v1beta/openai/chat/completions`; `/v1/chat/completions` 404s (issue
 *    #1070).
 *
 * Keyed by hostname so the override holds regardless of which routing tier
 * produced the base URL.
 *
 * Foreground requests that come through the fetch interceptor forward verbatim
 * to the client's original endpoint (see `verbatimUpstreamUrl`); this map covers
 * the paths the gateway must RECONSTRUCT from scratch — background worker
 * requests (which have no original request to forward) and any provider invoked
 * purely via its `X-Lore-Provider` route with no preserved endpoint path.
 */
const OPENAI_HOST_CHAT_COMPLETIONS_PATHS: ReadonlyMap<string, string> = new Map(
  [["generativelanguage.googleapis.com", "/v1beta/openai/chat/completions"]],
);

/**
 * GitHub Copilot serves Chat Completions at `/chat/completions` (NO `/v1`) on
 * ALL of its hosts, not just `api.githubcopilot.com`. Per-plan/regional hosts
 * carry a subdomain segment — `api.individual.githubcopilot.com` (free/OSS
 * quota), `api.business.githubcopilot.com`, `api.enterprise.githubcopilot.com`,
 * and the `proxy.*` variants — and the token exchange (`copilot_internal/v2/
 * token`) returns the account's specific host in `endpoints.api`. Matching the
 * whole domain (not a single host) keeps individual/enterprise accounts from
 * being reconstructed as `<host>/v1/chat/completions` → 404 (issue #1052).
 */
export function isGitHubCopilotHost(hostname: string): boolean {
  return (
    hostname === "githubcopilot.com" || hostname.endsWith(".githubcopilot.com")
  );
}

/**
 * Build the OpenAI Chat Completions upstream URL for an upstream base.
 *
 * Most OpenAI-compatible providers serve at `<base>/v1/chat/completions`, so the
 * route tables store a bare origin and the gateway appends `/v1/...`. Two
 * exceptions are handled, in priority order:
 *
 *  1. GitHub Copilot hosts (any `*.githubcopilot.com`, issue #1052) serve at
 *     `/chat/completions` with no `/v1`, and hosts in
 *     `OPENAI_HOST_CHAT_COMPLETIONS_PATHS` use a fixed non-`/v1` endpoint path
 *     (Google's `/v1beta/openai/...`, issue #1070). These hosts' route bases are
 *     bare origins, so the mapped path is simply appended.
 *  2. A base whose pathname already ends in a version segment (e.g. Z.AI's
 *     user-configured `.../api/paas/v4`, issue #1093) serves Chat Completions at
 *     `<base>/chat/completions`; appending the default `/v1` would duplicate the
 *     version (`.../v4/v1/chat/completions`) and 404. Such bases come from
 *     user-supplied `LORE_UPSTREAM_<PROVIDER>` values (`url: null` routes) where
 *     the host cannot be keyed in the static map above. Appending only
 *     `/chat/completions` is also a no-op harmless normalization for a base that
 *     already carries `/v1`.
 *
 * Falls back to the default `/v1` form when `base` cannot be parsed as a URL.
 */
export function buildOpenAIChatCompletionsUrl(base: string): string {
  try {
    const { hostname, pathname } = new URL(base);
    // GitHub Copilot (all hosts, incl. api.individual/business/enterprise.*)
    // serves at /chat/completions with no /v1 prefix — issue #1052.
    if (isGitHubCopilotHost(hostname)) {
      return `${base}/chat/completions`;
    }
    const hostPath = OPENAI_HOST_CHAT_COMPLETIONS_PATHS.get(hostname);
    if (hostPath !== undefined) {
      return `${base}${hostPath}`;
    }
    // Base already ends in a version segment (`/v4`, `/v1`, …) → the API path is
    // just `/chat/completions`; a `/v1` prefix would double the version.
    if (/\/v\d+$/.test(pathname)) {
      return `${base}/chat/completions`;
    }
  } catch {
    // Unparseable base (e.g. a bare placeholder) — keep the default `/v1` path.
  }
  return `${base}${DEFAULT_OPENAI_CHAT_COMPLETIONS_PATH}`;
}

export function buildOpenAIUpstreamRequest(
  req: GatewayRequest,
  upstreamBase: string,
): { url: string; headers: Record<string, string>; body: unknown } {
  // Forward non-managed client headers first, then overlay gateway-managed.
  const headers: Record<string, string> = {
    ...forwardClientHeaders(req.rawHeaders),
    "content-type": "application/json",
  };

  // Forward auth from the original request — OpenAI-protocol upstreams
  // always use Bearer regardless of the incoming auth scheme.
  const cred = extractAuth(req.rawHeaders);
  if (cred) {
    headers.Authorization = `Bearer ${cred.value}`;
  }

  const body: Record<string, unknown> = {
    model: req.model,
    messages: buildOpenAIMessages(req.messages, req.system),
    stream: req.stream,
  };

  if (req.maxTokens) {
    body.max_tokens = req.maxTokens;
  }

  // Add tools in OpenAI format
  if (req.tools.length > 0) {
    body.tools = req.tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      },
    }));
  }

  // Forward extras
  if (req.extras) {
    if (req.extras.temperature !== undefined) {
      body.temperature = req.extras.temperature;
    }
    if (req.extras.top_p !== undefined) {
      body.top_p = req.extras.top_p;
    }
    if (req.extras.frequency_penalty !== undefined) {
      body.frequency_penalty = req.extras.frequency_penalty;
    }
    if (req.extras.presence_penalty !== undefined) {
      body.presence_penalty = req.extras.presence_penalty;
    }
    if (req.extras.user !== undefined) {
      body.user = req.extras.user;
    }
    if (req.extras.logprobs !== undefined) {
      body.logprobs = req.extras.logprobs;
    }
    if (req.extras.top_logprobs !== undefined) {
      body.top_logprobs = req.extras.top_logprobs;
    }
  }

  return {
    url: buildOpenAIChatCompletionsUrl(upstreamBase),
    headers,
    body,
  };
}

function buildOpenAIMessages(
  messages: GatewayMessage[],
  system: string,
): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = [];

  // Add system prompt if present
  if (system) {
    result.push({ role: "system", content: system });
  }

  for (const msg of messages) {
    const blocks = msg.content;
    const role = msg.role;

    // Collect text, opaque (image/audio/…), and tool_use blocks.
    const contentParts: Array<Record<string, unknown>> = [];
    const toolUses: Array<Record<string, unknown>> = [];
    let hasOpaque = false;

    for (const block of blocks) {
      if (block.type === "text") {
        contentParts.push({ type: "text", text: block.text });
      } else if (block.type === "tool_use") {
        toolUses.push({
          id: block.id,
          type: "function",
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input),
          },
        });
      } else if (block.type === "tool_result") {
        // OpenAI tool messages take a string content field. Use the text
        // projection — non-text sub-blocks (images) are represented as
        // placeholders. (OpenAI's wire format can't carry structured
        // tool-result content; Anthropic-native clients are unaffected.)
        result.push({
          role: "tool",
          tool_call_id: block.toolUseId,
          content: blocksToText(block.content),
        });
      } else if (block.type === "opaque") {
        // Re-emit the original block verbatim (e.g. image_url, input_audio).
        contentParts.push(block.raw);
        hasOpaque = true;
      }
    }

    if (contentParts.length > 0 || toolUses.length > 0) {
      const msgRecord: Record<string, unknown> = { role };

      if (contentParts.length > 0) {
        // Use array form when non-text (opaque) parts are present — OpenAI
        // requires array content for multimodal messages. Use plain string
        // when text-only for maximum compatibility and cache stability.
        if (hasOpaque) {
          msgRecord.content = contentParts;
        } else {
          msgRecord.content = contentParts
            .map((p) => asString(p.text))
            .join("");
        }
      }

      if (toolUses.length > 0) {
        msgRecord.tool_calls = toolUses;
      }

      result.push(msgRecord);
    }
  }

  return result;
}
