import { MemoryRouter, Route } from "@solidjs/router";
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";

import { ProjectActions } from "~/components/lore/ProjectActions";
import { MergeProjectsAction } from "~/components/lore/ProjectActions";
import {
  closeLoreDb,
  createKnowledgeRepo,
  createMessageBlocksRepo,
  createProjectsRepo,
  createSessionsRepo,
  openLoreDb,
} from "~/db";
import { WorkspaceProvider } from "~/routes/workspace";
import type { ApiClient } from "~/lib/api";
import { ApiError } from "~/lib/api";
import type { ProjectSummary } from "~/contracts";
import { createProjectActionsState } from "~/state/project-actions";
import { IDBFactory } from "./idb-globals";

const project = (over: Partial<ProjectSummary> = {}): ProjectSummary => ({
  id: "p-1",
  path: "/src/lore",
  name: "lore",
  git_remote: "github.com/BYK/loreai",
  created_at: 1,
  knowledge_count: 3,
  session_count: 2,
  message_count: 10,
  distillation_count: 1,
  ...over,
});

const otherProject: ProjectSummary = project({
  id: "p-2",
  path: "/src/scratch",
  name: "scratch",
  git_remote: null,
});

const session = (id: string, messages = 3) => ({
  session_id: id,
  message_count: messages,
  first_message_at: 1,
  last_message_at: 2,
  distilled_count: 1,
  undistilled_count: 0,
  distillation_count: 0,
});

function clientWith(partial: Partial<ApiClient>): ApiClient {
  return {
    listProjects: async () => [project(), otherProject],
    listProjectSessionsPage: async () => ({
      items: [session("s-1"), session("s-2", 5)],
      next_cursor: null,
    }),
    getProjectSharing: async () => {
      throw new ApiError("not_found", "/sharing", "none", 404);
    },
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
            <ProjectActions project={project()} />
            <MergeProjectsAction />
          </WorkspaceProvider>
        )}
      />
    </MemoryRouter>
  ));
}

describe("ProjectActions", () => {
  it("renames via the dialog and reports the stored name", async () => {
    const renameProject = vi.fn(async () => ({
      id: "p-1",
      name: "lore-renamed",
    }));
    mount(clientWith({ renameProject }));
    fireEvent.click(await screen.findByRole("button", { name: "Rename…" }));
    const input = await screen.findByLabelText("Project name");
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();
    fireEvent.input(input, { target: { value: " lore-renamed " } });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() =>
      expect(renameProject).toHaveBeenCalledWith("p-1", "lore-renamed"),
    );
    expect(
      await screen.findByText("Renamed to lore-renamed"),
    ).toBeInTheDocument();
  });

  it("keeps Save disabled for an unchanged or empty name", async () => {
    mount(clientWith({}));
    fireEvent.click(await screen.findByRole("button", { name: "Rename…" }));
    const input = await screen.findByLabelText("Project name");
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();
    fireEvent.input(input, { target: { value: "   " } });
    expect(save).toBeDisabled();
  });

  it("surfaces a hosted-mode refusal as an inline locked notice", async () => {
    mount(
      clientWith({
        renameProject: async () => {
          throw new ApiError("forbidden", "/projects/p-1", "hosted", 403);
        },
      }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Rename…" }));
    fireEvent.input(await screen.findByLabelText("Project name"), {
      target: { value: "x" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(
      await screen.findByText(/Not available in hosted mode/),
    ).toBeInTheDocument();
    // A hosted refusal can't be retried — the dialog closes on its own and
    // the notice stays on the section.
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(
      screen
        .getByTestId("project-actions")
        .querySelector("[data-testid='action-notice-forbidden']"),
    ).toBeInTheDocument();
  });

  it("keeps a retriable error inside the open dialog", async () => {
    mount(
      clientWith({
        renameProject: async () => {
          throw new ApiError(
            "invalid",
            "/projects/p-1",
            "Project name must be 1-200 characters",
            400,
          );
        },
      }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Rename…" }));
    fireEvent.input(await screen.findByLabelText("Project name"), {
      target: { value: "x" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() =>
      expect(
        dialog.querySelector("[data-testid='action-notice-error']"),
      ).toHaveTextContent("Project name must be 1-200 characters"),
    );
  });

  it("moves selected sessions and reports counts", async () => {
    const moveSessions = vi.fn(async () => ({
      sessions_moved: 1,
      messages_moved: 3,
      distillations_moved: 0,
      tool_calls_moved: 0,
      knowledge_moved: 2,
      movedSessionIds: ["s-1"],
    }));
    mount(clientWith({ moveSessions }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Move sessions…" }),
    );
    const box = await screen.findByText("s-1");
    fireEvent.click(box.closest("label")!.querySelector("input")!);
    // Choose the scratch target from the select.
    const trigger = screen.getByRole("button", { name: /target project/i });
    fireEvent.keyDown(trigger, { key: "Enter" });
    fireEvent.click(await screen.findByRole("option", { name: "scratch" }));
    fireEvent.click(screen.getByRole("button", { name: /Move 1 session/ }));
    await waitFor(() =>
      expect(moveSessions).toHaveBeenCalledWith(
        expect.objectContaining({
          session_ids: ["s-1"],
          from_project_id: "p-1",
          include_children: true,
        }),
      ),
    );
    expect(await screen.findByText(/Moved 1 session/)).toBeInTheDocument();
  });

  it("clears after a destructive confirm naming the project", async () => {
    const clearProject = vi.fn(async () => ({
      knowledge_deleted: 3,
      temporal_deleted: 10,
      distillations_deleted: 1,
      sessions_cleared: 2,
    }));
    mount(clientWith({ clearProject }));
    fireEvent.click(await screen.findByRole("button", { name: "Clear…" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("lore");
    fireEvent.click(screen.getByRole("button", { name: "Clear project data" }));
    await waitFor(() => expect(clearProject).toHaveBeenCalledWith("p-1"));
    expect(await screen.findByText(/Cleared 3/)).toBeInTheDocument();
  });

  it("deletes after confirm and navigates to the project list", async () => {
    const deleteProject = vi.fn(async () => ({
      knowledge_deleted: 3,
      temporal_deleted: 10,
      distillations_deleted: 1,
      sessions_cleared: 2,
    }));
    mount(clientWith({ deleteProject }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Delete project…" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("lore");
    fireEvent.click(screen.getByRole("button", { name: "Delete project" }));
    await waitFor(() => expect(deleteProject).toHaveBeenCalledWith("p-1"));
  });

  it("disables action buttons while a write is pending", async () => {
    let resolve!: (v: { id: string; name: string }) => void;
    const renameProject = vi.fn(
      () => new Promise<{ id: string; name: string }>((r) => (resolve = r)),
    );
    mount(clientWith({ renameProject }));
    fireEvent.click(await screen.findByRole("button", { name: "Rename…" }));
    fireEvent.input(await screen.findByLabelText("Project name"), {
      target: { value: "x" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(
      await screen.findByRole("button", { name: "Clear…" }),
    ).toBeDisabled();
    resolve({ id: "p-1", name: "x" });
  });
});

describe("MergeProjectsAction", () => {
  it("clears collection metadata for every store after merging", async () => {
    const db = await openLoreDb({ factory: new IDBFactory() });
    expect(db).not.toBeNull();
    const repos = {
      projects: createProjectsRepo(db),
      knowledge: createKnowledgeRepo(db),
      sessions: createSessionsRepo(db),
      messageBlocks: createMessageBlocksRepo(db),
    };
    const collection = {
      complete: false,
      count: 1,
      nextCursor: "next",
      fetchedAt: 1,
    };
    await repos.projects.setCollection("all", collection);
    await repos.projects.setCollection("p-1", collection);
    await repos.knowledge.setCollection("p-1", collection);
    await repos.sessions.setCollection("p-1", collection);
    await repos.messageBlocks.setCollection("p-1/s-1", collection);

    const actions = createProjectActionsState({
      client: clientWith({
        mergeProjects: async () => ({
          updated: 1,
          merged: 1,
          namesBackfilled: 0,
          mergeDetails: [],
        }),
      }),
      tracked: (read) => read(),
      repos,
      projects: { remove: vi.fn(), reload: vi.fn() },
    });

    await actions.merge();

    expect(await repos.projects.collection("all")).toBeUndefined();
    expect(await repos.projects.collection("p-1")).toBeUndefined();
    expect(await repos.knowledge.collection("p-1")).toBeUndefined();
    expect(await repos.sessions.collection("p-1")).toBeUndefined();
    expect(await repos.messageBlocks.collection("p-1/s-1")).toBeUndefined();
    await closeLoreDb();
  });

  it("keeps merge successful when cache purge fails", async () => {
    const db = await openLoreDb({ factory: new IDBFactory() });
    expect(db).not.toBeNull();
    const repos = {
      projects: createProjectsRepo(db),
      knowledge: createKnowledgeRepo(db),
      sessions: createSessionsRepo(db),
      messageBlocks: createMessageBlocksRepo(db),
    };
    vi.spyOn(repos.projects, "clear").mockRejectedValue(
      new Error("cache closed"),
    );
    vi.spyOn(repos.projects, "clearCollections").mockRejectedValue(
      new Error("cache closed"),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = {
      updated: 1,
      merged: 1,
      namesBackfilled: 0,
      mergeDetails: [],
    };
    const actions = createProjectActionsState({
      client: clientWith({ mergeProjects: async () => result }),
      tracked: (read) => read(),
      repos,
      projects: { remove: vi.fn(), reload: vi.fn() },
    });

    try {
      await expect(actions.merge()).resolves.toEqual(result);
      expect(warn).toHaveBeenCalledWith(
        "merge cache purge failed",
        expect.any(Error),
      );
    } finally {
      warn.mockRestore();
      await closeLoreDb();
    }
  });

  it("reports No duplicates found when merged is 0", async () => {
    const mergeProjects = vi.fn(async () => ({
      updated: 0,
      merged: 0,
      namesBackfilled: 0,
      mergeDetails: [],
    }));
    mount(clientWith({ mergeProjects }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Merge duplicate projects" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Merge duplicates" }),
    );
    await waitFor(() => expect(mergeProjects).toHaveBeenCalled());
    expect(await screen.findByText("No duplicates found.")).toBeInTheDocument();
  });

  it("shows the merge result details", async () => {
    mount(
      clientWith({
        mergeProjects: async () => ({
          updated: 1,
          merged: 1,
          namesBackfilled: 0,
          mergeDetails: [
            {
              sourcePath: "/src/a",
              targetPath: "/src/b",
              gitRemote: "example.com/x",
              result: {
                knowledge_moved: 2,
                messages_moved: 5,
                distillations_moved: 1,
              },
            },
          ],
        }),
      }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Merge duplicate projects" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Merge duplicates" }),
    );
    expect(await screen.findByText(/Merged 1 project/)).toBeInTheDocument();
  });

  it("clears a previous error when reopening the merge dialog", async () => {
    const mergeProjects = vi.fn(async () => {
      throw new Error("merge failed");
    });
    mount(clientWith({ mergeProjects }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Merge duplicate projects" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Merge duplicates" }),
    );
    expect(
      (await screen.findAllByText("Error: merge failed")).length,
    ).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Merge duplicate projects" }),
    );
    expect(screen.queryByText("Error: merge failed")).not.toBeInTheDocument();
  });
});

describe("project action cache failures", () => {
  it("keeps clear successful when cache purge fails", async () => {
    const db = await openLoreDb({ factory: new IDBFactory() });
    expect(db).not.toBeNull();
    const repos = {
      projects: createProjectsRepo(db),
      knowledge: createKnowledgeRepo(db),
      sessions: createSessionsRepo(db),
      messageBlocks: createMessageBlocksRepo(db),
    };
    vi.spyOn(repos.sessions, "putMany").mockRejectedValue(
      new Error("cache quota exceeded"),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = {
      knowledge_deleted: 3,
      temporal_deleted: 10,
      distillations_deleted: 1,
      sessions_cleared: 2,
    };
    const reload = vi.fn();
    const actions = createProjectActionsState({
      client: clientWith({ clearProject: async () => result }),
      tracked: (read) => read(),
      repos,
      projects: { remove: vi.fn(), reload },
    });

    try {
      await expect(actions.clear("p-1")).resolves.toEqual(result);
      expect(warn).toHaveBeenCalledWith(
        "project cache purge failed",
        expect.any(Error),
      );
      expect(reload).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      await closeLoreDb();
    }
  });

  it("keeps remove successful when cache eviction fails", async () => {
    const db = await openLoreDb({ factory: new IDBFactory() });
    expect(db).not.toBeNull();
    const repos = {
      projects: createProjectsRepo(db),
      knowledge: createKnowledgeRepo(db),
      sessions: createSessionsRepo(db),
      messageBlocks: createMessageBlocksRepo(db),
    };
    const remove = vi.fn(async () => {
      throw new Error("cache closed");
    });
    const reload = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = {
      knowledge_deleted: 3,
      temporal_deleted: 10,
      distillations_deleted: 1,
      sessions_cleared: 2,
    };
    const actions = createProjectActionsState({
      client: clientWith({ deleteProject: async () => result }),
      tracked: (read) => read(),
      repos,
      projects: { remove, reload },
    });

    try {
      await expect(actions.remove("p-1")).resolves.toEqual(result);
      expect(remove).toHaveBeenCalledWith("p-1");
      expect(warn).toHaveBeenCalledWith(
        "project cache eviction failed",
        expect.any(Error),
      );
      expect(reload).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      await closeLoreDb();
    }
  });
});
