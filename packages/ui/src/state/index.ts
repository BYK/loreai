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
import { createRecallState } from "./recall";

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
  handle: () => Promise<LoreUiDb | null>,
  make: (handle: LoreUiDb | null) => Repository<T>,
): Repository<T> {
  const call = <R>(fn: (repo: Repository<T>) => Promise<R>, fallback: R) =>
    handle().then(
      (h) => fn(make(h)),
      () => fallback,
    );
  return {
    get: (key) => call((r) => r.get(key), undefined),
    getScope: (scope) => call((r) => r.getScope(scope), []),
    put: (value, scope, opts) =>
      call((r) => r.put(value, scope, opts), undefined),
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
  let current: Promise<LoreUiDb | null> = ready;

  const projectsRepo = lazyRepo(
    () => current,
    (h) => createProjectsRepo(h),
  );
  const knowledgeRepo = lazyRepo(
    () => current,
    (h) => createKnowledgeRepo(h),
  );
  const sessionsRepo = lazyRepo(
    () => current,
    (h) => createSessionsRepo(h),
  );
  const messageBlocksRepo = lazyRepo(
    () => current,
    (h) => createMessageBlocksRepo(h),
  );

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
  const recall = createRecallState({ client, tracked });

  return {
    projects,
    knowledge,
    sessions,
    recall,
    cache: {
      status: cacheStatus,
      async reset(): Promise<void> {
        await closeLoreDb();
        await resetCache();
        setCacheStatus("reset");
        current = openLoreDb().then(
          (handle) => {
            setCacheStatus(handle ? "ready" : "unavailable");
            return handle;
          },
          () => {
            setCacheStatus("unavailable");
            return null;
          },
        );
        await current;
      },
    },
    /** Resolves once the db handle (and so the repos) is ready. Test hook. */
    ready,
  };
}

export type AppState = ReturnType<typeof createAppState>;
