/**
 * Read-only assembly of a session's "real context window" for the management
 * API (#1924): the gradient layer the session last settled on, the temporal
 * history volume, the live distilled prefix, the injected-knowledge state and
 * durable prompt deltas, plus the per-turn transform stats the gateway stamps
 * into assistant message metadata.
 *
 * Everything here is a scoped read — the caller (gateway route) has already
 * resolved the project; `sessionContext` returns `null` only when the session
 * is entirely unknown to that project (no temporal rows, no session_state,
 * no prompt deltas, no injections), so a caller that never proxied through
 * Lore still gets a shape, not a 404-shaped guess.
 */
import {
  db,
  ensureProject,
  listSessionPromptDeltas,
  loadSessionTracking,
} from "./db";
import { sql } from "./sql";
import { loadForSession } from "./distillation";

export type SessionContextTurn = {
  message_id: string;
  created_at: number;
  layer: number;
  raw_tokens: number;
  total_tokens: number;
  distilled_tokens: number;
  usage: {
    input: number;
    output: number;
    cache_read: number;
    cache_write: number;
  } | null;
};

export type SessionContext = {
  session_id: string;
  /** Last accepted gradient layer; null when never recorded
   *  (`session_state.last_accepted_provenance_layer = -1` or no row). */
  layer: number | null;
  history: { message_count: number; token_estimate: number };
  distilled_prefix: {
    token_count: number;
    distillations: Array<{
      id: string;
      generation: number;
      token_count: number;
      created_at: number;
      observations: string;
    }>;
  };
  knowledge: {
    cache_text: string | null;
    cache_tokens: number | null;
    pin_tokens: number | null;
    stable_tokens: number | null;
    injections: Array<{
      logical_id: string;
      title: string | null;
      category: string | null;
      confidence: number | null;
      created_at: number;
      credited: boolean;
      verdict: string | null;
    }>;
  };
  /** Raw persisted deltas; the gateway reshapes selectors/content. */
  prompt_deltas: Array<{ seq: number; selector: string; content: string }>;
  /** Assistant turns that carry gradient metadata (per-turn transform stats). */
  turns: SessionContextTurn[];
};

/** Rows under SQLite's 999-variable ceiling, same budget as temporal lookups. */
const MAX_BIND_PARAMS = 900;

/**
 * Titles for a set of knowledge ids matched on EITHER the stable `logical_id`
 * or a version `id` (delta `mut.changed` carries whichever the writer had).
 * The result maps every matched column value to its title so a caller can
 * look up by the id form it holds. Unknown ids are simply absent.
 */
export function knowledgeTitlesFor(ids: string[]): Map<string, string> {
  const unique = [...new Set(ids)];
  const out = new Map<string, string>();
  for (let i = 0; i < unique.length; i += MAX_BIND_PARAMS) {
    const chunk = unique.slice(i, i + MAX_BIND_PARAMS);
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = db()
      .query(
        `SELECT logical_id, id, title FROM knowledge_current
           WHERE logical_id IN (${placeholders}) OR id IN (${placeholders})`,
      )
      .all(...chunk, ...chunk) as Array<{
      logical_id: string;
      id: string;
      title: string;
    }>;
    for (const row of rows) {
      out.set(row.logical_id, row.title);
      out.set(row.id, row.title);
    }
  }
  return out;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function numericField(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Assemble the session's context-window state for `projectPath`. Returns null
 * only when the session is entirely unknown to this project.
 */
export function sessionContext(
  projectPath: string,
  sessionID: string,
): SessionContext | null {
  const pid = ensureProject(projectPath);

  const history = sql.get<{ message_count: number; token_estimate: number }>(
    db(),
    sql`SELECT COUNT(*) AS message_count, COALESCE(SUM(tokens), 0) AS token_estimate
          FROM temporal_messages
         WHERE project_id = ${pid} AND session_id = ${sessionID}`,
  ) ?? { message_count: 0, token_estimate: 0 };

  const tracking = loadSessionTracking(sessionID);
  const layer =
    tracking && tracking.lastAcceptedProvenanceLayer >= 0
      ? tracking.lastAcceptedProvenanceLayer
      : null;

  const distillations = loadForSession(projectPath, sessionID).map((d) => ({
    id: d.id,
    generation: d.generation,
    token_count: d.token_count,
    created_at: d.created_at,
    observations: d.observations,
  }));
  const distilledPrefix = {
    token_count: distillations.reduce((sum, d) => sum + d.token_count, 0),
    distillations,
  };

  const injections = sql
    .all<{
      logical_id: string;
      title: string | null;
      category: string | null;
      confidence: number | null;
      created_at: number;
      credited: number;
      verdict: string | null;
    }>(
      db(),
      sql`SELECT i.logical_id, k.title, k.category, k.confidence,
               i.created_at, i.credited, i.verdict
          FROM knowledge_session_injections i
          LEFT JOIN knowledge_current k ON k.logical_id = i.logical_id
         WHERE i.session_id = ${sessionID} AND i.project_id = ${pid}
         ORDER BY i.created_at, i.logical_id`,
    )
    .map((row) => ({
      logical_id: row.logical_id,
      title: row.title,
      category: row.category,
      confidence: row.confidence,
      created_at: row.created_at,
      credited: row.credited === 1,
      verdict: row.verdict,
    }));

  const promptDeltas = listSessionPromptDeltas(sessionID)
    .filter((d) => d.projectID === pid)
    .map((d) => ({ seq: d.seq, selector: d.selector, content: d.content }));

  const turnRows = sql.all<{
    id: string;
    created_at: number;
    metadata: string | null;
  }>(
    db(),
    sql`SELECT id, created_at, metadata FROM temporal_messages
         WHERE project_id = ${pid} AND session_id = ${sessionID}
           AND role = 'assistant'
         ORDER BY created_at, id`,
  );
  const turns: SessionContextTurn[] = [];
  for (const row of turnRows) {
    if (!row.metadata) continue;
    let meta: unknown;
    try {
      meta = JSON.parse(row.metadata);
    } catch {
      continue; // malformed metadata JSON is skipped silently
    }
    if (!isRecord(meta) || !isRecord(meta.gradient)) continue;
    const g = meta.gradient;
    const layer_ = numericField(g.layer);
    const raw = numericField(g.raw_tokens);
    const total = numericField(g.total_tokens);
    const distilled = numericField(g.distilled_tokens);
    if (layer_ === null || raw === null || total === null || distilled === null)
      continue;
    let usage: SessionContextTurn["usage"] = null;
    if (isRecord(meta.usage)) {
      const u = meta.usage;
      const input = numericField(u.input);
      const output = numericField(u.output);
      const cacheRead = numericField(u.cache_read);
      const cacheWrite = numericField(u.cache_write);
      if (
        input !== null &&
        output !== null &&
        cacheRead !== null &&
        cacheWrite !== null
      ) {
        usage = {
          input,
          output,
          cache_read: cacheRead,
          cache_write: cacheWrite,
        };
      }
    }
    turns.push({
      message_id: row.id,
      created_at: row.created_at,
      layer: layer_,
      raw_tokens: raw,
      total_tokens: total,
      distilled_tokens: distilled,
      usage,
    });
  }

  if (
    history.message_count === 0 &&
    !tracking &&
    promptDeltas.length === 0 &&
    injections.length === 0 &&
    distillations.length === 0
  ) {
    return null;
  }

  return {
    session_id: sessionID,
    layer,
    history,
    distilled_prefix: distilledPrefix,
    knowledge: {
      cache_text: tracking?.ltmCacheText ?? null,
      cache_tokens: tracking?.ltmCacheTokens ?? null,
      pin_tokens: tracking?.ltmPinTokens ?? null,
      stable_tokens: tracking?.stableLtmTokens ?? null,
      injections,
    },
    prompt_deltas: promptDeltas,
    turns,
  };
}
