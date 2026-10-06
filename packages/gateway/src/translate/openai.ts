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
  GatewayUsage,
} from "./types";
import {
  blocksToText,
  forwardClientHeaders,
  providerRoutingValue,
  requestTargetsOpenRouter,
  ZERO_USAGE,
} from "./types";
import type { AnthropicCacheOptions } from "./anthropic";
import { asString, digestChain } from "@loreai/core";
import { extractAuth } from "../auth";
import { safeTokenSum } from "../usage-validation";
import {
  parseStreamedRequest,
  type StreamedItemsBuilder,
} from "./streaming-request";
import { parseContextBoundary } from "../context-boundary";
import {
  InvalidCrossProviderRequestError,
  requireTextOnlyToolResult,
} from "./errors";

type OpenAIMessages = {
  system: string;
  messages: GatewayMessage[];
  hasDeveloperInstruction: boolean;
  nativeChatInstructionPrefix: NonNullable<
    GatewayRequest["extras"]
  >["nativeChatInstructionPrefix"];
  boundarySafe: boolean;
  retainedItems: number;
};

function supportedInstructionCacheControl(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const control = value as Record<string, unknown>;
  return (
    control.type === "ephemeral" &&
    (control.ttl === undefined || control.ttl === "1h") &&
    Object.keys(control).every((key) => key === "type" || key === "ttl")
  );
}

export function createOpenAIMessagesBuilder(): StreamedItemsBuilder<OpenAIMessages> {
  let system = "";
  const messages: GatewayMessage[] = [];
  let leadingSystemItems = 0;
  let sawConversationItem = false;
  let systemAfterConversation = false;
  let hasDeveloperInstruction = false;
  let hasInstructionCacheControl = false;
  const instructionItems: NonNullable<
    OpenAIMessages["nativeChatInstructionPrefix"]
  >["items"] = [];
  let seamKind: "none" | "other" | "tool-result" = "none";
  return {
    add(item) {
      const msg = item as Record<string, unknown>;
      const role = msg.role as string;
      const content = msg.content;

      if (role === "system" || role === "developer") {
        if (role === "developer") hasDeveloperInstruction = true;
        if (sawConversationItem) systemAfterConversation = true;
        else leadingSystemItems++;
        let text = "";
        if (typeof content === "string") {
          text = content;
        } else if (Array.isArray(content)) {
          if (
            content.some(
              (part) =>
                !part ||
                part.type !== "text" ||
                typeof part.text !== "string" ||
                Object.keys(part).some(
                  (key) =>
                    key !== "type" && key !== "text" && key !== "cache_control",
                ) ||
                (part.cache_control !== undefined &&
                  !supportedInstructionCacheControl(part.cache_control)),
            )
          ) {
            throw new InvalidCrossProviderRequestError();
          }
          text = (content as Array<Record<string, unknown>>)
            .filter((b) => b.type === "text")
            .map((b) => asString(b.text))
            .join("\n");
          if (content.some((part) => part.cache_control !== undefined)) {
            hasInstructionCacheControl = true;
          }
        } else {
          throw new InvalidCrossProviderRequestError();
        }
        instructionItems.push({
          role,
          content:
            typeof content === "string"
              ? content
              : (content as Array<{ type: "text"; text: string }>).map(
                  (part) => ({ ...part }),
                ),
        });
        if (system) {
          system += `\n\n${text}`;
        } else {
          system = text;
        }
        return;
      }

      sawConversationItem = true;

      if (role === "user") {
        const blocks = parseUserContent(
          content,
          msg.tool_calls as Array<Record<string, unknown>> | undefined,
        );
        messages.push(chatMessageWithTextProvenance("user", blocks));
        seamKind = "other";
        return;
      }

      if (role === "assistant") {
        const blocks = parseAssistantContent(
          content,
          msg.tool_calls as Array<Record<string, unknown>> | undefined,
        );
        messages.push(chatMessageWithTextProvenance("assistant", blocks));
        seamKind = "other";
        return;
      }

      if (role === "tool") {
        const toolResultBlocks = parseToolResult(msg);
        if (toolResultBlocks.length > 0) {
          const last = messages[messages.length - 1];
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
          seamKind = "tool-result";
        }
      }
    },
    finish() {
      return {
        system,
        messages,
        hasDeveloperInstruction,
        nativeChatInstructionPrefix:
          hasDeveloperInstruction ||
          systemAfterConversation ||
          hasInstructionCacheControl
            ? {
                normalizedSystem: system,
                hasLateItems: systemAfterConversation,
                items: instructionItems,
              }
            : undefined,
        // A suffix cannot recover the developer tier from normalized system
        // text, so it must never inherit a checkpoint without this marker.
        boundarySafe:
          !hasDeveloperInstruction &&
          !systemAfterConversation &&
          !hasInstructionCacheControl &&
          seamKind === "other",
        retainedItems: leadingSystemItems,
      };
    },
  };
}

function chatMessageWithTextProvenance(
  role: GatewayMessage["role"],
  content: GatewayContentBlock[],
): GatewayMessage {
  return content.some((block) => block.type === "text" && block.raw)
    ? {
        role,
        content,
        provenanceContent: content,
        provenancePositions: content.map((_block, index) => index),
      }
    : { role, content };
}

function chatTextPart(item: Record<string, unknown>): GatewayContentBlock {
  if (typeof item.text !== "string") {
    throw new InvalidCrossProviderRequestError();
  }
  return Object.keys(item).some((key) => key !== "type" && key !== "text")
    ? { type: "text", text: item.text, raw: item }
    : { type: "text", text: item.text };
}

function openAIUsage(usage: GatewayUsage): Record<string, unknown> {
  const inclusiveInputTokens = safeTokenSum(
    [
      usage.inputTokens,
      usage.cacheReadInputTokens,
      usage.cacheCreationInputTokens,
    ],
    "OpenAI response usage overflow",
  );
  const result: Record<string, unknown> = {
    prompt_tokens: inclusiveInputTokens,
    completion_tokens: usage.outputTokens,
    total_tokens: safeTokenSum(
      [inclusiveInputTokens, usage.outputTokens],
      "OpenAI response usage overflow",
    ),
  };
  if (
    usage.cacheReadInputTokens != null ||
    usage.cacheCreationInputTokens != null
  ) {
    result.prompt_tokens_details = {
      cached_tokens: usage.cacheReadInputTokens ?? 0,
      cache_write_tokens: usage.cacheCreationInputTokens ?? 0,
    };
  }
  return result;
}

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
  if (Object.hasOwn(raw, "provider")) {
    extras.provider = raw.provider;
  }
  if (Object.hasOwn(raw, "tool_choice")) {
    extras.tool_choice = raw.tool_choice;
  }
  if (Object.hasOwn(raw, "parallel_tool_calls")) {
    if (typeof raw.parallel_tool_calls !== "boolean") {
      throw new InvalidCrossProviderRequestError();
    }
    extras.parallel_tool_calls = raw.parallel_tool_calls;
  }
  if (Object.hasOwn(raw, "response_format")) {
    if (
      !raw.response_format ||
      typeof raw.response_format !== "object" ||
      Array.isArray(raw.response_format)
    ) {
      throw new Error("invalid Chat response format");
    }
    extras.response_format = raw.response_format as Record<string, unknown>;
  }
  if (raw.stream_options && typeof raw.stream_options === "object") {
    const so = raw.stream_options as Record<string, unknown>;
    if (typeof so.include_usage === "boolean") {
      extras.stream_options = { include_usage: so.include_usage };
    }
  }

  // Parse messages and extract system prompt
  const rawMessages = Array.isArray(raw.messages) ? raw.messages : [];
  const messageBuilder = createOpenAIMessagesBuilder();
  for (const msg of rawMessages as Array<Record<string, unknown>>) {
    messageBuilder.add(msg);
  }
  const {
    system,
    messages,
    hasDeveloperInstruction,
    nativeChatInstructionPrefix,
    boundarySafe,
    retainedItems,
  } = messageBuilder.finish();
  if (hasDeveloperInstruction) extras.chatDeveloperInstruction = true;
  if (nativeChatInstructionPrefix) {
    extras.nativeChatInstructionPrefix = nativeChatInstructionPrefix;
  }

  // Parse tools
  const rawTools = Array.isArray(raw.tools) ? raw.tools : [];
  const tools: GatewayTool[] = rawTools.map((t: Record<string, unknown>) => {
    const func = t.function as Record<string, unknown> | undefined;
    if (func?.strict !== undefined && typeof func.strict !== "boolean") {
      throw new InvalidCrossProviderRequestError();
    }
    return {
      name: asString(func?.name ?? t.name),
      description: asString(func?.description),
      inputSchema: (func?.parameters as Record<string, unknown>) ?? {},
      ...(func?.strict !== undefined ? { strict: func.strict } : {}),
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
    rawHeaders: { ...headers },
    extras,
    sourceInput: {
      itemCount: rawMessages.length,
      inputDigest: digestChain(rawMessages),
      boundarySafe: rawMessages.length > 0 && boundarySafe,
      retainedItems,
    },
  };
}

const OPENAI_STREAM_CAPTURE_KEYS = new Set([
  "model",
  "stream",
  "max_tokens",
  "temperature",
  "top_p",
  "frequency_penalty",
  "presence_penalty",
  "user",
  "logprobs",
  "top_logprobs",
  "provider",
  "tool_choice",
  "parallel_tool_calls",
  "response_format",
  "stream_options",
  "tools",
]);

export function parseOpenAIRequestChunks(
  chunks: AsyncIterable<Uint8Array>,
  headers: Record<string, string>,
): Promise<GatewayRequest> {
  const boundary = parseContextBoundary(headers, "openai");
  return parseStreamedRequest(chunks, {
    streamKey: "messages",
    captureKeys: OPENAI_STREAM_CAPTURE_KEYS,
    contextBoundary: boundary,
    isRetainedItem: (item) => {
      const role = (item as Record<string, unknown>)?.role;
      return role === "system" || role === "developer";
    },
    describeBoundary: (streamed, sourceBoundary) => ({
      boundarySafe:
        streamed.boundarySafe &&
        (!sourceBoundary ||
          streamed.retainedItems === sourceBoundary.retainedItems),
      retainedItems: streamed.retainedItems,
    }),
    createItemsBuilder: createOpenAIMessagesBuilder,
    parseSync: (raw) => parseOpenAIRequest(raw, headers),
    assemble(raw, streamed) {
      const req = parseOpenAIRequest(raw, headers);
      if (streamed !== undefined) {
        req.system = streamed.system;
        req.messages = streamed.messages;
        if (streamed.hasDeveloperInstruction) {
          req.extras ??= {};
          req.extras.chatDeveloperInstruction = true;
        }
        if (streamed.nativeChatInstructionPrefix) {
          req.extras ??= {};
          req.extras.nativeChatInstructionPrefix =
            streamed.nativeChatInstructionPrefix;
        }
      }
      return req;
    },
  });
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
        blocks.push(chatTextPart(item));
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
        blocks.push(chatTextPart(item));
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
        if (
          typeof item.text !== "string" ||
          Object.keys(item).some((key) => key !== "type" && key !== "text")
        ) {
          throw new InvalidCrossProviderRequestError();
        }
        return { type: "text" as const, text: item.text };
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
    usage: openAIUsage(usage),
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

      // Build the terminal usage object from resp.usage (or ZERO_USAGE fallback).
      // Mirrors the working reference at stream/openai.ts:285-308 so OpenAI
      // Chat Completions clients that read usage from the final SSE chunk
      // (e.g. Pi) get the data they asked for via stream_options.include_usage.
      // Emitted unconditionally, not gated on include_usage — same as the
      // reference; clients that didn't opt in simply ignore the extra field.
      const ru = resp.usage ?? ZERO_USAGE;
      const terminalUsage = openAIUsage(ru);

      function emitChunk(
        delta: Record<string, unknown>,
        finishReason: string | null,
        usage?: Record<string, unknown>,
      ) {
        const chunk: Record<string, unknown> = {
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
        if (usage) {
          chunk.usage = usage;
        }
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

      // Emit final chunk with finish reason AND usage (single chunk, matching
      // the working reference at stream/openai.ts:285-308).
      emitChunk({}, mapStopReason(resp.stopReason), terminalUsage);

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
 * Default OpenAI **Responses** API path appended to a bare provider origin.
 * Most OpenAI Responses-compatible providers serve at `<base>/v1/responses`.
 */
export const DEFAULT_OPENAI_RESPONSES_PATH = "/v1/responses";

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
 * Hosts whose OpenAI Responses API endpoint is NOT served at the bare
 * `<base>${DEFAULT_OPENAI_RESPONSES_PATH}` shape. Same shape as the
 * Chat-Completions map; keep them side-by-side to make the per-host quirks easy
 * to read in one place.
 *
 * Currently EMPTY — GitHub Copilot's `/responses` is handled by the
 * `isGitHubCopilotHost` short-circuit inside `buildOpenAIResponsesUrl`
 * (mirroring `buildOpenAIChatCompletionsUrl`'s path for `/chat/completions`,
 * issue #1052). Real OpenAI (`api.openai.com`) uses the default `/v1/responses`
 * path and needs NO entry here.
 *
 * Keyed by hostname so the override holds regardless of which routing tier
 * produced the base URL. Reserved for future per-host Responses quirks.
 */
const OPENAI_HOST_RESPONSES_PATHS: ReadonlyMap<string, string> = new Map();
/** The API version pinned for GitHub Copilot requests (matches Copilot CLI). */
export const GITHUB_COPILOT_API_VERSION = "2026-06-01";

/**
 * Extra headers GitHub Copilot expects on Chat Completions calls. The stored
 * GitHub OAuth token authenticates on its own (verified), but Copilot's API
 * canonically wants a `Copilot-Integration-Id` identifying the integration and
 * an `X-GitHub-Api-Version`. Sending them matches what real Copilot clients do
 * and hardens against the API tightening later. No-op for non-Copilot hosts.
 */
export function copilotHeaders(url: string): Record<string, string> {
  try {
    if (isGitHubCopilotHost(new URL(url).hostname)) {
      return {
        "Copilot-Integration-Id": "vscode-chat",
        "X-GitHub-Api-Version": GITHUB_COPILOT_API_VERSION,
      };
    }
  } catch {
    // Unparseable URL — add nothing.
  }
  return {};
}

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

/**
 * Build the OpenAI **Responses API** upstream URL for an upstream base.
 *
 * Mirror of {@link buildOpenAIChatCompletionsUrl}, used by background worker
 * calls for providers/models that require the Responses wire shape (currently
 * the `gpt-5.6-{sol,terra,luna}` family on `github-copilot`, which Copilot
 * rolled out on 2026-07-09 — those return
 * `unsupported_api_for_model` on `/chat/completions` and are ONLY reachable
 * via `/responses`, per `earendil-works/pi#6475`).
 *
 * Routing rules mirror the chat-completions builder:
 *  1. GitHub Copilot hosts (any `*.githubcopilot.com`, issue #1052) serve at
 *     `/responses` with no `/v1` prefix.
 *  2. Hosts in `OPENAI_HOST_RESPONSES_PATHS` (currently empty) use a fixed
 *     non-`/v1` endpoint path. Reserved for future per-host Responses quirks
 *     (no real provider needs it today).
 *  3. A base whose pathname already ends in a version segment serves
 *     `/responses` at `<base>/responses`; a default `/v1/responses` prefix
 *     would duplicate the version.
 *  4. Falls back to `${base}${DEFAULT_OPENAI_RESPONSES_PATH}` (`/v1/responses`).
 */
function appendOpenAIEndpoint(base: string, endpoint: string): string {
  try {
    const url = new URL(base);
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.hostname === "" ||
      url.username !== "" ||
      url.password !== "" ||
      url.hash !== ""
    ) {
      throw new Error("Invalid upstream base URL");
    }
    url.pathname = `${url.pathname.replace(/\/$/, "")}${endpoint}`;
    return url.href;
  } catch {
    throw new Error("Invalid upstream base URL");
  }
}

export function buildOpenAIResponsesUrl(base: string): string {
  try {
    const url = new URL(base);
    const { hostname, pathname } = url;
    // GitHub Copilot (all hosts, incl. api.individual/business/enterprise.*)
    // serves /responses with no /v1 prefix — issue #1052.
    if (isGitHubCopilotHost(hostname)) {
      return appendOpenAIEndpoint(base, "/responses");
    }
    const hostPath = OPENAI_HOST_RESPONSES_PATHS.get(hostname);
    if (hostPath !== undefined) {
      return appendOpenAIEndpoint(base, hostPath);
    }
    // Base already ends in a version segment (`/v4`, `/v1`, …) → the API path
    // is just `/responses`; a `/v1` prefix would double the version.
    if (/\/v\d+$/.test(pathname)) {
      return appendOpenAIEndpoint(base, "/responses");
    }
    return appendOpenAIEndpoint(base, DEFAULT_OPENAI_RESPONSES_PATH);
  } catch {
    throw new Error("Invalid upstream base URL");
  }
}

export function buildOpenAICodexResponsesUrl(base: string): string {
  return appendOpenAIEndpoint(base, "/codex/responses");
}

export function buildOpenAIUpstreamRequest(
  req: GatewayRequest,
  upstreamBase: string,
  cache?: AnthropicCacheOptions,
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
    messages: buildOpenAIMessages(
      req.messages,
      req.system,
      req.protocol,
      cache,
      req.protocol === "openai"
        ? req.extras?.nativeChatInstructionPrefix
        : undefined,
    ),
    stream: req.stream,
  };

  if (req.maxTokens) {
    body.max_tokens = req.maxTokens;
  }

  // Add tools in OpenAI format. OpenRouter honors Anthropic-style
  // `cache_control` on the last tool definition for Anthropic models, exactly
  // like the native Anthropic path (see buildAnthropicRequest). Tool defs are
  // stable across turns, so a breakpoint here keeps them as cache reads.
  if (req.tools.length > 0) {
    const tools = req.tools.map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
        ...(t.strict !== undefined ? { strict: t.strict } : {}),
      },
    }));
    if (cache?.cacheTools && tools.length > 0) {
      const lastTool = tools[tools.length - 1] as Record<string, unknown>;
      lastTool.cache_control = ephemeralCacheControl(cache.systemTTL);
    }
    body.tools = tools;
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
    if (req.extras.stream_options !== undefined) {
      body.stream_options = req.extras.stream_options;
    }
    if (req.extras.response_format !== undefined) {
      body.response_format = req.extras.response_format;
    }
    if (req.protocol === "openai" && req.extras.tool_choice !== undefined) {
      body.tool_choice = req.extras.tool_choice;
    }
    if (req.extras.parallel_tool_calls !== undefined) {
      body.parallel_tool_calls = req.extras.parallel_tool_calls;
    }
  }

  const providerRouting = providerRoutingValue(req);
  if (providerRouting.present && requestTargetsOpenRouter(req, upstreamBase)) {
    body.provider = providerRouting.value;
  }

  return {
    url: buildOpenAIChatCompletionsUrl(upstreamBase),
    headers,
    body,
  };
}

/**
 * Build the `cache_control` object for an ephemeral breakpoint. OpenRouter
 * accepts Anthropic's `{ type: "ephemeral", ttl?: "1h" }` shape verbatim on the
 * OpenAI Chat Completions API for Anthropic models. Non-Anthropic OpenRouter
 * models (and other OpenAI-protocol providers) simply ignore the annotation, so
 * emitting it is safe across the board.
 */
function ephemeralCacheControl(ttl?: "5m" | "1h" | false): {
  type: "ephemeral";
  ttl?: "1h";
} {
  return ttl === "1h"
    ? { type: "ephemeral", ttl: "1h" }
    : { type: "ephemeral" };
}

/**
 * Quantization step for the intermediate anchor's position. The anchor sits at a
 * multiple of this step, so it stays byte-identical for this many turns before
 * advancing — a moving anchor would bust the very cache it protects.
 */
const CACHE_ANCHOR_STEP = 10;

/**
 * Minimum number of committed (pre-tail) messages before a second, stable
 * intermediate `cache_control` anchor is placed. Below this the prefix is small
 * enough that a single tail breakpoint already bounds eviction cost.
 *
 * This is `2 * CACHE_ANCHOR_STEP`, not an independent number: the anchor lands at
 * `floor((tailIdx / 2) / STEP) * STEP`, which only clears 0 (and so passes the
 * `anchorIdx > 0` guard) once the midpoint reaches a full step, i.e. once
 * `tailIdx >= 2 * STEP`. Setting a smaller minimum would advertise an anchor that
 * silently never fires for `tailIdx` in `[min, 2*STEP)`.
 */
const CACHE_ANCHOR_MIN_MESSAGES = 2 * CACHE_ANCHOR_STEP;

function buildOpenAIMessages(
  messages: GatewayMessage[],
  system: string,
  source: GatewayRequest["protocol"],
  cache?: AnthropicCacheOptions,
  nativeInstructions?: NonNullable<
    GatewayRequest["extras"]
  >["nativeChatInstructionPrefix"],
): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = [];

  if (nativeInstructions) {
    const prefix = nativeInstructions.normalizedSystem;
    if (prefix && system !== prefix && !system.startsWith(`${prefix}\n\n`)) {
      throw new Error("Chat instruction provenance changed");
    }
    const suffix =
      prefix && system !== prefix
        ? system.slice(prefix.length + 2)
        : prefix
          ? ""
          : system;
    const firstDeveloper = nativeInstructions.items.findIndex(
      (item) => item.role === "developer",
    );
    const suffixAt =
      firstDeveloper < 0 ? nativeInstructions.items.length : firstDeveloper;
    for (const [index, item] of nativeInstructions.items.entries()) {
      if (index === suffixAt && suffix)
        result.push({ role: "system", content: suffix });
      result.push({
        role: item.role,
        content: Array.isArray(item.content)
          ? item.content.map((part) => ({ ...part }))
          : item.content,
      });
    }
    if (suffixAt === nativeInstructions.items.length && suffix) {
      result.push({ role: "system", content: suffix });
    }
    if (cache?.systemTTL) {
      const lastSystem = result.findLastIndex((item) => item.role === "system");
      if (lastSystem >= 0) {
        const item = result[lastSystem];
        const parts =
          typeof item.content === "string"
            ? [{ type: "text", text: item.content }]
            : (item.content as Array<Record<string, unknown>>);
        if (parts.length > 0) {
          if (parts[parts.length - 1].cache_control === undefined) {
            parts[parts.length - 1].cache_control = ephemeralCacheControl(
              cache.systemTTL,
            );
          }
          item.content = parts;
        }
      }
    }
  }

  // Add system prompt if present. When system caching is requested, emit the
  // block-array form with a `cache_control` breakpoint so OpenRouter caches the
  // (large, stable) system prefix. Otherwise keep the plain-string form for
  // maximum compatibility and cache stability (byte-identical across turns).
  if (system && !nativeInstructions) {
    if (cache?.systemTTL) {
      result.push({
        role: "system",
        content: [
          {
            type: "text",
            text: system,
            cache_control: ephemeralCacheControl(cache.systemTTL),
          },
        ],
      });
    } else {
      result.push({ role: "system", content: system });
    }
  }

  for (const msg of messages) {
    if (
      source === "openai-responses" &&
      msg.provenanceContent?.some(
        (block) =>
          block.type === "opaque" &&
          block.responsesItem &&
          block.raw.type === "message" &&
          Array.isArray(block.raw.content) &&
          block.raw.content.some(
            (part: unknown) =>
              part !== null &&
              typeof part === "object" &&
              !Array.isArray(part) &&
              "annotations" in part &&
              (!Array.isArray(part.annotations) || part.annotations.length > 0),
          ),
      )
    ) {
      throw new InvalidCrossProviderRequestError();
    }
    const blocks =
      source === "openai" &&
      msg.provenanceContent?.some((block) => block.type === "text" && block.raw)
        ? msg.provenanceContent
        : msg.content;
    const role = msg.role;

    // Collect text, opaque (image/audio/…), and tool_use blocks.
    const contentParts: Array<Record<string, unknown>> = [];
    const toolUses: Array<Record<string, unknown>> = [];
    let hasOpaque = false;

    for (const block of blocks) {
      if (block.type === "text") {
        contentParts.push(
          source === "openai" && block.raw
            ? { ...block.raw }
            : { type: "text", text: block.text },
        );
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
        requireTextOnlyToolResult(block);
        // OpenAI tool messages take a string content field. Reject non-text
        // sub-blocks before taking the text projection.
        result.push({
          role: "tool",
          tool_call_id: block.toolUseId,
          content: blocksToText(block.content),
        });
      } else if (block.type === "opaque") {
        if (source !== "openai") {
          throw new InvalidCrossProviderRequestError();
        }
        // Re-emit the original block verbatim (e.g. image_url, input_audio).
        contentParts.push(block.raw);
        hasOpaque = true;
      }
    }

    if (contentParts.length > 0 || toolUses.length > 0) {
      const msgRecord: Record<string, unknown> = { role };

      if (contentParts.length > 0) {
        // Use array form when non-text (opaque) parts are present — OpenAI
        // requires array content for multimodal messages.
        //
        // For text-only messages the shape choice must be STABLE across turns
        // or it busts the prompt cache: the conversation breakpoint below is
        // placed on the LAST message and promotes a plain string to a single
        // text block to hang `cache_control` on it. That breakpoint moves
        // forward every turn, so a message annotated on turn N (array form)
        // would revert to string form on turn N+1 — flipping
        //   "content":[{"type":"text","text":"…"}]  ⇄  "content":"…"
        // for the SAME historical message and breaking the cached prefix at
        // that point (observed as recurring `messages[N].content` divergences).
        // When conversation caching is on, emit array form uniformly so only
        // the single `cache_control` marker moves between turns (matching the
        // always-array native Anthropic path); keep the plain-string form when
        // caching is off, where it's simpler and there's no breakpoint to move.
        if (
          hasOpaque ||
          cache?.cacheConversation ||
          (source === "openai" &&
            blocks.some((block) => block.type === "text" && block.raw))
        ) {
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

  // Conversation caching: place a `cache_control` breakpoint on the final
  // content block of the last cacheable message. OpenRouter's lookback finds
  // the prior turn's breakpoint, reads the cached prefix, and writes only the
  // new tail — the same strategy as the native Anthropic path. This requires
  // the block-array content form, so promote a plain-string message body to a
  // single text block before annotating it.
  //
  // Walk back to the most recent message we can annotate, skipping:
  //   - `role: "system"` messages — the system prefix owns its own breakpoint
  //     (via `systemTTL`); the conversation breakpoint must never overwrite it,
  //     which would clobber a distinct system TTL;
  //   - `role: "tool"` messages — the OpenAI Chat Completions API requires tool
  //     messages to carry STRING content, so we can't attach a block-level
  //     breakpoint there; and
  //   - assistant messages that carry only `tool_calls` (no `content`) — there
  //     is no content block to hang the breakpoint on.
  // The cached prefix still covers every skipped message (they precede the
  // breakpoint), so no cache coverage is lost.
  if (cache?.cacheConversation && result.length > 0) {
    // Under `cacheConversation`, every text-only message is emitted in array
    // form above (the shape-stability invariant that stops the string↔array
    // flip from busting the cache). `role:"tool"` messages carry STRING content
    // (OpenAI requirement) and can't hold a block-level breakpoint. So a
    // message is annotatable only when its content is a non-empty block array.
    const isAnnotatable = (m: Record<string, unknown>): boolean =>
      m.role !== "system" &&
      m.role !== "tool" &&
      Array.isArray(m.content) &&
      m.content.length > 0;
    const annotate = (
      m: Record<string, unknown>,
      ttl?: "5m" | "1h" | false,
    ) => {
      const parts = m.content as Array<Record<string, unknown>>;
      if (parts[parts.length - 1].cache_control === undefined) {
        parts[parts.length - 1].cache_control = ephemeralCacheControl(ttl);
      }
    };

    // (1) Moving tail breakpoint — on the last annotatable message. Advances
    // every turn; caches everything up to the new tail.
    let tailIdx = result.length - 1;
    while (tailIdx >= 0 && !isAnnotatable(result[tailIdx])) tailIdx--;
    if (tailIdx >= 0) annotate(result[tailIdx], cache.conversationTTL);

    // (2) Stable intermediate anchor breakpoint (upstream-eviction resilience).
    //
    // With only the moving tail breakpoint, the entire committed prefix is ONE
    // cache segment. A single upstream (e.g. OpenRouter) partial cache eviction
    // then re-bills that whole segment as fresh INPUT (~10x cache-read price) —
    // observed as one ~345K-token spike per long session, worth ~$1/run on a
    // frontier model (issue #961). Native Anthropic mitigates this with the
    // distilled-prefix breakpoint, but at Layer 0 (no distilled prefix) it, too,
    // has a single segment. Anchoring a second breakpoint partway through the
    // committed history splits the prefix into two independently-cacheable
    // segments, so an eviction of one segment leaves the other intact and
    // bounds the blast radius.
    //
    // Placement: the anchor targets the MIDPOINT of the committed prefix, not a
    // point near the tail. The observed eviction sits deep in the early prefix
    // (the accumulated large user blobs), so an anchor hugging the tail would
    // leave that whole early region as one unprotected segment — it must split
    // the LARGE half. A midpoint anchor cuts the prefix into two ~equal halves,
    // so an eviction of the front half re-sends ~half, not all.
    //
    // The anchor MUST be byte-stable across turns or it busts the cache itself.
    // We quantize its position to a coarse step so it only advances every
    // CACHE_ANCHOR_STEP messages (byte-identical in between), and only place it
    // when the committed prefix is large enough to be worth splitting.
    if (tailIdx >= CACHE_ANCHOR_MIN_MESSAGES) {
      // Midpoint of the committed prefix, quantized DOWN to a step multiple so
      // it stays put for many turns (the midpoint advances at ~half the tail's
      // rate, so it moves even less often than the step alone implies). Quantize
      // guarantees the anchor is stable and strictly below the moving tail.
      const midpoint = Math.floor(tailIdx / 2);
      const quantized =
        Math.floor(midpoint / CACHE_ANCHOR_STEP) * CACHE_ANCHOR_STEP;
      // Walk back from the quantized index to the nearest annotatable message.
      let anchorIdx = Math.min(quantized, tailIdx - 1);
      while (anchorIdx > 0 && !isAnnotatable(result[anchorIdx])) anchorIdx--;
      if (
        anchorIdx > 0 &&
        anchorIdx < tailIdx &&
        isAnnotatable(result[anchorIdx])
      ) {
        // Inherit the (longer) system TTL when available: the anchored segment
        // is old, stable history that benefits from the longer eviction window,
        // matching how Anthropic anchors its distilled prefix at systemTTL.
        annotate(
          result[anchorIdx],
          cache.systemTTL === false ? cache.conversationTTL : cache.systemTTL,
        );
      }
    }
  }

  return result;
}
