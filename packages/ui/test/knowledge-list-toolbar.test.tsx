import { MemoryRouter, Route } from "@solidjs/router";
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KnowledgeListToolbar } from "~/components/lore/KnowledgeListToolbar";
import { DEFAULT_KNOWLEDGE_QUERY, type KnowledgeQuery } from "~/contracts";

function mount(initial: KnowledgeQuery = DEFAULT_KNOWLEDGE_QUERY) {
  const [query, setQuery] = createSignal(initial);
  const change = vi.fn((next: KnowledgeQuery) => setQuery(next));
  render(() => (
    <MemoryRouter>
      <Route
        path="*"
        component={() => (
          <KnowledgeListToolbar
            query={query()}
            count={4}
            tableHref="/projects/p/knowledge"
            onChange={change}
          />
        )}
      />
    </MemoryRouter>
  ));
  return { change, query };
}

async function choose(label: string, option: string) {
  fireEvent.pointerDown(
    screen.getByRole("button", { name: new RegExp(`^${label}`) }),
    { pointerId: 1, button: 0 },
  );
  fireEvent.click(await screen.findByRole("option", { name: option }));
}

describe.each(["desktop", "mobile"] as const)(
  "Knowledge list filters on %s",
  (device) => {
    beforeEach(() => {
      vi.stubGlobal("matchMedia", (query: string) => ({
        matches: query === "(min-width: 48rem)" && device === "desktop",
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }));
    });
    afterEach(() => vi.unstubAllGlobals());
    it("uses the correct responsive presentation", () => {
      mount();
      fireEvent.click(screen.getByRole("button", { name: "Filters" }));
      expect(
        screen.getByRole("dialog", { name: "Knowledge filters" }),
      ).toHaveAttribute(
        "data-filter-presentation",
        device === "mobile" ? "sheet" : "popover",
      );
      expect(screen.queryByRole("button", { name: "Dismiss" }) !== null).toBe(
        device === "mobile",
      );
    });
    it("applies category and scope together without disturbing search or a custom sort", async () => {
      const initial: KnowledgeQuery = {
        q: "SQLite",
        category: null,
        scope: null,
        sort: [
          { field: "title", dir: "desc" },
          { field: "confidence", dir: "asc" },
        ],
        cursor: "older",
      };
      const { change, query } = mount(initial);
      fireEvent.click(screen.getByRole("button", { name: "Filters" }));
      await choose("Category", "Decisions");
      await choose("Scope", "Project + shared");
      expect(change).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Apply filters" }));
      expect(query()).toEqual({
        ...initial,
        category: "decision",
        scope: "all",
        cursor: null,
      });
      await waitFor(() =>
        expect(
          screen.queryByRole("dialog", { name: "Knowledge filters" }),
        ).toBeNull(),
      );
      fireEvent.click(
        screen.getByRole("button", { name: "Remove category: Decisions" }),
      );
      expect(query()).toEqual({
        ...initial,
        category: null,
        scope: "all",
        cursor: null,
      });
      fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
      expect(query()).toEqual({
        ...initial,
        q: "",
        category: null,
        scope: null,
        cursor: null,
      });
      expect(
        screen.getByRole("textbox", { name: "Filter knowledge list" }),
      ).toHaveValue("");
    });

    it("discards unapplied filter changes when dismissed and reopens from the applied state", async () => {
      const { change } = mount();
      fireEvent.click(screen.getByRole("button", { name: "Filters" }));
      await choose("Category", "Gotchas");
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(change).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Filters" }));
      expect(
        screen.getByRole("button", { name: /^Category/ }),
      ).toHaveTextContent("All categories");
      fireEvent.click(screen.getByRole("button", { name: "Apply filters" }));
      expect(change).toHaveBeenLastCalledWith(DEFAULT_KNOWLEDGE_QUERY);
    });

    it("offers both directions for each supported sort and preserves filters", async () => {
      const { query } = mount({
        ...DEFAULT_KNOWLEDGE_QUERY,
        category: "gotcha",
        scope: "shared",
        cursor: "older",
      });
      await choose("List sort", "Lowest confidence");
      expect(query()).toEqual({
        ...DEFAULT_KNOWLEDGE_QUERY,
        category: "gotcha",
        scope: "shared",
        sort: [{ field: "confidence", dir: "asc" }],
        cursor: null,
      });
    });
  },
);
