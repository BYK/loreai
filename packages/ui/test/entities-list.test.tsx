import { MemoryRouter, Route, createMemoryHistory } from "@solidjs/router";
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";

import { EntitiesPage } from "~/components/lore/EntitiesPage";
import { WorkspaceProvider } from "~/routes/workspace";
import type { ApiClient } from "~/lib/api";
import { ApiError } from "~/lib/api";
import type { EntityListItem } from "~/contracts";

const makeEntity = (over: Partial<EntityListItem> = {}): EntityListItem => ({
  id: "e-1",
  entity_type: "person",
  canonical_name: "Ada Lovelace",
  project_id: null,
  cross_project: true,
  aliases: ["ada@example.com"],
  created_at: 1,
  updated_at: 2,
  ...over,
});

function clientWith(partial: Partial<ApiClient>): ApiClient {
  return {
    listProjects: async () => [],
    listEntities: async () => ({
      entities: [makeEntity()],
      next_cursor: null,
      total: 1,
    }),
    getEntityRebuildStatus: async () => ({ active: false }),
    ...partial,
  } as unknown as ApiClient;
}

function mount(client: ApiClient, path = "/entities") {
  const history = createMemoryHistory();
  history.set({ value: path });
  return render(() => (
    <MemoryRouter history={history}>
      <Route
        path="*"
        component={() => (
          <WorkspaceProvider client={client} db={Promise.resolve(null)}>
            <EntitiesPage />
          </WorkspaceProvider>
        )}
      />
    </MemoryRouter>
  ));
}

describe("EntitiesPage", () => {
  it("shows a loading state then the list", async () => {
    let resolve: ((v: unknown) => void) | undefined;
    const client = clientWith({
      listEntities: () => new Promise((r) => (resolve = r)) as never,
    });
    mount(client);
    expect(screen.getByText("Loading entities")).toBeInTheDocument();
    resolve?.({ entities: [makeEntity()], next_cursor: null, total: 1 });
    expect(await screen.findByText("Ada Lovelace")).toBeInTheDocument();
    expect(screen.getByTestId("entity-row")).toHaveAttribute(
      "href",
      "/entities/e-1",
    );
  });

  it("renders the empty state", async () => {
    mount(
      clientWith({
        listEntities: async () => ({
          entities: [],
          next_cursor: null,
          total: 0,
        }),
      }),
    );
    expect(await screen.findByText("No entities yet")).toBeInTheDocument();
  });

  it("renders the error state with retry", async () => {
    mount(
      clientWith({
        listEntities: async () => {
          throw new ApiError("http", "/entities", "boom", 500);
        },
      }),
    );
    expect(await screen.findByText("Entities unavailable")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("renders the unauthorized state as locked", async () => {
    mount(
      clientWith({
        listEntities: async () => {
          throw new ApiError("unauthorized", "/entities", "hidden", 404);
        },
      }),
    );
    expect(
      await screen.findByText("Entities hidden by the gateway"),
    ).toBeInTheDocument();
  });

  it("passes the type filter through to the API", async () => {
    const listEntities = vi.fn<ApiClient["listEntities"]>(async () => ({
      entities: [],
      next_cursor: null,
      total: 0,
    }));
    mount(clientWith({ listEntities }), "/entities?type=org");
    await waitFor(() => expect(listEntities).toHaveBeenCalled());
    expect(listEntities.mock.calls[0]?.[0]).toMatchObject({ type: "org" });
  });

  it("pages with Next using the server cursor", async () => {
    const listEntities = vi
      .fn()
      .mockResolvedValueOnce({
        entities: [makeEntity()],
        next_cursor: "tok",
        total: 2,
      })
      .mockResolvedValueOnce({
        entities: [makeEntity({ id: "e-2", canonical_name: "Bob" })],
        next_cursor: null,
        total: 2,
      });
    mount(clientWith({ listEntities }));
    const next = await screen.findByRole("button", { name: "Next" });
    await waitFor(() => expect(next).toBeEnabled());
    fireEvent.click(next);
    await waitFor(() =>
      expect(listEntities).toHaveBeenCalledWith(
        expect.objectContaining({ page: "tok" }),
        expect.anything(),
      ),
    );
    expect(await screen.findByText("Bob")).toBeInTheDocument();
  });
});
