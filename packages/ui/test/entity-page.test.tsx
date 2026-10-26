import { MemoryRouter, Route, createMemoryHistory } from "@solidjs/router";
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";

import { EntityPage } from "~/components/lore/EntityPage";
import { WorkspaceProvider } from "~/routes/workspace";
import type { ApiClient } from "~/lib/api";
import { ApiError } from "~/lib/api";
import type { EntityDetail } from "~/contracts";

const detail = (over: Partial<EntityDetail["entity"]> = {}): EntityDetail => ({
  entity: {
    id: "e-1",
    entity_type: "person",
    canonical_name: "Ada Lovelace",
    project_id: null,
    cross_project: true,
    aliases: ["ada@example.com"],
    created_at: 1,
    updated_at: 2,
    metadata: { role: "engineer" },
    ...over,
  },
  relations: [
    {
      id: "r-1",
      relation: "colleague",
      direction: "outgoing",
      other_id: "e-2",
      other_name: "Charles Babbage",
      other_type: "person",
      created_at: 1,
    },
  ],
  knowledge: [
    {
      id: "k-1",
      title: "Built the analytical engine",
      category: "decision",
      project_id: null,
    },
  ],
});

function clientWith(partial: Partial<ApiClient>): ApiClient {
  return {
    listProjects: async () => [],
    getEntity: async () => detail(),
    ...partial,
  } as unknown as ApiClient;
}

function mount(client: ApiClient, base = "") {
  const history = createMemoryHistory();
  history.set({ value: `${base}/entities/e-1` });
  return render(() => (
    <MemoryRouter history={history} base={base}>
      <Route
        path="*"
        component={() => (
          <WorkspaceProvider client={client} db={Promise.resolve(null)}>
            <EntityPage entityId="e-1" />
          </WorkspaceProvider>
        )}
      />
    </MemoryRouter>
  ));
}

describe("EntityPage", () => {
  it("renders detail: name, aliases, metadata form, relations, knowledge", async () => {
    mount(clientWith({}));
    expect(await screen.findByTestId("entity-name")).toHaveTextContent(
      "Ada Lovelace",
    );
    expect(screen.getByText("ada@example.com")).toBeInTheDocument();
    expect(screen.getByDisplayValue("engineer")).toBeInTheDocument();
    expect(screen.getByText("Charles Babbage")).toBeInTheDocument();
    expect(screen.getByText("Built the analytical engine")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Built the analytical engine" }),
    ).toHaveAttribute("href", "/knowledge/k-1");
  });

  it("prioritizes recorded context and evidence, links accurate relation directions under /ui", async () => {
    const data = detail({
      metadata: {
        description: "Recorded engine collaborator",
        notes: "private notes",
      },
    });
    const relation = data.relations[0];
    if (!relation) throw new Error("Missing relation fixture");
    data.relations.push({
      ...relation,
      id: "r-in",
      relation: "employs",
      direction: "incoming",
      other_id: "org/space ?",
      other_name: "Engine Company",
      other_type: "org",
    });
    data.knowledge = [
      {
        id: "global/a ?",
        title: "Workspace evidence",
        category: "decision",
        project_id: null,
      },
      {
        id: "project/a ?",
        title: "Project evidence",
        category: "pattern",
        project_id: "p/a ?",
      },
    ];
    mount(clientWith({ getEntity: async () => data }), "/ui");
    expect(
      await screen.findByText("Recorded engine collaborator"),
    ).toBeInTheDocument();
    const incoming = screen.getByRole("link", { name: "Engine Company" });
    expect(incoming).toHaveAttribute("href", "/ui/entities/org%2Fspace%20%3F");
    expect(incoming.closest("li")).toHaveTextContent(
      "Engine Company org employs → Ada Lovelace",
    );
    expect(
      screen.getByRole("link", { name: "Charles Babbage" }).closest("li"),
    ).toHaveTextContent("Ada Lovelace colleague → Charles Babbage person");
    expect(
      screen.getByRole("link", { name: "Workspace evidence" }),
    ).toHaveAttribute("href", "/ui/knowledge/global%2Fa%20%3F");
    expect(
      screen.getByRole("link", { name: "Project evidence" }),
    ).toHaveAttribute(
      "href",
      "/ui/projects/p%2Fa%20%3F/knowledge/project%2Fa%20%3F",
    );
    const administration = screen
      .getByText("Edit entity details")
      .closest("details");
    if (!administration) throw new Error("Missing details disclosure");
    expect(administration).not.toHaveAttribute("open");
    expect(
      screen
        .getByTestId("entity-knowledge")
        .compareDocumentPosition(administration) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("shows the not-found state for an unknown id", async () => {
    mount(
      clientWith({
        getEntity: async () => {
          throw new ApiError(
            "not_found",
            "/entities/x",
            "Entity not found",
            404,
          );
        },
      }),
    );
    expect(await screen.findByText("Entity not found")).toBeInTheDocument();
  });

  it("enables Save only when dirty and PATCHes the metadata", async () => {
    const updateEntityMetadata = vi.fn(async () =>
      detail({ metadata: { role: "engineer", notes: "new note" } }),
    );
    mount(clientWith({ updateEntityMetadata }));
    const save = await screen.findByRole("button", { name: "Save" });
    expect(save).toBeDisabled();
    const notes = screen.getByTestId("entity-notes") as HTMLTextAreaElement;
    notes.value = "new note";
    // A direct listener must see input events even when an integration
    // primitive prevents them from bubbling (as happened in mobile e2e).
    notes.dispatchEvent(new Event("input"));
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() =>
      expect(updateEntityMetadata).toHaveBeenCalledWith(
        "e-1",
        expect.objectContaining({ notes: "new note" }),
      ),
    );
    expect(await screen.findByText("Saved.")).toBeInTheDocument();
    expect(save).toBeDisabled();
  });

  it("clears existing notes and adopts the saved server value", async () => {
    const updateEntityMetadata = vi.fn(async () =>
      detail({ metadata: { role: "engineer", notes: "" } }),
    );
    mount(
      clientWith({
        getEntity: async () =>
          detail({ metadata: { role: "engineer", notes: "Old note" } }),
        updateEntityMetadata,
      }),
    );
    const notes = (await screen.findByLabelText(
      "Notes",
    )) as HTMLTextAreaElement;
    const save = screen.getByRole("button", { name: "Save" });
    expect(notes).toHaveValue("Old note");
    expect(save).toBeDisabled();
    notes.value = "";
    notes.dispatchEvent(new Event("input"));
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await screen.findByText("Saved.");
    expect(updateEntityMetadata).toHaveBeenCalledWith("e-1", {
      role: "engineer",
      description: "",
      notes: "",
    });
    expect(notes).toHaveValue("");
    expect(save).toBeDisabled();
  });

  it("surfaces a hosted-mode refusal as locked, not a broken form", async () => {
    mount(
      clientWith({
        updateEntityMetadata: async () => {
          throw new ApiError("forbidden", "/entities/e-1", "hosted", 403);
        },
      }),
    );
    const save = await screen.findByRole("button", { name: "Save" });
    fireEvent.input(screen.getByTestId("entity-notes"), {
      target: { value: "x" },
    });
    fireEvent.click(save);
    expect(
      await screen.findByText("Not available in hosted mode"),
    ).toBeInTheDocument();
  });

  it("deletes after confirm and navigates away", async () => {
    const deleteEntity = vi.fn(async () => ({ deleted: true }));
    mount(clientWith({ deleteEntity }));
    fireEvent.click(await screen.findByTestId("entity-delete"));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Ada Lovelace");
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(deleteEntity).toHaveBeenCalledWith("e-1"));
  });

  it("renders a malicious entity name as inert text", async () => {
    mount(
      clientWith({
        getEntity: async () =>
          detail({
            canonical_name: "<img src=x onerror=alert(1)>",
            metadata: { description: '<a href="javascript:alert(1)">x</a>' },
          }),
      }),
    );
    const name = await screen.findByTestId("entity-name");
    expect(name.textContent).toBe("<img src=x onerror=alert(1)>");
    expect(document.querySelector("img")).toBeNull();
  });
});
