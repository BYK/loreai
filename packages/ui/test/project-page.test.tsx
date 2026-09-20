import { MemoryRouter, Route, createMemoryHistory } from "@solidjs/router";
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";

import { ProjectPage } from "~/components/lore/ProjectPage";
import { WorkspaceProvider } from "~/routes/workspace";
import type { ApiClient } from "~/lib/api";
import type { ProjectSummary } from "~/contracts";

const project: ProjectSummary = {
  id: "p-1",
  path: "/tmp/project",
  name: "project",
  git_remote: null,
  created_at: 1,
  knowledge_count: 1,
  session_count: 0,
  message_count: 0,
  distillation_count: 0,
};

const client = {
  listProjects: async () => [project],
  listProjectSessionsPage: async () => ({ items: [], next_cursor: null }),
  getProjectSharing: async () => ({
    linked: false,
    team: null,
    policy: {
      effective: "manual",
      project_override: null,
      team_default: null,
    },
    state: "not_linked",
    detail: null,
  }),
} as unknown as ApiClient;

describe("ProjectPage", () => {
  it("offers project-level knowledge navigation", () => {
    render(() => (
      <MemoryRouter>
        <Route
          path="*"
          component={() => (
            <WorkspaceProvider client={client} db={Promise.resolve(null)}>
              <ProjectPage project={project} />
            </WorkspaceProvider>
          )}
        />
      </MemoryRouter>
    ));
    expect(
      screen.getByRole("link", { name: /Browse knowledge/i }),
    ).toHaveAttribute("href", "/projects/p-1/knowledge");
  });

  it("shows local-only identity", () => {
    render(() => (
      <MemoryRouter>
        <Route
          path="*"
          component={() => (
            <WorkspaceProvider client={client} db={Promise.resolve(null)}>
              <ProjectPage project={project} />
            </WorkspaceProvider>
          )}
        />
      </MemoryRouter>
    ));
    expect(
      screen.getByText("local path only (no remote recorded)"),
    ).toBeInTheDocument();
  });

  it("shows recorded counts", () => {
    render(() => (
      <MemoryRouter>
        <Route
          path="*"
          component={() => (
            <WorkspaceProvider client={client} db={Promise.resolve(null)}>
              <ProjectPage project={project} />
            </WorkspaceProvider>
          )}
        />
      </MemoryRouter>
    ));
    expect(screen.getByText(/1 knowledge/)).toBeInTheDocument();
  });

  it("shows the no-sessions health hint", () => {
    render(() => (
      <MemoryRouter>
        <Route
          path="*"
          component={() => (
            <WorkspaceProvider client={client} db={Promise.resolve(null)}>
              <ProjectPage project={project} />
            </WorkspaceProvider>
          )}
        />
      </MemoryRouter>
    ));
    expect(screen.getByText(/No captured sessions yet/)).toBeInTheDocument();
  });

  it("shows sharing status when available", async () => {
    render(() => (
      <MemoryRouter>
        <Route
          path="*"
          component={() => (
            <WorkspaceProvider client={client} db={Promise.resolve(null)}>
              <ProjectPage project={project} />
            </WorkspaceProvider>
          )}
        />
      </MemoryRouter>
    ));
    expect(
      await screen.findByText(/Not linked · No team · policy: manual/),
    ).toBeInTheDocument();
    expect(screen.getByText("0 messages")).toBeInTheDocument();
    expect(screen.queryByText("Select an entry to inspect it.")).toBeNull();
  });

  it("shows sharing loading state while the request is pending", () => {
    let resolveSharing:
      | ((
          value: Awaited<
            ReturnType<NonNullable<ApiClient["getProjectSharing"]>>
          >,
        ) => void)
      | undefined;
    const pending = {
      ...client,
      getProjectSharing: () =>
        new Promise((resolve) => {
          resolveSharing = resolve;
        }),
    } as unknown as ApiClient;
    render(() => (
      <MemoryRouter>
        <Route
          path="*"
          component={() => (
            <WorkspaceProvider client={pending} db={Promise.resolve(null)}>
              <ProjectPage project={project} />
            </WorkspaceProvider>
          )}
        />
      </MemoryRouter>
    ));
    expect(screen.getByText("Loading sharing status")).toBeInTheDocument();
    expect(screen.queryByText("Sharing status not available")).toBeNull();
    resolveSharing?.({
      linked: false,
      team: null,
      policy: {
        effective: "manual",
        project_override: null,
        team_default: null,
      },
      state: "not_linked",
      detail: null,
    });
  });

  it("shows recent sessions navigation", () => {
    render(() => (
      <MemoryRouter>
        <Route
          path="*"
          component={() => (
            <WorkspaceProvider client={client} db={Promise.resolve(null)}>
              <ProjectPage project={project} />
            </WorkspaceProvider>
          )}
        />
      </MemoryRouter>
    ));
    expect(screen.getByRole("link", { name: /All sessions/ })).toHaveAttribute(
      "href",
      "/projects/p-1/sessions",
    );
  });

  it("shows the project search link", () => {
    render(() => (
      <MemoryRouter>
        <Route
          path="*"
          component={() => (
            <WorkspaceProvider client={client} db={Promise.resolve(null)}>
              <ProjectPage project={project} />
            </WorkspaceProvider>
          )}
        />
      </MemoryRouter>
    ));
    expect(
      screen.getByRole("textbox", { name: "Search project memory" }),
    ).toBeInTheDocument();
  });

  it("submits the selected recall scope", async () => {
    const history = createMemoryHistory();
    history.set({ value: "/projects/p-1" });
    render(() => (
      <MemoryRouter history={history}>
        <Route
          path="*"
          component={() => (
            <WorkspaceProvider client={client} db={Promise.resolve(null)}>
              <ProjectPage project={project} />
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
      expect(history.get()).toBe("/projects/p-1/search?q=&scope=knowledge"),
    );
  });

  it("shows no sharing fallback when sharing is unavailable", async () => {
    const unavailable = {
      ...client,
      getProjectSharing: async () => {
        throw new Error("down");
      },
    } as unknown as ApiClient;
    render(() => (
      <MemoryRouter>
        <Route
          path="*"
          component={() => (
            <WorkspaceProvider client={unavailable} db={Promise.resolve(null)}>
              <ProjectPage project={project} />
            </WorkspaceProvider>
          )}
        />
      </MemoryRouter>
    ));
    expect(
      await screen.findByText("Sharing status not available"),
    ).toBeInTheDocument();
  });
});
