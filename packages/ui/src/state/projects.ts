import { createMemo } from "solid-js";

import type { ProjectSummary } from "~/contracts";
import type { ApiClient } from "~/lib/api";
import type { Repository } from "~/db";
import { createLoader, type Loader } from "~/lib/loader";

import { createEntityStore } from "./entity-store";
import { statusOf, type KeyStatus } from "./status";

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
        // An empty scope with no recorded collection means "never fetched",
        // not "no projects" — let the server answer first in that case.
        if (rows.length === 0 && !collection) return undefined;
        for (const p of rows) store.reconcileOne(p);
        return rows;
      },
      async onServer(_, values) {
        for (const p of values) store.reconcileOne(p);
        store.reconcileList(SCOPE, values, { complete: true });
        await repo.putMany(values, SCOPE, { replaceScope: true });
        await repo.setCollection(SCOPE, {
          complete: true,
          nextCursor: null,
          fetchedAt: Date.now(),
        });
      },
    },
  );

  return {
    list,
    byId(id: string | null | undefined): ProjectSummary | undefined {
      return id ? (store.select(id) ?? list.data()?.find((p) => p.id === id)) : undefined;
    },
    all(): ProjectSummary[] | undefined {
      return list.data() ?? store.selectList(SCOPE);
    },
    status: statusOf(list),
  };
}
