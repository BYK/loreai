import { MemoryRouter, Route } from "@solidjs/router";
import { fireEvent, render, screen } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";

import { KnowledgeTable } from "~/components/lore/KnowledgeTable";
import type { KnowledgeEntry, KnowledgeQuery } from "~/contracts";

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
  sort: "updated_desc",
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
      screen.getByRole("button", { name: "Sort Updated" }),
    ).toBeInTheDocument();
  });

  it("renders human sort labels while preserving server values", () => {
    mount([entry], { ...defaultQuery, sort: "title_asc" });
    expect(
      screen.getByRole("button", { name: "Sort Title A–Z" }),
    ).toBeInTheDocument();
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

  it("provides sortable column headers", () => {
    mount();
    expect(screen.getByRole("columnheader", { name: "title" })).toHaveAttribute(
      "aria-sort",
    );
  });

  it("describes server sorting in the table caption", () => {
    mount();
    expect(screen.getByText(/Sorted on the server/)).toBeInTheDocument();
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
});
