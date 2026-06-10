/**
 * Entity re-derivation — rebuild the entity registry from historical
 * distillations.
 *
 * Used to recover people/orgs/services/tools that were lost (e.g. merged away
 * by an over-eager self/person merge) without touching the conversation
 * history, which is intact. Runs an extraction-only LLM pass (no knowledge
 * ops) over a project's distillation observations, recreates the detected
 * entities + relations, then folds genuine self-duplicates into the self
 * entity and runs the normal embedding dedup sweep.
 *
 * This is an offline, host-triggered operation (CLI / REST) — it requires a
 * worker LLM client built from gateway config, since there is no live session.
 */
import * as distillation from "./distillation";
import * as entities from "./entities";
import * as embedding from "./embedding";
import { parseResponse } from "./curator";
import type { DetectedEntity, DetectedRelation } from "./curator";
import { ENTITY_EXTRACT_SYSTEM, entityExtractUser } from "./prompt";
import type { LLMClient } from "./types";
import type { EntityType, RelationType } from "./entities";
import * as log from "./log";

/** ~3 chars/token; cap each batch near 16K input tokens of observations. */
const MAX_BATCH_CHARS = 48_000;

export type EntityRebuildResult = {
  projectPath: string;
  dryRun: boolean;
  scannedDistillations: number;
  batches: number;
  /** Distinct entities detected by the LLM across all batches. */
  detected: number;
  personsCreated: number;
  orgsCreated: number;
  otherCreated: number;
  relationsCreated: number;
  /** Person entities folded into the self entity (genuine self-duplicates). */
  mergedIntoSelf: number;
  /** Near-duplicate entities merged by the embedding dedup sweep. */
  dedupMerged: number;
  /** True if the run was cancelled (via the abort signal) before completing. */
  cancelled?: boolean;
  /** Populated on dry runs: candidate entities the LLM would create. */
  candidates?: Array<{ type: EntityType; name: string }>;
};

/** Group observation strings into batches under MAX_BATCH_CHARS. */
function batchObservations(observations: string[]): string[] {
  const batches: string[] = [];
  let current = "";
  for (const obs of observations) {
    if (!obs) continue;
    // A single oversized observation becomes its own (truncated) batch.
    if (obs.length >= MAX_BATCH_CHARS) {
      if (current) {
        batches.push(current);
        current = "";
      }
      batches.push(
        `${obs.slice(0, MAX_BATCH_CHARS)}\n\n[truncated — content continues]`,
      );
      continue;
    }
    if (current.length + obs.length + 2 > MAX_BATCH_CHARS) {
      batches.push(current);
      current = "";
    }
    current += (current ? "\n\n" : "") + obs;
  }
  if (current) batches.push(current);
  return batches;
}

/** Count person entities globally (self-merge operates across all projects). */
function globalPersonCount(): number {
  return entities.listAll().filter((e) => e.entity_type === "person").length;
}

/**
 * Re-derive entities for a single project from its distillation history.
 *
 * On `dryRun`, performs the LLM extraction and returns the candidate list
 * WITHOUT writing anything. Otherwise creates entities/relations, folds self
 * duplicates, and runs the embedding dedup sweep.
 */
export async function rebuildEntitiesFromHistory(input: {
  llm: LLMClient;
  projectPath: string;
  model?: { providerID: string; modelID: string };
  dryRun?: boolean;
  sessionID?: string;
  /** Abort signal — checked between batches to stop early on cancellation. */
  signal?: AbortSignal;
}): Promise<EntityRebuildResult> {
  const { llm, projectPath } = input;
  const dryRun = input.dryRun ?? false;

  const result: EntityRebuildResult = {
    projectPath,
    dryRun,
    scannedDistillations: 0,
    batches: 0,
    detected: 0,
    personsCreated: 0,
    orgsCreated: 0,
    otherCreated: 0,
    relationsCreated: 0,
    mergedIntoSelf: 0,
    dedupMerged: 0,
  };

  const dists = distillation.loadForProject(projectPath, true);
  result.scannedDistillations = dists.length;
  if (dists.length === 0) return result;

  // Provide known entities so the LLM reuses canonical names (fewer dupes).
  let entityContext = "";
  try {
    const known = entities.forProject(projectPath);
    if (known.length > 0) entityContext = entities.formatForPrompt(known);
  } catch (err) {
    log.warn("entity-rebuild: known-entity context failed (non-fatal):", err);
  }

  const batches = batchObservations(dists.map((d) => d.observations));
  result.batches = batches.length;

  const detectedEntities: DetectedEntity[] = [];
  const detectedRelations: DetectedRelation[] = [];
  for (const batch of batches) {
    // Cancellation: stop before issuing the next (costly) LLM call.
    if (input.signal?.aborted) {
      result.cancelled = true;
      return result;
    }
    const user = entityExtractUser({ observations: batch, entityContext });
    let text: string | null = null;
    try {
      text = await llm.prompt(ENTITY_EXTRACT_SYSTEM, user, {
        model: input.model,
        workerID: "lore-entity-rebuild",
        sessionID: input.sessionID,
        thinking: false,
        urgent: true,
        maxTokens: 2048,
        temperature: 0,
      });
    } catch (err) {
      log.warn("entity-rebuild: extraction call failed (skipping batch):", err);
      continue;
    }
    if (!text) continue;
    const parsed = parseResponse(text);
    detectedEntities.push(...parsed.entities);
    detectedRelations.push(...parsed.relations);
  }
  result.detected = detectedEntities.length;

  // Cancellation that arrived during the last batch's LLM call lands here (the
  // loop-top check only catches it before subsequent batches). Bail before any
  // writes so a cancel is always a clean no-op for this project.
  if (input.signal?.aborted) {
    result.cancelled = true;
    return result;
  }

  if (dryRun) {
    // Dedupe candidate names for a cleaner preview.
    const seen = new Set<string>();
    result.candidates = [];
    for (const de of detectedEntities) {
      const key = `${de.type}\x1f${de.canonical_name.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.candidates.push({ type: de.type, name: de.canonical_name });
    }
    return result;
  }

  // Create detected entities (create() dedups + merges metadata).
  for (const de of detectedEntities) {
    try {
      const r = entities.create({
        projectPath,
        entityType: de.type,
        canonicalName: de.canonical_name,
        aliases: de.aliases?.map((a) => ({
          type: a.type,
          value: a.value,
          source: "rebuild",
        })),
        metadata: de.metadata,
      });
      if (r.created) {
        if (de.type === "person") result.personsCreated++;
        else if (de.type === "org") result.orgsCreated++;
        else result.otherCreated++;
      }
    } catch (err) {
      log.warn(
        `entity-rebuild: create failed for "${de.canonical_name}":`,
        err,
      );
    }
  }

  // Create detected relations (resolve endpoints by canonical name / [uuid]).
  for (const dr of detectedRelations) {
    try {
      const aId = resolveRef(dr.entity_a);
      const bId = resolveRef(dr.entity_b);
      if (aId && bId && aId !== bId) {
        const relId = entities.addRelation(
          aId,
          bId,
          dr.relation as RelationType,
          { metadata: dr.metadata, source: "rebuild" },
        );
        if (relId) result.relationsCreated++;
      }
    } catch (err) {
      log.warn("entity-rebuild: relation create failed (non-fatal):", err);
    }
  }

  // Fold genuine self-duplicates into the self entity. ensureSelfEntity()
  // internally runs the (now identity-restricted) mergeSelfPersonDuplicates,
  // so real colleagues survive. Attribute the delta in person count.
  const personsBefore = globalPersonCount();
  try {
    entities.ensureSelfEntity(projectPath);
  } catch (err) {
    log.warn("entity-rebuild: ensureSelfEntity failed (non-fatal):", err);
  }
  result.mergedIntoSelf = Math.max(0, personsBefore - globalPersonCount());

  // Embedding dedup sweep to merge near-duplicate entities the pass introduced.
  if (embedding.isAvailable()) {
    try {
      const dupes = await entities.deduplicateEntities(projectPath, {
        dryRun: false,
      });
      result.dedupMerged = dupes.merged.reduce(
        (n, c) => n + c.merged.length,
        0,
      );
    } catch (err) {
      log.warn("entity-rebuild: dedup sweep failed (non-fatal):", err);
    }
  }

  log.info(
    `entity-rebuild [${projectPath}]: ${result.personsCreated} persons, ${result.orgsCreated} orgs, ${result.otherCreated} other created; ${result.relationsCreated} relations; ${result.mergedIntoSelf} folded into self; ${result.dedupMerged} deduped`,
  );

  return result;
}

/** Resolve a relation endpoint reference to an entity ID. */
function resolveRef(ref: string): string | null {
  const uuidMatch = ref.match(/^\[([^\]]+)\]$/);
  if (uuidMatch) return entities.get(uuidMatch[1])?.id ?? null;
  return entities.resolve(ref)?.id ?? null;
}
