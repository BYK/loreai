import {
  MemoryRouter,
  Route,
  createMemoryHistory,
  useLocation,
} from "@solidjs/router";
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";

import { KnowledgeTable } from "~/components/lore/KnowledgeTable";
import type {
  AllKnowledgeQuery,
  KnowledgeEntry,
  KnowledgeQuery,
} from "~/contracts";
import { knowledgeQueryToSearch, parseKnowledgeQuery } from "~/contracts";

const entry: KnowledgeEntry = {
  id: "k-1",
  project_id: "p-1",
  category: "gotcha",
  title: "<img onerror><script>",
  content: "<script>not executable</script>",
  confidence: 0.8,
  created_at: 1,
  updated_at: 2,
};

const defaultQuery: KnowledgeQuery = {
  q: "",
  category: null,
  scope: null,
  sort: [{ field: "updated_at", dir: "desc" }],
  cursor: null,
};

function mount(data = [entry], query: KnowledgeQuery = defaultQuery) {
  const page = {
    loader: {
      data: () => ({ items: data, next_cursor: null }),
      loading: () => false,
      error: () => undefined,
      reload: vi.fn(),
      stale: () => false,
    },
    status: () => ({ stale: false, partial: false }),
  };
  return render(() => (
    <MemoryRouter>
      <Route
        path="*"
        component={() => (
          <KnowledgeTable projectId="p-1" query={query} page={page} />
        )}
      />
    </MemoryRouter>
  ));
}

function mountRoutedTable(initialQuery: KnowledgeQuery = defaultQuery) {
  const history = createMemoryHistory();
  history.set({
    value: `/projects/p-1/knowledge${knowledgeQueryToSearch(initialQuery)}`,
  });
  const page = {
    loader: {
      data: () => ({ items: [entry], next_cursor: null }),
      loading: () => false,
      error: () => undefined,
      reload: vi.fn(),
      stale: () => false,
    },
    status: () => ({ stale: false, partial: false }),
  };
  const utils = render(() => (
    <MemoryRouter history={history}>
      <Route
        path="*"
        component={() => {
          const location = useLocation();
          const query = () =>
            parseKnowledgeQuery(
              Object.fromEntries(new URLSearchParams(location.search)),
            );
          return (
            <>
              <KnowledgeTable projectId="p-1" query={query()} page={page} />
              <output data-testid="route-search">{location.search}</output>
            </>
          );
        }}
      />
    </MemoryRouter>
  ));
  return { ...utils, history };
}

describe("KnowledgeTable", () => {
  it("renders server-provided order and escapes entry text", () => {
    mount();
    expect(screen.getByText("<img onerror><script>")).toBeInTheDocument();
    expect(
      screen.getByText("<script>not executable</script>"),
    ).toBeInTheDocument();
    expect(document.querySelector("img")).toBeNull();
  });

  it("marks only the selected row", () => {
    mount([entry]);
    expect(
      screen
        .getByRole("row", { name: /img onerror/ })
        .getAttribute("aria-selected"),
    ).toBeNull();
  });

  it("exposes server sorting and filter controls", () => {
    mount();
    expect(screen.getByRole("search")).toBeInTheDocument();
    expect(
      screen.getByRole("textbox", { name: "Knowledge search" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "Sort by Updated, level 1, descending",
      }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "sort" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: /sort/i })).toBeNull();
  });

  it("clears scope to the omitted default and resets the cursor", async () => {
    mountRoutedTable({ ...defaultQuery, cursor: "next" });

    fireEvent.pointerDown(screen.getByRole("button", { name: /^scope\b/ }), {
      button: 0,
      pointerType: "mouse",
    });
    fireEvent.click(await screen.findByRole("option", { name: /^project$/ }));
    await waitFor(() =>
      expect(screen.getByTestId("route-search")).toHaveTextContent(
        "?scope=project",
      ),
    );

    fireEvent.pointerDown(screen.getByRole("button", { name: /^scope\b/ }), {
      button: 0,
      pointerType: "mouse",
    });
    fireEvent.click(await screen.findByRole("option", { name: /^Any scope$/ }));
    await waitFor(() =>
      expect(screen.getByTestId("route-search").textContent).toBe(""),
    );
  });

  it("renders stacked sort labels, accessible state, and server sort values", () => {
    mount([entry], {
      ...defaultQuery,
      sort: [
        { field: "title", dir: "asc" },
        { field: "confidence", dir: "desc" },
      ],
    });
    expect(
      screen.getByRole("button", {
        name: "Sort by Title, level 1, ascending",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "Sort by Confidence, level 2, descending",
      }),
    ).toBeInTheDocument();
    const titleHeader = screen
      .getByRole("button", { name: "Sort by Title, level 1, ascending" })
      .closest("th");
    const confidenceHeader = screen
      .getByRole("button", {
        name: "Sort by Confidence, level 2, descending",
      })
      .closest("th");
    expect(titleHeader).toHaveAttribute("aria-sort", "ascending");
    expect(confidenceHeader).toHaveAttribute("aria-sort", "none");
    expect(
      screen.getByRole("table").querySelector("caption"),
    ).toHaveTextContent(
      "Sorted by Title ↑, then Confidence ↓ · page of up to 50",
    );
    expect(screen.queryByText("title_asc")).toBeNull();
  });

  it("keeps malicious markup inert", () => {
    mount();
    expect(document.querySelector("script")).toBeNull();
    expect(document.querySelector("img")).toBeNull();
  });

  it("renders server order without client filtering", () => {
    const second = { ...entry, id: "k-2", title: "Earlier server row" };
    mount([entry, second]);
    expect(
      screen
        .getAllByTestId("knowledge-row")
        .map((r) => r.getAttribute("data-knowledge-id")),
    ).toEqual(["k-1", "k-2"]);
  });

  it("marks the keyboard-active row", () => {
    mount();
    expect(screen.getByTestId("knowledge-row")).toHaveAttribute("data-active");
  });

  it("provides tabbable sortable column headers with a primary aria-sort", () => {
    mount();
    const title = screen.getByRole("button", { name: "Sort by Title" });
    const updated = screen.getByRole("button", {
      name: "Sort by Updated, level 1, descending",
    });
    expect(title).toHaveAttribute("type", "button");
    expect(title.closest("th")).toHaveAttribute("aria-sort", "none");
    expect(updated.closest("th")).toHaveAttribute("aria-sort", "descending");
  });

  it("describes server sorting in the table caption, including Created", () => {
    const view = mount();
    expect(
      screen.getByText("Sorted by Updated ↓ · page of up to 50"),
    ).toBeInTheDocument();
    view.unmount();
    mount([entry], {
      ...defaultQuery,
      sort: [{ field: "created_at", dir: "asc" }],
    });
    expect(screen.getByText(/Sorted by Created ↑/)).toBeInTheDocument();
  });

  it("stacks, toggles, removes, and caps header sorts while clearing cursors", async () => {
    const first = mountRoutedTable({ ...defaultQuery, cursor: "next" });
    fireEvent.click(screen.getByRole("button", { name: "Sort by Confidence" }));
    await waitFor(() =>
      expect(screen.getByTestId("route-search")).toHaveTextContent(
        "?sort=confidence%3Adesc%2Cupdated_at%3Adesc",
      ),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "Sort by Updated, level 2, descending",
      }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("route-search")).toHaveTextContent(
        "?sort=updated_at%3Adesc%2Cconfidence%3Adesc",
      ),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "Sort by Updated, level 1, descending",
      }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("route-search")).toHaveTextContent(
        "?sort=updated_at%3Aasc%2Cconfidence%3Adesc",
      ),
    );

    first.unmount();
    const capped = mountRoutedTable({
      ...defaultQuery,
      sort: [
        { field: "created_at", dir: "desc" },
        { field: "confidence", dir: "asc" },
        { field: "updated_at", dir: "asc" },
      ],
    });
    fireEvent.click(
      screen.getAllByRole("button", { name: "Sort by Title" })[0]!,
    );
    await waitFor(() =>
      expect(screen.getByTestId("route-search")).toHaveTextContent(
        "?sort=title%3Aasc%2Ccreated_at%3Adesc%2Cconfidence%3Aasc",
      ),
    );
    capped.unmount();
  });

  it("renders empty filtered state", () => {
    mount([], { ...defaultQuery, q: "missing" });
    expect(
      screen.getByText("No knowledge matches these filters"),
    ).toBeInTheDocument();
  });

  it("renders empty default state", () => {
    mount([]);
    expect(screen.getByText("No knowledge extracted yet")).toBeInTheDocument();
  });

  it("supports keyboard row focus", () => {
    const second = { ...entry, id: "k-2", title: "Second row" };
    mount([entry, second]);
    const rows = screen.getAllByTestId("knowledge-row");
    const first = rows[0];
    const next = rows[1];
    if (!first || !next) throw new Error("Expected two knowledge rows");
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(document.activeElement).toBe(next);
    fireEvent.keyDown(next, { key: "ArrowUp" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: "Enter" });
    expect(first).toBeInTheDocument();
  });

  it("keeps the search form available for cursor-reset navigation", () => {
    mount([entry], { ...defaultQuery, cursor: "next" });
    const input = screen.getByRole("textbox", { name: "Knowledge search" });
    expect(input).toHaveValue("");
    fireEvent.input(input, { target: { value: "sqlite" } });
    expect(input).toHaveValue("sqlite");
  });

  it("renders a loading state", () => {
    const page = {
      loader: {
        data: () => undefined,
        loading: () => true,
        error: () => undefined,
        reload: vi.fn(),
        stale: () => false,
      },
      status: () => ({ stale: false, partial: false }),
    };
    render(() => (
      <MemoryRouter>
        <Route
          path="*"
          component={() => (
            <KnowledgeTable projectId="p-1" query={defaultQuery} page={page} />
          )}
        />
      </MemoryRouter>
    ));
    expect(screen.getByText("Loading knowledge")).toBeInTheDocument();
  });

  it("renders a retry action for errors", () => {
    const reload = vi.fn();
    const page = {
      loader: {
        data: () => undefined,
        loading: () => false,
        error: () => new Error("down"),
        reload,
        stale: () => false,
      },
      status: () => ({ stale: false, partial: false }),
    };
    render(() => (
      <MemoryRouter>
        <Route
          path="*"
          component={() => (
            <KnowledgeTable projectId="p-1" query={defaultQuery} page={page} />
          )}
        />
      </MemoryRouter>
    ));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(reload).toHaveBeenCalled();
  });

  it("supports route-mode entry links and a non-sortable project column", () => {
    const query: AllKnowledgeQuery = {
      ...defaultQuery,
      project: "p-1",
    };
    const shared = {
      ...entry,
      id: "k-shared",
      project_id: null,
      project_name: null,
    };
    const crossProject = {
      ...entry,
      id: "k-cross-project",
      project_id: "p-2",
      cross_project: 1,
      project_name: "Scratch",
    };
    const rows = [{ ...entry, project_name: "Lore" }, shared, crossProject];
    const entryRoute = vi.fn(() => "/knowledge/k-1");
    const routes = {
      list: vi.fn(() => "/knowledge"),
      entry: entryRoute,
      defaultQuery: { ...defaultQuery, project: null },
    };
    const page = {
      loader: {
        data: () => ({ items: rows, next_cursor: null }),
        loading: () => false,
        error: () => undefined,
        reload: vi.fn(),
        stale: () => false,
      },
      status: () => ({ stale: false, partial: false }),
    };
    render(() => (
      <MemoryRouter>
        <Route
          path="*"
          component={() => (
            <KnowledgeTable
              routes={routes}
              query={query}
              page={page}
              showProject
            />
          )}
        />
      </MemoryRouter>
    ));

    expect(
      screen.getByRole("columnheader", { name: "project" }),
    ).not.toHaveAttribute("aria-sort");
    expect(screen.getByText("Lore")).toBeInTheDocument();
    const sharedRow = screen.getByText("No project").closest("tr");
    if (!sharedRow) throw new Error("Missing shared knowledge row");
    expect(sharedRow).toHaveTextContent("shared");
    expect(sharedRow).toHaveTextContent("No project");
    const crossProjectRow = screen
      .getByText("Scratch", { exact: true })
      .closest("tr");
    if (!crossProjectRow)
      throw new Error("Missing cross-project knowledge row");
    expect(crossProjectRow).toHaveTextContent("shared");
    expect(crossProjectRow).toHaveTextContent("Scratch");
    const firstRow = screen.getAllByTestId("knowledge-row")[0];
    if (!firstRow) throw new Error("Expected a knowledge table row");
    fireEvent.click(firstRow);
    expect(entryRoute).toHaveBeenCalledWith("k-1", query);
  });

  it("counts extra filters in the empty state and clears to the route default", () => {
    const defaultAllQuery: AllKnowledgeQuery = {
      ...defaultQuery,
      project: null,
    };
    const listRoute = vi.fn(() => "/knowledge");
    const page = {
      loader: {
        data: () => ({ items: [], next_cursor: null }),
        loading: () => false,
        error: () => undefined,
        reload: vi.fn(),
        stale: () => false,
      },
      status: () => ({ stale: false, partial: false }),
    };
    render(() => (
      <MemoryRouter>
        <Route
          path="*"
          component={() => (
            <KnowledgeTable
              routes={{
                list: listRoute,
                entry: () => "/knowledge/k-1",
                defaultQuery: defaultAllQuery,
              }}
              query={{ ...defaultAllQuery, project: "missing-project" }}
              page={page}
              extraFilters={<span>Project filter</span>}
              extraFiltersActive
            />
          )}
        />
      </MemoryRouter>
    ));

    expect(
      screen.getByText("No knowledge matches these filters"),
    ).toBeInTheDocument();
    expect(screen.getByText("Project filter")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(listRoute).toHaveBeenCalledWith(defaultAllQuery);
  });
});
