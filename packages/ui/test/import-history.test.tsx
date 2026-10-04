import {
  MemoryRouter,
  Route,
  createMemoryHistory,
  useSearchParams,
} from "@solidjs/router";
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";

import { ImportHistoryPage } from "~/components/lore/ImportHistoryPage";
import { WorkspaceProvider } from "~/routes/workspace";
import type { ApiClient } from "~/lib/api";
import { ApiError } from "~/lib/api";
import type { ImportRecord } from "~/contracts";

const makeImport = (over: Partial<ImportRecord> = {}): ImportRecord => ({
  id: "imp-1",
  project_id: "p-1",
  agent_name: "claude",
  source_id: "session-abc",
  source_hash: "hash",
  entries_created: 3,
  entries_updated: 1,
  imported_at: 1_700_000_000_000,
  ...over,
});

function clientWith(partial: Partial<ApiClient>): ApiClient {
  return {
    listProjects: async () => [],
    listProjectImports: async () => ({
      imports: [makeImport()],
      next_cursor: null,
      total: 1,
    }),
    ...partial,
  } as unknown as ApiClient;
}

const Routed = () => {
  const [params] = useSearchParams();
  return (
    <ImportHistoryPage
      projectId="p-1"
      cursor={typeof params.cursor === "string" ? params.cursor : null}
    />
  );
};

function mount(client: ApiClient, path = "/projects/p-1/imports") {
  const history = createMemoryHistory();
  history.set({ value: path });
  return render(() => (
    <MemoryRouter history={history}>
      <Route
        path="*"
        component={() => (
          <WorkspaceProvider client={client} db={Promise.resolve(null)}>
            <Routed />
          </WorkspaceProvider>
        )}
      />
    </MemoryRouter>
  ));
}

describe("ImportHistoryPage", () => {
  it("shows loading then the import table", async () => {
    let resolve: ((v: unknown) => void) | undefined;
    const client = clientWith({
      listProjectImports: () => new Promise((r) => (resolve = r)) as never,
    });
    mount(client);
    expect(screen.getByText("Loading imports")).toBeInTheDocument();
    resolve?.({ imports: [makeImport()], next_cursor: null, total: 1 });
    expect(await screen.findByText("claude")).toBeInTheDocument();
    expect(screen.getByText("session-abc")).toBeInTheDocument();
    expect(screen.getByText("1 import")).toBeInTheDocument();
  });

  it("renders the empty state", async () => {
    mount(
      clientWith({
        listProjectImports: async () => ({
          imports: [],
          next_cursor: null,
          total: 0,
        }),
      }),
    );
    expect(await screen.findByText("No imports")).toBeInTheDocument();
    expect(
      screen.getByText("No conversation imports recorded for this project."),
    ).toBeInTheDocument();
  });

  it("renders the unauthorized state", async () => {
    mount(
      clientWith({
        listProjectImports: async () => {
          throw new ApiError("unauthorized", "/x", "nope");
        },
      }),
    );
    await waitFor(() =>
      expect(document.querySelector('[data-state="locked"]')).not.toBeNull(),
    );
  });

  it("pages forward with next_cursor and back via the history stack", async () => {
    const calls: Array<{ page: string | null | undefined }> = [];
    const pages: Record<string, unknown> = {
      first: {
        imports: [makeImport({ id: "imp-1", source_id: "s-1" })],
        next_cursor: "cur-2",
        total: 2,
      },
      second: {
        imports: [makeImport({ id: "imp-2", source_id: "s-2" })],
        next_cursor: null,
        total: 2,
      },
    };
    const client = clientWith({
      listProjectImports: async (
        _id: string,
        opts: { page?: string | null },
      ) => {
        calls.push({ page: opts.page });
        return (opts.page === "cur-2" ? pages.second : pages.first) as never;
      },
    });
    mount(client);
    expect(await screen.findByText("s-1")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText("s-2")).toBeInTheDocument();
    expect(calls.at(-1)?.page).toBe("cur-2");

    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect(await screen.findByText("s-1")).toBeInTheDocument();
  });

  it("renders a malicious source id as inert text", async () => {
    mount(
      clientWith({
        listProjectImports: async () => ({
          imports: [
            makeImport({
              agent_name: "<img src=x onerror=alert(1)>",
              source_id: "javascript:alert(1)",
            }),
          ],
          next_cursor: null,
          total: 1,
        }),
      }),
    );
    expect(
      await screen.findByText("<img src=x onerror=alert(1)>"),
    ).toBeInTheDocument();
    expect(screen.getByText("javascript:alert(1)")).toBeInTheDocument();
    expect(document.querySelector("img")).toBeNull();
  });
});
