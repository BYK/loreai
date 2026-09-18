/**
 * review-actions.ts — user-review decisions over knowledge/entity suggestions
 * that the automated workers never apply on their own: resolving or dismissing
 * a detected contradiction (#1123) and accepting or rejecting a dedup
 * suggestion with calibration feedback (#462).
 *
 * These used to live inline in the legacy server-rendered dashboard. They are
 * kept here, without any HTTP surface, so the CLI and a future management
 * route can share the same guarded behaviour.
 */
import { entities, ltm } from "@loreai/core";

const REVIEW_SOURCE = "dashboard" as const;

/**
 * Resolve a knowledge id from a possibly stale reference — a current OR
 * superseded version id, or a logical_id — to the current entry (A2, #823).
 */
export function resolveKnowledgeRef(id: string): ltm.KnowledgeEntry | null {
  return ltm.get(id) ?? ltm.getByLogical(ltm.logicalIdOf(id));
}

/**
 * Keep one side of a recorded contradiction and remove the other. Only acts on
 * a real, recorded pair so this can never become a generic "delete any entry"
 * — `contradictionExists` is order-independent. `ltm.remove()` also purges the
 * pair row, so the contradiction leaves the open list either way.
 *
 * Returns true when an entry was removed.
 */
export function resolveContradiction(
  keepId: string,
  removeId: string,
): boolean {
  if (keepId === removeId) return false;
  if (!ltm.contradictionExists(keepId, removeId)) return false;
  if (!resolveKnowledgeRef(removeId)) return false;
  ltm.remove(removeId);
  return true;
}

/**
 * Keep both entries: mark the pair dismissed so it stops surfacing and is never
 * re-judged by the detector.
 */
export function dismissContradiction(idA: string, idB: string): void {
  ltm.setContradictionStatus(idA, idB, "dismissed");
}

export interface DedupDecision {
  /** Cosine similarity from the dedup dry-run; non-finite or <= 0 skips feedback. */
  similarity: number;
  /** Optional title overrides (the dry-run titles as shown to the reviewer). */
  titleA?: string;
  titleB?: string;
}

/**
 * Accept a knowledge dedup suggestion: keep `survivingId`, remove `sourceId`,
 * and record accept feedback scoped to the surviving entry's project (null for
 * global/cross-project entries) — matches dedup calibration.
 *
 * Returns true when the source entry was removed.
 */
export function acceptKnowledgeDuplicate(
  survivingId: string,
  sourceId: string,
  decision: DedupDecision,
): boolean {
  const surviving = resolveKnowledgeRef(survivingId);
  const source = resolveKnowledgeRef(sourceId);
  if (!surviving || !source || surviving.id === source.id) return false;
  ltm.remove(source.id);
  if (Number.isFinite(decision.similarity) && decision.similarity > 0) {
    ltm.recordDedupFeedback({
      projectId: surviving.project_id,
      entryATitle: decision.titleA || source.title,
      entryBTitle: decision.titleB || surviving.title,
      similarity: decision.similarity,
      accepted: true,
      source: REVIEW_SOURCE,
    });
  }
  return true;
}

/**
 * Reject a knowledge dedup suggestion: both entries stay; reject feedback is
 * recorded when titles and similarity are usable. Returns true when feedback
 * was recorded.
 */
export function rejectKnowledgeDuplicate(
  survivingId: string,
  sourceId: string,
  decision: DedupDecision,
): boolean {
  const surviving = resolveKnowledgeRef(survivingId);
  const source = resolveKnowledgeRef(sourceId);
  const titleA = decision.titleA || source?.title || "";
  const titleB = decision.titleB || surviving?.title || "";
  if (!Number.isFinite(decision.similarity) || !titleA || !titleB) return false;
  ltm.recordDedupFeedback({
    projectId: surviving?.project_id ?? null,
    entryATitle: titleA,
    entryBTitle: titleB,
    similarity: decision.similarity,
    accepted: false,
    source: REVIEW_SOURCE,
  });
  return true;
}

const SELF_PERSON = new Set<string>(["self", "person"]);

/**
 * Accept an entity dedup suggestion: keep `targetId`, absorb `sourceId`. Only
 * same-type merges (plus self↔person, since self is conceptually a person) are
 * allowed. Returns true when the merge happened.
 */
export function acceptEntityDuplicate(
  targetId: string,
  sourceId: string,
  decision: DedupDecision,
): boolean {
  const target = entities.get(targetId);
  const source = entities.get(sourceId);
  if (!target || !source || target.id === source.id) return false;
  const typesCompatible =
    target.entity_type === source.entity_type ||
    (SELF_PERSON.has(target.entity_type) &&
      SELF_PERSON.has(source.entity_type));
  if (!typesCompatible) return false;
  const sourceName = source.canonical_name;
  entities.merge(target.id, source.id);
  if (Number.isFinite(decision.similarity)) {
    entities.recordEntityDedupFeedback({
      projectId: null,
      entryATitle: decision.titleA || sourceName,
      entryBTitle: decision.titleB || target.canonical_name,
      similarity: decision.similarity,
      accepted: true,
      source: REVIEW_SOURCE,
    });
  }
  return true;
}

/**
 * Reject an entity dedup suggestion: both entities stay; reject feedback is
 * recorded when both exist and the similarity is finite.
 */
export function rejectEntityDuplicate(
  entityAId: string,
  entityBId: string,
  decision: DedupDecision,
): boolean {
  const entityA = entities.get(entityAId);
  const entityB = entities.get(entityBId);
  if (!Number.isFinite(decision.similarity) || !entityA || !entityB) {
    return false;
  }
  entities.recordEntityDedupFeedback({
    projectId: null,
    entryATitle: entityA.canonical_name,
    entryBTitle: entityB.canonical_name,
    similarity: decision.similarity,
    accepted: false,
    source: REVIEW_SOURCE,
  });
  return true;
}
