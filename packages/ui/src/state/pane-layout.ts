export type Pane = "nav" | "participants" | "list" | "document";
export type PaneVisibility = "open" | "min";

export interface PaneLayout {
  nav: PaneVisibility;
  participants: PaneVisibility;
  list: PaneVisibility;
  maximized: Pane | null;
  listWidth: number;
  v: 1;
}

export type PaneLayoutAction =
  | { type: "minimize"; pane: Pane }
  | { type: "restore"; pane: Exclude<Pane, "document"> }
  | { type: "toggle-maximize"; pane: Pane }
  | { type: "set-list-width"; width: number };

export const PANE_LAYOUT_STORAGE_KEY = "lore.ui.paneLayout";
export const DEFAULT_LIST_WIDTH = 340;
export const MIN_LIST_WIDTH = 280;
export const MAX_LIST_WIDTH = 640;

export const DEFAULT_PANE_LAYOUT: PaneLayout = {
  nav: "open",
  participants: "open",
  list: "open",
  maximized: null,
  listWidth: DEFAULT_LIST_WIDTH,
  v: 1,
};

export function clampListWidth(width: number): number {
  return Math.max(MIN_LIST_WIDTH, Math.min(MAX_LIST_WIDTH, width));
}

export function reducePaneLayout(
  state: PaneLayout,
  action: PaneLayoutAction,
): PaneLayout {
  switch (action.type) {
    case "minimize":
      if (action.pane === "document") return state;
      return {
        ...state,
        [action.pane]: "min",
        maximized: state.maximized === action.pane ? null : state.maximized,
      };
    case "restore":
      return { ...state, [action.pane]: "open" };
    case "toggle-maximize":
      return {
        ...state,
        maximized: state.maximized === action.pane ? null : action.pane,
      };
    case "set-list-width":
      return { ...state, listWidth: clampListWidth(action.width) };
  }
}

export function readPaneLayout(raw: string | null): PaneLayout {
  if (!raw) return { ...DEFAULT_PANE_LAYOUT };
  try {
    const value: unknown = JSON.parse(raw);
    if (!isPaneLayout(value)) {
      return { ...DEFAULT_PANE_LAYOUT };
    }
    return { ...value, listWidth: clampListWidth(value.listWidth) };
  } catch {
    return { ...DEFAULT_PANE_LAYOUT };
  }
}

export function loadPaneLayout(): PaneLayout {
  try {
    return readPaneLayout(
      globalThis.localStorage?.getItem(PANE_LAYOUT_STORAGE_KEY) ?? null,
    );
  } catch {
    return { ...DEFAULT_PANE_LAYOUT };
  }
}

export function savePaneLayout(layout: PaneLayout): void {
  try {
    globalThis.localStorage?.setItem(
      PANE_LAYOUT_STORAGE_KEY,
      JSON.stringify(layout),
    );
  } catch {
    // The workspace remains usable when browser storage is unavailable.
  }
}

function isPaneLayout(value: unknown): value is PaneLayout {
  if (!value || typeof value !== "object") return false;
  const parsed = value as Partial<PaneLayout>;
  return (
    parsed.v === 1 &&
    (parsed.nav === "open" || parsed.nav === "min") &&
    (parsed.participants === "open" || parsed.participants === "min") &&
    (parsed.list === "open" || parsed.list === "min") &&
    (parsed.maximized === null ||
      parsed.maximized === "nav" ||
      parsed.maximized === "participants" ||
      parsed.maximized === "list" ||
      parsed.maximized === "document") &&
    typeof parsed.listWidth === "number" &&
    Number.isFinite(parsed.listWidth)
  );
}
