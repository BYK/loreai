/**
 * Idle-time contradiction detection (#1123).
 *
 * Finds pairs of stored knowledge entries that genuinely OPPOSE each other and
 * records them so they can be surfaced to the user for resolution (dashboard /
 * CLI). This is the affirmative of the consolidation invariant "opposing rules
 * (e.g. 'always use tabs' vs 'always use spaces') are NEVER duplicates — never
 * merge them" (prompt.ts): consolidation must leave opposing entries alone; this
 * worker is the one that notices them.
 *
 * Detection ONLY — never merges, never deletes. The user picks the survivor (or
 * keeps both) on the dashboard.
 *
 * Pipeline (mirrors pattern-echo's embed -> cluster -> judge shape):
 *   1. Enumerate the project's current knowledge entries (incl. cross-project).
 *   2. Load their embeddings and form candidate pairs by cosine similarity —
 *      opposing rules are TOPICALLY similar ("tabs vs spaces"), so high
 *      similarity is a cheap prefilter.
 *   3. For each not-yet-judged candidate (most-similar first, capped per pass),
 *      ask the worker LLM "do these directly contradict?". Precision over
 *      recall — a false alarm wastes the user's attention.
 *   4. Record contradictions (status 'open', surfaced) and non-contradictions
 *      (status 'cleared', never re-judged) so cost stays bounded.
 */

import { db, ensureProject } from "./db";
import { embeddingByIdSource, readStorageMode } from "./db/vec-store";
import * as embedding from "./embedding";
import * as ltm from "./ltm";
import type { KnowledgeEntry } from "./ltm";
import * as log from "./log";
import { CONTRADICTION_JUDGE_SYSTEM, contradictionJudgeUser } from "./prompt";
import type { LLMClient } from "./types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Minimum cosine similarity for a pair to be a contradiction CANDIDATE.
 * Opposing rules about the same subject embed close together, so this is a
 * permissive topical prefilter — the LLM judge supplies the precision. Kept low
 * enough to catch reworded opposites, high enough to keep the pair count (and
 * therefore judge calls) bounded.
 */
export const CANDIDATE_SIMILARITY = 0.6;

/** Cap the pairwise scan to the top-N entries by confidence (forProject is
 *  ordered confidence DESC) so a huge knowledge set can't make this O(N^2)
 *  scan expensive. */
const MAX_ENTRIES_SCAN = 300;

/** Never consider more than this many candidate pairs in one pass. */
const MAX_PAIRS_CONSIDER = 200;

/** At most this many LLM judge calls per pass. New (unjudged) pairs are judged
 *  most-similar first; the rest are picked up on later idle passes. */
const MAX_JUDGE_CALLS_PER_PASS = 8;

// ---------------------------------------------------------------------------
// Candidate pairing (pure — unit tested directly)
// ---------------------------------------------------------------------------

export interface PairItem {
  /** Current-version knowledge id (embedding key). */
  id: string;
  /** Stable logical id (persistence key). */
  logicalId: string;
  vec: Float32Array;
}

export interface CandidatePair {
  aIdx: number;
  bIdx: number;
  similarity: number;
}

/**
 * All index pairs whose cosine similarity is at least `threshold`, sorted
 * most-similar first. Pure over the embedding math — deterministic.
 */
export function candidatePairs(
  items: PairItem[],
  threshold: number,
): CandidatePair[] {
  const pairs: CandidatePair[] = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const sim = embedding.cosineSimilarity(items[i].vec, items[j].vec);
      if (sim >= threshold) pairs.push({ aIdx: i, bIdx: j, similarity: sim });
    }
  }
  pairs.sort((a, b) => b.similarity - a.similarity);
  return pairs;
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

export interface DetectResult {
  /** Candidate pairs sent to the LLM judge this pass. */
  judged: number;
  /** New contradictions recorded (surfaced) this pass. */
  found: number;
}

/**
 * Run one contradiction-detection pass for a project. Bounded and idempotent:
 * pairs already recorded (in any status) are skipped, so cost is capped and a
 * user-dismissed/resolved pair is never re-surfaced. Errors are the caller's to
 * catch (the idle handler wraps each step in try/catch).
 */
export async function detectContradictions(input: {
  projectPath: string;
  sessionID: string;
  llm: LLMClient;
  model?: { providerID: string; modelID: string };
}): Promise<DetectResult> {
  const entries = ltm.forProject(input.projectPath, true);
  if (entries.length < 2) return { judged: 0, found: 0 };
  const pid = ensureProject(input.projectPath);

  // Cap the pairwise scan (entries are confidence DESC).
  const scan = entries.slice(0, MAX_ENTRIES_SCAN);

  // Load embeddings keyed by current-version id (same helper pattern-echo uses).
  const ids = scan.map((e) => e.id);
  const placeholders = ids.map(() => "?").join(",");
  const src = embeddingByIdSource(
    "knowledge",
    readStorageMode(db()),
    "knowledge_current",
  );
  const rows = db()
    .query(
      `SELECT id, embedding FROM ${src.table} WHERE id IN (${placeholders})${src.presenceFilter}`,
    )
    .all(...ids) as Array<{ id: string; embedding: Buffer }>;
  const vecById = new Map<string, Float32Array>();
  for (const r of rows) {
    try {
      vecById.set(r.id, embedding.fromBlob(r.embedding));
    } catch {
      // A corrupted/truncated embedding blob must not abort the whole pass:
      // detectContradictions throwing here would exit with the cooldown already
      // armed, silently disabling detection for this project for an hour. Skip
      // the bad entry (a later pass re-embeds it) — mirrors the dedup guard.
      log.info(`contradiction: skipping corrupted embedding for entry ${r.id}`);
    }
  }

  const items: PairItem[] = [];
  const byLogical = new Map<string, KnowledgeEntry>();
  for (const e of scan) {
    const vec = vecById.get(e.id);
    if (!vec) continue; // not embedded yet — a later pass will pick it up
    items.push({ id: e.id, logicalId: e.logical_id, vec });
    byLogical.set(e.logical_id, e);
  }
  if (items.length < 2) return { judged: 0, found: 0 };

  const pairs = candidatePairs(items, CANDIDATE_SIMILARITY).slice(
    0,
    MAX_PAIRS_CONSIDER,
  );

  let judged = 0;
  let found = 0;
  for (const pair of pairs) {
    if (judged >= MAX_JUDGE_CALLS_PER_PASS) break;
    const a = items[pair.aIdx];
    const b = items[pair.bIdx];
    // Judge each pair at most once ever — this also guarantees a pair the user
    // already dismissed or resolved is never re-judged and re-surfaced.
    if (ltm.contradictionExists(a.logicalId, b.logicalId)) continue;
    const ea = byLogical.get(a.logicalId);
    const eb = byLogical.get(b.logicalId);
    if (!ea || !eb) continue;

    judged++;
    const responseText = await input.llm.prompt(
      CONTRADICTION_JUDGE_SYSTEM,
      contradictionJudgeUser({
        a: { title: ea.title, content: ea.content },
        b: { title: eb.title, content: eb.content },
      }),
      {
        model: input.model,
        workerID: "lore-contradiction",
        thinking: false,
        sessionID: input.sessionID,
        maxTokens: 256,
        temperature: 0,
      },
    );

    const verdict = parseContradictionVerdict(responseText);
    if (!verdict) continue; // unparseable — leave unrecorded, retry next pass

    if (verdict.contradict) {
      const inserted = ltm.recordContradiction({
        logicalIdA: a.logicalId,
        logicalIdB: b.logicalId,
        projectId: ea.project_id ?? eb.project_id ?? pid,
        similarity: pair.similarity,
        rationale: verdict.reason,
      });
      if (inserted) {
        found++;
        log.info(
          `contradiction: "${ea.title}" <> "${eb.title}" (sim=${pair.similarity.toFixed(3)})`,
        );
      }
    } else {
      ltm.recordContradictionCleared({
        logicalIdA: a.logicalId,
        logicalIdB: b.logicalId,
        projectId: ea.project_id ?? eb.project_id ?? pid,
        similarity: pair.similarity,
      });
    }
  }

  return { judged, found };
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

interface ContradictionVerdict {
  contradict: boolean;
  reason: string | null;
}

export function parseContradictionVerdict(
  text: string | null,
): ContradictionVerdict | null {
  if (!text) return null;
  const cleaned = text
    .trim()
    .replace(/^```json?\s*/i, "")
    .replace(/\s*```$/i, "");
  try {
    const parsed = JSON.parse(cleaned);
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.contradict === "boolean"
    ) {
      const reason =
        typeof parsed.reason === "string" ? parsed.reason.slice(0, 400) : null;
      return { contradict: parsed.contradict, reason };
    }
  } catch {
    // not valid JSON
  }
  return null;
}
