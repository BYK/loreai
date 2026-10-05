import { MemoryRouter, Route, createMemoryHistory } from "@solidjs/router";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  DedupPreviewCandidate,
  DedupPreviewGroup,
  DedupPreviewResponse,
  KnowledgeVersionHistory,
} from "~/contracts";
import {
  closeLoreDb,
  createReviewDecisionsStore,
  openLoreDb,
  type DedupReviewMark,
  type LoreUiDb,
} from "~/db";
import { DuplicateReview } from "~/components/lore/DuplicateReview";
import { ApiError, type ApiClient } from "~/lib/api";
import { globalKnowledgeHref, knowledgeHref, sessionHref } from "~/lib/href";
import { WorkspaceProvider } from "~/routes/workspace";
import { IDBFactory } from "./idb-globals";

const projectId = "project-1";

function candidate(
  logicalId: string,
  overrides: Partial<DedupPreviewCandidate> = {},
): DedupPreviewCandidate {
  return {
    id: `${logicalId}-version`,
    logical_id: logicalId,
    revision: 1,
    title: `Entry ${logicalId}`,
    content_excerpt: `Excerpt for ${logicalId}`,
    scope: "project",
    project_id: projectId,
    category: "decision",
    confidence: 0.9,
    source_session: null,
    updated_at: 1_700_000_000_000,
    score: 0.93,
    reasons: ["title_overlap"],
    ...overrides,
  };
}

function group(
  groupId = "project:group-1",
  candidates = [candidate("knowledge-a"), candidate("knowledge-b")],
  overrides: Partial<DedupPreviewGroup> = {},
): DedupPreviewGroup {
  const suggested = candidates[0];
  if (!suggested) throw new Error("A duplicate group needs a candidate");
  return {
    group_id: groupId,
    scope: "project",
    pool: "project",
    project_id: projectId,
    candidates,
    suggested_keep_id: suggested.id,
    ...overrides,
  };
}

function response(groups: DedupPreviewGroup[]): DedupPreviewResponse {
  return {
    dry_run: true,
    groups,
    project: { clusters: [], totalRemoved: 0 },
    global: { clusters: [], totalRemoved: 0 },
    project_shared: { clusters: [], totalRemoved: 0 },
  };
}

function history(
  entry: DedupPreviewCandidate,
  overrides: Partial<KnowledgeVersionHistory["versions"][number]> = {},
): KnowledgeVersionHistory {
  return {
    id: entry.logical_id,
    current_version_id: `${entry.logical_id}-version`,
    versions: [
      {
        version_id: `${entry.logical_id}-version`,
        version: entry.revision,
        created_at: 1_700_000_000_000,
        superseded_at: null,
        is_current: true,
        is_deleted: false,
        title: entry.title,
        content: `Full content for ${entry.logical_id}`,
        category: entry.category,
        confidence: entry.confidence,
        scope: entry.scope,
        cross_project: false,
        source_refs: {
          session_id: null,
          entry_id: null,
          user_id: null,
          created_by: null,
          updated_by: null,
          worker_provider_id: null,
          worker_model_id: null,
        },
        ...overrides,
      },
    ],
  };
}

function makeClient(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    listProjects: async () => [],
    previewDedup: async () => response([group()]),
    listKnowledgeVersions: async (id: string) => {
      const item = group().candidates.find((value) => value.logical_id === id);
      if (!item) throw new Error(`Unknown knowledge id: ${id}`);
      return history(item);
    },
    ...overrides,
  } as unknown as ApiClient;
}

function mount(
  client: ApiClient = makeClient(),
  db: Promise<LoreUiDb | null> = Promise.resolve(null),
  withInput = false,
  withNavLink = false,
) {
  const historyRouter = createMemoryHistory();
  historyRouter.set({ value: `/ui/projects/${projectId}/duplicates` });
  return render(() => (
    <MemoryRouter base="/ui" history={historyRouter}>
      <Route
        path="*"
        component={() => (
          <WorkspaceProvider client={client} db={db}>
            <>
              {withNavLink && (
                <nav>
                  <a href="/ui/projects/project-1" data-testid="keyboard-nav">
                    Project navigation
                  </a>
                </nav>
              )}
              <DuplicateReview projectId={projectId} />
              {withInput && <input aria-label="Keyboard test input" />}
            </>
          </WorkspaceProvider>
        )}
      />
    </MemoryRouter>
  ));
}

afterEach(async () => {
  await closeLoreDb();
});

describe("DuplicateReview", () => {
  it("shows the initial scanning state, then full inert evidence and metadata", async () => {
    let resolvePreview: ((value: DedupPreviewResponse) => void) | undefined;
    const hostile = "<img src=x onerror=alert(1)>";
    const first = candidate("knowledge-a", {
      title: hostile,
      score: 0.83,
      reasons: ["title_overlap"],
      confidence: 0.86,
    });
    const previewDedup = vi.fn(
      () =>
        new Promise<DedupPreviewResponse>((resolve) => {
          resolvePreview = resolve;
        }),
    );
    const listKnowledgeVersions = vi.fn(async (id: string) => {
      const item = id === first.logical_id ? first : candidate(id);
      return history(
        item,
        id === first.logical_id ? { title: hostile, content: hostile } : {},
      );
    });

    mount(makeClient({ previewDedup, listKnowledgeVersions }));
    expect(screen.getByText("Scanning for duplicates")).toBeInTheDocument();
    resolvePreview?.(
      response([
        {
          ...group("global:hostile", [
            first,
            candidate("knowledge-b", {
              scope: "shared",
              project_id: "project-2",
              source_session: "session-1",
              score: 0.86,
              reasons: ["embedding_similarity"],
              confidence: 0.71,
            }),
          ]),
          scope: "global",
          pool: "shared",
          project_id: null,
        },
      ]),
    );

    expect(
      await screen.findByText("Full content for knowledge-b"),
    ).toBeInTheDocument();
    expect(screen.getByText("Shared scope")).toBeInTheDocument();
    expect(screen.getAllByText("Shared").length).toBeGreaterThan(0);
    expect(screen.getByText("session-1")).toBeInTheDocument();
    const candidates = screen.getAllByTestId("duplicate-candidate");
    expect(screen.getByText("86% match")).toHaveAttribute(
      "aria-label",
      "Best match score 86%",
    );
    expect(within(candidates[0]!).getByText("Match 83%")).toBeInTheDocument();
    expect(
      within(candidates[0]!).getByText("Title overlap"),
    ).toBeInTheDocument();
    expect(
      within(candidates[0]!).getByText("Confidence 86%"),
    ).toBeInTheDocument();
    expect(within(candidates[1]!).getByText("Match 86%")).toBeInTheDocument();
    expect(
      within(candidates[1]!).getByText("Embedding similarity"),
    ).toBeInTheDocument();
    expect(
      within(candidates[1]!).getByText("Confidence 71%"),
    ).toBeInTheDocument();
    expect(candidates[0]).toHaveTextContent(hostile);
    expect(candidates[0]?.querySelector("img")).toBeNull();
    expect(screen.getAllByText("v1")).toHaveLength(2);
    expect(screen.getByLabelText("Keep this one (1)")).toBeChecked();
    expect(screen.getByTestId("duplicate-review")).not.toHaveTextContent(
      "global",
    );
    expect(previewDedup).toHaveBeenCalledTimes(1);
    expect(listKnowledgeVersions).toHaveBeenCalledTimes(2);
  });

  it("links to each candidate's owning project or global document", async () => {
    const otherProject = candidate("knowledge-other-project", {
      project_id: "project-2",
      source_session: "session-other-project",
    });
    const projectless = candidate("knowledge-projectless", {
      project_id: null,
      scope: "shared",
      source_session: "session-projectless",
    });
    mount(
      makeClient({
        previewDedup: async () =>
          response([
            group("global:link-targets", [otherProject, projectless], {
              scope: "global",
              pool: "shared",
              project_id: null,
            }),
          ]),
        listKnowledgeVersions: async (id) => {
          const item = [otherProject, projectless].find(
            (value) => value.logical_id === id,
          );
          if (!item) throw new Error(`Unknown knowledge id: ${id}`);
          return history(item);
        },
      }),
    );
    await screen.findByText("Full content for knowledge-other-project");

    const cards = screen.getAllByTestId("duplicate-candidate");
    expect(
      within(cards[0]!).getByRole("link", { name: "Open knowledge document" }),
    ).toHaveAttribute(
      "href",
      `/ui${knowledgeHref("project-2", "knowledge-other-project")}`,
    );
    expect(
      within(cards[0]!).getByRole("link", { name: "session-other-project" }),
    ).toHaveAttribute(
      "href",
      `/ui${sessionHref("project-2", "session-other-project")}`,
    );
    expect(
      within(cards[1]!).getByRole("link", { name: "Open knowledge document" }),
    ).toHaveAttribute(
      "href",
      `/ui${globalKnowledgeHref("knowledge-projectless")}`,
    );
    expect(
      within(cards[1]!).queryByRole("link", { name: "session-projectless" }),
    ).not.toBeInTheDocument();
    expect(
      within(cards[1]!).getByText("session-projectless"),
    ).toBeInTheDocument();
  });

  it("renders empty and retryable error states", async () => {
    const emptyClient = makeClient({
      previewDedup: async () => response([]),
    });
    const emptyMount = mount(emptyClient);
    expect(
      await screen.findByText("No duplicate candidates"),
    ).toBeInTheDocument();
    emptyMount.unmount();

    const previewDedup = vi
      .fn<ApiClient["previewDedup"]>()
      .mockRejectedValueOnce(new Error("gateway down"))
      .mockResolvedValueOnce(response([]));
    mount(makeClient({ previewDedup }));
    expect(
      await screen.findByText("Duplicate preview unavailable"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(
      await screen.findByText("No duplicate candidates"),
    ).toBeInTheDocument();
    expect(previewDedup).toHaveBeenCalledTimes(2);
  });

  it("persists decisions and keeper selection, then marks changed revisions stale", async () => {
    const factory = new IDBFactory();
    const db = await openLoreDb({ factory });
    expect(db).not.toBeNull();
    let revision = 1;
    const previewDedup = vi.fn(async () =>
      response([
        group("project:stable", [
          candidate("knowledge-a", { revision }),
          candidate("knowledge-b", { revision }),
        ]),
      ]),
    );
    const client = makeClient({ previewDedup });
    const firstMount = mount(client, Promise.resolve(db));
    await screen.findByText("Full content for knowledge-a");
    fireEvent.click(screen.getByRole("button", { name: "Accept merge" }));
    await waitFor(() =>
      expect(screen.getByTestId("review-summary")).toHaveTextContent(
        "1 accepted",
      ),
    );
    fireEvent.click(screen.getByLabelText("Keep this one (2)"));
    await waitFor(async () => {
      const mark = await createReviewDecisionsStore(db).get(
        `${projectId}/project:stable`,
      );
      expect(mark?.keepId).toBe("knowledge-b");
    });
    firstMount.unmount();

    mount(client, Promise.resolve(db));
    await screen.findByText("Full content for knowledge-a");
    await waitFor(() =>
      expect(screen.getByTestId("review-summary")).toHaveTextContent(
        "1 accepted",
      ),
    );
    expect(screen.getByLabelText("Keep this one (2)")).toBeChecked();

    revision = 2;
    fireEvent.click(screen.getByTestId("dedup-rescan"));
    await waitFor(() =>
      expect(screen.getByTestId("review-summary")).toHaveTextContent("1 stale"),
    );
    expect(screen.getByTestId("duplicate-group")).toHaveAttribute(
      "data-testid",
      "duplicate-group",
    );
  });

  it("keeps orphaned marks until explicitly discarded", async () => {
    const db = await openLoreDb({ factory: new IDBFactory() });
    const orphan: DedupReviewMark = {
      key: `${projectId}/project:removed`,
      kind: "dedup",
      projectId,
      groupId: "project:removed",
      decision: "skip",
      keepId: "knowledge-a",
      mergeIds: ["knowledge-b"],
      expectedRevisions: { "knowledge-a": 1, "knowledge-b": 1 },
      markedAt: 1,
    };
    await createReviewDecisionsStore(db).put(orphan);

    mount(makeClient(), Promise.resolve(db));
    expect(await screen.findByTestId("orphaned-marks")).toHaveTextContent(
      "1 saved mark",
    );
    expect(await createReviewDecisionsStore(db).get(orphan.key)).toEqual(
      orphan,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Discard orphaned marks" }),
    );
    await waitFor(() =>
      expect(screen.queryByTestId("orphaned-marks")).not.toBeInTheDocument(),
    );
    expect(
      await createReviewDecisionsStore(db).get(orphan.key),
    ).toBeUndefined();
  });

  it("shows changed and removed candidates without treating either as current evidence", async () => {
    const previewGroup = group();
    const client = makeClient({
      previewDedup: async () => response([previewGroup]),
      listKnowledgeVersions: async (id) => {
        const item = previewGroup.candidates.find(
          (value) => value.logical_id === id,
        );
        if (!item) throw new Error(`Unknown knowledge id: ${id}`);
        if (id === "knowledge-b") {
          throw new ApiError(
            "not_found",
            "/api/v1/knowledge/knowledge-b/versions",
            "entry removed",
            404,
          );
        }
        return history(item, { version: 2 });
      },
    });
    mount(client);
    expect(
      await screen.findByText(/Changed since this scan/),
    ).toBeInTheDocument();
    expect(
      await screen.findByText("Removed since this scan"),
    ).toBeInTheDocument();
    expect(await screen.findByText("v2")).toBeInTheDocument();
    expect(screen.getByTestId("accept-merge")).toBeDisabled();
    expect(screen.getByTestId("changed-group-notice")).toHaveTextContent(
      "Rescan before marking — this group changed since the scan",
    );
    fireEvent.keyDown(screen.getByTestId("duplicate-review"), { key: "a" });
    expect(screen.getByTestId("review-summary")).toHaveTextContent(
      "0 accepted · 0 skipped · 1 pending",
    );
    fireEvent.click(screen.getByTestId("skip-group"));
    await waitFor(() =>
      expect(screen.getByTestId("review-summary")).toHaveTextContent(
        "0 accepted · 1 skipped · 0 pending",
      ),
    );
  });

  it("handles review shortcuts but ignores key events from typing fields", async () => {
    mount(makeClient(), Promise.resolve(null), true, true);
    await screen.findByText("Full content for knowledge-a");

    fireEvent.keyDown(document.body, { key: "s" });
    await waitFor(() =>
      expect(screen.getByTestId("review-summary")).toHaveTextContent(
        "1 skipped",
      ),
    );
    fireEvent.keyDown(screen.getByLabelText("Keyboard test input"), {
      key: "a",
    });
    expect(screen.getByTestId("review-summary")).toHaveTextContent("1 skipped");
    const navLink = screen.getByTestId("keyboard-nav");
    navLink.focus();
    expect(navLink).toHaveFocus();
    fireEvent.keyDown(navLink, { key: "a" });
    expect(screen.getByTestId("review-summary")).toHaveTextContent("1 skipped");
    const review = screen.getByTestId("duplicate-review");
    const combobox = document.createElement("div");
    combobox.setAttribute("role", "combobox");
    combobox.tabIndex = 0;
    review.append(combobox);
    combobox.focus();
    fireEvent.keyDown(combobox, { key: "a" });
    expect(screen.getByTestId("review-summary")).toHaveTextContent("1 skipped");
    const listbox = document.createElement("div");
    listbox.setAttribute("role", "listbox");
    listbox.tabIndex = 0;
    review.append(listbox);
    listbox.focus();
    fireEvent.keyDown(listbox, { key: "a" });
    expect(screen.getByTestId("review-summary")).toHaveTextContent("1 skipped");
    fireEvent.keyDown(document.body, { key: "a", ctrlKey: true });
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    document.body.append(dialog);
    fireEvent.keyDown(document.body, { key: "a" });
    dialog.remove();
    expect(screen.getByTestId("review-summary")).toHaveTextContent("1 skipped");
    fireEvent.keyDown(document.body, { key: "u" });
    await waitFor(() =>
      expect(screen.getByTestId("review-summary")).toHaveTextContent(
        "1 pending",
      ),
    );
  });

  it("labels groups by dedup pool: Project, Project + shared, Shared", async () => {
    mount(
      makeClient({
        previewDedup: async () =>
          response([
            group("project:pool-project"),
            group(
              "project_shared:pool-project-shared",
              [
                candidate("knowledge-ps-private"),
                candidate("knowledge-ps-shared", {
                  scope: "shared",
                  project_id: "project-2",
                }),
              ],
              { pool: "project_shared" },
            ),
            group(
              "global:pool-shared",
              [
                candidate("knowledge-s-a", {
                  scope: "shared",
                  project_id: null,
                }),
                candidate("knowledge-s-b", {
                  scope: "shared",
                  project_id: null,
                }),
              ],
              { scope: "global", pool: "shared", project_id: null },
            ),
          ]),
      }),
    );
    await screen.findByTestId("duplicate-review");
    const groups = await screen.findAllByTestId("duplicate-group");
    expect(groups).toHaveLength(3);
    expect(groups[0]).toHaveTextContent("Project");
    expect(groups[1]).toHaveTextContent("Project + shared");
    expect(groups[2]).toHaveTextContent("Shared");
  });

  it("moves between groups and selects a keeper with numbered shortcuts", async () => {
    const second = group(
      "global:second",
      [
        candidate("knowledge-c", { scope: "shared", project_id: null }),
        candidate("knowledge-d", { scope: "shared", project_id: null }),
      ],
      { scope: "global", pool: "shared", project_id: null },
    );
    const candidates = [...group().candidates, ...second.candidates];
    mount(
      makeClient({
        previewDedup: async () => response([group(), second]),
        listKnowledgeVersions: async (id: string) => {
          const item = candidates.find((item) => item.logical_id === id);
          if (!item) throw new Error(`Unknown knowledge id: ${id}`);
          return history(item);
        },
      }),
    );
    await screen.findByText("Full content for knowledge-a");
    fireEvent.keyDown(document.body, { key: "j" });
    expect(screen.getByTestId("focused-duplicate-group")).toHaveTextContent(
      "Group 2 of 2",
    );
    fireEvent.keyDown(document.body, { key: "2" });
    expect(screen.getByLabelText("Keep this one (2)")).toBeChecked();
    fireEvent.keyDown(document.body, { key: "k" });
    expect(screen.getByTestId("focused-duplicate-group")).toHaveTextContent(
      "Group 1 of 2",
    );
  });

  it("explains that decisions are session-only when IndexedDB is unavailable", async () => {
    mount(makeClient(), Promise.resolve(null));
    expect(
      await screen.findByTestId("review-storage-notice"),
    ).toHaveTextContent("not saved on this device");
  });

  it("reports failed mark writes and deletes", async () => {
    const db = await openLoreDb({ factory: new IDBFactory() });
    if (!db) throw new Error("IndexedDB fixture did not open");
    let failNextReviewPut = true;
    let failNextReviewDelete = true;
    const failingDb = new Proxy(db, {
      get(target, property) {
        if (property === "put") {
          return async (...args: Parameters<typeof target.put>) => {
            const [store] = args;
            if (store === "reviewDecisions" && failNextReviewPut) {
              failNextReviewPut = false;
              throw new Error("simulated storage failure");
            }
            return Reflect.apply(target.put, target, args);
          };
        }
        if (property === "delete") {
          return async (...args: Parameters<typeof target.delete>) => {
            const [store] = args;
            if (store === "reviewDecisions" && failNextReviewDelete) {
              failNextReviewDelete = false;
              throw new Error("simulated delete failure");
            }
            return Reflect.apply(target.delete, target, args);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    mount(makeClient(), Promise.resolve(failingDb));
    await screen.findByText("Full content for knowledge-a");

    fireEvent.click(screen.getByTestId("accept-merge"));
    expect(
      await screen.findByTestId("review-persistence-error"),
    ).toHaveTextContent("Could not save this mark on this device");
    expect(screen.getByTestId("review-summary")).toHaveTextContent(
      "0 accepted",
    );

    fireEvent.click(screen.getByTestId("skip-group"));
    await waitFor(() =>
      expect(screen.getByTestId("review-summary")).toHaveTextContent(
        "1 skipped",
      ),
    );
    await waitFor(() =>
      expect(
        screen.queryByTestId("review-persistence-error"),
      ).not.toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Clear mark" }));
    expect(
      await screen.findByTestId("review-persistence-error"),
    ).toHaveTextContent("Could not save this mark on this device");
    expect(screen.getByTestId("review-summary")).toHaveTextContent("1 skipped");
  });
});
