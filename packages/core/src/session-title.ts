/**
 * Human-readable session titles (#1921).
 *
 * Pure derivation helpers: given a session's raw inputs (explicit
 * `session_state.title`, the stored `content` of its first user messages,
 * the latest distillation narrative) produce a short display title plus the
 * `title_source` that produced it. Persistence/caching lives in
 * `session-meta.ts`; this module has no DB dependency so it is trivially
 * unit-testable.
 */

export type SessionTitleSource =
  | "explicit"
  | "first_message"
  | "distillation"
  | "id";

/** Maximum visible length of a derived or explicit title (graphemes). */
export const SESSION_TITLE_MAX = 80;

/**
 * Case-folded, whitespace-collapsed form of a title for substring search.
 * Stored as `session_meta.title_norm` and applied to the query text so a
 * search for `ünïcode` matches a `Ünïcode` title (NFKC + toLowerCase on both
 * sides; `instr()` then does a plain substring scan).
 */
export function normalizeTitle(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

const graphemeSegmenter = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});

/**
 * Truncate to `max` code points without ever splitting a grapheme cluster
 * (an emoji, a CJK char, or a base char + combining marks stays whole).
 * When truncated, the result is at most `max - 1` graphemes plus `…` —
 * never more than `max` code points total.
 */
export function truncateTitle(text: string, max = SESSION_TITLE_MAX): string {
  if (Array.from(text).length <= max) return text;
  let out = "";
  let count = 0;
  for (const { segment } of graphemeSegmenter.segment(text)) {
    const next = count + Array.from(segment).length;
    if (next > max - 1) break;
    out += segment;
    count = next;
  }
  return `${out}…`;
}

/**
 * Tag names that wrap injected context rather than user intent (Claude Code
 * emits `<system-reminder>`, `<command-name>`, `<local-command-stdout>`, …).
 * For these the WHOLE block — tags and inner text — is dropped.
 */
const INJECTED_BLOCK_RE =
  /<(system-reminder|command-[\w-]*|local-command-[\w-]*)[^>]*>[\s\S]*?<\/\1\s*>/gi;

/** Any remaining `<…>`/`</…>` marker: dropped, inner text kept. */
const TAG_MARKER_RE = /<\/?[A-Za-z][^>]*>/g;

/** Strip markup noise and collapse whitespace into a single line. */
function cleanTitleText(text: string): string {
  const noBlocks = text.replace(INJECTED_BLOCK_RE, " ");
  const noTags = noBlocks.replace(TAG_MARKER_RE, " ");
  const collapsed = noTags.replace(/\s+/g, " ").trim();
  // Leading markdown structure carries no title signal.
  return collapsed.replace(/^(?:#+\s*|[-*]\s+)+/, "").trim();
}

/**
 * The title candidate inside one stored `temporal_messages.content` value,
 * or null when the message carries no user prose (tool results / reasoning
 * only, or only injected context). Chunks are split on the
 * `"\n" + CHUNK_TERMINATOR` boundary `partsToText` writes; `[tool:…]` and
 * `[reasoning]` chunks are skipped, kept chunks are cleaned and joined.
 */
export function titleFromMessageContent(content: string): string | null {
  const chunks = content.split("\n\x1f");
  const kept: string[] = [];
  for (const chunk of chunks) {
    const lead = chunk.trimStart();
    if (lead.startsWith("[tool:") || lead.startsWith("[reasoning]")) continue;
    const cleaned = cleanTitleText(chunk);
    if (cleaned) kept.push(cleaned);
  }
  return kept.length ? kept.join(" ") : null;
}

/**
 * The title candidate inside a distillation narrative: its first non-empty
 * line, markdown heading/bullet markers stripped, or null when the
 * narrative has no usable text.
 */
export function titleFromNarrative(narrative: string): string | null {
  for (const line of narrative.split("\n")) {
    const cleaned = cleanTitleText(line);
    if (cleaned) return cleaned;
  }
  return null;
}

/**
 * Derive a session title from raw inputs, in priority order:
 * explicit title → first usable user message → latest distillation
 * narrative → the session id itself.
 */
export function deriveSessionTitle(input: {
  sessionId: string;
  explicitTitle: string | null;
  userMessages: string[];
  latestDistillationNarrative: string | null;
}): { title: string; title_source: SessionTitleSource } {
  const explicit = input.explicitTitle?.replace(/\s+/g, " ").trim();
  if (explicit) {
    return { title: truncateTitle(explicit), title_source: "explicit" };
  }
  for (const content of input.userMessages) {
    const candidate = titleFromMessageContent(content);
    if (candidate) {
      return {
        title: truncateTitle(candidate),
        title_source: "first_message",
      };
    }
  }
  if (input.latestDistillationNarrative !== null) {
    const candidate = titleFromNarrative(input.latestDistillationNarrative);
    if (candidate) {
      return {
        title: truncateTitle(candidate),
        title_source: "distillation",
      };
    }
  }
  return { title: input.sessionId, title_source: "id" };
}
