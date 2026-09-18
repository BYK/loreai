import type { Accessor } from "solid-js";
import { createSignal } from "solid-js";

import type { KnowledgeEntry } from "~/contracts";
import type { ApiClient } from "~/lib/api";
import type { Repository } from "~/db";
import { createLoader, type Loader } from "~/lib/loader";

import { createEntityStore } from "./entity-store";
import { mergeCursorPage, type MergedPage } from "./pages";
import { statusOf, type KeyStatus } from "./status";

export interface KnowledgeDeps {
  client: ApiClient;
  repo: Repository<KnowledgeEntry>;
  tracked: <T>(read: () => Promise<T>) => Promise<T>;
}

/** `ltm.forProject` order — cached rows must render in the server's order. */
const LIST_ORDER = (a: KnowledgeEntry, b: KnowledgeEntry) =>
  b.confidence - a.confidence || (b.updated_at ?? 0) - (a.updated_at ?? 0);

export function createKnowledgeState({ client, repo, tracked }: KnowledgeDeps) {
  const store = createEntityStore<KnowledgeEntry>((k) => k.id);

  function list(projectId: Accessor<string | null>): {
    loader: Loader<KnowledgeEntry[]>;
    status: Accessor<KeyStatus>;
  } {
    const loader = createLoader(
      projectId,
      (id, signal) => tracked(() => client.listProjectKnowledge(id, signal)),
      {
        async cached(id) {
          const [rows, collection] = await Promise.all([
            repo.getScope(id),
            repo.collection(id),
          ]);
          if (!collection) return undefined;
          const sorted = [...rows].sort(LIST_ORDER);
          for (const k of sorted) store.reconcileOne(k);
          return {
            value: sorted,
            // Rows lost to TTL/LRU eviction → render them, marked partial.
            partial: rows.length !== collection.count,
          };
        },
        async onServer(id, values) {
          for (const k of values) store.reconcileOne(k);
          store.reconcileList(id, values, { complete: true });
          await repo.putMany(values, id, { replaceScope: true });
          await repo.setCollection(id, {
            complete: true,
            count: values.length,
            nextCursor: null,
            fetchedAt: Date.now(),
          });
        },
      },
    );
    return { loader, status: statusOf(loader) };
  }

  /**
   * Cursor-paged variant (`?page=cursor`), for the branch that adds it.
   * `partial` stays true until the gateway reports `next_cursor === null`.
   * Not wired into Browse yet — unit-tested only.
   */
  function listPaged(projectId: string): {
    page: Accessor<MergedPage<KnowledgeEntry> | undefined>;
    status: Accessor<KeyStatus>;
    loadMore(): Promise<void>;
    loading: Accessor<boolean>;
  } {
    const [page, setPage] = createSignal<MergedPage<KnowledgeEntry>>();
    const [loading, setLoading] = createSignal(false);
    const [error, setError] = createSignal<unknown>(undefined);
    const status: Accessor<KeyStatus> = () => ({
      loading: loading(),
      stale: false,
      partial: page()?.complete === false,
      error: error(),
      source: "server" as const,
    });
    const loadMore = async () => {
      const cursor = page()?.nextCursor ?? null;
      if (page() && cursor === null) return;
      setLoading(true);
      try {
        const next = await tracked(() =>
          client.listProjectKnowledgePage(projectId, cursor),
        );
        setPage((prev) => mergeCursorPage(prev, next, (k) => k.id));
      } catch (reason) {
        setError(reason);
        throw reason;
      } finally {
        setLoading(false);
      }
    };
    return { page, status, loadMore, loading };
  }

  function entry(id: Accessor<string | null>): {
    loader: Loader<KnowledgeEntry>;
    status: Accessor<KeyStatus>;
  } {
    const loader = createLoader(
      id,
      (entryId, signal) => tracked(() => client.getKnowledge(entryId, signal)),
      {
        cached: (entryId) => repo.get(entryId),
        async onServer(_, value) {
          store.reconcileOne(value);
          await repo.put(value, value.project_id ?? "");
        },
      },
    );
    return { loader, status: statusOf(loader) };
  }

  return {
    list,
    listPaged,
    entry,
    select: (id: string) => store.select(id),
    selectList: (projectId: string) => store.selectList(projectId),
    store,
  };
}
