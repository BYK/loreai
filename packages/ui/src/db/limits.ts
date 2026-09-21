import type { CachedStoreName } from "./schema";

export interface CacheLimit {
  maxEntries: number;
  maxAgeMs: number;
}

const DAY = 24 * 60 * 60 * 1000;

/**
 * Per-store bounds. Injectable into `createRepository` so tests can shrink
 * them without touching production values.
 */
export const CACHE_LIMITS: Record<CachedStoreName, CacheLimit> = {
  projects: { maxEntries: 500, maxAgeMs: 7 * DAY },
  knowledge: { maxEntries: 5000, maxAgeMs: 7 * DAY },
  sessions: { maxEntries: 2000, maxAgeMs: 7 * DAY },
  entities: { maxEntries: 1000, maxAgeMs: 7 * DAY },
  messageBlocks: { maxEntries: 1000, maxAgeMs: 3 * DAY },
};
