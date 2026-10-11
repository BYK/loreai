import { createRoot, createSignal } from "solid-js";

export const SAVED_SEARCHES_STORAGE_KEY = "lore.ui.savedSearches";

export type SavedSearch = {
  id: string;
  title: string;
  query: string;
};

function readStored(): SavedSearch[] {
  try {
    const value: unknown = JSON.parse(
      globalThis.localStorage?.getItem(SAVED_SEARCHES_STORAGE_KEY) ?? "[]",
    );
    if (!Array.isArray(value)) return [];
    return value.filter(
      (entry): entry is SavedSearch =>
        typeof entry === "object" &&
        entry !== null &&
        typeof entry.id === "string" &&
        typeof entry.title === "string" &&
        typeof entry.query === "string",
    );
  } catch {
    return [];
  }
}

function writeStored(searches: readonly SavedSearch[]): void {
  try {
    globalThis.localStorage?.setItem(
      SAVED_SEARCHES_STORAGE_KEY,
      JSON.stringify(searches),
    );
  } catch {
    // Storage may be unavailable; keep the in-memory list usable.
  }
}

function createStore() {
  return createRoot(() => {
    const [searches, setSearches] = createSignal(readStored());
    const replace = (next: SavedSearch[]) => {
      setSearches(next);
      writeStored(next);
    };
    return {
      list: searches,
      save(search: Omit<SavedSearch, "id">): SavedSearch {
        const saved = { ...search, id: crypto.randomUUID() };
        replace([...searches(), saved]);
        return saved;
      },
      update(id: string, update: Omit<SavedSearch, "id">): void {
        replace(
          searches().map((search) =>
            search.id === id ? { ...search, ...update } : search,
          ),
        );
      },
      remove(id: string): void {
        replace(searches().filter((search) => search.id !== id));
      },
    };
  });
}

let store: ReturnType<typeof createStore> | null = null;

export function savedSearches(): ReturnType<typeof createStore> {
  store ??= createStore();
  return store;
}

export function resetSavedSearchesForTests(): void {
  store = null;
}
