/**
 * Gateway recall interception — transparent memory search for any client.
 *
 * Uses a unified "Marker and Expand" strategy:
 *
 *  1. **On response (to client):** The recall `tool_use` block is replaced
 *     with a text marker. Responses clients receive an invisible unique anchor;
 *     other clients receive status text plus the same anchor. The recall result
 *     is stored in session state under that unique key.
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
import { createHash } from "node:crypto";

import type {
  GatewayTool,
  GatewayRequest,
  GatewayResponse,
  GatewayToolUseBlock,
  GatewayMessage,
  GatewayContentBlock,
  RecallStore,
  StoredRecall,
} from "./translate/types";
import { promiseAgainstAbort } from "./abort-race";
import { cancelAndReleaseReader } from "./stream/anthropic";
import { looksLikeSSE } from "./translate/types";

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
    additionalProperties: false,
  },
};

export const RECALL_TOOL_NAME = "recall";

/** Safety-net cap on recall follow-ups per client request (like any agentic loop). */
export const MAX_RECALL_DEPTH = 10;
export const MAX_RECALL_STORE_ENTRIES = 128;
export const MAX_RECALL_STORE_BYTES = 1024 * 1024;

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
const MARKER_REGEX = /^📚 Searching (.+?) for "(.+)"…$/;

/** Regex to parse an id-based recall marker. */
const ID_MARKER_REGEX = /^📚 Fetching detail for (.+?)…$/;

/** Invisible Responses transcript anchor. Markdown renderers omit comments. */
const ANCHOR_REGEX =
  /^<!-- lore-recall:([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}) -->$/;

export function buildRecallAnchor(toolUseId: string): string {
  return `<!-- lore-recall:${encodeURIComponent(toolUseId)} -->`;
}

/** Keep the visible status while assigning every replay a unique key. */
export function buildAnchoredRecallMarker(
  query: string,
  scope: string,
  id: string | undefined,
  anchorId: string,
): string {
  return `${buildRecallMarker(query, scope, id)}\n${buildRecallAnchor(anchorId)}`;
}

export function parseRecallAnchor(text: string): string | null {
  const match = ANCHOR_REGEX.exec(text);
  return match && buildRecallAnchor(match[1]) === text ? match[1] : null;
}

function parseRecallAnchorFromText(text: string): string | null {
  const direct = parseRecallAnchor(text);
  if (direct) return direct;
  const newline = text.lastIndexOf("\n");
  if (newline < 0) return null;
  return parseRecallAnchor(text.slice(newline + 1));
}

/** Fingerprint the complete transcript prefix that precedes a replay anchor. */
export function recallAnchorContext(
  messages: GatewayMessage[],
  beforeIndex = messages.length,
  assistantPrefix: GatewayContentBlock[] = [],
): string {
  const normalized: GatewayMessage[] = [];
  const append = (message: GatewayMessage): void => {
    const content = message.provenanceContent ?? message.content;
    if (content.length === 0) return;
    const previous = normalized[normalized.length - 1];
    if (previous?.role === message.role) {
      previous.content.push(...content);
    } else {
      normalized.push({ role: message.role, content: [...content] });
    }
  };
  for (const message of messages.slice(0, beforeIndex)) append(message);
  if (assistantPrefix.length > 0) {
    append({ role: "assistant", content: assistantPrefix });
  }
  const hash = createHash("sha256");
  const frame = (value: unknown): void => {
    const payload = JSON.stringify(value);
    hash.update(`${Buffer.byteLength(payload)}:`);
    hash.update(payload);
  };
  normalized.forEach((message, index) =>
    frame([index, message.role, message.content]),
  );
  return hash.digest("hex");
}

function recallMessagePrefix(
  message: GatewayMessage,
  visibleBlocks: number,
): GatewayContentBlock[] {
  if (!message.provenanceContent || !message.provenancePositions) {
    return message.content.slice(0, visibleBlocks);
  }
  const end =
    visibleBlocks < message.provenancePositions.length
      ? message.provenancePositions[visibleBlocks]
      : message.provenanceContent.length;
  return message.provenanceContent.slice(0, end);
}

function replaceVisibleContentBlock(
  message: GatewayMessage,
  visibleIndex: number,
  block: GatewayContentBlock,
): void {
  message.content[visibleIndex] = block;
  if (!message.provenanceContent || !message.provenancePositions) return;
  const provenanceIndex = message.provenancePositions[visibleIndex];
  if (provenanceIndex === undefined) return;
  const nextIndex =
    message.provenancePositions[visibleIndex + 1] ??
    message.provenanceContent.length;
  message.provenanceContent.splice(
    provenanceIndex,
    nextIndex - provenanceIndex,
    block,
  );
  const delta = 1 - (nextIndex - provenanceIndex);
  for (let i = visibleIndex + 1; i < message.provenancePositions.length; i++) {
    message.provenancePositions[i] += delta;
  }
}

function truncateVisibleContent(
  message: GatewayMessage,
  visibleLength: number,
): void {
  message.content.length = visibleLength;
  if (!message.provenanceContent || !message.provenancePositions) return;
  const provenanceLength =
    visibleLength < message.provenancePositions.length
      ? message.provenancePositions[visibleLength]
      : message.provenanceContent.length;
  message.provenanceContent.length = provenanceLength;
  message.provenancePositions.length = visibleLength;
}

function removeVisibleContentBlock(
  message: GatewayMessage,
  visibleIndex: number,
): GatewayContentBlock {
  const provenanceIndex = message.provenancePositions?.[visibleIndex];
  if (
    message.provenanceContent &&
    message.provenancePositions &&
    (provenanceIndex === undefined ||
      provenanceIndex < 0 ||
      provenanceIndex >= message.provenanceContent.length)
  ) {
    throw new Error("invalid visible content provenance");
  }
  const [block] = message.content.splice(visibleIndex, 1);
  if (!block) throw new Error("visible content block not found");
  if (!message.provenanceContent || !message.provenancePositions) return block;
  if (provenanceIndex === undefined) {
    throw new Error("invalid visible content provenance");
  }
  message.provenanceContent.splice(provenanceIndex, 1);
  message.provenancePositions.splice(visibleIndex, 1);
  for (let i = visibleIndex; i < message.provenancePositions.length; i++) {
    message.provenancePositions[i] -= 1;
  }
  return block;
}

function insertVisibleContentBlocks(
  message: GatewayMessage,
  visibleIndex: number,
  blocks: GatewayContentBlock[],
): void {
  if (blocks.length === 0) return;
  message.content.splice(visibleIndex, 0, ...blocks);
  if (!message.provenanceContent || !message.provenancePositions) return;
  const provenanceIndex =
    message.provenancePositions[visibleIndex] ??
    message.provenanceContent.length;
  message.provenanceContent.splice(provenanceIndex, 0, ...blocks);
  for (let i = visibleIndex; i < message.provenancePositions.length; i++) {
    message.provenancePositions[i] += blocks.length;
  }
  message.provenancePositions.splice(
    visibleIndex,
    0,
    ...blocks.map((_block, index) => provenanceIndex + index),
  );
}

type CompanionBundle = {
  content: GatewayContentBlock[];
  provenanceContent?: GatewayContentBlock[];
  provenancePositions?: number[];
};

function insertCompanionBundle(
  message: GatewayMessage,
  visibleIndex: number,
  bundle: CompanionBundle,
): void {
  if (!bundle.provenanceContent || !bundle.provenancePositions) {
    insertVisibleContentBlocks(message, visibleIndex, bundle.content);
    return;
  }
  if (!message.provenanceContent || !message.provenancePositions) {
    message.provenanceContent = [...message.content];
    message.provenancePositions = message.content.map((_block, index) => index);
  }
  message.content.splice(visibleIndex, 0, ...bundle.content);
  const provenanceIndex =
    message.provenancePositions[visibleIndex] ??
    message.provenanceContent.length;
  message.provenanceContent.splice(
    provenanceIndex,
    0,
    ...bundle.provenanceContent,
  );
  for (let i = visibleIndex; i < message.provenancePositions.length; i++) {
    message.provenancePositions[i] += bundle.provenanceContent.length;
  }
  message.provenancePositions.splice(
    visibleIndex,
    0,
    ...bundle.provenancePositions.map((position) => provenanceIndex + position),
  );
}

/** Check if a text string is a recall marker (search or detail). */
export function isRecallMarker(text: string): boolean {
  return (
    parseRecallMarker(text) !== null || parseRecallAnchorFromText(text) !== null
  );
}

function storedRecallForText(
  text: string,
  store: RecallStore,
): { key: string; stored: StoredRecall; canonical: boolean } | null {
  const parsed = parseRecallMarker(text);
  if (parsed) {
    const key = recallStoreKey(parsed.query, parsed.scope, parsed.id);
    const stored = store.get(key);
    return stored ? { key, stored, canonical: false } : null;
  }
  const anchorId = parseRecallAnchorFromText(text);
  if (!anchorId) return null;
  const key = `anchor:${anchorId}`;
  const stored = store.get(key);
  return stored ? { key, stored, canonical: true } : null;
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

/** Add one record without evicting a still-live replay anchor. */
export function addRecallStoreEntry(
  store: RecallStore,
  key: string,
  value: StoredRecall,
): void {
  let minimumBytes = 0;
  const countStrings = (input: unknown): void => {
    if (minimumBytes > MAX_RECALL_STORE_BYTES) return;
    if (typeof input === "string") {
      minimumBytes += Buffer.byteLength(input);
    } else if (Array.isArray(input)) {
      for (const item of input) countStrings(item);
    } else if (input && typeof input === "object") {
      for (const [name, child] of Object.entries(input)) {
        minimumBytes += Buffer.byteLength(name);
        countStrings(child);
      }
    }
  };
  countStrings(key);
  countStrings(value);
  if (minimumBytes > MAX_RECALL_STORE_BYTES) {
    throw new Error("recall store capacity exceeded");
  }
  const candidate = new Map(store);
  candidate.set(key, value);
  if (
    candidate.size > MAX_RECALL_STORE_ENTRIES ||
    Buffer.byteLength(serializeRecallStore(candidate)) > MAX_RECALL_STORE_BYTES
  ) {
    throw new Error("recall store capacity exceeded");
  }
  store.set(key, value);
}

/** Restore a recall store from its JSON form. Tolerant of corrupt/old blobs. */
export function deserializeRecallStore(json: string): RecallStore {
  const store: RecallStore = new Map();
  if (Buffer.byteLength(json) > MAX_RECALL_STORE_BYTES) return store;
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
        isStoredRecall(entry[1]) &&
        isValidRecallStoreEntry(entry[0], entry[1])
      ) {
        try {
          addRecallStoreEntry(store, entry[0], entry[1]);
        } catch {
          break;
        }
      }
    }
  } catch {
    // Corrupt blob — start empty (markers fall back to raw text; recoverable
    // once the recall re-executes).
  }
  return store;
}

function isValidRecallStoreEntry(key: string, item: StoredRecall): boolean {
  if (
    !item.toolUseId ||
    !Number.isSafeInteger(item.position) ||
    item.position < 0 ||
    (item.input.scope !== undefined &&
      item.input.scope !== "all" &&
      item.input.scope !== "session" &&
      item.input.scope !== "project" &&
      item.input.scope !== "knowledge")
  ) {
    return false;
  }
  if (!key.startsWith("anchor:")) {
    return (
      item.anchorContextId === undefined ||
      /^[0-9a-f]{64}$/.test(item.anchorContextId)
    );
  }
  if (!item.anchorContextId || !/^[0-9a-f]{64}$/.test(item.anchorContextId)) {
    return false;
  }
  const anchorId = key.slice("anchor:".length);
  return (
    item.anchorId === anchorId &&
    parseRecallAnchor(buildRecallAnchor(anchorId)) === anchorId
  );
}

function isStoredRecall(value: unknown): value is StoredRecall {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  const input = item.input as Record<string, unknown> | undefined;
  if (
    typeof item.toolUseId !== "string" ||
    typeof item.result !== "string" ||
    typeof item.position !== "number" ||
    !input ||
    typeof input.query !== "string" ||
    (input.scope !== undefined && typeof input.scope !== "string") ||
    ((item.input as Record<string, unknown>).id !== undefined &&
      typeof (item.input as Record<string, unknown>).id !== "string")
  ) {
    return false;
  }
  if (
    (item.anchorId !== undefined && typeof item.anchorId !== "string") ||
    (item.anchorContextId !== undefined &&
      typeof item.anchorContextId !== "string") ||
    (item.companionToolUseIds !== undefined &&
      (!Array.isArray(item.companionToolUseIds) ||
        !item.companionToolUseIds.every((id) => typeof id === "string")))
  ) {
    return false;
  }
  if (item.companionToolUses !== undefined) {
    if (!Array.isArray(item.companionToolUses)) return false;
    for (const companion of item.companionToolUses) {
      if (!companion || typeof companion !== "object") return false;
      const record = companion as Record<string, unknown>;
      if (
        typeof record.id !== "string" ||
        typeof record.name !== "string" ||
        !("input" in record) ||
        (record.side !== "before" && record.side !== "after")
      ) {
        return false;
      }
    }
  }
  return true;
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
  const anchorValidity = new Map<string, boolean[]>();
  const incomingMessages = structuredClone(req.messages);
  for (let i = 0; i < incomingMessages.length; i++) {
    const message = incomingMessages[i];
    if (message.role !== "assistant") continue;
    for (let j = 0; j < message.content.length; j++) {
      const block = message.content[j];
      if (block.type !== "text") continue;
      const candidate = storedRecallForText(block.text, store);
      if (!candidate) continue;
      const valid = candidate.key.startsWith("anchor:")
        ? candidate.stored.anchorContextId ===
          recallAnchorContext(
            incomingMessages,
            i,
            recallMessagePrefix(message, j),
          )
        : candidate.stored.anchorContextId === undefined ||
          candidate.stored.anchorContextId ===
            recallAnchorContext(
              incomingMessages,
              i,
              recallMessagePrefix(message, j),
            );
      const occurrences = anchorValidity.get(candidate.key) ?? [];
      occurrences.push(valid);
      anchorValidity.set(candidate.key, occurrences);
    }
  }

  // Iterate forward; when we splice messages the index is adjusted.
  for (let i = 0; i < req.messages.length; i++) {
    const msg = req.messages[i];
    if (msg.role !== "assistant") continue;

    // Find the first (should be only) recall marker in this message.
    // We process one marker per assistant message per pass; the outer
    // loop will revisit if there's more than one (rare).
    let markerIdx = -1;
    let match: { key: string; stored: StoredRecall } | null = null;
    for (let j = 0; j < msg.content.length; j++) {
      const block = msg.content[j];
      if (block.type !== "text") continue;
      match = storedRecallForText(block.text, store);
      if (match) {
        markerIdx = j;
        break;
      }
    }

    if (markerIdx < 0 || !match) continue;
    const { stored } = match;
    if (!(anchorValidity.get(match.key)?.shift() ?? false)) continue;

    // Responses emits output text and function calls as separate input items,
    // which parse into adjacent assistant messages. Rejoin only tool calls that
    // were companions of the original recall. Continuation tool calls are not
    // companions and must stay after the synthetic recall result turn.
    const companions = stored.companionToolUses;
    const beforeCompanions = companions?.filter(
      (item) => item.side === "before",
    );
    const afterCompanions = companions?.filter((item) => item.side === "after");
    const matchesCompanions = (
      content: GatewayContentBlock[],
      expected: typeof beforeCompanions,
    ): boolean =>
      content.filter((block) => block.type === "tool_use").length ===
        expected?.length &&
      content
        .filter((block) => block.type === "tool_use")
        .every((block, index) => {
          const item = expected[index];
          return (
            block.type === "tool_use" &&
            block.id === item.id &&
            block.name === item.name &&
            JSON.stringify(block.input) === JSON.stringify(item.input)
          );
        });
    const takeCompanions = (message: GatewayMessage): CompanionBundle => {
      if (
        message.content.every((block) => block.type === "tool_use") &&
        message.provenanceContent &&
        message.provenancePositions
      ) {
        const provenanceContent = message.provenanceContent;
        const provenancePositions = message.provenancePositions;
        if (
          provenancePositions.length !== message.content.length ||
          provenancePositions.some(
            (position, index) =>
              !Number.isSafeInteger(position) ||
              position < 0 ||
              position >= provenanceContent.length ||
              (index > 0 && position <= provenancePositions[index - 1]),
          )
        ) {
          throw new Error("invalid companion provenance");
        }
        const bundle: CompanionBundle = {
          content: [...message.content],
          provenanceContent: [...provenanceContent],
          provenancePositions: [...provenancePositions],
        };
        message.content.length = 0;
        provenanceContent.length = 0;
        provenancePositions.length = 0;
        return bundle;
      }
      const moved: GatewayContentBlock[] = [];
      for (let index = message.content.length - 1; index >= 0; index--) {
        if (message.content[index].type === "tool_use") {
          moved.unshift(removeVisibleContentBlock(message, index));
        }
      }
      return { content: moved };
    };
    while ((beforeCompanions?.length ?? 0) > 0 && i > 0) {
      const previous = req.messages[i - 1];
      if (
        previous.role !== "assistant" ||
        !matchesCompanions(previous.content, beforeCompanions)
      ) {
        break;
      }
      const moved = takeCompanions(previous);
      insertCompanionBundle(msg, 0, moved);
      markerIdx += moved.content.length;
      if (
        previous.content.length === 0 &&
        (previous.provenanceContent?.length ?? 0) === 0
      ) {
        req.messages.splice(i - 1, 1);
        i -= 1;
      }
    }
    while ((afterCompanions?.length ?? 0) > 0) {
      const next = req.messages[i + 1];
      if (
        !next ||
        next.role !== "assistant" ||
        !matchesCompanions(next.content, afterCompanions)
      ) {
        break;
      }
      insertCompanionBundle(msg, msg.content.length, takeCompanions(next));
      if (
        next.content.length === 0 &&
        (next.provenanceContent?.length ?? 0) === 0
      ) {
        req.messages.splice(i + 1, 1);
      }
    }

    // Check if there's non-tool content AFTER the marker in this message.
    // This happens when recall-only follow-up piped continuation content
    // (text blocks) into the same assistant message. Tool_use blocks after
    // the marker are from the same turn (mixed tools) and stay together.
    const afterMarker = msg.content.slice(markerIdx + 1);
    const hasContinuationAfter = afterMarker.some((b) => b.type !== "tool_use");

    // Replace marker with tool_use
    replaceVisibleContentBlock(msg, markerIdx, {
      type: "tool_use",
      id: stored.toolUseId,
      name: RECALL_TOOL_NAME,
      input: stored.input,
    });

    // Truncate assistant message at the tool_use (remove continuation)
    if (hasContinuationAfter) {
      truncateVisibleContent(msg, markerIdx + 1);
    }

    // Build synthetic tool_result user message
    const toolResultMsg: GatewayMessage = {
      role: "user",
      content: [
        {
          type: "tool_result",
          toolUseId: stored.toolUseId,
          toolName: RECALL_TOOL_NAME,
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
        const resultIndex = msg.content
          .slice(0, markerIdx)
          .filter((block) => block.type === "tool_use").length;
        nextMsg.content.splice(resultIndex, 0, {
          type: "tool_result",
          toolUseId: stored.toolUseId,
          toolName: RECALL_TOOL_NAME,
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
): boolean {
  if (store.size === 0) return false;

  // Collect all marker keys still present in assistant messages
  const activeKeys = new Set<string>();
  for (const msg of req.messages) {
    if (msg.role !== "assistant") continue;
    for (const block of msg.content) {
      if (block.type !== "text") continue;
      const match = storedRecallForText(block.text, store);
      if (
        match &&
        (!match.stored.anchorContextId ||
          match.stored.anchorContextId ===
            recallAnchorContext(
              req.messages,
              req.messages.indexOf(msg),
              recallMessagePrefix(msg, msg.content.indexOf(block)),
            ))
      ) {
        activeKeys.add(match.key);
      }
    }
  }

  // Remove entries not referenced by any current marker
  let changed = false;
  for (const key of store.keys()) {
    if (!activeKeys.has(key)) {
      store.delete(key);
      changed = true;
    }
  }
  return changed;
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
  const input = block.input;
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Recall input must be an object");
  }
  const record = input as Record<string, unknown>;
  if (record.query !== undefined && typeof record.query !== "string") {
    throw new Error("Recall query must be a string");
  }
  if (
    record.id !== undefined &&
    (typeof record.id !== "string" || !record.id)
  ) {
    throw new Error("Recall id must be a non-empty string");
  }
  const query = record.query ?? "";
  if (!query.trim() && !record.id) {
    throw new Error("Recall query or id is required");
  }
  const validScopes: ReadonlySet<string> = new Set([
    "all",
    "session",
    "project",
    "knowledge",
  ]);
  if (
    record.scope !== undefined &&
    (typeof record.scope !== "string" || !validScopes.has(record.scope))
  ) {
    throw new Error("Invalid recall scope");
  }
  if (
    record.limit !== undefined &&
    (!Number.isSafeInteger(record.limit) ||
      (record.limit as number) < 1 ||
      (record.limit as number) > 50)
  ) {
    throw new Error("Recall limit must be an integer from 1 to 50");
  }
  return {
    query,
    scope: (record.scope as RecallScope | undefined) ?? "all",
    ...(typeof record.id === "string" && record.id ? { id: record.id } : {}),
  };
}

/**
 * Execute the recall tool and return formatted results.
 *
 * Wraps `runRecall()` with error handling — on failure returns a
 * user-friendly error string rather than throwing.
 *
 * `alreadyInLtmIds` is forwarded to `runRecall` to surface a hint when the
 * model's recall hits overlap with entries already in its LTM context (system
 * catalog + knowledge-delta pair). Prevents silent 3-token agent loop exits
 * when a query's hits are entirely redundant.
 */
export async function executeRecall(
  block: GatewayToolUseBlock,
  projectPath: string,
  sessionID: string,
  llm?: LLMClient,
  alreadyInLtmIds?: ReadonlySet<string>,
  signal?: AbortSignal,
  deferTransferRecording?: (record: () => void) => void,
): Promise<{
  result: string;
  input: { query: string; scope?: RecallScope; id?: string };
}> {
  let query = "";
  let scope: RecallScope = "all";
  let id: string | undefined;

  try {
    ({ query, scope, id } = parseRecallInput(block));
    const cfg = loreConfig();
    signal?.throwIfAborted();
    const result = await runRecall({
      query,
      scope,
      id,
      projectPath,
      sessionID,
      knowledgeEnabled: cfg.knowledge?.enabled ?? true,
      llm,
      signal,
      searchConfig: cfg.search,
      // Genuine agent recall — record cross-project transfer metrics (#506).
      recordTransfers: true,
      deferTransferRecording,
      ...(alreadyInLtmIds ? { alreadyInLtmIds } : {}),
    });
    signal?.throwIfAborted();

    return { result, input: { query, scope, id } };
  } catch (e) {
    if (signal?.aborted) throw signal.reason;
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
  | "vertex"
  | "gemini";

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
    signal?: AbortSignal,
  ) => Promise<{ response: Response; effectiveProtocol: RecallProtocol }>;
  /** Parse a non-streaming (JSON) upstream response into a GatewayResponse. */
  parseJSON: (
    response: Response,
    protocol: RecallProtocol,
    signal?: AbortSignal,
  ) => Promise<GatewayResponse>;
  /**
   * Accumulate a streaming (SSE) upstream response into a GatewayResponse.
   * Required only by `runRecallFollowUpStreamAccumulated` (the `openai-codex`
   * path, whose ChatGPT backend mandates streaming).
   */
  parseSSE?: (
    response: Response,
    signal?: AbortSignal,
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
      b.type !== "text" &&
      b.type !== "tool_use" &&
      b.type !== "tool_result" &&
      !(b.type === "opaque" && b.responsesItem),
  );
  const rawPrefixBlocks: GatewayContentBlock[] = (resp.rawOutputItems ?? [])
    .filter(
      (item) =>
        item.type !== "function_call" &&
        item.type !== "function_call_output" &&
        item.type !== "item_reference",
    )
    .map((raw) => ({ type: "opaque", raw, responsesItem: true }));

  const assistantMessage: GatewayMessage = {
    role: "assistant",
    content: [
      ...rawPrefixBlocks,
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
        toolName: recallToolUseBlock.name,
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
async function ensureSSEResponse(
  response: Response,
  signal?: AbortSignal,
): Promise<Response> {
  const ct = response.headers.get("content-type") ?? "";
  if (!response.body) {
    throw new Error("recall follow-up (streaming) response has no body");
  }
  if (ct.includes("text/event-stream")) return response;

  // ChatGPT/Codex sometimes omits Content-Type on valid SSE responses. Sniff a
  // tee of the body, preserving the other branch for the real stream parser.
  const [probe, replay] = response.body.tee();
  const reader = probe.getReader();
  const decoder = new TextDecoder();
  let prefix = "";
  let probedBytes = 0;
  const maxProbeBytes = 4096;
  const maxProbeChunks = 64;
  const probeSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
    : AbortSignal.timeout(10_000);
  let chunks = 0;
  let preserveReplay = false;
  try {
    while (probedBytes < maxProbeBytes && chunks < maxProbeChunks) {
      const { done, value } = await promiseAgainstAbort(
        () => reader.read(),
        probeSignal,
      );
      if (done) break;
      chunks++;
      if (value) {
        const remaining = maxProbeBytes - probedBytes;
        const chunk = value.subarray(0, remaining);
        probedBytes += chunk.byteLength;
        prefix += decoder.decode(chunk, { stream: true });
      }
      let head = prefix.replace(/^\uFEFF/, "").trimStart();
      while (head.startsWith(":")) {
        const newline = head.indexOf("\n");
        if (newline < 0) {
          head = "";
          break;
        }
        head = head.slice(newline + 1).trimStart();
      }
      if (looksLikeSSE(ct, head)) {
        const replayResponse = new Response(replay, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
        preserveReplay = true;
        return replayResponse;
      }
      if (head && !"data:".startsWith(head) && !"event:".startsWith(head)) {
        break;
      }
    }
  } finally {
    cancelAndReleaseReader(reader, probeSignal.reason);
    if (!preserveReplay) {
      try {
        void replay.cancel(probeSignal.reason).catch(() => {});
      } catch {
        // Both tee branches are best-effort and must never delay the caller.
      }
    }
  }
  throw new Error(
    `recall follow-up expected SSE but got "${ct}" and a non-SSE body`,
  );
}

async function readResponseTextLimited(
  response: Response,
  maxBytes = 500,
  signal?: AbortSignal,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let text = "";
  let readBytes = 0;
  try {
    while (readBytes < maxBytes) {
      signal?.throwIfAborted();
      const { done, value } = await promiseAgainstAbort(
        () => reader.read(),
        signal,
      );
      signal?.throwIfAborted();
      if (done) break;
      if (!value) continue;
      const chunk = value.subarray(0, maxBytes - readBytes);
      readBytes += chunk.byteLength;
      text += decoder.decode(chunk, { stream: readBytes < maxBytes });
    }
  } finally {
    cancelAndReleaseReader(reader, signal?.reason);
  }
  return text;
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

async function parseFollowUpAgainstAbort<T>(
  response: Response,
  parse: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const onAbort = (): void => {
    try {
      void response.body?.cancel(signal?.reason).catch(() => {});
    } catch {
      // A parser may already own the body reader; it receives the same signal.
    }
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    return await promiseAgainstAbort(parse, signal);
  } finally {
    signal?.removeEventListener("abort", onAbort);
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
  signal?: AbortSignal,
): Promise<RecallFollowUpStreaming | RecallFollowUpError> {
  const followUp = buildRecallFollowUpRequest(
    originalReq,
    resp,
    recallResult,
    recallToolUseBlock,
    /* stream */ true,
  );
  const { response } = await promiseAgainstAbort(
    () => ctx.forward(followUp, signal),
    signal,
    ({ response: lateResponse }) => {
      try {
        void lateResponse.body?.cancel(signal?.reason).catch(() => {});
      } catch {
        // Late follow-up cleanup is best-effort.
      }
    },
  );
  if (!response.ok) {
    let detail = "";
    try {
      detail = await readResponseTextLimited(response, 500, signal);
    } catch (err) {
      if (signal?.aborted) throw signal.reason;
      log.warn("recall follow-up error body could not be read:", err);
    }
    return { ok: false, status: response.status, detail };
  }
  const sseResponse = await ensureSSEResponse(response, signal);
  const body = sseResponse.body;
  if (!body) {
    throw new Error("recall follow-up (streaming) response has no body");
  }
  return { ok: true, reader: body.getReader(), followUp };
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
  signal?: AbortSignal,
): Promise<RecallFollowUpJSON | RecallFollowUpError> {
  const followUp = buildRecallFollowUpRequest(
    originalReq,
    resp,
    recallResult,
    recallToolUseBlock,
    /* stream */ false,
  );
  const { response, effectiveProtocol } = await promiseAgainstAbort(
    () => ctx.forward(followUp, signal),
    signal,
    ({ response: lateResponse }) => {
      try {
        void lateResponse.body?.cancel(signal?.reason).catch(() => {});
      } catch {
        // Late body may already be locked by the abandoned operation.
      }
    },
  );
  if (!response.ok) {
    let detail = "";
    try {
      detail = await readResponseTextLimited(response, 500, signal);
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      log.warn("recall follow-up error body could not be read:", error);
    }
    return { ok: false, status: response.status, detail };
  }
  assertJSONResponse(response);
  const continuation = await parseFollowUpAgainstAbort(
    response,
    () => ctx.parseJSON(response, effectiveProtocol, signal),
    signal,
  );
  return { ok: true, continuation, followUp };
}

/**
 * Build a `stream: true` follow-up, forward it, accumulate the SSE body into a
 * non-streaming continuation, and return it in the same shape as
 * `runRecallFollowUpJSON`.
 *
 * This is the follow-up path for backends that MANDATE streaming and reject a
 * non-streaming request — specifically Pi's `openai-codex` provider, whose
 * ChatGPT backend (`/backend-api/codex/responses`) returns
 * `400 {"detail":"Stream must be set to true"}` for `stream: false`. The plain
 * `runRecallFollowUpJSON` path (`stream: false`) therefore always 400s on
 * Codex, breaking every recall continuation. Here the follow-up is forced to
 * stream and its SSE body is accumulated (via the injected `ctx.parseSSE`,
 * which the pipeline wires to `accumulateResponsesSSEStream`) back into a
 * non-streaming `GatewayResponse`, so the shared recall loop continues
 * unchanged. The stream flag is coupled to its consumer — the body is asserted
 * to be SSE — so a flag/consumer mismatch fails loud (see assertSSEResponse).
 */
export async function runRecallFollowUpStreamAccumulated(
  ctx: RecallFollowUpCtx,
  originalReq: GatewayRequest,
  resp: GatewayResponse,
  recallResult: string,
  recallToolUseBlock: GatewayToolUseBlock,
  signal?: AbortSignal,
): Promise<RecallFollowUpJSON | RecallFollowUpError> {
  const parseSSE = ctx.parseSSE;
  if (!parseSSE) {
    throw new Error(
      "runRecallFollowUpStreamAccumulated requires ctx.parseSSE to accumulate the streamed continuation",
    );
  }
  const followUp = buildRecallFollowUpRequest(
    originalReq,
    resp,
    recallResult,
    recallToolUseBlock,
    /* stream */ true,
  );
  const { response } = await promiseAgainstAbort(
    () => ctx.forward(followUp, signal),
    signal,
    ({ response: lateResponse }) => {
      try {
        void lateResponse.body?.cancel(signal?.reason).catch(() => {});
      } catch {
        // Late body may already be locked by the abandoned operation.
      }
    },
  );
  if (!response.ok) {
    let detail = "";
    try {
      detail = await readResponseTextLimited(response, 500, signal);
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      log.warn("recall follow-up error body could not be read:", error);
    }
    return { ok: false, status: response.status, detail };
  }
  const sseResponse = await ensureSSEResponse(response, signal);
  const continuation = await parseFollowUpAgainstAbort(
    sseResponse,
    () => parseSSE(sseResponse, signal),
    signal,
  );
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
  markers?: ReadonlyMap<string, string>,
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
          text: markers?.get(b.id) ?? buildRecallMarker(query, scope, id),
        };
      }
      return b;
    }),
  };
}
