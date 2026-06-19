import { config } from "./config";
import {
  db,
  saveSessionTracking,
  loadSessionTracking,
  ensureProject,
} from "./db";
import * as temporal from "./temporal";
import * as distillation from "./distillation";
import * as ltm from "./ltm";
import * as entities from "./entities";
import * as embedding from "./embedding";
import * as log from "./log";
import {
  CURATOR_SYSTEM,
  curatorUser,
  CONSOLIDATION_SYSTEM,
  CONSOLIDATION_MERGE_SYSTEM,
  consolidationUser,
} from "./prompt";
import * as toolTrace from "./tool-trace";
import { tagToTitle } from "./pattern-extract";
import { detectAndFormat } from "./instruction-detect";
import { curatorLimiter } from "./session-limiter";
import type { LLMClient } from "./types";
import type { EntityType, AliasType, RelationType } from "./entities";

/**
 * Maximum length (chars) for a single knowledge entry's content.
 * ~400 tokens at chars/3. Entries exceeding this are truncated with a notice.
 * The curator prompt also instructs the model to stay within this limit,
 * so truncation is a last-resort safety net.
 */
export const MAX_ENTRY_CONTENT_LENGTH = 1200;

/** Entity detected by the curator from conversation context. */
export type DetectedEntity = {
  type: EntityType;
  canonical_name: string;
  aliases?: Array<{ type: AliasType; value: string }>;
  metadata?: Record<string, unknown>;
};

/** Relationship detected by the curator from conversation context. */
export type DetectedRelation = {
  entity_a: string; // canonical name or [uuid]
  entity_b: string;
  relation: string;
  metadata?: Record<string, unknown>;
};

/** Parsed curator response containing knowledge ops, entities, and relations. */
export type CuratorResponse = {
  ops: CuratorOp[];
  entities: DetectedEntity[];
  relations: DetectedRelation[];
};

export type CuratorOp =
  | {
      op: "create";
      category: string;
      title: string;
      content: string;
      scope: "project" | "global";
      crossProject?: boolean;
      /** Initial confidence (0.0–1.0). Controls injection priority for preferences. */
      confidence?: number;
    }
  | { op: "update"; id: string; content?: string; confidence?: number }
  | { op: "delete"; id: string; reason: string };

/**
 * Parse the LLM's JSON response into typed curator ops.
 * Handles markdown fences and filters invalid entries.
 *
 * Supports two response shapes:
 * 1. Legacy: plain JSON array of ops → `[{ op: "create", ... }]`
 * 2. New:    `{ ops: [...], entities: [...] }` with optional entity detections
 */
export function parseOps(text: string): CuratorOp[] {
  return parseResponse(text).ops;
}

/**
 * Parse the full curator response including both ops and detected entities.
 */
export function parseResponse(text: string): CuratorResponse {
  const cleaned = text
    .trim()
    .replace(/^```json?\s*/i, "")
    .replace(/\s*```$/i, "");
  try {
    const parsed = JSON.parse(cleaned);

    // Legacy format: plain array of ops
    if (Array.isArray(parsed)) {
      return {
        ops: filterOps(parsed),
        entities: [],
        relations: [],
      };
    }

    // New format: { ops: [...], entities: [...], relations: [...] }
    if (typeof parsed === "object" && parsed !== null) {
      const ops = Array.isArray(parsed.ops) ? filterOps(parsed.ops) : [];
      const detectedEntities = Array.isArray(parsed.entities)
        ? filterEntities(parsed.entities)
        : [];
      const detectedRelations = Array.isArray(parsed.relations)
        ? filterRelations(parsed.relations)
        : [];
      return { ops, entities: detectedEntities, relations: detectedRelations };
    }

    return { ops: [], entities: [], relations: [] };
  } catch {
    return { ops: [], entities: [], relations: [] };
  }
}

function filterOps(arr: unknown[]): CuratorOp[] {
  return arr.filter((op: unknown) => {
    if (typeof op !== "object" || op === null || !("op" in op)) return false;
    const o = op as Record<string, unknown>;
    if (typeof o.op !== "string") return false;
    // Validate required fields per op type to prevent runtime crashes
    // from malformed LLM output (e.g. missing content on create ops).
    if (o.op === "create") {
      return (
        typeof o.category === "string" &&
        typeof o.title === "string" &&
        typeof o.content === "string" &&
        (o.scope === "project" || o.scope === "global")
      );
    }
    if (o.op === "update") {
      return typeof o.id === "string";
    }
    if (o.op === "delete") {
      return typeof o.id === "string";
    }
    return false;
  }) as CuratorOp[];
}

function filterEntities(arr: unknown[]): DetectedEntity[] {
  return arr
    .filter((e: unknown): e is Record<string, unknown> => {
      if (typeof e !== "object" || e === null) return false;
      const obj = e as Record<string, unknown>;
      return (
        typeof obj.type === "string" &&
        typeof obj.canonical_name === "string" &&
        obj.canonical_name.length > 0 &&
        entities.ENTITY_TYPES.includes(obj.type as EntityType)
      );
    })
    .map((obj) => {
      // Validate alias objects — LLM may return malformed structures
      const validAliases = Array.isArray(obj.aliases)
        ? (obj.aliases as unknown[]).filter(
            (a): a is { type: AliasType; value: string } =>
              typeof a === "object" &&
              a !== null &&
              typeof (a as Record<string, unknown>).type === "string" &&
              typeof (a as Record<string, unknown>).value === "string" &&
              ((a as Record<string, unknown>).value as string).length > 0,
          )
        : undefined;

      // Validate metadata — must be a plain object with non-empty string values ≤500 chars
      let validMetadata: Record<string, unknown> | undefined;
      if (
        typeof obj.metadata === "object" &&
        obj.metadata !== null &&
        !Array.isArray(obj.metadata)
      ) {
        const filtered = Object.fromEntries(
          Object.entries(obj.metadata as Record<string, unknown>).filter(
            ([, v]) => typeof v === "string" && v.length > 0 && v.length <= 500,
          ),
        );
        if (Object.keys(filtered).length > 0) validMetadata = filtered;
      }

      return {
        type: obj.type as EntityType,
        canonical_name: obj.canonical_name as string,
        aliases: validAliases,
        metadata: validMetadata,
      };
    });
}

function filterRelations(arr: unknown[]): DetectedRelation[] {
  return arr
    .filter((r: unknown): r is DetectedRelation => {
      if (typeof r !== "object" || r === null) return false;
      const obj = r as Record<string, unknown>;
      return (
        typeof obj.entity_a === "string" &&
        obj.entity_a.length > 0 &&
        typeof obj.entity_b === "string" &&
        obj.entity_b.length > 0 &&
        typeof obj.relation === "string" &&
        entities.RELATION_TYPES.includes(obj.relation as RelationType)
      );
    })
    .map((obj) => {
      // Validate relation metadata
      let validMetadata: Record<string, unknown> | undefined;
      if (
        typeof obj.metadata === "object" &&
        obj.metadata !== null &&
        !Array.isArray(obj.metadata)
      ) {
        const filtered = Object.fromEntries(
          Object.entries(obj.metadata as Record<string, unknown>).filter(
            ([, v]) => typeof v === "string" && v.length > 0 && v.length <= 500,
          ),
        );
        if (Object.keys(filtered).length > 0) validMetadata = filtered;
      }
      return {
        entity_a: obj.entity_a,
        entity_b: obj.entity_b,
        relation: obj.relation,
        metadata: validMetadata,
      };
    });
}

/** One post-image entry surfaced to durable prompt deltas. */
export type ChangedEntry =
  | {
      op: "created";
      id: string;
      category: string;
      title: string;
      content: string;
    }
  | {
      op: "updated";
      id: string;
      category: string;
      title: string;
      content: string;
      prevContent: string;
    }
  | {
      op: "deleted";
      id: string;
      category: string;
      title: string;
      prevContent: string;
    };

/**
 * Apply a list of curator ops (create/update/delete) to the knowledge DB,
 * and optionally create detected entities and relations.
 * Shared by both the live curator and the conversation import system.
 *
 * @returns Counts of applied operations AND the post-image content of
 *   each changed entry. The post-image is captured in-process (cheap) so
 *   durable prompt deltas can render an authoritative update
 *   message without a re-read from the DB (which would be racy vs. parallel
 *   applyOps calls and would lose the pre-image for "changed" entries).
 */
export function applyOps(
  ops: CuratorOp[],
  input: {
    projectPath?: string;
    sessionID?: string;
    /** If true, skip "create" ops (used by consolidation). */
    skipCreate?: boolean;
    /** Entities detected by the curator from conversation context. */
    detectedEntities?: DetectedEntity[];
    /** Relations detected by the curator from conversation context. */
    detectedRelations?: DetectedRelation[];
    /** Worker model that produced these ops (for v35 source attribution). */
    workerModel?: { providerID: string; modelID: string };
  },
): {
  created: number;
  updated: number;
  deleted: number;
  entitiesCreated: number;
  relationsCreated: number;
  changedEntries: ChangedEntry[];
} {
  let created = 0;
  let updated = 0;
  let deleted = 0;
  let entitiesCreated = 0;
  const idsToSync: string[] = [];
  const changedEntries: ChangedEntry[] = [];

  for (const op of ops) {
    if (op.op === "create") {
      if (input.skipCreate) continue;
      // Defensive: skip malformed ops missing required fields
      if (!op.content || !op.title || !op.category) continue;
      const content =
        op.content.length > MAX_ENTRY_CONTENT_LENGTH
          ? op.content.slice(0, MAX_ENTRY_CONTENT_LENGTH) +
            " [truncated — entry too long]"
          : op.content;
      // tryCreate() distinguishes genuine new inserts from dedup-merged
      // creates. Only genuine inserts surface in the delta channel — the
      // agent must not see a "new" entry whose id was reused by a dedup hit.
      const {
        id,
        created: wasCreated,
        previousContent,
      } = ltm.tryCreate({
        projectPath: op.scope === "project" ? input.projectPath : undefined,
        category: op.category,
        title: op.title,
        content,
        session: input.sessionID,
        scope: op.scope,
        // Default to project-scoped. Cross-project sharing must be an explicit,
        // deliberate choice by the curator — defaulting to true caused
        // project-specific engineering directives to leak into every project's
        // injected context (see plan: cross-project knowledge leak).
        crossProject: op.crossProject ?? false,
        confidence: op.confidence,
        workerProviderID: input.workerModel?.providerID,
        workerModelID: input.workerModel?.modelID,
      });
      if (!wasCreated) {
        // Dedup-merged into an existing entry — not a real create, but the
        // existing row was updated in place and may already be pinned in the
        // prompt cache. Surface it as an update so session LTM caches are
        // invalidated and durable prompt deltas can replay the new bytes.
        const entry = ltm.get(id);
        if (entry) {
          idsToSync.push(id);
          changedEntries.push({
            op: "updated",
            id,
            category: entry.category,
            title: entry.title,
            content: entry.content,
            prevContent: previousContent ?? entry.content,
          });
          updated++;
        }
        continue;
      }
      idsToSync.push(id);
      changedEntries.push({
        op: "created",
        id,
        category: op.category,
        title: op.title,
        content,
      });
      created++;
    } else if (op.op === "update") {
      const entry = ltm.get(op.id);
      if (entry) {
        // Guard: don't mutate entries owned by a different project.
        // Cross-project entries (project_id=NULL or same project) are safe.
        if (entry.project_id !== null && input.projectPath) {
          const pid = ensureProject(input.projectPath);
          if (entry.project_id !== pid) continue;
        }
        const prevContent = entry.content;
        const content =
          op.content !== undefined &&
          op.content.length > MAX_ENTRY_CONTENT_LENGTH
            ? op.content.slice(0, MAX_ENTRY_CONTENT_LENGTH) +
              " [truncated — entry too long]"
            : op.content;
        ltm.update(op.id, { content, confidence: op.confidence });
        if (op.content !== undefined) idsToSync.push(op.id);
        changedEntries.push({
          op: "updated",
          id: op.id,
          category: entry.category,
          title: entry.title,
          content: content ?? prevContent,
          prevContent,
        });
        updated++;
      }
    } else if (op.op === "delete") {
      const entry = ltm.get(op.id);
      if (entry) {
        // Guard: don't delete entries owned by a different project.
        if (entry.project_id !== null && input.projectPath) {
          const pid = ensureProject(input.projectPath);
          if (entry.project_id !== pid) continue;
        }
        changedEntries.push({
          op: "deleted",
          id: op.id,
          category: entry.category,
          title: entry.title,
          prevContent: entry.content,
        });
        ltm.remove(op.id);
        deleted++;
      }
    }
  }

  // Sync cross-references for created/updated entries
  for (const id of idsToSync) {
    ltm.syncRefs(id);
    // Also sync entity references (detect entity mentions in content)
    const entry = ltm.get(id);
    if (entry) {
      try {
        entities.syncEntityRefs(id, entry.content);
      } catch (err) {
        log.warn(`entity ref sync failed for ${id}:`, err);
      }
    }
  }

  // Create detected entities (metadata merged on dedup via create())
  if (input.detectedEntities?.length) {
    for (const de of input.detectedEntities) {
      try {
        const result = entities.create({
          projectPath: input.projectPath,
          entityType: de.type,
          canonicalName: de.canonical_name,
          aliases: de.aliases?.map((a) => ({
            type: a.type,
            value: a.value,
            source: "curator",
          })),
          metadata: de.metadata,
        });
        if (result.created) entitiesCreated++;
      } catch (err) {
        log.warn(`entity creation failed for "${de.canonical_name}":`, err);
      }
    }
  }

  // Create detected relations
  let relationsCreated = 0;
  if (input.detectedRelations?.length) {
    for (const dr of input.detectedRelations) {
      try {
        // Resolve entity references by canonical name or UUID
        const resolveRef = (ref: string): string | null => {
          // Check if it's a UUID (wrapped in brackets like [uuid])
          const uuidMatch = ref.match(/^\[([^\]]+)\]$/);
          if (uuidMatch) {
            const entity = entities.get(uuidMatch[1]);
            return entity?.id ?? null;
          }
          // Try to resolve by name
          const entity = entities.resolve(ref);
          return entity?.id ?? null;
        };

        const aId = resolveRef(dr.entity_a);
        const bId = resolveRef(dr.entity_b);
        if (aId && bId && aId !== bId) {
          const relId = entities.addRelation(
            aId,
            bId,
            dr.relation as entities.RelationType,
            { metadata: dr.metadata, source: "curator" },
          );
          if (relId) relationsCreated++;
        }
      } catch (err) {
        log.warn(
          `relation creation failed for "${dr.entity_a}" → "${dr.entity_b}":`,
          err,
        );
      }
    }
  }

  return {
    created,
    updated,
    deleted,
    entitiesCreated,
    relationsCreated,
    changedEntries,
  };
}

// Track which messages we've already curated — per session to prevent
// cross-session leaking (curation on session A advancing the timestamp
// past session B's messages, causing B's curation to find < 3 recent).
// In-memory cache backed by session_state DB table so it survives restarts.
const lastCuratedAt = new Map<string, number>();

/** Get the last-curated timestamp for a session, loading from DB if needed. */
function getLastCuratedAt(sessionID: string): number {
  const cached = lastCuratedAt.get(sessionID);
  if (cached !== undefined) return cached;
  // Load from DB on first access
  const persisted = loadSessionTracking(sessionID);
  const ts = persisted?.lastCuratedAt ?? 0;
  lastCuratedAt.set(sessionID, ts);
  return ts;
}

export async function run(input: {
  llm: LLMClient;
  projectPath: string;
  sessionID: string;
  model?: { providerID: string; modelID: string };
  /** Optional gateway worker-health hook — called when the LLM call returns
   *  null. The gateway uses this to escalate to Sentry after sustained failure. */
  workerHealth?: {
    recordFailure(reason: string): void;
    recordSuccess(): void;
  };
}): Promise<{
  created: number;
  updated: number;
  deleted: number;
  entitiesCreated: number;
  relationsCreated: number;
  changedEntries: ChangedEntry[];
}> {
  const cfg = config();
  if (!cfg.curator.enabled)
    return {
      created: 0,
      updated: 0,
      deleted: 0,
      entitiesCreated: 0,
      relationsCreated: 0,
      changedEntries: [],
    };

  // Skip-if-busy: curation is periodic, not accumulative. If a curation is
  // already running for this session, skip — the next trigger will pick up
  // any new messages. Serializing would waste an LLM call.
  //
  // The isBusy() check and get()() enqueue are both synchronous — in Node's
  // single-threaded event loop no microtask can interleave between them, so
  // there is no TOCTOU race. The p-limit(1) serialization is a safety net
  // if this invariant is ever violated.
  if (curatorLimiter.isBusy(input.sessionID)) {
    log.info(
      `curation skipped: already running for session ${input.sessionID.slice(0, 16)}`,
    );
    return {
      created: 0,
      updated: 0,
      deleted: 0,
      entitiesCreated: 0,
      relationsCreated: 0,
      changedEntries: [],
    };
  }

  return curatorLimiter.get(input.sessionID)(() => runInner(input));
}

/**
 * Collapse near-duplicate `preference` create ops into update ops before they
 * reach applyOps. For each `op:"create"` with category `preference`, look up a
 * semantic duplicate (embedding cosine ≥ PREFERENCE_DEDUP_THRESHOLD, looser than
 * the global dedup cutoff because the curator re-phrases the same rule every
 * session). On a hit, rewrite the op to `{op:"update", id, content, confidence}`
 * so the existing entry is refreshed in place instead of a paraphrase being
 * minted — preventing system[1] preference bloat. Non-preference ops and ops
 * with no semantic match pass through unchanged. No-ops when embeddings are
 * unavailable (findSemanticDuplicate returns null).
 */
export async function dedupePreferenceCreates(
  ops: CuratorOp[],
  projectPath: string,
): Promise<CuratorOp[]> {
  if (!embedding.isAvailable()) return ops;
  const pid = ensureProject(projectPath);
  // Track ids already matched this batch so two paraphrases in the SAME op list
  // don't both redirect onto the same existing entry (the second would clobber
  // the first's content). ACCEPTED LIMITATION: the second paraphrase then falls
  // through as a normal create, so two same-rule paraphrases emitted in ONE
  // curator batch still yield two entries this turn. The per-category
  // consolidation trigger merges that residual on a later idle pass; in practice
  // the curator rarely emits two paraphrases of one rule in a single batch.
  const claimed = new Set<string>();
  const out: CuratorOp[] = [];
  for (const op of ops) {
    if (op.op !== "create" || op.category !== "preference" || !op.title) {
      out.push(op);
      continue;
    }
    let dup: { id: string; similarity: number } | null = null;
    try {
      dup = await ltm.findSemanticDuplicate({
        title: op.title,
        content: op.content,
        projectId: op.scope === "global" ? null : pid,
        threshold: ltm.PREFERENCE_DEDUP_THRESHOLD,
      });
    } catch (err) {
      log.warn(
        "preference dedup: findSemanticDuplicate failed (non-fatal):",
        err,
      );
    }
    const existing = dup && !claimed.has(dup.id) ? ltm.get(dup.id) : null;
    // Guard: a project-scoped create must NOT mutate a globally-shared
    // (cross-project) preference — that would let one project overwrite a
    // preference visible to all projects. Let it fall through as a normal
    // project-scoped create instead. (A global create may still update a global
    // match; a project create may update a same-project match.)
    const wouldMutateGlobalFromProject =
      existing != null &&
      op.scope !== "global" &&
      (existing.cross_project === 1 || existing.project_id == null);
    if (existing && !wouldMutateGlobalFromProject) {
      claimed.add(existing.id);
      // Keep the richer text: don't let a terser paraphrase degrade a more
      // detailed existing entry. Only adopt the new content when it is at least
      // as long (a fuller restatement); otherwise refresh confidence only.
      const keepNewContent =
        (op.content?.length ?? 0) >= (existing.content?.length ?? 0);
      log.info(
        `curation: collapsing near-duplicate preference into existing entry ` +
          `${existing.id.slice(0, 8)} (sim=${dup?.similarity.toFixed(3)}, ` +
          `content=${keepNewContent ? "new" : "kept"}): "${op.title}"`,
      );
      out.push({
        op: "update",
        id: existing.id,
        ...(keepNewContent ? { content: op.content } : {}),
        confidence: op.confidence,
      });
    } else {
      out.push(op);
    }
  }
  return out;
}

async function runInner(input: {
  llm: LLMClient;
  projectPath: string;
  sessionID: string;
  model?: { providerID: string; modelID: string };
  workerHealth?: {
    recordFailure(reason: string): void;
    recordSuccess(): void;
  };
}): Promise<{
  created: number;
  updated: number;
  deleted: number;
  entitiesCreated: number;
  relationsCreated: number;
  changedEntries: ChangedEntry[];
}> {
  const cfg = config();

  // Get recent undistilled messages since last curation.
  // After /lore:curate runs distillation, most messages are marked distilled=1.
  // Using undistilled() avoids sending 100K+ tokens of already-processed
  // messages to the curator. If all messages are distilled, fall back to
  // distilled observations for the session instead.
  const sessionCuratedAt = getLastCuratedAt(input.sessionID);
  const undistilledAll = temporal.undistilled(
    input.projectPath,
    input.sessionID,
  );
  const recentUndistilled = undistilledAll.filter(
    (m) => m.created_at > sessionCuratedAt,
  );

  let text: string;
  if (recentUndistilled.length >= 3) {
    text = recentUndistilled
      .map((m) => `[${m.role}] ${m.content}`)
      .join("\n\n");
  } else {
    // All messages distilled — use distillation observations as input.
    // This is the common case after /lore:curate runs distillation first.
    const distillations = distillation.loadForSession(
      input.projectPath,
      input.sessionID,
      true,
    );
    const recentDistillations = distillations.filter(
      (d) => d.created_at > sessionCuratedAt,
    );
    if (recentDistillations.length === 0)
      return {
        created: 0,
        updated: 0,
        deleted: 0,
        entitiesCreated: 0,
        relationsCreated: 0,
        changedEntries: [],
      };
    text = recentDistillations.map((d) => d.observations).join("\n\n");
  }
  // Include cross-project entries so the curator can see and update
  // preferences created in earlier sessions (preferences default to
  // crossProject: true, so excluding them makes them invisible).
  // A project guard in applyOps prevents mutating entries from foreign projects.
  // forCurator() token-budgets this set so curator LLM cost stops scaling with
  // stored count (cross-project entries are always kept; see forCurator docs).
  const existing = ltm.forCurator(
    input.projectPath,
    cfg.curator.contextTokenBudget,
  );
  const existingForPrompt = existing.map((e) => ({
    id: e.id,
    category: e.category,
    title: e.title,
    content: e.content,
  }));

  // Ensure the self entity exists (created from git config / .lore.json user section).
  // Must run before forProject() so the self entity is included in the entity context
  // and the curator can anchor "I"/"me" references and detect relationships to the user.
  try {
    entities.ensureSelfEntity(input.projectPath);
  } catch (err) {
    log.warn("self entity creation failed (non-fatal):", err);
  }

  // Load known entities for grounding context
  let entityContext = "";
  try {
    const knownEntities = entities.forProject(input.projectPath);
    if (knownEntities.length > 0) {
      entityContext = entities.formatForPrompt(knownEntities);
    }
  } catch (err) {
    log.warn("entity context loading failed (non-fatal):", err);
  }

  const baseUserContent = curatorUser({
    messages: text,
    existing: existingForPrompt,
    entityContext: entityContext || undefined,
  });

  // Detect repeated instructions across prior sessions and append as
  // additional context for the curator. This is async (may embed candidates)
  // but fast — typically <250ms for 5 candidates with local embeddings.
  let crossSessionContext = "";
  try {
    crossSessionContext = await detectAndFormat({
      projectPath: input.projectPath,
      sessionID: input.sessionID,
    });
  } catch (err) {
    log.warn("instruction-detect failed (non-fatal):", err);
  }

  // Lightweight cross-session context: count action tag occurrences
  // from distillation observations across the project. This gives the
  // curator a compact signal about repeated behaviors without the noise
  // of full recall results.
  let actionTagContext = "";
  try {
    actionTagContext = buildActionTagContext(
      input.projectPath,
      input.sessionID,
    );
  } catch (err) {
    log.warn("action tag context failed (non-fatal):", err);
  }

  // Cross-session tool-failure signal: recurring tool failures across prior
  // sessions, so the curator can decide whether they warrant a gotcha entry.
  let toolFailureContext = "";
  try {
    toolFailureContext = buildToolFailureContext(
      input.projectPath,
      input.sessionID,
    );
  } catch (err) {
    log.warn("tool failure context failed (non-fatal):", err);
  }

  const userContent =
    baseUserContent +
    crossSessionContext +
    actionTagContext +
    toolFailureContext;
  // Pass the explicit worker model through — never fall back to cfg.model
  // which is the project/session model and may be from a different provider
  // than the worker's upstream URL. Cross-provider model names → 404.
  // When model is undefined, the gateway's cross-provider guard validates
  // or skips the call before the adapter's defaultModel is used.
  const model = input.model;
  const responseText = await input.llm.prompt(CURATOR_SYSTEM, userContent, {
    model,
    workerID: "lore-curator",
    thinking: false,
    sessionID: input.sessionID,
    maxTokens: 2048,
    temperature: 0,
  });
  if (!responseText) {
    // Transport failure / empty completion already recorded by the LLM
    // adapter (single owner of transport-failure attribution) — avoid
    // double-counting here.
    return {
      created: 0,
      updated: 0,
      deleted: 0,
      entitiesCreated: 0,
      relationsCreated: 0,
      changedEntries: [],
    };
  }

  const response = parseResponse(responseText);
  // Record success only AFTER parsing — parseResponse() silently swallows
  // malformed JSON into empty ops. Recording success before parse would clear
  // the health state, making sustained parse failures invisible.
  input.workerHealth?.recordSuccess();

  // Soft cap (v48): admit creates even at the limit, then evict the lowest-VALUE
  // tail back down to maxEntries below (see post-applyOps eviction). This breaks
  // the old ratchet (creates frozen at the cap → consolidation can't reduce a
  // genuinely-unique set → knowledge base frozen) without relying on an LLM merge
  // that will never succeed. Eviction ranks by decayed confidence, so a create
  // weaker than every incumbent self-evicts and nothing valuable is displaced.

  // Pre-pass: collapse near-duplicate `preference` creates into updates.
  // The curator re-observes the same behavioral rule each session and re-phrases
  // it ("document invariants in code" stated 3 ways), producing paraphrases that
  // ltm.create()'s title-only dedup misses. Preferences inject into the
  // always-pinned system[1] block, so duplicates are the most costly. Use
  // embedding similarity at a preference-specific (looser) threshold to redirect
  // a near-dup create onto the existing entry. Async embedding work lives here
  // (runInner is async) so applyOps can stay synchronous.
  const ops = await dedupePreferenceCreates(response.ops, input.projectPath);

  const result = applyOps(ops, {
    projectPath: input.projectPath,
    sessionID: input.sessionID,
    skipCreate: false, // soft cap: admit creates, evict the lowest-value tail below
    detectedEntities: response.entities,
    detectedRelations: response.relations,
    workerModel: input.model,
  });

  // Post-curation dedup sweep: if the curator created new entries, check for
  // and auto-merge any semantic duplicates it introduced. Uses embedding-based
  // similarity when available, falls back to word-overlap.
  if (result.created > 0) {
    try {
      const dupes = await ltm.deduplicate(input.projectPath, { dryRun: false });
      if (dupes.totalRemoved > 0) {
        log.info(
          `post-curation dedup: merged ${dupes.totalRemoved} duplicate entries`,
        );
        result.deleted += dupes.totalRemoved;
      }
      // Record auto-signals for adaptive threshold calibration.
      // Merged pairs → accept; non-merged high-similarity pairs → reject.
      if (dupes.pairSimilarities.size > 0) {
        const pid = ensureProject(input.projectPath);
        ltm.recordAutoSignals(pid, dupes);
        // Recalibrate if enough data has accumulated
        const newThreshold = ltm.calibrateDedupThreshold(pid);
        if (newThreshold !== null) {
          const count = ltm.getDedupFeedbackCount(pid);
          ltm.saveCalibratedThreshold(pid, newThreshold, count);
        }
      }
    } catch (err) {
      log.warn("post-curation dedup failed (non-fatal):", err);
    }

    // Cross-project auto-promotion (issue #498): after new knowledge lands,
    // detect entries whose meaning recurs across 3+ unrelated projects and
    // promote them to cross_project = 1 so they surface everywhere. Reuses the
    // dedup similarity machinery; gated by the top-level crossProject flag and
    // embedding availability (inner function also guards on isAvailable for
    // callers that don't pre-check).
    if (cfg.crossProject && embedding.isAvailable()) {
      try {
        const promotion = ltm.promoteCrossProject({ dryRun: false });
        if (promotion.promoted > 0) {
          log.info(
            `cross-project promotion: promoted ${promotion.promoted} entries across ${promotion.clusters.length} cluster(s)`,
          );
        }
      } catch (err) {
        log.warn("cross-project promotion failed (non-fatal):", err);
      }
    }
  }

  // Post-curation entity dedup sweep (#462): if the curator created new
  // entities, auto-merge high-confidence semantic duplicates it introduced
  // ("Seylan Cinar" ↔ "Seylan", "GitHub Actions" ↔ "GHA"). Only the auto-merge
  // tier is applied; moderate-confidence pairs are surfaced as suggestions via
  // the CLI / dashboard. Gated on embedding availability since the primary
  // signal is vector similarity. Note: freshly created entities embed
  // fire-and-forget, so some vectors may not have landed yet — name-Jaccard and
  // alias-overlap signals still fire, and the next run catches the rest.
  if (result.entitiesCreated > 0 && embedding.isAvailable()) {
    try {
      const dupes = await entities.deduplicateEntities(input.projectPath, {
        dryRun: false,
      });
      const autoMerged = dupes.merged.reduce((n, c) => n + c.merged.length, 0);
      if (autoMerged > 0) {
        log.info(
          `post-curation entity dedup: merged ${autoMerged} duplicate entit${autoMerged === 1 ? "y" : "ies"}`,
        );
        result.deleted += autoMerged;
      }
      // Record reject auto-signals + recalibrate the entity threshold.
      if (dupes.pairSimilarities.size > 0) {
        const pid = ensureProject(input.projectPath);
        entities.recordEntityAutoSignals(pid, dupes);
        const newThreshold = entities.calibrateEntityDedupThreshold(pid);
        if (newThreshold !== null) {
          const count = entities.getEntityDedupFeedbackCount(pid);
          entities.saveEntityCalibratedThreshold(pid, newThreshold, count);
        }
      }
    } catch (err) {
      log.warn("post-curation entity dedup failed (non-fatal):", err);
    }
  }

  // Soft-cap enforcement: after creates and the dedup sweeps settle the count,
  // evict the lowest-value project-scoped entries back down to maxEntries.
  const evictedCount = enforceEntryCap(
    input.projectPath,
    cfg.curator.maxEntries,
    result,
  );
  if (evictedCount > 0) {
    log.info(
      `curation: cap reached (${cfg.curator.maxEntries}) — evicted ${evictedCount} lowest-value entries`,
    );
  }

  const now = Date.now();
  lastCuratedAt.set(input.sessionID, now);
  saveSessionTracking(input.sessionID, { lastCuratedAt: now });
  return result;
}

// ---------------------------------------------------------------------------
// Lightweight cross-session context from action tags
// ---------------------------------------------------------------------------

/**
 * True if a non-zero-confidence knowledge entry with this exact (case-folded)
 * title already exists for the project in the given category. Used to suppress
 * behavioral-signal lines for patterns the curator has ALREADY captured — so it
 * is not re-prompted every run to re-create the same preference/gotcha (the
 * re-observation → near-duplicate-mint loop). Mirrors the title check ltm.create
 * uses, so "already captured" here means "would dedup-merge on create".
 */
function hasKnowledgeTitle(
  projectId: string,
  category: string,
  title: string,
): boolean {
  return (
    db()
      .query(
        `SELECT id FROM knowledge
         WHERE project_id = ? AND LOWER(title) = LOWER(?)
         AND category = ? AND confidence > 0 LIMIT 1`,
      )
      .get(projectId, title, category) != null
  );
}

/**
 * Scan distillation observations for action tags and count their occurrence
 * across distinct sessions. Returns a compact summary like:
 *
 *   "Cross-session behavioral patterns detected:
 *    - [requested-tests] appeared in 4 sessions
 *    - [corrected-style] appeared in 3 sessions"
 *
 * This helps the curator recognize implicit preferences from repeated behavior
 * without the noise of full recall results. Tags already captured as preference
 * entries are filtered out so the curator is not re-prompted to re-create them.
 */
export function buildActionTagContext(
  projectPath: string,
  currentSessionID: string,
): string {
  const pid = ensureProject(projectPath);

  // Get all distillation observations for this project
  const rows = db()
    .query(
      "SELECT session_id, observations FROM distillations WHERE project_id = ?",
    )
    .all(pid) as Array<{ session_id: string; observations: string }>;

  if (!rows.length) return "";

  // Count action tags across distinct sessions (exclude current session)
  const tagSessions = new Map<string, Set<string>>();
  const tagRe = /\[([a-z]+-[a-z-]+)\]/g;

  for (const row of rows) {
    if (row.session_id === currentSessionID) continue;
    tagRe.lastIndex = 0;
    let match = tagRe.exec(row.observations);
    while (match !== null) {
      const tag = match[1];
      if (!tagSessions.has(tag)) tagSessions.set(tag, new Set());
      tagSessions.get(tag)?.add(row.session_id);
      match = tagRe.exec(row.observations);
    }
  }

  // Filter to tags that appeared in 2+ sessions (emerging patterns), AND that
  // are not already captured as a preference entry — otherwise the curator is
  // re-prompted to re-create the same preference on every run (re-observation
  // loop → near-duplicate mints). tagToTitle maps a tag to the canonical
  // preference title the distiller/curator would create for it.
  const significant = [...tagSessions.entries()]
    .filter(([, sessions]) => sessions.size >= 2)
    .filter(([tag]) => !hasKnowledgeTitle(pid, "preference", tagToTitle(tag)))
    .sort((a, b) => b[1].size - a[1].size);

  if (!significant.length) return "";

  const lines = significant.map(
    ([tag, sessions]) =>
      `- [${tag}] appeared in ${sessions.size} prior sessions`,
  );

  return (
    "\n\n---\nCross-session behavioral patterns detected (consider creating preference entries for these):\n" +
    lines.join("\n")
  );
}

/**
 * Build a compact cross-session tool-failure block for the curator prompt.
 * Aggregates recurring tool failures from the structured `tool_calls` table
 * (excluding the current session), so the curator can decide whether a
 * recurring failure warrants a gotcha entry. Returns "" when none qualify.
 */
function buildToolFailureContext(
  projectPath: string,
  currentSessionID: string,
): string {
  const pid = ensureProject(projectPath);
  const stats = toolTrace
    .toolFailureStats(projectPath, {
      minSessions: 2,
      excludeSessionID: currentSessionID,
    })
    // Drop failures already captured as a gotcha entry so the curator is not
    // re-prompted to re-create them every run (re-observation loop).
    .filter(
      (s) =>
        !hasKnowledgeTitle(
          pid,
          "gotcha",
          toolTrace.toolGotchaTitle(s.tool, s.error_type),
        ),
    );
  if (!stats.length) return "";

  const lines = stats
    .slice(0, 8)
    .map(
      (s) =>
        `- ${s.tool} failed with "${s.error_type ?? "unknown"}" in ${s.session_count} sessions (${s.failure_count}×)`,
    );

  return (
    "\n\n---\nRecurring tool failures across sessions (consider creating gotcha entries for root causes):\n" +
    lines.join("\n")
  );
}

export function resetCurationTracker(sessionID?: string) {
  if (sessionID) {
    lastCuratedAt.delete(sessionID);
  } else {
    lastCuratedAt.clear();
  }
}

/**
 * Maximum entries to include in a single consolidation prompt.
 *
 * With ~300 tokens per entry (title + content), 50 entries ≈ 15K tokens of
 * input — well within the context window. The 4096 output token budget can
 * express ~80-100 delete/update ops, enough to act on most of the batch.
 *
 * When the total entry count exceeds this, consolidation runs in batched
 * mode: each pass evaluates the lowest-confidence entries for deletion,
 * and the idle scheduler runs subsequent passes as the count drops.
 */
const CONSOLIDATION_BATCH_SIZE = 50;

/**
 * Soft-cap enforcement (the eviction half of the decoupled create-gate). When a
 * project exceeds `maxEntries`, evict the lowest-VALUE project-scoped entries
 * (decayed confidence, then least-recently reinforced) back down to the cap, and
 * fold the evictions into `result` (deletes + changedEntries) so session LTM
 * caches / durable deltas stay consistent — exactly as consolidation deletes do.
 *
 * The knowledge base can always admit new high-value knowledge; the confidence
 * lifecycle (decay + reinforcement) decides what leaves. A freshly-created entry
 * weaker than every incumbent self-evicts (evictLowestValue ranks it to the
 * tail), so weak new knowledge never displaces stronger existing knowledge.
 * Returns the number of entries evicted. Exported for testing.
 */
export function enforceEntryCap(
  projectPath: string,
  maxEntries: number,
  result: { deleted: number; changedEntries: ChangedEntry[] },
): number {
  const overBy = ltm.forProject(projectPath, false).length - maxEntries;
  if (overBy <= 0) return 0;
  const evicted = ltm.evictLowestValue(projectPath, overBy);
  for (const e of evicted) {
    result.changedEntries.push({
      op: "deleted",
      id: e.id,
      category: e.category,
      title: e.title,
      prevContent: e.content,
    });
  }
  result.deleted += evicted.length;
  return evicted.length;
}

/**
 * Consolidation pass: reviews project entries and merges/trims/deletes
 * to reduce entry count to cfg.curator.maxEntries.
 *
 * When the entry count is moderately above the limit (≤ CONSOLIDATION_BATCH_SIZE),
 * sends all entries in a single prompt. When massively over (e.g., 1143 entries),
 * operates in batched mode: sends the lowest-confidence entries as candidates
 * for deletion. Each pass makes progress; the idle scheduler runs subsequent
 * passes as the count drops (the cooldown tracks entry count and clears when
 * it changes).
 *
 * Only "update" and "delete" ops are applied — consolidation never creates entries.
 */
export async function consolidate(input: {
  llm: LLMClient;
  projectPath: string;
  sessionID: string;
  model?: { providerID: string; modelID: string };
  /**
   * When set, consolidate a single bloated category (e.g. "preference") even
   * though the GLOBAL entry count is under maxEntries. Sends all PROJECT-SCOPED
   * entries of that category (cross-project/global entries are EXCLUDED for
   * deletion safety — one project must not delete a globally-shared preference)
   * to the LLM so it can merge paraphrased near-duplicates that the
   * confidence-tail batched mode would never surface. Used by the per-category
   * consolidation trigger.
   */
  focusCategory?: string;
  workerHealth?: {
    recordFailure(reason: string): void;
    recordSuccess(): void;
  };
}): Promise<{ updated: number; deleted: number }> {
  const cfg = config();
  if (!cfg.curator.enabled) return { updated: 0, deleted: 0 };

  // Category-focused mode: bypass the global-count gate and merge one bloated
  // category. Only send PROJECT-SCOPED entries to the consolidator — never
  // cross-project (global) ones. applyOps' project guard treats global
  // (project_id=NULL) rows as freely mutable/deletable, so a single project's
  // consolidation could otherwise delete a preference shared across ALL
  // projects. Excluding them mirrors the global path's includeCross=false
  // safety. (Global-preference dedup is handled at create time by
  // dedupePreferenceCreates, which redirects onto the existing global entry.)
  if (input.focusCategory) {
    const projectScoped = ltm.forProject(input.projectPath, false);
    const catEntries = projectScoped.filter(
      (e) => e.category === input.focusCategory,
    );
    if (catEntries.length < 2) return { updated: 0, deleted: 0 };
    return consolidateEntries(input, catEntries);
  }

  // Intentionally excludes cross-project entries (includeCross=false).
  // Consolidation should only merge/trim project-scoped entries — cross-project
  // entries are shared and should not be deleted by a single project's consolidation.
  const entries = ltm.forProject(input.projectPath, false);
  if (entries.length <= cfg.curator.maxEntries)
    return { updated: 0, deleted: 0 };

  // Entries are sorted by confidence DESC, updated_at DESC from forProject().
  // For batched mode, we take the lowest-confidence entries (tail of the list)
  // as candidates for deletion — they're the least valuable.
  let entriesForPrompt: Array<{
    id: string;
    category: string;
    title: string;
    content: string;
  }>;
  let batchTarget: number;

  if (entries.length <= CONSOLIDATION_BATCH_SIZE) {
    // Small overshoot — send all entries, target is maxEntries
    entriesForPrompt = entries.map((e) => ({
      id: e.id,
      category: e.category,
      title: e.title,
      content: e.content,
    }));
    batchTarget = cfg.curator.maxEntries;
  } else {
    // Large overshoot — batched mode. Take the lowest-confidence entries.
    // The LLM evaluates this batch and deletes the least valuable ones.
    // Subsequent passes (on future idle ticks) handle the rest.
    const candidates = entries.slice(-CONSOLIDATION_BATCH_SIZE);
    entriesForPrompt = candidates.map((e) => ({
      id: e.id,
      category: e.category,
      title: e.title,
      content: e.content,
    }));
    // Target is relative to the batch (not the global total) because the
    // prompt only sees the batch entries. Keep at most half — delete the rest.
    // Each pass deletes ~25 entries, the idle scheduler re-triggers (cooldown
    // clears when entry count changes), converging over multiple passes.
    batchTarget = Math.ceil(CONSOLIDATION_BATCH_SIZE / 2);
    log.info(
      `consolidation: batched mode — evaluating ${candidates.length} lowest-confidence entries ` +
        `(${entries.length} total, batch keeps at most ${batchTarget})`,
    );
  }

  return runConsolidationPrompt(input, entriesForPrompt, batchTarget);
}

/**
 * Consolidate an explicit set of entries (a single bloated category) by merging
 * GENUINE DUPLICATES only — no numeric eviction target. Uses the merge-oriented
 * prompt so distinct entries are never force-deleted (unlike the global trim
 * path). Bypasses the lowest-confidence batched selection (which never surfaces
 * high-confidence preference dups).
 */
async function consolidateEntries(
  input: Parameters<typeof consolidate>[0],
  entries: Array<{
    id: string;
    category: string;
    title: string;
    content: string;
  }>,
): Promise<{ updated: number; deleted: number }> {
  const entriesForPrompt = entries.map((e) => ({
    id: e.id,
    category: e.category,
    title: e.title,
    content: e.content,
  }));
  log.info(
    `consolidation: category-focused — evaluating ${entries.length} "${entries[0]?.category}" entries for near-duplicate merge`,
  );
  return runConsolidationPrompt(input, entriesForPrompt, 0, "merge-duplicates");
}

/**
 * Shared tail of consolidate(): build the prompt, call the LLM, apply the
 * returned merge/delete ops. Never creates (skipCreate). Used by both the
 * global-count trim path ("trim") and the category-focused merge path
 * ("merge-duplicates").
 */
async function runConsolidationPrompt(
  input: Parameters<typeof consolidate>[0],
  entriesForPrompt: Array<{
    id: string;
    category: string;
    title: string;
    content: string;
  }>,
  targetMax: number,
  mode: "trim" | "merge-duplicates" = "trim",
): Promise<{ updated: number; deleted: number }> {
  const userContent = consolidationUser({
    entries: entriesForPrompt,
    targetMax,
    mode,
  });
  // Pass the explicit worker model through — never fall back to cfg.model
  // which is the project/session model and may be from a different provider
  // than the worker's upstream URL. Cross-provider model names → 404.
  // When model is undefined, the gateway's cross-provider guard validates
  // or skips the call before the adapter's defaultModel is used.
  const model = input.model;
  const responseText = await input.llm.prompt(
    mode === "merge-duplicates"
      ? CONSOLIDATION_MERGE_SYSTEM
      : CONSOLIDATION_SYSTEM,
    userContent,
    {
      model,
      workerID: "lore-curator",
      thinking: false,
      sessionID: input.sessionID,
      maxTokens: 4096,
      temperature: 0,
    },
  );
  if (!responseText) {
    // Transport failure / empty completion already recorded by the LLM
    // adapter (single owner of transport-failure attribution) — avoid
    // double-counting here.
    return { updated: 0, deleted: 0 };
  }

  const ops = parseOps(responseText);
  // Record success after parsing (see runInner for rationale).
  input.workerHealth?.recordSuccess();
  const result = applyOps(ops, {
    projectPath: input.projectPath,
    sessionID: input.sessionID,
    skipCreate: true, // Consolidation must not add entries.
    workerModel: input.model,
  });

  return { updated: result.updated, deleted: result.deleted };
}
