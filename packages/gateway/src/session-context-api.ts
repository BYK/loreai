/**
 * `GET /api/v1/sessions/:id/context` (#1924): the session's real context
 * window as Lore sees it — accepted gradient layer, history volume, live
 * distilled prefix, injected-knowledge state, reshaped prompt deltas, and the
 * per-turn transform stats the proxy stamps into assistant message metadata.
 *
 * Read-only and additive: the legacy `GET /sessions/:id` shape is untouched.
 * The project is resolved by the dispatcher exactly like `GET /sessions/:id`
 * (`?git_remote=` / `?path=`); a session entirely unknown to the project is a
 * 404 `not_found`.
 *
 * Response shape:

 *     { session_id, layer: number|null,
 *       history: { message_count, token_estimate },
 *       distilled_prefix: { token_count,
 *         distillations: [{ id, generation, token_count, created_at,
 *                           observations }] },
 *       knowledge: { cache_text, cache_tokens, pin_tokens, stable_tokens,
 *         injections: [{ logical_id, title, category, confidence,
 *                        created_at, credited, verdict }] },
 *       prompt_deltas: [{ seq, insert_at, applied_at,
 *                         changed: [{ id, title }], removed: [id...],
 *                         text: [string...] }],
 *       turns: [{ message_id, created_at, layer, raw_tokens, total_tokens,
 *                 distilled_tokens,
 *                 usage: { input, output, cache_read, cache_write } | null }] }
 *
 * Prompt-delta reshape: the persisted `selector` JSON carries the block's
 * `insertAt`, its `mut` signature (`changed` ids + `removed` ids) and the
 * `debounceAt` watermark; `applied_at` is derived as `debounceAt -
 * KNOWLEDGE_DELTA_DEBOUNCE_MS`. `changed` ids are resolved to titles via
 * `knowledge_current` (null when the entry no longer exists). The persisted
 * `content` is a `GatewayMessage[]`; `text` collects every text block's text
 * in order. Any malformed JSON degrades to nulls/empties — never a 500.
 */
import { knowledgeTitlesFor, sessionContext } from "@loreai/core";
import { KNOWLEDGE_DELTA_DEBOUNCE_MS } from "./prompt-delta-constants";

// ---------------------------------------------------------------------------
// Response helpers (mirrors api-lists.ts; kept local so this module has no cycle)
// ---------------------------------------------------------------------------

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function errorResponse(
  status: number,
  type: string,
  message: string,
): Response {
  return jsonResponse({ type: "error", error: { type, message } }, status);
}

// ---------------------------------------------------------------------------
// Prompt-delta reshape
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** ids surfaced by the block's `mut.changed` signature, in order. */
function selectorChangedIds(selector: unknown): string[] {
  if (!isRecord(selector) || !isRecord(selector.mut)) return [];
  const changed = selector.mut.changed;
  if (!Array.isArray(changed)) return [];
  return changed
    .map((c) => (isRecord(c) && typeof c.id === "string" ? c.id : null))
    .filter((id): id is string => id !== null);
}

function selectorRemovedIds(selector: unknown): string[] {
  if (!isRecord(selector) || !isRecord(selector.mut)) return [];
  const removed = selector.mut.removed;
  if (!Array.isArray(removed)) return [];
  return removed.filter((x): x is string => typeof x === "string");
}

/**
 * `insert_at` / `applied_at` derived from the block's selector JSON. Both are
 * null when the selector doesn't parse or the field isn't a finite number.
 */
function selectorPlacement(selector: unknown): {
  insert_at: number | null;
  applied_at: number | null;
} {
  const insertAt =
    isRecord(selector) &&
    typeof selector.insertAt === "number" &&
    Number.isFinite(selector.insertAt)
      ? selector.insertAt
      : null;
  const debounceAt =
    isRecord(selector) &&
    typeof selector.debounceAt === "number" &&
    Number.isFinite(selector.debounceAt)
      ? selector.debounceAt
      : null;
  return {
    insert_at: insertAt,
    applied_at:
      debounceAt !== null ? debounceAt - KNOWLEDGE_DELTA_DEBOUNCE_MS : null,
  };
}

/** Every text block's `text` from the persisted GatewayMessage[] content. */
function deltaTexts(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const texts: string[] = [];
  for (const message of content) {
    if (!isRecord(message) || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (
        isRecord(block) &&
        block.type === "text" &&
        typeof block.text === "string"
      )
        texts.push(block.text);
    }
  }
  return texts;
}

/**
 * `GET /api/v1/sessions/:id/context` handler. `project` is pre-resolved by the
 * dispatcher; a session unknown to the project is a 404 `not_found`.
 */
export function handleSessionContext(
  _url: URL,
  project: { id: string; path: string },
  sessionId: string,
): Response {
  const context = sessionContext(project.path, sessionId);
  if (!context) {
    return errorResponse(404, "not_found", `Session not found: ${sessionId}`);
  }

  const changedIds = [
    ...new Set(
      context.prompt_deltas.flatMap((d) =>
        selectorChangedIds(parseJson(d.selector)),
      ),
    ),
  ];
  const titles = knowledgeTitlesFor(changedIds);

  const prompt_deltas = context.prompt_deltas.map((delta) => {
    const selector = parseJson(delta.selector);
    const placement = selectorPlacement(selector);
    return {
      seq: delta.seq,
      insert_at: placement.insert_at,
      applied_at: placement.applied_at,
      changed: selectorChangedIds(selector).map((id) => ({
        id,
        title: titles.get(id) ?? null,
      })),
      removed: selectorRemovedIds(selector),
      text: deltaTexts(parseJson(delta.content)),
    };
  });

  return jsonResponse({ ...context, prompt_deltas });
}
