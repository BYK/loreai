export {
  openLoreDb,
  resetCache,
  closeLoreDb,
  indexedDbAvailable,
  type CacheStatus,
  type OpenOptions,
} from "./open";
export {
  LORE_DB_NAME,
  LORE_DB_VERSION,
  MESSAGE_BLOCK_SIZE,
  type CachedEntity,
  type CachedRecord,
  type CollectionState,
  type CachedStoreName,
  type LoreUiDb,
  type LoreUiSchema,
  type MessageBlock,
} from "./schema";
export { CACHE_LIMITS, type CacheLimit } from "./limits";
export type { Repository } from "./repository";
export {
  createDraftsStore,
  createPendingChangesStore,
  type LocalDraft,
  type LocalStore,
  type PendingChange,
} from "./local";

import type {
  KnowledgeEntry,
  ProjectSummary,
  SessionSummary,
} from "~/contracts";

import { createRepository, type Repository } from "./repository";
import type { CachedEntity, LoreUiDb, MessageBlock } from "./schema";

export function createEntitiesRepo(
  db: LoreUiDb | null,
): Repository<CachedEntity> {
  return createRepository<CachedEntity>(db, "entities", (e) => e.id);
}

export function createProjectsRepo(
  db: LoreUiDb | null,
): Repository<ProjectSummary> {
  return createRepository<ProjectSummary>(db, "projects", (p) => p.id);
}

export function createKnowledgeRepo(
  db: LoreUiDb | null,
): Repository<KnowledgeEntry> {
  return createRepository<KnowledgeEntry>(db, "knowledge", (k) => k.id);
}

export function createSessionsRepo(
  db: LoreUiDb | null,
): Repository<SessionSummary> {
  return createRepository<SessionSummary>(
    db,
    "sessions",
    (s, scope) => `${scope}/${s.session_id}`,
  );
}

export function createMessageBlocksRepo(
  db: LoreUiDb | null,
): Repository<MessageBlock> {
  return createRepository<MessageBlock>(
    db,
    "messageBlocks",
    (block) => `${block.sessionKey}#${block.index}`,
  );
}

/** `meta` store accessor (per-device UI preferences). */
export async function getMeta(
  db: LoreUiDb | null,
  key: string,
): Promise<unknown> {
  if (!db) return undefined;
  return (await db.get("meta", key))?.value;
}

export async function setMeta(
  db: LoreUiDb | null,
  key: string,
  value: unknown,
): Promise<void> {
  if (!db) return;
  await db.put("meta", { key, value, updatedAt: Date.now() });
}
