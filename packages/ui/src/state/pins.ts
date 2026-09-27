/**
 * Pinned sidebar projects (#1918). Local working state like the theme —
 * kept in localStorage under `lore.ui.pinnedProjects`, deliberately
 * OUTSIDE the disposable IndexedDB API cache so pins survive cache resets.
 * Storage is a JSON array of project ids in pin order (newest appended);
 * malformed or missing storage reads as []. Storage failures are swallowed
 * and pins still work in-memory. Pins are never pruned when a project
 * disappears from the list — Nav simply doesn't render unknown ids.
 */
import { createRoot, createSignal } from "solid-js";

export const PINNED_PROJECTS_STORAGE_KEY = "lore.ui.pinnedProjects";

function readStoredPins(): string[] {
  try {
    const raw = globalThis.localStorage?.getItem(PINNED_PROJECTS_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === "string");
  } catch {
    return [];
  }
}

function writeStoredPins(ids: readonly string[]): void {
  try {
    globalThis.localStorage?.setItem(
      PINNED_PROJECTS_STORAGE_KEY,
      JSON.stringify(ids),
    );
  } catch {
    // Private mode / storage disabled: pins still apply in-memory.
  }
}

function createPinsStore() {
  return createRoot(() => {
    const [ids, setIds] = createSignal<string[]>(readStoredPins());

    function isPinned(id: string): boolean {
      return ids().includes(id);
    }

    function toggle(id: string): void {
      const next = isPinned(id)
        ? ids().filter((pinned) => pinned !== id)
        : [...ids(), id];
      setIds(next);
      writeStoredPins(next);
    }

    return { pinned: ids, isPinned, toggle };
  });
}

export interface PinsStore {
  pinned(): readonly string[];
  isPinned(id: string): boolean;
  toggle(id: string): void;
}

let store: PinsStore | null = null;

export function pins(): PinsStore {
  store ??= createPinsStore();
  return store;
}

/** Test hook: discard the singleton so each test starts from storage. */
export function resetPinsStoreForTests(): void {
  store = null;
}
