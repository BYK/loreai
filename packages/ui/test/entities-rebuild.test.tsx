import { MemoryRouter, Route } from "@solidjs/router";
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";

import { EntitiesPage } from "~/components/lore/EntitiesPage";
import { WorkspaceProvider } from "~/routes/workspace";
import type { ApiClient } from "~/lib/api";
import { ApiError } from "~/lib/api";

function clientWith(partial: Partial<ApiClient>): ApiClient {
  return {
    listProjects: async () => [],
    listEntities: async () => ({ entities: [], next_cursor: null, total: 0 }),
    getEntityRebuildStatus: async () => ({ active: false }),
    ...partial,
  } as unknown as ApiClient;
}

function mount(client: ApiClient) {
  return render(() => (
    <MemoryRouter>
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

const doneResult = {
  dryRun: false,
  cancelled: false,
  results: [
    {
      projectPath: "/tmp/proj",
      dryRun: false,
      scannedDistillations: 4,
      batches: 1,
      detected: 3,
      personsCreated: 2,
      orgsCreated: 1,
      otherCreated: 0,
      relationsCreated: 5,
      mergedIntoSelf: 0,
      dedupMerged: 1,
    },
  ],
};

describe("RebuildCard", () => {
  it("states the cost honestly before the action", async () => {
    mount(clientWith({}));
    const card = await screen.findByTestId("rebuild-card");
    expect(card).toHaveTextContent("costs money");
    expect(card).toHaveTextContent("still costs model calls");
  });

  it("runs a dry run straight away and shows the result table", async () => {
    const rebuildEntities = vi.fn(async () => doneResult);
    mount(clientWith({ rebuildEntities }));
    const preview = await screen.findByRole("button", {
      name: "Preview (dry run)",
    });
    await waitFor(() => expect(preview).toBeEnabled());
    fireEvent.click(preview);
    expect(await screen.findByText(/Rebuild complete/)).toBeInTheDocument();
    expect(rebuildEntities).toHaveBeenCalledWith({ dryRun: true });
    expect(screen.getByTestId("rebuild-results")).toHaveTextContent(
      "/tmp/proj",
    );
  });

  it("confirms before a full rebuild", async () => {
    const rebuildEntities = vi.fn(async () => doneResult);
    mount(clientWith({ rebuildEntities }));
    const rebuildAll = await screen.findByRole("button", {
      name: "Rebuild all",
    });
    await waitFor(() => expect(rebuildAll).toBeEnabled());
    fireEvent.click(rebuildAll);
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("costs money");
    fireEvent.click(
      screen.getByRole("button", { name: "Rebuild all entities" }),
    );
    await waitFor(() =>
      expect(rebuildEntities).toHaveBeenCalledWith({ dryRun: false }),
    );
  });

  it("shows running + Cancel while in flight, and cancels", async () => {
    let resolve: ((v: unknown) => void) | undefined;
    const cancelEntityRebuild = vi.fn(async () => ({ cancelled: true }));
    mount(
      clientWith({
        rebuildEntities: () => new Promise((r) => (resolve = r)) as never,
        cancelEntityRebuild,
      }),
    );
    const preview = await screen.findByRole("button", {
      name: "Preview (dry run)",
    });
    await waitFor(() => expect(preview).toBeEnabled());
    fireEvent.click(preview);
    const cancel = await screen.findByRole("button", { name: "Cancel" });
    expect(screen.getByText(/Running a dry run/)).toBeInTheDocument();
    fireEvent.click(cancel);
    await waitFor(() => expect(cancelEntityRebuild).toHaveBeenCalled());
    resolve?.(doneResult);
    expect(await screen.findByText(/Rebuild complete/)).toBeInTheDocument();
  });

  it("keeps rebuild actions unavailable when status cannot be checked", async () => {
    const getEntityRebuildStatus = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue({ active: false });
    mount(clientWith({ getEntityRebuildStatus }));

    const retry = await screen.findByRole("button", {
      name: "Retry status check",
    });
    expect(
      screen.queryByRole("button", { name: "Preview (dry run)" }),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("rebuild-card")).toHaveTextContent(
      "actions stay disabled until status is confirmed",
    );

    fireEvent.click(retry);
    expect(
      await screen.findByRole("button", { name: "Preview (dry run)" }),
    ).toBeEnabled();
    expect(getEntityRebuildStatus).toHaveBeenCalledTimes(2);
  });

  it("detects a rebuild started elsewhere", async () => {
    mount(
      clientWith({ getEntityRebuildStatus: async () => ({ active: true }) }),
    );
    expect(await screen.findByText(/started elsewhere/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
  });

  it("clears an external rebuild after cancellation is confirmed", async () => {
    let active = true;
    const getEntityRebuildStatus = vi.fn(async () => ({ active }));
    const cancelEntityRebuild = vi.fn(async () => {
      active = false;
      return { cancelled: true };
    });
    mount(
      clientWith({
        getEntityRebuildStatus,
        cancelEntityRebuild,
      }),
    );

    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));

    expect(
      await screen.findByRole("button", { name: "Preview (dry run)" }),
    ).toBeEnabled();
    expect(
      screen.queryByRole("button", { name: "Cancel" }),
    ).not.toBeInTheDocument();
    expect(getEntityRebuildStatus).toHaveBeenCalledTimes(2);
  });

  it("refreshes the entity list after an external rebuild is cancelled", async () => {
    let active = true;
    const listEntities = vi.fn(async () => ({
      entities: [],
      next_cursor: null,
      total: 0,
    }));
    const getEntityRebuildStatus = vi.fn(async () => ({ active }));
    const cancelEntityRebuild = vi.fn(async () => {
      active = false;
      return { cancelled: true };
    });
    mount(
      clientWith({
        listEntities,
        getEntityRebuildStatus,
        cancelEntityRebuild,
      }),
    );

    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(
      await screen.findByRole("button", { name: "Preview (dry run)" }),
    ).toBeEnabled();
    await waitFor(() =>
      expect(listEntities.mock.calls.length).toBeGreaterThan(1),
    );
  });

  it("surfaces a hosted-mode refusal", async () => {
    mount(
      clientWith({
        rebuildEntities: async () => {
          throw new ApiError("forbidden", "/entities/rebuild", "hosted", 403);
        },
      }),
    );
    const preview = await screen.findByRole("button", {
      name: "Preview (dry run)",
    });
    await waitFor(() => expect(preview).toBeEnabled());
    fireEvent.click(preview);
    const card = await screen.findByTestId("rebuild-card");
    await waitFor(() =>
      expect(card).toHaveTextContent("Not available in hosted mode"),
    );
  });
});
