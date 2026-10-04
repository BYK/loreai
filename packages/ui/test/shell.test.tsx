import { MemoryRouter, Route, createMemoryHistory } from "@solidjs/router";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@solidjs/testing-library";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { createAppRoot, routes } from "~/app";
import { Nav } from "~/components/shell/Nav";
import { knowledgeHref } from "~/lib/href";
import { ApiError, type ApiClient } from "~/lib/api";
import { ConnectionContext, createConnectionStore } from "~/lib/connection";
import type {
  KnowledgeEntry,
  KnowledgeSearchResponse,
  ProjectSummary,
} from "~/contracts";
import {
  closeLoreDb,
  createKnowledgeRepo,
  createProjectsRepo,
  openLoreDb,
  type LoreUiDb,
} from "~/db";
import { NOT_AVAILABLE_YET } from "~/components/lore/FutureAction";
import { resetThemeStoreForTests, THEME_STORAGE_KEY, theme } from "~/lib/theme";

const PROJECTS: ProjectSummary[] = [
  {
    id: "p-lore",
    path: "/home/me/lore",
    name: "lore",
    git_remote: "github.com/BYK/loreai",
    created_at: Date.UTC(2026, 8, 1, 10),
    knowledge_count: 2,
    session_count: 5,
    message_count: 90,
    distillation_count: 3,
    last_activity: Date.UTC(2026, 8, 2, 10),
  },
  {
    id: "p-empty",
    path: "/home/me/empty",
    name: "",
    git_remote: null,
    created_at: Date.UTC(2026, 8, 1, 10),
    knowledge_count: 0,
    session_count: 1,
    message_count: 2,
    distillation_count: 0,
    last_activity: Date.UTC(2026, 8, 1, 11),
  },
];

const ENTRIES: KnowledgeEntry[] = [
  {
    id: "k-sqlite",
    logical_id: "k-sqlite",
    project_id: "p-lore",
    category: "decision",
    title: "Keep SQLite",
    content: "Portability is a requirement.\n\nNo remote cache.",
    confidence: 0.92,
    cross_project: 0,
    source_session: "s-42",
    created_at: Date.UTC(2026, 8, 1, 10),
    updated_at: Date.UTC(2026, 8, 2, 10),
  },
  {
    id: "k-wal",
    logical_id: "k-wal",
    project_id: "p-lore",
    category: "gotcha",
    title: "WAL recovery",
    content: "Cover the WAL recovery path in tests.",
    confidence: 0.6,
    cross_project: 1,
    created_at: Date.UTC(2026, 8, 1, 10),
    updated_at: Date.UTC(2026, 8, 1, 10),
  },
];

function entryAt(index: number): KnowledgeEntry {
  const entry = ENTRIES[index];
  if (!entry) throw new Error(`Missing test knowledge entry ${index}`);
  return entry;
}

const ALL_ENTRIES = [
  { ...entryAt(0), project_name: "Lore workspace" },
  { ...entryAt(1), project_name: "Lore workspace" },
  {
    ...entryAt(0),
    id: "k-scratch",
    logical_id: "k-scratch",
    project_id: "p-empty",
    category: "pattern",
    title: "Scratch setting",
    project_name: "/home/me/empty",
  },
  {
    ...entryAt(1),
    id: "k-global",
    logical_id: "k-global",
    project_id: null,
    category: "preference",
    title: "Shared setting",
    cross_project: 1,
    project_name: null,
  },
];

function allEntryAt(index: number) {
  const entry = ALL_ENTRIES[index];
  if (!entry) throw new Error(`Missing cross-project test entry ${index}`);
  return entry;
}

type Overrides = Partial<{ [K in keyof ApiClient]: ApiClient[K] }>;

function fakeClient(overrides: Overrides = {}): ApiClient & {
  calls: string[];
  pageOpts: Array<{ projectId: string; opts: { cursor?: string | null } }>;
  allPageOpts: Array<{
    cursor?: string | null;
    project?: string;
    q?: string;
  }>;
  searchOpts: Array<{ q: string; limit?: number; project?: string }>;
} {
  const calls: string[] = [];
  const pageOpts: Array<{
    projectId: string;
    opts: { cursor?: string | null };
  }> = [];
  const allPageOpts: Array<{
    cursor?: string | null;
    project?: string;
    q?: string;
  }> = [];
  const searchOpts: Array<{ q: string; limit?: number; project?: string }> = [];
  let client!: ApiClient;
  const base = {
    async listProjects() {
      calls.push("projects");
      return PROJECTS;
    },
    async listProjectKnowledge(projectId: string) {
      calls.push(`knowledge:${projectId}`);
      if (projectId === "p-lore") return ENTRIES;
      if (projectId === "p-empty") return [];
      throw new ApiError(
        "not_found",
        `/projects/${projectId}/knowledge`,
        "Project not found",
        404,
      );
    },
    async listProjectKnowledgePage(
      projectId: string,
      opts: { cursor?: string | null },
    ) {
      pageOpts.push({ projectId, opts });
      const items = await client.listProjectKnowledge(projectId);
      return { items, next_cursor: null };
    },
    async listKnowledgePage(opts: {
      cursor?: string | null;
      project?: string;
      q?: string;
    }) {
      allPageOpts.push(opts);
      return {
        items: ALL_ENTRIES.filter(
          (entry) => !opts.project || entry.project_id === opts.project,
        ),
        next_cursor: null,
      };
    },
    async searchKnowledge(opts: {
      q: string;
      limit?: number;
      project?: string;
    }) {
      searchOpts.push(opts);
      const items = ALL_ENTRIES.filter(
        (entry) => !opts.project || entry.project_id === opts.project,
      ).map((entry) => ({ ...entry, rank: -0.5 }));
      return {
        query: opts.q,
        mode: "fts" as const,
        total: items.length,
        items,
      };
    },
    async listProjectSessionsPage() {
      return { items: [], next_cursor: null };
    },
    async getProjectSharing() {
      throw new ApiError(
        "not_found",
        "/projects/sharing",
        "Sharing is not configured",
        404,
      );
    },
    async getKnowledge(id: string) {
      calls.push(`entry:${id}`);
      const entry = [...ENTRIES, ...ALL_ENTRIES].find((e) => e.id === id);
      if (!entry) {
        throw new ApiError(
          "not_found",
          `/knowledge/${id}`,
          "Knowledge entry not found",
          404,
        );
      }
      return entry;
    },
    async listKnowledgeVersions(id: string) {
      return {
        id,
        current_version_id: `${id}-v1`,
        versions: [
          {
            version_id: `${id}-v1`,
            version: 1,
            created_at: Date.UTC(2026, 8, 2, 10),
            superseded_at: null,
            is_current: true,
            is_deleted: false,
            title: ENTRIES.find((entry) => entry.id === id)?.title ?? "Entry",
            content: "Version content",
            category:
              ENTRIES.find((entry) => entry.id === id)?.category ?? "decision",
            confidence: 0.9,
            scope: "project",
            cross_project: false,
            source_refs: {
              session_id: null,
              entry_id: id,
              user_id: null,
              created_by: null,
              updated_by: null,
              worker_provider_id: null,
              worker_model_id: null,
            },
          },
        ],
      };
    },
    async getSession() {
      return { messages: [], distillations: [] };
    },
  };
  client = Object.assign(base, overrides) as ApiClient;
  return Object.assign(client, { calls, pageOpts, allPageOpts, searchOpts });
}

function mount(
  path: string,
  client: ApiClient,
  db?: Promise<LoreUiDb | null>,
  base?: string,
) {
  const history = createMemoryHistory();
  history.set({ value: path });
  const utils = render(() => (
    <MemoryRouter
      base={base}
      history={history}
      root={createAppRoot(client, db)}
    >
      {routes}
    </MemoryRouter>
  ));
  return { ...utils, history };
}

function mountBaseNav(path: string) {
  const history = createMemoryHistory();
  history.set({ value: path });
  const utils = render(() => (
    <MemoryRouter base="/ui" history={history}>
      <Route
        path="*"
        component={() => (
          <ConnectionContext.Provider value={createConnectionStore()}>
            <Nav
              projects={PROJECTS}
              loading={false}
              error={null}
              activeProjectId={null}
              totalKnowledge={4}
            />
          </ConnectionContext.Provider>
        )}
      />
    </MemoryRouter>
  ));
  return { ...utils, history };
}

/** Seed a fake-indexeddb cache with the shared fixtures and hand it to mount. */
async function seededDb(): Promise<Promise<LoreUiDb | null>> {
  const { IDBFactory } = await import("./idb-globals");
  const factory = new IDBFactory();
  await closeLoreDb();
  const db = (await openLoreDb({ factory }))!;
  await createProjectsRepo(db).putMany(PROJECTS, "all", {
    replaceScope: true,
  });
  await createProjectsRepo(db).setCollection("all", {
    complete: true,
    count: 2,
    nextCursor: null,
    fetchedAt: Date.now(),
  });
  await createKnowledgeRepo(db).putMany(ENTRIES, "p-lore", {
    replaceScope: true,
  });
  await createKnowledgeRepo(db).setCollection("p-lore", {
    complete: true,
    count: 2,
    nextCursor: null,
    fetchedAt: Date.now(),
  });
  await createKnowledgeRepo(db).put(ENTRIES[0]!, "p-lore");
  // Return a pending-open promise so the memoised connection stays alive for
  // the mounted shell; `openLoreDb({factory})` memoises per options.
  return openLoreDb({ factory });
}

function isPreloadable(
  value: unknown,
): value is { preload: () => Promise<unknown> } {
  return (
    typeof value === "function" &&
    "preload" in value &&
    typeof value.preload === "function"
  );
}

function pane(name: "nav" | "list" | "detail"): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-pane="${name}"]`);
  if (!el) throw new Error(`no ${name} pane`);
  return el;
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.classList.remove("dark");
  resetThemeStoreForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetThemeStoreForTests();
});

describe("shell: project navigation and real-data path", () => {
  it("highlights workspace links relative to the router base", async () => {
    const { history } = mount("/ui", fakeClient(), undefined, "/ui");
    await screen.findByTestId("nav-projects");

    await waitFor(() =>
      expect(screen.getByTestId("nav-projects")).toHaveClass("bg-accent-soft"),
    );
    expect(screen.getByTestId("nav-all-knowledge")).not.toHaveClass(
      "bg-accent-soft",
    );

    history.set({ value: "/ui/knowledge" });
    await waitFor(() => {
      expect(screen.getByTestId("nav-all-knowledge")).toHaveClass(
        "bg-accent-soft",
      );
      expect(screen.getByTestId("nav-projects")).not.toHaveClass(
        "bg-accent-soft",
      );
    });
  });

  it("matches nav descendants under the /ui router base", async () => {
    const { history } = mountBaseNav("/ui");
    const navIds = [
      "nav-entities",
      "nav-contradictions",
      "nav-warming",
      "nav-costs",
    ] as const;
    const activeRoutes = [
      ["/ui/entities", "nav-entities"],
      ["/ui/entities/entity-1", "nav-entities"],
      ["/ui/contradictions", "nav-contradictions"],
      ["/ui/warming", "nav-warming"],
      ["/ui/costs", "nav-costs"],
    ] as const;

    for (const [path, activeId] of activeRoutes) {
      history.set({ value: path });
      await waitFor(() =>
        expect(screen.getByTestId(activeId)).toHaveClass("bg-accent-soft"),
      );
      for (const id of navIds) {
        if (id !== activeId) {
          expect(screen.getByTestId(id)).not.toHaveClass("bg-accent-soft");
        }
      }
    }
  });

  it("loads projects into the nav and shows the welcome document", async () => {
    const client = fakeClient();
    mount("/", client);
    const rows = await screen.findAllByTestId("nav-project");
    expect(rows.map((r) => r.textContent)).toEqual([
      "lore2",
      "/home/me/empty0", // nameless project falls back to its path
    ]);
    expect(
      screen.getByRole("heading", { name: "Choose a project" }),
    ).toBeVisible();
    expect(screen.getByTestId("connection-status")).toHaveAttribute(
      "data-connection",
      "reachable",
    );
    expect(client.calls).toEqual(["projects"]);
    // Only the nav + detail panes exist without a selected project.
    expect(document.querySelector('[data-pane="list"]')).toBeNull();
    expect(document.querySelector("[data-mobile-pane]")).toHaveAttribute(
      "data-mobile-pane",
      "nav",
    );
  });

  it("returns focus to the navigation opener when the drawer closes", async () => {
    const client = fakeClient();
    mount("/", client);
    const opener = await screen.findByTestId("open-nav");
    opener.focus();
    fireEvent.click(opener);
    await screen.findByTestId("nav-drawer");

    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => expect(screen.queryByTestId("nav-drawer")).toBeNull());
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it("focuses a replacement opener after the original is removed", async () => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      setTimeout(() => callback(0), 0);
      return 1;
    });
    const client = fakeClient();
    mount("/", client);
    const opener = await screen.findByTestId("open-nav");
    opener.focus();
    fireEvent.click(opener);
    await screen.findByTestId("nav-drawer");

    opener.remove();
    fireEvent.keyDown(document, { key: "Escape" });
    const replacement = document.createElement("button");
    replacement.dataset.testid = "open-nav";
    replacement.tabIndex = 0;
    document.body.append(replacement);

    await waitFor(() => expect(replacement).toHaveFocus());
  });

  it("navigates project → knowledge list → entry document with stable ids in the URL", async () => {
    const client = fakeClient();
    const { history } = mount("/", client);
    const [lore] = await screen.findAllByTestId("nav-project");
    fireEvent.click(lore!);

    await waitFor(() => expect(history.get()).toBe("/projects/p-lore"));
    fireEvent.click(
      await screen.findByRole("link", { name: /Browse knowledge/ }),
    );
    await waitFor(() =>
      expect(history.get()).toBe("/projects/p-lore/knowledge"),
    );
    const rows = await screen.findAllByTestId("knowledge-row");
    expect(rows[0]).toHaveTextContent("Keep SQLite");
    expect(rows[1]).toHaveTextContent("WAL recovery");
    expect(document.querySelector("[data-mobile-pane]")).toHaveAttribute(
      "data-mobile-pane",
      "detail",
    );

    fireEvent.click(rows[1]!);
    await waitFor(() =>
      expect(history.get()).toBe("/projects/p-lore/knowledge/k-wal"),
    );
    const doc = await screen.findByTestId("knowledge-document");
    expect(doc).toHaveAttribute("data-knowledge-id", "k-wal");
    expect(within(doc).getByRole("heading", { level: 1 })).toHaveTextContent(
      "WAL recovery",
    );
    expect(within(doc).getByTestId("category")).toHaveTextContent("gotcha");
    expect(within(doc).getByText("shared")).toBeInTheDocument();
    expect(within(doc).getByText("Confidence 60%")).toBeInTheDocument();
    expect(
      within(doc).getByText("No source session recorded."),
    ).toBeInTheDocument();
    const selectedRows = await screen.findAllByTestId("knowledge-row");
    expect(selectedRows[1]).toHaveAttribute("aria-current", "page");
    expect(selectedRows[0]).not.toHaveAttribute("aria-current");
    expect(document.querySelector("[data-mobile-pane]")).toHaveAttribute(
      "data-mobile-pane",
      "detail",
    );
    expect(screen.getByTestId("mobile-back")).toHaveAttribute(
      "href",
      "/projects/p-lore/knowledge",
    );
    expect(client.calls[0]).toBe("projects");
    expect(client.calls).toContain("entry:k-wal");
    expect(client.pageOpts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          projectId: "p-lore",
          opts: expect.objectContaining({ cursor: null }),
        }),
      ]),
    );
  });

  it("keeps knowledge q filters on the table route", async () => {
    mount("/projects/p-lore/knowledge?q=Keep", fakeClient());
    expect(await screen.findAllByTestId("knowledge-row")).toHaveLength(2);
    expect(
      screen.getByRole("textbox", { name: "Knowledge search" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Recall Results")).toBeNull();
  });

  it("renders a deep link straight to an entry (reload of a nested route)", async () => {
    const client = fakeClient();
    mount("/projects/p-lore/knowledge/k-sqlite", client);
    const doc = await screen.findByTestId("knowledge-document");
    expect(within(doc).getByRole("heading", { level: 1 })).toHaveTextContent(
      "Keep SQLite",
    );
    expect(within(doc).getByText("s-42")).toBeInTheDocument();
    // Paragraphs are split on blank lines, never rendered as HTML.
    expect(
      within(doc).getAllByText(/Portability|No remote cache/),
    ).toHaveLength(2);
    const rows = await screen.findAllByTestId("knowledge-row");
    expect(rows[0]).toHaveAttribute("aria-current", "page");
    const [lore] = await screen.findAllByTestId("nav-project");
    expect(lore).toHaveAttribute("aria-current", "page");
  });

  it("resolves /knowledge/:id deep links to the entry's project", async () => {
    const client = fakeClient();
    mount("/knowledge/k-wal", client);
    await screen.findByTestId("knowledge-document");
    const rows = await screen.findAllByTestId("knowledge-row");
    expect(rows).toHaveLength(2);
    expect(pane("list")).toHaveTextContent("Knowledge · lore");
    expect(client.calls).toEqual([
      "projects",
      "entry:k-wal",
      "knowledge:p-lore",
    ]);
    expect(client.pageOpts).toContainEqual({
      projectId: "p-lore",
      opts: {
        cursor: null,
        limit: 50,
        q: undefined,
        category: undefined,
        scope: undefined,
        sort: [{ field: "updated_at", dir: "desc" }],
      },
    });
  });

  it("decodes percent-encoded ids from the URL exactly once", async () => {
    const [baseProject] = PROJECTS;
    const [baseEntry] = ENTRIES;
    if (!baseProject || !baseEntry) throw new Error("fixtures missing");
    const project: ProjectSummary = {
      ...baseProject,
      id: "team/lore v2",
      knowledge_count: 1,
    };
    const entry: KnowledgeEntry = {
      ...baseEntry,
      id: "k/1%2",
      logical_id: "k/1%2",
      project_id: project.id,
    };
    const client = fakeClient({
      async listProjects() {
        return [project];
      },
      async listProjectKnowledge(projectId) {
        client.calls.push(`knowledge:${projectId}`);
        return projectId === project.id ? [entry] : [];
      },
      async getKnowledge(id) {
        client.calls.push(`entry:${id}`);
        if (id !== entry.id) throw new Error(`unexpected id ${id}`);
        return entry;
      },
    });
    const { history } = mount(knowledgeHref(project.id, entry.id), client);
    expect(history.get()).toBe(
      "/projects/team%2Flore%20v2/knowledge/k%2F1%252",
    );
    const doc = await screen.findByTestId("knowledge-document");
    expect(within(doc).getByRole("heading", { level: 1 })).toHaveTextContent(
      "Keep SQLite",
    );
    expect(client.calls).toEqual(["entry:k/1%2", "knowledge:team/lore v2"]);
    expect(client.pageOpts).toContainEqual({
      projectId: "team/lore v2",
      opts: {
        cursor: null,
        limit: 50,
        q: undefined,
        category: undefined,
        scope: undefined,
        sort: [{ field: "updated_at", dir: "desc" }],
      },
    });
    expect(pane("list")).toHaveTextContent("Knowledge · lore");
    const [row] = await screen.findAllByTestId("knowledge-row");
    expect(row).toHaveAttribute("aria-current", "page");
  });

  it("renders the future actions disabled with the exact wording", async () => {
    mount("/projects/p-lore/knowledge/k-sqlite", fakeClient());
    const doc = await screen.findByTestId("knowledge-document");
    const buttons = within(doc).getAllByRole("button", {
      name: /not available yet/,
    });
    expect(
      buttons.map((b) => b.textContent?.replace(NOT_AVAILABLE_YET, "").trim()),
    ).toEqual([
      "Save note",
      "Ask agent",
      "Explore separately",
      "Start with selected context",
      "Share finding",
    ]);
    for (const button of buttons) {
      expect(button).toBeDisabled();
      expect(button).toHaveTextContent(NOT_AVAILABLE_YET);
    }
  });

  it("does not interpret entry content as HTML", async () => {
    const client = fakeClient({
      async getKnowledge() {
        return {
          ...entryAt(0),
          title: "<img src=x onerror=alert(1)>",
          project_name: "Lore workspace",
          content: "<script>alert(1)</script>",
        };
      },
    });
    mount("/projects/p-lore/knowledge/k-sqlite", client);
    const doc = await screen.findByTestId("knowledge-document");
    expect(doc.querySelector("img, script")).toBeNull();
    expect(within(doc).getByRole("heading", { level: 1 })).toHaveTextContent(
      "<img src=x onerror=alert(1)>",
    );
  });
});

describe("shell: workspace knowledge and search", () => {
  it("browses all knowledge with project labels and query-free entry navigation", async () => {
    const client = fakeClient();
    const { history } = mount("/knowledge?q=SQLite&cursor=old-cursor", client);
    expect(
      await screen.findByRole("heading", { name: "All knowledge" }),
    ).toBeInTheDocument();
    await screen.findAllByTestId("knowledge-row");
    const table = screen.getByRole("table");
    expect(within(table).getAllByText("Lore workspace")).toHaveLength(2);
    expect(within(table).getByText("/home/me/empty")).toBeInTheDocument();
    expect(within(table).getByText("No project")).toBeInTheDocument();

    const nav = screen.getByRole("navigation", { name: "Workspace" });
    const allKnowledge = within(nav).getByTestId("nav-all-knowledge");
    const projects = within(nav).getByTestId("nav-projects");
    expect(allKnowledge).toHaveAttribute("aria-current", "page");
    expect(projects).not.toHaveAttribute("aria-current");
    const navLinks = [...nav.querySelectorAll("a[data-testid]")];
    expect(navLinks.indexOf(allKnowledge)).toBeLessThan(
      navLinks.findIndex(
        (link) => link.getAttribute("data-testid") === "nav-project",
      ),
    );

    const firstRow = (await screen.findAllByTestId("knowledge-row"))[0];
    if (!firstRow) throw new Error("Missing all-knowledge table row");
    fireEvent.click(firstRow);
    await waitFor(() => expect(history.get()).toBe("/knowledge/k-sqlite"));
  });

  it("activates Projects only on the workspace home", async () => {
    const { history } = mount("/", fakeClient());
    const nav = screen.getByRole("navigation", { name: "Workspace" });
    const projects = within(nav).getByTestId("nav-projects");
    const allKnowledge = within(nav).getByTestId("nav-all-knowledge");
    expect(projects).toHaveAttribute("aria-current", "page");
    fireEvent.click(allKnowledge);
    await waitFor(() => expect(history.get()).toBe("/knowledge"));
    await waitFor(() => {
      expect(screen.getByTestId("nav-projects")).not.toHaveAttribute(
        "aria-current",
      );
      expect(screen.getByTestId("nav-all-knowledge")).toHaveAttribute(
        "aria-current",
        "page",
      );
    });
  });

  it("changes the all-knowledge project filter and removes the cursor", async () => {
    const client = fakeClient();
    const { history } = mount("/knowledge?cursor=next", client);
    await screen.findAllByTestId("knowledge-row");

    fireEvent.pointerDown(screen.getByRole("button", { name: /^project\b/ }), {
      button: 0,
    });
    fireEvent.click(
      await screen.findByRole("option", { name: "/home/me/empty" }),
    );

    await waitFor(() =>
      expect(history.get()).toBe("/knowledge?project=p-empty"),
    );
    expect(client.allPageOpts.at(-1)).toEqual(
      expect.objectContaining({ project: "p-empty", cursor: null }),
    );

    fireEvent.pointerDown(screen.getByRole("button", { name: /^project\b/ }), {
      button: 0,
    });
    fireEvent.click(
      await screen.findByRole("option", { name: "All projects" }),
    );

    await waitFor(() => expect(history.get()).toBe("/knowledge"));
  });

  it("keeps an unknown project filter visible while projects load", async () => {
    let releaseProjects: (projects: ProjectSummary[]) => void = () => {};
    const client = fakeClient({
      async listProjects() {
        return new Promise<ProjectSummary[]>((resolve) => {
          releaseProjects = resolve;
        });
      },
    });
    mount("/knowledge?project=p-unknown", client);
    const project = await screen.findByRole("button", { name: /^project\b/ });
    expect(project).toHaveTextContent("p-unknown");
    releaseProjects(PROJECTS);
    await waitFor(() => expect(project).toHaveTextContent("p-unknown"));
  });

  it("returns entry-only deep links to All knowledge", async () => {
    mount("/knowledge/k-global", fakeClient());
    await screen.findByTestId("knowledge-document");
    expect(screen.getByTestId("mobile-back")).toHaveAttribute(
      "href",
      "/knowledge",
    );
    expect(screen.getByTestId("mobile-back")).toHaveTextContent(
      "All knowledge",
    );
  });

  it("shows ranked search results and links to the complete table", async () => {
    const searchOpts: Array<{ q: string; limit?: number; project?: string }> =
      [];
    const client = fakeClient({
      async searchKnowledge(opts) {
        searchOpts.push(opts);
        const hit = allEntryAt(3);
        return {
          query: opts.q,
          mode: "fts",
          total: 100,
          items: [{ ...hit, rank: -0.5 }],
        };
      },
    });
    const { history } = mount("/search?q=SQLite", client);
    expect(screen.getByRole("search")).toBeInTheDocument();
    expect(
      screen.getByRole("textbox", { name: "Search all knowledge" }),
    ).toHaveValue("SQLite");
    expect(await screen.findByTestId("search-hit")).toHaveAttribute(
      "href",
      "/knowledge/k-global",
    );
    expect(screen.getByTestId("search-hit")).toHaveTextContent(
      "preference · No project",
    );
    expect(screen.getByTestId("search-summary")).toHaveTextContent(
      "Top 1 of 100 matches",
    );
    expect(
      screen.getByText(
        "Knowledge only — sessions and distillations are searched per project.",
      ),
    ).toBeInTheDocument();
    expect(searchOpts[0]).toEqual(
      expect.objectContaining({ q: "SQLite", limit: 50 }),
    );
    const browse = screen.getByRole("link", {
      name: "Browse all 100 matches in the table",
    });
    expect(browse).toHaveAttribute("href", "/knowledge?q=SQLite");
    fireEvent.click(browse);
    await waitFor(() => expect(history.get()).toBe("/knowledge?q=SQLite"));
  });

  it("shows substring fallback, no-searchable-term, and error states", async () => {
    const like = fakeClient({
      async searchKnowledge({ q }) {
        return { query: q, mode: "like", total: 0, items: [] };
      },
    });
    mount("/search?q=!!!", like);
    expect(
      await screen.findByText(
        "No indexed terms in this query; showing substring matches, newest first.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Browse all knowledge" }),
    ).toHaveAttribute("href", "/knowledge");

    const none = fakeClient({
      async searchKnowledge({ q }) {
        return { query: q, mode: "none", total: 0, items: [] };
      },
    });
    mount("/search?q=the", none);
    expect(
      await screen.findByText("Nothing in this query is searchable"),
    ).toBeInTheDocument();
  });

  it("renders workspace search errors through the shared error state", async () => {
    const client = fakeClient({
      async searchKnowledge() {
        throw new ApiError("unreachable", "/knowledge/search", "offline");
      },
    });
    mount("/search?q=SQLite", client);
    expect(await screen.findByText("Gateway unreachable")).toBeInTheDocument();
  });

  it("shows an honest loading state for workspace search", async () => {
    let release: (response: KnowledgeSearchResponse) => void = () => {};
    const client = fakeClient({
      searchKnowledge() {
        return new Promise<KnowledgeSearchResponse>((resolve) => {
          release = resolve;
        });
      },
    });
    mount("/search?q=SQLite", client);
    expect(await screen.findByText("Searching knowledge")).toBeInTheDocument();
    release({
      query: "SQLite",
      mode: "fts",
      total: 1,
      items: [{ ...allEntryAt(0), rank: -0.5 }],
    });
    expect(await screen.findByTestId("search-hit")).toBeInTheDocument();
  });

  it("shows the empty-query prompt without starting a search", async () => {
    const client = fakeClient();
    mount("/search?q=", client);
    expect(
      await screen.findByText(
        "Type a query to search knowledge across every project",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Browse all knowledge" }),
    ).toHaveAttribute("href", "/knowledge");
    expect(client.searchOpts).toEqual([]);
  });

  it("renders hostile search titles as literal text", async () => {
    const title = '<img src=x onerror="window.__pwned=1">';
    const client = fakeClient({
      async searchKnowledge({ q }) {
        return {
          query: q,
          mode: "fts",
          total: 1,
          items: [{ ...allEntryAt(0), title, rank: -0.5 }],
        };
      },
    });
    mount("/search?q=Hostile", client);
    expect(await screen.findByText(title)).toBeInTheDocument();
    expect(pane("detail").querySelector("img")).toBeNull();
    expect((window as Window & { __pwned?: number }).__pwned).toBeUndefined();
  });
});

describe("shell: empty, error, not-found and locked states", () => {
  it("settles an unknown search project after projects load", async () => {
    mount("/projects/nope/search?q=x", fakeClient());
    expect(
      await screen.findByText("Project not found or inaccessible"),
    ).toBeInTheDocument();
  });

  it("keeps an unknown search project loading until projects resolve", async () => {
    let release: (projects: ProjectSummary[]) => void = () => {};
    const client = fakeClient({
      async listProjects() {
        return new Promise<ProjectSummary[]>((resolve) => {
          release = resolve;
        });
      },
    });
    mount("/projects/nope/search?q=x", client);
    expect(screen.getByText("Loading project")).toBeInTheDocument();

    release(PROJECTS);
    expect(
      await screen.findByText("Project not found or inaccessible"),
    ).toBeInTheDocument();
  });

  it("does not load knowledge pages while browsing sessions", async () => {
    let knowledgePageCalls = 0;
    const client = fakeClient({
      async listProjectKnowledgePage() {
        knowledgePageCalls++;
        return { items: [], next_cursor: null };
      },
    });
    mount("/projects/p-lore/sessions?cursor=abc", client);
    expect(await screen.findByText("No captured sessions")).toBeInTheDocument();
    expect(knowledgePageCalls).toBe(0);
  });

  it("does not load session pages while browsing knowledge", async () => {
    let sessionPageCalls = 0;
    const client = fakeClient({
      async listProjectSessionsPage() {
        sessionPageCalls++;
        return { items: [], next_cursor: null };
      },
    });
    mount("/projects/p-lore/knowledge?cursor=abc", client);
    expect(await screen.findByText("Keep SQLite")).toBeInTheDocument();
    expect(sessionPageCalls).toBe(0);
  });

  it("shows an empty state for a project without knowledge", async () => {
    mount("/projects/p-empty/knowledge", fakeClient());
    expect(
      await screen.findByText("No knowledge extracted yet"),
    ).toBeInTheDocument();
  });

  it("shows not-found for an unknown entry without breaking the connection status", async () => {
    mount("/projects/p-lore/knowledge/nope", fakeClient());
    expect(
      await screen.findByText("Knowledge entry not found"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("connection-status")).toHaveAttribute(
      "data-connection",
      "reachable",
    );
  });

  it("shows an empty project list when the gateway has nothing yet", async () => {
    mount(
      "/",
      fakeClient({
        async listProjects() {
          return [];
        },
      }),
    );
    // Both the nav and the welcome document explain the empty state.
    expect(await screen.findAllByText("No projects yet")).toHaveLength(2);
    expect(screen.getByTestId("connection-status")).toHaveAttribute(
      "data-connection",
      "reachable",
    );
  });

  it("does not flip the connection status when a read is aborted", async () => {
    let attempts = 0;
    const client = fakeClient({
      async listProjectKnowledge() {
        attempts++;
        // `abort(reason)` rejects with the raw reason, which need not be an Error.
        if (attempts === 1) throw { name: "AbortError", reason: "superseded" };
        return ENTRIES;
      },
    });
    mount("/projects/p-lore/knowledge", client);
    await screen.findAllByTestId("nav-project");
    await waitFor(() => expect(attempts).toBe(1));
    const status = screen.getByTestId("connection-status");
    expect(status).toHaveAttribute("data-connection", "reachable");
    expect(status).not.toHaveTextContent("Gateway unreachable");
  });

  it("reports the gateway as unreachable and offers a retry", async () => {
    let attempts = 0;
    const client = fakeClient({
      async listProjects() {
        attempts++;
        if (attempts === 1) {
          throw new ApiError("unreachable", "/projects", "Gateway unreachable");
        }
        return PROJECTS;
      },
    });
    mount("/", client);
    const status = await screen.findByTestId("connection-status");
    await waitFor(() =>
      expect(status).toHaveAttribute("data-connection", "unreachable"),
    );
    expect(status).toHaveTextContent("Gateway unreachable");
    expect(screen.getByText("Projects unavailable")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findAllByTestId("nav-project");
    expect(status).toHaveAttribute("data-connection", "reachable");
  });

  it("renders proxy 503 responses as gateway unreachable", async () => {
    const client = fakeClient({
      async listProjectKnowledgePage() {
        throw new ApiError(
          "unreachable",
          "/projects/p-lore/knowledge",
          "Gateway responded 503",
          503,
        );
      },
    });
    mount("/projects/p-lore/knowledge", client);
    expect(await screen.findByText("Gateway unreachable")).toBeInTheDocument();
    expect(screen.getByText(/lore start/)).toBeInTheDocument();
    expect(screen.getByTestId("connection-status")).toHaveAttribute(
      "data-connection",
      "unreachable",
    );
  });

  it("clears the error card while a retry is in flight instead of keeping the stale error", async () => {
    let attempts = 0;
    let release: (page: {
      items: KnowledgeEntry[];
      next_cursor: null;
    }) => void = () => {};
    const client = fakeClient({
      async listProjectKnowledgePage() {
        attempts++;
        if (attempts === 1) {
          throw new ApiError("http", "/projects/p-lore/knowledge", "boom", 500);
        }
        return new Promise<{ items: KnowledgeEntry[]; next_cursor: null }>(
          (resolve) => {
            release = resolve;
          },
        );
      },
    });
    mount("/projects/p-lore/knowledge", client);
    await screen.findByText("Knowledge unavailable");

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(screen.queryByText("Knowledge unavailable")).toBeNull(),
    );
    expect(screen.getByText("Loading knowledge")).toBeInTheDocument();
    expect(attempts).toBe(2);

    release({ items: ENTRIES, next_cursor: null });
    await screen.findByText("Keep SQLite");
    expect(screen.queryByText("Loading knowledge…")).toBeNull();
    expect(screen.queryByText("Knowledge unavailable")).toBeNull();
  });

  it("renders the locked state when the gateway hides management from this peer", async () => {
    const client = fakeClient({
      async listProjects() {
        throw new ApiError("unauthorized", "/projects", "hidden", 404);
      },
      async listProjectKnowledgePage() {
        throw new ApiError(
          "unauthorized",
          "/projects/p-lore/knowledge",
          "hidden",
          404,
        );
      },
    });
    mount("/projects/p-lore/knowledge", client);
    const status = await screen.findByTestId("connection-status");
    await waitFor(() =>
      expect(status).toHaveAttribute("data-connection", "unauthorized"),
    );
    expect(status).toHaveTextContent("Management not authorized");
    expect(status).toHaveTextContent("LORE_ALLOW_REMOTE_MANAGEMENT");
    expect(screen.getByText("Projects hidden")).toBeInTheDocument();
    expect(
      await screen.findByText("Knowledge hidden by the gateway"),
    ).toBeInTheDocument();
    expect(document.querySelectorAll('[data-state="locked"]')).toHaveLength(2);
  });

  it("shows the not-found page for unknown client routes", () => {
    mount("/definitely/not/a/route", fakeClient());
    expect(screen.getByTestId("not-found")).toBeInTheDocument();
  });
});

describe("shell: search entry, theme and fixture", () => {
  // `/fixture` is a lazy route. Resolve it through the route table's own
  // `lazy()` wrapper once, so later mounts render synchronously from the
  // same module graph (the production-routes test below resets modules).
  beforeAll(async () => {
    const component = routes.find((r) => r.path === "/fixture")?.component;
    if (!isPreloadable(component)) throw new Error("fixture route not lazy");
    await component.preload();
  });

  it("submits a workspace search from the header", async () => {
    const { history } = mount("/", fakeClient());
    const input = screen.getByRole("textbox", { name: "Search" });
    expect(input).toHaveAttribute("placeholder", "Search all knowledge…");
    fireEvent.input(input, { target: { value: "SQLite" } });
    const form = input.closest("form");
    if (!form) throw new Error("workspace search form missing");
    fireEvent.submit(form);
    await waitFor(() => expect(history.get()).toBe("/search?q=SQLite"));
    expect((await screen.findAllByTestId("search-hit")).length).toBeGreaterThan(
      0,
    );
  });

  it("defaults to the system theme and lets the user force light or dark", async () => {
    mount("/", fakeClient());
    const group = screen.getByTestId("theme-toggle");
    expect(group).toHaveAttribute("data-theme-choice", "system");
    expect(screen.getByTestId("theme-system")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    expect(document.documentElement).not.toHaveClass("dark");

    fireEvent.click(screen.getByTestId("theme-dark"));
    await waitFor(() => expect(document.documentElement).toHaveClass("dark"));
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(screen.getByTestId("theme-dark")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByTestId("theme-system")).toHaveAttribute(
      "aria-pressed",
      "false",
    );

    fireEvent.click(screen.getByTestId("theme-light"));
    await waitFor(() =>
      expect(document.documentElement).not.toHaveClass("dark"),
    );
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
  });

  it("follows the OS preference while on system and stops once a mode is forced", async () => {
    let systemDark = false;
    let onChange: ((e: { matches: boolean }) => void) | undefined;
    vi.stubGlobal("matchMedia", (query: string) => ({
      media: query,
      get matches() {
        return systemDark;
      },
      addEventListener: (_: string, cb: (e: { matches: boolean }) => void) => {
        onChange = cb;
      },
    }));
    resetThemeStoreForTests();
    mount("/", fakeClient());
    expect(document.documentElement).not.toHaveClass("dark");

    systemDark = true;
    onChange?.({ matches: true });
    await waitFor(() => expect(document.documentElement).toHaveClass("dark"));
    // Nothing persisted: still following the system.
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();

    fireEvent.click(screen.getByTestId("theme-light"));
    await waitFor(() =>
      expect(document.documentElement).not.toHaveClass("dark"),
    );
    systemDark = false;
    onChange?.({ matches: false });
    systemDark = true;
    onChange?.({ matches: true });
    expect(document.documentElement).not.toHaveClass("dark");

    // Back to system picks the live OS value up again and clears storage.
    fireEvent.click(screen.getByTestId("theme-system"));
    await waitFor(() => expect(document.documentElement).toHaveClass("dark"));
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
  });

  it("swaps the header logo between the light and dark website marks", async () => {
    mount("/", fakeClient());
    const logo = screen.getByTestId("logo");
    const img = logo.querySelector("img");
    const wordmark = logo.querySelector(".font-serif");
    expect(img).not.toBeNull();
    expect(logo).toBeVisible();
    expect(wordmark).toHaveClass("hidden", "sm:inline");
    expect(logo).toHaveAttribute("data-logo-theme", "light");
    expect(img?.getAttribute("src")).toMatch(/loreai\.svg/);
    // The wordmark stays a real link target for assistive tech.
    expect(screen.getByRole("link", { name: /Lore\.AI — home/ })).toBeVisible();
    fireEvent.click(screen.getByTestId("theme-dark"));
    await waitFor(() =>
      expect(logo).toHaveAttribute("data-logo-theme", "dark"),
    );
    expect(img?.getAttribute("src")).toMatch(/loreai-dark\.svg/);
  });

  it("applies a persisted dark choice before the first render", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "dark");
    resetThemeStoreForTests();
    theme();
    expect(document.documentElement).toHaveClass("dark");
  });

  it("mounts the fixture and compatibility smoke in dev only, never in production builds", async () => {
    const paths = (defs: typeof routes) =>
      defs.flatMap((r) => (Array.isArray(r.path) ? r.path : [r.path]));
    expect(import.meta.env.DEV).toBe(true);
    expect(paths(routes)).toEqual(
      expect.arrayContaining(["/fixture", "/_compat"]),
    );

    vi.stubEnv("DEV", false);
    vi.resetModules();
    const prod = await import("~/app");
    expect(paths(prod.routes)).not.toContain("/_compat");
    expect(paths(prod.routes)).not.toContain("/fixture");
    expect(paths(prod.routes)).toEqual(
      expect.arrayContaining([
        "/",
        "/projects/:projectId",
        "/projects/:projectId/knowledge/:knowledgeId",
        "/knowledge/:knowledgeId",
        "*",
      ]),
    );
    // The catch-all keeps the SPA fallback for stale deep links.
    expect(paths(prod.routes).at(-1)).toBe("*");
    vi.unstubAllEnvs();
  });

  it("renders the fixture as a labelled non-production specimen without API calls", async () => {
    const client = fakeClient();
    mount("/fixture", client);
    expect(await screen.findByTestId("fixture-banner")).toHaveTextContent(
      "NOT PRODUCTION",
    );
    expect(screen.getAllByTestId("fixture-thread-row")).toHaveLength(4);
    expect(screen.getByTestId("inline-discussion")).toBeInTheDocument();
    expect(screen.queryByTestId("focus-discussion")).toBeNull();
    expect(document.querySelector(".passage-target")).toHaveTextContent(
      "Replace the SQLite cache with a remote service.",
    );
    // Every note state and pane state is on the page.
    for (const state of ["draft", "saved", "sent", "unknown"]) {
      expect(
        document.querySelector(`[data-note-state="${state}"]`),
      ).not.toBeNull();
    }
    for (const state of ["empty", "error", "locked"]) {
      expect(document.querySelector(`[data-state="${state}"]`)).not.toBeNull();
    }
    // All five future actions appear, all disabled.
    const future = screen.getAllByRole("button", { name: /not available yet/ });
    const names = new Set(
      future.map((b) => b.textContent?.replace(NOT_AVAILABLE_YET, "").trim()),
    );
    expect([...names].sort()).toEqual(
      [
        "Ask agent",
        "Explore separately",
        "Save note",
        "Share finding",
        "Start with selected context",
      ].sort(),
    );
    for (const button of future) expect(button).toBeDisabled();
    // The fixture must not hit the gateway: the root's project fetch is the
    // only call, and it belongs to the shell provider, not the fixture.
    await waitFor(() => expect(client.calls).toEqual(["projects"]));
  });

  it("switches to the focused discussion view and back", async () => {
    const { history } = mount("/fixture", fakeClient());
    fireEvent.click(await screen.findByTestId("open-focus"));
    await waitFor(() => expect(history.get()).toBe("/fixture?view=focus"));
    expect(await screen.findByTestId("focus-discussion")).toHaveTextContent(
      "Keep the local store",
    );
    expect(screen.queryByTestId("inline-discussion")).toBeNull();
    expect(document.querySelector('[data-pane="list"]')).toBeNull();
    expect(screen.getByTestId("mobile-back")).toHaveTextContent("Source");

    fireEvent.click(screen.getByTestId("back-to-source"));
    await waitFor(() => expect(history.get()).toBe("/fixture"));
    expect(await screen.findByTestId("inline-discussion")).toBeInTheDocument();
  });

  it("renders the invented session through the block model at ?view=blocks", async () => {
    const client = fakeClient();
    mount("/fixture?view=blocks", client);
    const section = await screen.findByTestId("reader-blocks");
    expect(screen.getByTestId("fixture-banner")).toHaveTextContent(
      "NOT PRODUCTION",
    );
    expect(screen.queryByTestId("inline-discussion")).toBeNull();
    // Every origin the model distinguishes is on the page, labelled.
    for (const origin of ["system", "lore", "user", "agent"]) {
      expect(
        section.querySelector(`[data-block-id][data-origin="${origin}"]`),
      ).not.toBeNull();
    }
    expect(
      section.querySelector('[data-origin="distillation"]'),
    ).toHaveTextContent("Compressed context");
    expect(section.querySelector('[data-part-kind="tool"]')).not.toBeNull();
    expect(section.textContent).toContain("time unknown");
    // Block ids come from the server ids, never from position.
    expect(section.querySelector("#m\\.spec-sys")).not.toBeNull();
    // No script survives the sanitiser anywhere in the specimen.
    expect(section.querySelector("script")).toBeNull();
    await waitFor(() => expect(client.calls).toEqual(["projects"]));
  });
});

describe("shell: IndexedDB cache behavior", () => {
  it("does not show cached knowledge rows while a project page is loading", async () => {
    const db = await seededDb();
    const client = fakeClient({
      listProjectKnowledgePage: () =>
        new Promise<{ items: KnowledgeEntry[]; next_cursor: null }>(() => {}),
    });
    mount("/projects/p-lore/knowledge", client, Promise.resolve(db));
    await screen.findByText("Loading knowledge");
    expect(screen.queryByTestId("knowledge-row")).toBeNull();
    expect(screen.queryByText("Keep SQLite")).toBeNull();
  });

  it("renders the server page without consulting cached knowledge rows", async () => {
    const db = await seededDb();
    let release: (page: {
      items: KnowledgeEntry[];
      next_cursor: null;
    }) => void = () => {};
    const server = new Promise<{ items: KnowledgeEntry[]; next_cursor: null }>(
      (r) => {
        release = r;
      },
    );
    const client = fakeClient({
      listProjectKnowledgePage: () => server,
    });
    mount("/projects/p-lore/knowledge", client, Promise.resolve(db));
    await screen.findByText("Loading knowledge");
    release({
      items: [{ ...ENTRIES[0]!, title: "Keep SQLite (v2)" }],
      next_cursor: null,
    });
    await screen.findByText("Keep SQLite (v2)");
    expect(screen.getAllByTestId("knowledge-row")).toHaveLength(1);
    await waitFor(() =>
      expect(screen.queryByTestId("stale-indicator")).toBeNull(),
    );
  });

  it("shows the page error instead of cached knowledge rows when the server rejects", async () => {
    const db = await seededDb();
    const client = fakeClient({
      listProjectKnowledgePage: async () => {
        throw new ApiError("unreachable", "/projects/p-lore/knowledge", "down");
      },
      getKnowledge: () => {
        throw new ApiError("unreachable", "/knowledge/k-sqlite", "down");
      },
    });
    mount("/projects/p-lore/knowledge", client, Promise.resolve(db));
    await screen.findByText("Gateway unreachable");
    expect(screen.queryByTestId("knowledge-row")).toBeNull();
    expect(screen.queryByText("Keep SQLite")).toBeNull();
    await waitFor(() => {
      expect(screen.queryByTestId("stale-indicator")).toBeNull();
    });
  });

  it("keeps cached projects in the nav when the gateway is unreachable", async () => {
    const db = await seededDb();
    const client = fakeClient({
      listProjects: () => {
        throw new ApiError("unreachable", "/projects", "down");
      },
      listProjectKnowledge: () => {
        throw new ApiError("unreachable", "/projects/p-lore/knowledge", "down");
      },
    });
    mount("/projects/p-lore", client, Promise.resolve(db));
    const rows = await screen.findAllByTestId("nav-project");
    expect(rows.map((r) => r.textContent)).toContain("lore2");
    const badges = await screen.findAllByTestId("stale-indicator");
    expect(badges.map((b) => b.textContent)).toContain(
      "Cached · gateway unavailable",
    );
    await waitFor(() =>
      expect(screen.queryByText("Projects unavailable")).toBeNull(),
    );
  });
});
