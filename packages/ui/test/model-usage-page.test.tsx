import { MemoryRouter, Route, createMemoryHistory } from "@solidjs/router";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@solidjs/testing-library";
import { beforeAll, describe, expect, it, vi } from "vitest";

import type { ModelUsageDocument } from "~/contracts";
import { ModelUsagePage } from "~/components/lore/ModelUsagePage";
import { Nav } from "~/components/shell/Nav";
import { ConnectionContext, createConnectionStore } from "~/lib/connection";
import type { ApiClient } from "~/lib/api";
import { ApiError } from "~/contracts";
import { WorkspaceProvider } from "~/routes/workspace";

beforeAll(() => {
  // jsdom has no ResizeObserver; the chart only needs observe/disconnect.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

const usageData: ModelUsageDocument = {
  format: "model-tides-daily",
  version: 2,
  source: "lore",
  days: [
    { day: "2026-09-01", models: { "anthropic/claude-sonnet-4": 3 } },
    {
      day: "2026-09-02",
      models: {
        "anthropic/claude-sonnet-4": 2,
        "openai/gpt-5": 5,
      },
    },
    { day: "2026-09-30", models: { "openai/gpt-5": 1, "openai/gpt-4o": 1 } },
  ],
};

const emptyDoc: ModelUsageDocument = {
  format: "model-tides-daily",
  version: 2,
  source: "lore",
  days: [],
};

const emptyUpload = {
  snapshot: { format: "model-tides-weekly", version: 2, weeks: [] },
  snapshot_sha256: "0".repeat(64),
  upload_os: "linux",
  report: null,
} as const;

function clientWith(partial: Partial<ApiClient>): ApiClient {
  return {
    listProjects: async () => [],
    getModelUsageUpload: async () => emptyUpload,
    ...partial,
  } as unknown as ApiClient;
}

function mountPage(
  client: ApiClient,
  initial = "/model-usage",
  projects: { id: string; name?: string; path?: string }[] = [],
) {
  const history = createMemoryHistory();
  history.set({ value: initial });
  client.listProjects = async () =>
    projects.map((p) => ({ knowledge_count: 0, ...p })) as never;
  return render(() => (
    <MemoryRouter history={history}>
      <Route
        path="*"
        component={() => (
          <WorkspaceProvider client={client} db={Promise.resolve(null)}>
            <ModelUsagePage />
          </WorkspaceProvider>
        )}
      />
    </MemoryRouter>
  ));
}

describe("ModelUsagePage", () => {
  it("renders the flow chart SVG, legend and totals table", async () => {
    mountPage(clientWith({ getModelUsage: async () => usageData }));
    await waitFor(() =>
      expect(document.querySelector("svg.flow-svg")).toBeTruthy(),
    );
    expect(
      document.querySelector("svg.flow-svg")?.getAttribute("aria-label"),
    ).toBe("Your model usage over time");
    // Tooltip stays hidden until the first pointer move (#2034).
    expect(
      document.querySelector<HTMLDivElement>(".chart-tooltip")?.hidden,
    ).toBe(true);
    expect(screen.getByTestId("model-legend").textContent).toContain(
      "claude-sonnet-4",
    );
    const rows = await screen.findAllByRole("row");
    // header + 3 models, default order Session-days desc: gpt-5 (6), sonnet (5), gpt-4o (1)
    const firstCells = rows
      .slice(1)
      .map((row) => within(row).queryAllByRole("cell")[0]?.textContent);
    expect(firstCells).toEqual(["GPT-5", "claude-sonnet-4", "GPT-4o"]);
    expect(screen.getByTestId("chart-status").textContent).toContain(
      "12 active session-days",
    );
  });

  it("click-to-sort changes primary key and stacked sort works", async () => {
    mountPage(clientWith({ getModelUsage: async () => usageData }));
    await waitFor(() =>
      expect(document.querySelectorAll("tbody tr").length).toBe(3),
    );
    const modelHeader = screen.getByRole("button", {
      name: /^Sort by Model/,
    });
    fireEvent.click(modelHeader);
    await waitFor(() =>
      expect(screen.getByLabelText(/Sort by Model, level 1/)).toBeTruthy(),
    );
    let cells = document
      .querySelectorAll("tbody tr td:first-child")
      .values()
      .map((td) => td.textContent)
      .toArray();
    expect(cells).toEqual(["claude-sonnet-4", "GPT-4o", "GPT-5"]);
    // second click on same field toggles direction
    fireEvent.click(screen.getByLabelText(/Sort by Model, level 1/));
    await waitFor(() => {
      cells = document
        .querySelectorAll("tbody tr td:first-child")
        .values()
        .map((td) => td.textContent)
        .toArray();
      expect(cells).toEqual(["GPT-5", "GPT-4o", "claude-sonnet-4"]);
    });
    expect(document.querySelector("caption")?.textContent).toContain(
      "Sorted by Model",
    );
  });

  it("fuzzy filters models", async () => {
    mountPage(clientWith({ getModelUsage: async () => usageData }));
    await waitFor(() =>
      expect(document.querySelectorAll("tbody tr").length).toBe(3),
    );
    fireEvent.input(screen.getByLabelText("Filter models"), {
      target: { value: "sonnet" },
    });
    await waitFor(() => {
      const cells = document.querySelectorAll("tbody tr td:first-child");
      expect(cells.length).toBe(1);
      expect(cells[0]?.textContent).toBe("claude-sonnet-4");
    });
  });

  it("date presets narrow the totals and chart", async () => {
    mountPage(clientWith({ getModelUsage: async () => usageData }));
    await waitFor(() =>
      expect(document.querySelectorAll("tbody tr").length).toBe(3),
    );
    expect(screen.getByTestId("chart-status").textContent).toContain(
      "12 active session-days",
    );
    fireEvent.click(screen.getByText("4 weeks"));
    await waitFor(() =>
      expect(screen.getByTestId("chart-status").textContent).toContain(
        "2 active session-days",
      ),
    );
    // 4-week window covers only 2026-09-10 → only gpt-5 + gpt-4o remain
    const cells = document
      .querySelectorAll("tbody tr td:first-child")
      .values()
      .map((td) => td.textContent)
      .toArray();
    expect(cells).toEqual(["GPT-4o", "GPT-5"]);
    fireEvent.click(screen.getByText("All"));
    await waitFor(() =>
      expect(screen.getByTestId("chart-status").textContent).toContain(
        "12 active session-days",
      ),
    );
  });

  it("project change refetches with project= and updates export href", async () => {
    const getModelUsage = vi.fn(async () => usageData);
    mountPage(clientWith({ getModelUsage }), "/model-usage", [
      { id: "proj-2", name: "Project Two" },
    ]);
    await waitFor(() =>
      expect(document.querySelectorAll("tbody tr").length).toBe(3),
    );
    expect(getModelUsage).toHaveBeenCalledWith({ project: undefined });
    expect(screen.getByTestId("export-link").getAttribute("href")).toContain(
      "/api/v1/model-usage/export?from=2026-09-01&to=2026-09-30",
    );
    // select via the search param path directly (Select is a dropdown;
    // setting ?project= is the state change that matters)
    const history = createMemoryHistory();
    history.set({ value: "/model-usage?project=proj-2" });
    render(() => (
      <MemoryRouter history={history}>
        <Route
          path="*"
          component={() => (
            <WorkspaceProvider
              client={clientWith({
                getModelUsage,
                listProjects: async () =>
                  [
                    { id: "proj-2", name: "Project Two", knowledge_count: 0 },
                  ] as never,
              })}
              db={Promise.resolve(null)}
            >
              <ModelUsagePage />
            </WorkspaceProvider>
          )}
        />
      </MemoryRouter>
    ));
    await waitFor(() =>
      expect(getModelUsage).toHaveBeenCalledWith({ project: "proj-2" }),
    );
    await waitFor(() => {
      const links = screen.getAllByTestId("export-link");
      expect(links.length).toBe(2);
      expect(links[1]?.getAttribute("href")).toContain("project=proj-2");
    });
    // The closed trigger keeps showing "All projects" by default and shows
    // the project name while a project is selected.
    const triggers = screen.getAllByTestId("project-select");
    expect(triggers[0]?.textContent).toBe("All projects");
    await waitFor(() => expect(triggers[1]?.textContent).toBe("Project Two"));
  });

  it("keeps 'All projects' in the trigger after selecting and switching back", async () => {
    mountPage(
      clientWith({ getModelUsage: async () => usageData }),
      "/model-usage",
      [{ id: "proj-2", name: "Project Two" }],
    );
    await waitFor(() =>
      expect(document.querySelectorAll("tbody tr").length).toBe(3),
    );
    const trigger = screen.getByTestId("project-select");
    expect(trigger.textContent).toBe("All projects");
    // Kobalte opens the listbox on a primary-button pointerdown.
    fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" });
    fireEvent.click(await screen.findByRole("option", { name: "Project Two" }));
    await waitFor(() => expect(trigger.textContent).toBe("Project Two"));
    fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" });
    fireEvent.click(
      await screen.findByRole("option", { name: "All projects" }),
    );
    await waitFor(() => expect(trigger.textContent).toBe("All projects"));
  });

  it("shows the nothing-recorded empty state", async () => {
    mountPage(clientWith({ getModelUsage: async () => emptyDoc }));
    expect(await screen.findByText("No model usage recorded yet")).toBeTruthy();
  });

  it("shows the no-activity-in-window state with a Show all action", async () => {
    mountPage(
      clientWith({ getModelUsage: async () => usageData }),
      "/model-usage?from=2026-09-03&to=2026-09-05",
    );
    await screen.findByText("No model activity in this window.");
    fireEvent.click(screen.getByText("Show all"));
    await waitFor(() =>
      expect(screen.getByTestId("chart-status").textContent).toContain(
        "12 active session-days",
      ),
    );
  });

  it("renders model names containing HTML-syntactic characters safely", async () => {
    const evilDoc: ModelUsageDocument = {
      format: "model-tides-daily",
      version: 2,
      source: "lore",
      days: [
        {
          day: "2026-09-01",
          models: { "evil/<img src=x onerror=alert(1)>\"&'": 1 },
        },
      ],
    };
    mountPage(clientWith({ getModelUsage: async () => evilDoc }));
    await waitFor(() =>
      expect(document.querySelector("svg.flow-svg")).toBeTruthy(),
    );
    expect(document.querySelector("svg.flow-svg img")).toBeNull();
    // the renderer escapes to text; the raw payload string survives
    // (inside attribute values innerHTML reserialises `&lt;` as `<` —
    // harmless text, no element is created)
    expect(document.querySelector("svg.flow-svg")?.innerHTML).toContain(
      "img src=x",
    );
  });

  it("marks the Model usage nav item active on /model-usage", async () => {
    const history = createMemoryHistory();
    history.set({ value: "/model-usage" });
    render(() => (
      <MemoryRouter history={history}>
        <Route
          path="*"
          component={() => (
            <ConnectionContext.Provider value={createConnectionStore()}>
              <Nav activeProjectId={null} />
            </ConnectionContext.Provider>
          )}
        />
      </MemoryRouter>
    ));
    await waitFor(() =>
      expect(
        screen.getByTestId("nav-model-usage").getAttribute("aria-current"),
      ).toBe("page"),
    );
  });
});

const uploadState = (overrides: Record<string, unknown> = {}) => ({
  snapshot: {
    format: "model-tides-weekly" as const,
    version: 2 as const,
    weeks: [
      {
        week: "2026-09-01",
        models: { "anthropic/claude-sonnet-4": 4, "openai/gpt-5": 1 },
      },
    ],
  },
  snapshot_sha256: "a".repeat(64),
  upload_os: "linux" as const,
  report: null,
  ...overrides,
});

const storedReport = {
  id: "7b2f9a3e-1c4d-7e5f-8a6b-0c1d2e3f4a5b",
  url: "https://modeltides.dev/u/7b2f9a3e-1c4d-7e5f-8a6b-0c1d2e3f4a5b",
  published: true,
  inAggregate: false,
  revision: 7,
  metricVersion: 2,
  snapshot: {
    format: "model-tides-weekly" as const,
    version: 2 as const,
    weeks: [{ week: "2026-09-01", models: { "openai/gpt-5": 3 } }],
  },
};

describe("ModelTidesUpload", () => {
  it("review dialog lists every cell + privacy text and gates on YES", async () => {
    const posted: Record<string, unknown>[] = [];
    mountPage(
      clientWith({
        getModelUsage: async () => usageData,
        getModelUsageUpload: async () => uploadState(),
        postModelUsageUpload: async (body) => {
          posted.push(body);
          return { id: "id" };
        },
      }),
    );
    const btn = await screen.findByRole("button", { name: "Review upload…" });
    expect(screen.getByText(/Nothing is uploaded automatically/)).toBeTruthy();
    fireEvent.click(btn);
    const dialog = await screen.findByRole("alertdialog", {
      name: "Review upload",
    });
    expect(within(dialog).getByText("Week of 2026-09-01")).toBeTruthy();
    expect(within(dialog).getByText("anthropic/claude-sonnet-4")).toBeTruthy();
    expect(within(dialog).getByText("openai/gpt-5")).toBeTruthy();
    expect(within(dialog).getByText("4")).toBeTruthy();
    expect(within(dialog).getByText(/No prompts, replies, paths/)).toBeTruthy();
    expect(
      within(dialog).getByText(/uploading OS \(linux\) are sent/),
    ).toBeTruthy();
    expect(
      within(dialog).getByText(/viewable by anyone with its link/),
    ).toBeTruthy();
    const confirm = within(dialog).getByRole("button", { name: "Confirm" });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.input(within(dialog).getByLabelText("Type YES to confirm"), {
      target: { value: "yes" },
    });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.input(within(dialog).getByLabelText("Type YES to confirm"), {
      target: { value: "YES" },
    });
    expect((confirm as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({
      confirm: "YES",
      snapshot_sha256: "a".repeat(64),
    });
  });

  it("409 stale_review shows the changed-counts message and reloads", async () => {
    let fetches = 0;
    mountPage(
      clientWith({
        getModelUsage: async () => usageData,
        getModelUsageUpload: async () => {
          fetches += 1;
          return uploadState({
            snapshot_sha256: `${fetches}`.padStart(64, "0"),
          });
        },
        postModelUsageUpload: async () => {
          throw new ApiError(
            "http",
            "/model-usage/upload",
            "Counts changed since you reviewed them",
            409,
            "stale_review",
          );
        },
      }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Review upload…" }),
    );
    const dialog = await screen.findByRole("alertdialog", {
      name: "Review upload",
    });
    fireEvent.input(within(dialog).getByLabelText("Type YES to confirm"), {
      target: { value: "YES" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
    await waitFor(() =>
      expect(
        within(dialog).getByText("Counts changed since you reviewed them"),
      ).toBeTruthy(),
    );
    expect(fetches).toBe(2);
  });

  it("post-upload controls: link + share/contribute/delete/rotate with reviewed_revision", async () => {
    const calls: { action?: string; body: unknown }[] = [];
    mountPage(
      clientWith({
        getModelUsage: async () => usageData,
        getModelUsageUpload: async () => uploadState({ report: storedReport }),
        postModelUsageUploadAction: async (action, body) => {
          calls.push({ action, body });
          return { id: storedReport.id };
        },
      }),
    );
    const link = await screen.findByRole("link", {
      name: "Your public report",
    });
    expect(link.getAttribute("href")).toBe(storedReport.url);
    fireEvent.click(screen.getByRole("button", { name: "Contribute" }));
    const dialog = await screen.findByRole("alertdialog", {
      name: "Contribute to the community aggregate",
    });
    // Reviews the stored report's cells, not the local snapshot.
    expect(within(dialog).getByText("openai/gpt-5")).toBeTruthy();
    fireEvent.input(within(dialog).getByLabelText("Type YES to confirm"), {
      target: { value: "YES" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({
      action: "contribute",
      body: { confirm: "YES", reviewed_revision: 7 },
    });
  });

  it("report_error shows the error and disables mutation buttons except delete/rotate", async () => {
    mountPage(
      clientWith({
        getModelUsage: async () => usageData,
        getModelUsageUpload: async () =>
          uploadState({
            report: storedReport,
            report_error: "Could not confirm personal report",
          }),
      }),
    );
    await waitFor(() =>
      expect(
        screen.getByText(/Could not confirm your stored report/),
      ).toBeTruthy(),
    );
    const review = screen.getByRole<HTMLButtonElement>("button", {
      name: "Review upload…",
    });
    const contribute = screen.getByRole<HTMLButtonElement>("button", {
      name: "Contribute",
    });
    expect(review.disabled).toBe(true);
    expect(contribute.disabled).toBe(true);
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Rotate key" })
        .disabled,
    ).toBe(false);
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Delete report" })
        .disabled,
    ).toBe(false);
  });

  it("reopening a YES dialog resets the input and disables confirm", async () => {
    mountPage(
      clientWith({
        getModelUsage: async () => usageData,
        getModelUsageUpload: async () => uploadState({ report: storedReport }),
      }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Delete report" }),
    );
    const dialog = await screen.findByRole("alertdialog", {
      name: "Delete Model Tides report",
    });
    const input = within(dialog).getByLabelText("Type YES to confirm");
    fireEvent.input(input, { target: { value: "YES" } });
    expect(
      within(dialog).getByRole<HTMLButtonElement>("button", {
        name: "Confirm",
      }).disabled,
    ).toBe(false);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("alertdialog", {
          name: "Delete Model Tides report",
        }),
      ).toBeNull(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete report" }));
    const reopened = await screen.findByRole("alertdialog", {
      name: "Delete Model Tides report",
    });
    expect(
      within(reopened).getByLabelText<HTMLInputElement>("Type YES to confirm")
        .value,
    ).toBe("");
    expect(
      within(reopened).getByRole<HTMLButtonElement>("button", {
        name: "Confirm",
      }).disabled,
    ).toBe(true);
  });
});
