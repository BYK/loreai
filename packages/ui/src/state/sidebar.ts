import { createRoot, createSignal } from "solid-js";

export const SIDEBAR_STORAGE_KEY = "lore.ui.sidebarCollapsed";

function createSidebar() {
  let initial = false;
  try {
    initial = globalThis.localStorage?.getItem(SIDEBAR_STORAGE_KEY) === "true";
  } catch {
    /* Storage is optional. */
  }
  const [collapsed, setCollapsed] = createSignal(initial);
  const persist = (next: boolean) => {
    setCollapsed(next);
    try {
      globalThis.localStorage?.setItem(SIDEBAR_STORAGE_KEY, String(next));
    } catch {
      /* Keep the current session usable without storage. */
    }
  };
  return {
    collapsed,
    setCollapsed: persist,
    toggle: () => persist(!collapsed()),
  };
}

let store: ReturnType<typeof createSidebar> | undefined;
export function sidebar() {
  return (store ??= createRoot(createSidebar));
}
export function resetSidebarForTests() {
  store = undefined;
}
