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

function clientWith(partial: Partial<ApiClient>): ApiClient {
  return { listProjects: async () => [], ...partial } as unknown as ApiClient;
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
              client={clientWith({ getModelUsage })}
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
              <Nav
                projects={[]}
                loading={false}
                error={undefined}
                activeProjectId={null}
                totalKnowledge={0}
              />
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
