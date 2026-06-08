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
  consolidationUser,
} from "./prompt";
import * as toolTrace from "./tool-trace";
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

/**
 * Apply a list of curator ops (create/update/delete) to the knowledge DB,
 * and optionally create detected entities and relations.
 * Shared by both the live curator and the conversation import system.
 *
 * @returns Counts of applied operations.
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
} {
  let created = 0;
  let updated = 0;
  let deleted = 0;
  let entitiesCreated = 0;
  const idsToSync: string[] = [];

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
      const id = ltm.create({
        projectPath: op.scope === "project" ? input.projectPath : undefined,
        category: op.category,
        title: op.title,
        content,
        session: input.sessionID,
        scope: op.scope,
        crossProject: op.crossProject ?? true,
        confidence: op.confidence,
        workerProviderID: input.workerModel?.providerID,
        workerModelID: input.workerModel?.modelID,
      });
      idsToSync.push(id);
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
        const content =
          op.content !== undefined &&
          op.content.length > MAX_ENTRY_CONTENT_LENGTH
            ? op.content.slice(0, MAX_ENTRY_CONTENT_LENGTH) +
              " [truncated — entry too long]"
            : op.content;
        ltm.update(op.id, { content, confidence: op.confidence });
        if (op.content !== undefined) idsToSync.push(op.id);
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

  return { created, updated, deleted, entitiesCreated, relationsCreated };
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
}> {
  const cfg = config();
  if (!cfg.curator.enabled)
    return {
      created: 0,
      updated: 0,
      deleted: 0,
      entitiesCreated: 0,
      relationsCreated: 0,
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
    };
  }

  return curatorLimiter.get(input.sessionID)(() => runInner(input));
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
      };
    text = recentDistillations.map((d) => d.observations).join("\n\n");
  }
  // Include cross-project entries so the curator can see and update
  // preferences created in earlier sessions (preferences default to
  // crossProject: true, so excluding them makes them invisible).
  // A project guard in applyOps prevents mutating entries from foreign projects.
  const existing = ltm.forProject(input.projectPath, true);
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
    input.workerHealth?.recordFailure("no-response");
    return {
      created: 0,
      updated: 0,
      deleted: 0,
      entitiesCreated: 0,
      relationsCreated: 0,
    };
  }

  const response = parseResponse(responseText);
  // Record success only AFTER parsing — parseResponse() silently swallows
  // malformed JSON into empty ops. Recording success before parse would clear
  // the health state, making sustained parse failures invisible.
  input.workerHealth?.recordSuccess();

  // Gate entry creation when at or above maxEntries to prevent the ratchet
  // effect: curation creates entries → count exceeds limit → consolidation
  // can't reduce (all unique) → curation creates more → count grows forever.
  // When at the limit, only allow update/delete ops. Creates are allowed
  // again once consolidation (or manual deletion) brings count below limit.
  const currentEntries = ltm.forProject(input.projectPath, false);
  const atLimit = currentEntries.length >= cfg.curator.maxEntries;
  if (atLimit && response.ops.some((op) => op.op === "create")) {
    log.info(
      `curation: skipping creates (${currentEntries.length} entries >= maxEntries ${cfg.curator.maxEntries})`,
    );
  }

  const result = applyOps(response.ops, {
    projectPath: input.projectPath,
    sessionID: input.sessionID,
    skipCreate: atLimit,
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

  const now = Date.now();
  lastCuratedAt.set(input.sessionID, now);
  saveSessionTracking(input.sessionID, { lastCuratedAt: now });
  return result;
}

// ---------------------------------------------------------------------------
// Lightweight cross-session context from action tags
// ---------------------------------------------------------------------------

/**
 * Scan distillation observations for action tags and count their occurrence
 * across distinct sessions. Returns a compact summary like:
 *
 *   "Cross-session behavioral patterns detected:
 *    - [requested-tests] appeared in 4 sessions
 *    - [corrected-style] appeared in 3 sessions"
 *
 * This helps the curator recognize implicit preferences from repeated behavior
 * without the noise of full recall results.
 */
function buildActionTagContext(
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

  // Filter to tags that appeared in 2+ sessions (emerging patterns)
  const significant = [...tagSessions.entries()]
    .filter(([, sessions]) => sessions.size >= 2)
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
  const stats = toolTrace.toolFailureStats(projectPath, {
    minSessions: 2,
    excludeSessionID: currentSessionID,
  });
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
  workerHealth?: {
    recordFailure(reason: string): void;
    recordSuccess(): void;
  };
}): Promise<{ updated: number; deleted: number }> {
  const cfg = config();
  if (!cfg.curator.enabled) return { updated: 0, deleted: 0 };

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

  const userContent = consolidationUser({
    entries: entriesForPrompt,
    targetMax: batchTarget,
  });
  // Pass the explicit worker model through — never fall back to cfg.model
  // which is the project/session model and may be from a different provider
  // than the worker's upstream URL. Cross-provider model names → 404.
  // When model is undefined, the gateway's cross-provider guard validates
  // or skips the call before the adapter's defaultModel is used.
  const model = input.model;
  const responseText = await input.llm.prompt(
    CONSOLIDATION_SYSTEM,
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
    input.workerHealth?.recordFailure("no-response");
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
