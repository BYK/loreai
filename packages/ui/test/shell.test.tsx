import { MemoryRouter, createMemoryHistory } from "@solidjs/router";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createAppRoot, routes } from "~/app";
import { knowledgeHref } from "~/routes/Browse";
import { ApiError, type ApiClient } from "~/lib/api";
import type { KnowledgeEntry, ProjectSummary } from "~/lib/schemas";
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

function fakeClient(
  overrides: Overrides = {},
): ApiClient & { calls: string[] } {
  const calls: string[] = [];
  const client: ApiClient = {
    async listProjects() {
      calls.push("projects");
      return PROJECTS;
    },
    async listProjectKnowledge(projectId) {
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
    async getKnowledge(id) {
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
    ...overrides,
  };
  return Object.assign(client, { calls });
}

function mount(path: string, client: ApiClient) {
  const history = createMemoryHistory();
  history.set({ value: path });
  const utils = render(() => (
    <MemoryRouter history={history} root={createAppRoot(client)}>
      {routes}
    </MemoryRouter>
  ));
  return { ...utils, history };
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
    const rows = await screen.findAllByTestId("knowledge-row");
    expect(rows[0]).toHaveTextContent("Keep SQLite");
    expect(rows[1]).toHaveTextContent("WAL recovery");
    expect(pane("list")).toHaveTextContent("2 entries");
    expect(screen.getByText("Select an entry")).toBeInTheDocument();
    expect(document.querySelector("[data-mobile-pane]")).toHaveAttribute(
      "data-mobile-pane",
      "list",
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
    expect(rows[1]).toHaveAttribute("aria-current", "page");
    expect(rows[0]).not.toHaveAttribute("aria-current");
    expect(document.querySelector("[data-mobile-pane]")).toHaveAttribute(
      "data-mobile-pane",
      "detail",
    );
    expect(screen.getByTestId("mobile-back")).toHaveAttribute(
      "href",
      "/projects/p-lore",
    );
    expect(client.calls).toEqual([
      "projects",
      "knowledge:p-lore",
      "entry:k-wal",
    ]);
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
  it("shows an empty state for a project without knowledge", async () => {
    mount("/projects/p-empty", fakeClient());
    expect(await screen.findByText("No knowledge yet")).toBeInTheDocument();
    expect(pane("list")).toHaveTextContent("0 entries");
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

  it("clears the error card while a retry is in flight instead of keeping the stale error", async () => {
    let attempts = 0;
    let release: (entries: KnowledgeEntry[]) => void = () => {};
    const client = fakeClient({
      async listProjectKnowledge() {
        attempts++;
        if (attempts === 1) {
          throw new ApiError("http", "/projects/p-lore/knowledge", "boom", 500);
        }
        return new Promise<KnowledgeEntry[]>((resolve) => {
          release = resolve;
        });
      },
    });
    mount("/projects/p-lore", client);
    await screen.findByText("Knowledge unavailable");

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(screen.queryByText("Knowledge unavailable")).toBeNull(),
    );
    expect(screen.getByText("Loading knowledge…")).toBeInTheDocument();
    expect(attempts).toBe(2);

    release(ENTRIES);
    await screen.findByText("Keep SQLite");
    expect(screen.queryByText("Loading knowledge…")).toBeNull();
    expect(screen.queryByText("Knowledge unavailable")).toBeNull();
  });

  it("renders the locked state when the gateway hides management from this peer", async () => {
    const client = fakeClient({
      async listProjects() {
        throw new ApiError("unauthorized", "/projects", "hidden", 404);
      },
      async listProjectKnowledge() {
        throw new ApiError(
          "unauthorized",
          "/projects/p-lore/knowledge",
          "hidden",
          404,
        );
      },
    });
    mount("/projects/p-lore", client);
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
  it("explains that search arrives in UI-04 instead of accepting a query", async () => {
    mount("/", fakeClient());
    fireEvent.click(screen.getByTestId("search-entry"));
    expect(await screen.findByRole("dialog")).toHaveTextContent(
      "Search arrives in UI-04",
    );
    expect(screen.queryByRole("searchbox")).toBeNull();
  });

  it("toggles dark mode via the .dark class and persists the choice", async () => {
    mount("/", fakeClient());
    const toggle = screen.getByTestId("theme-toggle");
    expect(document.documentElement).not.toHaveClass("dark");
    fireEvent.click(toggle);
    await waitFor(() => expect(document.documentElement).toHaveClass("dark"));
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(document.documentElement).not.toHaveClass("dark"),
    );
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
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
    fireEvent.click(screen.getByTestId("theme-toggle"));
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

  it("renders the fixture as a labelled non-production specimen without API calls", async () => {
    const client = fakeClient();
    mount("/fixture", client);
    expect(screen.getByTestId("fixture-banner")).toHaveTextContent(
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
    fireEvent.click(screen.getByTestId("open-focus"));
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
});
