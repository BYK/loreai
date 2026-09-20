import { MemoryRouter, Route, createMemoryHistory } from "@solidjs/router";
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";

import { SearchResults } from "~/components/lore/SearchResults";
import { WorkspaceProvider } from "~/routes/workspace";
import type { ApiClient } from "~/lib/api";
import type { ProjectSummary } from "~/contracts";

const project: ProjectSummary = {
  id: "p-1",
  path: "/tmp/project",
  name: "project",
  git_remote: null,
  created_at: 1,
  knowledge_count: 0,
  session_count: 0,
  message_count: 0,
  distillation_count: 0,
};

const client = {
  listProjects: async () => [project],
  listProjectSessionsPage: async () => ({ items: [], next_cursor: null }),
  getProjectSharing: async () => ({ enabled: false }),
} as unknown as ApiClient;

const recallClient = {
  ...client,
  recall: async () => ({
    query: "SQLite",
    scope: "all",
    projectPath: project.path,
    result: "No results found for this query.",
  }),
} as unknown as ApiClient;

describe("SearchResults", () => {
  it("prompts for a query before making recall output", () => {
    render(() => (
      <MemoryRouter>
        <Route
          path="*"
          component={() => (
            <WorkspaceProvider client={client} db={Promise.resolve(null)}>
              <SearchResults project={project} q="" scope="all" />
            </WorkspaceProvider>
          )}
        />
      </MemoryRouter>
    ));
    expect(
      screen.getByText("Type a query to search this project's memory"),
    ).toBeInTheDocument();
  });

  it("renders an accessible search form", () => {
    render(() => (
      <MemoryRouter>
        <Route
          path="*"
          component={() => (
            <WorkspaceProvider client={client} db={Promise.resolve(null)}>
              <SearchResults project={project} q="" scope="all" />
            </WorkspaceProvider>
          )}
        />
      </MemoryRouter>
    ));
    expect(screen.getByRole("search")).toBeInTheDocument();
    expect(
      screen.getByRole("textbox", { name: "Search query" }),
    ).toBeInTheDocument();
  });

  it("renders the scope selector", () => {
    render(() => (
      <MemoryRouter>
        <Route
          path="*"
          component={() => (
            <WorkspaceProvider client={client} db={Promise.resolve(null)}>
              <SearchResults project={project} q="" scope="all" />
            </WorkspaceProvider>
          )}
        />
      </MemoryRouter>
    ));
    expect(
      screen.getByRole("button", { name: /Search scope/ }),
    ).toBeInTheDocument();
  });

  it("submits the selected recall scope", async () => {
    const history = createMemoryHistory();
    history.set({ value: "/projects/p-1/search?q=SQLite&scope=all" });
    render(() => (
      <MemoryRouter history={history}>
        <Route
          path="*"
          component={() => (
            <WorkspaceProvider client={client} db={Promise.resolve(null)}>
              <SearchResults project={project} q="SQLite" scope="all" />
            </WorkspaceProvider>
          )}
        />
      </MemoryRouter>
    ));
    fireEvent.pointerDown(
      screen.getByRole("button", { name: /Search scope/ }),
      {
        button: 0,
        pointerType: "mouse",
      },
    );
    fireEvent.click(await screen.findByRole("option", { name: "knowledge" }));
    fireEvent.submit(screen.getByRole("search"));
    await waitFor(() =>
      expect(history.get()).toBe(
        "/projects/p-1/search?q=SQLite&scope=knowledge",
      ),
    );
  });

  it("does not render recall headings for an empty query", () => {
    render(() => (
      <MemoryRouter>
        <Route
          path="*"
          component={() => (
            <WorkspaceProvider client={client} db={Promise.resolve(null)}>
              <SearchResults project={project} q="" scope="all" />
            </WorkspaceProvider>
          )}
        />
      </MemoryRouter>
    ));
    expect(
      screen.queryByRole("heading", { name: "Recall Results" }),
    ).toBeNull();
  });

  it("documents expansion-disabled recall behavior", () => {
    render(() => (
      <MemoryRouter>
        <Route
          path="*"
          component={() => (
            <WorkspaceProvider client={client} db={Promise.resolve(null)}>
              <SearchResults project={project} q="" scope="all" />
            </WorkspaceProvider>
          )}
        />
      </MemoryRouter>
    ));
    expect(screen.getByText(/expansion is disabled/)).toBeInTheDocument();
  });

  it("renders the query field as a controlled input", () => {
    render(() => (
      <MemoryRouter>
        <Route
          path="*"
          component={() => (
            <WorkspaceProvider client={client} db={Promise.resolve(null)}>
              <SearchResults project={project} q="SQLite" scope="all" />
            </WorkspaceProvider>
          )}
        />
      </MemoryRouter>
    ));
    expect(screen.getByRole("textbox", { name: "Search query" })).toHaveValue(
      "SQLite",
    );
  });

  it("renders exact no-results output", async () => {
    render(() => (
      <MemoryRouter>
        <Route
          path="*"
          component={() => (
            <WorkspaceProvider client={recallClient} db={Promise.resolve(null)}>
              <SearchResults project={project} q="SQLite" scope="all" />
            </WorkspaceProvider>
          )}
        />
      </MemoryRouter>
    ));
    expect(await screen.findByText("No results")).toBeInTheDocument();
  });

  it("renders a loading state before recall resolves", () => {
    const pending = {
      ...client,
      recall: () => new Promise<never>(() => {}),
    } as unknown as ApiClient;
    render(() => (
      <MemoryRouter>
        <Route
          path="*"
          component={() => (
            <WorkspaceProvider client={pending} db={Promise.resolve(null)}>
              <SearchResults project={project} q="SQLite" scope="all" />
            </WorkspaceProvider>
          )}
        />
      </MemoryRouter>
    ));
    expect(screen.getByText("Searching memory")).toBeInTheDocument();
  });

  it("renders a shared recall error state", async () => {
    const broken = {
      ...client,
      recall: async () => {
        throw new Error("down");
      },
    } as unknown as ApiClient;
    render(() => (
      <MemoryRouter>
        <Route
          path="*"
          component={() => (
            <WorkspaceProvider client={broken} db={Promise.resolve(null)}>
              <SearchResults project={project} q="SQLite" scope="all" />
            </WorkspaceProvider>
          )}
        />
      </MemoryRouter>
    ));
    expect(
      await screen.findByRole("button", { name: "Retry" }),
    ).toBeInTheDocument();
  });
});
