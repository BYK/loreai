/**
 * Google Gemini (native `generateContent`) ↔ Gateway translation layer.
 *
 * Converts between Google's native Generative Language API
 * (`POST /v1beta/models/{model}:generateContent` /
 * `:streamGenerateContent?alt=sse`) and the gateway's internal
 * `GatewayRequest`/`GatewayResponse` types.
 *
 * This is a DISTINCT wire format from OpenAI/Anthropic (it is NOT the OpenAI
 * compatibility layer at `/v1beta/openai/...`). Key differences:
 *   - roles are `user` / `model` (not `assistant`);
 *   - the system prompt lives in `systemInstruction` (a `{parts:[{text}]}`);
 *   - tool calls are `functionCall` parts; tool results are `functionResponse`
 *     parts. Gemini has NO per-call id — calls/results are paired by function
 *     NAME, so we synthesize the internal tool-use id from the name;
 *   - tools are `[{functionDeclarations:[{name,description,parameters}]}]`;
 *   - generation params live under `generationConfig`;
 *   - auth is an API key via the `x-goog-api-key` header. Clients that use the
 *     `?key=` query form instead have it normalized to that header at ingress
 *     (see `handleGeminiGenerateContent`), since the upstream URL is rebuilt.
 */
import type {
  GatewayContentBlock,
  GatewayMessage,
  GatewayRequest,
  GatewayResponse,
  GatewayTool,
  GatewayUsage,
} from "./types";
import { blocksToText, forwardClientHeaders, ZERO_USAGE } from "./types";

/** Default Gemini API version segment used when building upstream URLs. */
const GEMINI_API_VERSION = "v1beta";

/** Default max output tokens when a request omits `generationConfig.maxOutputTokens`. */
const DEFAULT_GEMINI_MAX_TOKENS = 8192;

type GeminiPart = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Gemini generateContent request → GatewayRequest
// ---------------------------------------------------------------------------

/** Extract the joined text of a Gemini `{parts:[{text}]}` container. */
function partsText(container: unknown): string {
  const parts = (container as { parts?: unknown } | undefined)?.parts;
  if (!Array.isArray(parts)) return "";
  return (parts as GeminiPart[])
    .filter((p) => typeof p.text === "string")
    .map((p) => String(p.text))
    .join("");
}

/** Map a single Gemini content part to a gateway content block. */
function partToBlock(part: GeminiPart): GatewayContentBlock | null {
  if (typeof part.text === "string") {
    // A `thought: true` part is the model's private reasoning summary
    // (thinkingConfig.includeThoughts). It must NOT be concatenated with the
    // visible answer — map it to a distinct thinking block so egress can keep
    // the `thought` flag and clients can tell reasoning from answer.
    if (part.thought === true) {
      return { type: "thinking", thinking: part.text };
    }
    return { type: "text", text: part.text };
  }
  if (part.functionCall && typeof part.functionCall === "object") {
    const fc = part.functionCall as { name?: unknown; args?: unknown };
    const name = String(fc.name ?? "");
    // Gemini has no per-call id; pair by NAME (see file header).
    return { type: "tool_use", id: name, name, input: fc.args ?? {} };
  }
  if (part.functionResponse && typeof part.functionResponse === "object") {
    const fr = part.functionResponse as { name?: unknown; response?: unknown };
    const name = String(fr.name ?? "");
    return {
      type: "tool_result",
      toolUseId: name,
      content: [{ type: "text", text: JSON.stringify(fr.response ?? {}) }],
    };
  }
  // inlineData / fileData / executableCode / … — preserve verbatim.
  return { type: "opaque", raw: part };
}

/**
 * Parse a Gemini `generateContent` request body into a `GatewayRequest`.
 *
 * `model` and `stream` are supplied by the caller because Gemini carries them in
 * the URL, not the body: the model is the path segment
 * (`/v1beta/models/{model}:…`) and streaming is selected by the verb
 * (`:streamGenerateContent` vs `:generateContent`).
 */
export function parseGeminiRequest(
  body: unknown,
  headers: Record<string, string>,
  model: string,
  stream: boolean,
): GatewayRequest {
  const raw = (body ?? {}) as Record<string, unknown>;

  // System prompt: `systemInstruction` (camelCase) or `system_instruction`.
  const system = partsText(raw.systemInstruction ?? raw.system_instruction);

  const rawContents = Array.isArray(raw.contents) ? raw.contents : [];
  const messages: GatewayMessage[] = [];
  for (const c of rawContents as Array<Record<string, unknown>>) {
    const geminiRole = String(c.role ?? "user");
    // Gemini roles: "model" → assistant; "user"/"function" → user.
    const role: "user" | "assistant" =
      geminiRole === "model" ? "assistant" : "user";
    const parts = Array.isArray(c.parts) ? (c.parts as GeminiPart[]) : [];
    const blocks: GatewayContentBlock[] = [];
    for (const p of parts) {
      const block = partToBlock(p);
      if (block) blocks.push(block);
    }
    messages.push({ role, content: blocks });
  }

  // Tools: `[{functionDeclarations:[{name,description,parameters}]}]`.
  const tools: GatewayTool[] = [];
  const rawTools = Array.isArray(raw.tools) ? raw.tools : [];
  for (const t of rawTools as Array<Record<string, unknown>>) {
    const decls = Array.isArray(t.functionDeclarations)
      ? (t.functionDeclarations as Array<Record<string, unknown>>)
      : [];
    for (const d of decls) {
      tools.push({
        name: String(d.name ?? ""),
        description: String(d.description ?? ""),
        inputSchema: (d.parameters as Record<string, unknown>) ?? {},
      });
    }
  }

  const genConfig = (raw.generationConfig ?? {}) as Record<string, unknown>;
  const maxTokens =
    typeof genConfig.maxOutputTokens === "number"
      ? genConfig.maxOutputTokens
      : DEFAULT_GEMINI_MAX_TOKENS;

  // Preserve generation params + any non-standard top-level fields the gateway
  // doesn't model, so they round-trip to the upstream.
  const metadata: Record<string, unknown> = {};
  if (Object.keys(genConfig).length > 0) metadata.generationConfig = genConfig;
  if (raw.safetySettings) metadata.safetySettings = raw.safetySettings;
  if (raw.toolConfig) metadata.toolConfig = raw.toolConfig;
  if (raw.cachedContent) metadata.cachedContent = raw.cachedContent;

  return {
    protocol: "gemini",
    model,
    system,
    messages,
    tools,
    stream,
    maxTokens,
    metadata,
    rawHeaders: { ...headers },
  };
}

// ---------------------------------------------------------------------------
// GatewayRequest → Gemini generateContent upstream request
// ---------------------------------------------------------------------------

/** Build the Gemini `:generateContent` / `:streamGenerateContent` URL. */
export function buildGeminiUpstreamUrl(
  base: string,
  model: string,
  stream: boolean,
): string {
  const verb = stream ? "streamGenerateContent" : "generateContent";
  const encodedModel = encodeURIComponent(model);
  const url = `${base}/${GEMINI_API_VERSION}/models/${encodedModel}:${verb}`;
  return stream ? `${url}?alt=sse` : url;
}

/** Convert a gateway content block to Gemini part(s). */
function blockToGeminiParts(block: GatewayContentBlock): GeminiPart[] {
  switch (block.type) {
    case "text":
      return block.text ? [{ text: block.text }] : [];
    case "thinking":
      // Re-emit as a Gemini thought part (`text` + `thought: true`) so a
      // reasoning summary round-trips as reasoning — never merged into the
      // visible answer text.
      return block.thinking ? [{ text: block.thinking, thought: true }] : [];
    case "tool_use":
      return [{ functionCall: { name: block.name, args: block.input ?? {} } }];
    case "tool_result": {
      const text = blocksToText(block.content);
      let response: unknown;
      try {
        const parsed = JSON.parse(text);
        response =
          parsed && typeof parsed === "object" ? parsed : { output: text };
      } catch {
        response = { output: text };
      }
      return [{ functionResponse: { name: block.toolUseId, response } }];
    }
    case "opaque":
      return [block.raw as GeminiPart];
  }
}

/**
 * Build the upstream Gemini request `{url, headers, body}` from a
 * `GatewayRequest`. Injects the (LTM-augmented) system prompt as
 * `systemInstruction`. Auth is the API key via the `x-goog-api-key` header
 * (forwarded from the client by `forwardClientHeaders`; a client `?key=` query
 * param is normalized to this header at ingress). The upstream URL is rebuilt
 * from scratch, so query-string auth is NOT preserved on the URL itself.
 */
export function buildGeminiUpstreamRequest(
  req: GatewayRequest,
  upstreamBase: string,
): { url: string; headers: Record<string, string>; body: unknown } {
  const headers: Record<string, string> = {
    ...forwardClientHeaders(req.rawHeaders),
    "content-type": "application/json",
  };

  const contents: Array<Record<string, unknown>> = [];
  for (const msg of req.messages) {
    const role = msg.role === "assistant" ? "model" : "user";
    const parts: GeminiPart[] = [];
    for (const block of msg.content) parts.push(...blockToGeminiParts(block));
    if (parts.length > 0) contents.push({ role, parts });
  }

  const body: Record<string, unknown> = { contents };

  if (req.system) {
    body.systemInstruction = { parts: [{ text: req.system }] };
  }

  if (req.tools.length > 0) {
    body.tools = [
      {
        functionDeclarations: req.tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.inputSchema,
        })),
      },
    ];
  }

  // Reconstruct generationConfig: preserve the client's original config, and
  // ensure maxOutputTokens reflects the gateway's normalized value.
  const genConfig: Record<string, unknown> = {
    ...((req.metadata.generationConfig as Record<string, unknown>) ?? {}),
  };
  if (req.maxTokens) genConfig.maxOutputTokens = req.maxTokens;
  if (Object.keys(genConfig).length > 0) body.generationConfig = genConfig;

  if (req.metadata.safetySettings)
    body.safetySettings = req.metadata.safetySettings;
  if (req.metadata.toolConfig) body.toolConfig = req.metadata.toolConfig;
  if (req.metadata.cachedContent)
    body.cachedContent = req.metadata.cachedContent;

  return {
    url: buildGeminiUpstreamUrl(upstreamBase, req.model, req.stream),
    headers,
    body,
  };
}

// ---------------------------------------------------------------------------
// Gemini response → GatewayResponse
// ---------------------------------------------------------------------------

/**
 * Map a Gemini `finishReason` + tool presence to an internal stop reason.
 *
 * Abnormal reasons (SAFETY, RECITATION, BLOCKLIST, PROHIBITED_CONTENT, SPII,
 * MALFORMED_FUNCTION_CALL, OTHER, …) are preserved VERBATIM so a proxied client
 * still sees the real block/filter signal instead of a laundered "STOP".
 * `toGeminiFinishReason` echoes any such preserved value back on egress. Only
 * the truly-normal reasons are normalized to the internal model. A block reason
 * takes precedence over `hasToolCall` (a filtered turn is not a tool turn).
 */
export function mapGeminiFinishReason(
  reason: unknown,
  hasToolCall: boolean,
): string {
  const r = String(reason ?? "");
  const isNormal =
    r === "" ||
    r === "STOP" ||
    r === "MAX_TOKENS" ||
    r === "FINISH_REASON_UNSPECIFIED";
  if (!isNormal) return r; // preserve verbatim
  if (hasToolCall) return "tool_use";
  if (r === "MAX_TOKENS") return "max_tokens";
  return "end_turn";
}

/**
 * Convert a Gemini `usageMetadata` object into `GatewayUsage`. Shared by the
 * non-streaming parser and the SSE accumulator (single source of truth — avoids
 * drift). Gemini bills thinking separately in `thoughtsTokenCount`; fold it into
 * outputTokens (the internal model is Anthropic-shaped, where output_tokens
 * INCLUDES thinking). Omitting it undercounts output for the gateway's
 * cost-aware routing and understates the client's total.
 */
export function geminiUsageFromMetadata(
  um: Record<string, unknown> | undefined,
): GatewayUsage {
  if (!um) return { ...ZERO_USAGE };
  const candidates =
    typeof um.candidatesTokenCount === "number" ? um.candidatesTokenCount : 0;
  const thoughts =
    typeof um.thoughtsTokenCount === "number" ? um.thoughtsTokenCount : 0;
  const usage: GatewayUsage = {
    inputTokens:
      typeof um.promptTokenCount === "number" ? um.promptTokenCount : 0,
    outputTokens: candidates + thoughts,
  };
  if (typeof um.cachedContentTokenCount === "number") {
    usage.cacheReadInputTokens = um.cachedContentTokenCount;
  }
  return usage;
}

/** Parse Gemini `usageMetadata` into `GatewayUsage`. */
function parseGeminiUsage(json: Record<string, unknown>): GatewayUsage {
  return geminiUsageFromMetadata(
    json.usageMetadata as Record<string, unknown> | undefined,
  );
}

/**
 * Parse a Gemini `generateContent` response JSON into a `GatewayResponse`.
 * Mirrors `parseAnthropicResponseJSON`, over `candidates[0].content.parts[]`.
 */
export function parseGeminiResponseJSON(
  json: Record<string, unknown>,
): GatewayResponse {
  const candidates = Array.isArray(json.candidates) ? json.candidates : [];
  // LIMITATION: the internal model holds a single response, so when a client
  // requests `candidateCount > 1` only candidates[0] is surfaced. Multi-candidate
  // fan-out is a documented follow-up, not currently supported.
  const first = (candidates[0] ?? {}) as Record<string, unknown>;
  const content = (first.content ?? {}) as Record<string, unknown>;
  const parts = Array.isArray(content.parts)
    ? (content.parts as GeminiPart[])
    : [];

  const blocks: GatewayContentBlock[] = [];
  let hasToolCall = false;
  for (const p of parts) {
    const block = partToBlock(p);
    if (!block) continue;
    if (block.type === "tool_use") hasToolCall = true;
    blocks.push(block);
  }

  // Prompt-level block: Gemini returns NO candidates plus
  // `promptFeedback.blockReason`. Surface that reason as the stop reason instead
  // of laundering it into a fake `end_turn`/STOP, so the client sees the block.
  const promptFeedback = json.promptFeedback as
    | { blockReason?: unknown }
    | undefined;
  const stopReason =
    candidates.length === 0 && promptFeedback?.blockReason
      ? String(promptFeedback.blockReason)
      : mapGeminiFinishReason(first.finishReason, hasToolCall);

  return {
    id: String(json.responseId ?? ""),
    model: String(json.modelVersion ?? ""),
    content: blocks,
    stopReason,
    usage: parseGeminiUsage(json),
  };
}

// ---------------------------------------------------------------------------
// GatewayResponse → Gemini client response
// ---------------------------------------------------------------------------

/** Map an internal stop reason back to a Gemini `finishReason`. */
function toGeminiFinishReason(stopReason: string): string {
  switch (stopReason) {
    case "max_tokens":
    case "length":
      return "MAX_TOKENS";
    case "end_turn":
    case "tool_use":
    case "stop":
    case "":
      // Gemini reports STOP even for tool calls.
      return "STOP";
    default:
      // A preserved Gemini block reason (SAFETY, RECITATION, …) — echo verbatim.
      return stopReason;
  }
}

/** Build the Gemini non-streaming JSON body from a `GatewayResponse`. */
export function buildGeminiResponseBody(
  resp: GatewayResponse,
): Record<string, unknown> {
  const usage = resp.usage ?? ZERO_USAGE;
  const parts: GeminiPart[] = [];
  for (const block of resp.content) parts.push(...blockToGeminiParts(block));

  const usageMetadata: Record<string, unknown> = {
    promptTokenCount: usage.inputTokens,
    candidatesTokenCount: usage.outputTokens,
    totalTokenCount: usage.inputTokens + usage.outputTokens,
  };
  if (usage.cacheReadInputTokens != null) {
    usageMetadata.cachedContentTokenCount = usage.cacheReadInputTokens;
  }

  return {
    candidates: [
      {
        content: { role: "model", parts },
        finishReason: toGeminiFinishReason(resp.stopReason),
        index: 0,
      },
    ],
    usageMetadata,
    ...(resp.model ? { modelVersion: resp.model } : {}),
  };
}

/**
 * Build a client-facing Gemini `Response`. For `stream`, emits a single
 * aggregated SSE chunk (`data: <json>\n\n`) matching `?alt=sse`; otherwise a
 * plain JSON body. Used when the gateway accumulated internally and must
 * re-emit in the Gemini wire format.
 */
export function buildGeminiResponse(
  resp: GatewayResponse,
  stream: boolean,
): Response {
  const bodyJson = buildGeminiResponseBody(resp);
  if (stream) {
    const sse = `data: ${JSON.stringify(bodyJson)}\n\n`;
    return new Response(sse, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }
  return new Response(JSON.stringify(bodyJson), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
