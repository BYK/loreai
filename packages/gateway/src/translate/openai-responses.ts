/**
 * OpenAI Responses API ↔ Gateway translation layer.
 *
 * Converts between OpenAI's `/v1/responses` API format and the gateway's
 * internal `GatewayRequest`/`GatewayResponse` types.
 *
 * The Responses API uses a different message format than Chat Completions:
 *   - Input is an array of "input items" (message, function_call, function_call_output, etc.)
 *   - Output is an array of "output items" with similar structure
 *   - System prompt is in the `instructions` field
 *   - Tools use `parameters` directly (not wrapped in `function`)
 */
import {
  CHAIN_DIGEST_SEED,
  asString,
  digestChain,
  log,
  type ContextBoundary,
} from "@loreai/core";
import type {
  GatewayContentBlock,
  GatewayMessage,
  GatewayRequest,
  GatewayResponse,
  GatewayTool,
  GatewayUsage,
} from "./types";
import { sanitizeCodexRateLimitEvents } from "../codex-rate-limits";
import {
  blocksToText,
  forwardClientHeaders,
  providerRoutingValue,
  requestTargetsOpenRouter,
  ZERO_USAGE,
} from "./types";
import { extractAuth } from "../auth";
import { isImageBlock, toResponsesImage } from "./images";
import {
  assertResponsesToolOutputEnvelope,
  portableResponsesFunctionCall,
  portableResponsesToolOutput,
} from "./anthropic";
import {
  InvalidCrossProviderRequestError,
  requireTextOnlyToolResult,
} from "./errors";
import { safeTokenSum } from "../usage-validation";
import {
  buildOpenAICodexResponsesUrl,
  buildOpenAIResponsesUrl,
} from "./openai";
import {
  parseContextBoundary,
  type ContextBoundaryProtocol,
} from "../context-boundary";
import {
  parseStreamedRequest,
  StreamedRequestBoundaryMismatchError,
  type StreamingRequestSpec,
} from "./streaming-request";

export { STREAMING_PARSE_SPOOL_BYTES } from "./streaming-request";

type ParsedInputItems = {
  messages: GatewayMessage[];
  instructions: string[];
  elevatedItems: Array<{
    type?: "message";
    role: "system" | "developer";
    content: string | Array<{ type: "input_text"; text: string }>;
  }>;
  hasLateItems: boolean;
  boundarySafe: boolean;
};

function responsesUsage(usage: GatewayUsage): Record<string, unknown> {
  const inclusiveInputTokens = safeTokenSum(
    [
      usage.inputTokens,
      usage.cacheReadInputTokens,
      usage.cacheCreationInputTokens,
    ],
    "Responses usage overflow",
  );
  const result: Record<string, unknown> = {
    input_tokens: inclusiveInputTokens,
    output_tokens: usage.outputTokens,
    total_tokens: safeTokenSum(
      [inclusiveInputTokens, usage.outputTokens],
      "Responses usage overflow",
    ),
  };
  if (
    usage.cacheReadInputTokens != null ||
    usage.cacheCreationInputTokens != null
  ) {
    result.input_tokens_details = {
      cached_tokens: usage.cacheReadInputTokens ?? 0,
      cache_write_tokens: usage.cacheCreationInputTokens ?? 0,
    };
  }
  return result;
}

// ---------------------------------------------------------------------------
// OpenAI Responses API → GatewayRequest
// ---------------------------------------------------------------------------

export function parseOpenAIResponsesRequest(
  body: unknown,
  headers: Record<string, string>,
): GatewayRequest {
  const boundary = parseContextBoundary(headers, "openai-responses");
  const input = rawInput(body);
  const parsed = parseInputItems(input);
  const req = parseOpenAIResponsesRequestInternal(body, headers, parsed);
  attachDirectSourceInput(req, input, parsed, boundary);
  return req;
}

function parseOpenAIResponsesRequestInternal(
  body: unknown,
  headers: Record<string, string>,
  parsedInput?: ParsedInputItems,
): GatewayRequest {
  const raw = (body ?? {}) as Record<string, unknown>;

  const model = asString(raw.model);
  const stream = raw.stream === true;

  // max_output_tokens defaults to 4096 if not specified
  const maxTokens =
    typeof raw.max_output_tokens === "number" ? raw.max_output_tokens : 4096;

  // System prompt comes from `instructions`
  const instructions =
    typeof raw.instructions === "string" ? raw.instructions : "";

  // Parse input items into normalized messages
  const parsed = parsedInput ?? parseInputItems(raw.input);
  const messages = parsed.messages;
  const system = [instructions, ...parsed.instructions]
    .filter(Boolean)
    .join("\n\n");

  // Parse tools
  if (raw.tools !== undefined && !Array.isArray(raw.tools)) {
    throw new InvalidCrossProviderRequestError();
  }
  const rawTools = Array.isArray(raw.tools) ? raw.tools : [];
  const tools: GatewayTool[] = rawTools.map((t: unknown) => {
    if (
      !t ||
      typeof t !== "object" ||
      Array.isArray(t) ||
      typeof (t as Record<string, unknown>).type !== "string"
    ) {
      // GatewayTool represents only functions. Dropping another tool would
      // change the request without the client's consent.
      throw new InvalidCrossProviderRequestError();
    }
    const tool = t as Record<string, unknown>;
    if (tool.type === "web_search_preview") {
      if (Object.keys(tool).some((key) => key !== "type")) {
        throw new InvalidCrossProviderRequestError();
      }
      return {
        name: "web_search_preview",
        description: "",
        inputSchema: {},
        responsesBuiltin: "web_search_preview",
      };
    }
    if (
      tool.type !== "function" ||
      Object.keys(tool).some(
        (key) =>
          !["type", "name", "description", "parameters", "strict"].includes(
            key,
          ),
      ) ||
      (tool.strict !== undefined && typeof tool.strict !== "boolean")
    ) {
      throw new InvalidCrossProviderRequestError();
    }
    return {
      name: asString(tool.name),
      description: asString(tool.description),
      inputSchema: (tool.parameters as Record<string, unknown>) ?? {},
      ...(tool.strict !== undefined ? { strict: tool.strict } : {}),
    };
  });

  // Extract extras for passthrough
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
  // Responses API-specific extras
  if (raw.previous_response_id !== undefined) {
    extras.previous_response_id = raw.previous_response_id as string;
  }
  if (raw.reasoning !== undefined) {
    extras.reasoning = raw.reasoning;
  }
  if (parsed.elevatedItems.length > 0) {
    extras.nativeInstructionPrefix = {
      originalInstructions: instructions,
      normalizedSystem: system,
      items: parsed.elevatedItems,
      hasLateItems: parsed.hasLateItems,
    };
  }
  if (raw.text !== undefined) {
    extras.text = raw.text;
  }
  if (raw.truncation !== undefined) {
    if (raw.truncation !== "auto" && raw.truncation !== "disabled") {
      throw new InvalidCrossProviderRequestError();
    }
    extras.truncation = raw.truncation;
  }

  return {
    protocol: "openai-responses",
    model,
    system,
    messages,
    tools,
    stream,
    maxTokens,
    metadata: {},
    rawHeaders: { ...headers },
    extras,
  };
}

const RESPONSES_TOP_LEVEL_KEYS = new Set([
  "model",
  "stream",
  "max_output_tokens",
  "instructions",
  "tools",
  "temperature",
  "top_p",
  "frequency_penalty",
  "presence_penalty",
  "user",
  "provider",
  "tool_choice",
  "parallel_tool_calls",
  "previous_response_id",
  "reasoning",
  "text",
  "truncation",
]);

const CODEX_TOP_LEVEL_KEYS = new Set([
  "include",
  "prompt_cache_key",
  "service_tier",
]);

function addCodexControls(
  req: GatewayRequest,
  raw: Record<string, unknown>,
): GatewayRequest {
  req.codex = true;
  if (!req.extras) req.extras = {};
  const extras = req.extras;
  // `store` is intentionally absent: the upstream builder always forces it to
  // false for Codex, so retaining the client value would be dead state.
  if (raw.include !== undefined) extras.include = raw.include;
  if (typeof raw.prompt_cache_key === "string") {
    extras.prompt_cache_key = raw.prompt_cache_key;
  }
  if (typeof raw.service_tier === "string") {
    extras.service_tier = raw.service_tier;
  }
  return req;
}

const responsesSpec = (
  headers: Record<string, string>,
  codex: boolean,
): StreamingRequestSpec<ParsedInputItems> => {
  const protocol: ContextBoundaryProtocol = codex
    ? "openai-codex"
    : "openai-responses";
  const boundary = parseContextBoundary(headers, protocol);
  return {
    streamKey: "input",
    captureKeys: codex
      ? new Set([...RESPONSES_TOP_LEVEL_KEYS, ...CODEX_TOP_LEVEL_KEYS])
      : RESPONSES_TOP_LEVEL_KEYS,
    contextBoundary: boundary,
    describeBoundary: (parsed) => ({
      boundarySafe: parsed.boundarySafe,
      retainedItems: 0,
    }),
    createItemsBuilder: createInputItemsBuilder,
    parseSync: (raw) =>
      codex
        ? parseOpenAICodexRequest(raw, headers)
        : parseOpenAIResponsesRequest(raw, headers),
    assemble(raw, streamed) {
      const parsed = streamed ?? parseInputItems(raw.input);
      const req = parseOpenAIResponsesRequestInternal(raw, headers, parsed);
      if (codex) addCodexControls(req, raw);
      return req;
    },
  };
};

/** Parse a streamed OpenAI Responses request. */
export function parseOpenAIResponsesRequestChunks(
  chunks: AsyncIterable<Uint8Array>,
  headers: Record<string, string>,
): Promise<GatewayRequest> {
  return parseStreamedRequest(chunks, responsesSpec(headers, false));
}

/**
 * Parse a Pi `openai-codex` request. The wire format is the OpenAI Responses
 * API, so we reuse `parseOpenAIResponsesRequest` for the shared parsing and add
 * the Codex-specific delta on top:
 *   - flag the request as Codex (steers the upstream URL + `store:false`)
 *   - capture Codex-only controls (`include`, `prompt_cache_key`,
 *     `service_tier`). Shared Responses `text`, `tool_choice`, and
 *     `parallel_tool_calls` controls are captured by the base parser.
 *
 * Codex-only controls are captured here; both routes force `store: false`
 * because the gateway sends complete history on every turn.
 */
export function parseOpenAICodexRequest(
  body: unknown,
  headers: Record<string, string>,
): GatewayRequest {
  const boundary = parseContextBoundary(headers, "openai-codex");
  const parsed = parseInputItems(rawInput(body));
  const req = parseOpenAIResponsesRequestInternal(body, headers, parsed);
  const raw = (body ?? {}) as Record<string, unknown>;
  attachDirectSourceInput(req, raw.input, parsed, boundary);
  return addCodexControls(req, raw);
}

/** Parse a streamed Codex request while preserving Codex-only controls. */
export function parseOpenAICodexRequestChunks(
  chunks: AsyncIterable<Uint8Array>,
  headers: Record<string, string>,
): Promise<GatewayRequest> {
  return parseStreamedRequest(chunks, responsesSpec(headers, true));
}

// ---------------------------------------------------------------------------
// Input item parsing
// ---------------------------------------------------------------------------

function rawInput(body: unknown): unknown {
  const raw = (body ?? {}) as Record<string, unknown>;
  return raw.input;
}

function parseInputItems(input: unknown): ParsedInputItems {
  // String shorthand: single user message
  if (typeof input === "string") {
    return {
      messages: [{ role: "user", content: [{ type: "text", text: input }] }],
      instructions: [],
      elevatedItems: [],
      hasLateItems: false,
      // String shorthand cannot be suffix-elided as an item array.
      boundarySafe: false,
    };
  }

  if (input !== undefined && input !== null && !Array.isArray(input)) {
    throw new InvalidCrossProviderRequestError();
  }
  if (!Array.isArray(input)) {
    return {
      messages: [],
      instructions: [],
      elevatedItems: [],
      hasLateItems: false,
      boundarySafe: false,
    };
  }

  const builder = createInputItemsBuilder();
  for (const item of input) {
    builder.add(item);
  }
  return builder.finish();
}

function attachDirectSourceInput(
  req: GatewayRequest,
  input: unknown,
  parsed: ParsedInputItems,
  boundary?: ContextBoundary,
): void {
  if (!Array.isArray(input)) {
    if (!boundary) return;
    throw new StreamedRequestBoundaryMismatchError(
      "The checkpointed input suffix is not an array; retrying with the full conversation.",
    );
  }
  req.sourceInput = {
    itemCount: (boundary?.inputItems ?? 0) + input.length,
    inputDigest: digestChain(input, boundary?.inputDigest ?? CHAIN_DIGEST_SEED),
    boundarySafe: input.length > 0 && parsed.boundarySafe,
    retainedItems: 0,
    ...(boundary
      ? {
          sourcePrefix: {
            messageCount: boundary.sourceMessages,
            sourceDigest: boundary.sourceDigest,
          },
        }
      : {}),
  };
}

function createInputItemsBuilder(): {
  add(item: unknown): void;
  finish(): ParsedInputItems;
} {
  const messages: GatewayMessage[] = [];
  const instructions: string[] = [];
  const elevatedItems: ParsedInputItems["elevatedItems"] = [];
  let pendingReasoning: GatewayContentBlock[] = [];
  let sawItem = false;
  let sawConversationItem = false;
  let elevatedAfterConversation = false;
  let seamKind: "none" | "other" | "tool-call" | "tool-result" = "none";
  let seamHasPendingReasoning = false;

  const appendAssistant = (
    content: GatewayContentBlock[],
    provenanceContent?: GatewayContentBlock[],
    provenancePositions?: number[],
  ): GatewayMessage => {
    const message: GatewayMessage = { role: "assistant", content };
    if (provenanceContent) {
      message.provenanceContent = [...pendingReasoning, ...provenanceContent];
      message.provenancePositions = (provenancePositions ?? []).map(
        (position) => pendingReasoning.length + position,
      );
      pendingReasoning = [];
    } else if (pendingReasoning.length > 0) {
      message.provenanceContent = [...pendingReasoning, ...content];
      message.provenancePositions = content.map(
        (_block, index) => pendingReasoning.length + index,
      );
      pendingReasoning = [];
    }
    messages.push(message);
    return message;
  };

  const add = (item: unknown): void => {
    sawItem = true;
    const raw = item as Record<string, unknown>;
    const itemType = raw.type as string | undefined;
    const role = raw.role as string | undefined;

    // Track only the state that can affect normalization across an item seam.
    if (itemType === "message" || (!itemType && role)) {
      if (role === "user" && pendingReasoning.length > 0) {
        // The pending assistant items would otherwise be appended after this
        // user turn, changing the source item's order.
        throw new InvalidCrossProviderRequestError();
      }
      if (
        role === "user" &&
        typeof raw.content !== "string" &&
        (!Array.isArray(raw.content) ||
          raw.content.some(
            (part: unknown) =>
              !part || typeof part !== "object" || Array.isArray(part),
          ))
      ) {
        throw new InvalidCrossProviderRequestError();
      }
      const content = parseMessageContent(raw.content);
      if (
        role === "user" &&
        content.length === 0 &&
        (raw.id !== undefined || raw.status !== undefined)
      ) {
        throw new InvalidCrossProviderRequestError();
      }
      if (role === "assistant") {
        seamHasPendingReasoning = false;
        seamKind = "other";
      } else if (content.length > 0) {
        seamKind = "other";
      }
    } else if (itemType === "function_call") {
      seamHasPendingReasoning = false;
      seamKind = "tool-call";
    } else if (itemType === "function_call_output") {
      seamKind = "tool-result";
    } else {
      seamHasPendingReasoning = true;
    }
    if (itemType === "message" || (!itemType && role)) {
      // Message item — has role + content
      const msgRole =
        role === "assistant" || role === "developer" || role === "system"
          ? role
          : "user";

      const content = parseMessageContent(raw.content);

      if (msgRole === "developer" || msgRole === "system") {
        // These items carry instructions, never user text. Other providers
        // have one system field, so preserve their priority there.
        if (
          Object.keys(raw).some(
            (key) => key !== "type" && key !== "role" && key !== "content",
          )
        ) {
          throw new InvalidCrossProviderRequestError();
        }
        if (
          typeof raw.content !== "string" &&
          (!Array.isArray(raw.content) ||
            raw.content.some(
              (part: unknown) =>
                !part ||
                typeof part !== "object" ||
                Array.isArray(part) ||
                (part as Record<string, unknown>).type !== "input_text" ||
                typeof (part as Record<string, unknown>).text !== "string" ||
                Object.keys(part).some(
                  (key) => key !== "type" && key !== "text",
                ),
            ))
        ) {
          throw new InvalidCrossProviderRequestError();
        }
        if (content.some((block) => block.type !== "text")) {
          throw new InvalidCrossProviderRequestError();
        }
        if (sawConversationItem) elevatedAfterConversation = true;
        const text = content
          .map((block) => (block.type === "text" ? block.text : ""))
          .join("\n");
        if (text) {
          instructions.push(text);
        }
        // Keep the original wire shape, including string content and an
        // omitted `type`. The joined text above is only for translation.
        elevatedItems.push({
          ...(raw.type === undefined ? {} : { type: "message" }),
          role: msgRole,
          content: Array.isArray(raw.content)
            ? (raw.content as Array<{ type: "input_text"; text: string }>).map(
                (part) => ({ ...part }),
              )
            : raw.content,
        });
      } else if (msgRole === "assistant") {
        sawConversationItem = true;
        if (typeof raw.content !== "string" && !Array.isArray(raw.content)) {
          throw new InvalidCrossProviderRequestError();
        }
        const parsed = parseAssistantMessageContent(raw);
        appendAssistant(
          parsed.content,
          parsed.provenanceContent,
          parsed.provenancePositions,
        );
      } else {
        sawConversationItem = true;
        if (
          content.some((block) => block.type === "opaque" && block.requestOnly)
        ) {
          // Request-only text with unknown metadata must not enter Lore's
          // visible user content, even when the source route is native.
          throw new InvalidCrossProviderRequestError();
        }
        if (
          role !== "user" ||
          (raw.status !== undefined && raw.status !== "completed") ||
          (raw.id !== undefined && (typeof raw.id !== "string" || !raw.id)) ||
          Object.keys(raw).some(
            (key) =>
              key !== "type" &&
              key !== "role" &&
              key !== "content" &&
              key !== "id" &&
              key !== "status",
          )
        ) {
          throw new InvalidCrossProviderRequestError();
        }
        if (Array.isArray(raw.content)) {
          for (const part of raw.content) {
            if (
              part &&
              typeof part === "object" &&
              !Array.isArray(part) &&
              ((part as Record<string, unknown>).type === "input_text" ||
                (part as Record<string, unknown>).type === "output_text")
            ) {
              assertToolOutputPart(part);
            }
          }
        }
        if (content.length === 0) {
          // An empty source item would otherwise vanish from the full-history
          // request. Reject it rather than silently changing the transcript.
          throw new InvalidCrossProviderRequestError();
        }
        // Every input item is a separate item on the Responses wire, even
        // without an ID or status. Keep its complete envelope for replay.
        messages.push({
          role: "user",
          content,
          provenanceContent: [
            { type: "opaque", raw, responsesItem: true, requestOnly: true },
          ],
          provenancePositions: content.map(() => 0),
        });
      }
      return;
    }

    if (itemType === "function_call") {
      sawConversationItem = true;
      portableResponsesFunctionCall(raw);
      // Function call from assistant — maps to tool_use.
      //
      // The Responses API emits each parallel tool call as its OWN
      // `function_call` item, and each tool result as its own
      // `function_call_output` item. The gateway's downstream tool-pairing
      // (loreMessagesToGateway + removeOrphanedToolResults) assumes the
      // Anthropic shape: one assistant message carries ALL tool_use blocks,
      // and the single immediately-following user message carries ALL matching
      // tool_result blocks. Coalesce consecutive function_call items into one
      // assistant message so an N-tool-call turn keeps its N tool_use blocks
      // together (and matched by the coalesced tool_result message below).
      const toolUseBlock: GatewayContentBlock = {
        type: "tool_use",
        id: asString(raw.call_id ?? raw.id),
        name: asString(raw.name),
        input: parseArguments(raw.arguments),
      };
      const provenanceBlock: GatewayContentBlock = {
        type: "opaque",
        raw,
        responsesItem: true,
      };
      const last = messages[messages.length - 1];
      const lastIsToolUseMessage =
        last !== undefined &&
        last.role === "assistant" &&
        last.content.length > 0 &&
        last.content.every((b) => b.type === "tool_use");
      if (lastIsToolUseMessage) {
        const provenance = last.provenanceContent ?? [...last.content];
        const positions =
          last.provenancePositions ??
          last.content.map((_block, index) => index);
        const position = provenance.length + pendingReasoning.length;
        provenance.push(...pendingReasoning, provenanceBlock);
        positions.push(position);
        last.content.push(toolUseBlock);
        last.provenanceContent = provenance;
        last.provenancePositions = positions;
        pendingReasoning = [];
      } else {
        appendAssistant([toolUseBlock], [provenanceBlock], [0]);
      }
      return;
    }

    if (itemType === "function_call_output") {
      if (pendingReasoning.length > 0) {
        // A result cannot cross a pending assistant reasoning item: the
        // normalized tool pair cannot represent that native item order.
        throw new InvalidCrossProviderRequestError();
      }
      sawConversationItem = true;
      assertResponsesToolOutputEnvelope(raw);
      if (Array.isArray(raw.output)) {
        raw.output.forEach(assertToolOutputPart);
      }
      // Function output — maps to tool_result. Coalesce consecutive outputs
      // into one user message (see the function_call comment above).
      //
      // `output` is usually a plain string, but the Responses API also allows
      // an array of content parts (e.g. `output_text`, plus multimodal parts
      // for tool results). Reuse parseMessageContent so the string form yields
      // a single text block (unchanged) while the array form extracts its text
      // parts and preserves any non-text parts as opaque blocks — rather than
      // flattening the whole array to "".
      const toolResultBlock: GatewayContentBlock = {
        type: "tool_result",
        toolUseId: asString(raw.call_id),
        ...(Array.isArray(raw.output)
          ? { nativeResponsesOutputArray: true as const }
          : {}),
        // Cited text remains visible to memory and search; the complete
        // annotated output is retained only in request-only item provenance.
        content: Array.isArray(raw.output)
          ? raw.output.flatMap((part: Record<string, unknown>) =>
              part.type === "output_text" &&
              typeof part.text === "string" &&
              (part.text === "" ||
                (Array.isArray(part.annotations) &&
                  part.annotations.length > 0))
                ? [{ type: "text" as const, text: part.text }]
                : parseMessageContent([part]),
            )
          : parseMessageContent(raw.output),
      };
      const provenanceBlock: GatewayContentBlock = {
        type: "opaque",
        raw,
        responsesItem: true,
      };
      const last = messages[messages.length - 1];
      const lastIsToolResultMessage =
        last !== undefined &&
        last.role === "user" &&
        last.content.length > 0 &&
        last.content.every((b) => b.type === "tool_result");
      if (lastIsToolResultMessage) {
        if (last.provenanceContent || raw.output !== undefined) {
          last.provenanceContent = [
            ...(last.provenanceContent ?? last.content),
            provenanceBlock,
          ];
          last.provenancePositions = last.content.map((_block, index) => index);
          last.provenancePositions.push(last.content.length);
        }
        last.content.push(toolResultBlock);
      } else {
        messages.push({
          role: "user",
          content: [toolResultBlock],
          provenanceContent: [provenanceBlock],
          provenancePositions: [0],
        });
      }
      return;
    }

    if (itemType === "reasoning") {
      sawConversationItem = true;
      pendingReasoning.push({ type: "opaque", raw, responsesItem: true });
      return;
    }

    // `item_reference` points to an item OpenAI stored server-side (under an
    // opaque upstream id). The gateway is a stateless full-history proxy: it
    // rewrites the conversation every turn and never persists upstream item
    // ids. Reject it rather than forwarding a conversation missing that item.
    if (itemType === "item_reference") {
      throw new InvalidCrossProviderRequestError();
    }

    // Preserve every self-contained item in request-only provenance. The
    // gateway may not render an unknown item, but canonical replay must hash
    // the same full transcript on both the producing and consuming turns.
    sawConversationItem = true;
    pendingReasoning.push({ type: "opaque", raw, responsesItem: true });
  };

  const finish = (): ParsedInputItems => {
    const boundarySafe =
      sawItem &&
      // Elevated items live in req.system rather than the normalized message
      // prefix. A suffix request cannot reconstruct them from a checkpoint.
      elevatedItems.length === 0 &&
      !elevatedAfterConversation &&
      !seamHasPendingReasoning &&
      seamKind !== "tool-call" &&
      seamKind !== "tool-result";
    if (pendingReasoning.length > 0) {
      messages.push({
        role: "assistant",
        content: [],
        provenanceContent: pendingReasoning,
        provenancePositions: [],
      });
      pendingReasoning = [];
    }

    return {
      messages,
      instructions,
      elevatedItems,
      hasLateItems: elevatedAfterConversation,
      boundarySafe,
    };
  };

  return { add, finish };
}

function parseMessageContent(content: unknown): GatewayContentBlock[] {
  if (typeof content === "string") {
    return content ? [{ type: "text", text: content }] : [];
  }

  if (!Array.isArray(content)) return [];

  const blocks: GatewayContentBlock[] = [];
  for (const part of content as Array<Record<string, unknown>>) {
    if (
      part.type === "input_text" ||
      part.type === "output_text" ||
      part.type === "text"
    ) {
      // Annotations on output_text are known native metadata. The source
      // envelope retains them for replay; only its visible words enter Lore.
      // Any other text metadata remains request-only and is rejected for users.
      if (
        typeof part.text !== "string" ||
        Object.keys(part).some(
          (key) =>
            key !== "type" &&
            key !== "text" &&
            !(
              key === "annotations" &&
              part.type === "output_text" &&
              Array.isArray(part.annotations)
            ),
        )
      ) {
        // Retain native wire fields, but never project unknown text metadata
        // into visible conversation text for a different provider.
        blocks.push({ type: "opaque", raw: part, requestOnly: true });
        continue;
      }
      const text = asString(part.text);
      if (
        !text &&
        part.type === "output_text" &&
        Array.isArray(part.annotations) &&
        part.annotations.length > 0
      ) {
        // Keep this visible empty part so native provenance retains its
        // position. Its citation remains in the source envelope, never text.
        blocks.push({ type: "text", text: "" });
        continue;
      }
      if (text) blocks.push({ type: "text", text });
    } else {
      // Unknown content part (input_image, input_audio, input_file, …) —
      // preserve verbatim as opaque so it round-trips losslessly.
      blocks.push({ type: "opaque", raw: part });
    }
  }
  return blocks;
}

function parseAssistantMessageContent(item: Record<string, unknown>): {
  content: GatewayContentBlock[];
  provenanceContent: GatewayContentBlock[];
  provenancePositions: number[];
} {
  if (typeof item.content === "string") {
    const content = item.content
      ? [{ type: "text" as const, text: item.content }]
      : [];
    return {
      content,
      provenanceContent: [{ type: "opaque", raw: item, responsesItem: true }],
      provenancePositions: content.map(() => 0),
    };
  }

  const content: GatewayContentBlock[] = [];
  // Keep the source item whole: adjacent source messages may have identical
  // envelopes, while parts of a single message must replay as one item.
  const provenanceContent: GatewayContentBlock[] = [
    { type: "opaque", raw: item, responsesItem: true },
  ];
  const provenancePositions: number[] = [];
  if (!Array.isArray(item.content)) {
    return { content, provenanceContent, provenancePositions };
  }
  for (const part of item.content as Array<Record<string, unknown>>) {
    if (!part || typeof part !== "object" || Array.isArray(part)) {
      throw new InvalidCrossProviderRequestError();
    }
    if (isImageBlock(part)) {
      throw new InvalidCrossProviderRequestError();
    }
    const isText = part.type === "output_text" || part.type === "text";
    if (isText && typeof part.text !== "string") {
      throw new InvalidCrossProviderRequestError();
    }
    const text = isText ? asString(part.text) : "";
    const visible: GatewayContentBlock | undefined = text
      ? { type: "text", text }
      : !isText
        ? { type: "opaque", raw: part }
        : undefined;
    if (!visible) {
      // The full item retains empty text, annotations, and the enclosing
      // status for replay and foreign-route checks.
      continue;
    }
    provenancePositions.push(0);
    content.push(visible);
  }
  return { content, provenanceContent, provenancePositions };
}

function parseArguments(args: unknown): unknown {
  if (typeof args === "string") {
    try {
      return JSON.parse(args);
    } catch {
      return args;
    }
  }
  return args ?? {};
}

/**
 * OpenAI strict function schemas require every property to be listed in
 * `required`. Recall has three mutually exclusive modes, so the properties
 * omitted by a mode must be represented as nullable instead.
 */
function buildStrictRecallParameters(
  inputSchema: Record<string, unknown>,
): Record<string, unknown> {
  const schema = { ...inputSchema };
  delete schema.anyOf;
  const sourceProperties =
    schema.properties &&
    typeof schema.properties === "object" &&
    !Array.isArray(schema.properties)
      ? (schema.properties as Record<string, unknown>)
      : {};
  const properties = Object.fromEntries(
    Object.entries(sourceProperties).map(([name, value]) => {
      const property =
        value && typeof value === "object" && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : {};
      const sourceTypes = Array.isArray(property.type)
        ? property.type
        : typeof property.type === "string"
          ? [property.type]
          : [];
      const nonNullTypes = sourceTypes.filter((item) => item !== "null");
      if (
        nonNullTypes.length === 0 ||
        nonNullTypes.some((item) => typeof item !== "string")
      ) {
        throw new Error(
          `Recall schema property "${name}" must declare a non-null type`,
        );
      }
      const type = [...nonNullTypes, "null"];
      return [
        name,
        {
          ...property,
          type,
          ...(Array.isArray(property.enum)
            ? {
                enum: property.enum.includes(null)
                  ? property.enum
                  : [...property.enum, null],
              }
            : {}),
        },
      ];
    }),
  );
  return {
    ...schema,
    properties,
    required: Object.keys(properties),
  };
}

function chatTextFormatForResponses(
  format: Record<string, unknown>,
): Record<string, unknown> {
  if (
    !format ||
    typeof format !== "object" ||
    Array.isArray(format) ||
    Object.keys(format).some((key) => key !== "type" && key !== "json_schema")
  ) {
    throw new InvalidCrossProviderRequestError();
  }
  if (format.type === "json_object" || format.type === "text") {
    if (format.json_schema !== undefined) {
      throw new InvalidCrossProviderRequestError();
    }
    return { format: { type: format.type } };
  }
  if (format.type !== "json_schema") {
    throw new InvalidCrossProviderRequestError();
  }
  const schema = format.json_schema;
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    throw new InvalidCrossProviderRequestError();
  }
  const value = schema as Record<string, unknown>;
  if (
    Object.keys(value).some(
      (key) =>
        key !== "name" &&
        key !== "description" &&
        key !== "schema" &&
        key !== "strict",
    ) ||
    typeof value.name !== "string" ||
    !value.name.trim() ||
    (value.description !== undefined &&
      typeof value.description !== "string") ||
    !value.schema ||
    typeof value.schema !== "object" ||
    Array.isArray(value.schema) ||
    (value.strict !== undefined && typeof value.strict !== "boolean")
  ) {
    throw new InvalidCrossProviderRequestError();
  }
  return {
    format: {
      type: "json_schema",
      name: value.name,
      ...(value.description !== undefined
        ? { description: value.description }
        : {}),
      ...(value.strict !== undefined ? { strict: value.strict } : {}),
      schema: value.schema,
    },
  };
}

// ---------------------------------------------------------------------------
// GatewayRequest → OpenAI Responses API upstream request
// ---------------------------------------------------------------------------

export function buildOpenAIResponsesUpstreamRequest(
  req: GatewayRequest,
  upstreamBase: string,
): { url: string; headers: Record<string, string>; body: unknown } {
  // Forward non-managed client headers first, then overlay gateway-managed.
  const headers: Record<string, string> = {
    ...forwardClientHeaders(req.rawHeaders),
    "content-type": "application/json",
  };

  // Forward auth — Responses API uses Bearer
  const cred = extractAuth(req.rawHeaders);
  if (cred) {
    headers.Authorization = `Bearer ${cred.value}`;
  }

  const body: Record<string, unknown> = {
    model: req.model,
    stream: req.stream,
    // The gateway sends full history, so upstream response storage is unused.
    store: false,
  };

  if (req.maxTokens) {
    body.max_output_tokens = req.maxTokens;
  }

  const nativeInstructions =
    req.protocol === "openai-responses"
      ? req.extras?.nativeInstructionPrefix
      : undefined;
  if (nativeInstructions) {
    const prefix = nativeInstructions.normalizedSystem;
    if (
      prefix &&
      req.system !== prefix &&
      !req.system.startsWith(`${prefix}\n\n`)
    ) {
      throw new Error("Responses instruction provenance changed");
    }
    const suffix =
      req.system === prefix
        ? ""
        : prefix
          ? req.system.slice(prefix.length + 2)
          : req.system;
    const instructions = [nativeInstructions.originalInstructions, suffix]
      .filter(Boolean)
      .join("\n\n");
    if (instructions) body.instructions = instructions;
    body.input = [
      ...nativeInstructions.items,
      ...buildResponsesInput(req.messages, req.protocol),
    ];
  } else {
    if (req.system) body.instructions = req.system;
    body.input = buildResponsesInput(req.messages, req.protocol);
  }

  // Add tools in Responses API format
  if (req.tools.length > 0) {
    body.tools = req.tools.map((t) => {
      if (t.responsesBuiltin === "web_search_preview") {
        return { type: "web_search_preview" };
      }
      if (
        t.name !== "recall" ||
        t.gatewayOwned !== true ||
        t.inputSchema.additionalProperties !== false
      ) {
        return {
          type: "function",
          name: t.name,
          description: t.description,
          parameters: t.inputSchema,
          ...(t.strict !== undefined ? { strict: t.strict } : {}),
        };
      }
      return {
        type: "function",
        name: t.name,
        description: t.description,
        strict: true,
        parameters: buildStrictRecallParameters(t.inputSchema),
      };
    });
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
    // Intentionally do NOT forward `previous_response_id`. The gateway is a
    // stateless full-history proxy: `buildResponsesInput` above already sends
    // the COMPLETE (gradient-transformed, recall-injected) conversation as
    // `input`. `previous_response_id` would tell the upstream to ALSO prepend
    // its server-stored copy of the prior turns — duplicating history and,
    // worse, defeating the gateway's compression and recall edits with an
    // un-editable server-side copy. Dropping it keeps the upstream's view
    // consistent with what the gateway actually sends.
    //
    // Logged at `warn` (not `error`) deliberately: this is the gateway working
    // as designed, not a failure. `error` would print red `[lore]` noise on
    // every request from a client that sets the field. The file log + Sentry
    // breadcrumb provide observability; the application-level symptom (no
    // server-side continuation) is what a debugging user would actually chase.
    if (req.extras.previous_response_id !== undefined) {
      log.warn(
        "dropping previous_response_id; gateway sends full conversation history " +
          "as input and does not rely on server-side response storage",
      );
    }
    if (req.extras.reasoning !== undefined) {
      body.reasoning = req.extras.reasoning;
    }
    if (req.extras.truncation !== undefined) {
      body.truncation = req.extras.truncation;
    }
    if (req.extras.text !== undefined) {
      body.text = req.extras.text;
    }
    if (req.extras.response_format !== undefined) {
      body.text = chatTextFormatForResponses(req.extras.response_format);
    }
    if (req.extras.parallel_tool_calls !== undefined) {
      body.parallel_tool_calls = req.extras.parallel_tool_calls;
    }
    if (
      req.protocol === "openai-responses" &&
      req.extras.tool_choice !== undefined
    ) {
      body.tool_choice = req.extras.tool_choice;
    }
  }

  const providerRouting = providerRoutingValue(req);
  if (
    !req.codex &&
    providerRouting.present &&
    requestTargetsOpenRouter(req, upstreamBase)
  ) {
    body.provider = providerRouting.value;
  }

  // Codex (ChatGPT) is the OpenAI Responses wire format plus a small, cohesive
  // delta. Keep ALL Codex-specific differences in `applyCodexResponsesDelta`
  // (and the worker-side `buildCodexWorkerRequest`) so the shared builder stays
  // Codex-agnostic and nobody has to sprinkle `req.codex` checks inline.
  if (req.codex) {
    applyCodexResponsesDelta(body, req);
    return {
      url: buildOpenAICodexResponsesUrl(upstreamBase),
      headers,
      body,
    };
  }

  return { url: buildOpenAIResponsesUrl(upstreamBase), headers, body };
}

/**
 * Mutate a standard OpenAI Responses body into a Codex (ChatGPT) body. This is
 * the single home for every Codex-vs-Responses difference:
 *
 *  - REMOVE `max_output_tokens`: ChatGPT's `/codex/responses` rejects it
 *    outright ("Unsupported parameter: max_output_tokens").
 *  - FORCE `store: false`: ChatGPT rejects `store: true`; the gateway sends the
 *    full conversation as `input` and never relies on server-side storage, so
 *    this is also semantically correct. Enforced gateway-side, not trusted from
 *    the client.
 *  - RE-EMIT the Codex control fields captured by `parseOpenAICodexRequest`
 *    (`include`, `prompt_cache_key`, `tool_choice`,
 *    `parallel_tool_calls`, `service_tier`).
 */
function applyCodexResponsesDelta(
  body: Record<string, unknown>,
  req: GatewayRequest,
): void {
  // ChatGPT Codex rejects the request if this parameter is present
  // ("Unsupported parameter: max_output_tokens"). There is no per-request cap
  // to send instead — Codex enforces its own server-side output limits.
  delete body.max_output_tokens;

  // ChatGPT Codex rejects `store: true`.
  body.store = false;

  const extras = req.extras;
  if (!extras) return;
  if (extras.include !== undefined) body.include = extras.include;
  if (extras.prompt_cache_key !== undefined) {
    body.prompt_cache_key = extras.prompt_cache_key;
  }
  if (extras.tool_choice !== undefined) body.tool_choice = extras.tool_choice;
  if (extras.parallel_tool_calls !== undefined) {
    body.parallel_tool_calls = extras.parallel_tool_calls;
  }
  if (extras.service_tier !== undefined) {
    body.service_tier = extras.service_tier;
  }
}

function assertToolOutputPart(part: unknown): void {
  if (!part || typeof part !== "object" || Array.isArray(part)) {
    throw new InvalidCrossProviderRequestError();
  }
  const value = part as Record<string, unknown>;
  if (value.type === "input_image") {
    // Even native output must not replay malformed or foreign image shapes.
    if (value.image_url === undefined) {
      if (
        Object.keys(value).some(
          (key) => key !== "type" && key !== "file_id" && key !== "detail",
        ) ||
        typeof value.file_id !== "string" ||
        !value.file_id ||
        (value.detail !== undefined &&
          value.detail !== "auto" &&
          value.detail !== "low" &&
          value.detail !== "high" &&
          value.detail !== "original")
      ) {
        throw new InvalidCrossProviderRequestError();
      }
    } else if (typeof value.image_url !== "string") {
      throw new InvalidCrossProviderRequestError();
    } else {
      toResponsesImage(value, "openai-responses");
    }
  } else if (value.type === "output_text" || value.type === "input_text") {
    if (
      typeof value.text !== "string" ||
      Object.keys(value).some(
        (key) =>
          key !== "type" &&
          key !== "text" &&
          !(
            value.type === "output_text" &&
            key === "annotations" &&
            Array.isArray(value.annotations)
          ),
      )
    ) {
      throw new InvalidCrossProviderRequestError();
    }
  } else if (value.type === "input_file") {
    const references = [value.file_id, value.file_data, value.file_url].filter(
      (reference) => reference !== undefined,
    );
    const encoded =
      typeof value.file_data === "string"
        ? /^data:[a-z][a-z0-9.+-]*\/[a-z][a-z0-9.+-]*;base64,([A-Za-z0-9+/]+={0,2})$/i.exec(
            value.file_data,
          )
        : null;
    const validURL = (() => {
      if (value.file_url === undefined) return true;
      if (typeof value.file_url !== "string") return false;
      try {
        const url = new URL(value.file_url);
        return (
          url.protocol === "https:" &&
          !url.username &&
          !url.password &&
          !url.hash
        );
      } catch {
        return false;
      }
    })();
    if (
      Object.keys(value).some(
        (key) =>
          ![
            "type",
            "file_id",
            "file_data",
            "file_url",
            "filename",
            "detail",
          ].includes(key),
      ) ||
      references.length !== 1 ||
      (value.file_id !== undefined &&
        (typeof value.file_id !== "string" || !value.file_id.trim())) ||
      (value.file_data !== undefined &&
        (!encoded ||
          Buffer.from(encoded[1], "base64").toString("base64") !== encoded[1] ||
          typeof value.filename !== "string" ||
          !value.filename.trim())) ||
      !validURL ||
      (value.filename !== undefined &&
        (typeof value.filename !== "string" || !value.filename.trim())) ||
      (value.detail !== undefined &&
        value.detail !== "auto" &&
        value.detail !== "low" &&
        value.detail !== "high")
    ) {
      throw new InvalidCrossProviderRequestError();
    }
  } else {
    throw new InvalidCrossProviderRequestError();
  }
}

function buildResponsesInput(
  messages: GatewayMessage[],
  source: GatewayRequest["protocol"],
): Array<Record<string, unknown>> {
  const items: Array<Record<string, unknown>> = [];
  const synthesizedItemIndices = new Set<number>();
  const appendItem = (item: Record<string, unknown>, native = false): void => {
    const previous = items[items.length - 1];
    if (
      !native &&
      synthesizedItemIndices.has(items.length - 1) &&
      item.type === "message" &&
      previous?.type === "message"
    ) {
      const { content: itemContent, ...itemEnvelope } = item;
      const { content: previousContent, ...previousEnvelope } = previous;
      if (
        JSON.stringify(itemEnvelope) === JSON.stringify(previousEnvelope) &&
        Array.isArray(itemContent) &&
        Array.isArray(previousContent)
      ) {
        previous.content = [...previousContent, ...itemContent];
        return;
      }
    }
    if (!native) synthesizedItemIndices.add(items.length);
    items.push(item);
  };

  for (const msg of messages) {
    for (const block of msg.provenanceContent ?? msg.content) {
      if (block.type === "text") {
        appendItem({
          type: "message",
          role: msg.role === "assistant" ? "assistant" : "user",
          content: [
            {
              type: msg.role === "assistant" ? "output_text" : "input_text",
              text: block.text,
            },
          ],
        });
      } else if (block.type === "tool_use") {
        appendItem({
          type: "function_call",
          call_id: block.id,
          name: block.name,
          arguments: JSON.stringify(block.input),
        });
      } else if (block.type === "tool_result") {
        if (block.isError) throw new InvalidCrossProviderRequestError();
        if (
          source === "openai-responses" &&
          block.nativeResponsesOutputArray === true
        ) {
          const output = block.content.map((part) => {
            if (part.type === "text") {
              return { type: "output_text", text: part.text };
            }
            if (part.type === "opaque") return part.raw;
            throw new InvalidCrossProviderRequestError();
          });
          output.forEach(assertToolOutputPart);
          appendItem({
            type: "function_call_output",
            call_id: block.toolUseId,
            output,
          });
          continue;
        }
        requireTextOnlyToolResult(block);
        // Text-only results from other protocols use a string projection.
        // Native multi-part results take the array path above, even when a
        // compaction boundary deliberately drops their source provenance.
        appendItem({
          type: "function_call_output",
          call_id: block.toolUseId,
          output: blocksToText(block.content),
        });
      } else if (block.type === "opaque") {
        if (
          (block.requestOnly && source !== "openai-responses") ||
          block.raw.type === "thinking" ||
          block.raw.type === "redacted_thinking"
        ) {
          throw new InvalidCrossProviderRequestError();
        }
        if (block.responsesItem) {
          if (block.raw.type === "item_reference") continue;
          if (block.raw.type === "function_call_output") {
            assertResponsesToolOutputEnvelope(block.raw);
            if (
              typeof block.raw.call_id !== "string" ||
              (typeof block.raw.output !== "string" &&
                !Array.isArray(block.raw.output))
            ) {
              throw new InvalidCrossProviderRequestError();
            }
            if (Array.isArray(block.raw.output)) {
              block.raw.output.forEach(assertToolOutputPart);
            } else {
              portableResponsesToolOutput(block.raw);
            }
          }
          let nativeItem = block.raw;
          if (
            (block.raw.type === "message" ||
              (block.raw.type === undefined &&
                (block.raw.role === "user" ||
                  block.raw.role === "assistant"))) &&
            Array.isArray(block.raw.content)
          ) {
            const content = block.raw.content.map((part: unknown) => {
              if (!part || typeof part !== "object" || Array.isArray(part)) {
                return part;
              }
              const rawPart = part as Record<string, unknown>;
              if (isImageBlock(rawPart)) {
                if (block.raw.role !== "user") {
                  throw new InvalidCrossProviderRequestError();
                }
                return toResponsesImage(rawPart, source);
              }
              if (rawPart.type === "input_file") {
                assertToolOutputPart(rawPart);
              }
              return part;
            });
            nativeItem = { ...block.raw, content };
          }
          // Stateless follow-ups must replay complete top-level output items
          // verbatim, including encrypted reasoning, refusals, and future types.
          appendItem(nativeItem, true);
        } else {
          // Re-emit opaque blocks as message content parts (e.g. input_image).
          if (
            source !== "openai-responses" &&
            (!isImageBlock(block.raw) || msg.role !== "user")
          ) {
            throw new InvalidCrossProviderRequestError();
          }
          if (isImageBlock(block.raw) && msg.role !== "user") {
            throw new InvalidCrossProviderRequestError();
          }
          if (block.raw.type === "input_file") {
            assertToolOutputPart(block.raw);
          }
          appendItem({
            type: "message",
            role: msg.role === "assistant" ? "assistant" : "user",
            content: [
              isImageBlock(block.raw)
                ? toResponsesImage(block.raw, source)
                : block.raw,
            ],
          });
        }
      }
    }
  }

  return items;
}

// ---------------------------------------------------------------------------
// GatewayResponse → OpenAI Responses API response
// ---------------------------------------------------------------------------

export function buildOpenAIResponsesResponse(
  resp: GatewayResponse,
  wasStreaming: boolean,
): Response {
  if (wasStreaming) {
    return buildOpenAIResponsesStreamResponse(resp);
  }
  return buildOpenAIResponsesNonStreamResponse(resp);
}

function buildOpenAIResponsesNonStreamResponse(
  resp: GatewayResponse,
): Response {
  const usage = resp.usage ?? ZERO_USAGE;
  const output: Array<Record<string, unknown>> = resp.rawOutputItems
    ? [...resp.rawOutputItems]
    : [];
  let textContent = "";
  const functionCalls: Array<Record<string, unknown>> = [];

  if (!resp.rawOutputItems) {
    for (const block of resp.content) {
      if (block.type === "text") {
        textContent += block.text;
      } else if (block.type === "tool_use") {
        functionCalls.push({
          type: "function_call",
          id: `fc_${block.id}`,
          call_id: block.id,
          name: block.name,
          arguments: JSON.stringify(block.input),
          status: "completed",
        });
      }
    }

    if (textContent) {
      output.push({
        type: "message",
        id: `msg_${resp.id}`,
        role: "assistant",
        status: "completed",
        content: [
          {
            type: "output_text",
            text: textContent,
            annotations: [],
          },
        ],
      });
    }

    output.push(...functionCalls);
  }

  const status = mapStopReasonToStatus(resp.stopReason);
  const response = {
    id: resp.id.startsWith("resp_") ? resp.id : `resp_${resp.id}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model: resp.model,
    status,
    ...(status === "incomplete"
      ? { incomplete_details: incompleteDetails(resp.stopReason) }
      : {}),
    output,
    usage: responsesUsage(usage),
  };

  return new Response(JSON.stringify(response), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function mapStopReasonToStatus(reason: string): string {
  switch (reason) {
    case "end_turn":
    case "stop":
    case "stop_sequence":
      return "completed";
    case "max_tokens":
    case "length":
    case "content_filter":
      return "incomplete";
    case "tool_use":
      return "completed";
    default:
      return "completed";
  }
}

function incompleteDetails(stopReason: string): { reason: string } {
  return {
    reason:
      stopReason === "content_filter" ? "content_filter" : "max_output_tokens",
  };
}

type ResponsesEventEmitter = (
  eventType: string,
  data: Record<string, unknown>,
) => void;

function emitRawResponsesOutputItemLifecycle(
  emit: ResponsesEventEmitter,
  item: Record<string, unknown>,
  outputIndex: number,
): void {
  const itemType = String(item.type);
  if (itemType === "message") {
    const itemId =
      typeof item.id === "string" && item.id
        ? item.id
        : `msg_lore_${outputIndex}`;
    const addedItem: Record<string, unknown> = {
      ...item,
      status: "in_progress",
      content: [],
    };
    emit("response.output_item.added", {
      type: "response.output_item.added",
      output_index: outputIndex,
      item: addedItem,
    });

    const content = Array.isArray(item.content) ? item.content : [];
    for (const [contentIndex, rawPart] of content.entries()) {
      if (!rawPart || typeof rawPart !== "object" || Array.isArray(rawPart)) {
        continue;
      }
      const part = rawPart as Record<string, unknown>;
      if (part.type === "output_text" && typeof part.text === "string") {
        emit("response.content_part.added", {
          type: "response.content_part.added",
          item_id: itemId,
          output_index: outputIndex,
          content_index: contentIndex,
          part: {
            type: "output_text",
            text: "",
            annotations: Array.isArray(part.annotations)
              ? part.annotations
              : [],
          },
        });
        for (let offset = 0; offset < part.text.length; offset += 50) {
          emit("response.output_text.delta", {
            type: "response.output_text.delta",
            item_id: itemId,
            output_index: outputIndex,
            content_index: contentIndex,
            delta: part.text.slice(offset, offset + 50),
          });
        }
        emit("response.output_text.done", {
          type: "response.output_text.done",
          item_id: itemId,
          output_index: outputIndex,
          content_index: contentIndex,
          text: part.text,
        });
        emit("response.content_part.done", {
          type: "response.content_part.done",
          item_id: itemId,
          output_index: outputIndex,
          content_index: contentIndex,
          part,
        });
      } else if (part.type === "refusal" && typeof part.refusal === "string") {
        emit("response.content_part.added", {
          type: "response.content_part.added",
          item_id: itemId,
          output_index: outputIndex,
          content_index: contentIndex,
          part: {
            type: "refusal",
            refusal: "",
          },
        });
        for (let offset = 0; offset < part.refusal.length; offset += 50) {
          emit("response.refusal.delta", {
            type: "response.refusal.delta",
            item_id: itemId,
            output_index: outputIndex,
            content_index: contentIndex,
            delta: part.refusal.slice(offset, offset + 50),
          });
        }
        emit("response.refusal.done", {
          type: "response.refusal.done",
          item_id: itemId,
          output_index: outputIndex,
          content_index: contentIndex,
          refusal: part.refusal,
        });
        emit("response.content_part.done", {
          type: "response.content_part.done",
          item_id: itemId,
          output_index: outputIndex,
          content_index: contentIndex,
          part,
        });
      }
    }

    emit("response.output_item.done", {
      type: "response.output_item.done",
      output_index: outputIndex,
      item,
    });
    return;
  }

  if (itemType === "function_call") {
    const callId = typeof item.call_id === "string" ? item.call_id : "";
    const itemId =
      typeof item.id === "string" && item.id
        ? item.id
        : `fc_${callId || outputIndex}`;
    const args = typeof item.arguments === "string" ? item.arguments : "";
    emit("response.output_item.added", {
      type: "response.output_item.added",
      output_index: outputIndex,
      item: {
        ...item,
        status: "in_progress",
        arguments: "",
      },
    });
    if (args) {
      emit("response.function_call_arguments.delta", {
        type: "response.function_call_arguments.delta",
        item_id: itemId,
        output_index: outputIndex,
        delta: args,
      });
    }
    emit("response.function_call_arguments.done", {
      type: "response.function_call_arguments.done",
      item_id: itemId,
      output_index: outputIndex,
      arguments: args,
    });
    emit("response.output_item.done", {
      type: "response.output_item.done",
      output_index: outputIndex,
      item,
    });
    return;
  }

  const addedItem = { ...item };
  if (
    [
      "reasoning",
      "web_search_call",
      "file_search_call",
      "tool_search_call",
      "computer_call",
      "computer_tool_call",
      "code_interpreter_call",
      "image_generation_call",
      "local_shell_call",
      "shell_call",
      "mcp_call",
      "custom_tool_call",
      "apply_patch_call",
    ].includes(itemType)
  ) {
    addedItem.status = "in_progress";
  }
  emit("response.output_item.added", {
    type: "response.output_item.added",
    output_index: outputIndex,
    item: addedItem,
  });
  emit("response.output_item.done", {
    type: "response.output_item.done",
    output_index: outputIndex,
    item,
  });
}

function buildOpenAIResponsesStreamResponse(resp: GatewayResponse): Response {
  const usage = resp.usage ?? ZERO_USAGE;
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      const respId = resp.id.startsWith("resp_") ? resp.id : `resp_${resp.id}`;
      const created = Math.floor(Date.now() / 1000);

      function emit(eventType: string, data: Record<string, unknown>) {
        controller.enqueue(
          encoder.encode(
            `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`,
          ),
        );
      }

      // response.created
      emit("response.created", {
        type: "response.created",
        response: {
          id: respId,
          object: "response",
          created_at: created,
          model: resp.model,
          status: "in_progress",
          output: [],
          usage: null,
        },
      });

      // Buffered Codex responses still carry subscription windows and credits.
      // These values are independent of the token usage Lore may rescale.
      for (const quota of sanitizeCodexRateLimitEvents(
        resp.codexRateLimits ?? [],
      )) {
        emit("codex.rate_limits", quota);
      }

      // response.in_progress
      emit("response.in_progress", {
        type: "response.in_progress",
        response: {
          id: respId,
          object: "response",
          created_at: created,
          model: resp.model,
          status: "in_progress",
          output: [],
          usage: null,
        },
      });

      let outputIndex = 0;

      // Rebuild native Responses output items when the accumulator has
      // them. This includes opaque reasoning items with encrypted_content;
      // reducing them to GatewayResponse.content would silently drop the
      // provider's continuation state from buffered client streams.
      if (resp.rawOutputItems) {
        for (const item of resp.rawOutputItems) {
          emitRawResponsesOutputItemLifecycle(emit, item, outputIndex);
          outputIndex++;
        }
      } else {
        for (const block of resp.content) {
          if (block.type === "text") {
            const itemId = `msg_${respId}_${outputIndex}`;

            // output_item.added
            emit("response.output_item.added", {
              type: "response.output_item.added",
              output_index: outputIndex,
              item: {
                type: "message",
                id: itemId,
                role: "assistant",
                status: "in_progress",
                content: [],
              },
            });

            // content_part.added
            emit("response.content_part.added", {
              type: "response.content_part.added",
              item_id: itemId,
              output_index: outputIndex,
              content_index: 0,
              part: { type: "output_text", text: "", annotations: [] },
            });

            // output_text.delta — emit text in chunks
            const text = block.text;
            let pos = 0;
            while (pos < text.length) {
              const chunk = text.slice(pos, pos + 50);
              emit("response.output_text.delta", {
                type: "response.output_text.delta",
                item_id: itemId,
                output_index: outputIndex,
                content_index: 0,
                delta: chunk,
              });
              pos += 50;
            }

            // output_text.done
            emit("response.output_text.done", {
              type: "response.output_text.done",
              item_id: itemId,
              output_index: outputIndex,
              content_index: 0,
              text: block.text,
            });

            // content_part.done
            emit("response.content_part.done", {
              type: "response.content_part.done",
              item_id: itemId,
              output_index: outputIndex,
              content_index: 0,
              part: {
                type: "output_text",
                text: block.text,
                annotations: [],
              },
            });

            // output_item.done
            emit("response.output_item.done", {
              type: "response.output_item.done",
              output_index: outputIndex,
              item: {
                type: "message",
                id: itemId,
                role: "assistant",
                status: "completed",
                content: [
                  {
                    type: "output_text",
                    text: block.text,
                    annotations: [],
                  },
                ],
              },
            });

            outputIndex++;
          } else if (block.type === "tool_use") {
            const callId = block.id;
            const itemId = `fc_${callId}`;
            const args = JSON.stringify(block.input);

            // output_item.added
            emit("response.output_item.added", {
              type: "response.output_item.added",
              output_index: outputIndex,
              item: {
                type: "function_call",
                id: itemId,
                call_id: callId,
                name: block.name,
                arguments: "",
                status: "in_progress",
              },
            });

            // function_call_arguments.delta
            emit("response.function_call_arguments.delta", {
              type: "response.function_call_arguments.delta",
              item_id: itemId,
              output_index: outputIndex,
              delta: args,
            });

            // function_call_arguments.done
            emit("response.function_call_arguments.done", {
              type: "response.function_call_arguments.done",
              item_id: itemId,
              output_index: outputIndex,
              arguments: args,
            });

            // output_item.done
            emit("response.output_item.done", {
              type: "response.output_item.done",
              output_index: outputIndex,
              item: {
                type: "function_call",
                id: itemId,
                call_id: callId,
                name: block.name,
                arguments: args,
                status: "completed",
              },
            });

            outputIndex++;
          }
        }
      }

      const status = mapStopReasonToStatus(resp.stopReason);
      const terminalEvent =
        status === "incomplete" ? "response.incomplete" : "response.completed";
      emit(terminalEvent, {
        type: terminalEvent,
        response: {
          id: respId,
          object: "response",
          created_at: created,
          model: resp.model,
          status,
          ...(status === "incomplete"
            ? { incomplete_details: incompleteDetails(resp.stopReason) }
            : {}),
          output:
            resp.rawOutputItems ??
            resp.content
              .map((block, i) => {
                if (block.type === "text") {
                  return {
                    type: "message",
                    id: `msg_${respId}_${i}`,
                    role: "assistant",
                    status: "completed",
                    content: [
                      {
                        type: "output_text",
                        text: block.text,
                        annotations: [],
                      },
                    ],
                  };
                }
                if (block.type === "tool_use") {
                  return {
                    type: "function_call",
                    id: `fc_${block.id}`,
                    call_id: block.id,
                    name: block.name,
                    arguments: JSON.stringify(block.input),
                    status: "completed",
                  };
                }
                return null;
              })
              .filter(Boolean),
          usage: responsesUsage(usage),
        },
      });

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
