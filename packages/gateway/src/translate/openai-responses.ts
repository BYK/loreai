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
import { asString, log } from "@loreai/core";
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
import { extractAuth } from "../auth";
import { safeTokenSum } from "../usage-validation";

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
  const raw = (body ?? {}) as Record<string, unknown>;

  const model = asString(raw.model);
  const stream = raw.stream === true;

  // max_output_tokens defaults to 4096 if not specified
  const maxTokens =
    typeof raw.max_output_tokens === "number" ? raw.max_output_tokens : 4096;

  // System prompt comes from `instructions`
  const system = typeof raw.instructions === "string" ? raw.instructions : "";

  // Parse input items into normalized messages
  const messages = parseInputItems(raw.input);

  // Parse tools
  const rawTools = Array.isArray(raw.tools) ? raw.tools : [];
  const tools: GatewayTool[] = rawTools
    .filter((t: Record<string, unknown>) => t.type === "function")
    .map((t: Record<string, unknown>) => ({
      name: asString(t.name),
      description: asString(t.description),
      inputSchema: (t.parameters as Record<string, unknown>) ?? {},
    }));

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
  // Responses API-specific extras
  if (raw.previous_response_id !== undefined) {
    extras.previous_response_id = raw.previous_response_id as string;
  }
  if (raw.reasoning !== undefined) {
    extras.reasoning = raw.reasoning;
  }
  if (raw.truncation !== undefined) {
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

/**
 * Parse a Pi `openai-codex` request. The wire format is the OpenAI Responses
 * API, so we reuse `parseOpenAIResponsesRequest` for the shared parsing and add
 * the Codex-specific delta on top:
 *   - flag the request as Codex (steers the upstream URL + `store:false`)
 *   - capture Codex control fields (`store`, `include`, `prompt_cache_key`,
 *     `text`, `tool_choice`, `parallel_tool_calls`, `service_tier`).
 *
 * These fields are captured ONLY here (not in the shared base parser) so normal
 * `openai-responses` callers keep their existing upstream body untouched.
 */
export function parseOpenAICodexRequest(
  body: unknown,
  headers: Record<string, string>,
): GatewayRequest {
  const req = parseOpenAIResponsesRequest(body, headers);
  req.codex = true;

  const raw = (body ?? {}) as Record<string, unknown>;
  if (!req.extras) req.extras = {};
  const extras = req.extras;
  // NOTE: `store` is intentionally NOT captured — the upstream builder forces
  // `store: false` for all Codex requests (ChatGPT rejects `store: true`), so
  // echoing the client's value would be dead state.
  if (raw.include !== undefined) {
    extras.include = raw.include;
  }
  if (typeof raw.prompt_cache_key === "string") {
    extras.prompt_cache_key = raw.prompt_cache_key;
  }
  if (raw.text !== undefined) {
    extras.text = raw.text;
  }
  if (raw.tool_choice !== undefined) {
    extras.tool_choice = raw.tool_choice;
  }
  if (typeof raw.parallel_tool_calls === "boolean") {
    extras.parallel_tool_calls = raw.parallel_tool_calls;
  }
  if (typeof raw.service_tier === "string") {
    extras.service_tier = raw.service_tier;
  }

  return req;
}

// ---------------------------------------------------------------------------
// Input item parsing
// ---------------------------------------------------------------------------

function parseInputItems(input: unknown): GatewayMessage[] {
  // String shorthand: single user message
  if (typeof input === "string") {
    return [{ role: "user", content: [{ type: "text", text: input }] }];
  }

  if (!Array.isArray(input)) return [];

  const messages: GatewayMessage[] = [];
  let pendingReasoning: GatewayContentBlock[] = [];

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

  for (const item of input as Array<Record<string, unknown>>) {
    const itemType = item.type as string | undefined;
    const role = item.role as string | undefined;

    if (itemType === "message" || (!itemType && role)) {
      // Message item — has role + content
      const msgRole =
        role === "assistant" || role === "developer" || role === "system"
          ? role
          : "user";

      const content = parseMessageContent(item.content);

      if (msgRole === "developer" || msgRole === "system") {
        // developer/system messages in input array are treated as user messages
        // with the system content (the real system prompt is in `instructions`)
        if (content.length > 0) {
          messages.push({ role: "user", content });
        }
      } else if (msgRole === "assistant") {
        const parsed = parseAssistantMessageContent(item);
        appendAssistant(
          parsed.content,
          parsed.provenanceContent,
          parsed.provenancePositions,
        );
      } else {
        if (content.length > 0) {
          messages.push({ role: "user", content });
        }
      }
      continue;
    }

    if (itemType === "function_call") {
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
        id: asString(item.call_id ?? item.id),
        name: asString(item.name),
        input: parseArguments(item.arguments),
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
        provenance.push(...pendingReasoning, toolUseBlock);
        positions.push(position);
        last.content.push(toolUseBlock);
        if (last.provenanceContent || pendingReasoning.length > 0) {
          last.provenanceContent = provenance;
          last.provenancePositions = positions;
        }
        pendingReasoning = [];
      } else {
        appendAssistant([toolUseBlock]);
      }
      continue;
    }

    if (itemType === "function_call_output") {
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
        toolUseId: asString(item.call_id),
        content: parseMessageContent(item.output),
      };
      const last = messages[messages.length - 1];
      const lastIsToolResultMessage =
        last !== undefined &&
        last.role === "user" &&
        last.content.length > 0 &&
        last.content.every((b) => b.type === "tool_result");
      if (lastIsToolResultMessage) {
        last.content.push(toolResultBlock);
      } else {
        messages.push({ role: "user", content: [toolResultBlock] });
      }
      continue;
    }

    if (itemType === "reasoning") {
      pendingReasoning.push({ type: "opaque", raw: item, responsesItem: true });
      continue;
    }

    // Other item types — skip, but warn about ones that can carry conversation
    // content the gateway cannot reconstruct.
    //
    // `item_reference` points to an item OpenAI stored server-side (under an
    // opaque upstream id). The gateway is a stateless full-history proxy: it
    // rewrites the conversation every turn and never persists upstream item
    // ids, so it has no way to resolve a reference. Codex itself never emits
    // these (it always sends full input items), but other Responses-API
    // clients might. Surface it so we have observability if it ever happens
    // rather than silently dropping context. (`reasoning` items are expected
    // and intentionally dropped — don't warn on those.)
    if (itemType === "item_reference") {
      log.warn(
        `dropping unresolvable Responses API item_reference (id=${asString(item.id, "?")}); ` +
          `gateway is stateless full-history and cannot resolve server-side item references`,
      );
      continue;
    }

    // Preserve every self-contained item in request-only provenance. The
    // gateway may not render an unknown item, but canonical replay must hash
    // the same full transcript on both the producing and consuming turns.
    pendingReasoning.push({ type: "opaque", raw: item, responsesItem: true });
  }

  if (pendingReasoning.length > 0) {
    messages.push({
      role: "assistant",
      content: [],
      provenanceContent: pendingReasoning,
      provenancePositions: [],
    });
  }

  return messages;
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
      const text = asString(part.text);
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
      provenanceContent: [...content],
      provenancePositions: content.map((_block, index) => index),
    };
  }

  const content: GatewayContentBlock[] = [];
  const provenanceContent: GatewayContentBlock[] = [];
  const provenancePositions: number[] = [];
  if (!Array.isArray(item.content)) {
    return { content, provenanceContent, provenancePositions };
  }
  for (const part of item.content as Array<Record<string, unknown>>) {
    const isText = part.type === "output_text" || part.type === "text";
    const text = isText ? asString(part.text) : "";
    const visible: GatewayContentBlock | undefined = text
      ? { type: "text", text }
      : !isText
        ? { type: "opaque", raw: part }
        : undefined;
    if (!visible) continue;
    provenancePositions.push(provenanceContent.length);
    content.push(visible);
    provenanceContent.push({
      type: "opaque",
      raw: { ...item, content: [part] },
      responsesItem: true,
    });
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
  };

  if (req.maxTokens) {
    body.max_output_tokens = req.maxTokens;
  }

  // System prompt → instructions
  if (req.system) {
    body.instructions = req.system;
  }

  // Build input items from normalized messages
  body.input = buildResponsesInput(req.messages);

  // Add tools in Responses API format
  if (req.tools.length > 0) {
    body.tools = req.tools.map((t) => {
      if (t.name !== "recall" || t.inputSchema.additionalProperties !== false) {
        return {
          type: "function",
          name: t.name,
          description: t.description,
          parameters: t.inputSchema,
        };
      }
      const properties = t.inputSchema.properties as Record<
        string,
        Record<string, unknown>
      >;
      return {
        type: "function",
        name: t.name,
        description: t.description,
        strict: true,
        parameters: {
          ...t.inputSchema,
          properties: {
            ...properties,
            scope: {
              ...properties.scope,
              type: ["string", "null"],
              enum: [...((properties.scope.enum as unknown[]) ?? []), null],
            },
            id: { ...properties.id, type: ["string", "null"] },
          },
          required: Object.keys(properties),
        },
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
    if (req.extras.parallel_tool_calls !== undefined) {
      body.parallel_tool_calls = req.extras.parallel_tool_calls;
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
    return { url: `${upstreamBase}/codex/responses`, headers, body };
  }

  return { url: `${upstreamBase}/v1/responses`, headers, body };
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
 *    (`include`, `prompt_cache_key`, `text`, `tool_choice`,
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
  if (extras.text !== undefined) body.text = extras.text;
  if (extras.tool_choice !== undefined) body.tool_choice = extras.tool_choice;
  if (extras.parallel_tool_calls !== undefined) {
    body.parallel_tool_calls = extras.parallel_tool_calls;
  }
  if (extras.service_tier !== undefined) {
    body.service_tier = extras.service_tier;
  }
}

function buildResponsesInput(
  messages: GatewayMessage[],
): Array<Record<string, unknown>> {
  const items: Array<Record<string, unknown>> = [];
  const appendItem = (item: Record<string, unknown>): void => {
    const previous = items[items.length - 1];
    if (item.type === "message" && previous?.type === "message") {
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
        // Responses API function_call_output.output is a string — use the
        // text projection. (Non-text tool-result sub-blocks can't be
        // represented on this wire format; Anthropic-native clients are
        // unaffected.)
        appendItem({
          type: "function_call_output",
          call_id: block.toolUseId,
          output: blocksToText(block.content),
        });
      } else if (block.type === "opaque") {
        if (block.responsesItem) {
          if (block.raw.type === "item_reference") continue;
          // Stateless follow-ups must replay complete top-level output items
          // verbatim, including encrypted reasoning, refusals, and future types.
          appendItem(block.raw);
        } else {
          // Re-emit opaque blocks as message content parts (e.g. input_image).
          appendItem({
            type: "message",
            role: msg.role === "assistant" ? "assistant" : "user",
            content: [block.raw],
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

      // Process content blocks
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
          output: resp.content
            .map((block, i) => {
              if (block.type === "text") {
                return {
                  type: "message",
                  id: `msg_${respId}_${i}`,
                  role: "assistant",
                  status: "completed",
                  content: [
                    { type: "output_text", text: block.text, annotations: [] },
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
