/**
 * Sidebar project sections (#1918): pinned, recent, filter and "All
 * projects" — plus pure tests for `sectionProjects`/`byRecency` and the
 * `pins` localStorage store.
 */
import { MemoryRouter, Route } from "@solidjs/router";
import { fireEvent, render, screen } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Nav } from "~/components/shell/Nav";
import { byRecency, sectionProjects } from "~/components/shell/nav-projects";
import type { ProjectSummary } from "~/contracts";
import { closeLoreDb, resetCache } from "~/db";
import { ConnectionContext, createConnectionStore } from "~/lib/connection";
import {
  pins,
  PINNED_PROJECTS_STORAGE_KEY,
  resetPinsStoreForTests,
} from "~/state/pins";

function project(
  id: string,
  overrides: Partial<ProjectSummary> = {},
): ProjectSummary {
  return {
    id,
    path: `/home/me/${id}`,
    name: id,
    git_remote: null,
    created_at: 1_000,
    knowledge_count: 0,
    session_count: 0,
    message_count: 0,
    distillation_count: 0,
    last_activity: null,
    ...overrides,
  };
}

function renderNav(projects: ProjectSummary[]) {
  return render(() => (
    <MemoryRouter>
      <Route
        path="*"
        component={() => (
          <ConnectionContext.Provider value={createConnectionStore()}>
            <Nav
              projects={projects}
              loading={false}
              error={undefined}
              activeProjectId={null}
              totalKnowledge={null}
            />
          </ConnectionContext.Provider>
        )}
      />
    </MemoryRouter>
  ));
}

/** Labels of all project rows under a given data-section. */
function sectionLabels(section: string): string[] {
  return [
    ...document.querySelectorAll<HTMLElement>(`[data-section="${section}"]`),
  ].map((el) => el.textContent ?? "");
}

beforeEach(async () => {
  localStorage.clear();
  resetPinsStoreForTests();
  await closeLoreDb();
});

describe("Nav project sections", () => {
  const SEVEN: ProjectSummary[] = [
    // Shuffled created_at; order must come from last_activity.
    project("bravo", { created_at: 5_000, last_activity: 5_000 }),
    project("delta", { created_at: 3_000, last_activity: null }),
    project("alpha", { created_at: 6_000, last_activity: 6_000 }),
    project("golf", { created_at: 1_000, last_activity: null }),
    project("echo", { created_at: 4_000, last_activity: 4_000 }),
    project("foxtrot", { created_at: 2_000, last_activity: 3_000 }),
    project("charlie", { created_at: 7_000, last_activity: 7_000 }),
  ];

  it("shows the 5 most recent under Recent and the rest behind All", async () => {
    renderNav(SEVEN);
    await screen.findByTestId("nav-project-filter");

    expect(sectionLabels("recent")).toEqual([
      "charlie0",
      "alpha0",
      "bravo0",
      "echo0",
      "foxtrot0",
    ]);
    // Null-activity projects land in All, by created_at desc.
    const all = screen.getByTestId("nav-all-projects");
    expect(all).toHaveTextContent("All projects (2)");
    expect(all).toHaveAttribute("aria-expanded", "false");
    expect(document.querySelector('[data-section="all"]')).toBeNull();

    fireEvent.click(all);
    expect(all).toHaveAttribute("aria-expanded", "true");
    expect(sectionLabels("all")).toEqual(["delta0", "golf0"]);
  });

  it("pin moves a project out of Recent into Pinned and persists", async () => {
    renderNav(SEVEN);
    await screen.findByTestId("nav-project-filter");

    const pin = screen.getByRole("button", { name: "Pin echo" });
    expect(pin).toHaveAttribute("aria-pressed", "false");
    // Hidden only on hover-capable devices; touch users must see the control.
    expect(pin.className).not.toMatch(/(^|\s)opacity-0(\s|$)/);
    expect(pin.className).toContain("[@media(hover:hover)]:opacity-0");
    fireEvent.click(pin);

    expect(sectionLabels("pinned")).toEqual(["echo0"]);
    expect(sectionLabels("recent")).toEqual([
      "charlie0",
      "alpha0",
      "bravo0",
      "foxtrot0",
      "delta0",
    ]);
    expect(
      JSON.parse(localStorage.getItem(PINNED_PROJECTS_STORAGE_KEY)!),
    ).toEqual(["echo"]);

    const unpin = screen.getByRole("button", { name: "Unpin echo" });
    expect(unpin).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(unpin);
    expect(sectionLabels("pinned")).toEqual([]);
    expect(pins().pinned()).toEqual([]);
    expect(localStorage.getItem(PINNED_PROJECTS_STORAGE_KEY)).toBe("[]");
  });

  it("pins survive an IndexedDB cache reset", async () => {
    const { IDBFactory } = await import("./idb-globals");
    pins().toggle("echo");
    await resetCache({ factory: new IDBFactory() });
    resetPinsStoreForTests();
    expect(pins().pinned()).toEqual(["echo"]);

    renderNav(SEVEN);
    await screen.findByTestId("nav-project-filter");
    expect(sectionLabels("pinned")).toEqual(["echo0"]);
  });

  it("filter shows matches (pinned included), Escape clears", async () => {
    pins().toggle("delta");
    renderNav(SEVEN);
    const input = await screen.findByTestId("nav-project-filter");

    fireEvent.input(input, { target: { value: "a" } });
    // 'a' matches alpha, bravo, delta, charlie — pinned delta included.
    const matched = sectionLabels("matches");
    expect(matched).toContain("alpha0");
    expect(matched).toContain("delta0");
    expect(document.querySelector('[data-section="recent"]')).toBeNull();
    expect(screen.queryByTestId("nav-all-projects")).toBeNull();

    fireEvent.input(input, { target: { value: "zzzzz" } });
    expect(screen.getByText("No projects match")).toBeInTheDocument();

    fireEvent.keyDown(input, { key: "Escape" });
    expect(sectionLabels("recent").length).toBe(5);
  });

  it("no filter box and no All button with ≤5 projects and no pins", async () => {
    renderNav(SEVEN.slice(0, 3));
    await screen.findAllByTestId("nav-project");
    expect(screen.queryByTestId("nav-project-filter")).toBeNull();
    expect(screen.queryByTestId("nav-all-projects")).toBeNull();
    expect(sectionLabels("recent")).toEqual(["alpha0", "bravo0", "delta0"]);
  });
});

describe("sectionProjects / byRecency", () => {
  it("partitions input into pinned ∪ recent ∪ rest", () => {
    const list = [
      project("a", { last_activity: 3 }),
      project("b", { last_activity: 1 }),
      project("c", { last_activity: 2 }),
    ];
    const sections = sectionProjects(list, ["b"], "");
    expect(sections.pinned.map((p) => p.id)).toEqual(["b"]);
    expect(
      [...sections.pinned, ...sections.recent, ...sections.rest]
        .map((p) => p.id)
        .sort(),
    ).toEqual(["a", "b", "c"]);
  });

  it("keeps pin order and ignores unknown pinned ids", () => {
    const list = [project("a"), project("b")];
    const sections = sectionProjects(list, ["b", "ghost", "a"], "");
    expect(sections.pinned.map((p) => p.id)).toEqual(["b", "a"]);
  });

  it("byRecency breaks activity ties by created_at desc", () => {
    const a = project("a", { last_activity: 5, created_at: 1 });
    const b = project("b", { last_activity: 5, created_at: 2 });
    expect(byRecency(a, b)).toBeGreaterThan(0);
    const noActivity = project("c", { last_activity: null, created_at: 9 });
    expect(byRecency(noActivity, a)).toBeGreaterThan(0);
  });

  it("matches is null for empty and whitespace filters", () => {
    const list = [project("a")];
    expect(sectionProjects(list, [], "").matches).toBeNull();
    expect(sectionProjects(list, [], "   ").matches).toBeNull();
  });

  it("matches on name or path, case-insensitive", () => {
    const list = [
      project("alpha", { name: "ALPHA", last_activity: 2 }),
      project("beta", { path: "/x/ALPHA-path", last_activity: 1 }),
      project("gamma", { last_activity: 3 }),
    ];
    expect(
      sectionProjects(list, [], "alpha").matches?.map((p) => p.id),
    ).toEqual(["alpha", "beta"]);
  });
});

describe("pins store", () => {
  it("malformed JSON in storage reads as []", () => {
    localStorage.setItem(PINNED_PROJECTS_STORAGE_KEY, "{not json");
    resetPinsStoreForTests();
    expect(pins().pinned()).toEqual([]);
  });

  it("storage failures are swallowed; in-memory toggle still works", () => {
    const spy = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("quota");
      });
    try {
      pins().toggle("a");
      expect(pins().isPinned("a")).toBe(true);
      expect(pins().pinned()).toEqual(["a"]);
      pins().toggle("a");
      expect(pins().isPinned("a")).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});
