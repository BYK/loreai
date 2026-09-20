import { createMemo, type Accessor } from "solid-js";
import { createSignal } from "solid-js";

import type { KnowledgeEntry, KnowledgeVersionHistory } from "~/contracts";
import type { ApiClient } from "~/lib/api";
import type { Repository } from "~/db";
import { createLoader, type Loader } from "~/lib/loader";

import { createEntityStore } from "./entity-store";
import type { CursorPage, KnowledgeQuery } from "~/contracts";
import { mergeCursorPage, type MergedPage } from "./pages";
import {
  isDefaultKnowledgeQuery,
  KNOWLEDGE_PAGE_SIZE,
  knowledgeQueryKey,
} from "~/contracts";
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
  function page(
    source: Accessor<{
      projectId: string;
      query: KnowledgeQuery;
    } | null>,
  ): {
    loader: Loader<CursorPage<KnowledgeEntry>>;
    status: Accessor<KeyStatus>;
  } {
    const keyed = createMemo(() => {
      const value = source();
      return value
        ? { ...value, key: knowledgeQueryKey(value.projectId, value.query) }
        : null;
    });
    const loader = createLoader(
      () => keyed()?.key ?? null,
      (key, signal) => {
        const value = keyed();
        if (!value || value.key !== key)
          throw new Error("Knowledge query changed");
        return tracked(() =>
          client.listProjectKnowledgePage(
            value.projectId,
            {
              limit: KNOWLEDGE_PAGE_SIZE,
              q: value.query.q || undefined,
              category: value.query.category ?? undefined,
              scope: value.query.scope ?? undefined,
              sort: value.query.sort,
              cursor: value.query.cursor,
            },
            signal,
          ),
        );
      },
      {
        async cached() {
          const value = keyed();
          if (!value || !isDefaultKnowledgeQuery(value.query)) return undefined;
          const [rows, collection] = await Promise.all([
            repo.getScope(value.projectId),
            repo.collection(value.projectId),
          ]);
          if (!collection) return undefined;
          const items = [...rows].sort(
            (a, b) =>
              (b.updated_at ?? 0) - (a.updated_at ?? 0) ||
              b.id.localeCompare(a.id),
          );
          return {
            value: {
              items: items.slice(0, KNOWLEDGE_PAGE_SIZE),
              next_cursor: null,
            },
            partial: true,
          };
        },
        async onServer(_, value) {
          for (const item of value.items) {
            store.reconcileOne(item);
            await repo.put(item, item.project_id ?? "global", {
              keepScope: true,
            });
          }
        },
      },
    );
    return { loader, status: statusOf(loader) };
  }

  function listPaged(projectId: string): {
    page: Accessor<MergedPage<KnowledgeEntry> | undefined>;
    status: Accessor<KeyStatus>;
    loadMore: () => Promise<void>;
    loading: Accessor<boolean>;
  } {
    const [value, setValue] = createSignal<MergedPage<KnowledgeEntry>>();
    const [loading, setLoading] = createSignal(false);
    const [error, setError] = createSignal<unknown>();
    const loadMore = async () => {
      if (value()?.complete) return;
      setLoading(true);
      try {
        const next = await tracked(() =>
          client.listProjectKnowledgePage(projectId, {
            cursor: value()?.nextCursor ?? null,
          }),
        );
        setValue((previous) =>
          mergeCursorPage(previous, next, (entry) => entry.id),
        );
        setError(undefined);
      } catch (reason) {
        setError(reason);
        throw reason;
      } finally {
        setLoading(false);
      }
    };
    return {
      page: value,
      loadMore,
      loading,
      status: () => ({
        loading: loading(),
        stale: false,
        partial: value()?.complete === false,
        error: error(),
        source: "server" as const,
      }),
    };
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
          await repo.put(value, value.project_id ?? "global", {
            keepScope: true,
          });
        },
      },
    );
    return { loader, status: statusOf(loader) };
  }

  function versions(id: Accessor<string | null>): {
    loader: Loader<KnowledgeVersionHistory>;
    status: Accessor<KeyStatus>;
  } {
    const loader = createLoader(id, (entryId, signal) =>
      tracked(() => client.listKnowledgeVersions(entryId, { signal })),
    );
    return { loader, status: statusOf(loader) };
  }

  return {
    list,
    page,
    listPaged,
    entry,
    versions,
    select: (id: string) => store.select(id),
    selectList: (projectId: string) => store.selectList(projectId),
    store,
  };
}
