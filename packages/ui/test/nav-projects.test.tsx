import { MemoryRouter, Route } from "@solidjs/router";
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Nav } from "~/components/shell/Nav";
import type { ProjectSummary } from "~/contracts";
import { ConnectionContext, createConnectionStore } from "~/lib/connection";
import {
  pins,
  PINNED_PROJECTS_STORAGE_KEY,
  resetPinsStoreForTests,
} from "~/state/pins";
import {
  resetSavedSearchesForTests,
  savedSearches,
} from "~/state/saved-searches";

const PROJECT: ProjectSummary = {
  id: "p-lore",
  path: "/home/me/lore",
  name: "lore",
  git_remote: "github.com/BYK/loreai",
  created_at: 1_700_000_000_000,
  knowledge_count: 1,
  session_count: 1,
  message_count: 1,
  distillation_count: 0,
  last_activity: 1_700_000_000_000,
};

function mount(query = "in:inbox", activeProjectId: string | null = null) {
  return render(() => (
    <MemoryRouter>
      <Route
        path="*"
        component={() => (
          <ConnectionContext.Provider value={createConnectionStore()}>
            <Nav
              activeProjectId={activeProjectId}
              query={query}
              projects={[PROJECT]}
            />
          </ConnectionContext.Provider>
        )}
      />
    </MemoryRouter>
  ));
}

describe("workspace activity navigation", () => {
  beforeEach(() => {
    localStorage.clear();
    resetPinsStoreForTests();
    resetSavedSearchesForTests();
  });

  it("highlights built-in activity searches and encodes their query in the URL", () => {
    mount("type:session");

    const sessions = screen.getByRole("link", { name: "Sessions" });
    expect(sessions).toHaveAttribute("href", "/?q=type%3Asession");
    expect(sessions).toHaveClass("bg-selected");
    expect(screen.getByTestId("nav-projects")).not.toHaveClass("bg-selected");
  });

  it("pins the active project and links to a project-filtered activity search", async () => {
    mount("in:inbox", PROJECT.id);

    fireEvent.click(screen.getByTestId("toggle-active-project-pin"));
    const pinned = await screen.findByTestId("pinned-project-search");
    expect(pinned).toHaveTextContent("lore");
    expect(pinned).toHaveAttribute("href", "/?q=project%3Ap-lore");
    expect(pins().pinned()).toEqual(["p-lore"]);
    expect(localStorage.getItem(PINNED_PROJECTS_STORAGE_KEY)).toBe(
      '["p-lore"]',
    );
  });

  it("saves, edits, and deletes a validated search", async () => {
    mount("type:session");
    fireEvent.click(screen.getByTestId("save-search-open"));
    const title = await screen.findByTestId("saved-search-title");
    fireEvent.input(title, { target: { value: "Sessions" } });
    fireEvent.click(screen.getByTestId("saved-search-submit"));

    expect(await screen.findByTestId("saved-search")).toHaveTextContent(
      "Sessions",
    );
    expect(savedSearches().list()).toHaveLength(1);

    fireEvent.click(screen.getByTestId("saved-search-edit"));
    await waitFor(() =>
      expect(screen.getByTestId("saved-search-title")).toHaveValue("Sessions"),
    );
    fireEvent.input(screen.getByTestId("saved-search-title"), {
      target: { value: "Recent sessions" },
    });
    fireEvent.input(screen.getByTestId("saved-search-query"), {
      target: { value: "type:session with:codex" },
    });
    fireEvent.click(screen.getByTestId("saved-search-submit"));
    expect(await screen.findByTestId("saved-search")).toHaveTextContent(
      "Recent sessions",
    );
    expect(savedSearches().list()[0]?.query).toBe("type:session with:codex");

    vi.stubGlobal("confirm", () => true);
    fireEvent.click(screen.getByTestId("saved-search-delete"));
    await waitFor(() =>
      expect(screen.queryByTestId("saved-search")).toBeNull(),
    );
    expect(savedSearches().list()).toEqual([]);
    vi.unstubAllGlobals();
  });

  it("disables saving invalid search grammar", async () => {
    mount();
    fireEvent.click(screen.getByTestId("save-search-open"));
    fireEvent.input(await screen.findByTestId("saved-search-title"), {
      target: { value: "Bad query" },
    });
    fireEvent.input(screen.getByTestId("saved-search-query"), {
      target: { value: "unknown:value" },
    });
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByTestId("saved-search-submit")).toBeDisabled();
  });
});
