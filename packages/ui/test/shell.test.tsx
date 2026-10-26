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
import { resetSidebarForTests } from "~/state/sidebar";
import { Rail } from "~/components/shell/Rail";
import { Shell } from "~/components/shell/Shell";
import { knowledgeHref } from "~/lib/href";
import { ApiError, type ApiClient } from "~/lib/api";
import { ConnectionContext, createConnectionStore } from "~/lib/connection";
import type {
  KnowledgeEffects,
  KnowledgeEntry,
  KnowledgeSearchResponse,
  KnowledgeVersionHistory,
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

async function projectRows() {
  if (!screen.queryByRole("searchbox", { name: "Filter projects" })) {
    fireEvent.click(screen.getByRole("button", { name: /switch project/i }));
  }
  return screen.findAllByTestId("nav-project");
}

function projectRowSummary(row: HTMLElement) {
  return `${row.querySelector("[data-project-label]")?.textContent ?? ""}${row.querySelector("[data-project-count]")?.textContent ?? ""}`;
}

function mountBaseNav(path: string, activeProjectId: string | null = null) {
  const history = createMemoryHistory();
  history.set({ value: path });
  const utils = render(() => (
    <MemoryRouter
      base="/ui"
      history={history}
      root={createAppRoot(fakeClient())}
    >
      <Route
        path="*"
        component={() => (
          <ConnectionContext.Provider value={createConnectionStore()}>
            <Rail projectId={activeProjectId ?? undefined} />
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
  resetSidebarForTests();
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
    await screen.findByTestId("rail-projects");

    await waitFor(() =>
      expect(screen.getByTestId("rail-projects")).toHaveClass("bg-accent-soft"),
    );
    expect(screen.getByTestId("rail-knowledge")).not.toHaveClass(
      "bg-accent-soft",
    );

    history.set({ value: "/ui/knowledge" });
    await waitFor(() => {
      expect(screen.getByTestId("rail-knowledge")).toHaveClass(
        "bg-accent-soft",
      );
      expect(screen.getByTestId("rail-projects")).not.toHaveClass(
        "bg-accent-soft",
      );
    });
  });

  it("matches nav descendants under the /ui router base", async () => {
    const { history } = mountBaseNav("/ui");
    const navIds = [
      "rail-entities",
      "rail-contradictions",
      "rail-warming",
      "rail-costs",
    ] as const;
    const activeRoutes = [
      ["/ui/entities", "rail-entities"],
      ["/ui/entities/entity-1", "rail-entities"],
      ["/ui/contradictions", "rail-contradictions"],
      ["/ui/warming", "rail-warming"],
      ["/ui/costs", "rail-costs"],
    ] as const;

    for (const [path, activeId] of activeRoutes) {
      history.set({ value: path });
      await waitFor(() =>
        expect(screen.getByTestId(activeId)).toHaveClass("bg-accent-soft"),
      );
      for (const id of navIds) {
        if (id !== activeId) {
          expect(
            screen.queryByTestId(id)?.classList.contains("bg-accent-soft") ??
              false,
          ).toBe(false);
        }
      }
    }
  });

  it("routes to project duplicates under the /ui base and keeps the entry muted without a project", async () => {
    const project = PROJECTS[0];
    if (!project) throw new Error("A navigation project fixture is required");
    const duplicatesPath = `/ui/projects/${project.id}/duplicates`;
    const { history, unmount } = mountBaseNav(duplicatesPath, project.id);
    const duplicates = screen.getByTestId("rail-duplicates");

    expect(duplicates).toHaveAttribute("href", duplicatesPath);
    await waitFor(() => {
      expect(duplicates).toHaveAttribute("aria-current", "page");
      expect(duplicates).toHaveClass("bg-accent-soft");
    });

    history.set({ value: `/ui/projects/${project.id}` });
    await waitFor(() => {
      expect(duplicates).not.toHaveAttribute("aria-current", "page");
      expect(duplicates).not.toHaveClass("bg-accent-soft");
    });
    unmount();

    mountBaseNav("/ui");
    expect(screen.getByTestId("rail-projects")).toBeInTheDocument();
    expect(screen.queryByTestId("rail-duplicates")).not.toBeInTheDocument();
  });

  it("loads projects into the nav and shows the welcome document", async () => {
    const client = fakeClient();
    mount("/", client);
    const rows = await projectRows();
    expect(rows.map(projectRowSummary)).toEqual([
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

  for (const wide of [true, false]) {
    for (const [section, path, role, label] of [
      [
        "knowledge",
        "/projects/p-lore/knowledge/k-sqlite",
        "textbox",
        "Filter this list",
      ],
      [
        "sessions",
        "/projects/p-lore/sessions/s-42",
        "searchbox",
        "Filter session list",
      ],
    ] as const) {
      it(`keeps ${section} context open when Escape is pressed in its search on ${wide ? "desktop" : "mobile"}`, async () => {
        vi.stubGlobal("matchMedia", () => ({
          matches: wide,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        }));
        mount(path, fakeClient());
        const toggle = await screen.findByTestId("context-toggle");
        if (toggle.getAttribute("aria-expanded") === "false")
          fireEvent.click(toggle);
        const input = await screen.findByRole(role, { name: label });
        input.focus();
        fireEvent.input(input, { target: { value: "SQLite" } });
        const preference = localStorage.getItem("lore.ui.sidebarCollapsed");
        fireEvent.keyDown(input, { key: "Escape" });
        expect(toggle).toHaveAttribute("aria-expanded", "true");
        expect(screen.getByTestId("context-pane")).toBeVisible();
        expect(input).toHaveFocus();
        expect(localStorage.getItem("lore.ui.sidebarCollapsed")).toBe(
          preference,
        );
      });
    }
  }

  it("leaves Escape to native controls and nested editable content", async () => {
    const history = createMemoryHistory();
    history.set({ value: "/" });
    render(() => (
      <MemoryRouter history={history} root={createAppRoot(fakeClient())}>
        <Route
          path="*"
          component={() => (
            <Shell
              mobilePane="list"
              detail={<div>Document</div>}
              list={
                <form>
                  <textarea aria-label="Notes" />
                  <select aria-label="Selection">
                    <option>One</option>
                  </select>
                  <div contentEditable={true}>
                    <span data-testid="editable-child">Editable</span>
                  </div>
                </form>
              }
            />
          )}
        />
      </MemoryRouter>
    ));
    const toggle = screen.getByTestId("context-toggle");
    for (const target of [
      screen.getByLabelText("Notes"),
      screen.getByLabelText("Selection"),
      screen.getByTestId("editable-child"),
    ]) {
      const event = new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      });
      target.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
      expect(toggle).toHaveAttribute("aria-expanded", "true");
      expect(localStorage.getItem("lore.ui.sidebarCollapsed")).not.toBe("true");
    }
  });

  it("closes narrow context with Escape and returns focus to the toolbar", async () => {
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    mount("/projects/p-lore/knowledge/k-sqlite", fakeClient());
    const opener = await screen.findByTestId("context-toggle");
    fireEvent.click(opener);
    const link = (await screen.findAllByTestId("knowledge-row"))[0]!;
    link.focus();
    fireEvent.keyDown(link, { key: "Escape" });
    await waitFor(() => expect(opener).toHaveFocus());
    expect(screen.getByTestId("context-pane")).not.toBeVisible();
    expect(screen.queryByTestId("icon-rail")).toBeNull();
    expect(screen.getByTestId("mobile-menu-trigger")).toBeVisible();
  });

  it("navigates project → knowledge list → entry document with stable ids in the URL", async () => {
    const client = fakeClient();
    const { history } = mount("/", client);
    const [lore] = await projectRows();
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
      screen.getByRole("textbox", { name: "Filter this list" }),
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
    const [lore] = await projectRows();
    expect(lore).toHaveAttribute("aria-current", "page");
  });

  it("resolves /knowledge/:id deep links to the entry's project", async () => {
    const client = fakeClient();
    mount("/knowledge/k-wal", client);
    await screen.findByTestId("knowledge-document");
    const rows = await screen.findAllByTestId("knowledge-row");
    expect(rows).toHaveLength(2);
    expect(pane("list")).toHaveTextContent("Knowledge");
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
    expect(pane("list")).toHaveTextContent("Knowledge");
    const [row] = await screen.findAllByTestId("knowledge-row");
    expect(row).toHaveAttribute("aria-current", "page");
  });

  it("offers the real knowledge actions without roadmap placeholders", async () => {
    mount("/projects/p-lore/knowledge/k-sqlite", fakeClient());
    const doc = await screen.findByTestId("knowledge-document");
    expect(
      within(doc).queryAllByRole("button", { name: /not available yet/ }),
    ).toHaveLength(0);
    expect(within(doc).getByText("Source & details")).toBeInTheDocument();
    expect(within(doc).getByText("History")).toBeInTheDocument();
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

  it("refreshes the sidebar and project counts after delete and restore", async () => {
    const target = entryAt(0);
    const targetProjectId = target.project_id;
    if (!targetProjectId) throw new Error("fixture must belong to a project");
    let liveEntries = ENTRIES.map((entry) => ({ ...entry }));
    let revision = 1;
    let deleted = false;
    const listProjects = vi.fn(async () =>
      PROJECTS.map((project) =>
        project.id === target.project_id
          ? {
              ...project,
              knowledge_count: liveEntries.filter(
                (entry) => entry.project_id === project.id,
              ).length,
            }
          : project,
      ),
    );
    const listProjectKnowledgePage = vi.fn(async (projectId: string) => ({
      items: liveEntries.filter((entry) => entry.project_id === projectId),
      next_cursor: null,
    }));
    const getKnowledge = vi.fn(async (id: string) => {
      const entry = liveEntries.find((candidate) => candidate.id === id);
      if (!entry) {
        throw new ApiError(
          "not_found",
          `/knowledge/${id}`,
          "Knowledge entry not found",
          404,
        );
      }
      return entry;
    });
    const writeEffects = (): KnowledgeEffects => ({
      scope: "project",
      project_id: targetProjectId,
      revision,
      is_deleted: deleted,
      lore_file: { enabled: false, path: null, affected: false },
      agents_file: { enabled: false, mode: "off", immediate: false },
      sync: { enabled: false },
    });
    const listKnowledgeVersions = vi.fn(
      async (id: string): Promise<KnowledgeVersionHistory> => {
        const makeVersion = (
          version: number,
          is_current: boolean,
          is_deleted: boolean,
        ): KnowledgeVersionHistory["versions"][number] => ({
          version_id: `${id}-v${version}`,
          version,
          created_at: Date.UTC(2026, 8, 2, 10) + version,
          superseded_at: is_current ? null : Date.UTC(2026, 8, 2, 10),
          is_current,
          is_deleted,
          title: target.title,
          content: target.content,
          category: target.category,
          confidence: target.confidence,
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
        });
        const versions = [makeVersion(revision, true, deleted)];
        if (deleted) versions.push(makeVersion(revision - 1, false, false));
        return {
          id,
          current_version_id: `${id}-v${revision}`,
          versions,
        };
      },
    );
    const deleteKnowledge = vi.fn(async (id: string) => {
      liveEntries = liveEntries.filter((entry) => entry.id !== id);
      revision += 1;
      deleted = true;
      return {
        deleted: true as const,
        id,
        revision,
        previous_revision: revision - 1,
        version_id: `${id}-v${revision}`,
        changed: ["is_deleted"],
        effects: writeEffects(),
        entry: null,
      };
    });
    const restoreKnowledge = vi.fn(async (id: string) => {
      liveEntries = [...liveEntries, target];
      revision += 1;
      deleted = false;
      return {
        id,
        revision,
        previous_revision: revision - 1,
        version_id: `${id}-v${revision}`,
        changed: ["is_deleted"],
        effects: writeEffects(),
        restored_from: { version_id: `${id}-v1`, version: 1 },
        entry: target,
      };
    });
    const client = fakeClient({
      listProjects,
      listProjectKnowledgePage,
      getKnowledge,
      listKnowledgeVersions,
      getKnowledgeEffects: async () => writeEffects(),
      deleteKnowledge,
      restoreKnowledge,
    });
    mount("/projects/p-lore/knowledge/k-sqlite", client, Promise.resolve(null));

    const list = await screen.findByTestId("knowledge-list");
    await within(list).findByText(target.title);
    const projectCount = () =>
      screen.getByTestId("active-project-count").textContent;
    await waitFor(() => expect(projectCount()).toBe("2"));

    let pageCalls = listProjectKnowledgePage.mock.calls.length;
    let projectCalls = listProjects.mock.calls.length;
    const deleteButton = await screen.findByRole("button", { name: "Delete" });
    await waitFor(() => expect(deleteButton).toBeEnabled());
    fireEvent.click(deleteButton);
    const deleteDialog = await screen.findByRole("alertdialog");
    fireEvent.click(
      within(deleteDialog).getByRole("button", { name: "Delete entry" }),
    );
    await waitFor(() =>
      expect(within(list).queryByText(target.title)).toBeNull(),
    );
    await waitFor(() => expect(projectCount()).toBe("1"));
    await waitFor(() =>
      expect(listProjectKnowledgePage).toHaveBeenCalledTimes(pageCalls + 1),
    );
    await waitFor(() =>
      expect(listProjects).toHaveBeenCalledTimes(projectCalls + 1),
    );

    pageCalls = listProjectKnowledgePage.mock.calls.length;
    projectCalls = listProjects.mock.calls.length;
    const restoreButton = await screen.findByRole("button", {
      name: "Restore…",
    });
    await waitFor(() => expect(restoreButton).toBeEnabled());
    fireEvent.click(restoreButton);
    const restoreDialog = await screen.findByRole("alertdialog");
    fireEvent.click(
      within(restoreDialog).getByRole("button", { name: "Restore version" }),
    );
    await waitFor(() =>
      expect(within(list).getByText(target.title)).toBeInTheDocument(),
    );
    await waitFor(() => expect(projectCount()).toBe("2"));
    await waitFor(() =>
      expect(listProjectKnowledgePage).toHaveBeenCalledTimes(pageCalls + 1),
    );
    await waitFor(() =>
      expect(listProjects).toHaveBeenCalledTimes(projectCalls + 1),
    );
  });

  it("refreshes the sidebar after a saved retitle", async () => {
    let currentEntry = { ...entryAt(0) };
    const currentProjectId = currentEntry.project_id;
    if (!currentProjectId) throw new Error("fixture must belong to a project");
    let revision = 1;
    const listProjects = vi.fn(async () =>
      PROJECTS.map((project) =>
        project.id === currentEntry.project_id
          ? { ...project, knowledge_count: 2 }
          : project,
      ),
    );
    const listProjectKnowledgePage = vi.fn(async (projectId: string) => ({
      items: ENTRIES.filter(
        (entry) =>
          entry.project_id === projectId && entry.id !== currentEntry.id,
      ).concat(currentEntry.project_id === projectId ? [currentEntry] : []),
      next_cursor: null,
    }));
    const client = fakeClient({
      listProjects,
      listProjectKnowledgePage,
      async getKnowledge(id: string) {
        if (id !== currentEntry.id) throw new Error(`unexpected entry ${id}`);
        return currentEntry;
      },
      async listKnowledgeVersions(id: string) {
        return {
          id,
          current_version_id: `${id}-v${revision}`,
          versions: [
            {
              version_id: `${id}-v${revision}`,
              version: revision,
              created_at: Date.UTC(2026, 8, 2, 10),
              superseded_at: null,
              is_current: true,
              is_deleted: false,
              title: currentEntry.title,
              content: currentEntry.content,
              category: currentEntry.category,
              confidence: currentEntry.confidence,
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
      async editKnowledge(id, body) {
        revision += 1;
        currentEntry = {
          ...currentEntry,
          ...(body.title !== undefined ? { title: body.title } : {}),
        };
        return {
          id,
          revision,
          previous_revision: revision - 1,
          version_id: `${id}-v${revision}`,
          changed: ["title"],
          effects: {
            scope: "project",
            project_id: currentProjectId,
            revision,
            is_deleted: false,
            lore_file: { enabled: false, path: null, affected: false },
            agents_file: { enabled: false, mode: "off", immediate: false },
            sync: { enabled: false },
          },
          entry: currentEntry,
        };
      },
    });
    mount("/projects/p-lore/knowledge/k-sqlite", client, Promise.resolve(null));

    const list = await screen.findByTestId("knowledge-list");
    await within(list).findByText(currentEntry.title);
    const originalTitle = currentEntry.title;
    const pageCalls = listProjectKnowledgePage.mock.calls.length;
    const projectCalls = listProjects.mock.calls.length;
    const editButton = await screen.findByRole("button", { name: "Edit" });
    await waitFor(() => expect(editButton).toBeEnabled());
    fireEvent.click(editButton);
    fireEvent.input(screen.getByLabelText("Title"), {
      target: { value: "Retitled knowledge entry" },
    });
    const saveButton = screen.getByRole("button", {
      name: "Save",
    });
    await waitFor(() => expect(saveButton).toBeEnabled());
    fireEvent.click(saveButton);

    await waitFor(() =>
      expect(
        within(list).getByText("Retitled knowledge entry"),
      ).toBeInTheDocument(),
    );
    expect(within(list).queryByText(originalTitle)).toBeNull();
    await waitFor(() =>
      expect(listProjectKnowledgePage).toHaveBeenCalledTimes(pageCalls + 1),
    );
    await waitFor(() =>
      expect(listProjects).toHaveBeenCalledTimes(projectCalls + 1),
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
    expect(within(table).getAllByText("Lore workspace")).toHaveLength(4);
    expect(within(table).getAllByText("/home/me/empty")[0]).toBeInTheDocument();
    expect(within(table).getAllByText("No project")[0]).toBeInTheDocument();

    const nav = screen.getByRole("navigation", { name: "Primary navigation" });
    const allKnowledge = within(nav).getByTestId("rail-knowledge");
    const projects = within(nav).getByTestId("rail-projects");
    expect(allKnowledge).toHaveAttribute("aria-current", "page");
    expect(projects).not.toHaveAttribute("aria-current");
    const navLinks = [...nav.querySelectorAll("a[data-testid]")];
    expect(navLinks.indexOf(projects)).toBeLessThan(
      navLinks.indexOf(allKnowledge),
    );
    expect(
      screen.getByRole("button", { name: /switch project/i }),
    ).toBeInTheDocument();

    const firstRow = (await screen.findAllByTestId("knowledge-row"))[0];
    if (!firstRow) throw new Error("Missing all-knowledge table row");
    fireEvent.click(firstRow);
    await waitFor(() => expect(history.get()).toBe("/knowledge/k-sqlite"));
  });

  it("activates Projects only on the workspace home", async () => {
    const { history } = mount("/", fakeClient());
    const nav = screen.getByRole("navigation", { name: "Primary navigation" });
    const projects = within(nav).getByTestId("rail-projects");
    const allKnowledge = within(nav).getByTestId("rail-knowledge");
    expect(projects).toHaveAttribute("aria-current", "page");
    fireEvent.click(allKnowledge);
    await waitFor(() => expect(history.get()).toBe("/knowledge"));
    await waitFor(() => {
      expect(screen.getByTestId("rail-projects")).not.toHaveAttribute(
        "aria-current",
      );
      expect(screen.getByTestId("rail-knowledge")).toHaveAttribute(
        "aria-current",
        "page",
      );
    });
  });

  it("changes the all-knowledge project filter and removes the cursor", async () => {
    const client = fakeClient();
    const { history } = mount("/knowledge?cursor=next", client);
    await screen.findAllByTestId("knowledge-row");

    const projectTrigger = screen.getByRole("button", { name: /^project\b/ });
    fireEvent.pointerDown(projectTrigger, {
      button: 0,
    });
    fireEvent.click(
      await screen.findByRole("option", { name: "/home/me/empty" }),
    );

    await waitFor(() =>
      expect(history.get()).toBe("/knowledge?project=p-empty"),
    );
    expect(screen.getByRole("button", { name: /^project\b/ })).toBe(
      projectTrigger,
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
    expect(screen.getByRole("button", { name: /^project\b/ })).toBe(
      projectTrigger,
    );
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
      within(screen.getByRole("main")).getByRole("textbox", {
        name: "Search knowledge across projects",
      }),
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
        "Knowledge only. Search a project's memory to include its conversations and summaries.",
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

  it("flags approximate hits and counts them in the summary", async () => {
    const client = fakeClient({
      async searchKnowledge({ q }) {
        return {
          query: q,
          mode: "fts",
          total: 2,
          items: [
            { ...allEntryAt(0), rank: -0.5, match: "exact" },
            { ...allEntryAt(3), rank: null, match: "fuzzy" },
          ],
        };
      },
    });
    mount("/search?q=SQLite", client);
    const hits = await screen.findAllByTestId("search-hit");
    expect(hits).toHaveLength(2);
    expect(
      hits[0]!.querySelector("[data-testid='search-match-fuzzy']"),
    ).toBeNull();
    expect(
      hits[1]!.querySelector("[data-testid='search-match-fuzzy']"),
    ).not.toBeNull();
    expect(screen.getByTestId("search-summary")).toHaveTextContent(
      "2 matches · 1 approximate",
    );
  });

  it("renders fuzzy hits even when the exact leg reports mode none", async () => {
    const client = fakeClient({
      async searchKnowledge({ q }) {
        return {
          query: q,
          mode: "none",
          total: 1,
          items: [{ ...allEntryAt(3), rank: null, match: "fuzzy" }],
        };
      },
    });
    mount("/search?q=SQLite", client);
    expect(await screen.findByTestId("search-hit")).toBeInTheDocument();
    expect(
      screen.queryByText("Nothing in this query is searchable"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("search-summary")).toHaveTextContent(
      "1 match · 1 approximate",
    );
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
    const listKnowledgeVersions = vi
      .fn<ApiClient["listKnowledgeVersions"]>()
      .mockRejectedValue(
        new ApiError(
          "not_found",
          "/knowledge/nope/versions",
          "Knowledge entry not found",
          404,
        ),
      );
    mount(
      "/projects/p-lore/knowledge/nope",
      fakeClient({ listKnowledgeVersions }),
    );
    expect(
      await screen.findByText("Knowledge entry not found"),
    ).toBeInTheDocument();
    expect(listKnowledgeVersions).toHaveBeenCalledWith(
      "nope",
      expect.objectContaining({ includeDeleted: true }),
    );
    expect(screen.getByTestId("connection-status")).toHaveAttribute(
      "data-connection",
      "reachable",
    );
  });

  it("shows a deleted-save error after reloading into deleted history", async () => {
    const target = entryAt(0);
    const deletedAt = Date.UTC(2026, 8, 3, 12);
    const makeVersion = (
      version: number,
      is_current: boolean,
      is_deleted: boolean,
    ): KnowledgeVersionHistory["versions"][number] => ({
      version_id: `${target.id}-v${version}`,
      version,
      created_at: deletedAt + version,
      superseded_at: is_current ? null : deletedAt,
      is_current,
      is_deleted,
      title: target.title,
      content: target.content,
      category: target.category,
      confidence: target.confidence,
      scope: "project",
      cross_project: false,
      source_refs: {
        session_id: null,
        entry_id: target.id,
        user_id: null,
        created_by: null,
        updated_by: null,
        worker_provider_id: null,
        worker_model_id: null,
      },
    });
    const liveHistory: KnowledgeVersionHistory = {
      id: target.id,
      current_version_id: `${target.id}-v1`,
      versions: [makeVersion(1, true, false)],
    };
    const deletedHistory: KnowledgeVersionHistory = {
      id: target.id,
      current_version_id: `${target.id}-v2`,
      versions: [makeVersion(2, true, true), makeVersion(1, false, false)],
    };
    let deleted = false;
    const client = fakeClient({
      async getKnowledge(id) {
        if (deleted) {
          throw new ApiError(
            "not_found",
            `/knowledge/${id}`,
            "Knowledge entry not found",
            404,
          );
        }
        return target;
      },
      async listKnowledgeVersions(id, options) {
        return options?.includeDeleted ? deletedHistory : liveHistory;
      },
      async editKnowledge() {
        deleted = true;
        throw new ApiError(
          "http",
          `/api/v1/knowledge/${target.id}`,
          "Entry is deleted",
          409,
          "deleted",
        );
      },
    });
    mount(
      `/projects/p-lore/knowledge/${target.id}`,
      client,
      Promise.resolve(null),
    );

    await screen.findByTestId("knowledge-document");
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.input(screen.getByLabelText("Title"), {
      target: { value: "Draft after deletion" },
    });
    fireEvent.submit(screen.getByTestId("knowledge-editor"));

    const deletedDocument = await screen.findByTestId(
      "deleted-knowledge-document",
    );
    expect(within(deletedDocument).getByRole("alert")).toHaveTextContent(
      "This entry was deleted. Your draft is kept on this device; restore the entry from History to continue.",
    );
    expect(screen.queryByTestId("knowledge-editor")).not.toBeInTheDocument();
  });

  it("shows deleted-entry recovery when history has a deleted head", async () => {
    const deletedAt = Date.UTC(2026, 8, 3, 12);
    const deletedHistory: KnowledgeVersionHistory = {
      id: "k-merged",
      current_version_id: "k-merged-v2",
      versions: [
        {
          version_id: "k-merged-v2",
          version: 2,
          created_at: deletedAt,
          superseded_at: null,
          is_current: true,
          is_deleted: true,
          title: "Last live title",
          content: "Last live content",
          category: "decision",
          confidence: 0.9,
          scope: "project",
          cross_project: false,
          source_refs: {
            session_id: null,
            entry_id: "k-merged",
            user_id: null,
            created_by: null,
            updated_by: null,
            worker_provider_id: null,
            worker_model_id: null,
          },
        },
        {
          version_id: "k-merged-v1",
          version: 1,
          created_at: deletedAt - 10_000,
          superseded_at: deletedAt,
          is_current: false,
          is_deleted: false,
          title: "Last live title",
          content: "Last live content",
          category: "decision",
          confidence: 0.9,
          scope: "project",
          cross_project: false,
          source_refs: {
            session_id: null,
            entry_id: "k-merged",
            user_id: null,
            created_by: null,
            updated_by: null,
            worker_provider_id: null,
            worker_model_id: null,
          },
        },
      ],
    };
    const listKnowledgeVersions = vi
      .fn<ApiClient["listKnowledgeVersions"]>()
      .mockResolvedValue(deletedHistory);
    mount(
      "/projects/p-lore/knowledge/k-merged",
      fakeClient({ listKnowledgeVersions }),
    );

    expect(
      await screen.findByTestId("deleted-knowledge-document"),
    ).toBeInTheDocument();
    expect(
      screen
        .getByText("This entry was merged or deleted")
        .closest('[data-state="empty"]'),
    ).not.toBeNull();
    expect(screen.getByTestId("deleted-entry-last-live")).toHaveTextContent(
      "Last live title",
    );
    expect(screen.getByTestId("deleted-entry-last-live")).toHaveTextContent(
      "Last live content",
    );
    expect(screen.getByTestId("deleted-entry-last-live")).toHaveTextContent(
      new Date(deletedAt).toLocaleString(),
    );
    expect(screen.getByTestId("knowledge-version-2")).toHaveTextContent(
      "Deleted",
    );
    expect(screen.getByRole("button", { name: "Restore…" })).toBeEnabled();
    expect(
      screen.queryByText("Restoring arrives with knowledge editing (#1805)"),
    ).not.toBeInTheDocument();
    expect(listKnowledgeVersions).toHaveBeenCalledWith(
      "k-merged",
      expect.objectContaining({ includeDeleted: true }),
    );
  });

  it("keeps a not-found entry out of recovery when history has no tombstone", async () => {
    const historyWithoutTombstone: KnowledgeVersionHistory = {
      id: "missing-but-live",
      current_version_id: "missing-but-live-v1",
      versions: [
        {
          version_id: "missing-but-live-v1",
          version: 1,
          created_at: 1_700_000_000_000,
          superseded_at: null,
          is_current: true,
          is_deleted: false,
          title: "Not a tombstone",
          content: "No recovery should appear.",
          category: "decision",
          confidence: 0.8,
          scope: "project",
          cross_project: false,
          source_refs: {
            session_id: null,
            entry_id: "missing-but-live",
            user_id: null,
            created_by: null,
            updated_by: null,
            worker_provider_id: null,
            worker_model_id: null,
          },
        },
      ],
    };
    mount(
      "/projects/p-lore/knowledge/missing-but-live",
      fakeClient({
        listKnowledgeVersions: async () => historyWithoutTombstone,
      }),
    );

    expect(
      await screen.findByText("Knowledge entry not found"),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("deleted-knowledge-document"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Restore…" }),
    ).not.toBeInTheDocument();
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
    // Both the picker and the welcome document explain the empty state.
    fireEvent.click(screen.getByRole("button", { name: /switch project/i }));
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
    await projectRows();
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
    fireEvent.click(screen.getByRole("button", { name: /switch project/i }));
    expect(
      await within(
        screen.getByRole("dialog", { name: "Switch project" }),
      ).findByText("Projects unavailable"),
    ).toBeInTheDocument();

    fireEvent.click(
      within(screen.getByRole("dialog", { name: "Switch project" })).getByRole(
        "button",
        { name: "Retry" },
      ),
    );
    await projectRows();
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
    let knowledgeRequests = 0;
    const client = fakeClient({
      async listProjectKnowledgePage() {
        knowledgeRequests += 1;
        throw new ApiError(
          "unauthorized",
          "/projects/p-lore/knowledge",
          "hidden",
          404,
        );
      },
    });
    mount("/projects/p-lore/knowledge", client);
    const gate = await screen.findByTestId("gateway-auth-gate");
    expect(gate).toHaveTextContent("Connect to your gateway");
    expect(gate).toHaveTextContent("LORE_GATEWAY_AUTH_TOKEN");
    expect(screen.getByLabelText("Gateway token")).toHaveAttribute(
      "type",
      "password",
    );
    expect(knowledgeRequests).toBe(1);
    expect(screen.queryByTestId("connection-status")).toBeNull();
    expect(screen.queryByText("Keep SQLite")).toBeNull();
  });

  it("keeps workspace navigation and safe recovery links on unknown routes under /ui", async () => {
    mount(
      "/ui/missing-page?token=private-value",
      fakeClient(),
      undefined,
      "/ui",
    );
    const page = screen.getByTestId("not-found");
    expect(screen.getByTestId("icon-rail")).toBeInTheDocument();
    expect(screen.getAllByRole("main")).toHaveLength(1);
    expect(
      within(page).getByRole("heading", { name: "Page not found" }),
    ).toBeInTheDocument();
    expect(
      within(page).getByRole("link", { name: "Browse projects" }),
    ).toHaveAttribute("href", "/ui");
    expect(
      within(page).getByRole("link", { name: "Search knowledge" }),
    ).toHaveAttribute("href", "/ui/search?q=");
    expect(page).not.toHaveTextContent("private-value");
    expect(
      screen.queryByRole("link", { name: /Return to project/ }),
    ).toBeNull();
  });

  it("recovers to a known project without guessing project IDs from the route", async () => {
    const { history } = mount(
      "/ui/projects/p-lore/missing-page",
      fakeClient(),
      undefined,
      "/ui",
    );
    const recovery = await screen.findByRole("link", {
      name: "Return to project: lore",
    });
    expect(recovery).toHaveAttribute("href", "/ui/projects/p-lore");
    fireEvent.click(recovery);
    await waitFor(() => expect(history.get()).toBe("/ui/projects/p-lore"));
    expect(screen.queryByTestId("not-found")).toBeNull();
  });

  it.each(["missing-project", "%25E0%25A4%25A", "p-lore%2F..%2Fother"])(
    "keeps global recovery for an unrecognized project segment %s",
    async (id) => {
      mount(`/projects/${id}/missing-page`, fakeClient());
      await waitFor(() =>
        expect(screen.getByTestId("connection-status")).toHaveAttribute(
          "data-connection",
          "reachable",
        ),
      );
      expect(
        screen.queryByRole("link", { name: /Return to project/ }),
      ).toBeNull();
      expect(
        within(screen.getByTestId("not-found")).getByRole("link", {
          name: "Browse projects",
        }),
      ).toHaveAttribute("href", "/");
    },
  );

  it("offers project recovery only after the workspace confirms that project", async () => {
    let release: (projects: ProjectSummary[]) => void = () => {};
    mount(
      "/projects/p-lore/missing-page",
      fakeClient({
        listProjects: () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      }),
    );
    expect(
      screen.queryByRole("link", { name: /Return to project/ }),
    ).toBeNull();
    release(PROJECTS);
    expect(
      await screen.findByRole("link", { name: "Return to project: lore" }),
    ).toHaveAttribute("href", "/projects/p-lore");
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
    const input = screen.getByRole("textbox", {
      name: "Search knowledge across projects",
    });
    expect(input).toHaveAttribute(
      "placeholder",
      "Search knowledge across projects…",
    );
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
    fireEvent.click(screen.getByTestId("folk-status"));
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
        return query === "(prefers-color-scheme: dark)" ? systemDark : true;
      },
      addEventListener: (_: string, cb: (e: { matches: boolean }) => void) => {
        if (query === "(prefers-color-scheme: dark)") onChange = cb;
      },
      removeEventListener: vi.fn(),
    }));
    resetThemeStoreForTests();
    mount("/", fakeClient());
    fireEvent.click(screen.getByTestId("folk-status"));
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

  it("swaps the sidebar logo between the light and dark website marks", async () => {
    mount("/", fakeClient());
    const logo = screen.getByTestId("logo");
    const img = logo.querySelector("img");
    const wordmark = logo.querySelector(".font-serif");
    expect(img).not.toBeNull();
    expect(logo).toBeVisible();
    expect(wordmark).toHaveClass("sr-only");
    expect(logo).toHaveAttribute("data-logo-theme", "light");
    expect(img?.getAttribute("src")).toMatch(/loreai\.svg/);
    // The wordmark stays a real link target for assistive tech.
    expect(screen.getByRole("link", { name: /Lore\.AI — home/ })).toBeVisible();
    fireEvent.click(screen.getByTestId("folk-status"));
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
    const rows = await projectRows();
    expect(rows.map(projectRowSummary)).toContain("lore2");
    const badges = await screen.findAllByTestId("stale-indicator");
    expect(badges.map((b) => b.textContent)).toContain(
      "Cached · gateway unavailable",
    );
    await waitFor(() =>
      expect(screen.queryByText("Projects unavailable")).toBeNull(),
    );
  });
});

describe("Knowledge reader toolbar", () => {
  it("filters the list without dropping the selected entry, scope or sort", async () => {
    const client = fakeClient();
    const { history } = mount(
      "/projects/p-lore/knowledge/k-sqlite?category=decision&scope=project&sort=confidence:desc&cursor=older",
      client,
    );
    await screen.findByTestId("knowledge-document");
    const search = screen.getByRole("textbox", {
      name: "Filter this list",
    });
    fireEvent.input(search, { target: { value: "SQLite" } });
    fireEvent.submit(search.closest("form")!);
    await waitFor(() => {
      const current = new URL(history.get(), "http://local");
      expect(current.pathname).toBe("/projects/p-lore/knowledge/k-sqlite");
      expect(current.searchParams.get("q")).toBe("SQLite");
      expect(current.searchParams.get("category")).toBe("decision");
      expect(current.searchParams.get("scope")).toBe("project");
      expect(current.searchParams.get("sort")).toBe("confidence:desc");
      expect(current.searchParams.has("cursor")).toBe(false);
    });
    expect(screen.getByTestId("knowledge-document")).toHaveTextContent(
      "Keep SQLite",
    );
  });
});

it("keeps the toolbar project picker available when context is hidden", async () => {
  const { history } = mount("/projects/p-lore", fakeClient());
  expect(screen.queryByTestId("context-toggle")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /switch project/i }));
  await screen.findByRole("searchbox", { name: "Filter projects" });
  const target = (await screen.findAllByTestId("nav-project")).find(
    (row) => row.getAttribute("href") === "/projects/p-empty",
  );
  fireEvent.click(target!);
  await waitFor(() => expect(history.get()).toBe("/projects/p-empty"));
  expect(screen.getByTestId("icon-rail")).toBeVisible();
});

it("resizes the knowledge pane with the keyboard and remembers its width", async () => {
  mount("/projects/p-lore/knowledge/k-sqlite", fakeClient());
  const handle = await screen.findByRole("separator", {
    name: "Resize knowledge list",
  });
  fireEvent.keyDown(handle, { key: "ArrowRight" });
  expect(handle).toHaveAttribute("aria-valuenow", "336");
  expect(localStorage.getItem("lore.ui.listWidth")).toBe("336");
  fireEvent.keyDown(handle, { key: "End" });
  expect(handle).toHaveAttribute("aria-valuenow", "480");
  fireEvent.doubleClick(handle);
  expect(handle).toHaveAttribute("aria-valuenow", "320");
});

it("keeps mobile detail mounted and measurable but inert while context is open", async () => {
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  mount("/projects/p-lore/knowledge/k-sqlite", fakeClient());
  const doc = await screen.findByTestId("knowledge-document");
  const main = pane("detail");
  expect(main.style.gridColumn).toBe("1 / -1");
  fireEvent.click(screen.getByTestId("context-toggle"));
  expect(main.style.display).not.toBe("none");
  expect(main.style.gridColumn).toBe("1 / -1");
  expect(main).toHaveStyle({ visibility: "hidden" });
  expect(main.inert).toBe(true);
  expect(main).toHaveAttribute("aria-hidden", "true");
  expect(screen.getByTestId("knowledge-document")).toBe(doc);
  fireEvent.click(screen.getByTestId("context-toggle"));
  expect(main.inert).toBe(false);
  expect(main).not.toHaveAttribute("aria-hidden", "true");
  expect(doc).toBeVisible();
});

it("focuses the reader without remounting the selected document", async () => {
  mount("/projects/p-lore/knowledge/k-sqlite", fakeClient());
  const doc = await screen.findByTestId("knowledge-document");
  fireEvent.click(
    screen.getByRole("button", { name: "Collapse context pane" }),
  );
  expect(pane("list")).not.toBeVisible();
  expect(screen.getByTestId("knowledge-document")).toBe(doc);
  fireEvent.click(screen.getByRole("button", { name: "Expand context pane" }));
  expect(pane("list")).toBeVisible();
});

it("clears reader filters while preserving the selected entry and sort", async () => {
  const { history } = mount(
    "/projects/p-lore/knowledge/k-sqlite?q=SQLite&category=decision&scope=shared&sort=confidence%3Adesc&cursor=old",
    fakeClient(),
  );
  await screen.findByTestId("knowledge-document");
  fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
  await waitFor(() =>
    expect(history.get()).toBe(
      "/projects/p-lore/knowledge/k-sqlite?sort=confidence%3Adesc",
    ),
  );
});

it("filters project cards and can recover from an empty result", async () => {
  mount("/", fakeClient());
  await screen.findAllByTestId("project-card");
  const filter = screen.getByRole("textbox", { name: "Filter project cards" });
  fireEvent.input(filter, { target: { value: "not-a-project" } });
  expect(await screen.findByText("No projects match")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Clear project filter" }));
  await waitFor(() =>
    expect(screen.getAllByTestId("project-card")).toHaveLength(2),
  );
});

it("restores context focus at narrow breakpoints without stealing reader input focus", async () => {
  const listeners = new Set<(event: { matches: boolean }) => void>();
  const media = {
    matches: true,
    addEventListener: (_: string, fn: (event: { matches: boolean }) => void) =>
      listeners.add(fn),
    removeEventListener: (
      _: string,
      fn: (event: { matches: boolean }) => void,
    ) => listeners.delete(fn),
  };
  vi.stubGlobal("matchMedia", () => media);
  mount("/projects/p-lore/knowledge/k-sqlite", fakeClient());
  const row = (await screen.findAllByTestId("knowledge-row"))[0]!;
  row.focus();
  media.matches = false;
  for (const listener of listeners) listener({ matches: false });
  await waitFor(() =>
    expect(screen.getByTestId("context-toggle")).toHaveFocus(),
  );
  const search = screen.getByRole("textbox", {
    name: "Search this project's memory",
  });
  search.focus();
  media.matches = true;
  for (const listener of listeners) listener({ matches: true });
  expect(search).toHaveFocus();
});

it("keeps scoped recall searches on their route without mounting hidden reader filters", async () => {
  const { history } = mount(
    "/projects/p-lore/search?q=SQLite&scope=all",
    fakeClient(),
  );
  await screen.findByRole("textbox", { name: "Search query" });
  history.set({ value: "/projects/p-lore/search?q=SQLite&scope=knowledge" });
  // Let Select's queued selection effects settle after the route change.
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(history.get()).toBe(
    "/projects/p-lore/search?q=SQLite&scope=knowledge",
  );
  expect(
    screen.queryByRole("textbox", { name: "Filter this list" }),
  ).toBeNull();
  expect(
    screen.getByRole("textbox", { name: "Search query" }),
  ).toBeInTheDocument();
});

it("keeps primary navigation and the project picker available with context collapsed", async () => {
  mount("/projects/p-lore/knowledge/k-sqlite", fakeClient());
  const document = await screen.findByTestId("knowledge-document");
  const rail = screen.getByRole("navigation", { name: "Primary navigation" });
  expect(within(rail).getByRole("link", { name: "Projects" })).toBeVisible();
  fireEvent.click(
    screen.getByRole("button", { name: "Collapse context pane" }),
  );
  expect(screen.getByTestId("context-pane")).not.toBeVisible();
  expect(rail).toBeVisible();
  expect(screen.getByRole("button", { name: /switch project/i })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Expand context pane" }));
  expect(screen.getByTestId("context-pane")).toBeVisible();
  expect(screen.getByTestId("knowledge-document")).toBe(document);
});

it("keeps narrow context open after reader filter submissions", async () => {
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  const { history } = mount(
    "/projects/p-lore/knowledge/k-sqlite",
    fakeClient(),
  );
  await screen.findByTestId("knowledge-document");
  fireEvent.click(screen.getByRole("button", { name: "Expand context pane" }));
  const input = screen.getByRole("textbox", { name: "Filter this list" });
  fireEvent.input(input, { target: { value: "SQLite" } });
  fireEvent.submit(input.closest("form")!);
  await waitFor(() => expect(history.get()).toContain("q=SQLite"));
  expect(screen.getByTestId("context-pane")).toBeVisible();
  expect(screen.queryByTestId("icon-rail")).toBeNull();
  expect(screen.getByTestId("mobile-menu-trigger")).toBeVisible();
});

it("updates picker destinations when changing chooser sections", async () => {
  const { history } = mount("/", fakeClient());
  await projectRows();
  history.set({ value: "/?section=sessions" });
  await waitFor(() =>
    expect(screen.getAllByTestId("nav-project")[0]).toHaveAttribute(
      "href",
      "/projects/p-lore/sessions",
    ),
  );
  history.set({ value: "/" });
  await waitFor(() =>
    expect(screen.getAllByTestId("nav-project")[0]).toHaveAttribute(
      "href",
      "/projects/p-lore",
    ),
  );
});

it("switches projects within the current knowledge section", async () => {
  const { history } = mount(
    "/projects/p-lore/knowledge/k-sqlite",
    fakeClient(),
  );
  await screen.findByTestId("knowledge-document");
  await projectRows();
  const target = screen
    .getAllByTestId("nav-project")
    .find((row) => row.getAttribute("href")?.includes("p-empty"));
  fireEvent.click(target!);
  await waitFor(() =>
    expect(history.get()).toBe("/projects/p-empty/knowledge"),
  );
});

it("uses rail destinations consistently and exposes workspace tools directly", async () => {
  const { history } = mount(
    "/projects/p-lore/knowledge/k-sqlite",
    fakeClient(),
  );
  await screen.findByTestId("knowledge-document");
  const rail = within(
    screen.getByRole("navigation", { name: "Primary navigation" }),
  );
  expect(rail.getByRole("link", { name: "Search" })).toHaveAttribute(
    "href",
    "/projects/p-lore/search?scope=all",
  );
  for (const name of [
    "Entities",
    "Conflicting instructions",
    "Team proposals",
    "Team",
    "Sync recovery",
    "Cache warming",
    "Cost intelligence",
    "Model usage",
  ])
    expect(rail.getByRole("link", { name })).toBeInTheDocument();
  fireEvent.click(rail.getByRole("link", { name: "Knowledge" }));
  await waitFor(() => expect(history.get()).toBe("/projects/p-lore/knowledge"));
});

it("marks exactly one rail destination current across chooser queries and reader routes", async () => {
  const { history } = mount("/", fakeClient());
  const current = () =>
    [
      ...screen
        .getByTestId("icon-rail")
        .querySelectorAll('[aria-current="page"]'),
    ].map((node) => node.getAttribute("data-testid"));
  expect(current()).toEqual(["rail-projects"]);
  history.set({ value: "/?section=sessions" });
  await waitFor(() => expect(current()).toEqual(["rail-sessions"]));
  history.set({ value: "/projects/p-lore/knowledge/k-sqlite" });
  await screen.findByTestId("knowledge-document");
  expect(current()).toEqual(["rail-knowledge"]);
  await projectRows();
  expect(
    screen
      .getAllByTestId("nav-project")
      .find((row) => row.textContent?.includes("lore")),
  ).toHaveAttribute("aria-current", "page");
});

it("marks the rail parent current without duplicate tabs on detail routes", async () => {
  const history = createMemoryHistory();
  history.set({ value: "/entities/entity-1" });
  render(() => (
    <MemoryRouter history={history} root={createAppRoot(fakeClient())}>
      <Route
        path="*"
        component={() => (
          <Shell
            nav={() => null}
            detail={<div>Entity detail</div>}
            mobilePane="detail"
          />
        )}
      />
    </MemoryRouter>
  ));
  expect(
    screen.queryByRole("navigation", { name: "Related pages" }),
  ).toBeNull();
  expect(await screen.findByTestId("rail-entities")).toHaveAttribute(
    "aria-current",
    "page",
  );
});

it.each([
  "/",
  "/knowledge",
  "/projects/p-lore",
  "/projects/p-lore/knowledge",
  "/projects/p-lore/sessions",
  "/projects/p-lore/imports",
  "/projects/p-lore/duplicates",
  "/search",
])("uses the rail without redundant context on %s", async (path) => {
  mount(path, fakeClient());
  await screen.findByTestId("icon-rail");
  expect(screen.queryByTestId("context-toggle")).toBeNull();
  expect(
    screen.queryByRole("navigation", { name: "Section navigation" }),
  ).toBeNull();
  expect(screen.getByTestId("context-pane")).not.toBeVisible();
  expect(pane("detail")).toBeVisible();
});

it("restores toolbar focus when a narrow reader context opens the full table", async () => {
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  const { history } = mount(
    "/projects/p-lore/knowledge/k-sqlite",
    fakeClient(),
  );
  await screen.findByTestId("knowledge-document");
  fireEvent.click(screen.getByTestId("context-toggle"));
  const link = screen.getByRole("link", { name: "Open as table" });
  link.focus();
  fireEvent.click(link);
  await waitFor(() => expect(history.get()).toBe("/projects/p-lore/knowledge"));
  await waitFor(() =>
    expect(screen.getByTestId("project-picker-trigger")).toHaveFocus(),
  );
});

it("defaults to labeled navigation and persists compact mode independently of context", async () => {
  const first = mount("/projects/p-lore/knowledge/k-sqlite", fakeClient());
  await screen.findByTestId("knowledge-document");
  expect(screen.getByTestId("rail-projects")).toHaveTextContent("Projects");
  const toggle = screen.getByRole("button", { name: "Use compact navigation" });
  toggle.focus();
  fireEvent.click(toggle);
  expect(screen.getByTestId("rail-projects")).not.toHaveTextContent("Projects");
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "Show navigation labels" }),
  );
  expect(localStorage.getItem("lore.ui.navigationCompact")).toBe("true");
  expect(localStorage.getItem("lore.ui.sidebarCollapsed")).toBeNull();
  first.unmount();
  mount("/", fakeClient());
  expect(
    screen.getByRole("button", { name: "Show navigation labels" }),
  ).toHaveAttribute("aria-pressed", "true");
});

it.each([null, "broken", "false"])(
  "uses labeled navigation for missing or invalid preference %s",
  (value) => {
    if (value !== null)
      localStorage.setItem("lore.ui.navigationCompact", value);
    mount("/", fakeClient());
    expect(screen.getByTestId("rail-projects")).toHaveTextContent("Projects");
  },
);

it("keeps navigation usable when storage reads and writes are blocked", () => {
  const read = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  const write = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(() => {
      throw new Error("blocked");
    });
  try {
    mount("/", fakeClient());
    expect(screen.getByTestId("rail-projects")).toHaveTextContent("Projects");
    fireEvent.click(
      screen.getByRole("button", { name: "Use compact navigation" }),
    );
    expect(
      screen.getByRole("button", { name: "Show navigation labels" }),
    ).toHaveAttribute("aria-pressed", "true");
  } finally {
    read.mockRestore();
    write.mockRestore();
  }
});

it.each([
  "bogus",
  "",
  "__proto__",
  "constructor",
  "toString",
  "ALL",
  "knowledge ",
])(
  "recovers invalid recall scope %s through the project search route",
  async (rawScope) => {
    const recall = vi.fn<ApiClient["recall"]>(async (opts) => ({
      query: opts.q,
      scope: opts.scope,
      projectPath: opts.project.path,
      result: "No results found for this query.",
    }));
    const { history } = mount(
      `/projects/p-lore/search?q=SQLite&scope=${encodeURIComponent(rawScope)}`,
      fakeClient({ recall }),
    );
    expect(await screen.findByText("No results")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /^Search scope/ }),
    ).toHaveTextContent("All memory");
    expect(screen.getByTestId("recall-search-scope")).toHaveTextContent(
      "Scope: All memory",
    );
    expect(recall).toHaveBeenLastCalledWith(
      expect.objectContaining({ q: "SQLite", scope: "all" }),
      expect.anything(),
    );
    fireEvent.submit(screen.getByRole("search"));
    await waitFor(() =>
      expect(history.get()).toBe("/projects/p-lore/search?q=SQLite&scope=all"),
    );
  },
);

it("updates every rail destination and group when compact mode changes without reloading", async () => {
  mount("/projects/p-lore/knowledge/k-sqlite", fakeClient());
  await screen.findByTestId("knowledge-document");
  const rail = screen.getByTestId("icon-rail");
  const destinations = [
    ...rail.querySelectorAll<HTMLAnchorElement>("a[data-testid]"),
  ].map((link) => ({
    id: link.dataset.testid!,
    label: link.getAttribute("aria-label")!,
    href: link.getAttribute("href")!,
  }));
  expect(destinations.length).toBeGreaterThan(10);
  for (const compact of [true, false, true, false]) {
    fireEvent.click(screen.getByTestId("navigation-compact-toggle"));
    for (const { id, label, href } of destinations) {
      const link = screen.getByTestId(id);
      expect(link).toHaveAttribute("href", href);
      expect(link).toHaveAttribute("aria-label", label);
      expect(link.textContent).toBe(compact ? "" : label);
      if (compact) {
        link.focus();
        expect(await screen.findByRole("tooltip")).toHaveTextContent(label);
        expect(link).toHaveAttribute(
          "aria-describedby",
          screen.getByRole("tooltip").id,
        );
        fireEvent.keyDown(link, { key: "Escape" });
        link.blur();
        await waitFor(() =>
          expect(screen.queryByRole("tooltip")).not.toBeInTheDocument(),
        );
      }
    }
    for (const group of [
      "Project tools",
      "Knowledge tools",
      "Collaboration",
      "Operations",
    ]) {
      if (compact)
        expect(
          within(rail).getByRole("separator", { name: group }),
        ).toBeInTheDocument();
      else
        expect(
          within(rail).getByText(group, { exact: true }),
        ).toBeInTheDocument();
    }
  }
});
