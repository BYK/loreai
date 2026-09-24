/**
 * IndexedDB schema for the UI cache (`lore-ui`, version 3).
 *
 * Everything in the entity stores is a disposable projection of `/api/v1`
 * responses — the gateway's SQLite store is the only authority. `drafts` and
 * `pendingChanges` are local working state on this device (see `local.ts`);
 * they are structurally different from every contract type and are never
 * merged into the entity stores.
 */
import type { DBSchema, IDBPDatabase } from "idb";

import type {
  EntityDetail,
  EntityListItem,
  KnowledgeEntry,
  ProjectSummary,
  SessionSummary,
  TemporalMessage,
} from "~/contracts";

import type { LocalDraft, PendingChange } from "./local";

export const LORE_DB_NAME = "lore-ui";
export const LORE_DB_VERSION = 3;

/** A cached API record plus bookkeeping for TTL and LRU eviction. */
export interface CachedRecord<T> {
  key: string;
  scope: string;
  value: T;
  storedAt: number;
  accessedAt: number;
}

/** Progress of a paginated fetch into a store, per scope. */
export interface CollectionState {
  /** `${store}:${scope}` — the primary key. */
  key: string;
  store: CachedStoreName;
  scope: string;
  complete: boolean;
  /** Rows the server reported — survives row eviction; a cached scope whose
   * row count differs renders as `partial`, not complete. */
  count: number;
  nextCursor: string | null;
  fetchedAt: number;
}

/** A `MESSAGE_BLOCK_SIZE`-sized chunk of one session's messages. */
export type MessageBlock = {
  sessionKey: string;
  index: number;
  messages: TemporalMessage[];
};

export const MESSAGE_BLOCK_SIZE = 200;

export type CachedStoreName =
  | "projects"
  | "knowledge"
  | "sessions"
  | "entities"
  | "messageBlocks";

// `type` (not `interface`) so it is assignable to idb's index-key signature.
type CachedStoreIndexes = {
  "by-scope": string;
  "by-accessed": number;
  "by-stored": number;
};

export interface LoreUiSchema extends DBSchema {
  /** Per-device UI preferences (v1; untouched by the v2 upgrade). */
  meta: {
    key: string;
    value: { key: string; value: unknown; updatedAt: number };
  };
  /** Cached `GET /projects` rows. scope = "all". */
  projects: {
    key: string;
    value: CachedRecord<ProjectSummary>;
    indexes: CachedStoreIndexes;
  };
  /** Cached knowledge entries. scope = project id. */
  knowledge: {
    key: string;
    value: CachedRecord<KnowledgeEntry>;
    indexes: CachedStoreIndexes;
  };
  /** Cached session summaries. scope = project id, key = `${projectId}/${session_id}`. */
  sessions: {
    key: string;
    value: CachedRecord<SessionSummary>;
    indexes: CachedStoreIndexes;
  };
  /** Cached entity rows + details. scope = "all", key = entity id. */
  entities: {
    key: string;
    value: CachedRecord<CachedEntity>;
    indexes: CachedStoreIndexes;
  };
  /** Cached session message blocks. scope = session key, key = `${sessionKey}#${index}`. */
  messageBlocks: {
    key: string;
    value: CachedRecord<MessageBlock>;
    indexes: CachedStoreIndexes;
  };
  /** Per-scope pagination state for the entity stores. */
  collections: {
    key: string;
    value: CollectionState;
  };
  drafts: {
    key: string;
    value: LocalDraft;
    indexes: { "by-updated": number };
  };
  pendingChanges: {
    key: string;
    value: PendingChange;
    indexes: { "by-created": number };
  };
}

/**
 * One row in the `entities` store: `item` is the list-row projection every
 * write fills (so the cached first page never loses a detail-written row),
 * `detail` is present only once the detail route has been fetched.
 */
export type CachedEntity = {
  id: string;
  item: EntityListItem;
  detail?: EntityDetail;
};

export type LoreUiDb = IDBPDatabase<LoreUiSchema>;
