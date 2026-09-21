/**
 * Entities screen state: a keyset-paged list over `GET /api/v1/entities`,
 * per-entity detail loaders, metadata PATCH / DELETE writes that reconcile
 * into the store + IndexedDB projection, and the in-flight rebuild signal.
 *
 * Caching mirrors knowledge.ts: only the default first page (no type filter,
 * no cursor) and fetched details land in the `entities` store; every write
 * fills `item` so a detail write can never evict a row from the cached list.
 */
import { createMemo, createSignal, type Accessor } from "solid-js";

import type {
  EntityDetail,
  EntityListItem,
  EntityListPage,
  EntityRebuildResult,
} from "~/contracts";
import type { ApiClient } from "~/lib/api";
import type { CachedEntity, Repository } from "~/db";
import { createLoader, type Loader } from "~/lib/loader";

import { createEntityStore } from "./entity-store";
import { statusOf, type KeyStatus } from "./status";

export const ENTITY_PAGE_SIZE = 50;
const LIST_SCOPE = "all";

/** Code-unit comparison: the gateway sorts with `<`, not a locale collation. */
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Matches the gateway's `(entity_type, canonical_name, id)` keyset order. */
const LIST_ORDER = (a: EntityListItem, b: EntityListItem) =>
  cmp(a.entity_type, b.entity_type) ||
  cmp(a.canonical_name, b.canonical_name) ||
  cmp(a.id, b.id);

export interface EntityListSource {
  type: string | null;
  /** Previous page's `next_cursor` token; null = first page. */
  cursor: string | null;
}

export interface RebuildState {
  phase: "idle" | "checking" | "running" | "cancelling" | "done" | "error";
  /** True when the running rebuild was started by this client (Cancel shown
   *  either way — the POST resolves when the rebuild settles). */
  dryRun: boolean;
  /** True when `phase === "running"` but the rebuild started elsewhere. */
  external: boolean;
  result?: EntityRebuildResult;
  error?: unknown;
}

export interface EntitiesDeps {
  client: ApiClient;
  repo: Repository<CachedEntity>;
  tracked: <T>(read: () => Promise<T>) => Promise<T>;
}

export function createEntitiesState({ client, repo, tracked }: EntitiesDeps) {
  const store = createEntityStore<EntityDetail["entity"]>((e) => e.id);

  // Bumping the nonce refetches the active page loaders (post-write
  // invalidation — the keyset cursor of a previous page may have vanished).
  const [listNonce, setListNonce] = createSignal(0);

  /** Cache a list row; a `detail` already stored for the id is preserved. */
  async function cacheItem(item: EntityListItem): Promise<void> {
    const existing = await repo.get(item.id);
    await repo.put({ id: item.id, item, detail: existing?.detail }, LIST_SCOPE);
  }

  /** Cache a detail; its `entity` minus metadata is the list projection. */
  async function putDetail(detail: EntityDetail): Promise<void> {
    const { metadata: _metadata, ...item } = detail.entity;
    await repo.put({ id: detail.entity.id, item, detail }, LIST_SCOPE);
  }

  function page(source: Accessor<EntityListSource | null>): {
    loader: Loader<EntityListPage>;
    status: Accessor<KeyStatus>;
  } {
    const keyed = createMemo(() => {
      const value = source();
      return value
        ? {
            ...value,
            key: `${value.type ?? ""}|${value.cursor ?? ""}|${listNonce()}`,
          }
        : null;
    });
    const loader = createLoader(
      () => keyed()?.key ?? null,
      (key, signal) => {
        const value = keyed();
        if (!value || value.key !== key)
          throw new Error("Entity list query changed");
        return tracked(() =>
          client.listEntities(
            { type: value.type, page: value.cursor, limit: ENTITY_PAGE_SIZE },
            signal,
          ),
        );
      },
      {
        async cached() {
          const value = keyed();
          if (!value || value.type !== null || value.cursor !== null) {
            return undefined;
          }
          const [rows, collection] = await Promise.all([
            repo.getScope(LIST_SCOPE),
            repo.collection(LIST_SCOPE),
          ]);
          if (!collection) return undefined;
          const sorted = rows.map((r) => r.item).sort(LIST_ORDER);
          for (const item of sorted)
            store.reconcileOne({ ...item, metadata: null });
          return {
            value: {
              entities: sorted.slice(0, ENTITY_PAGE_SIZE),
              next_cursor: collection.nextCursor,
              total: collection.count,
            },
            // Rows lost to TTL/LRU eviction (or a delete) → mark partial.
            partial: rows.length !== collection.count,
          };
        },
        async onServer(_, value) {
          for (const item of value.entities) {
            store.reconcileOne({ ...item, metadata: null });
          }
          for (const item of value.entities) await cacheItem(item);
          const value2 = keyed();
          if (value2 && value2.type === null && value2.cursor === null) {
            await repo.setCollection(LIST_SCOPE, {
              complete: value.next_cursor === null,
              count: value.total,
              nextCursor: value.next_cursor,
              fetchedAt: Date.now(),
            });
          }
        },
      },
    );
    return { loader, status: statusOf(loader) };
  }

  function detail(id: Accessor<string | null>): {
    loader: Loader<EntityDetail>;
    status: Accessor<KeyStatus>;
  } {
    const loader = createLoader(
      id,
      (entityId, signal) => tracked(() => client.getEntity(entityId, signal)),
      {
        async cached(entityId) {
          const record = await repo.get(entityId);
          return record?.detail;
        },
        async onServer(_, value) {
          store.reconcileOne(value.entity);
          await putDetail(value);
        },
      },
    );
    return { loader, status: statusOf(loader) };
  }

  async function updateMetadata(
    id: string,
    patch: {
      role?: string | null;
      description?: string | null;
      notes?: string | null;
    },
  ): Promise<EntityDetail> {
    const detail = await tracked(() => client.updateEntityMetadata(id, patch));
    store.reconcileOne(detail.entity);
    await putDetail(detail);
    return detail;
  }

  async function remove(id: string): Promise<void> {
    await tracked(() => client.deleteEntity(id));
    store.remove(id);
    await repo.delete(id);
    // The first page's cached count is now wrong — the next list load marks
    // itself partial until the server answers, which is the honest state.
    setListNonce((n) => n + 1);
  }

  // ---------------------------------------------------------------------
  // Rebuild signal
  // ---------------------------------------------------------------------

  const [rebuild, setRebuild] = createSignal<RebuildState>({
    phase: "idle",
    dryRun: false,
    external: false,
  });

  /** On-mount probe: is a rebuild already in flight (started elsewhere)? */
  async function checkRebuildStatus(): Promise<void> {
    setRebuild((r) =>
      r.phase === "running" || r.phase === "cancelling"
        ? r
        : { ...r, phase: "checking" },
    );
    try {
      const { active } = await tracked(() => client.getEntityRebuildStatus());
      setRebuild((r) =>
        r.phase === "running" || r.phase === "cancelling"
          ? r
          : {
              phase: active ? "running" : "idle",
              dryRun: false,
              external: active,
            },
      );
    } catch {
      // A failed probe (offline, unauthorized) is not "idle" — surface it.
      setRebuild((r) =>
        r.phase === "running" || r.phase === "cancelling"
          ? r
          : { ...r, phase: "idle" },
      );
    }
  }

  async function startRebuild(dryRun: boolean): Promise<void> {
    if (rebuild().phase === "running" || rebuild().phase === "cancelling") {
      return;
    }
    setRebuild({ phase: "running", dryRun, external: false });
    try {
      const result = await tracked(() => client.rebuildEntities({ dryRun }));
      setRebuild({ phase: "done", dryRun, external: false, result });
      setListNonce((n) => n + 1);
    } catch (error) {
      setRebuild({ phase: "error", dryRun, external: false, error });
    }
  }

  async function cancelRebuild(): Promise<void> {
    const current = rebuild();
    if (current.phase !== "running") return;
    setRebuild({ ...current, phase: "cancelling" });
    try {
      await tracked(() => client.cancelEntityRebuild());
    } catch (error) {
      setRebuild({
        phase: "error",
        dryRun: current.dryRun,
        external: false,
        error,
      });
    }
    // The rebuild POST resolves with `cancelled: true` when it notices; for
    // an externally-started rebuild there is nothing to await — flip back so
    // the next status check decides.
    setRebuild((r) =>
      r.phase === "cancelling" ? { ...r, phase: "running" } : r,
    );
  }

  function resetRebuild(): void {
    setRebuild({ phase: "idle", dryRun: false, external: false });
  }

  return {
    page,
    detail,
    updateMetadata,
    remove,
    rebuild,
    checkRebuildStatus,
    startRebuild,
    cancelRebuild,
    resetRebuild,
    select: (id: string) => store.select(id),
    store,
  };
}
