// Part-aware splitter for temporal-message embedding text.
//
// A `temporal_messages.content` value is the concatenation of a message's parts
// joined by `"\n" + CHUNK_TERMINATOR` (see `partsToText` in temporal.ts). Each
// part renders as one of:
//   plain text          → "<text>"
//   reasoning part      → "[reasoning] <text>"
//   completed tool call → "[tool:<name>] <output>"
//
// `buildEmbeddingUnits` recovers those parts from the stored content string —
// the part boundaries are already there, so no access to the original parts
// array is needed — and classifies each. Text and reasoning are high-value
// signal and pass through verbatim. Tool envelopes are LOW semantic value and,
// when large, dominate the message: a single read/diff/log can be tens of KB,
// which both blows past the embedding token cap (tail-truncated away) and
// dilutes the mean-pooled vector so it matches no sub-topic well. So a tool unit
// keeps only its `[tool:<name>]` header + the FIRST LINE of output (a path, an
// error, a summary) and drops the body. The full content stays in
// `temporal_messages.content` + FTS, so tool output remains keyword-recallable.
//
// This is the shared "splitter" between Phase 1 (single part-selective vector —
// `buildEmbeddingText` joins the units and embeds once) and a future Phase 2
// (multi-vector chunking — embed each unit into the chunk-keyed `temporal_vec`).
//
// MUST stay a dependency-free leaf: it does NOT import temporal.ts (which would
// create an embedding → embedding-units → temporal → embedding import cycle, as
// temporal.ts imports embedding.ts). The chunk separator is re-declared locally
// and pinned against `partsToText` by a producer/consumer round-trip test.

/** ASCII Unit Separator — mirrors `CHUNK_TERMINATOR` in temporal.ts. Re-declared
 *  here (rather than imported) to keep this module cycle-free; the round-trip
 *  test in `embedding-units.test.ts` fails if the two ever drift apart. */
const CHUNK_TERMINATOR = "\x1f";

/** The boundary `partsToText` inserts between parts: a newline then the
 *  terminator. Splitting content on this recovers the original parts. */
const CHUNK_SEPARATOR = `\n${CHUNK_TERMINATOR}`;

/** Prefix `partsToText` uses for reasoning parts. */
const REASONING_PREFIX = "[reasoning] ";

/**
 * Max characters of a tool output's first line kept in the embedding text.
 * "First line" is normally short (a file path, an error message, a one-line
 * summary), but a single-line megabyte dump (minified JSON, a one-line log)
 * would otherwise re-introduce exactly the head-eviction/dilution we are
 * removing — so the first line is itself bounded. Generous enough to retain a
 * meaningful path or error.
 */
export const TOOL_FIRST_LINE_MAX = 200;

/** Maximum logical vec0 chunks stored for one temporal message. */
export const MAX_TEMPORAL_CHUNKS_PER_MESSAGE = 64;

/** Stored content shorter than this has too little semantic signal to index. */
export const TEMPORAL_EMBEDDING_MIN_CONTENT_LENGTH = 50;

export type EmbedUnitKind = "text" | "reasoning" | "tool";

export interface EmbedUnit {
  kind: EmbedUnitKind;
  /** The text to embed for this unit — already reduced for tool units. */
  text: string;
  /** Tool name; present only when `kind === "tool"`. */
  tool?: string;
}

/**
 * Reduce a single `[tool:<name>] <output>` envelope to its header + the first
 * (bounded) line of output. Returns `null` when `chunk` is not a well-formed
 * tool envelope, so the caller can treat it as plain text. Parsing mirrors
 * `truncateSingleChunk` in distillation.ts (`"[tool:".length === 6`; the
 * `"] "` delimiter separates name from payload) for consistency.
 */
function reduceToolChunk(chunk: string): EmbedUnit | null {
  if (!chunk.startsWith("[tool:")) return null;
  const closeBracket = chunk.indexOf("] ");
  if (closeBracket < 0) return null; // malformed envelope → leave to caller
  const tool = chunk.slice(6, closeBracket);
  const payload = chunk.slice(closeBracket + 2);
  const nl = payload.indexOf("\n");
  let firstLine = (nl >= 0 ? payload.slice(0, nl) : payload).trimEnd();
  if (firstLine.length > TOOL_FIRST_LINE_MAX) {
    firstLine = firstLine.slice(0, TOOL_FIRST_LINE_MAX);
  }
  const text = firstLine ? `[tool:${tool}] ${firstLine}` : `[tool:${tool}]`;
  return { kind: "tool", tool, text };
}

/**
 * Split stored temporal-message `content` into part-aware embedding units.
 *
 * Splits ONLY on the structural `"\n" + CHUNK_TERMINATOR` boundary, never on a
 * bare `[tool:` — so a `[tool:...]`-looking line *inside* a tool output (e.g.
 * the agent reading a file that documents this very format) stays part of its
 * owning envelope and is dropped with the rest of the body, never promoted to
 * its own unit.
 */
export function buildEmbeddingUnits(content: string): EmbedUnit[] {
  const units: EmbedUnit[] = [];
  for (const chunk of content.split(CHUNK_SEPARATOR)) {
    const tool = reduceToolChunk(chunk);
    if (tool) {
      units.push(tool);
      continue;
    }
    if (chunk.startsWith(REASONING_PREFIX)) {
      units.push({ kind: "reasoning", text: chunk });
      continue;
    }
    units.push({ kind: "text", text: chunk });
  }
  return units;
}

/**
 * Phase 1 collapse: join the part-selective units back into one string to embed
 * as a single vector. Tool bodies are already dropped by {@link buildEmbeddingUnits},
 * so prose and reasoning can no longer be evicted from the head by a large tool
 * dump. (Phase 2 will instead embed each unit separately into `temporal_vec`.)
 */
export function buildEmbeddingText(content: string): string {
  return buildEmbeddingUnits(content)
    .map((u) => u.text)
    .join("\n")
    .trim();
}
