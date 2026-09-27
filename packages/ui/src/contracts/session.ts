import "./config";
import { type } from "arktype";

import { distillationSummary } from "./distillation";
import { epochMs, nonEmptyString, nonNegInt } from "./primitives";

/** `GET /api/v1/projects/:id/sessions` row — core `SessionSummary`. */
export const sessionSummary = type({
  session_id: nonEmptyString,
  message_count: nonNegInt,
  first_message_at: epochMs,
  last_message_at: epochMs,
  distilled_count: nonNegInt,
  undistilled_count: nonNegInt,
  distillation_count: nonNegInt,
});

export type SessionSummary = typeof sessionSummary.infer;

export const sessionList = sessionSummary.array();

/**
 * One `temporal_messages` row as `temporal.bySession` returns it (`SELECT *`
 * — `metadata` is the stored JSON string, not a parsed object).
 */
export const temporalMessage = type({
  id: nonEmptyString,
  "source_id?": "string | null",
  project_id: "string",
  session_id: "string",
  role: "string",
  content: "string",
  tokens: nonNegInt,
  distilled: "number.integer",
  created_at: epochMs,
  metadata: "string",
});

export type TemporalMessage = typeof temporalMessage.infer;

/** `GET /api/v1/sessions/:id?path=…` — `{ messages, distillations }`. */
export const sessionDetail = type({
  messages: temporalMessage.array(),
  distillations: distillationSummary.array(),
});

export type SessionDetail = typeof sessionDetail.infer;

/**
 * `GET /api/v1/sessions/:id?path=…&page=cursor` (or `&cursor=`) — the newest
 * `limit` messages in chronological order, every distillation, the cursor
 * for the next *older* page (null at the session's first message) and the
 * session's total message count at query time.
 */
export const sessionPage = type({
  messages: temporalMessage.array(),
  distillations: distillationSummary.array(),
  next_cursor: "string | null",
  message_count: nonNegInt,
});

export type SessionPage = typeof sessionPage.infer;

/**
 * `GET /api/v1/sessions/:id/search?path=…&q=…` hit — the id of a matching
 * message (the `TemporalMessage.id` the reader keys its blocks by), when it
 * was said, and a plain-text excerpt around the first match.
 */
export const sessionSearchHit = type({
  message_id: nonEmptyString,
  created_at: epochMs,
  role: "string",
  snippet: "string",
  rank: "number",
});

export type SessionSearchHit = typeof sessionSearchHit.infer;

/**
 * One page of in-session finder hits, newest first across pages and
 * chronological within one. `terms` is what the gateway actually matched
 * (unicode61 tokens of `q`; empty when nothing in `q` was searchable);
 * `mode` says whether hits contain the terms as one phrase or merely all of
 * them somewhere; `total` is the matching-message count at query time.
 */
export const sessionSearchPage = type({
  hits: sessionSearchHit.array(),
  terms: "string[]",
  mode: "'phrase' | 'terms'",
  total: nonNegInt,
  next_cursor: "string | null",
});

export type SessionSearchPage = typeof sessionSearchPage.infer;
export type SessionSearchMode = SessionSearchPage["mode"];

/**
 * `GET /api/v1/sessions/:id/context?path=…` (#1924) — the session's real
 * context window as Lore sees it: accepted gradient layer, history volume,
 * the live distilled prefix, injected-knowledge state, reshaped prompt
 * deltas, and per-turn transform stats stamped into assistant message
 * metadata. Nullable fields stay null when the gateway could not derive
 * them (unrecorded layer, absent session_state cache counters, injections
 * whose entry was deleted, deltas with unparseable selectors, turns without
 * usage).
 */
export const sessionContext = type({
  session_id: nonEmptyString,
  layer: "number | null",
  history: { message_count: nonNegInt, token_estimate: "number" },
  distilled_prefix: {
    token_count: "number",
    distillations: type({
      id: nonEmptyString,
      generation: "number.integer",
      token_count: "number",
      created_at: epochMs,
      observations: "string",
    }).array(),
  },
  knowledge: {
    cache_text: "string | null",
    cache_tokens: "number | null",
    pin_tokens: "number | null",
    stable_tokens: "number | null",
    injections: type({
      logical_id: "string",
      title: "string | null",
      category: "string | null",
      confidence: "number | null",
      created_at: epochMs,
      credited: "boolean",
      verdict: "string | null",
    }).array(),
  },
  prompt_deltas: type({
    seq: "number.integer",
    insert_at: "number | null",
    applied_at: "number | null",
    changed: type({ id: "string", title: "string | null" }).array(),
    removed: "string[]",
    text: "string[]",
  }).array(),
  turns: type({
    message_id: nonEmptyString,
    created_at: epochMs,
    layer: "number",
    raw_tokens: "number",
    total_tokens: "number",
    distilled_tokens: "number",
    usage: type({
      input: "number",
      output: "number",
      cache_read: "number",
      cache_write: "number",
    }).or("null"),
  }).array(),
});

export type SessionContext = typeof sessionContext.infer;
export type SessionContextTurn = SessionContext["turns"][number];
export type SessionContextInjection =
  SessionContext["knowledge"]["injections"][number];
export type SessionContextDelta = SessionContext["prompt_deltas"][number];
