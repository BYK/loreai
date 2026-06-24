/**
 * Gateway recall interception — transparent memory search for any client.
 *
 * Uses a unified "Marker and Expand" strategy:
 *
 *  1. **On response (to client):** The recall `tool_use` block is replaced
 *     with a human-readable marker text block
 *     (`📚 Searching <scope> for "<query>"…`). The recall is executed
 *     internally and the result is stored in session state.
 *
 *  2. **On request (from client):** Marker text blocks in the conversation
 *     are expanded back into the original `tool_use` + `tool_result` pairs
 *     before forwarding upstream.
 *
 *  For recall-only responses, a follow-up call is still made internally
 *  so the model can continue in the same HTTP response (seamless UX).
 *
 * All recall execution delegates to `runRecall()` from `@loreai/core`.
 */
import {
  runRecall,
  RECALL_TOOL_DESCRIPTION,
  RECALL_PARAM_DESCRIPTIONS,
  log,
  config as loreConfig,
  type RecallScope,
  type LLMClient,
} from "@loreai/core";

import type {
  GatewayTool,
  GatewayRequest,
  GatewayResponse,
  GatewayToolUseBlock,
  GatewayMessage,
  RecallStore,
  StoredRecall,
} from "./translate/types";

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

/** Recall tool definition for injection into upstream requests. */
export const RECALL_GATEWAY_TOOL: GatewayTool = {
  name: "recall",
  description: RECALL_TOOL_DESCRIPTION,
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: RECALL_PARAM_DESCRIPTIONS.query,
      },
      scope: {
        type: "string",
        enum: ["all", "session", "project", "knowledge"],
        description: RECALL_PARAM_DESCRIPTIONS.scope,
      },
      id: {
        type: "string",
        description: RECALL_PARAM_DESCRIPTIONS.id,
      },
    },
    required: ["query"],
  },
};

export const RECALL_TOOL_NAME = "recall";

/** Safety-net cap on recall follow-ups per client request (like any agentic loop). */
export const MAX_RECALL_DEPTH = 10;

// ---------------------------------------------------------------------------
// Marker utilities — human-readable text ↔ recall tool round-trip
// ---------------------------------------------------------------------------

/** Scope → human-readable label for marker text. */
const SCOPE_LABELS: Record<string, string> = {
  all: "all archives",
  session: "session history",
  project: "project archives",
  knowledge: "knowledge base",
};

/** Reverse: label → scope enum. */
const LABEL_TO_SCOPE: Record<string, RecallScope> = Object.fromEntries(
  Object.entries(SCOPE_LABELS).map(([k, v]) => [v, k as RecallScope]),
);

/** Map a recall scope to a human-readable label. */
export function scopeToLabel(scope: string = "all"): string {
  return SCOPE_LABELS[scope] ?? SCOPE_LABELS.all;
}

/** Map a human-readable label back to a scope enum value. */
export function labelToScope(label: string): RecallScope {
  return LABEL_TO_SCOPE[label] ?? "all";
}

/**
 * Build a marker text string for a recall tool call.
 *
 * Format: `📚 Searching <scope-label> for "<query>"…`
 * When `id` is provided (detail lookup), uses: `📚 Fetching detail for <id>…`
 */
export function buildRecallMarker(
  query: string,
  scope: string = "all",
  id?: string,
): string {
  if (id) return `📚 Fetching detail for ${id}…`;
  return `📚 Searching ${scopeToLabel(scope)} for "${query}"…`;
}

/** Regex to parse a recall marker back into query + scope. */
const MARKER_REGEX = /📚 Searching (.+?) for "(.+?)"…/;

/** Regex to parse an id-based recall marker. */
const ID_MARKER_REGEX = /📚 Fetching detail for (.+?)…/;

/** Check if a text string is a recall marker (search or detail). */
export function isRecallMarker(text: string): boolean {
  return parseRecallMarker(text) !== null;
}

/**
 * Parse a recall marker text block, returning query and scope if valid.
 * Returns null if the text doesn't match the marker format.
 */
export function parseRecallMarker(
  text: string,
): { query: string; scope: RecallScope; id?: string } | null {
  // Try id-based marker first
  const idMatch = ID_MARKER_REGEX.exec(text);
  if (idMatch) {
    return { query: "", scope: "all", id: idMatch[1] };
  }
  const match = MARKER_REGEX.exec(text);
  if (!match) return null;
  return {
    query: match[2],
    scope: labelToScope(match[1]),
  };
}

/**
 * Serialize a recall store to JSON for cross-restart persistence.
 *
 * The store is in-memory per session; without persistence a gateway restart
 * loses it, so historical recall markers can no longer be expanded into their
 * tool_use + tool_result pair and instead leak upstream as raw marker TEXT —
 * rewriting that (deep) assistant message and busting the prompt cache
 * (ses_14b9bf3d… incident). Persisting + restoring keeps expansion byte-stable.
 */
export function serializeRecallStore(store: RecallStore): string {
  return JSON.stringify([...store.entries()]);
}

/** Restore a recall store from its JSON form. Tolerant of corrupt/old blobs. */
export function deserializeRecallStore(json: string): RecallStore {
  const store: RecallStore = new Map();
  try {
    const entries = JSON.parse(json);
    if (!Array.isArray(entries)) return store;
    for (const entry of entries) {
      if (
        Array.isArray(entry) &&
        entry.length === 2 &&
        typeof entry[0] === "string" &&
        entry[1] &&
        typeof entry[1] === "object" &&
        typeof (entry[1] as StoredRecall).toolUseId === "string" &&
        typeof (entry[1] as StoredRecall).result === "string"
      ) {
        store.set(entry[0], entry[1] as StoredRecall);
      }
    }
  } catch {
    // Corrupt blob — start empty (markers fall back to raw text; recoverable
    // once the recall re-executes).
  }
  return store;
}

/** Derive a store key from query + scope, or from id for detail lookups. */
export function recallStoreKey(
  query: string,
  scope: string = "all",
  id?: string,
): string {
  if (id) return `id:${id}`;
  return `${scope}:${query}`;
}

// ---------------------------------------------------------------------------
// Marker expansion — restore tool_use + tool_result from markers on inbound
// ---------------------------------------------------------------------------

/**
 * Find recall marker text blocks in the conversation and expand them
 * back into tool_use + tool_result pairs for the upstream API.
 *
 * Scans ALL assistant messages (not just the last one) since markers
 * persist across turns until gradient evicts the message.
 *
 * Mutates the request in-place. Returns true if any expansion was performed.
 */
export function expandRecallMarkers(
  req: GatewayRequest,
  store: RecallStore,
): boolean {
  let expanded = false;

  // Iterate forward; when we splice messages the index is adjusted.
  for (let i = 0; i < req.messages.length; i++) {
    const msg = req.messages[i];
    if (msg.role !== "assistant") continue;

    // Find the first (should be only) recall marker in this message.
    // We process one marker per assistant message per pass; the outer
    // loop will revisit if there's more than one (rare).
    let markerIdx = -1;
    let parsed: { query: string; scope: RecallScope; id?: string } | null =
      null;
    for (let j = 0; j < msg.content.length; j++) {
      const block = msg.content[j];
      if (block.type !== "text") continue;
      parsed = parseRecallMarker(block.text);
      if (parsed) {
        markerIdx = j;
        break;
      }
    }

    if (markerIdx < 0 || !parsed) continue;

    const key = recallStoreKey(parsed.query, parsed.scope, parsed.id);
    const stored = store.get(key);
    if (!stored) continue; // No stored result — leave marker as-is

    // Check if there's non-tool content AFTER the marker in this message.
    // This happens when recall-only follow-up piped continuation content
    // (text blocks) into the same assistant message. Tool_use blocks after
    // the marker are from the same turn (mixed tools) and stay together.
    const afterMarker = msg.content.slice(markerIdx + 1);
    const hasContinuationAfter =
      afterMarker.length > 0 && afterMarker.some((b) => b.type !== "tool_use");

    // Replace marker with tool_use
    msg.content[markerIdx] = {
      type: "tool_use",
      id: stored.toolUseId,
      name: RECALL_TOOL_NAME,
      input: stored.input,
    };

    // Truncate assistant message at the tool_use (remove continuation)
    if (hasContinuationAfter) {
      msg.content.length = markerIdx + 1;
    }

    // Build synthetic tool_result user message
    const toolResultMsg: GatewayMessage = {
      role: "user",
      content: [
        {
          type: "tool_result",
          toolUseId: stored.toolUseId,
          content: [{ type: "text", text: stored.result }],
        },
      ],
    };

    if (hasContinuationAfter) {
      // Split: insert tool_result user message + continuation assistant
      // message after the current assistant message.
      const continuationMsg: GatewayMessage = {
        role: "assistant",
        content: afterMarker,
      };
      req.messages.splice(i + 1, 0, toolResultMsg, continuationMsg);
      // Skip past the two newly inserted messages
      i += 2;
    } else {
      // No split needed — insert tool_result into the following user message.
      // Prepend (unshift) so the recall result appears before existing
      // tool_results — matching the tool_use order in the assistant message.
      const nextMsg = req.messages[i + 1];
      if (nextMsg?.role === "user") {
        nextMsg.content.unshift({
          type: "tool_result",
          toolUseId: stored.toolUseId,
          content: [{ type: "text", text: stored.result }],
        });
      } else {
        // No following user message — insert a synthetic one
        req.messages.splice(i + 1, 0, toolResultMsg);
        i += 1;
      }
    }

    expanded = true;
  }

  return expanded;
}

/**
 * Clean up orphaned recall store entries whose markers no longer
 * appear in the conversation (e.g. gradient evicted the turn).
 */
export function cleanupRecallStore(
  req: GatewayRequest,
  store: RecallStore,
): void {
  if (store.size === 0) return;

  // Collect all marker keys still present in assistant messages
  const activeKeys = new Set<string>();
  for (const msg of req.messages) {
    if (msg.role !== "assistant") continue;
    for (const block of msg.content) {
      if (block.type !== "text") continue;
      const parsed = parseRecallMarker(block.text);
      if (parsed) {
        activeKeys.add(recallStoreKey(parsed.query, parsed.scope, parsed.id));
      }
    }
  }

  // Remove entries not referenced by any current marker
  for (const key of store.keys()) {
    if (!activeKeys.has(key)) {
      store.delete(key);
    }
  }
}

// ---------------------------------------------------------------------------
// Detection helpers
// ---------------------------------------------------------------------------

/** Find the recall tool_use block in a GatewayResponse, if any. */
export function findRecallToolUse(
  resp: GatewayResponse,
): GatewayToolUseBlock | undefined {
  return resp.content.find(
    (b): b is GatewayToolUseBlock =>
      b.type === "tool_use" && b.name === RECALL_TOOL_NAME,
  );
}

/** Check whether a response contains a recall tool_use. */
export function hasRecallToolUse(resp: GatewayResponse): boolean {
  return findRecallToolUse(resp) !== undefined;
}

/** Check whether the response contains non-recall tool_use blocks. */
export function hasOtherToolUse(resp: GatewayResponse): boolean {
  return resp.content.some(
    (b) => b.type === "tool_use" && b.name !== RECALL_TOOL_NAME,
  );
}

/** Check whether the client's tools list already includes a recall tool. */
export function clientHasRecallTool(tools: GatewayTool[]): boolean {
  return tools.some((t) => t.name === RECALL_TOOL_NAME);
}

// ---------------------------------------------------------------------------
// Recall execution
// ---------------------------------------------------------------------------

/** Parse recall input from the tool_use block. */
function parseRecallInput(block: GatewayToolUseBlock): {
  query: string;
  scope: RecallScope;
  id?: string;
} {
  const input = block.input as Record<string, unknown>;
  return {
    query: typeof input.query === "string" ? input.query : "",
    scope: (input.scope as RecallScope) ?? "all",
    ...(typeof input.id === "string" && input.id ? { id: input.id } : {}),
  };
}

/**
 * Execute the recall tool and return formatted results.
 *
 * Wraps `runRecall()` with error handling — on failure returns a
 * user-friendly error string rather than throwing.
 */
export async function executeRecall(
  block: GatewayToolUseBlock,
  projectPath: string,
  sessionID: string,
  llm?: LLMClient,
): Promise<{
  result: string;
  input: { query: string; scope?: RecallScope; id?: string };
}> {
  const { query, scope, id } = parseRecallInput(block);
  const cfg = loreConfig();

  try {
    const result = await runRecall({
      query,
      scope,
      id,
      projectPath,
      sessionID,
      knowledgeEnabled: cfg.knowledge?.enabled ?? true,
      llm,
      searchConfig: cfg.search,
      // Genuine agent recall — record cross-project transfer metrics (#506).
      recordTransfers: true,
    });

    return { result, input: { query, scope, id } };
  } catch (e) {
    log.error("gateway recall execution failed:", e);
    return {
      result: "Recall search failed. The memory system encountered an error.",
      input: { query, scope, id },
    };
  }
}

// ---------------------------------------------------------------------------
// Follow-up request builder (Case 1: recall-only)
// ---------------------------------------------------------------------------

/** Wire protocol used for a recall follow-up upstream response. */
export type RecallProtocol =
  | "anthropic"
  | "openai"
  | "openai-responses"
  | "vertex";

/**
 * Injected upstream dependencies for recall follow-up execution.
 *
 * Passed by the pipeline so `recall.ts` never imports `pipeline.ts`
 * (avoids a circular dependency). `forward` wraps `forwardToUpstream`
 * — callers should disable conversation caching on the follow-up;
 * `parseJSON` wraps `accumulateNonStreamResponse`.
 */
export interface RecallFollowUpCtx {
  /** Forward a follow-up request upstream and return the raw response. */
  forward: (
    req: GatewayRequest,
  ) => Promise<{ response: Response; effectiveProtocol: RecallProtocol }>;
  /** Parse a non-streaming (JSON) upstream response into a GatewayResponse. */
  parseJSON: (
    response: Response,
    protocol: RecallProtocol,
  ) => Promise<GatewayResponse>;
}

/**
 * Build a follow-up request after recall execution.
 *
 * The follow-up includes:
 *  - All original messages
 *  - A synthetic assistant message with thinking blocks + recall tool_use
 *  - A user message with recall results as a tool_result
 *  - Full tools list (including recall — the continuation is recall-aware)
 *
 * The model continues from where it left off, now with recall results
 * in context. If it needs more detail it can call recall again.
 *
 * `stream` is REQUIRED (no default) and MUST match how the caller consumes
 * the upstream response: `false` → JSON via `accumulateNonStreamResponse()`,
 * `true` → SSE via `parseSSEStream()`. A mismatch produces a silent empty
 * stream ("conversation stops after recall"). Callers should NOT use this
 * builder directly — use `runRecallFollowUpStreaming()` /
 * `runRecallFollowUpJSON()`, which couple the flag to its consumer so the two
 * can never diverge. Exported only for unit-testing the message structure.
 */
export function buildRecallFollowUpRequest(
  originalReq: GatewayRequest,
  resp: GatewayResponse,
  recallResult: string,
  recallToolUseBlock: GatewayToolUseBlock,
  stream: boolean,
): GatewayRequest {
  // Build the follow-up using proper tool_use/tool_result pairs.
  //
  // Why: sending recall results as plain user text causes the LLM to treat
  // them as conversational input — during streaming, the model may echo raw
  // recall formatting (knowledge entries, internal IDs, score tiers) before
  // settling into a natural response. Using tool_result tells the LLM these
  // are tool outputs to synthesize, not user speech to parrot.
  //
  // This also matches the shape that expandRecallMarkers() reconstructs on
  // subsequent turns, so the model sees a consistent message structure.
  //
  // Thinking blocks MUST be preserved: the Anthropic API requires thinking
  // blocks (with their cryptographic signatures) to precede content blocks
  // in assistant messages when extended thinking is enabled.
  // Using a deny-list (exclude text/tool_use/tool_result) rather than an
  // allow-list so future block types (e.g. redacted_thinking) are preserved
  // by default.
  const prefixBlocks = resp.content.filter(
    (b) =>
      b.type !== "text" && b.type !== "tool_use" && b.type !== "tool_result",
  );

  const assistantMessage: GatewayMessage = {
    role: "assistant",
    content: [
      ...prefixBlocks,
      {
        type: "tool_use",
        id: recallToolUseBlock.id,
        name: recallToolUseBlock.name,
        input: recallToolUseBlock.input,
      },
    ],
  };

  const resultMessage: GatewayMessage = {
    role: "user",
    content: [
      {
        type: "tool_result",
        toolUseId: recallToolUseBlock.id,
        content: [
          { type: "text", text: recallResult || "[No results found.]" },
        ],
      },
    ],
  };

  return {
    ...originalReq,
    // The stream flag is set by the caller-specific helper to match its
    // consumer (JSON vs SSE) — see buildRecallFollowUpRequest's doc comment.
    stream,
    messages: [...originalReq.messages, assistantMessage, resultMessage],
  };
}

// ---------------------------------------------------------------------------
// Content-type guards — fail loud on a stream-flag / consumer mismatch
// ---------------------------------------------------------------------------

/**
 * Assert an upstream recall follow-up response is SSE (`text/event-stream`).
 *
 * The streaming follow-up path consumes the body via `parseSSEStream()`. If
 * the follow-up's `stream` flag is ever wrong, the upstream returns JSON and
 * the SSE parser silently yields zero events — the client gets the recall
 * marker then dead air. Throwing here converts that silent failure into a
 * loud, greppable error (caught by the recall try/catch → marker fallback +
 * Sentry via log.error).
 */
function assertSSEResponse(response: Response): void {
  const ct = response.headers.get("content-type") ?? "";
  if (!ct.includes("text/event-stream")) {
    throw new Error(
      `recall follow-up expected SSE but got "${ct}" — stream flag/consumer mismatch`,
    );
  }
}

/**
 * Assert an upstream recall follow-up response is NOT SSE (JSON expected).
 *
 * The non-streaming follow-up path parses the body as JSON. An SSE body would
 * crash `response.json()`; throwing here gives a clear diagnostic instead.
 */
function assertJSONResponse(response: Response): void {
  const ct = response.headers.get("content-type") ?? "";
  if (ct.includes("text/event-stream")) {
    throw new Error(
      `recall follow-up expected JSON but got SSE — stream flag/consumer mismatch`,
    );
  }
}

// ---------------------------------------------------------------------------
// Coupled build + consume — the ONLY entry points the pipeline should use
// ---------------------------------------------------------------------------

/** Result of a streaming recall follow-up: the SSE reader + the request sent. */
export interface RecallFollowUpStreaming {
  ok: true;
  /** SSE reader for the continuation stream — pipe through parseSSEStream(). */
  reader: ReadableStreamDefaultReader<Uint8Array>;
  /** The follow-up request that was sent (for the next loop iteration). */
  followUp: GatewayRequest;
}

/** Result of a non-streaming recall follow-up: the parsed continuation. */
export interface RecallFollowUpJSON {
  ok: true;
  /** Parsed continuation response. */
  continuation: GatewayResponse;
  /** The follow-up request that was sent (for the next loop iteration). */
  followUp: GatewayRequest;
}

/** Failure result shared by both follow-up modes. */
export interface RecallFollowUpError {
  ok: false;
  /** HTTP status when the upstream responded with a non-OK status. */
  status?: number;
  /** Human-readable error detail for logging. */
  detail: string;
}

/**
 * Build a `stream: true` follow-up, forward it, and return the SSE reader.
 *
 * Couples the stream flag to its consumer: the body is asserted to be SSE and
 * returned as a reader, so a flag/consumer mismatch is structurally impossible
 * and any divergence fails loud (see assertSSEResponse).
 */
export async function runRecallFollowUpStreaming(
  ctx: RecallFollowUpCtx,
  originalReq: GatewayRequest,
  resp: GatewayResponse,
  recallResult: string,
  recallToolUseBlock: GatewayToolUseBlock,
): Promise<RecallFollowUpStreaming | RecallFollowUpError> {
  const followUp = buildRecallFollowUpRequest(
    originalReq,
    resp,
    recallResult,
    recallToolUseBlock,
    /* stream */ true,
  );
  const { response } = await ctx.forward(followUp);
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    return { ok: false, status: response.status, detail: detail.slice(0, 500) };
  }
  assertSSEResponse(response);
  if (!response.body) {
    throw new Error("recall follow-up (streaming) response has no body");
  }
  return { ok: true, reader: response.body.getReader(), followUp };
}

/**
 * Build a `stream: false` follow-up, forward it, and parse the JSON response.
 *
 * Couples the stream flag to its consumer: the body is asserted to be JSON and
 * parsed via the injected `parseJSON`, so a flag/consumer mismatch is
 * structurally impossible and any divergence fails loud (see assertJSONResponse).
 */
export async function runRecallFollowUpJSON(
  ctx: RecallFollowUpCtx,
  originalReq: GatewayRequest,
  resp: GatewayResponse,
  recallResult: string,
  recallToolUseBlock: GatewayToolUseBlock,
): Promise<RecallFollowUpJSON | RecallFollowUpError> {
  const followUp = buildRecallFollowUpRequest(
    originalReq,
    resp,
    recallResult,
    recallToolUseBlock,
    /* stream */ false,
  );
  const { response, effectiveProtocol } = await ctx.forward(followUp);
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    return { ok: false, status: response.status, detail: detail.slice(0, 500) };
  }
  assertJSONResponse(response);
  const continuation = await ctx.parseJSON(response, effectiveProtocol);
  return { ok: true, continuation, followUp };
}

// ---------------------------------------------------------------------------
// Response content rewriting — replace recall tool_use with marker text
// ---------------------------------------------------------------------------

/**
 * Build a GatewayResponse with recall tool_use blocks replaced by marker text.
 *
 * Used for both recall-only and mixed-tools cases to produce a response
 * where the client sees human-readable markers instead of tool call mechanics.
 */
export function replaceRecallWithMarker(
  resp: GatewayResponse,
): GatewayResponse {
  return {
    ...resp,
    content: resp.content.map((b) => {
      if (b.type === "tool_use" && b.name === RECALL_TOOL_NAME) {
        const input = b.input as Record<string, unknown>;
        const query = typeof input.query === "string" ? input.query : "";
        const scope = (input.scope as string) ?? "all";
        const id =
          typeof input.id === "string" && input.id ? input.id : undefined;
        return {
          type: "text" as const,
          text: buildRecallMarker(query, scope, id),
        };
      }
      return b;
    }),
  };
}
