/**
 * Session block model (UI-06a): the document-first projection of
 * `GET /api/v1/sessions/:id` that the reader, source anchors, search and the
 * later annotation (APP-02) and agent (ACP-04) surfaces all address.
 *
 * Identity
 * --------
 * A block id is derived from server data only — never from an array index —
 * so it is identical across reloads, pages and clients:
 *
 *   message block        `m.<temporal_messages.id>`
 *   distillation block   `d.<distillations.id>`
 *
 * Message *parts* are the chunks `temporal.partsToText` joined with
 * `"\n" + CHUNK_TERMINATOR` (`\x1f`): plain text, `[reasoning] …` and
 * `[tool:<name>] …` envelopes. A part is addressed by its position in that
 * chunk list (`partIndex`), which is stable because the stored content is
 * immutable for a given message id; if the content changes, the part's
 * `hash` changes and every anchor into it reports "source changed".
 *
 * Nothing here manufactures data: a message without a usable `created_at`
 * has `createdAt: null` ("time unknown"), unknown roles stay unknown, and
 * distillations are kept as separate *compressed context* blocks rather than
 * being interleaved as speech.
 */
import type {
  DistillationSummary,
  SessionDetail,
  TemporalMessage,
} from "~/contracts";
import { contentHash } from "~/lib/hash";

/** Mirrors `@loreai/core` `CHUNK_TERMINATOR` (ASCII Unit Separator). */
export const CHUNK_TERMINATOR = "\x1f";
export const CHUNK_SEPARATOR = `\n${CHUNK_TERMINATOR}`;

const REASONING_PREFIX = "[reasoning] ";
const TOOL_ENVELOPE = /^\[tool:([^\]\s]{1,200})\] ?/;

export type PartKind = "text" | "reasoning" | "tool";

export interface BlockPart {
  /** Position in the message's chunk list — the anchor's `partIndex`. */
  index: number;
  kind: PartKind;
  /** Payload without the `[tool:…] ` / `[reasoning] ` envelope. */
  text: string;
  /** Tool name for `tool` parts, else null. */
  tool: string | null;
  /** Revision check for anchors: {@link contentHash} of `text`. */
  hash: string;
}

/**
 * Who produced a block. Derived from the stored role and metadata; `unknown`
 * is shown as the raw role rather than guessed. `lore` marks content Lore
 * itself injected (synthetic prefix, recalled context); `system` is a stored
 * system prompt. Neither is captured by today's gateway (#1508) — the reader
 * labels them when present and says so when absent.
 */
export type BlockOrigin = "user" | "agent" | "lore" | "system" | "unknown";

export interface MessageMeta {
  agent: string | null;
  modelId: string | null;
  providerId: string | null;
  mode: string | null;
  tools: readonly string[];
  /** Metadata flagged the message as Lore-synthetic. */
  synthetic: boolean;
}

export interface MessageBlock {
  kind: "message";
  id: string;
  /** Server storage key (`temporal_messages.id`). */
  messageId: string;
  /** Caller-supplied id (harness message id), when the server kept one. */
  sourceId: string | null;
  role: string;
  origin: BlockOrigin;
  /** Epoch ms, or null when unknown — never synthesised. */
  createdAt: number | null;
  distilled: boolean;
  tokens: number;
  meta: MessageMeta;
  parts: readonly BlockPart[];
}

export interface DistillationBlock {
  kind: "distillation";
  id: string;
  distillationId: string;
  summary: DistillationSummary;
  createdAt: number | null;
}

export type ReaderBlock = MessageBlock | DistillationBlock;

export function messageBlockId(messageId: string): string {
  return `m.${messageId}`;
}

export function distillationBlockId(distillationId: string): string {
  return `d.${distillationId}`;
}

/** Epoch ms when plausible; `0`/negative/non-finite are "unknown". */
function knownTime(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

/** Split stored content into parts. Empty content is one empty text part. */
export function parseParts(content: string): BlockPart[] {
  const chunks = content.split(CHUNK_SEPARATOR);
  return chunks.map((chunk, index) => {
    if (chunk.startsWith(REASONING_PREFIX)) {
      const text = chunk.slice(REASONING_PREFIX.length);
      return {
        index,
        kind: "reasoning",
        text,
        tool: null,
        hash: contentHash(text),
      };
    }
    const tool = TOOL_ENVELOPE.exec(chunk);
    if (tool) {
      const text = chunk.slice(tool[0].length);
      return {
        index,
        kind: "tool",
        text,
        tool: tool[1] ?? null,
        hash: contentHash(text),
      };
    }
    return {
      index,
      kind: "text",
      text: chunk,
      tool: null,
      hash: contentHash(chunk),
    };
  });
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

/** Defensive read of the stored metadata JSON; malformed input → empty meta. */
export function parseMeta(metadata: string | null | undefined): MessageMeta {
  const empty: MessageMeta = {
    agent: null,
    modelId: null,
    providerId: null,
    mode: null,
    tools: [],
    synthetic: false,
  };
  if (!metadata) return empty;
  let parsed: unknown;
  try {
    parsed = JSON.parse(metadata);
  } catch {
    return empty;
  }
  if (!isRecord(parsed)) return empty;
  // User rows store `model: { providerID, modelID }`; assistant rows store
  // `modelID` / `providerID` at the top level.
  const model = isRecord(parsed.model) ? parsed.model : undefined;
  const tools = Array.isArray(parsed.tools)
    ? parsed.tools.filter((t): t is string => typeof t === "string")
    : [];
  return {
    agent: str(parsed.agent),
    modelId: str(parsed.modelID) ?? str(model?.modelID),
    providerId: str(parsed.providerID) ?? str(model?.providerID),
    mode: str(parsed.mode),
    tools,
    synthetic: parsed.synthetic === true || parsed.lore === true,
  };
}

export function originOf(role: string, meta: MessageMeta): BlockOrigin {
  if (meta.synthetic || meta.agent === "lore") return "lore";
  switch (role) {
    case "user":
      return "user";
    case "assistant":
      return "agent";
    case "system":
      return "system";
    case "lore":
      return "lore";
    default:
      return "unknown";
  }
}

/**
 * Blocks are derived once per message *object*: pages and streamed updates
 * replace only the messages that changed, so a rebuild over thousands of
 * messages costs one map lookup each instead of re-parsing and re-hashing
 * every part.
 */
const blockCache = new WeakMap<TemporalMessage, MessageBlock>();

export function messageBlock(message: TemporalMessage): MessageBlock {
  const cached = blockCache.get(message);
  if (cached) return cached;
  const block = uncachedMessageBlock(message);
  blockCache.set(message, block);
  return block;
}

function uncachedMessageBlock(message: TemporalMessage): MessageBlock {
  const meta = parseMeta(message.metadata);
  return {
    kind: "message",
    id: messageBlockId(message.id),
    messageId: message.id,
    sourceId: message.source_id ?? null,
    role: message.role,
    origin: originOf(message.role, meta),
    createdAt: knownTime(message.created_at),
    distilled: message.distilled === 1,
    tokens: message.tokens,
    meta,
    parts: parseParts(message.content),
  };
}

export function distillationBlock(
  summary: DistillationSummary,
): DistillationBlock {
  return {
    kind: "distillation",
    id: distillationBlockId(summary.id),
    distillationId: summary.id,
    summary,
    createdAt: knownTime(summary.created_at),
  };
}

export interface SessionBlocks {
  /** Message blocks in server (chronological) order, deduplicated by id. */
  messages: MessageBlock[];
  /** Compressed context, oldest generation first, deduplicated by id. */
  distillations: DistillationBlock[];
  byId: Map<string, ReaderBlock>;
}

/**
 * Project a session detail response into blocks. Duplicate ids (a message
 * that arrived on two pages) keep the first occurrence; order is the
 * server's, which is `created_at ASC` with the message id as tiebreaker.
 */
export function buildBlocks(detail: SessionDetail): SessionBlocks {
  const byId = new Map<string, ReaderBlock>();
  const messages: MessageBlock[] = [];
  for (const m of detail.messages) {
    const block = messageBlock(m);
    if (byId.has(block.id)) continue;
    byId.set(block.id, block);
    messages.push(block);
  }
  const distillations: DistillationBlock[] = [];
  for (const d of detail.distillations) {
    const block = distillationBlock(d);
    if (byId.has(block.id)) continue;
    byId.set(block.id, block);
    distillations.push(block);
  }
  distillations.sort(
    (a, b) =>
      a.summary.generation - b.summary.generation ||
      (a.createdAt ?? 0) - (b.createdAt ?? 0) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  return { messages, distillations, byId };
}

/** Human label for a block's author line. */
export function originLabel(block: MessageBlock): string {
  switch (block.origin) {
    case "user":
      return "User";
    case "agent":
      return "Agent";
    case "lore":
      return "Lore";
    case "system":
      return "System prompt";
    default:
      return block.role || "Unknown role";
  }
}
