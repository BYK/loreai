import { createSignal } from "solid-js";

import type { ApiClient } from "~/lib/api";
import {
  closeLoreDb,
  createKnowledgeRepo,
  createMessageBlocksRepo,
  createProjectsRepo,
  createSessionsRepo,
  openLoreDb,
  resetCache,
  type CacheStatus,
  type LoreUiDb,
  type Repository,
} from "~/db";

import { createKnowledgeState } from "./knowledge";
import { createProjectsState } from "./projects";
import { createSessionsState } from "./sessions";

export interface AppStateDeps {
  client: ApiClient;
  /** The (possibly unavailable) cache handle, e.g. `openLoreDb()`. */
  db: Promise<LoreUiDb | null>;
  tracked: <T>(read: () => Promise<T>) => Promise<T>;
}

/**
 * A Repository facade that forwards every call to the real repository once
 * the db handle resolves — until then (or when it resolves null) every
 * method is a no-op.
 */
function lazyRepo<T>(
  db: Promise<LoreUiDb | null>,
  make: (handle: LoreUiDb | null) => Repository<T>,
): Repository<T> {
  const inner = db.then(make, () => make(null));
  const call = <R>(fn: (repo: Repository<T>) => Promise<R>, fallback: R) =>
    inner.then(fn, () => fallback);
  return {
    get: (key) => call((r) => r.get(key), undefined),
    getScope: (scope) => call((r) => r.getScope(scope), []),
    put: (value, scope) => call((r) => r.put(value, scope), undefined),
    putMany: (values, scope, opts) =>
      call((r) => r.putMany(values, scope, opts), undefined),
    delete: (key) => call((r) => r.delete(key), undefined),
    clear: () => call((r) => r.clear(), undefined),
    collection: (scope) => call((r) => r.collection(scope), undefined),
    setCollection: (scope, state) =>
      call((r) => r.setCollection(scope, state), undefined),
  };
}

export function createAppState({ client, db, tracked }: AppStateDeps) {
  const [cacheStatus, setCacheStatus] = createSignal<CacheStatus>("ready");
  const ready = db.then(
    (handle) => {
      setCacheStatus(handle ? "ready" : "unavailable");
      return handle;
    },
    () => {
      setCacheStatus("unavailable");
      return null;
    },
  );

  const projectsRepo = lazyRepo(ready, (h) => createProjectsRepo(h));
  const knowledgeRepo = lazyRepo(ready, (h) => createKnowledgeRepo(h));
  const sessionsRepo = lazyRepo(ready, (h) => createSessionsRepo(h));
  const messageBlocksRepo = lazyRepo(ready, (h) => createMessageBlocksRepo(h));

  const projects = createProjectsState({
    client,
    repo: projectsRepo,
    tracked,
  });
  const knowledge = createKnowledgeState({
    client,
    repo: knowledgeRepo,
    tracked,
  });
  const sessions = createSessionsState({
    client,
    repos: { sessions: sessionsRepo, messageBlocks: messageBlocksRepo },
    projectPathOf: (id) => projects.byId(id)?.path,
    tracked,
  });

  return {
    projects,
    knowledge,
    sessions,
    cache: {
      status: cacheStatus,
      async reset(): Promise<void> {
        await closeLoreDb();
        await resetCache();
        setCacheStatus("reset");
        // Repos bound to the previous handle degrade to no-ops; the next
        // app mount reopens a fresh database.
        void openLoreDb();
      },
    },
    /** Resolves once the db handle (and so the repos) is ready. Test hook. */
    ready,
  };
}

export type AppState = ReturnType<typeof createAppState>;
