import {
  MemoryRouter,
  Route,
  createMemoryHistory,
  useLocation,
} from "@solidjs/router";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";
import type { ProjectSummary } from "~/contracts";
import { ProjectDirectory } from "~/components/lore/ProjectDirectory";
import { WorkspaceProvider } from "~/routes/workspace";
import type { ApiClient } from "~/lib/api";
import { directoryProjects } from "~/lib/project-directory";

const project = (
  id: string,
  overrides: Partial<ProjectSummary> = {},
): ProjectSummary => ({
  id,
  name: "Same name",
  path: `/work/${id}`,
  git_remote: null,
  created_at: 1,
  last_activity: null,
  knowledge_count: 0,
  session_count: 0,
  message_count: 0,
  distillation_count: 0,
  ...overrides,
});
const ids = (projects: readonly ProjectSummary[]) => projects.map((p) => p.id);

describe("directoryProjects", () => {
  it("groups only exact nonempty recorded remotes and preserves all checkout identities", () => {
    const result = directoryProjects(
      [
        project("a", { git_remote: "git@host:repo.git" }),
        project("b", { git_remote: "git@host:repo.git" }),
        project("c", { git_remote: "https://host/repo.git" }),
        project("d", { git_remote: " git@host:repo.git " }),
        project("e", { git_remote: "  " }),
        project("f"),
      ],
      "",
      "name",
    );
    expect(result.repositories.map((group) => ids(group.projects))).toEqual([
      ["a", "b"],
      ["c"],
      ["d"],
    ]);
    expect(ids(result.local)).toEqual(["e", "f"]);
  });

  it("filters every child before grouping so an older checkout remains discoverable", () => {
    const rows = [
      project("new", { git_remote: "remote", last_activity: 10 }),
      project("older", {
        name: "Release checkout",
        git_remote: "remote",
        last_activity: 2,
      }),
    ];
    expect(
      ids(
        directoryProjects(rows, " release ", "recent").repositories[0]
          ?.projects ?? [],
      ),
    ).toEqual(["older"]);
    expect(
      ids(
        directoryProjects(rows, "remote", "recent").repositories[0]?.projects ??
          [],
      ),
    ).toEqual(["new", "older"]);
  });

  it("separates only recorded unattributed buckets, including a bucket with a remote", () => {
    const rows = [
      project("u", {
        path: "/__lore_unattributed__/session",
        git_remote: "remote",
      }),
      project("root", { path: "/__lore_unattributed__" }),
      project("real", {
        path: "/__lore_unattributed__-real",
        name: "(unattributed) real",
      }),
    ];
    const result = directoryProjects(rows, "", "name");
    expect(ids(result.unattributed)).toEqual(["root", "u"]);
    expect(ids(result.local)).toEqual(["real"]);
    expect(result.repositories).toEqual([]);
  });

  it("sorts deterministically without mutating frozen source records", () => {
    const rows = Object.freeze([
      Object.freeze(
        project("z", { name: "Zebra", knowledge_count: 8, last_activity: 5 }),
      ),
      Object.freeze(
        project("b", { name: "Alpha", knowledge_count: 2, last_activity: 9 }),
      ),
      Object.freeze(
        project("a", { name: "Alpha", knowledge_count: 2, last_activity: 9 }),
      ),
    ]);
    expect(ids(directoryProjects(rows, "", "recent").local)).toEqual([
      "a",
      "b",
      "z",
    ]);
    expect(ids(directoryProjects(rows, "", "name").local)).toEqual([
      "a",
      "b",
      "z",
    ]);
    expect(ids(directoryProjects(rows, "", "knowledge").local)).toEqual([
      "z",
      "a",
      "b",
    ]);
    expect(ids(rows)).toEqual(["z", "b", "a"]);
  });
});

function mount(
  rows: ProjectSummary[],
  url = "/knowledge",
  sessionsMode = false,
) {
  const history = createMemoryHistory();
  history.set({ value: url });
  const view = render(() => (
    <MemoryRouter history={history}>
      <Route
        path="*"
        component={() => {
          const location = useLocation();
          return (
            <WorkspaceProvider
              db={Promise.resolve(null)}
              client={{ listProjects: async () => rows } as ApiClient}
            >
              <ProjectDirectory projects={rows} sessionsMode={sessionsMode} />
              <output data-testid="search">{location.search}</output>
            </WorkspaceProvider>
          );
        }}
      />
    </MemoryRouter>
  ));
  return { ...view, history };
}

describe("ProjectDirectory", () => {
  it("uses compact rows for every group with wrapping labels and native checkout links", () => {
    const long = "checkout".repeat(40);
    const view = mount([
      project("one", {
        name: long,
        path: `/work/${long}`,
        git_remote: "remote",
      }),
      project("two", { git_remote: "remote" }),
      project("local"),
      project("unattributed", { path: "/__lore_unattributed__/capture" }),
    ]);
    const links = screen.getAllByTestId("project-card");
    expect(links).toHaveLength(4);
    for (const link of links) {
      expect(link).not.toHaveClass("min-h-36");
      expect(link.querySelector("button, a, summary")).toBeNull();
    }
    expect(screen.getByText(long)).toHaveClass("[overflow-wrap:anywhere]");
    expect(screen.getByText(`/work/${long}`)).toHaveClass(
      "[overflow-wrap:anywhere]",
    );
    expect(
      screen.getByRole("region", { name: "Local projects" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "Unattributed sessions" }),
    ).toBeInTheDocument();
    const link = links[0]!;
    const event = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
    });
    link.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(view.history.get()).toBe("/knowledge");
  });

  it("lays out repository groups once while keeping every checkout reachable", () => {
    mount([
      project("single", { git_remote: "remote-one" }),
      project("new", { git_remote: "remote-two", last_activity: 10 }),
      project("older", { git_remote: "remote-two", last_activity: 1 }),
    ]);
    const groups = screen.getByRole("list", { name: "Repository groups" });
    expect(groups.children).toHaveLength(2);
    const single = groups.querySelector('[data-repository="remote-one"]');
    const multiple = groups.querySelector('[data-repository="remote-two"]');
    expect(single).toBeInTheDocument();
    expect(multiple).toBeInTheDocument();
    expect(
      within(single as HTMLElement).getByTestId("project-card"),
    ).toHaveAttribute("href", "/projects/single");
    expect(
      within(multiple as HTMLElement)
        .getAllByTestId("project-card")
        .map((link) => link.getAttribute("href")),
    ).toEqual(["/projects/new", "/projects/older"]);
  });

  it("keeps each checkout link and restores URL filter/sort state", async () => {
    mount(
      [
        project("new", { git_remote: "remote", last_activity: 10 }),
        project("older", { git_remote: "remote" }),
      ],
      "/knowledge?projectFilter=older&projectSort=name",
    );
    expect(screen.getAllByTestId("project-card")).toHaveLength(1);
    expect(screen.getByTestId("project-card")).toHaveAttribute(
      "href",
      "/projects/older",
    );
    fireEvent.input(screen.getByRole("textbox", { name: "Filter projects" }), {
      target: { value: "" },
    });
    await waitFor(() =>
      expect(screen.getAllByTestId("project-card")).toHaveLength(2),
    );
    expect(screen.getByTestId("search")).toHaveTextContent("projectSort=name");
  });

  it("changes the visible checkout order and persists the selected sort", async () => {
    mount([
      project("a", { knowledge_count: 1, last_activity: 20 }),
      project("b", { knowledge_count: 9, last_activity: 10 }),
    ]);
    expect(
      screen
        .getAllByTestId("project-card")
        .map((link) => link.getAttribute("href")),
    ).toEqual(["/projects/a", "/projects/b"]);
    fireEvent.pointerDown(
      screen.getByRole("button", { name: /^Sort projects/ }),
      { button: 0, pointerType: "mouse" },
    );
    fireEvent.click(
      await screen.findByRole("option", { name: "Knowledge count" }),
    );
    await waitFor(() =>
      expect(
        screen
          .getAllByTestId("project-card")
          .map((link) => link.getAttribute("href")),
      ).toEqual(["/projects/b", "/projects/a"]),
    );
    expect(screen.getByTestId("search")).toHaveTextContent(
      "projectSort=knowledge",
    );
  });

  it("preserves sessions destinations and offers recovery for an empty filter", async () => {
    mount([project("a")], "/sessions", true);
    expect(screen.getByTestId("project-card")).toHaveAttribute(
      "href",
      "/projects/a/sessions",
    );
    fireEvent.input(screen.getByRole("textbox", { name: "Filter projects" }), {
      target: { value: "missing" },
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "Clear project filter" }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("project-card")).toBeInTheDocument(),
    );
  });
});
