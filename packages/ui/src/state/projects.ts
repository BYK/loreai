import type { ProjectSummary } from "~/contracts";
import type { ApiClient } from "~/lib/api";
import type { Repository } from "~/db";
import { createLoader, type Loader } from "~/lib/loader";

import { createEntityStore } from "./entity-store";
import { statusOf } from "./status";

export interface ProjectsDeps {
  client: ApiClient;
  repo: Repository<ProjectSummary>;
  tracked: <T>(read: () => Promise<T>) => Promise<T>;
}

const SCOPE = "all";

export function createProjectsState({ client, repo, tracked }: ProjectsDeps) {
  const store = createEntityStore<ProjectSummary>((p) => p.id);

  const list: Loader<ProjectSummary[]> = createLoader(
    () => true,
    (_, signal) => tracked(() => client.listProjects(signal)),
    {
      async cached() {
        const [rows, collection] = await Promise.all([
          repo.getScope(SCOPE),
          repo.collection(SCOPE),
        ]);
        // No recorded collection means "never fetched" — let the server
        // answer first. A row count below the recorded count means rows
        // were lost to TTL/LRU eviction: render them, marked partial.
        // NB: no store.reconcileOne here — a late cache read resolving after
        // the server answer would overwrite fresh records with stale rows
        // (cache reads are raced, not ordered); only onServer writes records.
        if (!collection) return undefined;
        return { value: rows, partial: rows.length !== collection.count };
      },
      async onServer(_, values) {
        for (const p of values) store.reconcileOne(p);
        store.reconcileList(SCOPE, values, { complete: true });
        await repo.putMany(values, SCOPE, { replaceScope: true });
        await repo.setCollection(SCOPE, {
          complete: true,
          count: values.length,
          nextCursor: null,
          fetchedAt: Date.now(),
        });
      },
    },
  );

  return {
    list,
    byId(id: string | null | undefined): ProjectSummary | undefined {
      return id
        ? (store.select(id) ?? list.data()?.find((p) => p.id === id))
        : undefined;
    },
    all(): ProjectSummary[] | undefined {
      return list.data() ?? store.selectList(SCOPE);
    },
    /** Evict a deleted/merged project from memory + the cache projection. */
    async remove(id: string): Promise<void> {
      store.remove(id);
      await repo.delete(id);
      await repo.deleteCollection(SCOPE);
    },
    /** Refetch the list (post-write invalidation). */
    reload(): void {
      list.reload();
    },
    status: statusOf(list),
  };
}
