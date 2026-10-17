import {
  createReviewDecisionsStore,
  type DedupApplyRecord,
  type DedupReviewMark,
  type LoreUiDb,
} from "~/db";

export function reviewMarkKey(projectId: string, groupId: string): string {
  return `${projectId}/${groupId}`;
}

export function createDedupReviewState(db: () => Promise<LoreUiDb | null>) {
  const inMemory = createReviewDecisionsStore(null);
  const withStore = async <T>(
    operation: (
      store: ReturnType<typeof createReviewDecisionsStore>,
    ) => Promise<T>,
    fallback: T,
  ): Promise<T> => {
    try {
      const handle = await db();
      return await operation(
        handle ? createReviewDecisionsStore(handle) : inMemory,
      );
    } catch {
      return fallback;
    }
  };

  return {
    get(projectId: string, groupId: string) {
      return withStore(async (store) => {
        const record = await store.get(reviewMarkKey(projectId, groupId));
        return record?.kind === "dedup" ? record : undefined;
      }, undefined);
    },
    list(projectId: string) {
      return withStore(
        async (store) =>
          (await store.list(projectId)).filter(
            (record): record is DedupReviewMark => record.kind === "dedup",
          ),
        [],
      );
    },
    listApplies(projectId: string) {
      return withStore(
        async (store) =>
          (await store.list(projectId)).filter(
            (record): record is DedupApplyRecord =>
              record.kind === "dedup-apply",
          ),
        [],
      );
    },
    put(mark: DedupReviewMark) {
      return withStore(async (store) => {
        await store.put(mark);
        return true;
      }, false);
    },
    putApply(record: DedupApplyRecord) {
      return (async () => {
        try {
          const handle = await db();
          if (!handle) return false;
          await createReviewDecisionsStore(handle).put(record);
          return true;
        } catch {
          return false;
        }
      })();
    },
    delete(projectId: string, groupId: string) {
      return withStore(async (store) => {
        await store.delete(reviewMarkKey(projectId, groupId));
        return true;
      }, false);
    },
    deleteApply(record: DedupApplyRecord) {
      return (async () => {
        try {
          const handle = await db();
          if (!handle) return false;
          await createReviewDecisionsStore(handle).delete(record.key);
          return true;
        } catch {
          return false;
        }
      })();
    },
    async persistent(): Promise<boolean> {
      try {
        return (await db()) !== null;
      } catch {
        return false;
      }
    },
  };
}

export type DedupReviewState = ReturnType<typeof createDedupReviewState>;
