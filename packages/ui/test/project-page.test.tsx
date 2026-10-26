import { MemoryRouter, Route, createMemoryHistory } from "@solidjs/router";
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";

import { ProjectPage } from "~/components/lore/ProjectPage";
import { WorkspaceProvider } from "~/routes/workspace";
import { ApiError, type ApiClient } from "~/lib/api";
import type { ProjectSummary, SharingStatus } from "~/contracts";

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
  last_activity: null,
};

const client = {
  listProjects: async () => [project],
  listProjectSessionsPage: async () => ({ items: [], next_cursor: null }),
  listProjectKnowledgePage: async () => ({ items: [], next_cursor: null }),
  getProjectSharing: async () => ({
    linked: false,
    team: null,
    policy: {
      effective: "manual",
      project_override: null,
      team_default: null,
    },
    auto_share: false,
    review_required: null,
    state: "not_linked",
    detail: null,
  }),
} as unknown as ApiClient;

function mountProject(apiClient: ApiClient) {
  return render(() => (
    <MemoryRouter>
      <Route
        path="*"
        component={() => (
          <WorkspaceProvider client={apiClient} db={Promise.resolve(null)}>
            <ProjectPage project={project} />
          </WorkspaceProvider>
        )}
      />
    </MemoryRouter>
  ));
}

const linkedAuto: SharingStatus = {
  linked: true,
  team: { id: "team-acme", name: "Acme" },
  policy: {
    effective: "auto",
    project_override: "auto",
    team_default: "auto",
  },
  auto_share: true,
  review_required: false,
  state: "linked",
  detail: null,
};

describe("ProjectPage", () => {
  it("bounds recent knowledge previews to the first recorded line", async () => {
    const { default: entries } = await import("./fixtures/knowledge-list.json");
    const entry = entries[0];
    if (!entry) throw new Error("Missing knowledge fixture");
    mountProject({
      ...client,
      listProjectKnowledgePage: async () => ({
        items: [
          {
            ...entry,
            id: "long-preview",
            title: "Bounded preview",
            content: "A".repeat(200) + "\nHidden second line",
          },
        ],
        next_cursor: null,
      }),
    });
    const link = await screen.findByRole("link", { name: /Bounded preview/ });
    expect(link).toHaveTextContent("A".repeat(119) + "…");
    expect(link.textContent).not.toContain("A".repeat(120));
    expect(link.textContent).not.toContain("Hidden second line");
    expect(link).toHaveAttribute(
      "href",
      "/projects/p-1/knowledge/long-preview",
    );
  });
  it("shows a memory summary and up to five recent knowledge entries", async () => {
    const { default: entries } = await import("./fixtures/knowledge-list.json");
    const entry = entries[0];
    if (!entry) throw new Error("Missing knowledge fixture");
    const listProjectKnowledgePage = async () => ({
      items: Array.from({ length: 6 }, (_, i) => ({
        ...entry,
        id: `entry-${i}`,
        title: `Recent entry ${i}`,
        project_id: project.id,
      })),
      next_cursor: null,
    });
    mountProject({
      ...client,
      listProjectKnowledgePage,
    });
    expect(screen.getByText("Memory summary")).toBeInTheDocument();
    expect(
      await screen.findByRole("link", { name: /Recent entry 0/ }),
    ).toHaveAttribute("href", "/projects/p-1/knowledge/entry-0");
    expect(screen.queryByRole("link", { name: /Recent entry 5/ })).toBeNull();
    expect(screen.queryByText(/health warnings/)).toBeNull();
  });

  it("reports a failed recent-session read without claiming no captured sessions", async () => {
    mountProject({
      ...client,
      listProjectSessionsPage: async () => {
        throw new Error("gateway unavailable");
      },
    });
    expect(
      await screen.findByText("Sessions could not be loaded"),
    ).toBeInTheDocument();
    expect(screen.queryByText("No captured sessions")).toBeNull();
  });

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
    expect(screen.getByText(/1 knowledge entry/)).toBeInTheDocument();
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
      auto_share: false,
      review_required: null,
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
      screen.getByRole("textbox", { name: "Search this project's memory" }),
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
    fireEvent.click(
      await screen.findByRole("option", { name: "Knowledge and memory files" }),
    );
    fireEvent.submit(screen.getByRole("search"));
    await waitFor(() =>
      expect(history.get()).toBe("/projects/p-1/search?scope=knowledge"),
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

  it("explains linked automatic sharing", async () => {
    mountProject({
      ...client,
      async getProjectSharing() {
        return linkedAuto;
      },
    });

    expect(
      await screen.findByText("Linked · Acme · policy: auto"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "New team knowledge is proposed automatically. Your team’s review rules still apply.",
      ),
    ).toBeInTheDocument();
  });

  it("labels a linked team with no name", async () => {
    mountProject({
      ...client,
      async getProjectSharing() {
        return {
          ...linkedAuto,
          team: { id: "team-acme", name: null },
        };
      },
    });

    expect(
      await screen.findByText("Linked · Unnamed team · policy: auto"),
    ).toBeInTheDocument();
  });

  it("shows locked sharing detail", async () => {
    mountProject({
      ...client,
      async getProjectSharing() {
        return {
          ...linkedAuto,
          state: "locked",
          detail: "Encryption keys are locked on this device",
        };
      },
    });

    expect(
      await screen.findByText("Encryption keys are locked on this device"),
    ).toBeInTheDocument();
    const state = screen
      .getByTestId("sharing-panel")
      .querySelector("[data-sharing-state]");
    expect(state?.getAttribute("data-sharing-state")).toBe("locked");
  });

  it("shows degraded status and inherited policy detail", async () => {
    mountProject({
      ...client,
      async getProjectSharing() {
        return {
          ...linkedAuto,
          state: "degraded",
          detail: "Not signed in; team content cannot sync",
          policy: {
            effective: "manual",
            project_override: null,
            team_default: "manual",
          },
        };
      },
    } as unknown as ApiClient);

    expect(
      await screen.findByText("Not signed in; team content cannot sync"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("sharing-panel")).toHaveTextContent(
      "Project preference: none · team default: manual",
    );
  });

  it("renders unauthorized sharing status as hidden", async () => {
    mountProject({
      ...client,
      async getProjectSharing() {
        throw new ApiError(
          "unauthorized",
          "/api/v1/projects/p-1/sharing",
          "hidden",
        );
      },
    });

    expect(
      await screen.findByText("Sharing status hidden"),
    ).toBeInTheDocument();
  });

  it("retries a failed sharing read", async () => {
    let attempts = 0;
    mountProject({
      ...client,
      async getProjectSharing() {
        attempts++;
        if (attempts === 1) throw new Error("sharing endpoint unavailable");
        return linkedAuto;
      },
    });

    expect(
      await screen.findByText("Sharing status not available"),
    ).toBeInTheDocument();
    expect(attempts).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(
      await screen.findByText("Linked · Acme · policy: auto"),
    ).toBeInTheDocument();
    expect(attempts).toBe(2);
  });
});
