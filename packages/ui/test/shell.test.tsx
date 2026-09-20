import { MemoryRouter, createMemoryHistory } from "@solidjs/router";
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
import { knowledgeHref } from "~/routes/Browse";
import { ApiError, type ApiClient } from "~/lib/api";
import type { KnowledgeEntry, ProjectSummary } from "~/contracts";
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

type Overrides = Partial<{ [K in keyof ApiClient]: ApiClient[K] }>;

function fakeClient(overrides: Overrides = {}): ApiClient & {
  calls: string[];
  pageOpts: Array<{ projectId: string; opts: { cursor?: string | null } }>;
} {
  const calls: string[] = [];
  const pageOpts: Array<{
    projectId: string;
    opts: { cursor?: string | null };
  }> = [];
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
      const entry = ENTRIES.find((e) => e.id === id);
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
  };
  client = Object.assign(base, overrides) as ApiClient;
  return Object.assign(client, { calls, pageOpts });
}

function mount(path: string, client: ApiClient, db?: Promise<LoreUiDb | null>) {
  const history = createMemoryHistory();
  history.set({ value: path });
  const utils = render(() => (
    <MemoryRouter history={history} root={createAppRoot(client, db)}>
      {routes}
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
    expect(within(doc).getByText("Cross-project")).toBeInTheDocument();
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
        sort: "updated_desc",
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
        sort: "updated_desc",
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
          ...ENTRIES[0]!,
          title: "<img src=x onerror=alert(1)>",
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

  it("asks for a project before accepting a search query", async () => {
    mount("/", fakeClient());
    fireEvent.click(screen.getByTestId("search-entry"));
    expect(await screen.findByRole("dialog")).toHaveTextContent(
      "Pick a project first — recall is scoped to a project",
    );
    expect(screen.queryByRole("searchbox")).toBeNull();
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
    expect(img).not.toBeNull();
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

describe("shell: cached-first rendering (IndexedDB)", () => {
  it("renders cached rows with 'Cached · refreshing…' while the server is silent", async () => {
    const db = await seededDb();
    const client = fakeClient({
      listProjects: () => new Promise<ProjectSummary[]>(() => {}),
      listProjectKnowledgePage: () =>
        new Promise<{ items: KnowledgeEntry[]; next_cursor: null }>(() => {}),
      getKnowledge: () => new Promise<KnowledgeEntry>(() => {}),
    });
    mount("/projects/p-lore/knowledge", client, Promise.resolve(db));
    const rows = await screen.findAllByTestId("knowledge-row");
    expect(rows[0]).toHaveTextContent("Keep SQLite");
    const badges = await screen.findAllByTestId("stale-indicator");
    expect(badges.map((b) => b.textContent)).toContain("Cached · refreshing…");
    expect(screen.queryByText("Knowledge unavailable")).toBeNull();
  });

  it("replaces the cached value and drops the badge when the server answers", async () => {
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
    await screen.findAllByTestId("stale-indicator");
    release({
      items: [{ ...ENTRIES[0]!, title: "Keep SQLite (v2)" }],
      next_cursor: null,
    });
    await screen.findByText("Keep SQLite (v2)");
    await waitFor(() =>
      expect(screen.queryByTestId("stale-indicator")).toBeNull(),
    );
  });

  it("keeps cached rows and shows 'Cached · gateway unavailable' when the server rejects", async () => {
    const db = await seededDb();
    const client = fakeClient({
      listProjectKnowledgePage: () => {
        throw new ApiError("unreachable", "/projects/p-lore/knowledge", "down");
      },
      getKnowledge: () => {
        throw new ApiError("unreachable", "/knowledge/k-sqlite", "down");
      },
    });
    mount("/projects/p-lore/knowledge", client, Promise.resolve(db));
    // The title appears in the list row and the open document.
    await screen.findAllByText("Keep SQLite");
    const badges = await screen.findAllByTestId("stale-indicator");
    expect(badges.map((b) => b.textContent)).toContain(
      "Cached · gateway unavailable",
    );
    // Cached rows stay; no error card replaces them. The list's cached read
    // settles a few tasks after the document's, so wait the transient out.
    await waitFor(() => {
      expect(screen.queryByText("Knowledge unavailable")).toBeNull();
      expect(screen.queryByText("Knowledge entry unavailable")).toBeNull();
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
