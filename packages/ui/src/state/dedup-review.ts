import {
  createReviewDecisionsStore,
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
      return withStore(
        (store) => store.get(reviewMarkKey(projectId, groupId)),
        undefined,
      );
    },
    list(projectId: string) {
      return withStore((store) => store.list(projectId), []);
    },
    put(mark: DedupReviewMark) {
      return withStore(async (store) => {
        await store.put(mark);
        return true;
      }, false);
    },
    delete(projectId: string, groupId: string) {
      return withStore(async (store) => {
        await store.delete(reviewMarkKey(projectId, groupId));
        return true;
      }, false);
    },
  };
}

export type DedupReviewState = ReturnType<typeof createDedupReviewState>;
