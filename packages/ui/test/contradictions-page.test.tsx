import { MemoryRouter, Route, createMemoryHistory } from "@solidjs/router";
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";

import type {
  ContradictionListItem,
  ContradictionListResponse,
} from "~/contracts";
import { ContradictionsPage } from "~/components/lore/ContradictionsPage";
import { ApiError, type ApiClient } from "~/lib/api";
import { WorkspaceProvider } from "~/routes/workspace";

const makePair = (
  overrides: Partial<ContradictionListItem> = {},
): ContradictionListItem => ({
  id_a: "logical-a",
  id_b: "logical-b",
  title_a: "Rule A",
  title_b: "Rule B",
  similarity: 0.94,
  rationale: "These rules conflict.",
  detected_at: Date.UTC(2026, 8, 1, 10),
  project_id_a: "p-lore",
  project_name_a: "lore",
  project_id_b: "p-lore",
  project_name_b: "lore",
  ...overrides,
});

const openPairs: ContradictionListResponse = {
  contradictions: [makePair()],
  total: 1,
};

function clientWith(partial: Partial<ApiClient>): ApiClient {
  return {
    listProjects: async () => [],
    listContradictions: async () => openPairs,
    decideContradiction: async () => ({ status: "dismissed", kept_id: null }),
    ...partial,
  } as unknown as ApiClient;
}

function mount(client: ApiClient) {
  const history = createMemoryHistory();
  history.set({ value: "/ui/contradictions" });
  return render(() => (
    <MemoryRouter base="/ui" history={history}>
      <Route
        path="*"
        component={() => (
          <WorkspaceProvider client={client} db={Promise.resolve(null)}>
            <ContradictionsPage />
          </WorkspaceProvider>
        )}
      />
    </MemoryRouter>
  ));
}

describe("ContradictionsPage", () => {
  it("shows a loading state, then the recorded pair and safe knowledge links", async () => {
    let resolve: ((value: ContradictionListResponse) => void) | undefined;
    mount(
      clientWith({
        listContradictions: () => new Promise((done) => (resolve = done)),
      }),
    );

    expect(screen.getByText("Loading contradictions")).toBeInTheDocument();
    resolve?.(openPairs);
    expect(await screen.findByText("Rule A")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Rule A" })).toHaveAttribute(
      "href",
      "/ui/knowledge/logical-a",
    );
    expect(screen.getByTestId("contradiction-row")).toHaveTextContent(
      "These rules conflict.",
    );
  });

  it("confirms before keeping one side and refreshes the open list", async () => {
    const listContradictions = vi
      .fn<ApiClient["listContradictions"]>()
      .mockResolvedValueOnce(openPairs)
      .mockResolvedValueOnce({ contradictions: [], total: 0 });
    const decideContradiction = vi.fn<ApiClient["decideContradiction"]>(
      async () => ({ status: "resolved", kept_id: "logical-a" }),
    );
    mount(clientWith({ listContradictions, decideContradiction }));

    await screen.findByText("Rule A");
    fireEvent.click(screen.getByRole("button", { name: "Keep Rule A" }));
    expect(screen.getByRole("alertdialog")).toHaveTextContent(
      "permanently remove",
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Keep selected entry" }),
    );

    await screen.findByText("No open contradictions");
    expect(decideContradiction).toHaveBeenCalledWith(
      "logical-a",
      "logical-b",
      "keep-a",
    );
    expect(listContradictions).toHaveBeenCalledTimes(2);
  });

  it("keeps both immediately without removing either knowledge entry", async () => {
    const decideContradiction = vi.fn<ApiClient["decideContradiction"]>(
      async () => ({ status: "dismissed", kept_id: null }),
    );
    const listContradictions = vi
      .fn<ApiClient["listContradictions"]>()
      .mockResolvedValueOnce(openPairs)
      .mockResolvedValueOnce({ contradictions: [], total: 0 });
    mount(clientWith({ listContradictions, decideContradiction }));

    await screen.findByText("Rule A");
    fireEvent.click(screen.getByRole("button", { name: "Keep both" }));
    await screen.findByText("No open contradictions");
    expect(decideContradiction).toHaveBeenCalledWith(
      "logical-a",
      "logical-b",
      "keep-both",
    );
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("renders an empty state", async () => {
    mount(
      clientWith({
        listContradictions: async () => ({ contradictions: [], total: 0 }),
      }),
    );
    expect(
      await screen.findByText("No open contradictions"),
    ).toBeInTheDocument();
  });

  it("explains when hosted mode refuses a review decision", async () => {
    mount(
      clientWith({
        decideContradiction: async () => {
          throw new ApiError(
            "forbidden",
            "/contradictions/a/b",
            "Contradiction review is not available in hosted mode.",
            403,
          );
        },
      }),
    );
    await screen.findByText("Rule A");
    fireEvent.click(screen.getByRole("button", { name: "Keep both" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Contradiction review is not available in hosted mode.",
    );
  });

  it("offers a retry after an unavailable response", async () => {
    const listContradictions = vi
      .fn<ApiClient["listContradictions"]>()
      .mockRejectedValueOnce(
        new ApiError("http", "/contradictions", "gateway error", 500),
      )
      .mockResolvedValueOnce(openPairs);
    mount(clientWith({ listContradictions }));

    expect(
      await screen.findByText("Contradictions unavailable"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByText("Rule A")).toBeInTheDocument());
  });

  it("groups pairs by project with the cross-project group last", async () => {
    mount(
      clientWith({
        listContradictions: async () => ({
          contradictions: [
            makePair(),
            makePair({
              id_a: "pa2",
              id_b: "pb2",
              title_a: "Rule A2",
              title_b: "Rule B2",
            }),
            makePair({
              id_a: "other-a",
              id_b: "other-b",
              title_a: "Other A",
              title_b: "Other B",
              project_id_a: "p-other",
              project_name_a: "other",
              project_id_b: "p-other",
              project_name_b: "other",
            }),
            makePair({
              id_a: "cross-a",
              id_b: "cross-b",
              title_a: "Cross A",
              title_b: "Cross B",
              project_id_b: "p-other",
              project_name_b: "other",
            }),
          ],
          total: 4,
        }),
      }),
    );

    await screen.findByText("Rule A");
    const groups = screen.getAllByTestId("contradiction-group");
    expect(groups).toHaveLength(3);
    expect(groups.map((g) => g.getAttribute("data-group"))).toEqual([
      "p-lore",
      "p-other",
      "cross-project",
    ]);
    const toggles = screen.getAllByTestId("contradiction-group-toggle");
    expect(toggles[0]).toHaveTextContent("lore (2)");
    expect(toggles[1]).toHaveTextContent("other (1)");
    expect(toggles[2]).toHaveTextContent("Cross-project (1)");
    expect(groups[2]).toHaveTextContent(
      "Entries from different projects (or global rules)",
    );
    expect(groups[2]).toHaveTextContent("A: lore · B: other");
  });

  it("collapses and expands a group via its header", async () => {
    mount(clientWith({}));
    const toggle = await screen.findByTestId("contradiction-group-toggle");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getAllByTestId("contradiction-row")).toHaveLength(1);

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryAllByTestId("contradiction-row")).toHaveLength(0);

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getAllByTestId("contradiction-row")).toHaveLength(1);
  });

  it("keeps collapsed state across a list refresh", async () => {
    const listContradictions = vi
      .fn<ApiClient["listContradictions"]>()
      .mockResolvedValue(openPairs);
    mount(clientWith({ listContradictions }));
    const toggle = await screen.findByTestId("contradiction-group-toggle");
    fireEvent.click(toggle);
    expect(screen.queryAllByTestId("contradiction-row")).toHaveLength(0);
  });
});
