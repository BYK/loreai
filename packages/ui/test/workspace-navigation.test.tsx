import { MemoryRouter, Route, useLocation } from "@solidjs/router";
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { projectDestination } from "~/components/shell/navigation";
import { ProjectPicker } from "~/components/shell/ProjectPicker";
import { ConnectionContext, createConnectionStore } from "~/lib/connection";
import type { ProjectSummary } from "~/contracts";
import {
  sidebar,
  resetSidebarForTests,
  SIDEBAR_STORAGE_KEY,
} from "~/state/sidebar";
import { resetPinsStoreForTests } from "~/state/pins";

const projects: ProjectSummary[] = ["lore", "toolkit", "website"].map(
  (name, index) => ({
    id: name,
    name,
    path: `/code/${name}`,
    git_remote: null,
    created_at: index,
    last_activity: index,
    knowledge_count: index + 1,
    session_count: 0,
    message_count: 0,
    distillation_count: 0,
  }),
);

function navigation() {
  return render(() => (
    <MemoryRouter>
      <Route
        path="*"
        component={() => {
          const location = useLocation();
          return (
            <ConnectionContext.Provider value={createConnectionStore()}>
              <ProjectPicker
                projects={projects}
                loading={false}
                error={undefined}
                activeProjectId="lore"
              />
              <output data-testid="location">{location.pathname}</output>
            </ConnectionContext.Provider>
          );
        }}
      />
    </MemoryRouter>
  ));
}

beforeEach(() => {
  localStorage.clear();
  resetPinsStoreForTests();
  resetSidebarForTests();
});

describe("workspace navigation", () => {
  it("persists context collapse independently of project switching", () => {
    sidebar().setCollapsed(true);
    expect(localStorage.getItem(SIDEBAR_STORAGE_KEY)).toBe("true");
    resetSidebarForTests();
    expect(sidebar().collapsed()).toBe(true);
    navigation();
    expect(
      screen.getByRole("button", { name: /switch project/i }),
    ).toBeVisible();
    sidebar().setCollapsed(false);
    expect(localStorage.getItem(SIDEBAR_STORAGE_KEY)).toBe("false");
  });

  it("can collapse when storage rejects writes", () => {
    const write = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("storage disabled");
      });
    try {
      sidebar().setCollapsed(true);
      expect(sidebar().collapsed()).toBe(true);
    } finally {
      write.mockRestore();
    }
  });

  it("supports arrow navigation from picker search and keeps pin actions open", async () => {
    navigation();
    fireEvent.click(screen.getByRole("button", { name: /switch project/i }));
    const search = await screen.findByRole("searchbox", {
      name: "Filter projects",
    });
    fireEvent.click(screen.getByRole("button", { name: "Pin toolkit" }));
    expect(screen.getByRole("heading", { name: "Pinned" })).toBeInTheDocument();
    search.focus();
    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(document.activeElement).toHaveAttribute(
      "data-testid",
      "nav-project",
    );
    expect(
      screen.getByRole("searchbox", { name: "Filter projects" }),
    ).toBeInTheDocument();
  });

  it("opens the project picker, filters projects and navigates to a selection", async () => {
    navigation();
    fireEvent.click(screen.getByRole("button", { name: /switch project/i }));
    const search = await screen.findByRole("searchbox", {
      name: "Filter projects",
    });
    fireEvent.input(search, { target: { value: "toolkit" } });
    // The active project stays visible alongside a filtered match.
    const toolkit = screen
      .getAllByTestId("nav-project")
      .find((row) => row.textContent?.includes("toolkit"));
    expect(toolkit).toBeDefined();
    fireEvent.click(toolkit!);
    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent(
        "/projects/toolkit",
      ),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("searchbox", { name: "Filter projects" }),
      ).not.toBeInTheDocument(),
    );
  });
});

it.each([
  ["/ui", "", "/projects/next"],
  ["/ui", "?section=sessions", "/projects/next/sessions"],
  ["/ui/projects/old/knowledge/entry", "?q=old", "/projects/next/knowledge"],
  ["/knowledge", "", "/projects/next/knowledge"],
  ["/projects/old/sessions/session", "?a=old", "/projects/next/sessions"],
  ["/projects/old/imports", "", "/projects/next/imports"],
  ["/projects/old/duplicates", "", "/projects/next/duplicates"],
  [
    "/search",
    "?q=memory&scope=session",
    "/projects/next/search?q=memory&scope=session",
  ],
])(
  "keeps project switching in the intended section from %s%s",
  (path, query, expected) => {
    expect(projectDestination(path, query, "next")).toBe(expected);
  },
);
