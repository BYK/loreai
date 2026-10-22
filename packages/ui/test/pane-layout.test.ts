import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_PANE_LAYOUT,
  MAX_LIST_WIDTH,
  MIN_LIST_WIDTH,
  PANE_LAYOUT_STORAGE_KEY,
  readPaneLayout,
  reducePaneLayout,
  loadPaneLayout,
  savePaneLayout,
} from "~/state/pane-layout";

describe("pane layout reducer", () => {
  it("minimizes and restores navigation and participants", () => {
    const minimized = reducePaneLayout(DEFAULT_PANE_LAYOUT, {
      type: "minimize",
      pane: "nav",
    });
    expect(minimized.nav).toBe("min");
    expect(minimized.participants).toBe("open");
    expect(
      reducePaneLayout(minimized, { type: "restore", pane: "nav" }).nav,
    ).toBe("open");
    const minimizedList = reducePaneLayout(DEFAULT_PANE_LAYOUT, {
      type: "minimize",
      pane: "list",
    });
    expect(minimizedList.list).toBe("min");
    expect(
      reducePaneLayout(minimizedList, { type: "restore", pane: "list" }).list,
    ).toBe("open");
  });

  it("maximizes a pane without changing other panes and restores it on toggle", () => {
    const partlyMinimized = reducePaneLayout(DEFAULT_PANE_LAYOUT, {
      type: "minimize",
      pane: "participants",
    });
    const maximized = reducePaneLayout(partlyMinimized, {
      type: "toggle-maximize",
      pane: "document",
    });
    expect(maximized.maximized).toBe("document");
    expect(maximized.participants).toBe("min");
    expect(
      reducePaneLayout(maximized, {
        type: "toggle-maximize",
        pane: "document",
      }),
    ).toEqual(partlyMinimized);
  });

  it("does not minimize the document", () => {
    expect(
      reducePaneLayout(DEFAULT_PANE_LAYOUT, {
        type: "minimize",
        pane: "document",
      }),
    ).toEqual(DEFAULT_PANE_LAYOUT);
  });

  it("restores other panes when minimizing the maximized pane", () => {
    const maximized = reducePaneLayout(DEFAULT_PANE_LAYOUT, {
      type: "toggle-maximize",
      pane: "list",
    });
    const minimized = reducePaneLayout(maximized, {
      type: "minimize",
      pane: "list",
    });
    expect(minimized.list).toBe("min");
    expect(minimized.maximized).toBeNull();
  });

  it("restores navigation while another pane is maximized", () => {
    const navMinimized = reducePaneLayout(DEFAULT_PANE_LAYOUT, {
      type: "minimize",
      pane: "nav",
    });
    const maximized = reducePaneLayout(navMinimized, {
      type: "toggle-maximize",
      pane: "document",
    });
    const restored = reducePaneLayout(maximized, {
      type: "restore",
      pane: "nav",
    });

    expect(restored.nav).toBe("open");
    expect(restored.maximized).toBeNull();
  });

  it("restores the list while navigation is maximized", () => {
    const listMinimized = reducePaneLayout(DEFAULT_PANE_LAYOUT, {
      type: "minimize",
      pane: "list",
    });
    const maximized = reducePaneLayout(listMinimized, {
      type: "toggle-maximize",
      pane: "nav",
    });
    const restored = reducePaneLayout(maximized, {
      type: "restore",
      pane: "list",
    });

    expect(restored.list).toBe("open");
    expect(restored.maximized).toBeNull();
  });

  it("clamps list width to the supported bounds", () => {
    expect(
      reducePaneLayout(DEFAULT_PANE_LAYOUT, {
        type: "set-list-width",
        width: MIN_LIST_WIDTH - 1,
      }).listWidth,
    ).toBe(MIN_LIST_WIDTH);
    expect(
      reducePaneLayout(DEFAULT_PANE_LAYOUT, {
        type: "set-list-width",
        width: MAX_LIST_WIDTH + 1,
      }).listWidth,
    ).toBe(MAX_LIST_WIDTH);
  });
});

describe("pane layout persistence", () => {
  beforeEach(() => localStorage.clear());

  it("uses defaults for malformed and unsupported storage", () => {
    expect(readPaneLayout("{broken")).toEqual(DEFAULT_PANE_LAYOUT);
    expect(readPaneLayout(JSON.stringify({ v: 0 }))).toEqual(
      DEFAULT_PANE_LAYOUT,
    );
  });

  it("clamps an out-of-range width from supported storage", () => {
    const layout = {
      ...DEFAULT_PANE_LAYOUT,
      listWidth: 999,
    };
    expect(readPaneLayout(JSON.stringify(layout)).listWidth).toBe(
      MAX_LIST_WIDTH,
    );
  });

  it("round-trips stored pane choices", () => {
    const layout = {
      ...DEFAULT_PANE_LAYOUT,
      nav: "min" as const,
      maximized: "document" as const,
      listWidth: 420,
    };
    savePaneLayout(layout);
    expect(localStorage.getItem(PANE_LAYOUT_STORAGE_KEY)).toBe(
      JSON.stringify(layout),
    );
    expect(loadPaneLayout()).toEqual(layout);
  });

  it("swallows storage access failures", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    expect(loadPaneLayout()).toEqual(DEFAULT_PANE_LAYOUT);
    expect(() => savePaneLayout(DEFAULT_PANE_LAYOUT)).not.toThrow();
  });
});
